// lib/cve/health.ts
//
// PROACTIVE HEALTH DETECTION FOR THE CVE INGEST.
//
// ⛔ WHY THIS FILE EXISTS: A 23-DAY SILENT OUTAGE. Ingestion stopped on
// 2026-10-23T15:10:27Z and nobody found out until 2026-11-15. At that point all
// 32 targets carried errors, 16 of them NVD's `HTTP 404` — which is what NVD
// returns for an INVALID API KEY, not 401 and not 403 — and the max
// consecutive_failures was 81. The cause was the trap CLAUDE.md already
// documents twice: a Netlify env change does not reach a deployed function until
// the next build, so the replaced key never arrived.
//
// ⛔ AND THE REAL COST MEASURE WAS NEITHER TIMESTAMP. The newest CVE
// *publication date* in the corpus was 2026-09-22, so nothing published in 54
// days had ever been ingested. On a customer site that cannot reach NVD at all
// (address-space overlap — see CLAUDE.md "why this exists") this hub is the ONLY
// source of usable version ranges, so a frozen hub is a CVE-discovery outage for
// that customer. Every mechanism signal in the system was individually
// available; nothing joined them up and nothing told anyone.
//
// ⛔ THE CUSTOMER-SIDE HALF ALREADY EXISTS AND IS NOT DUPLICATED HERE.
// SecVault v2.228.13 reads `checked_at` and `generated_at` off the signed feed
// and reports a stale ingest and a frozen corpus separately. That catches it
// from the outside, one sync cycle late, and only for a customer who is looking.
// This file is the inside view, for the operator, before any customer sees it.
//
// ⛔ THE CLASSIFIER IS A PURE FUNCTION OVER FACTS, DELIBERATELY. Every threshold
// here was wrong at least once somewhere in this repo because it could only be
// checked by waiting for production to reproduce the condition. `classify()`
// takes a plain struct and returns a verdict, so all six states are forced and
// asserted in scripts/verify-cve-health.ts without a database, a clock or NVD.

import { rawQuery } from '../db';
import { ensureCveSchema } from './schema';
import { probeApiKey, nvdKeyFingerprint } from './ingest';

// ---------------------------------------------------------------------------
// Thresholds. BOTH ARE DERIVED FROM MEASUREMENT, AND THE DERIVATION IS THE
// POINT — a number picked by feel is a number the next session cannot audit.
// ---------------------------------------------------------------------------

/**
 * ⛔ DERIVED, NOT STATED: 6 hours = six consecutive missed hourly ticks.
 *
 * `scheduled-cve-ingest` runs `10 * * * *` — hourly — and a healthy invocation
 * was measured on 2026-11-15 to attempt 7 targets and SUCCEED on 3 of them
 * within one 31-second slice. So a healthy hour produces successes, plural, and
 * six consecutive hours producing NONE fleet-wide is roughly 42 attempts with
 * nothing to show. That is far outside measured healthy behaviour, which is what
 * makes it a safe floor rather than a hair trigger.
 *
 * ⛔ IT IS DELIBERATELY NOT TIGHTER THAN THAT. Per-target failure is the NORMAL
 * state of this pipeline: in that same healthy slice FOUR of seven targets
 * returned HTTP 503. A threshold that fires on a bad hour would fire most days,
 * and an alert the operator learns to ignore is strictly worse than no alert.
 */
export const STALL_HOURS = 6;

/**
 * ⛔ DERIVED FROM THE CORPUS'S OWN PUBLICATION HISTORY: 45 days.
 *
 * `max(published_at)` ages on its own whenever these six vendors simply have not
 * published anything, so the threshold has to clear the longest GENUINELY QUIET
 * period or it cries wolf. Measured on the live corpus (955 advisories,
 * 2026-11-15), gaps between consecutive publication days:
 *
 *   since 2024-01-01 (81 gaps):  p50 8d   p90 28d   p95 31d   max 42d
 *   every gap in 2026:           max 28d
 *   longest quiet period since 2025-01-01:  42d (2025-08-14 -> 2025-09-25)
 *
 * 42 days is therefore the false-positive floor; 45 adds a slim margin above it.
 *
 * ⛔ AND THE MARGIN IS HONESTLY NARROW — 45 sits between a 42-day quiet period
 * and the 54-day ceiling this outage reached, so this check would have fired
 * around day 45, not day 2. It is the BACKSTOP, not the primary: STALL_HOURS
 * catches a hard stop within hours. What this one uniquely catches is the case
 * no mechanism signal can see at all — the key works, the requests return 200,
 * and we are silently storing nothing. Do not tighten it below 42 to make it
 * faster; that trades a real outage signal for routine false alarms. To make it
 * genuinely fast, compare the ceiling against its own history (every evaluation
 * records `newest_published_at` in cve_health_status.facts for exactly that) and
 * alert when it fails to advance across several COMPLETED sweeps.
 */
