// lib/eol/os-feed.ts
//
// Apply the curated OS-branch corpus to the database, then build, sign and
// publish it as a THIRD signed feed.
//
// It deliberately mirrors lib/cve/feed.ts, which mirrors lib/feed-core.ts: same
// Ed25519 detached signature over canonical-JSON bytes, same sha256, same
// latest.json pointer, same headers. A consumer that can verify either existing
// feed needs no new verification code for this one.
//
// ⛔ ITS OWN BLOB STORE, 'os-feed'. NOT 'eol-feed', NOT 'cve-feed'. The EOL feed
// is live and NetVault reads it in production; writing feed.json into that store
// would replace the model catalogue with OS branches and the first symptom would
// be NetVault silently matching zero devices. Three products, three stores, no
// shared key names.

import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { rawQuery } from '../db';
import { ensureOsSchema } from './os-schema';
import { checkCycle, type OsCycle } from './os-cycles';

const OS_SCHEMA_VERSION = 1;

/**
 * The slice of Netlify Blobs this module uses.
 *
 * ⛔ A SEAM FOR ONE JOB: SUPPLYING THE STORE. `@netlify/blobs` only works inside
 * a Netlify function, so without this the entire publish path — idempotence, the
 * artefacts-present check, the "no audit row for a publish that did not happen"
 * rule — could only be verified by reading it. Every one of those three was a
 * REAL BUG on the CVE feed, and two of them produced a healthy-looking service
 * serving nothing.
 *
 * ⛔ IT SUPPLIES THE STORE AND NOTHING ELSE. An earlier seam in this repo (a
 * `now` parameter on the health check) quietly did two jobs — it fast-forwarded
 * a cooldown AND re-dated a liveness check — and silently turned a test fixture
 * into a different state than intended. One seam, one job.
 */
export type FeedBlobStore = {
  get(key: string, opts: { type: 'text' }): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};

async function netlifyStore(): Promise<FeedBlobStore> {
  const { getStore } = await import('@netlify/blobs');
  // ⛔ 'os-feed'. NOT 'eol-feed', NOT 'cve-feed'. See the header.
  return getStore('os-feed') as unknown as FeedBlobStore;
}

export type ApplyResult = {
  inserted: number;
  updated: number;
  removed: number;
  total: number;
  rejected: Array<{ cycle: string; reason: string }>;
};

/**
 * Upsert the curated corpus into `os_cycles`.
 *
 * ⛔ IT VALIDATES BEFORE IT WRITES, AND A BAD ROW STOPS THE WHOLE APPLY.
 * checkCycle is the same function the generator and the verifier use. A corpus
 * that fails it has either been hand-edited wrongly or built from a page whose
 * layout moved, and half-applying it would leave the database in a state no
 * file describes.
 *
 * ⛔ ROWS ABSENT FROM THE SEED ARE DELETED. The corpus is fully regenerated
 * every time, so a cycle that disappears upstream must disappear here — a stale
 * branch row would keep telling a consumer that a long-dead branch is the
 * vendor's current statement. This is safe precisely because the seed is
 * version-controlled: the file, not the table, is the source of truth.
 */
export async function applyOsCycles(cycles: OsCycle[]): Promise<ApplyResult> {
  await ensureOsSchema();

  const rejected = cycles
    .map((c) => checkCycle(c))
    .filter((v): v is NonNullable<typeof v> => v !== null)
    .map((v) => ({ cycle: v.cycle, reason: v.reason }));
  if (rejected.length) {
    return { inserted: 0, updated: 0, removed: 0, total: 0, rejected };
  }

  const before = await rawQuery<{ n: number }>('SELECT count(*)::int AS n FROM os_cycles');

  // ⛔ ONE ROUND TRIP, not one INSERT per row — the lesson ensureTargets()
  // learned when 32 sequential round trips ate a function's whole budget.
  await rawQuery(
    `INSERT INTO os_cycles
       (vendor, product, cycle, release_date, support_end_date, extended_end_date,
        latest_version, lts, confidence, source, vendor_link, note, applied_at)
     SELECT v, p, c, rd::date, sed::date, eed::date, lv, l, cf, s, vl, n, NOW()
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                   $7::text[], $8::boolean[], $9::text[], $10::text[], $11::text[], $12::text[])
              AS t(v, p, c, rd, sed, eed, lv, l, cf, s, vl, n)
     ON CONFLICT (vendor, product, cycle) DO UPDATE
        SET release_date = EXCLUDED.release_date,
            support_end_date = EXCLUDED.support_end_date,
            extended_end_date = EXCLUDED.extended_end_date,
            latest_version = EXCLUDED.latest_version,
            lts = EXCLUDED.lts,
            confidence = EXCLUDED.confidence,
            source = EXCLUDED.source,
            vendor_link = EXCLUDED.vendor_link,
            note = EXCLUDED.note,
            applied_at = NOW()`,
    [
      cycles.map((c) => c.vendor), cycles.map((c) => c.product), cycles.map((c) => c.cycle),
      cycles.map((c) => c.release_date), cycles.map((c) => c.support_end_date),
      cycles.map((c) => c.extended_end_date), cycles.map((c) => c.latest_version),
      cycles.map((c) => c.lts), cycles.map((c) => c.confidence), cycles.map((c) => c.source),
      cycles.map((c) => c.vendor_link), cycles.map((c) => c.note),
    ]
  );

  const del = await rawQuery(
    `DELETE FROM os_cycles
      WHERE (vendor, product, cycle) NOT IN (
        SELECT v, p, c FROM unnest($1::text[], $2::text[], $3::text[]) AS t(v, p, c))`,
    [cycles.map((c) => c.vendor), cycles.map((c) => c.product), cycles.map((c) => c.cycle)]
  );

  const after = await rawQuery<{ n: number }>('SELECT count(*)::int AS n FROM os_cycles');
  const removed = del.rowCount ?? 0;
  const total = after.rows[0]?.n ?? 0;
  const inserted = Math.max(0, total - (before.rows[0]?.n ?? 0) + removed);

  return { inserted, updated: cycles.length - inserted, removed, total, rejected: [] };
}

