// Cisco public End-of-Life index scraper.
//
// Multi-level, RESUMABLE scrape (the full crawl is thousands of requests and
// cannot complete in a single serverless invocation):
//
//   index  -> series pages       (4 target categories, EOL-marked only)
//   series -> listing page        (the "eos-eol-notice-listing.html" link)
//   listing-> bulletin pages       (/products/collateral/...eol...html)
//   bulletin-> eol_products rows    (one record per affected PID)
//
// Progress is persisted in the cisco_eol_queue table. Each call to runCisco()
// drains a bounded chunk of pending work and returns how much is left, so the
// caller re-invokes until done. vendors.scrape_status is 'running' while work
// remains and 'success' once the queue is fully drained.

import { query } from './db';
import { normalizeModel, normalizeDate } from './normalize';

export const CISCO_EOL_INDEX_URL =
  'https://www.cisco.com/c/en/us/support/eol/index.html';
const CISCO_BASE = 'https://www.cisco.com';

// Cisco is behind Akamai; this header set passes where a bare request 403s.
const CISCO_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
};

// Index sections we care about (the <section class="seoli-container" id="...">).
const TARGET_CATEGORY_IDS = ['Security', 'Routers', 'Switches', 'Wireless'];

const REQUEST_DELAY_MS = 500; // be respectful between request batches
const MAX_CONCURRENT = 5; // batches of 5 concurrent requests
// Bounded work per invocation so a single serverless call stays within its
// time budget. Override with CISCO_MAX_ITEMS_PER_RUN; the caller re-invokes.
const MAX_ITEMS_PER_RUN = Number(process.env.CISCO_MAX_ITEMS_PER_RUN) || 12;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
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

function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

async function fetchCisco(url: string): Promise<string> {
  const res = await fetch(url, { headers: CISCO_HEADERS, redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.text();
}

// ---- Parsers ----------------------------------------------------------------

export interface IndexSeries {
  url: string;
  name: string;
  category: string;
  status: string;
}

/**
 * Extract EOL-marked series links from the target category sections of the
 * index page. Series without an EOL/EOS status icon are skipped.
 */
export function parseIndexSeries(html: string): IndexSeries[] {
  const out: IndexSeries[] = [];
  const seen = new Set<string>();

  for (const id of TARGET_CATEGORY_IDS) {
    const start = html.indexOf(`id="${id}"`);
    if (start < 0) continue;
    // Slice to the next category container (or end of document).
    const nextContainer = html.indexOf('class="seoli-container"', start + 1);
    const slice = html.slice(start, nextContainer < 0 ? undefined : nextContainer);

    for (const li of slice.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
      const block = li[1];
      const a = block.match(
        /<a href="((?:https:\/\/www\.cisco\.com)?\/c\/en\/us\/support\/[^"]+\/(?:series|model)\.html)"[^>]*>([^<]+)<\/a>/i
      );
      if (!a) continue;
      // Skip series with no EOL/EOS status icon.
      const icon = block.match(/\/web\/images\/(cat-ann|cat-eol|eol-models|cat-eos)\.png/i);
      if (!icon) continue;

      const url = a[1].startsWith('http') ? a[1] : CISCO_BASE + a[1];
      if (seen.has(url)) continue;
      seen.add(url);

      const category = (url.match(/\/c\/en\/us\/support\/([^/]+)\//) || [])[1] || id.toLowerCase();
      out.push({ url, name: cleanText(a[2]), category, status: icon[1].toLowerCase() });
    }
  }

  return out;
}

/** The single "EOL Details" link on a series page -> the notice listing page. */
export function parseSeriesListingUrl(html: string): string | null {
  const clean = stripComments(html);
  const m = clean.match(
    /href="(\/c\/en\/us\/products\/[^"]+eos-eol-notice-listing\.html)"/i
  );
  return m ? CISCO_BASE + m[1] : null;
}

