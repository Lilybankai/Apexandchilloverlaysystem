/**
 * scripts/fit-strategy.js — fit the strategy coefficient table, offline.
 * -----------------------------------------------------------------------------
 * Phase 2 of docs/RACE-STRATEGY-ENGINE.md: turn the corpus (`pit_stops`,
 * `lap_consumption`) into the table `raceStrategy.ts` will read —
 * `data/strategy-coefficients.json`, one row per (carClass, trackKey).
 *
 * ## The posture
 * Every coefficient here is REFUSED rather than guessed. `pitExit.ts` will not
 * estimate a pit loss until it has watched a real stop; this follows the same
 * rule at the other end of the pipe, and carries a per-coefficient confidence
 * so the engine can offer `balanced` and `push` off a known fuel coefficient
 * while refusing `save` for want of a lift term. A row with no fittable
 * coefficient is still emitted, with every confidence at 'none' and a `whyNot`
 * — a table that silently omits a track looks identical to a table that has
 * not been rebuilt, and the engine cannot tell the driver which it is.
 *
 * ## What it fits, and the honest difficulty in each
 *
 * - **burnBaseLPerLap** — median of `fuelUsedL` over clean laps. The easy one.
 *
 * - **kFuelSecPerL and the tyre linear term** — ONE joint regression, not two:
 *       lapSec ~ basePaceSec + kFuel·fuelStartL + lin·stintLap
 *   The doc describes them as two fits ("controlling for stintLap", "at matched
 *   fuel load"); a single multiple regression IS that, done once and without
 *   binning. The trap is collinearity: inside one stint the fuel falls as the
 *   stint lap rises, so the two columns are near-perfectly anti-correlated and
 *   NEITHER coefficient is identifiable from a single stint however many laps
 *   it has. Separating them needs stints that began at different fuel loads.
 *   So the fit measures |r| between the two columns and refuses both terms
 *   above COLLIN_REFUSE — this is the failure that would otherwise produce a
 *   confident, precise, wrong number, and it is invisible in a lap count.
 *
 * - **the tyre cliff** — a hinge term, searched over candidate cliff laps and
 *   accepted only when real laps ran past it (§6: "refuse the cliff term until
 *   a stint has actually run past it") and it genuinely improves the fit.
 *
 * - **pitCycleLossSec** — measured, not configured: the excess of in-lap and
 *   out-lap times over the group's normal clean lap. That sum is the whole cost
 *   of a pit cycle INCLUDING the stationary service, which is precisely the
 *   `pitLoss` term in §5's T(S); `referenceStationarySec` rides along so the
 *   engine can adjust it for a fuel load different from the stops observed,
 *   exactly as §5 says. `lane_sec` cannot give this — entry-to-exit is not the
 *   time lost against staying out, and LMU publishes no pit lane length.
 *
 * - **refuelLPerSec** — pooled per CLASS, never per track: litres per second is
 *   the car's fuel rig (migration 0019, and §6's status note). Contaminated
 *   stops are dropped first — `tyres_changed = false` does NOT mean fuel-only,
 *   and a driver swap sitting inside the filter drags the rate down.
 *
 * - **kLift / saveFractionMax** — NOT fitted, and not for want of rows. It
 *   needs deliberate lift-and-coast variation at matched load and tyre age;
 *   drivers in the corpus do not lift on purpose. §7 already requires the
 *   engine to refuse `save` until this exists, so the table says 'none' and
 *   the engine does the right thing. Inventing it is the one outcome the whole
 *   document is written against.
 *
 * ## Sources
 *   --source cloud   every driver's rows (default when a service key is set).
 *                    Needs APEX_SUPABASE_SERVICE_KEY — pit_stops and
 *                    lap_consumption are select-own, so an ordinary admin
 *                    session cannot read the raw rows the fit needs.
 *   --source local   this machine's ~/.apex-overlay/{laps,stops}. One PC is far
 *                    too few race stops to fit a refuel rate, but it is the
 *                    only source that works on a plane, and it is what the
 *                    local-override half of §6 will eventually run against.
 *
 * A local fit is a DEVELOPMENT artefact and never the shipped table: one PC
 * cannot produce five fuel-only race stops in a class, and its laps are one
 * driver's habits. So `--source local` writes `strategy-coefficients.local.json`
 * (git-ignored) and the shipping filename is reachable from a local fit only by
 * naming it with `--out`. There is no silent fallback either: without a key and
 * without `--source`, the script stops and says so rather than quietly fitting
 * from whatever happens to be on the machine — the output of the two sources
 * looks identical at a glance, and only one of them is worth shipping.
 *
 * Usage:
 *   node scripts/fit-strategy.js [--source cloud|local] [--out <path>]
 *                                [--min-laps N] [--json] [--quiet]
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Bars and thresholds. Every one of these is a refusal boundary, so they live
// together where they can be read at once rather than inline at the point of
// use. The first two match migration 0019 and the Admin card exactly — if they
// drift apart the card starts promising fits that this script then refuses.
// ---------------------------------------------------------------------------
const BURN_MIN = 30;            // clean laps with a measured burn
const REFUEL_MIN = 5;           // fuel-only race stops, per CLASS
const PACE_MIN = 30;            // laps in the joint pace regression
const PACE_MIN_PARTIAL = 15;
const SPREAD_FRAC = 0.40;       // fuel-load spread as a fraction of capacity
const SPREAD_FRAC_PARTIAL = 0.25;
const CLIFF_MIN_STINT = 15;     // longest stint before a cliff can be sought
const CLIFF_MIN_BEYOND = 8;     // laps that must sit past a candidate cliff
const CLIFF_MIN_GAIN = 0.02;    // fraction of RSS a cliff must remove to count
const PIT_MIN = 10;             // race in-laps AND out-laps for 'measured'
const PIT_MIN_PARTIAL = 5;     // three medians nothing; five is the floor
// A real pit cycle — lane in, service, lane out — lives in this band at every
// circuit LMU ships. Outside it the measurement is of something else.
const PIT_MIN_SEC = 20;
const PIT_MAX_SEC = 180;
// Laps a (driver x session) cell needs before its mean is stable enough to
// subtract. Below this the cell is dropped, not demeaned.
const FE_MIN_CELL = 5;
// |t| a coefficient must reach to be reported at all: the ordinary 95% rule.
// Below it the honest reading is "no effect measured", not "a small effect".
const T_MIN = 2;
// Above this |r| between the fuel and stint columns the two terms are the same
// column wearing two hats and neither can be trusted. 0.95 is strict on
// purpose: at r = 0.95 the variance inflation is already ~10x.
const COLLIN_REFUSE = 0.95;
const COLLIN_WARN = 0.85;
// A "clean" lap can still be a lap spent behind a slower car. Anything beyond
// this multiple of the group's best clean lap is traffic, not pace.
const PACE_WINDOW = 1.07;
// Robust refit: drop residuals beyond this many MADs and fit once more.
const ROBUST_MAD = 3;
// Contaminated-stop window, as a fraction of the class median L/s. Low side:
// a driver swap or a repair held the car. High side: a torn stationary read.
const REFUEL_LO = 0.70;
const REFUEL_HI = 1.60;

const SUPABASE_URL = process.env.APEX_SUPABASE_URL || 'https://svtyxuhbsbbodsecbnsc.supabase.co';
// Read at call time, not at import time: a caller that sets the variable after
// requiring this module (a wrapper script, a test) must still be seen, and a
// const captured at load would silently ignore it.
const serviceKey = () => process.env.APEX_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const OUT_DEFAULT = path.join(__dirname, '..', 'data', 'strategy-coefficients.json');
// Where a local fit goes unless told otherwise. A different NAME rather than a
// different folder, because electron-builder ships `data/**/*` wholesale: a
// local table sitting under the shipping name would be packaged into a build
// without anyone deciding to.
const OUT_LOCAL = path.join(__dirname, '..', 'data', 'strategy-coefficients.local.json');

// ===========================================================================
// Small statistics. No dependency: this is three functions and a solver, and a
// matrix library would be a bigger liability than the twenty lines it saves.
// ===========================================================================

function median(xs) {
  const a = xs.filter((v) => Number.isFinite(v)).slice().sort((p, q) => p - q);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function mad(xs, centre) {
  const m = centre != null ? centre : median(xs);
  if (m == null) return null;
  return median(xs.map((v) => Math.abs(v - m)));
}

/** Pearson correlation. Returns 0 for a column with no variance. */
function corr(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Solve A·x = b by Gaussian elimination with partial pivoting.
 * Returns null when the system is singular — which is the honest answer for a
 * design matrix whose columns are the same information twice.
 */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (!Number.isFinite(M[piv][col]) || Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = M.map((row, i) => row[n] / row[i]);
  return x.every((v) => Number.isFinite(v)) ? x : null;
}

/**
 * Ordinary least squares with an implicit intercept.
 * @param {number[][]} X rows of predictors (no intercept column)
 * @param {number[]} y
 * @param {number} dfUsed degrees of freedom already spent (e.g. absorbed fixed effects)
 * @returns {{coef:number[], intercept:number, rss:number, r2:number, n:number}|null}
 */
function ols(X, y, dfUsed = 0) {
  const n = y.length;
  const k = X[0] ? X[0].length : 0;
  if (n <= k + 1) return null;
  const p = k + 1;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const row = [1, ...X[i]];
    for (let a = 0; a < p; a++) {
      b[a] += row[a] * y[i];
      for (let c = 0; c < p; c++) A[a][c] += row[a] * row[c];
    }
  }
  const beta = solve(A, b);
  if (!beta) return null;
  let rss = 0, tss = 0;
  const my = y.reduce((s, v) => s + v, 0) / n;
  for (let i = 0; i < n; i++) {
    const row = [1, ...X[i]];
    const fit = row.reduce((s, v, j) => s + v * beta[j], 0);
    rss += (y[i] - fit) ** 2;
    tss += (y[i] - my) ** 2;
  }

  // Standard errors: se(b_j) = sqrt(s² · (X'X)⁻¹_jj). Without these a
  // coefficient is just a number, and this corpus produces plenty of numbers
  // that are pure noise — a GT3 group with 649 laps fits the fuel term to an
  // r² of 0.011, which is not a small effect measured well, it is nothing
  // measured at all. The t statistic is what tells the two apart.
  //
  // `dfUsed` is for the fixed effects absorbed before the fit: demeaning
  // within C cells costs C degrees of freedom that this function cannot see,
  // and ignoring them makes every error bar too narrow.
  const dof = n - p - Math.max(0, dfUsed);
  const se = new Array(p).fill(null);
  if (dof > 0) {
    const sigma2 = rss / dof;
    for (let j = 0; j < p; j++) {
      const e = new Array(p).fill(0);
      e[j] = 1;
      const col = solve(A.map((r) => [...r]), e);
      if (col && Number.isFinite(col[j]) && col[j] >= 0) se[j] = Math.sqrt(sigma2 * col[j]);
    }
  }

  return {
    intercept: beta[0],
    coef: beta.slice(1),
    se: se.slice(1),
    seIntercept: se[0],
    dof,
    rss,
    r2: tss > 0 ? 1 - rss / tss : 0,
    n,
  };
}

/** OLS, then drop residual outliers beyond ROBUST_MAD and fit once more. */
function robustOls(X, y, dfUsed = 0) {
  const first = ols(X, y, dfUsed);
  if (!first) return null;
  const resid = y.map((v, i) => {
    const row = [1, ...X[i]];
    return v - row.reduce((s, c, j) => s + c * [first.intercept, ...first.coef][j], 0);
  });
  const spread = mad(resid, 0);
  if (!spread || spread <= 0) return { ...first, dropped: 0 };
  const keep = resid.map((r) => Math.abs(r) <= ROBUST_MAD * 1.4826 * spread);
  const kept = keep.filter(Boolean).length;
  if (kept === y.length || kept <= X[0].length + 2) return { ...first, dropped: 0 };
  const second = ols(X.filter((_, i) => keep[i]), y.filter((_, i) => keep[i]), dfUsed);
  return second ? { ...second, dropped: y.length - kept } : { ...first, dropped: 0 };
}

const round = (v, d) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

// ===========================================================================
// Reading the corpus. Both sources normalise to the same row shape so the fit
// below never learns where a lap came from.
// ===========================================================================

/** @returns {{laps:object[], stops:object[], source:string}} */
async function readCloud() {
  const key = serviceKey();
  if (!key) {
    throw new Error(
      'cloud source needs APEX_SUPABASE_SERVICE_KEY (pit_stops and lap_consumption '
      + 'are select-own, so an admin session cannot read the raw rows). '
      + 'Set it, or run with --source local.',
    );
  }
  const tracks = new Map();
  for (const t of await page('tracks', 'id,slug,name,length_m')) {
    tracks.set(t.id, { key: t.slug, name: t.name, lengthM: t.length_m });
  }
  const lapRows = await page(
    'lap_consumption',
    'id,driver_id,track_id,car_class,car,session_type,lap_ms,clean,fuel_start_l,fuel_end_l,fuel_used_l,'
    + 'capacity_l,wear_at_line,compound,stint_lap,is_out_lap,is_in_lap,wet,set_at',
  );
  const stopRows = await page(
    'pit_stops',
    'id,track_id,car_class,car,session_type,lane_sec,stationary_sec,booked_sec,'
    + 'fuel_added_l,tyres_changed,compound_fitted,stopped_at',
  );
  const t = (id) => tracks.get(id) || { key: null, name: '?', lengthM: null };
  return {
    source: 'cloud',
    laps: lapRows.map((r) => ({
      driverId: r.driver_id, carClass: r.car_class, car: r.car,
      trackKey: t(r.track_id).key, track: t(r.track_id).name, trackLengthM: t(r.track_id).lengthM,
      sessionType: r.session_type, lapMs: r.lap_ms, clean: r.clean,
      fuelStartL: r.fuel_start_l, fuelUsedL: r.fuel_used_l, capacityL: r.capacity_l,
      compound: r.compound, stintLap: r.stint_lap,
      isOutLap: r.is_out_lap, isInLap: r.is_in_lap, wet: r.wet,
    })),
    stops: stopRows.map((r) => ({
      carClass: r.car_class, car: r.car,
      trackKey: t(r.track_id).key, track: t(r.track_id).name,
      sessionType: r.session_type, laneSec: r.lane_sec, stationarySec: r.stationary_sec,
      bookedSec: r.booked_sec, fuelAddedL: r.fuel_added_l, tyresChanged: r.tyres_changed,
    })),
  };

  /** PostgREST is capped per request; walk it until a short page comes back. */
  async function page(table, select) {
    const out = [];
    const size = 1000;
    for (let offset = 0; ; offset += size) {
      const url = `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}`
        + `&limit=${size}&offset=${offset}`;
      const res = await fetch(url, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
      const rows = await res.json();
      out.push(...rows);
      if (rows.length < size) return out;
    }
  }
}

/** This machine's logs. `dirs` is injectable so the test never reads real laps. */
function readLocal(dirs) {
  const root = (dirs && dirs.root) || path.join(os.homedir(), '.apex-overlay');
  const read = (sub) => {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8')
        .split('\n').filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean));
  };
  // Only v5+ laps carry the consumption block; earlier ones are invisible here
  // and that is not a bug, it is the schema they were written under.
  const laps = read('laps').filter((l) => Number(l.v || 0) >= 5).map((l) => ({
    // One machine is one driver; the fixed-effect cells collapse to sessions.
    driverId: 'local', carClass: l.carClass, car: l.car, trackKey: l.trackKey, track: l.track,
    trackLengthM: l.trackLengthM, sessionType: l.sessionType, lapMs: l.lapMs, clean: !!l.clean,
    fuelStartL: l.fuelStartL, fuelUsedL: l.fuelUsedL, capacityL: l.capacityL,
    compound: l.compound, stintLap: l.stintLap,
    isOutLap: !!l.isOutLap, isInLap: !!l.isInLap, wet: l.wet,
  }));
  const stops = read('stops').map((s) => ({
    carClass: s.carClass, car: s.car, trackKey: s.trackKey, track: s.track,
    sessionType: s.sessionType, laneSec: s.laneSec,
    // The client writes UNKNOWN_VALUE (-1) when it had no speed channel; the
    // cloud stores that as NULL and so must this, or a negative duration
    // becomes an infinitely fast refuel.
    stationarySec: Number(s.stationarySec) >= 0 ? s.stationarySec : null,
    bookedSec: s.bookedSec, fuelAddedL: s.fuelAddedL, tyresChanged: !!s.tyresChanged,
  }));
  return { source: 'local', laps, stops };
}

// ===========================================================================
// The fit
// ===========================================================================

/** A fuel-only race stop, by the same definition the Admin card uses. */
function isFuelStop(s) {
  return String(s.sessionType || '').toLowerCase() === 'race'
    && Number(s.stationarySec) >= 5
    && Number(s.fuelAddedL) >= 5
    && !s.tyresChanged;
}

/**
 * Refuel rate per class, contaminated stops removed.
 *
 * Two passes: a provisional median over everything that passes the filters,
 * then the median again over the stops that sit in a plausible band around it.
 * The first median has to be robust enough to define the band, which is why it
 * is a median and not a mean — one Le Mans driver swap would move a mean far
 * enough to drag half the honest stops outside its own window.
 */
function fitRefuelByClass(stops) {
  const byClass = new Map();
  for (const s of stops) {
    if (!isFuelStop(s)) continue;
    const cls = String(s.carClass || '').toUpperCase();
    if (!cls) continue;
    const lps = Number(s.fuelAddedL) / Number(s.stationarySec);
    if (!Number.isFinite(lps) || lps <= 0) continue;
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls).push({ lps, stop: s });
  }
  const out = new Map();
  for (const [cls, rows] of byClass) {
    const provisional = median(rows.map((r) => r.lps));
    const kept = rows.filter((r) => r.lps >= REFUEL_LO * provisional && r.lps <= REFUEL_HI * provisional);
    const value = median(kept.map((r) => r.lps));
    const tracks = new Set(kept.map((r) => r.stop.trackKey || r.stop.track)).size;
    out.set(cls, {
      refuelLPerSec: round(value, 3),
      stops: kept.length,
      stopsBeforeFilter: rows.length,
      dropped: rows.length - kept.length,
      tracks,
      p25: round(percentile(kept.map((r) => r.lps), 0.25), 3),
      p75: round(percentile(kept.map((r) => r.lps), 0.75), 3),
      confidence: kept.length >= REFUEL_MIN ? 'measured' : 'none',
    });
  }
  return out;
}

function percentile(xs, p) {
  const a = xs.filter(Number.isFinite).slice().sort((q, r) => q - r);
  if (!a.length) return null;
  const i = (a.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
}

/**
 * Everything that can be fitted from ONE (class, track) group's laps.
 * `refuel` is the class row from fitRefuelByClass, passed in rather than
 * recomputed — it is deliberately not this group's own arithmetic.
 */
function fitGroup(laps, stops, refuel) {
  const whyNot = [];
  const confidence = { burn: 'none', kFuel: 'none', tyre: 'none', cliff: 'none', pit: 'none', refuel: 'none', kLift: 'none' };

  // ---- burn -------------------------------------------------------------
  const burnLaps = laps.filter((l) => l.clean && Number.isFinite(Number(l.fuelUsedL)));
  const burnBaseLPerLap = round(median(burnLaps.map((l) => Number(l.fuelUsedL))), 3);
  if (burnLaps.length >= BURN_MIN) confidence.burn = 'measured';
  else if (burnLaps.length) { confidence.burn = 'partial'; whyNot.push(`burn from ${burnLaps.length} laps, wants ${BURN_MIN}`); }
  else whyNot.push('no lap carried a measured burn');

  const capacityL = Math.max(0, ...laps.map((l) => Number(l.capacityL) || 0)) || null;

  // ---- the pace regression ----------------------------------------------
  // Dry, clean, timed, mid-stint laps only. An out-lap carries cold tyres and
  // a lane transit, an in-lap carries the entry; both are fitted separately
  // below as the pit cycle, and leaving them in here would smear that cost
  // across the fuel term.
  const timed = laps.filter((l) => l.clean && !l.isOutLap && !l.isInLap && l.wet !== true
    && Number(l.lapMs) > 5000 && Number(l.lapMs) < 3600000);
  const best = Math.min(...timed.map((l) => Number(l.lapMs)), Infinity);
  const paceRows = timed.filter((l) => Number(l.lapMs) <= best * PACE_WINDOW
    && Number.isFinite(Number(l.fuelStartL)) && Number.isFinite(Number(l.stintLap)));

  let basePaceSec = round(median(timed.map((l) => Number(l.lapMs) / 1000)), 3);
  let kFuelSecPerL = null;
  let tyre = null;
  let collinearity = null;
  let fitQuality = null;
  let tStats = null;

  const spreadL = paceRows.length
    ? Math.max(...paceRows.map((l) => Number(l.fuelStartL))) - Math.min(...paceRows.map((l) => Number(l.fuelStartL)))
    : 0;
  const stintMax = paceRows.length ? Math.max(...paceRows.map((l) => Number(l.stintLap))) : 0;

  // ---- driver fixed effects ---------------------------------------------
  // A pooled regression over several drivers does not measure the fuel effect,
  // it measures whoever happened to run light. Real case, GT3 at Barcelona:
  // the slowest driver averaged 109.2 s carrying 10.8 L while the quickest
  // averaged 105.1 s carrying 65.4 L, so ACROSS drivers low fuel looks slow and
  // the pooled coefficient comes out NEGATIVE — a heavier car lapping faster.
  //
  // The fix is the standard panel one: subtract each cell's own mean from
  // every column and fit the deviations, so a driver is only ever compared
  // with himself. Cells are (driver × session type), not driver alone —
  // qualifying pace, practice pace and race pace are different animals for the
  // same person, and a session's track state moves with it.
  //
  // A cell too small to have a stable mean contributes nothing but noise, so
  // it is dropped rather than demeaned. That is also what makes the refusals
  // downstream honest: after this, "not enough laps" means not enough laps
  // that can actually speak to the question.
  const cells = new Map();
  for (const l of paceRows) {
    const k = `${l.driverId || '?'}|${String(l.sessionType || '').toLowerCase()}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(l);
  }
  const usableCells = [...cells.values()].filter((c) => c.length >= FE_MIN_CELL);
  const feRows = usableCells.flat();
  const driversSeen = new Set(paceRows.map((l) => l.driverId || '?')).size;

  if (paceRows.length >= PACE_MIN_PARTIAL && feRows.length >= PACE_MIN_PARTIAL) {
    // Deviations from each cell's mean.
    // `cellOf` keeps the panel structure available after flattening, so any
    // column DERIVED from a raw one — the cliff hinge below — can be demeaned
    // the same way. A hinge built from demeaned stint laps would be a hinge on
    // "laps either side of this cell's average stint position", which is not a
    // cliff and not anything.
    const cellOf = [];
    const fuelRaw = [], stintRaw = [], yRaw = [];
    usableCells.forEach((cell, ci) => {
      for (const l of cell) {
        cellOf.push(ci);
        fuelRaw.push(Number(l.fuelStartL));
        stintRaw.push(Number(l.stintLap));
        yRaw.push(Number(l.lapMs) / 1000);
      }
    });
    const demean = (col) => {
      const sums = new Array(usableCells.length).fill(0);
      const counts = new Array(usableCells.length).fill(0);
      col.forEach((v, i) => { sums[cellOf[i]] += v; counts[cellOf[i]]++; });
      return col.map((v, i) => v - sums[cellOf[i]] / counts[cellOf[i]]);
    };
    const fuelCol = demean(fuelRaw);
    const stintCol = demean(stintRaw);
    const y = demean(yRaw);
    // Measured on the DEMEANED columns: identification lives in the within-cell
    // variation, so that is where collinearity has to be judged.
    collinearity = round(Math.abs(corr(fuelCol, stintCol)), 3);

    if (collinearity >= COLLIN_REFUSE) {
      // The two columns are one column. Any split between them is arbitrary,
      // and an arbitrary split that looks precise is worse than no number.
      whyNot.push(
        `fuel load and stint lap are ${(collinearity * 100).toFixed(0)}% collinear `
        + '— every stint started at the same fuel load, so the fuel and tyre terms cannot be separated',
      );
    } else {
      const fit = robustOls(fuelCol.map((_, i) => [fuelCol[i], stintCol[i]]), y,
        Math.max(0, usableCells.length - 1));
      if (fit) {
        // Demeaning removes the intercept, so base pace is recovered by taking
        // the slopes back off the ORIGINAL lap times. The median across drivers
        // is a field-average reference, not any one person's pace — the engine
        // should prefer the driver's own live pace and use this as a fallback.
        const kF = fit.coef[0];
        const lin0 = fit.coef[1];
        basePaceSec = round(median(feRows.map((l) =>
          Number(l.lapMs) / 1000 - kF * Number(l.fuelStartL) - lin0 * Number(l.stintLap))), 3);
        kFuelSecPerL = round(kF, 5);
        const lin = round(lin0, 5);
        fitQuality = { r2: round(fit.r2, 3), n: fit.n, droppedOutliers: fit.dropped, cells: usableCells.length, drivers: driversSeen };

        // Is the coefficient distinguishable from zero at all? |t| >= 2 is the
        // usual 95% rule. This is the guard that separates a small effect
        // measured well from nothing measured at all, and in this corpus that
        // distinction is the whole ball game: a GT3 group with 649 laps fits
        // the fuel term to an r² of 0.011 — lap-to-lap scatter from traffic,
        // setup changes and track state swamps the ~2 s a full tank is worth.
        // A lap COUNT cannot see this; only the error bar can.
        const tOf = (i) => (fit.se && fit.se[i] ? fit.coef[i] / fit.se[i] : null);
        const tFuel = tOf(0);
        const tTyre = tOf(1);
        tStats = { fuel: round(tFuel, 2), tyre: round(tTyre, 2) };

        if (kFuelSecPerL != null && tFuel != null && Math.abs(tFuel) < T_MIN) {
          whyNot.push(
            `fuel term is not distinguishable from zero (${kFuelSecPerL} ± ${round(1.96 * fit.se[0], 5)} s/L, `
            + `t=${round(tFuel, 2)}, r²=${round(fit.r2, 3)}) — lap-time scatter swamps the effect`,
          );
          kFuelSecPerL = null;
        }
        // A negative fuel term says a heavier car laps faster. It does not.
        // Refuse it for the same reason the negative tyre term below is
        // refused: the number is a symptom of a confound still in the data,
        // and shipping it would be worse than shipping nothing.
        if (kFuelSecPerL != null && kFuelSecPerL < 0) {
          whyNot.push(`fuel term came out negative (${kFuelSecPerL} s/L) — a heavier car does not lap faster; something is still confounded`);
          kFuelSecPerL = null;
        }

        const enough = feRows.length >= PACE_MIN;
        const spreadOk = capacityL ? spreadL >= SPREAD_FRAC * capacityL : false;
        const spreadPartial = capacityL ? spreadL >= SPREAD_FRAC_PARTIAL * capacityL : false;
        if (kFuelSecPerL == null) confidence.kFuel = 'none';
        else if (enough && spreadOk && collinearity < COLLIN_WARN) confidence.kFuel = 'measured';
        else if (spreadPartial) confidence.kFuel = 'partial';
        if (confidence.kFuel !== 'measured') {
          whyNot.push(
            `kFuel from ${feRows.length} within-driver laps over a ${spreadL.toFixed(0)} L spread`
            + (capacityL ? ` (wants ${Math.round(SPREAD_FRAC * capacityL)} L of a ${capacityL} L tank)` : '')
            + (collinearity >= COLLIN_WARN ? `, and ${(collinearity * 100).toFixed(0)}% collinear with stint lap` : ''),
          );
        }

        // A negative linear term means the tyres got faster with age, which
        // they do not: it is track evolution or fuel burn-off leaking into the
        // column. Report the fit and refuse the coefficient.
        if (lin != null && tTyre != null && Math.abs(tTyre) < T_MIN) {
          whyNot.push(`tyre term is not distinguishable from zero (t=${round(tTyre, 2)}) — degradation is inside the lap-to-lap noise here`);
        } else if (lin != null && lin < 0) {
          whyNot.push(`tyre term came out negative (${lin} s/lap) — track evolution, not degradation`);
        } else {
          tyre = { linSecPerLap: lin, cliffLap: null, cliffSecPerLap: null };
          if (feRows.length >= PACE_MIN && stintMax >= CLIFF_MIN_STINT) confidence.tyre = 'measured';
          else {
            confidence.tyre = 'partial';
            whyNot.push(`tyre from ${feRows.length} within-driver laps, longest stint ${stintMax}`);
          }

          // ---- the cliff -------------------------------------------------
          const cliff = fitCliff(fuelCol, stintCol, y, fit.rss, stintRaw, demean);
          if (cliff) {
            tyre.cliffLap = cliff.cliffLap;
            tyre.cliffSecPerLap = cliff.cliffSecPerLap;
            confidence.cliff = 'measured';
          } else if (stintMax < CLIFF_MIN_STINT + CLIFF_MIN_BEYOND) {
            whyNot.push(`no stint ran far enough past a cliff (longest ${stintMax})`);
          }
        }
      }
    }
  } else {
    whyNot.push(`only ${paceRows.length} laps carry both a fuel load and a stint position`);
  }

  // ---- the pit cycle ----------------------------------------------------
  // RACE sessions only. In practice an "out-lap" is usually a garage exit and
  // an "in-lap" a decision to stop running — neither is a pit cycle, and mixing
  // them in produced 7 s at one circuit and 103 s at another when the true
  // figure is the same 40-60 s everywhere. In a race an in-lap and an out-lap
  // really are the two halves of a stop.
  const raceOnly = (l) => String(l.sessionType || '').toLowerCase() === 'race';
  const racing = timed.filter(raceOnly);
  const normal = median((racing.length >= PIT_MIN_PARTIAL ? racing : timed).map((l) => Number(l.lapMs) / 1000));
  const inLaps = laps.filter((l) => raceOnly(l) && l.isInLap && Number(l.lapMs) > 5000).map((l) => Number(l.lapMs) / 1000);
  const outLaps = laps.filter((l) => raceOnly(l) && l.isOutLap && Number(l.lapMs) > 5000).map((l) => Number(l.lapMs) / 1000);
  let pitCycleLossSec = null;
  let referenceStationarySec = null;
  if (normal != null && inLaps.length >= PIT_MIN_PARTIAL && outLaps.length >= PIT_MIN_PARTIAL) {
    const inExcess = median(inLaps) - normal;
    const outExcess = median(outLaps) - normal;
    const total = inExcess + outExcess;
    // A pit cycle that reads under PIT_MIN_SEC or over PIT_MAX_SEC is not a
    // pit cycle: it is a safety-car lap, a stop-go, a spin on the out-lap, or
    // a median taken over too few laps to mean anything. Refuse it — a wrong
    // pit loss does not degrade a strategy call, it inverts it.
    if (inExcess > 0 && outExcess > 0 && total >= PIT_MIN_SEC && total <= PIT_MAX_SEC) {
      pitCycleLossSec = round(total, 2);
      confidence.pit = (inLaps.length >= PIT_MIN && outLaps.length >= PIT_MIN) ? 'measured' : 'partial';
    } else if (inExcess > 0 && outExcess > 0) {
      whyNot.push(`pit cycle came out at ${round(total, 1)} s from ${inLaps.length} in / ${outLaps.length} out — outside the ${PIT_MIN_SEC}-${PIT_MAX_SEC} s a real stop takes`);
    }
  }
  if (confidence.pit === 'none') {
    whyNot.push(`pit cycle wants ${PIT_MIN_PARTIAL} race in-laps and ${PIT_MIN_PARTIAL} race out-laps, has ${inLaps.length} and ${outLaps.length}`);
  }
  const groupStops = stops.filter(isFuelStop);
  if (groupStops.length) referenceStationarySec = round(median(groupStops.map((s) => Number(s.stationarySec))), 2);

  // ---- refuel, from the class pool --------------------------------------
  let refuelLPerSec = null;
  if (refuel && refuel.confidence === 'measured') {
    refuelLPerSec = refuel.refuelLPerSec;
    confidence.refuel = 'measured';
  } else {
    whyNot.push(`refuel rate wants ${REFUEL_MIN} fuel-only race stops in the class, has ${refuel ? refuel.stops : 0}`);
  }

  // kLift is never fitted. See the header.
  whyNot.push('no deliberate lift-and-coast in the corpus, so `save` cannot be offered');

  return {
    basePaceSec, burnBaseLPerLap, capacityL,
    kFuelSecPerL, tyre,
    refuelLPerSec,
    refuelSource: confidence.refuel === 'measured' ? 'class' : null,
    pitCycleLossSec, referenceStationarySec,
    kLiftSecPerLPerLap: null, saveFractionMax: null,
    confidence,
    n: { burnLaps: burnLaps.length, paceLaps: feRows.length, paceLapsPooled: paceRows.length, inLaps: inLaps.length, outLaps: outLaps.length, stops: groupStops.length },
    diagnostics: { loadSpreadL: round(spreadL, 1), stintMax, collinearity, drivers: driversSeen, feLaps: feRows.length, t: tStats, fit: fitQuality },
    whyNot,
  };
}

