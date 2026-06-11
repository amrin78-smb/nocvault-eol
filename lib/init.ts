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
  description TEXT,
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

-- Work queue for the resumable Cisco EOL crawl (series -> listing -> bulletin).
CREATE TABLE IF NOT EXISTS cisco_eol_queue (
  id SERIAL PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  category TEXT,
  series_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
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

// Bring existing databases (created before the column was added) up to date.
const ALTER_SQL = `
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS description TEXT;
`;

interface SeedVendor {
  slug: string;
  name: string;
  manual_only?: boolean;
}

// Vendors not tracked by endoflife.date (verified 2026-06-11) and with no
// scrapeable source are handled via the manual-entry workflow. Sangfor is NOT
// here because it has a scrapeable EOS table (see scrape route + reconcileVendorSources).
const MANUAL_ONLY_SLUGS = [
  'hp',
  'juniper',
  'ubiquiti',
  'ruckus',
  'checkpoint',
  'sonicwall',
  'forcepoint',
];

const SANGFOR_EOS_URL =
  'https://www.sangfor.com/support/services-policy/support-life-cycle-policy/end-of-sale-service-eos';
const FORCEPOINT_LIFECYCLE_URL =
  'https://support.forcepoint.com/s/productsupportlifecycle';
const FORCEPOINT_NOTE =
  'Lifecycle data is rendered by JavaScript (Salesforce Experience Cloud) and is not present in the page HTML, so it cannot be scraped. Open the source URL in a browser and enter EOS/EOL dates manually.';

const SEED_VENDORS: SeedVendor[] = [
  { slug: 'cisco', name: 'Cisco' },
  { slug: 'fortinet', name: 'Fortinet' },
  { slug: 'hp', name: 'HP/Aruba', manual_only: true },
  { slug: 'juniper', name: 'Juniper', manual_only: true },
  { slug: 'mikrotik', name: 'MikroTik' },
  { slug: 'ubiquiti', name: 'Ubiquiti', manual_only: true },
  { slug: 'ruckus', name: 'Ruckus', manual_only: true },
  { slug: 'checkpoint', name: 'CheckPoint', manual_only: true },
  { slug: 'sonicwall', name: 'SonicWall', manual_only: true },
  { slug: 'paloalto', name: 'Palo Alto' },
  { slug: 'forcepoint', name: 'Forcepoint', manual_only: true },
  { slug: 'sangfor', name: 'Sangfor' },
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
  await rawQuery(ALTER_SQL.trim());

  await seedVendors();
  await reconcileManualOnly();
  await reconcileVendorSources();
  await seedAdmin();
}

// seedVendors uses ON CONFLICT DO NOTHING, so vendor source config must be
// reconciled separately for databases seeded before these scrapers existed.
async function reconcileVendorSources(): Promise<void> {
  // Sangfor publishes a plain-HTML EOS table -> scrapeable.
  await rawQuery(
    `UPDATE vendors
        SET manual_only = false,
            scrape_url = $1,
            scrape_method = 'html_table'
      WHERE slug = 'sangfor'`,
    [SANGFOR_EOS_URL]
  );

  // Cisco: public EOL index crawl (lib/cisco.ts), wired via scrape_method.
  await rawQuery(
    `UPDATE vendors
        SET manual_only = false,
            scrape_url = $1,
            scrape_method = 'cisco_eol_index'
      WHERE slug = 'cisco'`,
    ['https://www.cisco.com/c/en/us/support/eol/index.html']
  );

  // Forcepoint is a JS-rendered Salesforce shell -> not scrapeable; keep manual.
  await rawQuery(
    `UPDATE vendors
        SET manual_only = true,
            scrape_url = $1,
            scrape_status = 'js_rendered',
            description = $2
      WHERE slug = 'forcepoint'`,
    [FORCEPOINT_LIFECYCLE_URL, FORCEPOINT_NOTE]
  );
}

// seedVendors uses ON CONFLICT DO NOTHING, so it never updates existing rows.
// Flip vendors that have no automated source to manual_only on existing DBs too.
async function reconcileManualOnly(): Promise<void> {
  await rawQuery(
    `UPDATE vendors
       SET manual_only = true,
           scrape_status = 'manual_only'
     WHERE slug = ANY($1) AND manual_only = false`,
    [MANUAL_ONLY_SLUGS]
  );
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
