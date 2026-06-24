import { NextResponse } from 'next/server';
import { getStore } from '@netlify/blobs';

export const dynamic = 'force-dynamic';

// Public: returns the latest feed pointer (feed_version, sha256, generated_at).
export async function GET() {
  try {
    const store = getStore('eol-feed');
    const latest = await store.get('latest.json', { type: 'text' });
    if (!latest) {
      return NextResponse.json({ error: 'no feed published' }, { status: 503 });
    }
    return new NextResponse(latest, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return NextResponse.json({ error: 'no feed published' }, { status: 503 });
  }
}
