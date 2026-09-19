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

## 5. Salary Extraction — verified against live LinkedIn HTML

Salary came back `null` for every row because **LinkedIn search result cards contain no salary markup at all**. Confirmed by fetching the live guest search endpoint: zero `salary`/`compensation` classes in the response. The listing parser's salary code could never have matched anything.

Measured on 10 live job detail fragments:

| Where the pay actually is | Count |
|---|---|
| `.salary.compensation__salary` structured block | 1 |
| Description prose only | 4 |
| Not disclosed at all | 5 |

So pay is disclosed on about half of postings, but **only a fifth of those use the structured block** — the rest bury it in the description body. That is why a job shows a salary on the site while the scraped record has none.

`parseJobDetails` now resolves salary as: compensation block → listing value → description prose, and records which one in `salarySource` (`'compensation'` | `'description'` | `'listing'` | `null`).

### Two traps, both verified
1. **Never read salary from the full `/jobs/view/` page.** It carries `main-job-card__salary-info` and `aside-job-card__salary-info` for unrelated "similar jobs" in the sidebar — scraping those attaches another company's pay to the record. The `/jobs-guest/jobs/api/jobPosting/` fragment the actor uses has none of these and is safe.
2. **Description prose is full of currency figures that are not pay** — funds protected, funding rounds, transaction values. `extractSalaryFromText()` requires a pay-context keyword within 220 chars before the figure (or an explicit `/yr`-style marker) and range-checks the magnitude against the pay period via `isPlausibleSalary()`. A real posting reading "protected over $250B+ in funds" correctly yields no salary. Ranges are always resolved before single figures, otherwise a lone "$157,400 per year" outscores the "$107,800 - $157,400" range it is the upper half of and silently collapses it.

### `includeSalary` input — and why it is off by default
LinkedIn's own salary filter (`f_SB2`) is **ignored by the guest endpoint** — verified by diffing result sets with and without it, which were identical. Pay exists only on the job detail page. So showing salary costs **one extra request per job**: 400 jobs goes from 40 requests to 440, which is the entire reason a salary run is slower. There is no cheaper path.

`includeSalary` therefore:
- forces `scrapeJobDetails` on, since salary is never on a search card;
- **returns every job regardless**, with `salary: null` where pay was not disclosed.

It deliberately does **not** filter. An earlier version discarded jobs without pay and over-fetched ~2x to compensate; a real run returned 195 rows instead of 400 and took 2m32s for 410 requests. Dropping rows makes the returned count depend on how many employers happened to disclose, which is not what `maxItems` should mean. `requireSalary` is still accepted as a legacy alias for `includeSalary`, but no longer discards anything.

### Cost profile of a detail page
Measured on 10 live fragments (avg 69 KB):

| | ms | share |
|---|---|---|
| cheerio load (Crawlee does this, unavoidable) | 8.52 | 69% |
| `parseJobDetails` | 4.61 | 37% |
| — of which salary extraction | 1.04 | 8% |
| **total per detail page** | **12.33** | |

Salary parsing is not the bottleneck and never will be — the request count is. **Apify allocates 1 CPU core per 4 GB of memory**, so a 1 GB run gets ~0.25 core, and Crawlee's autoscaler then throttles concurrency under CPU pressure. For salary runs, raise the actor's memory before touching anything in the code.

## 6. Performance & Failure Insights
- **~25% failed requests is normal.** LinkedIn returns HTTP 429 or serves bot-challenge/checkpoint pages, which the actor detects. At concurrency 10 without residential proxies this rate is expected; retries and exponential backoff absorb it.
- **300 results in 8 seconds** (37.5 jobs/sec) is extremely fast. Browser-based scrapers typically need 60–120+ seconds for the same work. The runtime is bound by network latency (200–500ms per LinkedIn request) and retry backoff, not CPU parsing.
- Local CPU benchmarks on the parsing logic reached **607 jobs/second** with pre-queued pagination and concurrency 10.

## 7. Key Architecture Notes for Other AIs
- Code on `main` is up to date.
- **Pagination is pre-queued in waves**, not discovered serially. LinkedIn's `start` offsets are deterministic (0, 25, 50…), so page N+1 never needs page N parsed first. Serial discovery would force the whole search phase through one request at a time regardless of `maxConcurrency`. Only the last page of a wave queues the next, so waves never overlap.
- **Retry backoff uses full jitter** (`Math.random() * ceiling`), not exponential-plus-small-jitter. With N concurrent workers, near-deterministic backoff makes blocked requests retry in lockstep and burst a host that is already pushing back.
- `isChallengePage()` exists because LinkedIn serves checkpoint/auth-wall pages with **HTTP 200**, so status codes alone miss them.
- `salary` is a **JSON object or `null`**, never a raw string.
- `companyId`, `isReposted`, and `salaryParsed` do not exist on job records.
- `extractCompanyId()` is still used for company records; `extractCompanyKey()` is what deduplication actually runs on.
- Test suite: **161/161 passing** (`npm test`).
