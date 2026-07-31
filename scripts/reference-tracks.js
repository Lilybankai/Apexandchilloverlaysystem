/**
 * scripts/reference-tracks.js — the hand-written bridge between what the sim
 * calls a track and what the reference spreadsheet calls one.
 * -----------------------------------------------------------------------------
 * The reference times come from Ohne Speed's community spreadsheet (see
 * `fetch-reference-times.js`), which labels rows the way drivers talk —
 * "Bahrain (wec)", "Fuji (chicane)", "Paul Ricard (1A v2)". The sim publishes
 * something else entirely: LMU's REST `sessionInfo.trackName` is a venue name
 * with no layout in it at all ("Autodromo Nazionale Monza", "Fuji Speedway"),
 * and the only other identity we get is `lapDistance` in metres.
 *
 * Nothing joins those two automatically, so this file is the join, written once
 * by hand. It is build-time data: `fetch-reference-times.js` folds it into the
 * generated JSON, so the runtime never reads this file.
 *
 * ## The three ways a layout gets identified, in order
 *
 *   1. **`sim`** — substrings matched against the sim's INTERNAL track name
 *      (`rF2ScoringInfo.mTrackName`, read from shared memory). That string names
 *      the scene, so it is the only channel that can tell Monza GP from Monza
 *      Curva Grande. Exactly one layout must match, or the hint is discarded.
 *   2. **`config`** — substrings matched against `session.trackConfig`, for the
 *      providers that publish one (the simulator does; LMU over REST does not).
 *   3. **`lengthM`** — nearest nominal length wins, but only when it wins by a
 *      clear margin. See `LAYOUT_SEPARATION_M` in `src/telemetry/referencePace.ts`.
 *
 * When none of them resolves, the lap is left **unscored**. That is deliberate
 * and it matters: Monza's two layouts are ~10 s apart in GT3 and Le Mans's are
 * ~16 s apart, so a guess is not a slightly-worse number, it is a wrong one. The
 * same habit the damage widget and the clean-lap rule follow — do not invent
 * what the sim does not publish.
 *
 * ## About `lengthM`
 * These are the layouts' NOMINAL (published) lengths. The sim's measured spline
 * runs a little shorter — Monza reads 5781 against 5793, Le Mans 13624 against
 * 13626, COTA 5497 against 5513 — so the matcher compares with a tolerance and
 * never on equality.
 */

'use strict';

/**
 * Reference-time bands, straight from the spreadsheet's own header row. The
 * labels are Ohne Speed's, not ours, and are credited as such wherever they are
 * shown.
 *
 * The sheet labels columns 100/101/102/104/106/107 and leaves 103 and 105 blank,
 * meaning the label above them spans down. `maxPercent` is inclusive.
 */
const BANDS = [
  { id: 'alien', label: 'Alien', maxPercent: 100 },
  { id: 'competitive', label: 'Competitive', maxPercent: 101 },
  { id: 'good', label: 'Good', maxPercent: 103 },
  { id: 'midpack', label: 'Midpack', maxPercent: 105 },
  { id: 'tail', label: 'Tail-ender', maxPercent: 106 },
  { id: 'offline', label: 'Offline', maxPercent: Infinity },
];

/**
 * Canonical class (from `src/telemetry/carClass.ts`) → the sheet's class rows.
 *
 * Only LMP2 needs more than a rename. The sheet splits it into ELMS and WEC
 * regulations, which are ~3.5 s apart at Bahrain because they are a different
 * power level, not a different driver. LMU exposes them as separate cars, so the
 * car model picks the row; when it does not say, the WEC row is used, because
 * LMU is the WEC game and ELMS arrived as a pack. That default is reported as
 * `assumed` so the UI can say so rather than quietly pick a side.
 *
 * GT4 is absent from the sheet entirely — those laps come back unscored.
 */
const CLASSES = {
  HYPERCAR: { sheet: ['LMH'] },
  LMP2: {
    sheet: ['LMP2wec', 'LMP2elms'],
    pick: [
      { match: ['elms'], use: 'LMP2elms' },
      { match: ['wec'], use: 'LMP2wec' },
    ],
    default: 'LMP2wec',
    defaultAssumed: true,
  },
  LMP3: { sheet: ['LMP3'] },
  GTE: { sheet: ['GTE'] },
  GT3: { sheet: ['LMGT3'] },
};

/**
 * Every circuit in the spreadsheet, keyed to how the sim names it.
 *
 * `match` are substrings tested against the sim's display track name, lower-cased.
 * They must be specific enough not to collide across circuits — "circuit" would
 * hit nine of these, so the venue's distinctive word is used instead.
 *
 * `sheet` on a layout must equal the spreadsheet's Track cell EXACTLY; the fetch
 * script fails loudly on any row it cannot place, which is how a sheet rename
 * gets noticed rather than silently dropping a track.
 */
