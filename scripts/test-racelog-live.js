/**
 * scripts/test-racelog-live.js — the race log's live recorder and its merge.
 * -----------------------------------------------------------------------------
 * Phase 2 of docs/RACE-LOG-PLAN.md, headless:
 *
 *   1. the recorder against hand-built frames: every flag edge, graded damage
 *      that only speaks when the car gets worse, laps, places, pit, swaps,
 *      stewards, and the incident list filtered to our car;
 *   2. the file: async writes, the reader, app-restart segments joined;
 *   3. mergeLive / matchLiveRace against a hand-built XML log;
 *   4. real races replayed through it, when they are on this machine:
 *      `recordings/*.jsonl` (frames, `scripts/record-session.js`), the
 *      2026-08-04 Daytona `~/.apex-overlay/race-probe-*.jsonl` (raw REST, two
 *      races, real incident lists), and the serve-fixture race-finish frames.
 *      A missing file is a skip, never a failure.
 *
 *   node scripts/test-racelog-live.js        (after `npm run build`)
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const {
  RaceLogRecorder,
  LiveLogWriter,
  parseLiveLog,
  loadLiveLog,
  lapTime,
} = require('../dist/telemetry/raceLogRecorder');
const { mergeLive, matchLiveRace, provisionalLog, sameTrack, writtenAt } = require('../dist/telemetry/raceLogMerge');
const { decodeDamage, damageGrade } = require('../dist/telemetry/damage');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail !== undefined ? `  (${detail})` : ''}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  A hand-built race                                                          */
/* -------------------------------------------------------------------------- */

const T0 = Date.UTC(2026, 8, 30, 18, 0, 0);

function row(over = {}) {
  return {
    slotId: 7, position: 5, driverName: 'Carl Jones', carNumber: '27', carClass: 'GT3',
    classPosition: 2, bestLapSec: -1, lastLapSec: -1, lapsCompleted: 0, inPit: false,
    isPlayer: false, ...over,
  };
}

function damage(aero, susp, parts = 0) {
  const worst = Math.max(aero, ...susp);
  return {
    aero, suspension: susp, brakeThicknessMm: [-1, -1, -1, -1], partsDetached: parts, worst,
    hasDamage: worst > 0.005, repairSeconds: 20, repairBodySeconds: 10, repairSelection: 'all',
    repairOptions: [], tyreChangeSeconds: 0, tyreCornersSelected: 0, stopLengthSeconds: 20,
    randomDelayMaxSeconds: 5,
    grades: { aero: damageGrade(aero), suspension: susp.map(damageGrade) },
  };
}

/** A race frame at `sec` seconds in; `et` runs 100 s ahead of it (the grid). */
function frame(sec, over = {}) {
  const s = over.session || {};
  const p = over.player || {};
  return {
    schemaVersion: 1,
    source: 'lmu',
    timestamp: T0 + sec * 1000,
    connected: over.connected ?? true,
    session: {
      type: 'race', phase: 'green', flag: 'green', track: 'Grand Prix of Long Beach',
      timeRemainingSec: 1000, totalLaps: 0, lapsRemaining: -1, currentLap: 1, classLeaderLap: 1,
      numCars: 3, notStarted: false, scheduledLengthSec: 3600, elapsedSec: 100 + sec,
      sectorFlags: ['none', 'none', 'none'], ...s,
    },
    player: { slotId: 1, position: 1, ...p },
    standings: over.standings || [
      row(over.me),
      row({ slotId: 23, position: 4, driverName: 'Peter Dempsey', carNumber: '23', carClass: 'HYPERCAR', classPosition: 1 }),
      row({ slotId: 9, position: 6, driverName: 'Ana Silva', carNumber: '9', classPosition: 3 }),
    ],
    relative: [],
    fuel: {},
    weather: {},
  };
}

function rig() {
  const r = new RaceLogRecorder({ identity: () => ({ slot: 7, names: ['carl jones', 'micky t'] }) });
  const lines = [];
  return {
    r,
    lines,
    feed(sec, over) {
      lines.push(...r.update(frame(sec, over)));
    },
    incidents(sec, rows) {
      lines.push(...r.noteIncidents(rows, T0 + sec * 1000));
    },
    events(kind) {
      return lines.filter((l) => l.t === 'event' && (!kind || l.kind === kind));
    },
  };
}

console.log('\n1) The recorder, frame by frame\n');

