// Runs the actual actor against a local HTTP fixture; no LinkedIn traffic.
// Optional baseline: ACTOR_BASELINE=/absolute/path/to/baseline-main.js npm run bench:actor
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

let requests = 0;
const server = http.createServer((req, res) => {
    requests++;
    const u = new URL(req.url, 'http://localhost');
    const offset = Number(u.searchParams.get('start'));
    const scenario = u.searchParams.get('case');
    const duplicate = scenario === 'duplicates';
    if (scenario === 'failed-page' && offset === 70) { res.writeHead(500); res.end('fixture failure'); return; }
    const start = duplicate && offset < 80 ? 0 : offset;
    const cards = offset >= (scenario === 'empty' ? 40 : 240) ? '' : Array.from({ length: 10 }, (_, i) => {
        const id = 4000000000 + start + i;
        return `<li><div class="base-card" data-entity-urn="urn:li:jobPosting:${id}"><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/${id}"></a><h3 class="base-search-card__title">Engineer ${id}</h3></div></li>`;
    }).join('');
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(cards); }, offset % 80 === 70 ? 800 : 60);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/search`;
async function run(entry, scenario) {
    const storage = await mkdtemp(join(tmpdir(), 'scrapper2-bench-'));
    const kv = join(storage, 'key_value_stores', 'default');
    await mkdir(kv, { recursive: true });
    await writeFile(join(kv, 'INPUT.json'), JSON.stringify({
        startUrls: [`${base}?case=${scenario}`], maxItems: 160,
        proxyConfiguration: { useApifyProxy: false },
        maxConcurrency: 8, paginationBatchSize: 8, requestsPerMinuteMultiplier: 30, maxRequestRetries: 0,
    }));
    requests = 0;
    const start = performance.now();
    let logs = '';
    try {
        await new Promise((accept, reject) => {
            const child = spawn(process.execPath, [entry], {
                env: { ...process.env, CRAWLEE_STORAGE_DIR: storage, APIFY_LOCAL_STORAGE_DIR: storage, APIFY_LOG_LEVEL: 'ERROR' },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
            const timer = setTimeout(() => { child.kill(); reject(new Error('Actor timed out\n' + logs)); }, 60000);
            child.on('error', reject);
            child.on('exit', code => { clearTimeout(timer); code === 0 ? accept() : reject(new Error(logs)); });
        });
        const seconds = (performance.now() - start) / 1000;
        const dir = join(storage, 'datasets', 'default');

        const names = (await readdir(dir)).filter(n => /^\d+\.json$/.test(n));
        const rows = await Promise.all(names.map(async n => JSON.parse(await readFile(join(dir, n), 'utf8'))));
        assert.equal(new Set(rows.map(r => r.jobId)).size, rows.length, 'no duplicate jobs');
        assert.ok(rows.length <= 160, 'maxItems enforced');
        if (entry === resolve('src/main.js')) assert.equal(rows.length, scenario === 'empty' ? 40 : 160, 'all available/requested jobs returned');
        return { actor: entry.includes('baseline') ? 'baseline' : 'updated', scenario, jobs: rows.length, requests, seconds: +seconds.toFixed(3) };
    } finally { await rm(storage, { recursive: true, force: true }); }
}
try {
    const results = [];
    for (const scenario of ['normal', 'duplicates', 'failed-page', 'empty']) {
        if (process.env.ACTOR_BASELINE) results.push(await run(process.env.ACTOR_BASELINE, scenario));
        results.push(await run(resolve('src/main.js'), scenario));
    }
    console.table(results);
} finally { server.close(); }
