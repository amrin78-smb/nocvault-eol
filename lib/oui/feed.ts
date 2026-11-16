// lib/oui/feed.ts
//
// Refresh the OUI catalogue from the IEEE registries, then build, sign and
// publish it as a FOURTH signed feed.
//
// ⛔ THIS ONE FETCHES ON A SCHEDULE, AND THAT IS NOT THE SCRAPER THIS REPO
// DELETED. The distinction matters enough to state plainly, because the OS
// lifecycle corpus three files away does the OPPOSITE and for good reason:
//
//   - REFUSED (the deleted scrapers, and the EOL watch's reason for existing):
//     a scheduled job that INFERS DATES from vendor prose and writes them into a
//     feed nobody reviews. Every row is a judgement call, and a wrong one is a
//     confident lie about a customer's device.
//   - THIS: a verbatim copy of an official REGISTRY. There is no judgement in a
//     row — IEEE says prefix 00000C belongs to Cisco, and that is the entire
//     fact. Committing 54,000 such rows to git would produce a diff nobody
//     reads, and a review nobody performs is worse than an honest absence of one.
//
// ⛔ BUT "A 200 IS NOT THE DOCUMENT" STILL APPLIES, so a refresh is ADMITTED or
// REFUSED before it replaces anything: per-registry row floors, all three
// registries present, and six spot checks with known-good answers. A refusal
// KEEPS the existing catalogue. See lib/oui/parse.ts admit().

import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { rawQuery } from '../db';
import { ensureOuiSchema } from './schema';
import { OUI_SOURCES } from './sources';
import {
  parseRegistryCsv, admit, buildLookupTable, OUI_MATCH_VERSION,
  type OuiAssignment, type OuiLookup,
} from './parse';

const OUI_FEED_SCHEMA_VERSION = 1;
const FETCH_MS = 25000;

export type FeedBlobStore = {
  get(key: string, opts: { type: 'text' }): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};

async function netlifyStore(): Promise<FeedBlobStore> {
  const { getStore } = await import('@netlify/blobs');
  // ⛔ 'oui-feed'. NOT 'eol-feed', 'cve-feed' or 'os-feed'. Four products, four
  // stores, no shared key names — the EOL store is read by NetVault in
  // production and writing into it would replace the model catalogue.
  return getStore('oui-feed') as unknown as FeedBlobStore;
}

export type RefreshResult = {
  ok: boolean;
  admitted: boolean;
  total: number;
  perRegistry: Array<{ registry: string; rows: number; status: number | null; error?: string }>;
  reasons: string[];
  skippedRows: number;
  replaced: boolean;
};

/**
 * Fetch all three registries, admit or refuse, and replace the catalogue only
 * on success.
 */
