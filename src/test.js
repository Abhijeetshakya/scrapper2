/**
 * Test suite for the LinkedIn Jobs Scraper.
 * Tests parser functions against sample HTML that matches LinkedIn's
 * guest job search endpoint response format.
 */
import { load } from 'cheerio';
import { parseJobListing, parseJobDetails } from './parsers.js';
import {
    buildSearchUrls, cleanText, extractJobId, detectWorkplaceType, extractCompanyId,
    extractCompanyKey, parseSalary, parseLocation, isChallengePage, filterOutputFields,
    buildPaginationUrls, canonicalizeUrl,
} from './utils.js';

// ─── Sample HTML ─────────────────────────────────────────────────────
const SAMPLE_SEARCH_HTML = `
<ul>
  <li>
    <div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:3912345678">
      <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/3912345678?trk=test&position=1">
        <span class="sr-only">Senior Software Engineer</span>
      </a>
      <div class="base-search-card__info">
        <h3 class="base-search-card__title">Senior Software Engineer</h3>
        <h4 class="base-search-card__subtitle">
          <a class="hidden-nested-link" href="https://www.linkedin.com/company/acme-corp">Acme Corp</a>
        </h4>
        <div class="base-search-card__metadata">
          <span class="job-search-card__location">San Francisco, CA</span>
          <time class="job-search-card__listdate" datetime="2024-01-15">2 days ago</time>
          <span class="job-search-card__salary-info">$150,000 - $200,000</span>
        </div>
      </div>
    </div>
  </li>
  <li>
    <div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:3912345679">
      <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/3912345679">
        <span class="sr-only">Data Scientist</span>
      </a>
      <div class="base-search-card__info">
        <h3 class="base-search-card__title">Data Scientist</h3>
        <h4 class="base-search-card__subtitle">
          <a class="hidden-nested-link">TechCo Inc</a>
        </h4>
        <div class="base-search-card__metadata">
          <span class="job-search-card__location">New York, NY (Remote)</span>
          <time class="job-search-card__listdate" datetime="2024-01-14">3 days ago</time>
        </div>
      </div>
    </div>
  </li>
  <li>
    <!-- Empty/invalid list item without card class -->
    <div class="some-other-div">Not a job card</div>
  </li>
</ul>
`;

const SAMPLE_DETAIL_HTML = `
<div class="decorated-job-posting__details">
  <div class="top-card-layout__entity-info">
    <h1 class="top-card-layout__title">Senior Software Engineer</h1>
    <a class="topcard__org-name-link" href="https://www.linkedin.com/company/acme-corp">Acme Corp</a>
    <span class="topcard__flavor topcard__flavor--metadata">Over 200 applicants</span>
  </div>
  <div class="description__text">
    <div class="show-more-less-html__markup">
      We are looking for a Senior Software Engineer to join our team.
      You will work on cutting-edge projects using React, Node.js, and Python.
      Requirements:
      - 5+ years of experience
      - Strong problem solving skills
    </div>
  </div>
  <ul class="description__job-criteria-list">
    <li class="description__job-criteria-item">
      <h3 class="description__job-criteria-subheader">Seniority level</h3>
      <span class="description__job-criteria-text">Mid-Senior level</span>
    </li>
    <li class="description__job-criteria-item">
      <h3 class="description__job-criteria-subheader">Employment type</h3>
      <span class="description__job-criteria-text">Full-time</span>
    </li>
    <li class="description__job-criteria-item">
      <h3 class="description__job-criteria-subheader">Job function</h3>
      <span class="description__job-criteria-text">Engineering and Information Technology</span>
    </li>
    <li class="description__job-criteria-item">
      <h3 class="description__job-criteria-subheader">Industries</h3>
      <span class="description__job-criteria-text">Technology, Information and Internet</span>
    </li>
  </ul>
</div>
`;

// ─── Test Runner ─────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, testName) {
    if (condition) {
        console.log(`  ✅ ${testName}`);
        passed++;
    } else {
        console.error(`  ❌ ${testName}`);
        failed++;
    }
}

function assertEqual(actual, expected, testName) {
    if (actual === expected) {
        console.log(`  ✅ ${testName}`);
        passed++;
    } else {
        console.error(`  ❌ ${testName}: expected "${expected}", got "${actual}"`);
        failed++;
    }
}

