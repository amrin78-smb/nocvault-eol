// lib/eol/watch.ts
//
// The vendor EOL page change detector: fetch each watched listing on a schedule,
// reduce it to its set of lifecycle statements, and raise a REVIEW ITEM when
// that set changes.
//
// ⛔ IT NEVER WRITES AN EOL DATE. NOT ONE. CLAUDE.md's rule is "NEVER guess or
// infer a date"; the curated `data/eol-seed.json` is the only thing that feeds
// `eol_models`, and a human reading an official bulletin is the only thing that
// feeds the seed. This module's entire output is "a vendor's published listing
// is no longer what it was — go and look." It turns an unknown into a prompt.
//
// ⛔ THAT RESTRAINT IS THE FEATURE, NOT A LIMITATION OF IT. This repo already
// deleted per-vendor HTML scrapers once because they did not work. A detector
// that parsed dates out of these pages would be those scrapers again, and it
// would be writing unreviewed dates into the feed that NetVault matches customer
// devices against — where a wrong date is worse than a missing one, because a
// missing date shows up as "unknown" and a wrong one shows up as a confident
// answer.
//
// ⛔ A FAILED READ IS NEVER RECORDED AS A CHANGE. This is the repo's oldest and
// most-repeated rule, and here it has teeth: of eighteen vendor URLs probed,
// FIVE answered HTTP 200 while carrying no lifecycle content at all — a WAF
// denial, three client-rendered shells, and one page serving an entirely
// different document. If any of those were read as "the vendor emptied their EoL
// list", the resulting review item would be a lie with a date on it.

import { rawQuery } from '../db';
import { ensureEolWatchSchema } from './watch-schema';
import { EOL_WATCH_SOURCES } from './watch-sources';
import { extractSignal, hashSignal, diffSignal, looksBlocked, visibleText } from './signal';
import { sendAlertEmail, notifyConfigured, type NotifyResult } from '../cve/notify';

/** A source is due for a re-read once this old. Daily schedule, with slack. */
export const RECHECK_AFTER_HOURS = 20;

/**
 * ⛔ THREE CONSECUTIVE FAILURES BEFORE A SOURCE IS CALLED UNREADABLE, because at
 * a daily cadence that is three days — long enough that one vendor maintenance
 * window, one CDN hiccup or one transient 503 cannot produce an email. CLAUDE.md
 * already records the governing rule from the CVE side: "DO NOT ALERT ON 'A RUN
 * FAILED' ... an alert that fires on them trains the operator to filter the
 * channel."
 */
export const UNREADABLE_AFTER_FAILURES = 3;

/** Re-remind about a still-unreadable source at most this often. */
export const UNREADABLE_REMINDER_DAYS = 7;

/** Bound on third-party content kept per source. */
const MAX_STORED_SIGNAL_LINES = 2000;

const FETCH_MS = 10000;
const MAX_CHANGES_IN_EMAIL = 20;
const MAX_LINES_PER_CHANGE = 15;

const USER_AGENT = 'nocvault-eol/1.0 (+https://nocvault-eol.netlify.app)';

export type WatchOutcome = 'first_seen' | 'unchanged' | 'changed' | 'failed';

export type WatchStepResult = {
  ok: boolean;
  vendor: string | null;
  label: string | null;
  url: string | null;
  outcome: WatchOutcome | null;
  httpStatus: number | null;
  bytes: number;
  signalCount: number;
  added: number;
  removed: number;
  error?: string;
};

let sourcesReady = false;

/**
 * One row per configured source.
 *
 * ⛔ CODE IS THE AUTHORITY ON CONFIGURATION, THE DATABASE ON OBSERVATION. The
 * label, signal kind and collapse floor are re-asserted on every run so editing
 * watch-sources.ts actually takes effect; `content_hash`, the counts and the
 * failure history are never touched here, because overwriting an observation
 * with a deploy would silently reset the baseline and make the next read look
 * like a first read.
 */
