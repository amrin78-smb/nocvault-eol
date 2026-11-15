// lib/cve/rss-sources.ts
//
// Vendor advisory feeds this service polls to DISCOVER CVE identifiers early.
//
// ⛔ EVERY FEED HERE WAS PROBED LIVE AND WHAT IT RETURNED IS RECORDED BESIDE IT,
// exactly as vendor-cpes.ts records each CPE string's totalResults. Probed
// 2026-11-15 from this machine.
//
// ⛔ RSS CHANGES WHEN WE LOOK. IT NEVER CHANGES WHAT WE ACCEPT.
// A feed yields nothing but CVE identifiers. Each one is then fetched FROM NVD
// and passed through the same lib/cve/extract.ts and the same
// classifyNvdNativeMatchability as the CPE rotation, so a CVE that does not name
// a tracked CPE prefix is recorded as `other_product` and stored nowhere. The
// feeds are a schedule optimisation, not a second source of truth — which is
// what keeps the extractor's "zero divergence against 243 real NVD records"
// claim true for every row in the corpus.
//
// ⛔ WHY NOT PARSE THE ADVISORY PAGE AND SKIP NVD: because the September PSIRT
// probe settled it. `fortiguard.com/psirt/<id>` returns a byte-identical
// 19,751-byte Cloudflare JavaScript challenge from the SecVault server, an
// office connection and a Netlify function alike, and Check Point publishes HTML
// with no machine-readable feed at all. Advisory prose also carries no reliably
// parseable version ranges, which are the only thing a consumer can match on.

export type CveRssSource = {
  vendor: string;
  url: string;
  /** What the live probe returned. Keep updated when re-measured. */
  measured: string;
};

/**
 * ⛔ TWO VENDORS, NOT THREE — FORTINET WAS MEASURED OUT, NOT OVERLOOKED.
 * See FORTINET_REFUSED below before adding it back.
 */
export const CVE_RSS_SOURCES: CveRssSource[] = [
  {
    // ⛔ vendor MUST be a key of VENDOR_CPES: it selects the CPE prefixes the
    // relevance gate uses. Cisco's key is `cisco_asa`, not `cisco`.
    vendor: 'cisco_asa',
    url: 'https://sec.cloudapps.cisco.com/security/center/psirtrss20/CiscoSecurityAdvisory.xml',
    measured:
      '2026-11-15: HTTP 200 application/xml, 145 KB, 50 items, 49 carrying a CVE ID (98%), '
      + '106 distinct IDs. ⛔ COVERS EVERY CISCO PRODUCT, not just ASA — most items will '
      + 'resolve to other_product against our two Cisco CPE strings, and that is CORRECT. '
      + 'The CPE prefixes stay the authority on relevance; see the checkpoint wildcard note '
      + 'in vendor-cpes.ts for why filing a non-firewall CVE against a firewall is refused.',
  },
  {
    vendor: 'paloalto',
    url: 'https://security.paloaltonetworks.com/rss.xml',
    measured:
      '2026-11-15: HTTP 200 application/xml, 8 KB, 25 items, 24 carrying a CVE ID (96%), '
      + '25 distinct IDs, identifier in the item TITLE (e.g. "CVE-2026-0326 PAN-OS: ...").',
  },
];

/**
 * ⛔ FORTINET'S FEED DOES NOT CARRY CVE IDENTIFIERS. MEASURED, NOT ASSUMED.
 *
 * `filestore.fortinet.com/fortiguard/rss/ir.xml` answers 200 with 47 KB and 50
 * items from everywhere — CLAUDE.md's PSIRT probe already recorded it as the one
 * Fortinet URL that is not Cloudflare-fronted — but on 2026-11-15 only **1 of
 * those 50 items carried a CVE ID at all** (2%), and the 10 identifiers found
 * all came from that single item. It is a threat-RESEARCH feed: its titles read
 * "Numeric truncation error", "Node2Shell CVEs". It is not a PSIRT advisory
 * feed.
 *
 * Fortinet's actual advisories are at `fortiguard.com/psirt/<id>`, which is the
 * byte-identical Cloudflare JavaScript challenge the September probe refused —
 * and the feed's own item links point there. So there is no path from this feed
 * to a CVE identifier that does not go through a page no server-side fetch can
 * read.
 *
 * ⛔ DO NOT ADD IT "FOR COVERAGE". A source that yields nothing still costs a
 * poll, a state row and a failure count, and a vendor listed as covered that
 * silently contributes zero is worse than one honestly absent — it is the same
 * defect as a guard that cannot fire. Fortinet keeps its CPE rotation, which
 * works: 279 advisories today.
 */
export const FORTINET_REFUSED =
  'fortiguard ir.xml carries CVE IDs in 2% of items (measured 2026-11-15); it is a threat-'
  + 'research feed, not a PSIRT feed, and the advisory pages it links are Cloudflare-challenged.';

/**
 * ⛔ AGGREGATORS ARE REFUSED, INCLUDING THE CONVENIENT ONE. `endoflife.date`
 * answers 200 with 87 KB of clean JSON and is NOT an official vendor source, so
 * it fails the rule that governs this entire dataset. Recorded here so the next
 * session does not rediscover it and treat "it parses nicely" as qualification.
 */
export const AGGREGATORS_REFUSED =
  'endoflife.date and similar aggregators: not official vendor sources.';
