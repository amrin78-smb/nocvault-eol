import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { applyOsCycles, buildAndPublishOsFeed, osFeedStatus } from '@/lib/eol/os-feed';
import { secretMatches } from '@/lib/cve/license';
import type { OsCycle } from '@/lib/eol/os-cycles';
import osCycles from '@/data/os-lifecycle.json';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 26;

/** Corpus + last published version, for the dashboard. */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, ...(await osFeedStatus()) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST — load the curated corpus, publish the signed feed, or both.
 *
 * `{ "mode": "seed" }`    upsert data/os-lifecycle.json into os_cycles
 * `{ "mode": "publish" }` build + sign + write the os-feed blobs (default)
 * `{ "mode": "both" }`    seed then publish
 *
 * ⛔ THE CORPUS COMES FROM THE DEPLOYED JSON FILE, exactly as the EOL seed
 * button reads data/eol-seed.json. Nothing here parses a vendor page: that is
 * `npm run build:os-cycles`, run by a person, whose output is reviewed as a git
 * diff. See lib/eol/os-cycles.ts for why that line matters.
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const authorized =
    !!session || secretMatches(req.headers.get('x-cron-secret'), process.env.CRON_SECRET);
  if (!authorized) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let mode = 'publish';
  try {
    const body = await req.json();
    if (body && ['seed', 'publish', 'both'].includes(body.mode)) mode = body.mode;
  } catch {
    // no body is the normal case
  }

  try {
    const out: Record<string, unknown> = { mode };
    if (mode === 'seed' || mode === 'both') {
      const applied = await applyOsCycles(osCycles as OsCycle[]);
      out.applied = applied;
      // ⛔ A REJECTED CORPUS IS AN ERROR, NOT A QUIET NO-OP. applyOsCycles
      // validates before it writes; if it refused, saying so is the whole point.
      if (applied.rejected.length) {
        return NextResponse.json(
          { ok: false, mode, error: `corpus rejected: ${applied.rejected.length} invalid row(s)`, ...out },
          { status: 400 }
        );
      }
    }
    if (mode === 'publish' || mode === 'both') {
      out.publish = await buildAndPublishOsFeed({ publishedBy: session?.user?.email || 'cron' });
    }
    return NextResponse.json({ ok: true, ...out });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
