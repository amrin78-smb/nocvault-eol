import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { applyNetvaultSeed } from '@/lib/feed-core';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Admin-only: upsert the curated NetVault-derived seed into the DB.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const result = await applyNetvaultSeed();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
