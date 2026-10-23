/**
 * scripts/test-penalties.js — outstanding penalties for every car, on the wire.
 * -----------------------------------------------------------------------------
 * The standings tower badges any car that still owes a penalty, so a driver can
 * see that the car in front has a stop to make. This pins the server half:
 *
 *   1. the pure helpers (telemetry/penalties.ts) — what counts as a count, what
 *      names a kind, and that a kind is only ever attached beside a count;
 *   2. the LMU REST mapping — every row's `penalties` reaches its StandingEntry,
 *      clear cars carry nothing, retired cars carry nothing, and OUR car's kind
 *      (pit menu / trace) lands on our row only, only for a single penalty;
 *   3. the replay mapping — LiveStandings' `penalties: {DT, SG, TIME}` gives a
 *      count AND a kind for every car, against the real Road Atlanta capture
 *      with penalties injected (the capture itself has all zeros).
 *
 * The failure that matters is a WRONG KIND: "SG" over a car serving a
 * drive-through is worse than "PEN". So every kind assertion has a twin that
 * proves the kind is withheld when the source cannot vouch for it.
 *
 * Run: node scripts/test-penalties.js   (needs a built dist/)
 */

'use strict';

const path = require('node:path');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? `   [${detail}]` : ''));
  ok ? pass++ : fail++;
};
const show = (v) => JSON.stringify(v);

const dist = path.join(__dirname, '..', 'dist', 'telemetry');
const pen = require(path.join(dist, 'penalties.js'));
const rf = require(path.join(dist, 'replayFeed.js'));
const { LmuRestProvider } = require(path.join(dist, 'lmuRestProvider.js'));
const fx = require('./fixtures/replay-ws-road-atlanta.json');

/* -------------------------------------------------------------------------- */
console.log('\npenaltyCount — only a real, positive count is a penalty');
check('1 → 1', pen.penaltyCount(1) === 1);
check('3 → 3', pen.penaltyCount(3) === 3);
check('0 → none', pen.penaltyCount(0) === undefined);
check('-1 (unpopulated record) → none', pen.penaltyCount(-1) === undefined);
check('NaN → none', pen.penaltyCount(Number.NaN) === undefined);
check('a string is not a count', pen.penaltyCount('1') === undefined);
check('missing → none', pen.penaltyCount(undefined) === undefined);
check('a torn read (32767) is not 32767 penalties', pen.penaltyCount(32767) === undefined);

/* -------------------------------------------------------------------------- */
console.log('\npenaltyKindFromType — our car, in the sim\'s own words');
check('pit menu "STOP/GO" → stop-go', pen.penaltyKindFromType('STOP/GO') === 'stop-go');
check('trace "STOP/GO 10S" → stop-go', pen.penaltyKindFromType('STOP/GO 10S') === 'stop-go');
check('"Stop-Go" spelling → stop-go', pen.penaltyKindFromType('Stop-Go') === 'stop-go');
check('pit menu "DRIVE THRU" → drive-through', pen.penaltyKindFromType('DRIVE THRU') === 'drive-through');
check('trace "DRIVE THROUGH" → drive-through', pen.penaltyKindFromType('DRIVE THROUGH') === 'drive-through');
check('generic "PENALTY" row names no kind', pen.penaltyKindFromType('PENALTY') === undefined);
check('"DISQUALIFIED" names no kind', pen.penaltyKindFromType('DISQUALIFIED') === undefined);
check('nothing → nothing', pen.penaltyKindFromType(undefined) === undefined);

/* -------------------------------------------------------------------------- */
console.log('\nliveStandingsPenalties — LiveStandings {DT, SG, TIME}');
check('all zero (the real capture) → none', pen.liveStandingsPenalties({ DT: 0, SG: 0, TIME: 0 }) === undefined);
check('DT 1 → one drive-through', show(pen.liveStandingsPenalties({ DT: 1, SG: 0, TIME: 0 })) === show({ count: 1, kind: 'drive-through' }));
check('SG 2 → two stop/gos', show(pen.liveStandingsPenalties({ DT: 0, SG: 2, TIME: 0 })) === show({ count: 2, kind: 'stop-go' }));
check('DT 1 + SG 1 → two, kind withheld', show(pen.liveStandingsPenalties({ DT: 1, SG: 1, TIME: 0 })) === show({ count: 2 }));
check('TIME alone is not a lane penalty (LMU\'s own hasPenalty ignores it)', pen.liveStandingsPenalties({ DT: 0, SG: 0, TIME: 5 }) === undefined);
check('a bare number is not the object', pen.liveStandingsPenalties(1) === undefined);
check('missing → none', pen.liveStandingsPenalties(undefined) === undefined);

/* -------------------------------------------------------------------------- */
console.log('\npenaltyFields — what a row carries');
check('clear car carries nothing', show(pen.penaltyFields(undefined, undefined)) === '{}');
check('count alone', show(pen.penaltyFields(2, undefined)) === show({ penalties: 2 }));
check('count + kind', show(pen.penaltyFields(1, 'stop-go')) === show({ penalties: 1, penaltyKind: 'stop-go' }));
check('a kind with no count is dropped', show(pen.penaltyFields(undefined, 'stop-go')) === '{}');
check('a retired car owes nothing', show(pen.penaltyFields(1, 'drive-through', true)) === '{}');

