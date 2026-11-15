// lib/cve/rss.ts
//
// RSS-triggered CVE discovery: poll vendor advisory feeds for CVE identifiers,
// then fetch each one FROM NVD through the existing extractor.
//
// ⛔ WHY THIS EXISTS: the CPE rotation finds new advisories far too slowly. It
// re-reads everything a product has ever had in order to notice what is new, and
// with 32 CPE strings on a vendor round-robin a full sweep is 2-4 days when
// healthy. Measured worse on 2026-11-15: after a key outage, checkpoint's 19
// outstanding strings alone needed ~16 hours at the hourly cadence, during which
// the corpus ceiling stayed 54 days stale and SecVault customers — who cannot
// reach NVD at all — had no path to a current advisory. A feed poll finds the
// same advisory in minutes, at one NVD request instead of a paged result set.
//
// ⛔ DISCOVERY ONLY. THE GATE DOES NOT MOVE. Every identifier found here is
// fetched from NVD and passed through upsertAdvisory(), which runs the same
// extractAffectedRanges + classifyNvdNativeMatchability against the same
// VENDOR_CPES prefixes as the rotation. A CVE that does not name a tracked
// product is recorded as `other_product` and stored nowhere. RSS can only make
// the corpus EARLIER, never broader.
//
// ⛔ THE FEED IS NEVER PARSED AS XML. It is scanned for a strict identifier
// pattern. That is deliberate on two counts: feeds differ (RSS 2.0 here, Atom
// there, occasionally malformed) and an identifier regex survives all of it; and
// parsing untrusted third-party XML invites entity-expansion and external-entity
// handling for no benefit, when the only thing wanted from the document is a set
// of CVE IDs. There is no XML parser in package.json and this adds none.

import { rawQuery } from '../db';
import { ensureCveSchema } from './schema';
import { fetchNvdByCveId, upsertAdvisory, nvdThrottleWaitMs, stampNvdCall } from './ingest';
import { cpePrefixes } from './extract';
import { VENDOR_CPES } from './vendor-cpes';
import { CVE_RSS_SOURCES } from './rss-sources';

/** ⛔ STRICT. Four to seven digits is NVD's own identifier shape. */
const CVE_ID_RE = /CVE-\d{4}-\d{4,7}/gi;

/**
 * ⛔ A CAP, BECAUSE THE BODY IS THIRD-PARTY TEXT. A feed that is replaced by
 * something enormous (or hostile) must cost a bounded amount of queue, not an
 * unbounded INSERT. 1000 is far above the 106 the largest real feed produced.
 */
const MAX_IDS_PER_POLL = 1000;

/** The feed fetch is not an NVD call; it gets its own, shorter bound. */
const FEED_FETCH_MS = 8000;

export function extractCveIds(body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.match(CVE_ID_RE) || []) {
    seen.add(m.toUpperCase());
    if (seen.size >= MAX_IDS_PER_POLL) break;
  }
  return [...seen];
}

let sourcesReady = false;

/** One row per configured feed. Idempotent, memoised for the container. */
async function ensureSources(): Promise<void> {
  if (sourcesReady) return;
  // ⛔ ONE ROUND TRIP, not one INSERT per source — the lesson ensureTargets()
  // learned when 32 sequential round trips ate the fetch budget before a byte
  // was requested.
  await rawQuery(
    `INSERT INTO cve_rss_sources (vendor, url)
       SELECT v, u FROM unnest($1::text[], $2::text[]) AS t(v, u)
     ON CONFLICT (vendor, url) DO NOTHING`,
    [CVE_RSS_SOURCES.map((s) => s.vendor), CVE_RSS_SOURCES.map((s) => s.url)]
  );
  sourcesReady = true;
}

export type PollResult = {
  ok: boolean;
  vendor: string | null;
  url: string | null;
  httpStatus: number | null;
  bytes: number;
  idsFound: number;
  idsNew: number;
  sourcesRemaining: number;
  error?: string;
};

/**
 * Poll the least-recently-fetched feed and enqueue identifiers not already known.
 *
 * ⛔ ONE FEED PER CALL, like ingestStep's one target per call. The caller loops.
 */
