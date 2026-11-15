// lib/cve/health-alerts.ts
//
// The alerting state machine around lib/cve/health.ts: decide whether a verdict
// is NEWS, send it if so, and record it either way.
//
// ⛔ DEDUPLICATION IS THE FEATURE, NOT A REFINEMENT. The outage this was built
// for ran 23 days. Emailing every evaluation would have sent ~552 messages, and
// an operator who filters that channel has uninstalled the alert — so the next
// real fault is silent again, with extra steps. One message per state
// TRANSITION, at most one reminder per cooldown, and an all-clear when it ends.
//
// ⛔ AND THE ALL-CLEAR IS LOAD-BEARING. A cooldown deliberately makes "fixed"
// and "still broken, stopped emailing" look identical from the inbox. Only a
// recovery message tells them apart.
//
// ⛔ THE VERDICT IS RECORDED BEFORE, AND REGARDLESS OF, ANY SEND. If the mailer
// is unconfigured or broken, the check must still have run, still have decided,
// and still be readable on /api/health and the dashboard — because "a failure
// nobody was told about" is precisely the defect being fixed, and a health
// checker that reports only by email reintroduces it one layer up.

import { rawQuery } from '../db';
import { ensureCveSchema } from './schema';
import {
  evaluateIngestHealth,
  NOTIFY_COOLDOWN_HOURS,
  type HealthVerdict,
} from './health';
import { sendAlertEmail, notifyConfigured, type NotifyResult } from './notify';

/** What the state machine decided to do with this verdict. */
export type AlertAction =
  | 'none'                 // healthy/info, nothing open
  | 'opened'               // new episode -> notified
  | 'reminded'             // same episode, cooldown elapsed -> notified
  | 'suppressed_cooldown'  // same episode, inside cooldown -> not notified
  | 'superseded'           // different alert state -> old resolved, new notified
  | 'recovered'            // episode resolved -> all-clear notified
  | 'recovered_silently';  // episode resolved, but it had never been notified

export type HealthCheckResult = {
  verdict: HealthVerdict;
  action: AlertAction;
  /** Null when the action sent nothing. */
  notify: NotifyResult | null;
  /** Whether a mailer is configured at all, and why not when it is not. */
  notifyConfigured: { ok: boolean; reason: string };
  episodeId: number | null;
};

type OpenEpisode = {
  id: number;
  state: string;
  first_seen_at: string;
  notified_at: string | null;
  notify_count: number;
};

const MS_PER_HOUR = 3_600_000;

/**
 * Evaluate ingest health, alert if it is news, and record the verdict.
 *
 * `trigger` only labels the log line — the decision is identical whether this
 * came from the schedule or the dashboard button, so a manual check can never
 * produce a different verdict from the automatic one.
 */
