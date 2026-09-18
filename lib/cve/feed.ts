// lib/cve/feed.ts
//
// Build, sign and publish the CVE feed. Deliberately mirrors lib/feed-core.ts's
// buildAndPublishFeed() — same Ed25519 detached signature over the same
// canonical-JSON bytes, same sha256, same blob+pointer shape — so a consumer
// that can already verify the EOL feed needs no new verification code.
//
// ⛔ ITS OWN BLOB STORE ('cve-feed'), NEVER 'eol-feed'. The EOL feed is LIVE and
// NetVault reads it in production. Writing feed.json into the same store would
// replace the EOL feed with CVE data, and the first symptom would be NetVault
// silently matching zero devices. Two products, two stores, no shared keys.
//
// ⛔ ITS OWN VERSION LOG (cve_feed_versions), for the same reason the tables are
// separate: a CVE bug must not be able to corrupt the EOL feed's audit trail.

import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { rawQuery } from '../db';
import { ensureCveSchema } from './schema';

const CVE_SCHEMA_VERSION = 1;

export type FeedAdvisory = {
  cve_id: string;
  vendor: string;
  title: string | null;
  description: string | null;
  cvss_score: number | null;
  cvss_vector: string | null;
  cvss_version: string | null;
  cvss_source: string | null;
  published_at: string | null;
  affected_version_ranges: unknown;
  fixed_in_versions: unknown;
  advisory_url: string | null;
  cwe_ids: string[] | null;
  matchability: string | null;
};

/**
 * ⛔ KEY ORDER IS FIXED HERE AND NOT INHERITED FROM THE ROW. The signature
 * covers these exact bytes, so anything that can reorder keys changes the hash
 * for identical data. jsonb does not preserve key order — it returns keys
 * sorted by length then bytes — so serialising a row object directly would
 * produce a different signature run to run for unchanged data, and every
 * consumer would re-download a feed that had not changed.
 */
function canonicalCveFeedJson(feed: {
  schema_version: number;
  feed_version: string;
  generated_at: string;
  row_count: number;
  advisories: FeedAdvisory[];
}): string {
  const ordered = {
    schema_version: feed.schema_version,
    feed_version: feed.feed_version,
    generated_at: feed.generated_at,
    row_count: feed.row_count,
    advisories: feed.advisories.map((a) => ({
      cve_id: a.cve_id,
      vendor: a.vendor,
      title: a.title,
      description: a.description,
      cvss_score: a.cvss_score,
      cvss_vector: a.cvss_vector,
      cvss_version: a.cvss_version,
      cvss_source: a.cvss_source,
      published_at: a.published_at,
      affected_version_ranges: a.affected_version_ranges,
      fixed_in_versions: a.fixed_in_versions,
      advisory_url: a.advisory_url,
      cwe_ids: a.cwe_ids,
      matchability: a.matchability,
    })),
  };
  return JSON.stringify(ordered, null, 2);
}

export type CvePublishResult = {
  feed_version: string;
  row_count: number;
  sha256: string;
  bytes: number;
  by_vendor: Array<{ vendor: string; n: number }>;
  by_matchability: Array<{ matchability: string; n: number }>;
  published: boolean;
  publish_note?: string;
};

export async function buildAndPublishCveFeed(opts?: {
  feedVersion?: string;
  publishedBy?: string;
  generatedAt?: string;
}): Promise<CvePublishResult> {
  const signingKeyB64 = process.env.FEED_SIGNING_KEY;
  if (!signingKeyB64) throw new Error('FEED_SIGNING_KEY is not set');

  await ensureCveSchema();

  const feedVersion = opts?.feedVersion || `${new Date().toISOString().slice(0, 10)}.1`;
  const generatedAt = opts?.generatedAt || new Date().toISOString();

  // ⛔ raw_data IS NOT CARRIED. Measured at Phase 0: it is ~84% of each row and
  // no consumer needs it — matching runs off the extracted ranges. Shipping it
  // would multiply every customer's download for data none of them read.
  //
  // ⛔ ORDER BY is EXPLICIT AND TOTAL. Without a deterministic order Postgres
  // may return the same rows in a different sequence, changing the bytes and
  // therefore the signature for a feed whose content has not changed.
  const { rows } = await rawQuery<FeedAdvisory>(
    `SELECT cve_id, vendor, title, description,
            cvss_score::float8 AS cvss_score,
            cvss_vector, cvss_version, cvss_source,
            to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS published_at,
            affected_version_ranges, fixed_in_versions,
            advisory_url, cwe_ids, matchability
       FROM cve_advisories
      ORDER BY vendor ASC, cve_id ASC`
  );

  const feed = {
    schema_version: CVE_SCHEMA_VERSION,
    feed_version: feedVersion,
    generated_at: generatedAt,
    row_count: rows.length,
    advisories: rows,
  };

  const canonical = canonicalCveFeedJson(feed);
  const bytes = Buffer.from(canonical, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const keyObject = createPrivateKey({
    key: Buffer.from(signingKeyB64, 'base64'), format: 'der', type: 'pkcs8',
  });
  const sigB64 = cryptoSign(null, bytes, keyObject).toString('base64');

  await rawQuery(
    `INSERT INTO cve_feed_versions
       (feed_version, generated_at, row_count, content_sha256, signature, published_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (feed_version) DO UPDATE SET
        generated_at = EXCLUDED.generated_at, row_count = EXCLUDED.row_count,
        content_sha256 = EXCLUDED.content_sha256, signature = EXCLUDED.signature,
        published_by = EXCLUDED.published_by`,
    [feedVersion, generatedAt, feed.row_count, sha256, sigB64, opts?.publishedBy || 'app']
  );

  const latestJson = JSON.stringify(
    { feed_version: feedVersion, sha256, generated_at: generatedAt, row_count: feed.row_count },
    null,
    2
  );

  let published = false;
  let publish_note: string | undefined;
  try {
    const { getStore } = await import('@netlify/blobs');
    // ⛔ 'cve-feed', NOT 'eol-feed'. See the header.
    const store = getStore('cve-feed');
    await store.set('feed.json', canonical);
    await store.set('feed.json.sig', sigB64);
    await store.set('latest.json', latestJson);
    published = true;
  } catch (err) {
    publish_note = err instanceof Error ? err.message : String(err);
  }

  const byVendor = new Map<string, number>();
  const byMatch = new Map<string, number>();
  for (const r of rows) {
    byVendor.set(r.vendor, (byVendor.get(r.vendor) || 0) + 1);
    const m = r.matchability || '(null)';
    byMatch.set(m, (byMatch.get(m) || 0) + 1);
  }

  return {
    feed_version: feedVersion,
    row_count: feed.row_count,
    sha256,
    bytes: bytes.length,
    by_vendor: [...byVendor].map(([vendor, n]) => ({ vendor, n })).sort((a, b) => b.n - a.n),
    by_matchability: [...byMatch].map(([matchability, n]) => ({ matchability, n })).sort((a, b) => b.n - a.n),
    published,
    publish_note,
  };
}
