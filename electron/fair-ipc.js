/**
 * fair-ipc.js — fair comparison laps for the coach: which board laps a
 * practice session can be measured against, and how fair each one is.
 * -----------------------------------------------------------------------------
 * 2026-10-29 (AI driving coach, "fair" piece). The rules live in
 * `src/telemetry/fairTarget.ts` (pure); this file is the main-process half:
 * read the driver's own lap off the lap log (`fairTargetLoad.ts`), read the
 * league board, shape each row as a `TargetLapInfo`, and fetch a board lap's
 * trace when a session is to be measured against it.
 *
 *   register(ipcMain, deps) → FairService
 *
 *   `practice:targets` ({ sessionId }) →
 *     { ok, mine, candidates: [{ lap, assessment, label }], pick, leaderGap, signedOut?, error? }
 *       mine        the session's best valid lap with its conditions (null: none)
 *       candidates  every row of the board for the session's circuit (layout,
 *                   via its trackKey), class and surface, fairest first
 *       pick        the lapId `pickFairTarget` chose, or null
 *       leaderGap   my best vs the top of the board: { sec, label, flags }
 *     Offline or signed out: `ok:false` with `mine` still filled (it is local)
 *     and no candidates. Never throws.
 *
 *   `review:fairChips` ({ sessionId, rows }) → { ok, chips: { [driverId]: FairnessFlag[] }, pick }
 *     The same assessment for rows the Review tab already holds (its board
 *     card, `review:board`), so the board picker shows the same chips without
 *     a second board read. `pick` is the driverId of the fair pick, or null.
 *
 *   service.boardTarget(sessionId, targetLapId) → { ok, target, error? }
 *     A board lap as a PracticeTargetSnapshot (`practiceReviewLoad.boardTargetSnapshot`),
 *     for `review:practice` / `practice:lap` with `opts.targetLapId`. Async:
 *     the trace may come from the league.
 *
 * ## Board lap ids
 * `board:<driverId>:<lapMs>` — the same id the Training reference gives a
 * board lap (`trainingReference.refIdOf`), so a session that CHASED a board
 * lap and one measured against it afterwards name it alike. A driver who has
 * since gone quicker has a new id; asking for the old one gets their current
 * board lap (the old trace is gone from the league — one per driver).
 *
 * ## Caching
 * The board: per `trackKey|CLASS|surface` for {@link BOARD_TTL_MS}, one read
 * in flight per key, failures backed off and never stored (a failed refresh
 * serves the last good rows) — the Training reference's rules. Traces: the
 * Training reference's own on-disk {@link TraceCache}, in the SAME folder
 * (`<userData>/training-refs`), so a lap chased on track is not downloaded
 * again to be studied. Two TraceCache instances on one folder are safe: every
 * read checks the file's own key, and a file the other instance dropped reads
 * as a miss.
 *
 * ## Which board
 * `board_for_lap` for the session's own surface (dry unless its best lap was
 * damp or wet). Traces exist for the DRY board only (`lap_traces` has no
 * surface), so a damp/wet session gets candidates with `hasTrace: false`,
 * never a pick, but still a leader gap.
 */

'use strict';

const path = require('node:path');
const { TraceCache, Backoff, cacheKey } = require('./trainingRefCache');
const { shortName, traceMatchesRow } = require('./trainingReference');
const boardConditions = require('./control-panel/board-conditions');

/** How long a board read is trusted. */
const BOARD_TTL_MS = 5 * 60_000;
/** Boards remembered. */
const MAX_BOARDS = 16;
/** Rows assessed per call — the board RPCs are asked for 200. */
const MAX_ROWS = 300;

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/* ------------------------------ pure helpers ------------------------------ */

/** `board:<driverId>:<lapMs>`, or '' when the row cannot be named. */
function boardLapId(row) {
  if (!row || typeof row.driver_id !== 'string' || !ID_RE.test(row.driver_id)) return '';
  if (!Number.isInteger(row.lap_ms) || row.lap_ms <= 0) return '';
  return `board:${row.driver_id}:${row.lap_ms}`;
}

/** `{ driverId, lapMs }` from a board lap id, or null. */
function parseBoardLapId(id) {
  const m = typeof id === 'string' ? /^board:([A-Za-z0-9-]{1,64}):(\d{1,9})$/.exec(id) : null;
  return m ? { driverId: m[1], lapMs: Number(m[2]) } : null;
}

