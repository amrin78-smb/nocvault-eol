// lib/eol/os-cycles.ts
//
// OS / firmware BRANCH lifecycle — the third corpus, beside hardware EOL and CVE.
//
// ⛔ WHY IT IS NOT A COLUMN ON THE HARDWARE ROW. `eol_models.os_eol_date` exists
// and is populated on 34 of 7,902 entries (0.4%), and it could never have been
// filled properly, because OS support is not a property of a MODEL. One
// FortiGate runs FortiOS 6.4, 7.0, 7.2 or 7.4, each with its own dates; one
// column on the hardware row cannot hold four answers. So branches are their own
// corpus, keyed (vendor, product, cycle).
//
// ⛔ WHY IT MATTERS MORE THAN HARDWARE EOL. SecVault already knows every
// device's RUNNING VERSION and matches CVEs against it. Today it can say "this
// firewall is vulnerable to CVE-X". With branch lifecycle it can say "...and it
// runs PAN-OS 10.0, which left support in 2022, so no fix will ever ship and the
// only remediation is an upgrade." A hardware EOL date cannot make that
// statement: a chassis supported until 2029 running a branch that died in 2022
// is unpatchable today, and nothing in the suite can currently see it.
//
// ⛔ THIS IS NOT THE SCRAPER THIS REPO DELETED, AND THE DIFFERENCE IS THE POINT.
// CLAUDE.md records that the per-vendor HTML/regex scrapers were removed, and
// lib/eol/watch.ts refuses to parse dates for exactly that reason. The
// difference is WHERE THE OUTPUT LANDS and WHO REVIEWS IT:
//   - refused: a SCHEDULED job that parses pages and writes dates into the live
//     feed with no human in the loop.
//   - this:    a MANUALLY RUN generator (`npm run build:os-cycles`) whose output
//     is a version-controlled JSON file, reviewed as a git diff like every other
//     seed change, and published only by the same human-pressed button.
// The daily watch (lib/eol/watch.ts) monitors these same source pages and raises
// a review item when they change, which is the signal to re-run the generator.
// ⛔ DO NOT WIRE THE GENERATOR TO A SCHEDULE. That single change converts this
// file into the thing the repo already deleted once.

import { classifySource, maxConfidenceFor, type Confidence } from './source-policy';

export type OsCycle = {
  /** Display vendor, matching the hardware seed's spelling where they overlap. */
  vendor: string;
  /** The OS product, e.g. "PAN-OS", "FortiOS", "Cisco IOS-XE". */
  product: string;
  /** The branch, e.g. "11.1". NOT a full version. */
  cycle: string;
  /** First general availability, or null. */
  release_date: string | null;
  /**
   * End of STANDARD support for the branch — the date after which no fix ships
   * to a device on this branch without an extended-support contract. This is the
   * field a consumer keys on, and it is the analogue of the hardware seed's
   * `support_end_date`.
   */
  support_end_date: string | null;
  /**
   * ⛔ EXTENDED SUPPORT IS A SEPARATE DATE, NOT A LONGER support_end_date.
   * PAN-OS 10.1 has standard support to 2024-11-30 and extended to 2026-03-30.
   * Collapsing them would tell a customer without an extended contract that
   * their branch is supported for 16 more months than it is. Null means the
   * vendor publishes no extended option for this branch.
   */
  extended_end_date: string | null;
  /** Latest release on the branch, when published. Informational. */
  latest_version: string | null;
  /** Long-term-support branch, when the vendor labels it. Null = not stated. */
  lts: boolean | null;
  confidence: Confidence;
  /** The document this row was read from. Governs `confidence` via source-policy. */
  source: string;
  /**
   * ⛔ THE PROMOTION PATH, AND THE REASON AGGREGATOR ROWS ARE WORTH CARRYING.
   * endoflife.date records carry a `link` to the vendor's own page. Storing it
   * means an aggregator row at `low` can be raised to `high` by one person
   * opening that link and confirming — mechanical, not a re-research. Null when
   * the source is already official.
   */
  vendor_link: string | null;
  note: string;
};

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8,
  oct: 9, nov: 10, dec: 11,
};

/**
 * Parse a vendor-published date into `YYYY-MM-DD`.
 *
 * ⛔ UTC ONLY. NEVER `new Date(string).toISOString()`. That is not a style
 * preference — it is a bug this file exists partly to prevent, and it was caught
 * live on 2026-11-16 while cross-checking Palo Alto's official PAN-OS table
 * against endoflife.date. Every one of 24 cycles appeared to DIFFER by exactly
 * one day. The sources agreed perfectly; the parser was wrong.
 *
 *   `new Date('July 30, 2026')` is LOCAL midnight. This machine is UTC+7, so
 *   `.toISOString()` returned "2026-07-29T17:00:00.000Z" -> "2026-07-29".
 *
 * Every date in the corpus would have been shifted one day earlier, silently,
 * and the only visible symptom was a 24-of-24 "disagreement" that looked like a
 * data-quality problem in the aggregator. ⛔ A support-end date that is one day
 * early is not a rounding error here: it is the difference between "supported"
 * and "unsupported" on exactly the day somebody checks.
 */
