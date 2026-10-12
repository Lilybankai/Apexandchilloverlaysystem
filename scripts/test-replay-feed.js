/**
 * scripts/test-replay-feed.js — LMU's replay websockets → the replay frame
 * (THE-35 follow-up).
 *
 * In a replay REST and shared memory are frozen at the loaded session's start;
 * the live replay data is LMU's own broadcast feed on :6398 (LiveStandings +
 * replaymetrics). Pins, against a real capture
 * (scripts/fixtures/replay-ws-road-atlanta.json, Road Atlanta, 39 cars):
 *
 *   1. the mapping — standings order, laps down, focus car, speed units, lap
 *      distance normalisation, world positions on the track map's axes;
 *   2. the timing loops — gaps timed off the replay clock agree with LMU's own
 *      figure where LMU's is valid, lap times, torn reads, pauses, seeks;
 *   3. the socket lifecycle — inert until activated, the subscribe message,
 *      reconnect with backoff after a drop, closed and emptied on exit, never
 *      a throw into the caller.
 *
 * Run: node scripts/test-replay-feed.js   (needs a built dist/)
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? `   [${detail}]` : ''));
  ok ? pass++ : fail++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const rf = require(path.join(__dirname, '..', 'dist', 'telemetry', 'replayFeed.js'));
const fx = require('./fixtures/replay-ws-road-atlanta.json');
const LEN = fx.trackLengthM;
const UNKNOWN = -1;
const etOf = (m) => m.msg.body.replayStartET + m.msg.body.currentReplayPos;

/* -------------------------------------------------------------------------- */
console.log('\nhelpers');
check('negative lapDist is distance TO the line', near(rf.normaliseLapDist(-807.4, LEN), LEN - 807.4, 1e-6));
check('positive lapDist passes through', rf.normaliseLapDist(194, LEN) === 194);
check('race distance = laps × length + way round', near(rf.raceDistance(250, -807.4, LEN), 250 * LEN + LEN - 807.4, 1e-6));
check('mph → km/h', near(rf.metricsSpeedKph({ speed: 100, speedUnit: 'mph' }), 160.9344, 1e-6));
check('kph stays', rf.metricsSpeedKph({ speed: 200, speedUnit: 'kph' }) === 200);
check('"km/h" spelling accepted', rf.metricsSpeedKph({ speed: 200, speedUnit: 'km/h' }) === 200);
check('unknown unit is not guessed', rf.metricsSpeedKph({ speed: 200, speedUnit: 'furlongs' }) === UNKNOWN);
check('no speed → unknown', rf.metricsSpeedKph({ speedUnit: 'mph' }) === UNKNOWN);
check('event time = replayStartET + currentReplayPos', near(rf.replayEventTime({ replayStartET: 100, currentReplayPos: 5.5 }), 105.5, 1e-9));
check('event time missing → NaN', Number.isNaN(rf.replayEventTime({ currentReplayPos: 5 })));
check('metrics match by number and class', rf.metricsMatchCar({ vehicleNumber: 399, replayDriverClass: 'GT3' }, { carNumber: '399', carClass: 'GT3' }));
check('same number, other class: not the same car', !rf.metricsMatchCar({ vehicleNumber: 7, replayDriverClass: 'GT3' }, { carNumber: '7', carClass: 'Hyper' }));
check('other number: no', !rf.metricsMatchCar({ vehicleNumber: 98, replayDriverClass: 'GT3' }, { carNumber: '399', carClass: 'GT3' }));

