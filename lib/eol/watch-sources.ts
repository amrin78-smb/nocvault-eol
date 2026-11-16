// lib/eol/watch-sources.ts
//
// Vendor EOL/EOS pages this service WATCHES FOR CHANGE.
//
// ⛔ THIS IS A CHANGE DETECTOR, NOT A SCRAPER, AND THE DIFFERENCE IS THE WHOLE
// DESIGN. CLAUDE.md records that the per-vendor HTML/regex scrapers were REMOVED
// because they did not work; re-adding them under a new name would be the same
// mistake with a fresh coat. Nothing here ever writes an EOL date. It notices
// that a vendor's published listing is no longer what it was, and raises a
// review item for the curated research sweep that `data/eol-seed.json` is fed
// by. A human still reads the bulletin and still types the date.
//
// ⛔ WHY NOT RSS: BECAUSE NO VENDOR PUBLISHES ONE. Probed 2026-11-16 across
// Cisco, Fortinet, Palo Alto, HPE/Aruba, Netgear, Juniper, SonicWall, Check
// Point, Ruckus, Ubiquiti, Meraki, TP-Link and D-Link: there is no EOL feed
// anywhere, in any format. Every lifecycle listing is an HTML page. That is the
// finding that shaped this file — the CVE half of the same feature got real
// feeds and uses them (lib/cve/rss-sources.ts); the EOL half cannot, and says so
// rather than pretending otherwise.
//
// ⛔ EVERY ENTRY WAS PROBED LIVE AND WHAT IT RETURNED IS RECORDED BESIDE IT,
// exactly as vendor-cpes.ts records each CPE's totalResults and rss-sources.ts
// records each feed's identifier yield.

import type { SignalKind } from './signal';
import { PA_EOL_SUMMARY, findPanOsTable } from './os-sources';

export type EolWatchSource = {
  /** Display vendor. Free text — this never selects a CPE or a feed gate. */
  vendor: string;
  /** Short human label, used in the alert subject line. */
  label: string;
  url: string;
  signalKind: SignalKind;
  /** Required for signalKind 'links'. Anchored to the category path — see below. */
  hrefPattern?: RegExp;
  /**
   * ⛔ NARROW THE PAGE BEFORE EXTRACTING, WHEN MOST OF IT IS NOISE.
   *
   * Returns the sub-region of the HTML to read, or null when that region has
   * vanished (which is a FAILED READ, not an empty one). Added for Palo Alto's
   * End-of-Life Summary: 556 dated lines across 22 tables, of which the FIRST
   * table is the Applications & Threats content releases — 157.19.x.x on
   * November 4, 156.17.x.x on October 21, 155.16.x.x on October 8. Those ship
   * roughly weekly, so watching the whole page would raise a review item every
   * week, forever, about content updates nobody is tracking. One source like
   * that is enough to make an operator stop reading the channel.
   */
  scope?: (html: string) => string | null;
  /**
   * ⛔ THE COLLAPSE FLOOR. Below this many signal lines the read is treated as
   * FAILED, never as "the vendor removed everything". Set well under the
   * measured count: it exists to catch a page that has become a shell or a
   * denial, not to police genuine small edits.
   */
  minSignalLines: number;
  /** What the live probe returned. Keep updated when re-measured. */
  measured: string;
};

/**
 * ⛔ CISCO'S PATTERN IS ANCHORED TO ITS OWN CATEGORY PATH, and that is not
 * fussiness. Measured 2026-11-16 on interfaces-modules: a pattern matching any
 * `/products/<x>/<y>/index.html` also caught the page-furniture link
 * `Choose your firewall :: /site/us/en/products/security/firewalls/index.html`.
 * Site navigation is re-templated far more often than an EoL listing changes, so
 * one nav link inside the signal turns this detector into a false-alarm
 * generator — the single failure mode that makes an operator stop reading.
 */
function ciscoCategory(cat: string): RegExp {
  return new RegExp(`^(?:https://www\\.cisco\\.com)?/c/en/us/products/${cat}/[a-z0-9-]+/index\\.html$`, 'i');
}

