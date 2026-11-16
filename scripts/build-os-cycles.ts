/**
 * Rebuild `data/os-lifecycle.json` from the measured OS-branch lifecycle sources.
 *
 * Run:  npm run build:os-cycles
 *
 * ⛔ MANUAL. NOT SCHEDULED. NOT CALLED BY ANY ROUTE OR FUNCTION. The output is a
 * version-controlled JSON file reviewed as a git diff, exactly like
 * data/eol-seed.json, and published only by the same human-pressed button.
 * CLAUDE.md records that this repo deleted its per-vendor scrapers; the thing it
 * deleted was a SCHEDULED parser writing dates into the live feed with nobody
 * reading them. Wiring this to a cron would recreate that, and the daily
 * lib/eol/watch.ts already raises a review item when these pages change — which
 * is the signal to run this by hand and read the diff.
 *
 * ⛔ TWO SOURCES PER PRODUCT WHERE BOTH EXIST, AND THEY ARE CROSS-CHECKED.
 * PAN-OS is published officially AND by endoflife.date. On 2026-11-16 all 24
 * shared cycles agreed exactly — but only after a timezone bug was fixed in the
 * date parser (see parseLifecycleDate). The cross-check is kept because it is
 * what caught that, and it is the only independent evidence that either
 * extraction is right.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLifecycleDate, checkCycle, type OsCycle } from '../lib/eol/os-cycles';
import {
  PA_EOL_SUMMARY, EOD_PRODUCTS, findPanOsTable, PAN_OS_COLUMNS, PAN_OS_TABLE_MARKERS,
} from '../lib/eol/os-sources';

const UA = 'nocvault-eol/1.0 (+https://nocvault-eol.netlify.app)';

async function get(url: string): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: ctl.signal });
    if (!res.ok) throw new Error(`${url} responded HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(t); }
}

/**
 * PAN-OS, from Palo Alto's own End-of-Life Summary.
 *
 * ⛔ THE TABLE IS LOCATED BY ITS HEADER, NOT BY ITS INDEX ALONE. The page
 * carried 22 tables on 2026-11-16 — content-update versions, QRadar, Prisma,
 * VM-Series on six clouds — and the PAN-OS one was the fourth. An index alone
 * would silently read Prisma's dates as PAN-OS's the first time Palo Alto adds a
 * table above it, and the result would look entirely plausible.
 *
 * ⛔ THE COLUMN LAYOUT HAS AN EMPTY SPACER: a row is
 * [version, release, standard-support, "", extended-support]. Reading index 3 as
 * extended support yields an empty string, which parses to null — a silent loss
 * of every extended-support date. checkCycle's "extended precedes standard"
 * guard is the backstop for getting this wrong in the other direction.
 */
async function panOs(): Promise<OsCycle[]> {
  const html = await get(PA_EOL_SUMMARY);

  // ⛔ ONE LOCATOR, SHARED WITH THE VERIFIER. It lived here and in the verifier
  // as two copies; they drifted on the very first run and the verifier then
  // failed against an unchanged page. See lib/eol/os-sources.ts.
  const rows = findPanOsTable(html);
  if (!rows) {
    throw new Error(
      `PAN-OS table not found on ${PA_EOL_SUMMARY}. It is identified by ${PAN_OS_TABLE_MARKERS}. `
      + 'The page layout has changed — re-measure before editing this.');
  }

  const out: OsCycle[] = [];
  for (const r of rows) {
    const label = (r[PAN_OS_COLUMNS.version] || '').trim();
    if (!/^\d+\.\d+/.test(label)) continue;
    // "9.0-XFR (VM-Series only)" / "5.1 (Panorama only)" -> cycle + qualifier
    const cm = label.match(/^([\d.]+(?:-[A-Za-z]+)?)\s*(?:\((.*)\))?$/);
    const cycle = (cm ? cm[1] : label).trim();
    const qualifier = cm && cm[2] ? cm[2].trim() : null;
    const release = parseLifecycleDate(r[PAN_OS_COLUMNS.release]);
    const std = parseLifecycleDate(r[PAN_OS_COLUMNS.standard]);
    const ext = parseLifecycleDate(r[PAN_OS_COLUMNS.extended]);
    if (!std && !ext) continue;
    out.push({
      vendor: 'Palo Alto', product: 'PAN-OS', cycle,
      release_date: release, support_end_date: std, extended_end_date: ext,
      latest_version: null, lts: null,
      confidence: 'high',
      source: PA_EOL_SUMMARY,
      vendor_link: null,
      note: `PAN-OS ${cycle}${qualifier ? ` (${qualifier})` : ''} — Palo Alto End-of-Life Summary`
        + `${ext ? '; extended support available' : ''}.`,
    });
  }
  return out;
}

type EodRecord = {
  cycle: string; releaseDate?: string; eol?: string | boolean; support?: string | boolean;
  latest?: string; latestReleaseDate?: string; lts?: boolean; link?: string;
};

