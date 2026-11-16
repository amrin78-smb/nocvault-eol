// lib/eol/os-schema.ts
//
// Storage for the OS/firmware branch lifecycle corpus and its signed feed.
//
// ⛔ ITS OWN GATE. FOURTH TIME IN THIS REPO, SAME REASON. lib/init.ts's EOL fast
// path is gated on eol_models + feed_versions + the lifecycle column; widening
// THAT would re-run ~25 EOL DDL/seed statements (~9s measured) on a live service
// to create tables unrelated to the model catalogue. lib/cve/schema.ts and
// lib/eol/watch-schema.ts both made this call and documented it.
//
// ⛔ AND IT DOES NOT WIDEN THEIRS. Three corpora, three gates: a CVE deploy must
// not re-run EOL DDL, and a bug in one must not be able to take the others with
// it. Same reasoning that kept cve_feed_versions out of feed_versions.

import { rawQuery } from '../db';

// ⛔ WHOLE STATEMENTS IN AN ARRAY — NEVER ONE STRING SPLIT ON ';'. The comments
// below contain semicolons, and lib/cve/schema.ts broke in production exactly
// that way: splitting cut CREATE TABLE into fragments that are each a syntax
// error, with an error message naming none of it.
const OS_SCHEMA_STATEMENTS: string[] = [
  // ⛔ KEYED (vendor, product, cycle), NOT (vendor, cycle). "7.4" is a FortiOS
  // branch and also a plausible branch of half a dozen other products; the
  // product is part of the identity, not a label on it. This is the same mistake
  // SecVault made keying advisories on cve_id alone, recorded in CLAUDE.md as
  // permanent once made — cheap to get right here, expensive to change later.
  //
  // ⛔ extended_end_date IS A SEPARATE COLUMN, NOT A LONGER support_end_date.
  // PAN-OS 10.1: standard support to 2024-11-30, extended to 2026-03-30.
  // Collapsing them tells a customer with no extended contract that their
  // branch lives 16 months longer than it does.
  `CREATE TABLE IF NOT EXISTS os_cycles (
     id SERIAL PRIMARY KEY,
     vendor TEXT NOT NULL,
     product TEXT NOT NULL,
     cycle TEXT NOT NULL,
     release_date DATE,
     support_end_date DATE,
     extended_end_date DATE,
     latest_version TEXT,
     lts BOOLEAN,
     confidence TEXT NOT NULL,
     source TEXT NOT NULL,
     vendor_link TEXT,
     note TEXT,
     applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (vendor, product, cycle)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_os_cycles_product ON os_cycles (vendor, product)`,

  // Audit log for each published OS feed. Deliberately not feed_versions and
  // not cve_feed_versions.
  `CREATE TABLE IF NOT EXISTS os_feed_versions (
     id SERIAL PRIMARY KEY,
     feed_version TEXT UNIQUE NOT NULL,
     generated_at TIMESTAMPTZ DEFAULT NOW(),
     row_count INTEGER,
     content_sha256 TEXT,
     signature TEXT,
     published_by TEXT
   )`,

  // ⛔ THE PAYLOAD-ONLY DIGEST, AND IT IS NOT REDUNDANT WITH content_sha256.
  // The signed body contains feed_version and generated_at, so its sha256
  // changes on every publish by construction — comparing THAT to detect
  // "nothing changed" is a guard that cannot fire. cve_feed_versions learned
  // this the expensive way. ⛔ CREATE TABLE IF NOT EXISTS never guards a new
  // column, hence the companion ALTER.
  `ALTER TABLE os_feed_versions ADD COLUMN IF NOT EXISTS cycles_sha256 TEXT`,
];

let schemaReady = false;

export async function ensureOsSchema(): Promise<void> {
  if (schemaReady) return;
  try {
    // ⛔ THE GATE DESCRIBES THE WHOLE EXPECTED SHAPE, NOT JUST THE TABLES.
    // CLAUDE.md records what checking only to_regclass cost once: the
    // advisories_sha256 ALTER sat behind a gate that returned early, every
    // publish failed on a missing column for hours, and the DDL was right there
    // in the diff. The column and the uniqueness constraint are part of the
    // shape, so they are part of the check.
    const r = await rawQuery<{ present: boolean }>(
      `SELECT (to_regclass('public.os_cycles') IS NOT NULL
               AND to_regclass('public.os_feed_versions') IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'os_feed_versions'
                    AND column_name = 'cycles_sha256'
               )
               AND EXISTS (
                 SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.os_cycles'::regclass
                    AND contype = 'u' AND array_length(conkey, 1) = 3
               )) AS present`
    );
    if (r.rows[0]?.present) { schemaReady = true; return; }
  } catch {
    // Fall through and attempt the DDL; every statement is IF NOT EXISTS.
  }

  for (const stmt of OS_SCHEMA_STATEMENTS) {
    await rawQuery(stmt);
  }
  schemaReady = true;
}

/** Test-only: forget the memoised gate so a fresh database is re-checked. */
export function _resetOsSchemaMemo(): void {
  schemaReady = false;
}
