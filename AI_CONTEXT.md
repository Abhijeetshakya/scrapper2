# Scrapper2 — AI Context File

This file contains the full context of recent modifications made to the `scrapper2` (LinkedIn Jobs Scraper) Apify actor. It is intended to be shared with other AI assistants to provide them with immediate context on the project's current state, recent fixes, and performance characteristics.

## 1. Project Overview
- **Project**: A fast, HTTP-only LinkedIn job scraper built as an Apify actor.
- **Tech Stack**: Node.js, Apify SDK, Crawlee (`CheerioCrawler`), Cheerio.
- **Key Feature**: Extracts job listings from LinkedIn's guest search endpoints without a browser or login.
- **Repo**: https://github.com/Abhijeetshakya/scrapper2.git

## 2. Output Schema Decisions
1. **`companyId`**: Always returned `null` on job listings → **removed** from job output. It still exists on `type: "COMPANY"` records, where it holds the numeric ID when LinkedIn exposes one (usually it does not — see §4).
2. **`isReposted`**: Always returned `false` → **removed**.
3. **`salary` & `salaryParsed`**: Consolidated into a single `salary` field holding a parsed JSON object, or `null` when the posting lists no pay. Shape: `{ min, max, currency, period, raw }`.
4. **`companyLogo`**: A plain image URL string.

## 3. Apify Schema Files — IMPORTANT

The three schema files under `.actor/` are three *different* specifications. Confusing them is what broke the build previously.

| File | Spec marker | Purpose |
|---|---|---|
| `input_schema.json` | `schemaVersion: 1` | Actor input form fields |
| `dataset_schema.json` | `actorSpecification: 1` | `fields` (item JSON Schema) + `views` (Output tab rendering) |
| `output_schema.json` | `actorOutputSchemaVersion: 1` | **Links to output storages only** — `template` URLs. NOT field definitions. |

**Build failure that was fixed**: `output_schema.json` had been written in the *input* schema format, so the build aborted with `must have required property 'actorOutputSchemaVersion'`. It was rewritten to the correct spec, and the per-field documentation moved to `dataset_schema.json` → `fields`.

**Validate any schema change before pushing** — this is the same validator the Apify build runs:

```bash
apify validate-schema
```

### Dataset `fields` validation is enforced
Apify runs **AJV validation on every dataset insert and discards items that do not match**, returning HTTP 400. This actor pushes several different record shapes:

- listing-only job records
- detail-enriched job records (when `scrapeJobDetails` is on)
- partial records flagged `detailScrapeFailed` (when a detail page fails)
- `type: "COMPANY"` records
- arbitrary subsets of any of the above (when `outputFields` is set)

Therefore `fields` in `dataset_schema.json` deliberately uses **nullable type unions** (`["string", "null"]`) and has **no `required` array**. Tightening it will silently throw away scraped data. Any change there must be re-validated against every record shape with AJV.

### Images DO render — earlier note was wrong
A previous version of this file claimed Apify's dataset table cannot render images and treats everything as plain text. **That is incorrect.** The dataset schema's `display.properties` accepts `format: "image"` alongside `text`, `number`, `date`, `link`, `boolean`, `array`, and `object`. `companyLogo` now uses `format: "image"` and renders as an actual image in the Output tab.

## 4. Bugs Found and Fixed

1. **Dead filter dropdowns.** `input_schema.json` offered `datePosted: "past-24h"` and `remoteFilter: "on-site"`, but `constants.js` keys off `past24hours` / `onSite`. The lookup returned `undefined` and `if (tpr)` skipped it, so those filters were **silently ignored** — no error, just unfiltered results. The schema now uses canonical values with `enumTitles` for display. Hyphenated aliases were added to `DATE_POSTED_MAP` / `REMOTE_FILTER_MAP` so existing saved tasks and API callers keep working.

2. **`scrapeCompanyDetails` never fired.** `queueCompanies()` read `companyId` off each job to build its dedup key, but `companyId` had been removed from parser output (§2). The guard rejected every job, so no company page was ever queued and the input toggle did nothing. It now keys on the company URL **slug** via `extractCompanyKey()`. This matters because guest job cards link companies as `/company/<slug>`, so `extractCompanyId()` returns `null` for most of them even when a company page exists. Company records now also carry `companySlug`.

3. **`companyUrl` was unusable as a base URL.** The listing parser returned the raw `href`, which may be relative and usually carries `?trk=` tracking params. Appending `/about` produced `https://...?trk=x/about`, which is not a valid URL. It is now absolutised and canonicalised, matching how `jobUrl` was already handled.

4. **Missing inputs.** `main.js` reads `jobType`, `experienceLevel`, `startUrls`, `outputFields`, `resumeFromPreviousRun`, `webhookUrl`, `notifyOnCompletion`, `maxConcurrency`, `requestsPerMinuteMultiplier`, `maxRequestRetries`, `paginationBatchSize`, and the request-delay options — none were in `input_schema.json`, so they were unreachable from the Apify UI. All are now exposed, grouped into sections. `errorRateThreshold` remains API/JSON-only because Apify input schemas have no float type (only `integer`).

## 5. Performance & Failure Insights
- **~25% failed requests is normal.** LinkedIn returns HTTP 429 or serves bot-challenge/checkpoint pages, which the actor detects. At concurrency 10 without residential proxies this rate is expected; retries and exponential backoff absorb it.
- **300 results in 8 seconds** (37.5 jobs/sec) is extremely fast. Browser-based scrapers typically need 60–120+ seconds for the same work. The runtime is bound by network latency (200–500ms per LinkedIn request) and retry backoff, not CPU parsing.
- Local CPU benchmarks on the parsing logic reached **607 jobs/second** with pre-queued pagination and concurrency 10.

## 6. Key Architecture Notes for Other AIs
- Code on `main` is up to date.
- **Pagination is pre-queued in waves**, not discovered serially. LinkedIn's `start` offsets are deterministic (0, 25, 50…), so page N+1 never needs page N parsed first. Serial discovery would force the whole search phase through one request at a time regardless of `maxConcurrency`. Only the last page of a wave queues the next, so waves never overlap.
- **Retry backoff uses full jitter** (`Math.random() * ceiling`), not exponential-plus-small-jitter. With N concurrent workers, near-deterministic backoff makes blocked requests retry in lockstep and burst a host that is already pushing back.
- `isChallengePage()` exists because LinkedIn serves checkpoint/auth-wall pages with **HTTP 200**, so status codes alone miss them.
- `salary` is a **JSON object or `null`**, never a raw string.
- `companyId`, `isReposted`, and `salaryParsed` do not exist on job records.
- `extractCompanyId()` is still used for company records; `extractCompanyKey()` is what deduplication actually runs on.
- Test suite: **137/137 passing** (`npm test`).
