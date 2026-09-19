# ⚡ Fast LinkedIn Jobs Scraper

### **Up to 1,000 LinkedIn jobs in ~30 seconds. No browser. No login. No cookies.**

Most LinkedIn scrapers drive a headless browser — rendering pages, waiting on JavaScript, burning minutes of compute you pay for. This one talks to LinkedIn's public guest endpoints over **pure HTTP** and parses the HTML directly.

Same data. A fraction of the time. A fraction of the cost.

---

## 🏁 Real measured performance

Not estimates — actual runs from the Apify console:

| Jobs returned | Requests | Duration | Failures |
|---|---|---|---|
| **991** | 100 | **32 s** | 0 |
| **400** | 40 | **10 s** | 0 |
| **400** | 40 | **13 s** | 0 |
| **400** | 40 | **18 s** | 0 |

**~31 jobs per second.** A browser-based scraper is typically still launching Chromium at the 10-second mark.

> Cost check: a 400-job run costs about **$0.005**. A 1,000-job run about **$0.012**.

---

## 🚀 Why it's this fast

| | This actor | Browser-based scrapers |
|---|---|---|
| Engine | Pure HTTP + Cheerio | Chromium / Playwright |
| Page render | None needed | Full JS render per page |
| Login / cookies | **Never required** | Usually required |
| Memory | Runs fine on 1 GB | 4 GB+ typical |
| 1,000 jobs | **~30 seconds** | Several minutes |

Three design decisions do the heavy lifting:

- **Pre-queued pagination.** LinkedIn's page offsets are deterministic, so pages are fetched **in parallel** rather than discovered one-at-a-time. Serial discovery would bottleneck the entire crawl through a single request regardless of concurrency.
- **Zero rendering.** No browser process, no JS execution, no screenshot buffers.
- **One-pass parsing.** Each job card's DOM subtree is traversed once, not repeatedly.

---

## 🛡️ Built to be reliable, not just quick

Speed is worthless if the run dies halfway. LinkedIn actively defends these endpoints, so this actor expects that:

- **Full-jitter retry backoff.** On a block, the session is retired and retried with a fresh session and proxy. Backoff samples the whole window rather than a fixed curve — otherwise every concurrent worker retries *in lockstep* and re-bursts a host that's already pushing back.
- **Silent-block detection.** LinkedIn serves login walls and bot checkpoints with an **HTTP 200**. Status codes alone miss them, so response bodies are scanned for challenge markers and treated as failures.
- **Adaptive throttling.** If the rolling block rate crosses 30%, concurrency automatically halves and an optional webhook fires.
- **Resumable runs.** `resumeFromPreviousRun` skips everything already scraped, so scheduled runs only fetch what's new.
- **Never loses a partial.** If a detail page fails, the listing data already collected is still saved, flagged `detailScrapeFailed`.
- **163 automated tests** covering every parser and edge case.

---

## 📦 What you get

Every job returns clean, structured JSON:

```json
{
  "jobId": "4467951950",
  "title": "Senior Software Engineer - Java",
  "company": "The Walt Disney Company",
  "companyUrl": "https://www.linkedin.com/company/the-walt-disney-company",
  "companyLogo": "https://media.licdn.com/dms/image/...",
  "location": "New York, NY",
  "locationParsed": { "city": "New York", "state": "NY", "country": null, "raw": "New York, NY" },
  "workplaceType": "On-site",
  "salary": null,
  "postedDate": "2026-09-16",
  "jobUrl": "https://www.linkedin.com/jobs/view/4467951950",
  "scrapedAt": "2026-09-19T13:16:15.000Z"
}
```

Enable **Deep Scrape: Job Details** and each record also carries `description`, `descriptionHtml`, `seniorityLevel`, `employmentType`, `jobFunction`, `industries`, `skills`, `applicants`, `easyApply`, and `applyUrl`.

Company logos render as **actual images** in the Output tab — not raw URLs.

---

## ⚙️ Quick start

```json
{
  "searchQueries": ["Software Engineer", "Data Scientist"],
  "location": "United States",
  "maxItems": 1000,
  "datePosted": "pastWeek",
  "remoteFilter": "remote"
}
```

That's it. No credentials, no cookie extraction, no session setup.

---

## 🎛️ Input reference

### Search