async function ensureSources(): Promise<void> {
  if (sourcesReady) return;
  await rawQuery(
    `INSERT INTO eol_watch_sources (vendor, label, url, signal_kind, min_signal_lines)
       SELECT v, l, u, k, m
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[])
                AS t(v, l, u, k, m)
     ON CONFLICT (url) DO UPDATE
        SET vendor = EXCLUDED.vendor,
            label = EXCLUDED.label,
            signal_kind = EXCLUDED.signal_kind,
            min_signal_lines = EXCLUDED.min_signal_lines`,
    [
      EOL_WATCH_SOURCES.map((s) => s.vendor),
      EOL_WATCH_SOURCES.map((s) => s.label),
      EOL_WATCH_SOURCES.map((s) => s.url),
      EOL_WATCH_SOURCES.map((s) => s.signalKind),
      EOL_WATCH_SOURCES.map((s) => s.minSignalLines),
    ]
  );
  sourcesReady = true;
}

/** Test-only: forget the memoised seed so a fresh database is re-seeded. */
export function _resetSourcesMemo(): void {
  sourcesReady = false;
}

type SourceRow = {
  id: number;
  vendor: string;
  label: string;
  url: string;
  signal_kind: string;
  min_signal_lines: number;
  content_hash: string | null;
  signal_count: number | null;
  signal_lines: string[] | null;
  signal_truncated: boolean;
  consecutive_failures: number;
};

async function recordFailure(id: number, status: number | null, message: string): Promise<void> {
  await rawQuery(
    `UPDATE eol_watch_sources
        SET last_status = $2,
            last_error = $3,
            consecutive_failures = consecutive_failures + 1
      WHERE id = $1`,
    [id, status, message.slice(0, 600)]
  );
}

/**
 * Read one source and compare it with what we last successfully read.
 *
 * ⛔ ONE SOURCE PER CALL, like ingestStep and pollFeedStep. The caller loops
 * within its own budget, so an invocation that is cut off has still made
 * progress and the next one resumes at the least-recently-fetched row.
 */
