import { NextResponse } from 'next/server';
import { getStore } from '@netlify/blobs';

export const dynamic = 'force-dynamic';

/**
 * The version pointer. Unlicensed on purpose, exactly as the other feeds'
 * pointers are: it carries a version, a digest and two timestamps — no corpus —
 * so a consumer can cheaply decide whether it already holds the current bytes
 * before spending a licensed fetch.
 */
export async function GET() {
  try {
    const store = getStore('os-feed');
    const latest = await store.get('latest.json', { type: 'text' });
    if (!latest) return NextResponse.json({ error: 'no os feed published' }, { status: 503 });
    return new NextResponse(latest, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'no os feed published' }, { status: 503 });
  }
}
