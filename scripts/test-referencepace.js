/**
 * scripts/test-referencepace.js — the pace-scoring rules.
 * -----------------------------------------------------------------------------
 * This module turns a lap time into a number a driver is told about themselves,
 * which makes its failure mode social rather than technical: nobody files a bug
 * for "the overlay says I'm 9% off the pace", they just decide the feature is
 * rubbish and stop looking at it. And 9% is exactly what you get by scoring a
 * Monza Curva Grande lap against the Grand Prix reference — the two layouts are
 * ~10 s apart and LMU's REST feed names neither of them.
 *
 * So the cases below are weighted towards the ways a lap gets attached to the
 * WRONG reference:
 *
 *   - a venue with several layouts, resolved by scene name, by config, by
 *     length, and — where none of those can — refused outright
 *   - the two LMP2 rulesets, which are a power difference, not a driver one
 *   - classes and tracks the sheet has never heard of
 *
 * plus the arithmetic and the band boundaries, which are cheap to check and
 * would be embarrassing to get wrong.
 *
 * The reference data itself is the shipped file, not a fixture: a test that
 * invents its own table would keep passing after a fetch broke the real one.
 *
 * Run: node scripts/test-referencepace.js
 */

'use strict';

const {
  scoreLap,
  referenceFor,
  referenceCredit,
  referenceUpdated,
  paceBands,
} = require('../dist/telemetry/referencePace');

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

/** `"1:59.09"` → ms, so the expectations below read like the spreadsheet. */
function ms(text) {
  const m = /^(\d+):(\d\d)(?:\.(\d+))?$/.exec(text);
  return (Number(m[1]) * 60 + Number(m[2])) * 1000 + Number((m[3] || '0').padEnd(3, '0'));
}

/* -------------------------------------------------------------------------- */
console.log('\nThe shipped table');
/* -------------------------------------------------------------------------- */

const credit = referenceCredit();
check('the table loads', credit !== null);
check(
  'attribution travels with the data',
  credit && credit.author === 'Ohne Speed' && credit.sheetUrl.startsWith('https://'),
  credit ? credit.author : 'missing',
);
check(
  'contributors are named',
  credit && credit.contributors.length >= 3,
  credit ? credit.contributors.join(', ') : '—',
);
check('the sheet vintage is recorded', referenceUpdated().length > 0, referenceUpdated());
check('the ladder has six rungs', paceBands().length === 6, `${paceBands().length}`);
check(
  'the ladder is open-ended at the slow end',
  paceBands()[paceBands().length - 1].maxPercent === null,
);

/* -------------------------------------------------------------------------- */
console.log('\nScoring arithmetic');
/* -------------------------------------------------------------------------- */

/* Bahrain GP is single-length-resolvable and its GT3 reference is 1:59.09. */
const BAHRAIN_GT3 = ms('1:59.09');

function bahrain(lapMs, extra) {
  return scoreLap({
    track: 'Bahrain International Circuit',
    trackLengthM: 5412,
    carClass: 'GT3',
    car: 'Ferrari 296 GT3',
    lapMs,
    ...extra,
  });
}

{
  const r = bahrain(BAHRAIN_GT3);
  check('a lap exactly on the reference is 100.0%', r.ok && r.score.percent === 100, r.score && r.score.percent);
  check('...and lands in the Alien band', r.ok && r.score.bandId === 'alien', r.score && r.score.bandLabel);
  check('...with a zero delta', r.ok && r.score.deltaSec === 0, r.score && r.score.deltaSec);
  check(
    '...naming the layout it resolved',
    r.ok && r.score.layoutId === 'bahrain_gp',
    r.score && r.score.layoutId,
  );
  check(
    '...and the sheet class row',
    r.ok && r.score.sheetClass === 'LMGT3',
    r.score && r.score.sheetClass,
  );
}

{
  const r = bahrain(Math.round(BAHRAIN_GT3 * 1.05));
  check('5% off the reference reads 105.0%', r.ok && r.score.percent === 105, r.score && r.score.percent);
  check('...which the sheet calls Midpack', r.ok && r.score.bandId === 'midpack', r.score && r.score.bandLabel);
}