export async function refreshOuiCatalogue(opts?: {
  fetchImpl?: (url: string) => Promise<{ status: number; text: string }>;
}): Promise<RefreshResult> {
  await ensureOuiSchema();

  const doFetch = opts?.fetchImpl ?? (async (url: string) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_MS);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'nocvault-eol/1.0 (+https://nocvault-eol.netlify.app)' },
        signal: ctl.signal,
      });
      return { status: res.status, text: await res.text() };
    } finally { clearTimeout(timer); }
  });

  const all: OuiAssignment[] = [];
  const perRegistry: RefreshResult['perRegistry'] = [];
  const floors: Array<{ registry: any; rows: number; minRows: number }> = [];
  let skippedRows = 0;

  for (const src of OUI_SOURCES) {
    await rawQuery(
      `INSERT INTO oui_refresh_state (registry, url, last_attempt_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (registry) DO UPDATE SET url = EXCLUDED.url, last_attempt_at = NOW()`,
      [src.registry, src.url]
    );

    // ⛔ EXACTLY ONE ENTRY PER REGISTRY, PUSHED AFTER EVERYTHING THAT CAN THROW.
    // The first draft pushed the good result, then wrote to the database, and
    // pushed AGAIN from the catch when that write failed — so admit() saw a
    // phantom zero row beside a healthy one and refused a perfectly good
    // refresh. r.total said 30 while the verdict said "0 assignments", which is
    // how the verifier found it. A loop that can report the same subject twice
    // is a loop whose verdict depends on which copy is read.
    let rows = 0;
    let status: number | null = null;
    let error: string | undefined;
    let parsed: OuiAssignment[] = [];
    try {
      const got = await doFetch(src.url);
      status = got.status;
      if (got.status !== 200) throw new Error(`registry responded HTTP ${got.status}`);
      const out = parseRegistryCsv(got.text, src.registry, src.prefixChars);
      parsed = out.assignments;
      rows = out.assignments.length;
      skippedRows += out.skipped.length;
      if (rows === 0) {
        error = `parsed 0 assignments from ${got.text.length} bytes — not the registry we expected`;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    if (!error) all.push(...parsed);
    perRegistry.push({ registry: src.registry, rows, status, ...(error ? { error } : {}) });
    floors.push({ registry: src.registry, rows, minRows: src.minRows });

    // ⛔ EVERY PARAMETER USED INSIDE A `CASE WHEN ... IS NULL` IS CAST. Postgres
    // cannot infer the type of a parameter whose only appearance is a null test,
    // and the failure is `42P08 inconsistent types deduced for parameter`. This
    // repo has now hit that twice: lib/cve/health-alerts.ts fired it only on the
    // recovery path, and it fired here on the SUCCESS path — where the thrown
    // error was swallowed by the catch and turned into a refused refresh.
    await rawQuery(
      `UPDATE oui_refresh_state
          SET last_status = $2::int,
              last_rows = $3::int,
              last_error = $4::text,
              consecutive_failures = CASE WHEN $4::text IS NULL THEN 0 ELSE consecutive_failures + 1 END,
              last_success_at = CASE WHEN $4::text IS NULL THEN NOW() ELSE last_success_at END
        WHERE registry = $1::text`,
      [src.registry, status, rows, error ? error.slice(0, 400) : null]
    );
  }

  const table = buildLookupTable(all as unknown as OuiLookup[]);
  const verdict = admit(floors, table);

  if (!verdict.ok) {
    // ⛔ A REFUSED REFRESH CHANGES NOTHING. Overwriting 54,000 good assignments
    // with a truncated download is a silent, total loss of MAC-vendor
    // resolution in three apps — and it would look like a successful run.
    return {
      ok: false, admitted: false, total: all.length, perRegistry,
      reasons: verdict.reasons, skippedRows, replaced: false,
    };
  }

  // ⛔ REPLACE WHOLESALE, INSIDE ONE STATEMENT PER STEP. The registry is
  // authoritative: a prefix it no longer lists must not survive here. Delete
  // after insert so a crash between the two leaves a superset, never a gap.
  const CHUNK = 5000;
  for (let i = 0; i < all.length; i += CHUNK) {
    const slice = all.slice(i, i + CHUNK);
    await rawQuery(
      `INSERT INTO oui_assignments
         (prefix, prefix_bits, registry, org, is_registry_block, source, confidence, refreshed_at)
       SELECT p, b, r, o, irb, s, 'high', NOW()
         FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::boolean[], $6::text[])
                AS t(p, b, r, o, irb, s)
       ON CONFLICT (prefix) DO UPDATE
          SET prefix_bits = EXCLUDED.prefix_bits, registry = EXCLUDED.registry,
              org = EXCLUDED.org, is_registry_block = EXCLUDED.is_registry_block,
              source = EXCLUDED.source, confidence = 'high', refreshed_at = NOW()`,
      [
        slice.map((a) => a.prefix), slice.map((a) => a.prefix_bits),
        slice.map((a) => a.registry), slice.map((a) => a.org),
        slice.map((a) => a.is_registry_block),
        slice.map((a) => OUI_SOURCES.find((s) => s.registry === a.registry)!.url),
      ]
    );
  }
  await rawQuery(
    `DELETE FROM oui_assignments WHERE prefix <> ALL($1::text[])`,
    [all.map((a) => a.prefix)]
  );

  return {
    ok: true, admitted: true, total: all.length, perRegistry,
    reasons: [], skippedRows, replaced: true,
  };
}

export type FeedEntry = [string, number, string, 0 | 1];

/**
 * ⛔ COMPACT, AND THE ONLY FEED IN THIS REPO THAT IS NOT PRETTY-PRINTED.
 *
 * 54,469 rows as named objects at indent 2 is roughly 6.5 MB; as positional
 * tuples with no indentation it is under 2 MB. The other three feeds are
 * pretty-printed because a human occasionally reads them; nobody reads a MAC
 * lookup table by eye, and every consumer pays for the difference on every
 * pull. ⛔ Canonicality is unaffected — determinism comes from fixed field
 * ORDER and a total row ORDER, not from whitespace.
 *
 * Tuple layout is fixed and documented for consumers:
 *   [0] prefix (uppercase hex, no separators)
 *   [1] prefix_bits (24 | 28 | 36)
 *   [2] organisation ("Private" where the assignee withheld it)
 *   [3] is_registry_block (1 = the block is IEEE's own; NOT a device vendor)
 */
export function canonicalOuiFeedJson(feed: {
  schema_version: number;
  match_version: number;
  feed_version: string;
  generated_at: string;
  row_count: number;
  entries: FeedEntry[];
}): string {
  return JSON.stringify({
    schema_version: feed.schema_version,
    match_version: feed.match_version,
    feed_version: feed.feed_version,
    generated_at: feed.generated_at,
    tuple: ['prefix', 'prefix_bits', 'org', 'is_registry_block'],
    row_count: feed.row_count,
    entries: feed.entries,
  });
}

export type OuiPublishResult = {
  feed_version: string;
  checked_at: string | null;
  unchanged?: boolean;
  row_count: number;
  sha256: string;
  bytes: number;
  by_registry: Array<{ registry: string; n: number }>;
  published: boolean;
  publish_note?: string;
};

export async function buildAndPublishOuiFeed(opts?: {
  feedVersion?: string;
  publishedBy?: string;
  generatedAt?: string;
  store?: FeedBlobStore;
}): Promise<OuiPublishResult> {
  const signingKeyB64 = process.env.FEED_SIGNING_KEY;
  if (!signingKeyB64) throw new Error('FEED_SIGNING_KEY is not set');

  await ensureOuiSchema();
  const today = new Date().toISOString().slice(0, 10);
  const generatedAt = opts?.generatedAt || new Date().toISOString();

  // ⛔ ORDER BY IS EXPLICIT AND TOTAL, or identical data produces different
  // bytes run to run and every consumer re-downloads an unchanged feed.
  const { rows } = await rawQuery<{
    prefix: string; prefix_bits: number; org: string; is_registry_block: boolean; registry: string;
  }>(
    `SELECT prefix, prefix_bits, org, is_registry_block, registry
       FROM oui_assignments ORDER BY prefix ASC`
  );
  const entries: FeedEntry[] = rows.map((r) => [r.prefix, r.prefix_bits, r.org, r.is_registry_block ? 1 : 0]);

  const payloadSha = createHash('sha256')
    .update(canonicalOuiFeedJson({
      schema_version: OUI_FEED_SCHEMA_VERSION, match_version: OUI_MATCH_VERSION,
      feed_version: '', generated_at: '', row_count: entries.length, entries,
    }))
    .digest('hex');

  // ⛔ LIVENESS IS WHEN THE REGISTRY WAS LAST SUCCESSFULLY READ, not when we
  // last published. Publishing is idempotent and IEEE changes slowly, so
  // generated_at can sit still for weeks while everything is healthy — and
  // would sit equally still if the hub died. oui_refresh_state.last_success_at
  // advances on every healthy refresh whether or not anything changed.
  const checkedRow = await rawQuery<{ checked_at: string | null }>(
    `SELECT to_char(MIN(last_success_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS checked_at
       FROM oui_refresh_state`
  );
  // ⛔ MIN, NOT MAX. Three registries must ALL be current; reporting the newest
  // would hide one that has been failing for a month behind two that are fine.
  const checkedAt = checkedRow.rows[0]?.checked_at ?? null;

  const prior = await rawQuery<{ feed_version: string; assignments_sha256: string | null }>(
    `SELECT feed_version, assignments_sha256 FROM oui_feed_versions
      ORDER BY generated_at DESC LIMIT 1`
  );

  if (!opts?.feedVersion && prior.rows[0] && prior.rows[0].assignments_sha256 === payloadSha) {
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
    } catch { artefactsPresent = false; }

    if (artefactsPresent) {
      return {
        feed_version: prior.rows[0].feed_version, checked_at: checkedAt, unchanged: true,
        row_count: entries.length, sha256: '', bytes: 0, by_registry: [],
        published: false,
        publish_note: 'catalogue identical to the last published feed — nothing republished',
      };
    }
    // ⛔ FALL THROUGH when the artefacts are not confirmed: the idempotence
    // guard exists to stop version churn, not to make a broken publish permanent.
  }

  const seqRow = await rawQuery<{ n: number }>(
    `SELECT COALESCE(MAX(NULLIF(split_part(feed_version, '.', 2), '')::int), 0) + 1 AS n
       FROM oui_feed_versions WHERE feed_version LIKE $1 || '.%'`,
    [today]
  );
  const feedVersion = opts?.feedVersion || `${today}.${seqRow.rows[0]?.n ?? 1}`;

  const canonical = canonicalOuiFeedJson({
    schema_version: OUI_FEED_SCHEMA_VERSION, match_version: OUI_MATCH_VERSION,
    feed_version: feedVersion, generated_at: generatedAt,
    row_count: entries.length, entries,
  });
  const bytes = Buffer.from(canonical, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const keyObject = createPrivateKey({
    key: Buffer.from(signingKeyB64, 'base64'), format: 'der', type: 'pkcs8',
  });
  const sigB64 = cryptoSign(null, bytes, keyObject).toString('base64');

  const latestJson = JSON.stringify({
    feed_version: feedVersion, sha256, generated_at: generatedAt,
    checked_at: checkedAt, row_count: entries.length, match_version: OUI_MATCH_VERSION,
  }, null, 2);

  // ⛔ SIGNATURE FIRST, THEN BODY, THEN POINTER; AUDIT ROW ONLY IF ALL LAND.
  // A feed.json without a matching .sig is the state that breaks consumers.
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
    return {
      feed_version: feedVersion, checked_at: checkedAt, row_count: entries.length,
      sha256, bytes: bytes.length, by_registry: [], published: false,
      publish_note: `blob write FAILED, no version recorded so the next run retries: ${publish_note}`,
    };
  }

  const conflictClause = opts?.feedVersion
    ? `ON CONFLICT (feed_version) DO UPDATE SET
         generated_at = EXCLUDED.generated_at, row_count = EXCLUDED.row_count,
         content_sha256 = EXCLUDED.content_sha256, assignments_sha256 = EXCLUDED.assignments_sha256,
         signature = EXCLUDED.signature, published_by = EXCLUDED.published_by`
    : 'ON CONFLICT (feed_version) DO NOTHING';

  await rawQuery(
    `INSERT INTO oui_feed_versions
       (feed_version, generated_at, row_count, content_sha256, assignments_sha256, signature, published_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ${conflictClause}`,
    [feedVersion, generatedAt, entries.length, sha256, payloadSha, sigB64, opts?.publishedBy || 'app']
  );

  const byReg = new Map<string, number>();
  for (const r of rows) byReg.set(r.registry, (byReg.get(r.registry) || 0) + 1);

  return {
    feed_version: feedVersion, checked_at: checkedAt, row_count: entries.length,
    sha256, bytes: bytes.length,
    by_registry: [...byReg].map(([registry, n]) => ({ registry, n })).sort((a, b) => b.n - a.n),
    published,
  };
}

