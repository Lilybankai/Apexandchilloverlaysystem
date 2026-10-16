/**
 * electron/setupHistory.js — the Setups tab's History: every version of a car's
 * setup at a track, recorded as it happens, so a driver can go back.
 * -----------------------------------------------------------------------------
 * Drivers experiment more now (± buttons, engineer macros), and an experiment
 * needs a way back. This module keeps one history per car + LMU track folder
 * (the same identity the library and community setups file under) in
 * userData/setup-history/, and records a version when:
 *
 *   - the car + track is first seen this run       'session'  (baseline)
 *   - Apply sends a batch                          'engineer' / 'library' / 'restore'
 *   - slider and ± writes from the editor          'editor'   (coalesced)
 *   - values change that WE did not write          'game'     (LMU's garage screen)
 *
 * Two feeds tell it what the car looks like: the provider's own 3 s garage
 * poll (via src/telemetry/garageTap.ts — runs whether or not the Setups tab is
 * open, which is what catches garage-screen edits) and the editor's
 * `setup:state` reads while the tab is visible. Writes tell it who changed
 * what: main calls expectWrites() BEFORE posting and noteWrite()/noteBatch()
 * after, so a poll that lands mid-write is never mistaken for the game.
 *
 * Quiet windows: editor writes and game changes both arrive a click at a time.
 * They are folded into one version after QUIET_MS with no further change of
 * the same kind, and a window that nets out to nothing (up two clicks, down
 * two) records nothing at all.
 *
 * THE MAIN-THREAD RULE. This runs in the Electron main process, on the thread
 * that composites every overlay (see the stall memory). So: no sync I/O except
 * at quit, every feed is an in-memory compare, disk writes are async, coalesced
 * per file, and atomic (temp file + rename). A corrupt file never throws — it
 * is kept as .bak and the history starts again.
 *
 * No Electron imports: main hands in the directory and the key resolver, and
 * scripts/test-setup-history.js drives the whole thing with fake timers.
 */

'use strict';

const fs = require('node:fs');
const nodeFsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./control-panel/setup-history-core.js');

/** Fold a run of edits into one version after this long with no more. */
const QUIET_MS = 10000;
/**
 * How long a key we just wrote is ignored by the observers. A garage poll that
 * was already in flight when we posted comes back with the OLD value; without
 * this it would read as "the game changed it back". Covers the provider's 3 s
 * tick plus its 2 s request timeout.
 */
const WRITE_GUARD_MS = 8000;
/** After a failed car/track lookup, don't ask again for this long. */
const RESOLVE_BACKOFF_MS = 15000;
/** A feed older than this means the car is no longer in front of us. */
const LIVE_MS = 15000;

const BATCH_SOURCES = new Set(['engineer', 'library', 'restore']);

class SetupHistory {
  /**
   * @param {object} opts
   * @param {string} opts.dir                 where the history files live
   * @param {() => Promise<{car, trackFolder, trackName?, carClass?}|null>} [opts.resolveKey]
   *        where are we? — only asked when a garage poll shows a change
   */
  constructor(opts) {
    this.dir = opts.dir;
    this.resolveKey = opts.resolveKey || (async () => null);
    this.now = opts.now || Date.now;
    this.setTimer = opts.setTimer || setTimeout;
    this.clearTimer = opts.clearTimer || clearTimeout;
    this.quietMs = opts.quietMs ?? QUIET_MS;
    this.guardMs = opts.guardMs ?? WRITE_GUARD_MS;
    this.cap = opts.cap ?? core.CAP;
    this.fsp = opts.fsp || nodeFsp;
    this.log = opts.log || console;

    this.queue = Promise.resolve(); // every state change runs in order, one at a time
    this.stores = new Map(); // id -> { meta, entries (oldest first), rev, savedRev }
    this.loading = new Map(); // id -> Promise<store>
    this.saving = new Map(); // id -> tail of that file's write chain
    this.index = null; // { v, keys: { id: meta }, lastId }
    this.indexRev = 0;
    this.indexSavedRev = 0;
    this.indexSaving = Promise.resolve();
    this.indexQueued = false;
    this.ctx = null; // the car + track in front of us — see enter()
    this.guard = new Map(); // setting key -> ignore observations until (ms)
    this.seenThisRun = new Set();
    this.resolveAfter = 0;
    this.seq = 0;
    this.closed = false;
  }

