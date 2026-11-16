/**
 * EXECUTION VERIFICATION for the vendor EOL page change detector.
 *
 * Run:  npm run verify:eol-watch
 *
 * ⛔ REFUSES TO RUN AGAINST ANYTHING BUT A LOCAL TEST DATABASE. It creates and
 * drops the watch tables and writes a sentinel row into eol_models.
 *
 * ⛔ THE PAGES ARE SERVED LOCALLY, BECAUSE THE BRANCHES THAT MATTER CANNOT BE
 * ORDERED FROM A VENDOR. The interesting cases are a page that quietly empties,
 * a WAF denial wearing an HTTP 200, a listing that gains one row, and a mailer
 * that fails — none of which Cisco will produce on request. The REAL sources are
 * checked separately at the end, as an integration check allowed to be skipped
 * when the network is not there.
 *
 * ⛔ THE CENTRAL CLAIM UNDER TEST IS A NEGATIVE: that this feature never writes
 * an EOL date. CLAUDE.md records that this repo keeps shipping guards verified
 * by reading which then cannot fire, so it is asserted twice — once at runtime
 * against a sentinel catalogue, and once statically against the module source.
 */

import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rawQuery, pool } from '../lib/db';
import { ensureEolWatchSchema } from '../lib/eol/watch-schema';
import {
  extractDateSignal, extractLinkSignal, extractSignal, hashSignal,
  diffSignal, looksBlocked, visibleText, hasDate,
} from '../lib/eol/signal';
import { EOL_WATCH_SOURCES, type EolWatchSource } from '../lib/eol/watch-sources';
import {
  watchSourceStep, runEolWatch, notifyWatchFindings, acknowledgeChange,
  eolWatchStatus, _resetSourcesMemo, UNREADABLE_AFTER_FAILURES,
} from '../lib/eol/watch';

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

// ---------------------------------------------------------------------------
// Local stand-ins: a vendor page server and a mail capture server
// ---------------------------------------------------------------------------

let pageBody = '';
let pageStatus = 200;
let pageRedirectTo = '';
let pageServer: Server | null = null;
let pageUrl = '';

function startPageServer(): Promise<string> {
  return new Promise((resolve) => {
    pageServer = createServer((req, res) => {
      // A second path, so a redirect has somewhere real to land.
      if ((req.url || '').startsWith('/landing')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><nav><a href="/site/x/index.html">Products</a></nav>'
          + 'Explore lifecycle resources</body></html>');
        return;
      }
      if (pageRedirectTo) {
        res.writeHead(302, { Location: pageRedirectTo, 'Content-Type': 'text/html' });
        res.end('');
        return;
      }
      res.writeHead(pageStatus, { 'Content-Type': 'text/html' });
      res.end(pageBody);
    });
    pageServer.listen(0, '127.0.0.1', () => {
      const a = pageServer!.address() as any;
      resolve(`http://127.0.0.1:${a.port}/eol.html`);
    });
  });
}

type Captured = { path: string; headers: Record<string, string>; body: any };
let captured: Captured[] = [];
let mailStatus = 201;
let mailServer: Server | null = null;
let mailBase = '';

function startMailServer(): Promise<string> {
  return new Promise((resolve) => {
    mailServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let parsed: any = null;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        captured.push({ path: req.url || '', headers: req.headers as any, body: parsed });
        res.writeHead(mailStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mailStatus < 300 ? { messageId: 'test' } : { message: 'rejected' }));
      });
    });
    mailServer.listen(0, '127.0.0.1', () => {
      const a = mailServer!.address() as any;
      resolve(`http://127.0.0.1:${a.port}`);
    });
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function datesPage(rows: string[]): string {
  return [
    '<html><head><title>Lifecycle</title>',
    // ⛔ A DATE INSIDE <script> MUST NOT COUNT. Build stamps and analytics
    // payloads carry dates and change on every deploy; counting them would make
    // the signal change constantly for no vendor reason.
    '<script>var buildStamp = "2026-11-16"; var nonce="' + Math.random() + '";</script>',
    '</head><body>',
    '<div class="banner">Rotating promo ' + Math.random() + '</div>',
    '<table>',
    ...rows.map((r) => `<tr><td>${r}</td></tr>`),
    '</table></body></html>',
  ].join('\n');
}

const BASE_ROWS = [
  'PA-220 End-of-Sale: April 30, 2024',
  'PA-820 End-of-Life: December 31, 2026',
  'PA-3020 Last Date of Support: 2027-04-30',
];