// ─── Test: cleanText ─────────────────────────────────────────────────
console.log('\n🧪 Testing cleanText()');
assertEqual(cleanText('  hello   world  '), 'hello world', 'removes extra whitespace');
assertEqual(cleanText(''), '', 'handles empty string');
assertEqual(cleanText(null), '', 'handles null');
assertEqual(cleanText(undefined), '', 'handles undefined');
assertEqual(cleanText('no changes'), 'no changes', 'preserves clean text');
assertEqual(cleanText('\n\t  multi\n  line\t'), 'multi line', 'handles newlines and tabs');

// ─── Test: extractJobId ──────────────────────────────────────────────
console.log('\n🧪 Testing extractJobId()');
assertEqual(extractJobId('https://www.linkedin.com/jobs/view/3912345678'), '3912345678', 'extracts job ID from URL');
assertEqual(extractJobId('https://www.linkedin.com/jobs/view/3912345678?trk=test'), '3912345678', 'extracts job ID with query params');
assertEqual(extractJobId(null), null, 'handles null');
assertEqual(extractJobId(''), null, 'handles empty string');
assertEqual(extractJobId('https://www.linkedin.com/feed'), null, 'returns null for non-job URL');

// ─── Test: detectWorkplaceType ───────────────────────────────────────
console.log('\n🧪 Testing detectWorkplaceType()');
assertEqual(detectWorkplaceType('New York, NY (Remote)'), 'Remote', 'detects remote');
assertEqual(detectWorkplaceType('Austin, TX (Hybrid)'), 'Hybrid', 'detects hybrid');
assertEqual(detectWorkplaceType('San Francisco, CA'), 'On-site', 'defaults to on-site');
assertEqual(detectWorkplaceType(null), null, 'handles null');
assertEqual(detectWorkplaceType(''), null, 'handles empty string');

// ─── Test: extractCompanyId ──────────────────────────────────────────
console.log('\n🧪 Testing extractCompanyId()');
assertEqual(extractCompanyId('urn:li:organization:12345'), '12345', 'extracts ID from organization URN');
assertEqual(extractCompanyId('urn:li:company:6789'), '6789', 'extracts ID from company URN');
assertEqual(extractCompanyId('https://www.linkedin.com/company/12345'), '12345', 'extracts ID from numeric company URL');
assertEqual(extractCompanyId('https://www.linkedin.com/company/acme-corp'), null, 'returns null for slug-based URL');
assertEqual(extractCompanyId(null), null, 'handles null');

// ─── Test: extractCompanyKey ─────────────────────────────────────────
// Guest job cards link companies by slug, so extractCompanyId returns null for
// almost all of them. This is the key company deduplication actually runs on.
console.log('\n🧪 Testing extractCompanyKey()');
assertEqual(extractCompanyKey('https://www.linkedin.com/company/acme-corp'), 'acme-corp', 'extracts slug');
assertEqual(extractCompanyKey('https://www.linkedin.com/company/12345'), '12345', 'extracts numeric ID');
assertEqual(extractCompanyKey('https://www.linkedin.com/company/acme-corp?trk=public_jobs'), 'acme-corp', 'ignores tracking params');
assertEqual(extractCompanyKey('/company/Acme-Corp/'), 'acme-corp', 'handles relative URL and normalises case');
assertEqual(extractCompanyKey('https://www.linkedin.com/company/acme-corp/about'), 'acme-corp', 'ignores trailing path');
assertEqual(extractCompanyKey(null), null, 'handles null');
assertEqual(extractCompanyKey(''), null, 'handles empty string');

// ─── Test: parseSalary ────────────────────────────────────────────────
console.log('\n🧪 Testing parseSalary()');
const salary1 = parseSalary('$150,000 - $200,000');
assertEqual(salary1.min, 150000, 'extracts min from range');
assertEqual(salary1.max, 200000, 'extracts max from range');
assertEqual(salary1.currency, 'USD', 'detects USD from $ symbol');
assertEqual(salary1.period, 'yearly', 'defaults large figures to yearly');

const salary2 = parseSalary('$40 - $60/hr');
assertEqual(salary2.min, 40, 'extracts min hourly rate');
assertEqual(salary2.max, 60, 'extracts max hourly rate');
assertEqual(salary2.period, 'hourly', 'detects hourly period from /hr suffix');

const salary3 = parseSalary('€45.5K per year');
assertEqual(salary3.min, 45500, 'converts K suffix to full number');
assertEqual(salary3.currency, 'EUR', 'detects EUR from € symbol');
assertEqual(salary3.period, 'yearly', 'detects yearly period from "per year"');

