# ⚡ Fast LinkedIn Jobs Scraper

**Purpose-built for rapid results.** Extract LinkedIn job listings at scale over plain HTTP — up to 1,000 jobs per search in under a minute, with no login, cookies, or browser required.

Every design decision in this Actor was made to minimise time-to-results: no browser, no page rendering, and search pages fetched in parallel rather than one after another.

---

## 📑 Table of Contents

- [🔍 What does this Actor do?](#-what-does-this-actor-do)
- [🚀 Why use this Actor?](#-why-use-this-actor)
- [⚙️ How it works](#-how-it-works)
- [📥 Input](#-input)
- [📤 Output](#-output)
- [💵 Pricing](#-pricing)
- [🎯 Use cases](#-use-cases)
- [❓ FAQ](#-faq)
- [🏁 Getting started](#-getting-started)
- [⚠️ Limitations and known issues](#-limitations-and-known-issues)
- [💬 Support & feedback](#-support--feedback)
- [⚖️ Legal and responsible use](#-legal-and-responsible-use)

---

## 🔍 What does this Actor do?

This Actor scrapes public job postings from LinkedIn and returns them as clean, structured JSON. It reads LinkedIn's guest-accessible job search endpoints directly over HTTP instead of driving a headless browser, which is why it completes in seconds what browser-based scrapers take minutes to do.

You get job titles, companies, logos, locations, workplace type, posting dates, and direct links — plus optional full descriptions, required skills, and salary. No LinkedIn account, session cookie, or credential of any kind is needed.

⏱️ **Measured throughput: 991 jobs in 32 seconds across 100 requests, with zero failures.** That is roughly 31 jobs per second.

---

## 🚀 Why use this Actor?

- ⚡ **Extremely fast.** No browser process, no JavaScript rendering, no page-load waits. Pure HTTP requests plus HTML parsing.
- 🔓 **No authentication.** Works entirely against LinkedIn's public guest endpoints. Nothing to configure, no cookies to refresh, no account to risk.
- 🔀 **Parallel pagination.** LinkedIn's result offsets are deterministic, so pages are fetched concurrently rather than discovered one at a time — the single biggest reason this Actor outpaces sequential scrapers.
- 💰 **Predictable cost.** You pay per result, not per minute of compute — $1.00 per 1,000 jobs, with no charge for the requests, retries, or proxy traffic behind them.
- 🛡️ **Resilient to blocking.** Session rotation, full-jitter retry backoff, and detection of LinkedIn's silent bot-challenge pages (served with HTTP 200, which status-code checks miss).
- 🧩 **Structured, not raw.** Locations and salaries are parsed into typed objects, not left as free text.
- 🔄 **Incremental runs.** `resumeFromPreviousRun` skips jobs already collected, so scheduled runs fetch only what is new.
- ✅ **Tested.** 163 automated tests cover the parsers and edge cases.

---

## ⚙️ How it works

1. Builds LinkedIn guest search URLs from your keywords, location, and filters.
2. Queues result pages in parallel waves using deterministic `start` offsets, so throughput is not bottlenecked by sequential page discovery.
3. Parses each job card from the returned HTML with Cheerio.
4. Optionally fetches each job's detail page for descriptions, skills, seniority, and salary.
5. De-duplicates by job ID across queries and pages, then writes structured records to the dataset.

Blocked or rate-limited requests are retried with a fresh session and proxy using randomized backoff. If the rolling error rate exceeds 30%, concurrency is automatically reduced.

---

## 📥 Input

Only `searchQueries` is required. Everything else has a sensible default.

### 🔎 Search

| Field | Type | Required | Description | Example |
|---|---|---|---|---|
| `searchQueries` | `array` | **Yes** | Job titles or keywords. Each is searched separately; results are de-duplicated across them. | `["Software Engineer", "Data Scientist"]` |
| `location` | `string` | No | Target location. Default `"United States"`. | `"London"` |
| `maxItems` | `integer` | No | Maximum jobs to return. Default `100`. LinkedIn serves up to 1,000 per query. | `1000` |
| `startUrls` | `array` | No | Use LinkedIn search URLs directly instead of building them from filters. Default `[]`. | `["https://www.linkedin.com/jobs/search?keywords=devops"]` |

![Search input section in Apify Console](https://raw.githubusercontent.com/Abhijeetshakya/scrapper2/main/images/input-search.png)

### 🎚️ Filters

| Field | Type | Required | Description | Example |
|---|---|---|---|---|
| `datePosted` | `string` | No | `any`, `past24hours`, `pastWeek`, `pastMonth`. Default `any`. | `"pastWeek"` |
| `jobType` | `string` | No | `any`, `fullTime`, `partTime`, `contract`, `temporary`, `internship`. Default `any`. | `"fullTime"` |
| `experienceLevel` | `string` | No | `any`, `internship`, `entryLevel`, `associate`, `midSenior`, `director`, `executive`. Default `any`. | `"midSenior"` |
| `remoteFilter` | `string` | No | `any`, `onSite`, `remote`, `hybrid`. Default `any`. | `"remote"` |

### ➕ Optional enrichment

Each of these adds requests and increases runtime. All are `false` by default.

| Field | Type | Required | Description | Example |
|---|---|---|---|---|
| `includeSalary` | `boolean` | No | Fetch pay for each job. Adds one request per job. Jobs without disclosed pay are still returned with `salary: null`. | `true` |
| `scrapeJobDetails` | `boolean` | No | Fetch full descriptions, skills, seniority, employment type, and apply links. Adds one request per job. | `true` |
| `scrapeCompanyDetails` | `boolean` | No | Fetch company industry, size, and website. Adds one request per unique company. | `true` |

> ### ⚠️ Caution: enabling `includeSalary` will slow the run considerably
>
> **LinkedIn does not expose salary as a structured field on its job listings.** There is no salary tag to read — pay is usually written into the job description itself, as ordinary prose among the responsibilities and benefits.
>
> Recovering it therefore means opening every job posting individually and parsing the salary out of plain text, rather than reading a clean value. That is roughly **10× the requests**, so a run that normally finishes in under a minute can take several minutes.
>
> Leave this **off** for fast bulk collection. Turn it on only when pay is the point of the search.

![Filters and Deep scraping options in Apify Console](https://raw.githubusercontent.com/Abhijeetshakya/scrapper2/main/images/input-filters.png)

### 🛠️ Performance and output control

| Field | Type | Required | Description | Example |
|---|---|---|---|---|
| `proxyConfiguration` | `object` | No | Apify Proxy settings. Default `{"useApifyProxy": true}`. Residential proxies recommended at volume. | `{"useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"]}` |
| `maxConcurrency` | `integer` | No | Requests in flight. Default `10`. | `5` |
| `requestsPerMinuteMultiplier` | `integer` | No | Rate cap = `maxConcurrency × this`. Default `30`. | `60` |
| `maxRequestRetries` | `integer` | No | Retries before a request is abandoned. Default `5`. | `8` |
| `outputFields` | `array` | No | Restrict records to these fields. Default `[]` (all fields). `jobId` is always kept. | `["title", "company", "jobUrl"]` |
| `resumeFromPreviousRun` | `boolean` | No | Skip jobs collected in earlier runs. Default `false`. | `true` |
| `webhookUrl` | `string` | No | URL to POST run events to (`HIGH_ERROR_RATE`, `COMPLETED`). | `"https://example.com/hook"` |
| `notifyOnCompletion` | `boolean` | No | Send a webhook when the run finishes. Default `false`. | `true` |
| `paginationBatchSize` | `integer` | No | Result pages queued per parallel wave. Default `8`. Higher fetches more in parallel but over-fetches on short result sets. | `12` |
| `requestDelayMinMs` | `integer` | No | Artificial minimum delay before each request, in ms. Default `0`. Leave at `0` — a delay here holds a concurrency slot open while it waits. | `0` |
| `requestDelayMaxMs` | `integer` | No | Upper bound of the artificial delay. Default `0` (disabled). Only useful for targets needing jittered spacing. | `0` |

![Proxy and performance settings in Apify Console](https://raw.githubusercontent.com/Abhijeetshakya/scrapper2/main/images/input-proxy-performance.png)

### 📝 Example input

```json
{
  "searchQueries": ["Software Engineer", "Backend Engineer"],
  "location": "United States",
  "maxItems": 1000,
  "datePosted": "pastWeek",
  "jobType": "fullTime",
  "remoteFilter": "remote",
  "proxyConfiguration": { "useApifyProxy": true }
}
```

---

## 📤 Output

Each job becomes one dataset item:

```json
{
  "jobId": "4467951950",
  "title": "Senior Software Engineer - Java",
  "company": "The Walt Disney Company",
  "companyUrl": "https://www.linkedin.com/company/the-walt-disney-company",
  "companyLogo": "https://media.licdn.com/dms/image/v2/D4E0BAQH.../company-logo_100_100.png",
  "location": "New York, NY",
  "locationParsed": {
    "city": "New York",
    "state": "NY",
    "country": null,
    "raw": "New York, NY"
  },
  "workplaceType": "On-site",
  "salary": null,
  "salarySource": null,
  "postedDate": "2026-09-16",
  "jobUrl": "https://www.linkedin.com/jobs/view/4467951950",
  "scrapedAt": "2026-09-19T13:16:15.000Z"
}
```

### 🔑 Key fields

| Field | Description |
|---|---|
| `jobId` | LinkedIn's unique posting ID. Stable, and used for de-duplication. |
| `title` / `company` | Job title and hiring company. |
| `companyLogo` | Direct image URL. Renders as an image in the Output tab. |
| `location` / `locationParsed` | Raw location text, plus a parsed `{city, state, country, raw}` object. |
| `workplaceType` | `Remote`, `Hybrid`, or `On-site`. |
| `salary` | Parsed object `{min, max, currency, period, raw}`, or `null`. Requires `includeSalary`. |
| `salarySource` | Where pay came from: `compensation` (LinkedIn's structured block) or `description` (recovered from the posting text). Useful for judging confidence. |
| `postedDate` | Publication date, ISO format where LinkedIn provides it. |
| `jobUrl` | Canonical posting URL with tracking parameters stripped. |

### 📄 With `scrapeJobDetails` enabled

Records additionally include `description`, `descriptionHtml`, `seniorityLevel`, `employmentType`, `jobFunction`, `industries`, `skills`, `applicants`, `easyApply`, and `applyUrl`.

### 🏢 With `scrapeCompanyDetails` enabled

Separate records with `"type": "COMPANY"` are added, containing `companySlug`, `name`, `industry`, `companySize`, `website`, and `description`.

---

## 💵 Pricing

This Actor uses Apify's **pay-per-result** model: **from $1.00 per 1,000 results**, which works out to $0.001 per job.

You are charged only for the results actually delivered to your dataset. The requests, retries, proxy traffic, and compute behind them are not billed to you — that cost sits with the Actor, not with your account.

| You request | You receive | You pay |
|---|---|---|
| 100 jobs | 100 | $0.10 |
| 500 jobs | 500 | $0.50 |
| 1,000 jobs | ~991 (after de-duplication) | ~$0.99 |

**Enrichment is free of extra charge.** Turning on `includeSalary`, `scrapeJobDetails`, or `scrapeCompanyDetails` multiplies the requests made behind the scenes, but your price per result does not change. A job with a full description and salary costs exactly the same $0.001 as a bare listing.

Two things worth knowing:

- **You only pay for unique jobs.** De-duplication happens before results are written, so you are never billed twice for the same posting — a 1,000-job request that yields 991 unique jobs bills for 991, not 1,000.
- **`scrapeCompanyDetails` adds records.** Company profiles are written as separate dataset items with `"type": "COMPANY"`, and each counts as a result. A 100-job run spanning 60 distinct companies produces 160 billable records. Leave the option off if you only want job rows.

Apify free-plan credits apply, so you can trial the Actor before spending anything.

---

## 🎯 Use cases

📋 **Job board aggregation.** Refresh thousands of listings on a schedule. Pair `resumeFromPreviousRun` with a daily trigger to fetch only newly posted roles instead of re-scraping the full set.

🧑‍💼 **Recruitment and talent sourcing.** Track which companies are hiring for a given role in a given market. Filter by `experienceLevel` and `remoteFilter` to find competitors staffing specific seniority bands.

📊 **Labor market research.** Collect postings across roles and regions to analyze demand, remote-work ratios, and — with `includeSalary` — compensation bands by title and location.

📈 **Sales lead generation.** Companies posting engineering roles are companies growing engineering teams. Use `scrapeCompanyDetails` to enrich each hit with industry and headcount.

---

## ❓ FAQ

**Do I need a LinkedIn account, cookies, or session token?**
No. The Actor only reads LinkedIn's publicly accessible guest job endpoints. There is nothing to authenticate.

**Does it work with proxies?**
Yes, and proxies are enabled by default via Apify Proxy. LinkedIn rate-limits aggressively, so **residential proxies are strongly recommended** for large runs. Configure them through `proxyConfiguration`.

**What are the rate limits, and why do some requests fail?**
LinkedIn throttles guest traffic and sometimes serves bot-challenge pages with an HTTP 200 status. The Actor detects these, retires the session, and retries with a new session and proxy using randomized backoff. A modest failure rate on large runs is normal — the run still completes. Lower `maxConcurrency` or use residential proxies to reduce it.

**Can I run this on a schedule?**
Yes. Use Apify Schedules. Combine with `resumeFromPreviousRun: true` so each run returns only jobs not seen previously.

**Why did I get 991 results instead of 1,000?**
LinkedIn caps any single search at 1,000 result slots, and duplicate postings that appear at more than one offset are removed. You receive unique jobs rather than a padded count. To exceed 1,000, split the work across multiple `searchQueries`, locations, or date windows.

**Why is `salary` null?**
Either `includeSalary` is off (the default), or the employer did not disclose pay. LinkedIn does not include salary on search result cards at all, so retrieving it requires opening each posting individually. Roughly half of postings disclose pay.

---

## 🏁 Getting started

### 1️⃣ Run in Apify Console

1. Open the Actor in Apify Console and click **Try for free**.
2. Enter your keywords under **Search Queries** and set a **Location**.
3. Set **Maximum Items** (start with `100` to preview).
4. Click **Start** and watch results populate the **Output** tab.
5. Export as JSON, CSV, or Excel from the **Export** button.

### 2️⃣ Run via API

```bash
curl -X POST "https://api.apify.com/v2/acts/unknownbrain~fast-linkedin-jobs-scraper/runs?token=YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "searchQueries": ["Software Engineer"],
    "location": "United States",
    "maxItems": 500,
    "remoteFilter": "remote"
  }'
```

To run and receive the dataset in one synchronous call:

```bash
curl -X POST "https://api.apify.com/v2/acts/unknownbrain~fast-linkedin-jobs-scraper/run-sync-get-dataset-items?token=YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "searchQueries": ["Data Scientist"], "maxItems": 100 }'
```

### 3️⃣ Run via Apify CLI

```bash
npm install -g apify-cli
apify login
apify call unknownbrain/fast-linkedin-jobs-scraper \
  --input '{"searchQueries":["Product Manager"],"location":"Berlin","maxItems":200}'
```

### 4️⃣ Use the JavaScript client

```javascript
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: 'YOUR_API_TOKEN' });

const run = await client.actor('unknownbrain/fast-linkedin-jobs-scraper').call({
    searchQueries: ['Software Engineer'],
    location: 'United States',
    maxItems: 1000,
    datePosted: 'pastWeek',
});

const { items } = await client.dataset(run.defaultDatasetId).listItems();
console.log(`Scraped ${items.length} jobs`);
```

---

## ⚠️ Limitations and known issues

- **1,000 results per search.** This is LinkedIn's own ceiling, not an Actor limit. Split across queries, locations, or date ranges to collect more.
- **Salary availability.** Roughly half of postings disclose pay, and most that do place it in the description body rather than a structured field. The Actor reads both and reports which via `salarySource`.
- **Enrichment costs speed.** `includeSalary` and `scrapeJobDetails` each add one request per job, turning a sub-minute run into several minutes. Leave them off for bulk collection.
- **Rate limiting.** LinkedIn actively defends these endpoints. Some requests fail on large runs even with retries; residential proxies materially improve success rates.
- **Slight under-count is expected.** De-duplication means a 1,000-item request typically returns 985–1,000 unique jobs.
- **Relative dates.** For some postings LinkedIn provides only relative text ("2 weeks ago") rather than an exact date.

---

## 💬 Support & feedback

- **Bug reports and feature requests:** open an issue on the Actor's **Issues** tab in Apify Console. Please include your run ID and input JSON — both make problems far faster to reproduce.
- **Questions:** use the Issues tab or contact the developer through the Apify Store page.

Feedback on which fields or filters you need most is genuinely useful and shapes what gets added next.

---

## ⚖️ Legal and responsible use

This Actor collects **publicly available** job postings that require no login to view. It does not access private profiles, personal data behind authentication, or any content requiring credentials.

You are responsible for ensuring your use complies with applicable laws — including data protection regulations such as GDPR and CCPA — and with LinkedIn's terms of service. Intended for lawful market research, recruitment analytics, and job aggregation.

---

### ⚡ Built for speed. Try a run — most finish before you've read this page.
