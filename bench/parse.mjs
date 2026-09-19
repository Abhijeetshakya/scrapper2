/**
 * Measures the four CPU-side hotspots identified in the audit, against a
 * realistic 25-card LinkedIn guest-search fragment.
 *
 *   1. cheerio parser backend: parse5 (default) vs htmlparser2
 *   2. $('li') over the whole document vs a scoped card selector
 *   3. repeated .text() traversals of the same subtree vs computing once
 *   4. combined effect on a full page-parse
 */
import { load } from 'cheerio';

// ─── Fixture: a realistic search fragment ──────────────────────────────
// 25 job cards (one LinkedIn page) wrapped in the nav/footer chrome that
// makes $('li') expensive in the real response.
function buildCard(i) {
    return `
  <li>
    <div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:39123456${String(i).padStart(2, '0')}">
      <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/39123456${String(i).padStart(2, '0')}?trk=guest&amp;position=${i}&amp;refId=abc123">
        <span class="sr-only">Senior Software Engineer ${i}</span>
      </a>
      <div class="search-entity-media">
        <img class="artdeco-entity-image" data-delayed-url="https://media.licdn.com/logo${i}.png" alt="logo">
      </div>
      <div class="base-search-card__info">
        <h3 class="base-search-card__title">Senior Software Engineer ${i}</h3>
        <h4 class="base-search-card__subtitle">
          <a class="hidden-nested-link" href="https://www.linkedin.com/company/${10000 + i}">Company ${i}</a>
        </h4>
        <div class="base-search-card__metadata">
          <span class="job-search-card__location">San Francisco, CA (Remote)</span>
          <time class="job-search-card__listdate" datetime="2026-09-1${i % 10}">2 days ago</time>
          <span class="job-search-card__salary-info">$150,000 - $200,000/yr</span>
          <span class="result-benefits__text">Be among the first 25 applicants</span>
        </div>
      </div>
    </div>
  </li>`;
}

// Nav + footer chrome: lots of <li> that are NOT job cards.
const CHROME_LIS = Array.from({ length: 80 }, (_, i) =>
    `<li class="nav-item"><a href="/n/${i}"><span>Nav link ${i}</span></a></li>`).join('');

const SEARCH_HTML = `<!DOCTYPE html><html><head><title>Jobs</title></head><body>
<nav><ul>${CHROME_LIS}</ul></nav>
<ul class="jobs-search__results-list">
${Array.from({ length: 25 }, (_, i) => buildCard(i)).join('')}
</ul>
<footer><ul>${CHROME_LIS}</ul></footer>
</body></html>`;

console.log(`fixture: ${(Buffer.byteLength(SEARCH_HTML) / 1024).toFixed(1)} KB, ` +
            `25 job cards, ${160} chrome <li> elements\n`);

// ─── Timing helper ─────────────────────────────────────────────────────
function bench(label, fn, reps = 200) {
    for (let i = 0; i < 20; i++) fn();           // warm up JIT
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < reps; i++) fn();
    const t1 = process.hrtime.bigint();
    const msPerOp = Number(t1 - t0) / 1e6 / reps;
    return { label, msPerOp };
}

function report(title, rows) {
    console.log(`--- ${title} ---`);
    const slowest = Math.max(...rows.map(r => r.msPerOp));
    for (const r of rows.sort((a, b) => b.msPerOp - a.msPerOp)) {
        console.log(`  ${r.label.padEnd(42)} ${r.msPerOp.toFixed(3)} ms   ` +
                    `(${(slowest / r.msPerOp).toFixed(2)}x)`);
    }
    console.log();
}

// ─── 1. Parser backend ─────────────────────────────────────────────────
report('cheerio parse only, per page', [
    bench('parse5 (cheerio default)', () => load(SEARCH_HTML)),
    bench('htmlparser2 (xmlMode:false)', () => load(SEARCH_HTML, null, false)),
]);

// ─── 2. Selector scope ─────────────────────────────────────────────────
const $p5 = load(SEARCH_HTML);
report('element selection, per page', [
    bench("$('li')  — whole document", () => $p5('li').length),
    bench("$('li.jobs-search__results-list > li, .base-card')", () =>
        $p5('.jobs-search__results-list > li').length),
]);

// ─── 3. Repeated subtree .text() ───────────────────────────────────────
const firstCard = $p5('.base-card').first();
report('metadata text extraction, per card', [
    bench('.text() called 3x on same subtree', () => {
        const a = firstCard.find('.base-search-card__metadata').text();
        const b = firstCard.find('.base-search-card__metadata').text();
        const c = firstCard.find('.base-search-card__metadata').text();
        return a.length + b.length + c.length;
    }, 2000),
    bench('.text() computed once, reused', () => {
        const a = firstCard.find('.base-search-card__metadata').text();
        return a.length * 3;
    }, 2000),
]);

// ─── 4. Full page parse, current vs optimised ──────────────────────────
import { parseJobListing } from '../src/parsers.js';

function parseCurrent(html) {
    const $ = load(html);                         // parse5
    const out = [];
    $('li').each((_, el) => {                     // every <li> in the document
        const job = parseJobListing($, el);
        if (job) out.push(job);
    });
    return out;
}

function parseOptimised(html) {
    const $ = load(html, null, false);            // htmlparser2
    const out = [];
    $('.jobs-search__results-list > li, li > .base-card').each((_, el) => {
        const li = el.name === 'li' ? el : el.parent;
        const job = parseJobListing($, li);
        if (job) out.push(job);
    });
    return out;
}

const nCurrent = parseCurrent(SEARCH_HTML).length;
const nOpt = parseOptimised(SEARCH_HTML).length;
console.log(`sanity: current extracts ${nCurrent} jobs, optimised extracts ${nOpt}\n`);

report('full page parse (parse + select + extract)', [
    bench('current: parse5 + $(\'li\')', () => parseCurrent(SEARCH_HTML), 100),
    bench('optimised: htmlparser2 + scoped', () => parseOptimised(SEARCH_HTML), 100),
]);
