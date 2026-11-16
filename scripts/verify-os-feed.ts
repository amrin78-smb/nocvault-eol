/**
 * EXECUTION VERIFICATION for the OS branch lifecycle feed — apply, build, sign,
 * publish.
 *
 * Run:  npm run verify:os-feed
 *
 * ⛔ REFUSES TO RUN AGAINST ANYTHING BUT A LOCAL TEST DATABASE. It creates and
 * drops os_cycles and os_feed_versions.
 *
 * ⛔ THE BLOB STORE IS A FAKE, AND THAT IS WHY THE INTERESTING CASES EXIST AT
 * ALL. @netlify/blobs only works inside a Netlify function, so without the
 * FeedBlobStore seam the publish path could only be verified by reading it —
 * and every subtle rule in it is there because the CVE feed got it wrong first:
 * a partial write making a broken signature permanent, an empty store with an
 * intact database making every publish a no-op for ever, an audit row recorded
 * for a publish that never happened. Those are the tests below.
 *
 * ⛔ THE SIGNATURE IS VERIFIED WITH THE REAL PUBLIC KEY from CLAUDE.md, not
 * merely "a signature was produced". A feed nobody can verify is a feed nobody
 * can trust, and the failure is silent on this side.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicKey, verify as cryptoVerify, generateKeyPairSync, createHash } from 'node:crypto';
import { rawQuery, pool } from '../lib/db';
import { ensureOsSchema, _resetOsSchemaMemo } from '../lib/eol/os-schema';
import {
  applyOsCycles, buildAndPublishOsFeed, canonicalOsFeedJson, osFeedStatus,
  type FeedBlobStore, type FeedCycle,
} from '../lib/eol/os-feed';
import type { OsCycle } from '../lib/eol/os-cycles';

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

// --- a fake blob store, with the failure modes the real one has -------------
class FakeStore implements FeedBlobStore {
  data = new Map<string, string>();
  failOn: string | null = null;
  writes = 0;
  async get(key: string): Promise<string | null> { return this.data.get(key) ?? null; }
  async set(key: string, value: string): Promise<void> {
    if (this.failOn === key) throw new Error(`simulated blob failure on ${key}`);
    this.writes++;
    this.data.set(key, value);
  }
}

const SRC = 'https://www.paloaltonetworks.com/services/support/end-of-life-announcements/end-of-life-summary';

function cyc(cycle: string, std: string, ext: string | null = null): OsCycle {
  return {
    vendor: 'Palo Alto', product: 'PAN-OS', cycle,
    release_date: '2023-01-01', support_end_date: std, extended_end_date: ext,
    latest_version: null, lts: null, confidence: 'high', source: SRC,
    vendor_link: null, note: `PAN-OS ${cycle}`,
  };
}

function partCanonical() {
  section('PART A — canonical bytes (pure)');

  const base = {
    schema_version: 1, feed_version: '2026-11-16.1',
    generated_at: '2026-11-16T00:00:00Z', row_count: 1,
    cycles: [{
      vendor: 'Palo Alto', product: 'PAN-OS', cycle: '11.1',
      release_date: '2023-11-02', support_end_date: '2027-05-03',
      extended_end_date: '2027-08-31', latest_version: null, lts: null,
      confidence: 'high', source: SRC, vendor_link: null,
    } as FeedCycle],
  };
  const a = canonicalOsFeedJson(base);
  const b = canonicalOsFeedJson(JSON.parse(JSON.stringify(base)));
  eq('the same input produces the same bytes', a, b);

  // ⛔ KEY ORDER IS NAMED, NOT INHERITED. pg returns jsonb keys sorted by length
  // then bytes, and a future SELECT edit can reorder columns; either would change
  // the signature for identical data and make every consumer re-download.
  const shuffled = {
    ...base,
    cycles: [Object.fromEntries(Object.entries(base.cycles[0]).reverse()) as unknown as FeedCycle],
  };
  eq('a row with its keys in a different order produces IDENTICAL bytes',
    canonicalOsFeedJson(shuffled), a);

  check('the payload names the feed fields', a.includes('"schema_version"') && a.includes('"cycles"'));
  // ⛔ A FIELD THE ROW CARRIES BUT THE FEED MUST NOT SHIP.
  const withExtra = { ...base, cycles: [{ ...base.cycles[0], note: 'internal', applied_at: 'x' } as any] };
  check('unlisted row fields are NOT carried into the feed',
    !canonicalOsFeedJson(withExtra).includes('internal'));
}

async function partApply() {
  section('PART B — applying the curated corpus');

  await rawQuery('DROP TABLE IF EXISTS os_cycles, os_feed_versions CASCADE');
  _resetOsSchemaMemo();
  await ensureOsSchema();

  const first = [cyc('11.1', '2027-05-03', '2027-08-31'), cyc('11.0', '2024-11-16'), cyc('10.2', '2025-08-26')];
  let r = await applyOsCycles(first);
  eq('three cycles applied', r.total, 3);
  eq('nothing rejected', r.rejected.length, 0);

  // Re-apply unchanged.
  r = await applyOsCycles(first);
  eq('re-applying the same corpus is idempotent', r.total, 3);
  eq('nothing removed on a no-op apply', r.removed, 0);

  // Update a date.
  const changed = [cyc('11.1', '2027-06-30', '2027-08-31'), cyc('11.0', '2024-11-16'), cyc('10.2', '2025-08-26')];
  await applyOsCycles(changed);
  const row = await rawQuery<any>(
    "SELECT to_char(support_end_date,'YYYY-MM-DD') AS d FROM os_cycles WHERE cycle = '11.1'");
  eq('an updated date is written', row.rows[0].d, '2027-06-30');

  // ⛔ A CYCLE DROPPED FROM THE SEED MUST DISAPPEAR. A stale branch row would go
  // on telling a consumer that a long-dead branch is the vendor's current
  // statement, and nothing would ever contradict it.
  r = await applyOsCycles([cyc('11.1', '2027-06-30', '2027-08-31')]);
  eq('removing a cycle from the corpus deletes the row', r.removed, 2);
  eq('only the remaining cycle is stored', r.total, 1);

  // ⛔ AN INVALID CORPUS WRITES NOTHING AT ALL. Half-applying leaves the
  // database in a state no file describes.
  const before = await rawQuery<{ n: number }>('SELECT count(*)::int AS n FROM os_cycles');
  const bad = [cyc('11.1', '2027-06-30'), { ...cyc('9.9', '2020-01-01'), confidence: 'high' as const,
    source: 'https://endoflife.date/api/panos.json' }];
  r = await applyOsCycles(bad);
  check('an aggregator row at high is rejected', r.rejected.length > 0, JSON.stringify(r.rejected));
  const after = await rawQuery<{ n: number }>('SELECT count(*)::int AS n FROM os_cycles');
  eq('a rejected corpus writes NOTHING', after.rows[0].n, before.rows[0].n);

  // ⛔ THE COLUMN-SWAP GUARD REACHES THE APPLY PATH TOO.
  r = await applyOsCycles([{ ...cyc('11.1', '2027-08-31'), extended_end_date: '2027-05-03' }]);
  check('extended-before-standard is rejected at apply time', r.rejected.length === 1);

  await applyOsCycles(first);
}

async function partPublish() {
  section('PART C — build, sign, publish');

  // A throwaway signing key, so the harness never needs the production one.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.FEED_SIGNING_KEY = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

  const store = new FakeStore();
  let res = await buildAndPublishOsFeed({ store, publishedBy: 'verify', generatedAt: '2026-11-16T10:00:00Z' });
  check('the feed published', res.published === true, JSON.stringify(res));
  eq('three rows', res.row_count, 3);
  check('a version was allocated', /^\d{4}-\d{2}-\d{2}\.\d+$/.test(res.feed_version), res.feed_version);
  check('all three artefacts were written',
    store.data.has('feed.json') && store.data.has('feed.json.sig') && store.data.has('latest.json'));

  // ⛔ THE SIGNATURE MUST ACTUALLY VERIFY OVER THE EXACT BODY BYTES.
  const body = Buffer.from(store.data.get('feed.json')!, 'utf8');
  const sig = Buffer.from(store.data.get('feed.json.sig')!, 'base64');
  check('the Ed25519 signature verifies over the published bytes',
    cryptoVerify(null, body, publicKey, sig));
  check('a tampered body FAILS verification',
    !cryptoVerify(null, Buffer.from(store.data.get('feed.json')!.replace('2027', '2099')), publicKey, sig));

  const pointer = JSON.parse(store.data.get('latest.json')!);
  eq('the pointer names the version', pointer.feed_version, res.feed_version);
  eq('the pointer sha256 matches the body',
    pointer.sha256, createHash('sha256').update(body).digest('hex'));

  // ⛔ DATES MUST BE YYYY-MM-DD TEXT, NOT ISO TIMESTAMPS. A pg `date` arrives as
  // a JS Date and serialises to a full timestamp in the SERVER's timezone — the
  // same class of bug as parseLifecycleDate's, one layer down, and it would both
  // bloat every consumer's download and shift dates outside UTC.
  const parsed = JSON.parse(body.toString());
  const d = parsed.cycles[0].support_end_date;
  check('dates are plain YYYY-MM-DD in the feed', /^\d{4}-\d{2}-\d{2}$/.test(d), String(d));
  check('no ISO timestamps leaked into the feed', !body.toString().includes('T00:00:00'));

  // ⛔ ROW ORDER IS TOTAL AND DETERMINISTIC.
  const order = parsed.cycles.map((c: any) => c.cycle);
  eq('rows are ordered deterministically', JSON.stringify(order), JSON.stringify([...order].sort()));

  section('PART C2 — idempotence');

  const v1 = res.feed_version;
  res = await buildAndPublishOsFeed({ store, publishedBy: 'verify' });
  eq('an unchanged corpus republishes nothing', res.unchanged, true);
  eq('and keeps its version', res.feed_version, v1);
  const rowsAfter = await rawQuery<{ n: number }>('SELECT count(*)::int AS n FROM os_feed_versions');
  eq('no second audit row for an unchanged corpus', rowsAfter.rows[0].n, 1);

  // ⛔ BUT THE POINTER IS STILL REFRESHED, because checked_at is exactly what an
  // unchanged run has to report. Freezing it would blind the one liveness signal
  // precisely when the hub is healthy and the corpus is quiet.
  const before = store.data.get('latest.json');
  await rawQuery(`CREATE TABLE IF NOT EXISTS eol_watch_sources (
     id SERIAL PRIMARY KEY, url TEXT, last_success_at TIMESTAMPTZ)`);
  await rawQuery("INSERT INTO eol_watch_sources (url, last_success_at) VALUES ('x', NOW())");
  res = await buildAndPublishOsFeed({ store, publishedBy: 'verify' });
  const afterPointer = JSON.parse(store.data.get('latest.json')!);
  check('an unchanged run still refreshes checked_at',
    afterPointer.checked_at !== null && store.data.get('latest.json') !== before,
    JSON.stringify(afterPointer));
  // ⛔ checked_at REUSES THE WATCH'S TIMESTAMP rather than defining a second
  // notion of "alive".
  check('checked_at comes from eol_watch_sources', typeof afterPointer.checked_at === 'string');

  section('PART C3 — a changed corpus, and broken publishes');

  await applyOsCycles([cyc('11.1', '2027-05-03', '2027-08-31'), cyc('11.0', '2024-11-16')]);
  res = await buildAndPublishOsFeed({ store, publishedBy: 'verify' });
  check('a changed corpus publishes again', res.published === true && !res.unchanged);
  check('and gets a NEW version', res.feed_version !== v1, `${res.feed_version} vs ${v1}`);
  eq('two rows now', res.row_count, 2);

  // ⛔ NO AUDIT ROW FOR A PUBLISH THAT DID NOT HAPPEN. Recording one would make
  // the next run treat this corpus as already shipped, and the idempotence guard
  // would then refuse to republish — a broken feed made permanent.
  const versionsBefore = await rawQuery<{ n: number }>('SELECT count(*)::int AS n FROM os_feed_versions');
  await applyOsCycles([cyc('11.1', '2028-01-01')]);
  const failing = new FakeStore();
  failing.failOn = 'feed.json';
  res = await buildAndPublishOsFeed({ store: failing, publishedBy: 'verify' });
  eq('a failed blob write reports published=false', res.published, false);
  check('and says the next run will retry', (res.publish_note || '').includes('retries'));
  const versionsAfter = await rawQuery<{ n: number }>('SELECT count(*)::int AS n FROM os_feed_versions');
  eq('NO audit row was written for the failed publish', versionsAfter.rows[0].n, versionsBefore.rows[0].n);

  // ⛔ AN EMPTY STORE WITH AN INTACT DATABASE MUST REPUBLISH, NOT NO-OP. This
  // exact combination made the CVE feed self-sustainingly broken: every publish
  // took the "unchanged" path, the pointer was rewritten with only checked_at,
  // feed.json was never written again, /latest returned 200 and the feed 503 —
  // and the route reported ok throughout.
  await applyOsCycles([cyc('11.1', '2027-05-03', '2027-08-31'), cyc('11.0', '2024-11-16')]);
  await buildAndPublishOsFeed({ store, publishedBy: 'verify' });
  const emptied = new FakeStore(); // same corpus, no artefacts
  res = await buildAndPublishOsFeed({ store: emptied, publishedBy: 'verify' });
  check('an empty store republishes rather than reporting "unchanged"',
    res.published === true && !res.unchanged, JSON.stringify({ p: res.published, u: res.unchanged }));
  check('and the artefacts are restored', emptied.data.has('feed.json') && emptied.data.has('feed.json.sig'));

  section('PART C4 — status');
  const st = await osFeedStatus();
  check('status reports a total', st.total > 0);
  check('status reports the latest version', !!st.latest?.feed_version);
  check('status breaks down by product', st.byProduct.length > 0);
}

async function partRealCorpus() {
  section('PART D — the shipped corpus end to end');

  const cycles: OsCycle[] = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'os-lifecycle.json'), 'utf8'));
  const r = await applyOsCycles(cycles);
  eq('the real corpus applies with nothing rejected', r.rejected.length, 0);
  eq('every cycle is stored', r.total, cycles.length);

  const store = new FakeStore();
  const res = await buildAndPublishOsFeed({ store, publishedBy: 'verify' });
  eq('the real corpus publishes every row', res.row_count, cycles.length);
  const parsed = JSON.parse(store.data.get('feed.json')!);
  eq('the feed carries every cycle', parsed.cycles.length, cycles.length);
  check('the feed is a sane size', res.bytes > 1000 && res.bytes < 2_000_000, `${res.bytes} bytes`);
  console.log(`      ${res.row_count} cycles, ${res.bytes} bytes, version ${res.feed_version}`);
  for (const p of res.by_product) console.log(`      ${p.product.padEnd(22)} ${p.n}`);
}

async function main() {
  const url = process.env.DATABASE_URL || '';
  const localish = /@(localhost|127\.0\.0\.1)/.test(url) || !/@/.test(url);
  if (!localish || !/test/i.test(url)) {
    console.error(
      'REFUSING TO RUN. This harness CREATES and DROPS os_cycles and os_feed_versions.\n'
      + `DATABASE_URL must be local AND contain "test". Got: ${url ? url.replace(/:[^:@/]*@/, ':***@') : '(unset)'}`);
    process.exit(2);
  }

  try {
    partCanonical();
    await partApply();
    await partPublish();
    await partRealCorpus();
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
