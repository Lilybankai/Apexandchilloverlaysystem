/**
 * test-racelog.js — the race log's XML half (phase 1 of docs/RACE-LOG-PLAN.md).
 * -----------------------------------------------------------------------------
 * `resultsXml.ts` reads LMU's results file; `raceLog.ts` turns one car of it
 * into a timeline. Every fixture here is a real results file off Carl's PC,
 * gzipped whole (the four-hour one is 3.1 MB raw), so the traps are the game's
 * own and not a guess at them:
 *
 *   - Long Beach 2026-09-24: 33 cars, two classes. Every contact is logged
 *     once per reporting car, and every TrackLimits line twice.
 *   - Silverstone ELMS 2026-09-20: four hours, slot 9 swapped between Alwin
 *     Kalander and Igor Karpinski five times. A log follows the car.
 *   - Le Mans 2026-09-25 12:42: this PC joined at et 4404. Everything before
 *     that is back-filled with p="105", which is not a position.
 *   - 2026-02-27: a penalty reason in German.
 *
 * Run: npm run test:racelog
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const X = require(path.join(__dirname, '..', 'dist', 'telemetry', 'resultsXml.js'));
const L = require(path.join(__dirname, '..', 'dist', 'telemetry', 'raceLog.js'));

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const FIX = path.join(__dirname, 'fixtures', 'results');
const LONG_BEACH = '2026_09_24_21_38_11-49R1.xml';
const SILVERSTONE = '2026_09_20_18_28_11-74R1.xml';
const MID_JOIN = '2026_09_25_12_42_51-05R1.xml';
const LOCALISED = '2026_02_27_22_56_23-92R1.xml';

function text(id) {
  return zlib.gunzipSync(fs.readFileSync(path.join(FIX, `${id}.gz`))).toString('utf8');
}
const parsed = {};
function results(id) {
  if (!parsed[id]) parsed[id] = X.parseResultsXml(text(id));
  return parsed[id];
}
const of = (log, kind) => log.events.filter((e) => e.kind === kind);

/* -------------------------------------------------------------------------- */
console.log('parser: never throws, refuses what is not a whole file');
{
  check('empty string', X.parseResultsXml('') === null);
  check('not a string', X.parseResultsXml(undefined) === null && X.parseResultsXml(42) === null);
  check('garbage', X.parseResultsXml('<html><body>nope</body></html>') === null);
  const whole = text(LONG_BEACH);
  check('cut short mid-write', X.parseResultsXml(whole.slice(0, Math.floor(whole.length / 2))) === null);
  check('cut short one tag from the end', X.parseResultsXml(whole.slice(0, whole.lastIndexOf('</RaceResults>'))) === null);
  check('entities', X.decodeEntities('&quot;a&amp;b&lt;c&gt;&apos;&#65;&#x42;&bogus;') === `"a&b<c>'AB&bogus;`);
}

/* -------------------------------------------------------------------------- */
console.log('parser: Long Beach, header and slots');
{
  const r = results(LONG_BEACH);
  check('parsed', r !== null);
  check('a race', r.sessionType === 'race' && r.sessionTag === 'Race');
  check('course name', r.header.trackCourse === 'Grand Prix of Long Beach');
  check('track length', r.header.trackLength === 3187.4);
  check('session DateTime, not the event one', r.startedAt === 1790277519 && r.header.eventDateTime === 1790276199);
  check('33 driver blocks', r.drivers.length === 33, `${r.drivers.length}`);
  check('green flag = the shared lap-1 start', r.raceStartEt === 152.1625, `${r.raceStartEt}`);

  // <Driver> blocks are NOT in slot order and carry no slot: the first block is
  // slot 0 but the second is slot 32, and Micky Roffe (block 17) is slot 25.
  const byName = (n) => r.drivers.find((d) => d.name === n);
  check('block order is not slot order', byName('Kevin McLaughlin').slot === 32, `${byName('Kevin McLaughlin').slot}`);
  check('Micky Roffe is slot 25', byName('Micky Roffe').slot === 25);
  check('Barry Weatherston is slot 9', byName('Barry Weatherston').slot === 9);
  check('a slot is claimed once', new Set(r.drivers.filter((d) => d.slot !== null).map((d) => d.slot)).size ===
    r.drivers.filter((d) => d.slot !== null).length);

  const roffe = byName('Micky Roffe');
  check('lap list', roffe.lapList.length === 5 && roffe.lapList[0].num === 1);
  check('lap time in seconds', Math.abs(roffe.lapList[1].lapTime - 83.329) < 0.001, `${roffe.lapList[1].lapTime}`);
  const dw = byName('David Weatherston');
  check('--.---- is no time', dw.lapList[0].lapTime === null);
  check('pit flag', dw.lapList.find((l) => l.num === 44).pit === true && dw.lapList.find((l) => l.num === 43).pit === false);
  check('DNF reason', roffe.finishStatus === 'DNF' && roffe.dnfReason === 'Suspension');

  const tl = r.stream.filter((e) => e.type === 'limits' && e.slot === 25);
  check('TrackLimits written twice, kept once', tl.length === 2, `${tl.length}`);
  const inc = r.stream.filter((e) => e.type === 'incident' && Math.abs(e.et - 592.2) < 0.01);
  check('an incident is kept once per reporting car', inc.length === 2, `${inc.length}`);
  check('incident parsed', inc.some((e) => e.slot === 25 && e.otherSlot === 9 && e.magnitude === 5147.87));
  const wall = r.stream.find((e) => e.type === 'incident' && e.object === 'Immovable');
  check('scenery contact', wall && wall.otherSlot === null && wall.otherName === null);
  check('chat entities decoded', r.stream.some((e) => e.type === 'chat' && e.text.includes("you're")));
  check('checkered row', r.stream.some((e) => e.type === 'checkered' && e.name === 'Tom Mould' && e.laps === 60));
}

