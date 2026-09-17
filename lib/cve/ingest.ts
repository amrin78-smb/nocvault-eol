// lib/cve/ingest.ts
//
// One STEP of CVE ingestion. Not a job — a state machine.
//
// ⛔ WHY A STATE MACHINE. A Netlify function invocation is bounded (10s by
// default, 26s at most) and NVD allows one request per six seconds without an
// API key. Six vendors span 32 verified CPE strings, so a full sweep is 192
// SECONDS OF WAITING AT MINIMUM — an order of magnitude past any invocation
// budget, on any plan. A "run the sweep" function cannot exist here.
//
// So each invocation takes the least-recently-attempted target, does as much as
// its time budget allows, records exactly where it got to, and reports what
// remains. A run that is cut off RESUMES; it does not restart. That also means a
// transient NVD outage costs one CPE string rather than the whole sweep.
//
// ⛔ NOTHING HERE TOUCHES THE EOL TABLES. It reads and writes only
// cve_advisories and cve_ingest_state.

import { rawQuery } from '../db';
import { ensureCveSchema } from './schema';
import { allCpeTargets } from './vendor-cpes';
import {
  cpePrefixes,
  extractAffectedRanges,
  extractFixedVersions,
  classifyNvdNativeMatchability,
} from './extract';
import { VENDOR_CPES } from './vendor-cpes';

const NVD_BASE = 'https://services.nvd.nist.gov/rest/json/cves/2.0';
const RESULTS_PER_PAGE = 2000;
const FETCH_TIMEOUT_MS = 20000;

/**
 * ⛔ NVD's PUBLISHED RATE LIMITS, and the API key is the single biggest reason
 * to centralise at all. ⛔ VERIFIED 2026-09-17, because an earlier draft of this
 * comment had it wrong: **5 requests / rolling 30s WITHOUT a key, 50 / 30s WITH
 * one** — a key is worth 10x, not the 5/30s an earlier note claimed (that is the
 * UNKEYED rate). The throttle values below were already right; the prose was not.
 * Every SecVault install pays the unkeyed rate separately today; here one key
 * serves the whole customer base.
 */
function rateLimitMs(): number {
  return process.env.NVD_API_KEY ? 700 : 6200;
}

/**
 * ⛔ HOW MUCH OF THE INVOCATION WE ARE WILLING TO SPEND. Deliberately well under
 * the 10s default so the function returns a RESULT rather than being killed —
 * a killed invocation loses the progress it made, which is exactly what the
 * state table exists to prevent.
 */
const DEFAULT_BUDGET_MS = 7000;

export type IngestStepResult = {
  ok: boolean;
  vendor: string | null;
  cpeString: string | null;
  fetched: number;
  inserted: number;
  updated: number;
  skippedOtherProduct: number;
  unmatchable: number;
  moreForThisTarget: boolean;
  targetsRemaining: number;
  error?: string;
  /** Set when the call was refused to respect NVD's rate limit. Wait this long. */
  throttled?: boolean;
  waitMs?: number;
};

/** Make sure every (vendor, cpe) pair has a state row. Idempotent. */
async function ensureTargets(): Promise<void> {
  for (const t of allCpeTargets()) {
    await rawQuery(
      `INSERT INTO cve_ingest_state (vendor, cpe_string)
       VALUES ($1, $2)
       ON CONFLICT (vendor, cpe_string) DO NOTHING`,
      [t.vendor, t.cpeString]
    );
  }
  // ⛔ A target REMOVED from vendor-cpes.ts leaves its state row behind on
  // purpose. Deleting it would also delete the record that it was ever ingested,
  // and the advisories it produced stay in the corpus regardless — history, not
  // garbage. It simply stops being selected below.
}

/**
 * The next target to work.
 *
 * ⛔ NEVER-ATTEMPTED SORTS FIRST, and `NULLS FIRST` is what does it. Postgres
 * orders NULLs LAST by default on ASC, so the obvious query would put every
 * never-run string BEHIND every already-run one — and a newly added vendor would
 * never be reached while any existing target kept failing.
 *
 * ⛔ A repeatedly-failing target is DEPRIORITISED, not abandoned: ordering by
 * consecutive_failures first means a string NVD keeps refusing steps aside for
 * the ones that work, and still gets its turn once they are current.
 */
