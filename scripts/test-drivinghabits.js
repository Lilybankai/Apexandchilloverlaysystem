/**
 * scripts/test-drivinghabits.js — "Your driving" (src/telemetry/drivingHabits.ts).
 * -----------------------------------------------------------------------------
 * A habit that is measured wrong does not look broken — it reads as advice
 * ("you coast 4% of a lap"). So every number here is planted on a synthetic
 * lap whose answer is known by construction, then read back:
 *
 *   §1 coasting: a planted 50 m coast at 250 km/h is counted; the one-sample
 *      crossover at every braking point is not (MIN_RUN_SEC);
 *   §2 brake/throttle overlap: a planted ~1.15 s overlap, nothing else;
 *   §3 trail braking: released before turn-in → 0 m and not trailed; held
 *      30 m past it → ~30 m and trailed;
 *   §4 TC/ABS: counted only on `aids: 2` traces; bursts closer than
 *      AID_MERGE_SEC are one event;
 *   §5 per corner: the braking point where it was planted (also when it is
 *      before the search window — the walk-back), the minimum speed, and
 *      segments that add up to the lap;
 *   §6 spreads ignore one odd lap (robustSpread);
 *   §7 the report: corner habit sentences (brakes early / braking point
 *      wanders), the learning curve, the dirty-lap share, the trend;
 *   §8 catalogue vs reference fallback: per-corner habits over every session
 *      only with `source: 'catalog'`, else the one session, with a note;
 *   §9 facts: one per number, unique ids, every card points at one, and the
 *      AI cache key moves only when a number does.
 *
 * Run: node scripts/test-drivinghabits.js (build first)
 */

'use strict';

const H = require('../dist/telemetry/drivingHabits');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  }
}
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;

/* ------------------------------ synthetic lap ----------------------------- */

const L = 3000;
const STEP = 5; // metres per sample
const APEXES = [800, 1800, 2600];
/** Catalogue-style corners: entry 160 m before the apex, exit 150 m after. */
const CORNERS = APEXES.map((a, i) => ({ id: `C${i + 1}`, entryD: (a - 160) / L, apexD: a / L, exitD: (a + 150) / L }));

/**
 * One lap. Per corner: `brake` = metres before the apex the brake goes on
 * (default 150), `min` = apex speed (default 90), `trail` = metres the brake
 * stays on past turn-in (turn-in sits ~39 m before the apex; default 20).
 * `coast` / `overlap` = [fromM, toM] stretches; `tc` = [[fromM, toM], ...]
 * bursts; `aids` = the trace's aids version.
 */
function synth(opts = {}) {
  const per = APEXES.map((a, i) => ({
    apex: a,
    brake: (opts.brake && opts.brake[i]) ?? 150,
    min: (opts.min && opts.min[i]) ?? 90,
    trail: (opts.trail && opts.trail[i]) ?? 20,
  }));
  const tr = { d: [], t: [], throttle: [], brake: [], steer: [], gear: [], speedKph: [], latG: [], lonG: [], tc: [], abs: [] };
  let t = 0;
  let prevS = null;
  let prevV = null;
  for (let s = 2; s <= L - 2; s += STEP) {
    let v = 250;
    let thr = 1;
    let brk = 0;
    let lat = 0;
    for (const c of per) {
      const bp = c.apex - c.brake;
      const turnIn = c.apex - 39;
      const release = turnIn + c.trail;
      if (s >= bp && s <= c.apex) {
        v = Math.min(v, 250 - ((250 - c.min) * (s - bp)) / c.brake);
        thr = 0;
        brk = s <= release ? 0.8 : 0;
        if (s > release) thr = 0.3; // maintenance throttle: not coasting
      } else if (s > c.apex && s <= c.apex + 300) {
        v = Math.min(v, c.min + ((250 - c.min) * (s - c.apex)) / 300);
      }
      if (s >= c.apex - 60 && s <= c.apex) lat = Math.max(lat, (1.5 * (s - (c.apex - 60))) / 60);
      else if (s > c.apex && s <= c.apex + 80) lat = Math.max(lat, 1.5 * (1 - (s - c.apex) / 80));
    }
    if (opts.coast && s >= opts.coast[0] && s < opts.coast[1]) { thr = 0; brk = 0; }
    if (opts.overlap && s >= opts.overlap[0] && s < opts.overlap[1]) { thr = 0.5; brk = 0.5; }
    let tc = 0;
    for (const b of opts.tc || []) if (s >= b[0] && s < b[1]) tc = 0.3;
    if (prevS !== null) t += (s - prevS) / (((prevV + v) / 2) / 3.6);
    prevS = s;
    prevV = v;
    tr.d.push(s / L);
    tr.t.push(t);
    tr.throttle.push(thr);
    tr.brake.push(brk);
    tr.steer.push(lat / 3);
    tr.gear.push(4);
    tr.speedKph.push(v);
    tr.latG.push(lat);
    tr.lonG.push(brk ? 1.5 : 0);
    tr.tc.push(tc);
    tr.abs.push(0);
  }
  // The last 2 m to the line at 250 km/h.
  const lapSec = t + (2 + 2) / (250 / 3.6);
  tr.count = tr.d.length;
  tr.lapSec = lapSec;
  tr.truncated = false;
  if (opts.aids) tr.aids = opts.aids;
  return tr;
}

