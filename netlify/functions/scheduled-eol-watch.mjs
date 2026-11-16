// Vendor EOL page change detection — read the watched listings, raise review items.
//
// ⛔ DAILY, NOT HOURLY, AND THAT IS A MEASUREMENT NOT A PREFERENCE. Vendor
// lifecycle listings change a few times a YEAR; the CVE feeds change a few times
// a week. Polling eight vendor pages every hour would be 192 fetches a day to
// observe something that moves monthly, and it would put this service in the
// position of hammering vendor sites that already front themselves with WAFs —
// SonicWall's answers an Incapsula denial to a single polite request as it is.
//
// ⛔ 06:20 UTC. Clear of the monthly EOL publish (06:00 on the 1st), of
// scheduled-cve-ingest (:10), health (:25), rss (:40) and publish (:45). A
// scheduled function is capped near 30 seconds and a second thing queued behind
// a first thing is hostage to it — the defect that lost the first CVE publish.
//
// ⛔ ONE CYCLE DOES NOT HAVE TO FINISH. runEolWatch works the least-recently-
// fetched source first and stops before starting a fetch it cannot fund, so a
// slice that runs out of clock has still made progress and tomorrow continues.
// At eight sources and a 20-hour recheck window, a partial cycle self-heals.

const WALL_CLOCK_MS = 24000;
const NAME = 'scheduled-eol-watch';

export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
  const secret = process.env.CRON_SECRET || '';

  // ⛔ LOG BEFORE THE GUARDS. Logging only on the success path produced
  // "invoked successfully" with no output in exactly the case the log exists to
  // explain.
  console.log(`${NAME} starting: base=${base ? 'set' : 'MISSING'} cronSecret=${secret ? 'set' : 'MISSING'}`);
  if (!base) {
    console.log(`${NAME} ABORT: no site URL in env (URL / DEPLOY_PRIME_URL / DEPLOY_URL all unset)`);
    return new Response('no site URL in env', { status: 500 });
  }
  if (!secret) {
    console.log(`${NAME} ABORT: CRON_SECRET is not set, so this cannot authenticate to the admin route.`);
    return new Response('CRON_SECRET is not set', { status: 500 });
  }

  const startedAt = Date.now();
  let result = null;
  try {
    const res = await fetch(`${base}/api/admin/eol-watch`, {
      method: 'POST',
      headers: { 'x-cron-secret': secret, 'Content-Type': 'application/json' },
      // ⛔ THE BUDGET IS STATED. Twice in this repo a scheduled caller posted no
      // body, took a default sized for a different invocation, and starved the
      // fetch it was supposed to make.
      body: JSON.stringify({ mode: 'check', budgetMs: WALL_CLOCK_MS - 4000 }),
    });
    const d = await res.json().catch(() => ({}));
    result = { http: res.status, ...d };
    console.log(`${NAME} cycle: ${JSON.stringify({
      http: result.http, checked: result.checked, changed: result.changed,
      firstSeen: result.firstSeen, unchanged: result.unchanged, failed: result.failed,
      remaining: result.remaining,
      notified: result.notify?.changesNotified ?? 0,
      unreadableNotified: result.notify?.unreadableNotified ?? 0,
      mail: result.notify?.notify?.skipped ?? (result.notify?.notify?.sent ? 'sent' : null),
      error: result.error,
    })}`);
    // ⛔ NAME EACH CHANGE IN THE LOG. The email may be the thing that is broken;
    // the log is the surface that is not.
    for (const s of result.steps || []) {
      if (s.outcome === 'changed' || s.outcome === 'failed') {
        console.log(`${NAME}   ${s.outcome}: ${s.vendor} / ${s.label} — ${
          s.outcome === 'changed'
            ? `+${s.added} -${s.removed} (now ${s.signalCount})`
            : s.error
        }`);
      }
    }
  } catch (err) {
    console.log(`${NAME} FAILED after ${Date.now() - startedAt}ms: ${err.message}`);
  }

  const summary = {
    seconds: Math.round((Date.now() - startedAt) / 1000),
    checked: result?.checked ?? 0,
    changed: result?.changed ?? 0,
    failed: result?.failed ?? 0,
    remaining: result?.remaining ?? null,
  };
  console.log(`${NAME} ${JSON.stringify(summary)}`);
  return new Response(JSON.stringify(summary), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};

// Daily at 06:20 UTC — clear of the monthly EOL publish at 06:00 and of every
// CVE schedule (:10, :25, :40, :45).
export const config = { schedule: '20 6 * * *' };