/* -------------------------------------------------------------------------- */
console.log('\nmapping — a real LiveStandings push');
const push0 = fx.ui[0].msg.body;
const m0 = fx.replaymetrics[0].msg.body;
{
  const field = rf.buildReplayField(push0, new rf.ReplayTiming(), LEN, Number.NaN);
  const cars = field.cars;
  const bySlot = new Map(cars.map((c) => [c.slotID, c]));
  const sorted = [...cars].sort((a, b) => a.position - b.position);
  check('every car mapped', cars.length === 39, cars.length);
  check('P1 is the overall leader (Chastain, Hyper, 284 laps)', sorted[0].slotID === 3 && sorted[0].driverName === 'Oliver Chastain' && sorted[0].lapsCompleted === 284);
  check('positions are the feed’s, 1..39 without gaps', sorted.every((c, i) => c.position === i + 1));
  check('the leader is on 0 laps down / 0 s', sorted[0].lapsBehindLeader === 0 && sorted[0].timeBehindLeader === 0);
  check('P2 Hyper is 6 laps down (284 vs 278)', bySlot.get(36).lapsBehindLeader === 6, bySlot.get(36).lapsBehindLeader);
  check('lapped car: no seconds gap claimed', bySlot.get(36).timeBehindLeader === 0);
  check('untimed yet: no last lap invented (feed has −1 for all)', cars.every((c) => c.lastLapTime === UNKNOWN));
  check('class leader of GT3 is P3 (slot 9), 0 behind its class', bySlot.get(9).lapsBehindClassLeader === 0 && bySlot.get(9).timeBehindClassLeader === 0);
  check('P6 GT3 laps down to its class leader (262 vs 250 → 11 full)', bySlot.get(2).lapsBehindClassLeader === 11, bySlot.get(2).lapsBehindClassLeader);
  const focusRows = cars.filter((c) => c.hasFocus);
  check('focus = slotHasFocus row = REST focus slot', focusRows.length === 1 && String(focusRows[0].slotID) === fx.restFocus);
  const f = bySlot.get(2);
  check('focus car identity', f.driverName === 'M Aranguren' && f.carNumber === '399' && f.carClass === 'GT3');
  check('metrics describe the focus car', rf.metricsMatchCar(m0, f));
  check('lapDist normalised to 0..length', cars.every((c) => c.lapDistance >= 0 && c.lapDistance <= LEN));
  check('focus lapDist −174 → 3909 m', near(f.lapDistance, LEN - 174.428, 0.01), f.lapDistance);
  const mph = f.carVelocity.velocity * 2.2369;
  check('|localVel| agrees with the replaymetrics mph', near(mph, m0.speed, 2.5), `${mph.toFixed(1)} vs ${m0.speed.toFixed(1)}`);
  check('garage cars flagged in the garage', bySlot.get(33).inGarageStall === true && bySlot.get(3).inGarageStall === false);
  check('a constant VE of 100 is not published as a reading', cars.every((c) => c.veFraction === undefined));
  check('pit state 0 makes no claim', cars.every((c) => c.pitState === undefined));
  check('team and grid position carried', f.fullTeamName !== undefined && typeof f.qualification === 'number');

  // Map axes: posX/posZ against the bundled Road Atlanta line.
  const map = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'trackmaps', 'michelin-raceway-road-atlanta-4080.json'), 'utf8'));
  let worst = 0;
  let worstIdx = 0;
  let moving = 0;
  for (const r of push0) {
    if (r.inGarage || Math.hypot(r.localVelX, r.localVelZ) < 5) continue;
    moving++;
    const p = field.positions.get(r.slotID);
    let best = Infinity;
    let bi = -1;
    map.points.forEach((q, i) => {
      const d = Math.hypot(q[0] - p.x, q[1] - p.z);
      if (d < best) { best = d; bi = i; }
    });
    if (best > worst) worst = best;
    // The nearest point of the line is the car's own lap distance (bins of binM).
    const along = Math.abs(bi * map.binM - bySlot.get(r.slotID).lapDistance);
    const wrapped = Math.min(along, LEN - along);
    if (wrapped > worstIdx) worstIdx = wrapped;
  }
  check('moving cars found', moving >= 6, moving);
  check('posX/posZ land on the map’s own x/z line (within 25 m)', worst < 25, worst.toFixed(1));
  check('…at the point matching their lap distance (within 60 m)', worstIdx < 60, worstIdx.toFixed(1));
}