/** Time at metres `m` on a synthetic lap (linear between samples). */
function tAt(tr, m) {
  const d = m / L;
  for (let i = 1; i < tr.d.length; i++) {
    if (tr.d[i] >= d) {
      const f = (d - tr.d[i - 1]) / (tr.d[i] - tr.d[i - 1]);
      return tr.t[i - 1] + (tr.t[i] - tr.t[i - 1]) * f;
    }
  }
  return tr.lapSec;
}

/* ------------------------------- §1 coasting ------------------------------ */
console.log('\n§1 coasting');
{
  const clean = H.extractLapFeatures(synth(), L);
  check('a lap with no coast reads ~0 (the braking crossover is not coasting)', clean && clean.coastSec === 0, clean && clean.coastSec);
  const tr = synth({ coast: [300, 350] });
  const f = H.extractLapFeatures(tr, L);
  const want = 50 / (250 / 3.6);
  check('a planted 50 m coast at 250 km/h is counted', near(f.coastSec, want, 0.08), `${f.coastSec} vs ${want.toFixed(2)}`);
  check('coasting % is of the lap time', near(f.coastPct, (want / tr.lapSec) * 100, 0.15), f.coastPct);
  const short = H.extractLapFeatures(synth({ coast: [300, 310] }), L);
  check('a 10 m (0.14 s) lift is a crossover, not coasting', short.coastSec === 0, short.coastSec);
  const slow = synth({ min: [30, 90, 90], coast: [797, 812] });
  check('coasting needs speed: a 15 m lift through a 30 km/h apex is not counted', H.extractLapFeatures(slow, L).coastSec === 0, H.extractLapFeatures(slow, L).coastSec);
}

/* ------------------------------- §2 overlap ------------------------------- */
console.log('\n§2 brake/throttle overlap');
{
  const none = H.extractLapFeatures(synth(), L);
  check('no planted overlap → 0 s', none.overlapSec === 0, none.overlapSec);
  const f = H.extractLapFeatures(synth({ overlap: [1100, 1180] }), L);
  const want = 80 / (250 / 3.6);
  check('a planted 80 m overlap at 250 km/h reads ~1.15 s', near(f.overlapSec, want, 0.08), `${f.overlapSec} vs ${want.toFixed(2)}`);
}

/* ---------------------------- §3 trail braking ---------------------------- */
console.log('\n§3 trail braking');
{
  const off = H.extractLapFeatures(synth({ trail: [-31, -31, -31] }), L);
  check('three braking zones found', off.zones === 3, off.zones);
  check('released 31 m before turn-in → no zone trailed', off.trailZones === 0, `${off.trailZones}/${off.turnZones}`);
  check('…and the depth reads 0 m', off.trailM === 0, off.trailM);
  const on = H.extractLapFeatures(synth({ trail: [30, 30, 30] }), L);
  check('held 30 m past turn-in → every zone trailed', on.trailZones === 3 && on.turnZones === 3, `${on.trailZones}/${on.turnZones}`);
  check('…about 30 m deep', near(on.trailM, 30, 6), on.trailM);
}

