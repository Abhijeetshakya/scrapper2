import {
    LINKEDIN_JOBS_SEARCH,
    DATE_POSTED_MAP,
    JOB_TYPE_MAP,
    EXPERIENCE_LEVEL_MAP,
    REMOTE_FILTER_MAP,
    SALARY_PERIOD_MAP,
    CURRENCY_SYMBOL_MAP,
    CHALLENGE_MARKERS,
    DEFAULTS,
} from './constants.js';

/**
 * Build LinkedIn search URLs from the input configuration.
 * Each search query generates its own URL with all filters applied.
 *
 * @param {object} config - Search configuration
 * @returns {string[]} Array of search URLs
 */
export function buildSearchUrls({ searchQueries, location, datePosted, jobType, experienceLevel, remoteFilter }) {
    return searchQueries.map(query => {
        const params = new URLSearchParams();
        params.set('keywords', query);
        params.set('location', location);
        params.set('start', '0');

        // Apply filters
        const tpr = DATE_POSTED_MAP[datePosted];
        if (tpr) params.set('f_TPR', tpr);

        const jt = JOB_TYPE_MAP[jobType];
        if (jt) params.set('f_JT', jt);

        const exp = EXPERIENCE_LEVEL_MAP[experienceLevel];
        if (exp) params.set('f_E', exp);

        const wt = REMOTE_FILTER_MAP[remoteFilter];
        if (wt) params.set('f_WT', wt);

        // Sort by most recent
        params.set('sortBy', 'DD');

        return `${LINKEDIN_JOBS_SEARCH}?${params.toString()}`;
    });
}

/**
 * Clean up text by removing extra whitespace and newlines.
 *
 * @param {string} text - Raw text to clean
 * @returns {string} Cleaned text
 */