/** Bulletin links from a notice-listing page (English, deduped, no policy/nav). */
export function parseListingBulletins(html: string): string[] {
  const clean = stripComments(html);
  const hrefs = [
    ...clean.matchAll(/href="(\/c\/en\/us\/products\/collateral\/[^"]+\.html)"/gi),
  ].map((m) => m[1]);

  const filtered = hrefs.filter((h) => {
    const low = h.toLowerCase();
    if (low.includes('eos-eol-policy')) return false; // global policy page
    if (low.endsWith('-fr.html')) return false; // French duplicate
    if (low.includes('-listing')) return false; // nav/listing pages
    return /eol|end[-_]of[-_]life|eos-eol/.test(low);
  });

  return [...new Set(filtered)].map((h) => CISCO_BASE + h);
}

export interface BulletinRecord {
  pid: string;
  eosDate: string | null;
  ldosDate: string | null;
}

/**
 * Parse an EOL bulletin. Table 1 holds milestone dates (End-of-Sale Date, Last
 * Date of Support); the PID table(s) hold affected part numbers. The dates apply
 * to every PID in the bulletin, so we emit one record per PID with those dates.
 */
export function parseBulletin(html: string): BulletinRecord[] {
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  let eosDate: string | null = null;
  let ldosDate: string | null = null;
  const pids: string[] = [];

  for (const table of tables) {
    const rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
    if (rows.length === 0) continue;
    const headerText = cleanText(rows[0]).toLowerCase();
    const isMilestone = headerText.includes('milestone') && headerText.includes('date');
    const isPidTable = headerText.includes('part number');

    for (const row of rows) {
      const cells = [...row.matchAll(/<t[dh][\s\S]*?<\/t[dh]>/gi)].map((c) => cleanText(c[0]));
      if (cells.length === 0) continue;

      if (isMilestone) {
        const label = cells[0].toLowerCase();
        const dateText = cells[cells.length - 1];
        if (/^end[-\s]of[-\s]sale date/.test(label)) eosDate = eosDate ?? dateText;
        else if (/^last date of support/.test(label)) ldosDate = ldosDate ?? dateText;
      } else if (isPidTable) {
        const pid = cells[0];
        if (
          pid &&
          pid !== '-' &&
          !/part\s*number/i.test(pid) &&
          !/^end[-\s]of[-\s]sale product/i.test(pid)
        ) {
          pids.push(pid);
        }
      }
    }
  }

  const uniquePids = [...new Set(pids)];
  return uniquePids.map((pid) => ({ pid, eosDate, ldosDate }));
}

// ---- Resumable worker -------------------------------------------------------

interface QueueItem {
  id: number;
  url: string;
  kind: string;
  category: string | null;
  series_name: string | null;
}

export interface CiscoRunResult {
  seeded: boolean;
  processed: number;
  upserts: number;
  pending: number;
  done: boolean;
  records: number;
}

async function enqueue(
  url: string,
  kind: string,
  category: string | null,
  seriesName: string | null
): Promise<void> {
  await query(
    `INSERT INTO cisco_eol_queue (url, kind, category, series_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (url) DO NOTHING`,
    [url, kind, category, seriesName]
  );
}

async function markDone(id: number): Promise<void> {
  await query(
    "UPDATE cisco_eol_queue SET status = 'done', processed_at = NOW() WHERE id = $1",
    [id]
  );
}

async function markFailure(id: number, message: string): Promise<void> {
  // Retry transient failures a couple of times; give up (error) after that.
  await query(
    `UPDATE cisco_eol_queue
        SET attempts = attempts + 1,
            note = $2,
            status = CASE WHEN attempts + 1 >= 3 THEN 'error' ELSE 'pending' END
      WHERE id = $1`,
    [id, message.slice(0, 300)]
  );
}

async function upsertBulletinRecords(
  vendorId: number,
  category: string | null,
  sourceUrl: string,
  records: BulletinRecord[]
): Promise<number> {
  let upserts = 0;
  for (const rec of records) {
    const model_normalized = normalizeModel(rec.pid);
    if (!model_normalized) continue;
    await query(
      `INSERT INTO eol_products
         (vendor_id, model_raw, model_normalized, category, eos_date, eosl_date, source_url, entry_method, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'scraped', 'high')
       ON CONFLICT (vendor_id, model_normalized) DO UPDATE SET
         model_raw = EXCLUDED.model_raw,
         category = COALESCE(EXCLUDED.category, eol_products.category),
         eos_date = EXCLUDED.eos_date,
         eosl_date = EXCLUDED.eosl_date,
         source_url = EXCLUDED.source_url,
         entry_method = 'scraped',
         confidence = 'high',
         updated_at = NOW()`,
      [
        vendorId,
        rec.pid,
        model_normalized,
        category,
        normalizeDate(rec.eosDate),
        normalizeDate(rec.ldosDate),
        sourceUrl,
      ]
    );
    upserts += 1;
  }
  return upserts;
}