/** Catalogue state for the dashboard. Read-only, no network. */
export async function ouiStatus(): Promise<{
  total: number;
  byRegistry: Array<{ registry: string; n: number }>;
  registryBlocks: number;
  refresh: Array<{ registry: string; lastSuccessAt: string | null; lastRows: number | null; lastError: string | null; consecutiveFailures: number }>;
  latest: { feed_version: string; generated_at: string; row_count: number } | null;
}> {
  await ensureOuiSchema();
  const t = await rawQuery<any>(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE is_registry_block)::int AS blocks FROM oui_assignments`);
  const b = await rawQuery<any>(
    'SELECT registry, count(*)::int AS n FROM oui_assignments GROUP BY registry ORDER BY registry');
  const r = await rawQuery<any>(
    `SELECT registry,
            to_char(last_success_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_success_at,
            last_rows, last_error, consecutive_failures
       FROM oui_refresh_state ORDER BY registry`);
  const v = await rawQuery<any>(
    `SELECT feed_version, to_char(generated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS generated_at,
            row_count FROM oui_feed_versions ORDER BY generated_at DESC LIMIT 1`);
  return {
    total: t.rows[0]?.n ?? 0,
    registryBlocks: t.rows[0]?.blocks ?? 0,
    byRegistry: b.rows,
    refresh: r.rows.map((x: any) => ({
      registry: x.registry, lastSuccessAt: x.last_success_at, lastRows: x.last_rows,
      lastError: x.last_error, consecutiveFailures: x.consecutive_failures,
    })),
    latest: v.rows[0] ?? null,
  };
}
