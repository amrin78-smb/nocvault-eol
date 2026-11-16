// lib/eol/os-sources.ts
//
// Where the OS-branch lifecycle corpus comes from, and how each source is
// located inside its page — ONE definition, shared by the generator and the
// verifier.
//
// ⛔ THIS FILE EXISTS BECAUSE THE TWO COPIES DRIFTED IMMEDIATELY. The PAN-OS
// table locator was written once in scripts/build-os-cycles.ts and once in
// scripts/verify-os-cycles.ts. The first run failed, the locator was fixed in
// the generator only, and the verifier then reported "the PAN-OS table is no
// longer identifiable" against a page that had not changed at all. A check that
// re-implements the thing it is checking is not a check — it is a second thing
// to keep in step. Same call SecVault's feedStatus.js makes: "ONE OPINION ONLY."
//
// ⛔ EVERY SOURCE RECORDS WHAT IT RETURNED WHEN MEASURED, as vendor-cpes.ts does
// for CPE strings and rss-sources.ts for feeds.

export const PA_EOL_SUMMARY =
  'https://www.paloaltonetworks.com/services/support/end-of-life-announcements/end-of-life-summary';

/**
 * ⛔ THE ONE OFFICIAL, SERVER-READABLE OS LIFECYCLE SOURCE FOUND ANYWHERE.
 *
 * Probed 2026-11-16 across Palo Alto, Fortinet, Juniper, Aruba/HPE, SonicWall
 * and Check Point. Every other vendor's software-lifecycle page is a
 * client-rendered shell, a WAF denial or a 404 — the same picture as their
 * hardware pages:
 *   - Fortinet support.fortinet.com/Information/ProductLifeCycle.aspx: 200, ZERO
 *     visible text. fortinet.com/support/support-services/product-life-cycle: 404.
 *   - Juniper /support/eol/software/junos/: 200, 86 KB, 120 chars of visible text.
 *   - Aruba: 503, redirects to asp.arubanetworks.com/end-of-life (retired).
 *   - SonicWall: 200 carrying an Incapsula WAF denial.
 *   - Check Point sk95746: 200, 157 chars (a footer).
 * So PAN-OS is `high` and everything else in this corpus is `low` from
 * endoflife.date. That asymmetry is a measurement, not a preference.
 */
export const PA_SUMMARY_MEASURED =
  '2026-11-16: HTTP 200, 251 KB, 30,134 chars visible text, 556 dated lines, 22 tables. '
  + 'The PAN-OS table is the 4th and holds 26 cycles. All 25 cycles shared with '
  + 'endoflife.date agreed exactly after the UTC parsing fix.';

export type EodProduct = {
  /** endoflife.date product slug. */
  slug: string;
  vendor: string;
  product: string;
  measured: string;
};

/**
 * ⛔ THREE PRODUCTS, OUT OF 489 ON endoflife.date, AND THAT IS THE HONEST
 * CEILING OF THIS SOURCE. Filtering the full index for every network vendor this
 * suite touches returned six slugs, of which three are relevant here
 * (`big-ip` and `opnsense` are out of scope, `citrix-vad` is not networking).
 * ⛔ There is NO Junos, NO Aruba AOS/AOS-CX, NO SonicOS, NO Check Point Gaia and
 * NO Meraki. Do not go looking again without re-reading this: the gap is in the
 * source, not in the query.
 */
export const EOD_PRODUCTS: EodProduct[] = [
  {
    slug: 'fortios', vendor: 'Fortinet', product: 'FortiOS',
    measured: '2026-11-16: HTTP 200, 8 cycles, fields {cycle, releaseDate, eol, support, lts}. '
      + 'No `link` field, so these rows carry no promotion path.',
  },
  {
    slug: 'cisco-ios-xe', vendor: 'Cisco', product: 'Cisco IOS-XE',
    measured: '2026-11-16: HTTP 200, 20 cycles, fields {cycle, lts, releaseDate, eol, link, support}. '
      + '`eol` is boolean false on still-supported branches — NOT a date.',
  },
  {
    slug: 'panos', vendor: 'Palo Alto', product: 'PAN-OS',
    measured: '2026-11-16: HTTP 200, 26 cycles. Fetched ONLY to cross-check the official table; '
      + 'official rows win outright and only cycles the official table omits are kept.',
  },
];

/** Every `<table>` on the page, as arrays of trimmed cell text. */
export function parseTables(html: string): string[][][] {
  return [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) =>
    [...m[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
      [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
        c[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
          .replace(/\s+/g, ' ').trim())));
}

/**
 * Locate the PAN-OS lifecycle table by THREE MARKERS IN ITS OWN ROWS.
 *
 * ⛔ NOT BY POSITION, AND NOT BY rows[0]/rows[1]. Measured 2026-11-16: the table
 * is the 4th of 22 on the page, and its first rows are `[""]`,
 * `["PAN-OS & Panorama"]`, then the column header. A positional read would
 * silently return Prisma Access's or QRadar's dates the first time Palo Alto
 * inserts a table above it — and the output would look entirely plausible. A
 * rows[0]/rows[1] header match is what actually broke on the first run, on the
 * leading empty spacer row.
 *
 * The table names itself, so that is what is matched.
 *
 * @returns the table's rows, or null when the page no longer has it.
 */
export function findPanOsTable(html: string): string[][] | null {
  for (const rows of parseTables(html)) {
    const flat = rows.map((r) => r.join('|').toLowerCase());
    const titled = flat.some((r) => /^pan-os\b/.test(r.trim()));
    const headed = flat.some((r) => r.includes('version') && r.includes('end-of-life'));
    const tiered = flat.some((r) => r.includes('standard support') && r.includes('extended support'));
    if (titled && headed && tiered) return rows;
  }
  return null;
}

export const PAN_OS_TABLE_MARKERS =
  'a title row starting "PAN-OS", a column header with "Version" + "End-of-Life", '
  + 'and a tier row with "Standard Support" + "Extended Support"';

/**
 * ⛔ THE COLUMN LAYOUT HAS AN EMPTY SPACER AT INDEX 3.
 * A data row is `[version, release, standard-support, "", extended-support]`.
 * Reading index 3 as extended support yields "" -> null, silently dropping every
 * extended-support date; reading the columns in the other order tells a customer
 * their branch dies months before it does. `checkCycle`'s "extended precedes
 * standard" guard is the backstop for the second mistake.
 */
export const PAN_OS_COLUMNS = { version: 0, release: 1, standard: 2, extended: 4 } as const;
