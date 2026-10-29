/**
 * scripts/test-fairtarget.js — is a comparison lap fair to chase?
 * (src/telemetry/fairTarget.ts)
 * -----------------------------------------------------------------------------
 * A chip that calls a fair lap unfair teaches the driver to ignore the chips;
 * one that misses a quali lap on ten litres sends them chasing fuel. So every
 * rule is pinned on BOTH sides of its threshold:
 *
 *   §1 a lap against its twin raises nothing and scores 0
 *   §2 hard rules: class, surface, clean → drop
 *   §3 car model: same model / livery years / unknown models / different model
 *   §4 fuel: prior and solid fit, the 0.15 s and 25%-of-gap thresholds (and
 *      the floor under the share rule), signs, qualifying with no fuel
 *   §5 track temperature 5 / 10 °C, air temperature 5 °C
 *   §6 compound, energy
 *   §7 the auto-pick: fewest/mildest flags, then 0.5–1.5% quicker over the
 *      fastest, never a drop, never slower, never a lap with no trace
 *
 * Run: node scripts/test-fairtarget.js (build first)
 */

'use strict';

const ft = require('../dist/telemetry/fairTarget');
const { assessTarget, pickFairTarget, fuelSecPerL, carModelOf } = ft;

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

const ME = {
  lapId: 'mine',
  car: 'Oreca 07 Custom Team 2025 #397',
  carClass: 'LMP2',
  lapSec: 100,
  sessionType: 'practice',
  trackTempC: 30,
  airTempC: 22,
  fuelStartL: 40,
  fuelCapacityL: 75,
  vePct: null,
  compound: 'Medium',
  condition: 'dry',
  clean: true,
  trackKey: 'some-track_4000',
};
const lap = (o) => ({ ...ME, lapId: 'cand', driver: 'Rival', lapSec: 99, ...o });
const flagsOf = (o, me) => assessTarget(me || ME, lap(o)).flags;
const kinds = (fl) => fl.map((f) => `${f.kind}:${f.severity}`).join(',');
const has = (fl, kind, sev) => fl.some((f) => f.kind === kind && (!sev || f.severity === sev));

console.log('\n§1 a twin');
{
  const a = assessTarget(ME, lap({}));
  check('no flags', a.flags.length === 0, kinds(a.flags));
  check('score 0', a.score === 0);
  check('fuel estimated at 0 s (same litres)', a.fuelSec === 0, a.fuelSec);
}

console.log('\n§2 hard rules');
{
  let f = flagsOf({ carClass: 'GT3', car: 'BMW GT3 Custom Team 2026 #397' });
  check('another class → car:drop', has(f, 'car', 'drop') && f.length === 1, kinds(f));
  check('…and not also "different car"', !has(f, 'car', 'warn'));
  check('class compared case-insensitively', flagsOf({ carClass: 'lmp2' }).length === 0);
  f = flagsOf({ condition: 'wet' });
  check('another surface → condition:drop', has(f, 'condition', 'drop'), kinds(f));
  check('…says which', f[0].text === 'wet track, yours dry', f[0].text);
  check('surface unknown on one side → nothing', flagsOf({ condition: null }).length === 0 && flagsOf({}, { ...ME, condition: null }).length === 0);
  f = flagsOf({ clean: false });
  check('not clean → drop', has(f, 'session', 'drop'), kinds(f));
  check('clean absent = clean (board laps)', flagsOf({ clean: undefined }).length === 0);
  const a = assessTarget(ME, lap({ condition: 'wet', clean: false }));
  check('score adds 100 per drop', a.score === 200, a.score);
}

console.log('\n§3 car model');
{
  check('carModelOf: custom livery → the model', carModelOf('BMW GT3 Custom Team 2026 #397') === 'bmw gt3');
  check('carModelOf: a team livery → unknown', carModelOf('Team WRT 2026 #32:WEC') === null);
  check('carModelOf: empty / not a string → null', carModelOf('') === null && carModelOf(undefined) === null);
  check('same model, another year and number → no flag', flagsOf({ car: 'Oreca 07 Custom Team 2026 #12' }).length === 0);
  const f = flagsOf({ car: 'Ligier JSP217 Custom Team 2025 #397' });
  check('another model, same class → car:warn "different car (BoP)"', has(f, 'car', 'warn') && f[0].text === 'different car (BoP)', kinds(f));
  check('a team livery (model unknown) → nothing', flagsOf({ car: 'United Autosports 2025 #22:LM' }).length === 0);
  check('no car on the board row → nothing', flagsOf({ car: '' }).length === 0);
}

