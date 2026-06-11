import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { normalizeModel, normalizeDate } from '@/lib/normalize';
import { EOL_PRODUCT_MAP } from '@/lib/eol-mapping';

export const dynamic = 'force-dynamic';

interface VendorRow {
  id: number;
  slug: string;
  manual_only: boolean;
}

interface Cycle {
  cycle?: unknown;
  eol?: unknown;
  releaseDate?: unknown;
  latest?: unknown;
}

export async function POST(
  _req: Request,
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
      'SELECT id, slug, manual_only FROM vendors WHERE slug = $1',
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
