import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getStore } from '@netlify/blobs';

export const dynamic = 'force-dynamic';

// Licensed: returns the full signed feed.json. Requires a non-empty x-license-key.
export async function GET(req: NextRequest) {
  const licenseKey = req.headers.get('x-license-key');
  if (!licenseKey || licenseKey.trim() === '') {
    return NextResponse.json({ error: 'license key required' }, { status: 401 });
  }
  // TODO: validate against NocVault /api/license

  try {
    const store = getStore('eol-feed');
    const [feed, sig, latest] = await Promise.all([
      store.get('feed.json', { type: 'text' }),
      store.get('feed.json.sig', { type: 'text' }),
      store.get('latest.json', { type: 'text' }),
    ]);
    if (!feed) {
      return NextResponse.json({ error: 'no feed published' }, { status: 503 });
    }
    let sha256 = '';
    try { sha256 = latest ? (JSON.parse(latest).sha256 ?? '') : ''; } catch { /* ignore */ }
    // The detached Ed25519 signature + sha256 travel as headers so a consumer can
    // verify the EXACT body bytes it received (one fetch, body stays pure JSON).
    return new NextResponse(feed, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
        'X-Feed-Signature': sig || '',
        'X-Feed-Sha256': sha256,
      },
    });
  } catch {
    return NextResponse.json({ error: 'no feed published' }, { status: 503 });
  }
}