function fmtLapFallback(sec) {
  if (!(sec > 0)) return '—';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

/** "J. Smith · 1:47.831"; "You · …" for the driver's own row. */
function candidateLabel(row, formatLapTime) {
  const fmt = typeof formatLapTime === 'function' ? formatLapTime : fmtLapFallback;
  const who = row && row.is_you === true ? 'You' : shortName(row && row.display_name);
  return `${who} · ${fmt((row && row.lap_ms) / 1000)}`;
}

/**
 * A board row as a `TargetLapInfo`. The conditions go through
 * board-conditions.js's `conditionsOf`, so a value the Leaderboard's tooltip
 * would refuse as implausible is "not recorded" here too.
 *
 * @param {object} row  a `leaderboard()` / `board_for_lap()` row
 * @param {{ carClass: string, trackKey: string, condition?: string }} ctx
 */
function targetFromBoardRow(row, ctx) {
  const c = boardConditions.conditionsOf(row) || {};
  const condition = typeof row.condition === 'string' && row.condition ? row.condition : ctx.condition || 'dry';
  return {
    lapId: boardLapId(row),
    driver: row.is_you === true ? 'You' : String(row.display_name || 'Driver'),
    car: typeof row.car === 'string' ? row.car : '',
    // The board was read FOR this class: every row on it is in it.
    carClass: ctx.carClass,
    lapSec: row.lap_ms / 1000,
    sessionType: c.session || null,
    trackTempC: c.trackTempC ?? null,
    airTempC: c.airTempC ?? null,
    fuelStartL: c.fuelStartL ?? null,
    fuelCapacityL: c.capacityL ?? null,
    vePct: c.veStartPct ?? null,
    compound: c.compound || null,
    condition,
    hasLine: row.has_line === true,
    hasTrace: row.has_trace === true,
    // Only clean laps reach a board (lapLog.buildUploadPlan, submit_lap).
    clean: true,
    trackKey: ctx.trackKey,
  };
}

/** Rows worth assessing: a driver, a positive whole-ms time. Capped. */
function usableRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && boardLapId(r)).slice(0, MAX_ROWS);
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

/**
 * My best against the top of the board: `{ sec, label, flags }`, positive sec
 * = behind. "+0.65 s vs top LMP2". null without a lap or a board.
 */
function leaderGapOf(fair, mine, laps, carClass) {
  if (!mine || !(mine.lapSec > 0) || !laps.length) return null;
  const top = laps.reduce((a, b) => (b.lapSec < a.lapSec ? b : a));
  const sec = round3(mine.lapSec - top.lapSec);
  const sign = sec > 0 ? '+' : sec < 0 ? '−' : '±';
  return {
    sec,
    label: `${sign}${Math.abs(sec).toFixed(2)} s vs top ${carClass || 'of the class'}`,
    flags: fair.assessTarget(mine, top).flags,
    lapId: top.lapId,
  };
}

/* -------------------------------- service -------------------------------- */