const CIRCUITS = [
  {
    id: 'bahrain',
    name: 'Bahrain International Circuit',
    match: ['bahrain', 'sakhir'],
    layouts: [
      {
        id: 'bahrain_gp',
        name: 'Grand Prix',
        sheet: 'Bahrain (wec)',
        lengthM: 5412,
        primary: true,
        config: ['grand prix', 'gp', 'wec'],
        sim: ['gp', 'grandprix'],
      },
      {
        id: 'bahrain_endurance',
        name: 'Endurance',
        sheet: 'Bahrain (endurance)',
        lengthM: 6299,
        config: ['endurance'],
        sim: ['endurance'],
      },
      {
        id: 'bahrain_outer',
        name: 'Outer Circuit',
        sheet: 'Bahrain (outer)',
        lengthM: 3543,
        config: ['outer'],
        sim: ['outer'],
      },
      {
        id: 'bahrain_paddock',
        name: 'Paddock Circuit',
        sheet: 'Bahrain (paddock)',
        lengthM: 3705,
        config: ['paddock'],
        sim: ['paddock'],
      },
    ],
  },
  {
    id: 'barcelona',
    name: 'Circuit de Barcelona-Catalunya',
    match: ['barcelona', 'catalunya'],
    layouts: [
      { id: 'barcelona_gp', name: 'Grand Prix', sheet: 'Barcelona', lengthM: 4657, primary: true },
    ],
  },
  {
    id: 'cota',
    name: 'Circuit of the Americas',
    match: ['americas', 'cota'],
    layouts: [
      {
        id: 'cota_gp',
        name: 'Grand Prix',
        sheet: 'COTA',
        lengthM: 5513,
        primary: true,
        config: ['grand prix', 'gp'],
        sim: ['gp', 'grandprix'],
      },
      {
        id: 'cota_national',
        name: 'National Circuit',
        sheet: 'COTA (national)',
        lengthM: 3702,
        config: ['national'],
        sim: ['national'],
      },
    ],
  },
  {
    id: 'daytona',
    name: 'Daytona International Speedway',
    match: ['daytona'],
    layouts: [
      // Not in `overlay/js/data/racedata.js` — the road course is 3.56 mi. The
      // live `tracks` table has measured 5734 against this 5729.
      { id: 'daytona_road', name: 'Road Course', sheet: 'Daytona', lengthM: 5729, primary: true },
    ],
  },
  {
    id: 'fuji',
    name: 'Fuji Speedway',
    match: ['fuji'],
    layouts: [
      {
        id: 'fuji_gp',
        name: 'Grand Prix',
        sheet: 'Fuji (chicane)',
        lengthM: 4563,
        primary: true,
        config: ['grand prix', 'gp', 'chicane'],
        sim: ['gp', 'grandprix'],
      },
      {
        // Only 37 m from the GP layout on paper and 3.8% quicker in the sheet —
        // length cannot separate these two, so this one lives or dies on a hint.
        id: 'fuji_classic',
        name: 'Classic Circuit',
        sheet: 'Fuji (classic)',
        lengthM: 4526,
        config: ['classic'],
        sim: ['classic'],
      },
    ],
  },
  {
    id: 'imola',
    name: 'Autodromo Enzo e Dino Ferrari',
    match: ['imola', 'enzo e dino'],
    layouts: [{ id: 'imola_gp', name: 'Grand Prix', sheet: 'Imola', lengthM: 4909, primary: true }],
  },
  {
    id: 'interlagos',
    name: 'Autódromo José Carlos Pace',
    match: ['interlagos', 'carlos pace'],
    layouts: [
      { id: 'interlagos_gp', name: 'Grand Prix', sheet: 'Interlagos', lengthM: 4309, primary: true },
    ],
  },
  {
    id: 'laguna_seca',
    name: 'WeatherTech Raceway Laguna Seca',
    match: ['laguna'],
    layouts: [
      // Also absent from racedata.js. 2.238 mi; the live table measured 3590.
      { id: 'laguna_seca', name: 'Full Circuit', sheet: 'Laguna Seca', lengthM: 3602, primary: true },
    ],
  },
  {
    id: 'lemans',
    name: 'Circuit de la Sarthe',
    match: ['sarthe', 'le mans', 'lemans'],
    layouts: [
      {
        id: 'lemans_full',
        name: 'Full Circuit',
        sheet: 'Circuit de la Sarthe',
        lengthM: 13626,
        primary: true,
        config: ['full', '24h', 'chicane'],
        sim: ['24h', 'full'],
      },
      {
        // The Mulsanne without its chicanes: same centreline length, 16 s a lap
        // quicker in GT3. The pair that most needs the shared-memory hint.
        id: 'lemans_straight',
        name: 'Mulsanne (no chicanes)',
        sheet: 'Circuit de la Sarthe (straight)',
        lengthM: 13626,
        config: ['straight', 'mulsanne', 'no chicane'],
        sim: ['straight', 'mulsanne', 'nochicane'],
      },
    ],
  },
  {
    id: 'monza',
    name: 'Autodromo Nazionale Monza',
    match: ['monza'],
    layouts: [
      {
        id: 'monza_gp',
        name: 'Grand Prix',
        sheet: 'Monza',
        lengthM: 5793,
        primary: true,
        config: ['grand prix', 'gp'],
        sim: ['gp', 'grandprix'],
      },
      {
        id: 'monza_curva_grande',
        name: 'Curva Grande',
        sheet: 'Monza (curvagrande)',
        lengthM: 5793,
        config: ['curva', 'grande'],
        sim: ['curva', 'grande'],
      },
    ],
  },
  {
    id: 'paul_ricard',
    name: 'Circuit Paul Ricard',
    match: ['ricard', 'castellet'],
    layouts: [
      {
        id: 'paul_ricard_gp',
        name: 'ELMS',
        sheet: 'Paul Ricard',
        lengthM: 5842,
        primary: true,
        config: ['elms', 'grand prix', 'gp'],
        sim: ['elms'],
      },
      {
        id: 'paul_ricard_1a',
        name: 'Layout 1A',
        sheet: 'Paul Ricard (1A)',
        lengthM: 5752,
        config: ['1a'],
        sim: ['1a'],
      },
      {
        id: 'paul_ricard_1av2',
        name: 'Layout 1A-V2',
        sheet: 'Paul Ricard (1A v2)',
        lengthM: 5842,
        config: ['1a v2', '1av2'],
        sim: ['1av2'],
      },
      {
        id: 'paul_ricard_1av2_short',
        name: 'Layout 1A-V2-Short',
        sheet: 'Paul Ricard (1A v2 short)',
        lengthM: 5227,
        config: ['short'],
        sim: ['short'],
      },
      {
        id: 'paul_ricard_3a',
        name: 'Layout 3A',
        sheet: 'Paul Ricard (3A)',
        lengthM: 3793,
        config: ['3a'],
        sim: ['3a'],
      },
    ],
  },
  {
    id: 'portimao',
    name: 'Algarve International Circuit',
    match: ['portimao', 'portimão', 'algarve'],
    layouts: [
      { id: 'portimao_gp', name: 'Grand Prix', sheet: 'Portimao', lengthM: 4653, primary: true },
    ],
  },
  {
    id: 'qatar',
    name: 'Lusail International Circuit',
    match: ['lusail', 'qatar'],
    layouts: [
      {
        id: 'qatar_gp',
        name: 'Grand Prix',
        sheet: 'Qatar',
        lengthM: 5400,
        primary: true,
        config: ['grand prix', 'gp'],
        sim: ['gp', 'grandprix'],
      },
      {
        id: 'qatar_short',
        name: 'Short Circuit',
        sheet: 'Qatar (short)',
        lengthM: 3701,
        config: ['short'],
        sim: ['short'],
      },
    ],
  },
  {
    id: 'sebring',
    name: 'Sebring International Raceway',
    match: ['sebring'],
    layouts: [
      {
        id: 'sebring_full',
        name: 'Full Circuit',
        sheet: 'Sebring',
        lengthM: 6019,
        primary: true,
        config: ['full', 'international'],
        sim: ['full'],
      },
      {
        id: 'sebring_school',
        name: 'School Circuit',
        sheet: 'Sebring (school)',
        lengthM: 3219,
        config: ['school'],
        sim: ['school'],
      },
    ],
  },
  {
    id: 'silverstone',
    name: 'Silverstone Circuit',
    match: ['silverstone'],
    layouts: [
      {
        id: 'silverstone_gp_wec',
        name: 'Grand Prix (WEC)',
        sheet: 'Silverstone (GP)',
        lengthM: 5890,
        primary: true,
        config: ['grand prix', 'gp', 'wec'],
        sim: ['gp', 'grandprix'],
      },
      {
        id: 'silverstone_international',
        name: 'International Circuit',
        sheet: 'Silverstone (International)',
        lengthM: 2979,
        config: ['international'],
        sim: ['international'],
      },
      {
        id: 'silverstone_national',
        name: 'National Circuit',
        sheet: 'Silverstone (National)',
        lengthM: 2639,
        config: ['national'],
        sim: ['national'],
      },
    ],
  },
  {
    id: 'spa',
    name: 'Circuit de Spa-Francorchamps',
    match: ['spa', 'francorchamps'],
    layouts: [
      // The sheet carries one Spa row; LMU's GP and Endurance layouts share a
      // centreline and the sheet does not distinguish them, so neither do we.
      { id: 'spa_gp', name: 'Grand Prix', sheet: 'Spa', lengthM: 7004, primary: true },
    ],
  },
];

module.exports = { BANDS, CLASSES, CIRCUITS };
