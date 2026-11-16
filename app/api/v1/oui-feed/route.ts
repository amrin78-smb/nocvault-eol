import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getStore } from '@netlify/blobs';
import { checkLicense } from '@/lib/cve/license';

export const dynamic = 'force-dynamic';

/**
 * The signed OUI (MAC address block) catalogue.
 *
 * ⛔ READS THE 'oui-feed' STORE — never 'eol-feed', 'cve-feed' or 'os-feed'.
 *
 * ⛔ THE BODY IS COMPACT JSON AND THE TUPLE LAYOUT IS IN THE PAYLOAD. Entries
 * are [prefix, prefix_bits, org, is_registry_block]; a `tuple` field names the
 * positions so a consumer never has to guess. See lib/oui/feed.ts for why this
 * one feed is not pretty-printed.
 *
 * ⛔ `is_registry_block` MATTERS. 442 MA-L blocks are registered to "IEEE
 * Registration Authority" itself and subdivided into 13,841 MA-M/MA-S
 * assignments. Match LONGEST PREFIX FIRST (9, then 7, then 6 hex chars); if the
 * only hit has is_registry_block = 1, the correct answer is "unknown vendor",
 * NOT the registry's name.
 */
export async function GET(req: NextRequest) {
  const verdict = checkLicense(req.headers.get('x-license-key'));
  if (!verdict.ok) return NextResponse.json({ error: verdict.reason }, { status: 401 });
  if (!verdict.enforced) {
    console.warn('oui-feed: served WITHOUT licence enforcement — CVE_FEED_KEYS is not set.');
  } else {
    console.log(`oui-feed: served to ${verdict.label}`);
  }

  try {
    const store = getStore('oui-feed');
    const [feed, sig, latest] = await Promise.all([
      store.get('feed.json', { type: 'text' }),
      store.get('feed.json.sig', { type: 'text' }),
      store.get('latest.json', { type: 'text' }),
    ]);
    if (!feed) return NextResponse.json({ error: 'no oui feed published' }, { status: 503 });

    let sha256 = '';
    let checkedAt = '';
    try {
      const j = latest ? JSON.parse(latest) : {};
      sha256 = j.sha256 ?? '';
      // ⛔ LIVENESS, NOT FRESHNESS. IEEE changes slowly and publishing is
      // idempotent, so generated_at can sit still for weeks while everything is
      // healthy — and would sit equally still if the hub died. checked_at is
      // the OLDEST of the three registries' last successful reads.
      checkedAt = j.checked_at ?? '';
    } catch { /* ignore */ }

    return new NextResponse(feed, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // ⛔ NEVER `public` ON A LICENSED RESPONSE. The CVE feed shipped with
        // public/max-age=3600 copied from the EOL feed, and Netlify's CDN cache
        // key does not vary on x-license-key — one authorised fetch populated
        // the edge and everything after was served without the function running.
        'Cache-Control': 'private, no-store, max-age=0',
        Vary: 'x-license-key',
        'X-Feed-Signature': sig || '',
        'X-Feed-Sha256': sha256,
        'X-Feed-Checked-At': checkedAt,
        'X-Feed-License': verdict.enforced ? 'enforced' : 'unenforced',
      },
    });
  } catch {
    return NextResponse.json({ error: 'no oui feed published' }, { status: 503 });
  }
}
