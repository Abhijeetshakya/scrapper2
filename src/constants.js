/**
 * Request labels to distinguish between search result pages and job detail pages.
 */
export const LABELS = {
    SEARCH: 'SEARCH',
    DETAIL: 'DETAIL',
    COMPANY: 'COMPANY',
};

/**
 * LinkedIn base URLs for guest (no-login) access.
 */
export const LINKEDIN_BASE = 'https://www.linkedin.com';
export const LINKEDIN_JOBS_SEARCH = `${LINKEDIN_BASE}/jobs-guest/jobs/api/seeMoreJobPostings/search`;
export const LINKEDIN_JOB_DETAIL = `${LINKEDIN_BASE}/jobs/view`;

/**
 * Mapping of date posted filter values to LinkedIn's f_TPR parameter.
 */
export const DATE_POSTED_MAP = {
    any: '',
    past24hours: 'r86400',
    pastWeek: 'r604800',
    pastMonth: 'r2592000',
    // Hyphenated aliases: these were the values shipped in input_schema.json,
    // so saved tasks and existing API callers still send them. An unrecognised
    // key resolves to undefined and the filter is dropped *silently*, so the
    // aliases stay until those callers are known to be gone.
    'past-24h': 'r86400',
    'past-week': 'r604800',
    'past-month': 'r2592000',
};

/**
 * Mapping of job type filter values to LinkedIn's f_JT parameter.
 */
export const JOB_TYPE_MAP = {
    any: '',
    fullTime: 'F',
    partTime: 'P',
    contract: 'C',
    temporary: 'T',
    internship: 'I',
};

/**
 * Mapping of experience level filter to LinkedIn's f_E parameter.
 */
export const EXPERIENCE_LEVEL_MAP = {
    any: '',
    internship: '1',
    entryLevel: '2',
    associate: '3',
    midSenior: '4',
    director: '5',
    executive: '6',
};

/**
 * Mapping of remote filter values to LinkedIn's f_WT parameter.
 */
export const REMOTE_FILTER_MAP = {
    any: '',
    onSite: '1',
    remote: '2',
    hybrid: '3',
    // Alias, see DATE_POSTED_MAP.
    'on-site': '1',
};

/**
 * Keywords/suffixes used to detect a salary's pay period (e.g. "$80/hr", "$150K per year").
 * Keys are matched as "/{key}" or "per {key}" (case-insensitive) against the raw salary text.
 */
export const SALARY_PERIOD_MAP = {
    yr: 'yearly',
    year: 'yearly',
    annum: 'yearly',
    hr: 'hourly',
    hour: 'hourly',
    mo: 'monthly',
    month: 'monthly',
    wk: 'weekly',
    week: 'weekly',
    day: 'daily',
};

/**
 * Words that signal a nearby currency figure is pay, rather than funding raised,
 * revenue, contract value, or a benefit allowance. Used to score candidate
 * matches when salary has to be recovered from free-text description prose.
 */
export const SALARY_CONTEXT_KEYWORDS = [
    'salary', 'compensation', 'pay range', 'base pay', 'pay rate', 'paid',
    'wage', 'per year', 'per hour', 'per annum', 'annually', 'hourly rate',
    'base salary', 'total compensation', 'remuneration', 'ctc', 'earn',
];

/**
 * Plausible bounds per pay period, used to reject figures that parse cleanly but
 * cannot be pay - "$250B+ in funds", "raised $10 million - $20 million", or a
 * "$5,000 - $10,000" benefit allowance sitting in the same paragraph.
 */
export const SALARY_SANITY_BOUNDS = {
    hourly: { min: 2, max: 2_000 },
    daily: { min: 20, max: 20_000 },
    weekly: { min: 100, max: 100_000 },
    monthly: { min: 500, max: 500_000 },
    yearly: { min: 10_000, max: 10_000_000 },
};

/**
 * A currency range ("$150,000 - $200,000", "$90,250.00/yr - $120,000.00/yr",
 * "$70K to $90K"). Ranges are matched before single figures because a lone
 * number in prose is far more often not pay.
 */
export const SALARY_RANGE_REGEX = /[$€£₹¥]\s?\d[\d,.]*\s*[kK]?(?:\s*\/\s*(?:yr|hr|mo|wk|year|hour|month|week))?\s*(?:-|–|—|to)\s*[$€£₹¥]?\s?\d[\d,.]*\s*[kK]?(?:\s*\/\s*(?:yr|hr|mo|wk|year|hour|month|week))?/gi;