export const CORPUS_CEILING_DAYS = 45;

/**
 * One alert per state transition, then at most one reminder a day.
 *
 * ⛔ DERIVED FROM THE OUTAGE THIS FIXES: it ran 23 days. Alerting per evaluation
 * would have sent ~552 emails; one per transition plus a daily reminder sends
 * ~24 over the same window. The reminder exists because a single email 23 days
 * ago is indistinguishable from no email at all.
 */
export const NOTIFY_COOLDOWN_HOURS = 24;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * ⛔ SIX STATES, NEVER COLLAPSED, because they send the operator to four
 * different places and two of them are not his problem at all:
 *
 *   key_invalid       -> replace NVD_API_KEY **and redeploy** (the trap)
 *   stalled           -> the pipeline is dead; look at the function logs
 *   corpus_frozen     -> ingest claims success and stores nothing
 *   upstream_degraded -> NVD is having a bad hour; do NOTHING
 *   unknown           -> an unrecognised condition; look, do not assume
 *   healthy           -> nothing
 */
export type HealthState =
  | 'healthy'
  | 'key_invalid'
  | 'upstream_degraded'
  | 'stalled'
  | 'corpus_frozen'
  | 'unknown';

/** `alert` notifies. `info` is recorded and shown but never emailed. */
export type HealthSeverity = 'ok' | 'info' | 'alert';

/** Counts of targets whose MOST RECENT attempt failed, by cause. */
export type FailureBreakdown = {
  /** NVD answered 404 — with a key configured, that means the key. */
  keyRejected: number;
  /** 429 / 5xx / our own fetch deadline. Transient, not actionable. */
  upstream: number;
  /** A cause none of the known patterns recognise. Drives `unknown`. */
  other: number;
};

export type HealthFacts = {
  now: Date;
  /** Rows in cve_ingest_state. 0 means nothing is registered to ingest. */
  targets: number;
  /**
   * MAX(cve_ingest_state.last_success_at) — the fleet-wide liveness signal.
   *
   * ⛔ THE SAME VALUE ALREADY PUBLISHED AS `checked_at`, reused rather than
   * redefined. lib/cve/feed.ts computes `checked_at` from exactly this
   * expression and SecVault's freshness check keys on it, so a second
   * definition here would let the operator's view and the customer's view
   * disagree about whether the hub is alive.
   */
  fleetLastSuccessAt: Date | null;
  /** MAX(cve_advisories.published_at) — the corpus ceiling. Read-only. */
  newestPublishedAt: Date | null;
  /** Targets whose latest attempt failed, by cause. */
  failing: FailureBreakdown;
  /**
   * ⛔ IS THE 404 EVIDENCE NEWER THAN THE NEWEST SUCCESS? This single boolean is
   * what stops the alert being a liar for the first five hours after every
   * recovery.
   *
   * `last_error` is cleared to NULL on success, so a non-null error IS that
   * target's latest outcome — but the fleet is swept ~7 targets an hour, so for
   * hours after a key is fixed most targets still legitimately carry the 404
   * from their last pre-fix attempt. Measured 2026-11-15 at 15:11Z, minutes
   * after the real recovery: 16 targets held `HTTP 404` while three others had
   * just succeeded. A naive "any target 404s" rule reports key_invalid there,
   * which is false and would have paged the operator about a fault he had just
   * finished fixing.
   *
   * A 404 at time T proves the key was bad at T. A success at S > T proves it is
   * good at S. So the only 404s that say anything about NOW are the ones not
   * older than the newest success.
   */
  keyRejectedSinceLastSuccess: boolean;
  /** Whether this process holds an NVD key at all. Changes the 404 remedy. */
  hasApiKey: boolean;
  /**
   * first4…last4 of the key THIS PROCESS holds, or null.
   *
   * ⛔ IT IDENTIFIES WHICH VALUE IS RUNNING, WHICH IS THE WHOLE POINT. Netlify
   * bakes env vars in at build time, so the operator's question during a key
   * fault is never "is the key in the dashboard right" — it is "is the function
   * holding the one I set". A fingerprint in the alert answers that without a
   * second round trip to anything.
   */
  keyFingerprint: string | null;
  /** One recorded error string, for the operator. Never a key or a secret. */
  sampleError: string | null;
  /** Live keyed/unkeyed probe, when one was run. See probeApiKey(). */
  probe?: { keyedStatus: number | null; unkeyedStatus: number | null } | null;
};