export async function watchSourceStep(budgetMs = FETCH_MS): Promise<WatchStepResult> {
  await ensureEolWatchSchema();
  await ensureSources();

  const sel = await rawQuery<SourceRow>(
    `SELECT id, vendor, label, url, signal_kind, min_signal_lines, content_hash,
            signal_count, signal_lines, signal_truncated, consecutive_failures
       FROM eol_watch_sources
      WHERE last_fetch_at IS NULL
         OR last_fetch_at < NOW() - ($1 || ' hours')::interval
      ORDER BY last_fetch_at ASC NULLS FIRST, id ASC
      LIMIT 1`,
    [String(RECHECK_AFTER_HOURS)]
  );
  const src = sel.rows[0];
  const base: WatchStepResult = {
    ok: false, vendor: src?.vendor ?? null, label: src?.label ?? null, url: src?.url ?? null,
    outcome: null, httpStatus: null, bytes: 0, signalCount: 0, added: 0, removed: 0,
  };
  if (!src) return { ...base, ok: true };

  // ⛔ STAMPED BEFORE THE FETCH. A killed invocation must not leave this source
  // looking un-attempted, or it monopolises every subsequent call — the same
  // reason cve_ingest_state.last_attempt_at is stamped at step start.
  await rawQuery('UPDATE eol_watch_sources SET last_fetch_at = NOW() WHERE id = $1', [src.id]);

  const cfg = EOL_WATCH_SOURCES.find((s) => s.url === src.url);
  if (!cfg) {
    // A row whose configuration has been removed from code. Not a vendor fault.
    const msg = 'no configuration in lib/eol/watch-sources.ts for this URL (stale row)';
    await recordFailure(src.id, null, msg);
    return { ...base, outcome: 'failed', error: msg };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  let body = '';
  let status: number | null = null;
  // ⛔ WHERE THE REQUEST ACTUALLY LANDED. Cisco's interfaces-modules listing was
  // retired by redirecting it to the generic products landing page: HTTP 200,
  // 201 KB, zero lifecycle content. The floor below already catches that as a
  // failed read, but "0 links found" sends the operator hunting a parser bug,
  // while "redirected to /site/us/en/products/index.html" names the real cause
  // in one line.
  let finalUrl = src.url;
  try {
    const res = await fetch(src.url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: controller.signal,
    });
    status = res.status;
    finalUrl = res.url || src.url;
    if (!res.ok) throw new Error(`page responded HTTP ${res.status}`);
    body = await res.text();
  } catch (err: any) {
    const message =
      err?.name === 'AbortError'
        ? `page did not respond within ${budgetMs}ms`
        : err instanceof Error ? err.message : String(err);
    await recordFailure(src.id, status, message);
    return { ...base, outcome: 'failed', httpStatus: status, error: message };
  } finally {
    clearTimeout(timer);
  }

  // ⛔ CHECK FOR A DENIAL BEFORE EXTRACTING. SonicWall answers HTTP 200 with an
  // Incapsula incident id and 1,159 bytes. Extraction would yield an empty set,
  // which is also what a genuinely emptied listing yields — so the specific
  // reason has to be captured while the evidence is still in the body.
  const blocked = looksBlocked(body);
  if (blocked) {
    const msg = `HTTP ${status} but the body is a ${blocked}, not the page (${body.length} bytes)`;
    await recordFailure(src.id, status, msg);
    return { ...base, outcome: 'failed', httpStatus: status, bytes: body.length, error: msg };
  }

  let signal: string[];
  try {
    // ⛔ A SCOPE THAT FINDS NOTHING IS A FAILED READ, NOT AN EMPTY ONE. If the
    // PAN-OS table is gone from Palo Alto's page, "0 dated lines" would mean
    // "Palo Alto published no lifecycle dates" — which is the exact
    // failed-read-as-a-fact error this module exists to prevent.
    let scoped: string = body;
    if (cfg.scope) {
      const region = cfg.scope(body);
      if (!region) {
        const msg =
          `HTTP ${status} with ${body.length} bytes, but the watched REGION of the page was not `
          + 'found. The page still answers, so this is a layout change, not an outage. '
          + 'Treated as a FAILED READ: an absent region is not an empty one.';
        await recordFailure(src.id, status, msg);
        return { ...base, outcome: 'failed', httpStatus: status, bytes: body.length, error: msg };
      }
      scoped = region;
    }
    signal = extractSignal(scoped, cfg.signalKind, cfg.hrefPattern);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordFailure(src.id, status, `signal extraction failed: ${msg}`);
    return { ...base, outcome: 'failed', httpStatus: status, bytes: body.length, error: msg };
  }

  // ⛔ A SIGNAL THAT COLLAPSES IS A FAILED READ, NEVER A CHANGE. This is the
  // whole guard. A page that became client-rendered, moved behind a login, or
  // started serving a different document still answers 200 with plenty of
  // bytes — Juniper returns 58 KB containing 120 characters of survey pop-up,
  // and Fortinet returns 9.9 KB containing nothing at all. Reading that as "the
  // vendor removed every EoL product" would manufacture a review item that is
  // not merely useless but actively misleading.
  if (signal.length < Math.max(1, src.min_signal_lines)) {
    const visible = visibleText(body).replace(/\s+/g, ' ').trim().length;
    const msg =
      `HTTP ${status} with ${body.length} bytes, but only ${signal.length} `
      + `${cfg.signalKind === 'links' ? 'matching product link(s)' : 'dated line(s)'} were found `
      + `(floor is ${src.min_signal_lines}; ${visible} chars of visible text). `
      + (finalUrl !== src.url ? `REDIRECTED TO ${finalUrl}. ` : '')
      + 'Treated as a FAILED READ, not as a change: a moved, client-rendered or '
      + 'access-denied page answers 200 with bytes too.';
    await recordFailure(src.id, status, msg);
    return {
      ...base, outcome: 'failed', httpStatus: status, bytes: body.length,
      signalCount: signal.length, error: msg,
    };
  }

  const hash = hashSignal(signal);
  const truncated = signal.length > MAX_STORED_SIGNAL_LINES;
  const stored = truncated ? signal.slice(0, MAX_STORED_SIGNAL_LINES) : signal;

  // ⛔ THE FIRST SUCCESSFUL READ IS A BASELINE, NOT A CHANGE. Without this, the
  // feature's first ever run emails about all eight sources having "changed"
  // from nothing — and an alert channel that opens with a burst of noise about
  // nothing is one the operator learns to ignore before it has ever been right.
  if (!src.content_hash) {
    await rawQuery(
      `UPDATE eol_watch_sources
          SET content_hash = $2, signal_count = $3, signal_lines = $4::jsonb,
              signal_truncated = $5, last_success_at = NOW(), last_status = $6,
              last_error = NULL, last_body_bytes = $7, consecutive_failures = 0,
              unreadable_notified_at = NULL
        WHERE id = $1`,
      [src.id, hash, signal.length, JSON.stringify(stored), truncated, status, body.length]
    );
    return {
      ...base, ok: true, outcome: 'first_seen', httpStatus: status,
      bytes: body.length, signalCount: signal.length,
    };
  }

  if (src.content_hash === hash) {
    await rawQuery(
      `UPDATE eol_watch_sources
          SET last_success_at = NOW(), last_status = $2, last_error = NULL,
              last_body_bytes = $3, consecutive_failures = 0, unreadable_notified_at = NULL
        WHERE id = $1`,
      [src.id, status, body.length]
    );
    return {
      ...base, ok: true, outcome: 'unchanged', httpStatus: status,
      bytes: body.length, signalCount: signal.length,
    };
  }

  // Changed.
  const before = Array.isArray(src.signal_lines) ? src.signal_lines : [];
  const { added, removed } = diffSignal(before, stored);
  // ⛔ IF EITHER SIDE WAS TRUNCATED THE DIFF IS NOT TRUSTWORTHY, and it says so
  // rather than presenting a partial diff as a complete one.
  const detailAvailable = !truncated && !src.signal_truncated && before.length > 0;

  await rawQuery(
    `INSERT INTO eol_watch_changes
       (source_id, vendor, label, url, old_hash, new_hash, old_count, new_count,
        added, removed, detail_available)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)`,
    [
      src.id, src.vendor, src.label, src.url, src.content_hash, hash,
      src.signal_count, signal.length,
      JSON.stringify(detailAvailable ? added.slice(0, 200) : []),
      JSON.stringify(detailAvailable ? removed.slice(0, 200) : []),
      detailAvailable,
    ]
  );
  await rawQuery(
    `UPDATE eol_watch_sources
        SET content_hash = $2, signal_count = $3, signal_lines = $4::jsonb,
            signal_truncated = $5, last_success_at = NOW(), last_changed_at = NOW(),
            last_status = $6, last_error = NULL, last_body_bytes = $7,
            consecutive_failures = 0, unreadable_notified_at = NULL
      WHERE id = $1`,
    [src.id, hash, signal.length, JSON.stringify(stored), truncated, status, body.length]
  );

  return {
    ...base, ok: true, outcome: 'changed', httpStatus: status, bytes: body.length,
    signalCount: signal.length, added: added.length, removed: removed.length,
  };
}

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