/** The real SonicWall body, measured 2026-11-16. */
const INCAPSULA_BODY =
  '<html><body>Request unsuccessful. Incapsula incident ID: 373000500016861373-1500021647543469</body></html>';

/** A client-rendered shell: plenty of bytes, no lifecycle content. Juniper's shape. */
const JS_SHELL =
  '<html><head><script>window.__DATA__=[];</script></head><body><div id="root"></div>'
  + '<p>Do you have time for a two-minute survey?</p>' + 'x'.repeat(40000) + '</body></html>';

const CISCO_PATTERN = /^(?:https:\/\/www\.cisco\.com)?\/c\/en\/us\/products\/switches\/[a-z0-9-]+\/index\.html$/i;

function linksPage(products: Array<[string, string]>): string {
  return [
    '<html><body>',
    // ⛔ THE NAV LINK THAT BROKE THE FIRST PATTERN, reproduced verbatim from the
    // 2026-11-16 measurement on cisco/interfaces-modules.
    '<nav><a href="/site/us/en/products/security/firewalls/index.html">Choose your firewall</a></nav>',
    '<a href="/c/en/us/products/switches/eos-eol-policy.html">End-of-Life Policy</a>',
    ...products.map(([t, h]) => `<li><a href="${h}">${t}</a></li>`),
    '</body></html>',
  ].join('\n');
}

const BASE_PRODUCTS: Array<[string, string]> = [
  ['Cisco Catalyst 1000 Series Switches', '/c/en/us/products/switches/catalyst-1000-series-switches/index.html'],
  ['Cisco Catalyst Digital Building Series Switches', '/c/en/us/products/switches/catalyst-digital-building-series-switches/index.html'],
];

// ---------------------------------------------------------------------------
// PART A — pure extraction
// ---------------------------------------------------------------------------

function partPure() {
  section('PART A — signal extraction (pure, no I/O)');

  const sig = extractDateSignal(datesPage(BASE_ROWS));
  eq('extracts one line per dated row', sig.length, 3);
  check('keeps the dated text', sig.some((l) => l.includes('PA-220') && l.includes('April 30, 2024')));

  // ⛔ THE SCRIPT-CONTENT RULE. datesPage() embeds a build stamp and a random
  // nonce inside <script>. If either leaked into the signal, the hash would
  // change on every single fetch and the detector would alert daily forever.
  check('ignores dates inside <script>', !sig.some((l) => l.includes('buildStamp')));
  const a = hashSignal(extractDateSignal(datesPage(BASE_ROWS)));
  const b = hashSignal(extractDateSignal(datesPage(BASE_ROWS)));
  eq('two renders of the same page hash identically despite nonces/banners', a, b);

  // ⛔ ORDER IS NOT MEANING. A re-ordered table is not a date change.
  const rev = hashSignal(extractDateSignal(datesPage([...BASE_ROWS].reverse())));
  eq('re-ordered rows produce the same hash', rev, a);

  // Date shapes actually observed on vendor pages.
  check('ISO date', hasDate('Support ends 2027-04-30'));
  check('US long date', hasDate('April 30, 2014'));
  check('UK long date', hasDate('As of 31 December 2022'));
  check('abbreviated date', hasDate('30-Apr-2024'));
  check('slashed date', hasDate('4/30/2024'));
  check('a bare year is not a date', !hasDate('Copyright 2026 Cisco'));
  check('a version number is not a date', !hasDate('PAN-OS 10.1.2'));

  eq('a page with no dates yields an empty signal', extractDateSignal('<html><body>Hello</body></html>').length, 0);
  check('prose longer than the line cap is dropped', extractDateSignal(`<p>${'word '.repeat(200)} April 30, 2014</p>`).length === 0);

  // --- links ---
  const links = extractLinkSignal(linksPage(BASE_PRODUCTS), CISCO_PATTERN);
  eq('extracts one entry per matching product link', links.length, 2);
  // ⛔ THE MEASURED FALSE POSITIVE. This single assertion is the reason the
  // pattern is category-anchored rather than shaped like /products/x/y/index.html.
  check('excludes the site-navigation link', !links.some((l) => l.includes('Choose your firewall')));
  check('excludes the policy link (not an /index.html product)', !links.some((l) => l.includes('eos-eol-policy')));
  check('carries the product name, not just the href', links[0].includes('Cisco Catalyst'));

  // --- blocked-body detection ---
  eq('SonicWall Incapsula body is recognised as a denial',
    looksBlocked(INCAPSULA_BODY), 'Incapsula/Imperva WAF denial served as HTTP 200');
  check('Cloudflare challenge is recognised', !!looksBlocked('<html><head><title>Just a moment...</title>'));
  check('a normal vendor page is NOT flagged', looksBlocked(datesPage(BASE_ROWS)) === null);
  // ⛔ NOT A SUBSTRING SEARCH OVER THE WHOLE BODY. "Access Denied" appearing in
  // a 180 KB advisory table is content, not a verdict.
  check('a denial phrase deep inside a long document is not a verdict',
    looksBlocked('<html><body>' + 'x'.repeat(20000) + 'Access Denied akamai</body></html>') === null);

  // --- diff + helpers ---
  const d = diffSignal(['a', 'b'], ['b', 'c']);
  check('diff reports added', d.added.length === 1 && d.added[0] === 'c');
  check('diff reports removed', d.removed.length === 1 && d.removed[0] === 'a');
  check('visibleText strips tags', !visibleText('<p>hi</p>').includes('<p>'));

  // ⛔ A MISCONFIGURED LINK SOURCE THROWS RATHER THAN RETURNING AN EMPTY SET.
  // An empty set means "the read failed"; a configuration error must not be
  // able to borrow that meaning and be reported as an unreadable vendor page.
  let threw = false;
  try { extractSignal('<a href="/x">y</a>', 'links'); } catch { threw = true; }
  check('links extraction without a pattern throws', threw);

  section('PART A2 — the configured source list');
  const urls = new Set(EOL_WATCH_SOURCES.map((s) => s.url));
  eq('no duplicate source URLs', urls.size, EOL_WATCH_SOURCES.length);
  for (const s of EOL_WATCH_SOURCES) {
    check(`${s.label}: https only`, s.url.startsWith('https://'));
    check(`${s.label}: has a recorded measurement`, s.measured.length > 30);
    check(`${s.label}: floor is at least 1`, s.minSignalLines >= 1);
    if (s.signalKind === 'links') {
      check(`${s.label}: link source has an hrefPattern`, !!s.hrefPattern);
    }
  }
}