/**
 * A single figure carrying an explicit pay period ("$120,000 per year",
 * "$45/hr"). Only trusted with the period marker attached.
 */
export const SALARY_SINGLE_REGEX = /[$€£₹¥]\s?\d[\d,.]*\s*[kK]?\s*(?:\/\s*(?:yr|hr|mo|wk)|per\s+(?:year|hour|month|week|annum)|annually|an hour|a year)/gi;

/** How far back to look for a context keyword when scoring a description match. */
export const SALARY_CONTEXT_WINDOW = 220;

/**
 * Currency symbol/prefix to ISO 4217 code mapping, used for structured salary parsing.
 * Longer/more specific prefixes (e.g. "C$") are checked before shorter ones (e.g. "$").
 */
export const CURRENCY_SYMBOL_MAP = {
    'C$': 'CAD',
    'A$': 'AUD',
    '$': 'USD',
    '€': 'EUR',
    '£': 'GBP',
    '₹': 'INR',
    '¥': 'JPY',
};

/**
 * HTTP status codes that indicate the session/proxy has been rate-limited or blocked
 * by LinkedIn. Used to configure Crawlee's session pool blocking detection and to
 * drive custom retry/backoff and concurrency-throttling logic.
 */
export const BLOCKED_STATUS_CODES = [401, 403, 429, 999];

/**
 * Text fragments that indicate LinkedIn has served a login wall, security checkpoint,
 * or bot-challenge page instead of the expected content. Used to detect blocking that
 * doesn't necessarily come back as a non-2xx HTTP status.
 */
export const CHALLENGE_MARKERS = [
    'checkpoint/challenge',
    'authwall',
    'id="captcha"',
    'class="challenge-dialog"',
    'unusual activity from your account',
];

/**
 * Default tunables. Everything here is overridable via actor input; nothing
 * in the crawler should hardcode a number that appears in this object.
 */
export const DEFAULTS = {
    /** Jobs per LinkedIn guest search page. Fixed by their API, not a preference. */
    JOBS_PER_PAGE: 25,
    /** LinkedIn stops serving guest results past this offset. */
    MAX_SEARCH_OFFSET: 1000,

    /** Requests in flight. */
    MAX_CONCURRENCY: 10,
    MIN_CONCURRENCY: 1,
    /** Requests/minute = maxConcurrency * this. Bounds *rate*, not in-flight count. */
    REQUESTS_PER_MINUTE_MULTIPLIER: 30,

    /**
     * Artificial per-request delay, in ms. Default 0: Crawlee's autoscaled pool
     * plus the rate cap already shape the request cadence, and a blocking sleep
     * inside preNavigationHooks holds a concurrency slot open while it waits.
     */
    REQUEST_DELAY_MIN_MS: 0,
    REQUEST_DELAY_MAX_MS: 0,

    /**
     * Search pages queued per wave. Pagination offsets are deterministic
     * (0, 25, 50, ...), so pages can be fetched in parallel rather than
     * discovered one at a time. Waves cap how many wasted requests a
     * short result set can cost.
     */
    PAGINATION_BATCH_SIZE: 8,

    MAX_REQUEST_RETRIES: 5,
    REQUEST_HANDLER_TIMEOUT_SECS: 60,
    RETRY_BACKOFF_BASE_MS: 2000,
    RETRY_BACKOFF_CAP_MS: 60_000,

    SESSION_POOL_MAX_SIZE: 20,
    SESSION_MAX_USAGE_COUNT: 10,

    /** Dedup state is flushed on a time interval, not an item count. */
    STATE_FLUSH_INTERVAL_MS: 15_000,
    /** Minimum attempts before the error rate is trusted enough to act on. */
    ERROR_RATE_MIN_SAMPLE: 10,
    ERROR_RATE_THRESHOLD: 0.3,

    /**
     * `requireSalary` can only be applied after a detail page is fetched, since
     * search cards carry no salary markup and LinkedIn ignores its own f_SB2
     * salary filter on the guest endpoint. Reaching maxItems therefore means
     * queuing more than maxItems and discarding the misses. These bound that
     * over-fetch: start assuming half disclose, adapt to the observed rate, and
     * never fan out more than MAX_OVERFETCH x maxItems however bad it gets.
     */
    SALARY_RATE_INITIAL: 0.5,
    SALARY_RATE_FLOOR: 0.15,
    SALARY_RATE_MIN_SAMPLE: 20,
    SALARY_MAX_OVERFETCH: 6,
};
