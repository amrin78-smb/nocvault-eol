// lib/cve/extract.ts
//
// Affected-version extraction from an NVD API 2.0 record.
//
// ⛔ PORTED VERBATIM FROM SecVault's lib/feeds/nvd.js. This is not new logic and
// must not be re-derived. Every branch below was found by a real bug on a real
// fleet, and the comments are the reasons — they are carried across deliberately
// because without them the next person "simplifies" the wildcard branch or the
// pinned-version branch and silently breaks matching for thousands of devices.
//
// ⛔ THE THREE BUGS THIS FILE ALREADY CONTAINS THE FIX FOR:
//   1. A partially-wildcarded version segment ("10.0.*") treated as a pinned
//      version — collapsing a whole branch to one point, so every other build in
//      that branch silently read as NOT AFFECTED.
//   2. A `vulnerable: true` entry with no range fields falling through to
//      {min: null, max: null} — which downstream means "no constraint", so ONE
//      exact-version CVE matched EVERY version of that product, forever.
//   3. versionEndIncluding vs versionEndExcluding reversed — which marks
//      PATCHED devices as vulnerable.
//
// PURE: no database, no network, no clock. That is what makes it portable, and
// what let it be lifted here without dragging the fetch machinery along.

export type AffectedRange = {
  min: string | null;
  max: string | null;
  exclude_fixed: boolean;
  vulnerable: true;
};

type CpeMatch = {
  vulnerable?: boolean;
  criteria?: string;
  versionStartIncluding?: string | null;
  versionEndIncluding?: string | null;
  versionEndExcluding?: string | null;
};
type Node = { cpeMatch?: CpeMatch[] };
type Configuration = { nodes?: Node[] };

/** `cpe:2.3:o:fortinet:fortios:*:*:…` -> `cpe:2.3:o:fortinet:fortios:` */
export function cpePrefixes(cpeStrings: string[]): string[] {
  return cpeStrings.map((s) => s.replace(/(:\*)+$/, ':'));
}

function matchesAnyPrefix(criteria: string | undefined, prefixes: string[]): boolean {
  if (!criteria || typeof criteria !== 'string') return false;
  return prefixes.some((p) => criteria.startsWith(p));
}

/**
 * The version segment of a CPE 2.3 URI (index 5), or null.
 *
 * ⛔ REJECTS ANY SEGMENT CONTAINING '*', not just the bare sentinels.
 * "10.0.*" is a real live value for PAN-OS branch entries. Returned as a pinned
 * version it becomes BOTH min and max, the trailing "*" fails to parse in the
 * consumer's tuple parser and defaults to 0, and the whole branch collapses to
 * the single point [10,0,0] — so a device on 10.0.5 reads as outside the range
 * and is never flagged, for a wildcard that plainly meant "all of 10.0.x".
 */
export function extractVersionFromCriteria(criteria: string | undefined): string | null {
  if (!criteria || typeof criteria !== 'string') return null;
  const parts = criteria.split(':');
  const version = parts[5];
  return version && version !== '*' && version !== '-' && !version.includes('*') ? version : null;
}

/**
 * Expand a wildcarded segment into a BOUNDED branch range.
 *
 * ⛔ WIDEN AN UNCERTAIN BOUND, NEVER NARROW OR DROP IT — the conservative
 * direction this whole product uses. "10.0.*" becomes {min:'10.0.0',
 * max:'10.0.999'}: still bounded, never unbounded.
 */
export function branchRangeFromWildcardCriteria(
  criteria: string | undefined
): { min: string; max: string } | null {
  if (!criteria || typeof criteria !== 'string') return null;
  const version = criteria.split(':')[5];
  if (!version || !version.endsWith('.*')) return null;
  const branch = version.slice(0, -2);
  return branch ? { min: `${branch}.0`, max: `${branch}.999` } : null;
}

/**
 * Affected ranges for ONE vendor, from a record that may name several.
 *
 * ⛔ `vendorPrefixes` IS NOT OPTIONAL. A CVE's `configurations` can list
 * cpeMatch entries for many products — a shared-library CVE affecting both
 * FortiOS and PAN-OS is the normal case — and without the filter one vendor's
 * version ranges pollute another's applicability data.
 *
 * ⛔ versionEndIncluding = affected UP TO AND INCLUDING.
 *    versionEndExcluding = affected UP TO BUT NOT INCLUDING (that one is fixed).
 *    Reversed, patched devices get reported vulnerable.
 */
