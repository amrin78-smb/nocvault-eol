import { NextResponse } from 'next/server';
import { getStore } from '@netlify/blobs';

export const dynamic = 'force-dynamic';

/**
 * The signed OUI (MAC address block) catalogue.
 *
 * ⛔ UNLICENSED, DELIBERATELY, AND IT IS THE ONLY NEW FEED THAT IS.
 *
 * It shipped metered by CVE_FEED_KEYS, copied from the CVE feed with the
 * justification "same customers, same commercial relationship". That was wrong,
 * and it broke something real: NetVault, DDIVault and LogVault hold no key —
 * NetVault falls back to a hard-coded 'netvault' that the allowlist does not
 * contain — so the first thing the suite's own apps got from this feed was a
 * 401. ⛔ The consumer was never a paying customer; it is this operator's own
 * infrastructure.
 *
 * And there is nothing here to meter. The payload is the IEEE registry, which
 * anyone can download from standards-oui.ieee.org without asking. What the hub
 * adds is freshness and a signature, not access to something withheld. Metering
 * it bought nothing and cost a credential on three internal apps. ⛔ The CVE
 * feed STAYS metered — that corpus is the one SecVault customers genuinely
 * cannot obtain, because their networks cannot reach NVD at all — and so does
 * the OS feed, whose consumer is SecVault and already holds a working key.
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
export async function GET() {
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
        // ⛔ `public` IS CORRECT HERE, AND ONLY BECAUSE THERE IS NO GATE —
        // which is the exact inverse of the CVE feed's incident. That feed
        // shipped `public, max-age=3600` WITH a licence check, and Netlify's CDN
        // cache key does not vary on x-license-key, so one authorised fetch
        // populated the edge and every later request was served the full corpus
        // without the function ever running: the gate was decorative. With no
        // gate there is nothing for the edge to bypass, and caching a 2.2 MB
        // body is a straight win — consumers read /latest first and only pull
        // the body when the version actually moved.
        // ⛔ IF A LICENCE CHECK IS EVER ADDED BACK, THIS LINE MUST CHANGE IN THE
        // SAME COMMIT, or it recreates that incident verbatim.
        'Cache-Control': 'public, max-age=3600',
        'X-Feed-Signature': sig || '',
        'X-Feed-Sha256': sha256,
        'X-Feed-Checked-At': checkedAt,
        // ⛔ NEVER SILENT ABOUT THE GATE, even when there is not one. The repo's
        // rule is that code merely mentioning licences reads as metered and only
        // the header says whether it actually is.
        'X-Feed-License': 'not-required',
      },
    });
  } catch {
    return NextResponse.json({ error: 'no oui feed published' }, { status: 503 });
  }
}
