// lib/oui/schema.ts
//
// Storage for the OUI (MAC address block) catalogue and its signed feed.
//
// ⛔ ITS OWN GATE. FIFTH CORPUS, FIFTH GATE, SAME REASON EVERY TIME: widening
// lib/init.ts's EOL fast path would re-run ~25 EOL DDL/seed statements (~9s
// measured) on a live service to create tables unrelated to the model
// catalogue. cve/schema.ts, eol/watch-schema.ts and eol/os-schema.ts all made
// this call and documented it.

import { rawQuery } from '../db';

const OUI_SCHEMA_STATEMENTS: string[] = [
  // ⛔ KEYED ON prefix ALONE, and that is correct precisely BECAUSE the three
  // registries use different lengths: "00000C" (MA-L) and "00000C1" (MA-M) are
  // different keys and both may legitimately exist. prefix_bits is stored, not
  // derived at read time, because the lookup is longest-prefix-first and the
  // length is part of the answer, not a formatting detail.
  `CREATE TABLE IF NOT EXISTS oui_assignments (
     prefix TEXT PRIMARY KEY,
     prefix_bits INTEGER NOT NULL,
     registry TEXT NOT NULL,
     org TEXT NOT NULL,
     is_registry_block BOOLEAN NOT NULL DEFAULT FALSE,
     source TEXT NOT NULL,
     confidence TEXT NOT NULL DEFAULT 'high',
     refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  `CREATE INDEX IF NOT EXISTS idx_oui_assignments_bits ON oui_assignments (prefix_bits)`,

  // ⛔ WHEN THE REGISTRY WAS LAST SUCCESSFULLY READ — one row per registry.
  // Separate from the assignments because a refresh that FAILS admission must
  // still be recorded: "we looked and refused what we got" and "we never
  // looked" are different facts, and the second one is the silent outage this
  // repo keeps rediscovering.
  `CREATE TABLE IF NOT EXISTS oui_refresh_state (
     registry TEXT PRIMARY KEY,
     url TEXT NOT NULL,
     last_attempt_at TIMESTAMPTZ,
     last_success_at TIMESTAMPTZ,
     last_status INTEGER,
     last_rows INTEGER,
     last_error TEXT,
     consecutive_failures INTEGER NOT NULL DEFAULT 0
   )`,

  `CREATE TABLE IF NOT EXISTS oui_feed_versions (
     id SERIAL PRIMARY KEY,
     feed_version TEXT UNIQUE NOT NULL,
     generated_at TIMESTAMPTZ DEFAULT NOW(),
     row_count INTEGER,
     content_sha256 TEXT,
     signature TEXT,
     published_by TEXT
   )`,

  // ⛔ THE PAYLOAD-ONLY DIGEST. content_sha256 covers the signed body, which
  // includes feed_version and generated_at, so it changes every publish by
  // construction — comparing it to detect "nothing changed" is a guard that
  // cannot fire. CREATE TABLE IF NOT EXISTS never guards a new column.
  `ALTER TABLE oui_feed_versions ADD COLUMN IF NOT EXISTS assignments_sha256 TEXT`,
];

let schemaReady = false;

export async function ensureOuiSchema(): Promise<void> {
  if (schemaReady) return;
  try {
    // ⛔ THE GATE DESCRIBES THE WHOLE SHAPE, columns included. CLAUDE.md records
    // what checking only to_regclass cost once: an ALTER behind a gate that
    // returned early, every publish failing on a missing column for hours, the
    // DDL sitting right there in the diff.
    const r = await rawQuery<{ present: boolean }>(
      `SELECT (to_regclass('public.oui_assignments') IS NOT NULL
               AND to_regclass('public.oui_refresh_state') IS NOT NULL
               AND to_regclass('public.oui_feed_versions') IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'oui_feed_versions'
                    AND column_name = 'assignments_sha256'
               )) AS present`
    );
    if (r.rows[0]?.present) { schemaReady = true; return; }
  } catch {
    // Fall through; every statement is IF NOT EXISTS.
  }
  for (const stmt of OUI_SCHEMA_STATEMENTS) await rawQuery(stmt);
  schemaReady = true;
}

/** Test-only: forget the memoised gate so a fresh database is re-checked. */
export function _resetOuiSchemaMemo(): void { schemaReady = false; }