export async function runHealthCheck(opts?: {
  trigger?: string;
  forceProbe?: boolean;
}): Promise<HealthCheckResult> {
  await ensureCveSchema();

  // ⛔ ONE CLOCK, AND IT IS NOT AN INPUT. An earlier draft let the caller state
  // `now` so a test could fast-forward the 24h cooldown — but the same value
  // also dates the liveness check, so a cooldown test silently became a
  // 26h-stale test and the verdict changed underneath it. One clock cannot do
  // two jobs. evaluateIngestHealth() still takes `now` (it is pure and judges
  // one thing); the cooldown is exercised by back-dating notified_at, which is
  // the column the cooldown actually reads.
  const now = new Date();
  const verdict = await evaluateIngestHealth({
    probeWhenSuspect: true,
    forceProbe: opts?.forceProbe,
    now,
  });
  const cfg = notifyConfigured();

  const open = await loadOpenEpisode();
  const isAlert = verdict.severity === 'alert';

  let action: AlertAction;
  let notify: NotifyResult | null = null;
  let episodeId: number | null = open?.id ?? null;

  if (isAlert) {
    if (open && open.state === verdict.state) {
      // Same fault, still present. Remind only once per cooldown.
      const lastNotified = open.notified_at ? new Date(open.notified_at) : null;
      const hoursSinceNotify =
        lastNotified ? (now.getTime() - lastNotified.getTime()) / MS_PER_HOUR : Infinity;
      await rawQuery(
        `UPDATE cve_health_alerts
            SET last_seen_at = $2::timestamptz, summary = $3, detail = $4::jsonb
          WHERE id = $1`,
        [open.id, now.toISOString(), verdict.summary, JSON.stringify(verdict.facts)]
      );
      if (hoursSinceNotify >= NOTIFY_COOLDOWN_HOURS) {
        // ⛔ "STILL FAILING" ONLY IF SOMETHING WAS ACTUALLY SAID BEFORE. The
        // episode being old does not make this a reminder — a send that never
        // landed leaves notify_count at 0, and the first message the operator
        // ever receives must not open with "[STILL FAILING] … Reminder 1".
        // Observed live on 2026-11-15: the episode opened at 16:19Z on a build
        // whose ALERT_EMAIL_TO was empty, so the first deliverable message would
        // have arrived labelled as a repeat of something nobody had been told.
        notify = await deliver(verdict, open.notify_count > 0 ? 'reminder' : 'new', open, now);
        await markNotified(open.id, now, notify);
        action = 'reminded';
      } else {
        action = 'suppressed_cooldown';
      }
    } else {
      // ⛔ A DIFFERENT ALERT STATE SUPERSEDES; IT DOES NOT "RECOVER". Resolving
      // the old episode with an all-clear while a new fault is active would tell
      // the operator the opposite of the truth. The new alert carries the news.
      if (open) {
        await rawQuery(
          `UPDATE cve_health_alerts SET resolved_at = $2, last_seen_at = $2 WHERE id = $1`,
          [open.id, now.toISOString()]
        );
      }
      episodeId = await openEpisode(verdict, now);
      notify = await deliver(verdict, open ? 'superseded' : 'new', open, now);
      await markNotified(episodeId, now, notify);
      action = open ? 'superseded' : 'opened';
    }
  } else {
    if (open) {
      // ⛔ EVERY TIMESTAMP PARAMETER IS CAST EXPLICITLY, and this statement is
      // why. `recovery_notified_at = CASE WHEN $3 THEN $2 ELSE NULL END` gives
      // Postgres no column to infer $2 from inside the CASE, so it deduced text
      // there and timestamptz from the two direct assignments, and refused the
      // whole statement with `42P08 inconsistent types deduced for parameter $2`.
      //
      // ⛔ IT FAILED ONLY ON THE RECOVERY PATH — the all-clear. Open, remind and
      // supersede all passed; the one query that runs when a fault CLEARS threw,
      // which would have left an episode permanently open and the operator
      // permanently unsure whether anything had been fixed. Caught by executing
      // the recovery, invisible to reading it.
      await rawQuery(
        `UPDATE cve_health_alerts
            SET resolved_at = $2::timestamptz, last_seen_at = $2::timestamptz,
                recovery_notified_at = CASE WHEN $3 THEN $2::timestamptz ELSE NULL END
          WHERE id = $1`,
        [open.id, now.toISOString(), open.notify_count > 0]
      );
      if (open.notify_count > 0) {
        notify = await deliver(verdict, 'recovery', open, now);
        action = 'recovered';
      } else {
        // ⛔ NO ALL-CLEAR FOR AN ALERT THAT WAS NEVER DELIVERED. An inbox that
        // never received the alarm does not need the stand-down, and sending one
        // is how an operator learns the channel is noise.
        action = 'recovered_silently';
      }
      episodeId = open.id;
    } else {
      action = 'none';
      episodeId = null;
    }
  }

  await recordStatus(verdict, action, notify, cfg, now);

  // ⛔ ONE LINE, ALWAYS, BEFORE ANY GUARD COULD HAVE RETURNED. The scheduled
  // functions in this repo previously logged only on their success paths, so
  // hitting a guard produced "invoked successfully" with no output in exactly
  // the case the log existed to explain.
  console.log(
    `cve-health [${opts?.trigger ?? 'manual'}] state=${verdict.state} `
    + `severity=${verdict.severity} action=${action} `
    + `notify=${notify ? (notify.sent ? 'sent' : `failed:${notify.skipped}`) : 'n/a'} `
    + `configured=${cfg.ok} :: ${verdict.summary}`
  );

  return { verdict, action, notify, notifyConfigured: cfg, episodeId };
}

