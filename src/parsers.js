import { cleanText, extractJobId, detectWorkplaceType, parseSalary, parseLocation, canonicalizeUrl } from './utils.js';
import { LINKEDIN_BASE } from './constants.js';

/**
 * Parse a single job listing card from the search results page.
 * LinkedIn's guest job search returns HTML with job cards in <li> elements.
 *
 * The endpoint /jobs-guest/jobs/api/seeMoreJobPostings/search returns HTML
 * fragments where each job is an <li> containing a div with class
 * "base-card" or "base-search-card".
 *
 * @param {import('cheerio').CheerioAPI} $ - Cheerio instance
 * @param {import('cheerio').Element} element - The <li> element containing the job card
 * @returns {object|null} Parsed job data or null if not a valid job card
 */
export function parseJobListing($, element) {
    const $el = $(element);

    // The job card contains a base-card or similar structure
    const $card = $el.find('.base-card, .job-search-card, .base-search-card');
    if ($card.length === 0) {
        // Sometimes the <li> itself has the card class
        if (!$el.hasClass('base-card') && !$el.hasClass('job-search-card') && !$el.hasClass('base-search-card')) {
            return null;
        }
    }

    // Use whichever element has the card class
    const $target = $card.length > 0 ? $card : $el;

    // ─── Title ───────────────────────────────────────────────────
    // Prefer the explicit h3 title; fall back to .base-card__full-link only if needed
    const $h3Title = $target.find('h3.base-search-card__title');
    const $fallbackTitle = $target.find('.base-card__full-link .sr-only');
    const title = cleanText($h3Title.length > 0 ? $h3Title.first().text() : $fallbackTitle.first().text());
    if (!title) return null;

    // ─── Job URL ─────────────────────────────────────────────────
    const $link = $target.find('a.base-card__full-link, a[href*="/jobs/view/"]');
    let jobUrl = $link.attr('href') || '';
    if (jobUrl && !jobUrl.startsWith('http')) {
        jobUrl = `${LINKEDIN_BASE}${jobUrl}`;
    }
    // Strip tracking query parameters so the URL is a stable dedup key
    jobUrl = canonicalizeUrl(jobUrl);

    // ─── Job ID ──────────────────────────────────────────────────
    const jobId = extractJobId(jobUrl)
        || $target.attr('data-entity-urn')?.split(':').pop()
        || $target.find('[data-entity-urn]').attr('data-entity-urn')?.split(':').pop()
        || '';

    if (!jobId) return null; // Can't deduplicate without an ID

    // ─── Company ─────────────────────────────────────────────────
    const $company = $target.find(
        '.base-search-card__subtitle, h4.base-search-card__subtitle, ' +
        'a.hidden-nested-link, a[data-tracking-control-name*="company"]'
    );
    const company = cleanText($company.first().text());

    // The selector above can match a wrapping <h4> before the <a> inside it,
    // and .attr('href') on a Cheerio set returns the FIRST matched element's
    // attribute — so we explicitly resolve the link itself, not just $company.
    const $companyLink = $company.first().is('a') ? $company.first() : $company.find('a').first();
    let companyUrl = $companyLink.attr('href') || null;
    if (companyUrl) {
        if (!companyUrl.startsWith('http')) companyUrl = `${LINKEDIN_BASE}${companyUrl}`;
        // Tracking parameters have to go: this URL is used as a base to build the
        // company "about" URL, and `https://...?trk=x` + '/about' is not a URL.
        companyUrl = canonicalizeUrl(companyUrl);
    }

    // ─── Location ────────────────────────────────────────────────
    const $location = $target.find(
        '.job-search-card__location, .base-search-card__metadata span:not(time)'
    );
    const location = cleanText($location.first().text());

    // ─── Date Posted ─────────────────────────────────────────────
    const $date = $target.find(
        'time, .job-search-card__listdate, .job-search-card__listdate--new'
    );
    const postedDate = $date.attr('datetime') || cleanText($date.text());

    // ─── Salary ──────────────────────────────────────────────────
    // LinkedIn doesn't consistently wrap salary in a dedicated element on the
    // guest search cards - the class name varies (and is sometimes absent
    // entirely even when a "$X - $Y" range is visible in the metadata row).
    // Try the known selectors first, then fall back to pattern-matching the
    // full metadata text for a currency-prefixed figure.
    // `.text()` on a subtree is a full traversal of that subtree. The original
    // code walked `.base-search-card__metadata` up to three times per card
    // (salary fallback, reposted flag). Measured at ~6x the cost of computing
    // it once and reusing it, so it is hoisted here.
    const metadataText = cleanText($target.find('.base-search-card__metadata').text());

    const $salary = $target.find(
        '.job-search-card__salary-info, .base-search-card__metadata .salary-info, ' +
        '.job-search-card__salary, [class*="salary" i]'
    );
    let salaryRaw = cleanText($salary.text());

    if (!salaryRaw) {
        const salaryMatch = metadataText.match(
            /[$€£₹¥]\s?[\d,.]+(?:\.\d+)?\s?[kK]?(?:\s*-\s*[$€£₹¥]?\s?[\d,.]+(?:\.\d+)?\s?[kK]?)?(?:\s*\/\s*(?:yr|hr|mo|wk|year|hour|month|week))?/
        );
        if (salaryMatch) salaryRaw = cleanText(salaryMatch[0]);
    }

    // ─── Workplace Type (Remote / Hybrid / On-site) ───────────────
    const workplaceType = detectWorkplaceType(location);

    // ─── Company Logo ────────────────────────────────────────────
    const $logo = $target.find('img.artdeco-entity-image, .search-entity-media img, img[data-delayed-url]');
    const companyLogo = $logo.attr('data-delayed-url') || $logo.attr('src') || null;

    return {
        jobId,
        title,
        company,
        companyUrl,
        companyLogo,
        location,
        locationParsed: parseLocation(location),
        workplaceType,
        salary: salaryRaw ? parseSalary(salaryRaw) : null,
        postedDate: postedDate || null,
        jobUrl: jobUrl || null,
        scrapedAt: new Date().toISOString(),
    };
}