// ---------------------------------------------------------------------------
// PART B — the detector, against local pages
// ---------------------------------------------------------------------------

const TEST_DATES_LABEL = 'TEST dates source';
let testDateUrl = '';
let testLinkUrl = '';
const TEST_LINKS_LABEL = 'TEST links source';

/** Make exactly one source due, so the step picks a known row. */
async function makeDue(url: string) {
  await rawQuery("UPDATE eol_watch_sources SET last_fetch_at = NOW()");
  await rawQuery("UPDATE eol_watch_sources SET last_fetch_at = NOW() - interval '30 hours' WHERE url = $1", [url]);
}

async function changeCount(): Promise<number> {
  const r = await rawQuery<{ n: number }>('SELECT count(*)::int AS n FROM eol_watch_changes');
  return r.rows[0]?.n ?? 0;
}
async function sourceRow(url: string): Promise<any> {
  const r = await rawQuery<any>('SELECT * FROM eol_watch_sources WHERE url = $1', [url]);
  return r.rows[0];
}

async function partDetector() {
  section('PART B — detection against a local page');

  await rawQuery('DROP TABLE IF EXISTS eol_watch_changes, eol_watch_sources CASCADE');
  await ensureEolWatchSchema();

  // A sentinel catalogue, so "it never writes a date" is a measurement.
  await rawQuery(`CREATE TABLE IF NOT EXISTS eol_models (
      id SERIAL PRIMARY KEY, model_raw TEXT, support_end_date DATE)`);
  await rawQuery('DELETE FROM eol_models');
  await rawQuery("INSERT INTO eol_models (model_raw, support_end_date) VALUES ('SENTINEL-1', '2030-01-01')");

  // Point the configured list at the local server.
  const dateSource: EolWatchSource = {
    vendor: 'TEST', label: TEST_DATES_LABEL, url: pageUrl,
    signalKind: 'dates', minSignalLines: 2, measured: 'local fixture',
  };
  const linkSource: EolWatchSource = {
    vendor: 'TEST', label: TEST_LINKS_LABEL, url: pageUrl + '?links=1',
    signalKind: 'links', hrefPattern: CISCO_PATTERN, minSignalLines: 1, measured: 'local fixture',
  };
  testDateUrl = dateSource.url;
  testLinkUrl = linkSource.url;
  EOL_WATCH_SOURCES.splice(0, EOL_WATCH_SOURCES.length, dateSource, linkSource);
  _resetSourcesMemo();

  // --- first read establishes a baseline, and is NOT a change ---
  pageBody = datesPage(BASE_ROWS); pageStatus = 200;
  await makeDue(dateSource.url);
  let r = await watchSourceStep(8000);
  eq('first successful read is first_seen', r.outcome, 'first_seen');
  eq('first read raises NO review item', await changeCount(), 0);
  check('baseline hash is stored', !!(await sourceRow(dateSource.url)).content_hash);

  // --- unchanged ---
  pageBody = datesPage(BASE_ROWS);
  await makeDue(dateSource.url);
  r = await watchSourceStep(8000);
  eq('an unchanged page is unchanged', r.outcome, 'unchanged');
  eq('an unchanged page raises NO review item', await changeCount(), 0);

  // --- re-ordered only ---
  pageBody = datesPage([...BASE_ROWS].reverse());
  await makeDue(dateSource.url);
  r = await watchSourceStep(8000);
  eq('a re-ordered table is still unchanged', r.outcome, 'unchanged');
  eq('re-ordering raises NO review item', await changeCount(), 0);

  // --- a row is added ---
  const ADDED_ROW = 'PA-5220 End-of-Sale: March 15, 2027';
  pageBody = datesPage([...BASE_ROWS, ADDED_ROW]);
  await makeDue(dateSource.url);
  r = await watchSourceStep(8000);
  eq('an added dated row is a change', r.outcome, 'changed');
  eq('the change reports one addition', r.added, 1);
  eq('the change reports no removals', r.removed, 0);
  eq('one review item exists', await changeCount(), 1);
  const ch = await rawQuery<any>('SELECT * FROM eol_watch_changes ORDER BY id DESC LIMIT 1');
  check('the review item NAMES the added line',
    JSON.stringify(ch.rows[0].added).includes('PA-5220'), JSON.stringify(ch.rows[0].added));
  eq('the review item records the counts', `${ch.rows[0].old_count}->${ch.rows[0].new_count}`, '3->4');
  check('the review item starts unnotified', ch.rows[0].notified_at === null);

  // --- a row is removed ---
  pageBody = datesPage(BASE_ROWS);
  await makeDue(dateSource.url);
  r = await watchSourceStep(8000);
  eq('a removed dated row is a change', r.outcome, 'changed');
  eq('the change reports one removal', r.removed, 1);
  const ch2 = await rawQuery<any>('SELECT * FROM eol_watch_changes ORDER BY id DESC LIMIT 1');
  check('the review item names the removed line',
    JSON.stringify(ch2.rows[0].removed).includes('PA-5220'));

  section('PART B2 — a failed read is never a change');

  const beforeHash = (await sourceRow(dateSource.url)).content_hash;
  const beforeChanges = await changeCount();

  // ⛔ THE CASE THAT MATTERS MOST. A page that becomes a client-rendered shell
  // answers 200 with 40 KB. Read as a change, it would say the vendor deleted
  // every EoL product — a review item that is not merely useless but false.
  pageBody = JS_SHELL; pageStatus = 200;
  await makeDue(dateSource.url);
  r = await watchSourceStep(8000);
  eq('a 200 carrying no dated lines is FAILED, not changed', r.outcome, 'failed');
  eq('it raises NO review item', await changeCount(), beforeChanges);
  eq('the baseline hash is PRESERVED', (await sourceRow(dateSource.url)).content_hash, beforeHash);
  check('the error explains itself', ((await sourceRow(dateSource.url)).last_error || '').includes('FAILED READ'));
  eq('consecutive_failures is 1', (await sourceRow(dateSource.url)).consecutive_failures, 1);

  // ⛔ THE MEASURED SONICWALL BODY.
  pageBody = INCAPSULA_BODY;
  await makeDue(dateSource.url);
  r = await watchSourceStep(8000);
  eq('an Incapsula denial served as 200 is FAILED', r.outcome, 'failed');
  check('the error names the WAF', ((await sourceRow(dateSource.url)).last_error || '').includes('Incapsula'));
  eq('still no review item', await changeCount(), beforeChanges);

  // --- a hard HTTP error ---
  pageStatus = 503; pageBody = 'gateway';
  await makeDue(dateSource.url);
  r = await watchSourceStep(8000);
  eq('HTTP 503 is FAILED', r.outcome, 'failed');
  eq('consecutive_failures has reached the unreadable threshold',
    (await sourceRow(dateSource.url)).consecutive_failures, UNREADABLE_AFTER_FAILURES);
  eq('three failures still raise NO review item', await changeCount(), beforeChanges);

  // --- recovery ---
  pageStatus = 200; pageBody = datesPage(BASE_ROWS);
  await makeDue(dateSource.url);
  r = await watchSourceStep(8000);
  eq('a recovered source reads unchanged against its preserved baseline', r.outcome, 'unchanged');
  eq('consecutive_failures is cleared', (await sourceRow(dateSource.url)).consecutive_failures, 0);

  // ⛔ THE REAL CISCO FAILURE, REPRODUCED. interfaces-modules/eos-eol-listing.html
  // was retired by REDIRECTING it to the generic products landing page: HTTP 200,
  // 201 KB, zero lifecycle content, and a loose pattern happily counted the
  // landing page's navigation as 16 healthy "product links". It must read as a
  // failed source, and the error must name where the request actually landed.
  pageStatus = 200;
  pageRedirectTo = pageUrl.replace('/eol.html', '/landing.html');
  await makeDue(dateSource.url);
  r = await watchSourceStep(8000);
  pageRedirectTo = '';
  eq('a page retired by redirect is FAILED', r.outcome, 'failed');
  check('the error names the redirect target',
    ((await sourceRow(dateSource.url)).last_error || '').includes('REDIRECTED TO'),
    (await sourceRow(dateSource.url)).last_error || '');
  eq('a retired page raises NO review item', await changeCount(), beforeChanges);

  // Recover again so the link-source section starts clean.
  pageStatus = 200; pageBody = datesPage(BASE_ROWS);
  await makeDue(dateSource.url);
  await watchSourceStep(8000);

  section('PART B3 — the link source');

  pageBody = linksPage(BASE_PRODUCTS); pageStatus = 200;
  await makeDue(linkSource.url);
  r = await watchSourceStep(8000);
  eq('link source baselines', r.outcome, 'first_seen');
  eq('only the two product links are counted', r.signalCount, 2);

  pageBody = linksPage([...BASE_PRODUCTS, ['Cisco Catalyst 9200 Series Switches', '/c/en/us/products/switches/catalyst-9200-series-switches/index.html']]);
  await makeDue(linkSource.url);
  r = await watchSourceStep(8000);
  eq('a newly listed product is a change', r.outcome, 'changed');
  eq('exactly one product added', r.added, 1);
  const ch3 = await rawQuery<any>('SELECT * FROM eol_watch_changes ORDER BY id DESC LIMIT 1');
  check('the review item names the new product',
    JSON.stringify(ch3.rows[0].added).includes('Catalyst 9200'));

  // ⛔ NAVIGATION CHANGES MUST NOT REGISTER. Site furniture is re-templated far
  // more often than an EoL listing changes.
  pageBody = linksPage([...BASE_PRODUCTS, ['Cisco Catalyst 9200 Series Switches', '/c/en/us/products/switches/catalyst-9200-series-switches/index.html']])
    .replace('Choose your firewall', 'Find your firewall')
    .replace('<nav>', '<nav class="redesigned-2027">');
  await makeDue(linkSource.url);
  r = await watchSourceStep(8000);
  eq('a navigation rewrite is NOT a change', r.outcome, 'unchanged');
}