/* -------------------------------- §4 aids --------------------------------- */
console.log('\n§4 TC / ABS');
{
  const bursts = [[1000, 1010], [1015, 1030], [2000, 2020]];
  const v1 = H.extractLapFeatures(synth({ tc: bursts }), L);
  check('a trace without aids:2 reports no TC/ABS at all', v1.aids === false && v1.tcSec === null && v1.absEvents === null);
  const v2 = H.extractLapFeatures(synth({ tc: bursts, aids: 2 }), L);
  check('aids:2 → TC measured', v2.aids === true && v2.tcSec > 0, v2.tcSec);
  check('bursts 5 m apart merge: 2 events, not 3', v2.tcEvents === 2, v2.tcEvents);
  check('no ABS planted → 0 events', v2.absEvents === 0 && v2.absSec === 0);
}

/* ------------------------------ §5 per corner ----------------------------- */
console.log('\n§5 per-corner features');
{
  const tr = synth({ brake: [150, 170, 280], min: [90, 85, 120] });
  const c = H.extractCornerFeatures(tr, tr.lapSec, L, CORNERS);
  check('one row per corner', c && c.length === 3);
  // Within one 5 m sample: the synthetic pedal steps between samples.
  check('C1 brake point at apex − 150 m', near(c[0].brakeD * L, 800 - 150, STEP), (c[0].brakeD * L).toFixed(1));
  check('C2 brake point at apex − 170 m', near(c[1].brakeD * L, 1800 - 170, STEP), (c[1].brakeD * L).toFixed(1));
  check('C3 braked 120 m before its entry (outside the window) is still found', near(c[2].brakeD * L, 2600 - 280, STEP), (c[2].brakeD * L).toFixed(1));
  check('minimum speeds where planted (samples straddle the apex)', near(c[0].minKph, 90, 2) && near(c[1].minKph, 85, 2) && near(c[2].minKph, 120, 2), c.map((x) => x.minKph).join(','));
  const leadIn = tAt(tr, CORNERS[0].entryD * L);
  const sum = c.reduce((a, x) => a + x.segSec, 0) + leadIn;
  check('lead-in + corner segments add up to the lap', near(sum, tr.lapSec, 0.01), `${sum.toFixed(3)} vs ${tr.lapSec.toFixed(3)}`);
  check('per-corner trail is measured too', c.every((x) => typeof x.trailM === 'number'));
  const part = synth();
  part.d = part.d.slice(0, 300); // a lap that stops half way
  for (const k of ['t', 'throttle', 'brake', 'speedKph', 'latG', 'tc', 'abs']) part[k] = part[k].slice(0, 300);
  const pc = H.extractCornerFeatures(part, part.lapSec, L, CORNERS);
  check('a partial trace gives no segment times (they would not add up)', pc.every((x) => x.segSec === null));
  check('cornerKey changes with the corners and the source', H.cornerKey(CORNERS, 'catalog') !== H.cornerKey(CORNERS, 'reference')
    && H.cornerKey(CORNERS, 'catalog') !== H.cornerKey(CORNERS.slice(1), 'catalog')
    && H.cornerKey(CORNERS, 'catalog') === H.cornerKey(CORNERS.map((x) => ({ ...x })), 'catalog'));
}

/* ------------------------------ §6 spreads -------------------------------- */
console.log('\n§6 robust spread');
{
  const steady = [100, 101, 99, 100, 102, 98, 100, 101];
  const odd = [...steady, 180];
  const a = H.robustSpread(steady);
  const b = H.robustSpread(odd);
  check('one 80 m outlier barely moves the spread', b - a < 1, `${a.toFixed(2)} → ${b.toFixed(2)}`);
  check('two values → their σ; one value → null', near(H.robustSpread([0, 2]), Math.SQRT2, 1e-9) && H.robustSpread([5]) === null);
}

/* ------------------------------ report inputs ----------------------------- */

const FEAT = (over = {}) => ({
  coastSec: 2, coastPct: 2.5, overlapSec: 0.1, zones: 3, turnZones: 3, trailZones: 2, trailM: 20,
  aids: true, tcSec: 1, tcEvents: 4, absSec: 0.5, absEvents: 2, ...over,
});
/** Corner rows: per corner [segSec, brakeM, minKph]. */
const ROWS = (spec) => spec.map(([seg, brakeM, min]) => ({ segSec: seg, brakeD: brakeM === null ? null : brakeM / L, minKph: min, trailM: 10 }));