{
  // Band edges are inclusive, so 101.0 must still be Competitive and a hair
  // over must not be. Off-by-one here silently relabels a whole tier.
  const at = bahrain(Math.round(BAHRAIN_GT3 * 1.01));
  const past = bahrain(Math.round(BAHRAIN_GT3 * 1.016));
  check('101.0% is still Competitive', at.ok && at.score.bandId === 'competitive', at.score && at.score.percent);
  check('101.6% has dropped to Good', past.ok && past.score.bandId === 'good', past.score && past.score.percent);
}

{
  const r = bahrain(Math.round(BAHRAIN_GT3 * 0.98));
  check('a faster-than-reference lap scores under 100', r.ok && r.score.percent === 98, r.score && r.score.percent);
  check('...with a negative delta', r.ok && r.score.deltaSec < 0, r.score && r.score.deltaSec);
}

{
  const r = bahrain(Math.round(BAHRAIN_GT3 * 1.4));
  check('40% off is Offline, not an error', r.ok && r.score.bandId === 'offline', r.score && r.score.bandLabel);
}

check('a 3-second "lap" is refused', bahrain(3_000).reason === 'implausible-lap');
check('an hour-long "lap" is refused', bahrain(4_000_000).reason === 'implausible-lap');

/* -------------------------------------------------------------------------- */
console.log('\nLayout resolution — the part that must never guess');
/* -------------------------------------------------------------------------- */

/* Bahrain's four layouts are 162 m apart at their closest, so length works. */
const BAHRAIN_LAYOUTS = [
  ['bahrain_gp', 5412],
  ['bahrain_endurance', 6299],
  ['bahrain_outer', 3543],
  ['bahrain_paddock', 3705],
];
for (const [want, lengthM] of BAHRAIN_LAYOUTS) {
  const r = referenceFor({
    track: 'Bahrain International Circuit',
    trackLengthM: lengthM,
    carClass: 'GT3',
  });
  check(`length alone resolves ${want}`, r.ok && r.score.layoutId === want, r.score && r.score.layoutId);
}

{
  // The sim measures short of the published length — Monza reads 5781 against
  // 5793. A tolerant match must still land on the right layout.
  const r = referenceFor({
    track: 'Bahrain International Circuit',
    trackLengthM: 5395,
    carClass: 'GT3',
  });
  check('a spline 17 m short still resolves', r.ok && r.score.layoutId === 'bahrain_gp', r.score && r.score.layoutId);
}

{
  // Monza's two layouts share a centreline and are ~9% apart in pace, so length
  // can never separate them. What does is the track name itself: LMU publishes
  // the COURSE name, and these two are different courses. Both strings below are
  // copied from LMU's own result files.
  const gp = referenceFor({
    track: 'Autodromo Nazionale Monza',
    trackLengthM: 5781,
    carClass: 'GT3',
  });
  check(
    'the course name resolves Monza GP',
    gp.ok && gp.score.layoutId === 'monza_gp',
    gp.score ? gp.score.layoutId : gp.reason,
  );
  check('...and reports how', gp.ok && gp.score.via === 'course', gp.score && gp.score.via);

  const grande = referenceFor({
    track: 'Monza Curva Grande Circuit',
    trackLengthM: 5745,
    carClass: 'GT3',
  });
  check(
    'the course name resolves Monza Curva Grande',
    grande.ok && grande.score.layoutId === 'monza_curva_grande',
    grande.score ? grande.score.layoutId : grande.reason,
  );
  check(
    '...and the two are scored against different references',
    gp.ok && grande.ok && gp.score.refMs !== grande.score.refMs,
  );
}

{
  // A name that identifies the venue but not the course still has to refuse.
  // Whole-name matching is what makes that true: "Monza" is a substring of both
  // course names and must not select either.
  const r = referenceFor({ track: 'Monza', trackLengthM: 5781, carClass: 'GT3' });
  check('a venue-only name refuses to guess a layout', !r.ok && r.reason === 'ambiguous-layout', r.reason);
  check('...and says why', !r.ok && /layouts/.test(r.detail || ''), r.detail);
}