export async function pollFeedStep(budgetMs = FEED_FETCH_MS): Promise<PollResult> {
  await ensureCveSchema();
  await ensureSources();

  const sel = await rawQuery<{ id: number; vendor: string; url: string }>(
    `SELECT id, vendor, url FROM cve_rss_sources
      ORDER BY last_fetch_at ASC NULLS FIRST, id ASC
      LIMIT 1`
  );
  const src = sel.rows[0];
  const remaining = CVE_RSS_SOURCES.length;
  const base: PollResult = {
    ok: false, vendor: src?.vendor ?? null, url: src?.url ?? null,
    httpStatus: null, bytes: 0, idsFound: 0, idsNew: 0, sourcesRemaining: remaining,
  };
  if (!src) return { ...base, ok: true, sourcesRemaining: 0 };

  // ⛔ STAMPED BEFORE THE FETCH, so a killed invocation cannot make this feed
  // look un-attempted and monopolise the next call. Same reason
  // cve_ingest_state.last_attempt_at is stamped at step start.
  await rawQuery('UPDATE cve_rss_sources SET last_fetch_at = NOW() WHERE id = $1', [src.id]);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  let body = '';
  let status: number | null = null;
  try {
    const res = await fetch(src.url, {
      headers: { 'User-Agent': 'nocvault-eol/1.0 (+https://nocvault-eol.netlify.app)' },
      signal: controller.signal,
    });
    status = res.status;
    if (!res.ok) throw new Error(`feed responded HTTP ${res.status}`);
    body = await res.text();
  } catch (err: any) {
    const message =
      err?.name === 'AbortError'
        ? `feed did not respond within ${budgetMs}ms`
        : err instanceof Error ? err.message : String(err);
    await rawQuery(
      `UPDATE cve_rss_sources
          SET last_status = $2, last_error = $3,
              consecutive_failures = consecutive_failures + 1
        WHERE id = $1`,
      [src.id, status, message.slice(0, 400)]
    );
    return { ...base, httpStatus: status, error: message };
  } finally {
    clearTimeout(timer);
  }

  const ids = extractCveIds(body);

  // ⛔ A 200 THAT YIELDS NO IDENTIFIERS IS RECORDED AS A PROBLEM, NOT AS "no new
  // advisories". A feed that is moved, replaced by a login page or quietly
  // rewritten still answers 200 with bytes, and "we did not understand the
  // answer" must never read the same as "there is nothing there" — this repo's
  // most-repeated bug, already written down for NVD's 200-with-wrong-shape.
  if (ids.length === 0) {
    await rawQuery(
      `UPDATE cve_rss_sources
          SET last_status = $2, last_error = $3,
              consecutive_failures = consecutive_failures + 1
        WHERE id = $1`,
      [
        src.id, status,
        `feed answered HTTP ${status} with ${body.length} bytes but carried NO CVE identifiers. `
        + 'Treated as a failure: a moved or rewritten feed answers 200 too.',
      ]
    );
    return { ...base, httpStatus: status, bytes: body.length, error: 'no CVE identifiers in feed body' };
  }

  // Enqueue. ON CONFLICT DO NOTHING makes re-polling free, which is what lets
  // this run hourly against a feed that changes a few times a week.
  const ins = await rawQuery(
    `INSERT INTO cve_rss_queue (cve_id, vendor)
       SELECT c, $2 FROM unnest($1::text[]) AS t(c)
     ON CONFLICT (cve_id, vendor) DO NOTHING`,
    [ids, src.vendor]
  );
  await rawQuery(
    `UPDATE cve_rss_sources
        SET last_status = $2, last_error = NULL, last_body_bytes = $3,
            cve_ids_seen = $4, consecutive_failures = 0
      WHERE id = $1`,
    [src.id, status, body.length, ids.length]
  );

  return {
    ...base, ok: true, httpStatus: status, bytes: body.length,
    idsFound: ids.length, idsNew: ins.rowCount ?? 0,
  };
}

export type DrainResult = {
  ok: boolean;
  processed: number;
  inserted: number;
  updated: number;
  otherProduct: number;
  notInNvd: number;
  failed: number;
  pending: number;
  throttled?: boolean;
  waitMs?: number;
  error?: string;
};

/**
 * Resolve queued identifiers against NVD until the budget runs out.
 *
 * ⛔ IT SHARES NVD'S RATE-LIMIT WINDOW WITH THE ROTATION. NVD limits the CALLER,
 * not the query, so a drain that paced itself independently would sail past the
 * limit alongside the sweep and earn 403s that read like an outage — precisely
 * what probeApiKey's own comment records happening when it stamped nothing.
 * Every NVD call here waits on the shared clock and stamps it afterwards.
 */
