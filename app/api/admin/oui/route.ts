import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { refreshOuiCatalogue, buildAndPublishOuiFeed, ouiStatus } from '@/lib/oui/feed';
import { secretMatches } from '@/lib/cve/license';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Three registry downloads totalling ~5.3 MB plus a wholesale replace. This is
// the longest-running admin route in the repo and 26 is the ceiling Netlify
// allows; the refresh is NOT resumable, so it either completes or changes
// nothing — which is why admission happens before any write.
export const maxDuration = 26;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, ...(await ouiStatus()) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * `{ "mode": "refresh" }` pull the IEEE registries, admit or refuse
 * `{ "mode": "publish" }` build + sign + write the oui-feed blobs (default)
 * `{ "mode": "both" }`    refresh then publish
 *
 * ⛔ A REFUSED REFRESH IS AN ERROR WITH ITS REASONS, NOT A QUIET NO-OP. The
 * whole point of admission is that somebody finds out the registry read was
 * rejected; reporting ok:true would reproduce the silent-failure defect this
 * repo keeps rediscovering.
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const authorized =
    !!session || secretMatches(req.headers.get('x-cron-secret'), process.env.CRON_SECRET);
  if (!authorized) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let mode = 'publish';
  try {
    const body = await req.json();
    if (body && ['refresh', 'publish', 'both'].includes(body.mode)) mode = body.mode;
  } catch { /* no body is the normal case */ }

  try {
    const out: Record<string, unknown> = { mode };
    if (mode === 'refresh' || mode === 'both') {
      const refresh = await refreshOuiCatalogue();
      out.refresh = refresh;
      if (!refresh.admitted) {
        return NextResponse.json(
          { ok: false, mode, error: `registry refresh REFUSED: ${refresh.reasons.join('; ')}`,
            note: 'the existing catalogue was left untouched', ...out },
          { status: 400 }
        );
      }
    }
    if (mode === 'publish' || mode === 'both') {
      out.publish = await buildAndPublishOuiFeed({ publishedBy: session?.user?.email || 'cron' });
    }
    return NextResponse.json({ ok: true, ...out });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