/**
 * ⛔ THE REMEDY NAMES THE ACTUAL NEXT ACTION, including the explicit statement
 * that nothing was written. CLAUDE.md's alerting rule is that an alert must name
 * its remedy; for this one the most important sentence is the one telling the
 * operator that the database has NOT been updated behind them.
 */
const CHANGE_REMEDY = [
  'WHAT TO DO:',
  '  1. Open the URL above and compare it with data/eol-seed.json.',
  '  2. If a model was added or a date moved, follow CLAUDE.md "HOW TO GROW THE LIST":',
  '     official vendor source only, never infer a date, skip anything undated.',
  '  3. Edit data/eol-seed.json, npm run build, commit, push.',
  '  4. Dashboard -> Load curated seed -> Build & Publish Feed.',
  '  5. Acknowledge the review item on the dashboard so it stops being listed.',
  '',
  'NOTHING WAS WRITTEN TO THE CATALOGUE. This detector never records an EOL date;',
  'it only reports that a vendor page no longer says what it said before. A date',
  'reaches the feed only when a human puts it in the curated seed.',
].join('\n');

const UNREADABLE_REMEDY = [
  'WHAT TO DO:',
  '  1. Open the URL in a browser. If it still works there but not from a server,',
  '     the page has most likely become client-rendered or WAF-protected.',
  '  2. Either correct the URL in lib/eol/watch-sources.ts, or move the source to',
  '     EOL_SOURCES_REFUSED with the measurement that disqualified it.',
  '',
  'A source listed as watched that cannot actually be read is worse than one',
  'honestly absent: it reports coverage that does not exist.',
].join('\n');