  /* ====================================================================== */
  /*  Feeds                                                                 */
  /* ====================================================================== */

  /**
   * The editor's `setup:state` result (car identity included). Returns the
   * history key for that car + track ('' when unknown) so main can hand it to
   * the panel — the panel then never has to re-derive the identity rule.
   */
  observeState(state) {
    if (!state || !state.connected || !Array.isArray(state.settings)) return '';
    const meta = {
      car: state.carModel || state.car || '',
      trackFolder: state.trackFolder || '',
      trackName: state.trackName || '',
      carClass: state.carClass || '',
    };
    const id = core.keyId(meta.car, meta.trackFolder);
    if (!id) return '';
    const snap = core.snapshotFromSettings(state.settings);
    void this.enqueue(() => this.observe(snap, { id, ...meta }));
    return id;
  }

  /**
   * A raw garage payload from the provider's poll. Called on the poll's own
   * tick, so the common case — nothing changed — is one in-memory compare and
   * no promise at all.
   */
  observeGarage(raw) {
    if (this.closed) return;
    const snap = core.snapshotFromGarage(raw);
    if (Object.keys(snap.values).length === 0) return;
    const ctx = this.ctx;
    if (ctx && !this.differs(ctx.live, snap)) {
      ctx.seenAt = this.now();
      return;
    }
    void this.enqueue(() => this.observeUnkeyed(snap));
  }

  /** Main is about to post these keys: observers ignore them for a while. */
  expectWrites(keys) {
    const until = this.now() + this.guardMs;
    for (const k of keys || []) if (typeof k === 'string' && k) this.guard.set(k, until);
  }

  /** A single live write landed (slider, ± button): `{key, value, str}`. */
  noteWrite(w) {
    if (!w || typeof w.key !== 'string' || typeof w.value !== 'number') return Promise.resolve();
    return this.enqueue(() => {
      const ctx = this.ctx;
      if (!ctx) return;
      this.guard.set(w.key, this.now() + this.guardMs);
      if (ctx.pending && ctx.pending.source !== 'editor') this.commit();
      ctx.live = core.applyWrites(ctx.live, [w]);
      if (!ctx.pending) ctx.pending = { source: 'editor' };
      this.arm();
    });
  }

  /**
   * An Apply landed. `applied` is `[{key, value, str}]` for the keys that took;
   * `meta` is `{source, label}` from the panel. Recorded at once as ONE
   * version — an Apply is a single deliberate act, there is nothing to fold.
   */
  noteBatch(meta, applied) {
    const source = meta && BATCH_SOURCES.has(meta.source) ? meta.source : 'engineer';
    const label =
      meta && typeof meta.label === 'string' ? meta.label.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    const list = Array.isArray(applied) ? applied : [];
    return this.enqueue(() => {
      const ctx = this.ctx;
      if (!ctx) return null;
      if (ctx.pending) this.commit();
      const until = this.now() + this.guardMs;
      for (const w of list) if (w && w.key) this.guard.set(w.key, until);
      ctx.live = core.applyWrites(ctx.live, list);
      ctx.pending = { source, ...(label ? { label } : {}) };
      return this.commit();
    });
  }

  /* ====================================================================== */
  /*  Queries (IPC)                                                         */
  /* ====================================================================== */

