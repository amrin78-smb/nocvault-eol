/**
 * EXECUTION VERIFICATION for the OUI catalogue and its signed feed.
 *
 * Run:  npm run verify:oui
 *
 * ⛔ REFUSES TO RUN AGAINST ANYTHING BUT A LOCAL TEST DATABASE. It creates and
 * drops oui_assignments, oui_refresh_state and oui_feed_versions.
 *
 * ⛔ THE REGISTRIES ARE FAKED FOR THE BRANCHES THAT MATTER. A truncated
 * download, a moved file and an HTML error page cannot be ordered from IEEE on
 * demand, and those are exactly the cases where overwriting 54,000 good
 * assignments with 11 silently removes MAC-vendor resolution from three apps.
 * The REAL registries are checked at the end as an integration test that is
 * allowed to be skipped when the network is not there.
 */

import { generateKeyPairSync, verify as cryptoVerify, createHash } from 'node:crypto';
import { rawQuery, pool } from '../lib/db';
import { ensureOuiSchema, _resetOuiSchemaMemo } from '../lib/oui/schema';
import {
  parseCsvLine, parseRegistryCsv, normalizePrefix, lookupMac, buildLookupTable,
  admit, SPOT_CHECKS, OUI_MATCH_VERSION, type OuiLookup,
} from '../lib/oui/parse';
import { OUI_SOURCES } from '../lib/oui/sources';
import {
  refreshOuiCatalogue, buildAndPublishOuiFeed, canonicalOuiFeedJson, ouiStatus,
  type FeedBlobStore,
} from '../lib/oui/feed';

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

class FakeStore implements FeedBlobStore {
  data = new Map<string, string>();
  failOn: string | null = null;
  async get(key: string): Promise<string | null> { return this.data.get(key) ?? null; }
  async set(key: string, value: string): Promise<void> {
    if (this.failOn === key) throw new Error(`simulated blob failure on ${key}`);
    this.data.set(key, value);
  }
}

const HEADER = 'Registry,Assignment,Organization Name,Organization Address';

function csv(registry: string, rows: Array<[string, string]>): string {
  return [HEADER, ...rows.map(([a, o]) => `${registry},${a},"${o}","somewhere, NY"`)].join('\n');
}

/** Enough rows to clear a lowered floor, plus the interesting ones. */
function bulk(prefixChars: number, n: number, start = 0x100000): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < n; i++) {
    const hex = (start + i).toString(16).toUpperCase().padStart(prefixChars, '0').slice(0, prefixChars);
    out.push([hex, `Filler Vendor ${i}`]);
  }
  return out;
}