type ChangeRow = {
  id: number; vendor: string; label: string; url: string; detected_at: string;
  old_count: number | null; new_count: number | null;
  added: string[] | null; removed: string[] | null; detail_available: boolean;
};

function renderChanges(rows: ChangeRow[]): string {
  const parts: string[] = [];
  for (const c of rows.slice(0, MAX_CHANGES_IN_EMAIL)) {
    parts.push(`--- ${c.vendor}: ${c.label}`);
    parts.push(`    ${c.url}`);
    parts.push(`    statements: ${c.old_count ?? '?'} -> ${c.new_count ?? '?'}`);
    if (!c.detail_available) {
      parts.push('    (no line-level detail: the stored signal set was truncated)');
    } else {
      const added = c.added ?? [];
      const removed = c.removed ?? [];
      if (added.length) {
        parts.push(`    ADDED (${added.length}):`);
        added.slice(0, MAX_LINES_PER_CHANGE).forEach((l) => parts.push(`      + ${l}`));
        if (added.length > MAX_LINES_PER_CHANGE) {
          parts.push(`      + ... ${added.length - MAX_LINES_PER_CHANGE} more`);
        }
      }
      if (removed.length) {
        parts.push(`    REMOVED (${removed.length}):`);
        removed.slice(0, MAX_LINES_PER_CHANGE).forEach((l) => parts.push(`      - ${l}`));
        if (removed.length > MAX_LINES_PER_CHANGE) {
          parts.push(`      - ... ${removed.length - MAX_LINES_PER_CHANGE} more`);
        }
      }
      if (!added.length && !removed.length) {
        parts.push('    (the set is the same but normalised differently — worth a glance)');
      }
    }
    parts.push('');
  }
  if (rows.length > MAX_CHANGES_IN_EMAIL) {
    parts.push(`... and ${rows.length - MAX_CHANGES_IN_EMAIL} more change(s) on the dashboard.`);
  }
  return parts.join('\n');
}

export type NotifyWatchResult = {
  changesNotified: number;
  unreadableNotified: number;
  notify: NotifyResult | null;
  configured: { ok: boolean; reason: string };
};

/**
 * Send one email covering everything this cycle found.
 *
 * ⛔ ONE EMAIL PER CYCLE, NOT ONE PER SOURCE. Eight sources that all change in
 * the same week — which is exactly what a vendor-wide site migration looks
 * like — would otherwise be eight separate emails saying the same thing.
 *
 * ⛔ WITH NO MAILER CONFIGURED THIS STILL RUNS AND STILL RECORDS. The review
 * items are in the database and on the dashboard either way; only the email is
 * skipped, and the reason is reported. A notifier that quietly no-ops when
 * unconfigured reproduces the silent-failure defect the CVE health check was
 * built to remove.
 */
