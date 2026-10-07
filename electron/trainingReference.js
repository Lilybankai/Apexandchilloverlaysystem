/**
 * trainingReference.js — which lap Ghost HUD chases in Training: your own
 * best, or a lap off the league board.
 * -----------------------------------------------------------------------------
 * The server's ghost selector already chases the driver's fastest clean local
 * lap for the combo being driven. This module lets the Training tab point it
 * at a league board lap instead, and does the main-process half of that: work
 * out the combo from the feed, read the board, pick the lap, fetch its trace
 * (through {@link TraceCache}), and hand it to the server with
 * `setGhostReference(trace, meta)`. The server only uses it while the combo
 * being driven is the one it was fetched for.
 *
 * ## The choice
 * Per `trackKey|CLASS`, persisted in settings (`trainingRefs`):
 *
 *   - **auto** (the default, stored as nothing) — the fastest board lap with a
 *     driven line in your class here. If that lap is YOURS, or there is none,
 *     your own best: chasing a slower lap teaches nothing, and your local best
 *     is at least as good as your board one.
 *   - **own** — your own best, always.
 *   - **pinned** — one driver's board lap. Their CURRENT time: if they go
 *     quicker the trace follows. If their row is gone or has no line, your own
 *     best, and the status says why — never a different driver behind your back.
 *
 * Board traces exist for the DRY board only (`lap_traces` has no surface in
 * its key), so on a damp or wet surface this is always your own best.
 *
 * ## What it costs
 * Nothing at all while the ghost is not wanted, and nothing while signed out
 * beyond one boolean per feed tick: signed out IS the own-best fallback. While
 * wanted, a feed tick is a string compare; the board is re-read every
 * {@link BOARD_TTL_MS} (so a new board time is noticed, and a new time is a new
 * cache key), and a trace is fetched once per board time, ever. Failures back
 * off and are never remembered past the backoff — see trainingRefCache.js.
 *
 * Everything here is async and generation-checked: an answer that arrives
 * after the combo, the choice or the sign-in changed is dropped.
 */

'use strict';

const path = require('node:path');
const { TraceCache, Backoff, cacheKey } = require('./trainingRefCache');

/** How long a board read is trusted before it is read again (while wanted). */
const BOARD_TTL_MS = 5 * 60_000;
/** Most combos remembered in settings. Oldest-inserted go first. */
const MAX_CHOICES = 200;

/* ------------------------------ pure helpers ------------------------------ */

/**
 * The combo being driven, from a parsed feed frame, or `null` when there is
 * nothing to choose for (demo feed, another sim, spectating, no class or no
 * track length yet). Built from the same functions the provider keys its
 * ghost with (`trackKeyOf`, `normalizeClass`, `conditionOf`), handed in as
 * `helpers` so this file does not load the telemetry build itself.
 */
function comboFromFrame(frame, helpers) {
  if (!frame || frame.connected === false || frame.source !== 'lmu') return null;
  const s = frame.session;
  const len = Number(s && s.trackLengthM);
  if (!s || !Number.isFinite(len) || len <= 1) return null;
  // The car being DRIVEN here (LMU's player flag), not the one on camera.
  const own = Array.isArray(frame.standings)
    ? frame.standings.find((r) => r && r.isOwn === true)
    : null;
  const carClass = helpers.normalizeClass(own && own.carClass);
  if (!carClass) return null;
  const track = typeof s.track === 'string' ? s.track : '';
  return {
    sim: 'lmu',
    track,
    trackLengthM: len,
    trackKey: helpers.trackKeyOf(track, len),
    carClass,
    condition: helpers.conditionOf(frame.weather && frame.weather.trackWetness),
  };
}

/** The settings key a choice is stored under. */
function choiceKey(combo) {
  return combo ? `${combo.trackKey}|${combo.carClass}` : '';
}

/** Everything that changes the answer, condition included; '' for no combo. */
function fullKeyOf(combo) {
  return combo ? `${combo.sim}|${combo.trackKey}|${combo.carClass}|${combo.condition}` : '';
}