{
  const r = referenceFor({
    track: 'Monza',
    simTrackName: 'Monza_CurvaGrande_2024',
    trackLengthM: 5781,
    carClass: 'GT3',
  });
  check(
    'the scene name resolves Monza Curva Grande',
    r.ok && r.score.layoutId === 'monza_curva_grande',
    r.score && r.score.layoutId,
  );
  check('...and reports how', r.ok && r.score.via === 'sim-name', r.score && r.score.via);
}

{
  // Le Mans names itself: the full circuit is "Circuit de la Sarthe" and the
  // other layout is "Circuit de la Sarthe Mulsanne" (observed 2026-08-04 in
  // UserData/Log/Results, from layoutMulsanne.mas). The full name is a strict
  // PREFIX of the Mulsanne's, so this is also the test that whole-name matching
  // holds: a substring test would score every Mulsanne lap 15 s slow.
  for (const [track, want] of [
    ['Circuit de la Sarthe', 'lemans_full'],
    ['Circuit de la Sarthe Mulsanne', 'lemans_straight'],
  ]) {
    const r = referenceFor({ track, trackLengthM: 13624, carClass: 'GT3' });
    check(
      `${track} resolves to ${want}`,
      r.ok && r.score.layoutId === want && r.score.via === 'course',
      r.ok ? `${r.score.layoutId} via ${r.score.via}` : r.reason,
    );
  }

  // And where the course name and the scene name name DIFFERENT layouts, that
  // is a disagreement, not a resolution. Le Mans is the circuit where this can
  // really happen, because its venue name and its full circuit's course name
  // are the same string — so a venue sent where a course was expected looks
  // exactly like the full circuit.
  const conflict = referenceFor({
    track: 'Circuit de la Sarthe',
    simTrackName: 'LeMans_NoChicane',
    trackLengthM: 13624,
    carClass: 'GT3',
  });
  check(
    'a course name contradicted by the scene name refuses to score',
    !conflict.ok && conflict.reason === 'ambiguous-layout',
    conflict.ok ? `scored anyway as ${conflict.score.layoutName}` : conflict.reason,
  );
}

{
  // Fuji's two layouts are 37 m apart on paper — inside the tolerance the spline
  // itself needs — and 3.8% apart in pace. Length must not be allowed to decide.
  const bare = referenceFor({ track: 'Fuji', trackLengthM: 4536, carClass: 'GT3' });
  check('Fuji refuses on length alone', !bare.ok && bare.reason === 'ambiguous-layout', bare.reason);

  // "Fuji Speedway" is a PREFIX of "Fuji Speedway Classic". A substring match
  // would hand every Classic lap to the GP row, 3.8% adrift; whole-name matching
  // is the only reason this pair works.
  const gp = referenceFor({ track: 'Fuji Speedway', trackLengthM: 4536, carClass: 'GT3' });
  check(
    'the course name resolves Fuji GP',
    gp.ok && gp.score.layoutId === 'fuji_gp',
    gp.score ? gp.score.layoutId : gp.reason,
  );
  const classic = referenceFor({
    track: 'Fuji Speedway Classic',
    trackLengthM: 4502,
    carClass: 'GT3',
  });
  check(
    'the course name resolves Fuji Classic',
    classic.ok && classic.score.layoutId === 'fuji_classic',
    classic.score ? classic.score.layoutId : classic.reason,
  );

  const hinted = referenceFor({
    track: 'Fuji',
    trackConfig: 'Classic Circuit',
    trackLengthM: 4536,
    carClass: 'GT3',
  });
  check(
    'trackConfig resolves Fuji Classic',
    hinted.ok && hinted.score.layoutId === 'fuji_classic',
    hinted.score && hinted.score.layoutId,
  );
  check('...and reports how', hinted.ok && hinted.score.via === 'config', hinted.score && hinted.score.via);
}

