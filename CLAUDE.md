# nocvault-eol — Claude Development Guide

## Workflow & deployment — READ FIRST
**Commit straight to `main`. Do NOT open PRs or work on feature branches.** The flow
every time is: **test (`npm run build`) → commit → `git push origin main`.** Netlify
auto-deploys `main` to production (~2 min). No branch, no PR, no merge step.
(Owner preference — PRs just added an extra merge that left commits undeployed.)

## What this is
The **central EOL Intelligence service** for the NocVault suite. It curates
vendor-confirmed End-of-Life / End-of-Support dates and publishes them as a
**signed, versioned feed** that consuming apps (NetVault, etc.) pull and match
**locally**. Device inventories never leave the customer — only the generic
`model → dates` feed travels.

- **Hosting:** Netlify (Next.js 14 app) + **Neon** Postgres. Feed artifacts live in
  **Netlify Blobs**.
- **Repo:** https://github.com/amrin78-smb/nocvault-eol
- Full architecture: `../nocvault-eol-architecture.md` (in the NocVault folder).

## The core principle
**Pull the seed, never push the devices.** This service serves a generic feed;
matching happens in the consuming app. The feed carries **raw** model strings; each
app re-normalizes locally with its own copy of `normalizeForMatch`, so an inaccurate
brand never blocks a match.

---

## Source of truth: `data/eol-seed.json`
The curated dataset is **`data/eol-seed.json`** — a JSON array, version-controlled
and human-reviewable. This is what you edit to grow coverage. Entry shape:

```json
{
  "key": "CISCO C9300-48P",              // human label (vendor + model), for dedupe/readability
  "vendor": "Cisco",                      // drives the DB vendor row
  "matches": ["C9300-48P", "<aliases>"],  // [0] = canonical model_raw; [1..] = alias_raw (SKU variants, legacy/garbled strings)
  "support_end_date": "2027-04-30",       // End-of-Support / Last Date of Support (apps key on this) | null
  "os_eol_date": null,                    // software/firmware EOL if separate | null
  "confidence": "high",                   // 'high' = model named in an official bulletin/table; 'medium' = series-level; 'low' = weak
  "source": "https://official-vendor-url",
  "note": "short: what it is + which bulletin"
}
```

Dates are `YYYY-MM-DD` text or `null`.

---

## HOW TO GROW THE LIST (the recurring task)

**Preference: COVERAGE-DRIVEN — ingest everything a vendor publishes.** For each
vendor, pull their **entire published EOL/EOS table** and add every model that has an
official date.

### Rules (non-negotiable)
- **Official vendor sources ONLY** (vendor.com EoL/EoS/lifecycle pages, official PDFs).
  Reseller/aggregator "estimated" dates do **not** count.
