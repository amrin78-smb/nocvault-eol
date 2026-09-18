import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 26;

// Can THIS host reach the vendor PSIRT sources?
//
// ⛔ A DIAGNOSTIC, NOT A FEED. It fetches published vendor advisory endpoints and
// reports status/content-type/size only — it parses nothing and stores nothing.
// It exists because "moving PSIRT to the hub will get past the bot check" was an
// ASSUMPTION, and a cloud IP is usually treated WORSE by bot protection than an
// office one, not better. Registering a vendor source requires a verified
// machine-readable feed; this is how that verification is done from the host
// that would actually be doing the fetching.
const TARGETS = [
  ['checkpoint', 'https://advisories.checkpoint.com/'],
  ['checkpoint', 'https://advisories.checkpoint.com/feed/'],
  ['checkpoint', 'https://support.checkpoint.com/results/sk/sk182336'],
  ['fortinet', 'https://fortiguard.com/rss/ir.xml'],
  ['fortinet', 'https://filestore.fortinet.com/fortiguard/rss/ir.xml'],
  ['fortinet', 'https://fortiguard.com/psirt/FG-IR-24-259'],
  ['cisco', 'https://sec.cloudapps.cisco.com/security/center/psirtrss20/CiscoSecurityAdvisory.xml'],
  ['cisco', 'https://api.cisco.com/security/advisories/v2/all'],
];

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const cronSecret = process.env.CRON_SECRET;
  const provided = req.headers.get('x-cron-secret');
  if (!session && !(cronSecret && provided === cronSecret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const ua = 'Mozilla/5.0 (compatible; NocVault-EOL/1.0; +https://nocvault.com)';
  const results = [];
  for (const [vendor, url] of TARGETS) {
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, { headers: { 'user-agent': ua }, signal: controller.signal, redirect: 'follow' });
      const text = await res.text();
      clearTimeout(timer);
      results.push({
        vendor,
        url,
        status: res.status,
        finalUrl: res.url,
        contentType: res.headers.get('content-type'),
        bytes: text.length,
        ms: Date.now() - started,
        // ⛔ The SHAPE is the verdict, not the status code. A bot challenge
        // answers 200 with HTML; only the body says whether this is data.
        looksLikeData: /^\s*(<\?xml|\{|\[)/.test(text),
        cfChallenge: /cf-browser-verification|challenge-platform|Just a moment|__cf_chl/i.test(text),
        server: res.headers.get('server'),
        first80: text.slice(0, 80).replace(/\s+/g, ' '),
      });
    } catch (err) {
      results.push({
        vendor, url, status: null,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started,
      });
    }
  }
  return NextResponse.json({ ok: true, from: 'netlify', results });
}
