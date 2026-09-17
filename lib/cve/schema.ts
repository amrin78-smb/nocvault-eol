// lib/cve/schema.ts
//
// The CVE corpus — Phase 1 of making this service a central VULNERABILITY feed
// alongside the EOL one. Nothing here touches the EOL tables.
//
// ⛔ ITS OWN GATE, DELIBERATELY SEPARATE FROM runInit()'s. The EOL fast path in
// lib/init.ts is gated on `eol_models` + `feed_versions` + the `lifecycle`
// column, and its comment says to bump that check when a new migration must
// reach an initialised DB. Doing that HERE would be wrong: it would make the
// next request after deploy re-run the ~25 EOL DDL/seed statements (~9s
// measured) on a live service, to create tables that have nothing to do with
// EOL. This gate checks only for the CVE tables and runs only the CVE DDL, so
// the EOL path is never re-entered and its blast radius stays zero.
//
// ⛔ SEPARATE TABLES, NOT SHARED ONES. `cve_feed_versions` is its own audit log
// rather than a `kind` column on `feed_versions`, because the EOL feed is live
// in production and NetVault reads it. A shared table means a CVE bug can
// corrupt the EOL feed's audit trail, and a schema change to one forces a
// migration on the other.

import { rawQuery } from '../db';

const CVE_SCHEMA_SQL = `
-- The advisory corpus. Generic vendor/product facts only:
-- ⛔ NO DEVICE DATA EVER REACHES THIS SERVICE. Consumers pull the corpus and
-- match locally, exactly as they do for EOL. This repo already deleted a live
-- query API once because it "leaked device data" — do not reintroduce one.
CREATE TABLE IF NOT EXISTS cve_advisories (
  id SERIAL PRIMARY KEY,
  cve_id TEXT NOT NULL,
  -- The consuming product's vendor slug ('paloalto', 'fortinet', …). A CVE can
  -- legitimately affect two vendors, so the key is (cve_id, vendor) and NOT
  -- cve_id alone.
  -- ⛔ SecVault's own advisories table made cve_id UNIQUE with a single vendor,
  -- and the consequence is recorded in its CLAUDE.md: a CVE affecting two
  -- vendors stays with whichever feed ingested it first, permanently. This is
  -- the one place that mistake can still be fixed, so it is fixed here.
  vendor TEXT NOT NULL,
  title TEXT,
  description TEXT,
  cvss_score NUMERIC(3,1),
  cvss_vector TEXT,
  cvss_version TEXT,
  cvss_source TEXT,
  published_at TIMESTAMPTZ,
  -- JSONB arrays, same shape the consumers already parse.
  affected_version_ranges JSONB,
  fixed_in_versions JSONB,
  advisory_url TEXT,
  cwe_ids TEXT[],
  -- ⛔ 'matched' | 'unmatchable' | 'other_product'. An advisory that declares
  -- itself affected but whose version range could NOT be extracted must never
  -- be stored with an empty range array: downstream, an empty array reads as
  -- "this device is not affected". Recording WHY it has no ranges is what keeps
  -- that distinction alive across the feed.
  matchability TEXT,
  source TEXT NOT NULL DEFAULT 'nvd',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cve_id, vendor)
);

CREATE INDEX IF NOT EXISTS idx_cve_advisories_vendor ON cve_advisories (vendor);

-- ⛔ RESUMABLE INGESTION STATE — this is what makes the whole thing possible.
--
-- A Netlify function invocation is bounded (10s by default, 26s at most), and
-- NVD is rate-limited to one request per six seconds without a key. The six
-- supported vendors span 32 verified CPE strings, so a full sweep is 192s of
-- waiting AT MINIMUM — an order of magnitude past any invocation budget.
--
-- So ingestion is a STATE MACHINE, not a job: each invocation takes the least
-- recently attempted CPE string, works it, records where it got to, and returns
-- how much is left. A run that is cut off resumes instead of restarting, which
-- also means a transient NVD outage costs one string rather than the sweep.
CREATE TABLE IF NOT EXISTS cve_ingest_state (
  id SERIAL PRIMARY KEY,
  vendor TEXT NOT NULL,
  cpe_string TEXT NOT NULL,
  -- NVD pages 2000 at a time; this is where the next invocation resumes.
  next_start_index INTEGER NOT NULL DEFAULT 0,
  total_results INTEGER,
  last_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  -- ⛔ NULL means never attempted, which is NOT the same as "attempted and found
  -- nothing". A string that has never run must sort to the FRONT of the queue;
  -- one that ran and returned zero must not be retried ahead of it.
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  advisories_seen INTEGER,
  UNIQUE (vendor, cpe_string)
);

-- Audit log for each published CVE feed. Deliberately NOT feed_versions.
CREATE TABLE IF NOT EXISTS cve_feed_versions (
  id SERIAL PRIMARY KEY,
  feed_version TEXT UNIQUE NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  row_count INTEGER,
  content_sha256 TEXT,
  signature TEXT,
  published_by TEXT
);
`;

/**
 * Create the CVE schema if it is absent.
 *
 * ⛔ CHECKS ONLY FOR ITS OWN TABLES and runs only its own DDL. It must never
 * call runInit() or widen runInit()'s gate — see the header.
 *
 * ⛔ IDEMPOTENT AND CHEAP ON THE HOT PATH: one `to_regclass` lookup when the
 * tables already exist. The EOL init learned this the expensive way (~9s per
 * cold start before its fast path existed).
 */
export async function ensureCveSchema(): Promise<void> {
  try {
    const r = await rawQuery<{ present: boolean }>(
      `SELECT (to_regclass('public.cve_advisories') IS NOT NULL
               AND to_regclass('public.cve_ingest_state') IS NOT NULL
               AND to_regclass('public.cve_feed_versions') IS NOT NULL) AS present`
    );
    if (r.rows[0]?.present) return;
  } catch {
    // Fall through and attempt the DDL; every statement is IF NOT EXISTS.
  }

  for (const stmt of CVE_SCHEMA_SQL.split(';')) {
    const trimmed = stmt.trim();
    if (trimmed) await rawQuery(trimmed);
  }
}