{
  const g = rig();
  // Grid, formation, then the lights.
  g.feed(0, { session: { phase: 'formation', notStarted: true } });
  check('the first race frame writes a header, nothing else', g.lines.length === 1 && g.lines[0].t === 'header');
  const h = g.lines[0];
  check('…keyed track|race|session start', h.key === `Grand Prix of Long Beach|race|${Math.round((T0 - 100000) / 1000)}`, h.key);
  check('…with our slot and car', h.slot === 7 && h.carNumber === '27' && h.carClass === 'GT3');
  check('…and multiclass seen from the field', h.multiclass === true);
  g.feed(1, { session: { phase: 'formation', notStarted: true } });
  check('a quiet frame writes nothing', g.lines.length === 1);

  g.feed(2, { session: { phase: 'green', notStarted: false }, me: { gridPosition: 6, position: 6, classPosition: 3 } });
  const start = g.events('start')[0];
  check('green flag → a start line with the grid slot', start && start.text === 'Green flag. Started P6 (P3 in GT3)', start && start.text);
  check('…stamped in session et', start && start.et === 102, start && start.et);
  check('…and wall time', start && start.at === T0 + 2000);
  check('…on lap 1', start && start.lap === 1, start && start.lap);

  // A local yellow in S2, a second in S3, all clear.
  g.feed(10, { session: { sectorFlags: ['none', 'yellow', 'none'] } });
  g.feed(11, { session: { sectorFlags: ['none', 'yellow', 'yellow'] } });
  g.feed(12, { session: { sectorFlags: ['none', 'none', 'none'] } });
  const flags = g.events('flag').map((e) => e.text);
  check('every local yellow is logged, the new sector named', flags[0] === 'Yellow flag in S2' && flags[1] === 'Yellow flag in S3', flags.join(' | '));
  check('…and the all-clear', flags[2] === 'Yellow flags cleared', flags[2]);

  // First crossing: P6 → P5, class P3 → P2; the lap time lands a poll later.
  g.feed(20, { me: { lapsCompleted: 1, position: 5, classPosition: 2, lastLapSec: -1 } });
  check('the lap waits for its time', g.events('lap').length === 0);
  const pos = g.events('position')[0];
  check('places gained at the line, lap 1 included', pos && pos.text === 'Gained 1 place, now P5 (P2 in GT3)', pos && pos.text);
  check('…with the structured gain', pos && pos.detail.gained === 1 && pos.detail.classGained === 1);
  g.feed(20.5, { me: { lapsCompleted: 1, position: 5, classPosition: 2, lastLapSec: 112.671 } });
  const lap1 = g.events('lap')[0];
  check('the lap line carries its time', lap1 && lap1.text === 'Lap 1  1:52.671', lap1 && lap1.text);
  check('…stamped at the crossing, not the late time', lap1 && lap1.et === 120, lap1 && lap1.et);
  check('…and its ms', lap1 && lap1.detail.lapMs === 112671);
  check('…on the lap it describes, as is the place change', lap1 && lap1.lap === 1 && pos.lap === 1, `${lap1 && lap1.lap} ${pos && pos.lap}`);

  // Damage: minor, then the same (a 3 s re-poll), then major, then a new zone at the same grade.
  const d1 = damage(0.04, [0, 0, 0, 0]);
  g.feed(30, { me: { lapsCompleted: 1, lastLapSec: 112.671 }, player: { damage: d1 } });
  g.feed(33, { me: { lapsCompleted: 1, lastLapSec: 112.671 }, player: { damage: damage(0.045, [0, 0, 0, 0]) } });
  g.feed(40, { me: { lapsCompleted: 1, lastLapSec: 112.671 }, player: { damage: damage(0.05, [0.2, 0, 0, 0]) } });
  g.feed(43, { me: { lapsCompleted: 1, lastLapSec: 112.671 }, player: { damage: damage(0.05, [0.2, 0.16, 0, 0]) } });
  g.feed(46, { me: { lapsCompleted: 1, lastLapSec: 112.671 }, player: { damage: damage(0.06, [0.21, 0.16, 0, 0]) } });
  const dmg = g.events('damage').map((e) => e.text);
  check('minor damage is logged once', dmg[0] === 'Minor damage: bodywork', dmg[0]);
  check('a worse grade is a new line, zones named', dmg[1] === 'Major damage: front-left suspension, bodywork', dmg[1]);
  check('a new zone at the same grade is a new line', dmg[2] === 'Major damage: front-left suspension, front-right suspension, bodywork', dmg[2]);
  check('the same damage re-polled is not', dmg.length === 3, dmg.length);
  check('damage carries grade and zones', g.events('damage')[1].detail.grade === 'major' && g.events('damage')[1].detail.zones.length === 2);
  // A repair, then a fresh knock: news again.
  g.feed(60, { me: { lapsCompleted: 1, lastLapSec: 112.671 }, player: { damage: damage(0, [0, 0, 0, 0]) } });
  g.feed(70, { me: { lapsCompleted: 1, lastLapSec: 112.671 }, player: { damage: damage(0.03, [0, 0, 0, 0], 1) } });
  const after = g.events('damage').map((e) => e.text);
  check('after a repair, a lost part is major', after[3] === 'Major damage: bodywork (1 part off)', after[3]);

  // Pit, a swap, the stewards.
  g.feed(80, { me: { lapsCompleted: 1, lastLapSec: 112.671, inPit: true } });
  g.feed(90, { me: { lapsCompleted: 1, lastLapSec: 112.671, inPit: true, driverName: 'Micky T' } });
  g.feed(95, { me: { lapsCompleted: 1, lastLapSec: 112.671, inPit: false, driverName: 'Micky T' } });
  check('pit in and out', g.events('pit').map((e) => e.text).join(',') === 'Pit in,Pit out');
  const drv = g.events('driver')[0];
  check('a swap on our car is logged', drv && drv.text === 'Driver change: Micky T takes over from Carl Jones', drv && drv.text);
  const tl = (points, penalties, penaltyType) => ({ points, pointsLimit: 5, penalties, penaltyType });
  g.feed(100, { me: { lapsCompleted: 1, driverName: 'Micky T' }, player: { trackLimits: tl(0, 0) } });
  g.feed(101, { me: { lapsCompleted: 1, driverName: 'Micky T' }, player: { trackLimits: tl(1.25, 0) } });
  g.feed(102, { me: { lapsCompleted: 1, driverName: 'Micky T' }, player: { trackLimits: tl(5, 1, 'Drive Through') } });
  g.feed(103, { me: { lapsCompleted: 1, driverName: 'Micky T' }, player: { trackLimits: tl(0, 0) } });
  check('track-limit points as the stewards count them', g.events('limits').map((e) => e.text).join('|') === 'Track limits: 1.25 of 5 points|Track limits: 5 of 5 points',
    g.events('limits').map((e) => e.text).join('|'));
  check('penalty issued with its kind, then served', g.events('penalty').map((e) => e.text).join('|') === 'Penalty: Drive Through|Penalty served',
    g.events('penalty').map((e) => e.text).join('|'));

  // Contacts: ours by either side, a teammate's name counts, scenery, dedupe, others dropped.
  g.incidents(104, [
    { player: 'Carl Jones', contactWith: 'Peter Dempsey', et: 150.2 },
    { player: 'Peter Dempsey', contactWith: 'Carl Jones', et: 150.6 }, // the other car's report
    { player: 'Micky T', contactWith: 'Immovable', et: 190.4 },
    { player: 'Ana Silva', contactWith: 'Peter Dempsey', et: 191.0 }, // not us
    { player: 'Ana Silva#123', contactWith: 'Carl Jones', et: 199 },
  ]);
  g.incidents(106, [{ player: 'Carl Jones', contactWith: 'Peter Dempsey', et: 150.2 }]); // re-polled list
  const ct = g.events('contact');
  check('our contacts only, each once', ct.length === 3, ct.map((e) => e.text).join(' | '));
  check('the other car named with its number', ct[0].text === 'Contact with Peter Dempsey (#23)' && ct[0].detail.otherSlot === 23, ct[0].text);
  check('…stamped in the list\'s own et', ct[0].et === 150.2);
  check('…on the lap it happened', ct[0].lap === 2, ct[0].lap);
  check('scenery reads as scenery', ct[1].text === 'Contact with the wall' && ct[1].detail.scenery === 'Immovable', ct[1].text);
  check('a #discriminator on the other side still matches us', ct[2].text === 'Contact with Ana Silva#123 (#9)' || ct[2].text.startsWith('Contact with Ana Silva'), ct[2].text);
  check('contacts before the green sit on lap 0', g.r.noteIncidents([{ player: 'Carl Jones', contactWith: 'Ana Silva', et: 101 }], T0 + 107000)[0].lap === 0);

  // FCY → restart; red; the chequered flag out; our next crossing is our finish.
  g.feed(110, { session: { phase: 'fullCourseYellow', flag: 'yellow' }, me: { lapsCompleted: 1, driverName: 'Micky T' } });
  g.feed(130, { session: { phase: 'green' }, me: { lapsCompleted: 1, driverName: 'Micky T' } });
  g.feed(140, { session: { phase: 'redFlag', flag: 'red' }, me: { lapsCompleted: 1, driverName: 'Micky T' } });
  g.feed(150, { session: { phase: 'green' }, me: { lapsCompleted: 1, driverName: 'Micky T' } });
  g.feed(160, { session: { finalLap: true, sectorFlags: ['checkered', 'none', 'none'] }, me: { lapsCompleted: 1, driverName: 'Micky T' } });
  g.feed(170, { session: { phase: 'checkered', flag: 'checkered', finalLap: true }, me: { lapsCompleted: 1, driverName: 'Micky T' } });
  g.feed(200, { session: { phase: 'checkered', finalLap: true }, me: { lapsCompleted: 2, position: 4, classPosition: 1, driverName: 'Micky T', lastLapSec: 180.2 } });
  const f2 = g.events('flag').map((e) => e.text).slice(3);
  check('FCY, restart, red, restart, final lap — every one', f2.join('|') ===
    'Full-course yellow|Restart: racing resumes|Red flag|Restart: racing resumes|Chequered flag out: final lap', f2.join('|'));
  const fin = g.events('finish')[0];
  check('our crossing after the flag is our finish', fin && fin.text === 'Chequered flag. Finished P4 (P1 in GT3), 2 laps', fin && fin.text);
  check('…the leader\'s phase change is not ours', g.events('finish').length === 1);

  // Leaving the race ends it; the next race gets its own header.
  g.feed(400, { session: { type: 'practice' } });
  g.feed(500, { session: { phase: 'formation', notStarted: true, elapsedSec: 20 } });
  check('a new race after a practice writes a new header', g.lines.filter((l) => l.t === 'header').length === 2);
  g.feed(501, { connected: false, session: { phase: 'green' } });
  check('demo frames record nothing', g.lines.filter((l) => l.t === 'event').length === g.lines.filter((l) => l.t === 'event').length && g.events('start').length === 1);
}