const salary4 = parseSalary(null);
assertEqual(salary4.min, null, 'handles null salary');
assertEqual(salary4.raw, null, 'raw is null for null salary');

const salary5 = parseSalary('Competitive');
assertEqual(salary5.min, null, 'returns null min when no numbers present');
assertEqual(salary5.raw, 'Competitive', 'still preserves raw text');

// ─── Test: parseLocation ──────────────────────────────────────────────
console.log('\n🧪 Testing parseLocation()');
const loc1 = parseLocation('San Francisco, CA');
assertEqual(loc1.city, 'San Francisco', 'extracts city');
assertEqual(loc1.state, 'CA', 'extracts state');
assertEqual(loc1.country, null, 'no country for 2-part location');

const loc2 = parseLocation('New York, NY (Remote)');
assertEqual(loc2.city, 'New York', 'strips workplace suffix before parsing city');
assertEqual(loc2.state, 'NY', 'strips workplace suffix before parsing state');

const loc3 = parseLocation('London, England, United Kingdom');
assertEqual(loc3.city, 'London', 'extracts city from 3-part location');
assertEqual(loc3.state, 'England', 'extracts region from 3-part location');
assertEqual(loc3.country, 'United Kingdom', 'extracts country from 3-part location');

const loc4 = parseLocation('United States');
assertEqual(loc4.country, 'United States', 'single segment treated as country');
assertEqual(loc4.city, null, 'no city for single-segment location');

const loc5 = parseLocation(null);
assertEqual(loc5.raw, null, 'handles null location');

// ─── Test: isChallengePage ────────────────────────────────────────────
console.log('\n🧪 Testing isChallengePage()');
assert(isChallengePage('<html>...authwall...</html>'), 'detects authwall marker');
assert(isChallengePage('<div class="challenge-dialog">Verify</div>'), 'detects challenge-dialog marker');
assert(!isChallengePage('<html><body>Senior Software Engineer</body></html>'), 'normal page not flagged');
assert(!isChallengePage(null), 'handles null body');
assert(!isChallengePage(''), 'handles empty body');

// ─── Test: filterOutputFields ─────────────────────────────────────────
console.log('\n🧪 Testing filterOutputFields()');
const fullRecord = { jobId: '123', title: 'Engineer', company: 'Acme', location: 'SF', salary: { min: 100000, max: 100000, currency: 'USD', period: 'yearly', raw: '$100K' } };
const filtered1 = filterOutputFields(fullRecord, ['title', 'company']);
assertEqual(Object.keys(filtered1).sort().join(','), 'company,jobId,title', 'keeps only selected fields plus jobId');
assert(!('location' in filtered1), 'excludes unselected field');

const filtered2 = filterOutputFields(fullRecord, []);
assertEqual(Object.keys(filtered2).length, 5, 'empty field list keeps all fields');

const filtered3 = filterOutputFields(fullRecord, undefined);
assertEqual(Object.keys(filtered3).length, 5, 'undefined field list keeps all fields');

// ─── Test: buildSearchUrls ───────────────────────────────────────────
console.log('\n🧪 Testing buildSearchUrls()');
const urls = buildSearchUrls({
    searchQueries: ['Software Engineer', 'Data Scientist'],
    location: 'San Francisco',
    datePosted: 'pastWeek',
    jobType: 'fullTime',
    experienceLevel: 'midSenior',
    remoteFilter: 'remote',
});
assertEqual(urls.length, 2, 'generates one URL per query');
assert(urls[0].includes('keywords=Software+Engineer'), 'includes keywords');
assert(urls[0].includes('location=San+Francisco'), 'includes location');
assert(urls[0].includes('f_TPR=r604800'), 'includes date filter');
assert(urls[0].includes('f_JT=F'), 'includes job type filter');
assert(urls[0].includes('f_E=4'), 'includes experience filter');
assert(urls[0].includes('f_WT=2'), 'includes remote filter');
assert(urls[0].includes('sortBy=DD'), 'sorts by date');
assert(urls[0].includes('start=0'), 'starts at 0');
assert(urls[1].includes('keywords=Data+Scientist'), 'second URL has correct keywords');

const minimalUrls = buildSearchUrls({
    searchQueries: ['Test'],
    location: 'US',
    datePosted: 'any',
    jobType: 'any',
    experienceLevel: 'any',
    remoteFilter: 'any',
});
assert(!minimalUrls[0].includes('f_TPR'), 'omits empty date filter');
assert(!minimalUrls[0].includes('f_JT'), 'omits empty job type filter');

