/**
 * The iRacing provider, checked against a REAL capture (plain node, run with
 * `npm run test:iracing` after a build).
 *
 * The fixture (scripts/fixtures/iracing-cap1) is a slice of a live capture of an
 * official BMW M2 Rookie event at Winton: practice traffic, the player's
 * qualifying laps and the race start, cut by scripts/make-iracing-fixture.js.
 * Set APEX_IR_CAPTURE=<dir> to run the same checks over a full capture instead.
 *
 * Covers:
 *  1. iRating: reproduces the irating-rs snapshot and the worked examples;
 *  2. class labels: iRacing names pass through, LMU's normaliser is unchanged;
 *  3. session-info YAML: unquoted-name repair, colours, 0-based class
 *     positions, and parse time on every captured revision (the main-thread
 *     budget: fails over 8 ms warm, which is the signal to move to a worker);
 *  4. the lap gate that waits for iRacing's lagging lap time;
 *  5. replaying the capture through the provider: every frame's invariants;
 *  6. the lap log fed from that replay, and the iRacing clean-lap rule on a
 *     scripted stint (incident, pit road, off track).
 */
const path = require('path');
const fs = require('fs');
const dist = (m) => require(path.join(__dirname, '..', 'dist', 'telemetry', m));
const { iRatingDeltas, iRatingDeltasByClass } = dist('iracing/irating.js');
const { normalizeClass, normalizeClassFor } = dist('carClass.js');
const { parseSessionInfo, decodeSessionInfo, repairSessionYaml } = dist('iracing/sessionInfo.js');
const { CaptureSource } = dist('iracing/captureSource.js');
const { IRacingProvider, LapGate } = dist('iracing/iracingProvider.js');

const UNKNOWN = -1;
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const near = (a, b, eps) => Math.abs(a - b) <= eps;

const fixtureDir = path.join(__dirname, 'fixtures', 'iracing-cap1');
// APEX_IR_CAPTURE: one or more capture dirs (separated by ';' or ','), each
// replayed in section 5 alongside the committed fixture.
const extraCaptures = (process.env.APEX_IR_CAPTURE || '')
  .split(/[;,]/)
  .map((s) => s.trim())
  .filter((s) => s && fs.existsSync(path.join(s, 'frames.ndjson')));
const captureDir = fixtureDir;

/* -------------------------------------------------------------------------- */
console.log('\n1) iRating (community formula, irating-rs snapshot)');
{
  const field = [7526, 5982, 5463, 4279, 4137, 4044, 3891, 3612, 3147, 2823, 2715, 2603, 2512, 2352,
    2227, 2195, 2166, 2089, 1773, 1772, 1752, 1748, 1705, 1662, 1622, 1537, 1464, 1203];
  const snapshot = [17.637, 25.834, 25.433, 37.928, 33.394, 27.948, 23.814, 22.627, 26.486, 27.702,
    23.364, 19.217, 14.533, 10.438, 8.529, 2.204, -4.209, -9.070, -5.788, -13.087, -19.722, -26.915,
    -32.736, -38.541, -44.440, -48.680, -53.308, -50.591];
  const got = iRatingDeltas(field.map((ir, i) => ({ ir, rank: i + 1, started: i !== 13 })));
  const bad = got.map((g, i) => [i, g, snapshot[i]]).filter(([, g, s]) => !near(g, s, 0.0005));
  check('28-driver snapshot to 3 dp (non-starter #14 included)', bad.length === 0, bad.length ? JSON.stringify(bad[0]) : 'all 28');

  const four = iRatingDeltas([
    { ir: 2000, rank: 1, started: true }, { ir: 1500, rank: 2, started: true },
    { ir: 1800, rank: 3, started: true }, { ir: 1200, rank: 4, started: true },
  ]);
  check('4-starter worked example', [59.07, 29.57, -32.44, -55.19].every((v, i) => near(four[i], v, 0.006)), four.map((x) => x.toFixed(2)).join(' '));

  const dns = iRatingDeltas([
    { ir: 2000, rank: 1, started: true }, { ir: 1500, rank: 2, started: true },
    { ir: 1800, rank: 3, started: true }, { ir: 1200, rank: 4, started: false },
  ]);
  check('non-starter example', [78.93, 39.59, -43.09, -75.42].every((v, i) => near(dns[i], v, 0.006)), dns.map((x) => x.toFixed(2)).join(' '));

  const mc = iRatingDeltasByClass([
    { key: 1, classId: 1, ir: 3200, rank: 1, started: true },
    { key: 7, classId: 1, ir: 2500, rank: 2, started: true },
    { key: 9, classId: 1, ir: 2900, rank: 3, started: true },
    { key: 40, classId: 2, ir: 1800, rank: 1, started: true },
    { key: 44, classId: 2, ir: 2100, rank: 2, started: true },
    { key: 46, classId: 2, ir: 1400, rank: 3, started: true },
    { key: 48, classId: 2, ir: 1600, rank: 4, started: false },
    { key: 50, classId: 3, ir: 1500, rank: 1, started: true },
  ]);
  const want = { 1: 56, 7: 12, 9: -67, 40: 95, 44: 14, 46: -14, 48: -94 };
  check('multiclass: computed per class, rounded', Object.entries(want).every(([k, v]) => mc.get(+k) === v),
    [...mc.entries()].map(([k, v]) => `${k}:${v}`).join(' '));
  check('a class of one gets no delta', !mc.has(50));
}

