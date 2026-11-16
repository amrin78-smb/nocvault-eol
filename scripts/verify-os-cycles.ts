/**
 * EXECUTION VERIFICATION for the OS/firmware branch lifecycle corpus.
 *
 * Run:  npm run verify:os
 *
 * ⛔ READ-ONLY. No database, no writes. It reads data/os-lifecycle.json and
 * lib/eol/os-cycles.ts, and makes a handful of network calls at the end to check
 * the live sources still have the shape the corpus was built from.
 *
 * ⛔ THE FIRST SECTION EXISTS BECAUSE OF A BUG THAT ALMOST SHIPPED. Cross-
 * checking Palo Alto's official PAN-OS table against endoflife.date showed all
 * 24 shared cycles DISAGREEING by exactly one day. The sources were identical;
 * the date parser was converting local midnight to UTC on a UTC+7 machine. Every
 * date in this corpus would have been one day early, and the only symptom was a
 * disagreement that read like an aggregator data-quality problem. The parser is
 * now tested against four timezones spanning UTC-11 to UTC+14.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseLifecycleDate, branchOf, checkCycle, branchState, OS_BRANCH_VERSION, type OsCycle,
} from '../lib/eol/os-cycles';
import { classifySource } from '../lib/eol/source-policy';
import { PA_EOL_SUMMARY, EOD_PRODUCTS, findPanOsTable, PAN_OS_TABLE_MARKERS } from '../lib/eol/os-sources';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t: string) { console.log(`\n=== ${t} ===`); }

const UA = 'nocvault-eol/1.0 (+https://nocvault-eol.netlify.app)';

function partDates() {
  section('PART A — the date parser, across timezones');

  // ⛔ THE REGRESSION TEST FOR THE SHIPPED-ALMOST BUG. UTC-11 through UTC+14 is
  // the full span of real civil offsets. A parser built on
  // `new Date(string).toISOString()` fails everything east of UTC here.
  const original = process.env.TZ;
  const ZONES = ['UTC', 'Asia/Bangkok', 'Pacific/Kiritimati', 'Pacific/Midway'];
  for (const tz of ZONES) {
    process.env.TZ = tz;
    eq(`[${tz}] "July 30, 2026" -> 2026-07-30`, parseLifecycleDate('July 30, 2026'), '2026-07-30');
    eq(`[${tz}] "July 30th, 2026" -> 2026-07-30`, parseLifecycleDate('July 30th, 2026'), '2026-07-30');
    eq(`[${tz}] ISO passthrough`, parseLifecycleDate('2026-07-30'), '2026-07-30');
    eq(`[${tz}] "1 January 2027" -> 2027-01-01`, parseLifecycleDate('1 January 2027'), '2027-01-01');
  }
  process.env.TZ = original;

  eq('ordinals: 1st', parseLifecycleDate('May 1st, 2024'), '2024-05-01');
  eq('ordinals: 2nd/3rd', parseLifecycleDate('March 3rd, 2024'), '2024-03-03');
  eq('abbreviated month', parseLifecycleDate('Sep 8 2025'), '2025-09-08');
  eq('US slashes', parseLifecycleDate('07/30/2026'), '2026-07-30');
  eq('day-first long form', parseLifecycleDate('31 December 2026'), '2026-12-31');

  // ⛔ VENDOR TABLES PUT WORDS IN DATE COLUMNS. "Latest" appears in Palo Alto's
  // own VM-Series tables. These must be null, never a parsed garbage date.
  for (const w of ['Latest', 'TBD', 'N/A', 'None', 'Not announced', '-', '']) {
    eq(`non-date "${w}" -> null`, parseLifecycleDate(w), null);
  }
  eq('null in, null out', parseLifecycleDate(null), null);
  eq('undefined in, null out', parseLifecycleDate(undefined), null);

  // ⛔ A ROLLED-OVER DATE IS A PARSE FAILURE, NOT A DATE. Date.UTC(2026,1,31)
  // silently becomes 3 March; returning that would invent a support date the
  // vendor never published.
  eq('February 31 is rejected, not rolled over', parseLifecycleDate('February 31, 2026'), null);
  eq('month 13 is rejected', parseLifecycleDate('2026-13-01'), null);
  eq('unparseable text', parseLifecycleDate('sometime next year'), null);

  section('PART A2 — branch matching');
  eq('branch version is pinned', OS_BRANCH_VERSION, 1);
  eq('PAN-OS point release', branchOf('10.1.2'), '10.1');
  eq('PAN-OS hotfix suffix', branchOf('10.1.2-h3'), '10.1');
  eq('FortiOS build suffix', branchOf('7.4.4 build2662'), '7.4');
  eq('v-prefixed', branchOf('v7.2.8'), '7.2');
  // ⛔ CISCO WRITES BOTH "17.9.1" AND "17.09.01a" FOR ONE BRANCH. Without
  // stripping leading zeros these are two keys and half the lookups miss.
  eq('Cisco zero-padded minor', branchOf('17.09.01a'), '17.9');
  eq('Cisco unpadded', branchOf('17.9.1'), '17.9');
  eq('already a branch', branchOf('11.1'), '11.1');
  eq('garbage', branchOf('not-a-version'), null);
  eq('null', branchOf(null), null);

  section('PART A3 — row validation');
  const ok: OsCycle = {
    vendor: 'Palo Alto', product: 'PAN-OS', cycle: '11.1',
    release_date: '2023-11-02', support_end_date: '2027-05-03', extended_end_date: '2027-08-31',
    latest_version: null, lts: null, confidence: 'high', source: PA_EOL_SUMMARY,
    vendor_link: null, note: 'x',
  };
  check('a well-formed official row passes', checkCycle(ok) === null);
  check('missing cycle is refused', checkCycle({ ...ok, cycle: '' }) !== null);
  check('a non major.minor cycle is refused', checkCycle({ ...ok, cycle: 'latest' }) !== null);
  check('a non-ISO date is refused', checkCycle({ ...ok, support_end_date: 'May 2027' as any }) !== null);
  check('a row with no support dates at all is refused',
    checkCycle({ ...ok, support_end_date: null, extended_end_date: null }) !== null);

  // ⛔ THE COLUMN-SWAP GUARD. Palo Alto's table has an EMPTY SPACER COLUMN
  // between standard and extended support; reading the wrong index is the single
  // most likely extraction mistake, and it is silent.
  check('extended support ending BEFORE standard is refused (columns swapped)',
    checkCycle({ ...ok, support_end_date: '2027-08-31', extended_end_date: '2027-05-03' }) !== null);
  check('support ending before release is refused',
    checkCycle({ ...ok, release_date: '2027-01-01', support_end_date: '2024-01-01', extended_end_date: null }) !== null);

  // The sourcing rule, inherited rather than restated.
  check('an aggregator row at high is refused',
    checkCycle({ ...ok, source: 'https://endoflife.date/api/panos.json', confidence: 'high' }) !== null);
  check('an aggregator row at low passes',
    checkCycle({ ...ok, source: 'https://endoflife.date/api/panos.json', confidence: 'low' }) === null);
  check('an unrecognised source host is refused',
    checkCycle({ ...ok, source: 'https://some-blog.example/panos' }) !== null);

  section('PART A4 — branch state');
  const c = { support_end_date: '2027-05-03', extended_end_date: '2027-08-31' };
  eq('before standard end -> supported', branchState(c, '2026-11-16'), 'supported');
  eq('on the standard end date -> still supported', branchState(c, '2027-05-03'), 'supported');
  // ⛔ FOUR STATES, NEVER THREE. "Past standard, inside extended" is its own
  // answer: calling it supported hides that the customer needs a contract they
  // may not hold; calling it eol is wrong for the customers who do.
  eq('day after standard end -> extended_only', branchState(c, '2027-05-04'), 'extended_only');
  eq('after extended end -> eol', branchState(c, '2027-09-01'), 'eol');
  eq('no dates -> unknown', branchState({ support_end_date: null, extended_end_date: null }), 'unknown');
  eq('no extended option, past standard -> eol',
    branchState({ support_end_date: '2024-01-01', extended_end_date: null }, '2026-11-16'), 'eol');
}

function partCorpus(): OsCycle[] {
  section('PART B — the shipped corpus');
  const path = join(process.cwd(), 'data', 'os-lifecycle.json');
  const cycles: OsCycle[] = JSON.parse(readFileSync(path, 'utf8'));
  console.log(`  ${cycles.length} cycles in data/os-lifecycle.json`);

  const bad = cycles.map((c) => checkCycle(c)).filter(Boolean);
  if (bad.length) for (const b of bad.slice(0, 15)) console.log(`    ${b!.cycle}: ${b!.reason}`);
  check('every cycle row is valid and policy-conforming', bad.length === 0, `${bad.length} invalid`);

  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const c of cycles) {
    const k = `${c.vendor}|${c.product}|${c.cycle}`;
    if (seen.has(k)) dupes.push(k); else seen.add(k);
  }
  check('no duplicate (vendor, product, cycle)', dupes.length === 0, dupes.slice(0, 5).join(', '));

  // ⛔ AN AGGREGATOR ROW WITHOUT ITS VENDOR LINK HAS NO PROMOTION PATH, which is
  // the entire argument for carrying aggregator rows at all.
  const aggNoLink = cycles.filter((c) => classifySource(c.source) === 'aggregator' && !c.vendor_link);
  console.log(`  aggregator rows without a vendor_link: ${aggNoLink.length}/${cycles.filter((c) => classifySource(c.source) === 'aggregator').length}`);

  const byProduct: Record<string, { n: number; high: number; low: number }> = {};
  for (const c of cycles) {
    const k = `${c.vendor} ${c.product}`;
    byProduct[k] = byProduct[k] || { n: 0, high: 0, low: 0 };
    byProduct[k].n++;
    if (c.confidence === 'high') byProduct[k].high++;
    if (c.confidence === 'low') byProduct[k].low++;
  }
  console.log('\n  coverage:');
  for (const [k, v] of Object.entries(byProduct)) {
    console.log(`    ${k.padEnd(22)} ${String(v.n).padStart(3)} cycles  (high ${v.high}, low ${v.low})`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const live = cycles.filter((c) => branchState(c, today) === 'supported');
  const ext = cycles.filter((c) => branchState(c, today) === 'extended_only');
  const dead = cycles.filter((c) => branchState(c, today) === 'eol');
  console.log(`\n  as of ${today}: ${live.length} supported, ${ext.length} extended-only, ${dead.length} EOL`);
  check('at least one branch is still supported per product',
    Object.keys(byProduct).every((k) => live.some((c) => `${c.vendor} ${c.product}` === k)),
    'a product with zero supported branches usually means a stale or misparsed table');

  return cycles;
}

async function partLive(cycles: OsCycle[]) {
  section('PART C — the live sources (network; skippable)');
  try {
    const res = await fetch(PA_EOL_SUMMARY, { headers: { 'User-Agent': UA } });
    const html = await res.text();
    check('Palo Alto EoL summary answers 200', res.ok, `got ${res.status}`);

    // ⛔ THE SAME LOCATOR THE GENERATOR USES, IMPORTED NOT RE-IMPLEMENTED.
    // These were two copies; they drifted on the first run and this check failed
    // against a page that had not changed. See lib/eol/os-sources.ts.
    const rows = findPanOsTable(html);
    check('the PAN-OS table is still identifiable', rows !== null,
      `expected ${PAN_OS_TABLE_MARKERS}; re-run npm run build:os-cycles and re-measure`);
    if (rows) {
      const dataRows = rows.filter((r) => /^\d+\.\d+/.test((r[0] || '').trim()));
      check('the PAN-OS table still has cycle rows', dataRows.length >= 10, `${dataRows.length} rows`);
      console.log(`      Palo Alto: ${dataRows.length} PAN-OS cycle rows live`);
    }
  } catch (err: any) {
    console.log(`      Palo Alto: SKIPPED — ${err?.message ?? err}`);
  }

  for (const { slug: product, product: display } of EOD_PRODUCTS) {
    try {
      const res = await fetch(`https://endoflife.date/api/${product}.json`, { headers: { 'User-Agent': UA } });
      const data = await res.json();
      check(`endoflife.date/${product} answers 200 with an array`, res.ok && Array.isArray(data) && data.length > 0,
        `status ${res.status}`);
      console.log(`      ${display}: ${Array.isArray(data) ? data.length : 0} cycles upstream`);
    } catch (err: any) {
      console.log(`      ${display}: SKIPPED — ${err?.message ?? err}`);
    }
  }

  // ⛔ THE CROSS-CHECK THAT CAUGHT THE TIMEZONE BUG, KEPT AS A STANDING TEST.
  // Two independent readings of PAN-OS must agree; if they stop agreeing, one of
  // them has drifted and the corpus should not be trusted until someone looks.
  try {
    const agg = await (await fetch('https://endoflife.date/api/panos.json', { headers: { 'User-Agent': UA } })).json();
    const official = new Map(
      cycles.filter((c) => c.product === 'PAN-OS' && c.confidence === 'high').map((c) => [c.cycle, c]));
    let agree = 0; const differ: string[] = [];
    for (const a of agg as any[]) {
      const o = official.get(String(a.cycle));
      if (!o) continue;
      const aggEol = typeof a.eol === 'string' ? parseLifecycleDate(a.eol) : null;
      if (aggEol === o.support_end_date || aggEol === o.extended_end_date) agree++;
      else differ.push(`${a.cycle}: corpus=${o.support_end_date}/${o.extended_end_date} aggregator=${aggEol}`);
    }
    for (const d of differ.slice(0, 8)) console.log(`      DIFFER ${d}`);
    check(`PAN-OS official corpus agrees with endoflife.date (${agree} cycles)`,
      differ.length === 0 && agree > 0, `${differ.length} disagreements`);
  } catch (err: any) {
    console.log(`      cross-check: SKIPPED — ${err?.message ?? err}`);
  }
}

async function main() {
  partDates();
  const cycles = partCorpus();
  await partLive(cycles);
  console.log(`\n${'='.repeat(60)}`);
  if (failures.length === 0) console.log(`ALL ${passed} CHECKS PASSED`);
  else {
    console.log(`${passed} passed, ${failures.length} FAILED:`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('='.repeat(60));
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => { console.error('harness crashed:', err); process.exit(1); });