export type HealthVerdict = {
  state: HealthState;
  severity: HealthSeverity;
  /** One line, safe to put in a subject header. */
  summary: string;
  /** What to actually DO. For key_invalid this MUST name the redeploy. */
  remedy: string | null;
  /** Everything the classifier looked at, for the record and the email body. */
  facts: {
    checkedAt: string;
    targets: number;
    fleetLastSuccessAt: string | null;
    hoursSinceSuccess: number | null;
    newestPublishedAt: string | null;
    daysBehindCorpus: number | null;
    failing: FailureBreakdown;
    keyRejectedSinceLastSuccess: boolean;
    hasApiKey: boolean;
    keyFingerprint: string | null;
    sampleError: string | null;
    probe: { keyedStatus: number | null; unkeyedStatus: number | null } | null;
    thresholds: { stallHours: number; corpusCeilingDays: number };
  };
};

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

function hoursBetween(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / MS_PER_HOUR;
}

/**
 * ⛔ THE WHOLE DECISION, AS A PURE FUNCTION. No DB, no clock, no network — `now`
 * is an input. Every state below is forced and asserted by
 * scripts/verify-cve-health.ts, which is the only way a guard in this repo has
 * ever been shown to fire; CLAUDE.md records several that could not.
 */
export function classifyIngestHealth(f: HealthFacts): HealthVerdict {
  const hoursSinceSuccess =
    f.fleetLastSuccessAt ? hoursBetween(f.now, f.fleetLastSuccessAt) : null;
  const daysBehindCorpus =
    f.newestPublishedAt
      ? (f.now.getTime() - f.newestPublishedAt.getTime()) / MS_PER_DAY
      : null;

  const facts: HealthVerdict['facts'] = {
    checkedAt: f.now.toISOString(),
    targets: f.targets,
    fleetLastSuccessAt: f.fleetLastSuccessAt ? f.fleetLastSuccessAt.toISOString() : null,
    hoursSinceSuccess: hoursSinceSuccess === null ? null : Math.round(hoursSinceSuccess * 10) / 10,
    newestPublishedAt: f.newestPublishedAt ? f.newestPublishedAt.toISOString() : null,
    daysBehindCorpus: daysBehindCorpus === null ? null : Math.round(daysBehindCorpus * 10) / 10,
    failing: f.failing,
    keyRejectedSinceLastSuccess: f.keyRejectedSinceLastSuccess,
    hasApiKey: f.hasApiKey,
    keyFingerprint: f.keyFingerprint,
    sampleError: f.sampleError,
    probe: f.probe ?? null,
    thresholds: { stallHours: STALL_HOURS, corpusCeilingDays: CORPUS_CEILING_DAYS },
  };

  const v = (
    state: HealthState,
    severity: HealthSeverity,
    summary: string,
    remedy: string | null
  ): HealthVerdict => ({ state, severity, summary, remedy, facts });

  // ⛔ NOTHING REGISTERED IS NOT HEALTH, IT IS AN ABSENCE OF EVIDENCE. Zero
  // targets means ensureTargets() has never run or the table was truncated; the
  // liveness and ceiling checks below would both read "fine" off an empty table
  // and report healthy, which is the exact failure mode this file exists to end.
  if (f.targets <= 0) {
    return v(
      'unknown',
      'alert',
      'No ingest targets are registered, so ingest health cannot be assessed.',
      'Check that cve_ingest_state is populated — one POST to /api/admin/ingest-cve '
        + 'calls ensureTargets() and recreates the rows from lib/cve/vendor-cpes.ts.'
    );
  }

  // --- 1. KEY VALIDITY, PROVABLE FIRST ------------------------------------
  // A live probe outranks every recorded string, in BOTH directions: it is the
  // only evidence about this instant, and the recorded 404s are by construction
  // about earlier attempts.
  // ⛔ A PROBE HAS THREE OUTCOMES, NOT TWO, AND THE THIRD IS THE DANGEROUS ONE.
  //   keyed != 200 while unkeyed == 200  -> PROVES the key is rejected
  //   keyed == 200                       -> PROVES the key works right now
  //   anything else                      -> PROVES NOTHING
  //
  // ⛔ AN INCONCLUSIVE PROBE MUST NOT DISCARD THE RECORDED EVIDENCE. An earlier
  // draft treated "a probe ran" as the branch condition, so an inconclusive
  // probe fell past the recorded-404 test entirely and reported healthy. That is
  // not hypothetical: on the very first live run of the verification harness,
  // against a deliberately wrong key, the KEYED request returned 404 and the
  // UNKEYED control timed out — probeApiKey bounds its fetches at 3000ms while
  // this repo's own measurement puts NVD at 1.5s to 14.4s, so losing the control
  // is ORDINARY, not exotic. The key was provably bad and the classifier was
  // about to call it healthy. Same failed-read-as-a-fact rule the ingest applies
  // to its own deadline: an inability to measure is not a negative finding.
  // ⛔ ONLY AN HTTP 404 IS A REJECTION. NOT A TIMEOUT, NOT A 503, NOT A 429.
  //
  // ⛔ THIS SHIPPED WRONG AND EMAILED A FALSE ALARM WITHIN THE HOUR
  // (2026-11-15 16:26:44Z). The test was `keyedStatus !== 200`, and a keyed
  // request that TIMED OUT has `keyedStatus === null` — which is `!== 200`. So a
  // probe that proved nothing was read as proof of rejection, and the alert told
  // the operator to replace a key that had successfully ingested 16 minutes
  // earlier and to redeploy on the strength of it. The alert's own FACTS block
  // contradicted its verdict in three places: "keyed no response", "404 since
  // last success false", and a sample error of HTTP 503.
  //
  // ⛔ IT IS THE SAME FAILED-READ-AS-A-FACT RULE THIS CODEBASE KEEPS WRITING
  // DOWN, in the same file that already applies it to the unkeyed control and
  // the same repo where ingestStep refuses to count its own deadline against a
  // target. Guarding one side of the probe and not the other is not a different
  // bug; it is the same bug, half-fixed. probeApiKey bounds each fetch at
  // 3000ms against NVD measured at 1.5-14.4s, so a keyed timeout is ORDINARY.
  //
  // ⛔ 404 SPECIFICALLY, because that is the signature ingest.ts documents: NVD
  // answers 404 for an invalid key and "does not use 401 or 403". A keyed 403 or
  // 429 is rate limiting and a keyed 5xx is NVD's own outage — neither says
  // anything about the credential, and both would send the operator to rotate a
  // working key.
  const probeProvesRejected =
    !!f.probe && f.hasApiKey && f.probe.keyedStatus === 404 && f.probe.unkeyedStatus === 200;
  const probeProvesWorking = !!f.probe && f.probe.keyedStatus === 200;

  if (probeProvesRejected) {
    return v(
      'key_invalid',
      'alert',
      'NVD rejects the API key this function holds (keyed 404, unkeyed 200) — that is the '
        + 'status NVD uses for an invalid key.',
      KEY_REMEDY
    );
  }
  if (!probeProvesWorking && f.keyRejectedSinceLastSuccess && f.hasApiKey) {
    return v(
      'key_invalid',
      'alert',
      `NVD answered HTTP 404 to ${f.failing.keyRejected} target(s) more recently than any `
        + 'target last succeeded — that is how NVD reports an invalid API key.',
      KEY_REMEDY
    );
  }
  if (!probeProvesWorking && f.keyRejectedSinceLastSuccess && !f.hasApiKey) {
    // ⛔ A DIFFERENT FAULT WITH THE SAME STATUS CODE. 404 with no key configured
    // is not a key problem — ingest.ts says the request URL is likely malformed
    // — and sending the operator to rotate a key he does not have wastes the
    // one alert he will read.
    return v(
      'unknown',
      'alert',
      'NVD answered HTTP 404 with NO API key configured, which is not the '
        + 'invalid-key signature.',
      'A 404 without a key points at a malformed request URL, not at credentials. '
        + 'Check NVD_BASE and the virtualMatchString in lib/cve/ingest.ts, and run the '
        + 'key probe (Dashboard -> CVE -> Test key) to see both verdicts side by side.'
    );
  }

  // --- 2. FLEET LIVENESS --------------------------------------------------
  if (hoursSinceSuccess === null) {
    return v(
      'stalled',
      'alert',
      'No ingest target has EVER succeeded.',
      'This is a first-run or a total failure, not a regression. Run the key probe '
        + '(Dashboard -> CVE -> Test key) and one manual step to see the error directly.'
    );
  }
  if (hoursSinceSuccess >= STALL_HOURS) {
    const cause = dominantCause(f.failing);
    return v(
      'stalled',
      'alert',
      `Nothing has ingested for ${facts.hoursSinceSuccess}h (threshold ${STALL_HOURS}h) `
        + `across ${f.targets} targets.`,
      'The hourly scheduled-cve-ingest is not completing successful steps. Check the '
        + `Netlify function log for scheduled-cve-ingest. Dominant recorded cause: ${cause}. `
        + (f.failing.keyRejected > 0
          ? 'Some targets carry HTTP 404 — run the key probe, and remember an env change '
            + 'needs a REDEPLOY. '
          : '')
        + 'cve_ingest_state.last_error holds the per-target reason.'
    );
  }

  // --- 3. THE OUTCOME CHECK NOBODY HAD -----------------------------------
  // ⛔ ASKED OF THE CORPUS, NOT OF THE MECHANISM, which is why it is the only
  // check that catches "the key works, the requests succeed, and we are
  // silently ingesting nothing". It is also what would have caught the whole
  // 23-day outage — mechanism-wise the fleet looked merely unlucky.
  if (daysBehindCorpus === null) {
    return v(
      'corpus_frozen',
      'alert',
      'The corpus holds no advisory with a publication date at all.',
      'cve_advisories is empty or every published_at is NULL. Run a sweep and check '
        + 'that upsertAdvisory is storing published_at.'
    );
  }
  if (daysBehindCorpus >= CORPUS_CEILING_DAYS) {
    return v(
      'corpus_frozen',
      'alert',
      `The newest CVE in the corpus was published ${facts.daysBehindCorpus} days ago `
        + `(threshold ${CORPUS_CEILING_DAYS}d), although ingest is reporting success.`,
      'Ingest is running and storing nothing new, so the error strings will look fine. '
        + 'Compare cve_ingest_state.total_results against advisories_seen per target, and '
        + 'confirm NVD is returning recent records for the CPE strings in '
        + 'lib/cve/vendor-cpes.ts. If a key was replaced recently this can also be a '
        + 'sweep that has not caught up yet — it clears itself within a full sweep.'
    );
  }

  // --- 4. TRANSIENT UPSTREAM: RECORDED, SHOWN, NEVER EMAILED -------------
  // ⛔ SEVERITY `info` ON PURPOSE. 429/5xx/timeouts are NVD's minute, not a
  // fault here, and they are already classified `retryable` so they correctly
  // do not increment consecutive_failures. Measured on a healthy tick: four of
  // seven targets 503 while three succeeded. Emailing that trains the operator
  // to filter the whole channel, and the next real alert dies in that filter.
  const totalFailing = f.failing.keyRejected + f.failing.upstream + f.failing.other;
  if (totalFailing > 0 && f.failing.other > f.failing.upstream && f.failing.other > f.failing.keyRejected) {
    // ⛔ FAIL TOWARD `unknown`, NEVER TOWARD HEALTHY. An error we cannot name is
    // the one case where assuming the best is indefensible.
    return v(
      'unknown',
      'alert',
      `${f.failing.other} target(s) failed for a reason this check does not recognise.`,
      'Read cve_ingest_state.last_error directly — the pattern is new, so classify() in '
        + `lib/cve/health.ts needs a case for it. Sample: ${f.sampleError ?? '(none recorded)'}`
    );
  }
  if (f.failing.upstream > 0) {
    return v(
      'upstream_degraded',
      'info',
      `${f.failing.upstream} of ${f.targets} targets are failing transiently `
        + `(NVD 429/5xx or our fetch deadline); last success ${facts.hoursSinceSuccess}h ago.`,
      null
    );
  }

  return v(
    'healthy',
    'ok',
    `Ingest healthy: last success ${facts.hoursSinceSuccess}h ago, corpus ceiling `
      + `${facts.daysBehindCorpus}d old, ${f.targets} targets.`,
    null
  );
}

