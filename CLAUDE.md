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
  "confidence": "high",                   // see "THE SOURCING RULE" below — capped by the SOURCE CLASS:
                                          // official -> high, community -> medium, aggregator -> low
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

**THE SOURCING RULE (owner's decision, 2026-11-16 — replaces "official sources ONLY"):**

> **Official sources only for `high` and `medium`. Aggregators are permitted at `low`,
> always labelled.**

⛔ **IT IS ENFORCED BY `npm run verify:seed`, NOT BY THIS PARAGRAPH.** The previous rule
said official-only, sat here in bold marked non-negotiable, and was quoted to refuse new
sources twice in one week — while **22.4% of the shipped corpus (1,767 of 7,902 entries)
was already aggregator-sourced**, nearly all of it correctly tagged `low`. A rule the data
contradicts is worse than a looser rule the data obeys: it gets applied selectively, and
the selection is whoever read it last. `lib/eol/source-policy.ts` is now the rule; this is
its description.

⛔ **CONFIDENCE AND PROVENANCE ARE TWO AXES.** `low` means EITHER "official but weak" OR
"aggregator-sourced", and the difference matters: the first cannot improve until the vendor
publishes better, the second can be **promoted to `high` by one person opening the vendor
link the aggregator already cites**. Provenance is derived from the source HOST, so it is
always recoverable from data the seed already carries and no feed-format change is needed.

| source class | ceiling | examples |
|---|---|---|
| **official** | `high` | `cisco.com`, `docs.fortinet.com`, `paloaltonetworks.com`, vendor PDFs |
| **community** | `medium` | `community.fortinet.com`, `community.juniper.net` — vendor-HOSTED but user-WRITTEN; nobody at the vendor signed it |
| **aggregator** | `low` | `endoflife.date`, `endoflife.ai`, Park Place, Layer23, router-switch, Service Express |
| **unknown host** | *inadmissible* | ⛔ an unrecognised host is NOT official by default — it fails toward refusal, like `health.ts`'s `unknown` verdict |
| **no source** | *inadmissible* | a date with no citation is not a weak fact, it is an unverifiable one |

- **To admit a new host**, add it to the right set in `lib/eol/source-policy.ts`. That is
  the single place; the verifier reads it.
- **NEVER guess or infer a date.** If a model has no published date anywhere, **skip it**.
  The one exception is explicit: `lifecycle: "eol"` with a null date, meaning *the vendor
  confirmed EOL but published no date* — a THIRD state, distinct from both "a date" and
  "no information" (26 entries). ⛔ The first draft of the verifier asserted "every row has
  a date" and failed on 24 of them; the rows were right and the assertion was wrong.
- `support_end_date` = End-of-Support / Last Date of Support (LDoS). Capture
  `os_eol_date` only if the vendor publishes a separate software EOL.
- `confidence` within a class: `high` when the model is named in the bulletin/table;
  `medium` when a series-level date is applied to a member; `low` when weak **or**
  aggregator-sourced.

⛔ **PRE-EXISTING DEBT IS PINNED, NOT WAIVED.** 70 entries carry `high` with no source URL
at all — their notes name real documents, so a human read a source and did not record the
link. Silently downgrading 70 published dates changes what consumers match against on no
new evidence; silently waiving them makes the rule decorative on day one. So
`UNSOURCED_HIGH_BASELINE` pins the count: the verifier fails if it ever RISES, so no new
unsourced row can be added, and the debt stays visible with a number on it. Lower the
constant in the same commit as any batch that gets its citations back.

⛔ **`endoflife.date` IS THE ONE THAT CHANGES WHAT IS POSSIBLE.** Measured 2026-11-16: a
clean JSON API, 489 products, and — unlike every other source here — it is organised by
**OS/firmware BRANCH CYCLE**, which is the gap in this corpus (`os_eol_date` is populated
on 34 of 7,902 entries, 0.4%). `api/panos.json` returns 26 cycles shaped
`{cycle, releaseDate, eol, support, latest, link}`, and `link` points at the official
vendor page — so every row arrives at `low` with its own promotion path to `high`.
⛔ `endoflife.ai` is permitted but is NOT a bulk source: its hardware tables are
client-rendered (7-9 dated lines reach a server fetch against "366 release lines tracked"),
and `/api/<product>` 301s to a marketing page about software products.

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
| `ALERT_EMAIL_PROVIDER` | `brevo` (default) or `resend`. ⛔ **NOT interchangeable via `ALERT_EMAIL_API_BASE`** — they differ in PATH, AUTH HEADER and BODY (see below) |
| `ALERT_EMAIL_API_KEY` | HTTP email API key for ingest health alerts. Brevo: `xkeysib-…`. Resend: `re_…`. **Unset = the health check still RUNS and still RECORDS**; it reports `no_api_key` and the verdict stays readable on `/api/health` and the dashboard |
| `ALERT_EMAIL_TO` | comma-separated alert recipients. Unset behaves exactly as above (`no_recipient`) |
| `ALERT_EMAIL_FROM` | sender. ⛔ **REQUIRED for Brevo** — it has no shared test sender and only sends from an address/domain validated in the account; unset is reported as `no_sender` before any request. Resend falls back to `onboarding@resend.dev`, which delivers only to the Resend account owner |
| `ALERT_EMAIL_API_BASE` | optional; defaults to `https://api.brevo.com` or `https://api.resend.com` per provider. Exists so `npm run verify:cve-health` can point the mailer at a local capture server and PROVE a send |

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

### Scheduling — TWO functions, and that split is a fix not a preference

⛔ **A NETLIFY SCHEDULED FUNCTION IS NOT A BACKGROUND FUNCTION.** It is capped at
roughly **30 seconds**, not the 15 minutes a background function gets. This file
originally claimed ~15 minutes and the function was written to match: an
11-MINUTE wall clock with the publish call at the END. It was killed long before
reaching it, so ingest crept forward while `latest.json` never moved and
`checked_at` stayed empty through TWO scheduled windows — visible only because
the consumer's freshness check had just been built. ⛔ Registration was never the
problem and the 403 on a direct HTTP call proves it: that is what Netlify returns
for a function it HAS registered as scheduled.

⛔ **SO INGEST AND PUBLISH ARE SEPARATE FUNCTIONS ON SEPARATE SCHEDULES.**
`scheduled-cve-ingest` (hourly at :10) spends ~20s stepping the state machine;
`scheduled-cve-publish` (every 2h at :45) does one call with its own fresh budget.
A second thing queued behind a first thing is hostage to it, which is exactly how
this failed.

⛔ **A SLICE DOES NOT HAVE TO FINISH.** Ingestion is a resumable state machine, so
20 seconds of progress an hour converges on a corpus that changes a few times a
week. ⛔ It only waits out a rate-limit throttle if the wait FITS in the remaining
budget — sleeping 6s inside 20s spends a third of the slice doing nothing.

⛔ **"20 SECONDS OF PROGRESS AN HOUR" WAS NEVER TRUE: IT WAS ONE STEP AN HOUR,
AND THE STATE TABLE SAYS SO WITHOUT READING A SINGLE LOG (measured 2026-11-15).**
`cve_ingest_state.last_attempt_at` is stamped at the START of every step, so the
SPREAD of those timestamps inside one tick is the invocation's whole reach. Six
consecutive ticks (09:10–14:10Z) each touched **1 target, span 0.000s**:
```sql
SELECT date_trunc('hour', last_attempt_at) AS tick, count(*) AS targets_touched,
       extract(epoch FROM max(last_attempt_at) - min(last_attempt_at)) AS span_s
  FROM cve_ingest_state GROUP BY 1 ORDER BY 1 DESC LIMIT 6;
```
⛔ **THE CAUSE WAS A PAIR OF INDEPENDENTLY-SET NUMBERS MULTIPLYING.** The loop
gate was `elapsed + longestStepMs < WALL_CLOCK_MS` seeded at
`longestStepMs = 4000` against `WALL_CLOCK_MS = 7000`, so any step leaving under
4s of headroom ended the slice — i.e. every step slower than 3s. With 32 targets
and three pages for the largest, that is a **2-4 DAY sweep when fully healthy.**

⛔ **AND THE PER-STEP BUDGET KNOB EXISTED, WAS CLAMPED, WAS HONOURED, AND THE ONLY
PRODUCTION CALLER NEVER SENT IT.** `/api/admin/ingest-cve` takes `budgetMs` in the
POST body; `scheduled-cve-ingest` posted no body at all, so every step ran on
`DEFAULT_BUDGET_MS` (7000) and handed NVD whatever was left — **2267-2867ms,
visible verbatim in `last_error`, against this file's own measurement of NVD at
1.5-14.4s.** A request started with 2.3s against a 1.5-14.4s service is not a
measurement, it is a timeout with extra steps. `ingest.ts`'s `MAX_DEADLINE_MS`
comment already complained that `maxDuration = 26` "allocated 26 seconds the code
refused to use"; the route stopped refusing and then nothing ever asked.
⛔ The function now STATES a budget per step and **will not start a step it cannot
fund** (`MIN_STEP_BUDGET_MS`), because an unfunded attempt is a false negative
about the target, not a reading.

⛔ **THE 23-DAY OUTAGE ITSELF WAS THE `NVD_API_KEY`, NOT THE BUDGET** — the trap
this file already documents two sections up, for the second time. All 32 targets
errored, 16 with NVD's `HTTP 404` (its answer to an invalid key), and every target
had last succeeded between 10-18 and 10-23 — so the tight budget was survivable
and the key was not. ⛔ **The two faults are INDEPENDENTLY OBSERVABLE in
`cve_ingest_state.last_error`** (`HTTP 404` vs `did not respond within NNNNms`),
which is what let one deploy verify both fixes separately.

⛔ **PUBLISH RUNS EVERY TIME, EVEN WHEN NOTHING CHANGED**, because an unchanged
corpus still has to refresh `checked_at`. A quiet corpus and a dead hub must not
look the same.

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

### Ingest health alerting (`lib/cve/health.ts`, `health-alerts.ts`, `notify.ts`)

Built 2026-11-15, after the 23-day silent outage above. `scheduled-cve-health`
(hourly at **:25** — clear of ingest at :10 and publish at :45) POSTs
`/api/admin/cve-health`, which classifies, deduplicates and alerts.

⛔ **SIX STATES, NEVER COLLAPSED**, because they send the operator to four
different places: `key_invalid` (replace the key **and redeploy**), `stalled`
(the pipeline is dead), `corpus_frozen` (ingest succeeds and stores nothing),
`upstream_degraded` (NVD's bad hour — **recorded and displayed, never emailed**),
`unknown` (an unrecognised condition — fails toward alert, never toward healthy),
`healthy`.

⛔ **DO NOT ALERT ON "A RUN FAILED".** Measured on a HEALTHY tick 2026-11-15:
four of seven targets returned HTTP 503 while three succeeded. Per-target failure
is the normal state of this pipeline, 429/5xx/timeouts are already classified
`retryable`, and an alert that fires on them trains the operator to filter the
channel — at which point the next real alert is silent again.

⛔ **THE 404 SIGNATURE MUST BE FRESHNESS-QUALIFIED OR IT LIES AFTER EVERY
RECOVERY.** `last_error` is cleared to NULL on success, so a non-null error IS
that target's latest outcome — but the fleet sweeps ~7 targets an hour, so for
hours after a key is fixed most targets still carry their pre-fix 404. Measured
at 15:11Z on 2026-11-15, minutes after the real recovery: 16 targets holding
`HTTP 404` beside three fresh successes. The rule is `404 whose last_attempt_at
>= MAX(last_success_at)`: a 404 at T proves the key was bad at T; a success at
S > T proves it is good at S.

⛔ **A PROBE HAS THREE OUTCOMES AND THE THIRD IS THE DANGEROUS ONE.**
`probeApiKey()` bounds each fetch at 3000ms while this file measures NVD at
1.5-14.4s, so losing the UNKEYED CONTROL is ordinary — observed twice on the
first live runs of the verifier (keyed 404 / unkeyed timeout, then 503/503). An
inconclusive probe proves nothing and must fall back to the recorded signature;
an early draft branched on "a probe ran" and was about to report a provably dead
key as healthy.

⛔ **THE CORPUS CEILING IS THE ONLY OUTCOME CHECK, AND ITS THRESHOLD IS DERIVED.**
`max(published_at)` ages on its own during quiet periods, so the threshold must
clear the longest genuine one. Measured on the live corpus (955 advisories):
gaps between publication days since 2024 are p50 **8d**, p90 **28d**, p95 **31d**,
**max 42d** (2025-08-14 -> 2025-09-25); every 2026 gap is ≤28d. Hence
`CORPUS_CEILING_DAYS = 45`. ⛔ **Do not tighten it below 42** to make it faster —
that trades a real signal for routine false alarms. It is the BACKSTOP (it would
have fired ~day 45 of this 54-day outage); `STALL_HOURS = 6` (six missed hourly
ticks) is what catches a hard stop within the hour. The ceiling is the one check
that catches "the key works, the requests return 200, and we store nothing".

⛔ **`STALL_HOURS` REUSES `MAX(last_success_at)` — the SAME expression already
published as `checked_at`**, not a second definition, so the operator's view and
SecVault's freshness check can never disagree about whether the hub is alive.

⛔ **ONE ALERT PER TRANSITION, A 24h COOLDOWN, AND AN ALL-CLEAR.** This outage ran
23 days: per-evaluation alerting is ~552 emails, transition-plus-daily is ~24.
⛔ `notified_at` advances **only on a real send**, so a broken mailer cannot start
a day of deliberate silence. ⛔ The recovery message is load-bearing — a cooldown
makes "fixed" and "still broken, stopped emailing" identical from the inbox.

⛔ **NO MAILER IS NOT AN EXCUSE TO SKIP.** With `ALERT_EMAIL_API_KEY` unset the
check still runs, still classifies and still records; it reports `no_api_key` and
the verdict is readable on `/api/health` and the dashboard. A notifier that
quietly no-ops when unconfigured reproduces the defect it was built to fix.

⛔ **TWO MAIL PROVIDERS, AND A BASE-URL SWAP CANNOT BRIDGE THEM.** Brevo and
Resend differ in all three parts of the request — path (`/v3/smtp/email` vs
`/emails`), auth header (`api-key:` vs `Authorization: Bearer`) and body
(`sender.email`/`to[].email`/`textContent` vs `from`/`to[]` strings/`text`). The
first draft shipped Resend's shape only and offered `ALERT_EMAIL_API_BASE` as the
way to point elsewhere, which would have produced a 401 or a 404 from the one
feature whose job is to work during an incident. `lib/cve/notify.ts` builds the
request per provider and the verifier asserts the bytes of both.
⛔ **Brevo has no shared test sender**, so `ALERT_EMAIL_FROM` is REQUIRED there
and an unset value is reported as `no_sender` *before* the request rather than
discovered as a rejection during the first real incident.

⛔ **VERIFIED BY EXECUTION: `npm run verify:cve-health` — 116 assertions.** It
forces all six states, both probe directions plus the inconclusive one, the
freshness qualifier against today's real production shape, dedup/cooldown/
supersede/recovery, both providers' exact wire format, and every email outcome
(sent, `no_api_key`, `no_sender`, `provider_error`) against a local capture
server. It refuses to run unless `DATABASE_URL` is local and contains `test`,
because it seeds a frozen corpus and a wall of 404s.
⛔ It found a `42P08 inconsistent types deduced for parameter $2` that fired
**only on the recovery path** — open, remind and supersede all passed — which
would have left every episode permanently open. Reading the query did not find
it; running it did.

### RSS-triggered CVE discovery (`lib/cve/rss.ts`, `rss-sources.ts`)

Built 2026-11-15. `scheduled-cve-rss` (hourly at **:40** — clear of ingest :10,
health :25, publish :45) polls one vendor advisory feed, enqueues the CVE
identifiers it finds, then drains the queue against NVD within what is left.

⛔ **RSS CHANGES WHEN WE LOOK. IT NEVER CHANGES WHAT WE ACCEPT.** A feed yields
identifiers only. Each is fetched FROM NVD and passed through the same
`extract.ts` + `classifyNvdNativeMatchability` against the same `VENDOR_CPES`
prefixes as the rotation, so anything not naming a tracked product is recorded
`other_product` and stored nowhere. This is what keeps the extractor's "zero
divergence over 243 real NVD records" true for every row in the corpus — and it
is why Cisco's feed covering every Cisco product is safe rather than a repeat of
the refused `cpe:2.3:a:checkpoint` wildcard.

⛔ **WHY IT EXISTS:** the CPE rotation re-reads everything a product has ever had
in order to notice what is new — 2-4 days for a full sweep when healthy, and
measured far worse on 2026-11-15, when checkpoint's 19 outstanding strings alone
needed ~16 hours while the corpus ceiling sat 54 days stale. A feed poll finds
the same advisory in minutes at one NVD request instead of a paged result set.

⛔ **FORTINET WAS MEASURED OUT, NOT OVERLOOKED.** Probed 2026-11-15:

| feed | items | carrying a CVE id | verdict |
|---|---|---|---|
| cisco `psirtrss20` | 50 | **49 (98%)**, 106 ids | in |
| paloalto `rss.xml` | 25 | **24 (96%)**, 25 ids | in |
| fortinet `ir.xml` | 50 | **1 (2%)**, 10 ids | **refused** |

`filestore.fortinet.com/fortiguard/rss/ir.xml` answers 200 everywhere (the one
Fortinet URL the September probe found un-Cloudflared) but it is a threat-
RESEARCH feed — titles like "Numeric truncation error" — not a PSIRT feed. Its
items link to `fortiguard.com/psirt/<id>`, the byte-identical Cloudflare
challenge already refused. ⛔ Do not add it "for coverage": a listed vendor that
silently contributes zero is worse than one honestly absent. Fortinet keeps its
CPE rotation, which works (279 advisories).
⛔ `endoflife.date` serves clean JSON and is an **aggregator** — disqualified by
the official-sources-only rule, recorded so it is not rediscovered as "it parses
nicely".

⛔ **THE FEED IS NEVER PARSED AS XML**, only scanned for a strict `CVE-\d{4}-\d{4,7}`
pattern. Feeds differ (RSS here, Atom there, occasionally malformed) and an
identifier regex survives all of it; parsing untrusted third-party XML invites
entity expansion for no benefit. No XML dependency is added.

⛔ **A 200 CARRYING NO IDENTIFIERS IS RECORDED AS A FAILURE**, not as "no new
advisories". A moved feed, a login page and a quiet rewrite all answer 200 with
bytes — the repo's most-repeated bug, already written down for NVD's
200-with-the-wrong-shape.

⛔ **DISCOVERY AND RESOLUTION CANNOT SHARE AN INVOCATION.** One Cisco poll
yielded 106 identifiers; resolving those is ~75s at the keyed rate against a
function capped near 30. So the poll ENQUEUES (`cve_rss_queue`) and a bounded
drain resolves — the same resumable-state-machine discipline as
`cve_ingest_state`. ⛔ The queue is keyed **(cve_id, vendor)**, matching
`cve_advisories`, because one CVE can be discovered for two vendors and must
resolve independently for each.

⛔ **`resolved_at` NULL WITH `last_error` SET IS NORMAL:** the vendor published
before NVD did. It must be retried, so it must not be resolved; it is not a
fault, so it must not read as one.

⛔ **THE NVD RATE-LIMIT WINDOW IS SHARED**, via `nvdThrottleWaitMs()` /
`stampNvdCall()` — NVD limits the CALLER, not the query, so a drain pacing itself
independently would be correct alone and, with the sweep, sail past the limit and
earn 403s that read like an outage. ⚠️ `ingestStep` still applies the same rule
inline rather than calling the helper; both are the same definition of the clock
and must change together.

⛔ **VERIFIED BY EXECUTION: `npm run verify:cve-rss` — 38 assertions**, including
identifier-extraction strictness both ways, the 1000-id cap, a full rotation
pass, re-polling being free, the 200-with-no-identifiers guard, HTTP errors,
recovery, and a live check that each admitted feed STILL carries identifiers (so
a feed that goes the way of Fortinet's fails here rather than quietly
contributing nothing).

## Vendor EOL page watch (`lib/eol/watch.ts`, `signal.ts`, `watch-sources.ts`)

Built 2026-11-16, the EOL half of "read vendor feeds automatically". `scheduled-eol-watch`
(**daily at 06:20 UTC** — clear of the monthly EOL publish at 06:00 and of every CVE
schedule) reads each watched lifecycle listing, reduces it to the set of statements it
publishes, and raises a **review item** when that set changes.

⛔ **IT NEVER WRITES AN EOL DATE, AND THAT RESTRAINT IS THE FEATURE.** This repo already
deleted per-vendor HTML scrapers once because they did not work; a detector that parsed
dates out of these pages would be those scrapers again, writing unreviewed dates into the
feed NetVault matches customer devices against — where a wrong date is worse than a missing
one, because a missing date shows as "unknown" and a wrong one shows as a confident answer.
The output is "go and look"; a human still reads the bulletin and still edits
`data/eol-seed.json`. Asserted twice in the verifier: a sentinel `eol_models` is unchanged
across a cycle that saw a brand-new date, **and** the module sources are scanned for any
statement touching `eol_models` / `model_aliases` / `feed_versions` / `vendors`.

⛔ **THERE ARE NO EOL RSS FEEDS. NOT ONE, FROM ANY VENDOR.** Probed 2026-11-16 across
Cisco, Fortinet, Palo Alto, HPE/Aruba, Netgear, Juniper, SonicWall, Check Point, Ruckus,
Ubiquiti, Meraki, TP-Link and D-Link. Every lifecycle listing is an HTML page. That is why
the CVE half gets real feeds (`lib/cve/rss-sources.ts`) and this half is a change detector.

⛔ **HASHING THE PAGE DOES NOT WORK.** A raw body hash moves on nonces, build ids and
rotating banners, so it alerts daily — the shape that trains an operator to filter the
channel. The page is reduced to its **set of lifecycle statements**, sorted and deduped, and
only that is hashed. Sorted because a re-ordered table is not a date change.

⛔ **TWO SIGNAL KINDS, BECAUSE THE VENDORS GENUINELY DIFFER.** Palo Alto and Meraki publish
dates in the page (13, 45 and 24 dated lines). **Cisco's category listings carry ZERO
dates** — the page says so itself ("Only the linked items below are End-of-Sale or
End-of-Life products") — so their signal is the **link set**, and "Cisco added Catalyst 9200
to the switches listing" is exactly the review prompt wanted. A date-only extractor scores
nothing on them.

⛔ **SEVEN SOURCES ADMITTED OUT OF NINETEEN PROBED — AND FIVE OF THE REFUSALS ANSWER HTTP
200.** The refusals are the more important half of `watch-sources.ts`:

| refused | what it actually returns |
|---|---|
| SonicWall `product-lifecycle-tables` | **200**, 1,159 B: `Request unsuccessful. Incapsula incident ID: …` — a WAF denial wearing a 200 |
| Juniper `/support/eol/hardware/` | **200**, 58 KB, **120 chars** of visible text (a survey pop-up) |
| Check Point `sk95746` | **200**, 29 KB, **157 chars** (a copyright footer) |
| Fortinet `ProductLifeCycle.aspx` | **200**, 9.9 KB, **zero** visible text |
| Netgear `kb…/NETGEAR-End-of-Life-Products` | **200**, 127 KB of real prose — **and it is a DGN2200v1 security advisory**. The KB id routes; the slug is decorative |
| HPE/Aruba | old URL **503** "Site is no longer available … Feb 23, 2026"; successor `networkingsupport.hpe.com/endoflife` is 200 with **9 chars** |
| Ubiquiti 403 · TP-Link 404 · D-Link 404 · Ruckus Cloudflare challenge | |

⛔ **CISCO `interfaces-modules` WAS ADMITTED, THEN REMOVED BY ITS OWN LIVE TEST** — the most
instructive failure in the build. It **redirects to the generic products landing page**:
200, 201 KB, zero product links. The first probe called it "STABLE, 16 links", and that
measurement was real and completely wrong — a loose href pattern was counting the landing
page's navigation, and it was stable *because site furniture is stable*. **The source looked
healthiest precisely when it was reading nothing.** The live check in the verifier asserts a
floor against the real URL rather than trusting the admission measurement, and that is what
caught it. A failed read now reports `REDIRECTED TO <final url>` instead of "0 links found".

⛔ **THE LINK PATTERN IS CATEGORY-ANCHORED, MEASURED NOT GUESSED.** A pattern of merely
`/products/<x>/<y>/index.html` also matched `Choose your firewall ::
/site/us/en/products/security/firewalls/index.html`. Site navigation is re-templated far
more often than an EoL listing changes; one nav link inside the signal turns the detector
into a false-alarm generator.

⛔ **A SIGNAL THAT COLLAPSES IS A FAILED READ, NEVER A CHANGE** — and here that rule has
teeth, because five refused URLs answer 200 with plenty of bytes. Reading any of them as
"the vendor removed every EoL product" would manufacture a review item that is not merely
useless but false. Each source carries a `minSignalLines` floor; below it the baseline hash
is **preserved**, `consecutive_failures` increments, and nothing is recorded as changed.

⛔ **THE FIRST SUCCESSFUL READ IS A BASELINE, NOT A CHANGE.** Without that, the feature's
debut is a burst of emails about every source "changing" from nothing — and the first
impression of an alert channel decides whether the second one is ever read.

⛔ **AGGREGATORS ARE REFUSED HERE TOO, AND THEY ARE THE TEMPTING OPTION.** A search for HPE
Aruba EOL dates returns almost nothing *but* aggregators (router-switch, endoflife.ai,
parkplace, layer23), several with clean complete tables. `endoflife.ai` concedes its dates
are read **from** `networkingsupport.hpe.com` — the JS shell above — so using it means
trusting a third party's rendering of a page we refuse to trust ourselves.

⛔ **ALERTS REUSE `lib/cve/notify.ts`**: one email per cycle (not per source), `notified_at`
set **only on a real send**, a source called unreadable only after
`UNREADABLE_AFTER_FAILURES = 3` consecutive failures (three days at this cadence) with a
7-day reminder cooldown. Review items are **acknowledgeable** on the dashboard — an
un-acknowledgeable alert list grows until it is ignored. With no mailer configured the check
still runs, still records, and says `no_api_key`.

⛔ **DAILY, NOT HOURLY, AND THAT IS A MEASUREMENT.** Vendor lifecycle listings change a few
times a *year*; the CVE feeds change a few times a week. Hourly would be 168 fetches a week
to observe something monthly, against vendor sites that already front themselves with WAFs.

⛔ **VERIFIED BY EXECUTION: `npm run verify:eol-watch` — 169 assertions.** Pages are served
locally so the branches can be forced: a page that quietly empties, the measured SonicWall
Incapsula body, a client-rendered shell, a retirement-by-redirect, a re-ordered table, a
navigation rewrite, a listing that gains one product, a failing mailer, the cooldown, and
acknowledgement. Two findings came out of running it rather than reading it: the
`interfaces-modules` source above, and an assertion that the alert email named an unreadable
source **when none was unreadable** — Part B2 had recovered it. The fix was to force the
state, not to soften the claim.

## OS / firmware branch lifecycle (`lib/eol/os-cycles.ts`, `os-sources.ts`, `data/os-lifecycle.json`)

Built 2026-11-16. A THIRD corpus beside hardware EOL and CVE: which **branch** of a
vendor OS is still supported. 54 cycles today — PAN-OS 27, Cisco IOS-XE 19, FortiOS 8.

⛔ **IT IS NOT A COLUMN ON THE HARDWARE ROW, AND IT NEVER COULD HAVE BEEN.**
`eol_models.os_eol_date` exists and is populated on **34 of 7,902 entries (0.4%)**. OS
support is not a property of a MODEL: one FortiGate runs FortiOS 6.4, 7.0, 7.2 or 7.4,
each with its own dates, and one column cannot hold four answers. Branches are keyed
`(vendor, product, cycle)`.

⛔ **WHY IT MATTERS MORE THAN HARDWARE EOL.** SecVault already knows each device's running
version and matches CVEs against it. Today it can say "this firewall is vulnerable to
CVE-X". With this it can say "…and it runs PAN-OS 10.0, which left support in 2022, so no
fix will ever ship." A chassis supported to 2029 running a branch that died in 2022 is
unpatchable today and nothing in the suite can currently see it.

⛔ **THIS IS NOT THE SCRAPER THIS REPO DELETED. THE DIFFERENCE IS WHERE THE OUTPUT LANDS.**
Refused: a SCHEDULED job parsing pages into the live feed with no human in the loop. This:
a **manually run** generator (`npm run build:os-cycles`) writing a version-controlled JSON
file, reviewed as a git diff like any seed change, published by the same human-pressed
button. The daily `scheduled-eol-watch` monitors the same pages and raises a review item
when they change — that is the signal to re-run it. ⛔ **Do not wire the generator to a
schedule.** That one change recreates what was deleted.

⛔ **THE TIMEZONE BUG THAT ALMOST SHIPPED, AND HOW IT WAS CAUGHT.** Cross-checking Palo
Alto's official PAN-OS table against endoflife.date showed **all 24 shared cycles
disagreeing by exactly one day**. The sources were identical; the parser was wrong.
`new Date('July 30, 2026')` is LOCAL midnight, and on this UTC+7 machine `.toISOString()`
returned `2026-07-29`. Every date in the corpus would have been one day early, and the only
symptom looked like an aggregator data-quality problem. ⛔ `parseLifecycleDate` is UTC-only
and `verify:os` tests it across **UTC-11 to UTC+14**. ⛔ **Never use
`new Date(string).toISOString()` on a vendor date.** A support-end date one day early is
the difference between "supported" and "unsupported" on the day someone checks.

⛔ **PAN-OS IS `high`, EVERYTHING ELSE IS `low`, AND THAT ASYMMETRY IS A MEASUREMENT.**
Palo Alto's `end-of-life-summary` is the ONLY official, server-readable OS lifecycle source
found anywhere: 251 KB, 30,134 chars of visible text, 22 tables. Every other vendor's
software page is a shell, a denial or a 404 — Fortinet's `ProductLifeCycle.aspx` 200 with
**zero** visible text, Juniper 200 with 120 chars, SonicWall an Incapsula denial, Check
Point 157 chars, Aruba 503. So FortiOS and IOS-XE come from `endoflife.date` at `low`, each
carrying its `link` as `vendor_link` — a promotion path to `high` for anyone who opens it.

⛔ **THE PAN-OS TABLE IS LOCATED BY THREE MARKERS IN ITS OWN ROWS**, not by position and not
by `rows[0]`. It is the 4th of 22 tables, and its first rows are `[""]`,
`["PAN-OS & Panorama"]`, then the column header — a `rows[0]`/`rows[1]` match is what broke
on the first run, on the leading spacer. A positional read would silently return Prisma
Access's or QRadar's dates the first time a table is inserted above it, and the output would
look entirely plausible. ⛔ **The column layout has an EMPTY SPACER at index 3**:
`[version, release, standard, "", extended]`. `checkCycle` refuses any row whose extended
date precedes its standard date, because that is what a column swap looks like.

⛔ **EXTENDED SUPPORT IS A SEPARATE DATE, AND `branchState` HAS FOUR STATES NOT THREE.**
PAN-OS 10.1 is standard-supported to 2024-11-30 and extended to 2026-03-30. Collapsing them
tells a customer without an extended contract they have 16 more months than they do;
calling `extended_only` "eol" is wrong for the customers who do hold one.

⛔ **`branchOf()` IS A MATCHING CONTRACT, LIKE `normalizeForMatch`.** The consumer holds
"PAN-OS 10.1.2" and this corpus holds "10.1". If the two sides disagree the lookup silently
misses and every device reads "branch unknown". Two components, leading zeros stripped —
Cisco writes both `17.9.1` and `17.09.01a` for one branch. Bump `OS_BRANCH_VERSION` on any
change.

⛔ **THE WATCH IS SCOPED, AND WITHOUT THAT IT WOULD ALERT WEEKLY FOREVER.** The Palo Alto
page carries 556 dated lines across 22 tables, and the FIRST one is Applications & Threats
content releases — `157.19.x.x`, `156.17.x.x`, `155.16.x.x` — which ship weekly. An
unscoped watch on that page is a guaranteed weekly false alarm. `EolWatchSource.scope`
narrows the signal to the PAN-OS table; ⛔ a scope that finds nothing is a **failed read**,
never an empty one.

⛔ **ONE LOCATOR, SHARED.** `findPanOsTable` lives in `lib/eol/os-sources.ts` and is
imported by the generator, the verifier AND the watch scope. It was briefly two copies, they
drifted on the first run, and the verifier then failed against a page that had not changed.

⛔ **ONLY THREE OF endoflife.date's 489 PRODUCTS ARE RELEVANT** — `panos`, `fortios`,
`cisco-ios-xe`. There is **no Junos, no Aruba AOS, no SonicOS, no Gaia, no Meraki**. The gap
is in the source, not in the query; do not go looking again without re-reading this.

⛔ **VERIFIED BY EXECUTION: `npm run verify:os` — 69 assertions**, including the timezone
matrix, rolled-over dates (`February 31` must be null, not 3 March), vendor words in date
columns ("Latest", "TBD"), the column-swap guard, all four branch states, and a LIVE
cross-check that the official PAN-OS corpus still agrees with endoflife.date. ⛔ That
cross-check is what caught the timezone bug and is kept as a standing test: if the two
readings ever stop agreeing, one has drifted and the corpus should not be trusted.

### The OS feed (Phase 2) — `/api/v1/os-feed`

A THIRD signed feed beside EOL and CVE, built from `os_cycles` by `lib/eol/os-feed.ts`.
Same Ed25519 detached signature over canonical-JSON bytes, same `X-Feed-Signature` /
`X-Feed-Sha256` headers, same `latest.json` pointer — a consumer that can verify either
existing feed needs no new verification code.

⛔ **ITS OWN BLOB STORE, `os-feed`.** Never `eol-feed` (the model catalogue NetVault reads
in production) and never `cve-feed`. Three products, three stores, no shared key names —
and `os_feed_versions` is its own audit log for the same reason.

⛔ **ROWS ABSENT FROM THE SEED ARE DELETED.** The corpus is fully regenerated each time, so
a cycle that disappears upstream must disappear here; a stale branch row would go on telling
a consumer that a long-dead branch is the vendor's current statement, and nothing would ever
contradict it. Safe only because the file, not the table, is the source of truth.

⛔ **AN INVALID CORPUS WRITES NOTHING AT ALL.** `applyOsCycles` runs `checkCycle` over every
row before it writes one; half-applying leaves the database in a state no file describes.

⛔ **`checked_at` REUSES `MAX(eol_watch_sources.last_success_at)`.** This corpus is refreshed
by a human running the generator, so `generated_at` says only when someone last did that —
a corpus untouched for three months is indistinguishable from a hub that died three months
ago. The daily watch's success timestamp is an automated liveness signal that advances
whether or not anything changed, and it is the SAME expression the watch already records,
not a second definition of "alive".

⛔ **DATES ARE `to_char`-FORMATTED OUT OF POSTGRES.** A pg `date` arrives as a JS Date and
serialises to a full ISO timestamp in the SERVER's timezone — the same class of bug as
`parseLifecycleDate`'s, one layer down. The verifier asserts no `T00:00:00` ever reaches the
feed.

⛔ **`Cache-Control: private, no-store` + `Vary: x-license-key`,** never `public`. The CVE
feed shipped with `public, max-age=3600` copied from the EOL feed and it made the licence
gate decorative — the CDN cache key does not vary on the header, so one authorised fetch
populated the edge and everything after was served without the function running. Metered by
the same `CVE_FEED_KEYS` list: same customers, same commercial relationship, and a third key
list would be a third thing to configure before anyone can pull.

⛔ **`scheduled-os-publish` runs DAILY at 06:50 UTC with `mode: "both"`**, after the watch at
06:20. It seeds as well as publishing because the corpus lives in a DEPLOYED FILE — a deploy
shipping a new `data/os-lifecycle.json` changes nothing until something loads it, and leaving
that to a human lets the file and the feed drift silently. Publishing is idempotent, so the
daily run exists to refresh `checked_at`.

⛔ **VERIFIED BY EXECUTION: `npm run verify:os-feed` — 46 assertions**, against a FAKE blob
store (`FeedBlobStore`, a seam that supplies the store and nothing else). Without it the
whole publish path could only be verified by reading, and every subtle rule in it is there
because the CVE feed got it wrong first: a partial write making a broken signature
permanent, an empty store with an intact database making every publish a no-op for ever, an
audit row recorded for a publish that never happened. All three are tests now, plus a real
Ed25519 verify over the published bytes and a tampered-body rejection.

## MAC vendor catalogue — the OUI feed (`lib/oui/`)

Built 2026-11-16. A FOURTH corpus and a fourth signed feed, `/api/v1/oui-feed`: the IEEE MAC
address block registries, 54,469 assignments.

⛔ **WHY IT IS ON THE HUB.** DDIVault keeps its own `data/oui.json`, rebuilt by a human
running `node scripts/update-oui.js`. Measured 2026-11-16: **39,267 entries, last updated
2026-06-05 — over five months stale**, because refreshing depends on somebody remembering.
**NetVault and LogVault have no MAC-vendor resolution at all.** One signed, versioned feed
replaces a hand-maintained file in one app and a gap in two others.

⛔ **THREE REGISTRIES, AND USING ONE IS A CORRECTNESS BUG.** IEEE assigns at three prefix
lengths — MA-L 24-bit (40,500), MA-M 28-bit (6,688), MA-S 36-bit (7,281). **442 MA-L blocks
are registered to "IEEE Registration Authority" itself, with 13,841 MA-M/MA-S assignments
underneath them.** A 24-bit-only lookup reports all 13,841 as *"IEEE Registration
Authority"* — not an "unknown", a **confident wrong answer**, which is this repo's
most-repeated failure mode. `lookupMac` tries 9, then 7, then 6 hex chars, and
`is_registry_block` travels in the feed so a consumer renders "unknown vendor" rather than a
registrar's name.

⛔ **IEEE DIRECTLY, AND THE RECORDED REASON FOR NOT DOING SO WAS STALE.** DDIVault's script
says IEEE "actively blocks scripted clients (HTTP 418)" and uses Wireshark's republished
`manuf` instead. **All three IEEE CSVs answer HTTP 200 from here.** Under the sourcing rule
IEEE is the registrar (official, `high`) and Wireshark is a republisher (aggregator, `low`),
so taking the aggregator when the official source answers would be choosing second-hand data
for nothing. Same lesson as Check Point's stale "202 bot challenge": a stale reason sends the
next session hunting a workaround for a problem that no longer exists.

⛔ **IT FETCHES ON A SCHEDULE, AND THAT IS *NOT* THE SCRAPER THIS REPO DELETED** — the OS
corpus three files away does the opposite, deliberately. The refused thing was a scheduled
job **inferring dates** from vendor prose into a feed nobody reviews: every row a judgement
call. This is a **verbatim copy of an official registry** — IEEE says `00000C` is Cisco, and
that is the whole fact. Committing 54,000 such rows to git would produce a diff nobody reads,
and a review nobody performs is worse than an honest absence of one.

⛔ **BUT "A 200 IS NOT THE DOCUMENT" STILL APPLIES, SO A REFRESH IS ADMITTED OR REFUSED AS A
WHOLE.** Per-registry row floors, all three registries present, and six spot checks with
known-good answers (counts alone cannot tell a good parse from a column-shifted one). ⛔ **A
refused refresh changes nothing** — overwriting 54,000 assignments with a truncated download
is a silent, total loss of MAC-vendor resolution in three apps, and it would look like a
successful run. "We looked and refused" is recorded separately from "we never looked".

⛔ **A REAL CSV PARSER, NOT `line.split(',')`.** IEEE quotes any field containing a comma and
vendor names are full of them — `"Cisco Systems, Inc"`. Splitting naively makes the org
"Cisco Systems" and shifts every later column, so it fails on the biggest vendors first and
silently.

⛔ **IEEE'S OWN REGISTRY CONTAINS DUPLICATE PREFIXES.** `080030` is assigned to three
organisations and `0001C8` to two (measured 2026-11-16: 3 duplicates in MA-L). First
assignment wins and duplicates are COUNTED, not silently overwritten — a last-write-wins race
over the registry's own quirks would make the catalogue depend on file order.

⛔ **`Private` IS A REAL IEEE VALUE, NOT A MISSING ONE.** An assignee may withhold their name
and the registry records "Private". That is a different fact from "unassigned" and from "we
failed to read the registry"; a consumer that renders all three alike loses the only
actionable one.

⛔ **THE ONLY COMPACT FEED IN THE REPO.** 54,469 rows as named objects at indent 2 is ~6.5 MB;
as positional tuples with no indentation it is under 2 MB. Nobody reads a MAC lookup table by
eye and every consumer pays the difference on every pull. Canonicality is unaffected —
determinism comes from fixed field order and a total row order, not whitespace. The payload
carries a `tuple` field naming the positions so a consumer never guesses, and `match_version`
so drift in `lookupMac` is detectable.

⛔ **`checked_at` IS THE `MIN` OF THE THREE REGISTRIES' LAST SUCCESS, NOT THE MAX.** Reporting
the newest would hide a registry that has been failing for a month behind two that are fine.

⛔ **WEEKLY, NOT DAILY** (`scheduled-oui-refresh`, Sunday 05:30 UTC). IEEE assigns a few
blocks a week against a catalogue of 54,469, and each run pulls ~5.3 MB from three registries.

⛔ **VERIFIED BY EXECUTION: `npm run verify:oui` — 73 assertions.** Registries are faked for
the branches that matter (a truncated download, an HTML page answering 200, a 404, a
withdrawn prefix, recovery), because none of those can be ordered from IEEE on demand; the
real registries are checked live at the end. ⛔ It found two defects by running:
a `CASE WHEN $4 IS NULL` with no cast threw `42P08` on the SUCCESS path — the second time
this repo has hit that, after `health-alerts.ts` — and the catch then pushed a **second,
phantom zero row** for each registry, so `admit()` refused a healthy refresh while `total`
said 30. A loop that can report the same subject twice has a verdict that depends on which
copy is read.

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

## Vendor PSIRT on the hub — MEASURED AND REFUSED (2026-09-18)

"Move PSIRT to the hub, because Netlify will not get the Cloudflare bot check" was
an assumption. It is **false**, and `/api/admin/probe-psirt` is how that was
settled — probed from the SecVault server, an office connection and a Netlify
function:

| target | all three hosts |
|---|---|
| `fortiguard.com/rss/ir.xml` | 200 `text/xml`, 38 KB — works everywhere |
| `filestore.fortinet.com/fortiguard/rss/ir.xml` | 200, ~46 ms, not Cloudflare-fronted |
| `fortiguard.com/psirt/<id>` | **byte-identical 19,751-byte "Just a moment" challenge** |
| `advisories.checkpoint.com/` | 200, 147 KB HTML, **no challenge** |
| `sec.cloudapps.cisco.com/.../psirtrss20` | 200 `application/xml`, 146 KB |
| `api.cisco.com/security/advisories/v2/all` | **403 "Developer Inactive"** |

⛔ **THE CHALLENGE IS ON THE ADVISORY PAGE, NOT THE FEED, AND IT IS A JAVASCRIPT
CHALLENGE** — not IP-dependent and not UA-dependent (a Chrome user-agent gets the
same page as a bot one). No plain server-side `fetch` solves it wherever it runs,
and a datacenter IP is typically treated more harshly than an office one. **Moving
the fetch here would relocate the failure, not fix it.**

⛔ **Check Point's recorded reason was STALE.** SecVault's CLAUDE.md said
`advisories.checkpoint.com` answers a 202 bot challenge; it answers 200 with
ordinary HTML from every host tested, and `/feed/` 404s. Still refused — HTML is
not a machine-readable source — but for the right reason now. A stale reason sends
the next session hunting a workaround for a problem that no longer exists.

⛔ **The one source centralisation genuinely unlocks is Cisco openVuln**, because
its 403 is about REGISTERED CREDENTIALS rather than about bot detection: a hub can
hold one credential and serve every customer, which no per-site install can do.
That is capability, not convenience — the only test worth applying before moving a
feed here.