// ---------------------------------------------------------------------------
// PART C — notification
// ---------------------------------------------------------------------------

async function partNotify() {
  section('PART B4 — a scoped source');

  // ⛔ THE NOISE PROBLEM THIS SOLVES, REPRODUCED. Palo Alto's EoL summary page
  // carries 556 dated lines across 22 tables, and the first table is the
  // Applications & Threats content releases, which ship WEEKLY. Watching the
  // whole page would raise a review item every week about something nobody
  // tracks. The scope narrows the signal to the section that matters.
  const SECTION = '<div id="watched">PA-9999 End-of-Life: March 1, 2030</div>';
  const noisy = (stamp: string) =>
    `<html><body><div id="weekly">Content release ${stamp}</div>${SECTION}</body></html>`;

  const scopedSource: EolWatchSource = {
    vendor: 'TEST', label: 'TEST scoped source', url: pageUrl + '?scoped=1',
    signalKind: 'dates', minSignalLines: 1,
    scope: (html) => {
      const m = html.match(/<div id="watched">([\s\S]*?)<\/div>/);
      return m ? m[0] : null;
    },
    measured: 'local fixture',
  };
  EOL_WATCH_SOURCES.push(scopedSource);
  _resetSourcesMemo();

  pageStatus = 200;
  pageBody = noisy('January 5, 2027');
  await makeDue(scopedSource.url);
  let r = await watchSourceStep(8000);
  eq('scoped source baselines', r.outcome, 'first_seen');
  eq('only the scoped region is counted', r.signalCount, 1);

  // The noisy region changes — the watched region does not.
  pageBody = noisy('January 12, 2027');
  await makeDue(scopedSource.url);
  r = await watchSourceStep(8000);
  eq('a change OUTSIDE the scope is not a change', r.outcome, 'unchanged');

  // The watched region changes.
  pageBody = noisy('January 19, 2027').replace('March 1, 2030', 'June 1, 2031');
  await makeDue(scopedSource.url);
  r = await watchSourceStep(8000);
  eq('a change INSIDE the scope is a change', r.outcome, 'changed');

  // ⛔ THE REGION DISAPPEARS. "0 dated lines" here would mean "the vendor
  // published no lifecycle dates", which is the failed-read-as-a-fact error.
  const beforeScopeChanges = await changeCount();
  pageBody = '<html><body><div id="weekly">Content release February 2, 2027</div></body></html>';
  await makeDue(scopedSource.url);
  r = await watchSourceStep(8000);
  eq('a vanished scope region is FAILED, not changed', r.outcome, 'failed');
  check('the error says the REGION was not found',
    ((await sourceRow(scopedSource.url)).last_error || '').includes('REGION'),
    (await sourceRow(scopedSource.url)).last_error || '');
  eq('a vanished region raises NO review item', await changeCount(), beforeScopeChanges);

  section('PART C — notification');

  process.env.ALERT_EMAIL_API_BASE = mailBase;
  process.env.ALERT_EMAIL_PROVIDER = 'brevo';
  delete process.env.ALERT_EMAIL_API_KEY;
  delete process.env.ALERT_EMAIL_TO;
  delete process.env.ALERT_EMAIL_FROM;

  const open = await rawQuery<{ n: number }>(
    'SELECT count(*)::int AS n FROM eol_watch_changes WHERE notified_at IS NULL AND acknowledged_at IS NULL');
  check('there are findings to deliver', (open.rows[0]?.n ?? 0) > 0);

  // ⛔ NO MAILER IS NOT AN EXCUSE TO SKIP. The findings must already be recorded.
  captured = [];
  let n = await notifyWatchFindings();
  eq('with no API key the result says so', n.notify?.skipped, 'no_api_key');
  eq('nothing was sent', captured.length, 0);
  const stillOpen = await rawQuery<{ n: number }>(
    'SELECT count(*)::int AS n FROM eol_watch_changes WHERE notified_at IS NULL');
  check('the findings are STILL recorded and still unnotified', (stillOpen.rows[0]?.n ?? 0) > 0);

  process.env.ALERT_EMAIL_API_KEY = 'xkeysib-test';
  n = await notifyWatchFindings();
  eq('with no recipient the result says so', n.notify?.skipped, 'no_recipient');

  process.env.ALERT_EMAIL_TO = 'ops@example.invalid';
  n = await notifyWatchFindings();
  eq('Brevo with no validated sender is reported before the request', n.notify?.skipped, 'no_sender');
  eq('still nothing sent', captured.length, 0);

  // ⛔ A FAILING PROVIDER MUST NOT MARK THE WORK AS ANNOUNCED.
  process.env.ALERT_EMAIL_FROM = 'alerts@example.invalid';
  mailStatus = 422;
  captured = [];
  n = await notifyWatchFindings();
  eq('a provider rejection is reported', n.notify?.skipped, 'provider_error');
  eq('a request WAS attempted', captured.length, 1);
  const unnotified = await rawQuery<{ n: number }>(
    'SELECT count(*)::int AS n FROM eol_watch_changes WHERE notified_at IS NULL AND acknowledged_at IS NULL');
  check('a failed send leaves the findings UNNOTIFIED for retry', (unnotified.rows[0]?.n ?? 0) > 0);

  // --- drive a source to UNREADABLE, so the path is proven rather than assumed ---
  //
  // ⛔ THIS SUB-SECTION EXISTS BECAUSE THE FIRST DRAFT ASSERTED THE EMAIL NAMED
  // AN UNREADABLE SOURCE WHEN NONE WAS UNREADABLE. Part B2 ends by RECOVERING the
  // source it broke, so consecutive_failures was 0 and the assertion was simply
  // false about the state. The honest fix is to force the state, not to soften
  // the claim: an untested alert path is the exact defect this repo keeps
  // recording.
  pageStatus = 503;
  pageBody = 'gateway';
  for (let i = 0; i < UNREADABLE_AFTER_FAILURES; i++) {
    await makeDue(testDateUrl);
    await watchSourceStep(8000);
  }
  const bad = await sourceRow(testDateUrl);
  eq('the source is now at the unreadable threshold', bad.consecutive_failures, UNREADABLE_AFTER_FAILURES);
  check('it has never been reported as unreadable', bad.unreadable_notified_at === null);

  // --- the real send ---
  mailStatus = 201;
  captured = [];
  n = await notifyWatchFindings();
  check('the email was sent', n.notify?.sent === true, JSON.stringify(n.notify));
  eq('exactly one email for the whole cycle', captured.length, 1);

  const req = captured[0];
  eq('Brevo path', req.path, '/v3/smtp/email');
  eq('Brevo auth header', req.headers['api-key'], 'xkeysib-test');
  check('Brevo body shape', !!req.body.sender?.email && Array.isArray(req.body.to) && !!req.body.textContent);
  check('subject names the feature', String(req.body.subject).includes('[EOL WATCH]'));

  const text: string = req.body.textContent;
  check('the body names the vendor page', text.includes('TEST'));
  check('the body names WHAT changed', text.includes('PA-5220') || text.includes('Catalyst 9200'));
  check('the body gives the URL', text.includes('127.0.0.1'));
  // ⛔ THE MOST IMPORTANT SENTENCE IN THE EMAIL.
  check('the body states that NOTHING was written to the catalogue',
    text.includes('NOTHING WAS WRITTEN TO THE CATALOGUE'));
  check('the body names the remedy', text.includes('data/eol-seed.json') && text.includes('Build & Publish Feed'));
  check('the body names the unreadable source', text.includes('consecutive failures'));
  check('the body names the unreadable source by label', text.includes(TEST_DATES_LABEL));
  check('the body gives the unreadable remedy', text.includes('watch-sources.ts'));
  eq('the unreadable source is counted as notified', n.unreadableNotified, 1);
  check('unreadable_notified_at is stamped',
    (await sourceRow(testDateUrl)).unreadable_notified_at !== null);

  const after = await rawQuery<{ n: number }>(
    'SELECT count(*)::int AS n FROM eol_watch_changes WHERE notified_at IS NULL AND acknowledged_at IS NULL');
  eq('a successful send marks the findings notified', after.rows[0]?.n, 0);

  // --- no repeat ---
  captured = [];
  n = await notifyWatchFindings();
  eq('nothing new means no second email', captured.length, 0);
  eq('and it reports zero notified', n.changesNotified, 0);
  // ⛔ THE COOLDOWN. The source is STILL unreadable, and must not re-email
  // every cycle — CLAUDE.md's 23-day outage is the worked example of what
  // per-evaluation alerting does to an inbox.
  eq('a still-unreadable source does not re-email inside the cooldown', n.unreadableNotified, 0);

  section('PART C2 — acknowledgement and status');

  const st = await eolWatchStatus();
  check('status lists the sources', st.sources.length >= 2);
  check('status lists open review items', st.openChanges.length > 0);
  check('status reports alerting configuration', st.alerting.ok === true);

  const first = st.openChanges[0];
  eq('acknowledging closes the item', await acknowledgeChange(first.id, 'checked, no date moved'), true);
  eq('acknowledging twice is a no-op', await acknowledgeChange(first.id), false);
  const st2 = await eolWatchStatus();
  eq('the item is gone from the open list', st2.openChanges.filter((c) => c.id === first.id).length, 0);
}