export async function notifyWatchFindings(): Promise<NotifyWatchResult> {
  await ensureEolWatchSchema();
  const configured = notifyConfigured();

  const changes = await rawQuery<ChangeRow>(
    `SELECT id, vendor, label, url, detected_at, old_count, new_count,
            added, removed, detail_available
       FROM eol_watch_changes
      WHERE notified_at IS NULL AND acknowledged_at IS NULL
      ORDER BY detected_at ASC, id ASC`
  );

  const unreadable = await rawQuery<{ id: number; vendor: string; label: string; url: string; consecutive_failures: number; last_error: string | null }>(
    `SELECT id, vendor, label, url, consecutive_failures, last_error
       FROM eol_watch_sources
      WHERE consecutive_failures >= $1
        AND (unreadable_notified_at IS NULL
             OR unreadable_notified_at < NOW() - ($2 || ' days')::interval)
      ORDER BY vendor, label`,
    [UNREADABLE_AFTER_FAILURES, String(UNREADABLE_REMINDER_DAYS)]
  );

  const empty: NotifyWatchResult = {
    changesNotified: 0, unreadableNotified: 0, notify: null, configured,
  };
  if (changes.rows.length === 0 && unreadable.rows.length === 0) return empty;

  const nChanges = changes.rows.length;
  const nBad = unreadable.rows.length;
  const subjectBits: string[] = [];
  if (nChanges) subjectBits.push(`${nChanges} vendor EOL page change${nChanges === 1 ? '' : 's'}`);
  if (nBad) subjectBits.push(`${nBad} unreadable source${nBad === 1 ? '' : 's'}`);
  const subject = `[EOL WATCH] ${subjectBits.join(', ')}`;

  const body: string[] = [];
  body.push('NocVault EOL hub — vendor lifecycle page watch');
  body.push(`Checked at ${new Date().toISOString()}`);
  body.push('');

  if (nChanges) {
    body.push(`${nChanges} watched vendor page(s) no longer publish what they published before.`);
    body.push('');
    body.push(renderChanges(changes.rows));
    body.push(CHANGE_REMEDY);
    body.push('');
  }

  if (nBad) {
    body.push(`${nBad} source(s) have failed ${UNREADABLE_AFTER_FAILURES}+ consecutive reads:`);
    body.push('');
    for (const s of unreadable.rows) {
      body.push(`--- ${s.vendor}: ${s.label}  (${s.consecutive_failures} consecutive failures)`);
      body.push(`    ${s.url}`);
      body.push(`    ${(s.last_error || 'no detail recorded').slice(0, 300)}`);
      body.push('');
    }
    body.push(UNREADABLE_REMEDY);
  }

  const notify = await sendAlertEmail(subject, body.join('\n'));

  // ⛔ MARKED ONLY ON A REAL SEND. cve_health_alerts learned this: advancing a
  // "notified" stamp on a failed delivery buys a window of deliberate silence
  // out of a broken mailer. A change whose email failed stays unnotified and is
  // retried on the next cycle.
  if (notify.sent) {
    if (nChanges) {
      await rawQuery(
        'UPDATE eol_watch_changes SET notified_at = NOW() WHERE id = ANY($1::int[])',
        [changes.rows.map((c) => c.id)]
      );
    }
    if (nBad) {
      await rawQuery(
        'UPDATE eol_watch_sources SET unreadable_notified_at = NOW() WHERE id = ANY($1::int[])',
        [unreadable.rows.map((s) => s.id)]
      );
    }
  }

  return {
    changesNotified: notify.sent ? nChanges : 0,
    unreadableNotified: notify.sent ? nBad : 0,
    notify,
    configured,
  };
}

// ---------------------------------------------------------------------------
// Cycle
// ---------------------------------------------------------------------------

export type WatchRunResult = {
  ok: boolean;
  checked: number;
  changed: number;
  firstSeen: number;
  unchanged: number;
  failed: number;
  remaining: number;
  steps: WatchStepResult[];
  notify: NotifyWatchResult | null;
};

/**
 * Work every due source within the budget, then notify once.
 *
 * ⛔ THE BUDGET IS STATED BY THE CALLER. CLAUDE.md records the cost of the
 * alternative twice over: `scheduled-cve-ingest` posted no body, every step ran
 * on a default sized for a 10s invocation, and NVD was handed 2.3s against a
 * service measured at 1.5-14.4s — "a timeout with extra steps". The dashboard
 * button then repeated it verbatim. Callers here state a budget; this stops
 * before starting a fetch it cannot fund.
 */
