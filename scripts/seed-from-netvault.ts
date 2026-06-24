/**
 * Seed the central EOL DB from the NetVault-derived seed file
 * (data/netvault-seed.json).
 *
 * Standalone tsx script — uses RELATIVE imports (the '@/...' alias only works in
 * app/ code). Idempotent: re-running upserts and leaves data consistent.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { normalizeForMatch } from '../lib/match-normalize.ts';

type SeedEntry = {
  key: string;
  vendor: string;
  matches: string[];
  support_end_date: string | null;
  os_eol_date: string | null;
  confidence: 'high' | 'medium' | 'low';
  source: string | null;
  note: string | null;
};

function vendorSlug(vendor: string): string {
  return vendor.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Safety net so `npm run seed` works on a fresh Neon DB without first deploying the
// app. Canonical schema lives in lib/init.ts; these are IF NOT EXISTS no-ops once the
// app has run its own init. Only the tables this script writes.
async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS vendors (
    id SERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    manual_only BOOLEAN DEFAULT false, lifecycle_source_url TEXT, notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS eol_models (
    id SERIAL PRIMARY KEY, vendor_id INTEGER REFERENCES vendors(id),
    model_raw TEXT NOT NULL, model_normalized TEXT NOT NULL,
    end_of_sale DATE, support_end_date DATE, os_eol_date DATE,
    confidence TEXT DEFAULT 'medium', source_url TEXT, note TEXT,
    verified BOOLEAN DEFAULT false, verified_at TIMESTAMPTZ,
    entry_method TEXT DEFAULT 'manual',
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS model_aliases (
    id SERIAL PRIMARY KEY,
    eol_model_id INTEGER REFERENCES eol_models(id) ON DELETE CASCADE,
    alias_raw TEXT NOT NULL, alias_normalized TEXT NOT NULL)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_eol_models_vendor_model
    ON eol_models (vendor_id, model_normalized)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_model_aliases_model_alias
    ON model_aliases (eol_model_id, alias_raw)`);
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  const seedPath = resolve(import.meta.dirname, '..', 'data', 'netvault-seed.json');
  const entries: SeedEntry[] = JSON.parse(readFileSync(seedPath, 'utf8'));

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });

  let vendorCount = 0;
  let modelCount = 0;
  let aliasCount = 0;

  try {
    await ensureSchema(pool);
    for (const entry of entries) {
      const vendor = entry.vendor;
      const slug = vendorSlug(vendor);

      // Upsert vendor — get its id whether it was just inserted or already existed.
      const vIns = await pool.query<{ id: number }>(
        `INSERT INTO vendors (slug, name)
           VALUES ($1, $2)
         ON CONFLICT (slug) DO NOTHING
         RETURNING id`,
        [slug, vendor]
      );
      let vendorId: number;
      if (vIns.rows.length > 0) {
        vendorId = vIns.rows[0].id;
        vendorCount++;
      } else {
        const vSel = await pool.query<{ id: number }>(
          `SELECT id FROM vendors WHERE slug = $1`,
          [slug]
        );
        vendorId = vSel.rows[0].id;
      }

      const modelRaw = entry.matches[0];
      const modelNormalized = normalizeForMatch(vendor, modelRaw);

      // Upsert the model. end_of_sale stays null at the seed stage.
      const mIns = await pool.query<{ id: number }>(
        `INSERT INTO eol_models
           (vendor_id, model_raw, model_normalized,
            end_of_sale, support_end_date, os_eol_date,
            confidence, source_url, note, entry_method, updated_at)
         VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, 'seed', now())
         ON CONFLICT (vendor_id, model_normalized) DO UPDATE SET
            support_end_date = EXCLUDED.support_end_date,
            os_eol_date      = EXCLUDED.os_eol_date,
            confidence       = EXCLUDED.confidence,
            source_url       = EXCLUDED.source_url,
            note             = EXCLUDED.note,
            entry_method     = 'seed',
            updated_at       = now()
         RETURNING id`,
        [
          vendorId,
          modelRaw,
          modelNormalized,
          entry.support_end_date,
          entry.os_eol_date,
          entry.confidence,
          entry.source,
          entry.note,
        ]
      );
      const modelId = mIns.rows[0].id;
      modelCount++;

      // Aliases: matches[1..]
      for (const alias of entry.matches.slice(1)) {
        const aliasNormalized = normalizeForMatch(vendor, alias);
        const aIns = await pool.query(
          `INSERT INTO model_aliases (eol_model_id, alias_raw, alias_normalized)
             VALUES ($1, $2, $3)
           ON CONFLICT (eol_model_id, alias_raw) DO NOTHING`,
          [modelId, alias, aliasNormalized]
        );
        aliasCount += aIns.rowCount ?? 0;
      }
    }
  } finally {
    await pool.end();
  }

  console.log('Seed complete:');
  console.log(`  entries processed : ${entries.length}`);
  console.log(`  vendors inserted  : ${vendorCount}`);
  console.log(`  models upserted   : ${modelCount}`);
  console.log(`  aliases inserted  : ${aliasCount}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
