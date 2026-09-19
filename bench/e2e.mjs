/**
 * End-to-end benchmark using real Crawlee against a local fixture server that
 * mimics LinkedIn's guest search endpoint (25 cards per page, `start` offsets).
 *
 * Compares three configurations:
 *   A. current   — 150-650ms preNav sleep, maxRequestsPerMinute = conc*8,
 *                  pagination discovered one page at a time
 *   B. no-sleep  — same, minus the artificial delay
 *   C. fixed     — no sleep, rate cap raised, pagination pre-queued
 *
 * Server latency is fixed at 80ms so the only variable is the crawler config.
 */
import http from 'node:http';
import { CheerioCrawler, Configuration, log as crawleeLog } from 'crawlee';

crawleeLog.setLevel(crawleeLog.LEVELS.OFF);
Configuration.getGlobalConfig().set('persistStorage', false);

const PORT = 8911;
const SERVER_LATENCY_MS = 80;
const CARDS_PER_PAGE = 25;
const TOTAL_PAGES = Number(process.env.PAGES || 8);
const MAX_ITEMS = CARDS_PER_PAGE * TOTAL_PAGES;

// ─── Fixture server ────────────────────────────────────────────────────
function card(i) {
    return `<li><div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:${4000000000 + i}">
<a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/${4000000000 + i}?trk=g"><span class="sr-only">Engineer ${i}</span></a>
<div class="base-search-card__info"><h3 class="base-search-card__title">Engineer ${i}</h3>
<h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="https://www.linkedin.com/company/${20000 + i}">Company ${i}</a></h4>
<div class="base-search-card__metadata"><span class="job-search-card__location">San Francisco, CA (Remote)</span>
<time datetime="2026-09-15">2 days ago</time><span class="job-search-card__salary-info">$150,000 - $200,000/yr</span></div>
</div></div></li>`;
}
const CHROME = Array.from({ length: 80 }, (_, i) => `<li class="nav-item"><a href="/n/${i}">Nav ${i}</a></li>`).join('');

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const start = parseInt(url.searchParams.get('start') || '0', 10);
    const page = Math.floor(start / CARDS_PER_PAGE);
    const body = page >= TOTAL_PAGES
        ? '<html><body><ul></ul></body></html>'
        : `<html><body><nav><ul>${CHROME}</ul></nav><ul class="jobs-search__results-list">${
            Array.from({ length: CARDS_PER_PAGE }, (_, i) => card(page * CARDS_PER_PAGE + i)).join('')
          }</ul><footer><ul>${CHROME}</ul></footer></body></html>`;
    setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(body);
    }, SERVER_LATENCY_MS);
});

const BASE = `http://127.0.0.1:${PORT}/search`;

// ─── Shared parse step (identical in every config, so it isn't the variable) ──
import { parseJobListing } from '../src/parsers.js';

// ─── One benchmark run ─────────────────────────────────────────────────
let RUN_ID = 0;
async function run({ name, sleepMs, rpmMultiplier, prequeuePagination, maxConcurrency }) {
    const rid = ++RUN_ID;
    const seen = new Set();
    let pushed = 0;
    let crawler;

    const opts = {
        maxConcurrency,
        minConcurrency: 1,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 60,
        useSessionPool: false,
        async requestHandler({ request, $ }) {
            const jobs = [];
            $('li').each((_, el) => {
                if (seen.size >= MAX_ITEMS) return false;
                const job = parseJobListing($, el);
                if (!job || !job.jobId || seen.has(job.jobId)) return;
                seen.add(job.jobId);
                jobs.push(job);
            });
            pushed += jobs.length;

            // Original behaviour: next page only discovered after this one parses.
            if (!prequeuePagination && jobs.length > 0 && seen.size < MAX_ITEMS) {
                const u = new URL(request.url);
                const next = parseInt(u.searchParams.get('start') || '0', 10) + CARDS_PER_PAGE;
                if (next < CARDS_PER_PAGE * TOTAL_PAGES) {
                    u.searchParams.set('start', String(next));
                    await crawler.addRequests([{ url: u.toString(), uniqueKey: `r${rid}-${u.toString()}` }]);
                }
            }
        },
    };

    if (rpmMultiplier !== null) opts.maxRequestsPerMinute = maxConcurrency * rpmMultiplier;

    if (sleepMs) {
        opts.preNavigationHooks = [async () => {
            await new Promise((r) => setTimeout(r, sleepMs[0] + Math.floor(Math.random() * sleepMs[1])));
        }];
    }

    crawler = new CheerioCrawler(opts);

    // Pre-queued pagination: `start` offsets are deterministic, so every page
    // can be requested immediately instead of discovered one at a time.
    const startRequests = prequeuePagination
        ? Array.from({ length: Math.ceil(MAX_ITEMS / CARDS_PER_PAGE) }, (_, i) => ({
            url: `${BASE}?start=${i * CARDS_PER_PAGE}`,
            uniqueKey: `r${rid}-s-${i}`,
        }))
        : [{ url: `${BASE}?start=0`, uniqueKey: `r${rid}-s-0` }];

    const t0 = process.hrtime.bigint();
    await crawler.run(startRequests);
    const elapsed = Number(process.hrtime.bigint() - t0) / 1e9;

    return { name, elapsed, pushed, throughput: pushed / elapsed };
}

// ─── Drive ─────────────────────────────────────────────────────────────
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

console.log(`\n${'='.repeat(72)}`);
console.log(`END-TO-END — ${MAX_ITEMS} jobs across ${TOTAL_PAGES} pages, ${SERVER_LATENCY_MS}ms server latency`);
console.log(`${'='.repeat(72)}\n`);

const configs = [
    { name: 'A. current (sleep 150-650ms, rpm=conc*8, serial pages)',
      sleepMs: [150, 500], rpmMultiplier: 8, prequeuePagination: false, maxConcurrency: 5 },
    { name: 'B. + drop artificial sleep',
      sleepMs: null, rpmMultiplier: 8, prequeuePagination: false, maxConcurrency: 5 },
    { name: 'C. + raise rate cap (rpm=conc*30)',
      sleepMs: null, rpmMultiplier: 30, prequeuePagination: false, maxConcurrency: 5 },
    { name: 'D. + pre-queue pagination',
      sleepMs: null, rpmMultiplier: 30, prequeuePagination: true, maxConcurrency: 5 },
    { name: 'E. + concurrency 10',
      sleepMs: null, rpmMultiplier: 30, prequeuePagination: true, maxConcurrency: 10 },
];

const results = [];
for (const cfg of configs) {
    const r = await run(cfg);
    results.push(r);
    console.log(`  ${r.name.padEnd(52)} ${r.elapsed.toFixed(2)}s  ` +
                `${r.throughput.toFixed(0).padStart(4)} jobs/s  ` +
                `${r.pushed} jobs`);
}

const base = results[0].elapsed;
console.log(`\n  cumulative speedup vs current: ${(base / results.at(-1).elapsed).toFixed(1)}x ` +
            `(${base.toFixed(2)}s -> ${results.at(-1).elapsed.toFixed(2)}s)\n`);

server.close();
process.exit(0);