/**
 * Search for a tyre cliff: the stint lap past which degradation steepens.
 * A hinge term max(0, stint − c) added to the same regression, swept over c,
 * accepted only when enough laps sit beyond it, the extra slope is positive,
 * and it removes a real share of the residual. Anything less is a fourth
 * parameter fitting noise, which a least-squares fit will always let you do.
 */
function fitCliff(fuelCol, stintCol, y, baseRss, stintRaw, demean) {
  // Candidates are real stint laps, so the hinge is built from `stintRaw` and
  // then put through the same within-cell demeaning as every other column.
  const raw = stintRaw || stintCol;
  const within = demean || ((col) => col);
  const stintMax = Math.max(...raw);
  if (stintMax < CLIFF_MIN_STINT) return null;
  let bestFit = null;
  for (let c = 5; c <= stintMax - 3; c++) {
    const beyond = raw.filter((s) => s > c).length;
    if (beyond < CLIFF_MIN_BEYOND) continue;
    const hinge = within(raw.map((s) => Math.max(0, s - c)));
    const X = stintCol.map((s, i) => [fuelCol[i], s, hinge[i]]);
    const fit = ols(X, y);
    if (!fit) continue;
    const extra = fit.coef[2];
    if (!(extra > 0)) continue;
    const gain = (baseRss - fit.rss) / baseRss;
    if (gain < CLIFF_MIN_GAIN) continue;
    if (!bestFit || fit.rss < bestFit.rss) {
      bestFit = { rss: fit.rss, cliffLap: c, cliffSecPerLap: round(extra, 5) };
    }
  }
  return bestFit;
}