export function extractAffectedRanges(
  configurations: Configuration[] | undefined,
  vendorPrefixes: string[]
): AffectedRange[] {
  const ranges: AffectedRange[] = [];
  for (const config of configurations || []) {
    for (const node of (config && config.nodes) || []) {
      for (const match of (node && node.cpeMatch) || []) {
        if (match && match.vulnerable === true && matchesAnyPrefix(match.criteria, vendorPrefixes)) {
          const hasRangeField =
            match.versionStartIncluding != null ||
            match.versionEndIncluding != null ||
            match.versionEndExcluding != null;

          // ⛔ A `vulnerable: true` entry CAN legitimately carry none of the
          // three range fields — NVD's shape for "this exact CPE version, and
          // only this one". Falling through to {min:null,max:null} means "no
          // constraint" downstream, so one exact-version CVE would match EVERY
          // version of that product forever.
          const pinnedVersion = hasRangeField ? null : extractVersionFromCriteria(match.criteria);

          // A wildcarded criteria never satisfies extractVersionFromCriteria —
          // check the branch interpretation before giving up.
          const branchRange =
            hasRangeField || pinnedVersion ? null : branchRangeFromWildcardCriteria(match.criteria);

          if (!hasRangeField && !pinnedVersion && !branchRange) {
            // ⛔ No range fields AND no usable version — MISSING DATA, not an
            // "applies to everything" signal. Skip rather than emit an unbounded
            // range out of nothing.
            continue;
          }

          ranges.push({
            min:
              pinnedVersion ||
              (branchRange ? branchRange.min : null) ||
              (match.versionStartIncluding != null ? match.versionStartIncluding : null),
            max:
              pinnedVersion ||
              (branchRange ? branchRange.max : null) ||
              (match.versionEndIncluding != null
                ? match.versionEndIncluding
                : match.versionEndExcluding != null
                  ? match.versionEndExcluding
                  : null),
            exclude_fixed: !!match.versionEndExcluding,
            vulnerable: true,
          });
        }
      }
    }
  }
  return ranges;
}

/** Versions NVD marks `vulnerable: false` — i.e. fixed. */
export function extractFixedVersions(
  configurations: Configuration[] | undefined,
  vendorPrefixes: string[]
): string[] {
  const versions = new Set<string>();
  for (const config of configurations || []) {
    for (const node of (config && config.nodes) || []) {
      for (const match of (node && node.cpeMatch) || []) {
        if (match && match.vulnerable === false && matchesAnyPrefix(match.criteria, vendorPrefixes)) {
          const v =
            match.versionStartIncluding ||
            match.versionEndIncluding ||
            match.versionEndExcluding ||
            extractVersionFromCriteria(match.criteria);
          if (v) versions.add(v);
        }
      }
    }
  }
  return Array.from(versions);
}

/**
 * Why a record has no ranges — `matched` | `unmatchable` | `other_product`.
 *
 * ⛔ THIS IS WHAT KEEPS "WE COULD NOT EXTRACT A RANGE" DISTINCT FROM "THIS
 * DEVICE IS NOT AFFECTED". An advisory stored with `affected_version_ranges: []`
 * reads downstream as an affirmative negative — the consumer concludes the
 * device is fine. So a record that names this vendor but whose ranges could not
 * be extracted is recorded as `unmatchable` and its empty array means nothing.
 */
export function classifyNvdNativeMatchability(
  configurations: Configuration[] | undefined,
  vendorPrefixes: string[],
  extractedRanges: AffectedRange[]
): { status: 'matched' | 'unmatchable' | 'other_product'; reason: string } {
  if (extractedRanges.length > 0) {
    return { status: 'matched', reason: 'affected version ranges extracted' };
  }

  let namesThisVendor = false;
  for (const config of configurations || []) {
    for (const node of (config && config.nodes) || []) {
      for (const match of (node && node.cpeMatch) || []) {
        if (match && matchesAnyPrefix(match.criteria, vendorPrefixes)) {
          namesThisVendor = true;
          break;
        }
      }
    }
  }

  if (!namesThisVendor) {
    return {
      status: 'other_product',
      reason: 'the record names no CPE belonging to this vendor',
    };
  }
  return {
    status: 'unmatchable',
    reason:
      'the record names this vendor but no affected version range could be extracted; '
      + 'stored without ranges rather than as "not affected"',
  };
}