/**
 * Parse the full job detail page for additional information.
 * Uses the guest endpoint /jobs-guest/jobs/api/jobPosting/{jobId}
 * which returns a full HTML page with job details.
 *
 * @param {import('cheerio').CheerioAPI} $ - Cheerio instance
 * @param {object} jobData - Existing job data from the listing
 * @returns {object} Enriched job data with description and other details
 */
export function parseJobDetails($, jobData) {
    // ─── Job Description ─────────────────────────────────────────
    const $description = $(
        '.show-more-less-html__markup, .description__text .show-more-less-html__markup, ' +
        '.decorated-job-posting__details'
    );
    const descriptionHtml = $description.html();
    const description = cleanText($description.text());

    // ─── Job Criteria (seniority, type, function, industry) ──────
    const criteria = {};
    $('.description__job-criteria-item, .job-criteria__item').each((_, el) => {
        const label = cleanText(
            $(el).find('.description__job-criteria-subheader, h3').text()
        ).toLowerCase();
        const value = cleanText(
            $(el).find('.description__job-criteria-text, span:last-child').text()
        );

        if (label.includes('seniority')) criteria.seniorityLevel = value;
        else if (label.includes('employment')) criteria.employmentType = value;
        else if (label.includes('function')) criteria.jobFunction = value;
        else if (label.includes('industr')) criteria.industries = value;
    });

    // ─── Applicants ──────────────────────────────────────────────
    const $applicants = $(
        '.num-applicants__caption, .applicant-count, ' +
        '.topcard__flavor--metadata, .top-card-layout__bullet'
    );
    const applicantsText = cleanText($applicants.first().text());

    // ─── Company URL ─────────────────────────────────────────────
    const $companyLink = $(
        'a[data-tracking-control-name*="company"], .topcard__org-name-link, ' +
        'a.topcard__org-name-link'
    );
    let companyUrl = $companyLink.attr('href') || null;
    if (companyUrl && !companyUrl.startsWith('http')) {
        companyUrl = `${LINKEDIN_BASE}${companyUrl}`;
    }

    // ─── Title & Company from detail page (fallback) ─────────────
    const detailTitle = cleanText($('.top-card-layout__title, .topcard__title').text());
    const detailCompany = cleanText(
        $('.topcard__org-name-link, .top-card-layout__second-subline a').text()
    );

    // ─── Company Logo (fallback to detail page if listing had none) ─
    const $detailLogo = $('.top-card-layout__entity-image, img.top-card-layout__entity-image, .artdeco-entity-image');
    const companyLogo = jobData.companyLogo || $detailLogo.attr('data-delayed-url') || $detailLogo.attr('src') || null;

    // ─── Required Skills / Qualifications ───────────────────────────
    // LinkedIn surfaces these as a distinct list, separate from the free-text description
    const skills = [];
    $(
        '.job-details-how-you-match__skills-item-subtitle, .job-criteria__text--skill, ' +
        '.description__skill-item, .skills-section li'
    ).each((_, el) => {
        const skill = cleanText($(el).text());
        if (skill) skills.push(skill);
    });

    // ─── Easy Apply vs External Application ─────────────────────────
    const $applyLink = $(
        'a.apply-link, a[data-tracking-control-name*="apply"], .jobs-apply-button, a.top-card-layout__cta'
    );
    const applyText = cleanText($applyLink.text());
    const easyApply = /easy apply/i.test(applyText);
    let applyUrl = $applyLink.attr('href') || null;
    if (applyUrl && !applyUrl.startsWith('http')) {
        applyUrl = `${LINKEDIN_BASE}${applyUrl}`;
    }

    return {
        ...jobData,
        // Override with detail-page values if listing values were empty
        title: jobData.title || detailTitle,
        company: jobData.company || detailCompany,
        companyLogo,
        description: description || null,
        descriptionHtml: descriptionHtml || null,
        seniorityLevel: criteria.seniorityLevel || null,
        employmentType: criteria.employmentType || null,
        jobFunction: criteria.jobFunction || null,
        industries: criteria.industries || null,
        skills: skills.length > 0 ? skills : null,
        applicants: applicantsText || null,
        companyUrl: companyUrl || null,
        easyApply,
        applyUrl,
    };
}

