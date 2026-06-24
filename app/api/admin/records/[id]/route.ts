import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { normalizeForMatch } from '@/lib/match-normalize';
import { normalizeDate } from '@/lib/normalize';

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
    const model_raw = body.model_raw ?? '';

    const { rows: vendorRows } = await query<{ name: string }>(
      `SELECT v.name AS name
       FROM eol_models m
       JOIN vendors v ON v.id = m.vendor_id
       WHERE m.id = $1`,
      [params.id]
    );
    const vendorName = vendorRows[0]?.name;
    if (!vendorName) {
      return NextResponse.json({ error: 'record not found' }, { status: 404 });
    }

    const model_normalized = normalizeForMatch(vendorName, model_raw);
    const end_of_sale = normalizeDate(body.end_of_sale ?? null);
    const support_end_date = normalizeDate(body.support_end_date ?? null);
    const os_eol_date = normalizeDate(body.os_eol_date ?? null);
    const source_url = body.source_url ?? null;
    const note = body.note ?? null;
    const confidence = body.confidence ?? 'high';
    const hasVerified = body.verified !== undefined;
    const verified = Boolean(body.verified);

    await query(
      `UPDATE eol_models SET
         model_raw = $1,
         model_normalized = $2,
         end_of_sale = $3,
         support_end_date = $4,
         os_eol_date = $5,
         confidence = $6,
         source_url = $7,
         note = $8,
         verified = CASE WHEN $9 THEN $10 ELSE verified END,
         verified_at = CASE WHEN $9 THEN (CASE WHEN $10 THEN NOW() ELSE NULL END) ELSE verified_at END,
         entry_method = 'manual',
         updated_at = NOW()
       WHERE id = $11`,
      [
        model_raw,
        model_normalized,
        end_of_sale,
        support_end_date,
        os_eol_date,
        confidence,
        source_url,
        note,
        hasVerified,
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
    await query(`DELETE FROM eol_models WHERE id = $1`, [params.id]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