/* -------------------------------------------------------------------------- */
console.log('race log: Long Beach, slot 25 (Micky Roffe)');
{
  const r = results(LONG_BEACH);
  const log = L.buildRaceLog(r, 25, 'picked', LONG_BEACH);
  check('header', log.slot === 25 && log.carNumber === '718' && log.carClass === 'GT3' && log.multiclass === true);
  check('greenEt', log.greenEt === 152.1625);
  check('raceS is et minus the green flag', log.events.every((e) => Math.abs(e.raceS - (e.et - log.greenEt)) < 1e-9));
  check('events in time order', log.events.every((e, i, a) => i === 0 || a[i - 1].et <= e.et));
  check('all from the xml', log.events.every((e) => e.source === 'xml'));

  const start = of(log, 'start')[0];
  check('start: grid, overall and class', start.text === 'Green flag. Started P22 (P8 in GT3)', start.text);

  // The contact at et 592.2 is written twice, once by each car. One event.
  const barry = of(log, 'contact').filter((e) => e.detail.otherSlot === 9);
  check('592.2 contact with Barry Weatherston appears ONCE', barry.length === 1, `${barry.length}`);
  check('named with his car number', barry[0].text === 'Heavy contact with Barry Weatherston (#30)', barry[0].text);
  check('severity from the larger report (5215.96)', barry[0].detail.severity === 'heavy');
  check('no raw number in the text', !/\d{3,}/.test(barry[0].text.replace('#30', '')));
  check('the other car\'s own log has it once too',
    of(L.buildRaceLog(r, 9, 'picked'), 'contact').filter((e) => e.detail.otherSlot === 25).length === 1);
  const harris = of(log, 'contact').filter((e) => e.detail.otherSlot === 24);
  check('LMU\'s #tag is dropped from the sentence', harris[0].text === 'Light contact with Mark Harris (#5)', harris[0].text);
  check('but kept in detail', harris[0].detail.otherName === 'Mark Harris#8511');
  check('the wall, in words', of(log, 'contact').some((e) => e.text === 'Light contact with the wall' && e.detail.scenery === 'Immovable'));

  const laps = of(log, 'lap');
  check('five laps', laps.length === 5);
  check('lap text', laps[2].text === 'Lap 3  1:22.535  personal best', laps[2].text);
  check('lap 1 is not a personal best (it beats nothing)', !laps[0].detail.personalBest);
  check('lap ms', laps[1].detail.lapMs === 83329);

  const pos = of(log, 'position');
  check('lap 1 counts: gained from the grid', pos[0].lap === 1 && pos[0].text === 'Gained 6 places, now P16 (P6 in GT3)', pos[0].text);
  check('gained in detail', pos[0].detail.gained === 6 && pos[0].detail.classGained === 2);
  check('derived positions agree with the file\'s p on every lap',
    r.drivers.find((d) => d.slot === 25).lapList.every((l) => {
      const p = [...pos].reverse().find((e) => e.lap <= l.num);
      return (p ? p.detail.position : log.gridPosition) === l.p;
    }));
  check('a class-only change says so', pos.some((e) => e.text === 'Lost 1 place in class, now P14 (P6 in GT3)'));

  // Two "No Further Action" verdicts on lap 2, each written twice: folded into
  // the lap, not four events.
  check('no-action verdicts are not events', of(log, 'limits').length === 0, `${of(log, 'limits').length}`);
  check('they fold into their lap', laps[1].detail.excursions === 2 &&
    laps[1].text === 'Lap 2  1:23.329  personal best  (2 off-track, no action)', laps[1].text);
  check('a lap without any says nothing', laps[2].detail.excursions === undefined && !/off-track/.test(laps[2].text));
  // Slot 32 is warned at 754.9 and again at 756.1, both "0.25": one warning.
  const w32 = of(L.buildRaceLog(r, 32, 'picked'), 'limits');
  check('a re-filed warning a second later is one event', w32.filter((e) => e.et >= 754 && e.et <= 757).length === 1,
    `${w32.filter((e) => e.et >= 754 && e.et <= 757).length}`);
  check('no two limits events with the same points inside 2 s', w32.every((e, i) => i === 0 ||
    e.et - w32[i - 1].et > 2 || e.detail.warningPoints !== w32[i - 1].detail.warningPoints));
  const dmg = of(log, 'damage');
  check('XML damage, the double report merged', dmg.length === 1 && dmg[0].text === 'New suspension damage', dmg.map((e) => e.text).join('|'));
  const fin = of(log, 'finish');
  check('retired, with the reason, on the lap it never finished', fin.length === 1 && fin[0].text === 'Retired on lap 6: suspension', fin[0].text);
  check('cars for the picker: every car with a slot', log.cars.length === r.drivers.filter((d) => d.slot !== null).length &&
    log.cars.length >= 24, `${log.cars.length}`);
}

/* -------------------------------------------------------------------------- */
console.log('race log: Long Beach, slot 9 penalties');
{
  const log = L.buildRaceLog(results(LONG_BEACH), 9, 'picked');
  const pen = of(log, 'penalty').map((e) => e.text);
  check('given, with the reason', pen.includes('Drive-through for out of position'), pen.join('|'));
  check('served, attributed by name', pen.includes('Served the drive-through'), pen.join('|'));
}

