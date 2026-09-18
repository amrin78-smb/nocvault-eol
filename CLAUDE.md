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
| `NVD_API_KEY` | raises NVD's limit from 5 to 50 requests / rolling 30s. Sent as an `apiKey` REQUEST HEADER, not a query param |
| `CVE_FEED_KEYS` | who may pull `/api/v1/cve-feed`. Comma-separated `key` or `key:label`; the label names the customer in the log line. **Unset = the gate fails OPEN** (any non-empty key accepted) and every response says so via `X-Feed-License: unenforced` |

⛔ **AN ENV CHANGE DOES NOT REACH A DEPLOYED FUNCTION UNTIL THE NEXT BUILD.**
Netlify bakes these in at BUILD time. Editing a value in the UI leaves every
running function on the previous one, and nothing in the failure points at it —
the dashboard shows the new value, the upstream service accepts the new value, and
the function uses the old one. This cost hours on 2026-09-17 with `NVD_API_KEY`
(every target returned HTTP 404, which is what NVD returns for an invalid key —
not 401, not 403). **After changing any variable here, trigger a deploy**, then
confirm with the dashboard's `build <sha>` marker or `X-Feed-License`.

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

## The CVE feed (Phase 2) — `/api/v1/cve-feed`

A SECOND signed feed beside the EOL one, built from `cve_advisories` by
`lib/cve/feed.ts`. It deliberately mirrors `lib/feed-core.ts`: same Ed25519
detached signature over canonical-JSON bytes, same `X-Feed-Signature` /
`X-Feed-Sha256` headers, same `latest.json` pointer — so a consumer that can
already verify the EOL feed needs no new verification code.

⛔ **ITS OWN BLOB STORE, `cve-feed`, NEVER `eol-feed`.** The EOL feed is live and
NetVault reads it in production. Writing `feed.json` into the same store would
replace the EOL feed with CVE data, and the first symptom would be NetVault
silently matching ZERO devices — a failure with no error anywhere. Two products,
two stores, no shared key names. Same reason `cve_feed_versions` is its own audit
log rather than a `kind` column on `feed_versions`.

⛔ **`raw_data` IS NOT CARRIED.** Measured at Phase 0: ~84% of each row, and no
consumer reads it — matching runs off the extracted ranges. Shipping it would
multiply every customer's download for data none of them use.

⛔ **KEY ORDER AND ROW ORDER ARE BOTH FIXED, AND BOTH ARE LOAD-BEARING.** The
signature covers exact bytes. `jsonb` does not preserve key order (keys come back
sorted by length then bytes), and Postgres may return the same rows in a
different sequence without a total `ORDER BY` — either one changes the hash for
UNCHANGED data, and every consumer re-downloads a feed that did not change.
`canonicalCveFeedJson` names every key explicitly and the query sorts
`vendor, cve_id`.

⛔ **`matchability` TRAVELS WITH EVERY ADVISORY.** An empty
`affected_version_ranges` means two opposite things — "this product is not
affected" and "we could not extract a range" — and from a CENTRAL feed that
ambiguity is multiplied across every customer at once. The field is what keeps
them apart downstream.

### Why this exists (measured 2026-09-18, on the reference SecVault deployment)

Not convenience. The consuming sites cannot reach NVD at all: they use internal
public IP ranges that OVERLAP NVD's own address space, so traffic to
`services.nvd.nist.gov` routes to an internal host. That is not fixable with a
firewall rule — you cannot permit egress to a range your own network claims.
SecVault therefore falls through to its CIRCL fallback on every string, every
run, and CIRCL's records carry no parseable version bounds:

| vendor | usable ranges today (CIRCL) | usable from NVD |
|---|---|---|
| `cisco_asa` | 70 / 353 (20%) | **332 / 369 (90%)** |
| `checkpoint` | 0 / 7 (0%) | **68 / 80 (85%)** |

Fleet-wide, **439 of 1,006 advisories on that deployment can never match a
device**. Vendors with a working PSIRT feed are healthy (paloalto 98%, fortinet
67%); the ones that depend on NVD are gutted. Both figures above were scored with
SecVault's OWN extractor, so the difference is the DATA SOURCE and nothing else.

⛔ The transport is already proven: `eol_catalogue` pulls 2,770 rows from this
service into that same SecVault box on schedule while every NVD call fails. The
address overlap does not touch this path.

### Scheduling (`netlify/functions/scheduled-cve.mjs`, every 6h at :20)

⛔ **THE LOOP LIVES IN THE SCHEDULED FUNCTION BECAUSE ONLY IT HAS THE BUDGET.** A
Netlify SCHEDULED function gets ~15 minutes; the synchronous route it calls gets
~10 seconds. `/api/admin/ingest-cve` does exactly ONE bounded step per call and
the scheduler drives it repeatedly. Sweeping inside the route is what produced a
wall of killed invocations that recorded nothing.

