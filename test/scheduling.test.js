import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchWindow, ConcurrencyController } from '../src/scheduling.js';
const create = (options = {}) => new SearchWindow({ size: 3, pageSize: 10, maxOffset: 100, ...options });

test('a fast page replenishes the window without waiting for its last page', () => {
    const w = create();
    assert.deepEqual(w.take(100), [0, 10, 20]);
    w.complete(0);
    assert.deepEqual(w.take(90), [30]);
    assert.equal(w.pending.size, 3);
    w.complete(10); // duplicate-only results still count as a nonempty page
    assert.deepEqual(w.take(90), [40]);
});
test('empty pages stop new requests while pending pages remain available', () => {
    const w = create(); w.take(100); w.complete(10, { empty: true });
    assert.deepEqual(w.take(100), []);
    assert.equal(w.pending.size, 2);
});
test('remaining item budget and endpoint ceiling bound speculative work', () => {
    const w = create({ startOffset: 80 });
    assert.deepEqual(w.take(100), [80, 90]);
    w.complete(80);
    assert.deepEqual(w.take(100), []);
    assert.deepEqual(create().take(1), [0]);
    assert.deepEqual(create().take(0), []);
});
test('duplicate completion cannot create extra slots; terminal failure releases one', () => {
    const w = create(); w.take(100); w.complete(20); w.complete(20);
    assert.deepEqual(w.take(100), [30]);
});
test('old failures do not repeatedly halve concurrency; clean windows recover', () => {
    const c = new ConcurrencyController({ maxConcurrency: 10, threshold: 0.3 });
    let n = 10;
    for (let i = 0; i < 10; i++) n = c.record(i < 4, n, 0);
    assert.equal(n, 5);
    for (let i = 0; i < 10; i++) n = c.record(false, n, 1000);
    assert.equal(n, 5);
    for (let i = 0; i < 10; i++) n = c.record(false, n, 15000);
    assert.equal(n, 6);
    for (let t = 30000; t <= 120000; t += 15000) {
        for (let i = 0; i < 10; i++) n = c.record(false, n, t);
    }
    assert.equal(n, 10);
});
test('sustained blocking still throttles, at most once per cooldown', () => {
    const c = new ConcurrencyController({ maxConcurrency: 10, threshold: 0.3 });
    let n = 10;
    for (let i = 0; i < 30; i++) n = c.record(true, n, 0);
    assert.equal(n, 5);
    for (let i = 0; i < 10; i++) n = c.record(true, n, 15000);
    assert.equal(n, 2);
});