/* -------------------------------------------------------------------------- */
console.log('\ntiming loops — gaps off the replay clock');
{
  const t = new rf.ReplayTiming();
  const ui1 = fx.ui[1];
  const et1 = etOf(fx.replaymetrics[1]);
  for (const s of fx.track) {
    if (s.t > ui1.t) break;
    t.update(s.rows.map(([slotId, laps, lapDist]) => ({ slotId, laps, lapDist })), s.et, LEN);
  }
  const field = rf.buildReplayField(ui1.msg.body, t, LEN, et1);
  const by = new Map(field.cars.map((c) => [c.slotID, c]));
  // Feed the whole push too (the other cars) so the field is current.
  t.update(ui1.msg.body.map((r) => ({ slotId: r.slotID, laps: r.currentLapsCompleted, lapDist: r.lapDist, inGarage: r.inGarage })), et1 + 0.001, LEN);
  const lmu = ui1.msg.body.find((r) => r.slotID === 32);
  const ours = by.get(32).timeBehindNext;
  // LMU's own `timeBehindNext` is only meaningful for a car on the same lap as
  // the one ahead (lapsBehindNext 0), as P7 is here. Over the whole capture it
  // read a steady 16.3–16.5 s where the timing loops (the replay clock at the
  // two cars' positions, re-derived independently from the raw 7 Hz feed)
  // read 17.1–17.3 s: the same gap, LMU's figure ~5% short by its own method.
  // Pinned as "the same gap", not "the same number".
  check('P7 → P6 interval (same lap) is the gap LMU reports, timed', near(ours, lmu.timeBehindNext, 1.25), `${ours.toFixed(2)} vs LMU ${lmu.timeBehindNext.toFixed(2)}`);
  check('…timed off the replay clock (17.1–17.3 s across the capture)', ours > 16.9 && ours < 17.5, ours.toFixed(2));
  check('lapped interval stays unknown (P6 is a lap+ behind P5)', by.get(2).timeBehindNext === 0);
  const rel32 = rf.replayRoadGap(t, field, 2, 32, LEN, et1);
  check('relative: P7 is behind the camera car on the road by the same interval', rel32 !== null && rel32 < 0 && near(-rel32, ours, 0.3), rel32 && rel32.toFixed(2));
  const rel3 = rf.replayRoadGap(t, field, 2, 3, LEN, et1);
  check('relative: the leader alongside on the road reads ~0 s', rel3 !== null && Math.abs(rel3) < 1.0, rel3 && rel3.toFixed(2));
  const rel36 = rf.replayRoadGap(t, field, 2, 36, LEN, et1);
  check('relative: a car not passed yet in this window reads null, not a guess', rel36 === null || Number.isFinite(rel36));
  check('one crossing seen is not a lap time', t.lastLap(2) === UNKNOWN);
}
{
  // Synthetic: a car at a steady 50 m/s for two and a half laps.
  const t = new rf.ReplayTiming();
  const v = 50;
  let et = 1000;
  for (let i = 0; i < 2.5 * LEN / v / 0.15; i++) {
    et += 0.15;
    const rd = (et - 1000) * v;
    t.update([{ slotId: 1, laps: Math.floor(rd / LEN), lapDist: rd % LEN }], et, LEN);
  }
  check('lap timed between two observed crossings', near(t.lastLap(1), LEN / v, 0.02), t.lastLap(1).toFixed(3));
  const before = t.lastLap(1);
  t.update([{ slotId: 1, laps: 2, lapDist: 100 }], et, LEN); // same ET = paused
  check('paused (event time not moving): nothing recorded', t.lastLap(1) === before);
  // Torn read at the line: lap count a push early → one skipped sample, not a reset.
  const t2 = new rf.ReplayTiming();
  let e2 = 50;
  const feed = (laps, d) => t2.update([{ slotId: 4, laps, lapDist: d }], (e2 += 0.15), LEN);
  for (let d = LEN - 200; d < LEN - 5; d += 7.5) feed(3, d);
  feed(4, LEN - 3); // laps ticked, distance not yet
  for (let d = 2; d < 200; d += 7.5) feed(4, d);
  check('torn line read skipped, history kept across it', t2.timeAt(4, 3 * LEN + LEN - 100) !== null);
  // A car moved back to its box: five implausible reads restart its history.
  for (let i = 0; i < 5; i++) feed(1, 50);
  check('teleport: history restarted after a run of implausible reads', t2.timeAt(4, 3 * LEN + LEN - 100) === null);
  // Backwards event time is a seek: everything goes.
  const t3 = new rf.ReplayTiming();
  t3.update([{ slotId: 9, laps: 1, lapDist: 10 }], 500, LEN);
  t3.update([{ slotId: 9, laps: 1, lapDist: 20 }], 500.2, LEN);
  t3.update([{ slotId: 9, laps: 0, lapDist: 10 }], 100, LEN);
  check('event time going backwards resets the loops', t3.timeAt(9, LEN + 15) === null);
}