| Parameter | Type | Default | Description |
|---|---|---|---|
| `searchQueries` | `string[]` | `["Software Engineer"]` | Keywords to search. Each runs separately; results are de-duplicated across them. |
| `location` | `string` | `"United States"` | e.g. `"London"`, `"Berlin, Germany"` |
| `maxItems` | `integer` | `100` | Jobs to scrape. **LinkedIn serves up to 1,000 per query.** |
| `startUrls` | `array` | `[]` | Supply LinkedIn search URLs directly instead of building them from filters. |

### Filters

| Parameter | Options |
|---|---|
| `datePosted` | `any`, `past24hours`, `pastWeek`, `pastMonth` |
| `jobType` | `any`, `fullTime`, `partTime`, `contract`, `temporary`, `internship` |
| `experienceLevel` | `any`, `internship`, `entryLevel`, `associate`, `midSenior`, `director`, `executive` |
| `remoteFilter` | `any`, `onSite`, `remote`, `hybrid` |

### Optional enrichment — *these trade speed for depth*

| Parameter | Default | Cost |
|---|---|---|
| `includeSalary` | `false` | ⚠️ One extra request **per job**. Keep off for full speed. |
| `scrapeJobDetails` | `false` | ⚠️ One extra request per job. Adds descriptions, skills, seniority. |
| `scrapeCompanyDetails` | `false` | One extra request per unique company. Adds industry, size, website. |

### Performance & output

| Parameter | Default | Description |
|---|---|---|
| `maxConcurrency` | `10` | Requests in flight. Lower it if blocks rise. |
| `requestsPerMinuteMultiplier` | `30` | Rate cap = `maxConcurrency × this`. |
| `maxRequestRetries` | `5` | Retries before a request is abandoned. |
| `proxyConfiguration` | Apify Proxy | **Residential proxies strongly recommended at volume.** |
| `outputFields` | `[]` (all) | Trim records to just the fields you need. |
| `resumeFromPreviousRun` | `false` | Skip anything scraped in a previous run. |
| `webhookUrl` / `notifyOnCompletion` | — | POST run events (`HIGH_ERROR_RATE`, `COMPLETED`). |

---

## 💰 A note on salary — read this before enabling

**LinkedIn does not put salary on search result cards.** Nothing can change that. Getting pay means opening every job individually — roughly **10× the requests**, turning a 30-second run into several minutes.

There's a second reality worth knowing: **only about half of postings disclose pay at all**, and of those, most bury it in the description body rather than a structured field. This actor reads both, and tells you which via `salarySource` (`compensation` or `description`).

With `includeSalary` **off**, every job is still returned — `salary` is simply `null`. Nothing is hidden or filtered out.

**Recommendation:** leave it off for bulk collection. Turn it on for targeted searches where pay is the point.

---

## 🎯 Built for

- **Job boards & aggregators** — refresh thousands of listings in seconds
- **Recruiting & sourcing** — track who's hiring, where, and for what
- **Market research** — salary bands, skill demand, remote-work trends
- **ATS / CRM pipelines** — clean JSON straight into your stack
- **Lead generation** — find companies actively growing a team

---

## ❓ FAQ

**Do I need a LinkedIn account or cookies?**
No. It uses LinkedIn's public guest endpoints. Nothing to configure.

**Why did I get 991 instead of 1,000?**
LinkedIn's ceiling is 1,000 result slots per search, and duplicates are removed. You get ~99% unique jobs rather than a padded count with repeats. Use multiple `searchQueries` or locations to go beyond 1,000.

**Can I get more than 1,000 jobs?**
Not from a single query — that's LinkedIn's hard limit. Split across several queries, locations, or date windows.

**Why is `salary` null?**
Either `includeSalary` is off (default), or the employer didn't disclose pay. See the salary section above.

**Some requests failed. Is it broken?**
No. LinkedIn rate-limits aggressively; the actor retries with fresh sessions and backoff. A modest failure rate is normal and the run still completes. Use residential proxies to reduce it.

---

## ⚖️ Legal

This actor collects **publicly accessible** job postings that require no login to view. You are responsible for ensuring your use complies with applicable laws, including data-protection regulations, and with LinkedIn's terms. Intended for lawful research, analysis, and job-market intelligence.

---

### ⚡ Fast. Reliable. No login. Try a run — it'll finish before you've read this far.