export async function runEolWatch(opts: { budgetMs?: number; notify?: boolean } = {}): Promise<WatchRunResult> {
  const budgetMs = Math.max(3000, Math.min(120000, opts.budgetMs ?? 20000));
  const startedAt = Date.now();
  const steps: WatchStepResult[] = [];
  const counts = { changed: 0, firstSeen: 0, unchanged: 0, failed: 0 };

  await ensureEolWatchSchema();
  await ensureSources();

  // Reserve enough for one fetch plus the writes that follow it.
  while (Date.now() - startedAt + FETCH_MS + 1500 < budgetMs) {
    const remainingMs = budgetMs - (Date.now() - startedAt) - 1500;
    const step = await watchSourceStep(Math.min(FETCH_MS, remainingMs));
    if (!step.url) break; // nothing due
    steps.push(step);
    if (step.outcome === 'changed') counts.changed++;
    else if (step.outcome === 'first_seen') counts.firstSeen++;
    else if (step.outcome === 'unchanged') counts.unchanged++;
    else counts.failed++;
  }

  const due = await rawQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM eol_watch_sources
      WHERE last_fetch_at IS NULL
         OR last_fetch_at < NOW() - ($1 || ' hours')::interval`,
    [String(RECHECK_AFTER_HOURS)]
  );

  const notify = opts.notify === false ? null : await notifyWatchFindings();

  return {
    ok: true,
    checked: steps.length,
    ...counts,
    remaining: due.rows[0]?.n ?? 0,
    steps,
    notify,
  };
}

/** Mark a review item done. */
export async function acknowledgeChange(id: number, note?: string): Promise<boolean> {
  await ensureEolWatchSchema();
  const r = await rawQuery(
    `UPDATE eol_watch_changes
        SET acknowledged_at = NOW(), acknowledged_note = $2
      WHERE id = $1 AND acknowledged_at IS NULL`,
    [id, (note || '').slice(0, 500) || null]
  );
  return (r.rowCount ?? 0) > 0;
}

export type EolWatchStatus = {
  sources: Array<{
    id: number; vendor: string; label: string; url: string; signalKind: string;
    signalCount: number | null; lastFetchAt: string | null; lastSuccessAt: string | null;
    lastChangedAt: string | null; lastStatus: number | null; lastError: string | null;
    consecutiveFailures: number; baselined: boolean;
  }>;
  openChanges: Array<{
    id: number; vendor: string; label: string; url: string; detectedAt: string;
    oldCount: number | null; newCount: number | null;
    added: string[]; removed: string[]; detailAvailable: boolean; notifiedAt: string | null;
  }>;
  openCount: number;
  unreadableCount: number;
  alerting: { ok: boolean; reason: string };
};

/** Source and review-queue state, for the dashboard. Read-only, no network. */
export async function eolWatchStatus(): Promise<EolWatchStatus> {
  await ensureEolWatchSchema();
  await ensureSources();

  const s = await rawQuery<any>(
    `SELECT id, vendor, label, url, signal_kind, signal_count, last_fetch_at, last_success_at,
            last_changed_at, last_status, last_error, consecutive_failures, content_hash
       FROM eol_watch_sources ORDER BY vendor, label`
  );
  const c = await rawQuery<any>(
    `SELECT id, vendor, label, url, detected_at, old_count, new_count, added, removed,
            detail_available, notified_at
       FROM eol_watch_changes
      WHERE acknowledged_at IS NULL
      ORDER BY detected_at DESC, id DESC
      LIMIT 50`
  );
  const iso = (v: any) => (v ? new Date(v).toISOString() : null);

  return {
    sources: s.rows.map((x: any) => ({
      id: x.id, vendor: x.vendor, label: x.label, url: x.url, signalKind: x.signal_kind,
      signalCount: x.signal_count,
      lastFetchAt: iso(x.last_fetch_at), lastSuccessAt: iso(x.last_success_at),
      lastChangedAt: iso(x.last_changed_at), lastStatus: x.last_status,
      lastError: x.last_error, consecutiveFailures: x.consecutive_failures,
      baselined: !!x.content_hash,
    })),
    openChanges: c.rows.map((x: any) => ({
      id: x.id, vendor: x.vendor, label: x.label, url: x.url,
      detectedAt: new Date(x.detected_at).toISOString(),
      oldCount: x.old_count, newCount: x.new_count,
      added: Array.isArray(x.added) ? x.added : [],
      removed: Array.isArray(x.removed) ? x.removed : [],
      detailAvailable: x.detail_available, notifiedAt: iso(x.notified_at),
    })),
    openCount: c.rowCount ?? 0,
    unreadableCount: s.rows.filter((x: any) => x.consecutive_failures >= UNREADABLE_AFTER_FAILURES).length,
    alerting: notifyConfigured(),
  };
}
