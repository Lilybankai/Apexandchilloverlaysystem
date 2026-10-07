/**
 * trainingRefCache.js — board-lap traces kept on disk for the Training
 * reference, and the backoff that keeps a failing fetch from hammering.
 * -----------------------------------------------------------------------------
 * A board lap's trace is ~65 KB of JSON and does not change while its board
 * time stands, so it is fetched once and kept: a driver who chases the same
 * lap every evening should cost the league one request, ever. Two rules shape
 * this file:
 *
 *   1. **Async fs only.** It runs in Electron's main process, on the thread
 *      that composites every overlay. No `*Sync` call appears here, and
 *      `scripts/test-trainingref.js` makes them throw while it runs.
 *   2. **A failure is never cached.** Only a trace that arrived and checked
 *      out is written. A failed fetch goes into {@link Backoff}, which lives in
 *      memory, doubles a delay up to a cap and then keeps retrying at the cap,
 *      so "the league was down for ten minutes" heals by itself without a
 *      restart.
 *
 * ## The key, and why it is the file name
 * `trackId|CLASS|driverId|lapMs` — the board row's own identity plus its time.
 * A driver who sets a quicker lap gets a new key, so a stale trace can never
 * be served for a new time; the superseded file for that driver is deleted
 * when the new one is written ({@link TraceCache.put}). The key IS the file
 * name (`.`-joined, each part checked against a strict alphabet), so the
 * folder listing is the index: no index file to write, tear or disagree with
 * the files.
 *
 * ## LRU
 * Bounded at {@link MAX_ENTRIES} laps (~3 MB). Recency is the file's mtime,
 * refreshed on every hit, so the order survives a restart; a few parsed
 * payloads are also kept in memory so repeated selections of the same lap do
 * not re-read or re-parse anything.
 */

'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

/** Laps kept on disk. */
const MAX_ENTRIES = 50;
/** Parsed payloads kept in memory. */
const MEMORY_ENTRIES = 4;
/** First retry delay after a failed fetch; doubles per failure. */
const BACKOFF_BASE_MS = 5_000;
/** The delay stops growing here — but retries never stop. */
const BACKOFF_MAX_MS = 5 * 60_000;

const PART = /^[A-Za-z0-9_-]{1,64}$/;

/** The cache key for a board row. `null` when any part is unusable. */
function cacheKey(trackId, carClass, driverId, lapMs) {
  const ms = Number(lapMs);
  if (!Number.isInteger(ms) || ms <= 0) return null;
  const parts = [String(trackId || ''), String(carClass || '').toUpperCase(), String(driverId || ''), String(ms)];
  return parts.every((p) => PART.test(p)) ? parts.join('|') : null;
}

/** `trackId|CLASS|driverId|` — every time this driver has had on this board. */
function rowPrefix(key) {
  return key.slice(0, key.lastIndexOf('|') + 1);
}

function fileOf(key) {
  return `${key.split('|').join('.')}.json`;
}

function keyOf(file) {
  if (!file.endsWith('.json')) return null;
  const parts = file.slice(0, -5).split('.');
  if (parts.length !== 4) return null;
  const key = parts.join('|');
  return cacheKey(parts[0], parts[1], parts[2], parts[3]) === key ? key : null;
}

class TraceCache {
  /**
   * @param {object} opts
   * @param {string} opts.dir         folder to keep traces in (created on first write)
   * @param {number} [opts.max]       laps kept on disk
   * @param {() => number} [opts.now] wall clock, a seam for the tests
   */
  constructor(opts) {
    this.dir = opts.dir;
    this.max = Math.max(1, opts.max || MAX_ENTRIES);
    this.now = opts.now || Date.now;
    /** key → last use (ms). Loaded from the folder once, then kept current. */
    this.entries = null;
    this.loading = null;
    /** key → parsed payload, most recent last. */
    this.memory = new Map();
    /** Serialises writes and evictions so two puts cannot race an unlink. */
    this.tail = Promise.resolve();
  }

  /** The cached payload for `key`, or `null`. Never rejects. */
  async get(key) {
    if (!key) return null;
    const hot = this.memory.get(key);
    if (hot) {
      this.remember(key, hot);
      this.touch(key);
      return hot;
    }
    const entries = await this.load();
    if (!entries.has(key)) return null;
    try {
      const body = JSON.parse(await fsp.readFile(path.join(this.dir, fileOf(key)), 'utf8'));
      if (!body || body.key !== key || !body.payload) throw new Error('not this key');
      this.remember(key, body.payload);
      this.touch(key);
      return body.payload;
    } catch {
      // Torn, hand-edited or gone: forget it, so the next ask fetches afresh.
      entries.delete(key);
      this.enqueue(() => fsp.unlink(path.join(this.dir, fileOf(key))));
      return null;
    }
  }

