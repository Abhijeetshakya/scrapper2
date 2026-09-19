import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';
import { buildSearchUrls, isChallengePage, filterOutputFields, buildPaginationUrls, extractCompanyKey, extractCompanyId } from './utils.js';
import { parseJobListing, parseJobDetails, parseCompanyDetails } from './parsers.js';
import { LABELS, LINKEDIN_BASE, BLOCKED_STATUS_CODES, DEFAULTS } from './constants.js';

await Actor.init();

// ─── Input ───────────────────────────────────────────────────────────
const input = await Actor.getInput() ?? {};
const {
    searchQueries = ['Software Engineer'],
    location = 'United States',
    maxItems = 100,
    scrapeJobDetails = false,
    scrapeCompanyDetails = false,
    requireSalary = false,             // Only keep jobs that disclose pay
    datePosted = 'any',
    jobType = 'any',
    experienceLevel = 'any',
    remoteFilter = 'any',
    proxyConfiguration: proxyConfig,
    startUrls = [],

    // ─── New options ───────────────────────────────────────────────
    resumeFromPreviousRun = false,     // Skip jobs/companies already seen in prior runs
    outputFields = [],                 // Restrict pushed records to these fields (+ id fields). Empty = all fields.
    webhookUrl = null,                 // POSTed with run summaries if set
    notifyOnCompletion = false,        // Send a webhook when the run finishes
    errorRateThreshold = DEFAULTS.ERROR_RATE_THRESHOLD,

    // ─── Performance tuning (defaults all live in constants.js) ────
    maxConcurrency = DEFAULTS.MAX_CONCURRENCY,
    requestsPerMinuteMultiplier = DEFAULTS.REQUESTS_PER_MINUTE_MULTIPLIER,
    requestDelayMinMs = DEFAULTS.REQUEST_DELAY_MIN_MS,
    requestDelayMaxMs = DEFAULTS.REQUEST_DELAY_MAX_MS,
    paginationBatchSize = DEFAULTS.PAGINATION_BATCH_SIZE,
    maxRequestRetries = DEFAULTS.MAX_REQUEST_RETRIES,
} = input;

const { JOBS_PER_PAGE, MAX_SEARCH_OFFSET } = DEFAULTS;

// Salary is never present on a search card - it lives on the job detail page,
// and LinkedIn ignores its own f_SB2 salary filter on the guest endpoint. So
// requireSalary cannot work without deep scraping. Enable it rather than let
// the run return nothing at all.
const scrapeDetails = scrapeJobDetails || requireSalary;
if (requireSalary && !scrapeJobDetails) {
    log.info('requireSalary is enabled, so job detail pages will be fetched: search result cards carry no salary data.');
}

log.info('Starting LinkedIn Jobs Scraper', {
    searchQueries,
    location,
    maxItems,
    scrapeJobDetails: scrapeDetails,
    scrapeCompanyDetails,
    requireSalary,
    resumeFromPreviousRun,
});

// ─── Proxy ───────────────────────────────────────────────────────────
const proxyConfiguration = proxyConfig
    ? await Actor.createProxyConfiguration(proxyConfig)
    : undefined;

// ─── Persistence keys (default key-value store) ─────────────────────
const SEEN_JOB_IDS_KEY = 'SEEN_JOB_IDS';
const SEEN_COMPANY_IDS_KEY = 'SEEN_COMPANY_IDS';

// ─── State ───────────────────────────────────────────────────────────
let pushedItems = 0;      // Items actually pushed to dataset (this run)
let queuedItems = 0;      // Items queued (pushed + pending detail pages)
const seenJobIds = new Set();     // Deduplication across search queries (and, optionally, prior runs)
const seenCompanyIds = new Set(); // Deduplication of company page requests

// Salary-filter accounting. `queueCeiling()` uses these to decide how far to
// over-fetch so that maxItems is still reached after the misses are discarded.
let detailsSeen = 0;
let detailsWithSalary = 0;
let droppedNoSalary = 0;

/**
 * How many items may be queued. Without requireSalary this is just maxItems.
 * With it, every detail page that discloses no pay is thrown away, so more has
 * to be queued than is wanted. The multiplier tracks the rate actually observed
 * rather than being fixed, because disclosure varies widely by query, location
 * and local pay-transparency law, and it is capped so a query where nobody
 * discloses cannot fan out indefinitely.
 */
function queueCeiling() {
    if (!requireSalary) return maxItems;
    const rate = detailsSeen >= DEFAULTS.SALARY_RATE_MIN_SAMPLE
        ? Math.max(detailsWithSalary / detailsSeen, DEFAULTS.SALARY_RATE_FLOOR)
        : DEFAULTS.SALARY_RATE_INITIAL;
    return Math.min(Math.ceil(maxItems / rate), maxItems * DEFAULTS.SALARY_MAX_OVERFETCH);
}