// Hyphenated values were shipped in input_schema.json, so saved tasks still send
// them. An unmapped value drops the filter silently, so the aliases are tested.
const aliasUrls = buildSearchUrls({
    searchQueries: ['Test'],
    location: 'US',
    datePosted: 'past-24h',
    jobType: 'any',
    experienceLevel: 'any',
    remoteFilter: 'on-site',
});
assert(aliasUrls[0].includes('f_TPR=r86400'), 'legacy past-24h value still maps to a date filter');
assert(aliasUrls[0].includes('f_WT=1'), 'legacy on-site value still maps to a workplace filter');

const canonicalUrls = buildSearchUrls({
    searchQueries: ['Test'],
    location: 'US',
    datePosted: 'past24hours',
    jobType: 'any',
    experienceLevel: 'any',
    remoteFilter: 'onSite',
});
assert(canonicalUrls[0].includes('f_TPR=r86400'), 'canonical past24hours maps to a date filter');
assert(canonicalUrls[0].includes('f_WT=1'), 'canonical onSite maps to a workplace filter');

// ─── Test: parseJobListing ───────────────────────────────────────────
console.log('\n🧪 Testing parseJobListing()');
const $search = load(SAMPLE_SEARCH_HTML);
const listItems = $search('li');

const job1 = parseJobListing($search, listItems[0]);
assert(job1 !== null, 'parses first job card');
assertEqual(job1.title, 'Senior Software Engineer', 'extracts title');
assertEqual(job1.company, 'Acme Corp', 'extracts company');
assertEqual(job1.location, 'San Francisco, CA', 'extracts location');
// salary is now a parsed JSON object, not a raw string
assert(job1.salary !== null, 'salary is not null when present');
assertEqual(job1.salary.min, 150000, 'salary JSON has correct min');
assertEqual(job1.salary.max, 200000, 'salary JSON has correct max');
assertEqual(job1.salary.currency, 'USD', 'salary JSON has correct currency');
assertEqual(job1.salary.period, 'yearly', 'salary JSON has correct period');
assertEqual(job1.salary.raw, '$150,000 - $200,000', 'salary JSON preserves raw text');
assertEqual(job1.postedDate, '2024-01-15', 'extracts datetime attribute');
assertEqual(job1.jobId, '3912345678', 'extracts job ID from URL');
assert(job1.jobUrl.includes('/jobs/view/3912345678'), 'has clean job URL');
assert(!job1.jobUrl.includes('trk='), 'strips tracking params');
assert(job1.scrapedAt, 'includes scrapedAt timestamp');
assertEqual(job1.workplaceType, 'On-site', 'derives on-site workplace type');
assertEqual(job1.companyUrl, 'https://www.linkedin.com/company/acme-corp', 'extracts company URL at listing level');

// companyUrl is the base the company "about" URL is built from, so a relative
// href or a leftover ?trk= would produce an unfetchable address.
const $relCompany = load(`<li><div class="base-card job-search-card" data-entity-urn="urn:li:jobPosting:3912345680">
  <a class="base-card__full-link" href="/jobs/view/3912345680"><span class="sr-only">Eng</span></a>
  <h3 class="base-search-card__title">Eng</h3>
  <h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="/company/acme-corp?trk=public_jobs">Acme</a></h4>
</div></li>`);
const relJob = parseJobListing($relCompany, $relCompany('li')[0]);
assertEqual(relJob.companyUrl, 'https://www.linkedin.com/company/acme-corp', 'absolutises and strips tracking from relative company URL');
assertEqual(extractCompanyKey(relJob.companyUrl), 'acme-corp', 'resulting company URL yields a dedup key');
assertEqual(`${relJob.companyUrl.replace(/\/$/, '')}/about`, 'https://www.linkedin.com/company/acme-corp/about', 'builds a valid company about URL');
// Verify removed columns are not present
assert(!('companyId' in job1), 'companyId column is removed');
assert(!('isReposted' in job1), 'isReposted column is removed');
assert(!('salaryParsed' in job1), 'salaryParsed column is removed');

const job2 = parseJobListing($search, listItems[1]);
assert(job2 !== null, 'parses second job card');
assertEqual(job2.title, 'Data Scientist', 'second job title');
assertEqual(job2.company, 'TechCo Inc', 'second job company');
assertEqual(job2.location, 'New York, NY (Remote)', 'second job location');
assertEqual(job2.salary, null, 'null salary when not present');
assertEqual(job2.jobId, '3912345679', 'second job ID');
assertEqual(job2.workplaceType, 'Remote', 'derives remote workplace type from location text');