/**
 * ⛔ THE REMEDY NAMES THE DEPLOY, AND THAT IS NOT OPTIONAL. "Set NVD_API_KEY in
 * Netlify" is insufficient advice in this codebase: Netlify bakes env vars in at
 * BUILD time, so editing the value leaves every running function on the old one.
 * That exact gap cost hours on 2026-09-17 and then 23 days from 2026-10-23. An
 * alert that gives the incomplete half of the fix reproduces the outage.
 */
const KEY_REMEDY =
  'Set a valid NVD_API_KEY in Netlify env, THEN TRIGGER A DEPLOY. An env change does '
  + 'NOT reach already-deployed functions — Netlify bakes env vars in at build time, so '
  + 'the dashboard will show the new key while every function still holds the old one. '
  + 'This is what cost hours on 2026-09-17 and 23 days from 2026-10-23. After the deploy, '
  + 'confirm with Dashboard -> CVE -> Test key: the fingerprint it reports is what the '
  + 'FUNCTION holds, not what the dashboard holds. Keys must be activated via the '
  + 'single-use link NIST emails and must carry no quotes or trailing spaces. Clearing '
  + 'NVD_API_KEY entirely also works, nine times slower.';

function dominantCause(f: FailureBreakdown): string {
  const entries: Array<[string, number]> = [
    ['NVD HTTP 404 (invalid key signature)', f.keyRejected],
    ['transient NVD 429/5xx or fetch deadline', f.upstream],
    ['unrecognised', f.other],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][1] > 0 ? `${entries[0][0]} (${entries[0][1]} targets)` : 'none recorded';
}

