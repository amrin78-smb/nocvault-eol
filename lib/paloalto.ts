// Palo Alto Networks hardware End-of-Life scraper.
//
// One server-rendered <table>; columns (note hyphenated headers):
//   0 End-of-Sale Product   - product family + <br>-separated SKUs
//   1 End-of-Sale Date       -> eol_date  (per spec mapping)
//   2 End-of-Life Date       -> eos_date  (per spec mapping)
// Dates are mixed: "Nov 22, 2026", "August 31, 2024", "June 15th, 2024" (ordinals).

import { query } from './db';
import { normalizeModel, normalizeDate } from './normalize';

export const PALO_ALTO_EOL_URL =
  'https://www.paloaltonetworks.com/services/support/end-of-life-announcements/hardware-end-of-life-dates';

const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function cleanText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Strip ordinal suffixes so normalizeDate can read "June 15th, 2024".
function paloDate(raw: string): string | null {
  return normalizeDate(raw.replace(/(\d{1,2})(st|nd|rd|th)\b/gi, '$1'));
}

export interface PaloRow {
  model: string;
  eolDate: string | null; // End-of-Sale column
  eosDate: string | null; // End-of-Life column
}

export function parsePaloAltoTable(html: string): PaloRow[] {
  const tStart = html.search(/<table[^>]*>/i);
  const tEnd = html.indexOf('</table>', tStart);
  if (tStart < 0 || tEnd < 0) return [];
  const table = html.slice(tStart, tEnd);

  const out: PaloRow[] = [];
  const rows = [...table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
  for (const row of rows) {
    if (/<th\b/i.test(row)) continue; // header row uses <th>
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 3) continue;

    // Product cell packs a family label + SKUs separated by <br> (and commas).
    const models = cells[0]
      .replace(/<br\s*\/?>/gi, '\n')
      .split(/[\n,]/)
      .map((s) => cleanText(s).replace(/^[("']+|[)"']+$/g, '').trim())
      .filter((s) => s.length > 1);
    if (models.length === 0) continue;

    const eolDate = paloDate(cleanText(cells[1]));
    const eosDate = paloDate(cleanText(cells[2]));
    for (const model of models) out.push({ model, eolDate, eosDate });
  }
  return out;
}

export interface PaloResult {
  ok: boolean;
  vendor: string;
  rows: number;
  upserts: number;
  records: number;
}

export async function scrapePaloAlto(vendorId: number, scrapeUrl: string | null): Promise<PaloResult> {
  const url = scrapeUrl || PALO_ALTO_EOL_URL;
  await query("UPDATE vendors SET scrape_status = 'running' WHERE id = $1", [vendorId]);

  const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  const body = await res.text();
  console.log(`[paloalto] GET ${url} -> ${res.status} | ${body.slice(0, 200).replace(/\s+/g, ' ')}`);
  if (!res.ok) throw new Error(`Palo Alto fetch failed: HTTP ${res.status}`);

  const parsed = parsePaloAltoTable(body);
  if (parsed.length === 0) {
    throw new Error('Palo Alto: EOL table not found or empty (page structure changed?)');
  }

  let upserts = 0;
  for (const row of parsed) {
    const model_normalized = normalizeModel(row.model);
    if (!model_normalized) continue;
    await query(
      `INSERT INTO eol_products
         (vendor_id, model_raw, model_normalized, category, eol_date, eos_date, source_url, entry_method, confidence)
       VALUES ($1, $2, $3, 'hardware', $4, $5, $6, 'scraped', 'high')
       ON CONFLICT (vendor_id, model_normalized) DO UPDATE SET
         model_raw = EXCLUDED.model_raw,
         eol_date = EXCLUDED.eol_date,
         eos_date = EXCLUDED.eos_date,
         source_url = EXCLUDED.source_url,
         entry_method = 'scraped',
         confidence = 'high',
         updated_at = NOW()`,
      [vendorId, row.model, model_normalized, row.eolDate, row.eosDate, url]
    );
    upserts += 1;
  }

  const { rows: countRows } = await query<{ c: number }>(
    'SELECT COUNT(*)::int AS c FROM eol_products WHERE vendor_id = $1',
    [vendorId]
  );
  const records = countRows[0]?.c ?? 0;
  await query(
    "UPDATE vendors SET scrape_status = 'success', last_scraped_at = NOW(), record_count = $2, scrape_url = $3 WHERE id = $1",
    [vendorId, records, url]
  );

  return { ok: true, vendor: 'paloalto', rows: parsed.length, upserts, records };
}
