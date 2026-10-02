/**
 * scripts/test-engineer-guard.js — the Tier-2 number guard and lap clock.
 * -----------------------------------------------------------------------------
 * supabase/functions/engineer/guard.ts is plain TypeScript with no Deno APIs.
 * It is transpiled here with the repo's own TypeScript and run under Node, so
 * the file this checks is byte-for-byte the file the edge function bundles.
 *
 *   1. lapClock / speakable / clockify — the formatting either side of the model
 *   2. spokenFigures — digits, clocks, number words, labels
 *   3. The ten real failures (scripts/fixtures/engineer-guard-calls.json): the
 *      guard must CATCH failures 1, 2 and 3, and PASS every correct answer
 *   4. The same questions against a v5 summary built by engineerSummary from a
 *      frame: right answers pass, neighbour-substituted answers are caught
 *
 * Run: npm run build && node scripts/test-engineer-guard.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function loadGuard() {
  const file = path.join(__dirname, '..', 'supabase', 'functions', 'engineer', 'guard.ts');
  const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
    fileName: file,
  });
  const m = new Module(file);
  m._compile(out.outputText, file);
  return m.exports;
}

const G = loadGuard();
const { engineerSummary } = require('../dist/telemetry/engineerSummary');
const { UNKNOWN_VALUE } = require('../dist/telemetry/types');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const show = (v) => JSON.stringify(v);

console.log('\n1) the lap clock either side of the model');
{
  check('106.4 → 1:46.4', G.lapClock(106.4) === '1:46.4', G.lapClock(106.4));
  check('63.44 → 1:03.4', G.lapClock(63.44) === '1:03.4', G.lapClock(63.44));
  check('119.96 rounds up to 2:00.0', G.lapClock(119.96) === '2:00.0', G.lapClock(119.96));
  check('sub-minute is not a clock', G.lapClock(45.2) === null);
  check('speakable 1:46.4 → "1 46.4" (Tier 1\'s shape)', G.speakable('Your average is 1:46.4.') === 'Your average is 1 46.4.');
  check('speakable 1:03.4 → "1 oh 3.4"', G.speakable('Best 1:03.4') === 'Best 1 oh 3.4');
  check('speakable leaves gaps alone', G.speakable('9.4 seconds back') === '9.4 seconds back');
  const c = G.clockify({
    lastLapSec: 103.6, myAvgLapSec: 106.4, paceCompetitiveSec: 79.4, fuelL: 70.2,
    ahead: { name: 'X', gapSec: 61.2, lastLapSec: 102.7 },
    classLeader: { name: 'Y', gapSec: 9.4, bestLapSec: 81.9 },
    classStandings: [{ pos: 1, name: 'Y', gap: 0, last: 82.04, toMe: 75 }],
  });
  check('top-level lap fields clocked', c.lastLapSec === '1:43.6' && c.myAvgLapSec === '1:46.4' && c.paceCompetitiveSec === '1:19.4', show(c));
  check('non-lap fields untouched, even past 60', c.fuelL === 70.2 && c.ahead.gapSec === 61.2 && c.classStandings[0].toMe === 75);
  check('rival and leader laps clocked', c.ahead.lastLapSec === '1:42.7' && c.classLeader.bestLapSec === '1:21.9');
  check('sheet rows clocked', c.classStandings[0].last === '1:22.0');
}

console.log('\n2) figures read out of an answer');
{
  const vals = (s) => G.spokenFigures(s).map((f) => f.readings.map((r) => r.map((x) => +x.value.toFixed(3)).join('+')).join('|'));
  check('digits', show(vals('Gap is 2.4 seconds')) === show(['2.4']), show(vals('Gap is 2.4 seconds')));
  check('clock', show(vals('Last lap 1:46.4')) === show(['106.4']));
  check('Tier-1 spoken clock', vals('Your best is 1 43.1.')[0].startsWith('103.1'), show(vals('Your best is 1 43.1.')));
  check('"twenty point nine"', show(vals('twenty point nine seconds')) === show(['20.9']));
  const owt = vals('one twenty-two point three')[0];
  check('"one twenty-two point three" reads as 122.3 or 1:22.3', owt.includes('122.3') && owt.includes('82.3'), owt);
  check('"one oh six point four" reads as 106.4', vals('one oh six point four')[0].includes('106.4'));
  check('"one minute twenty-two" = 82', vals('one minute twenty-two')[0].includes('82'));
  check('"one hundred and six" = 106', vals('one hundred and six')[0].split('|').includes('106'), vals('one hundred and six')[0]);
  check('ordinals and sector labels are not figures', vals('5th in class, S1 and sector 2 and sector three').length === 0, show(vals('5th in class, S1 and sector 2 and sector three')));
  check('a sector label does not eat the figure after it',
    show(vals("You're 2.9 down in sector 1 and 1.1 in sector 2.")) === show(['2.9', '1.1']),
    show(vals("You're 2.9 down in sector 1 and 1.1 in sector 2.")));
  check('a sentence-opening "Oh" is not zero', vals('Oh, copy that.').length === 0);
  check('"it\'s 3 laps" keeps its 3', show(vals("it's 3 laps")) === show(['3']));
  const p = G.spokenFigures('P5 is close');
  check('P5 is a position label', p.length === 1 && p[0].kind === 'position');
}

console.log('\n3) the ten real failures (2026-09-27..10-01)');
const calls = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'engineer-guard-calls.json'), 'utf8')).calls;
for (const c of calls) {
  // The guard sees what the model saw: the clockified summary.
  const summary = G.clockify(c.summary);
  const v = G.guardAnswer({ question: c.question, answer: c.answer, summary, previous: c.previous });
  const want = c.expect === 'catch' ? !v.ok : v.ok;
  check(`${c.id} "${c.question}" → "${c.answer}" is ${c.expect === 'catch' ? 'CAUGHT' : 'passed'}`, want,
    `unsupported=${show(v.unsupported)} targets=${show(v.targets)}`);
  if (c.better) {
    const b = G.guardAnswer({ question: c.question, answer: c.better, summary, previous: c.previous });
    check(`${c.id} correct answer passes: "${c.better}"`, b.ok, show(b.unsupported));
  }
  if (c.badDerived) {
    const b = G.guardAnswer({ question: c.question, answer: c.badDerived, summary, previous: c.previous });
    check(`${c.id} plausible wrong answer caught: "${c.badDerived}"`, !b.ok, show(b.unsupported));
  }
}
{
  const f1 = calls.find((c) => c.id === 'F1a');
  const v = G.guardAnswer({ question: f1.question, answer: f1.answer, summary: G.clockify(f1.summary), previous: null });
  check('F1a names its target and knows it is missing', show(v.targets) === show(['P5']) && v.missingTarget);
  check('replacement line names the car', G.noReadLine(v) === "No timing on P5 from here, I'm afraid.", G.noReadLine(v));
  check('replacement varies against the previous line',
    G.noReadLine(v, "No timing on P5 from here, I'm afraid.") !== "No timing on P5 from here, I'm afraid.");
  const f3 = calls.find((c) => c.id === 'F3');
  const v3 = G.guardAnswer({ question: f3.question, answer: f3.answer, summary: G.clockify(f3.summary), previous: null });
  check('F3 catches BOTH borrowed figures (9.4 and 81.9)', show(v3.unsupported) === show(['9.4', '81.9']), show(v3.unsupported));
  check('F3 replacement speaks of the leader', /leader/.test(G.noReadLine(v3)), G.noReadLine(v3));
  const f6 = calls.find((c) => c.id === 'F6');
  check('F6: the model now sees myAvgLapSec as "1:46.4"', G.clockify(f6.summary).myAvgLapSec === '1:46.4');
}

console.log('\n4) the same questions against a v5 summary with the class timing sheet');
{
  // A 20-car GT3 class; the player is P16. Gaps grow unevenly and
  // laps step 0.37 s a place, so no two cars share a figure.
  const standings = [];
  for (let p = 1; p <= 20; p++) {
    standings.push({
      slotId: p, position: p, classPosition: p, carClass: 'GT3', driverName: `Driver Name${p}`,
      carNumber: String(100 + p),
      gapToLeaderSec: (p - 1) * 3.1 + p * p / 50, gapToClassLeaderSec: (p - 1) * 3.1 + p * p / 50, gapToAheadSec: 3.1,
      lapsBehind: 0, classLapsBehind: 0,
      lastLapSec: 80 + p * 0.37, bestLapSec: 79 + p * 0.29,
      lastSector1Sec: 25 + p / 100, lastSector2Sec: 52 + p / 50,
      lapsCompleted: 7, inPit: false, pitStops: p % 3, isPlayer: p === 16,
    });
  }
  const frame = {
    connected: true,
    session: { type: 'race', phase: 'green', flag: 'green', track: 'Long Beach', timeRemainingSec: 900, lapsRemaining: 10, currentLap: 8 },
    player: { tyres: { frontLeft: {}, frontRight: {}, rearLeft: {}, rearRight: {} } },
    standings, relative: [], weather: { trackTempC: 30, ambientTempC: 22, rainIntensity: 0, forecast: [] },
    fuel: { levelLiters: 40, lapsRemaining: 12, lapsToFinish: 10, fuelToFinishLiters: 30, fuelDeltaLiters: 10, refuelToFinishLiters: 0 },
  };
  const raw = engineerSummary(frame);
  const s = G.clockify(raw);
  const row = (p) => raw.classStandings.find((r) => r.pos === p);
  const ask = (q, a, previous) => G.guardAnswer({ question: q, answer: a, summary: s, previous });
  check('P10 is on the sheet for a P16 driver', !!row(10), show(raw.classStandings.map((r) => r.pos)));

  const p10 = row(10);
  check(`"gap to P10." → "${p10.toMe} seconds" passes`, ask('gap to P10.', `P10 is ${p10.toMe} seconds up the road.`).ok);
  check('"gap to P10." → the gap to the car ahead (P15) is caught', !ask('gap to P10.', `Gap to P10 is ${row(15).toMe} seconds.`).ok);

  const p5 = row(5);
  const p5last = G.lapClock(p5.last);
  check(`"pace of P5?" → "${p5last}" passes`, ask('what is the pace of P5?', `P5's last lap was ${p5last}, best ${G.lapClock(p5.best)}.`).ok);
  check('"pace of P5?" → P6\'s lap is caught', !ask('what is the pace of P5?', `P5 is on a ${G.lapClock(row(6).last)}.`).ok);
  check('"pace of P5?" → the Competitive target is caught',
    !ask('what is the pace of P5?', `P5 is doing ${s.paceCompetitiveSec || '1:19.4'}.`).ok);
  check('follow-up "and in minutes?" inherits P5 and passes its figure',
    ask('give me that in minutes', `That's ${p5last}.`, { question: 'what is the pace of P5?', answer: `P5 is on ${p5.last} seconds.` }).ok);
  check('follow-up with the DRIVER\'s best instead is caught',
    !ask('give me that in minutes', `That's ${G.lapClock(raw.bestLapSec)}.`, { question: 'what is the pace of P5?', answer: `P5 is on ${p5.last} seconds.` }).ok);

  const L = raw.classLeader;
  check(`"class leaders times" → leader block passes`,
    ask('update me on class leaders times.', `${L.name} leads on ${G.lapClock(L.lastLapSec)}, best ${G.lapClock(L.bestLapSec)} — you're ${L.gapSec} back.`).ok);
  check('"class leaders times" → the car-ahead gap is caught',
    !ask('update me on class leaders times.', `You're ${row(15).toMe} behind the leader.`).ok);

  const p6 = row(6);
  check(`"gap between P5 and P6" → P6.interval (${p6.interval}) passes`,
    ask('what is the gap between P5 and P6?', `P6 is ${p6.interval} behind P5.`).ok);
  check('"gap between P5 and P6" → a figure from neither car is caught',
    !ask('what is the gap between P5 and P6?', 'They are 0.9 seconds apart.').ok);

  const d = raw.lastSectorsVsLeaderSec;
  check(`sector deltas to P1 pass (${d[0]}, ${d[1]})`,
    ask('what is my time difference in sector 1 and 2 to P1 in class?', `Sector 1 you're ${d[0]} down, sector 2 ${d[1]} down.`).ok);
  check('own last-lap sector passes', ask("what's my sector one?", `Sector 1 was ${raw.lastSectorsSec[0]}.`).ok);
  check('car-number target: "car 105" resolves to P5', ask("what's car 105's best?", `${G.lapClock(p5.best)}.`).ok);
  check('surname target: a named rival\'s lap passes', ask(`what's ${p5.name} doing?`, `${p5.name} is on a ${p5last}.`).ok);
  check('surname target: a different rival\'s lap is caught', !ask(`what's ${p5.name} doing?`, `${p5.name} is on a ${G.lapClock(row(7).last)}.`).ok);
  check('"#105" also resolves to P5', ask("what's #105 doing?", `${G.lapClock(p5.best)}.`).ok);
  {
    const racing = { ...s, classStandings: s.classStandings.map((r) => (r.pos === 7 ? { ...r, name: 'Racing' } : r)) };
    const v = G.guardAnswer({ question: "how's the racing going?", answer: `P16, ${s.lapsToFinish} laps to go.`, summary: racing });
    check('a driver called "Racing" does not scope "how\'s the racing going?"', v.ok && v.targets.length === 0, show(v));
  }
  check('"overall P5" cannot resolve from a class sheet → figures caught',
    !ask('gap to P5 overall?', `${p5.toMe} seconds.`).ok);
  check('unscoped status readout passes', ask('status?', `P16 in class, 10 laps to go, fuel's good with 10 litres spare.`).ok);
  check('asking about your OWN position is unscoped', ask('what about P16, how am I doing?', `You're P16, last lap ${G.lapClock(raw.lastLapSec)}.`).ok);

  // Partial sheet: drop P10 to simulate a budget cut, and the guard must not
  // let the car-ahead gap stand in for it.
  const cut = { ...s, classStandings: s.classStandings.filter((r) => r.pos !== 10), classStandingsPartial: true };
  const v = G.guardAnswer({ question: 'gap to P10.', answer: `Gap to P10 is ${row(15).toMe}.`, summary: cut });
  check('P10 cut from the sheet → any gap is caught, and noReadLine names it',
    !v.ok && v.missingTarget && /P10/.test(G.noReadLine(v)), G.noReadLine(v));

  // Lapped cars: the sheet says laps, and the guard accepts the lap count.
  const lapped = JSON.parse(JSON.stringify(frame));
  for (const e of lapped.standings) {
    if (e.position >= 18) {
      e.gapToClassLeaderSec = UNKNOWN_VALUE;
      e.gapToLeaderSec = UNKNOWN_VALUE;
      e.classLapsBehind = 2;
      e.classLapsBehindExact = 2.3;
    } else e.classLapsBehindExact = (e.position - 1) * 0.04;
  }
  const ls = engineerSummary(lapped);
  const r19 = ls.classStandings.find((r) => r.pos === 19);
  check('lapped P19: lapsDown, no seconds', r19.lapsDown === 2 && r19.gap === undefined, show(r19));
  const gv = G.guardAnswer({ question: 'gap to P19?', answer: 'P19 is 2 laps down on you.', summary: G.clockify(ls) });
  check('lapped answer in laps passes', gv.ok, show(gv.unsupported));
}

if (fail) {
  console.log(`\n${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`\n${pass} passed`);