  /**
   * The list for one car + track (default: the one in front of us, else the
   * most recent). Entries are newest first and LIGHT — no snapshots; the
   * panel asks for one with entry() when it restores or compares.
   */
  list(id) {
    return this.enqueue(async () => {
      await this.ensureIndex();
      const keys = Object.entries(this.index.keys)
        .map(([k, m]) => ({
          id: k,
          car: m.car || '',
          trackFolder: m.trackFolder || '',
          trackName: m.trackName || '',
          carClass: m.carClass || '',
          count: m.count || 0,
          lastAt: m.lastAt || 0,
        }))
        .sort((a, b) => b.lastAt - a.lastAt);
      const currentId = this.ctx ? this.ctx.id : '';
      let want = typeof id === 'string' && id ? id : currentId;
      if (!want) want = this.index.lastId && this.index.keys[this.index.lastId] ? this.index.lastId : '';
      if (!want && keys.length) want = keys[0].id;
      const base = { ok: true, currentId, live: this.isLive(), keys, pending: null };
      if (!want) return { ...base, key: null, entries: [] };
      const store = await this.load(want);
      const isCtx = Boolean(this.ctx && this.ctx.id === want);
      let currentEntry = '';
      // "On the car" only while the car is actually in front of us — a
      // remembered context from an hour ago is not what is on it now.
      if (isCtx && !this.ctx.pending && this.isLive()) {
        for (let i = store.entries.length - 1; i >= 0; i--) {
          if (core.sameSnapshot(store.entries[i], this.ctx.live)) {
            currentEntry = store.entries[i].id;
            break;
          }
        }
      }
      const entries = [];
      for (let i = store.entries.length - 1; i >= 0; i--) {
        const e = store.entries[i];
        entries.push({
          id: e.id,
          at: e.at,
          source: e.source,
          ...(e.label ? { label: e.label } : {}),
          changes: e.changes,
          ...(e.id === currentEntry ? { isCurrent: true } : {}),
        });
      }
      const pending =
        isCtx && this.ctx.pending
          ? {
              source: this.ctx.pending.source,
              count: core.diffSnapshots(this.ctx.known, this.ctx.live).length,
            }
          : null;
      return {
        ...base,
        key: { id: want, ...metaOf(store.meta), count: store.entries.length },
        entries,
        pending,
      };
    });
  }

  /** One full entry (with its snapshot), or null. */
  entry(id, entryId) {
    return this.enqueue(async () => {
      if (typeof id !== 'string' || !id || typeof entryId !== 'string') return null;
      await this.ensureIndex();
      if (!this.index.keys[id] && !(this.ctx && this.ctx.id === id)) return null;
      const store = await this.load(id);
      const e = store.entries.find((x) => x.id === entryId);
      return e ? JSON.parse(JSON.stringify(e)) : null;
    });
  }

  /**
   * Forget one car + track's history. If it is the car in front of us, the
   * next observation records a fresh "Session start" — history begins again
   * from the setup as it is now, so there is always something to go back to.
   */
  clear(id) {
    return this.enqueue(async () => {
      if (typeof id !== 'string' || !id) return { ok: false, error: 'needs a history key' };
      await this.ensureIndex();
      const file = this.fileFor(id);
      // Wait for any write in flight, or it would resurrect the file.
      await (this.saving.get(id) || Promise.resolve());
      this.stores.delete(id);
      delete this.index.keys[id];
      if (this.index.lastId === id) this.index.lastId = '';
      this.touchIndex();
      this.seenThisRun.delete(id);
      if (this.ctx && this.ctx.id === id) {
        if (this.ctx.timer) this.clearTimer(this.ctx.timer);
        this.ctx = null;
      }
      try {
        await this.fsp.unlink(file);
      } catch (err) {
        if (err && err.code !== 'ENOENT') return { ok: false, error: err.message };
      }
      return { ok: true };
    });
  }

  /** Every queued change and write settled — for tests, and before quit. */
  async idle() {
    await this.queue;
    await Promise.all([...this.saving.values()]);
    await this.indexSaving;
  }

