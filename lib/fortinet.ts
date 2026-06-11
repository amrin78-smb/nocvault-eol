// Fortinet lifecycle scraper.
//
// The legacy ProductLifeCycle.aspx page now redirects into the FortiCare support
// portal, a SAML-gated Angular SPA whose lifecycle API returns 401 without a
// login. So hardware lifecycle data is NOT scrapeable anonymously: we record the
// page as auth_required and fall back to endoflife.date/api/fortios.json for
// FortiOS firmware cycles (the one public, machine-readable source).

import { query } from './db';
import { normalizeModel, normalizeDate } from './normalize';

export const FORTINET_LIFECYCLE_URL =
  'https://support.fortinet.com/Information/ProductLifeCycle.aspx';
const FORTIOS_API = 'https://endoflife.date/api/fortios.json';

const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

interface FortiOsCycle {
  cycle?: unknown;
  releaseDate?: unknown;
  support?: unknown;
  eol?: unknown;
}

export interface FortinetResult {
  ok: boolean;
  vendor: string;
  authRequired: boolean;
  upserts: number;
  records: number;
  warnings?: string[];
}

export async function scrapeFortinet(vendorId: number, scrapeUrl: string | null): Promise<FortinetResult> {
  const lifecycleUrl = scrapeUrl || FORTINET_LIFECYCLE_URL;
  await query("UPDATE vendors SET scrape_status = 'running' WHERE id = $1", [vendorId]);

  const warnings: string[] = [];

  // 1. Probe the lifecycle page to confirm whether it is reachable anonymously.
  let authRequired = true;
  try {
    const res = await fetch(lifecycleUrl, { headers: HEADERS, redirect: 'follow' });
    const body = await res.text();
    console.log(
      `[fortinet] GET ${lifecycleUrl} -> ${res.status} final=${res.url} | ${body
        .slice(0, 200)
        .replace(/\s+/g, ' ')}`
    );
    // Real lifecycle data would contain a table with end-of-sale/support columns.
    // The SPA shell does not; treat SPA/login markers as auth-required.
    const hasData = /end[-\s]of[-\s]sale|end[-\s]of[-\s]support/i.test(body) && /<table/i.test(body);
    const isShell = /<app-root|Ticketing|saml|sign in|log in/i.test(body);
    authRequired = !hasData || isShell;
  } catch (err) {
    warnings.push(`lifecycle probe: ${err instanceof Error ? err.message : 'error'}`);
  }

  // 2. Fallback: FortiOS firmware cycles from endoflife.date.
  let upserts = 0;
  try {
    const res = await fetch(FORTIOS_API, { headers: { Accept: 'application/json' } });
    console.log(`[fortinet] GET ${FORTIOS_API} -> ${res.status}`);
    const data: unknown = await res.json();
    if (Array.isArray(data)) {
      for (const item of data as FortiOsCycle[]) {
        const model = `FortiOS ${item.cycle}`;
        const model_normalized = normalizeModel(model);
        if (!model_normalized) continue;
        await query(
          `INSERT INTO eol_products
             (vendor_id, model_raw, model_normalized, category, eol_date, eosl_date, source_url, entry_method, confidence)
           VALUES ($1, $2, $3, 'firmware', $4, $5, $6, 'scraped', 'high')
           ON CONFLICT (vendor_id, model_normalized) DO UPDATE SET
             model_raw = EXCLUDED.model_raw,
             eol_date = EXCLUDED.eol_date,
             eosl_date = EXCLUDED.eosl_date,
             source_url = EXCLUDED.source_url,
             entry_method = 'scraped',
             confidence = 'high',
             updated_at = NOW()`,
          [
            vendorId,
            model,
            model_normalized,
            normalizeDate(item.eol),
            normalizeDate(item.support),
            'https://endoflife.date/fortios',
          ]
        );
        upserts += 1;
      }
    } else {
      warnings.push('fortios fallback: response not an array');
    }
  } catch (err) {
    warnings.push(`fortios fallback: ${err instanceof Error ? err.message : 'error'}`);
  }

  const { rows: countRows } = await query<{ c: number }>(
    'SELECT COUNT(*)::int AS c FROM eol_products WHERE vendor_id = $1',
    [vendorId]
  );
  const records = countRows[0]?.c ?? 0;

  // Hardware lifecycle stays auth-gated; status reflects that even though the
  // firmware fallback succeeded.
  const status = authRequired ? 'auth_required' : 'success';
  await query(
    "UPDATE vendors SET scrape_status = $2, last_scraped_at = NOW(), record_count = $3, scrape_url = $4 WHERE id = $1",
    [vendorId, status, records, lifecycleUrl]
  );

  return {
    ok: true,
    vendor: 'fortinet',
    authRequired,
    upserts,
    records,
    warnings: warnings.length ? warnings : undefined,
  };
}