function partPure() {
  section('PART A — CSV parsing (pure)');

  // ⛔ THE BUG THAT `line.split(',')` CAUSES, AND IT HITS THE BIGGEST VENDORS
  // FIRST. "Cisco Systems, Inc" is a quoted field containing a comma; splitting
  // naively makes the org "Cisco Systems" and shifts every later column.
  const f = parseCsvLine('MA-L,00000C,"Cisco Systems, Inc","170 West Tasman Dr., San Jose"');
  eq('quoted comma does not split the field', f[2], 'Cisco Systems, Inc');
  eq('and the next column is still right', f[3], '170 West Tasman Dr., San Jose');
  eq('escaped doubled quotes collapse', parseCsvLine('a,"He said ""hi""",c')[1], 'He said "hi"');
  eq('plain fields still work', parseCsvLine('a,b,c').length, 3);

  eq('prefix normalisation strips separators', normalizePrefix('00:1b:17'), '001B17');
  eq('dotted notation too', normalizePrefix('001b.1700.0001'), '001B1700 0001'.replace(' ', ''));
  eq('already-normal passes through', normalizePrefix('001B17'), '001B17');

  section('PART A2 — registry parsing');
  const good = csv('MA-L', [['00000C', 'Cisco Systems, Inc'], ['001B17', 'Palo Alto Networks']]);
  let r = parseRegistryCsv(good, 'MA-L', 6);
  eq('two assignments parsed', r.assignments.length, 2);
  eq('bits derived from the registry', r.assignments[0].prefix_bits, 24);

  // ⛔ A WRONG-LENGTH PREFIX IS SKIPPED, NOT COERCED. The registry defines the
  // shape; a row that does not match it means the file is not what we think,
  // and a wrong-length key in a length-matched lookup table is unreachable.
  r = parseRegistryCsv(csv('MA-L', [['00000C', 'Cisco'], ['ABCD', 'Too short']]), 'MA-L', 6);
  eq('a short prefix is skipped', r.assignments.length, 1);
  check('and the skip says why', r.skipped[0].reason.includes('expected 6'));

  // ⛔ A FILE WHOSE HEADER IS NOT THE REGISTRY'S IS REFUSED WHOLESALE. An HTML
  // error page or a moved file answers 200 with bytes.
  r = parseRegistryCsv('<html><body>Not found</body></html>', 'MA-L', 6);
  eq('a non-registry body yields nothing', r.assignments.length, 0);
  check('and says the header was wrong', r.skipped[0].reason.includes('header'));

  // "Private" is a real IEEE value, not a missing one.
  r = parseRegistryCsv(csv('MA-L', [['00000C', '']]), 'MA-L', 6);
  eq('an empty org is recorded as Private', r.assignments[0].org, 'Private');

  r = parseRegistryCsv(csv('MA-L', [['B84C87', 'IEEE Registration Authority']]), 'MA-L', 6);
  eq('an IEEE-held block is flagged', r.assignments[0].is_registry_block, true);

  r = parseRegistryCsv(csv('MA-L', [['00000C', 'First'], ['00000C', 'Second']]), 'MA-L', 6);
  eq('a duplicate prefix is skipped, first wins', r.assignments.length, 1);
  eq('and the first value is kept', r.assignments[0].org, 'First');

  section('PART A3 — the matching contract');
  eq('match version is pinned', OUI_MATCH_VERSION, 1);

  // ⛔ THE CORRECTNESS POINT OF THE WHOLE FEATURE. 442 MA-L blocks belong to
  // IEEE itself with 13,841 MA-M/MA-S assignments inside them. Checking 24 bits
  // first attributes every one of those to "IEEE Registration Authority" — a
  // confident wrong answer, strictly worse than no answer.
  const table = buildLookupTable([
    { prefix: 'B84C87', prefix_bits: 24, org: 'IEEE Registration Authority', registry: 'MA-L', is_registry_block: true },
    { prefix: 'B84C879', prefix_bits: 28, org: 'Airgain Inc.', registry: 'MA-M', is_registry_block: false },
    { prefix: '00000C', prefix_bits: 24, org: 'Cisco Systems, Inc', registry: 'MA-L', is_registry_block: false },
  ] as OuiLookup[]);

  eq('the LONGER prefix wins over the registry block',
    lookupMac('B8:4C:87:9A:BB:CC', table)?.org, 'Airgain Inc.');
  eq('a different sub-block still falls back to the registry block',
    lookupMac('B8:4C:87:0A:BB:CC', table)?.org, 'IEEE Registration Authority');
  check('and that fallback is FLAGGED as a registry block, not a vendor',
    lookupMac('B8:4C:87:0A:BB:CC', table)?.is_registry_block === true);
  eq('a plain MA-L match works', lookupMac('00:00:0c:11:22:33', table)?.org, 'Cisco Systems, Inc');
  eq('dotted notation matches', lookupMac('0000.0c11.2233', table)?.org, 'Cisco Systems, Inc');
  eq('an unassigned prefix resolves to nothing', lookupMac('FF:FF:FF:11:22:33', table), null);
  // ⛔ A PREFIX IS NOT AN ADDRESS. Accepting one would let a 6-char string
  // resolve as though a device had been identified.
  eq('a bare prefix is not a MAC', lookupMac('00000C', table), null);
  eq('a short string is not a MAC', lookupMac('00:00:0c', table), null);

  section('PART A4 — admission');
  const floorsOk = [
    { registry: 'MA-L' as const, rows: 40000, minRows: 30000 },
    { registry: 'MA-M' as const, rows: 6000, minRows: 4000 },
    { registry: 'MA-S' as const, rows: 7000, minRows: 4000 },
  ];
  const spotTable = buildLookupTable(SPOT_CHECKS.map((s, i) => ({
    prefix: normalizePrefix(s.mac).slice(0, 6), prefix_bits: 24,
    org: ['Cisco Systems, Inc', 'Fortinet, Inc.', 'Palo Alto Networks', 'Apple, Inc.',
      'Raspberry Pi Foundation', 'IEEE Registration Authority'][i],
    registry: 'MA-L', is_registry_block: false,
  })) as OuiLookup[]);
  check('a healthy catalogue is admitted', admit(floorsOk, spotTable).ok);

  // ⛔ A TRUNCATED DOWNLOAD MUST BE REFUSED. Overwriting 54,000 assignments
  // with 11 is a silent, total loss of a feature in three apps — and it would
  // look like a successful run.
  const truncated = admit(
    [{ registry: 'MA-L' as const, rows: 11, minRows: 30000 }, ...floorsOk.slice(1)], spotTable);
  check('a truncated MA-L is refused', !truncated.ok);
  check('and the reason names the floor', truncated.reasons[0].includes('below the floor'));

  // ⛔ ALL THREE REGISTRIES OR NONE, or the 13,841-row misattribution returns.
  const missing = admit([floorsOk[0], { registry: 'MA-M' as const, rows: 0, minRows: 4000 }], spotTable);
  check('a missing registry is refused', !missing.ok);
  check('and it is named', missing.reasons.some((x) => x.includes('MA-S is missing')));

  // ⛔ COUNTS ALONE DO NOT PROVE A CORRECT PARSE. A column shift keeps the
  // counts plausible and makes every answer wrong.
  const wrongTable = buildLookupTable([
    { prefix: '00000C', prefix_bits: 24, org: '170 West Tasman Dr', registry: 'MA-L', is_registry_block: false },
  ] as OuiLookup[]);
  const shifted = admit(floorsOk, wrongTable);
  check('a column-shifted parse fails the spot checks', !shifted.ok);
  check('and the reason names a spot check', shifted.reasons.some((x) => x.includes('spot check')));
}