⛔ **A RUN DOES NOT HAVE TO FINISH.** Ingestion is a resumable state machine, so a
run that stops on its wall clock has still made progress and the next continues.
What it must never do is overrun its budget and be killed mid-write, which is why
it stops itself at 11 minutes.

⛔ **IT PUBLISHES EVERY RUN, EVEN AN INCOMPLETE ONE.** Gating publication on a
complete sweep would mean a feed that never refreshes on a site where one
stubborn CPE string always times out.

⛔ **PUBLISHING IS IDEMPOTENT ON A PAYLOAD DIGEST, AND THE OBVIOUS VERSION OF
THAT CHECK CANNOT WORK.** `content_sha256` covers the whole SIGNED body, which
includes `feed_version` and `generated_at` — so it changes on every publish by
construction, and comparing it to detect "nothing changed" is a guard that cannot
fire. `advisories_sha256` (its own column, added by an `ALTER TABLE ... ADD COLUMN
IF NOT EXISTS`, since `CREATE TABLE IF NOT EXISTS` never guards a new column)
covers the payload alone, so an unchanged corpus republishes NOTHING and keeps its
version. Changed content gets a NEW version — the date plus the next free
sequence.

⛔ **A VERSION IDENTIFIES BYTES.** Republishing one version with different content
breaks the only cheap thing a consumer can do: read `latest.json` and skip a
download it already has. It would fetch nothing and run on stale data while its
own pointer said it was current.

⛔ **6-HOURLY MATCHES THE CONSUMER.** SecVault syncs its feeds on a 6-hourly cycle;
a hub refreshing less often would leave it faithfully importing a stale corpus —
worse than an obvious failure, because every signal stays green.

### Licence gate (`lib/cve/license.ts`)

`CVE_FEED_KEYS` is a comma-separated list of `key` or `key:label` entries; the
label names which customer pulled, which is the point of metering.

⛔ **THIS GATE IS COMMERCIAL, NOT SECURITY, AND FAILS OPEN WHEN UNCONFIGURED.**
Same call the rest of the range makes — SecVault's own rule is "the licence guard
fails open; the RBAC guard fails closed", because a configuration gap must never
cut a paying customer off from data their security posture depends on. With
`CVE_FEED_KEYS` unset every non-empty key is accepted, exactly as before the file
existed.

⛔ **BUT IT IS NEVER SILENT ABOUT IT.** Every response carries
`X-Feed-License: enforced | unenforced` and an unenforced serve logs a warning.
Code that merely mentions licences reads as metered; only the header says whether
it actually is.

⛔ **IT IS NOT AUTHENTICATION AND MUST NOT BE MISTAKEN FOR IT.** The keys are
bearer strings in an env var. What the corpus contains is PUBLIC vulnerability
data — NVD's own records — so the gate meters distribution, it does not protect
content. **Do not add device data to this feed and then rely on this gate.** This
repo already deleted a live query API once for leaking device data.

⛔ **`timingSafeEqual` THROWS ON A LENGTH MISMATCH** rather than returning false,
so length is compared separately first. A bare call would leak length through an
exception and crash the route on the first wrong-sized key.

⛔ **`/api/v1/feed` (EOL) IS DELIBERATELY NOT TOUCHED.** NetVault consumes it in
production with an unvalidated key today; tightening it from here would risk a
live outage in a different product for no gain in this one. Metering the EOL feed
is its own change, made with NetVault in view.

⛔ **`Cache-Control` ON A LICENSED RESPONSE IS THE CONTROL, NOT THE CODE BELOW
IT.** `/api/v1/cve-feed` shipped with `public, max-age=3600`, copied from the EOL
feed, and that made the licence gate decorative: Netlify's CDN cached the body,
its cache key does **not** vary on `x-license-key`, and one authorised fetch
populated the edge — after which a request with no key, a bogus key, or a
cache-busted query was served the full 3.4 MB corpus **without the function ever
running**. Verified live 2026-09-18. It is now `private, no-store, max-age=0`
plus `Vary: x-license-key`. No validation in a route can fire if the edge answers
first.

⚠️ **`/api/v1/feed` (EOL) STILL CARRIES `public, max-age=3600` AND HAS THE SAME
HOLE.** Left as-is deliberately pending a decision: NetVault consumes it in
production, and removing CDN caching changes its fetch cost (every pull would
reach the function). The hole is real — that feed is currently readable by anyone
who knows the URL — but the fix belongs in a change made with NetVault in view,
not as a side effect of CVE work.

