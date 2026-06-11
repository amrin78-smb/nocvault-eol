// Sangfor "End of Services Announcements" parsing + upsert.
//
// Shared by the admin scrape route (best-effort direct fetch, usually blocked by
// Cloudflare) and the ingest route (HTML fetched from an allowed environment and
// POSTed in). Keeping the parser here makes it the single source of truth.
//
// The EOS table has three columns:
//   1. Service       - one or more model names separated by <br>
//   2. EOS Date      - e.g. "Apr 30, 2026"
//   3. Announcement  - an <a href> to the EOS announcement page
//
// The date and announcement cells use rowspan="2", so some <tr> rows omit them
// and inherit the value from the row above. We classify each non-first cell by
// whether it contains an <a> (announcement) or not (date), and carry the
// last-seen date/url forward for rows where the cell was rowspanned away.

import { query } from './db';
import { normalizeModel, normalizeDate } from './normalize';

export const SANGFOR_EOS_URL =
  'https://www.sangfor.com/support/services-policy/support-life-cycle-policy/end-of-sale-service-eos';

export interface SangforRow {
  models: string[];
  dateRaw: string | null;
  sourceUrl: string | null;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}

function cleanText(html: string): string {
  return decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim();
}

export function parseSangforTable(html: string): SangforRow[] {
  // Isolate the "End of Services Announcements" section, then its first table.
  const aliasIdx = html.indexOf('End of Services Announcements');
  const scope = aliasIdx >= 0 ? html.slice(aliasIdx) : html;
  const tableStart = scope.indexOf('<table');
  const tableEnd = scope.indexOf('</table>', tableStart);
  if (tableStart < 0 || tableEnd < 0) return [];
  const tableHtml = scope.slice(tableStart, tableEnd);

  const out: SangforRow[] = [];
  let carriedDate: string | null = null;
  let carriedUrl: string | null = null;

  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr: RegExpExecArray | null;
  while ((tr = trRegex.exec(tableHtml)) !== null) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length === 0) continue;

    // Skip the header row ("Service" / "EOS Date" / "Announcement").
    if (cleanText(cells[0]).toLowerCase() === 'service') continue;

    const models = cells[0]
      .replace(/<br\s*\/?>/gi, '\n')
      .split('\n')
      .map((part) => cleanText(part))
      .filter((p) => p.length > 0);
    if (models.length === 0) continue;

    let dateRaw: string | null = null;
    let sourceUrl: string | null = null;
    for (const cell of cells.slice(1)) {
      const hrefMatch = cell.match(/href="([^"]+)"/i);
      if (hrefMatch) {
        sourceUrl = hrefMatch[1];
      } else {
        // Prefer the bold primary date over any trailing exception note.
        const strong = cell.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
        const text = cleanText(strong ? strong[1] : cell);
        if (text) dateRaw = text;
      }
    }

    // Apply rowspan inheritance from the previous row where cells were omitted.
    if (dateRaw) carriedDate = dateRaw;
    else dateRaw = carriedDate;
    if (sourceUrl) carriedUrl = sourceUrl;
    else sourceUrl = carriedUrl;

    out.push({ models, dateRaw, sourceUrl });
  }

  return out;
}

export interface SangforIngestResult {
  rows: number;
  upserts: number;
  count: number;
  warnings: string[];
}

/**
 * Parse Sangfor EOS HTML, upsert each model into eol_products, and mark the
 * vendor row as successfully scraped. Throws if the table cannot be found so the
 * caller can mark the scrape as failed rather than silently wiping the status.
 */
export async function ingestSangforHtml(
  vendorId: number,
  html: string
): Promise<SangforIngestResult> {
  const parsed = parseSangforTable(html);
  if (parsed.length === 0) {
    throw new Error('Sangfor: EOS table not found or empty (page structure changed?)');
  }

  let upserts = 0;
  const warnings: string[] = [];

  for (const row of parsed) {
    const eos_date = normalizeDate(row.dateRaw);
    if (!eos_date && row.dateRaw) {
      warnings.push(`unparsed date "${row.dateRaw}" for ${row.models.join(', ')}`);
    }
    for (const model of row.models) {
      const model_normalized = normalizeModel(model);
      if (!model_normalized) continue;
      await query(
        `INSERT INTO eol_products
           (vendor_id, model_raw, model_normalized, category, eos_date, source_url, entry_method, confidence)
         VALUES ($1, $2, $3, NULL, $4, $5, 'scraped', 'high')
         ON CONFLICT (vendor_id, model_normalized) DO UPDATE SET
           model_raw = EXCLUDED.model_raw,
           eos_date = EXCLUDED.eos_date,
           source_url = EXCLUDED.source_url,
           entry_method = 'scraped',
           confidence = 'high',
           updated_at = NOW()`,
        [vendorId, model, model_normalized, eos_date, row.sourceUrl]
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

  return { rows: parsed.length, upserts, count, warnings };
}