async function partRefresh() {
  section('PART B — refresh, against fake registries');

  await rawQuery('DROP TABLE IF EXISTS oui_assignments, oui_refresh_state, oui_feed_versions CASCADE');
  _resetOuiSchemaMemo();
  await ensureOuiSchema();

  // Lower the floors so a fixture can clear them without 40,000 rows.
  const realFloors = OUI_SOURCES.map((s) => s.minRows);
  OUI_SOURCES.forEach((s) => { s.minRows = 5; });

  const bodies: Record<string, string> = {};
  const serve = async (url: string) => ({ status: bodies[url] === undefined ? 404 : 200, text: bodies[url] ?? '' });
  const [mal, mam, mas] = OUI_SOURCES;

  const goodMal = csv('MA-L', [
    ['00000C', 'Cisco Systems, Inc'], ['00090F', 'Fortinet, Inc.'], ['001B17', 'Palo Alto Networks'],
    ['000D93', 'Apple, Inc.'], ['B827EB', 'Raspberry Pi Foundation'], ['0050C2', 'IEEE Registration Authority'],
    ...bulk(6, 6),
  ]);
  const goodMam = csv('MA-M', [['B84C879', 'Airgain Inc.'], ...bulk(7, 8, 0x1000000)]);
  const goodMas = csv('MA-S', [['0050C2000', 'Some Small Vendor'], ...bulk(9, 8, 0x100000000)]);

  bodies[mal.url] = goodMal; bodies[mam.url] = goodMam; bodies[mas.url] = goodMas;

  let r = await refreshOuiCatalogue({ fetchImpl: serve });
  check('a healthy refresh is admitted', r.admitted, JSON.stringify(r.reasons));
  check('all three registries contributed', r.perRegistry.every((x) => x.rows > 0));
  const n1 = await rawQuery<{ n: number }>('SELECT count(*)::int AS n FROM oui_assignments');
  eq('rows were written', n1.rows[0].n, r.total);

  // ⛔ THE CASE THE WHOLE ADMISSION STEP EXISTS FOR.
  const before = await rawQuery<{ n: number }>('SELECT count(*)::int AS n FROM oui_assignments');
  bodies[mal.url] = csv('MA-L', [['00000C', 'Cisco Systems, Inc']]); // truncated
  r = await refreshOuiCatalogue({ fetchImpl: serve });
  check('a truncated registry is REFUSED', !r.admitted);
  eq('and nothing was replaced', r.replaced, false);
  const after = await rawQuery<{ n: number }>('SELECT count(*)::int AS n FROM oui_assignments');
  eq('the existing catalogue is INTACT', after.rows[0].n, before.rows[0].n);

  // ⛔ "WE LOOKED AND REFUSED" MUST BE RECORDED. It is a different fact from
  // "we never looked", and the second is the silent outage this repo keeps
  // rediscovering.
  const st = await rawQuery<any>("SELECT last_attempt_at FROM oui_refresh_state WHERE registry = 'MA-L'");
  check('the refused attempt was still recorded', st.rows[0].last_attempt_at !== null);

  // An HTML error page answering 200.
  bodies[mal.url] = '<html><body>503 Service Unavailable</body></html>';
  r = await refreshOuiCatalogue({ fetchImpl: serve });
  check('an HTML body answering 200 is refused', !r.admitted);
  const after2 = await rawQuery<{ n: number }>('SELECT count(*)::int AS n FROM oui_assignments');
  eq('catalogue still intact', after2.rows[0].n, before.rows[0].n);

  // A registry that 404s.
  delete bodies[mam.url];
  r = await refreshOuiCatalogue({ fetchImpl: serve });
  check('a 404 registry is refused', !r.admitted);
  const failRow = await rawQuery<any>("SELECT consecutive_failures FROM oui_refresh_state WHERE registry = 'MA-M'");
  check('and its failure count advanced', Number(failRow.rows[0].consecutive_failures) > 0);

  // Recovery, with a prefix removed upstream.
  bodies[mal.url] = goodMal; bodies[mam.url] = goodMam; bodies[mas.url] = goodMas;
  r = await refreshOuiCatalogue({ fetchImpl: serve });
  check('recovery is admitted again', r.admitted);

  // ⛔ A PREFIX THE REGISTRY NO LONGER LISTS MUST NOT SURVIVE. The registry is
  // authoritative; a stale row keeps answering with a vendor IEEE has withdrawn.
  bodies[mal.url] = csv('MA-L', [
    ['00000C', 'Cisco Systems, Inc'], ['00090F', 'Fortinet, Inc.'], ['001B17', 'Palo Alto Networks'],
    ['000D93', 'Apple, Inc.'], ['B827EB', 'Raspberry Pi Foundation'], ['0050C2', 'IEEE Registration Authority'],
    ...bulk(6, 5),
  ]);
  const totalBefore = (await rawQuery<{ n: number }>('SELECT count(*)::int AS n FROM oui_assignments')).rows[0].n;
  r = await refreshOuiCatalogue({ fetchImpl: serve });
  const totalAfter = (await rawQuery<{ n: number }>('SELECT count(*)::int AS n FROM oui_assignments')).rows[0].n;
  check('a withdrawn prefix is deleted', totalAfter === totalBefore - 1, `${totalBefore} -> ${totalAfter}`);

  OUI_SOURCES.forEach((s, i) => { s.minRows = realFloors[i]; });
  // Restore a full catalogue for the publish section.
  OUI_SOURCES.forEach((s) => { s.minRows = 5; });
  bodies[mal.url] = goodMal;
  await refreshOuiCatalogue({ fetchImpl: serve });
  OUI_SOURCES.forEach((s, i) => { s.minRows = realFloors[i]; });
}