export function parseLifecycleDate(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  // Vendors write "Latest", "TBD", "N/A", "Not announced" in date columns.
  if (/^(latest|tbd|n\/?a|none|not announced|unannounced|-)$/i.test(raw)) return null;

  const t = raw
    .replace(/(\d+)(st|nd|rd|th)\b/gi, '$1')   // "30th" -> "30"
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return utc(+m[1], +m[2] - 1, +m[3]);

  m = t.match(/^([A-Za-z]+)\s+(\d{1,2})\s+(\d{4})$/);           // July 30 2026
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) return utc(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);

  m = t.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);           // 30 July 2026
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) return utc(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);

  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);               // 07/30/2026 (US)
  if (m) return utc(+m[3], +m[1] - 1, +m[2]);

  return null;
}

function utc(y: number, monthIndex: number, d: number): string | null {
  if (monthIndex < 0 || monthIndex > 11 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, monthIndex, d));
  // Reject rolled-over dates like 2026-02-31.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== monthIndex || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Reduce a running version to its branch, e.g. "10.1.2-h3" -> "10.1".
 *
 * ⛔ THIS IS A MATCHING CONTRACT, LIKE `normalizeForMatch`, AND IT LIVES ON BOTH
 * SIDES. A consumer holds "PAN-OS 10.1.2" and this corpus holds the branch
 * "10.1"; if the two sides disagree about how to get from one to the other, the
 * lookup silently misses and every device reads as "branch unknown" — the same
 * shape as the normalizer drift CLAUDE.md already warns about between this repo
 * and NetVault. Bump OS_BRANCH_VERSION on any behavioural change.
 *
 * ⛔ TWO COMPONENTS IS THE RULE AND IT IS A MEASUREMENT, NOT A GUESS: PAN-OS
 * (11.1), FortiOS (7.4) and Cisco IOS-XE (17.9) all publish lifecycle at
 * major.minor. Any vendor added later that versions differently needs this
 * revisited, not worked around at the call site.
 */
export const OS_BRANCH_VERSION = 1;

export function branchOf(version: string | null | undefined): string | null {
  if (!version) return null;
  const m = String(version).trim().match(/^v?(\d+)\.(\d+)/);
  if (!m) return null;
  // ⛔ LEADING ZEROS STRIPPED. Cisco writes both "17.9.1" and "17.09.01a" for
  // the same branch; "17.09" and "17.9" must not be two different keys.
  return `${parseInt(m[1], 10)}.${parseInt(m[2], 10)}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type CycleViolation = { cycle: string; reason: string };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Check one cycle row against the shape and the sourcing policy. */
export function checkCycle(c: OsCycle): CycleViolation | null {
  const id = `${c.vendor}/${c.product}/${c.cycle}`;
  if (!c.vendor || !c.product || !c.cycle) return { cycle: id, reason: 'vendor, product and cycle are all required' };
  if (!/^\d+\.\d+/.test(c.cycle)) return { cycle: id, reason: `cycle "${c.cycle}" is not major.minor` };

  for (const [field, v] of [
    ['release_date', c.release_date], ['support_end_date', c.support_end_date],
    ['extended_end_date', c.extended_end_date],
  ] as const) {
    if (v !== null && !ISO.test(v)) return { cycle: id, reason: `${field} must be YYYY-MM-DD or null, got ${JSON.stringify(v)}` };
  }

  // ⛔ A ROW THAT SAYS NOTHING ABOUT SUPPORT IS NOT WORTH CARRYING. The hardware
  // seed's rule is "never add a null-dated row"; the same applies here.
  if (!c.support_end_date && !c.extended_end_date) {
    return { cycle: id, reason: 'neither support_end_date nor extended_end_date — nothing to tell a consumer' };
  }

  // ⛔ EXTENDED SUPPORT CANNOT END BEFORE STANDARD SUPPORT. If it does, the two
  // columns were read in the wrong order — which is the single most likely
  // mistake when a vendor table has an empty spacer column between them, as
  // Palo Alto's does.
  if (c.support_end_date && c.extended_end_date && c.extended_end_date < c.support_end_date) {
    return { cycle: id, reason: `extended_end_date ${c.extended_end_date} precedes support_end_date ${c.support_end_date} — columns likely swapped` };
  }

  if (c.release_date && c.support_end_date && c.support_end_date < c.release_date) {
    return { cycle: id, reason: `support_end_date ${c.support_end_date} precedes release_date ${c.release_date}` };
  }

  // The sourcing rule, reused rather than restated.
  const cls = classifySource(c.source);
  const ceiling = maxConfidenceFor(cls);
  if (ceiling === null) return { cycle: id, reason: `source "${c.source}" is ${cls} — inadmissible at any confidence` };
  const RANK: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };
  if (RANK[c.confidence] > RANK[ceiling]) {
    return { cycle: id, reason: `${cls} source may carry at most "${ceiling}", found "${c.confidence}"` };
  }
  return null;
}

/** Is this branch past standard support as of `asOf` (default: today, UTC)? */
export function branchState(
  c: Pick<OsCycle, 'support_end_date' | 'extended_end_date'>,
  asOf: string = new Date().toISOString().slice(0, 10)
): 'supported' | 'extended_only' | 'eol' | 'unknown' {
  const std = c.support_end_date;
  const ext = c.extended_end_date;
  if (!std && !ext) return 'unknown';
  if (std && asOf <= std) return 'supported';
  // ⛔ PAST STANDARD SUPPORT BUT INSIDE EXTENDED IS ITS OWN STATE. Reporting it
  // as "supported" hides that the customer needs a contract they may not have;
  // reporting it as "eol" is wrong for the customers who do. Four states,
  // never three.
  if (ext && asOf <= ext) return 'extended_only';
  return 'eol';
}
