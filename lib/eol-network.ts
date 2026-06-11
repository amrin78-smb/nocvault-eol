// Shared scraper for eol.network (third-party EOL aggregator).
//
// Used by Juniper, Aruba (our 'hp' vendor), Ruckus, SonicWall and CheckPoint —
// every vendor page on the site shares the same markup:
//
//   /<vendor>            -> family-table: links to family pages
//   /<vendor>/<family>   -> ptable: per-SKU  Product | Status | End of Sale | Last Support
//
// Dates are ISO (YYYY-MM-DD) inside <time datetime="...">. The site rate-limits
// aggressively (HTTP 429 / "Daily limit reached"), so every fetch retries with
// backoff and every family page is wrapped in try/catch — a throttled family is
// skipped with a warning rather than crashing the whole scrape.

import { query } from './db';
import { normalizeModel, normalizeDate } from './normalize';

const EOL_NET_BASE = 'https://www.eol.network';

const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const DELAY_MS = 300; // between page fetches
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cleanText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fetch with a test-fetch log line and backoff on 429 / "daily limit". */
async function fetchEol(url: string): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
      const body = await res.text();
      console.log(
        `[eol.network] GET ${url} -> ${res.status} | ${body.slice(0, 200).replace(/\s+/g, ' ')}`
      );
      const throttled = res.status === 429 || /Daily limit reached|Too Many Requests/i.test(body);
      if (res.ok && !throttled) return body;
      lastErr = new Error(throttled ? 'rate-limited (429)' : `HTTP ${res.status}`);
      if (!throttled) throw lastErr;
      await sleep(2000 * (attempt + 1)); // 2s, 4s backoff
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error('fetch failed');
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr ?? new Error('fetch failed');
}

/** Family detail-page links from a vendor index page. */
export function parseFamilyLinks(html: string, vendorSlug: string): string[] {
  const hrefs = [
    ...html.matchAll(/<td class="ft-name">\s*<a href="([^"]+)"/gi),
  ].map((m) => m[1]);
  const wanted = hrefs.filter((h) => h.startsWith(`/${vendorSlug}/`) || h === `/${vendorSlug}`);
  return [...new Set(wanted)].map((h) => EOL_NET_BASE + h);
}

export interface EolRow {
  model: string;
  eosDate: string | null; // End of Sale
  eoslDate: string | null; // Last Support
}

/** Per-SKU rows from a family detail page (ptable). */
export function parseFamilyRows(html: string): EolRow[] {
  const out: EolRow[] = [];
  const rows = [...html.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
  for (const row of rows) {
    if (/<th\b/i.test(row)) continue; // header
    if (!/td-sku/i.test(row)) continue;

    let model =
      (row.match(/<td class="td-sku">[\s\S]*?<code>([\s\S]*?)<\/code>/i) || [])[1] ||
      (row.match(/<td class="td-sku">\s*<a [^>]*>([\s\S]*?)<\/a>/i) || [])[1] ||
      '';
    model = cleanText(model);
    if (!model) continue;

    // Two td-date cells in order: [0] End of Sale, [1] Last Support. Empty -> null.
    const dates = [
      ...row.matchAll(/<td class="td-date">\s*(?:<time datetime="([^"]*)")?/gi),
    ].map((m) => m[1] || null);

    out.push({ model, eosDate: dates[0] || null, eoslDate: dates[1] || null });
  }
  return out;
}

export interface EolNetworkResult {
  ok: boolean;
  vendor: string;
  source: string;
  families: number;
  upserts: number;
  records: number;
  warnings?: string[];
}

/**
 * Crawl an eol.network vendor: index -> family pages -> per-SKU upserts.
 * Sets vendor status to success (or no_source when the site exposes no data).
 */
export async function scrapeEolNetwork(
  vendorId: number,
  vendorSlug: string,
  confidence: string
): Promise<EolNetworkResult> {
  const indexUrl = `${EOL_NET_BASE}/${vendorSlug}`;
  const sourceUrl = `${EOL_NET_BASE}/${vendorSlug}/`;

  await query("UPDATE vendors SET scrape_status = 'running' WHERE id = $1", [vendorId]);

  const indexHtml = await fetchEol(indexUrl); // fatal if the index itself fails
  const families = parseFamilyLinks(indexHtml, vendorSlug);

  let upserts = 0;
  const warnings: string[] = [];

  for (const familyUrl of families) {
    await sleep(DELAY_MS);
    try {
      const html = await fetchEol(familyUrl);
      for (const row of parseFamilyRows(html)) {
        const model_normalized = normalizeModel(row.model);
        if (!model_normalized) continue;
        await query(
          `INSERT INTO eol_products
             (vendor_id, model_raw, model_normalized, category, eos_date, eosl_date, source_url, entry_method, confidence)
           VALUES ($1, $2, $3, NULL, $4, $5, $6, 'scraped', $7)
           ON CONFLICT (vendor_id, model_normalized) DO UPDATE SET
             model_raw = EXCLUDED.model_raw,
             eos_date = EXCLUDED.eos_date,
             eosl_date = EXCLUDED.eosl_date,
             source_url = EXCLUDED.source_url,
             entry_method = 'scraped',
             confidence = EXCLUDED.confidence,
             updated_at = NOW()`,
          [
            vendorId,
            row.model,
            model_normalized,
            normalizeDate(row.eosDate),
            normalizeDate(row.eoslDate),
            sourceUrl,
            confidence,
          ]
        );
        upserts += 1;
      }
    } catch (err) {
      warnings.push(`${familyUrl}: ${err instanceof Error ? err.message : 'error'}`);
    }
  }

  const { rows: countRows } = await query<{ c: number }>(
    'SELECT COUNT(*)::int AS c FROM eol_products WHERE vendor_id = $1',
    [vendorId]
  );
  const records = countRows[0]?.c ?? 0;
  const status = families.length === 0 ? 'no_source' : 'success';

  await query(
    `UPDATE vendors
        SET scrape_status = $2, last_scraped_at = NOW(), record_count = $3, scrape_url = $4
      WHERE id = $1`,
    [vendorId, status, records, sourceUrl]
  );

  return {
    ok: true,
    vendor: vendorSlug,
    source: sourceUrl,
    families: families.length,
    upserts,
    records,
    warnings: warnings.length ? warnings : undefined,
  };
}