console.log('\n§4 fuel');
{
  // Prior: 0.035 s/kg/100 s × 0.74 kg/L × 99 s / 100 → s/L for a 99 s lap.
  const k = (0.035 * 0.74 * 99) / 100;
  check('the prior, per litre', near(fuelSecPerL('x', 'LMP2', 99), k, 1e-9), fuelSecPerL('x', 'LMP2', 99));
  check('a solid fit wins over the prior (Daytona LMP2)',
    fuelSecPerL('daytona-international-speedway-road-course_5734', 'lmp2', 100) === 0.03046);
  check('…Fuji GT3 too', fuelSecPerL('fuji-speedway_4536', 'GT3', 100) === 0.02281);
  check('a noisy fit is NOT used (Monza GT3 → the prior)', near(fuelSecPerL('autodromo-nazionale-monza_5781', 'GT3', 111.773), (0.035 * 0.74 * 111.773) / 100, 1e-9));
  check('no lap time → null', fuelSecPerL('x', 'LMP2', 0) === null);

  // 0.15 s threshold: litres either side of it, on a gap big enough that the share rule stays quiet.
  const lit = 0.15 / k; // ≈5.79 L
  let me = { ...ME, lapSec: 101 }; // gap 2 s → 25% is 0.5 s, out of the way
  let a = assessTarget(me, lap({ fuelStartL: 40 - (lit - 0.2) }));
  check('just under 0.15 s → no flag', a.flags.length === 0 && a.fuelSec < 0.15, a.fuelSec);
  a = assessTarget(me, lap({ fuelStartL: 40 - (lit + 0.2) }));
  check('just over 0.15 s → fuel:warn', has(a.flags, 'fuel', 'warn') && a.fuelSec > 0.15, a.fuelSec);
  check('estSec on the flag = fuelSec', a.flags[0].estSec === a.fuelSec);
  check('I carried more → positive, "of the gap is fuel", with ≈', a.fuelSec > 0 && /^≈0\.\d s of the gap is fuel \(\d+ L\)$/.test(a.flags[0].text), a.flags[0].text);
  a = assessTarget(me, lap({ fuelStartL: 40 + (lit + 0.2) }));
  check('they carried more → negative, "they ran ≈N L heavier"', a.fuelSec < -0.15 && /^they ran ≈\d+ L heavier \(≈0\.\d s\)$/.test(a.flags[0].text), a.flags[0].text);

  // 25%-of-gap rule: gap 0.4 s → 25% = 0.10 s. Estimates 0.09 / 0.11 s.
  me = { ...ME, lapSec: 99.4 };
  const kk = (0.035 * 0.74 * 99) / 100;
  a = assessTarget(me, lap({ fuelStartL: 40 - 0.09 / kk }));
  check('0.09 s of a 0.4 s gap (22%) → no flag', a.flags.length === 0, a.fuelSec);
  a = assessTarget(me, lap({ fuelStartL: 40 - 0.11 / kk }));
  check('0.11 s of a 0.4 s gap (27%) → fuel:warn', has(a.flags, 'fuel', 'warn'), a.fuelSec);
  check('…0.11 s reads ≈0.1 s', a.flags[0].text.startsWith('≈0.1 s'), a.flags[0].text);
  // The floor: 0.04 s of a 0.1 s gap is 40%, but under 0.05 s it is noise.
  me = { ...ME, lapSec: 99.1 };
  a = assessTarget(me, lap({ fuelStartL: 40 - 0.04 / kk }));
  check('0.04 s of a 0.1 s gap → no flag (under the 0.05 s floor)', a.flags.length === 0, a.fuelSec);
  a = assessTarget(me, lap({ fuelStartL: 40 - 0.06 / kk }));
  check('0.06 s of a 0.1 s gap → fuel:warn, in hundredths', has(a.flags, 'fuel', 'warn') && a.flags[0].text.startsWith('≈0.06 s'), a.flags[0] && a.flags[0].text);

  // Missing fuel.
  a = assessTarget(ME, lap({ fuelStartL: null }));
  check('candidate fuel not recorded → no estimate, no flag', a.fuelSec === null && a.flags.length === 0);
  a = assessTarget({ ...ME, fuelStartL: null }, lap({}));
  check('my fuel not recorded → no estimate, no flag', a.fuelSec === null && a.flags.length === 0);
  a = assessTarget(ME, lap({ fuelStartL: null, sessionType: 'qualifying' }));
  check('qualifying, no fuel → session:info "likely low fuel, fresh tyres"',
    has(a.flags, 'session', 'info') && a.flags[0].text === 'likely low fuel, fresh tyres' && a.score === 1, kinds(a.flags));
  a = assessTarget(ME, lap({ fuelStartL: 40, sessionType: 'qualifying' }));
  check('qualifying WITH fuel recorded → measured, no quali chip', a.flags.length === 0 && a.fuelSec === 0, kinds(a.flags));
  a = assessTarget({ ...ME, fuelStartL: null }, lap({ fuelStartL: null, sessionType: 'race' }));
  check('a race lap with no fuel → nothing', a.flags.length === 0);
}

