/**
 * Build, sign, and publish the EOL feed artifact.
 *
 * Standalone tsx script — RELATIVE imports only.
 *
 *  1. Read eol_models JOIN vendors (+ aggregated aliases) from the DB.
 *  2. Build the canonical Feed JSON (dates read as ::text to avoid tz drift).
 *  3. Deterministic serialization: models sorted by vendor then model_raw,
 *     stable object key order. sha256 over the canonical UTF-8 bytes.
 *  4. Detached Ed25519 signature over the canonical bytes (FEED_SIGNING_KEY,
 *     base64 pkcs8 DER) via node:crypto sign(null, data, keyObject).
 *  5. Write dist/feed/{feed.json, feed.json.sig, latest.json}.
 *  6. INSERT a feed_versions row.
 *  7. Best-effort publish to Netlify Blobs (store 'eol-feed').
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { Pool } from 'pg';
import { NORMALIZER_VERSION } from '../lib/match-normalize';

const SCHEMA_VERSION = 1;

type ModelRow = {
  vendor: string;
  model_raw: string;
  end_of_sale: string | null;
  support_end_date: string | null;
  os_eol_date: string | null;
  confidence: 'high' | 'medium' | 'low';
  source_url: string | null;
  note: string | null;
  aliases: string[] | null;
};

type FeedModel = {
  vendor: string;
  matches: string[];
  end_of_sale: string | null;
  support_end_date: string | null;
  os_eol_date: string | null;
  confidence: 'high' | 'medium' | 'low';
  source: string | null;
  note: string | null;
};

type Feed = {
  schema_version: number;
  normalizer_version: number;
  feed_version: string;
  generated_at: string;
  row_count: number;
  models: FeedModel[];
};

/**
 * Canonical JSON serialization: object keys are emitted in a fixed order so the
 * bytes (and therefore the hash and signature) are reproducible.
 */
function canonicalFeedJson(feed: Feed): string {
  const model = (m: FeedModel) => ({
    vendor: m.vendor,
    matches: m.matches,
    end_of_sale: m.end_of_sale,
    support_end_date: m.support_end_date,
    os_eol_date: m.os_eol_date,
    confidence: m.confidence,
    source: m.source,
    note: m.note,
  });
  const ordered = {
    schema_version: feed.schema_version,
    normalizer_version: feed.normalizer_version,
    feed_version: feed.feed_version,
    generated_at: feed.generated_at,
    row_count: feed.row_count,
    models: feed.models.map(model),
  };
  return JSON.stringify(ordered, null, 2);
}

async function publishToBlobs(
  feedJson: string,
  sigB64: string,
  latestJson: string
): Promise<void> {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore('eol-feed');
    await store.set('feed.json', feedJson);
    await store.set('feed.json.sig', sigB64);
    await store.set('latest.json', latestJson);
    console.log('Published feed.json, feed.json.sig, latest.json to Netlify Blobs.');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`skipped blobs: ${reason}`);
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  const signingKeyB64 = process.env.FEED_SIGNING_KEY;
  if (!signingKeyB64) {
    throw new Error('FEED_SIGNING_KEY is not set');
  }

  const feedVersion =
    process.env.FEED_VERSION || `${new Date().toISOString().slice(0, 10)}.1`;
  const generatedAt = new Date().toISOString();

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });

  let feed: Feed;
  let canonical: string;
  let sha256: string;
  let sigB64: string;

  try {
    const { rows } = await pool.query<ModelRow>(
      `SELECT
          v.name AS vendor,
          m.model_raw,
          m.end_of_sale::text       AS end_of_sale,
          m.support_end_date::text  AS support_end_date,
          m.os_eol_date::text       AS os_eol_date,
          m.confidence,
          m.source_url,
          m.note,
          COALESCE(
            array_agg(a.alias_raw ORDER BY a.alias_raw)
              FILTER (WHERE a.alias_raw IS NOT NULL),
            '{}'
          ) AS aliases
        FROM eol_models m
        JOIN vendors v ON v.id = m.vendor_id
        LEFT JOIN model_aliases a ON a.eol_model_id = m.id
        GROUP BY v.name, m.id`
    );

    const models: FeedModel[] = rows.map((r) => ({
      vendor: r.vendor,
      matches: [r.model_raw, ...(r.aliases ?? [])],
      end_of_sale: r.end_of_sale,
      support_end_date: r.support_end_date,
      os_eol_date: r.os_eol_date,
      confidence: r.confidence,
      source: r.source_url,
      note: r.note,
    }));

    // Deterministic order: vendor, then model_raw (matches[0]).
    models.sort((a, b) => {
      const v = a.vendor.localeCompare(b.vendor);
      if (v !== 0) return v;
      return a.matches[0].localeCompare(b.matches[0]);
    });

    feed = {
      schema_version: SCHEMA_VERSION,
      normalizer_version: NORMALIZER_VERSION,
      feed_version: feedVersion,
      generated_at: generatedAt,
      row_count: models.length,
      models,
    };

    canonical = canonicalFeedJson(feed);
    const bytes = Buffer.from(canonical, 'utf8');

    sha256 = createHash('sha256').update(bytes).digest('hex');

    const keyObject = createPrivateKey({
      key: Buffer.from(signingKeyB64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    sigB64 = cryptoSign(null, bytes, keyObject).toString('base64');

    // Record this feed version in the DB.
    await pool.query(
      `INSERT INTO feed_versions
         (feed_version, generated_at, row_count, content_sha256,
          signature, normalizer_version, published_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (feed_version) DO UPDATE SET
          generated_at       = EXCLUDED.generated_at,
          row_count          = EXCLUDED.row_count,
          content_sha256     = EXCLUDED.content_sha256,
          signature          = EXCLUDED.signature,
          normalizer_version = EXCLUDED.normalizer_version,
          published_by       = EXCLUDED.published_by`,
      [
        feedVersion,
        generatedAt,
        feed.row_count,
        sha256,
        sigB64,
        NORMALIZER_VERSION,
        process.env.FEED_PUBLISHED_BY || 'build-feed',
      ]
    );
  } finally {
    await pool.end();
  }

  const latest = {
    feed_version: feedVersion,
    sha256,
    generated_at: generatedAt,
  };
  const latestJson = JSON.stringify(latest, null, 2);

  const outDir = resolve(__dirname, '..', 'dist', 'feed');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'feed.json'), canonical, 'utf8');
  writeFileSync(resolve(outDir, 'feed.json.sig'), sigB64, 'utf8');
  writeFileSync(resolve(outDir, 'latest.json'), latestJson, 'utf8');

  console.log(`Built feed ${feedVersion}: ${feed.row_count} models.`);
  console.log(`  sha256: ${sha256}`);
  console.log(`  wrote ${outDir}/{feed.json, feed.json.sig, latest.json}`);

  await publishToBlobs(canonical, sigB64, latestJson);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