async function partPublish() {
  section('PART C — build, sign, publish');

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.FEED_SIGNING_KEY = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

  const store = new FakeStore();
  let res = await buildAndPublishOuiFeed({ store, publishedBy: 'verify', generatedAt: '2026-11-16T10:00:00Z' });
  check('the feed published', res.published, JSON.stringify(res));
  check('rows were carried', res.row_count > 0);

  const body = Buffer.from(store.data.get('feed.json')!, 'utf8');
  const sig = Buffer.from(store.data.get('feed.json.sig')!, 'base64');
  check('the Ed25519 signature verifies over the published bytes',
    cryptoVerify(null, body, publicKey, sig));
  check('a tampered body FAILS verification',
    !cryptoVerify(null, Buffer.from(body.toString().replace('Cisco', 'Bogus')), publicKey, sig));

  const parsed = JSON.parse(body.toString());
  // ⛔ THE TUPLE LAYOUT TRAVELS WITH THE FEED, so a consumer never guesses.
  eq('the payload names its tuple layout',
    JSON.stringify(parsed.tuple), JSON.stringify(['prefix', 'prefix_bits', 'org', 'is_registry_block']));
  eq('match_version travels with the feed', parsed.match_version, OUI_MATCH_VERSION);
  check('entries are positional tuples', Array.isArray(parsed.entries[0]) && parsed.entries[0].length === 4);
  // ⛔ COMPACT, NOT PRETTY. This is the only feed in the repo that is not
  // indented; at 54k rows the difference is megabytes on every consumer pull.
  check('the body is compact (no pretty-printing)', !body.toString().includes('\n  "'));

  const order = parsed.entries.map((e: any[]) => e[0]);
  eq('rows are ordered deterministically', JSON.stringify(order), JSON.stringify([...order].sort()));

  const pointer = JSON.parse(store.data.get('latest.json')!);
  eq('the pointer sha256 matches the body', pointer.sha256, createHash('sha256').update(body).digest('hex'));

  // A consumer can actually use it.
  const table = buildLookupTable(parsed.entries.map((e: any[]) => ({
    prefix: e[0], prefix_bits: e[1], org: e[2], registry: 'MA-L', is_registry_block: e[3] === 1,
  })) as OuiLookup[]);
  eq('a consumer round-trip resolves Cisco', lookupMac('00:00:0C:11:22:33', table)?.org, 'Cisco Systems, Inc');
  eq('and longest-prefix still wins after a round trip',
    lookupMac('B8:4C:87:9A:BB:CC', table)?.org, 'Airgain Inc.');

  section('PART C2 — idempotence and broken publishes');
  const v1 = res.feed_version;
  res = await buildAndPublishOuiFeed({ store, publishedBy: 'verify' });
  eq('an unchanged catalogue republishes nothing', res.unchanged, true);
  eq('and keeps its version', res.feed_version, v1);
  const versions = await rawQuery<{ n: number }>('SELECT count(*)::int AS n FROM oui_feed_versions');
  eq('no second audit row', versions.rows[0].n, 1);

  const vBefore = (await rawQuery<{ n: number }>('SELECT count(*)::int AS n FROM oui_feed_versions')).rows[0].n;
  await rawQuery("DELETE FROM oui_assignments WHERE prefix = '000D93'");
  const failing = new FakeStore();
  failing.failOn = 'feed.json';
  res = await buildAndPublishOuiFeed({ store: failing, publishedBy: 'verify' });
  eq('a failed blob write reports published=false', res.published, false);
  const vAfter = (await rawQuery<{ n: number }>('SELECT count(*)::int AS n FROM oui_feed_versions')).rows[0].n;
  eq('NO audit row for a publish that did not happen', vAfter, vBefore);

  // ⛔ EMPTY STORE, INTACT DATABASE: must republish, not report "unchanged".
  await buildAndPublishOuiFeed({ store, publishedBy: 'verify' });
  const emptied = new FakeStore();
  res = await buildAndPublishOuiFeed({ store: emptied, publishedBy: 'verify' });
  check('an empty store republishes rather than no-opping', res.published && !res.unchanged);

  section('PART C3 — status');
  const st = await ouiStatus();
  check('status reports a total', st.total > 0);
  check('status breaks down by registry', st.byRegistry.length >= 1);
  check('status reports refresh state', st.refresh.length === 3);
}