{
  // Paul Ricard's layout names nest: "1A" is a substring of "1A-V2", which is a
  // substring of "1A-V2-Short". The longest match has to win, or the sim loading
  // the short layout gets scored against the 13-seconds-slower ELMS one.
  const nested = [
    ['1A', 'paul_ricard_1a'],
    ['1A-V2', 'paul_ricard_1av2'],
    ['1A-V2-Short', 'paul_ricard_1av2_short'],
    ['3A', 'paul_ricard_3a'],
    ['ELMS', 'paul_ricard_gp'],
  ];
  for (const [config, want] of nested) {
    const r = referenceFor({
      track: 'Circuit Paul Ricard',
      trackConfig: config,
      trackLengthM: 5800,
      carClass: 'GT3',
    });
    check(`config "${config}" resolves ${want}`, r.ok && r.score.layoutId === want, r.score && r.score.layoutId);
  }

  // ...but a hint that matches two layouts EQUALLY well has not discriminated,
  // and that is different from it saying nothing: it must fall through rather
  // than pick whichever happened to be listed first. Contrived on purpose —
  // "GP" and "3A" are both two characters, so neither can outrank the other.
  const tie = referenceFor({
    track: 'Circuit Paul Ricard',
    trackConfig: 'GP 3A',
    trackLengthM: 5800,
    carClass: 'GT3',
  });
  check(
    'a hint matching two layouts equally does not pick a winner',
    !tie.ok && tie.reason === 'ambiguous-layout',
    tie.reason || (tie.score && tie.score.layoutId),
  );

  // The same nesting, in the course names LMU actually publishes. "Paul Ricard -
  // 1A" is a prefix of both the others and 1A-V2 shares the ELMS layout's length
  // exactly, so this is the pair that only a whole-name match can call.
  const courses = [
    ['Paul Ricard - 1A', 'paul_ricard_1a'],
    ['Paul Ricard - 1A-V2', 'paul_ricard_1av2'],
    ['Paul Ricard - 1A-V2-Short', 'paul_ricard_1av2_short'],
  ];
  for (const [course, want] of courses) {
    const r = referenceFor({ track: course, trackLengthM: 5800, carClass: 'GT3' });
    check(
      `course "${course}" resolves ${want}`,
      r.ok && r.score.layoutId === want && r.score.via === 'course',
      r.score ? `${r.score.layoutId} via ${r.score.via}` : r.reason,
    );
  }
}

{
  const r = referenceFor({ track: 'Spa-Francorchamps', trackLengthM: 7004, carClass: 'GT3' });
  check('a single-layout circuit needs no hint', r.ok && r.score.via === 'only', r.score && r.score.via);
}

check(
  'an unknown venue is reported as such',
  referenceFor({ track: 'Nordschleife', trackLengthM: 20832, carClass: 'GT3' }).reason ===
    'unknown-track',
);
check(
  'a blank track name does not resolve to something',
  referenceFor({ track: '', trackLengthM: 5412, carClass: 'GT3' }).reason === 'unknown-track',
);

/* -------------------------------------------------------------------------- */
console.log('\nClass resolution');
/* -------------------------------------------------------------------------- */

const CLASS_ROWS = [
  ['HYPERCAR', 'LMH'],
  ['LMP3', 'LMP3'],
  ['GTE', 'GTE'],
  ['GT3', 'LMGT3'],
];
for (const [canonical, sheet] of CLASS_ROWS) {
  const r = referenceFor({
    track: 'Bahrain International Circuit',
    trackLengthM: 5412,
    carClass: canonical,
  });
  check(`${canonical} reads the ${sheet} row`, r.ok && r.score.sheetClass === sheet, r.score && r.score.sheetClass);
}

{
  // The ELMS and WEC LMP2s are 3.6 s apart at Bahrain. Getting this wrong is a
  // whole band, so the car model decides it whenever the car model says.
  const elms = referenceFor({
    track: 'Bahrain International Circuit',
    trackLengthM: 5412,
    carClass: 'LMP2',
    car: 'Oreca 07 ELMS',
  });
  const wec = referenceFor({
    track: 'Bahrain International Circuit',
    trackLengthM: 5412,
    carClass: 'LMP2',
    car: 'Oreca 07 WEC',
  });
  check('an ELMS LMP2 reads the ELMS row', elms.ok && elms.score.sheetClass === 'LMP2elms', elms.score && elms.score.sheetClass);
  check('a WEC LMP2 reads the WEC row', wec.ok && wec.score.sheetClass === 'LMP2wec', wec.score && wec.score.sheetClass);
  check('neither is flagged as assumed', elms.ok && wec.ok && !elms.score.assumed && !wec.score.assumed);
  check('...and they are genuinely different references', elms.score.refMs !== wec.score.refMs,
    `${elms.score.refMs} vs ${wec.score.refMs}`);

  const vague = referenceFor({
    track: 'Bahrain International Circuit',
    trackLengthM: 5412,
    carClass: 'LMP2',
    car: 'Oreca 07',
  });
  check('a nameless LMP2 falls back to WEC', vague.ok && vague.score.sheetClass === 'LMP2wec', vague.score && vague.score.sheetClass);
  check('...and admits the assumption', vague.ok && vague.score.assumed === true);
}