{
  // The clock rewinding (an admin restart) and a regrid both open a new race.
  const g = rig();
  g.feed(0, { session: { phase: 'green' } });
  g.feed(50, { session: { phase: 'green' } });
  g.feed(51, { session: { phase: 'formation', notStarted: true, elapsedSec: 3 } });
  check('et running backwards opens a new race', g.lines.filter((l) => l.t === 'header').length === 2);
  const g2 = rig();
  g2.feed(0, { session: { phase: 'green', elapsedSec: 500 } });
  g2.feed(1, { session: { phase: 'formation', notStarted: true, elapsedSec: 501 } });
  g2.feed(2, { session: { phase: 'green', elapsedSec: 502 } });
  check('one odd pre-green frame does not split a race', g2.lines.filter((l) => l.t === 'header').length === 1);
  g2.feed(20, { session: { phase: 'gridwalk', notStarted: true, elapsedSec: 520 } });
  g2.feed(24, { session: { phase: 'gridwalk', notStarted: true, elapsedSec: 524 } });
  check('back on the grid for 3 s is a restarted session', g2.lines.filter((l) => l.t === 'header').length === 2);
}

{
  // Our slot learned late (teams load on a timer): the header is re-sent with it.
  let id = { slot: null, names: [] };
  const r = new RaceLogRecorder({ identity: () => id });
  const out = [...r.update(frame(0))];
  check('no slot yet → header with slot null', out[0].slot === null);
  id = { slot: 7, names: ['carl jones'] };
  out.push(...r.update(frame(2)));
  const hs = out.filter((l) => l.t === 'header');
  check('…re-sent once the slot is known', hs.length === 2 && hs[1].slot === 7 && hs[1].key === hs[0].key);
  // A late join with damage already on the car still gets one line.
  out.push(...r.update(frame(3, { player: { damage: damage(0.3, [0, 0, 0, 0]) } })));
  const d = out.filter((l) => l.kind === 'damage');
  check('damage on arrival is logged, and says so', d.length === 1 && /already on the car/.test(d[0].text), d[0] && d[0].text);
}

{
  // Isn't us: never isPlayer. The camera car must not become ours.
  const r = new RaceLogRecorder();
  const st = [row({ slotId: 3, isPlayer: true, driverName: 'Someone Else' })];
  const out = [...r.update(frame(0, { standings: st })), ...r.update(frame(5, { standings: [{ ...st[0], lapsCompleted: 1 }] }))];
  check('the camera car is never followed', out.filter((l) => l.t === 'event').length === 0);
  const r2 = new RaceLogRecorder();
  const own = [row({ slotId: 3, isOwn: true })];
  const o2 = [...r2.update(frame(0, { standings: own })), ...r2.update(frame(5, { standings: [{ ...own[0], lapsCompleted: 1, lastLapSec: 90 }] })),
    ...r2.update(frame(6, { standings: [{ ...own[0], lapsCompleted: 1, lastLapSec: 90 }] }))];
  check('…the isOwn row is', o2.some((l) => l.kind === 'lap'), o2.map((l) => l.text).join('|'));
}