export type FeedCycle = {
  vendor: string;
  product: string;
  cycle: string;
  release_date: string | null;
  support_end_date: string | null;
  extended_end_date: string | null;
  latest_version: string | null;
  lts: boolean | null;
  confidence: string;
  source: string;
  vendor_link: string | null;
};

/**
 * ⛔ KEY ORDER IS NAMED EXPLICITLY, NOT INHERITED FROM THE ROW OBJECT. The
 * signature covers these exact bytes. Serialising a row straight from pg lets
 * column order or a future SELECT edit change the hash for identical data, and
 * every consumer re-downloads a feed that did not change.
 */
export function canonicalOsFeedJson(feed: {
  schema_version: number;
  feed_version: string;
  generated_at: string;
  row_count: number;
  cycles: FeedCycle[];
}): string {
  const ordered = {
    schema_version: feed.schema_version,
    feed_version: feed.feed_version,
    generated_at: feed.generated_at,
    row_count: feed.row_count,
    cycles: feed.cycles.map((c) => ({
      vendor: c.vendor,
      product: c.product,
      cycle: c.cycle,
      release_date: c.release_date,
      support_end_date: c.support_end_date,
      extended_end_date: c.extended_end_date,
      latest_version: c.latest_version,
      lts: c.lts,
      confidence: c.confidence,
      source: c.source,
      vendor_link: c.vendor_link,
    })),
  };
  return JSON.stringify(ordered, null, 2);
}

export type OsPublishResult = {
  feed_version: string;
  checked_at: string | null;
  unchanged?: boolean;
  row_count: number;
  sha256: string;
  bytes: number;
  by_product: Array<{ product: string; n: number }>;
  published: boolean;
  publish_note?: string;
};