/** One stored choice, checked: 'auto' | 'own' | { driverId, trackId }. */
function normalizeChoice(v) {
  if (v === 'own' || v === 'auto') return v;
  if (v && typeof v === 'object') {
    const driverId = typeof v.driverId === 'string' ? v.driverId : '';
    const trackId = typeof v.trackId === 'string' ? v.trackId : '';
    if (/^[A-Za-z0-9-]{1,64}$/.test(driverId) && /^[A-Za-z0-9-]{1,64}$/.test(trackId)) {
      return { driverId, trackId };
    }
  }
  return 'auto';
}

/**
 * `settings.trainingRefs` from disk: `{ "trackKey|CLASS": 'own' | {driverId, trackId} }`.
 * 'auto' is the default and is never stored, which keeps the map to the
 * combos where the driver actually changed something.
 */
function normalizeTrainingRefs(stored) {
  const out = {};
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
  const entries = Object.entries(stored).slice(-MAX_CHOICES);
  for (const [k, v] of entries) {
    if (typeof k !== 'string' || !k.includes('|') || k.length > 160) continue;
    const c = normalizeChoice(v);
    if (c !== 'auto') out[k] = c;
  }
  return out;
}

/**
 * Pick the reference for a choice from a board's rows.
 *
 * @returns `{ kind: 'board', row }` or `{ kind: 'own', reason }`, where reason
 *   is `chosen` | `no-board-line` | `you-lead` | `pinned-unavailable`.
 */
function chooseReference(choice, rows) {
  if (choice === 'own') return { kind: 'own', reason: 'chosen' };
  const lined = (Array.isArray(rows) ? rows : []).filter(
    (r) => r && r.has_line === true && Number.isInteger(r.lap_ms) && r.lap_ms > 0 && r.driver_id && r.track_id,
  );
  if (choice && typeof choice === 'object') {
    const row = lined.find((r) => r.driver_id === choice.driverId);
    return row ? { kind: 'board', row } : { kind: 'own', reason: 'pinned-unavailable' };
  }
  if (!lined.length) return { kind: 'own', reason: 'no-board-line' };
  const best = lined.reduce((a, b) => (b.lap_ms < a.lap_ms ? b : a));
  return best.is_you === true ? { kind: 'own', reason: 'you-lead' } : { kind: 'board', row: best };
}

/** "John Smith" → "J. Smith"; a single name stays as it is. */
function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Driver';
  if (parts.length === 1) return parts[0];
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}

/** The ghost's overlay label: `"J. Smith · 1:47.831 · board"`. */
function refLabel(row, formatLapTime) {
  return `${shortName(row.display_name)} · ${formatLapTime(row.lap_ms / 1000)} · board`;
}

/** `board:<driverId>:<lapMs>` — unique per board time, so the widget refetches. */
function refIdOf(row) {
  return `board:${row.driver_id}:${row.lap_ms}`;
}

/**
 * Whether a `get_lap_trace` answer is the lap this row describes. The board
 * row and the trace are two reads; a driver who set a new time between them
 * gives a trace for a time the row does not have.
 */
function traceMatchesRow(payload, row) {
  if (!payload || payload.found !== true) return false;
  const data = payload.data;
  if (!data || typeof data !== 'object' || !Array.isArray(data.d) || !Array.isArray(data.t)) return false;
  if (data.d.length < 2 || data.d.length !== data.t.length) return false;
  return Number(payload.lapMs) === row.lap_ms && (!payload.driverId || payload.driverId === row.driver_id);
}

/* ------------------------------- controller ------------------------------- */

