import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { normalizeForMatch } from '@/lib/match-normalize';
import { normalizeDate } from '@/lib/normalize';

function parseAliases(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map((a) => String(a).trim()).filter(Boolean);
  }
  if (typeof input === 'string') {
    return input
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
  }
  return [];
}

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

    const { rows: vendorRows } = await query<{ name: string }>(
      'SELECT name FROM vendors WHERE id = $1',
      [vendor_id]
    );
    const vendorName = vendorRows[0]?.name;
    if (!vendorName) {
      return NextResponse.json({ error: 'vendor not found' }, { status: 400 });
    }

    const model_normalized = normalizeForMatch(vendorName, model_raw);
    const end_of_sale = normalizeDate(body.end_of_sale ?? null);
    const support_end_date = normalizeDate(body.support_end_date ?? null);
    const os_eol_date = normalizeDate(body.os_eol_date ?? null);
    const source_url = body.source_url ?? null;
    const note = body.note ?? null;
    const confidence = body.confidence ?? 'high';

    const { rows } = await query<{ id: number }>(
      `INSERT INTO eol_models
         (vendor_id, model_raw, model_normalized, end_of_sale, support_end_date, os_eol_date, confidence, source_url, note, entry_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual')
       ON CONFLICT (vendor_id, model_normalized) DO UPDATE SET
         model_raw = EXCLUDED.model_raw,
         end_of_sale = EXCLUDED.end_of_sale,
         support_end_date = EXCLUDED.support_end_date,
         os_eol_date = EXCLUDED.os_eol_date,
         confidence = EXCLUDED.confidence,
         source_url = EXCLUDED.source_url,
         note = EXCLUDED.note,
         entry_method = 'manual',
         updated_at = NOW()
       RETURNING id`,
      [
        vendor_id,
        model_raw,
        model_normalized,
        end_of_sale,
        support_end_date,
        os_eol_date,
        confidence,
        source_url,
        note,
      ]
    );

    const eolModelId = rows[0]?.id;
    const aliases = parseAliases(body.aliases);
    if (eolModelId && aliases.length > 0) {
      for (const alias_raw of aliases) {
        await query(
          `INSERT INTO model_aliases (eol_model_id, alias_raw, alias_normalized)
           VALUES ($1, $2, $3)
           ON CONFLICT (eol_model_id, alias_raw) DO NOTHING`,
          [eolModelId, alias_raw, normalizeForMatch(vendorName, alias_raw)]
        );
      }
    }

    return NextResponse.json({ ok: true, id: eolModelId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