{
  // Who we are is per race. Race 1: team-mate John Mate drives our slot 3.
  // Race 2 at another track: the provider has no slot yet and only knows
  // Carl, who has no row yet. Slot 3 there is a rival, and John Mate drives
  // someone else's car: neither may be followed or logged as ours.
  let id = { slot: 3, names: ['carl jones', 'john mate'] };
  const r = new RaceLogRecorder({ identity: () => id });
  const out = [];
  const st1 = [row({ slotId: 3, driverName: 'John Mate', carNumber: '3' }), row({ slotId: 23, driverName: 'Peter Dempsey', carNumber: '23' })];
  out.push(...r.update(frame(0, { standings: st1 })));
  check('race 1 follows the team-mate\'s car', out[0].t === 'header' && out[0].slot === 3, out[0].slot);
  id = { slot: null, names: ['carl jones'] };
  const atl = (sec, laps) => ({
    session: { track: 'Michelin Raceway Road Atlanta', elapsedSec: 50 + sec },
    standings: [
      row({ slotId: 3, driverName: 'Rita Rival', carNumber: '3', lapsCompleted: laps, lastLapSec: laps ? 90 : -1 }),
      row({ slotId: 8, driverName: 'John Mate', carNumber: '88' }),
      row({ slotId: 23, driverName: 'Peter Dempsey', carNumber: '23' }),
    ],
  });
  out.push(...r.update(frame(1000, atl(0, 0))));
  const h2 = out.filter((l) => l.t === 'header')[1];
  check('race 2 opens with no slot, not the last race\'s', h2 && h2.slot === null && h2.carNumber === undefined, h2 && `${h2.slot} #${h2.carNumber}`);
  out.push(...r.update(frame(1010, atl(10, 1))), ...r.update(frame(1011, atl(11, 1))));
  const ev2 = out.filter((l) => l.t === 'event' && l.key === h2.key);
  check('…the rival now in slot 3 is not followed', ev2.length === 0, ev2.map((e) => e.text).join('|'));
  const c2 = r.noteIncidents([{ player: 'John Mate', contactWith: 'Peter Dempsey', et: 60 }], T0 + 1012000);
  check('…and last race\'s team-mate\'s contact is not ours', c2.length === 0, c2.map((e) => e.text).join('|'));
  check('…while our own name still is', r.noteIncidents([{ player: 'Carl Jones', contactWith: 'Peter Dempsey', et: 61 }], T0 + 1012000).length === 1);
}

{
  // Replays (review 2026-09-30): LMU plays one as RACE1 in GSTATE_DYN with the
  // replay's cars in standings; only /navigation/state's settingMode says so.
  let id = { slot: 7, names: ['carl jones'], replay: null };
  const r = new RaceLogRecorder({ identity: () => id });
  const out = [];
  out.push(...r.update(frame(0)));
  check('replay mode not yet read → nothing recorded', out.length === 0 && !r.inRace());
  id = { ...id, replay: true };
  out.push(...r.update(frame(2)));
  // Playback, then two backward seeks: each rewinds et, which would be a new race.
  out.push(...r.update(frame(3, { me: { lapsCompleted: 1, lastLapSec: 90 } })));
  out.push(...r.update(frame(5, { session: { elapsedSec: 40 } })));
  out.push(...r.update(frame(7, { session: { elapsedSec: 2600 } })));
  out.push(...r.update(frame(9, { session: { elapsedSec: 10 } })));
  check('a replay playing writes no header and no event, seeks included', out.length === 0, out.map((l) => l.t).join());
  check('…nor takes incidents', r.noteIncidents([{ player: 'Carl Jones', contactWith: 'Peter Dempsey', et: 9 }], T0 + 9500).length === 0);
  id = { ...id, replay: false };
  out.push(...r.update(frame(20)));
  check('back to a live race, it records', out.length === 1 && out[0].t === 'header');
  id = { ...id, replay: true };
  out.push(...r.update(frame(22)));
  check('a replay mid-record ends the race, writing nothing', out.length === 1 && !r.inRace());
  const plain = new RaceLogRecorder({ identity: () => ({ slot: 7, names: [] }) });
  check('a provider that cannot tell (no replay field) records as before', plain.update(frame(0)).length === 1);
}

{
  // Stale incidents after a restart: LMU need not clear its list, so rows
  // stamped before the new race's first et are the old session's.
  const g = rig();
  g.feed(0, { session: { phase: 'green', elapsedSec: 300 } }); // joined mid-race
  g.incidents(1, [{ player: 'Carl Jones', contactWith: 'Peter Dempsey', et: 150 }]);
  check('joined mid-way, an earlier contact is this race\'s own', g.events('contact').length === 1);
  g.feed(10, { session: { phase: 'green', elapsedSec: 310 } });
  // The admin restarts: the clock rewinds while the phase has not caught up.
  g.feed(11, { session: { phase: 'green', elapsedSec: 20 } });
  check('the restart opens a new race', g.lines.filter((l) => l.t === 'header').length === 2);
  g.incidents(15, [
    { player: 'Carl Jones', contactWith: 'Ana Silva', et: 8 }, // the old session's, still listed
    { player: 'Carl Jones', contactWith: 'Ana Silva', et: 22 },
  ]);
  const after = g.events('contact').slice(1);
  check('…a listed row from before its start is ignored, a new one kept', after.length === 1 && after[0].et === 22, after.map((e) => e.et).join());
  // A race after practice, from the grid: the practice session's rows are older than its first et.
  const p = rig();
  p.feed(0, { session: { type: 'practice' } });
  p.feed(10, { session: { phase: 'gridwalk', notStarted: true, elapsedSec: 30 } });
  p.incidents(12, [{ player: 'Carl Jones', contactWith: 'Ana Silva', et: 5 }, { player: 'Carl Jones', contactWith: 'Ana Silva', et: 31 }]);
  check('…and from the grid, rows older than the race are not its', p.events('contact').map((e) => e.et).join() === '31', p.events('contact').map((e) => e.et).join());
}

check('lap times read m:ss.sss', lapTime(65.4) === '1:05.400' && lapTime(112.671) === '1:52.671');

/* -------------------------------------------------------------------------- */
/*  2) The file                                                                */
/* -------------------------------------------------------------------------- */