class TrainingReference {
  /**
   * @param {object} deps
   * @param {(fn: string, body: object) => Promise<object>} deps.rpc   authService.rpc
   * @param {() => boolean} deps.isSignedIn
   * @param {import('./trainingRefCache').TraceCache} deps.cache
   * @param {import('./trainingRefCache').Backoff} deps.backoff
   * @param {(trace: object|null, meta?: object) => boolean} deps.deliver
   *        hands the reference to the server; false = no server yet, try again
   * @param {() => object} deps.loadChoices   the persisted `trainingRefs` map
   * @param {(map: object) => void} deps.saveChoices
   * @param {() => object} deps.helpers       { trackKeyOf, conditionOf, normalizeClass, formatLapTime }
   * @param {() => object|null} [deps.getFrame] newest feed frame, for the tab while not wanted
   * @param {(status: object) => void} [deps.onChange]
   * @param {() => number} [deps.now]
   */
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now || Date.now;
    this.wanted = false;
    this.combo = null;
    this.comboFullKey = '';
    this.signedIn = false;
    this.choices = null;
    /** choiceKey → { rows, at } — successful board reads only. */
    this.boards = new Map();
    this.boardInflight = new Map();
    this.gen = 0;
    this.running = null;
    this.dirty = false;
    /** When the next tick should look again: a retry, or the board going stale. */
    this.nextAt = 0;
    /** What the server holds: `{ refId, trace, meta }` or null, and whether it took it. */
    this.delivery = null;
    this.deliveredOk = true;
    this.status = { state: 'off' };
    this.frameMemo = { track: null, len: 0, trackKey: '' };
  }

  /** Whether Ghost HUD (or Training) wants a reference at all. */
  setWanted(on) {
    on = on === true;
    if (on === this.wanted) {
      this.redeliver();
      return;
    }
    this.wanted = on;
    this.signedIn = this.deps.isSignedIn() === true;
    // The combo is only kept up to date while wanted, so whatever is held is
    // from the last time training was on — another track, another car. Start
    // from the newest frame instead; noteFrame takes over from here. Off, it
    // is dropped, so nothing stale is left to start from next time.
    this.combo = on ? this.comboOf(this.deps.getFrame ? this.deps.getFrame() : null) : null;
    this.comboFullKey = fullKeyOf(this.combo);
    this.bump();
  }

  /**
   * A parsed feed frame. Called at the status socket's ~4 Hz; while wanted it
   * is a string compare unless something is due.
   */
  noteFrame(frame) {
    if (!this.wanted) return;
    const combo = this.comboOf(frame);
    const full = fullKeyOf(combo);
    const signedIn = this.deps.isSignedIn() === true;
    if (full !== this.comboFullKey || signedIn !== this.signedIn) {
      this.combo = combo;
      this.comboFullKey = full;
      this.signedIn = signedIn;
      this.bump();
      return;
    }
    this.redeliver();
    if (this.nextAt && this.now() >= this.nextAt) {
      this.nextAt = 0;
      this.kick();
    }
  }

  /** The current state, for the panel. */
  getStatus() {
    return { ...this.status };
  }

  /** The stored choice for the current combo: 'auto' | 'own' | { driverId, trackId }. */
  choiceFor(combo) {
    const map = this.loadChoices();
    return normalizeChoice(map[choiceKey(combo)]);
  }

  /**
   * What `training:refOptions` answers: the board for the current combo (read
   * if it has not been, even while not wanted — the tab asked), the choice,
   * and the status.
   */
  async options() {
    const combo = this.currentCombo();
    const base = { ok: true, status: this.getStatus() };
    if (!combo) return { ...base, combo: null, choice: 'auto', rows: [] };
    const choice = this.choiceFor(combo);
    const head = {
      ...base,
      combo: { track: combo.track, trackKey: combo.trackKey, carClass: combo.carClass, condition: combo.condition },
      choice,
    };
    if (!this.deps.isSignedIn()) return { ...head, signedOut: true, rows: [] };
    if (combo.condition !== 'dry') return { ...head, rows: [] };
    const board = await this.boardFor(combo, this.now());
    const fmt = this.deps.helpers().formatLapTime;
    const pick = chooseReference(choice, board.rows);
    const selected = pick.kind === 'board' ? pick.row.driver_id : null;
    return {
      ...head,
      // The status as it is now, not as it was before the board was read.
      status: this.getStatus(),
      ...(board.signedOut ? { signedOut: true } : {}),
      ...(board.error ? { error: board.error } : {}),
      selected,
      rows: (board.rows || []).map((r) => ({
        driverId: r.driver_id,
        trackId: r.track_id,
        name: r.display_name || 'Driver',
        lapMs: r.lap_ms,
        time: Number.isInteger(r.lap_ms) && r.lap_ms > 0 ? fmt(r.lap_ms / 1000) : '',
        car: r.car || '',
        rank: r.rank,
        hasLine: r.has_line === true,
        isYou: r.is_you === true,
      })),
    };
  }

  /**
   * `training:setRef` — 'auto', 'own' or `{ driverId, trackId }` for the
   * current combo (or the one named by `trackKey`/`carClass`). Persisted, then
   * the reference is re-resolved.
   */
  setChoice(req) {
    const combo = req && typeof req.trackKey === 'string' && typeof req.carClass === 'string'
      ? { trackKey: req.trackKey, carClass: req.carClass }
      : this.currentCombo();
    const key = choiceKey(combo);
    if (!key) return { ok: false, error: 'Not on a circuit.' };
    const choice = normalizeChoice(req && req.choice);
    const map = { ...this.loadChoices() };
    delete map[key];
    if (choice !== 'auto') map[key] = choice;
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_CHOICES))) delete map[k];
    this.choices = map;
    try {
      this.deps.saveChoices(map);
    } catch {
      /* kept in memory for this run either way */
    }
    this.bump();
    return { ok: true, choice };
  }

  /** Resolves when the current resolution has settled. For the tests. */
  settled() {
    return this.running || Promise.resolve();
  }

  /* ------------------------------ internals ------------------------------ */

  /**
   * The combo being driven. While wanted, the one {@link noteFrame} keeps;
   * otherwise worked out on demand from the newest frame, so the tab can show
   * the board without this module doing anything per frame.
   */
  currentCombo() {
    if (this.wanted) return this.combo;
    return this.comboOf(this.deps.getFrame ? this.deps.getFrame() : null);
  }

  loadChoices() {
    if (!this.choices) {
      try {
        this.choices = normalizeTrainingRefs(this.deps.loadChoices());
      } catch {
        this.choices = {};
      }
    }
    return this.choices;
  }

  comboOf(frame) {
    const helpers = this.deps.helpers();
    // trackKeyOf slugs the name on every call; the name changes once a session.
    const s = frame && frame.session;
    const memo = this.frameMemo;
    if (s && s.track === memo.track && Number(s.trackLengthM) === memo.len) {
      return comboFromFrame(frame, { ...helpers, trackKeyOf: () => memo.trackKey });
    }
    const combo = comboFromFrame(frame, helpers);
    if (combo) this.frameMemo = { track: s.track, len: Number(s.trackLengthM), trackKey: combo.trackKey };
    return combo;
  }

  /** Something that could change the answer changed: drop in-flight answers, look again. */
  bump() {
    this.gen += 1;
    this.nextAt = 0;
    this.kick();
  }

  kick() {
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = (async () => {
      do {
        this.dirty = false;
        try {
          await this.resolveOnce();
        } catch {
          // Last resort — every call above already turns its failures into
          // answers. Chase the own best and look again in a minute.
          this.nextAt = this.now() + 60_000;
          this.settle(this.gen, null, { state: 'own', reason: 'trace-unavailable' });
        }
      } while (this.dirty);
    })().finally(() => {
      this.running = null;
    });
  }

  async resolveOnce() {
    const gen = this.gen;
    const combo = this.combo;
    if (!this.wanted) return this.settle(gen, null, { state: 'off' });
    if (!combo) return this.settle(gen, null, { state: 'no-combo' });
    if (!this.signedIn) return this.settle(gen, null, { state: 'signed-out' });
    if (combo.condition !== 'dry') return this.settle(gen, null, { state: 'not-dry' });

    const choice = this.choiceFor(combo);
    if (choice === 'own') return this.settle(gen, null, { state: 'own', reason: 'chosen' });

    const now = this.now();
    const board = await this.boardFor(combo, now);
    if (gen !== this.gen) return;
    if (board.signedOut) return this.settle(gen, null, { state: 'signed-out' });
    if (!board.rows) {
      this.nextAt = board.retryAt || now + BOARD_TTL_MS;
      return this.settle(gen, null, { state: 'own', reason: 'board-unavailable', retryAt: this.nextAt });
    }
    // Look at the board again when it goes stale: that is how a new board
    // time (a new cache key) is noticed. A failed refresh serving the last
    // good rows waits for its backoff instead.
    this.nextAt = Math.max(board.at + BOARD_TTL_MS, board.retryAt || 0);

    const pick = chooseReference(choice, board.rows);
    if (pick.kind === 'own') return this.settle(gen, null, { state: 'own', reason: pick.reason });
    const row = pick.row;
    const key = cacheKey(row.track_id, combo.carClass, row.driver_id, row.lap_ms);
    const refId = refIdOf(row);
    const label = refLabel(row, this.deps.helpers().formatLapTime);
    const boardStatus = { state: 'board', label, refId, driverId: row.driver_id, lapMs: row.lap_ms };
    if (!key) return this.settle(gen, null, { state: 'own', reason: 'trace-unavailable' });
    if (this.delivery && this.delivery.refId === refId && this.delivery.combo === this.comboFullKey) {
      return this.settle(gen, this.delivery, boardStatus);
    }
    if (!this.deps.backoff.ready(key, now)) {
      const retryAt = this.deps.backoff.retryAt(key);
      this.nextAt = Math.min(this.nextAt, retryAt);
      return this.settle(gen, null, { state: 'own', reason: 'trace-unavailable', retryAt });
    }

    this.setStatus(gen, { state: 'loading', label });
    let payload = await this.deps.cache.get(key);
    if (gen !== this.gen) return;
    if (!payload) {
      const res = await this.rpc('get_lap_trace', {
        p_driver_id: row.driver_id,
        p_track_id: row.track_id,
        p_car_class: combo.carClass,
      });
      if (gen !== this.gen) return;
      if (!res || !res.ok) {
        if (res && res.signedOut) return this.settle(gen, null, { state: 'signed-out' });
        const retryAt = this.deps.backoff.fail(key, this.now());
        this.nextAt = Math.min(this.nextAt, retryAt);
        return this.settle(gen, null, { state: 'own', reason: 'trace-unavailable', retryAt });
      }
      if (!traceMatchesRow(res.body, row)) {
        // Most likely a new board time landed between the two reads. Back
        // off this key, and read the board again when the backoff allows.
        const retryAt = this.deps.backoff.fail(key, this.now());
        this.boards.delete(choiceKey(combo));
        this.nextAt = Math.min(this.nextAt, retryAt);
        return this.settle(gen, null, { state: 'own', reason: 'trace-unavailable', retryAt });
      }
      payload = {
        driverId: row.driver_id,
        trackId: row.track_id,
        carClass: combo.carClass,
        car: typeof res.body.car === 'string' ? res.body.car : '',
        lapMs: row.lap_ms,
        setAt: typeof res.body.setAt === 'string' ? res.body.setAt : '',
        data: res.body.data,
      };
      this.deps.cache.put(key, payload);
    }
    this.deps.backoff.clear(key);
    const meta = {
      sim: combo.sim,
      trackKey: combo.trackKey,
      carClass: combo.carClass,
      condition: combo.condition,
      refId,
      label,
      lapMs: row.lap_ms,
    };
    return this.settle(gen, { refId, combo: this.comboFullKey, trace: payload.data, meta }, boardStatus);
  }

  /**
   * The board for a combo: cached for {@link BOARD_TTL_MS}, one read in flight
   * per combo, failures backed off and never stored. A failed refresh keeps
   * serving the last good rows.
   *
   * @returns `{ rows, at }`, or `{ rows: null|staleRows, error, signedOut?, retryAt? }`
   */
  async boardFor(combo, now) {
    const key = choiceKey(combo);
    const hit = this.boards.get(key);
    if (hit && now - hit.at < BOARD_TTL_MS) return hit;
    const bkey = `board|${key}`;
    if (!this.deps.backoff.ready(bkey, now)) {
      const retryAt = this.deps.backoff.retryAt(bkey);
      return hit ? { ...hit, retryAt } : { rows: null, error: 'Board unavailable.', retryAt };
    }
    let inflight = this.boardInflight.get(key);
    if (!inflight) {
      // The same call, with the same arguments, as Review's `review:board`.
      inflight = this.rpc('board_for_lap', {
        p_sim: combo.sim,
        p_track_key: combo.trackKey,
        p_car_class: combo.carClass,
        p_limit: 200,
        p_condition: 'dry',
      }).finally(() => this.boardInflight.delete(key));
      this.boardInflight.set(key, inflight);
    }
    const res = await inflight;
    if (res && res.ok) {
      this.deps.backoff.clear(bkey);
      const fresh = { rows: Array.isArray(res.body) ? res.body : [], at: this.now() };
      this.boards.set(key, fresh);
      if (this.boards.size > 16) this.boards.delete(this.boards.keys().next().value);
      return fresh;
    }
    if (res && res.signedOut) return { rows: null, signedOut: true, error: 'Sign in to chase a board lap.' };
    const retryAt = this.deps.backoff.fail(bkey, this.now());
    const error = (res && res.error) || 'Board unavailable.';
    return hit ? { ...hit, error, retryAt } : { rows: null, error, retryAt };
  }

  /** The league call, with a rejection turned into an ordinary failure (which backs off). */
  async rpc(fn, body) {
    try {
      return await this.deps.rpc(fn, body);
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  /** Record the answer for generation `gen` and make sure the server has it. */
  settle(gen, delivery, status) {
    if (gen !== this.gen) return;
    const before = this.delivery ? this.delivery.refId : null;
    const after = delivery ? delivery.refId : null;
    this.delivery = delivery;
    if (before !== after || !this.deliveredOk) this.push();
    this.setStatus(gen, status);
  }

  /** Re-send a delivery the server was not there to take. */
  redeliver() {
    if (!this.deliveredOk) this.push();
  }

  push() {
    const d = this.delivery;
    let ok = false;
    try {
      ok = d ? this.deps.deliver(d.trace, d.meta) === true : this.deps.deliver(null) === true;
    } catch {
      ok = false;
    }
    this.deliveredOk = ok;
  }

  setStatus(gen, status) {
    if (gen !== this.gen) return;
    const next = { ...status, choice: this.combo ? this.choiceFor(this.combo) : 'auto' };
    const same = JSON.stringify(next) === JSON.stringify(this.status);
    this.status = next;
    if (!same && this.deps.onChange) {
      try {
        this.deps.onChange(this.getStatus());
      } catch {
        /* the panel being away is not this module's problem */
      }
    }
  }
}

/* --------------------------------- wiring --------------------------------- */

/**
 * Build the app's one controller. Everything main.js would otherwise have to
 * spell out lives here, so main only wires: the settings it persists into, the
 * server it delivers to, the frame it reads, and the window it tells.
 *
 * @param {object} o
 * @param {string} o.userData                  app.getPath('userData')
 * @param {{ rpc: Function, stateForUi: Function }} o.auth
 * @param {() => object|null} o.getServer      the loaded server module, or null
 * @param {() => object|null} o.getFrame       newest parsed feed frame
 * @param {() => object} o.loadChoices         settings.trainingRefs
 * @param {(map: object) => void} o.saveChoices
 * @param {(status: object) => void} [o.onChange]
 */
function create(o) {
  const dist = path.join(__dirname, '..', 'dist', 'telemetry');
  let helpers = null;
  // Loaded on first use, which is only ever while wanted or asked: by then the
  // server has loaded every one of these, so this is a module-cache lookup.
  const getHelpers = () =>
    (helpers ??= {
      trackKeyOf: require(path.join(dist, 'paceDelta.js')).trackKeyOf,
      conditionOf: require(path.join(dist, 'lapLog.js')).conditionOf,
      normalizeClass: require(path.join(dist, 'carClass.js')).normalizeClass,
      formatLapTime: require(path.join(dist, 'raceLog.js')).formatLapTime,
    });
  let warned = '';
  return new TrainingReference({
    rpc: (fn, body) => o.auth.rpc(fn, body),
    isSignedIn: () => !!o.auth.stateForUi().signedIn,
    cache: new TraceCache({ dir: path.join(o.userData, 'training-refs') }),
    backoff: new Backoff(),
    // `false` only when there is no server to take it yet — the next feed tick
    // tries again. A reference the server refuses is logged and left: the
    // server is then chasing the own best, which is the fallback anyway.
    deliver: (trace, meta) => {
      const server = o.getServer();
      if (!server || typeof server.setGhostReference !== 'function') return false;
      const accepted = server.setGhostReference(trace, meta);
      if (!accepted && meta && warned !== meta.refId) {
        warned = meta.refId;
        console.warn(`[training] board lap ${meta.refId} refused by the server`);
      }
      return true;
    },
    loadChoices: o.loadChoices,
    saveChoices: o.saveChoices,
    helpers: getHelpers,
    getFrame: o.getFrame,
    onChange: o.onChange,
  });
}

module.exports = {
  create,
  TrainingReference,
  comboFromFrame,
  choiceKey,
  normalizeChoice,
  normalizeTrainingRefs,
  chooseReference,
  shortName,
  refLabel,
  refIdOf,
  traceMatchesRow,
  BOARD_TTL_MS,
};