export async function drainQueueStep(budgetMs = 15000): Promise<DrainResult> {
  await ensureCveSchema();
  const startedAt = Date.now();
  const r: DrainResult = {
    ok: true, processed: 0, inserted: 0, updated: 0,
    otherProduct: 0, notInNvd: 0, failed: 0, pending: 0,
  };

  // ⛔ NEVER START A REQUEST THE BUDGET CANNOT FUND. NVD is measured at
  // 1.5-14.4s; an under-funded attempt is a timeout with extra steps, recorded
  // as a fact about a CVE that was never actually asked for.
  const MIN_CALL_MS = 9000;

  while (Date.now() - startedAt + MIN_CALL_MS < budgetMs) {
    const wait = await nvdThrottleWaitMs();
    if (wait > 0) {
      if (Date.now() - startedAt + wait + MIN_CALL_MS > budgetMs) {
        r.throttled = true; r.waitMs = wait; break;
      }
      await new Promise((res) => setTimeout(res, wait));
    }

    const sel = await rawQuery<{ id: number; cve_id: string; vendor: string }>(
      `SELECT id, cve_id, vendor FROM cve_rss_queue
        WHERE resolved_at IS NULL
        ORDER BY attempts ASC, discovered_at ASC
        LIMIT 1`
    );
    const row = sel.rows[0];
    if (!row) break;

    await rawQuery(
      'UPDATE cve_rss_queue SET attempts = attempts + 1, last_attempt_at = NOW() WHERE id = $1',
      [row.id]
    );
    await stampNvdCall();

    try {
      const remaining = budgetMs - (Date.now() - startedAt);
      const data = await fetchNvdByCveId(row.cve_id, Math.max(MIN_CALL_MS, remaining - 1500));
      if (!data || !Array.isArray(data.vulnerabilities) || typeof data.totalResults !== 'number') {
        throw new Error(
          'NVD returned HTTP 200 but not the expected shape (vulnerabilities[] and a numeric '
          + 'totalResults). Recorded as a FAILURE, not as "this CVE does not exist".'
        );
      }
      const vuln = data.vulnerabilities[0];
      if (!vuln || !vuln.cve) {
        // ⛔ A REAL ANSWER: NVD does not hold this identifier yet. Vendors
        // publish before NVD does, so this is the NORMAL case for a fresh
        // advisory and must not be recorded as an error — but it must be
        // retried later, so it is left UNRESOLVED with its reason recorded.
        await rawQuery(
          `UPDATE cve_rss_queue SET last_error = $2 WHERE id = $1`,
          [row.id, 'not yet published by NVD (vendor advisory precedes the NVD record)']
        );
        r.notInNvd++; r.processed++;
        continue;
      }
      const prefixes = cpePrefixes(VENDOR_CPES[row.vendor] || []);
      const outcome = await upsertAdvisory(row.vendor, vuln.cve, prefixes);
      await rawQuery(
        `UPDATE cve_rss_queue SET resolved_at = NOW(), outcome = $2, last_error = NULL WHERE id = $1`,
        [row.id, outcome]
      );
      if (outcome === 'inserted') r.inserted++;
      else if (outcome === 'updated') r.updated++;
      else r.otherProduct++;
      r.processed++;
    } catch (err: any) {
      await rawQuery(
        'UPDATE cve_rss_queue SET last_error = $2 WHERE id = $1',
        [row.id, String(err?.message || err).slice(0, 400)]
      );
      r.failed++; r.processed++;
      // ⛔ STOP ON A KEY REJECTION. A 404 wall means every subsequent call fails
      // the same way; continuing burns the budget and the rate limit to learn
      // the same fact 40 more times. The health check reports the key.
      if (/HTTP 404/.test(String(err?.message || ''))) { r.ok = false; r.error = String(err.message); break; }
    }
  }

  const p = await rawQuery<{ n: number }>(
    'SELECT count(*)::int AS n FROM cve_rss_queue WHERE resolved_at IS NULL'
  );
  r.pending = p.rows[0]?.n ?? 0;
  return r;
}

/** Feed + queue state, for the dashboard. */
export async function rssStatus(): Promise<{
  sources: Array<{
    vendor: string; url: string; lastFetchAt: string | null; lastStatus: number | null;
    lastError: string | null; cveIdsSeen: number; consecutiveFailures: number;
  }>;
  pending: number;
  resolved: number;
  byOutcome: Array<{ outcome: string; n: number }>;
  notInNvd: number;
}> {
  await ensureCveSchema();
  await ensureSources();
  const s = await rawQuery<any>(
    `SELECT vendor, url, last_fetch_at, last_status, last_error, cve_ids_seen, consecutive_failures
       FROM cve_rss_sources ORDER BY vendor`
  );
  const q = await rawQuery<any>(
    `SELECT count(*) FILTER (WHERE resolved_at IS NULL)::int AS pending,
            count(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS resolved,
            count(*) FILTER (WHERE resolved_at IS NULL AND last_error LIKE 'not yet published%')::int AS not_in_nvd
       FROM cve_rss_queue`
  );
  const o = await rawQuery<any>(
    `SELECT outcome, count(*)::int AS n FROM cve_rss_queue
      WHERE outcome IS NOT NULL GROUP BY outcome ORDER BY 2 DESC`
  );
  return {
    sources: s.rows.map((x: any) => ({
      vendor: x.vendor, url: x.url,
      lastFetchAt: x.last_fetch_at ? new Date(x.last_fetch_at).toISOString() : null,
      lastStatus: x.last_status, lastError: x.last_error,
      cveIdsSeen: x.cve_ids_seen, consecutiveFailures: x.consecutive_failures,
    })),
    pending: q.rows[0]?.pending ?? 0,
    resolved: q.rows[0]?.resolved ?? 0,
    notInNvd: q.rows[0]?.not_in_nvd ?? 0,
    byOutcome: o.rows,
  };
}
