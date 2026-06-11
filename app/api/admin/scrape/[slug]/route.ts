import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { normalizeModel, normalizeDate } from '@/lib/normalize';
import { EOL_PRODUCT_MAP } from '@/lib/eol-mapping';
import { ingestSangforHtml, SANGFOR_EOS_URL } from '@/lib/sangfor';
import { runCisco, CISCO_EOL_INDEX_URL } from '@/lib/cisco';
import { scrapePaloAlto } from '@/lib/paloalto';
import { scrapeFortinet } from '@/lib/fortinet';
import { scrapeEolNetwork } from '@/lib/eol-network';

// Our vendor slug -> eol.network slug (only Aruba/HP differs).
const EOL_NETWORK_VENDORS: Record<string, string> = {
  juniper: 'juniper',
  hp: 'aruba',
  ruckus: 'ruckus',
  sonicwall: 'sonicwall',
  checkpoint: 'checkpoint',
};

export const dynamic = 'force-dynamic';

// Sangfor sits behind Cloudflare bot management. A full browser-like header set
// is the best we can do from a server; note that CF also fingerprints the TLS
// client (JA3), so datacenter/Node requests may still be challenged with a 403.
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

interface VendorRow {
  id: number;
  slug: string;
  manual_only: boolean;
  scrape_url: string | null;
}

interface Cycle {
  cycle?: unknown;
  eol?: unknown;
  releaseDate?: unknown;
  latest?: unknown;
}

export async function POST(
  req: Request,
  { params }: { params: { slug: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const slug = params.slug;
  let vendorId: number | null = null;

  try {
    const { rows } = await query<VendorRow>(
      'SELECT id, slug, manual_only, scrape_url FROM vendors WHERE slug = $1',
      [slug]
    );
    const vendor = rows[0];
    if (!vendor) {
      return NextResponse.json({ error: 'vendor not found' }, { status: 404 });
    }
    vendorId = vendor.id;

    if (vendor.manual_only) {
      return NextResponse.json({ error: 'vendor is manual_only' }, { status: 400 });
    }

    // Sangfor publishes a bespoke HTML EOS table rather than an endoflife.date feed.
    if (slug === 'sangfor') {
      return await scrapeSangfor(vendorId, vendor.scrape_url ?? SANGFOR_EOS_URL);
    }

    // Cisco: large, resumable public EOL index crawl. Each call drains a bounded
    // chunk; re-invoke until done:true. Pass ?reset=1 to restart from scratch.
    if (slug === 'cisco') {
      const reset = new URL(req.url).searchParams.get('reset') === '1';
      const result = await runCisco(vendorId, vendor.scrape_url ?? CISCO_EOL_INDEX_URL, reset);
      return NextResponse.json({ ok: true, vendor: 'cisco', ...result });
    }

    // Palo Alto: public hardware EOL table.
    if (slug === 'paloalto') {
      return NextResponse.json(await scrapePaloAlto(vendorId, vendor.scrape_url));
    }

    // Fortinet: lifecycle page is auth-gated; import the FortiOS firmware fallback.
    if (slug === 'fortinet') {
      return NextResponse.json(await scrapeFortinet(vendorId, vendor.scrape_url));
    }

    // Juniper / Aruba(hp) / Ruckus / SonicWall / CheckPoint via eol.network.
    if (EOL_NETWORK_VENDORS[slug]) {
      return NextResponse.json(
        await scrapeEolNetwork(vendorId, EOL_NETWORK_VENDORS[slug], 'medium')
      );
    }

    const products = EOL_PRODUCT_MAP[slug] ?? [];

    if (products.length === 0) {
      await query(
        "UPDATE vendors SET scrape_status = 'no_source', last_scraped_at = NOW() WHERE id = $1",
        [vendorId]
      );
      return NextResponse.json({ ok: true, status: 'no_source', records: 0 });
    }

    await query(
      "UPDATE vendors SET scrape_status = 'running' WHERE id = $1",
      [vendorId]
    );

    let upserts = 0;
    const warnings: string[] = [];

    for (const product of products) {
      const res = await fetch(`https://endoflife.date/api/${product}.json`, {
        headers: { Accept: 'application/json' },
      });

      if (!res.ok) {
        warnings.push(`${product}: HTTP ${res.status}`);
        continue;
      }

      const data: unknown = await res.json();
      if (!Array.isArray(data)) {
        warnings.push(`${product}: response not an array`);
        continue;
      }

      const sourceUrl = `https://endoflife.date/${product}`;

      for (const item of data as Cycle[]) {
        const model_raw = `${product} ${item.cycle}`;
        const model_normalized = normalizeModel(model_raw);
        const eol_date = normalizeDate(item.eol);

        await query(
          `INSERT INTO eol_products
             (vendor_id, model_raw, model_normalized, category, eol_date, source_url, entry_method, confidence)
           VALUES ($1, $2, $3, $4, $5, $6, 'scraped', 'high')
           ON CONFLICT (vendor_id, model_normalized) DO UPDATE SET
             model_raw = EXCLUDED.model_raw,
             eol_date = EXCLUDED.eol_date,
             source_url = EXCLUDED.source_url,
             entry_method = 'scraped',
             confidence = 'high',
             updated_at = NOW()`,
          [vendorId, model_raw, model_normalized, product, eol_date, sourceUrl]
        );
        upserts += 1;
      }
    }

    const { rows: countRows } = await query<{ c: number }>(
      'SELECT COUNT(*)::int AS c FROM eol_products WHERE vendor_id = $1',
      [vendorId]
    );
    const count = countRows[0]?.c ?? 0;

    await query(
      "UPDATE vendors SET scrape_status = 'success', last_scraped_at = NOW(), record_count = $2 WHERE id = $1",
      [vendorId, count]
    );

    return NextResponse.json({
      ok: true,
      status: 'success',
      products: products.length,
      upserts,
      warnings: warnings.length ? warnings : undefined,
    });
  } catch (err) {
    if (vendorId !== null) {
      try {
        await query(
          "UPDATE vendors SET scrape_status = 'failed', last_scraped_at = NOW() WHERE id = $1",
          [vendorId]
        );
      } catch {
        // ignore secondary failure
      }
    }
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Sangfor adapter
//
// Best-effort direct fetch. Sangfor sits behind Cloudflare bot management which
// fingerprints the TLS client, so server-side/datacenter requests are usually
// answered with a 403. The reliable path is the ingest route, which receives the
// HTML fetched from an allowed environment. Both paths share lib/sangfor.ts.
// ---------------------------------------------------------------------------

async function scrapeSangfor(
  vendorId: number,
  scrapeUrl: string
): Promise<NextResponse> {
  await query("UPDATE vendors SET scrape_status = 'running' WHERE id = $1", [
    vendorId,
  ]);

  const res = await fetch(scrapeUrl, { headers: BROWSER_HEADERS });
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error(
        'Sangfor fetch blocked by Cloudflare (HTTP 403). The page loads in a ' +
          'normal browser but Cloudflare blocks server-side/datacenter requests ' +
          'by TLS fingerprint. Use the scheduled ingest job (scripts/scrape-sangfor.sh) ' +
          'which fetches the page from an allowed environment and POSTs it to the ' +
          'ingest endpoint.'
      );
    }
    throw new Error(`Sangfor fetch failed: HTTP ${res.status}`);
  }

  const result = await ingestSangforHtml(vendorId, await res.text());
  return NextResponse.json({
    ok: true,
    status: 'success',
    rows: result.rows,
    upserts: result.upserts,
    warnings: result.warnings.length ? result.warnings : undefined,
  });
}