async function fileSuite() {
  console.log('\n2) The file\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'racelog-'));
  const g = rig();
  g.feed(0, { session: { phase: 'formation', notStarted: true } });
  g.feed(2, { session: { phase: 'green', notStarted: false } });
  g.incidents(3, [{ player: 'Carl Jones', contactWith: 'Peter Dempsey', et: 102.5 }]);
  // The app restarts mid-race: a second recorder, same race, re-reads the incident list.
  const g2 = rig();
  g2.feed(40, { me: { lapsCompleted: 0 } });
  g2.incidents(41, [{ player: 'Carl Jones', contactWith: 'Peter Dempsey', et: 102.5 }]);
  g2.feed(50, { player: { damage: damage(0.2, [0, 0, 0, 0]) } });
  // A race across UTC midnight.
  const lateAt = Date.UTC(2026, 8, 30, 23, 59, 59);
  const w = new LiveLogWriter(dir);
  w.write(g.lines);
  w.write(g2.lines);
  const rolled = { ...g2.lines[g2.lines.length - 1], at: lateAt + 2000, text: 'Yellow flags out', kind: 'flag' };
  w.write([rolled]);
  await w.flush();
  const files = fs.readdirSync(dir).sort();
  check('one file per UTC day', files.join(',') === 'live-2026-09-30.jsonl,live-2026-10-01.jsonl', files.join(','));
  const second = fs.readFileSync(path.join(dir, files[1]), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  check('a new day\'s file opens with the race header', second[0].t === 'header' && second[1].t === 'event');
  const races = await loadLiveLog({ dir, sinceMs: Date.UTC(2026, 8, 1) });
  check('the restart segments read back as one race', races.length === 1, races.length);
  const race = races[0];
  check('…the re-read contact is not doubled', race.events.filter((e) => e.kind === 'contact').length === 1);
  check('…the green flag is found', race.greenEt === 102 && race.greenAt === T0 + 2000, `${race.greenEt} ${race.greenAt}`);
  check('…events in et order', race.events.every((e, i, a) => i === 0 || a[i - 1].et === null || e.et === null || a[i - 1].et <= e.et));
  check('a missing directory is an empty list', (await loadLiveLog({ dir: path.join(dir, 'nope') })).length === 0);
  check('a torn last line is skipped', parseLiveLog(fs.readFileSync(path.join(dir, files[0]), 'utf8') + '{"t":"event","ke').length === 1);
  fs.rmSync(dir, { recursive: true, force: true });

  // A failed append (antivirus holding the new file) must not cost the race:
  // the header rode in the failed batch, and parseLiveLog drops every event
  // that has no header.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'racelog-'));
  const io = {
    fail: 1,
    mkdir: (d, o) => fs.promises.mkdir(d, o),
    appendFile(f, t, e) {
      if (io.fail > 0) {
        io.fail--;
        return Promise.reject(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }));
      }
      return fs.promises.appendFile(f, t, e);
    },
  };
  const g3 = rig();
  g3.feed(0, { session: { phase: 'formation', notStarted: true } });
  g3.feed(2, { session: { phase: 'green', notStarted: false } });
  const w2 = new LiveLogWriter(dir2, io);
  const errLog = console.error;
  console.error = () => undefined; // the one-time warning is expected here
  try {
    w2.write(g3.lines);
    await new Promise((r) => setTimeout(r, 20));
    check('a failed append keeps its lines for a retry', w2.pendingChars() > 0 && io.fail === 0, w2.pendingChars());
    const before = g3.lines.length;
    g3.incidents(3, [{ player: 'Carl Jones', contactWith: 'Peter Dempsey', et: 102.5 }]);
    w2.write(g3.lines.slice(before));
    await w2.flush();
    const back = parseLiveLog(fs.readFileSync(liveFile(dir2), 'utf8'));
    check('…and the retry lands the header and every event', back.length === 1 && back[0].events.length === 2 && back[0].greenEt === 102,
      back.map((b) => `${b.header.key}:${b.events.map((e) => e.kind).join(',')}`).join(' | '));

    // A disk that never lets go: what is held stays bounded, and once it
    // recovers the header is re-sent with the next line.
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'racelog-'));
    io.fail = Infinity;
    const w3 = new LiveLogWriter(dir3, io);
    w3.write(g3.lines.slice(0, 1));
    const ev = g3.lines.find((l) => l.t === 'event');
    for (let i = 0; i < 4000; i++) {
      w3.write([{ ...ev, text: `Yellow flag ${i} ${'x'.repeat(200)}` }]);
      if (i % 200 === 0) await w3.flush();
    }
    await w3.flush();
    check('…a disk that keeps refusing holds at most 512 KB', w3.pendingChars() <= 512 * 1024, w3.pendingChars());
    io.fail = 0;
    w3.write([{ ...ev, text: 'Yellow flags cleared' }]);
    await w3.flush();
    const back3 = parseLiveLog(fs.readFileSync(liveFile(dir3), 'utf8'));
    check('…and when it recovers, the header is re-sent so the next line still reads',
      back3.length === 1 && back3[0].events.some((e) => e.text === 'Yellow flags cleared'), back3.length);
    fs.rmSync(dir3, { recursive: true, force: true });
  } finally {
    console.error = errLog;
  }
  fs.rmSync(dir2, { recursive: true, force: true });
}

/** The one live file a test wrote into `dir`. */
function liveFile(dir) {
  return path.join(dir, fs.readdirSync(dir).find((n) => n.startsWith('live-')));
}

/* -------------------------------------------------------------------------- */
/*  3) Merge                                                                   */
/* -------------------------------------------------------------------------- */