/* -------------------------------------------------------------------------- */
console.log('\ncamera car physics + session clock');
{
  const et = etOf(fx.replaymetrics[0]);
  const p = rf.metricsPhysics(m0, et);
  check('speed converted from mph', p.speedKph === Math.round(m0.speed * 1.609344), p.speedKph);
  check('gear / rpm / max rpm', p.gear === m0.gear && p.rpm === m0.rpm && p.maxRpm === m0.maxRPM);
  check('pedals + steering', p.throttle === m0.throttle && p.brake === m0.brakes && p.steer === m0.steering);
  check('fuel / hybrid / tyres stay unknown', p.fuelLiters === UNKNOWN && p.batteryCharge === UNKNOWN && p.tyreHudTempsC.every((x) => x === UNKNOWN));
  check('no motion / chassis / aids invented', p.motion === null && p.chassis === null && p.aidSettings === null);
  check('time into lap from the sim', p.lapTimeSec === m0.timeIntoLap);
  check('−1 at the line reads unknown', rf.metricsPhysics({ ...m0, timeIntoLap: -1 }, et).lapTimeSec === UNKNOWN);

  check('time remaining = booked end − replay clock', rf.replayTimeRemaining(et, fx.endEventTime, m0) === Math.round(fx.endEventTime - et), rf.replayTimeRemaining(et, fx.endEventTime, m0));
  check('a recording that outlasts the booked session is not that session', rf.replayTimeRemaining(et, 3600, m0) === UNKNOWN);
  check('no replay clock → unknown', rf.replayTimeRemaining(Number.NaN, 36000, m0) === UNKNOWN);
  check('phase: nobody with a lap → not claimed', rf.replayPhase([{ lapsCompleted: 0 }]) === 'unknown');
  check('phase: a lap on the board → green', rf.replayPhase([{ lapsCompleted: 3 }]) === 'green');
  check('phase: a FINISHED verdict → chequered', rf.replayPhase([{ lapsCompleted: 3, finishStatus: 'FSTAT_FINISHED' }]) === 'checkered');
}

/* -------------------------------------------------------------------------- */
console.log('\nsockets — lifecycle');