  /**
   * App quit: fold any open window into a version and write whatever has not
   * reached disk. The one place sync I/O is allowed — quit is not a hot path,
   * and an async write here would be cut off by the exit.
   */
  shutdown() {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.ctx && this.ctx.pending) this.commit();
      for (const [id, store] of this.stores) {
        if (store.rev === store.savedRev) continue;
        writeAtomicSync(this.fileFor(id), serialise(store));
        store.savedRev = store.rev;
      }
      if (this.index && this.indexRev !== this.indexSavedRev) {
        writeAtomicSync(path.join(this.dir, 'index.json'), JSON.stringify(this.index));
        this.indexSavedRev = this.indexRev;
      }
    } catch (err) {
      this.log.warn('[setup-history] quit flush failed:', err.message);
    }
  }

  /* ====================================================================== */
  /*  The recorder                                                          */
  /* ====================================================================== */

  enqueue(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch((err) => {
      this.log.warn('[setup-history]', err && err.message ? err.message : err);
    });
    return run.catch(() => null);
  }

  /** Does `snap` differ from `live` in any key we are not mid-writing? */
  differs(live, snap) {
    if (Object.keys(live.values).length !== Object.keys(snap.values).length) return true;
    const now = this.now();
    for (const c of core.diffSnapshots(live, snap)) {
      if (!((this.guard.get(c.key) || 0) > now)) return true;
    }
    return false;
  }

  isLive() {
    return Boolean(this.ctx && this.now() - (this.ctx.seenAt || 0) < LIVE_MS);
  }

  /** A garage poll showed a change: find out which car + track it is first. */
  async observeUnkeyed(snap) {
    // Re-check: an earlier queued step may have caught up with this already.
    if (this.ctx && !this.differs(this.ctx.live, snap)) {
      this.ctx.seenAt = this.now();
      return;
    }
    if (this.now() < this.resolveAfter) return;
    let where = null;
    try {
      where = await this.resolveKey();
    } catch {
      where = null;
    }
    const id = where ? core.keyId(where.car, where.trackFolder) : '';
    if (!id) {
      this.resolveAfter = this.now() + RESOLVE_BACKOFF_MS;
      return;
    }
    await this.observe(snap, {
      id,
      car: where.car,
      trackFolder: where.trackFolder,
      trackName: where.trackName || '',
      carClass: where.carClass || '',
    });
  }

  async observe(snap, meta) {
    if (this.closed || Object.keys(snap.values).length === 0) return;
    if (!this.ctx || this.ctx.id !== meta.id) {
      await this.enter(snap, meta);
      return;
    }
    this.ctx.seenAt = this.now();
    this.updateMeta(meta);
    this.absorb(snap);
  }

  /**
   * A car + track comes into view. Any open window on the previous one is
   * folded first. The first sighting this run records the baseline — always
   * for a brand-new history, otherwise only if the setup moved while we were
   * not looking (a fresh "Session start" for an unchanged car is noise).
   */
  async enter(snap, meta) {
    if (this.ctx) {
      if (this.ctx.pending) this.commit();
      if (this.ctx.timer) this.clearTimer(this.ctx.timer);
      this.ctx = null;
    }
    await this.ensureIndex();
    const store = await this.load(meta.id);
    this.updateMetaOn(store, meta);
    const newest = store.entries[store.entries.length - 1] || null;
    this.ctx = {
      id: meta.id,
      known: core.cloneSnapshot(snap),
      live: core.cloneSnapshot(snap),
      pending: null,
      timer: null,
      seenAt: this.now(),
    };
    if (this.index.lastId !== meta.id) {
      this.index.lastId = meta.id;
      this.touchIndex();
    }
    if (!this.seenThisRun.has(meta.id)) {
      this.seenThisRun.add(meta.id);
      if (!newest) {
        this.push(meta.id, { source: 'session', snap, changes: [] });
      } else {
        const changes = core.diffSnapshots(newest, snap);
        if (changes.length) this.push(meta.id, { source: 'session', snap, changes });
      }
      return;
    }
    // Back to a car we already saw this run: anything different from its last
    // version happened in the game while we were looking elsewhere.
    if (newest) {
      this.ctx.known = core.cloneSnapshot(newest);
      this.ctx.live = core.cloneSnapshot(newest);
      this.absorb(snap);
    }
  }

  /** Fold an observation into the open window as the game's doing. */
  absorb(snap) {
    const ctx = this.ctx;
    const now = this.now();
    const changes = core
      .diffSnapshots(ctx.live, snap)
      .filter((c) => !((this.guard.get(c.key) || 0) > now));
    if (changes.length === 0) return;
    if (ctx.pending && ctx.pending.source !== 'game') this.commit();
    ctx.live = core.applyWrites(
      ctx.live,
      changes.map((c) => ({ key: c.key, value: c.to, str: c.toStr })),
    );
    if (!ctx.pending) ctx.pending = { source: 'game' };
    this.arm();
  }

  /** (Re)start the quiet window. */
  arm() {
    const ctx = this.ctx;
    if (ctx.timer) this.clearTimer(ctx.timer);
    ctx.timer = this.setTimer(() => {
      ctx.timer = null;
      void this.enqueue(() => {
        if (this.ctx === ctx) this.commit();
      });
    }, this.quietMs);
    if (ctx.timer && typeof ctx.timer.unref === 'function') ctx.timer.unref();
  }

  /** Close the open window: one version for its net change, or nothing. */
  commit() {
    const ctx = this.ctx;
    if (!ctx) return null;
    if (ctx.timer) {
      this.clearTimer(ctx.timer);
      ctx.timer = null;
    }
    const pending = ctx.pending;
    ctx.pending = null;
    if (!pending) return null;
    const changes = core.diffSnapshots(ctx.known, ctx.live);
    if (changes.length === 0) return null; // up two, down two: nothing happened
    const entry = this.push(ctx.id, {
      source: pending.source,
      label: pending.label,
      snap: ctx.live,
      changes,
    });
    ctx.known = core.cloneSnapshot(ctx.live);
    return entry;
  }

  push(id, { source, label, snap, changes }) {
    const store = this.stores.get(id);
    if (!store) return null;
    const at = this.now();
    const entry = {
      id: `${at.toString(36)}-${(this.seq++).toString(36)}`,
      at,
      source,
      ...(label ? { label } : {}),
      values: { ...snap.values },
      strings: { ...snap.strings },
      changes,
    };
    store.entries.push(entry);
    store.entries = core.capEntries(store.entries, this.cap);
    store.rev++;
    const m = this.index.keys[id] || (this.index.keys[id] = {});
    Object.assign(m, metaOf(store.meta), { count: store.entries.length, lastAt: at });
    this.touchIndex();
    this.scheduleSave(id);
    return entry;
  }

  updateMeta(meta) {
    const store = this.stores.get(meta.id);
    if (store) this.updateMetaOn(store, meta);
  }

  /** Fill in identity fields as better ones arrive (class comes from the editor). */
  updateMetaOn(store, meta) {
    let changed = false;
    for (const k of ['car', 'trackFolder', 'trackName', 'carClass']) {
      if (meta[k] && store.meta[k] !== meta[k]) {
        store.meta[k] = meta[k];
        changed = true;
      }
    }
    if (changed && this.index.keys[meta.id]) {
      Object.assign(this.index.keys[meta.id], metaOf(store.meta));
      this.touchIndex();
    }
  }

  /* ====================================================================== */
  /*  Disk                                                                  */
  /* ====================================================================== */

  /** `<car>__<track>-<hash>.json` — readable, and unique per identity. */
  fileFor(id) {
    const [car, track] = id.split('|');
    const slug = (s) =>
      String(s || '')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'x';
    const hash = crypto.createHash('sha1').update(id).digest('hex').slice(0, 8);
    return path.join(this.dir, `${slug(car)}__${slug(track)}-${hash}.json`);
  }

  load(id) {
    if (this.stores.has(id)) return Promise.resolve(this.stores.get(id));
    if (this.loading.has(id)) return this.loading.get(id);
    const p = this.readStore(id).then((store) => {
      this.stores.set(id, store);
      this.loading.delete(id);
      return store;
    });
    this.loading.set(id, p);
    return p;
  }

  async readStore(id) {
    const [car, trackFolder] = id.split('|');
    const fresh = () => ({
      meta: { car, trackFolder, trackName: '', carClass: '' },
      entries: [],
      rev: 0,
      savedRev: 0,
    });
    const file = this.fileFor(id);
    const parsed = await this.readJson(file);
    if (parsed === undefined) return fresh(); // no file yet
    const ok = parsed === null ? null : core.validateFile(parsed);
    if (!ok) {
      await this.quarantine(file);
      return fresh();
    }
    return {
      meta: { car: ok.car || car, trackFolder: ok.trackFolder || trackFolder, trackName: ok.trackName, carClass: ok.carClass },
      entries: core.capEntries(ok.entries, this.cap),
      rev: 0,
      savedRev: 0,
    };
  }

  /** undefined = no file; null = unreadable or not JSON; else the value. */
  async readJson(file) {
    let text;
    try {
      text = await this.fsp.readFile(file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return undefined;
      this.log.warn('[setup-history] could not read', path.basename(file), err && err.message);
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * Keep a bad file as `.bak` (replacing an older one) so the next save does
   * not destroy what might still be recoverable by hand.
   */
  async quarantine(file) {
    this.log.warn('[setup-history] unreadable history kept as .bak:', path.basename(file));
    try {
      await this.fsp.rename(file, `${file}.bak`);
    } catch {
      /* best effort — a locked file is overwritten by the next save instead */
    }
  }

  scheduleSave(id) {
    const store = this.stores.get(id);
    if (!store || store.saveQueued || this.closed) return;
    store.saveQueued = true;
    const prev = this.saving.get(id) || Promise.resolve();
    const next = prev
      .then(async () => {
        store.saveQueued = false;
        if (this.closed || this.stores.get(id) !== store) return;
        const rev = store.rev;
        await this.writeAtomic(this.fileFor(id), serialise(store));
        store.savedRev = Math.max(store.savedRev, rev);
      })
      .catch((err) => this.log.warn('[setup-history] save failed:', err && err.message));
    this.saving.set(id, next);
  }

  async ensureIndex() {
    if (this.index) return;
    const file = path.join(this.dir, 'index.json');
    const raw = await this.readJson(file);
    if (raw && typeof raw === 'object' && raw.v === 1 && raw.keys && typeof raw.keys === 'object') {
      this.index = { v: 1, keys: raw.keys, lastId: typeof raw.lastId === 'string' ? raw.lastId : '' };
      return;
    }
    if (raw !== undefined) await this.quarantine(file);
    // No index (first run) or a bad one: rebuild it from the files themselves.
    this.index = { v: 1, keys: {}, lastId: '' };
    let names = [];
    try {
      names = await this.fsp.readdir(this.dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'index.json') continue;
      const ok = core.validateFile(await this.readJson(path.join(this.dir, name)));
      if (!ok || !ok.entries.length) continue;
      const id = core.keyId(ok.car, ok.trackFolder);
      if (!id || this.fileFor(id) !== path.join(this.dir, name)) continue;
      this.index.keys[id] = {
        ...metaOf(ok),
        count: ok.entries.length,
        lastAt: ok.entries[ok.entries.length - 1].at,
      };
    }
    if (Object.keys(this.index.keys).length) this.touchIndex();
  }

  touchIndex() {
    this.indexRev++;
    if (this.indexQueued || this.closed) return;
    this.indexQueued = true;
    this.indexSaving = this.indexSaving
      .then(async () => {
        this.indexQueued = false;
        if (this.closed) return;
        const rev = this.indexRev;
        await this.writeAtomic(path.join(this.dir, 'index.json'), JSON.stringify(this.index));
        this.indexSavedRev = Math.max(this.indexSavedRev, rev);
      })
      .catch((err) => this.log.warn('[setup-history] index save failed:', err && err.message));
  }

  /**
   * Write to a temp file, then rename over the real one — a crash or a full
   * disk mid-write leaves the previous version intact rather than half a JSON
   * document. The rename is retried briefly: on Windows an antivirus or
   * indexer holding the target open makes it fail with EPERM for a moment.
   */
  async writeAtomic(file, text) {
    await this.fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${(this.seq++).toString(36)}.tmp`;
    await this.fsp.writeFile(tmp, text, 'utf8');
    for (let attempt = 0; ; attempt++) {
      try {
        await this.fsp.rename(tmp, file);
        return;
      } catch (err) {
        if (attempt >= 2) {
          try {
            await this.fsp.unlink(tmp);
          } catch {
            /* leave it; it is ignored on read */
          }
          throw err;
        }
        await new Promise((r) => setTimeout(r, 60));
      }
    }
  }
}

function metaOf(m) {
  return {
    car: (m && m.car) || '',
    trackFolder: (m && m.trackFolder) || '',
    trackName: (m && m.trackName) || '',
    carClass: (m && m.carClass) || '',
  };
}

function serialise(store) {
  return JSON.stringify({ v: 1, ...metaOf(store.meta), entries: store.entries });
}

function writeAtomicSync(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.quit.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = { SetupHistory, QUIET_MS, WRITE_GUARD_MS };