async function processItem(vendorId: number, item: QueueItem): Promise<number> {
  try {
    const html = await fetchCisco(item.url);

    if (item.kind === 'series') {
      const listingUrl = parseSeriesListingUrl(html);
      if (listingUrl) await enqueue(listingUrl, 'listing', item.category, item.series_name);
      await markDone(item.id);
      return 0;
    }

    if (item.kind === 'listing') {
      const bulletins = parseListingBulletins(html);
      for (const b of bulletins) await enqueue(b, 'bulletin', item.category, item.series_name);
      await markDone(item.id);
      return 0;
    }

    // kind === 'bulletin'
    const records = parseBulletin(html);
    const upserts = await upsertBulletinRecords(vendorId, item.category, item.url, records);
    await markDone(item.id);
    return upserts;
  } catch (err) {
    await markFailure(item.id, err instanceof Error ? err.message : 'error');
    return 0;
  }
}

async function pendingCount(): Promise<number> {
  const { rows } = await query<{ c: number }>(
    "SELECT COUNT(*)::int AS c FROM cisco_eol_queue WHERE status = 'pending'"
  );
  return rows[0]?.c ?? 0;
}

async function vendorRecordCount(vendorId: number): Promise<number> {
  const { rows } = await query<{ c: number }>(
    'SELECT COUNT(*)::int AS c FROM eol_products WHERE vendor_id = $1',
    [vendorId]
  );
  return rows[0]?.c ?? 0;
}

/**
 * Drain one bounded chunk of the Cisco scrape queue, seeding it from the index
 * on the first run. Returns progress so the caller can re-invoke until done.
 */
export async function runCisco(
  vendorId: number,
  indexUrl: string,
  reset = false
): Promise<CiscoRunResult> {
  if (reset) {
    await query('TRUNCATE cisco_eol_queue RESTART IDENTITY');
  }

  // Seed from the index when the queue is empty (fresh start or after reset).
  let seeded = false;
  const { rows: cntRows } = await query<{ c: number }>(
    'SELECT COUNT(*)::int AS c FROM cisco_eol_queue'
  );
  if ((cntRows[0]?.c ?? 0) === 0) {
    await query("UPDATE vendors SET scrape_status = 'running' WHERE id = $1", [vendorId]);
    const indexHtml = await fetchCisco(indexUrl);
    const series = parseIndexSeries(indexHtml);
    for (const s of series) await enqueue(s.url, 'series', s.category, s.name);
    seeded = true;
  }

  // Pull a bounded batch, prioritising bulletins (data) then listings then series.
  const { rows: items } = await query<QueueItem>(
    `SELECT id, url, kind, category, series_name
       FROM cisco_eol_queue
      WHERE status = 'pending'
      ORDER BY CASE kind WHEN 'bulletin' THEN 0 WHEN 'listing' THEN 1 ELSE 2 END, id
      LIMIT $1`,
    [MAX_ITEMS_PER_RUN]
  );

  let processed = 0;
  let upserts = 0;
  for (let i = 0; i < items.length; i += MAX_CONCURRENT) {
    const batch = items.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.all(batch.map((it) => processItem(vendorId, it)));
    upserts += results.reduce((a, b) => a + b, 0);
    processed += batch.length;
    if (i + MAX_CONCURRENT < items.length) await sleep(REQUEST_DELAY_MS);
  }

  const records = await vendorRecordCount(vendorId);
  const pending = await pendingCount();
  const done = pending === 0;

  await query(
    `UPDATE vendors
        SET record_count = $2,
            scrape_status = CASE WHEN $3 THEN 'success' ELSE 'running' END,
            last_scraped_at = CASE WHEN $3 THEN NOW() ELSE last_scraped_at END
      WHERE id = $1`,
    [vendorId, records, done]
  );

  return { seeded, processed, upserts, pending, done, records };
}