export const EOL_WATCH_SOURCES: EolWatchSource[] = [
  // ---- Cisco: five category listings, watched as LINK SETS ----
  //
  // ⛔ THESE PAGES CARRY ZERO DATES, AND THAT IS NOT A DEFECT IN THEM. The page
  // says so itself: "Only the linked items below are End-of-Sale or End-of-Life
  // products. Click on the product link..." It is an INDEX; each product's dates
  // live in its own bulletin. So the watchable fact is which products are on the
  // list, and a product appearing is precisely the prompt for a research sweep.
  {
    vendor: 'Cisco', label: 'Cisco security EoL listing',
    url: 'https://www.cisco.com/c/en/us/products/security/eos-eol-listing.html',
    signalKind: 'links', hrefPattern: ciscoCategory('security'), minSignalLines: 1,
    measured: '2026-11-16: HTTP 200, 18.8 KB, 5 product links, byte-identical across two fetches.',
  },
  {
    vendor: 'Cisco', label: 'Cisco switches EoL listing',
    url: 'https://www.cisco.com/c/en/us/products/switches/eos-eol-listing.html',
    signalKind: 'links', hrefPattern: ciscoCategory('switches'), minSignalLines: 1,
    measured: '2026-11-16: HTTP 200, 21.3 KB, 2 product links, stable across two fetches.',
  },
  {
    vendor: 'Cisco', label: 'Cisco wireless EoL listing',
    url: 'https://www.cisco.com/c/en/us/products/wireless/eos-eol-listing.html',
    signalKind: 'links', hrefPattern: ciscoCategory('wireless'), minSignalLines: 1,
    measured: '2026-11-16: HTTP 200, 20.3 KB, 11 product links (10 after the nav-link fix), stable.',
  },
  {
    vendor: 'Cisco', label: 'Cisco routers EoL listing',
    url: 'https://www.cisco.com/c/en/us/products/routers/eos-eol-listing.html',
    signalKind: 'links', hrefPattern: ciscoCategory('routers'), minSignalLines: 1,
    measured: '2026-11-16: HTTP 200, 20.5 KB, 11 product links, stable across two fetches.',
  },
  // ---- Palo Alto: two pages, watched as DATE SETS ----
  {
    vendor: 'Palo Alto', label: 'Palo Alto EoL announcements',
    url: 'https://www.paloaltonetworks.com/services/support/end-of-life-announcements',
    signalKind: 'dates', minSignalLines: 3,
    measured: '2026-11-16: HTTP 200, 163 KB, 13 dated lines, identical signal hash across two fetches.',
  },
  {
    vendor: 'Palo Alto', label: 'Palo Alto hardware EoL dates',
    url: 'https://www.paloaltonetworks.com/services/support/end-of-life-announcements/hardware-end-of-life-dates',
    signalKind: 'dates', minSignalLines: 10,
    measured:
      '2026-11-16: HTTP 200, 180 KB, 45 dated lines (e.g. "April 30, 2014"), identical hash '
      + 'across two fetches. The richest EOL source found in the whole probe.',
  },

  // ---- Meraki: one page, watched as a DATE SET ----
  {
    vendor: 'Cisco Meraki', label: 'Meraki EoL products and dates',
    url: 'https://documentation.meraki.com/General_Administration/Other_Topics/Meraki_End-of-Life_(EOL)_Products_and_Dates',
    signalKind: 'dates', minSignalLines: 5,
    measured: '2026-11-16: HTTP 200, 157 KB, 24 dated lines, identical hash across two fetches.',
  },

  // ---- Palo Alto software lifecycle: SCOPED to the PAN-OS table ----
  // ⛔ THE PAGE IS 90% NOISE FOR THIS PURPOSE. See `scope` above: the content-
  // release table alone changes weekly. Scoped, the signal is the ~26 PAN-OS
  // cycle rows, which change a few times a year — and a change there is exactly
  // the prompt to re-run `npm run build:os-cycles` and read the diff.
  {
    vendor: 'Palo Alto', label: 'PAN-OS branch lifecycle (official)',
    url: PA_EOL_SUMMARY,
    signalKind: 'dates', minSignalLines: 10,
    scope: (html) => {
      const rows = findPanOsTable(html);
      return rows ? rows.map((r) => r.join(' | ')).join('\n') : null;
    },
    measured:
      '2026-11-16: HTTP 200, 251 KB, 556 dated lines UNSCOPED across 22 tables; scoped to the '
      + 'PAN-OS table it is 26 cycle rows. The unscoped page would alert weekly on Applications '
      + '& Threats content releases.',
  },

  // ---- HPE/Aruba via endoflife.ai: the only readable record that exists ----
  // See ARUBA_HPE_BLIND_SPOT below. Change signal only; floor deliberately low.
  {
    vendor: 'HPE Aruba', label: 'Aruba switches lifecycle (endoflife.ai)',
    url: 'https://endoflife.ai/aruba-switches',
    signalKind: 'dates', minSignalLines: 3,
    measured:
      '2026-11-16: HTTP 200, 158 KB, 34,103 chars visible text, 9 dated lines, identical '
      + 'signal hash across two fetches. AGGREGATOR — any date taken enters the seed at "low".',
  },
  {
    vendor: 'HPE Aruba', label: 'Aruba gateways/controllers lifecycle (endoflife.ai)',
    url: 'https://endoflife.ai/aruba-gateways',
    signalKind: 'dates', minSignalLines: 3,
    measured: '2026-11-16: HTTP 200, 203 KB, 51,901 chars visible text, 7 dated lines, stable.',
  },
  {
    vendor: 'HPE Aruba', label: 'Aruba access points lifecycle (endoflife.ai)',
    url: 'https://endoflife.ai/aruba-access-points',
    signalKind: 'dates', minSignalLines: 3,
    measured: '2026-11-16: HTTP 200, 373 KB, 7 dated lines, stable. Tracks 366 release lines.',
  },
];