/* -------------------------------------------------------------------------- */
console.log('\n2) Class labels');
{
  check('iRacing GTP stays GTP', normalizeClassFor('iracing', 'GTP') === 'GTP', normalizeClassFor('iracing', 'GTP'));
  check('iRacing names verbatim (trimmed)', normalizeClassFor('iracing', ' BMW M2 G87 ') === 'BMW M2 G87');
  check('iRacing empty is undefined', normalizeClassFor('iracing', '') === undefined);
  check('LMU path unchanged (GTP -> HYPERCAR)', normalizeClassFor('lmu', 'GTP') === 'HYPERCAR' && normalizeClass('GTP') === 'HYPERCAR');
}

/* -------------------------------------------------------------------------- */
console.log('\n3) Session-info YAML');
{
  const yaml = [
    '---', 'WeekendInfo:', ' TrackName: test track', ' TrackID: 7', ' TrackLength: 2.9455 km',
    ' TrackDisplayName: Test: Ring #1', ' TrackConfigName: ', ' Official: 1',
    ' WeekendOptions:', '  Date: 2027-04-01', 'SessionInfo:', ' CurrentSessionNum: 0', ' Sessions:',
    ' - SessionNum: 0', '   SessionLaps: unlimited', '   SessionTime: 3600.0000 sec', '   SessionType: Race',
    '   ResultsPositions:', '   - Position: 1', '     ClassPosition: 0', '     CarIdx: 3', '     ReasonOutStr: Running',
    'CameraInfo:', ' Groups:', ' - GroupNum: 1', '   GroupName: Nose: Cam',
    'DriverInfo:', ' DriverCarIdx: 3', ' PaceCarIdx: 62', ' Drivers:',
    ' - CarIdx: 3', "   UserName: O'Neil: J #2", '   TeamName: yes', '   CarNumber: "007"',
    '   CarClassShortName: GTP', '   CarClassColor: 0xff0000', '   IRating: 2500', '   LicString: A 3.45',
    '   LicColor: 0x0153db', '   IsSpectator: 0', '   CarIsPaceCar: 0', '...', '',
  ].join('\n');
  const info = parseSessionInfo(decodeSessionInfo(Buffer.from(yaml, 'latin1')));
  const d = info && info.drivers[0];
  check('parses despite unquoted ": " / "#" / quote in names', !!d && d.userName === "O'Neil: J #2", d && d.userName);
  check('a name that looks like a YAML bool stays a string', d && d.teamName === 'yes', d && d.teamName);
  check('car number keeps its leading zeros', d && d.carNumber === '007');
  check('licence colour -> #rrggbb', d && d.licColor === '#0153db', d && d.licColor);
  check('class colour parsed', d && d.carClassColor === 0xff0000);
  check('track length km -> m', info && info.trackLengthM === 2946, info && info.trackLengthM);
  check('empty TrackConfigName -> ""', info && info.trackConfig === '');
  check('display name with ": " survives', info && info.trackDisplayName === 'Test: Ring #1', info && info.trackDisplayName);
  check('YAML ClassPosition 0-based -> 1-based', info && info.sessions[0].results[0].classPosition === 1);
  check('unlimited laps -> 0, "3600.0000 sec" -> 3600', info && info.sessions[0].laps === 0 && info.sessions[0].timeSec === 3600);
  check('CameraInfo dropped before parsing', !repairSessionYaml(yaml).includes('GroupName'));
  check('cp1252 decode (0x80 = euro sign)', decodeSessionInfo(Buffer.from([0x80, 0x41])) === '€A');

  // Parse time over every captured revision.
  const zlib = require('zlib');
  const files = fs.readdirSync(captureDir).filter((f) => /^session-\d+\.yaml(\.gz)?$/.test(f));
  const times = [];
  let parsed = 0;
  for (const f of files) {
    let raw = fs.readFileSync(path.join(captureDir, f));
    if (f.endsWith('.gz')) raw = zlib.gunzipSync(raw);
    const bytes = Buffer.from(raw.toString('utf8'), 'latin1');
    const t0 = process.hrtime.bigint();
    const i = parseSessionInfo(decodeSessionInfo(bytes));
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (i && i.drivers.length > 0) parsed++;
  }
  check(`every captured revision parses (${files.length})`, parsed === files.length, `${parsed}/${files.length}`);
  const warm = times.slice(1);
  const max = Math.max(...warm);
  const avg = warm.reduce((a, b) => a + b, 0) / warm.length;
  check('warm parse under the 8 ms main-thread budget', max < 8, `first ${times[0].toFixed(1)} ms, warm avg ${avg.toFixed(2)} ms, max ${max.toFixed(2)} ms`);
}