/**
 * A product from endoflife.date.
 *
 * ⛔ `eol` AND `support` ARE STRING-OR-BOOLEAN IN THIS API. `false` means "not
 * end-of-life", i.e. no date, NOT the date false. Treating the boolean as a date
 * yields "Invalid Date" or, worse, a silent null that reads as "unknown" when
 * the real meaning is "still supported".
 *
 * ⛔ AGGREGATOR -> `low`, ALWAYS. Per CLAUDE.md's sourcing rule. `link` is kept
 * as `vendor_link` so a row can be promoted to `high` by opening the vendor page
 * it already cites.
 */
async function fromEndOfLifeDate(
  product: string, vendor: string, displayProduct: string
): Promise<OsCycle[]> {
  const url = `https://endoflife.date/api/${product}.json`;
  const data: EodRecord[] = JSON.parse(await get(url));
  const out: OsCycle[] = [];
  for (const r of data) {
    const eol = typeof r.eol === 'string' ? parseLifecycleDate(r.eol) : null;
    const support = typeof r.support === 'string' ? parseLifecycleDate(r.support) : null;
    // `support` is when ACTIVE support ends; `eol` is the hard end. Where both
    // exist, `support` is the standard-support analogue and `eol` the extended.
    const std = support || eol;
    const ext = support && eol && eol > support ? eol : null;
    if (!std && !ext) continue;
    out.push({
      vendor, product: displayProduct, cycle: String(r.cycle),
      release_date: parseLifecycleDate(r.releaseDate), support_end_date: std, extended_end_date: ext,
      latest_version: r.latest ?? null,
      lts: typeof r.lts === 'boolean' ? r.lts : null,
      confidence: 'low',
      source: url,
      vendor_link: r.link ?? null,
      note: `${displayProduct} ${r.cycle} — endoflife.date (aggregator, confidence low)`
        + `${r.link ? '; vendor page cited for promotion' : ''}.`,
    });
  }
  return out;
}

async function main() {
  const pa = await panOs();
  const agg = await Promise.all(
    EOD_PRODUCTS.map((p) => fromEndOfLifeDate(p.slug, p.vendor, p.product)));
  const panosAgg = agg[EOD_PRODUCTS.findIndex((p) => p.slug === 'panos')];
  const others = agg.filter((_, i) => EOD_PRODUCTS[i].slug !== 'panos').flat();

  // ⛔ CROSS-CHECK, AND IT IS THE REASON THE AGGREGATOR COPY IS FETCHED AT ALL.
  // It is NOT merged — official wins outright — but a disagreement means one of
  // the two readings is wrong and a human must look before this file ships.
  const byCycle = new Map(pa.map((c) => [c.cycle, c]));
  let agree = 0; const differ: string[] = [];
  for (const a of panosAgg) {
    const o = byCycle.get(a.cycle);
    if (!o) continue;
    // Compare against whichever official date the aggregator's `eol` means.
    const officialHard = o.extended_end_date || o.support_end_date;
    if (a.support_end_date === o.support_end_date || a.support_end_date === officialHard) agree++;
    else differ.push(`${a.cycle}: official=${o.support_end_date}/${o.extended_end_date} aggregator=${a.support_end_date}`);
  }
  console.log(`PAN-OS cross-check vs endoflife.date: ${agree} agree, ${differ.length} differ`);
  for (const d of differ) console.log(`  DIFFER ${d}`);

  // Official PAN-OS replaces the aggregator copy entirely; aggregator cycles the
  // official table does not list are kept at `low`.
  const extraPanos = panosAgg.filter((a) => !byCycle.has(a.cycle));
  if (extraPanos.length) {
    console.log(`PAN-OS cycles only endoflife.date lists (kept at low): ${extraPanos.map((c) => c.cycle).join(', ')}`);
  }

  const all = [...pa, ...extraPanos, ...others]
    .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.product.localeCompare(b.product)
      || b.cycle.localeCompare(a.cycle, undefined, { numeric: true }));

  const bad = all.map((c) => checkCycle(c)).filter(Boolean);
  if (bad.length) {
    console.error(`\nREFUSING TO WRITE — ${bad.length} invalid row(s):`);
    for (const b of bad) console.error(`  ${b!.cycle}: ${b!.reason}`);
    process.exit(1);
  }

  const path = join(process.cwd(), 'data', 'os-lifecycle.json');
  writeFileSync(path, JSON.stringify(all, null, 2) + '\n');

  const byProduct: Record<string, number> = {};
  const byConf: Record<string, number> = {};
  for (const c of all) {
    byProduct[`${c.vendor} ${c.product}`] = (byProduct[`${c.vendor} ${c.product}`] || 0) + 1;
    byConf[c.confidence] = (byConf[c.confidence] || 0) + 1;
  }
  console.log(`\nwrote ${all.length} cycles to data/os-lifecycle.json`);
  for (const [k, v] of Object.entries(byProduct)) console.log(`  ${k.padEnd(22)} ${v}`);
  console.log(`  confidence: ${JSON.stringify(byConf)}`);
}

main().catch((err) => { console.error('build failed:', err.message); process.exit(1); });
