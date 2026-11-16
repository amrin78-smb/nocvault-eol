// lib/oui/parse.ts
//
// Parsing the IEEE registry CSVs, and the MAC -> vendor matching contract.
//
// ⛔ PURE. NO I/O, NO CLOCK, NO DB — so every rule below is forceable from a
// string literal, which is what lets scripts/verify-oui.ts prove them.

import { PRIVATE_ORG, type OuiRegistry } from './sources';

export type OuiAssignment = {
  /** Uppercase hex, no separators. 6, 7 or 9 characters. */
  prefix: string;
  /** 24, 28 or 36. Stored because the lookup is longest-prefix-first. */
  prefix_bits: number;
  registry: OuiRegistry;
  org: string;
  /**
   * ⛔ TRUE WHEN THE BLOCK IS HELD BY IEEE ITSELF. 442 MA-L blocks are
   * registered to "IEEE Registration Authority" because they have been
   * subdivided into MA-M/MA-S assignments — 13,841 of them. Returning that
   * string as a DEVICE VENDOR is wrong, and wrong in the worst way: it looks
   * like an answer. The flag exists so a consumer can render "unknown vendor"
   * rather than a registry's name.
   */
  is_registry_block: boolean;
};

/**
 * ⛔ A REAL CSV PARSER, NOT `line.split(',')`.
 *
 * The IEEE files quote any field containing a comma, and organisation names and
 * addresses are full of them — "Cisco Systems, Inc", "Hewlett Packard
 * Enterprise, Ltd". Splitting on commas shifts every subsequent column for
 * exactly those rows, so the org name becomes a fragment and the address
 * becomes the org. It fails on the most common vendors first and silently.
 * Doubled quotes (`""`) are an escaped quote inside a quoted field.
 */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Strip separators and upper-case. "00:1b:17" / "001B.17" -> "001B17". */