// Rolling counters used to decide when to throttle concurrency / send alert webhooks
const rateLimitState = {
    totalAttempts: 0,
    blockedAttempts: 0,
    alertSent: false,
};

// ─── Resume from a previous run, if requested ────────────────────────
if (resumeFromPreviousRun) {
    const previousJobIds = await Actor.getValue(SEEN_JOB_IDS_KEY);
    if (Array.isArray(previousJobIds)) {
        previousJobIds.forEach((id) => seenJobIds.add(id));
        log.info(`Resumed with ${seenJobIds.size} job ID(s) seen in previous run(s).`);
    }
    const previousCompanyIds = await Actor.getValue(SEEN_COMPANY_IDS_KEY);
    if (Array.isArray(previousCompanyIds)) {
        previousCompanyIds.forEach((id) => seenCompanyIds.add(id));
    }
}

/**
 * Persist the seen-ID sets so a future run with `resumeFromPreviousRun: true`
 * can skip what has already been scraped.
 *
 * Debounced on wall-clock time rather than an item count. The previous version
 * fired on `pushedItems % 25`, which (a) re-serialised both Sets in full every
 * 25 items, so total serialisation cost grew quadratically with the size of the
 * run, and (b) could be skipped entirely, since `pushedItems` increments by
 * batch size and need never land on an exact multiple of 25. A time interval is
 * O(1) in call frequency and cannot be stepped over.
 */
let lastFlushAt = 0;
let flushInFlight = null;
async function persistSeenIds({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - lastFlushAt < DEFAULTS.STATE_FLUSH_INTERVAL_MS) return undefined;
    if (flushInFlight) return flushInFlight;
    lastFlushAt = now;
    flushInFlight = (async () => {
        await Actor.setValue(SEEN_JOB_IDS_KEY, Array.from(seenJobIds));
        await Actor.setValue(SEEN_COMPANY_IDS_KEY, Array.from(seenCompanyIds));
    })().finally(() => { flushInFlight = null; });
    return flushInFlight;
}

/**
 * POST a JSON event to the configured webhook URL, if any. Failures are logged
 * but never thrown - a broken webhook shouldn't crash the scrape.
 */
async function notifyWebhook(event, payload = {}) {
    if (!webhookUrl) return;
    try {
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                event,
                timestamp: new Date().toISOString(),
                ...payload,
            }),
        });
    } catch (err) {
        log.warning(`Webhook notification failed: ${err.message}`);
    }
}

/**
 * Push a batch (or single) record to the dataset, applying the user's output-field
 * selection first.
 */
async function pushFiltered(records) {
    const list = Array.isArray(records) ? records : [records];
    const filtered = list.map((record) => filterOutputFields(record, outputFields));
    await Actor.pushData(filtered);
}

/**
 * Queue company "about" pages for a batch of jobs in a single addRequests call.
 * Batched rather than one addRequests per job, which cost a request-queue round
 * trip per listing instead of one per page.
 *
 * Keyed on the company URL slug, not companyId. This used to read `companyId`
 * off each job, but that field was dropped from the parsed output, so the guard
 * below rejected every job and no company page was ever queued - the
 * scrapeCompanyDetails input silently did nothing. Slugs also work where the
 * numeric ID does not: guest job cards link companies as /company/<slug>, so
 * extractCompanyId returns null for most of them even when it is present.
 */
async function queueCompanies(jobs) {
    if (!scrapeCompanyDetails) return;
    const requests = [];
    for (const { companyUrl } of jobs) {
        const companyKey = extractCompanyKey(companyUrl);
        if (!companyKey || seenCompanyIds.has(companyKey)) continue;
        seenCompanyIds.add(companyKey);
        requests.push({
            url: `${companyUrl.replace(/\/$/, '')}/about`,
            userData: {
                label: LABELS.COMPANY,
                companyId: extractCompanyId(companyUrl),
                companySlug: companyKey,
                companyUrl,
            },
            uniqueKey: `company-${companyKey}`,
        });
    }
    if (requests.length > 0) await crawler.addRequests(requests);
}

/**
 * Track a request outcome for adaptive-concurrency purposes and, if the rolling
 * error rate crosses `errorRateThreshold`, halve the crawler's concurrency ceiling.
 * This intentionally only ever scales down; a fresh run/redeploy resets it.
 */