console.log('\n§5 temperatures');
{
  check('track +5 °C → fine', flagsOf({ trackTempC: 35 }).length === 0);
  let f = flagsOf({ trackTempC: 35.5 });
  check('track +5.5 °C → trackTemp:warn "hotter"', has(f, 'trackTemp', 'warn') && f[0].text === 'track 6 °C hotter', f[0] && f[0].text);
  f = flagsOf({ trackTempC: 20 });
  check('track −10 °C → still warn, "cooler"', has(f, 'trackTemp', 'warn') && f[0].text === 'track 10 °C cooler', f[0] && f[0].text);
  f = flagsOf({ trackTempC: 19.5 });
  check('track −10.5 °C → trackTemp:drop', has(f, 'trackTemp', 'drop'), kinds(f));
  check('track temp missing on either side → nothing', flagsOf({ trackTempC: null }).length === 0 && flagsOf({}, { ...ME, trackTempC: null }).length === 0);
  check('air +5 °C → fine', flagsOf({ airTempC: 27 }).length === 0);
  f = flagsOf({ airTempC: 15 });
  check('air −7 °C → airTemp:warn "cooler"', has(f, 'airTemp', 'warn') && f[0].text === 'air 7 °C cooler', f[0] && f[0].text);
}

console.log('\n§6 tyres and energy');
{
  check('same compound, any case → fine', flagsOf({ compound: 'medium ' }).length === 0);
  const f = flagsOf({ compound: 'Soft' });
  check('another compound → compound:warn "on Soft tyres"', has(f, 'compound', 'warn') && f[0].text === 'on Soft tyres', f[0] && f[0].text);
  check('compound missing → nothing', flagsOf({ compound: null }).length === 0);
  check('energy 50% → fine', flagsOf({ vePct: 50 }).length === 0);
  let e = flagsOf({ vePct: 32 });
  check('energy 32% (mine unknown) → energy:info', has(e, 'energy', 'info') && e[0].text === 'low energy start (32%)', e[0] && e[0].text);
  check('energy 32% vs my 40% (within 15) → fine', flagsOf({ vePct: 32 }, { ...ME, vePct: 40 }).length === 0);
  e = flagsOf({ vePct: 32 }, { ...ME, vePct: 47 });
  check('energy 32% vs my 47% (15 apart) → info', has(e, 'energy', 'info'));
}

console.log('\n§7 the auto-pick');
{
  // me 100 s. Laps: A 99.0 (1% quicker, clean), B 97.0 (3% quicker, clean),
  // C 99.8 (0.2% quicker), D 101 (slower), E 99.2 with a warn, F 98.9 drop.
  const A = lap({ lapId: 'A', lapSec: 99.0 });
  const B = lap({ lapId: 'B', lapSec: 97.0 });
  const C = lap({ lapId: 'C', lapSec: 99.8 });
  const D = lap({ lapId: 'D', lapSec: 101 });
  const E = lap({ lapId: 'E', lapSec: 99.2, compound: 'Soft' });
  const F = lap({ lapId: 'F', lapSec: 98.9, condition: 'wet' });
  let r = pickFairTarget(ME, [B, C, D, E, F, A]);
  check('a clean lap 1% quicker beats the fastest', r.pick && r.pick.lapId === 'A', r.pick && r.pick.lapId);
  check('ranked by score, then band: A, B, C, D, E, F', r.ranked.map((x) => x.lap.lapId).join('') === 'ABCDEF', r.ranked.map((x) => x.lap.lapId).join(''));
  r = pickFairTarget(ME, [B, C, E]);
  check('no lap in the band → far quicker (B) over barely quicker (C)', r.pick.lapId === 'B', r.pick.lapId);
  r = pickFairTarget(ME, [C, E]);
  check('flags outrank pace: a clean 0.2% (C) over a warned 0.8% (E)', r.pick.lapId === 'C', r.pick.lapId);
  r = pickFairTarget(ME, [E, D]);
  check('only a warned lap is quicker → it is picked (warn ≠ drop)', r.pick.lapId === 'E');
  r = pickFairTarget(ME, [F, D]);
  check('a drop is never picked, a slower lap neither → null', r.pick === null && r.ranked.length === 2);
  r = pickFairTarget(ME, [lap({ lapId: 'NT', lapSec: 99.0, hasTrace: false }), B]);
  check('a lap with no trace is never the pick', r.pick.lapId === 'B', r.pick.lapId);
  const inBand = [lap({ lapId: 'x1', lapSec: 99.4 }), lap({ lapId: 'x2', lapSec: 99.0 }), lap({ lapId: 'x3', lapSec: 98.6 })];
  r = pickFairTarget(ME, inBand);
  check('within the band, nearest 1% quicker first', r.pick.lapId === 'x2', r.ranked.map((x) => x.lap.lapId).join(','));
  r = pickFairTarget(ME, [lap({ lapId: 'edge-lo', lapSec: 99.5 }), lap({ lapId: 'edge-hi', lapSec: 98.5 }), lap({ lapId: 'out', lapSec: 98.4 })]);
  check('0.5% and 1.5% are inside the band; 1.6% is not', r.ranked[2].lap.lapId === 'out', r.ranked.map((x) => x.lap.lapId).join(','));
  check('no candidates → null pick, empty ranking', (() => { const z = pickFairTarget(ME, []); return z.pick === null && z.ranked.length === 0; })());
  r = pickFairTarget({ ...ME, lapSec: 0 }, [A, B]);
  check('my time unknown → nothing to be quicker than → null', r.pick === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