/* -------------------------------------------------------------------------- */
console.log('\nLMU REST → standings rows');
/** A REST standings row with only what buildStandings reads. */
const rest = (slotID, position, extra) => ({
  slotID,
  position,
  driverName: `Driver ${slotID}`,
  carNumber: String(slotID),
  carClass: 'GT3',
  bestLapTime: 100,
  lastLapTime: 101,
  timeBehindLeader: position - 1,
  timeBehindNext: position === 1 ? 0 : 1,
  lapsBehindLeader: 0,
  lapsCompleted: 10,
  ...extra,
});
const UNKNOWN = -1;
{
  const p = new LmuRestProvider({ verbose: false });
  const cars = [
    rest(1, 1, { penalties: 0 }),
    rest(2, 2, { penalties: 1 }), // a rival owing one: count, no kind
    rest(3, 3, { penalties: 2 }), // a rival owing two
    rest(4, 4, {}), // no field at all (an older build / another sim)
    rest(5, 5, { penalties: 1, finishStatus: 'FSTAT_DQ' }), // disqualified
    rest(6, 6, { penalties: 1, player: true }), // us
  ];
  const rows = p.buildStandings(cars, 6, 6, 'atl|RACE1', 4000, UNKNOWN);
  const by = new Map(rows.map((r) => [r.slotId, r]));
  check('a clear car carries no penalty field', !('penalties' in by.get(1)) && !('penaltyKind' in by.get(1)));
  check('a rival owing one: count 1', by.get(2).penalties === 1, by.get(2).penalties);
  check('…and NO kind — REST does not name one', by.get(2).penaltyKind === undefined);
  check('a rival owing two: count 2', by.get(3).penalties === 2);
  check('no field → no badge', by.get(4).penalties === undefined);
  check('a disqualified car owes nothing', by.get(5).penalties === undefined, show(by.get(5)));
  check('our car without a named kind: count only', by.get(6).penalties === 1 && by.get(6).penaltyKind === undefined);

  // Our car's kind, as the pit menu named it last frame.
  const named = p.buildStandings(cars, 6, 6, 'atl|RACE1', 4000, UNKNOWN, { slotId: 6, kind: 'stop-go' });
  const nb = new Map(named.map((r) => [r.slotId, r]));
  check('our row gets the pit menu\'s kind', nb.get(6).penaltyKind === 'stop-go', nb.get(6).penaltyKind);
  check('…and no rival inherits it', nb.get(2).penaltyKind === undefined && nb.get(3).penaltyKind === undefined);
  check('the memo is keyed on the kind (a fresh build, not the cached rows)', named !== rows);

  // Two owed: the menu names the NEXT one, not both — kind withheld.
  const two = cars.map((c) => (c.slotID === 6 ? { ...c, penalties: 2 } : c));
  const tb = new Map(
    p.buildStandings(two, 6, 6, 'atl|RACE1', 4000, UNKNOWN, { slotId: 6, kind: 'drive-through' }).map((r) => [r.slotId, r]),
  );
  check('our car owing two: count 2, kind withheld', tb.get(6).penalties === 2 && tb.get(6).penaltyKind === undefined, show(tb.get(6)));

  // Served: the count drops to zero and the badge's data goes with it.
  const served = cars.map((c) => (c.slotID === 6 || c.slotID === 2 ? { ...c, penalties: 0 } : c));
  const sb = new Map(
    p.buildStandings(served, 6, 6, 'atl|RACE1', 4000, UNKNOWN, { slotId: 6, kind: 'stop-go' }).map((r) => [r.slotId, r]),
  );
  check('served: the rival\'s badge data is gone', sb.get(2).penalties === undefined);
  check('served: ours too, even with a stale kind still cached', sb.get(6).penalties === undefined && sb.get(6).penaltyKind === undefined);
}

/* -------------------------------------------------------------------------- */
console.log('\nReplay — LiveStandings rows (real Road Atlanta capture, penalties injected)');
{
  const push = fx.ui[0].msg.body;
  check('the capture carries the {DT, SG, TIME} object on every row', push.every((r) => r.penalties && 'DT' in r.penalties && 'SG' in r.penalties), push.length);
  const clean = rf.buildReplayField(push, new rf.ReplayTiming(), fx.trackLengthM, Number.NaN);
  check('all-zero capture → no car carries a penalty', clean.cars.every((c) => c.penalties === undefined && c.penaltyKind === undefined));

  const [a, b, c] = push.slice(0, 3).map((r) => r.slotID);
  const injected = push.map((r) => {
    if (r.slotID === a) return { ...r, penalties: { DT: 1, SG: 0, TIME: 0 } };
    if (r.slotID === b) return { ...r, penalties: { DT: 0, SG: 2, TIME: 0 } };
    if (r.slotID === c) return { ...r, penalties: { DT: 1, SG: 1, TIME: 0 } };
    return r;
  });
  const field = rf.buildReplayField(injected, new rf.ReplayTiming(), fx.trackLengthM, Number.NaN);
  const car = (slot) => field.cars.find((x) => x.slotID === slot);
  check('DT 1 → 1 drive-through', car(a).penalties === 1 && car(a).penaltyKind === 'drive-through', show([car(a).penalties, car(a).penaltyKind]));
  check('SG 2 → 2 stop/gos', car(b).penalties === 2 && car(b).penaltyKind === 'stop-go');
  check('DT 1 + SG 1 → 2, no single kind', car(c).penalties === 2 && car(c).penaltyKind === undefined);

  // …and through the provider's standings mapping, which a replay frame uses.
  const p = new LmuRestProvider({ verbose: false });
  const rows = p.buildStandings(field.cars, a, UNKNOWN, 'atl|RACE1|replay#1', fx.trackLengthM, UNKNOWN);
  const r = (slot) => rows.find((x) => x.slotId === slot);
  check('replay standings row: DT', r(a).penalties === 1 && r(a).penaltyKind === 'drive-through');
  check('replay standings row: SG×2', r(b).penalties === 2 && r(b).penaltyKind === 'stop-go');
  check('replay standings row: mixed → count only', r(c).penalties === 2 && r(c).penaltyKind === undefined);
  check('the rest of the field stays clear', rows.filter((x) => x.penalties).length === 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
