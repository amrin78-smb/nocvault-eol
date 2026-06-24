/**
 * Shared seed + feed-build/publish logic. Runs inside the Next app (API routes /
 * Netlify functions), where DATABASE_URL + FEED_SIGNING_KEY are ambient env and
 * @netlify/blobs authenticates automatically — no Netlify token needed.
 */
import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { query } from '@/lib/db';
import { normalizeForMatch, NORMALIZER_VERSION } from '@/lib/match-normalize';
import seedData from '@/data/netvault-seed.json';

const SCHEMA_VERSION = 1;

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

export type SeedResult = { entries: number; vendors: number; models: number; aliases: number };

/** Upsert the curated NetVault-derived seed into eol_models + model_aliases. Idempotent. */
export async function applyNetvaultSeed(): Promise<SeedResult> {
  const entries = seedData as SeedEntry[];
  let vendors = 0;
  let models = 0;
  let aliases = 0;

  for (const entry of entries) {
    const slug = vendorSlug(entry.vendor);
    const vIns = await query<{ id: number }>(
      `INSERT INTO vendors (slug, name) VALUES ($1, $2)
       ON CONFLICT (slug) DO NOTHING RETURNING id`,
      [slug, entry.vendor]
    );
    let vendorId: number;
    if (vIns.rows.length > 0) {
      vendorId = vIns.rows[0].id;
      vendors++;
    } else {
      const vSel = await query<{ id: number }>(`SELECT id FROM vendors WHERE slug = $1`, [slug]);
      vendorId = vSel.rows[0].id;
    }

    const modelRaw = entry.matches[0];
    const modelNormalized = normalizeForMatch(entry.vendor, modelRaw);
    const mIns = await query<{ id: number }>(
      `INSERT INTO eol_models
         (vendor_id, model_raw, model_normalized, end_of_sale, support_end_date,
          os_eol_date, confidence, source_url, note, entry_method, updated_at)
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
      [vendorId, modelRaw, modelNormalized, entry.support_end_date, entry.os_eol_date,
       entry.confidence, entry.source, entry.note]
    );
    const modelId = mIns.rows[0].id;
    models++;

    for (const alias of entry.matches.slice(1)) {
      const aIns = await query(
        `INSERT INTO model_aliases (eol_model_id, alias_raw, alias_normalized)
           VALUES ($1, $2, $3)
         ON CONFLICT (eol_model_id, alias_raw) DO NOTHING`,
        [modelId, alias, normalizeForMatch(entry.vendor, alias)]
      );
      aliases += aIns.rowCount ?? 0;
    }
  }
  return { entries: entries.length, vendors, models, aliases };
}

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

function canonicalFeedJson(feed: {
  schema_version: number; normalizer_version: number; feed_version: string;
  generated_at: string; row_count: number; models: FeedModel[];
}): string {
  const ordered = {
    schema_version: feed.schema_version,
    normalizer_version: feed.normalizer_version,
    feed_version: feed.feed_version,
    generated_at: feed.generated_at,
    row_count: feed.row_count,
    models: feed.models.map((m) => ({
      vendor: m.vendor, matches: m.matches, end_of_sale: m.end_of_sale,
      support_end_date: m.support_end_date, os_eol_date: m.os_eol_date,
      confidence: m.confidence, source: m.source, note: m.note,
    })),
  };
  return JSON.stringify(ordered, null, 2);
}

export type PublishResult = {
  feed_version: string;
  row_count: number;
  sha256: string;
  published: boolean;
  publish_note?: string;
};

/** Build the feed from eol_models, sign it, write it to Netlify Blobs, log the version. */
export async function buildAndPublishFeed(opts?: {
  feedVersion?: string;
  publishedBy?: string;
  generatedAt?: string;
}): Promise<PublishResult> {
  const signingKeyB64 = process.env.FEED_SIGNING_KEY;
  if (!signingKeyB64) throw new Error('FEED_SIGNING_KEY is not set');

  const feedVersion = opts?.feedVersion || `${new Date().toISOString().slice(0, 10)}.1`;
  const generatedAt = opts?.generatedAt || new Date().toISOString();

  const { rows } = await query<ModelRow>(
    `SELECT v.name AS vendor, m.model_raw,
            m.end_of_sale::text AS end_of_sale,
            m.support_end_date::text AS support_end_date,
            m.os_eol_date::text AS os_eol_date,
            m.confidence, m.source_url, m.note,
            COALESCE(array_agg(a.alias_raw ORDER BY a.alias_raw)
                       FILTER (WHERE a.alias_raw IS NOT NULL), '{}') AS aliases
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
  models.sort((a, b) => {
    const v = a.vendor.localeCompare(b.vendor);
    return v !== 0 ? v : a.matches[0].localeCompare(b.matches[0]);
  });

  const feed = {
    schema_version: SCHEMA_VERSION,
    normalizer_version: NORMALIZER_VERSION,
    feed_version: feedVersion,
    generated_at: generatedAt,
    row_count: models.length,
    models,
  };
  const canonical = canonicalFeedJson(feed);
  const bytes = Buffer.from(canonical, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const keyObject = createPrivateKey({
    key: Buffer.from(signingKeyB64, 'base64'), format: 'der', type: 'pkcs8',
  });
  const sigB64 = cryptoSign(null, bytes, keyObject).toString('base64');

  await query(
    `INSERT INTO feed_versions
       (feed_version, generated_at, row_count, content_sha256, signature,
        normalizer_version, published_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (feed_version) DO UPDATE SET
        generated_at = EXCLUDED.generated_at, row_count = EXCLUDED.row_count,
        content_sha256 = EXCLUDED.content_sha256, signature = EXCLUDED.signature,
        normalizer_version = EXCLUDED.normalizer_version, published_by = EXCLUDED.published_by`,
    [feedVersion, generatedAt, feed.row_count, sha256, sigB64,
     NORMALIZER_VERSION, opts?.publishedBy || 'app']
  );

  const latestJson = JSON.stringify({ feed_version: feedVersion, sha256, generated_at: generatedAt }, null, 2);

  // Publish to Netlify Blobs (ambient auth inside a Netlify function).
  let published = false;
  let publish_note: string | undefined;
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore('eol-feed');
    await store.set('feed.json', canonical);
    await store.set('feed.json.sig', sigB64);
    await store.set('latest.json', latestJson);
    published = true;
  } catch (err) {
    publish_note = err instanceof Error ? err.message : String(err);
  }

  return { feed_version: feedVersion, row_count: feed.row_count, sha256, published, publish_note };
}