/* -------------------------------------------------------------------------- */
console.log('\n4) Lap gate (iRacing publishes the lap time ~2 s after the count)');
{
  const g = new LapGate();
  g.update(3, 95.1, 0);
  check('first sighting adopts the count', g.laps === 3 && g.last === 95.1);
  g.update(4, 95.1, 100);
  check('count held while the time is stale', g.laps === 3);
  g.update(4, 93.9, 1800);
  check('released with the NEW time', g.laps === 4 && g.last === 93.9);
  g.update(5, 93.9, 2000);
  g.update(5, 93.9, 5200);
  check('released untimed after the settle window', g.laps === 5 && g.last === UNKNOWN);
  g.update(-1, -1, 5300);
  check('not-in-world (-1) is ignored', g.laps === 5);
}

/* -------------------------------------------------------------------------- */
let laps = [];
let onTrackFrame = null;
let onTrackYaml = null;
for (const dir of [fixtureDir, ...extraCaptures]) {
  const isFixture = dir === fixtureDir;
  console.log(`\n5) Replay of ${path.relative(process.cwd(), dir) || dir}`);
  const runLaps = [];
  replay(dir, runLaps, isFixture);
  if (isFixture) laps = runLaps;
  else console.log(`        laps logged: ${runLaps.map((l) => `${l.lapMs}:${l.dirty.join('+') || 'clean'}`).join(' ') || 'none'}`);
}

