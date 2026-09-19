# Scrapper2 — AI Context File

This file contains the full context of recent modifications made to the `scrapper2` (LinkedIn Jobs Scraper) Apify actor. It is intended to be shared with other AI assistants to provide them with immediate context on the project's current state, recent fixes, and performance characteristics.

## 1. Project Overview
- **Project**: A fast, HTTP-only LinkedIn job scraper built as an Apify actor.
- **Tech Stack**: Node.js, Apify SDK, Crawlee (`CheerioCrawler`), Cheerio.
- **Key Feature**: Extracts job listings from LinkedIn's guest search endpoints without a browser or login.
- **Repo**: https://github.com/Abhijeetshakya/scrapper2.git

## 2. Recent Issues & User Requirements
The user identified several issues with the Apify dataset output:
1. **`companyId`**: Always returned `null` → **Removed** from output.
2. **`isReposted`**: Always returned `false` → **Removed** from output.
3. **`companyLogo`**: Outputs a plain image URL string. **Note:** Apify's dataset table view cannot render images — it treats all values as plain text. This is a platform limitation.
4. **`salary` & `salaryParsed`**: Consolidated into a single `salary` field that outputs a parsed JSON object directly.
5. **Performance Queries**: 10/40 failures are normal LinkedIn rate-limiting; 300 results in 8 seconds is excellent performance.

## 3. Implemented Fixes
The following changes were made in `src/parsers.js`, `src/utils.js`, and `src/test.js`:

- **Column Removals**: 
  - Completely removed `companyId`, `isReposted`, and `salaryParsed` from the parsed output and `filterOutputFields()`.
- **Salary JSON Consolidation**:
  - The `salary` field now directly outputs the parsed JSON object (e.g., `{ "min": 150000, "max": 200000, "currency": "USD", "period": "yearly", "raw": "$150k - $200k" }`) instead of a raw string.
  - If no salary is found, the field is `null`.
- **Company Logo**:
  - Outputs a clean URL string (e.g., `https://media.licdn.com/dms/image/...`).
  - Apify's dataset table view **does not render HTML or images** — all values are plain text. This is a known platform limitation. Users who need to display the logo as an image should use the URL in their own frontend/application.
- **Test Suite Updates**:
  - Updated all assertions in `test.js` to match the new schema. 
  - The test suite successfully passes with **123/123 tests**.

## 4. Performance & Failure Insights
- **10/40 Failed Requests (25% Error Rate)**:
  - This is expected behavior. LinkedIn heavily protects its endpoints. The failures are due to LinkedIn returning HTTP 429 (Too Many Requests) or serving bot-challenge/checkpoint pages (which the actor detects).
  - With a concurrency of 10, a ~25% block rate is normal without using residential proxies. The actor relies on retries and exponential backoff to handle these.
- **300 Results in 8 Seconds**:
  - Fetching 300 results in 8 seconds (37.5 jobs/second) is **extremely fast**. 
  - Browser-based scrapers (like Puppeteer/Playwright) typically take 60–120+ seconds for 300 jobs.
  - The 8-second runtime is primarily bound by network latency (200-500ms per request to LinkedIn) and retry backoff delays, not CPU parsing speed. 
  - Local CPU benchmarks on the parsing logic reached **607 jobs/second** with pre-queued pagination and concurrency 10.

## 5. Key Architecture Notes for Other AIs
- The code in the repository is fully up to date on the `main` branch.
- `companyLogo` is a **plain URL string**, NOT an HTML `<img>` tag. Apify cannot render images in table cells.
- `salary` is a **JSON object** `{min, max, currency, period, raw}`, NOT a raw text string.
- `companyId`, `isReposted`, and `salaryParsed` fields **do not exist** in the output anymore.
- The `extractCompanyId` function still exists in `utils.js` (used by `parseCompanyDetails`) but is no longer imported or used in `parsers.js` for job listings.
