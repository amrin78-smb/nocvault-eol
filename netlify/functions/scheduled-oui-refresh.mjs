// Refresh the OUI catalogue from IEEE and republish the signed feed.
//
// ⛔ WEEKLY, NOT DAILY. IEEE assigns a few blocks a week against a catalogue of
// 54,469, and each run downloads ~5.3 MB from three registries. Daily would be
// 21 MB a week of someone else's bandwidth to observe a rounding error — and
// the EOL watch's own rule applies: match the cadence to how fast the thing
// actually changes. ⛔ Sunday 05:30 UTC, clear of every other schedule.
//
// ⛔ `mode: "both"` — refresh THEN publish. A refresh that is REFUSED by
// admission returns HTTP 400 and the publish never runs, which is correct: the
// existing catalogue stays, the existing feed stays, and the log says why.

const NAME = 'scheduled-oui-refresh';

export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
  const secret = process.env.CRON_SECRET || '';

  // ⛔ LOG BEFORE THE GUARDS, or the one case the log exists to explain prints
  // "invoked successfully" with no output.
  console.log(`${NAME} starting: base=${base ? 'set' : 'MISSING'} cronSecret=${secret ? 'set' : 'MISSING'}`);
  if (!base) return new Response('no site URL in env', { status: 500 });
  if (!secret) {
    console.log(`${NAME} ABORT: CRON_SECRET is not set.`);
    return new Response('CRON_SECRET is not set', { status: 500 });
  }

  const startedAt = Date.now();
  let result = null;
  try {
    const res = await fetch(`${base}/api/admin/oui`, {
      method: 'POST',
      headers: { 'x-cron-secret': secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'both' }),
    });
    const d = await res.json().catch(() => ({}));
    result = { http: res.status, ...d };
    console.log(`${NAME} ${JSON.stringify({
      http: result.http,
      admitted: result.refresh?.admitted,
      total: result.refresh?.total,
      perRegistry: result.refresh?.perRegistry?.map((r) => `${r.registry}:${r.rows}`).join(' '),
      skippedRows: result.refresh?.skippedRows,
      reasons: result.refresh?.reasons,
      feed_version: result.publish?.feed_version,
      unchanged: result.publish?.unchanged ?? false,
      published: result.publish?.published,
      error: result.error,
    })}`);
  } catch (err) {
    console.log(`${NAME} FAILED after ${Date.now() - startedAt}ms: ${err.message}`);
  }

  return new Response(JSON.stringify({
    seconds: Math.round((Date.now() - startedAt) / 1000),
    total: result?.refresh?.total ?? null,
    feed_version: result?.publish?.feed_version ?? null,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

// Weekly, Sunday 05:30 UTC.
export const config = { schedule: '30 5 * * 0' };