async function nextTarget(): Promise<{
  id: number; vendor: string; cpe_string: string; next_start_index: number; total_results: number | null;
} | null> {
  const r = await rawQuery<{
    id: number; vendor: string; cpe_string: string; next_start_index: number; total_results: number | null;
  }>(
    `SELECT id, vendor, cpe_string, next_start_index, total_results
       FROM cve_ingest_state
      ORDER BY consecutive_failures ASC, last_attempt_at ASC NULLS FIRST
      LIMIT 1`
  );
  return r.rows[0] ?? null;
}

async function fetchNvdPage(cpeString: string, startIndex: number): Promise<any> {
  const url =
    `${NVD_BASE}?virtualMatchString=${encodeURIComponent(cpeString)}`
    + `&resultsPerPage=${RESULTS_PER_PAGE}&startIndex=${startIndex}`;
  // ⛔ TRIMMED. A key pasted into a Netlify env field with a trailing space or
  // surrounding quotes is sent verbatim, NVD rejects it, and the failure looks
  // nothing like a formatting problem (see the 404 note below).
  const apiKey = (process.env.NVD_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  const headers: Record<string, string> = {};
  if (apiKey) headers.apiKey = apiKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      // ⛔ NVD ANSWERS A BAD API KEY WITH 404 AND AN EMPTY BODY — not 401, not
      // 403, and with nothing in the response naming the key. Proved by
      // experiment 2026-09-17: the identical request returns 200 with no key and
      // 404 the moment a bogus `apiKey` header is added.
      //
      // That is the most confusing failure this integration can produce: every
      // target 404s, it reads exactly like "NVD is down" or "that product does
      // not exist", and the real cause is a key that was never activated or was
      // pasted with a stray quote. So the diagnosis is spelled out here rather
      // than left to whoever next sees a wall of 404s.
      //
      // ⛔ It also proves the HEADER NAME is right: if NVD were ignoring
      // `apiKey` the request would have succeeded unkeyed.
      let message = `NVD responded HTTP ${res.status}`;
      if (res.status === 404 && apiKey) {
        message =
          'NVD responded HTTP 404, which is what it returns for an INVALID API KEY '
          + '(it does not use 401 or 403). The request itself is fine — the same call '
          + 'succeeds with no key at all. Check NVD_API_KEY: it must be activated via the '
          + 'single-use link NIST emails, and must carry no quotes or trailing spaces. '
          + 'Clearing NVD_API_KEY entirely also works, just nine times slower.';
      } else if (res.status === 404) {
        message =
          'NVD responded HTTP 404 with no API key set — the request URL is likely malformed.';
      } else if (res.status === 403 || res.status === 429) {
        message = `NVD responded HTTP ${res.status} — rate limited. The sweep will retry this target.`;
      }
      const err: any = new Error(message);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Store one NVD record for one vendor.
 *
 * ⛔ AN UNEXTRACTABLE RECORD IS STORED WITH matchability='unmatchable' AND NULL
 * RANGES — never with an empty array. Downstream, `affected_version_ranges: []`
 * reads as an affirmative "this device is not affected", so an extraction
 * failure recorded that way becomes a fabricated all-clear. NULL plus a reason
 * is the honest shape, and from a CENTRAL feed the distinction is multiplied
 * across every customer at once.
 *
 * ⛔ AN 'other_product' RECORD IS NOT STORED AT ALL. NVD returns records that
 * merely mention a vendor's CPE somewhere in a shared-library configuration;
 * storing those under this vendor would attribute another product's CVE to a
 * firewall.
 */
async function upsertAdvisory(
  vendor: string,
  cve: any,
  prefixes: string[]
): Promise<'inserted' | 'updated' | 'other_product'> {
  const configurations = cve.configurations;
  const ranges = extractAffectedRanges(configurations, prefixes);
  const verdict = classifyNvdNativeMatchability(configurations, prefixes, ranges);

  if (verdict.status === 'other_product') return 'other_product';

  const fixed = extractFixedVersions(configurations, prefixes);
  const descEn = (cve.descriptions || []).find((d: any) => d.lang === 'en');

  // CVSS: prefer v3.1, then v3.0, then v2 — the same precedence the consumers use.
  const m = cve.metrics || {};
  const primary =
    (m.cvssMetricV31 && m.cvssMetricV31[0])
    || (m.cvssMetricV30 && m.cvssMetricV30[0])
    || (m.cvssMetricV2 && m.cvssMetricV2[0])
    || null;
  const cvssData = primary ? primary.cvssData : null;

  const cwes: string[] = [];
  for (const w of cve.weaknesses || []) {
    for (const d of w.description || []) {
      if (d.value && /^CWE-/.test(d.value) && !cwes.includes(d.value)) cwes.push(d.value);
    }
  }

  const res = await rawQuery<{ was_insert: boolean }>(
    `INSERT INTO cve_advisories
       (cve_id, vendor, title, description, cvss_score, cvss_vector, cvss_version,
        cvss_source, published_at, affected_version_ranges, fixed_in_versions,
        advisory_url, cwe_ids, matchability, source, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,'nvd',NOW())
     ON CONFLICT (cve_id, vendor) DO UPDATE SET
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       cvss_score = EXCLUDED.cvss_score,
       cvss_vector = EXCLUDED.cvss_vector,
       cvss_version = EXCLUDED.cvss_version,
       cvss_source = EXCLUDED.cvss_source,
       published_at = EXCLUDED.published_at,
       affected_version_ranges = EXCLUDED.affected_version_ranges,
       fixed_in_versions = EXCLUDED.fixed_in_versions,
       advisory_url = EXCLUDED.advisory_url,
       cwe_ids = EXCLUDED.cwe_ids,
       matchability = EXCLUDED.matchability,
       updated_at = NOW()
     RETURNING (xmax = 0) AS was_insert`,
    [
      cve.id,
      vendor,
      null,
      descEn ? descEn.value : null,
      cvssData ? cvssData.baseScore : null,
      cvssData ? cvssData.vectorString : null,
      cvssData ? cvssData.version : null,
      primary ? primary.source : null,
      cve.published || null,
      // ⛔ NULL, not '[]', when nothing could be extracted.
      ranges.length > 0 ? JSON.stringify(ranges) : null,
      fixed.length > 0 ? JSON.stringify(fixed) : null,
      `https://nvd.nist.gov/vuln/detail/${cve.id}`,
      cwes.length > 0 ? cwes : null,
      verdict.status,
    ]
  );
  return res.rows[0]?.was_insert ? 'inserted' : 'updated';
}

/**
 * Do as much ingestion as fits in `budgetMs`, then report.
 *
 * ⛔ RETURNS RATHER THAN THROWS on an NVD failure. A failing target records its
 * error and its failure count and steps aside; the next invocation works a
 * different one. Throwing would make one unreachable CPE string block the sweep.
 */
export async function ingestStep(budgetMs = DEFAULT_BUDGET_MS): Promise<IngestStepResult> {
  const startedAt = Date.now();
  await ensureCveSchema();
  await ensureTargets();

  const target = await nextTarget();
  const remainingRow = await rawQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM cve_ingest_state
      WHERE last_success_at IS NULL OR last_success_at < NOW() - INTERVAL '24 hours'`
  );
  const targetsRemaining = remainingRow.rows[0]?.n ?? 0;

  const base: IngestStepResult = {
    ok: true,
    vendor: target?.vendor ?? null,
    cpeString: target?.cpe_string ?? null,
    fetched: 0,
    inserted: 0,
    updated: 0,
    skippedOtherProduct: 0,
    unmatchable: 0,
    moreForThisTarget: false,
    targetsRemaining,
  };
  if (!target) return base;

  // ⛔ THE RATE LIMIT IS ENFORCED HERE, ON THE SERVER, AND THAT IS DELIBERATE.
  //
  // An earlier version of this file computed rateLimitMs() and never applied it
  // — a guard that cannot fire, which reads as handled in every review. Pacing
  // in the CLIENT alone would be worse than nothing: a cron, a retry and a
  // second browser tab would each pace themselves correctly and together sail
  // straight past the limit, and NVD answers that with 403s that look like an
  // outage rather than like our own fault.
  //
  // The clock is max(last_attempt_at) across ALL targets, because NVD rate
  // limits the CALLER, not the query.
  const gap = rateLimitMs();
  const lastRow = await rawQuery<{ ms: string | null }>(
    'SELECT EXTRACT(EPOCH FROM (NOW() - MAX(last_attempt_at))) * 1000 AS ms FROM cve_ingest_state'
  );
  const sinceLast = lastRow.rows[0]?.ms;
  if (sinceLast !== null && sinceLast !== undefined && Number(sinceLast) < gap) {
    const waitMs = Math.ceil(gap - Number(sinceLast));
    // ⛔ Returns WITHOUT marking an attempt. Stamping last_attempt_at on a call
    // that never reached NVD would push the window forward every time, so a
    // caller polling faster than the limit would starve itself for ever.
    return { ...base, throttled: true, waitMs };
  }

  const prefixes = cpePrefixes(VENDOR_CPES[target.vendor] || []);
  await rawQuery('UPDATE cve_ingest_state SET last_attempt_at = NOW() WHERE id = $1', [target.id]);

  try {
    const data = await fetchNvdPage(target.cpe_string, target.next_start_index);
    const vulns = data.vulnerabilities || [];
    const totalResults = typeof data.totalResults === 'number' ? data.totalResults : null;

    for (const v of vulns) {
      if (!v || !v.cve) continue;
      const outcome = await upsertAdvisory(target.vendor, v.cve, prefixes);
      if (outcome === 'inserted') base.inserted++;
      else if (outcome === 'updated') base.updated++;
      else base.skippedOtherProduct++;
      base.fetched++;

      // ⛔ Stop writing before the invocation is killed. Progress recorded below
      // is what the next invocation resumes from.
      if (Date.now() - startedAt > budgetMs) break;
    }

    const consumed = target.next_start_index + base.fetched;
    const more = totalResults !== null && consumed < totalResults;

    await rawQuery(
      `UPDATE cve_ingest_state
          SET next_start_index = $2,
              total_results = $3,
              last_success_at = NOW(),
              last_error = NULL,
              consecutive_failures = 0,
              advisories_seen = $4
        WHERE id = $1`,
      // ⛔ Wrap back to 0 when the target is complete, so the NEXT sweep re-reads
      // it from the start. Leaving the index at the end would mean a target is
      // ingested once and never refreshed.
      [target.id, more ? consumed : 0, totalResults, consumed]
    );

    base.moreForThisTarget = more;
    // A target with more pages still counts as outstanding work.
    base.targetsRemaining = more ? targetsRemaining : Math.max(0, targetsRemaining - 1);
    return base;
  } catch (err: any) {
    await rawQuery(
      `UPDATE cve_ingest_state
          SET last_error = $2, consecutive_failures = consecutive_failures + 1
        WHERE id = $1`,
      [target.id, String(err?.message || err).slice(0, 500)]
    );
    return { ...base, ok: false, error: String(err?.message || err) };
  }
}

/** How far through a sweep we are — for the dashboard and for monitoring. */
export async function ingestStatus(): Promise<{
  targets: number;
  neverRun: number;
  staleOver24h: number;
  failing: number;
  advisories: number;
  byVendor: Array<{ vendor: string; advisories: number }>;
  rateLimitMs: number;
  hasApiKey: boolean;
}> {
  await ensureCveSchema();
  await ensureTargets();
  const s = await rawQuery<any>(
    `SELECT count(*)::int AS targets,
            count(*) FILTER (WHERE last_success_at IS NULL)::int AS never_run,
            count(*) FILTER (WHERE last_success_at < NOW() - INTERVAL '24 hours')::int AS stale,
            count(*) FILTER (WHERE consecutive_failures > 0)::int AS failing
       FROM cve_ingest_state`
  );
  const a = await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM cve_advisories`);
  const v = await rawQuery<{ vendor: string; advisories: number }>(
    `SELECT vendor, count(*)::int AS advisories FROM cve_advisories GROUP BY vendor ORDER BY 2 DESC`
  );
  const row = s.rows[0] || {};
  return {
    targets: row.targets ?? 0,
    neverRun: row.never_run ?? 0,
    staleOver24h: row.stale ?? 0,
    failing: row.failing ?? 0,
    advisories: a.rows[0]?.n ?? 0,
    byVendor: v.rows,
    rateLimitMs: rateLimitMs(),
    hasApiKey: !!process.env.NVD_API_KEY,
  };
}
