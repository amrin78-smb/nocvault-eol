// lib/eol/watch-schema.ts
//
// State for the vendor EOL page change detector.
//
// ⛔ ITS OWN GATE, FOR THE THIRD TIME IN THIS REPO AND FOR THE SAME REASON.
// lib/init.ts's EOL fast path is gated on `eol_models` + `feed_versions` + the
// `lifecycle` column; widening THAT gate would make the next request after
// deploy re-run ~25 EOL DDL/seed statements (~9s measured) on a live service, to
// create tables that do not touch the model catalogue. lib/cve/schema.ts made
// the same call and documented it. This gate checks only for the watch tables
// and runs only the watch DDL.
//
// ⛔ AND IT DOES NOT WIDEN lib/cve/schema.ts's GATE EITHER. These are EOL
// tables; a CVE schema bug must not be able to take them with it, and a CVE
// deploy must not re-run EOL DDL. Two products, two gates — the same reasoning
// that kept `cve_feed_versions` separate from `feed_versions`.
//
// ⛔ NOTHING HERE TOUCHES `eol_models`, `model_aliases` OR `feed_versions`. The
// detector raises review items; the curated seed stays the only thing that ever
// writes a date. scripts/verify-eol-watch.ts asserts the catalogue row count is
// unchanged across a full watch cycle, because "it does not write dates" is a
// claim worth proving rather than stating.

import { rawQuery } from '../db';

// ⛔ WHOLE STATEMENTS IN AN ARRAY — NEVER ONE STRING SPLIT ON ';'. lib/cve/
// schema.ts broke in production this way: the comments contain semicolons, and
// splitting on them cut CREATE TABLE into fragments that are each a syntax
// error, with an error message that names none of it.
const EOL_WATCH_STATEMENTS: string[] = [
  // ⛔ ONE ROW PER WATCHED PAGE, HOLDING THE LAST SIGNAL WE SUCCESSFULLY READ.
  //
  // `content_hash IS NULL` means NEVER SUCCESSFULLY READ, and that is a distinct
  // state from "read and unchanged" — the first read of a source establishes a
  // baseline and must NOT raise a review item. Eight sources alerting on their
  // own first run would make the feature's debut a burst of noise about nothing,
  // and the operator's first impression of an alert channel decides whether they
  // ever read the second one.
  //
  // `signal_lines` is kept so a change can say WHAT changed. "Cisco's listing
  // changed" sends someone to diff a page by eye; "1 product added: Cisco
  // Catalyst 9200 Series" sends them to a bulletin.
  `CREATE TABLE IF NOT EXISTS eol_watch_sources (
     id SERIAL PRIMARY KEY,
     vendor TEXT NOT NULL,
     label TEXT NOT NULL,
     url TEXT NOT NULL,
     signal_kind TEXT NOT NULL,
     min_signal_lines INTEGER NOT NULL DEFAULT 1,
     content_hash TEXT,
     signal_count INTEGER,
     signal_lines JSONB,
     signal_truncated BOOLEAN NOT NULL DEFAULT FALSE,
     last_fetch_at TIMESTAMPTZ,
     last_success_at TIMESTAMPTZ,
     last_changed_at TIMESTAMPTZ,
     last_status INTEGER,
     last_error TEXT,
     last_body_bytes INTEGER,
     consecutive_failures INTEGER NOT NULL DEFAULT 0,
     unreadable_notified_at TIMESTAMPTZ,
     UNIQUE (url)
   )`,

  // ⛔ A REVIEW QUEUE, NOT A LOG. Each row is work for a human: go and read the
  // vendor's page, and if a date moved, update data/eol-seed.json and republish.
  // It is therefore ACKNOWLEDGEABLE — an un-acknowledgeable alert list grows
  // until it is ignored, which is the failure mode this repo keeps recording.
  //
  // ⛔ `notified_at` IS SET ONLY ON A REAL SEND, matching cve_health_alerts'
  // markNotified rule: a broken mailer must not be able to mark work as
  // announced. A change whose email failed is retried on the next cycle.
  `CREATE TABLE IF NOT EXISTS eol_watch_changes (
     id SERIAL PRIMARY KEY,
     source_id INTEGER NOT NULL REFERENCES eol_watch_sources(id) ON DELETE CASCADE,
     vendor TEXT NOT NULL,
     label TEXT NOT NULL,
     url TEXT NOT NULL,
     detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     old_hash TEXT,
     new_hash TEXT,
     old_count INTEGER,
     new_count INTEGER,
     added JSONB,
     removed JSONB,
     detail_available BOOLEAN NOT NULL DEFAULT TRUE,
     notified_at TIMESTAMPTZ,
     acknowledged_at TIMESTAMPTZ,
     acknowledged_note TEXT
   )`,

  `CREATE INDEX IF NOT EXISTS idx_eol_watch_changes_open
     ON eol_watch_changes (detected_at DESC) WHERE acknowledged_at IS NULL`,

  `CREATE INDEX IF NOT EXISTS idx_eol_watch_changes_unnotified
     ON eol_watch_changes (id) WHERE notified_at IS NULL`,
];

let schemaReady = false;

/**
 * Create the watch schema if absent. Idempotent, memoised for the container.
 *
 * ⛔ WHEN A MIGRATION MUST REACH AN ALREADY-INITIALISED DATABASE, WIDEN THIS
 * CHECK IN THE SAME COMMIT. CLAUDE.md records what skipping that costs: the
 * `advisories_sha256` ALTER sat behind a gate that returned early, every publish
 * failed on a missing column for hours, and the DDL was right there in the diff.
 * A statement that cannot run is indistinguishable from one that ran.
 */
export async function ensureEolWatchSchema(): Promise<void> {
  if (schemaReady) return;
  try {
    const r = await rawQuery<{ present: boolean }>(
      `SELECT (to_regclass('public.eol_watch_sources') IS NOT NULL
               AND to_regclass('public.eol_watch_changes') IS NOT NULL) AS present`
    );
    if (r.rows[0]?.present) {
      schemaReady = true;
      return;
    }
  } catch {
    // Fall through and attempt the DDL; every statement is IF NOT EXISTS.
  }

  for (const stmt of EOL_WATCH_STATEMENTS) {
    await rawQuery(stmt);
  }
  schemaReady = true;
}

/** Test-only: forget the memoised gate so a fresh database is re-checked. */
export function _resetWatchSchemaMemo(): void {
  schemaReady = false;
}