export function cleanText(text) {
    if (!text) return '';
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * Extract LinkedIn job ID from a URL.
 *
 * @param {string} url - LinkedIn job URL
 * @returns {string|null} Job ID or null
 */
export function extractJobId(url) {
    if (!url) return null;
    const match = url.match(/(\d{5,})/); // Job IDs are long numeric strings
    return match ? match[1] : null;
}

/**
 * Parse relative or human-readable dates into ISO format.
 *
 * @param {string} dateText - Date text like "2 days ago", "1 week ago"
 * @returns {string} The original text (kept as-is since LinkedIn uses relative dates)
 */
export function parseDate(dateText) {
    return cleanText(dateText);
}

/**
 * Derive the workplace type (Remote / Hybrid / On-site) from a location string.
 * LinkedIn appends "(Remote)" or "(Hybrid)" to the location text when applicable;
 * anything else is treated as on-site.
 *
 * @param {string} locationText - Raw location text, e.g. "New York, NY (Remote)"
 * @returns {string|null} 'Remote' | 'Hybrid' | 'On-site' | null
 */
export function detectWorkplaceType(locationText) {
    if (!locationText) return null;
    const text = locationText.toLowerCase();
    if (text.includes('remote')) return 'Remote';
    if (text.includes('hybrid')) return 'Hybrid';
    return 'On-site';
}

/**
 * Extract LinkedIn's numeric company ID from a data-entity-urn attribute
 * (e.g. "urn:li:organization:12345") or a company URL (e.g. ".../company/12345").
 *
 * @param {string} value - URN string or company URL
 * @returns {string|null} Numeric company ID or null
 */
export function extractCompanyId(value) {
    if (!value) return null;
    const urnMatch = value.match(/urn:li:(?:organization|company|fsd_company):(\d+)/);
    if (urnMatch) return urnMatch[1];
    const numMatch = value.match(/\/company\/(\d+)/);
    if (numMatch) return numMatch[1];
    return null;
}

/**
 * Parse a free-text salary string into structured min/max/currency/period fields.
 * Handles formats like "$150,000 - $200,000", "$80K/yr", "€45.5K", "$40 - $60 per hour".
 *
 * @param {string} salaryText - Raw salary text as scraped from the page
 * @returns {{min: number|null, max: number|null, currency: string|null, period: string|null, raw: string|null}}
 */
export function parseSalary(salaryText) {
    const empty = { min: null, max: null, currency: null, period: null, raw: null };
    const raw = cleanText(salaryText);
    if (!raw) return empty;

    // ─── Currency ────────────────────────────────────────────────
    let currency = null;
    for (const [symbol, code] of Object.entries(CURRENCY_SYMBOL_MAP)) {
        if (raw.includes(symbol)) {
            currency = code;
            break;
        }
    }
    if (!currency) {
        const isoMatch = raw.match(/\b(USD|EUR|GBP|INR|JPY|CAD|AUD)\b/i);
        if (isoMatch) currency = isoMatch[1].toUpperCase();
    }

    // ─── Pay period ──────────────────────────────────────────────
    let period = null;
    const lower = raw.toLowerCase();
    for (const [suffix, value] of Object.entries(SALARY_PERIOD_MAP)) {
        if (lower.includes(`/${suffix}`) || lower.includes(`per ${suffix}`)) {
            period = value;
            break;
        }
    }

    // ─── Numeric range (handles "150,000", "150K", "150.5k") ──────
    const numberTokens = raw.match(/[\d,]+(?:\.\d+)?\s*[kK]?/g) || [];
    const numbers = numberTokens
        .map((token) => {
            const isThousands = /[kK]\s*$/.test(token);
            const numeric = parseFloat(token.replace(/[^\d.]/g, ''));
            if (Number.isNaN(numeric)) return null;
            return isThousands ? numeric * 1000 : numeric;
        })
        .filter((n) => n !== null && n > 0);

    if (numbers.length === 0) {
        return { min: null, max: null, currency, period, raw };
    }

    const min = Math.min(...numbers);
    const max = numbers.length > 1 ? Math.max(...numbers) : min;

    // If LinkedIn didn't label the period explicitly, small figures almost always mean hourly
    if (!period) {
        period = max < 1000 ? 'hourly' : 'yearly';
    }

    return { min, max, currency, period, raw };
}

/**
 * Parse a free-text location string into city/state/country components.
 * LinkedIn location text varies widely in specificity, e.g.
 * "San Francisco, CA", "New York, NY (Remote)", "London, England, United Kingdom",
 * "United States". This is a best-effort heuristic split on commas.
 *
 * @param {string} locationText - Raw location text as scraped from the page
 * @returns {{city: string|null, state: string|null, country: string|null, raw: string|null}}
 */
export function parseLocation(locationText) {
    const empty = { city: null, state: null, country: null, raw: null };
    const raw = cleanText(locationText);
    if (!raw) return empty;

    // Strip the workplace-type suffix LinkedIn appends, e.g. "(Remote)" / "(Hybrid)"
    const withoutSuffix = raw.replace(/\s*\((Remote|Hybrid|On-site)\)\s*$/i, '').trim();
    const parts = withoutSuffix.split(',').map((p) => p.trim()).filter(Boolean);

    let city = null;
    let state = null;
    let country = null;

    if (parts.length === 1) {
        // Just one segment - usually a country or broad region, not a city
        [country] = parts;
    } else if (parts.length === 2) {
        [city, state] = parts;
    } else if (parts.length >= 3) {
        [city, state] = parts;
        country = parts.slice(2).join(', ');
    }

    return { city, state, country, raw };
}

/**
 * Detect whether a fetched HTML page is actually a LinkedIn login wall, security
 * checkpoint, or bot challenge page rather than the expected content. LinkedIn
 * sometimes serves these with a 200 status, so status-code checks alone miss them.
 *
 * @param {string} html - Raw HTML body of the response
 * @returns {boolean} True if the page looks like a challenge/block page
 */
export function isChallengePage(html) {
    if (!html || typeof html !== 'string') return false;
    return CHALLENGE_MARKERS.some((marker) => html.includes(marker));
}

/**
 * Restrict a data record to a user-selected subset of fields (for smaller/cleaner
 * output). `jobId` (or `companyId` for company records) is always preserved so
 * records remain identifiable even when trimmed.
 *
 * @param {object} record - Full data record
 * @param {string[]} fields - Field names to keep; empty/undefined means "keep all"
 * @returns {object} Filtered record
 */
export function filterOutputFields(record, fields) {
    if (!record || !Array.isArray(fields) || fields.length === 0) return record;
    const alwaysKeep = new Set(['jobId', 'companyId', 'type', ...fields]);
    return Object.fromEntries(
        Object.entries(record).filter(([key]) => alwaysKeep.has(key))
    );
}

/**
 * Build the `start` offsets for a wave of search-result pages.
 *
 * LinkedIn's guest search paginates on a deterministic `start` parameter
 * (0, 25, 50, ...), so there is no reason to discover page N+1 by parsing
 * page N. Discovering serially forces the whole search phase through a single
 * request at a time regardless of maxConcurrency; pre-queuing lets the pool
 * actually fetch pages in parallel.
 *
 * Queued in waves rather than all at once so that a search with fewer results
 * than `maxItems` wastes at most one wave of requests instead of fetching every
 * page up to the 1000-result ceiling.
 *
 * @param {string} baseUrl - A search URL (its existing `start` param is replaced)
 * @param {number} fromOffset - First offset in this wave
 * @param {number} count - How many pages to queue
 * @param {number} remainingItems - Items still needed; caps the wave
 * @returns {string[]} Absolute search URLs
 */
export function buildPaginationUrls(baseUrl, fromOffset, count, remainingItems) {
    const { JOBS_PER_PAGE, MAX_SEARCH_OFFSET } = DEFAULTS;
    const pagesNeeded = Math.ceil(remainingItems / JOBS_PER_PAGE);
    const pages = Math.min(count, Math.max(pagesNeeded, 0));

    const urls = [];
    for (let i = 0; i < pages; i++) {
        const offset = fromOffset + (i * JOBS_PER_PAGE);
        if (offset >= MAX_SEARCH_OFFSET) break;
        const url = new URL(baseUrl);
        url.searchParams.set('start', String(offset));
        urls.push(url.toString());
    }
    return urls;
}

/**
 * Strip LinkedIn's tracking query parameters from a job URL, leaving a stable
 * canonical form suitable for use as a dedup key.
 *
 * @param {string} url
 * @returns {string} Canonical URL, or the input unchanged if it will not parse
 */
export function canonicalizeUrl(url) {
    if (!url) return url;
    try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return url;
    }
}