function mergeSuite() {
  console.log('\n3) Merge with the XML\n');
  const xmlEv = (et, kind, text, detail) => ({ et, raceS: et - 152, lap: 1, kind, text, source: 'xml', ...(detail ? { detail } : {}) });
  const xml = {
    id: '2026_09_24_21_38_11-49R1.xml', track: 'Grand Prix of Long Beach', startedAt: 1790276199, slot: 7,
    carNumber: '27', carClass: 'GT3', vehicle: 'Porsche', drivers: ['Carl Jones'], greenEt: 152,
    gridPosition: 6, gridClassPosition: 3, finishPosition: 4, finishClassPosition: 1, finishStatus: 'Finished',
    laps: 40, multiclass: true, matchedBy: 'laplog', provisional: false,
    events: [
      xmlEv(152, 'start', 'Green flag. Started P6 (P3 in GT3)'),
      xmlEv(280.2, 'contact', 'Contact with Peter Dempsey (#23)', { otherSlot: 23, otherName: 'Peter Dempsey', otherNumber: '23', severity: 'light' }),
      // The file's own words for the hit at 281.5 (live says it better), an
      // engine report beside it (live never names the engine), and a later
      // hit the 3 s damage poll missed.
      xmlEv(281.2, 'damage', 'New suspension damage', { zones: ['suspension'] }),
      xmlEv(283, 'damage', 'New engine damage', { zones: ['engine'] }),
      xmlEv(290, 'lap', 'Lap 2  1:52.671'),
      xmlEv(3000, 'damage', 'New suspension damage', { zones: ['suspension'] }),
      xmlEv(4700, 'finish', 'Chequered flag. Finished P4 (P1 in GT3), 40 laps'),
    ],
  };
  // The live race, its clock placed so the XML was written ~80 s after et 4700.
  const written = writtenAt(xml.id);
  const startMs = written - 4700 * 1000 - 80_000 + 20_000;
  const lev = (et, kind, text, detail) => ({ t: 'event', key: 'k', at: startMs + et * 1000, et, lap: 2, kind, text, ...(detail ? { detail } : {}) });
  const live = {
    header: { t: 'header', v: 1, key: 'k', track: 'Long Beach Street Circuit', sessionType: 'race', source: 'lmu',
      sessionStartMs: startMs, firstAt: startMs + 100000, firstEt: 100, firstPhase: 'formation', slot: 7,
      carNumber: '27', carClass: 'GT3', driver: 'Carl Jones', multiclass: true },
    events: [
      lev(152.1, 'start', 'Green flag. Started P6 (P3 in GT3)'),
      lev(200, 'flag', 'Yellow flag in S2'),
      lev(281.0, 'contact', 'Contact with Peter Dempsey (#23)', { otherName: 'Peter Dempsey', otherNumber: '23', otherSlot: 23 }),
      lev(281.5, 'damage', 'Major damage: front-left suspension, bodywork', { grade: 'major', zones: ['front-left suspension', 'bodywork'] }),
      lev(290.1, 'lap', 'Lap 2  1:52.671'),
      lev(400, 'contact', 'Contact with the wall', { scenery: 'Immovable' }),
      lev(500, 'contact', 'Contact with Ana Silva (#9)', { otherName: 'Ana Silva', otherSlot: 9 }),
      { ...lev(0, 'flag', 'Red flag'), et: null, at: startMs + 152_000 + 3_000_000 },
    ],
    greenEt: 152.1, greenAt: startMs + 152100, lastAt: startMs + 4700000, finished: true,
  };
  const m = mergeLive(xml, live);
  const live2 = m.events.filter((e) => e.source === 'live');
  check('live adds flags and graded damage', live2.some((e) => e.kind === 'flag') && live2.some((e) => e.kind === 'damage'));
  check('a live contact the XML also has (same car, ±1.5 s) is dropped',
    m.events.filter((e) => e.kind === 'contact' && /Dempsey/.test(e.text)).length === 1 &&
    m.events.find((e) => /Dempsey/.test(e.text)).source === 'xml');
  check('a live contact the XML lacks is kept', live2.filter((e) => e.kind === 'contact').length === 2, live2.filter((e) => e.kind === 'contact').map((e) => e.text).join('|'));
  check('the XML owns laps, start and finish', !live2.some((e) => ['lap', 'start', 'finish', 'position'].includes(e.kind)));
  check('merged in et order', m.events.every((e, i, a) => i === 0 || a[i - 1].et <= e.et));
  check('raceS measured from the XML green', live2.find((e) => e.kind === 'flag').raceS === 48);
  check('an event with no et is placed by wall time against the green', live2.some((e) => e.text === 'Red flag' && Math.abs(e.et - (152 + 3000)) < 0.2),
    live2.filter((e) => e.text === 'Red flag').map((e) => e.et).join());
  check('the XML log is otherwise untouched', m.slot === 7 && m.provisional === false && m.laps === 40);
  const xmlDmg = m.events.filter((e) => e.kind === 'damage' && e.source === 'xml').map((e) => `${e.et} ${e.text}`);
  check('the XML\'s suspension line beside the live graded one (±5 s) is dropped', !xmlDmg.includes('281.2 New suspension damage'), xmlDmg.join(' | '));
  check('…an XML damage line no live one names is kept', xmlDmg.includes('283 New engine damage'), xmlDmg.join(' | '));
  check('…as is one with no live damage near it', xmlDmg.includes('3000 New suspension damage'), xmlDmg.join(' | '));
  check('no live extras → the XML object as-is', mergeLive(xml, { ...live, events: [] }) === xml);

  const p = mergeLive(null, live);
  check('no XML → a provisional log from the live file', p.provisional === true && p.events.length === live.events.length);
  check('…keeping everything, lap and start included', p.events.some((e) => e.kind === 'lap') && p.gridPosition === null);
  check('…all marked live', p.events.every((e) => e.source === 'live'));
  const crashed = provisionalLog({ ...live, events: live.events.filter((e) => e.kind !== 'finish'), finished: false });
  check('…and a log that just stops says Unknown, not Finished', crashed.finishStatus === 'Unknown');

  console.log('\n   pairing\n');
  check('track names spelt differently still pair', sameTrack('Grand Prix of Long Beach', 'Grand Prix of Long Beach - GP'));
  check('the file name is its local write time', new Date(written).getHours() === 21 && new Date(written).getMinutes() === 38);
  const decoy = { ...live, header: { ...live.header, track: 'Grand Prix of Long Beach', sessionStartMs: startMs - 86_400_000 }, greenEt: 152 };
  const far = { ...live, header: { ...live.header, sessionStartMs: startMs + 3_600_000 } };
  check('the right race pairs (green et agrees, track spelt otherwise)', matchLiveRace(xml, [decoy, live, far]) === live);
  check('yesterday\'s race at the same track does not', matchLiveRace(xml, [decoy]) === null);
  check('an hour out does not', matchLiveRace(xml, [far]) === null);
  const otherTrack = { ...live, header: { ...live.header, track: 'Sebring' }, greenEt: 90 };
  check('another track at another green does not', matchLiveRace(xml, [otherTrack]) === null);
}

/* -------------------------------------------------------------------------- */
/*  4) Real races                                                              */
/* -------------------------------------------------------------------------- */

