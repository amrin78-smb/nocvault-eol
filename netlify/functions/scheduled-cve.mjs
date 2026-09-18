// Scheduled CVE ingest + publish.
//
// ⛔ THE LOOP LIVES HERE BECAUSE ONLY HERE HAS THE BUDGET. A Netlify SCHEDULED
// function gets ~15 minutes; the synchronous route it calls gets ~10 seconds. So
// /api/admin/ingest-cve does exactly ONE bounded step per call and this drives it
// repeatedly. Trying to sweep inside the route is what produced a wall of killed
// invocations that recorded nothing.
//
// ⛔ IT DOES NOT HAVE TO FINISH, AND THAT IS THE DESIGN. Ingestion is a resumable
// state machine (cve_ingest_state.next_start_index), so a run that stops on the
// wall clock has still made progress and the next run continues. What it must
// never do is run past its own budget and be killed mid-write.
//
// ⛔ IT PUBLISHES WHATEVER IT HAS, EVERY RUN. Publishing is cheap and is now a
// no-op when the corpus is unchanged, so there is no reason to gate it on the
// sweep completing — and gating it would mean a feed that never refreshes on a
// site where one stubborn CPE string always times out.

const WALL_CLOCK_MS = 11 * 60 * 1000;   // leave room inside the ~15 min budget
const MAX_STEPS = 2000;
const MAX_CONSECUTIVE_FAILS = 8;        // a genuine refusal (404/400), not a timeout
const MAX_THROTTLE_WAITS = 400;

export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
  const secret = process.env.CRON_SECRET || '';
  if (!base) return new Response('no site URL in env', { status: 500 });
  if (!secret) return new Response('CRON_SECRET is not set — refusing to run unauthenticated', { status: 500 });

  const startedAt = Date.now();
  const headers = { 'x-cron-secret': secret };
  let steps = 0, fails = 0, throttles = 0, inserted = 0, updated = 0, timeouts = 0;
  let stopReason = 'complete';

  while (steps < MAX_STEPS) {
    if (Date.now() - startedAt > WALL_CLOCK_MS) { stopReason = 'wall-clock budget'; break; }

    let d;
    try {
      const r = await fetch(`${base}/api/admin/ingest-cve`, { method: 'POST', headers });
      d = await r.json();
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
    } catch (err) {
      // ⛔ A transport failure is a killed invocation — the server recorded
      // nothing, so it is not attributable to a target. Counted, never fatal on
      // its own.
      fails++;
      if (fails >= MAX_CONSECUTIVE_FAILS) { stopReason = `transport: ${err.message}`; break; }
      await new Promise((res) => setTimeout(res, 1500));
      continue;
    }

    if (d.throttled) {
      // Server-side NVD rate limit. Not a step; it has its own budget.
      if (++throttles > MAX_THROTTLE_WAITS) { stopReason = 'still throttled'; break; }
      await new Promise((res) => setTimeout(res, Math.max(250, Math.min(30000, d.waitMs || 1000))));
      continue;
    }

    steps++;
    inserted += d.inserted || 0;
    updated += d.updated || 0;

    if (d.ok === false) {
      // ⛔ A TIMEOUT IS OURS, NOT THE TARGET'S, and does not count toward the
      // refusal budget — NVD answers identical requests between 1.5s and 14.4s.
      if (d.retryable) { timeouts++; fails = 0; }
      else if (++fails >= MAX_CONSECUTIVE_FAILS) { stopReason = `refused: ${d.error}`; break; }
    } else {
      fails = 0;
    }

    if (d.targetsRemaining === 0 && !d.moreForThisTarget) break;
  }

  let publish = null;
  try {
    const r = await fetch(`${base}/api/admin/publish-cve-feed`, { method: 'POST', headers });
    publish = await r.json();
  } catch (err) {
    publish = { error: err.message };
  }

  const summary = {
    stopReason,
    steps,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    inserted,
    updated,
    timeouts,
    throttles,
    feed_version: publish?.feed_version ?? null,
    row_count: publish?.row_count ?? null,
    unchanged: publish?.unchanged ?? false,
    published: publish?.published ?? false,
    publish_error: publish?.error ?? null,
  };
  console.log(`scheduled-cve ${JSON.stringify(summary)}`);
  return new Response(JSON.stringify(summary), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};

// ⛔ EVERY SIX HOURS, MATCHING WHAT THE CONSUMER ALREADY DOES. SecVault syncs its
// feeds on a 6-hourly cycle, and a hub that refreshed less often would leave it
// faithfully importing a stale corpus — worse than an obvious failure, because
// every signal stays green. Four runs a day also means a sweep that ran out of
// wall clock is continued within hours rather than tomorrow.
export const config = { schedule: '20 */6 * * *' };