function recordAttempt({ blocked }) {
    rateLimitState.totalAttempts++;
    if (blocked) rateLimitState.blockedAttempts++;

    // Only start judging the error rate once we have a reasonable sample size
    if (rateLimitState.totalAttempts < DEFAULTS.ERROR_RATE_MIN_SAMPLE) return;

    const errorRate = rateLimitState.blockedAttempts / rateLimitState.totalAttempts;
    if (errorRate <= errorRateThreshold) return;

    if (!rateLimitState.alertSent) {
        rateLimitState.alertSent = true;
        log.warning(`Error rate ${(errorRate * 100).toFixed(1)}% exceeds threshold ${(errorRateThreshold * 100).toFixed(1)}%.`);
        notifyWebhook('HIGH_ERROR_RATE', { errorRate, blockedAttempts: rateLimitState.blockedAttempts, totalAttempts: rateLimitState.totalAttempts });
    }

    if (crawler?.autoscaledPool) {
        const current = crawler.autoscaledPool.maxConcurrency;
        const reduced = Math.max(1, Math.floor(current / 2));
        if (reduced < current) {
            crawler.autoscaledPool.maxConcurrency = reduced;
            log.warning(`Reducing concurrency from ${current} to ${reduced} due to high error rate.`);
        }
    }
}

/** Offsets already queued per base search URL, so waves never overlap. */
const queuedOffsets = new Map();

/**
 * Queue the next wave of search-result pages for a base URL.
 *
 * LinkedIn's guest search paginates on a deterministic `start` offset, so page
 * N+1 never needed to be discovered by parsing page N. Serial discovery forced
 * the entire search phase through one request at a time no matter what
 * maxConcurrency was set to; pre-queuing lets the pool fetch pages in parallel.
 *
 * Queued in waves rather than all at once so a query with fewer results than
 * `maxItems` over-fetches by at most `paginationBatchSize` requests instead of
 * walking all the way to LinkedIn's 1000-result ceiling.
 */
function buildWaveRequests(baseUrl, fromOffset, remaining) {
    const already = queuedOffsets.get(baseUrl) ?? new Set();
    const urls = buildPaginationUrls(baseUrl, fromOffset, paginationBatchSize, remaining)
        .filter((url) => !already.has(url));
    if (urls.length === 0) return [];

    const lastUrl = urls[urls.length - 1];
    const requests = urls.map((url) => {
        already.add(url);
        return {
            url,
            userData: {
                label: LABELS.SEARCH,
                baseUrl,
                offset: Number(new URL(url).searchParams.get('start')),
                // Only the final page of a wave queues the next one, so waves
                // never overlap or fan out combinatorially.
                isWaveEnd: url === lastUrl,
            },
            uniqueKey: url,
        };
    });
    queuedOffsets.set(baseUrl, already);
    return requests;
}

async function queueSearchWave(baseUrl, fromOffset) {
    const remaining = queueCeiling() - queuedItems;
    if (remaining <= 0 || fromOffset >= MAX_SEARCH_OFFSET) return 0;
    const requests = buildWaveRequests(baseUrl, fromOffset, remaining);
    if (requests.length > 0) await crawler.addRequests(requests);
    return requests.length;
}

// ─── Build search URLs ──────────────────────────────────────────────
let searchUrls;
if (startUrls && startUrls.length > 0) {
    // Use user-provided URLs directly (Apify requestListSources format)
    searchUrls = startUrls.map(item => typeof item === 'string' ? item : item.url);
    log.info(`Using ${searchUrls.length} user-provided start URL(s)`);
} else {
    searchUrls = buildSearchUrls({
        searchQueries,
        location,
        datePosted,
        jobType,
        experienceLevel,
        remoteFilter,
    });
    log.info(`Generated ${searchUrls.length} search URL(s) from queries`);
}

