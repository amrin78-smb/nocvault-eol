import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { runEolWatch, acknowledgeChange, eolWatchStatus, notifyWatchFindings } from '@/lib/eol/watch';
import { secretMatches } from '@/lib/cve/license';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Eight pages at up to 10s each will not fit one invocation, and that is fine:
// the cycle is resumable and runs daily. 26 is the same ceiling the ingest and
// RSS routes use.
export const maxDuration = 26;

/** Watched sources + the open review queue. Read-only, no network. */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, ...(await eolWatchStatus()) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST — one bounded cycle, or an acknowledgement.
 *
 * `{ "mode": "check" }`        read every due source, then notify once (default)
 * `{ "mode": "notify" }`       re-attempt delivery of findings already recorded
 * `{ "mode": "acknowledge", "id": N, "note": "..." }`  close one review item
 *
 * ⛔ THIS ROUTE NEVER WRITES AN EOL DATE AND HAS NO PATH TO ONE. It touches
 * eol_watch_sources and eol_watch_changes only. The model catalogue is written
 * by /api/admin/seed from the curated data/eol-seed.json, by a human, after
 * reading an official bulletin.
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const authorized =
    !!session || secretMatches(req.headers.get('x-cron-secret'), process.env.CRON_SECRET);
  if (!authorized) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let mode = 'check';
  let budgetMs: number | undefined;
  let id: number | undefined;
  let note: string | undefined;
  try {
    const body = await req.json();
    if (body && typeof body.mode === 'string' && ['check', 'notify', 'acknowledge'].includes(body.mode)) {
      mode = body.mode;
    }
    if (body && typeof body.budgetMs === 'number') {
      budgetMs = Math.max(3000, Math.min(120000, body.budgetMs));
    }
    if (body && typeof body.id === 'number') id = body.id;
    if (body && typeof body.note === 'string') note = body.note;
  } catch {
    // no body is the normal case
  }

  try {
    if (mode === 'acknowledge') {
      if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
      const done = await acknowledgeChange(id, note);
      return NextResponse.json({ ok: done, mode, id, acknowledged: done });
    }
    if (mode === 'notify') {
      return NextResponse.json({ ok: true, mode, ...(await notifyWatchFindings()) });
    }
    // ⛔ A STATED BUDGET, defaulting to something an invocation can actually
    // fund — not a default sized for a different caller. See runEolWatch.
    return NextResponse.json({ mode, ...(await runEolWatch({ budgetMs: budgetMs ?? 20000 })) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