{
  // LMU does not make you read the car name: it races the two rulesets as
  // separate classes and says `LMP2_ELMS` outright. That class must reach the
  // ELMS row on its own — a league board carries the class, and the car beside
  // it is whatever that driver happened to enter.
  const r = referenceFor({
    track: 'Daytona International Speedway Road Course',
    trackLengthM: 5734,
    carClass: 'LMP2_ELMS',
    car: '',
  });
  check(
    "LMU's LMP2_ELMS class reads the ELMS row",
    r.ok && r.score.sheetClass === 'LMP2elms',
    r.ok ? r.score.sheetClass : r.detail,
  );
  check('...with nothing assumed', r.ok && r.score.assumed === false);
}

check(
  'GT4 is unrated rather than mis-scored',
  referenceFor({ track: 'Bahrain International Circuit', trackLengthM: 5412, carClass: 'GT4' })
    .reason === 'unrated-class',
);
check(
  'a mod class is unrated rather than mis-scored',
  referenceFor({ track: 'Bahrain International Circuit', trackLengthM: 5412, carClass: 'TCR' })
    .reason === 'unrated-class',
);
check(
  'no class at all is unrated',
  referenceFor({ track: 'Bahrain International Circuit', trackLengthM: 5412, carClass: '' })
    .reason === 'unrated-class',
);

/* -------------------------------------------------------------------------- */
console.log('\nCoverage of the shipped table');
/* -------------------------------------------------------------------------- */

{
  const table = require('../overlay/js/data/reference-times.json');
  const layouts = Object.keys(table.times);
  check('every mapped layout has times', layouts.length === 31, `${layouts.length} layouts`);

  let entries = 0;
  let bad = [];
  for (const [layoutId, byClass] of Object.entries(table.times)) {
    for (const [cls, entry] of Object.entries(byClass)) {
      entries++;
      // A zero or absurd baseline would make every lap at that combo score as
      // infinitely slow — the one bug in this table that is invisible in a diff.
      if (!(entry.raceMs > 30_000 && entry.raceMs < 600_000)) bad.push(`${layoutId}/${cls}`);
    }
  }
  check('every reference time is plausible', bad.length === 0, bad.length ? bad.join(', ') : `${entries} entries`);
  check('all six sheet classes are covered', entries === 186, `${entries} entries`);
}

/* -------------------------------------------------------------------------- */
/*  Scoring a lap off a league board                                          */
/* -------------------------------------------------------------------------- */
/*
 * Clicking a row on a league board scores that driver's lap against the same
 * reference — and a board row carries almost no track metadata. `leaderboard`
 * returns a ranking (name, car, lap, gap), not the laps' identity, so the only
 * layout hints the panel has are the board's track NAME and its `track_length_m`
 * off the filter row. No `trackConfig`, no scene name: whatever those two can
 * settle is what another driver's lap can be scored against.
 *
 * ## The bug these pin (shipped in v0.56.0, fixed in 0.56.1)
 * The first version tried to recover the length by parsing it out of the board's
 * `track_id`, assuming that id was the lap log's `trackKey` string
 * (`${slug}_${metres}`). It is not — `track_id` is the `tracks.id` UUID, so the
 * parse matched nothing and every board was scored with NO length at all.
 *
 * That failure was near-invisible, which is why it reached a release: circuits
 * with one layout in the table score fine without any length, so the boards
 * anyone happened to look at first still worked. Only multi-layout circuits went
 * unscored — and an unscored row is silently unclickable, so the symptom was
 * "clicking that driver does nothing".
 *
 * The values below are the league's own, from `driver_best_laps`, so these fail
 * if that pipeline changes shape again rather than only if the arithmetic does.
 */

console.log('\nScoring a lap from a board row');

