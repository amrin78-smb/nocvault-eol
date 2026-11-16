// lib/eol/signal.ts
//
// Reduce a vendor EOL page to the SET OF LIFECYCLE STATEMENTS it publishes, so
// two fetches can be compared for meaning rather than for bytes.
//
// ⛔ HASHING THE PAGE DOES NOT WORK AND THAT IS WHY THIS FILE EXISTS. A raw body
// hash changes on nonces, build ids, rotating banners and session tokens, so a
// detector built on it alerts every single day. CLAUDE.md already records the
// cost of that shape for CVE: "an alert that fires on them trains the operator
// to filter the channel — at which point the next real alert is silent again."
// So the page is reduced to the statements a human would actually re-review, and
// only those are hashed.
//
// ⛔ PURE FUNCTIONS, NO I/O, NO CLOCK, NO DB. Every refusal rule below is
// forceable from a string literal, which is what lets scripts/verify-eol-watch.ts
// prove each one instead of reading it.

import { createHash } from 'crypto';

/**
 * What kind of statement a given source publishes.
 *
 * ⛔ TWO KINDS, BECAUSE THE VENDORS GENUINELY DIFFER AND ONE EXTRACTOR CANNOT
 * COVER BOTH. Measured 2026-11-16:
 *   - Palo Alto and Meraki publish DATES in the page (13, 45 and 24 dated lines).
 *   - Cisco's category listings publish NO dates at all. They are an index: the
 *     dates live in per-product bulletins behind each link. Their watchable
 *     signal is therefore the LINK SET — "Cisco added Catalyst 9200 to the
 *     switches EoL listing" is exactly the review prompt wanted, and it is
 *     invisible to a date extractor.
 */
export type SignalKind = 'dates' | 'links';

/**
 * ⛔ FOUR DATE SHAPES, BECAUSE VENDORS USE FOUR. Palo Alto's hardware table is
 * "April 30, 2014"; its announcements page mixes "31 December 2022" into prose;
 * ISO appears in Netgear-style bulletins. A single ISO-only pattern scored zero
 * on every page actually measured.
 */
const DATE_PATTERNS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}[-/ ](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-/ ]\d{2,4}\b/i,
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/i,
  /\b\d{1,2}\/\d{1,2}\/\d{4}\b/,
  /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i,
];

export function hasDate(line: string): boolean {
  return DATE_PATTERNS.some((re) => re.test(line));
}

/** Tags that end a visible line. Table rows and list items become lines. */
const BLOCK_TAGS =
  /<\/?(?:tr|td|th|li|p|div|br|h[1-6]|section|article|table|tbody|thead|option|dt|dd)\b[^>]*>/gi;

/** Elements whose CONTENT is never visible text — and is pure noise if included. */
const INVISIBLE_ELEMENTS = /<(script|style|noscript|svg|head|template)\b[^>]*>[\s\S]*?<\/\1>/gi;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&ndash;|&mdash;/gi, '-')
    .replace(/&#\d+;/g, ' ');
}

/** The page's visible text, with block structure preserved as newlines. */
export function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(INVISIBLE_ELEMENTS, ' ')
      .replace(BLOCK_TAGS, '\n')
      .replace(/<[^>]+>/g, ' ')
  );
}

/** Longest line we will keep. Beyond this it is prose, not a lifecycle row. */
const MAX_LINE = 400;
const MIN_LINE = 4;

/**
 * Every distinct date-bearing line, normalised and SORTED.
 *
 * ⛔ SORTED AND DEDUPED ON PURPOSE: the signal is the SET of published lifecycle
 * statements, not their order. A vendor re-ordering a table, or rendering it
 * through a different template, is not a date change and must not raise a review
 * item — the operator's time is the scarce resource this feature spends.
 */
export function extractDateSignal(html: string): string[] {
  const lines = visibleText(html)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= MIN_LINE && l.length <= MAX_LINE && hasDate(l));
  return [...new Set(lines)].sort();
}