// ---------------------------------------------------------------------------
// Fact gathering — READ-ONLY on cve_advisories and cve_ingest_state.
// ---------------------------------------------------------------------------

/**
 * ⛔ ONE ROUND TRIP. The health check rides a ~30s scheduled function that must
 * not starve the ingest, and this repo has already measured per-call Neon round
 * trips collapsing a fetch budget to its floor. Every fact below comes from a
 * single statement.
 *
 * ⛔ THE ERROR CLASSES ARE MATCHED ON THE STRINGS ingest.ts ACTUALLY WRITES.
 * `last_error` is set to NULL on success, so `last_error IS NOT NULL` means that
 * target's MOST RECENT attempt failed — not that it ever failed.
 */
export async function readHealthFacts(): Promise<Omit<HealthFacts, 'now' | 'probe'>> {
  const r = await rawQuery<{
    targets: number;
    fleet_last_success: string | null;
    newest_published: string | null;
    key_rejected: number;
    upstream: number;
    other: number;
    key_rejected_since_success: boolean;
    sample_error: string | null;
  }>(
    `WITH s AS (SELECT * FROM cve_ingest_state),
          live AS (SELECT max(last_success_at) AS fleet_last_success FROM s)
     SELECT (SELECT count(*)::int FROM s) AS targets,
            (SELECT fleet_last_success FROM live) AS fleet_last_success,
            (SELECT max(published_at) FROM cve_advisories) AS newest_published,
            (SELECT count(*)::int FROM s
              WHERE last_error IS NOT NULL
                AND last_error LIKE '%HTTP 404%') AS key_rejected,
            -- 429, any 5xx, and our own abort. ingest.ts marks all three
            -- retryable: they are NVD's minute or our clock, never the target.
            (SELECT count(*)::int FROM s
              WHERE last_error IS NOT NULL
                AND (last_error ~ 'HTTP (429|403|5[0-9][0-9])'
                     OR last_error LIKE '%did not respond within%'
                     OR last_error LIKE '%did not finish within%'
                     OR last_error LIKE '%aborted%')) AS upstream,
            (SELECT count(*)::int FROM s
              WHERE last_error IS NOT NULL
                AND last_error NOT LIKE '%HTTP 404%'
                AND last_error !~ 'HTTP (429|403|5[0-9][0-9])'
                AND last_error NOT LIKE '%did not respond within%'
                AND last_error NOT LIKE '%did not finish within%'
                AND last_error NOT LIKE '%aborted%') AS other,
            -- ⛔ THE FRESHNESS QUALIFIER. A 404 recorded BEFORE the newest
            -- success is history; only one at or after it says anything about
            -- the key now. NULL fleet_last_success means nothing has ever
            -- succeeded, so any 404 counts.
            (SELECT EXISTS (
               SELECT 1 FROM s
                WHERE last_error LIKE '%HTTP 404%'
                  AND last_attempt_at IS NOT NULL
                  AND ((SELECT fleet_last_success FROM live) IS NULL
                       OR last_attempt_at >= (SELECT fleet_last_success FROM live))
             )) AS key_rejected_since_success,
            (SELECT last_error FROM s
              WHERE last_error IS NOT NULL
              ORDER BY consecutive_failures DESC, last_attempt_at DESC NULLS LAST
              LIMIT 1) AS sample_error`
  );
  const row = r.rows[0];
  // ⛔ THE KEY IS READ THE SAME WAY ingest.ts READS IT. A raw process.env read
  // here would disagree with rateLimitMs() about whether a whitespace-only value
  // is a key — the exact split that file already documents.
  const keyFingerprint = nvdKeyFingerprint();
  const hasApiKey = !!(process.env.NVD_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  return {
    keyFingerprint,
    targets: row?.targets ?? 0,
    fleetLastSuccessAt: row?.fleet_last_success ? new Date(row.fleet_last_success) : null,
    newestPublishedAt: row?.newest_published ? new Date(row.newest_published) : null,
    failing: {
      keyRejected: row?.key_rejected ?? 0,
      upstream: row?.upstream ?? 0,
      other: row?.other ?? 0,
    },
    keyRejectedSinceLastSuccess: !!row?.key_rejected_since_success,
    hasApiKey,
    sampleError: row?.sample_error ? row.sample_error.slice(0, 300) : null,
  };
}

/**
 * Gather the facts and classify them.
 *
 * ⛔ THE LIVE PROBE IS RUN ONLY WHEN THE RECORDED EVIDENCE ALREADY POINTS AT THE
 * KEY, and that restraint is deliberate on two counts. probeApiKey() spends two
 * live NVD requests, and it stamps `last_attempt_at` on the lowest-id state row
 * to keep its own requests inside the sweep's rate-limit window — so running it
 * on every hourly health check would systematically make that one target look
 * freshly attempted and push it down nextTarget()'s ordering for ever. Probing
 * only on suspicion costs nothing when healthy and is exactly what turns
 * key_invalid from inferred into proven when it matters.
 */
export async function evaluateIngestHealth(opts?: {
  /** Confirm a suspected key fault with a live keyed/unkeyed probe. */
  probeWhenSuspect?: boolean;
  /** Probe regardless — the manual dashboard path. */
  forceProbe?: boolean;
  now?: Date;
}): Promise<HealthVerdict> {
  await ensureCveSchema();
  const base = await readHealthFacts();
  const now = opts?.now ?? new Date();

  const suspect =
    base.keyRejectedSinceLastSuccess
    || base.fleetLastSuccessAt === null
    || (base.fleetLastSuccessAt !== null
        && hoursBetween(now, base.fleetLastSuccessAt) >= STALL_HOURS);

  let probe: HealthFacts['probe'] = null;
  if (opts?.forceProbe || (opts?.probeWhenSuspect && suspect)) {
    try {
      const p = await probeApiKey();
      probe = { keyedStatus: p.keyed.status, unkeyedStatus: p.unkeyed.status };
    } catch {
      // ⛔ A FAILED PROBE IS NOT EVIDENCE THE KEY IS FINE. Leaving `probe` null
      // falls back to the recorded 404 signature rather than clearing the
      // suspicion, which is the same failed-read-as-a-fact rule the ingest
      // applies to its own deadline.
      probe = null;
    }
  }

  return classifyIngestHealth({ ...base, now, probe });
}