class FairService {
  /**
   * @param {object} deps
   * @param {(fn: string, body: object) => Promise<object>} deps.rpc   authService.rpc
   * @param {() => object} deps.fair          dist/telemetry/fairTarget.js
   * @param {() => object} deps.load          dist/telemetry/fairTargetLoad.js
   * @param {() => object} deps.practiceLoad  dist/telemetry/practiceReviewLoad.js
   * @param {(sec: number) => string} [deps.formatLapTime]
   * @param {TraceCache} deps.cache
   * @param {Backoff} deps.backoff
   * @param {string} [deps.lapDir]            lap log folder (tests)
   * @param {() => number} [deps.now]
   */
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now || Date.now;
    /** key → { rows, at } — successful reads only. */
    this.boards = new Map();
    this.inflight = new Map();
  }

  async rpc(fn, body) {
    try {
      return await this.deps.rpc(fn, body);
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  /** The session and my lap, or null. Never throws. */
  session(sessionId) {
    try {
      return this.deps.load().loadFairSession(sessionId, this.deps.lapDir);
    } catch (err) {
      console.error('[fair] session unreadable:', err.message);
      return null;
    }
  }

  /**
   * The board for a circuit, class and surface: `{ rows }` or
   * `{ rows: null, signedOut?, error }`. Cached; see the header.
   */
  async board(trackKey, carClass, condition) {
    const key = `${trackKey}|${String(carClass).toUpperCase()}|${condition}`;
    const now = this.now();
    const hit = this.boards.get(key);
    if (hit && now - hit.at < BOARD_TTL_MS) return hit;
    const bkey = `board|${key}`;
    if (!this.deps.backoff.ready(bkey, now)) {
      return hit || { rows: null, error: 'Board unavailable.' };
    }
    let p = this.inflight.get(key);
    if (!p) {
      // The same call, with the same arguments, as Review's `review:board`.
      p = this.rpc('board_for_lap', {
        p_sim: 'lmu',
        p_track_key: trackKey,
        p_car_class: carClass,
        p_limit: 200,
        p_condition: condition,
      }).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    const res = await p;
    if (res && res.ok) {
      this.deps.backoff.clear(bkey);
      const fresh = { rows: Array.isArray(res.body) ? res.body : [], at: this.now() };
      this.boards.set(key, fresh);
      if (this.boards.size > MAX_BOARDS) this.boards.delete(this.boards.keys().next().value);
      return fresh;
    }
    if (res && res.signedOut) return { rows: null, signedOut: true, error: 'Sign in to compare with the leaderboard.' };
    this.deps.backoff.fail(bkey, this.now());
    return hit || { rows: null, error: (res && res.error) || 'Board unavailable.' };
  }

  /** `practice:targets`. */
  async targets(sessionId) {
    const empty = { ok: false, mine: null, candidates: [], pick: null, leaderGap: null };
    if (typeof sessionId !== 'string' || !sessionId) return { ...empty, error: 'no session' };
    const info = this.session(sessionId);
    if (!info) return { ...empty, error: 'session not found' };
    const { session, mine } = info;
    if (!session.trackKey || !session.carClass) return { ...empty, mine, error: 'no circuit or class' };

    const condition = mine && mine.condition ? mine.condition : 'dry';
    const board = await this.board(session.trackKey, session.carClass, condition);
    if (!board.rows) {
      return { ...empty, mine, signedOut: !!board.signedOut, error: board.error || 'Board unavailable.' };
    }
    const fair = this.deps.fair();
    const ctx = { carClass: session.carClass, trackKey: session.trackKey, condition };
    const rows = usableRows(board.rows);
    const laps = rows.map((r) => targetFromBoardRow(r, ctx));
    const labels = new Map(rows.map((r, i) => [laps[i].lapId, candidateLabel(r, this.deps.formatLapTime)]));
    if (!mine) {
      // Nothing of mine to be fair TO: list the board, assess nothing.
      return {
        ok: true,
        mine: null,
        candidates: laps.map((lap) => ({ lap, assessment: { flags: [], fuelSec: null, score: 0 }, label: labels.get(lap.lapId) })),
        pick: null,
        leaderGap: null,
      };
    }
    const { pick, ranked } = fair.pickFairTarget(mine, laps);
    return {
      ok: true,
      mine,
      candidates: ranked.map(({ lap, assessment }) => ({ lap, assessment, label: labels.get(lap.lapId) })),
      pick: pick ? pick.lapId : null,
      leaderGap: leaderGapOf(fair, mine, laps, session.carClass),
    };
  }

  /** `review:fairChips`: the assessment for rows the Review tab already holds. */
  chips(sessionId, rows) {
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, chips: {}, pick: null, error: 'no session' };
    const info = this.session(sessionId);
    if (!info || !info.mine) return { ok: false, chips: {}, pick: null, error: info ? 'no valid lap' : 'session not found' };
    const { session, mine } = info;
    const fair = this.deps.fair();
    const ctx = { carClass: session.carClass, trackKey: session.trackKey, condition: 'dry' };
    const list = usableRows(rows);
    const laps = list.map((r) => targetFromBoardRow(r, ctx));
    const { pick, ranked } = fair.pickFairTarget(mine, laps);
    const chips = {};
    for (const { lap, assessment } of ranked) {
      const driverId = parseBoardLapId(lap.lapId).driverId;
      chips[driverId] = assessment.flags;
    }
    return { ok: true, chips, pick: pick ? parseBoardLapId(pick.lapId).driverId : null };
  }

  /**
   * A board lap as a PracticeTargetSnapshot for `review:practice` /
   * `practice:lap`: `{ ok, target }` or `{ ok:false, target:null, error, signedOut? }`.
   */
  async boardTarget(sessionId, targetLapId) {
    const fail = (error, extra) => ({ ok: false, target: null, error, ...(extra || {}) });
    const want = parseBoardLapId(targetLapId);
    if (!want) return fail('unknown target');
    const info = this.session(sessionId);
    if (!info) return fail('session not found');
    const { session } = info;
    if (!session.trackKey || !session.carClass || !(session.trackLengthM > 0)) return fail('no circuit or class');

    // Traces live behind the DRY board only.
    const board = await this.board(session.trackKey, session.carClass, 'dry');
    if (!board.rows) return fail(board.error || 'Board unavailable.', board.signedOut ? { signedOut: true } : null);
    const row = board.rows.find((r) => r && r.driver_id === want.driverId);
    if (!row || !boardLapId(row)) return fail('not on the board');
    if (row.has_trace !== true) return fail('no telemetry for this lap');

    const key = cacheKey(row.track_id, session.carClass, row.driver_id, row.lap_ms);
    if (!key) return fail('no telemetry for this lap');
    let payload = await this.deps.cache.get(key);
    if (!payload) {
      const now = this.now();
      if (!this.deps.backoff.ready(key, now)) return fail('trace unavailable, retrying shortly');
      const res = await this.rpc('get_lap_trace', {
        p_driver_id: row.driver_id,
        p_track_id: row.track_id,
        p_car_class: session.carClass,
      });
      if (!res || !res.ok) {
        if (res && res.signedOut) return fail('Sign in to compare with the leaderboard.', { signedOut: true });
        this.deps.backoff.fail(key, this.now());
        return fail((res && res.error) || 'trace unavailable');
      }
      if (!traceMatchesRow(res.body, row)) {
        // A new board time landed between the two reads: read the board again next time.
        this.deps.backoff.fail(key, this.now());
        this.boards.delete(`${session.trackKey}|${String(session.carClass).toUpperCase()}|dry`);
        return fail('trace unavailable');
      }
      // The Training reference's payload shape, so either can use the other's file.
      payload = {
        driverId: row.driver_id,
        trackId: row.track_id,
        carClass: session.carClass,
        car: typeof res.body.car === 'string' ? res.body.car : '',
        lapMs: row.lap_ms,
        setAt: typeof res.body.setAt === 'string' ? res.body.setAt : '',
        data: res.body.data,
      };
      this.deps.cache.put(key, payload);
    }
    this.deps.backoff.clear(key);

    let target = null;
    try {
      target = this.deps.practiceLoad().boardTargetSnapshot(payload.data, {
        driverId: row.driver_id,
        lapMs: row.lap_ms,
        label: candidateLabel(row, this.deps.formatLapTime),
        trackKey: session.trackKey,
        trackLengthM: session.trackLengthM,
        carClass: session.carClass,
        sim: session.sim || 'lmu',
      });
    } catch (err) {
      console.error('[fair] board target unusable:', err.message);
    }
    return target ? { ok: true, target } : fail('trace unusable');
  }
}

/* --------------------------------- wiring --------------------------------- */

/**
 * Register `practice:targets` and `review:fairChips`, and hand back the service
 * so main's `review:practice` / `practice:lap` can resolve `opts.targetLapId`.
 *
 * @param {Electron.IpcMain} ipcMain
 * @param {object} deps
 * @param {{ rpc: Function }} deps.auth             authService
 * @param {string | (() => string)} deps.userData   app.getPath('userData')
 * @param {string} [deps.distDir]                   dist/telemetry (tests)
 */
function register(ipcMain, deps) {
  const dist = deps.distDir || path.join(__dirname, '..', 'dist', 'telemetry');
  const lazy = (name) => {
    let mod = null;
    return () => (mod ??= require(path.join(dist, name)));
  };
  const userData = typeof deps.userData === 'function' ? deps.userData() : deps.userData;
  let formatLapTime = null;
  try {
    formatLapTime = require(path.join(dist, 'raceLog.js')).formatLapTime;
  } catch {
    /* the fallback formats the same way */
  }
  const service = new FairService({
    rpc: (fn, body) => deps.auth.rpc(fn, body),
    fair: lazy('fairTarget.js'),
    load: lazy('fairTargetLoad.js'),
    practiceLoad: lazy('practiceReviewLoad.js'),
    formatLapTime: formatLapTime || undefined,
    cache: deps.cache || new TraceCache({ dir: path.join(userData, 'training-refs') }),
    backoff: deps.backoff || new Backoff(),
    lapDir: deps.lapDir,
  });

  ipcMain.handle('practice:targets', async (_evt, req) => {
    try {
      return await service.targets(req && typeof req.sessionId === 'string' ? req.sessionId : '');
    } catch (err) {
      console.error('[fair] practice targets failed:', err.message);
      return { ok: false, mine: null, candidates: [], pick: null, leaderGap: null, error: err.message };
    }
  });

  ipcMain.handle('review:fairChips', (_evt, req) => {
    try {
      return service.chips(req && typeof req.sessionId === 'string' ? req.sessionId : '', req && req.rows);
    } catch (err) {
      console.error('[fair] chips failed:', err.message);
      return { ok: false, chips: {}, pick: null, error: err.message };
    }
  });

  return service;
}

module.exports = {
  register,
  FairService,
  boardLapId,
  parseBoardLapId,
  candidateLabel,
  targetFromBoardRow,
  leaderGapOf,
  usableRows,
  BOARD_TTL_MS,
};