/* -------------------------------------------------------------------------- */
console.log('race log: Silverstone ELMS, slot 9 across driver swaps');
{
  const r = results(SILVERSTONE);
  const log = L.buildRaceLog(r, 9, 'name', SILVERSTONE);
  check('both drivers, in stint order', JSON.stringify(log.drivers) === '["Alwin Kalander","Igor Karpinski"]', JSON.stringify(log.drivers));
  const swaps = of(log, 'driver');
  check('driver-swap events', swaps.length === 5, `${swaps.length}`);
  check('swap worded', swaps.some((e) => e.text === 'Igor Karpinski takes over from Alwin Kalander'));
  check('the pre-race seat change sits before the green flag', swaps[0].raceS < 0 && swaps[0].lap === 0);
  check('all 113 laps', of(log, 'lap').length === 113);
  check('pit stops', of(log, 'pit').length > 0 && of(log, 'pit').every((e) => e.detail.pitIn));
  check('finished', of(log, 'finish')[0].text === 'Chequered flag. Finished P12 (P12 in LMP2 ELMS), 113 laps', of(log, 'finish')[0].text);
  check('course name', log.track === 'Silverstone Grand Prix Circuit - ELMS');
  const nfa = r.stream.filter((e) => e.type === 'limits' && e.slot === 9 && e.resolution === 7).length;
  const folded = of(log, 'lap').reduce((n, e) => n + (e.detail.excursions || 0), 0);
  check('four hours of no-action verdicts: none as events', !of(log, 'limits').some((e) => /no further action/i.test(e.text)));
  check('all of them counted on laps', nfa > 50 && folded === nfa, `${folded} of ${nfa}`);
  // Either driver's name finds the car.
  check('found by the other driver\'s name', (L.findOurSlot(r, [], ['igor karpinski']) || {}).slot === 9);
  check('found by the first driver\'s name', (L.findOurSlot(r, [], ['Alwin Kalander']) || {}).slot === 9);
}

/* -------------------------------------------------------------------------- */
console.log('race log: mid-race join');
{
  const r = results(MID_JOIN);
  check('parsed', r !== null);
  check('stream starts late', r.firstStreamEt > 4000, `${r.firstStreamEt}`);
  const all = r.drivers.flatMap((d) => d.lapList);
  check('back-filled laps flagged', all.some((l) => l.backfilled));
  check('no p=105 survives as a position', all.every((l) => l.p !== 105 && (!l.backfilled || l.p === null)));
  // The file ends ~220 s after the join, about one Le Mans lap: the first
  // crossing after it only sets the baseline, so no car here has a position
  // event at all — and none may come from the back-filled half.
  let bad = 0;
  for (const d of r.drivers) {
    if (d.slot === null) continue;
    for (const e of of(L.buildRaceLog(r, d.slot, 'picked'), 'position')) {
      if (e.et < r.firstStreamEt || e.detail.position >= 105) bad++;
    }
  }
  check('no position said before the join', bad === 0, `${bad}`);
  const joined = L.buildRaceLog(r, 35, 'picked');
  check('the joined car still has its laps and its finish',
    of(joined, 'lap').length === 17 && of(joined, 'finish')[0].text === 'Classified P36 (P31 in GT3), 17 laps',
    of(joined, 'finish')[0] && of(joined, 'finish')[0].text);
}

/* -------------------------------------------------------------------------- */
console.log('race log: a penalty reason in German');
{
  const r = results(LOCALISED);
  const raw = r.stream.find((e) => e.type === 'penalty' && e.action === 'given' && e.slot === 6);
  check('parser keeps it verbatim', raw && raw.reason === 'Erlaubtes Energielimit überschritten.' && raw.seconds === 100);
  const pen = of(L.buildRaceLog(r, 6, 'picked'), 'penalty')[0];
  check('the log says it in English', pen && pen.text === '100 s stop-go for exceeded energy allowance limit', pen && pen.text);
  check('detail', pen && pen.detail.penaltyKind === 'Stop/Go' && pen.detail.reason === 'Exceeded energy allowance limit');
  const time = of(L.buildRaceLog(r, 16, 'picked'), 'penalty').map((e) => e.text);
  check('time penalty converted at the flag', time.includes('10 s time penalty for illegal pass') &&
    time.includes('Finished before serving the penalty: 10 s added'), time.join('|'));
}

/* -------------------------------------------------------------------------- */
console.log('contact severity');
{
  check('threshold', L.HEAVY_CONTACT_MIN === 1000);
  check('below is light', L.contactSeverity(999.99) === 'light');
  check('at it is heavy', L.contactSeverity(1000) === 'heavy');
}