/**
 * Every distinct `text :: href` pair whose href matches `hrefPattern`, SORTED.
 *
 * ⛔ THE PATTERN IS THE WHOLE POINT AND A LOOSE ONE SILENTLY POISONS THE SIGNAL.
 * Measured on cisco/interfaces-modules 2026-11-16: a pattern of merely
 * `/products/<something>/<something>/index.html` also matched the page-furniture
 * link `Choose your firewall :: /site/us/en/products/security/firewalls/index.html`.
 * Site navigation changes far more often than an EoL listing does, so including
 * one nav link converts this detector into a generator of false review items.
 * Each source therefore anchors its pattern to its own category path.
 */
export function extractLinkSignal(html: string, hrefPattern: RegExp): string[] {
  const out = new Set<string>();
  const anchors = html.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
  for (const m of anchors) {
    const href = m[1];
    if (!hrefPattern.test(href)) continue;
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length < 2 || text.length > MAX_LINE) continue;
    out.add(`${text} :: ${href}`);
  }
  return [...out].sort();
}

export function extractSignal(html: string, kind: SignalKind, hrefPattern?: RegExp): string[] {
  if (kind === 'links') {
    if (!hrefPattern) {
      // ⛔ NOT A SILENT EMPTY SET. An empty set is this module's signal for "the
      // read failed", and a misconfigured source must not be able to borrow that
      // meaning — it would then be reported as an unreadable vendor page rather
      // than as the configuration error it is.
      throw new Error('extractSignal: kind "links" requires an hrefPattern');
    }
    return extractLinkSignal(html, hrefPattern);
  }
  return extractDateSignal(html);
}

/** Stable digest of a signal set. Order-independent because the set is sorted. */
export function hashSignal(lines: string[]): string {
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

/**
 * ⛔ A 200 IS NOT A READ. Markers of a body that is a denial or a challenge
 * rather than the document asked for.
 *
 * Each pattern below was MEASURED on a real vendor URL on 2026-11-16, not
 * imagined:
 *   - SonicWall's product-lifecycle-tables answers **HTTP 200** with 1,159 bytes
 *     reading "Request unsuccessful. Incapsula incident ID: 373000500016861373".
 *     Status 200, Content-Type html, zero lifecycle content. Without this check
 *     it would have been watched forever on a hash of nothing.
 *   - Ruckus's product_families answers 200 with a Cloudflare challenge, the same
 *     shape CLAUDE.md already records for fortiguard.com/psirt/<id>.
 */
const BLOCK_MARKERS: Array<[RegExp, string]> = [
  [/Request unsuccessful\.\s*Incapsula incident ID/i, 'Incapsula/Imperva WAF denial served as HTTP 200'],
  [/Incapsula incident ID/i, 'Incapsula/Imperva WAF denial'],
  [/Just a moment\.\.\./i, 'Cloudflare JavaScript challenge'],
  [/cf-browser-verification|challenge-platform|_cf_chl_/i, 'Cloudflare JavaScript challenge'],
  [/Attention Required!\s*\|\s*Cloudflare/i, 'Cloudflare block page'],
  [/Access Denied[\s\S]{0,200}(?:akamai|reference\s*#)/i, 'Akamai/CDN access denial'],
  [/<title>\s*403\s*Forbidden\s*<\/title>/i, '403 body served with a 200 status'],
];

/** The reason this body is a denial rather than a document, or null. */
export function looksBlocked(html: string): string | null {
  // Only the head of the document: a word like "Access Denied" deep inside a
  // legitimate 180 KB advisory table is content, not a verdict.
  const head = html.slice(0, 8000);
  for (const [re, reason] of BLOCK_MARKERS) {
    if (re.test(head)) return reason;
  }
  return null;
}

export type SignalDiff = {
  added: string[];
  removed: string[];
};

/** What changed between two signal sets. */
export function diffSignal(before: string[], after: string[]): SignalDiff {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: after.filter((x) => !b.has(x)),
    removed: before.filter((x) => !a.has(x)),
  };
}