  /**
   * Keep a payload that arrived and checked out. Drops any older time for the
   * same driver on the same board, then trims to {@link max}. Never rejects;
   * a failed write only costs a refetch next time.
   */
  put(key, payload) {
    if (!key || !payload) return Promise.resolve();
    this.remember(key, payload);
    return this.enqueue(async () => {
      const entries = await this.load();
      await fsp.mkdir(this.dir, { recursive: true });
      const file = path.join(this.dir, fileOf(key));
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ v: 1, key, savedAt: this.now(), payload }), 'utf8');
      await fsp.rename(tmp, file);
      entries.set(key, this.now());
      const prefix = rowPrefix(key);
      for (const k of [...entries.keys()]) {
        if (k !== key && k.startsWith(prefix)) await this.drop(k);
      }
      if (entries.size > this.max) {
        const oldest = [...entries.entries()].sort((a, b) => a[1] - b[1]);
        for (const [k] of oldest.slice(0, entries.size - this.max)) await this.drop(k);
      }
    });
  }

  /** Resolves once queued writes have settled. For the tests. */
  settled() {
    return this.tail;
  }

  /* ------------------------------ internals ------------------------------ */

  load() {
    if (this.entries) return Promise.resolve(this.entries);
    if (!this.loading) {
      this.loading = (async () => {
        const entries = new Map();
        let names = [];
        try {
          names = await fsp.readdir(this.dir);
        } catch {
          /* no folder yet: an empty cache */
        }
        for (const name of names) {
          const key = keyOf(name);
          if (!key) continue;
          try {
            entries.set(key, (await fsp.stat(path.join(this.dir, name))).mtimeMs);
          } catch {
            /* vanished between readdir and stat */
          }
        }
        this.entries = entries;
        return entries;
      })();
    }
    return this.loading;
  }

  async drop(key) {
    this.entries?.delete(key);
    this.memory.delete(key);
    try {
      await fsp.unlink(path.join(this.dir, fileOf(key)));
    } catch {
      /* already gone */
    }
  }

  remember(key, payload) {
    this.memory.delete(key);
    this.memory.set(key, payload);
    while (this.memory.size > MEMORY_ENTRIES) this.memory.delete(this.memory.keys().next().value);
  }

  /** Mark a hit, in memory now and on disk (mtime) without waiting. */
  touch(key) {
    const t = this.now();
    if (this.entries && this.entries.has(key)) this.entries.set(key, t);
    const when = new Date(t);
    this.enqueue(() => fsp.utimes(path.join(this.dir, fileOf(key)), when, when));
  }

  enqueue(fn) {
    this.tail = this.tail.then(fn).catch(() => undefined);
    return this.tail;
  }
}

/**
 * Per-key failure memory: how long to leave a failing fetch alone. In memory
 * only, so a restart forgets every failure, and capped so a key that failed a
 * hundred times is still tried every {@link BACKOFF_MAX_MS}.
 */
class Backoff {
  constructor(opts = {}) {
    this.base = opts.baseMs || BACKOFF_BASE_MS;
    this.cap = opts.maxMs || BACKOFF_MAX_MS;
    this.failures = new Map();
  }

  /** Whether `key` may be tried at `now`. */
  ready(key, now) {
    const f = this.failures.get(key);
    return !f || now >= f.retryAt;
  }

  /** Record a failure; returns when the next try is allowed. */
  fail(key, now) {
    const count = (this.failures.get(key)?.count || 0) + 1;
    const delay = Math.min(this.cap, this.base * 2 ** (count - 1));
    const retryAt = now + delay;
    this.failures.set(key, { count, retryAt });
    // Bounded like the cache: a long session should not grow this forever.
    if (this.failures.size > 64) this.failures.delete(this.failures.keys().next().value);
    return retryAt;
  }

  /** Forget a key's failures — it worked, or the question changed. */
  clear(key) {
    this.failures.delete(key);
  }

  /** When `key` may next be tried, or 0 when it may now. */
  retryAt(key) {
    return this.failures.get(key)?.retryAt || 0;
  }
}

module.exports = {
  TraceCache,
  Backoff,
  cacheKey,
  MAX_ENTRIES,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
};
