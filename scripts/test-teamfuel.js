/**
 * test-teamfuel.js — the Team tab's mid-race re-planner.
 * -----------------------------------------------------------------------------
 * planRemaining answers "from here to the flag" from live numbers, so the
 * cases here are race situations, not parameter sweeps: comfortable to the
 * end, one stop with a realistic save target, a multi-stop endurance rest,
 * and the sentinel/garbage inputs a live feed will absolutely produce.
 *
 * Run: npm run test:teamfuel
 */

'use strict';

const path = require('path');
const ENGINE = require(path.join(__dirname, '..', 'electron', 'control-panel', 'team-fuel.js'));

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── Comfortable to the flag: no stops, honest margin ───────────────────────
{
  const p = ENGINE.planRemaining({ level: 60, tank: 100, perLap: 5, lapsToGo: 10, safetyLaps: 1 });
  check('no-stop plan builds', !!p);
  check('no-stop: zero stops', p.stops === 0, `stops=${p.stops}`);
  check('no-stop: margin is level - need', Math.abs(p.marginNoStop - 10) < 0.01, `margin=${p.marginNoStop}`);
  check('no-stop: single current stint', p.stints.length === 1 && p.stints[0].current === true);
  check('no-stop: no save target', p.saveTarget === null);
}

// ── Margin under the safety line forces a stop even if the car would coast in dry ──
{
  // 52 units for 10 laps at 5/lap = reaches the flag with 2, but safety wants 5.
  const p = ENGINE.planRemaining({ level: 52, tank: 100, perLap: 5, lapsToGo: 10, safetyLaps: 1 });
  check('under-safety forces a stop', p.stops === 1, `stops=${p.stops}`);
}

// ── One stop, VE-style: window, fills, save target ─────────────────────────
{
  // 40% VE, 6%/lap, 12 laps to go: needs 72 + 6 safety, tank 100 → 1 stop.
  const p = ENGINE.planRemaining({ level: 40, tank: 100, perLap: 6, lapsToGo: 12, safetyLaps: 1 });
  check('1-stop plan builds', !!p && p.stops === 1, p && `stops=${p.stops}`);
  check('1-stop: dry in floor(level/perLap)', p.lapsInTank === 6, `inTank=${p.lapsInTank}`);
  check('1-stop: window latest = dry', p.windowLatest === 6, `latest=${p.windowLatest}`);
  check('1-stop: window earliest 0 (a stop works any time)', p.windowEarliest === 0, `earliest=${p.windowEarliest}`);
  const sum = p.stints.reduce((a, s) => a + s.laps, 0);
  check('1-stop: stint laps cover the race', sum === 12, `sum=${sum}`);
  const final = p.stints[p.stints.length - 1];
  check('1-stop: final fill carries laps + safety', Math.abs(final.fill - (final.laps * 6 + 6)) < 0.11, `fill=${final.fill}`);
  // Save target: level+0 tanks over 13 laps = 40/13 ≈ 3.08 — a 48% save. Real
  // maths, unrealistic race craft: it must be offered but flagged infeasible.
  check('1-stop: save target exists', !!p.saveTarget);
  check('1-stop: absurd saving flagged infeasible', p.saveTarget.feasible === false, `saving=${p.saveTarget.savingPct}%`);
}

// ── A feasible save target is marked feasible ──────────────────────────────
{
  // 96 units, 20 laps at 5/lap → needs 100: 1 stop, but a 4.2% save makes it.
  const p = ENGINE.planRemaining({ level: 96, tank: 120, perLap: 5, lapsToGo: 20, safetyLaps: 0 });
  check('close-call is 1 stop', p.stops === 1, `stops=${p.stops}`);
  check('close-call save target ~4.8/lap', p.saveTarget && Math.abs(p.saveTarget.perLap - 4.8) < 0.01,
    p.saveTarget && `target=${p.saveTarget.perLap}`);
  check('close-call save is feasible', p.saveTarget && p.saveTarget.feasible === true,
    p.saveTarget && `saving=${p.saveTarget.savingPct}%`);
}

// ── Endurance rest-of-race: many stops, brimmed middle stints ──────────────
{
  // 30 units left, 3.8/lap, 100 laps to go, 75L tank (LMP2 Le Mans style).
  const p = ENGINE.planRemaining({ level: 30, tank: 75, perLap: 3.8, lapsToGo: 100, safetyLaps: 2 });
  // Need 380 + 7.6 safety - 30 on board = 357.6 short / 75 per stop → 5 stops.
  check('endurance stop count', p.stops === 5, `stops=${p.stops}`);
  check('endurance stint count = stops + current', p.stints.length === 6, `stints=${p.stints.length}`);
  const sum = p.stints.reduce((a, s) => a + s.laps, 0);
  check('endurance stint laps cover the race', sum === 100, `sum=${sum}`);
  check('endurance middle fills never exceed tank', p.stints.every((s) => s.fill == null || s.fill <= 75.01));
  // 5 stops of 19 full laps cover 95 of the 100 — you must burn 5 laps of the
  // current tank before the first stop can arithmetically work.
  check('endurance window earliest positive', p.windowEarliest === 5, `earliest=${p.windowEarliest}`);
}

// ── Sentinels and garbage: the live feed's -1s must produce null, not a plan ──
{
  check('unknown level → null', ENGINE.planRemaining({ level: -1, tank: 100, perLap: 5, lapsToGo: 10 }) === null);
  check('unknown perLap → null', ENGINE.planRemaining({ level: 50, tank: 100, perLap: -1, lapsToGo: 10 }) === null);
  check('unknown lapsToGo → null', ENGINE.planRemaining({ level: 50, tank: 100, perLap: 5, lapsToGo: -1 }) === null);
  check('missing tank → null', ENGINE.planRemaining({ level: 50, tank: NaN, perLap: 5, lapsToGo: 10 }) === null);
  check('tank smaller than one lap → null', ENGINE.planRemaining({ level: 5, tank: 4, perLap: 5, lapsToGo: 10 }) === null);
}

// ── Fractional laps-to-go round up (you fuel for laps you must complete) ───
{
  const p = ENGINE.planRemaining({ level: 100, tank: 100, perLap: 5, lapsToGo: 9.3, safetyLaps: 0 });
  check('fractional lapsToGo ceils', p.lapsToGo === 10, `laps=${p.lapsToGo}`);
}

console.log(`\ntest-teamfuel: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