export function normalizePrefix(raw: string): string {
  return (raw || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

const BITS_BY_CHARS: Record<number, number> = { 6: 24, 7: 28, 9: 36 };

export type ParseResult = {
  assignments: OuiAssignment[];
  /** Rows the parser refused, with why. Non-empty is not fatal; large is. */
  skipped: Array<{ line: string; reason: string }>;
};

/**
 * Parse one IEEE registry CSV.
 *
 * ⛔ A ROW WHOSE PREFIX IS THE WRONG LENGTH IS SKIPPED, NOT COERCED. The
 * registry is the thing defining what a valid assignment looks like; a row that
 * does not match the shape this registry is documented to have means the file
 * is not what we think it is, and guessing would put a wrong-length prefix into
 * a lookup table that is matched by length.
 */
export function parseRegistryCsv(text: string, registry: OuiRegistry, expectChars: number): ParseResult {
  const assignments: OuiAssignment[] = [];
  const skipped: Array<{ line: string; reason: string }> = [];
  const lines = text.split(/\r?\n/);

  // The header names the columns; if it does not, this is not the file we think.
  const header = (lines[0] || '').toLowerCase();
  if (!header.includes('assignment') || !header.includes('organization name')) {
    return {
      assignments: [],
      skipped: [{ line: lines[0] || '(empty)', reason: 'header does not name Assignment / Organization Name' }],
    };
  }

  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    if (f.length < 3) { skipped.push({ line: line.slice(0, 80), reason: 'fewer than 3 fields' }); continue; }

    const prefix = normalizePrefix(f[1]);
    if (prefix.length !== expectChars) {
      skipped.push({ line: line.slice(0, 80), reason: `prefix "${f[1]}" is ${prefix.length} hex chars, expected ${expectChars}` });
      continue;
    }
    // ⛔ FIRST ASSIGNMENT WINS, and duplicates are counted rather than silently
    // overwriting. A registry that starts shipping the same prefix twice with
    // different organisations is a fact worth seeing, not a last-write-wins race.
    if (seen.has(prefix)) { skipped.push({ line: line.slice(0, 80), reason: 'duplicate prefix' }); continue; }
    seen.add(prefix);

    const org = (f[2] || '').trim();
    assignments.push({
      prefix,
      prefix_bits: BITS_BY_CHARS[expectChars],
      registry,
      // ⛔ AN EMPTY ORG IS RECORDED AS "Private", MATCHING THE REGISTRY'S OWN
      // CONVENTION, never as an empty string that a consumer renders as a blank
      // vendor label.
      org: org || PRIVATE_ORG,
      is_registry_block: /^IEEE Registration Authority$/i.test(org),
    });
  }
  return { assignments, skipped };
}

// ---------------------------------------------------------------------------
// The matching contract
// ---------------------------------------------------------------------------

/**
 * ⛔ A MATCHING CONTRACT, LIKE `normalizeForMatch` AND `branchOf`. It lives on
 * BOTH sides: the hub builds the table and the consumer does the lookup. If the
 * two disagree about normalisation or about prefix precedence, lookups miss
 * silently or — worse — return the registry's own name as a vendor. Bump
 * OUI_MATCH_VERSION on any behavioural change and tell the consumers.
 */
export const OUI_MATCH_VERSION = 1;

/** Longest first: a 36-bit assignment must beat the 24-bit block containing it. */
export const PREFIX_CHARS_LONGEST_FIRST = [9, 7, 6] as const;

export type OuiLookup = {
  prefix: string;
  prefix_bits: number;
  org: string;
  registry: OuiRegistry;
  is_registry_block: boolean;
};

/**
 * Resolve a MAC address to its assignment.
 *
 * ⛔ LONGEST PREFIX WINS, AND THAT IS THE WHOLE POINT. 13,841 MA-M/MA-S
 * assignments sit inside MA-L blocks held by IEEE itself. Checking 24 bits
 * first would resolve every one of them to "IEEE Registration Authority" — a
 * confident wrong answer, which is strictly worse than no answer.
 *
 * @param mac any common form: "00:1b:17:00:00:01", "001b.1700.0001", "001B17000001"
 * @param table prefix (uppercase hex, no separators) -> assignment
 */
export function lookupMac(
  mac: string,
  table: Map<string, OuiLookup>
): OuiLookup | null {
  const hex = normalizePrefix(mac);
  // ⛔ A SHORT STRING IS NOT A MAC. Accepting one would let "001B17" — which is
  // a PREFIX, not an address — resolve as though a device had been identified.
  if (hex.length < 12) return null;
  for (const n of PREFIX_CHARS_LONGEST_FIRST) {
    const hit = table.get(hex.slice(0, n));
    if (hit) return hit;
  }
  return null;
}

/** Build the lookup table from a flat list. */
export function buildLookupTable(rows: OuiLookup[]): Map<string, OuiLookup> {
  const m = new Map<string, OuiLookup>();
  for (const r of rows) m.set(r.prefix, r);
  return m;
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

/**
 * ⛔ SPOT CHECKS WITH KNOWN-GOOD ANSWERS, because "we parsed 54,000 rows" does
 * not prove we parsed them CORRECTLY. These six are stable, independently
 * verifiable assignments; four are vendors this suite actually manages. If the
 * CSV column order changes, or the quote handling breaks, the counts stay
 * plausible and these fail — which is the only cheap way to tell a good parse
 * from a confident bad one.
 */
export const SPOT_CHECKS: Array<{ mac: string; expect: RegExp; note: string }> = [
  { mac: '00000C0102030', expect: /^Cisco Systems/i, note: 'Cisco MA-L' },
  { mac: '00090F010203AA', expect: /^Fortinet/i, note: 'Fortinet MA-L' },
  { mac: '001B17010203AA', expect: /^Palo Alto/i, note: 'Palo Alto MA-L' },
  { mac: '000D93010203AA', expect: /^Apple/i, note: 'Apple MA-L' },
  { mac: 'B827EB010203AA', expect: /Raspberry Pi/i, note: 'Raspberry Pi MA-L' },
  { mac: '0050C2000003AA', expect: /./, note: 'IEEE MA-S parent block resolves to something' },
];

export type AdmissionResult = { ok: boolean; reasons: string[] };

/**
 * Is this freshly parsed catalogue fit to replace the one we have?
 *
 * ⛔ A CATALOGUE THAT FAILS ADMISSION MUST NOT REPLACE A GOOD ONE. This is the
 * repo's standing rule — a failed read is never recorded as a fact — applied to
 * a dataset instead of a page. A truncated download, a moved file or an HTML
 * error page all parse to "fewer rows than expected", and overwriting 54,000
 * good assignments with 11 is a silent, total loss of a feature in three apps.
 */
export function admit(
  perRegistry: Array<{ registry: OuiRegistry; rows: number; minRows: number }>,
  table: Map<string, OuiLookup>
): AdmissionResult {
  const reasons: string[] = [];

  for (const r of perRegistry) {
    if (r.rows < r.minRows) {
      reasons.push(`${r.registry}: ${r.rows} assignments is below the floor of ${r.minRows}`);
    }
  }
  // ⛔ ALL THREE REGISTRIES OR NONE. Publishing MA-L alone would silently
  // reintroduce the exact 13,841-row misattribution this module exists to stop.
  const present = new Set(perRegistry.filter((r) => r.rows > 0).map((r) => r.registry));
  for (const need of ['MA-L', 'MA-M', 'MA-S'] as const) {
    if (!present.has(need)) reasons.push(`${need} is missing entirely`);
  }

  for (const s of SPOT_CHECKS) {
    const hit = lookupMac(s.mac, table);
    if (!hit) { reasons.push(`spot check failed: ${s.note} (${s.mac}) resolved to nothing`); continue; }
    if (!s.expect.test(hit.org)) {
      reasons.push(`spot check failed: ${s.note} resolved to "${hit.org}"`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}