// ---------------------------------------------------------------------------
// PART D — the negative claim, and a full cycle
// ---------------------------------------------------------------------------

async function partNeverWrites() {
  section('PART D — it never writes an EOL date');

  const before = await rawQuery<{ n: number; d: string }>(
    "SELECT count(*)::int AS n, coalesce(max(support_end_date)::text,'') AS d FROM eol_models");

  pageStatus = 200; pageBody = datesPage([...BASE_ROWS, 'PA-7050 End-of-Life: June 1, 2028']);
  await rawQuery("UPDATE eol_watch_sources SET last_fetch_at = NOW() - interval '30 hours'");
  const run = await runEolWatch({ budgetMs: 25000, notify: false });
  check('a full cycle ran', run.checked > 0, JSON.stringify(run));

  const after = await rawQuery<{ n: number; d: string }>(
    "SELECT count(*)::int AS n, coalesce(max(support_end_date)::text,'') AS d FROM eol_models");
  eq('eol_models row count is unchanged by a cycle that saw a NEW DATE', after.rows[0].n, before.rows[0].n);
  eq('eol_models dates are unchanged', after.rows[0].d, before.rows[0].d);

  // ⛔ THE STATIC HALF. The runtime check proves this cycle wrote nothing; the
  // source check proves there is no code path that could. CLAUDE.md records
  // that guards verified by reading keep turning out unable to fire — so this
  // one is asserted mechanically.
  // ⛔ process.cwd(), NOT __dirname. This file is compiled to
  // .verify-build/scripts/ before it runs, so __dirname resolves to the build
  // output, where the .ts sources do not exist. Caught by execution: the first
  // run crashed with ENOENT on .verify-build/lib/eol/watch.ts.
  const dir = join(process.cwd(), 'lib', 'eol');
  for (const f of ['watch.ts', 'watch-schema.ts', 'signal.ts', 'watch-sources.ts']) {
    const src = readFileSync(join(dir, f), 'utf8');
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const forbidden of ['eol_models', 'model_aliases', 'feed_versions', 'vendors']) {
      check(`${f} contains no statement touching ${forbidden}`,
        !new RegExp(`(INSERT INTO|UPDATE|DELETE FROM|UPSERT)\\s+${forbidden}\\b`, 'i').test(code));
    }
  }
}