/** Group key. The coefficient table is keyed by class and track, never by car
 *  — `car` is a team/livery/year string ("BMW GT3 Custom Team 2025 #397" vs
 *  "…2026 #397" is one car, two strings), so keying on it shatters every
 *  sample. Capacity separates genuinely different tanks instead. */
const groupKey = (r) => `${String(r.carClass || '?').toUpperCase()}|${r.trackKey || r.track || '?'}`;

function buildTable({ laps, stops, source }, opts = {}) {
  const minLaps = opts.minLaps != null ? opts.minLaps : 1;
  const refuelByClass = fitRefuelByClass(stops);

  const lapGroups = new Map();
  for (const l of laps) {
    const k = groupKey(l);
    if (!lapGroups.has(k)) lapGroups.set(k, []);
    lapGroups.get(k).push(l);
  }
  const stopGroups = new Map();
  for (const s of stops) {
    const k = groupKey(s);
    if (!stopGroups.has(k)) stopGroups.set(k, []);
    stopGroups.get(k).push(s);
  }

  const rows = [];
  for (const [key, groupLaps] of lapGroups) {
    if (groupLaps.length < minLaps) continue;
    const [carClass, trackKey] = key.split('|');
    const fitted = fitGroup(groupLaps, stopGroups.get(key) || [], refuelByClass.get(carClass));
    rows.push({
      carClass,
      trackKey,
      track: groupLaps[0].track || null,
      trackLengthM: groupLaps[0].trackLengthM || null,
      ...fitted,
    });
  }
  rows.sort((a, b) => (b.n.paceLaps - a.n.paceLaps) || a.carClass.localeCompare(b.carClass));

  const usable = (r) => r.confidence.burn === 'measured' && r.confidence.kFuel === 'measured'
    && r.confidence.tyre === 'measured' && r.confidence.refuel === 'measured';

  return {
    version: 1,
    fittedAt: new Date().toISOString().slice(0, 10),
    source,
    fitter: 'scripts/fit-strategy.js',
    bars: {
      burnLaps: BURN_MIN, refuelStops: REFUEL_MIN, paceLaps: PACE_MIN,
      loadSpreadFraction: SPREAD_FRAC, cliffMinStint: CLIFF_MIN_STINT,
      collinearityRefuse: COLLIN_REFUSE,
    },
    corpus: { laps: laps.length, stops: stops.length, pairs: rows.length },
    refuelByClass: Object.fromEntries(refuelByClass),
    ready: rows.filter(usable).map((r) => `${r.carClass} @ ${r.track || r.trackKey}`),
    rows,
  };
}