/* -------------------------------------------------------------------------- */
console.log('finding our car');
{
  const r = results(LONG_BEACH);
  const roffe = r.drivers.find((d) => d.slot === 25);
  const t0 = r.startedAt * 1000;
  const lapRec = (ms, i) => ({ v: 7, at: new Date(t0 + 300_000 + i * 90_000).toISOString(), sim: 'lmu', lapMs: ms });
  const mine = roffe.lapList.filter((l) => l.lapTime !== null).map((l, i) => lapRec(Math.round(l.lapTime * 1000) + (i % 2), i));
  const hit = L.findOurSlot(r, mine, []);
  check('lap log names the slot (±2 ms)', hit && hit.slot === 25 && hit.matchedBy === 'laplog', JSON.stringify(hit));
  check('one lap is not enough', L.findOurSlot(r, mine.slice(0, 1), []) === null);
  check('laps outside the race window are ignored', L.findOurSlot(r, mine.map((l) => ({ ...l, at: '2026-01-01T00:00:00.000Z' })), []) === null);
  const byName = L.findOurSlot(r, mine.slice(0, 1), ['  MICKY roffe ']);
  check('falls back to a known name', byName && byName.slot === 25 && byName.matchedBy === 'name');
  check('nothing known: null', L.findOurSlot(r, [], ['Carl Jones']) === null);
  check('lap log outranks a name', L.findOurSlot(r, mine, ['Barry Weatherston']).slot === 25);
  check('and says who drove the matched laps', JSON.stringify(hit.names) === '["Micky Roffe"]', JSON.stringify(hit.names));

  // A team race: the lap log follows the car, so it also holds laps a
  // team-mate drove while this PC watched. Only the majority stint is us.
  const s = results(SILVERSTONE);
  const car = s.drivers.find((d) => d.slot === 9);
  const stintOf = (num) => car.swaps.find((w) => num >= w.startLap && num <= w.endLap).name;
  const timed = car.lapList.filter((l) => l.lapTime !== null);
  const recs = (list) => list.map((l, i) => ({ v: 7, at: new Date(s.startedAt * 1000 + 600_000 + i * 60_000).toISOString(),
    sim: 'lmu', lapMs: Math.round(l.lapTime * 1000) }));
  const kal = timed.filter((l) => stintOf(l.num) === 'Alwin Kalander').slice(0, 10);
  const kar = timed.filter((l) => stintOf(l.num) === 'Igor Karpinski');
  const team = L.findOurSlot(s, recs([...kal, ...kar.slice(0, 2)]), []);
  check('team race: slot by lap log', team && team.slot === 9 && team.matchedBy === 'laplog');
  check('team race: a clear majority (10 of 12) is learnt', JSON.stringify(team.names) === '["Alwin Kalander"]', JSON.stringify(team.names));
  const split = L.findOurSlot(s, recs([...kal.slice(0, 5), ...kar.slice(0, 5)]), []);
  check('an even split learns nobody', split && split.slot === 9 && split.names.length === 0, JSON.stringify(split && split.names));
  // Carl's short opening stint with the PC left recording: the old 60% rule
  // learnt the team-mate from splits like 31/9. 10 of 13 is 77%: the car is
  // placed, nobody is learnt.
  const weak = L.findOurSlot(s, recs([...kal, ...kar.slice(0, 3)]), []);
  check('seed rule: under 80% learns nobody', L.SEED_MAJORITY === 0.8 && weak && weak.slot === 9 && weak.names.length === 0,
    JSON.stringify(weak && weak.names));
  const few = L.findOurSlot(s, recs(kal.slice(0, 4)), []);
  check('seed rule: 4 matched laps place the car but name nobody', L.SEED_MIN_LAPS === 5 && few && few.slot === 9 &&
    few.names.length === 0, JSON.stringify(few));
  check('seed rule: 5 do', JSON.stringify(L.findOurSlot(s, recs(kal.slice(0, 5)), []).names) === '["Alwin Kalander"]');
}