// ─── Crawler ─────────────────────────────────────────────────────────
// Declared with `let` and assigned below so that callbacks referencing `crawler`
// (e.g. recordAttempt, queueCompanies, queueSearchWave) resolve it once the run starts.
let crawler;
crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency,
    // More retries than the default: 429s are common and usually clear once a
    // fresh session/proxy plus backoff is applied.
    maxRequestRetries,
    requestHandlerTimeoutSecs: DEFAULTS.REQUEST_HANDLER_TIMEOUT_SECS,
    minConcurrency: DEFAULTS.MIN_CONCURRENCY,
    // Bounds requests per *second*; maxConcurrency bounds requests *in flight*.
    // Both are needed and they are not the same limit: N in-flight requests
    // against a fast origin is a far higher request rate than against a slow one.
    maxRequestsPerMinute: maxConcurrency * requestsPerMinuteMultiplier,

    // Session pool for anti-blocking. Sessions that receive a blocked status code
    // are retired automatically, so the next attempt gets a new session (and, with
    // a rotating proxy group, a new outbound IP).
    useSessionPool: true,
    sessionPoolOptions: {
        maxPoolSize: DEFAULTS.SESSION_POOL_MAX_SIZE,
        blockedStatusCodes: BLOCKED_STATUS_CODES,
        sessionOptions: {
            maxUsageCount: DEFAULTS.SESSION_MAX_USAGE_COUNT,
        },
    },

    // Accept JSON responses from the API endpoint
    additionalMimeTypes: ['application/json'],

    // Browser-like headers, plus an optional (default-off) randomised delay.
    preNavigationHooks: [
        async (_crawlingContext, gotOptions) => {
            gotOptions.headers = {
                ...gotOptions.headers,
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
            };
            // Optional, off by default. A sleep here holds a concurrency slot
            // open while it waits, so it costs throughput twice over: once for
            // the wall-clock delay, once for the slot that cannot be used
            // meanwhile. maxRequestsPerMinute shapes cadence without occupying
            // a slot. Kept as an escape hatch for targets that genuinely need
            // jittered spacing.
            if (requestDelayMaxMs > 0) {
                const span = Math.max(0, requestDelayMaxMs - requestDelayMinMs);
                const delay = requestDelayMinMs + Math.floor(Math.random() * (span + 1));
                if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
            }
        },
    ],

    async requestHandler({ request, $, body, session }) {
        const { label } = request.userData;

        // ── Challenge / login-wall detection ───────────────────────
        // LinkedIn sometimes returns a 200 with a checkpoint or auth-wall page
        // instead of real content, so a status-code check alone isn't enough.
        if (typeof body === 'string' && isChallengePage(body)) {
            session?.retire();
            recordAttempt({ blocked: true });
            throw new Error(`LinkedIn challenge/checkpoint page detected at ${request.url}`);
        }
        recordAttempt({ blocked: false });

        // ── SEARCH results page ──────────────────────────────────
        if (label === LABELS.SEARCH) {
            const { baseUrl, offset, isWaveEnd } = request.userData;
            const jobsToQueue = [];
            const jobsToPush = [];

            const ceiling = queueCeiling();
            $('li').each((_index, element) => {
                if (queuedItems >= ceiling) return false;

                const jobData = parseJobListing($, element);
                if (!jobData || !jobData.jobId) return;

                // Deduplicate (also skips jobs already scraped in a previous run
                // when resumeFromPreviousRun is enabled)
                if (seenJobIds.has(jobData.jobId)) return;
                seenJobIds.add(jobData.jobId);

                if (scrapeDetails && jobData.jobUrl) {
                    jobsToQueue.push({
                        url: `${LINKEDIN_BASE}/jobs-guest/jobs/api/jobPosting/${jobData.jobId}`,
                        userData: { label: LABELS.DETAIL, jobData },
                        uniqueKey: `detail-${jobData.jobId}`,
                    });
                } else {
                    jobsToPush.push(jobData);
                }
                queuedItems++;
            });

            const found = jobsToPush.length + jobsToQueue.length;

            if (jobsToPush.length > 0) {
                await pushFiltered(jobsToPush);
                pushedItems += jobsToPush.length;
                await queueCompanies(jobsToPush);
            }
            if (jobsToQueue.length > 0) await crawler.addRequests(jobsToQueue);

            log.info(`Search page start=${offset}: ${jobsToPush.length} pushed, ` +
                     `${jobsToQueue.length} queued for details. Progress: ${queuedItems}/${ceiling}` +
                     (requireSalary ? ` (kept ${pushedItems}/${maxItems}, ${droppedNoSalary} without pay)` : ''));

            await persistSeenIds();

            // ── Paginate ─────────────────────────────────────────
            // Only the last page of a wave queues the next wave, and only if
            // this wave returned results. An empty page means the query is
            // exhausted, so we stop rather than walking to the 1000 ceiling.
            if (isWaveEnd && found > 0 && queuedItems < queueCeiling() && pushedItems < maxItems) {
                const queued = await queueSearchWave(baseUrl, offset + JOBS_PER_PAGE);
                if (queued > 0) log.debug(`Queued next wave of ${queued} search page(s).`);
            }

        // ── DETAIL page ──────────────────────────────────────────
        } else if (label === LABELS.DETAIL) {
            log.debug(`Parsing job details: ${request.url}`);
            const { jobData } = request.userData;
            const detailedData = parseJobDetails($, jobData);

            detailsSeen++;
            if (detailedData.salary) detailsWithSalary++;

            if (requireSalary && !detailedData.salary) {
                droppedNoSalary++;
                log.debug(`Discarding ${request.url}: no pay disclosed.`);
                return;
            }
            // Over-fetching for requireSalary can overshoot once the misses stop
            // coming, so the cap is enforced here as well as at queue time.
            if (requireSalary && pushedItems >= maxItems) return;

            await pushFiltered(detailedData);
            pushedItems++;

            await queueCompanies([detailedData]);
            await persistSeenIds();

        // ── COMPANY "about" page ─────────────────────────────────
        } else if (label === LABELS.COMPANY) {
            log.debug(`Parsing company details: ${request.url}`);
            const { companyId, companySlug, companyUrl } = request.userData;
            const companyData = parseCompanyDetails($, companyId, companyUrl);

            await pushFiltered({ type: 'COMPANY', companySlug, ...companyData });
        }
    },

    // Called on each failed attempt, before Crawlee decides whether to retry.
    // This is where 429-specific exponential backoff + concurrency throttling live.
    async errorHandler({ request, session }, error) {
        const statusCode = error?.response?.statusCode ?? error?.statusCode ?? null;
        const looksRateLimited = BLOCKED_STATUS_CODES.includes(statusCode)
            || /challenge|checkpoint/i.test(error?.message || '');

        if (looksRateLimited) {
            recordAttempt({ blocked: true });
            session?.retire(); // Force a fresh session (and proxy, if rotating) on retry

            const retryCount = request.retryCount ?? 0;
            // Full jitter, not fixed exponential + small jitter. With N
            // concurrent workers, near-deterministic backoff makes every blocked
            // request retry in lockstep, producing synchronised bursts against a
            // host that is already pushing back. Sampling the whole window
            // spreads them out.
            const ceiling = Math.min(
                DEFAULTS.RETRY_BACKOFF_BASE_MS * (2 ** retryCount),
                DEFAULTS.RETRY_BACKOFF_CAP_MS,
            );
            const backoffMs = Math.floor(Math.random() * ceiling);
            log.warning(`Rate-limited (status ${statusCode ?? 'n/a'}) on ${request.url}. Backing off ${backoffMs}ms before retry ${retryCount + 1}.`);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
    },

    async failedRequestHandler({ request }, error) {
        log.error(`Request failed: ${request.url}`, { error: error.message });

        // If a detail page fails, push the listing data we already have
        if (request.userData?.label === LABELS.DETAIL && request.userData?.jobData) {
            // A partial record carries only listing fields, which never include
            // salary, so it cannot satisfy requireSalary.
            if (requireSalary && !request.userData.jobData.salary) {
                droppedNoSalary++;
                return;
            }
            log.warning(`Pushing partial data for failed detail page: ${request.url}`);
            await pushFiltered({
                ...request.userData.jobData,
                detailScrapeFailed: true,
            });
            pushedItems++;
        }
    },
});