// ===========================================================================
// CLI
// ===========================================================================

function parseArgs(argv) {
  const args = { source: null, out: null, minLaps: 1, json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') args.source = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--min-laps') args.minLaps = Number(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (a === '--quiet') args.quiet = true;
  }
  // No source and no key: stop. The alternative — quietly fitting this one
  // machine — produces a table that looks exactly like the real one in every
  // report and every file, and differs only in being worthless.
  if (!args.source) {
    if (!serviceKey()) {
      throw new Error(
        'no APEX_SUPABASE_SERVICE_KEY, so the cloud corpus cannot be read '
        + '(pit_stops and lap_consumption are select-own).\n'
        + '  Set the key to fit the real table, or pass --source local to fit '
        + 'from THIS MACHINE only — a development artefact, never the shipped table.',
      );
    }
    args.source = 'cloud';
  }
  if (!args.out) args.out = args.source === 'local' ? OUT_LOCAL : OUT_DEFAULT;
  // Reachable, but only by asking for it by name.
  if (args.source === 'local' && path.resolve(args.out) === path.resolve(OUT_DEFAULT)) {
    console.warn(
      `\n!! writing a LOCAL fit to the shipping filename (${path.basename(OUT_DEFAULT)}).\n`
      + '   data/**/* is packaged by electron-builder, so this will go out in a build.\n',
    );
  }
  return args;
}

