import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { ingestStep, ingestStatus, probeApiKey } from '@/lib/cve/ingest';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ⛔ ONE STEP PER CALL, NOT A SWEEP.
//
// NVD allows one request per six seconds without an API key, and the six
// supported vendors span 32 verified CPE strings — 192 seconds of waiting at
// minimum, against a 10s function budget. A "run the whole thing" endpoint
// cannot exist here, so this does as much as fits and reports what remains.
// The caller (a button, or a scheduled function later) calls it repeatedly.
//
// Same authorisation shape as publish-feed: an admin session OR a matching
// x-cron-secret, so automating it later needs no change here.

/**
 * Progress, for the dashboard. Safe to poll.
 *
 * `?probe=1` instead runs the API-key probe. ⛔ It is deliberately NOT part of
 * the normal status payload: it makes two live NVD requests with a 6.5s pause
 * between them, and the dashboard polls status on mount.
 */
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const cronSecret = process.env.CRON_SECRET;
  if (!session && !cronSecret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    if (new URL(req.url).searchParams.get('probe') === '1') {
      return NextResponse.json({ ok: true, probe: await probeApiKey() });
    }
    return NextResponse.json({ ok: true, ...(await ingestStatus()) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const cronSecret = process.env.CRON_SECRET;
  const provided = req.headers.get('x-cron-secret');
  const authorized = !!session || (!!cronSecret && provided === cronSecret);
  if (!authorized) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // A caller on a longer-lived runtime (a background or scheduled function) can
  // ask for more; the default stays well under the 10s synchronous budget so the
  // function RETURNS rather than being killed. A killed invocation loses the
  // progress it made, which is the one thing the state table exists to prevent.
  let budgetMs: number | undefined;
  try {
    const body = await req.json();
    if (body && typeof body.budgetMs === 'number') {
      budgetMs = Math.max(1000, Math.min(120000, body.budgetMs));
    }
  } catch {
    // no body is the normal case
  }

  try {
    const result = await ingestStep(budgetMs);
    // ⛔ A step that failed on ONE target is still a 200 with ok:false. It is not
    // a server error — the state machine recorded the failure, deprioritised
    // that target and will continue with others. Returning 500 would make a
    // caller stop sweeping because one CPE string is unreachable.
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