let seq = 0;
function lapIn(o = {}) {
  seq++;
  return {
    id: `l${seq}`, at: new Date(Date.UTC(2026, 9, 1, 10, 0, seq * 90)).toISOString(), lapNo: o.lapNo ?? seq, lapSec: o.lapSec ?? 90,
    valid: o.valid ?? true, timed: o.timed ?? true, outLap: o.outLap ?? false, inLap: false, dirty: o.dirty ?? [], wet: o.wet ?? false,
    f: o.f === undefined ? FEAT() : o.f, c: o.c === undefined ? null : o.c,
  };
}
function sessionIn(id, at, laps, o = {}) {
  const valid = laps.filter((l) => l.valid).map((l) => l.lapSec);
  return {
    id, at, type: o.type || 'practice', laps,
    bestSec: valid.length ? Math.min(...valid) : null,
    avgSec: valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null,
    spreadSec: o.spreadSec ?? 0.4, accuracy: o.accuracy ?? null, refPct: o.refPct ?? null,
  };
}

/* ------------------------------ §7 the report ----------------------------- */
console.log('\n§7 the report');
{
  // Ten laps. C1: the three quickest passes brake at 650 m; seven others brake
  // ~20 m earlier. C2: braking point all over the place, same speed. C3: steady.
  const laps = [];
  for (let i = 0; i < 10; i++) {
    const quick = i < 3;
    laps.push(lapIn({
      lapSec: 90 + i * 0.05,
      lapNo: i + 1,
      c: ROWS([
        [quick ? 20.0 + i * 0.01 : 20.3 + i * 0.01, quick ? 650 : 630 - (i % 2), 90],
        [25 + (i % 3) * 0.02, 1630 + [0, 30, -25, 18, -20, 26, -30, 5, 22, -18][i], 85],
        [30 + i * 0.001, 2450 + (i % 2), 120],
      ]),
    }));
  }
  const r = H.buildHabitsReport({
    trackKey: 'test-track_3000', carClass: 'GT3', track: 'Test Track', trackLengthM: L,
    sessions: [sessionIn('s1', '2026-10-01T10:00:00.000Z', laps, { accuracy: 80, refPct: 103.2 })],
    corners: CORNERS, cornerSource: 'catalog', cornerSessionId: null,
  });
  const c1 = r.corners[0];
  const c2 = r.corners[1];
  const c3 = r.corners[2];
  check('C1: "Brakes early" names the corner, the count and the metres', c1.habitKind === 'brakeEarly'
    && /^Brakes early into C1 on 7 of 7 laps — about 2[01] m before your quickest passes\.$/.test(c1.habit), c1.habit);
  check('C2: no clear early/late pattern → the wandering braking point', c2.habitKind === 'brakeWanders' && /wanders ±\d+ m/.test(c2.habit), c2.habit);
  check('C2 brake spread is large, C3 small', c2.brakeSpreadM > 15 && c3.brakeSpreadM < 2, `${c2.brakeSpreadM} / ${c3.brakeSpreadM}`);
  check('C3: steady → no habit sentence', c3.habit === null);
  check('avg loss vs own best pass: C1 ≈ 0.21 s', near(c1.avgLossSec, (3 * 0.01 + 7 * 0.3 + 0.01 * (0 + 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9) - 0) / 10, 0.02), c1.avgLossSec);
  check('trend: best, average and accuracy carried through', r.trend[0].bestSec === 90 && r.trend[0].accuracy === 80 && r.trend[0].refPct === 103.2);
  check('every corner number has its fact', r.corners.every((c) => c.factIds.length >= (c.habit ? 2 : 1)));

  // Learning curve: 108, 102, 101.2, 100.6, 100.0 → lap 4 is the first within 1%.
  const learn = [108, 102, 101.2, 100.6, 100].map((s, i) => lapIn({ lapSec: s, lapNo: i + 1 }));
  const dirty = [lapIn({ lapSec: 99, lapNo: 6, valid: false, dirty: ['limits'] }), lapIn({ lapSec: 0, lapNo: 7, timed: false, valid: false })];
  const out = lapIn({ lapSec: 130, lapNo: 0, outLap: true, valid: false });
  const r2 = H.buildHabitsReport({
    trackKey: 't', carClass: 'GT3', trackLengthM: L,
    sessions: [sessionIn('s2', '2026-10-02T10:00:00.000Z', [out, ...learn, ...dirty])],
    corners: [], cornerSource: 'none', cornerSessionId: null,
  });
  const learnItem = r2.lap.find((l) => l.kind === 'learnLaps');
  check('learning curve: 4 laps to within 1% of the session best', learnItem && learnItem.value === 4, learnItem && learnItem.text);
  const dirtyItem = r2.lap.find((l) => l.kind === 'dirtyPct');
  check('dirty share counts flying laps only (out-lap and untimed excluded): 1 of 6', dirtyItem && dirtyItem.value === 17, dirtyItem && dirtyItem.text);
  check('…and names track limits', dirtyItem && /17% for track limits/.test(dirtyItem.text));
  const coast = r2.lap.find((l) => l.kind === 'coastPct');
  check('coasting card is the mean over habit laps', coast && coast.value === 2.5 && /2\.5% of a lap/.test(coast.text), coast && coast.text);
  check('a slow lap (> 107% of best) teaches no habit', r2.habitLaps === 4, r2.habitLaps);
  check('lap items carry a fact each', r2.lap.every((l) => r2.facts.some((f) => f.id === l.factId)));

  // No ABS on the car: no ABS card at all.
  const noAbs = Array.from({ length: 4 }, () => lapIn({ f: FEAT({ absSec: 0, absEvents: 0 }) }));
  const r3 = H.buildHabitsReport({ trackKey: 't', carClass: 'LMP2', trackLengthM: L, sessions: [sessionIn('s3', '2026-10-03T10:00:00.000Z', noAbs)], corners: [], cornerSource: 'none', cornerSessionId: null });
  check('a car without ABS gets no "ABS 0 times a lap" card', !r3.lap.some((l) => l.kind === 'absSec') && r3.lap.some((l) => l.kind === 'tcSec'));
  // Old traces (no aids): no TC/ABS card.
  const old = Array.from({ length: 4 }, () => lapIn({ f: FEAT({ aids: false, tcSec: null, tcEvents: null, absSec: null, absEvents: null }) }));
  const r4 = H.buildHabitsReport({ trackKey: 't', carClass: 'GT3', trackLengthM: L, sessions: [sessionIn('s4', '2026-10-04T10:00:00.000Z', old)], corners: [], cornerSource: 'none', cornerSessionId: null });
  check('laps without aids:2 never make a TC/ABS card', !r4.lap.some((l) => l.kind === 'tcSec' || l.kind === 'absSec'));
  // Wet laps do not teach habits.
  const wet = Array.from({ length: 4 }, () => lapIn({ wet: true }));
  const r5 = H.buildHabitsReport({ trackKey: 't', carClass: 'GT3', trackLengthM: L, sessions: [sessionIn('s5', '2026-10-05T10:00:00.000Z', wet)], corners: [], cornerSource: 'none', cornerSessionId: null });
  check('wet laps teach no habit', r5.habitLaps === 0 && !r5.lap.some((l) => l.kind === 'coastPct'));
}

