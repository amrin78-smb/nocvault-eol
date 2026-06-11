import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { normalizeModel, normalizeDate } from '@/lib/normalize';

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const vendor_id = body.vendor_id;
    const model_raw = body.model_raw;

    if (!vendor_id || !model_raw) {
      return NextResponse.json(
        { error: 'vendor_id and model_raw are required' },
        { status: 400 }
      );
    }

    const model_normalized = normalizeModel(model_raw);
    const category = body.category ?? null;
    const eol_date = normalizeDate(body.eol_date ?? null);
    const eos_date = normalizeDate(body.eos_date ?? null);
    const eosl_date = normalizeDate(body.eosl_date ?? null);
    const source_url = body.source_url ?? null;
    const confidence = body.confidence ?? 'high';
    const entry_method = body.entry_method ?? 'manual';

    const { rows } = await query<{ id: number }>(
      `INSERT INTO eol_products
         (vendor_id, model_raw, model_normalized, category, eol_date, eos_date, eosl_date, source_url, entry_method, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (vendor_id, model_normalized) DO UPDATE SET
         model_raw = EXCLUDED.model_raw,
         category = EXCLUDED.category,
         eol_date = EXCLUDED.eol_date,
         eos_date = EXCLUDED.eos_date,
         eosl_date = EXCLUDED.eosl_date,
         source_url = EXCLUDED.source_url,
         confidence = EXCLUDED.confidence,
         updated_at = NOW()
       RETURNING id`,
      [
        vendor_id,
        model_raw,
        model_normalized,
        category,
        eol_date,
        eos_date,
        eosl_date,
        source_url,
        entry_method,
        confidence,
      ]
    );

    return NextResponse.json({ ok: true, id: rows[0]?.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
