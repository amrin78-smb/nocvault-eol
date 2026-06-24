import bcrypt from 'bcryptjs';
import { rawQuery } from './db';

// ── Schema (NocVault EOL central seed) ──────────────────────────────────────
// Source of truth for the signed EOL feed. Device matching happens in the
// CONSUMING apps, never here — this DB holds only generic vendor model→date data.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vendors (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  manual_only BOOLEAN DEFAULT false,        -- curated-only (no structured source)
  lifecycle_source_url TEXT,                -- vendor's published EoL page (reference)
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS eol_models (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER REFERENCES vendors(id),
  model_raw TEXT NOT NULL,                  -- vendor's exact string (canonical/display)
  model_normalized TEXT NOT NULL,           -- dedupe key (lib/match-normalize)
  end_of_sale DATE,                         -- last-order / end-of-sale
  support_end_date DATE,                    -- end-of-support / LDOS  (apps key on this)
  os_eol_date DATE,                         -- software/firmware EOL, if separate
  confidence TEXT DEFAULT 'medium',         -- 'high' | 'medium' | 'low'
  source_url TEXT,
  note TEXT,
  verified BOOLEAN DEFAULT false,
  verified_at TIMESTAMPTZ,
  entry_method TEXT DEFAULT 'manual',       -- 'agent' | 'manual' | 'seed'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Activated (was dead in the old repo). Additional raw strings that resolve to one
-- model row: SKU variants AND legacy "garbage" strings (e.g. 'Ne INT', '432e INT').
CREATE TABLE IF NOT EXISTS model_aliases (
  id SERIAL PRIMARY KEY,
  eol_model_id INTEGER REFERENCES eol_models(id) ON DELETE CASCADE,
  alias_raw TEXT NOT NULL,
  alias_normalized TEXT NOT NULL
);

-- Audit/generation log for each published feed version.
CREATE TABLE IF NOT EXISTS feed_versions (
  id SERIAL PRIMARY KEY,
  feed_version TEXT UNIQUE NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  row_count INTEGER,
  content_sha256 TEXT,
  signature TEXT,
  normalizer_version INTEGER,
  published_by TEXT
);

CREATE TABLE IF NOT EXISTS admin_users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'admin',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_eol_models_normalized
  ON eol_models USING gin(model_normalized gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_model_aliases_normalized
  ON model_aliases (alias_normalized);
`;

// Required for the seed/agent upsert (ON CONFLICT vendor_id + model_normalized).
const CONSTRAINT_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_eol_models_vendor_model
  ON eol_models (vendor_id, model_normalized);
CREATE UNIQUE INDEX IF NOT EXISTS uq_model_aliases_model_alias
  ON model_aliases (eol_model_id, alias_raw);
`;

interface SeedVendor {
  slug: string;
  name: string;
  manual_only?: boolean;
}

// v1 vendor scope = the fleet's actual vendors. Missing vendors are auto-created
// by the seed/agent import; this just gives the curation UI a starting list.
const SEED_VENDORS: SeedVendor[] = [
  { slug: 'cisco', name: 'Cisco' },
  { slug: 'aruba', name: 'Aruba / HPE' },
  { slug: 'meraki', name: 'Cisco Meraki' },
  { slug: 'sonicwall', name: 'SonicWall' },
  { slug: 'tplink', name: 'TP-Link' },
  { slug: 'netgear', name: 'Netgear' },
  { slug: 'ruckus', name: 'Ruckus' },
  { slug: 'huawei', name: 'Huawei' },
  { slug: 'paloalto', name: 'Palo Alto' },
  { slug: 'forcepoint', name: 'Forcepoint', manual_only: true },
  { slug: 'fortinet', name: 'Fortinet' },
  { slug: 'grandstream', name: 'Grandstream' },
  { slug: 'dlink', name: 'D-Link' },
  { slug: 'ubiquiti', name: 'Ubiquiti' },
  { slug: 'alliedtelesis', name: 'Allied Telesis' },
];

// One-time migrations from the OLD nocvault-eol schema (scraper/live-query era) to
// the feed-builder schema. Run BEFORE the CREATE TABLE IF NOT EXISTS block so the
// new shapes/indexes can be created. Each is idempotent. Run whole (DO blocks
// contain semicolons, so they must NOT be split on ';').
const MIGRATIONS: string[] = [
  // Legacy model_aliases (old shape eol_product_id/alias; was unused) -> drop so the
  // new (eol_model_id, alias_raw, alias_normalized) shape is created below.
  `DO $$ BEGIN
     IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'model_aliases' AND column_name = 'eol_product_id') THEN
       DROP TABLE model_aliases CASCADE;
     END IF;
   END $$;`,
  // Retired tables (live-query log + scraper work queue).
  `DROP TABLE IF EXISTS api_queries CASCADE`,
  `DROP TABLE IF EXISTS cisco_eol_queue CASCADE`,
  // vendors gains feed-era columns on databases created before them.
  `ALTER TABLE IF EXISTS vendors ADD COLUMN IF NOT EXISTS lifecycle_source_url TEXT`,
  `ALTER TABLE IF EXISTS vendors ADD COLUMN IF NOT EXISTS notes TEXT`,
  `ALTER TABLE IF EXISTS vendors ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,
];

export async function runInit(): Promise<void> {
  // Fast path: if the schema is already present, skip the ~25 DDL/migration/seed
  // statements. Serverless functions cold-start often; without this every first
  // request (login, publish, etc.) pays the full init (~9s observed). One cheap
  // existence check instead. NOTE: when a NEW migration is needed, add a version
  // marker check here (or temporarily bypass) so it actually runs.
  try {
    const r = await rawQuery<{ present: boolean }>(
      `SELECT (to_regclass('public.eol_models') IS NOT NULL
               AND to_regclass('public.feed_versions') IS NOT NULL) AS present`
    );
    if (r.rows[0]?.present) return;
  } catch {
    // fall through to full init on any error
  }

  // Migrations first (whole statements — do NOT split on ';').
  for (const stmt of MIGRATIONS) {
    await rawQuery(stmt);
  }
  // Statement-by-statement so a single failure is easy to diagnose.
  for (const stmt of SCHEMA_SQL.split(';')) {
    const trimmed = stmt.trim();
    if (trimmed) await rawQuery(trimmed);
  }
  for (const stmt of CONSTRAINT_SQL.split(';')) {
    const trimmed = stmt.trim();
    if (trimmed) await rawQuery(trimmed);
  }
  await seedVendors();
  await seedAdmin();
}

async function seedVendors(): Promise<void> {
  for (const v of SEED_VENDORS) {
    await rawQuery(
      `INSERT INTO vendors (slug, name, manual_only)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO NOTHING`,
      [v.slug, v.name, v.manual_only ?? false]
    );
  }
}

async function seedAdmin(): Promise<void> {
  const email = process.env.ADMIN_EMAIL;
  let hash = process.env.ADMIN_PASSWORD_HASH;
  if (!email) return;

  const { rows } = await rawQuery<{ count: string }>(
    'SELECT COUNT(*)::int AS count FROM admin_users'
  );
  if (Number(rows[0]?.count ?? 0) > 0) return;

  if (!hash && process.env.ADMIN_PASSWORD) {
    hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
  }
  if (!hash) return;

  await rawQuery(
    `INSERT INTO admin_users (email, password_hash, role)
     VALUES ($1, $2, 'admin')
     ON CONFLICT (email) DO NOTHING`,
    [email, hash]
  );
}