function replay(dir, laps, isFixture) {
  const src = new CaptureSource(dir);
  const p = new IRacingProvider({ verbose: false }, { source: src, lapSink: (r) => laps.push(r) });
  p.start();
  const problems = {};
  const bad = (k, detail) => {
    if (!problems[k]) problems[k] = { n: 0, first: detail };
    problems[k].n++;
  };
  let frames = 0;
  let live = 0;
  let threw = 0;
  let raceFramesWithDelta = 0;
  let raceFrames = 0;
  let relFrames = 0;
  let focusInWorld = 0;
  let maxPerLap = -1;
  const phases = new Set();
  const types = new Set();
  let lastNow = 0;
  let snap = null;
  while (!src.done()) {
    const t = src.peekTime();
    const now = Number.isFinite(t) ? t : lastNow + 100;
    lastNow = now;
    let fr;
    try {
      fr = p.poll(now, 100);
    } catch (e) {
      threw++;
      continue;
    }
    if (src.done()) break;
    frames++;
    if (!fr.connected) continue;
    live++;
    snap = p.snapshot();
    const info = p.sessionInfo.current();
    phases.add(fr.session.phase);
    types.add(fr.session.type);
    const s = fr.standings;

    // Standings: one row per real entrant, nobody else.
    const entrants = info.drivers.filter((d) => !d.isSpectator && !d.isPaceCar && d.carIdx !== info.paceCarIdx);
    if (s.length !== entrants.length) bad('standings count != entrants', `${s.length} vs ${entrants.length}`);
    const excluded = new Set(info.drivers.filter((d) => d.isSpectator || d.isPaceCar).map((d) => d.carIdx).concat([info.paceCarIdx]));
    if (s.some((r) => excluded.has(r.slotId))) bad('pace car / spectator in standings');
    // Positions 1..N in order.
    if (!s.every((r, i) => r.position === i + 1)) bad('positions not 1..N in order');
    // Exactly one player row, and it is the player block's car.
    const players = s.filter((r) => r.isPlayer);
    if (players.length !== 1) bad('isPlayer rows != 1', players.length);
    else if (players[0].slotId !== fr.player.slotId) bad('player.slotId != isPlayer row');
    // Class positions 1-based and contiguous within each class.
    const byClass = {};
    for (const r of s) (byClass[r.carClass] = byClass[r.carClass] || []).push(r.classPosition);
    for (const [c, list] of Object.entries(byClass)) {
      if (!list.every((v, i) => v === i + 1)) bad('class positions not 1..n', c);
    }
    if (s.some((r) => r.carClass === 'HYPERCAR')) bad('LMU normaliser relabelled an iRacing class');
    // Identity extras.
    for (const r of s) {
      const d = info.drivers.find((x) => x.carIdx === r.slotId);
      if (d.iRating > 0 && r.iRating !== d.iRating) bad('iRating missing/wrong', r.slotId);
      if (r.license && !/^#[0-9a-f]{6}$/.test(r.license.color || '')) bad('licence colour not #rrggbb', r.license.color);
      if (d.licString && (!r.license || r.license.text !== d.licString)) bad('licence text missing', r.slotId);
      if (info.numCarClasses === 1 && r.classColor !== undefined) bad('single-class session sent a class colour');
      if (typeof r.lapFraction === 'number' && (r.lapFraction < 0 || r.lapFraction > 1)) bad('lapFraction out of range');
      if (r.bestLapSec !== UNKNOWN && !(r.bestLapSec > 30 && r.bestLapSec < 300)) bad('best lap implausible', r.bestLapSec);
    }
    if (s[0] && s[0].gapToLeaderSec !== 0) bad('leader gap not 0');
    // iRating deltas: official races only.
    if (fr.session.type === 'race') {
      raceFrames++;
      if (s.filter((r) => r.iRating).every((r) => typeof r.iRatingDelta === 'number')) raceFramesWithDelta++;
    } else if (s.some((r) => r.iRatingDelta !== undefined)) bad('iRatingDelta outside a race');
    // Relative: LMU order (gaps descending), player row at 0, <= 3 each side.
    const rel = fr.relative;
    if (players[0] && typeof players[0].lapFraction === 'number') focusInWorld++;
    if (rel.length) {
      relFrames++;
      const me = rel.findIndex((r) => r.isPlayer);
      if (me < 0 || rel[me].relativeGapSec !== 0) bad('relative has no player row at gap 0');
      if (!rel.every((r, i) => i === 0 || rel[i - 1].relativeGapSec >= r.relativeGapSec)) bad('relative not ordered ahead->behind', rel.map((r) => r.relativeGapSec).join(','));
      if (me > 3 || rel.length - me - 1 > 3) bad('relative > 3 each side');
      if (rel.some((r) => !r.isPlayer && excluded.has(r.slotId))) bad('pace car in relative');
      if (rel.some((r) => Math.abs(r.relativeGapSec) > 60)) bad('relative gap beyond half a lap', Math.max(...rel.map((r) => Math.abs(r.relativeGapSec))));
    }
    // Fuel.
    const fu = fr.fuel;
    if (fu.levelLiters !== UNKNOWN && !(fu.levelLiters >= 0 && fu.levelLiters <= fu.capacityLiters + 0.01)) bad('fuel level outside 0..capacity', fu.levelLiters);
    if (fu.perLapAvgLiters !== UNKNOWN) {
      if (!(fu.perLapAvgLiters > 0.3 && fu.perLapAvgLiters < 5)) bad('fuel per lap implausible', fu.perLapAvgLiters);
      maxPerLap = Math.max(maxPerLap, fu.perLapAvgLiters);
    }
    // Player block sanity.
    const pl = fr.player;
    if (!(pl.pedals.clutch >= 0 && pl.pedals.clutch <= 1 && pl.pedals.steer >= -1 && pl.pedals.steer <= 1)) bad('pedals out of range');
    if (pl.speedKph < 0 || pl.speedKph > 400) bad('speed implausible', pl.speedKph);
    if (typeof pl.finished !== 'boolean') bad('player.finished not published');
    // Map + radar (wired 2026-11-10): every car on the map sits on the outline
    // by lap fraction (iRacing has no world x/y), and the radar exists only
    // for the driven car while it is on track.
    if (fr.trackMap) {
      for (const c of fr.trackMap.cars) {
        if (c.x !== undefined || !(c.lapFraction >= 0 && c.lapFraction <= 1)) bad('trackMap car not placed by lapFraction', c);
      }
    }
    if (fr.radar && !fr.session.onTrack) bad('radar while not on track');
    if (fr.session.onTrack && fr.player.slotId === p.snapshot().playerCarIdx && !pl.motion) bad('no motion while on track');
    if (isFixture && fr.session.onTrack && pl.speedKph > 100 && !onTrackFrame) {
      onTrackFrame = JSON.parse(JSON.stringify(src.raw()));
      onTrackYaml = src.readSessionInfo();
    }
  }
  check('replay produced live frames, none threw', live > 0 && threw === 0, `${live}/${frames} live, ${threw} threw`);
  for (const [k, v] of Object.entries(problems)) check(k, false, `${v.n} frames, first: ${v.first}`);
  if (Object.keys(problems).length === 0) check('per-frame invariants held on every live frame', true, `${live} frames`);
  const official = !!(p.sessionInfo.current() && p.sessionInfo.current().official);
  if (isFixture) {
    check('sessions seen: practice, qualifying, race', ['practice', 'qualifying', 'race'].every((t) => types.has(t)), [...types].join(','));
    check('phases seen include garage, green, checkered', ['garage', 'green', 'checkered'].every((t) => phases.has(t)), [...phases].join(','));
    check('fuel per lap measured from FuelLevel deltas (~1.4 L, BMW M2)', maxPerLap > 1.2 && maxPerLap < 1.7, maxPerLap);
  } else {
    console.log(`        sessions ${[...types].join(',')}; phases ${[...phases].join(',')}; fuel/lap max ${maxPerLap}`);
  }
  check('relative populated whenever the focus car is on the circuit', relFrames >= focusInWorld && (!isFixture || relFrames > 100), `${relFrames} frames with rows, ${focusInWorld} with the focus car placed`);
  if (raceFrames > 0 && official) {
    check('iRatingDelta on every rated row in (official) race frames', raceFramesWithDelta === raceFrames, `${raceFramesWithDelta}/${raceFrames}`);
  }
  check('tick snapshot exposed for map/radar', !!snap && snap.carIdxLapDistPct.length === 64 && snap.trackLengthM > 0 && typeof snap.carLeftRight === 'number' && snap.epoch >= 1, snap && `${snap.trackLengthM} m, epoch ${snap.epoch}`);
  const st = p.sessionInfoStats();
  check('session info parsed only on change, debounced', st.parses > 1 && st.parses <= 200, `${st.parses} parses, max ${st.maxMs.toFixed(1)} ms`);
}

/* -------------------------------------------------------------------------- */
console.log('\n6) Lap log');
{
  check('laps written from the capture', laps.length >= 3, laps.length);
  check('…as sim iracing, track key ir-<TrackID>', laps.every((l) => l.sim === 'iracing' && l.trackKey === 'ir-439'), laps.map((l) => l.trackKey).join(','));
  check('…track/car/class identity', laps.every((l) => l.track === 'Winton Motor Raceway - National' && l.car === 'BMW M2 Racing (G87)' && l.carClass === 'BMW M2 G87'));
  const times = laps.map((l) => l.lapMs);
  check('…with the sim\'s own lap times (not the previous lap\'s)', [95156, 93908, 102245].every((t) => times.includes(t)), times.join(','));
  check('…the clean laps are clean', laps.filter((l) => [95156, 93908].includes(l.lapMs)).every((l) => l.clean), laps.map((l) => `${l.lapMs}:${l.dirty.join('+') || 'clean'}`).join(' '));
  check('…fuel used per lap recorded', laps.some((l) => l.fuelUsedL > 1 && l.fuelUsedL < 2), laps.map((l) => l.fuelUsedL).join(','));
  check('…session types recorded', laps.some((l) => l.sessionType === 'qualifying') && laps.some((l) => l.sessionType === 'race'));

  // The clean-lap rule on a scripted stint over a real on-track frame.
  if (!onTrackFrame) {
    check('found an on-track frame to script from', false);
  } else {
    const base = onTrackFrame;
    let cur = null;
    const frameOf = (o) => ({
      tick: o._tick,
      has: (n) => o[n] !== undefined,
      count: (n) => (Array.isArray(o[n]) ? o[n].length : o[n] === undefined ? 0 : 1),
      num: (n, i = 0) => {
        let v = o[n];
        if (Array.isArray(v)) v = v[i];
        return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : NaN;
      },
      bool(n, i) {
        const v = this.num(n, i);
        return Number.isFinite(v) && v !== 0;
      },
    });
    let down = false;
    const source = {
      open: () => true, close() {}, isOpen: () => true, connected: () => !down,
      read: () => (down ? null : frameOf(cur)), sessionInfoUpdate: () => (down ? -1 : 1),
      readSessionInfo: () => (down ? null : onTrackYaml),
    };
    const scripted = [];
    const p2 = new IRacingProvider({ verbose: false }, { source, lapSink: (r) => scripted.push(r) });
    p2.start();
    let now = 1e12;
    let tick = 1;
    const step = (patch, ms = 1000) => {
      now += ms;
      cur = Object.assign({}, base, { _tick: tick++, IsOnTrack: true, IsReplayPlaying: false, OnPitRoad: false, PlayerCarInPitStall: false, PlayerTrackSurface: 3, CamCarIdx: base.PlayerCarIdx }, state, patch);
      p2.poll(now, ms);
    };
    const state = { LapCompleted: -1, LapLastLapTime: 0, PlayerCarMyIncidentCount: 0, FuelLevel: 30 };
    for (let i = 0; i < 5; i++) step({});
    // Laps: 1 clean, 2 incident, 3 pit road, 4 off track, 5 clean.
    const events = [null, null, 'incident', 'pit', 'off', null];
    for (let lap = 0; lap < events.length; lap++) {
      state.LapCompleted = lap; // the line
      for (let i = 0; i < 2; i++) step({}); // the time lags the count
      state.LapLastLapTime = lap === 0 ? 0 : 90 + lap;
      for (let i = 0; i < 60; i++) {
        const ev = events[lap + 1];
        const mid = i >= 25 && i < 28;
        if (ev === 'incident' && i === 25) state.PlayerCarMyIncidentCount++;
        state.FuelLevel -= 0.02;
        step(mid && ev === 'pit' ? { OnPitRoad: true } : mid && ev === 'off' ? { PlayerTrackSurface: 0 } : {});
      }
    }
    for (let i = 0; i < 60; i++) step({}); // let the lap log's verdict hold expire
    const v = Object.fromEntries(scripted.map((r) => [r.lapMs, r.dirty.join('+') || 'clean']));
    check('untimed pit-exit stretch is not written', !scripted.some((r) => r.lapMs === 0), Object.keys(v).join(','));
    check('a clean lap is clean', v[91000] === 'clean' && v[95000] === 'clean', JSON.stringify(v));
    check('incident count rose -> dirty (penalty)', v[92000] === 'penalty', v[92000]);
    check('pit road during the lap -> dirty (pit)', (v[93000] || '').includes('pit'), v[93000]);
    check('off-track surface -> dirty (limits)', v[94000] === 'limits', v[94000]);

    // iRacing exits mid-session (header zeroed): demo frame, no throw, and a
    // fresh start — new epoch, session info re-read — when it comes back.
    const epoch0 = p2.snapshot().epoch;
    down = true;
    now += 100;
    const off = p2.poll(now, 100);
    check('disconnect -> demo frame, snapshot cleared', off.connected === false && p2.snapshot() === null);
    down = false;
    step({});
    const parsesBefore = p2.sessionInfoStats().parses;
    check('reconnect -> live again with a new epoch', p2.isConnected() && p2.snapshot().epoch === epoch0 + 1, `${epoch0} -> ${p2.snapshot() && p2.snapshot().epoch}`);
    check('reconnect -> session info parsed from scratch', parsesBefore >= 2, parsesBefore);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
