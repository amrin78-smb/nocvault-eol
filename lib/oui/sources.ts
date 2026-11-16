// lib/oui/sources.ts
//
// The IEEE MAC address block registries — where the OUI catalogue comes from.
//
// ⛔ WHY THIS BELONGS ON THE HUB. DDIVault keeps its own `data/oui.json`,
// rebuilt by a human running `node scripts/update-oui.js`. Measured 2026-11-16:
// 39,267 entries, 2.4 MB, LAST UPDATED 2026-06-05 — over five months stale,
// because refreshing it depends on somebody remembering. NetVault and LogVault
// have no MAC-vendor resolution at all. One curated, signed, versioned feed
// replaces a hand-maintained file in one app and a gap in two others.
//
// ⛔ THREE REGISTRIES, NOT ONE, AND THAT IS A CORRECTNESS REQUIREMENT.
// IEEE assigns blocks at three prefix lengths:
//   MA-L  24 bits (6 hex)  40,500 assignments
//   MA-M  28 bits (7 hex)   6,688
//   MA-S  36 bits (9 hex)   7,281
// Measured 2026-11-16: **442 MA-L blocks are held by "IEEE Registration
// Authority" itself**, and **13,841 MA-M/MA-S assignments sit underneath them**.
// A 24-bit-only lookup therefore reports 13,841 real vendor assignments as
// "IEEE Registration Authority" — not an "unknown", a CONFIDENT WRONG ANSWER,
// which is this repo's most-repeated failure mode. Longest prefix must win.

export type OuiRegistry = 'MA-L' | 'MA-M' | 'MA-S';

export type OuiSource = {
  registry: OuiRegistry;
  url: string;
  /** Hex characters in an assignment from this registry. */
  prefixChars: number;
  /** Floor for the admission check — well under the measured count. */
  minRows: number;
  measured: string;
};

/**
 * ⛔ IEEE DIRECTLY, NOT WIRESHARK — AND THE RECORDED REASON FOR PREFERRING
 * WIRESHARK WAS STALE.
 *
 * DDIVault's update-oui.js says IEEE "actively blocks scripted clients
 * (HTTP 418)" and uses Wireshark's republished `manuf` as its primary source.
 * Probed from this machine 2026-11-16: **all three IEEE CSVs answer HTTP 200**.
 * Whatever was true when that note was written is not true here.
 *
 * It matters under this repo's own sourcing rule (CLAUDE.md, "THE SOURCING
 * RULE"): IEEE is the **registrar** — official, `high`. Wireshark is a
 * republisher — an aggregator, capped at `low`. Taking the aggregator when the
 * official source answers would be choosing second-hand data for no reason.
 *
 * ⛔ A STALE REASON SENDS THE NEXT SESSION HUNTING A WORKAROUND FOR A PROBLEM
 * THAT NO LONGER EXISTS — the same lesson CLAUDE.md already records for Check
 * Point's "202 bot challenge".
 */
export const OUI_SOURCES: OuiSource[] = [
  {
    registry: 'MA-L', url: 'https://standards-oui.ieee.org/oui/oui.csv',
    prefixChars: 6, minRows: 30000,
    measured: '2026-11-16: HTTP 200, 3.87 MB, 40,500 assignments. 442 of them are held by '
      + '"IEEE Registration Authority" itself and must never win over a longer match.',
  },
  {
    registry: 'MA-M', url: 'https://standards-oui.ieee.org/oui28/mam.csv',
    prefixChars: 7, minRows: 4000,
    measured: '2026-11-16: HTTP 200, 762 KB, 6,688 assignments.',
  },
  {
    registry: 'MA-S', url: 'https://standards-oui.ieee.org/oui36/oui36.csv',
    prefixChars: 9, minRows: 4000,
    measured: '2026-11-16: HTTP 200, 675 KB, 7,281 assignments.',
  },
];

/**
 * ⛔ WIRESHARK IS THE FALLBACK, NOT THE SOURCE, AND IT ENTERS AT `low`.
 * `https://www.wireshark.org/download/automated/data/manuf` answers 200 with
 * 3.18 MB (measured 2026-11-16) and is well maintained, but it is a
 * republication of the IEEE registries with the project's own edits and
 * shortened vendor names. Under the sourcing rule that is an aggregator.
 * Recorded so it is not promoted back to primary on the strength of "DDIVault
 * already uses it".
 */
export const WIRESHARK_MANUF = 'https://www.wireshark.org/download/automated/data/manuf';
export const WIRESHARK_IS_AGGREGATOR =
  'wireshark.org/.../manuf republishes the IEEE registries with its own edits and abbreviated '
  + 'vendor names. Official IEEE answers 200 from the hub, so it is used instead; this remains '
  + 'documented as a low-confidence fallback only.';

/**
 * ⛔ "Private" IS A REAL IEEE VALUE, NOT A MISSING ONE. An assignee may withhold
 * their name, and the registry then records the organisation literally as
 * "Private". That is a DIFFERENT fact from "this prefix is unassigned" and from
 * "we failed to read the registry", and a consumer that renders all three the
 * same way loses the only one of them that is actionable.
 */
export const PRIVATE_ORG = 'Private';
