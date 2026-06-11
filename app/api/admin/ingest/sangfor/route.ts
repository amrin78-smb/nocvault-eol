import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { ingestSangforHtml } from '@/lib/sangfor';

export const dynamic = 'force-dynamic';

// Machine-to-machine ingest for Sangfor EOS data.
//
// Sangfor is behind Cloudflare and cannot be fetched from the serverless runtime
// (see app/api/admin/scrape/[slug]/route.ts). Instead, an allowed environment
// (a developer machine or CI runner where curl passes Cloudflare — see
// scripts/scrape-sangfor.sh) fetches the page and POSTs the raw HTML here.
//
// Auth: Authorization: Bearer <API_SECRET_KEY> (same secret as the public API).
// Body: the page HTML, either as text/html or as JSON { "html": "..." }.

interface VendorRow {
  id: number;
}

export async function POST(req: NextRequest) {
  const secret = process.env.API_SECRET_KEY;
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!secret || token !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let vendorId: number | null = null;
  try {
    const contentType = req.headers.get('content-type') || '';
    const raw = await req.text();
    const html = contentType.includes('application/json')
      ? String(JSON.parse(raw).html ?? '')
      : raw;

    if (!html.trim()) {
      return NextResponse.json({ error: 'empty body' }, { status: 400 });
    }

    const { rows } = await query<VendorRow>(
      "SELECT id FROM vendors WHERE slug = 'sangfor'"
    );
    const vendor = rows[0];
    if (!vendor) {
      return NextResponse.json({ error: 'sangfor vendor not found' }, { status: 404 });
    }
    vendorId = vendor.id;

    await query("UPDATE vendors SET scrape_status = 'running' WHERE id = $1", [
      vendorId,
    ]);

    const result = await ingestSangforHtml(vendorId, html);
    return NextResponse.json({
      ok: true,
      status: 'success',
      rows: result.rows,
      upserts: result.upserts,
      records: result.count,
      warnings: result.warnings.length ? result.warnings : undefined,
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