/** Frames from `record-session.js`, with the pre-2026-08-26 raw detached-part count made a delta, as the provider now does. */
function replayRecording(file) {
  const r = new RaceLogRecorder({ identity: () => ({ slot: null, names: ['carl jones'] }) });
  const out = [];
  let partsBase = null;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    let f;
    try {
      f = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!f || !f.session || !f.timestamp) continue;
    const d = f.player && f.player.damage;
    if (d && f.connected && d.partsDetached >= 0) {
      partsBase = partsBase === null ? d.partsDetached : Math.min(partsBase, d.partsDetached);
      f.player.damage = { ...d, partsDetached: d.partsDetached - partsBase };
    }
    out.push(...r.update(f));
  }
  return out;
}

function recordingsSuite() {
  console.log('\n4a) recordings/*.jsonl\n');
  const dir = path.join(__dirname, '..', 'recordings');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')) : [];
  if (files.length === 0) {
    console.log('  skip (no recordings on this machine)');
    return;
  }
  for (const name of files) {
    const out = replayRecording(path.join(dir, name));
    const ev = out.filter((l) => l.t === 'event');
    console.log(`  ${name}: ${out.filter((l) => l.t === 'header').length} race(s), ${ev.length} events`);
    for (const e of ev) {
      const k = e.kind.toUpperCase().padEnd(8);
      console.log(`     L${String(e.lap).padEnd(3)} ${k} ${e.text}`);
    }
    check(`${name}: every event names its race`, ev.every((e) => out.some((h) => h.t === 'header' && h.key === e.key)));
    if (name === 'session-2026-08-19T13-05-44.jsonl') {
      // Barcelona, 2026-08-19: Carl P4 on the grid, a knock on lap 1, three
      // quarter-point cuts, then the REST-collapsed yellow before the feed died.
      check('Barcelona: one race, recorded until the sim went away', out.filter((l) => l.t === 'header').length === 1);
      check('Barcelona: the start from P4', ev.some((e) => e.kind === 'start' && e.text === 'Green flag. Started P4'),
        (ev.find((e) => e.kind === 'start') || {}).text);
      const dmg = ev.filter((e) => e.kind === 'damage');
      check('Barcelona: the lap-1 knock is minor damage, logged once per worsening',
        dmg.length >= 1 && dmg[0].detail.grade === 'minor' && dmg[0].lap === 1, dmg.map((e) => `${e.lap}:${e.text}`).join(' | '));
      check('Barcelona: the yellow is one line, not three', ev.filter((e) => e.kind === 'flag' && e.text.startsWith('Yellow flags out')).length === 1,
        ev.filter((e) => e.kind === 'flag').map((e) => e.text).join('|'));
      check('Barcelona: three track-limit charges', ev.filter((e) => e.kind === 'limits').length === 3);
      check('Barcelona: the five timed laps carry their times',
        ev.filter((e) => e.kind === 'lap' && /\d:\d\d\.\d{3}$/.test(e.text)).length === 5);
      // LMU publishes -1 for a lap it did not count: laps 2-4 here, the cut laps.
      check('Barcelona: laps 2-4 say no time', ev.filter((e) => e.kind === 'lap' && e.detail && e.detail.invalid)
        .map((e) => e.lap).join() === '2,3,4', ev.filter((e) => e.kind === 'lap').map((e) => `${e.lap}:${e.text}`).join(' | '));
      check('Barcelona: P1 by the end, via the line', ev.some((e) => e.kind === 'position' && /now P1$/.test(e.text)));
      check('Barcelona: no clock in 2026-08 frames, so et is null, not invented', ev.every((e) => e.et === null));
    }
  }
}

