// Bounded, continuously replenished pagination. Duplicate-only pages are not
// exhaustion: another query (or a resumed run) may already have seen their IDs.
export class SearchWindow {
    constructor({ size, pageSize, maxOffset, startOffset = 0 }) {
        this.size = size;
        this.pageSize = pageSize;
        this.maxOffset = maxOffset;
        this.nextOffset = startOffset;
        this.pending = new Set();
        this.exhausted = false;
    }

    take(remaining) {
        const offsets = [];
        const target = Math.min(this.size, Math.ceil(Math.max(0, remaining) / this.pageSize));
        while (!this.exhausted && this.pending.size < target && this.nextOffset < this.maxOffset) {
            const offset = this.nextOffset;
            this.nextOffset += this.pageSize;
            this.pending.add(offset);
            offsets.push(offset);
        }
        return offsets;
    }

    complete(offset, { empty = false } = {}) {
        if (!this.pending.delete(offset)) return;
        if (empty) this.exhausted = true;
    }
}

// Evaluate independent windows with a cooldown, instead of repeatedly halving
// concurrency on every subsequent success because old failures remain counted.
export class ConcurrencyController {
    constructor({ maxConcurrency, threshold, sampleSize = 10, cooldownMs = 15000 }) {
        Object.assign(this, { maxConcurrency, threshold, sampleSize, cooldownMs });
        this.samples = 0;
        this.blocked = 0;
        this.lastChange = -Infinity;
    }

    record(blocked, current, now = Date.now()) {
        this.samples++;
        this.blocked += Number(blocked);
        if (this.samples < this.sampleSize) return current;
        const rate = this.blocked / this.samples;
        this.samples = 0;
        this.blocked = 0;
        if (now - this.lastChange < this.cooldownMs) return current;
        let next = current;
        if (rate > this.threshold) next = Math.max(1, Math.floor(current / 2));
        else if (rate === 0) next = Math.min(this.maxConcurrency, current + 1);
        if (next !== current) this.lastChange = now;
        return next;
    }
}