/**
 * ⛔ CISCO interfaces-modules WAS ADMITTED AND THEN REMOVED BY ITS OWN TEST.
 *
 * `/c/en/us/products/interfaces-modules/eos-eol-listing.html` **no longer
 * exists**. It answers HTTP 200 with 201 KB after silently redirecting to
 * `https://www.cisco.com/site/us/en/products/index.html` — Cisco's generic
 * products landing page. Zero product links, zero dates, 151 hrefs of pure site
 * navigation.
 *
 * ⛔ AND THE FIRST PROBE OF IT REPORTED "STABLE, 16 LINKS". That measurement was
 * real and completely wrong: a loose href pattern was counting the landing
 * page's own navigation, and it was stable because site furniture is stable.
 * The source looked healthiest precisely when it was reading nothing — which is
 * why the live check in scripts/verify-eol-watch.ts asserts a floor against the
 * REAL url rather than trusting the admission measurement. That assertion is
 * what removed this entry.
 */
export const CISCO_INTERFACES_MODULES_REMOVED =
  'cisco interfaces-modules eos-eol-listing redirects to the generic products landing page '
  + '(measured 2026-11-16: 200, 201 KB, 0 product links, final URL /site/us/en/products/index.html).';

/**
 * ⛔ THE REFUSALS ARE THE MORE IMPORTANT HALF OF THIS FILE.
 *
 * Ten sources were admitted out of nineteen URLs probed (seven official, three aggregator). Every rejection below
 * is recorded with what was actually measured, so the next session does not
 * rediscover a URL, see HTTP 200, and conclude it works. ⛔ FIVE OF THESE
 * REFUSALS ANSWER HTTP 200.
 *
 * SonicWall — https://www.sonicwall.com/support/product-lifecycle-tables
 *   HTTP **200**, 1,159 bytes, body: "Request unsuccessful. Incapsula incident
 *   ID: 373000500016861373-1500021647543469". A WAF denial wearing a 200. This
 *   is the single best specimen of the rule and is why looksBlocked() exists.
 *
 * Juniper — /support/eol/hardware/ and /support/eol/software/
 *   HTTP 200, 58 KB and 80 KB, but 120 characters of visible text — and that
 *   text is a survey pop-up ("Do you have time for a two-minute survey?"). The
 *   listing is rendered client-side. A server-side fetch gets the shell.
 *
 * Check Point — https://support.checkpoint.com/results/sk/sk95746
 *   HTTP 200, 29 KB, 157 characters of visible text: a copyright footer. Also
 *   client-rendered. ⛔ Note this is a DIFFERENT finding from CLAUDE.md's
 *   September PSIRT probe, which found advisories.checkpoint.com serving plain
 *   HTML. Both are true: the advisory site renders, the SK knowledge base does
 *   not.
 *
 * Fortinet — support.fortinet.com/Information/ProductLifeCycle.aspx
 *   HTTP 200, 9.9 KB, **zero** characters of visible text. A pure JS shell.
 *   fortinet.com/support/support-services/product-life-cycle now answers 404.
 *
 * Netgear — kb.netgear.com/000062646/NETGEAR-End-of-Life-Products
 *   ⛔ THE MOST DANGEROUS ONE. HTTP 200, 127 KB, 7,775 characters of real,
 *   well-formed prose, stable across two fetches — and the document is a
 *   **security advisory for multiple HTTPd authentication vulnerabilities on
 *   DGN2200v1**, not an EOL list. The KB id routes; the URL slug is decorative.
 *   A watcher would have hashed a PSIRT bulletin forever and reported it as
 *   Netgear's lifecycle page. netgear.com/system/legacy-products/ and
 *   /support/product-lifecycle/ both 404. This is consistent with Netgear
 *   publishing its EOL list as a PDF, which is how this repo received it.
 *
 * HPE / Aruba — arubanetworks.com/support-services/end-of-life/
 *   HTTP 503 with a dated notice in the body: "Site is no longer available.
 *   Starting Feb 23, 2026, the redirection has been discontinued from the old
 *   ASP URL." The successor, networkingsupport.hpe.com/endoflife, answers 200
 *   with 13 KB and NINE characters of visible text. support.hpe.com's docDisplay
 *   returns 200 with zero visible text.
 *
 * Ubiquiti — help.ui.com — HTTP 403 to a server-side fetch.
 * TP-Link — /us/support/end-of-life/ and /end-of-life-devices/ — HTTP 404.
 * D-Link — dlink.com/en/end-of-life — HTTP 404.
 * Ruckus — support.ruckuswireless.com/product_families — 200 with a Cloudflare
 *   JavaScript challenge, the shape CLAUDE.md already refused for fortiguard.
 */
