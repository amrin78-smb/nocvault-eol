import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getStore } from '@netlify/blobs';
import { checkLicense } from '@/lib/cve/license';

export const dynamic = 'force-dynamic';

/**
 * The signed OS/firmware branch lifecycle feed.
 *
 * ⛔ READS THE 'os-feed' STORE. 'eol-feed' holds the model catalogue NetVault
 * reads in production and 'cve-feed' holds the advisories; these three must
 * never share a store or a key name.
 *
 * ⛔ METERED BY THE SAME CVE_FEED_KEYS LIST, deliberately. This corpus ships to
 * the same customers under the same commercial relationship as the CVE feed, and
 * a third key list would be a third thing to configure before a customer can
 * pull — with the same fail-open behaviour anyway. The gate is commercial, not
 * security: everything here is public vendor lifecycle data.
 */
export async function GET(req: NextRequest) {
  const verdict = checkLicense(req.headers.get('x-license-key'));
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.reason }, { status: 401 });
  }
  if (!verdict.enforced) {
    console.warn(
      'os-feed: served WITHOUT licence enforcement — CVE_FEED_KEYS is not set. '
      + 'Any non-empty x-license-key is accepted.'
    );
  } else {
    console.log(`os-feed: served to ${verdict.label}`);
  }

  try {
    const store = getStore('os-feed');
    const [feed, sig, latest] = await Promise.all([
      store.get('feed.json', { type: 'text' }),
      store.get('feed.json.sig', { type: 'text' }),
      store.get('latest.json', { type: 'text' }),
    ]);
    if (!feed) {
      return NextResponse.json({ error: 'no os feed published' }, { status: 503 });
    }
    let sha256 = '';
    let checkedAt = '';
    try {
      const j = latest ? JSON.parse(latest) : {};
      sha256 = j.sha256 ?? '';
      // ⛔ LIVENESS, NOT FRESHNESS. generated_at only advances when the corpus
      // CHANGES, and this corpus is human-refreshed, so it can sit still for
      // months while the hub is perfectly healthy. checked_at is when the daily
      // watch last successfully READ the upstream vendor pages.
      checkedAt = j.checked_at ?? '';
    } catch { /* ignore */ }

    return new NextResponse(feed, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // ⛔ NEVER `public` ON A LICENSED RESPONSE. /api/v1/cve-feed shipped with
        // `public, max-age=3600` copied from the EOL feed, and that made its
        // licence gate DECORATIVE: Netlify's CDN cache key does not vary on
        // x-license-key, so one authorised fetch populated the edge and every
        // later request — no key, bogus key, cache-busted — was served the full
        // corpus without the function running. Verified live 2026-09-18.
        // The header is the control, not the code above it.
        'Cache-Control': 'private, no-store, max-age=0',
        Vary: 'x-license-key',
        'X-Feed-Signature': sig || '',
        'X-Feed-Sha256': sha256,
        'X-Feed-Checked-At': checkedAt,
        'X-Feed-License': verdict.enforced ? 'enforced' : 'unenforced',
      },
    });
  } catch {
    return NextResponse.json({ error: 'no os feed published' }, { status: 503 });
  }
}
