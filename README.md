# LinkedIn Jobs Scraper — Apify Actor

🚀 **Fast, HTTP-only LinkedIn job scraper** — no browser, no login, no cookies required.

This Apify actor scrapes job listings from LinkedIn's public guest-accessible endpoints using [Crawlee's CheerioCrawler](https://crawlee.dev/), making it **significantly faster and cheaper** than browser-based alternatives.

## Features

- ⚡ **HTTP-only scraping** — No Playwright/Puppeteer overhead. Pure HTTP + Cheerio parsing.
- 🔓 **No login required** — Uses LinkedIn's guest job search endpoints.
- 🔍 **Rich filtering** — Keywords, location, date posted, job type, experience level, remote/hybrid/on-site.
- 📄 **Optional detail scraping** — Get full job descriptions, seniority level, industry, and more.
- 🔄 **Auto-pagination** — Automatically paginates through search results.
- 🛡️ **Anti-blocking** — Session pool, proxy rotation, rate limiting, and retries built-in.
- 📊 **Structured output** — Clean JSON dataset ready for further processing.

## Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `searchQueries` | `string[]` | `["Software Engineer"]` | Job search keywords |
| `location` | `string` | `"United States"` | Location filter |
| `maxItems` | `integer` | `100` | Maximum jobs to scrape (1–1000) |
| `scrapeJobDetails` | `boolean` | `false` | Scrape full job descriptions (slower) |
| `datePosted` | `enum` | `"any"` | `any`, `past24hours`, `pastWeek`, `pastMonth` |
| `jobType` | `enum` | `"any"` | `any`, `fullTime`, `partTime`, `contract`, `temporary`, `internship` |
| `experienceLevel` | `enum` | `"any"` | `any`, `internship`, `entryLevel`, `associate`, `midSenior`, `director`, `executive` |
| `remoteFilter` | `enum` | `"any"` | `any`, `onSite`, `remote`, `hybrid` |
| `includeSalary` | `boolean` | `false` | Fetch pay for each job. **Much slower** — one extra request per job. All jobs are still returned; salary is `null` when not disclosed. |
| `maxConcurrency` | `integer` | `5` | Concurrent requests (1–20) |
| `proxyConfiguration` | `object` | — | Apify proxy settings |
| `resumeFromPreviousRun` | `boolean` | `false` | Skip jobs/companies already scraped in a prior run (persisted in the key-value store) |
| `outputFields` | `string[]` | `[]` (all fields) | Restrict pushed records to these fields, plus id fields |
| `webhookUrl` | `string` | — | URL to POST JSON run events to (`HIGH_ERROR_RATE`, `COMPLETED`) |
| `notifyOnCompletion` | `boolean` | `false` | Send a webhook event when the run finishes |
| `errorRateThreshold` | `number` | `0.3` | Blocked/failed request ratio that triggers automatic concurrency throttling and a webhook alert |

## Example Input

```json
{
    "searchQueries": ["Data Scientist", "Machine Learning Engineer"],
    "location": "San Francisco",
    "maxItems": 50,
    "scrapeJobDetails": true,
    "datePosted": "pastWeek",
    "jobType": "fullTime",
    "remoteFilter": "remote",
    "maxConcurrency": 3
}
```

## Output

Each job listing produces a JSON object like:

```json
{
    "jobId": "3912345678",
    "title": "Senior Data Scientist",
    "company": "Acme Corp",
    "location": "San Francisco, CA (Remote)",
    "salary": "$150,000 - $200,000",
    "postedDate": "2024-01-15",
    "jobUrl": "https://www.linkedin.com/jobs/view/3912345678",
    "scrapedAt": "2024-01-16T10:30:00.000Z",
    "description": "We are looking for a Senior Data Scientist...",
    "seniorityLevel": "Mid-Senior level",
    "employmentType": "Full-time",
    "jobFunction": "Engineering and Information Technology",
    "industries": "Technology, Information and Internet",
    "applicants": "Over 200 applicants",
    "companyUrl": "https://www.linkedin.com/company/acme-corp"
}
```

> **Note:** Fields like `description`, `seniorityLevel`, etc. are only available when `scrapeJobDetails` is enabled.

## Resilience & Anti-Blocking

- **429-aware backoff** — on a rate-limit or block response, the actor retires the session, waits with exponential backoff (2s → 4s → 8s… capped at 60s, with jitter), and retries with a fresh session/proxy.
- **Challenge/checkpoint detection** — LinkedIn sometimes returns a login-wall or bot-checkpoint page with a `200` status. The actor scans response bodies for these patterns and treats them as failures so they get retried like any other block.
- **Adaptive concurrency** — if the rolling blocked-request rate exceeds `errorRateThreshold` (default 30%), the actor automatically halves its concurrency ceiling and (optionally) fires a webhook alert.
- **Resumable runs** — with `resumeFromPreviousRun: true`, the actor loads the job/company IDs it saw last time from the key-value store and skips them, so a scheduled/recurring run only scrapes what's new.

## Structured Output Extras

In addition to the raw `salary` and `location` strings, each job record includes parsed breakdowns:

```json
{
    "salary": "$150,000 - $200,000",
    "salaryParsed": { "min": 150000, "max": 200000, "currency": "USD", "period": "yearly", "raw": "$150,000 - $200,000" },
    "location": "San Francisco, CA",
    "locationParsed": { "city": "San Francisco", "state": "CA", "country": null, "raw": "San Francisco, CA" }
}
```

Use `outputFields` in the input if you'd rather receive a trimmed record (e.g. `["title", "company", "salaryParsed"]`) instead of the full object.

## Performance Tips

1. **Keep `scrapeJobDetails` off** for fastest results — listing data is scraped in bulk from search pages.
2. **Use `maxConcurrency: 3-5`** for a good balance of speed and reliability.
3. **Use Apify residential proxies** for best success rates against LinkedIn's anti-bot systems.
4. **Filter aggressively** — Use specific keywords and filters to reduce the number of pages to scrape.

## Running Locally

```bash
# Install dependencies
npm install

# Run with Apify CLI
apify run --input '{"searchQueries": ["Software Engineer"], "maxItems": 10}'

# Or run directly
npm start
```

## Deployment

```bash
# Login to Apify
apify login

# Deploy to Apify platform
apify push
```

## How It Works

1. **Builds search URLs** from your input parameters, targeting LinkedIn's guest job search API endpoint.
2. **Fetches search result pages** using pure HTTP requests (CheerioCrawler) — no browser rendering needed.
3. **Parses job cards** from the HTML response using Cheerio (jQuery-like selectors).
4. **Paginates automatically** by incrementing the `start` parameter (25 jobs per page).
5. **Optionally fetches detail pages** for each job to extract full descriptions and metadata.
6. **Outputs structured data** to the Apify dataset in JSON format.

## Legal Disclaimer

This actor is intended for personal and educational use. Scraping LinkedIn may violate their Terms of Service. Users are responsible for ensuring compliance with applicable laws and LinkedIn's User Agreement. Use at your own risk.

## License

ISC