const job3 = parseJobListing($search, listItems[2]);
assert(job3 === null, 'returns null for non-job list items');

// ─── Test: parseJobDetails ───────────────────────────────────────────
console.log('\n🧪 Testing parseJobDetails()');
const $detail = load(SAMPLE_DETAIL_HTML);
const baseJobData = {
    jobId: '3912345678',
    title: 'Senior Software Engineer',
    company: 'Acme Corp',
    location: 'San Francisco, CA',
    jobUrl: 'https://www.linkedin.com/jobs/view/3912345678',
};

const detailedJob = parseJobDetails($detail, baseJobData);
assertEqual(detailedJob.jobId, '3912345678', 'preserves jobId');
assertEqual(detailedJob.title, 'Senior Software Engineer', 'preserves title');
assert(detailedJob.description.includes('Senior Software Engineer'), 'extracts description');
assert(detailedJob.description.includes('5+ years'), 'description includes requirements');
assertEqual(detailedJob.seniorityLevel, 'Mid-Senior level', 'extracts seniority level');
assertEqual(detailedJob.employmentType, 'Full-time', 'extracts employment type');
assertEqual(detailedJob.jobFunction, 'Engineering and Information Technology', 'extracts job function');
assertEqual(detailedJob.industries, 'Technology, Information and Internet', 'extracts industries');
assert(detailedJob.applicants.includes('200'), 'extracts applicant count');
assertEqual(detailedJob.companyUrl, 'https://www.linkedin.com/company/acme-corp', 'extracts company URL');
assert(detailedJob.descriptionHtml !== null, 'includes HTML description');
assertEqual(detailedJob.skills, null, 'skills null when no skills markup present');
assertEqual(detailedJob.easyApply, false, 'easyApply false when no apply button present');
assertEqual(detailedJob.applyUrl, null, 'applyUrl null when no apply link present');

// Fallback test - empty base data
const emptyBase = { jobId: '123', title: '', company: '' };
const fallbackJob = parseJobDetails($detail, emptyBase);
assertEqual(fallbackJob.title, 'Senior Software Engineer', 'falls back to detail page title');
assertEqual(fallbackJob.company, 'Acme Corp', 'falls back to detail page company');


// ─── buildPaginationUrls() ────────────────────────────────────────────
console.log('\n🧪 Testing buildPaginationUrls()');
{
    const base = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=dev&start=0';

    const wave = buildPaginationUrls(base, 0, 8, 200);
    assert(wave.length === 8, 'queues a full wave when enough items remain');
    assert(new URL(wave[0]).searchParams.get('start') === '0', 'first offset is 0');
    assert(new URL(wave[1]).searchParams.get('start') === '25', 'offsets step by 25');
    assert(new URL(wave[7]).searchParams.get('start') === '175', 'last offset of wave is 175');

    const small = buildPaginationUrls(base, 0, 8, 30);
    assert(small.length === 2, 'wave is capped by remaining items, not batch size');

    const capped = buildPaginationUrls(base, 975, 8, 500);
    assert(capped.length === 1, 'stops at the 1000-result ceiling');

    const none = buildPaginationUrls(base, 1000, 8, 500);
    assert(none.length === 0, 'returns nothing past the ceiling');

    const zero = buildPaginationUrls(base, 0, 8, 0);
    assert(zero.length === 0, 'returns nothing when no items remain');

    assert(buildPaginationUrls(base, 0, 8, 200).every((u) => u.includes('keywords=dev')),
        'preserves the original query parameters');
}

// ─── canonicalizeUrl() ────────────────────────────────────────────────
console.log('\n🧪 Testing canonicalizeUrl()');
{
    assert(canonicalizeUrl('https://www.linkedin.com/jobs/view/123?trk=x&refId=y')
        === 'https://www.linkedin.com/jobs/view/123', 'strips tracking parameters');
    assert(canonicalizeUrl('not a url') === 'not a url', 'passes through unparseable input');
    assert(canonicalizeUrl('') === '', 'passes through empty input');
}

// ─── Summary ─────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
    console.error('\n💥 Some tests FAILED!');
    process.exit(1);
} else {
    console.log('\n🎉 All tests passed!');
    process.exit(0);
}
