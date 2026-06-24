// Monthly auto-publish of the EOL feed. Netlify runs this on a schedule and it
// POSTs the admin publish route with the shared CRON_SECRET (no session). The
// route does the DB read + sign + Blobs write. Manual runs use the dashboard button.
export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
  const secret = process.env.CRON_SECRET || '';
  if (!base) return new Response('no site URL in env', { status: 500 });

  const res = await fetch(`${base}/api/admin/publish-feed`, {
    method: 'POST',
    headers: { 'x-cron-secret': secret },
  });
  const body = await res.text();
  console.log(`scheduled-publish -> ${res.status}: ${body}`);
  return new Response(body, { status: res.status });
};

// 06:00 UTC on the 1st of each month.
export const config = { schedule: '0 6 1 * *' };