/** A fake ws client: records sends, lets the test fire events. */
function fakeFactory() {
  const made = [];
  const factory = (url) => {
    const handlers = {};
    const s = {
      url, sent: [], closed: false,
      on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
      send(d) { s.sent.push(d); },
      close() { s.closed = true; },
      terminate() { s.closed = true; },
      fire(ev, arg) { for (const fn of handlers[ev] || []) fn(arg); },
    };
    made.push(s);
    return s;
  };
  return { made, factory };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  {
    const { made, factory } = fakeFactory();
    const feed = new rf.ReplayFeed({ port: 6398, factory });
    check('constructed: no socket opened', made.length === 0 && feed.opened === 0);
    feed.setActive(false);
    check('deactivating an inactive feed opens nothing', made.length === 0);
    feed.setActive(true);
    const urls = made.map((s) => s.url).sort();
    check('activated: both sockets on REST port + 1', urls.join() === 'ws://127.0.0.1:6398/websocket/replaymetrics,ws://127.0.0.1:6398/websocket/ui', urls.join());
    feed.setActive(true);
    check('activating twice does not double up', made.length === 2);
    const ui = made.find((s) => s.url.endsWith('/ui'));
    const rm = made.find((s) => s.url.endsWith('/replaymetrics'));
    ui.fire('open');
    rm.fire('open');
    check('ui socket sends exactly the LiveStandings SUB', ui.sent.length === 1 && JSON.parse(ui.sent[0]).messageType === 'SUB' && JSON.parse(ui.sent[0]).topic === 'LiveStandings');
    check('replaymetrics socket sends nothing', rm.sent.length === 0);

    rm.fire('message', Buffer.from(JSON.stringify(fx.replaymetrics[0].msg)));
    ui.fire('message', Buffer.from(JSON.stringify(fx.ui[0].msg)));
    check('standings push held, stamped with the replay clock', feed.standings && feed.standings.rows.length === 39 && near(feed.standings.et, etOf(fx.replaymetrics[0]), 1e-6));
    check('metrics push held', feed.metrics && feed.metrics.body.gear === m0.gear);
    check('usable while the sockets are up', feed.standingsUsable(Date.now()) && feed.metricsUsable(Date.now()));
    let threw = false;
    try {
      ui.fire('message', 'not json {');
      ui.fire('message', JSON.stringify({ topic: 'Other', body: [] }));
      rm.fire('message', JSON.stringify({ type: 'replayMetrics' }));
      ui.fire('error', new Error('boom'));
    } catch {
      threw = true;
    }
    check('junk, other topics and socket errors never throw', !threw);
    check('…and never replace good data', feed.standings.rows.length === 39 && feed.metrics.body.gear === m0.gear);

    // Drop: the socket closes; data bridges briefly, then stops counting.
    ui.fire('close');
    check('dropped: still usable for a moment (reconnect bridge)', feed.standingsUsable(Date.now()));
    check('dropped: NOT usable once the push is 2 s old', !feed.standingsUsable(Date.now() + 2500));
    await sleep(1150);
    const ui2 = made.filter((s) => s.url.endsWith('/ui'));
    check('reconnects after ~1 s', ui2.length === 2, ui2.length);
    ui2[1].fire('close');
    await sleep(1150);
    check('backoff: the second retry waits longer than the first', made.filter((s) => s.url.endsWith('/ui')).length === 2);
    await sleep(1000);
    check('…and does come (2 s)', made.filter((s) => s.url.endsWith('/ui')).length === 3);
    const ui3 = made.filter((s) => s.url.endsWith('/ui'))[2];
    ui3.fire('open');
    check('reconnected socket subscribes again', ui3.sent.length === 1);

    // Exit the replay: both closed, data gone, no reconnect afterwards.
    feed.setActive(false);
    check('replay exit: open sockets closed', ui3.closed && rm.closed);
    check('replay exit: data dropped (nothing stale carries into the next replay)', feed.standings === null && feed.metrics === null && !feed.standingsUsable(Date.now()));
    const n = made.length;
    ui3.fire('close');
    await sleep(1200);
    check('replay exit: a late close does not reconnect', made.length === n);
  }
  {
    // A factory that throws (port refused synchronously, bad URL): retried, never thrown.
    let calls = 0;
    const feed = new rf.ReplayFeed({ port: 6398, factory: () => { calls++; throw new Error('ECONNREFUSED'); } });
    let threw = false;
    try { feed.setActive(true); } catch { threw = true; }
    check('socket creation failure does not throw', !threw && calls === 2);
    await sleep(1150);
    check('…and is retried with backoff', calls === 4, calls);
    feed.setActive(false);
    await sleep(2100);
    check('…and stops when the replay ends', calls === 4, calls);
  }
  {
    // A paused replay: socket up, push old — still the replay's state.
    const { made, factory } = fakeFactory();
    const feed = new rf.ReplayFeed({ port: 6398, factory });
    feed.setActive(true);
    const ui = made.find((s) => s.url.endsWith('/ui'));
    ui.fire('open');
    ui.fire('message', JSON.stringify(fx.ui[0].msg));
    check('paused (socket up, quiet): the last push still stands', feed.standingsUsable(Date.now() + 60_000));
    check('no clock moving → not playing', !feed.playing(Date.now()));
    feed.setActive(false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
