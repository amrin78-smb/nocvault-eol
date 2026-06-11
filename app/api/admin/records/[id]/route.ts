import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { normalizeModel, normalizeDate } from '@/lib/normalize';

export async function PUT(
  req: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const model_raw = body.model_raw;
    const model_normalized = normalizeModel(model_raw ?? '');
    const category = body.category ?? null;
    const eol_date = normalizeDate(body.eol_date ?? null);
    const eos_date = normalizeDate(body.eos_date ?? null);
    const eosl_date = normalizeDate(body.eosl_date ?? null);
    const source_url = body.source_url ?? null;
    const confidence = body.confidence ?? 'high';
    const verified = Boolean(body.verified);

    await query(
      `UPDATE eol_products SET
         model_raw = $1,
         model_normalized = $2,
         category = $3,
         eol_date = $4,
         eos_date = $5,
         eosl_date = $6,
         source_url = $7,
         confidence = $8,
         verified = $9,
         verified_at = CASE WHEN $9 THEN NOW() ELSE NULL END,
         updated_at = NOW()
       WHERE id = $10`,
      [
        model_raw,
        model_normalized,
        category,
        eol_date,
        eos_date,
        eosl_date,
        source_url,
        confidence,
        verified,
        params.id,
      ]
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    await query(`DELETE FROM eol_products WHERE id = $1`, [params.id]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