// ─── Run ─────────────────────────────────────────────────────────────
// Seed a full first wave per search URL, so page fetches are parallel from the
// first tick rather than serialised behind parsing the previous page.
const seedRequests = searchUrls.flatMap((baseUrl) => buildWaveRequests(baseUrl, 0, queueCeiling()));
log.info(`Seeded ${seedRequests.length} search page request(s) across ${searchUrls.length} query/queries.`);

await crawler.run(seedRequests);

await persistSeenIds({ force: true });

const errorRate = rateLimitState.totalAttempts > 0
    ? rateLimitState.blockedAttempts / rateLimitState.totalAttempts
    : 0;

log.info(`✅ Scraping complete. Total jobs scraped: ${pushedItems}`, {
    blockedAttempts: rateLimitState.blockedAttempts,
    totalAttempts: rateLimitState.totalAttempts,
    errorRate: `${(errorRate * 100).toFixed(1)}%`,
});

if (detailsSeen > 0) {
    const disclosureRate = (detailsWithSalary / detailsSeen) * 100;
    log.info(`Pay disclosed on ${detailsWithSalary}/${detailsSeen} job(s) (${disclosureRate.toFixed(1)}%).`
        + (requireSalary ? ` Discarded ${droppedNoSalary} without pay.` : ''));
    if (requireSalary && pushedItems < maxItems) {
        log.warning(`Returned ${pushedItems} of ${maxItems} requested: not enough postings disclosed pay. `
            + 'Broadening the search or the location usually helps, as disclosure varies by local law.');
    }
}

if (notifyOnCompletion) {
    await notifyWebhook('COMPLETED', { pushedItems, errorRate, totalSeenJobIds: seenJobIds.size });
}

await Actor.exit();