/* -------------------------------------------------------------------------- */
console.log('listing, loading, picks and names');
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-racelog-'));
  const resultsDir = path.join(tmp, 'Results');
  const stateDir = path.join(tmp, 'racelog');
  fs.mkdirSync(resultsDir);
  for (const id of [LONG_BEACH, SILVERSTONE, MID_JOIN, LOCALISED]) fs.writeFileSync(path.join(resultsDir, id), text(id));
  fs.writeFileSync(path.join(resultsDir, '2026_09_24_21_00_00-11Q1.xml'), 'qualifying: never listed');
  fs.writeFileSync(path.join(resultsDir, '2026_09_24_22_00_00-12R1.xml'), '<rFactorXML><RaceResults>cut');
  // Four of Micky Roffe's Long Beach laps in the lap log. Nothing else is known.
  const lbr = results(LONG_BEACH);
  const roffeLaps = lbr.drivers.find((d) => d.slot === 25).lapList.filter((l) => l.lapTime !== null)
    .map((l, i) => ({ v: 7, at: new Date(lbr.startedAt * 1000 + 300_000 + i * 90_000).toISOString(), sim: 'lmu',
      lapMs: Math.round(l.lapTime * 1000) }));
  const opts = { stateDir, laps: roffeLaps };

  try {
    check('no names known yet', L.readKnownNames(stateDir).length === 0);
    const list = await L.listRaceLogsAsync(resultsDir, opts);
    check('the lap-log match taught us the name', JSON.stringify(L.readKnownNames(stateDir)) === '["Micky Roffe"]',
      JSON.stringify(L.readKnownNames(stateDir)));
    // Roffe also drove in the mid-race-join file, which the lap log cannot place.
    check('and the name places a race the lap log could not, in the same listing',
      list.find((x) => x.id === MID_JOIN).slot === 35, `${list.find((x) => x.id === MID_JOIN).slot}`);
    check('a repeat of a known name adds nothing', (await L.rememberDriverName('micky  ROFFE', stateDir)) === false);
    check('names remembered once', JSON.stringify(L.readKnownNames(stateDir)) === '["Micky Roffe"]', JSON.stringify(L.readKnownNames(stateDir)));
    check('R1 files only, the broken one skipped', list.length === 4, `${list.length}`);
    check('newest first', list.every((s, i, a) => i === 0 || a[i - 1].startedAt >= s.startedAt));
    const lb = list.find((s) => s.id === LONG_BEACH);
    check('Long Beach found by lap log', lb.slot === 25 && lb.carClass === 'GT3' && lb.finishPosition === 20);
    check('contacts counted once each', lb.contacts === of(L.buildRaceLog(results(LONG_BEACH), 25, 'picked'), 'contact').length, `${lb.contacts}`);
    check('Silverstone not ours', list.find((s) => s.id === SILVERSTONE).slot === null);
    check('index written', fs.existsSync(path.join(stateDir, 'index.json')));

    const again = L.listRaceLogs(resultsDir, opts);
    check('sync listing agrees', JSON.stringify(again) === JSON.stringify(list));

    const none = L.loadRaceLog(SILVERSTONE, resultsDir, opts);
    check('no car found: slot null, the field to pick from', none.slot === null && none.events.length === 0 && none.cars.length > 30);
    check('pick saved', L.setPickedSlot(SILVERSTONE, 9, stateDir));
    const picked = L.loadRaceLog(SILVERSTONE, resultsDir, opts);
    check('pick used', picked.slot === 9 && picked.matchedBy === 'picked');
    check('pick shows in the list', L.listRaceLogs(resultsDir, opts).find((s) => s.id === SILVERSTONE).slot === 9);
    check('pick forgotten', L.setPickedSlot(SILVERSTONE, null, stateDir) && L.loadRaceLog(SILVERSTONE, resultsDir, opts).slot === null);
    check('a bad id is refused', L.loadRaceLog('..\\..\\secret-R1.xml', resultsDir, opts) === null &&
      !L.setPickedSlot('../x.xml', 1, stateDir));
    check('a missing file is null', L.loadRaceLog('2020_01_01_00_00_00-00R1.xml', resultsDir, opts) === null);
    check('no results folder: empty, not a throw', L.listRaceLogs(null, opts).length === 0 &&
      L.listRaceLogs(path.join(tmp, 'nope'), opts).length === 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ------------------------------------------------------------------------ */
  console.log('live log: merged on load, and live-only races listed');
  const M = require(path.join(__dirname, '..', 'dist', 'telemetry', 'raceLogMerge.js'));
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-racelog-live-'));
  const resultsDir2 = path.join(tmp2, 'Results');
  const stateDir2 = path.join(tmp2, 'racelog');
  fs.mkdirSync(resultsDir2);
  fs.mkdirSync(stateDir2);
  try {
    fs.writeFileSync(path.join(resultsDir2, LONG_BEACH), text(LONG_BEACH));
    const lbr = results(LONG_BEACH);
    // The recorder's clock for this race: et 0 sits where the file's write
    // time says it must (write = start + last et + ~80 s). Slot 25 retired on
    // lap 6, an hour before that, which is the case pairing must survive.
    const start = M.writtenAt(LONG_BEACH) - lbr.lastEt * 1000 - 80_000;
    const key = `Grand Prix of Long Beach|race|${Math.round(start / 1000)}`;
    const ev = (et, kind, txt, detail) => ({ t: 'event', key, at: Math.round(start + et * 1000), et, lap: 1, kind,
      text: txt, ...(detail ? { detail } : {}) });
    const header = (k, track, startMs, slot) => ({ t: 'header', v: 1, key: k, track, sessionType: 'race', source: 'lmu',
      sessionStartMs: startMs, firstAt: startMs + 100_000, firstEt: 100, firstPhase: 'formation', slot, multiclass: true });
    // A crashed race at Spa three days earlier: no results file anywhere.
    const spaStart = start - 3 * 86_400_000;
    const spaKey = `Circuit de Spa-Francorchamps|race|${Math.round(spaStart / 1000)}`;
    const spa = (et, kind, txt, detail) => ({ t: 'event', key: spaKey, at: Math.round(spaStart + et * 1000), et, lap: 1,
      kind, text: txt, ...(detail ? { detail } : {}) });
    const lines = [
      header(key, 'Grand Prix of Long Beach', start, 25),
      ev(152.2, 'start', 'Green flag'),
      ev(300, 'flag', 'Full course yellow'),
      ev(400, 'contact', 'Contact with Nobody Inthexml', { otherName: 'Nobody Inthexml' }),
      ev(592.4, 'contact', 'Contact with Barry Weatherston', { otherName: 'Barry Weatherston' }),
      ev(592.6, 'damage', 'Major damage: front-left suspension', { grade: 'major', zones: ['front-left suspension'] }),
      header(spaKey, 'Circuit de Spa-Francorchamps', spaStart, 4),
      spa(120, 'start', 'Green flag. Started P3'),
      spa(260, 'lap', 'Lap 1  2:20.000', { lapMs: 140_000 }),
      spa(300, 'contact', 'Contact with the wall', { scenery: 'Immovable' }),
    ];
    fs.writeFileSync(path.join(stateDir2, 'live-2026-09-24.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    L.setPickedSlot(LONG_BEACH, 25, stateDir2);
    // The live files are read LIVE_DAYS back from `now`: pinned, so the test
    // does not age out of its own window.
    const now = Date.parse('2026-09-30T12:00:00Z');
    const opts2 = { stateDir: stateDir2, laps: [], now };

    const merged = L.loadRaceLog(LONG_BEACH, resultsDir2, opts2);
    const liveEv = merged.events.filter((e) => e.source === 'live');
    check('live flags merged', liveEv.some((e) => e.kind === 'flag' && e.text === 'Full course yellow'));
    check('graded damage merged', liveEv.some((e) => e.kind === 'damage' && e.detail.grade === 'major'));
    check('a live contact the XML also has is dropped',
      !liveEv.some((e) => e.kind === 'contact' && /Barry/.test(e.text)) &&
      merged.events.filter((e) => e.kind === 'contact' && e.detail.otherSlot === 9).length === 1);
    check('a live contact the XML lacks is kept', liveEv.some((e) => e.kind === 'contact' && /Nobody/.test(e.text)));
    check('the live start is not doubled', of(merged, 'start').length === 1);
    check('still the XML log', merged.provisional === false && merged.matchedBy === 'picked');
    check('merged in time order', merged.events.every((e, i, a) => i === 0 || a[i - 1].et <= e.et));
    L.setPickedSlot(LONG_BEACH, 9, stateDir2);
    check('never merged into a car the recorder did not follow',
      !L.loadRaceLog(LONG_BEACH, resultsDir2, opts2).events.some((e) => e.source === 'live'));

    const list2 = await L.listRaceLogsAsync(resultsDir2, opts2);
    const prov = list2.filter((x) => x.provisional);
    check('a live race with a results file is not listed twice', list2.length === 2 && prov.length === 1,
      JSON.stringify(list2.map((x) => x.id)));
    check('the crashed race is listed as provisional', prov[0] && prov[0].id === `live:${spaKey}` && prov[0].slot === 4 &&
      prov[0].contacts === 1 && prov[0].track === 'Circuit de Spa-Francorchamps', JSON.stringify(prov[0]));
    const pl = prov[0] && L.loadRaceLog(prov[0].id, resultsDir2, opts2);
    check('and loads by its live id', pl && pl.provisional === true && pl.matchedBy === 'live' && pl.id === prov[0].id &&
      pl.events.length === 3, JSON.stringify(pl && { p: pl.provisional, m: pl.matchedBy, n: pl.events.length }));
    check('an unknown live id is null', L.loadRaceLog('live:nope', resultsDir2, opts2) === null);

    const asyncLog = await L.loadRaceLogAsync(LONG_BEACH, resultsDir2, opts2);
    check('loadRaceLogAsync gives the sync answer', JSON.stringify(asyncLog) === JSON.stringify(L.loadRaceLog(LONG_BEACH, resultsDir2, opts2)));
    check('and for a live id', JSON.stringify(await L.loadRaceLogAsync(prov[0].id, resultsDir2, opts2)) === JSON.stringify(pl));

    // No results folder at all (game not found): the recorder's races are still
    // there, the Long Beach one now unpaired too.
    const noDir = await L.listRaceLogsAsync(null, opts2);
    check('no results folder still lists live-only races', noDir.length === 2 && noDir.every((x) => x.provisional) &&
      noDir.some((x) => x.id === `live:${spaKey}`), JSON.stringify(noDir.map((x) => x.id)));
    check('an unreadable results folder too', L.listRaceLogs(path.join(tmp2, 'gone'), opts2).length === 2);

    // The window: 14 days back from `now`, by the file's day, like loadLiveLog.
    const late = { ...opts2, now: Date.parse('2026-10-09T12:00:00Z') };
    check('LIVE_DAYS is the recorder\'s 14', L.LIVE_DAYS === 14);
    check('a live file older than the window is not read', !L.listRaceLogs(null, late).some((x) => x.provisional) &&
      L.loadRaceLog(prov[0].id, resultsDir2, late) === null);
    check('inside the window it is', L.listRaceLogs(null, { ...opts2, now: Date.parse('2026-10-08T00:00:00Z') }).length === 2);

    // The cache: same name, mtime and size is not read again. Garbage of the
    // same length under the same mtime still lists the race it replaced.
    const liveFile = path.join(stateDir2, 'live-2026-09-24.jsonl');
    const stamp = new Date('2026-09-24T22:00:00Z');
    fs.utimesSync(liveFile, stamp, stamp);
    check('listed before the swap', (await L.listRaceLogsAsync(null, opts2)).length === 2);
    const size = fs.statSync(liveFile).size;
    fs.writeFileSync(liveFile, 'x'.repeat(size));
    fs.utimesSync(liveFile, stamp, stamp);
    check('an unchanged file (name, mtime, size) is not re-read', (await L.listRaceLogsAsync(null, opts2)).length === 2);
    fs.appendFileSync(liveFile, '\n');
    check('a changed one is', (await L.listRaceLogsAsync(null, opts2)).length === 0);
  } finally {
    fs.rmSync(tmp2, { recursive: true, force: true });
  }

  /* ------------------------------------------------------------------------ */
  console.log('live log: the linear parse gives the recorder\'s answer');
  {
    const R = require(path.join(__dirname, '..', 'dist', 'telemetry', 'raceLogRecorder.js'));
    const t0 = Date.parse('2026-09-24T23:50:00Z');
    const hdr = (key, track, start, extra) => ({ t: 'header', v: 1, key, track, sessionType: 'race', source: 'lmu',
      sessionStartMs: start, firstAt: start + 1000, firstEt: 1, firstPhase: 'formation', slot: null, multiclass: false, ...extra });
    const evt = (key, at, et, kind, txt) => ({ t: 'event', key, at, et, lap: 1, kind, text: txt });
    // Day one: a race, then an app restart (new key, start 20 s off: the same
    // race) that re-reads the same lines. Day two: the race goes on past
    // midnight, plus a second race at another track and a line with no header.
    const day1 = [
      hdr('A1', 'Spa', t0), evt('A1', t0 + 5000, 5, 'start', 'Green flag'),
      evt('A1', t0 + 60_000, 60, 'contact', 'Contact with X'), evt('A1', t0 + 61_000, null, 'flag', 'Yellow'),
      hdr('A2', 'Spa', t0 + 20_000, { slot: 7, driver: 'Carl' }),
      evt('A2', t0 + 60_400, 60.4, 'contact', 'Contact with X'), evt('A2', t0 + 61_500, null, 'flag', 'Yellow'),
      evt('A2', t0 + 62_600, 61.2, 'flag', 'Yellow'), evt('A2', t0 + 62_700, null, 'flag', 'Yellow'),
    ];
    const day2 = [
      hdr('A2', 'Spa', t0 + 20_000, { carClass: 'GT3' }),
      evt('A2', t0 + 700_000, 700, 'lap', 'Lap 5  2:20.000'), evt('A2', t0 + 700_900, 700.9, 'lap', 'Lap 5  2:20.000'),
      evt('A2', t0 + 800_000, 800, 'finish', 'Chequered flag'),
      evt('Z', t0 + 1, 1, 'lap', 'orphan'),
      hdr('B', 'Monza', t0 + 600_000), evt('B', t0 + 605_000, 5, 'start', 'Green flag'),
    ];
    const text = [...day1, ...day2].map((l) => JSON.stringify(l)).join('\n');
    const mine = L.liveRacesOf([day1, day2]);
    check('same races, events, header and flags as parseLiveLog', JSON.stringify(mine) === JSON.stringify(R.parseLiveLog(text)),
      `${JSON.stringify(mine).slice(0, 300)}`);
    check('the restart is one race, deduped', mine.length === 2 && mine[0].events.length === 6 && mine[0].header.slot === 7 &&
      mine[0].header.carClass === 'GT3' && mine[0].finished, JSON.stringify(mine.map((r) => r.events.map((e) => e.text))));

    // Linear: 20 000 laps each recorded twice by a restart. The recorder's
    // dedupe compares every line with every one kept (~400 M comparisons).
    const k = 'Spa|race|1';
    const big = [hdr(k, 'Spa', t0)];
    for (let i = 0; i < 20_000; i++) big.push(evt(k, t0 + i * 100_000, i * 100, 'lap', `Lap ${i}  1:40.000`));
    for (let i = 0; i < 20_000; i++) big.push(evt(k, t0 + i * 100_000 + 300, i * 100 + 0.3, 'lap', `Lap ${i}  1:40.000`));
    const t = Date.now();
    const bigRaces = L.liveRacesOf([big]);
    const ms = Date.now() - t;
    check('40 000 lines in well under a second', ms < 1000 && bigRaces[0].events.length === 20_000, `${ms} ms, ${bigRaces[0].events.length}`);
  }

  /* ------------------------------------------------------------------------ */
  console.log('names.json: concurrent writers lose nothing');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-racelog-names-'));
    try {
      // The provider's rememberDriverName and the listing's seedNames both
      // write it; with one shared tmp name one rename lost the other's name.
      const res = await Promise.all([
        L.rememberDriverName('Alpha One', dir), L.seedNames(['Bravo Two', 'Charlie Three'], dir),
        L.rememberDriverName('Delta Four', dir), L.seedNames(['Echo Five', 'alpha  ONE'], dir),
        L.rememberDriverName('Foxtrot Six', dir),
      ]);
      const names = L.readKnownNames(dir);
      check('every name kept', JSON.stringify([...names].sort()) ===
        '["Alpha One","Bravo Two","Charlie Three","Delta Four","Echo Five","Foxtrot Six"]', JSON.stringify(names));
      check('each added once', res[3].length === 1 && res[3][0] === 'Echo Five', JSON.stringify(res));
      check('no temp files left behind', fs.readdirSync(dir).every((n) => !n.endsWith('.tmp')), fs.readdirSync(dir).join(','));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /* ------------------------------------------------------------------------ */
  console.log('seeding: never a team-mate as us, and a wrong name is forgotten');
  {
    const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-racelog-seed-'));
    const mk = (sub, files) => {
      const dir = path.join(tmp3, sub);
      fs.mkdirSync(path.join(dir, 'Results'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'state'));
      for (const [id, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'Results', id), body);
      return { results: path.join(dir, 'Results'), state: path.join(dir, 'state') };
    };
    const setNames = (d, names) => fs.writeFileSync(path.join(d.state, 'names.json'), JSON.stringify(names));
    try {
      // Silverstone slot 9: ten of Igor Karpinski's laps and one of Alwin
      // Kalander's in the lap log. 91%, so Karpinski is proposed.
      const s = results(SILVERSTONE);
      const car = s.drivers.find((d) => d.slot === 9);
      const stintOf = (num) => car.swaps.find((w) => num >= w.startLap && num <= w.endLap).name;
      const timed = car.lapList.filter((l) => l.lapTime !== null);
      const recs = timed.filter((l) => stintOf(l.num) === 'Igor Karpinski').slice(0, 10)
        .concat(timed.filter((l) => stintOf(l.num) === 'Alwin Kalander').slice(0, 1))
        .map((l, i) => ({ v: 7, at: new Date(s.startedAt * 1000 + 600_000 + i * 60_000).toISOString(), sim: 'lmu',
          lapMs: Math.round(l.lapTime * 1000) }));
      const fresh = mk('fresh', { [SILVERSTONE]: text(SILVERSTONE) });
      await L.listRaceLogsAsync(fresh.results, { stateDir: fresh.state, laps: recs });
      check('control: nothing known, the clear majority is learnt',
        JSON.stringify(L.readKnownNames(fresh.state)) === '["Igor Karpinski"]', JSON.stringify(L.readKnownNames(fresh.state)));
      const kn = mk('known', { [SILVERSTONE]: text(SILVERSTONE) });
      setNames(kn, ['Alwin Kalander']);
      await L.listRaceLogsAsync(kn.results, { stateDir: kn.state, laps: recs });
      check('a known name drove that car: the listing learns nobody new',
        JSON.stringify(L.readKnownNames(kn.state)) === '["Alwin Kalander"]', JSON.stringify(L.readKnownNames(kn.state)));
      await L.loadRaceLogAsync(SILVERSTONE, kn.results, { stateDir: kn.state, laps: recs });
      check('nor does opening the race', JSON.stringify(L.readKnownNames(kn.state)) === '["Alwin Kalander"]',
        JSON.stringify(L.readKnownNames(kn.state)));

      // Long Beach placed by name on Barry Weatherston's car (slot 9); the
      // driver says it was slot 25. Barry never drove 25: forgotten.
      const wrong = mk('wrong', { [LONG_BEACH]: text(LONG_BEACH) });
      setNames(wrong, ['Barry Weatherston', 'Somebody Else']);
      const o = { stateDir: wrong.state, laps: [] };
      check('placed by name', (await L.listRaceLogsAsync(wrong.results, o))[0].slot === 9);
      check('the pick is saved', await L.pickSlotAsync(LONG_BEACH, 25, wrong.results, o));
      check('the name that placed it wrongly is forgotten', JSON.stringify(L.readKnownNames(wrong.state)) === '["Somebody Else"]',
        JSON.stringify(L.readKnownNames(wrong.state)));
      check('and the pick holds', (await L.listRaceLogsAsync(wrong.results, o))[0].slot === 25 &&
        (await L.loadRaceLogAsync(LONG_BEACH, wrong.results, o)).matchedBy === 'picked');

      // The same, but Barry also drove slot 25 (a seat change): kept.
      const lb = text(LONG_BEACH);
      const swapped = lb.replace('<Stream>', '<Stream>\n<DriverChange et="10.0">Slot=25 Vehicle=&quot;x&quot; ' +
        'Old=&quot;Micky Roffe&quot; New=&quot;Barry Weatherston&quot;</DriverChange>');
      const both = mk('both', { [LONG_BEACH]: swapped });
      setNames(both, ['Barry Weatherston']);
      const ob = { stateDir: both.state, laps: [] };
      check('still placed on slot 9 (most laps)', (await L.listRaceLogsAsync(both.results, ob))[0].slot === 9);
      L.pickSlot(LONG_BEACH, 25, both.results, ob);
      check('a name that also drove the picked car is kept', JSON.stringify(L.readKnownNames(both.state)) === '["Barry Weatherston"]',
        JSON.stringify(L.readKnownNames(both.state)));

      // Placed by the lap log, not a name: a re-pick unlearns nothing.
      const lbr = results(LONG_BEACH);
      const roffe = lbr.drivers.find((d) => d.slot === 25).lapList.filter((l) => l.lapTime !== null)
        .map((l, i) => ({ v: 7, at: new Date(lbr.startedAt * 1000 + 300_000 + i * 90_000).toISOString(), sim: 'lmu',
          lapMs: Math.round(l.lapTime * 1000) }));
      const byLaps = mk('laps', { [LONG_BEACH]: text(LONG_BEACH) });
      setNames(byLaps, ['Micky Roffe']);
      L.pickSlot(LONG_BEACH, 9, byLaps.results, { stateDir: byLaps.state, laps: roffe });
      check('a lap-log match is not a name\'s fault', JSON.stringify(L.readKnownNames(byLaps.state)) === '["Micky Roffe"]');
      check('forgetting a pick unlearns nothing', L.pickSlot(LONG_BEACH, null, wrong.results, o) &&
        JSON.stringify(L.readKnownNames(wrong.state)) === '["Somebody Else"]');
    } finally {
      fs.rmSync(tmp3, { recursive: true, force: true });
    }
  }

  /* ------------------------------------------------------------------------ */
  console.log('R2 races, the Game folder, the stepped parse');
  {
    const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-racelog-r2-'));
    try {
      const root = path.join(tmp4, 'LMU');
      const res = path.join(root, 'UserData', 'Log', 'Results');
      fs.mkdirSync(res, { recursive: true });
      const R2 = '2026_09_24_21_38_11-49R2.xml';
      fs.writeFileSync(path.join(res, R2), text(LONG_BEACH));
      fs.writeFileSync(path.join(res, '2026_09_24_21_00_00-11P2.xml'), text(LONG_BEACH));
      fs.writeFileSync(path.join(res, '2026_09_24_21_00_00-11Q2.xml'), text(LONG_BEACH));
      const st = path.join(tmp4, 'state');
      const list = L.listRaceLogs(res, { stateDir: st, laps: [] });
      check('a second race of the weekend (R2) is listed, P2/Q2 are not', list.length === 1 && list[0].id === R2,
        JSON.stringify(list.map((x) => x.id)));
      check('and opens, and takes a pick', L.loadRaceLog(R2, res, { stateDir: st, laps: [] }) !== null &&
        L.setPickedSlot(R2, 25, st) && !L.setPickedSlot('2026_09_24_21_00_00-11P2.xml', 25, st));

      check('the Game folder picker comes first', L.defaultResultsDir({ APEX_LMU_ROOT: `${root}\\`, APEX_LMU_LOG_DIR: tmp4 }) === res,
        L.defaultResultsDir({ APEX_LMU_ROOT: root }));
      check('a picked folder with no Results falls back to the lookup',
        L.defaultResultsDir({ APEX_LMU_ROOT: path.join(tmp4, 'empty'), APEX_LMU_LOG_DIR: tmp4 }) === path.join(tmp4, 'Results'));
    } finally {
      fs.rmSync(tmp4, { recursive: true, force: true });
    }
    const whole = text(SILVERSTONE);
    const it = X.parseResultsSteps(whole);
    let steps = 0;
    let step;
    while (!(step = it.next()).done) steps++;
    check('the parse comes in steps', steps > 20, `${steps}`);
    check('with the one-shot answer', JSON.stringify(step.value) === JSON.stringify(X.parseResultsXml(whole)));
  }

  console.log(`\ntest-racelog: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
