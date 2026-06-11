import bcrypt from 'bcryptjs';
import { rawQuery } from './db';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vendors (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  scrape_url TEXT,
  scrape_method TEXT DEFAULT 'html_table',
  last_scraped_at TIMESTAMPTZ,
  scrape_status TEXT DEFAULT 'pending',
  manual_only BOOLEAN DEFAULT false,
  record_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS eol_products (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER REFERENCES vendors(id),
  model_raw TEXT NOT NULL,
  model_normalized TEXT NOT NULL,
  category TEXT,
  eol_date DATE,
  eos_date DATE,
  eosl_date DATE,
  source_url TEXT,
  verified BOOLEAN DEFAULT false,
  verified_at TIMESTAMPTZ,
  entry_method TEXT DEFAULT 'manual',
  confidence TEXT DEFAULT 'medium',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS model_aliases (
  id SERIAL PRIMARY KEY,
  eol_product_id INTEGER REFERENCES eol_products(id),
  alias TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_queries (
  id SERIAL PRIMARY KEY,
  license_key TEXT,
  vendor TEXT,
  model_query TEXT,
  matched_product_id INTEGER REFERENCES eol_products(id),
  cache_hit BOOLEAN DEFAULT false,
  queried_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'admin',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_eol_products_normalized
  ON eol_products USING gin(model_normalized gin_trgm_ops);
`;

// Unique constraint required for the scrape upsert (ON CONFLICT vendor_id + model_normalized).
const CONSTRAINT_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_eol_products_vendor_model
  ON eol_products (vendor_id, model_normalized);
`;

interface SeedVendor {
  slug: string;
  name: string;
  manual_only?: boolean;
}

const SEED_VENDORS: SeedVendor[] = [
  { slug: 'cisco', name: 'Cisco' },
  { slug: 'fortinet', name: 'Fortinet' },
  { slug: 'hp', name: 'HP/Aruba' },
  { slug: 'juniper', name: 'Juniper' },
  { slug: 'mikrotik', name: 'MikroTik' },
  { slug: 'ubiquiti', name: 'Ubiquiti' },
  { slug: 'ruckus', name: 'Ruckus' },
  { slug: 'checkpoint', name: 'CheckPoint' },
  { slug: 'sonicwall', name: 'SonicWall' },
  { slug: 'paloalto', name: 'Palo Alto' },
  { slug: 'forcepoint', name: 'Forcepoint', manual_only: true },
  { slug: 'sangfor', name: 'Sangfor', manual_only: true },
];

export async function runInit(): Promise<void> {
  // Statement-by-statement so a single failure is easy to diagnose.
  for (const stmt of SCHEMA_SQL.split(';')) {
    const trimmed = stmt.trim();
    if (trimmed) {
      await rawQuery(trimmed);
    }
  }
  await rawQuery(CONSTRAINT_SQL.trim());

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

  // Fall back to hashing a plaintext ADMIN_PASSWORD if no hash supplied.
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