export async function buildAndPublishOsFeed(opts?: {
  feedVersion?: string;
  publishedBy?: string;
  generatedAt?: string;
  /** Test-only. Defaults to the Netlify 'os-feed' store. */
  store?: FeedBlobStore;
}): Promise<OsPublishResult> {
  const signingKeyB64 = process.env.FEED_SIGNING_KEY;
  if (!signingKeyB64) throw new Error('FEED_SIGNING_KEY is not set');

  await ensureOsSchema();

  const today = new Date().toISOString().slice(0, 10);
  const generatedAt = opts?.generatedAt || new Date().toISOString();

  // ⛔ ORDER BY IS EXPLICIT AND TOTAL. Without it Postgres may return the same
  // rows in a different sequence, changing the bytes and therefore the signature
  // for a corpus that has not changed.
  //
  // ⛔ DATES ARE FORMATTED, NOT HANDED TO JSON.stringify. A pg `date` arrives as
  // a JS Date, which serialises to a full ISO timestamp in the SERVER's
  // timezone — the same class of bug as parseLifecycleDate's, one layer down,
  // and it would both bloat the bytes and shift dates for anyone running this
  // outside UTC. to_char keeps them YYYY-MM-DD text, as the seed has them.
  const { rows } = await rawQuery<FeedCycle>(
    `SELECT vendor, product, cycle,
            to_char(release_date, 'YYYY-MM-DD') AS release_date,
            to_char(support_end_date, 'YYYY-MM-DD') AS support_end_date,
            to_char(extended_end_date, 'YYYY-MM-DD') AS extended_end_date,
            latest_version, lts, confidence, source, vendor_link
       FROM os_cycles
      ORDER BY vendor ASC, product ASC, cycle ASC`
  );

  // ⛔ THE PAYLOAD-ONLY DIGEST, computed before a version exists. See os-schema.
  const cyclesSha = createHash('sha256')
    .update(canonicalOsFeedJson({
      schema_version: OS_SCHEMA_VERSION,
      feed_version: '', generated_at: '', row_count: rows.length, cycles: rows,
    }))
    .digest('hex');

  // ⛔ LIVENESS FOR A HUMAN-CURATED CORPUS IS NOT "WHEN DID WE PUBLISH".
  //
  // This corpus is refreshed by a person running `npm run build:os-cycles`, so
  // generated_at says only when someone last did that — a corpus untouched for
  // three months is indistinguishable from a hub that died three months ago.
  //
  // So checked_at is MAX(eol_watch_sources.last_success_at): the last time the
  // daily watch successfully READ the upstream pages this corpus is built from.
  // It advances every day the hub is healthy, whether or not anything changed,
  // and stops the moment the hub does. ⛔ It REUSES the watch's existing
  // timestamp rather than defining a second notion of "alive", exactly as
  // STALL_HOURS reuses MAX(last_success_at) from cve_ingest_state.
  let checkedAt: string | null = null;
  try {
    const r = await rawQuery<{ checked_at: string | null }>(
      `SELECT to_char(MAX(last_success_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS checked_at
         FROM eol_watch_sources`
    );
    checkedAt = r.rows[0]?.checked_at ?? null;
  } catch {
    // The watch tables may not exist yet on a fresh database. A missing liveness
    // signal is reported as null, never faked with "now".
    checkedAt = null;
  }

  const prior = await rawQuery<{ feed_version: string; cycles_sha256: string | null }>(
    `SELECT feed_version, cycles_sha256 FROM os_feed_versions
      ORDER BY generated_at DESC LIMIT 1`
  );

  // ⛔ AN UNCHANGED CORPUS PUBLISHES NOTHING AND KEEPS ITS VERSION. A version
  // identifies bytes; republishing one version with different bytes breaks the
  // only cheap thing a consumer can do — read latest.json and skip a download it
  // already holds.
  if (!opts?.feedVersion && prior.rows[0] && prior.rows[0].cycles_sha256 === cyclesSha) {
    // ⛔ "UNCHANGED" MUST MEAN "STILL PUBLISHED AND UNCHANGED". The digest lives
    // in the DATABASE and the artefacts live in BLOBS, so they can disagree. An
    // empty store with an intact database made the CVE feed take this path
    // forever — pointer rewritten, feed.json never written again, /latest 200,
    // the feed 503, and the route reporting ok throughout.
    let artefactsPresent = false;
    try {
      const store = opts?.store ?? (await netlifyStore());
      const [existing, feedBlob, sigBlob] = await Promise.all([
        store.get('latest.json', { type: 'text' }),
        store.get('feed.json', { type: 'text' }),
        store.get('feed.json.sig', { type: 'text' }),
      ]);
      let parsed: any = null;
      try { parsed = existing ? JSON.parse(existing) : null; } catch { parsed = null; }
      artefactsPresent = !!(feedBlob && sigBlob && parsed && parsed.feed_version);
      if (artefactsPresent) {
        await store.set('latest.json', JSON.stringify({ ...parsed, checked_at: checkedAt }, null, 2));
      }
    } catch {
      artefactsPresent = false;
    }

    if (artefactsPresent) {
      return {
        feed_version: prior.rows[0].feed_version,
        checked_at: checkedAt,
        unchanged: true,
        row_count: rows.length,
        sha256: '', bytes: 0, by_product: [],
        published: false,
        publish_note: 'corpus identical to the last published feed — nothing republished',
      };
    }
    // ⛔ FALL THROUGH AND REPUBLISH when the artefacts are not confirmed. The
    // idempotence guard exists to stop version churn, not to make a broken
    // publish permanent.
  }

  const seqRow = await rawQuery<{ n: number }>(
    `SELECT COALESCE(MAX(NULLIF(split_part(feed_version, '.', 2), '')::int), 0) + 1 AS n
       FROM os_feed_versions
      WHERE feed_version LIKE $1 || '.%'`,
    [today]
  );
  const feedVersion = opts?.feedVersion || `${today}.${seqRow.rows[0]?.n ?? 1}`;

  const feed = {
    schema_version: OS_SCHEMA_VERSION,
    feed_version: feedVersion,
    generated_at: generatedAt,
    row_count: rows.length,
    cycles: rows,
  };

  const canonical = canonicalOsFeedJson(feed);
  const bytes = Buffer.from(canonical, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const keyObject = createPrivateKey({
    key: Buffer.from(signingKeyB64, 'base64'), format: 'der', type: 'pkcs8',
  });
  const sigB64 = cryptoSign(null, bytes, keyObject).toString('base64');

  const latestJson = JSON.stringify(
    {
      feed_version: feedVersion,
      sha256,
      generated_at: generatedAt,
      checked_at: checkedAt,
      row_count: feed.row_count,
    },
    null,
    2
  );

  // ⛔ BLOBS FIRST, AUDIT ROW ONLY IF ALL THREE LAND, AND THE SIGNATURE FIRST OF
  // THE THREE. A feed.json without a matching .sig is the state that breaks
  // consumers, so it is the one that must never exist alone. Recording the row
  // before the writes let a partial publish (new feed.json, old .sig) satisfy
  // the idempotence guard above and make a broken signature permanent.
  let published = false;
  let publish_note: string | undefined;
  try {
    const store = opts?.store ?? (await netlifyStore());
    await store.set('feed.json.sig', sigB64);
    await store.set('feed.json', canonical);
    await store.set('latest.json', latestJson);
    published = true;
  } catch (err) {
    publish_note = err instanceof Error ? err.message : String(err);
  }

  if (!published) {
    // ⛔ NO AUDIT ROW FOR A PUBLISH THAT DID NOT HAPPEN, or the next run treats
    // this corpus as already shipped.
    return {
      feed_version: feedVersion,
      checked_at: checkedAt,
      row_count: feed.row_count,
      sha256,
      bytes: bytes.length,
      by_product: [],
      published: false,
      publish_note: `blob write FAILED, no version recorded so the next run retries: ${publish_note}`,
    };
  }

  // ⛔ DO NOTHING, NOT DO UPDATE, for an auto-allocated version. The sequence is
  // read then inserted with no lock, so the dashboard button and the scheduled
  // function can compute the same n — and DO UPDATE would rewrite the audit row
  // for a version whose bytes a consumer may already hold.
  const conflictClause = opts?.feedVersion
    ? `ON CONFLICT (feed_version) DO UPDATE SET
         generated_at = EXCLUDED.generated_at, row_count = EXCLUDED.row_count,
         content_sha256 = EXCLUDED.content_sha256, cycles_sha256 = EXCLUDED.cycles_sha256,
         signature = EXCLUDED.signature, published_by = EXCLUDED.published_by`
    : 'ON CONFLICT (feed_version) DO NOTHING';

  await rawQuery(
    `INSERT INTO os_feed_versions
       (feed_version, generated_at, row_count, content_sha256, cycles_sha256, signature, published_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ${conflictClause}`,
    [feedVersion, generatedAt, feed.row_count, sha256, cyclesSha, sigB64, opts?.publishedBy || 'app']
  );

  const byProduct = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.vendor} ${r.product}`;
    byProduct.set(k, (byProduct.get(k) || 0) + 1);
  }

  return {
    feed_version: feedVersion,
    checked_at: checkedAt,
    row_count: feed.row_count,
    sha256,
    bytes: bytes.length,
    by_product: [...byProduct].map(([product, n]) => ({ product, n })).sort((a, b) => b.n - a.n),
    published,
    publish_note,
  };
}

/** Corpus state for the dashboard. Read-only, no network. */
export async function osFeedStatus(): Promise<{
  total: number;
  byProduct: Array<{ vendor: string; product: string; n: number; supported: number; eol: number }>;
  latest: { feed_version: string; generated_at: string; row_count: number } | null;
  appliedAt: string | null;
}> {
  await ensureOsSchema();
  const t = await rawQuery<{ n: number }>('SELECT count(*)::int AS n FROM os_cycles');
  const p = await rawQuery<any>(
    `SELECT vendor, product, count(*)::int AS n,
            count(*) FILTER (WHERE support_end_date >= CURRENT_DATE
                                OR extended_end_date >= CURRENT_DATE)::int AS supported,
            count(*) FILTER (WHERE COALESCE(extended_end_date, support_end_date) < CURRENT_DATE)::int AS eol
       FROM os_cycles GROUP BY vendor, product ORDER BY vendor, product`
  );
  const v = await rawQuery<any>(
    `SELECT feed_version, to_char(generated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS generated_at,
            row_count FROM os_feed_versions ORDER BY generated_at DESC LIMIT 1`
  );
  const a = await rawQuery<any>(
    `SELECT to_char(MAX(applied_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS applied_at FROM os_cycles`
  );
  return {
    total: t.rows[0]?.n ?? 0,
    byProduct: p.rows,
    latest: v.rows[0] ?? null,
    appliedAt: a.rows[0]?.applied_at ?? null,
  };
}