/* ------------------- §8 catalogue vs reference fallback ------------------- */
console.log('\n§8 catalogue vs reference');
{
  const mk = (n, brakeM) => Array.from({ length: n }, (_, i) => lapIn({ lapSec: 90 + i * 0.01, c: ROWS([[20 + i * 0.01, brakeM + (i % 2), 90], [25, 1630, 85], [30, 2450, 120]]) }));
  const old = sessionIn('old', '2026-09-01T10:00:00.000Z', mk(6, 600));
  const recent = sessionIn('new', '2026-10-01T10:00:00.000Z', mk(8, 650));
  const base = { trackKey: 't', carClass: 'GT3', trackLengthM: L, sessions: [old, recent], corners: CORNERS };
  const cat = H.buildHabitsReport({ ...base, cornerSource: 'catalog', cornerSessionId: null });
  const ref = H.buildHabitsReport({ ...base, cornerSource: 'reference', cornerSessionId: 'new' });
  check('catalogue: every session\'s laps count per corner (14)', cat.corners[0].laps === 14, cat.corners[0].laps);
  check('reference fallback: only the reference session\'s laps (8)', ref.corners[0].laps === 8, ref.corners[0].laps);
  check('a braking point MOVED 50 m between sessions (learning) is not read as one that wanders', cat.corners[0].brakeSpreadM < 2 && ref.corners[0].brakeSpreadM < 2,
    `${ref.corners[0].brakeSpreadM} / ${cat.corners[0].brakeSpreadM}`);
  const pooled = H.pooledSpread([[600, 601, 600, 601], [650, 690, 610, 655, 640]], []);
  check('spread pools each session\'s own scatter, weighted by laps', near(pooled, (0.5 * 1.4826 * 4 + 10 * 1.4826 * 5) / 9, 0.01), pooled && pooled.toFixed(1));
  check('reference fallback says so; the catalogue does not', typeof ref.cornerNote === 'string' && /session only/.test(ref.cornerNote) && cat.cornerNote === null);
  check('the fallback names its session', ref.cornerSessionId === 'new' && cat.cornerSessionId === null);
  const none = H.buildHabitsReport({ ...base, corners: [], cornerSource: 'none', cornerSessionId: null });
  check('no corners → no strip, and a note', none.corners.length === 0 && typeof none.cornerNote === 'string');
  check('whole-lap habits do not depend on the corners', none.lap.length === cat.lap.length);
}