/**
 * Parse a LinkedIn company "about" page for size, industry, and other
 * company-level details. Used only when `scrapeCompanyDetails` is enabled,
 * since it requires a separate request per unique company.
 *
 * @param {import('cheerio').CheerioAPI} $ - Cheerio instance
 * @param {string} companyId - Numeric LinkedIn company ID
 * @param {string} companyUrl - Company page URL
 * @returns {object} Parsed company data
 */
export function parseCompanyDetails($, companyId, companyUrl) {
    const name = cleanText(
        $('.org-top-card-summary__title, .top-card-layout__title').first().text()
    );

    // The "about" page lists industry, size, HQ, etc. as a flat list of info items;
    // company size is the one that mentions "employees".
    const infoItems = [];
    $('.org-top-card-summary-info-list__info-item').each((_, el) => {
        const value = cleanText($(el).text());
        if (value) infoItems.push(value);
    });

    const companySize = infoItems.find(item => /employee/i.test(item)) || null;
    const industry = infoItems.find(item => item !== companySize) || null;

    const website = $('a[data-tracking-control-name*="about_website"]').attr('href') || null;

    const description = cleanText(
        $('[data-test-id="about-us__description"], .core-section-container__content p, .about-us__description').text()
    );

    return {
        companyId: companyId || null,
        companyUrl: companyUrl || null,
        name: name || null,
        description: description || null,
        industry,
        companySize,
        website,
        scrapedAt: new Date().toISOString(),
    };
}
