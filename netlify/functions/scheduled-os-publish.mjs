// Publish the OS/firmware branch lifecycle feed.
//
// ⛔ IT RUNS EVERY DAY EVEN THOUGH THE CORPUS CHANGES A FEW TIMES A YEAR, and
// that is the point. Publishing is idempotent on a payload digest: an unchanged
// corpus republishes nothing and keeps its version. What the run still does is
// refresh `checked_at` in the pointer — the liveness signal. Without a run, a
// quiet corpus and a dead hub look identical to a consumer, which is the exact
// failure the CVE side spent 23 silent days proving.
//
// ⛔ IT SEEDS AS WELL AS PUBLISHES (`mode: "both"`), because the corpus lives in
// a DEPLOYED JSON FILE. A deploy that ships a new data/os-lifecycle.json changes
// nothing until something loads it into Neon; leaving that to a human means the
// file and the feed drift silently, which is the EOL seed's standing footgun.
// Seeding is an idempotent upsert, so doing it daily costs one round trip.
//
// ⛔ 06:50 UTC — after scheduled-eol-watch (06:20), which is what refreshes the
// `checked_at` this publish then copies into the pointer, and clear of the
// monthly EOL publish (06:00 on the 1st) and every CVE schedule.

const NAME = 'scheduled-os-publish';

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
    const res = await fetch(`${base}/api/admin/os-feed`, {
      method: 'POST',
      headers: { 'x-cron-secret': secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'both' }),
    });
    const d = await res.json().catch(() => ({}));
    result = { http: res.status, ...d };
    console.log(`${NAME} ${JSON.stringify({
      http: result.http,
      applied: result.applied
        ? { total: result.applied.total, removed: result.applied.removed, rejected: result.applied.rejected?.length ?? 0 }
        : null,
      feed_version: result.publish?.feed_version,
      unchanged: result.publish?.unchanged ?? false,
      row_count: result.publish?.row_count,
      published: result.publish?.published,
      checked_at: result.publish?.checked_at,
      note: result.publish?.publish_note,
      error: result.error,
    })}`);
  } catch (err) {
    console.log(`${NAME} FAILED after ${Date.now() - startedAt}ms: ${err.message}`);
  }

  const summary = {
    seconds: Math.round((Date.now() - startedAt) / 1000),
    feed_version: result?.publish?.feed_version ?? null,
    row_count: result?.publish?.row_count ?? null,
    unchanged: result?.publish?.unchanged ?? null,
  };
  return new Response(JSON.stringify(summary), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};

// Daily at 06:50 UTC — after the vendor page watch at 06:20.
export const config = { schedule: '50 6 * * *' };