// ---------------------------------------------------------------------------
// PART E — the live sources
// ---------------------------------------------------------------------------

async function partLive(real: EolWatchSource[]) {
  section('PART E — the real configured sources (network; skippable)');

  for (const s of real) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      const res = await fetch(s.url, {
        signal: ctl.signal, redirect: 'follow',
        headers: { 'User-Agent': 'nocvault-eol/1.0 (+https://nocvault-eol.netlify.app)' },
      });
      const body = await res.text();
      clearTimeout(t);
      const blocked = looksBlocked(body);
      const sig = res.ok && !blocked ? extractSignal(body, s.signalKind, s.hrefPattern) : [];
      // ⛔ A SOURCE THAT STOPS CARRYING SIGNAL FAILS HERE RATHER THAN QUIETLY
      // CONTRIBUTING NOTHING — the same rule that keeps Fortinet out of the CVE
      // feed list.
      check(`${s.label}: answers 200`, res.ok, `got ${res.status}`);
      check(`${s.label}: body is not a denial`, !blocked, blocked || '');
      check(`${s.label}: still carries at least ${s.minSignalLines} signal line(s)`,
        sig.length >= s.minSignalLines, `found ${sig.length}`);
      console.log(`      ${s.label}: ${body.length} bytes, ${sig.length} ${s.signalKind}`);
    } catch (err: any) {
      console.log(`      ${s.label}: SKIPPED — ${err?.message ?? err}`);
    }
  }
}

async function main() {
  const url = process.env.DATABASE_URL || '';
  const localish = /@(localhost|127\.0\.0\.1)/.test(url) || !/@/.test(url);
  if (!localish || !/test/i.test(url)) {
    console.error(
      'REFUSING TO RUN. This harness CREATES and DROPS the watch tables and writes to eol_models.\n'
      + `DATABASE_URL must be local AND contain "test". Got: ${url ? url.replace(/:[^:@/]*@/, ':***@') : '(unset)'}`
    );
    process.exit(2);
  }

  // Keep the real list before the detector tests replace it.
  const real = EOL_WATCH_SOURCES.map((s) => ({ ...s }));

  pageUrl = await startPageServer();
  mailBase = await startMailServer();
  console.log(`local page server at ${pageUrl}`);
  console.log(`local mail server at ${mailBase}`);
  try {
    partPure();
    await partDetector();
    await partNotify();
    await partNeverWrites();
    await partLive(real);
  } finally {
    pageServer?.close();
    mailServer?.close();
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