/* ------------------------------- §9 facts --------------------------------- */
console.log('\n§9 facts and the AI key');
{
  const laps = Array.from({ length: 8 }, (_, i) => lapIn({ lapSec: 90 + i * 0.1, c: ROWS([[20 + i * 0.05, 640 - (i % 3) * 9, 90 - (i % 2) * 4], [25, 1630, 85], [30, 2450, 120]]) }));
  const laps2 = Array.from({ length: 6 }, (_, i) => lapIn({ lapSec: 89.5 + i * 0.1 }));
  const input = {
    trackKey: 't', carClass: 'GT3', track: 'Test', car: 'Car', trackLengthM: L,
    sessions: [sessionIn('a', '2026-09-01T10:00:00.000Z', laps, { accuracy: 70 }), sessionIn('b', '2026-10-01T10:00:00.000Z', laps2, { accuracy: 78, refPct: 102.5 })],
    corners: CORNERS, cornerSource: 'catalog', cornerSessionId: null,
  };
  const r = H.buildHabitsReport(input);
  const ids = r.facts.map((f) => f.id);
  check('fact ids are unique', new Set(ids).size === ids.length, ids.length);
  check('every fact has a sentence and a unit from the contract', r.facts.every((f) => f.text && /^(s|m|kph|%|C|L|pts|laps)$/.test(f.unit) && Number.isFinite(f.value)));
  check('trend facts: best, PB, change since the first session, accuracy change', ['trend.best', 'trend.pb', 'trend.bestMoved', 'trend.accuracyMoved', 'trend.refPct'].every((id) => ids.includes(id)));
  const moved = r.facts.find((f) => f.id === 'trend.bestMoved');
  check('…best moved −0.5 s, and the sentence says quicker', near(moved.value, -0.5, 1e-9) && /quicker/.test(moved.text), moved.text);
  check('report carries the AI request pieces', typeof r.inputHash === 'string' && r.inputHash.length === 8 && r.context.carClass === 'GT3' && r.context.lapSec === 89.5);
  const again = H.buildHabitsReport(JSON.parse(JSON.stringify(input)));
  check('same numbers → same AI cache key', again.inputHash === r.inputHash);
  const changed = JSON.parse(JSON.stringify(input));
  changed.sessions[1].laps[0].lapSec = 89.4;
  changed.sessions[1].bestSec = 89.4;
  check('a number moves → the key moves', H.buildHabitsReport(changed).inputHash !== r.inputHash);
  check('contract fields present', ['trackKey', 'carClass', 'sessions', 'laps', 'trend', 'corners', 'lap', 'facts'].every((k) => k in r) && r.sessions === 2 && r.laps === 14);
  check('trend is oldest first', r.trend[0].sessionId === 'a' && r.trend[1].sessionId === 'b');
  const empty = H.buildHabitsReport({ trackKey: 't', carClass: 'GT3', trackLengthM: L, sessions: [], corners: [], cornerSource: 'none', cornerSessionId: null });
  check('no sessions → an empty report, not a throw', empty.trend.length === 0 && empty.lap.length === 0 && empty.facts.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