async function loadOpenEpisode(): Promise<OpenEpisode | null> {
  const r = await rawQuery<OpenEpisode>(
    `SELECT id, state, first_seen_at, notified_at, notify_count
       FROM cve_health_alerts
      WHERE resolved_at IS NULL
      ORDER BY id DESC
      LIMIT 1`
  );
  return r.rows[0] ?? null;
}

async function openEpisode(verdict: HealthVerdict, now: Date): Promise<number> {
  const r = await rawQuery<{ id: number }>(
    `INSERT INTO cve_health_alerts
       (state, severity, summary, first_seen_at, last_seen_at, detail)
     VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz, $5::jsonb)
     RETURNING id`,
    [verdict.state, verdict.severity, verdict.summary, now.toISOString(), JSON.stringify(verdict.facts)]
  );
  return r.rows[0].id;
}

async function markNotified(id: number, now: Date, notify: NotifyResult) {
  // ⛔ notified_at ADVANCES ONLY ON A REAL SEND. Stamping it on a failed send
  // would start the 24h cooldown on a message that never arrived, turning one
  // broken mailer into a full day of deliberate silence.
  await rawQuery(
    `UPDATE cve_health_alerts
        SET notified_at = CASE WHEN $3 THEN $2::timestamptz ELSE notified_at END,
            notify_count = notify_count + CASE WHEN $3 THEN 1 ELSE 0 END,
            last_notify_result = $4
      WHERE id = $1`,
    [id, now.toISOString(), notify.sent, `${notify.sent ? 'sent' : notify.skipped}: ${notify.detail}`.slice(0, 400)]
  );
}

async function recordStatus(
  verdict: HealthVerdict,
  action: AlertAction,
  notify: NotifyResult | null,
  cfg: { ok: boolean; reason: string },
  now: Date
) {
  const notifyStatus = notify
    ? (notify.sent ? 'sent' : `not_sent:${notify.skipped}`)
    : (action === 'suppressed_cooldown' ? 'suppressed_cooldown' : 'not_required');
  const notifyDetail = notify ? notify.detail : cfg.reason;
  await rawQuery(
    `INSERT INTO cve_health_status
       (id, checked_at, state, severity, summary, remedy, facts, notify_status, notify_detail)
     VALUES (1, $1::timestamptz, $2, $3, $4, $5, $6::jsonb, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       checked_at = EXCLUDED.checked_at,
       state = EXCLUDED.state,
       severity = EXCLUDED.severity,
       summary = EXCLUDED.summary,
       remedy = EXCLUDED.remedy,
       facts = EXCLUDED.facts,
       notify_status = EXCLUDED.notify_status,
       notify_detail = EXCLUDED.notify_detail`,
    [
      now.toISOString(),
      verdict.state,
      verdict.severity,
      verdict.summary,
      verdict.remedy,
      JSON.stringify(verdict.facts),
      notifyStatus,
      notifyDetail?.slice(0, 500) ?? null,
    ]
  );
}