async function partLive() {
  section('PART D — the real IEEE registries (network; skippable)');
  for (const src of OUI_SOURCES) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 45000);
      const res = await fetch(src.url, {
        signal: ctl.signal,
        headers: { 'User-Agent': 'nocvault-eol/1.0 (+https://nocvault-eol.netlify.app)' },
      });
      const text = await res.text();
      clearTimeout(t);
      check(`${src.registry}: answers 200`, res.ok, `got ${res.status}`);
      const { assignments, skipped } = parseRegistryCsv(text, src.registry, src.prefixChars);
      // ⛔ A REGISTRY THAT STOPS PARSING FAILS HERE rather than quietly shrinking
      // the catalogue on the next scheduled refresh.
      check(`${src.registry}: still parses above its floor (${src.minRows})`,
        assignments.length >= src.minRows, `got ${assignments.length}`);
      console.log(`      ${src.registry}: ${text.length} bytes, ${assignments.length} assignments, ${skipped.length} skipped`);
    } catch (err: any) {
      console.log(`      ${src.registry}: SKIPPED — ${err?.message ?? err}`);
    }
  }
}

async function main() {
  const url = process.env.DATABASE_URL || '';
  const localish = /@(localhost|127\.0\.0\.1)/.test(url) || !/@/.test(url);
  if (!localish || !/test/i.test(url)) {
    console.error(
      'REFUSING TO RUN. This harness CREATES and DROPS the OUI tables.\n'
      + `DATABASE_URL must be local AND contain "test". Got: ${url ? url.replace(/:[^:@/]*@/, ':***@') : '(unset)'}`);
    process.exit(2);
  }
  try {
    partPure();
    await partRefresh();
    await partPublish();
    await partLive();
  } finally {
    await pool.end().catch(() => {});
  }
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