/** Raw REST probe → frames. Only the channels the recorder reads. */
async function probeSuite() {
  console.log('\n4b) race-probe (Daytona, 2026-08-04, raw REST)\n');
  const file = path.join(os.homedir(), '.apex-overlay', 'race-probe-2026-08-04T19-54-48.jsonl');
  if (!fs.existsSync(file)) {
    console.log('  skip (probe not on this machine)');
    return;
  }
  const st = {
    phase: 'formation', sectors: ['none', 'none', 'none'], track: '', laps: 0, penalties: 0,
    pit: false, dnf: false, damage: null, etOffset: null, greenAt: null,
  };
  const r = new RaceLogRecorder({ identity: () => ({ slot: 0, names: ['carl jones'] }) });
  const out = [];
  const phaseOf = (p) => (/GREEN/.test(p) ? 'green' : /FORMATION/.test(p) ? 'formation' : /BEFORE|GRID/.test(p) ? 'gridwalk' : /CHECK/.test(p) ? 'checkered' : st.phase);
  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  for await (const raw of rl) {
    if (!raw.includes('"key":"gameState"') && !raw.includes('"key":"sessionInfo"') && !raw.includes('"key":"standings"')
      && !raw.includes('"key":"vehicleCondition"') && !raw.includes('"key":"incidents"')) continue;
    let o;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    const v = o.value;
    if (!v) continue;
    const at = Date.parse(o.at);
    if (o.key === 'gameState') {
      const next = phaseOf(v.gamePhase || '');
      // The probe has no session clock, so rebuild one: startEventTime is the
      // green flag's et, which fixes the offset at each green (race 1's is
      // 20.9 s from the probe's start); a regrid restarts it from zero.
      if (next === 'gridwalk' && st.phase !== 'gridwalk') st.etOffset = o.t;
      if (next === 'green' && st.phase !== 'green') st.greenAt = o.t;
      st.phase = next;
      st.pit = v.PitState && v.PitState !== 'NONE';
    } else if (o.key === 'sessionInfo') {
      st.track = v.trackName || st.track;
      st.sectors = (v.sectorFlag || []).map((s) => (s === 'YELLOW' ? 'yellow' : 'none'));
      if (st.greenAt !== null && v.startEventTime > 1) {
        st.etOffset = st.greenAt - v.startEventTime;
        st.greenAt = null;
      }
      if (st.etOffset === null) st.etOffset = 20.9;
    } else if (o.key === 'standings' && v.me) {
      st.laps = v.me.lapsCompleted;
      st.penalties = v.me.penalties;
      st.dnf = v.me.finishStatus === 'FSTAT_DNF';
    } else if (o.key === 'vehicleCondition') {
      const aero = v.vehicleDamage || 0;
      const susp = v.suspensionDamage || [0, 0, 0, 0];
      const worst = Math.max(aero, ...susp);
      st.damage = {
        aero, suspension: susp, partsDetached: 0, worst, hasDamage: worst > 0.005,
        grades: { aero: damageGrade(aero), suspension: susp.map(damageGrade) },
      };
    } else if (o.key === 'incidents') {
      out.push(...r.noteIncidents(v, at));
      continue;
    }
    if (!st.track || st.etOffset === null) continue; // no sessionInfo yet
    const et = Math.round((o.t - st.etOffset) * 10) / 10;
    out.push(...r.update({
      schemaVersion: 1, source: 'lmu', timestamp: at, connected: true,
      session: {
        type: 'race', phase: st.phase, flag: st.phase === 'green' ? 'green' : 'none', track: st.track,
        notStarted: st.phase !== 'green' && st.phase !== 'checkered', elapsedSec: et > 0 ? et : undefined,
        sectorFlags: st.sectors.length === 3 ? st.sectors : ['none', 'none', 'none'],
      },
      player: {
        slotId: 0, position: 1, ...(st.damage ? { damage: st.damage } : {}),
        trackLimits: { points: -1, penalties: st.penalties },
      },
      standings: [{ slotId: 0, position: -1, driverName: 'Carl Jones', carClass: 'GT3', lapsCompleted: st.laps, lastLapSec: -1,
        inPit: st.pit, retired: st.dnf || undefined, isPlayer: true }],
      relative: [],
    }));
  }
  const heads = out.filter((l) => l.t === 'header');
  const ev = (i) => out.filter((l) => l.t === 'event' && heads[i] && l.key === heads[i].key);
  console.log(`  ${heads.length} race(s)`);
  for (const h of heads) console.log(`   header ${h.key} phase=${h.firstPhase} et=${h.firstEt} at=${new Date(h.firstAt).toISOString()}`);
  for (const [i] of heads.entries()) {
    for (const e of ev(i)) console.log(`     R${i + 1} L${String(e.lap).padEnd(3)} ${e.kind.toUpperCase().padEnd(8)} et ${String(e.et).padEnd(7)} ${e.text}`);
  }
  check('the restart is a second race', heads.length === 2, heads.length);
  const r1 = ev(0);
  const r2 = ev(1);
  check('race 1: green flag', r1.some((e) => e.kind === 'start'));
  check('race 1: FR suspension at 100% is critical', r1.some((e) => e.kind === 'damage' && e.detail.grade === 'critical' && e.detail.zones.includes('front-right suspension')),
    r1.filter((e) => e.kind === 'damage').map((e) => e.text).join('|'));
  check('race 1: the DNF', r1.some((e) => e.kind === 'finish' && e.detail.status === 'DNF'));
  check('race 1: Carl\'s contacts from the real list, the rest of the field\'s dropped',
    r1.filter((e) => e.kind === 'contact').length === 2, r1.filter((e) => e.kind === 'contact').map((e) => `${e.et} ${e.text}`).join(' | '));
  check('race 2: 48% FL suspension is major, with the bodywork', r2.some((e) => e.kind === 'damage' && e.text === 'Major damage: front-left suspension, bodywork'),
    r2.filter((e) => e.kind === 'damage').map((e) => e.text).join('|'));
  check('race 2: the aero creeping 0.22 → 0.27 is not a new line', r2.filter((e) => e.kind === 'damage').length === 1);
  check('race 2: pit in and out', r2.filter((e) => e.kind === 'pit').length >= 2);
  check('race 2: two penalties and one served', r2.filter((e) => e.text === 'Penalty issued').length === 2 && r2.some((e) => e.text === 'Penalty served'));
  check('race 2: REST\'s collapsed yellow, then the clear', r2.some((e) => e.text === 'Yellow flags out') && r2.some((e) => e.text === 'Yellow flags cleared'));
  check('race 2: its contacts stamped in its own clock', r2.filter((e) => e.kind === 'contact').every((e) => e.et < 1000) && r2.some((e) => e.kind === 'contact'));
}

/** The serve-fixture race-finish frames, merged over its baseline the way it does. */
function fixtureSuite() {
  console.log('\n4c) serve-fixture race-finish frames\n');
  const dir = path.join(__dirname, 'fixtures');
  const a = path.join(dir, 'race-finish.json');
  const b = path.join(dir, 'race-finished.json');
  if (!fs.existsSync(a) || !fs.existsSync(b)) {
    console.log('  skip (fixtures missing)');
    return;
  }
  const merge = (base, patch) => {
    if (Array.isArray(patch) || patch === null || typeof patch !== 'object') return patch;
    const o = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      o[k] = k in base && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v;
    }
    return o;
  };
  const finished = JSON.parse(fs.readFileSync(b, 'utf8'));
  const me = finished.standings[0];
  const base = frame(0, { session: { track: 'Silverstone' }, standings: [{ ...me, lapsCompleted: 167, lastLapSec: 113.4 }] });
  const r = new RaceLogRecorder({ identity: () => ({ slot: me.slotId, names: [] }) });
  const out = [];
  const at = (sec, patch, standings) => {
    const f = merge(base, patch);
    f.timestamp = T0 + sec * 1000;
    f.session.elapsedSec = 20000 + sec;
    if (standings) f.standings = standings;
    out.push(...r.update(f));
  };
  at(0, { session: { finalLap: false, sectorFlags: ['none', 'none', 'none'] } });
  at(1, JSON.parse(fs.readFileSync(a, 'utf8')));
  at(47, finished);
  const ev = out.filter((l) => l.t === 'event');
  for (const e of ev) console.log(`     L${e.lap} ${e.kind.toUpperCase().padEnd(8)} ${e.text}`);
  check('the flag coming out is a final-lap line', ev.some((e) => e.kind === 'flag' && e.text === 'Chequered flag out: final lap'));
  check('our crossing under it is the finish, at our own position', ev.some((e) => e.kind === 'finish' && e.text === 'Chequered flag. Finished P28, 168 laps'),
    ev.filter((e) => e.kind === 'finish').map((e) => e.text).join());
}

(async () => {
  await fileSuite();
  mergeSuite();
  recordingsSuite();
  await probeSuite();
  fixtureSuite();
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
