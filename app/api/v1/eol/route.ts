import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { normalizeModel } from '@/lib/normalize';

export const dynamic = 'force-dynamic';

interface EolRow {
  id: number;
  model_raw: string;
  confidence: string;
  verified: boolean;
  source_url: string | null;
  eol_date: string | null;
  eos_date: string | null;
  vendor_slug: string;
  score: number;
}

export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const vendor = params.get('vendor') || '';
    const model = params.get('model') || '';
    const license_key = params.get('license_key') || '';

    if (license_key !== process.env.API_SECRET_KEY) {
      return NextResponse.json({ error: 'invalid license key' }, { status: 401 });
    }

    const normalized = normalizeModel(model);

    const { rows } = await query<EolRow>(
      `SELECT ep.id,
              ep.model_raw,
              ep.confidence,
              ep.verified,
              ep.source_url,
              ep.eol_date::text AS eol_date,
              ep.eos_date::text AS eos_date,
              v.slug AS vendor_slug,
              similarity(ep.model_normalized, $1) AS score
       FROM eol_products ep
       JOIN vendors v ON v.id = ep.vendor_id
       WHERE v.slug = $2
       ORDER BY score DESC
       LIMIT 1`,
      [normalized, vendor]
    );

    const best = rows[0];
    const matched = Boolean(best && best.score > 0.4);

    await query(
      `INSERT INTO api_queries (license_key, vendor, model_query, matched_product_id, cache_hit)
       VALUES ($1, $2, $3, $4, false)`,
      [license_key.slice(-4), vendor, model, matched ? best.id : null]
    );

    if (matched) {
      return NextResponse.json({
        matched: true,
        vendor,
        model_normalized: normalized,
        model_raw: best.model_raw,
        eol_date: best.eol_date ? String(best.eol_date).slice(0, 10) : null,
        eos_date: best.eos_date ? String(best.eos_date).slice(0, 10) : null,
        confidence: best.confidence,
        verified: best.verified,
        source_url: best.source_url,
        similarity_score: Number(best.score),
      });
    }

    return NextResponse.json({
      matched: false,
      vendor,
      model_normalized: normalized,
      similarity_score: best ? Number(best.score) : 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
