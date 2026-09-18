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

// ⛔ AN ARRAY OF WHOLE STATEMENTS — NEVER ONE STRING SPLIT ON ';'.
//
// lib/init.ts's own MIGRATIONS array says "whole statements — do NOT split on
// ';'". This file ignored that on its first draft and broke immediately in
// production with `syntax error at end of input`, because COMMENTS CONTAIN
// SEMICOLONS:
//
//     -- NVD pages 2000 at a time; this is where the next invocation resumes.
//     -- ...must sort to the FRONT of the queue; one that ran and returned zero…
//
// Splitting there cut CREATE TABLE cve_ingest_state into three fragments, each
// of which is a syntax error — and the error message names none of that. The
// comments are worth keeping, so the STATEMENTS are separated structurally
// instead, and prose can never again decide where a statement ends.
const CVE_SCHEMA_STATEMENTS: string[] = [
  // The advisory corpus. Generic vendor/product facts only:
  // ⛔ NO DEVICE DATA EVER REACHES THIS SERVICE. Consumers pull the corpus and
  // match locally, exactly as they do for EOL. This repo already deleted a live
  // query API once because it "leaked device data" — do not reintroduce one.
  //
  // ⛔ KEYED (cve_id, vendor), NOT cve_id. SecVault's own advisories table made
  // cve_id UNIQUE with a single vendor, and its CLAUDE.md records the
  // consequence: a CVE affecting two vendors stays with whichever feed ingested
  // it first, permanently. This is the one place that is still fixable.
  //
  // ⛔ `matchability` is 'matched' | 'unmatchable' | 'other_product'. An
  // advisory that declares itself affected but whose version range could NOT be
  // extracted must never be stored with an empty range array: downstream, an
  // empty array reads as "this device is not affected". Recording WHY it has no
  // ranges is what keeps that distinction alive across the feed.
  `CREATE TABLE IF NOT EXISTS cve_advisories (
     id SERIAL PRIMARY KEY,
     cve_id TEXT NOT NULL,
     vendor TEXT NOT NULL,
     title TEXT,
     description TEXT,
     cvss_score NUMERIC(3,1),
     cvss_vector TEXT,
     cvss_version TEXT,
     cvss_source TEXT,
     published_at TIMESTAMPTZ,
     affected_version_ranges JSONB,
     fixed_in_versions JSONB,
     advisory_url TEXT,
     cwe_ids TEXT[],
     matchability TEXT,
     source TEXT NOT NULL DEFAULT 'nvd',
     first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (cve_id, vendor)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_cve_advisories_vendor ON cve_advisories (vendor)`,

  // ⛔ RESUMABLE INGESTION STATE — this is what makes the whole thing possible.
  //
  // A Netlify function invocation is bounded (10s by default, 26s at most), and
  // NVD allows 5 requests per rolling 30s without an API key. The six supported
  // vendors span 32 verified CPE strings, so a full sweep is ~200s of waiting AT
  // MINIMUM — an order of magnitude past any invocation budget.
  //
  // So ingestion is a STATE MACHINE, not a job: each invocation takes the least
  // recently attempted CPE string, works it, records where it got to, and
  // returns how much is left. A run that is cut off resumes instead of
  // restarting, which also means a transient NVD outage costs one string rather
  // than the sweep.
  //
  // `next_start_index` is where the next invocation resumes NVD's paging.
  // `last_error` NULL means never attempted, which is NOT the same as
  // "attempted and found nothing" — a string that has never run must sort to the
  // FRONT of the queue, and one that ran and returned zero must not be retried
  // ahead of it.
  `CREATE TABLE IF NOT EXISTS cve_ingest_state (
     id SERIAL PRIMARY KEY,
     vendor TEXT NOT NULL,
     cpe_string TEXT NOT NULL,
     next_start_index INTEGER NOT NULL DEFAULT 0,
     total_results INTEGER,
     last_attempt_at TIMESTAMPTZ,
     last_success_at TIMESTAMPTZ,
     last_error TEXT,
     consecutive_failures INTEGER NOT NULL DEFAULT 0,
     advisories_seen INTEGER,
     UNIQUE (vendor, cpe_string)
   )`,

  // Audit log for each published CVE feed. Deliberately NOT feed_versions.
  `CREATE TABLE IF NOT EXISTS cve_feed_versions (
     id SERIAL PRIMARY KEY,
     feed_version TEXT UNIQUE NOT NULL,
     generated_at TIMESTAMPTZ DEFAULT NOW(),
     row_count INTEGER,
     content_sha256 TEXT,
     signature TEXT,
     published_by TEXT
   )`,

  // ⛔ A SECOND DIGEST, OVER THE ADVISORIES ALONE — and it is not redundant.
  // content_sha256 covers the WHOLE signed body, which includes feed_version and
  // generated_at, so it changes on every publish by construction. Comparing it
  // to decide "has anything actually changed?" is a guard that CANNOT FIRE.
  // advisories_sha256 covers only the payload, so two runs over an unchanged
  // corpus produce the same value and the republish can be skipped.
  //
  // ⛔ CREATE TABLE IF NOT EXISTS guards the TABLE, never a new column — an
  // already-deployed database keeps the old shape and the first query naming
  // this column fails at runtime. Hence the companion ALTER.
  `ALTER TABLE cve_feed_versions ADD COLUMN IF NOT EXISTS advisories_sha256 TEXT`,
];

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
let schemaReady = false;

export async function ensureCveSchema(): Promise<void> {
  // ⛔ MEMOISED FOR THE LIFE OF THE CONTAINER. The to_regclass probe is cheap
  // but it is not free: it is a network round trip to Neon on the hot path of
  // every ingest step, and those round trips were collectively starving the NVD
  // fetch of its budget. Tables cannot un-exist within one container.
  if (schemaReady) return;
  try {
    const r = await rawQuery<{ present: boolean }>(
      `SELECT (to_regclass('public.cve_advisories') IS NOT NULL
               AND to_regclass('public.cve_ingest_state') IS NOT NULL
               AND to_regclass('public.cve_feed_versions') IS NOT NULL) AS present`
    );
    if (r.rows[0]?.present) {
      schemaReady = true;
      return;
    }
  } catch {
    // Fall through and attempt the DDL; every statement is IF NOT EXISTS.
  }

  // Whole statements, in order. Nothing splits on ';'.
  for (const stmt of CVE_SCHEMA_STATEMENTS) {
    await rawQuery(stmt);
  }
  schemaReady = true;
}