export const EOL_SOURCES_REFUSED =
  'SonicWall (Incapsula denial served as HTTP 200), Juniper/CheckPoint/Fortinet/HPE-Aruba '
  + '(client-rendered shells), Netgear KB (200 serving a PSIRT advisory, not an EOL list), '
  + 'Ubiquiti (403), TP-Link/D-Link (404), Ruckus (Cloudflare challenge). Measured 2026-11-16.';

/**
 * ⛔ AGGREGATORS ARE NO LONGER REFUSED — THE RULE CHANGED ON 2026-11-16.
 *
 * CLAUDE.md's "THE SOURCING RULE" now reads: official sources only for `high`
 * and `medium`; **aggregators permitted at `low`, always labelled**. The change
 * was made because the old official-only rule was being quoted to refuse new
 * sources while 22.4% of the shipped corpus was already aggregator-sourced.
 * `lib/eol/source-policy.ts` is the enforceable version; `npm run verify:seed`
 * runs it over all 7,902 entries.
 *
 * ⛔ WHAT THAT DOES **NOT** CHANGE: an aggregator still has to be READABLE to be
 * watched. Admission here is a measurement, not a policy question, and the
 * measurement is unchanged — see ARUBA_HPE_BLIND_SPOT below for the one that
 * passed and why it only half-passes.
 */
export const EOL_AGGREGATORS_PERMITTED_AT_LOW =
  'Aggregators (endoflife.date, endoflife.ai, Park Place, Layer23, router-switch, Service '
  + 'Express) are permitted as SEED sources at confidence "low", always labelled. See '
  + 'lib/eol/source-policy.ts — the rule is executable, not prose.';

/**
 * ⛔ HPE/ARUBA IS THE ONE VENDOR WE ARE GENUINELY BLIND ON, and these three
 * pages are the only readable record that exists.
 *
 * ~2,100 Aruba + HPE models are carried in the seed. The official listing is
 * gone (503, "Site is no longer available ... Feb 23, 2026") and its successor
 * is a 13 KB page containing NINE characters of visible text. So for this vendor
 * the choice is not "aggregator or official" — it is "aggregator or nothing".
 *
 * ⛔ AND THEY ARE ADMITTED AS A CHANGE SIGNAL ONLY, NOT AS A DATA SOURCE.
 * Measured 2026-11-16: each page is stable across two fetches, but yields only
 * **7-9 dated lines** server-side while advertising "366 release lines tracked"
 * — the per-model table is client-rendered, exactly like the vendor pages this
 * file already refuses. What DOES reach a server fetch is the summary: "The next
 * HPE Aruba Networking access points support end date is December 31, 2026, when
 * version JW177A ... reaches end of life." When that sentence changes, something
 * in Aruba's lifecycle moved and a human should go and look. That is worth
 * having and it is all that is being claimed.
 *
 * ⛔ DO NOT RAISE minSignalLines HERE TO "GET MORE COVERAGE". The floor is 3
 * against a measured 7-9. Setting it near the measurement would turn a vendor
 * reformatting one summary line into a failed source.
 */
export const ARUBA_HPE_BLIND_SPOT =
  'endoflife.ai Aruba pages are watched as a CHANGE SIGNAL only (7-9 server-readable dated '
  + 'lines vs "366 release lines tracked"); the per-model table is client-rendered. Any date '
  + 'taken from them enters the seed at confidence "low".';