- **NEVER guess or infer a date.** If a model has no official published date, **skip
  it** (don't add a null-dated row).
- `support_end_date` = End-of-Support / Last Date of Support (LDoS). Capture
  `os_eol_date` only if the vendor publishes a separate software EOL.
- `confidence`: `high` when the model is named in the bulletin/table; `medium` when a
  series-level date is applied to a member.

### The flow
1. **Fan vendor-grouped research agents** (Agent tool, parallel — one per vendor).
   Each reads the vendor's official EOL table(s) and returns a JSON array of entries
   in the shape above. JSON only, no prose.
2. **Orchestrator merges** the results into `data/eol-seed.json`: dedupe against
   existing by `normalizeForMatch(vendor, matches[0])`; append new ones; keep the file
   sorted/clean.
3. `npm run build` (verify it still compiles — the JSON is imported by `lib/feed-core.ts`).
4. Commit + `git push origin main` (no branch/PR — see "Workflow & deployment"). Netlify auto-deploys.
5. **In the app:** Dashboard → **Feed actions** → **Load curated seed** → **Build &
   Publish Feed**. (The button reads the deployed `data/eol-seed.json`, upserts Neon,
   signs + writes the feed to Blobs.)

> Claude can't write to Neon directly (that's the user's secret). It edits the
> version-controlled seed; the buttons push it into Neon + publish.

### v1 vendor scope (the fleet's vendors — extend freely)
Cisco, Aruba/HPE, Cisco Meraki, SonicWall, Fortinet, Palo Alto, Ruckus, Juniper,
Netgear, TP-Link, Check Point, Grandstream, D-Link, Ubiquiti, Allied Telesis, Huawei.

---

## Publish / serve

- **`lib/feed-core.ts`** — `applyCuratedSeed()` (upsert seed → DB) and
  `buildAndPublishFeed()` (DB → canonical JSON → **Ed25519 sign** → write
  `feed.json` / `feed.json.sig` / `latest.json` to Netlify Blobs → log `feed_versions`).
  Runs **inside Netlify functions**, where `@netlify/blobs` + env secrets are ambient
  (no Netlify token needed).
- **Admin routes:** `app/api/admin/seed` + `app/api/admin/publish-feed` (NextAuth
  session-gated; publish also accepts `x-cron-secret`). Dashboard buttons in
  `components/AdminActions.tsx`.
- **Public serving:** `app/api/v1/feed/latest` (version pointer) + `app/api/v1/feed`
  (full feed; requires `x-license-key` header — Phase-1 stub, real license check TODO).
- **Monthly auto-publish:** `netlify/functions/scheduled-publish.mjs` (cron `0 6 1 * *`
  → POSTs the publish route with `CRON_SECRET`).

## CVE feed (Phase 1 — ingestion only, 2026-09-17)

A SECOND corpus alongside EOL: NVD advisories for the firewall vendors SecVault
manages. **Ingestion only so far — nothing is published and there is no public route yet.**

- `lib/cve/vendor-cpes.ts` — 32 CPE strings, each probed against live NVD with its
  `totalResults` recorded. ⛔ The vendor-level wildcard (`cpe:2.3:a:checkpoint`) was tested,
  works, returns 129 more CVEs that are ZoneAlarm/Harmony/SmartConsole, and is **refused** —
  filing an endpoint-agent CVE against a firewall from a CENTRAL feed does it to every customer
  at once. Do not "simplify" the list into a wildcard.
- `lib/cve/extract.ts` — ⛔ **ported VERBATIM from SecVault's lib/feeds/nvd.js**, not re-derived.
  Verified against 243 real NVD records: **zero divergence** in affected ranges, fixed versions and
  matchability. It already contains three hard-won fixes — a wildcard `10.0.*` must expand to a
  bounded branch range (not collapse to one point), a `vulnerable:true` entry with no range fields
  must pin to its own version (not become unbounded), and `versionEndExcluding` must not be
  confused with `versionEndIncluding` (which marks PATCHED devices vulnerable).
- `lib/cve/schema.ts` — ⛔ **its own gate, separate from runInit()'s.** Widening the EOL fast-path
  check would make the next request after deploy re-run ~25 EOL DDL/seed statements (~9s measured)
  on a live service, to create tables unrelated to EOL. This checks only for the CVE tables.
- `lib/cve/ingest.ts` — ⛔ **a state machine, not a job.** NVD is one request per six seconds
  without a key and there are 32 targets: ~192s minimum against a 10s function budget. Each call
  works the least-recently-attempted target within a time budget and records where it got to, so a
  cut-off run RESUMES. `ORDER BY … last_attempt_at ASC NULLS FIRST` is load-bearing: Postgres puts
  NULLs last by default, which would park every never-run target behind every already-run one.
- `app/api/admin/ingest-cve` + `components/CveActions.tsx` — session or `x-cron-secret`, same
  shape as publish-feed. The button loops until the sweep reports nothing left.

⛔ **Set `NVD_API_KEY` in Netlify env.** ⛔ Verified 2026-09-17: **5 requests / rolling 30s without
a key, 50 / 30s with one** — so ~6.2s between requests becomes ~0.7s, roughly nine
times faster — and being able to hold ONE key for every customer is a large part of why a central
feed is worth building.

⛔ **NO DEVICE DATA EVER REACHES THIS SERVICE**, exactly as for EOL: consumers pull the corpus and
match locally. This repo already deleted a live query API once because it "leaked device data".

⛔ **`cve_advisories` is keyed `(cve_id, vendor)`, NOT `cve_id`.** SecVault made it unique on
`cve_id` with a single vendor, and the consequence is in its own CLAUDE.md: a CVE affecting two
vendors stays with whichever feed ingested it first, permanently. This is the one place that is
still fixable.

## Signing keys
- **Ed25519.** Generate with `npm run gen:keys` (native `node scripts/gen-keys.ts`).
- **Private key** → `FEED_SIGNING_KEY` (Netlify env, base64 pkcs8). **Never commit.**
- **Public key** (base64 spki) → bundled into each consuming app to verify the feed.
  Current public key: `MCowBQYDK2VwAyEAI+nk9JoWunzPTASALa5PLWwcLe9NNWRrZ72tMY8ZU2k=`

## Environment variables (Netlify)
| Var | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string |
| `FEED_SIGNING_KEY` | Ed25519 private key (base64 pkcs8) for signing the feed |
| `CRON_SECRET` | shared secret for the scheduled-publish function |
| `NEXTAUTH_SECRET`, `NEXTAUTH_URL` | NextAuth admin login |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` | seeds the admin user on first init |

No Netlify token / GitHub secrets needed (Blobs is ambient inside functions).

## Schema (Neon — `lib/init.ts`)
`vendors`, `eol_models` (model_raw, model_normalized, end_of_sale, support_end_date,
os_eol_date, confidence, source_url, note, verified, entry_method; UNIQUE
(vendor_id, model_normalized)), `model_aliases` (eol_model_id, alias_raw,
alias_normalized), `feed_versions` (signed-feed audit log), `admin_users`.
`runInit` fast-paths (skips heavy DDL) when `eol_models` + `feed_versions` already
exist — keep that, but when adding a NEW migration, gate it so it actually runs.

## Dev / tooling notes
- Scripts run with **native `node` on Node ≥ 22** (TypeScript is executed directly;
  no `tsx`/`esbuild`). Relative imports in `scripts/` use explicit `.ts` extensions and
  `import.meta.dirname` (ESM). `scripts/` is excluded from the Next typecheck.
- `lib/match-normalize.ts` (`normalizeForMatch`, `deriveVendor`, `NORMALIZER_VERSION`)
  is the matching contract — **kept in lockstep with NetVault's `lib/eolEnrich.ts`**.
  Bump `NORMALIZER_VERSION` on any behavioural change.
- The old per-vendor HTML/regex scrapers + the live `/api/v1/eol` query API +
  `api_queries` were **removed** (scrapers didn't work; live query leaked device data).
  Ingestion is now the Claude research sweep above.

## Versioning
`feed_version` is date-based (`YYYY-MM-DD.N`, N defaults to 1) and recorded in
`feed_versions` with its sha256 + signature. `schema_version` + `normalizer_version`
are stamped in every feed so consumers can detect drift.

## Next phase (not yet built)
**Phase 2 — NetVault consumer:** a `/api/eol/sync` in NetVault that pulls
`/api/v1/feed`, **verifies the Ed25519 signature with the bundled public key**, and
upserts into NetVault's local `eol_seed` via its existing `migrateLegacySeed`, with the
embedded `lib/eolSeed.ts` as the offline fallback.