/** The latest recorded verdict, for /api/health and the dashboard. */
export async function readHealthStatus(): Promise<{
  checkedAt: string;
  state: string;
  severity: string;
  summary: string;
  remedy: string | null;
  facts: any;
  notifyStatus: string | null;
  notifyDetail: string | null;
  openEpisode: { id: number; state: string; firstSeenAt: string; notifyCount: number } | null;
} | null> {
  await ensureCveSchema();
  const r = await rawQuery<any>(
    `SELECT checked_at, state, severity, summary, remedy, facts, notify_status, notify_detail
       FROM cve_health_status WHERE id = 1`
  );
  if (!r.rows[0]) return null;
  const open = await loadOpenEpisode();
  const row = r.rows[0];
  return {
    checkedAt: new Date(row.checked_at).toISOString(),
    state: row.state,
    severity: row.severity,
    summary: row.summary,
    remedy: row.remedy,
    facts: row.facts,
    notifyStatus: row.notify_status,
    notifyDetail: row.notify_detail,
    openEpisode: open
      ? {
          id: open.id,
          state: open.state,
          firstSeenAt: new Date(open.first_seen_at).toISOString(),
          notifyCount: open.notify_count,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Message composition
// ---------------------------------------------------------------------------

function deliver(
  verdict: HealthVerdict,
  kind: 'new' | 'reminder' | 'superseded' | 'recovery',
  open: OpenEpisode | null,
  now: Date
): Promise<NotifyResult> {
  const site = process.env.URL || process.env.NEXTAUTH_URL || '(site URL not set in env)';
  const f = verdict.facts;

  if (kind === 'recovery') {
    const since = open ? ` It was first seen at ${new Date(open.first_seen_at).toISOString()}.` : '';
    return sendAlertEmail(
      `[RECOVERED] nocvault-eol CVE ingest: ${open?.state ?? 'alert'} cleared`,
      [
        `The CVE ingest alert "${open?.state ?? 'alert'}" has CLEARED.${since}`,
        '',
        `Current state: ${verdict.state} (${verdict.severity})`,
        verdict.summary,
        '',
        factBlock(f),
        '',
        `Dashboard: ${site}/dashboard`,
        `Health JSON: ${site}/api/health`,
      ].join('\n')
    );
  }

  const prefix =
    kind === 'reminder'
      ? '[STILL FAILING]'
      : kind === 'superseded'
        ? '[CHANGED]'
        : '[ALERT]';
  const openedLine =
    kind === 'reminder' && open
      ? `This fault has been open since ${new Date(open.first_seen_at).toISOString()} `
        + `(${Math.round((now.getTime() - new Date(open.first_seen_at).getTime()) / 3_600_000)}h). `
        + `Reminder ${open.notify_count + 1}; one is sent at most every ${NOTIFY_COOLDOWN_HOURS}h.`
      : kind === 'superseded' && open
        ? `This REPLACES the previous alert "${open.state}", which has been closed.`
        : 'First notification for this fault.';

  return sendAlertEmail(
    `${prefix} nocvault-eol CVE ingest: ${verdict.state}`,
    [
      verdict.summary,
      '',
      openedLine,
      '',
      '--- WHAT TO DO ---',
      verdict.remedy ?? '(no remedy recorded for this state)',
      '',
      '--- WHY THIS MATTERS ---',
      'SecVault customer sites cannot reach NVD directly (their internal public IP ranges',
      'overlap NVD\'s address space), so this hub is their ONLY source of usable CVE version',
      'ranges. A frozen hub is a CVE-discovery outage for those customers, not a cosmetic chip.',
      '',
      factBlock(f),
      '',
      `Dashboard: ${site}/dashboard`,
      `Health JSON: ${site}/api/health`,
    ].join('\n')
  );
}

function factBlock(f: HealthVerdict['facts']): string {
  return [
    '--- FACTS ---',
    `checked at              ${f.checkedAt}`,
    `ingest targets          ${f.targets}`,
    `last successful ingest  ${f.fleetLastSuccessAt ?? 'never'}`
      + (f.hoursSinceSuccess === null ? '' : ` (${f.hoursSinceSuccess}h ago, threshold ${f.thresholds.stallHours}h)`),
    `newest CVE in corpus    ${f.newestPublishedAt ?? 'none'}`
      + (f.daysBehindCorpus === null ? '' : ` (${f.daysBehindCorpus}d old, threshold ${f.thresholds.corpusCeilingDays}d)`),
    `targets failing now     ${f.failing.keyRejected} key-rejected / `
      + `${f.failing.upstream} transient / ${f.failing.other} unrecognised`,
    `404 since last success  ${f.keyRejectedSinceLastSuccess}`,
    // ⛔ FINGERPRINT, NEVER THE KEY. It answers "is the function holding the
    // value I set?", which is the question a Netlify env change makes unanswerable.
    `NVD key in function     ${f.hasApiKey ? (f.keyFingerprint ?? '(set)') : 'NOT SET'}`,
    f.probe
      ? `live key probe          keyed ${f.probe.keyedStatus ?? 'no response'} / unkeyed ${f.probe.unkeyedStatus ?? 'no response'}`
      : 'live key probe          not run (recorded evidence did not point at the key)',
    f.sampleError ? `sample last_error       ${f.sampleError}` : '',
  ].filter(Boolean).join('\n');
}