{
  // The bug, pinned from the front: COTA has two layouts ~1.8 km apart, so with
  // no length it cannot be resolved. This is exactly what every board looked
  // like in v0.56.0.
  const cotaBlind = scoreLap({
    track: 'Circuit of the Americas',
    trackLengthM: 0,
    carClass: 'GT3',
    lapMs: 131_955,
  });
  check(
    'a board row with no length cannot resolve a multi-layout circuit',
    !cotaBlind.ok && cotaBlind.reason === 'ambiguous-layout',
    cotaBlind.ok ? `scored anyway as ${cotaBlind.score.layoutName}` : cotaBlind.reason,
  );

  // ...and the fix: the sim's measured 5497 m is 16 m from the Grand Prix layout
  // and 1.8 km from the National, so the length settles it on its own.
  const cota = scoreLap({
    track: 'Circuit of the Americas',
    trackLengthM: 5497,
    carClass: 'GT3',
    car: 'BMW GT3 Custom Team 2026 #397',
    lapMs: 131_955,
  });
  check(
    'the same row resolves once the track length is supplied',
    cota.ok && cota.score.via === 'length',
    cota.ok
      ? `${cota.score.layoutName} via ${cota.score.via} — ${cota.score.percent}%`
      : `${cota.reason}: ${cota.detail}`,
  );

  // Why the bug hid: a single-layout circuit needs no length, so these boards
  // worked throughout and made the feature look fine.
  const laguna = scoreLap({
    track: 'WeatherTech Raceway Laguna Seca',
    trackLengthM: 0,
    carClass: 'GT3',
    lapMs: 84_579,
  });
  check(
    'a single-layout circuit scores with no length at all',
    laguna.ok && laguna.score.via === 'only',
    laguna.ok ? `via ${laguna.score.via} — ${laguna.score.percent}%` : laguna.reason,
  );

  // Where length genuinely cannot help — Monza's two layouts are ~10 s apart in
  // pace and 35 m apart in measured length — the track NAME does, and a board row
  // has one. This is the whole reason the course names were worth chasing down:
  // it makes other people's laps at multi-layout circuits scoreable, which no
  // amount of extra hints on the local lap record could have done.
  const monza = scoreLap({
    track: 'Autodromo Nazionale Monza',
    trackLengthM: 5781,
    carClass: 'LMP3',
    lapMs: 109_016,
  });
  check(
    'a board row at Monza is placed by its course name',
    monza.ok && monza.score.layoutId === 'monza_gp' && monza.score.via === 'course',
    monza.ok ? `${monza.score.layoutName} via ${monza.score.via}` : monza.reason,
  );

  // ...and where even the name cannot help, it still refuses. Both Le Mans
  // layouts are 13,626 m on paper, so length can never separate them: a row
  // carrying the VENUE rather than either course name has nothing left to go
  // on, and claiming the full circuit would be the 15-second guess the whole
  // resolver exists to avoid.
  const sarthe = scoreLap({
    track: 'Le Mans',
    trackLengthM: 13_624,
    carClass: 'GT3',
    lapMs: 231_000,
  });
  check(
    'an unresolvable board row still refuses to score',
    !sarthe.ok && sarthe.reason === 'ambiguous-layout',
    sarthe.ok ? `scored anyway as ${sarthe.score.layoutName}` : sarthe.reason,
  );

  // Another driver's lap is scored by exactly the same rule as your own: same
  // track, same class, same time must give the same number, or the Leaderboard
  // card would contradict the Dashboard for a lap they both hold.
  const mine = scoreLap({
    track: 'WeatherTech Raceway Laguna Seca',
    trackLengthM: 3590,
    carClass: 'GT3',
    car: 'Team WRT 2026 #32:WEC',
    lapMs: 84_994,
  });
  const theirs = scoreLap({
    track: 'WeatherTech Raceway Laguna Seca',
    trackLengthM: 3590,
    carClass: 'GT3',
    car: 'BMW GT3 Custom Team 2026 #397',
    lapMs: 84_994,
  });
  check(
    'a board lap and a local lap score identically',
    mine.ok && theirs.ok && mine.score.percent === theirs.score.percent,
    mine.ok && theirs.ok ? `${mine.score.percent}% both` : 'one of them failed to score',
  );
}

/* -------------------------------------------------------------------------- */

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