function report(table) {
  const mark = (c) => (c === 'measured' ? 'Y' : c === 'partial' ? '~' : '-');
  console.log(`\nStrategy coefficients — ${table.source}, ${table.corpus.laps} laps / ${table.corpus.stops} stops`);
  if (table.source === 'local') {
    console.log(
      'THIS MACHINE ONLY — not a shippable table. One PC cannot reach five fuel-only\n'
      + 'race stops in a class, so every refuel rate below will refuse, and the pace\n'
      + 'coefficients are one driver\'s habits. Fit from the cloud corpus to ship.',
    );
  }
  console.log(`${table.corpus.pairs} class/track pairs · ${table.ready.length} fittable on burn+kFuel+tyre+refuel\n`);
  console.log('  B K T R  class @ track                                    base    L/lap   s/L      deg     refuel');
  for (const r of table.rows.slice(0, 30)) {
    const c = r.confidence;
    console.log(
      `  ${mark(c.burn)} ${mark(c.kFuel)} ${mark(c.tyre)} ${mark(c.refuel)}  `
      + `${(r.carClass + ' @ ' + (r.track || r.trackKey)).padEnd(48).slice(0, 48)}`
      + `${String(r.basePaceSec ?? '—').padStart(7)} `
      + `${String(r.burnBaseLPerLap ?? '—').padStart(7)} `
      + `${String(r.kFuelSecPerL ?? '—').padStart(8)} `
      + `${String(r.tyre && r.tyre.linSecPerLap != null ? r.tyre.linSecPerLap : '—').padStart(8)} `
      + `${String(r.refuelLPerSec ?? '—').padStart(7)}`,
    );
  }
  console.log('\nRefuel rate, per class (pooled across circuits — the fuel rig is the car\'s):');
  for (const [cls, r] of Object.entries(table.refuelByClass)) {
    console.log(
      `  ${cls.padEnd(12)} ${String(r.refuelLPerSec ?? '—').padStart(6)} L/s  `
      + `from ${String(r.stops).padStart(3)} stops over ${r.tracks} circuits`
      + (r.dropped ? ` (${r.dropped} contaminated dropped)` : '')
      + `  ${r.confidence}`,
    );
  }
  const blocked = table.rows.filter((r) => r.confidence.kFuel === 'none' && r.n.paceLaps >= PACE_MIN);
  if (blocked.length) {
    console.log(`\n${blocked.length} pair(s) have laps enough but still refuse kFuel:`);
    for (const r of blocked.slice(0, 8)) {
      console.log(`  ${r.carClass} @ ${r.track || r.trackKey}: ${r.whyNot[r.whyNot.length - 2] || r.whyNot[0]}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const corpus = args.source === 'local' ? readLocal() : await readCloud();
  const table = buildTable(corpus, { minLaps: args.minLaps });

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(table, null, 2)}\n`, 'utf8');

  if (args.json) console.log(JSON.stringify(table, null, 2));
  else if (!args.quiet) { report(table); console.log(`\nwrote ${path.relative(process.cwd(), args.out)}`); }
}

module.exports = {
  median, mad, corr, solve, ols, robustOls, percentile,
  isFuelStop, fitRefuelByClass, fitGroup, fitCliff, buildTable, readLocal, groupKey,
  BURN_MIN, REFUEL_MIN, PACE_MIN, SPREAD_FRAC, CLIFF_MIN_STINT, COLLIN_REFUSE,
  // Argument handling is behaviour too — it decides which corpus gets fitted
  // and where the answer lands — so the test can reach it.
  readCloud,
  __cli: { parseArgs, OUT_DEFAULT, OUT_LOCAL },
};

if (require.main === module) {
  main().catch((err) => { console.error(String((err && err.message) || err)); process.exit(1); });
}
