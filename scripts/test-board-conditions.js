/**
 * scripts/test-board-conditions.js — the conditions a board lap was set in.
 * -----------------------------------------------------------------------------
 * Carl, 2026-10-23: hovering a board time should show the session, track and
 * air temperature and the fuel in the car as the lap began; rows that carry
 * them get a small marker. Four links in that chain, each checked here:
 *
 *   1. CAPTURE  — the fuel is the level at the line that STARTED the lap (the
 *                 lap recorder's baseline), and it rides into the upload plan's
 *                 `conditions` with the tank, energy and compound. Missing
 *                 readings are omitted, never zeroed.
 *   2. UPLOAD   — `submit_lap` is called with exactly the arguments every
 *                 deployed server already accepts. The new values ride inside
 *                 `p_conditions` (jsonb), so a server without 0043 stores them
 *                 untouched rather than refusing an unknown named argument.
 *   3. READ     — migration 0043 widens `leaderboard()` and `board_for_lap()`
 *                 without changing their arguments, with safe casts, and puts
 *                 the ACL back exactly (the 0021 anon trap).
 *   4. DRAW     — board-conditions.js: a row from an old server (no columns)
 *                 gets no marker and no card; a row with them gets both;
 *                 implausible values read as "not recorded"; user-supplied
 *                 strings are escaped.
 *
 * Run: node scripts/test-board-conditions.js   (needs `npm run build` first)
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

const ROOT = path.join(__dirname, '..');
const lapLog = require(path.join(ROOT, 'dist', 'telemetry', 'lapLog'));
const BC = require(path.join(ROOT, 'electron', 'control-panel', 'board-conditions.js'));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-boardcond-'));
}

/* -------------------------------------------------------------------------- */
/*  1. Capture: fuel at the START of the lap                                  */
/* -------------------------------------------------------------------------- */

console.log('\ncapture: the fuel is the level at the line that began the lap\n');

{
  // Drive the real recorder: a stint is seen mid-lap (partial), crosses the
  // line with 60 L, burns to 57 L over a clean lap, crosses again. The lap it
  // emits must say 60 L at the start — not 57 (the end), and not whatever the
  // tank holds when the upload eventually runs.
  const rec = new lapLog.LapRecorder();
  const base = {
    sim: 'lmu',
    track: 'Spa-Francorchamps',
    trackLengthM: 7004,
    car: 'Ferrari 296 GT3',
    carClass: 'GT3',
    sessionType: 'qualifying',
    inPit: false,
    limitWarnings: 0,
    penalties: 0,
    trackTempC: 31.4,
    ambientTempC: 22.1,
    capacityL: 100,
    compound: 'Medium',
  };
  let t = 1_000_000;
  const step = (over) => rec.update({ ...base, ...over }, (t += 1000));
  step({ lapsCompleted: 3, lastLapSec: 140.1, fuelL: 63 }); // first sighting, mid-lap
  step({ lapsCompleted: 3, lastLapSec: 140.1, fuelL: 61 });
  step({ lapsCompleted: 4, lastLapSec: 139.9, fuelL: 60 }); // the line: lap 5 begins at 60 L
  step({ lapsCompleted: 4, lastLapSec: 139.9, fuelL: 58.5 });
  step({ lapsCompleted: 5, lastLapSec: 138.42, fuelL: 57 }); // lap 5 done at 57 L
  let out = null;
  for (let i = 0; i < 60 && !out; i++) {
    const r = step({ lapsCompleted: 5, lastLapSec: 138.42, fuelL: 56.9 });
    if (r && r.lapMs === 138_420) out = r;
  }
  check('the recorder emits the clean lap', !!out && out.clean === true, out && out.dirty.join(','));
  check('fuelStartL is the level at the line that began it', out && out.fuelStartL === 60, out && out.fuelStartL);
  check('…not the level at the end', out && out.fuelEndL === 57, out && out.fuelEndL);
  check('temperatures recorded with it', out && out.trackTempC === 31.4 && out.ambientTempC === 22.1);
  check('session type recorded', out && out.sessionType === 'qualifying');

  const dir = tmpdir();
  lapLog.appendLap(out, dir);
  const plan = lapLog.buildUploadPlan(dir);
  const best = plan.bests[0];
  const c = (best && best.conditions) || {};
  check('the best carries fuel at start in its conditions', c.fuelStartL === 60, c.fuelStartL);
  check('…and the tank it was in', c.capacityL === 100, c.capacityL);
  check('…and the compound', c.compound === 'Medium', c.compound);
  check('…beside the session and temperatures it always had',
    c.sessionType === 'qualifying' && c.trackTempC === 31.4 && c.ambientTempC === 22.1);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // A lap with no consumption block (pre-v5, or no shared memory): nothing
  // invented. A zero would read on the board as "started on an empty tank".
  const dir = tmpdir();
  lapLog.appendLap(
    {
      v: 1,
      at: new Date().toISOString(),
      sim: 'lmu',
      track: 'Monza',
      trackKey: 'monza_5793',
      trackLengthM: 5793,
      car: 'Ferrari 296 GT3',
      carClass: 'GT3',
      lapMs: 108_500,
      distanceM: 5793,
      sessionType: 'practice',
      clean: true,
      dirty: [],
      trackTempC: 28,
    },
    dir,
  );
  const c = lapLog.buildUploadPlan(dir).bests[0].conditions;
  check('an old lap sends no fuel key at all', !('fuelStartL' in c) && !('capacityL' in c), JSON.stringify(c));
  check('…no energy, no compound', !('veStartPct' in c) && !('compound' in c));
  check('…and keeps what it did record', c.trackTempC === 28 && c.sessionType === 'practice');
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const f = lapLog.boardLapConditions;
  check('zero energy (a class with no budget) is omitted',
    !('veStartPct' in f({ veStartPct: 0, fuelStartL: 40 })));
  check('a blank compound is omitted', !('compound' in f({ compound: '   ' })));
  check('a NaN fuel reading is omitted', !('fuelStartL' in f({ fuelStartL: NaN })));
  check('energy carried when real', f({ veStartPct: 87.5 }).veStartPct === 87.5);
}

/* -------------------------------------------------------------------------- */
/*  2. Upload: same RPC arguments as every deployed server expects            */
/* -------------------------------------------------------------------------- */

async function uploadShape() {
  console.log('\nupload: the new values ride in p_conditions, not new arguments\n');
  const lapUpload = require(path.join(ROOT, 'electron', 'lapUpload'));
  const root = tmpdir();
  const laps = path.join(root, 'laps');
  const stops = path.join(root, 'stops');
  fs.mkdirSync(laps);
  fs.mkdirSync(stops);
  lapLog.appendLap(
    {
      v: 7,
      at: new Date().toISOString(),
      sim: 'lmu',
      track: 'Spa-Francorchamps',
      trackKey: 'spa-francorchamps_7004',
      trackLengthM: 7004,
      car: 'Ferrari 296 GT3',
      carClass: 'GT3',
      lapMs: 138_420,
      distanceM: 7004,
      sessionType: 'qualifying',
      clean: true,
      dirty: [],
      trackTempC: 31.4,
      ambientTempC: 22.1,
      wetness: 0,
      condition: 'dry',
      fuelStartL: 60,
      fuelEndL: 57,
      capacityL: 100,
      veStartPct: 92,
      compound: 'Soft',
    },
    laps,
  );
  const calls = [];
  lapUpload.init({
    userDataDir: root,
    dirs: { laps, stops },
    noTimer: true,
    auth: {
      getAccessToken: async () => 'token',
      rpc: async (name, args) => {
        calls.push({ name, args });
        return { ok: true, body: { accepted: true, improved: true, rank: 1, condition: 'dry' } };
      },
    },
  });
  await lapUpload.sync({ reason: 'test' });
  lapUpload.stop();
  const sub = calls.find((c) => c.name === 'submit_lap');
  check('submit_lap was called', !!sub);
  // The exact named arguments 0021/0034 declare. Any extra name would be
  // refused by PostgREST on today's server (no matching overload).
  const expected = [
    'p_sim', 'p_track_key', 'p_track_name', 'p_track_length_m', 'p_car_class', 'p_car',
    'p_lap_ms', 'p_set_at', 'p_conditions', 'p_app_version', 'p_condition',
  ].sort().join(',');
  const got = sub ? Object.keys(sub.args).sort().join(',') : '';
  check('…with exactly the arguments the deployed function takes', got === expected, got);
  const pc = (sub && sub.args.p_conditions) || {};
  check('p_conditions carries fuel at start', pc.fuelStartL === 60, pc.fuelStartL);
  check('…the tank', pc.capacityL === 100);
  check('…the energy', pc.veStartPct === 92);
  check('…the compound', pc.compound === 'Soft');
  check('…and still the session and temperatures',
    pc.sessionType === 'qualifying' && pc.trackTempC === 31.4 && pc.ambientTempC === 22.1);
  check('p_conditions is a plain JSON object (jsonb on the wire)',
    JSON.stringify(JSON.parse(JSON.stringify(pc))) === JSON.stringify(pc));
  fs.rmSync(root, { recursive: true, force: true });
}

/* -------------------------------------------------------------------------- */
/*  3. The migration                                                          */
/* -------------------------------------------------------------------------- */

function migration() {
  console.log('\nmigration 0043: wider results, same arguments, same grants\n');
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const name = fs.readdirSync(dir).find((n) => n.startsWith('0043_'));
  check('0043 exists', name === '0043_board_lap_conditions.sql', name);
  const sql = fs.readFileSync(path.join(dir, name), 'utf8');
  const code = sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');

  check('wrapped in one transaction', /^\s*begin;/m.test(code) && /^\s*commit;/m.test(code));
  check('writes no rows', !/\b(insert|update|delete)\b\s/i.test(code.replace(/on conflict[\s\S]*?;/gi, '')));
  check('alters no table', !/alter\s+table/i.test(code));

  for (const fn of [
    ['leaderboard', 'text, uuid, text, text, integer, text'],
    ['board_for_lap', 'text, text, text, integer, text'],
  ]) {
    const [f, sig] = fn;
    const esc = sig.replace(/[(),]/g, (c) => `\\${c}`).replace(/\s+/g, '\\s*');
    check(`${f}: dropped by its current signature`,
      new RegExp(`drop function if exists public\\.${f}\\(${esc}\\)`, 'i').test(code));
    check(`${f}: anon revoked by name (the 0021 trap)`,
      new RegExp(`revoke all on function public\\.${f}\\(${esc}\\) from public, anon`, 'i').test(code));
    check(`${f}: granted back to authenticated + service_role`,
      new RegExp(`grant execute on function public\\.${f}\\(${esc}\\)\\s*to authenticated, service_role`, 'i').test(code));
  }
  // Argument lists unchanged: same parameter names, same order.
  const lbArgs = /create function public\.leaderboard\(([\s\S]*?)\)\s*returns/i.exec(code);
  const names = lbArgs ? lbArgs[1].split(',').map((a) => a.trim().split(/\s+/)[0]) : [];
  check('leaderboard arguments unchanged',
    names.join(',') === 'p_sim,p_track_id,p_car_class,p_car,p_limit,p_condition', names.join(','));

  const cols = ['session_type text', 'track_temp_c real', 'air_temp_c real', 'fuel_start_l real',
    'fuel_capacity_l real', 've_start_pct real', 'compound text'];
  const returns = code.match(/returns table\(([\s\S]*?)\)\s*language/gi) || [];
  check('both functions declare a result table', returns.length === 2, returns.length);
  for (const col of cols) {
    check(`both return ${col}`, returns.every((r) => r.replace(/\s+/g, ' ').includes(col)));
  }
  // Every numeric field is cast only when jsonb says it is a number: one bad
  // string must not take the whole board down for everyone.
  for (const key of ['trackTempC', 'ambientTempC', 'fuelStartL', 'capacityL', 'veStartPct']) {
    check(`${key} cast only under jsonb_typeof = 'number'`,
      new RegExp(`jsonb_typeof\\(b\\.conditions -> '${key}'\\) = 'number'\\s*then \\(b\\.conditions ->> '${key}'\\)::real`).test(code));
  }
  check('the old columns are all still returned, in order',
    /legacy_wet boolean,\s*session_type text/.test(code.replace(/--.*$/gm, '')));
}

/* -------------------------------------------------------------------------- */
/*  4. Drawing                                                                */
/* -------------------------------------------------------------------------- */

function drawing() {
  console.log('\ndrawing: marker and card only where there is something to show\n');
  const OLD_ROW = {
    rank: 1, driver_id: 'a', display_name: 'X', car: 'Ferrari 296 GT3', lap_ms: 138_420,
    gap_ms: null, set_at: '2026-10-20T10:00:00Z', is_you: false, has_trace: true,
    has_line: true, condition: 'dry', wetness: 0, legacy_wet: false,
  };
  const NEW_ROW = {
    ...OLD_ROW,
    session_type: 'qualifying',
    track_temp_c: 31.4,
    air_temp_c: 22.1,
    fuel_start_l: 18.4,
    fuel_capacity_l: 100,
    ve_start_pct: 92,
    compound: 'Soft',
  };

  check('a row from a server without 0043 has no conditions', BC.conditionsOf(OLD_ROW) === null);
  check('…and its time is drawn exactly as before', BC.timeHtml(OLD_ROW, '2:18.420') === '2:18.420');
  check('a row with every column null has none either',
    BC.conditionsOf({ ...OLD_ROW, session_type: null, track_temp_c: null, fuel_start_l: null }) === null);

  const c = BC.conditionsOf(NEW_ROW);
  check('a 0043 row has conditions', !!c);
  check('…session normalised', c && c.session === 'qualifying');
  check('…fuel as a share of the tank', c && Math.round(c.fuelPct) === 18, c && c.fuelPct);
  check('marker letter Q for a quali lap', BC.markerText(c) === 'Q');
  check('marker letter R for a race lap', BC.markerText(BC.conditionsOf({ session_type: 'race', track_temp_c: 30 })) === 'R');
  check('a dot when the session is unknown', BC.markerText(BC.conditionsOf({ track_temp_c: 30 })) === '•');

  BC.setTempUnit('c');
  const m = BC.tipModel(c);
  const line = (label) => (m.lines.find((l) => l.label === label) || {}).value;
  check('card title names the session', m.title === 'Set in qualifying', m.title);
  check('track temperature, whole degrees', line('Track') === '31°C', line('Track'));
  check('air temperature', line('Air') === '22°C', line('Air'));
  check('fuel at start with tank share', line('Fuel at start') === '18.4 L · 18% of tank', line('Fuel at start'));
  check('energy at start', line('Energy at start') === '92%');
  check('compound', line('Tyres') === 'Soft');
  check('Fahrenheit when the panel says so', BC.tipModel(c, 'f').lines[0].value === '89°F', BC.tipModel(c, 'f').lines[0].value);

  const old = BC.tipModel(BC.conditionsOf({ session_type: 'practice', track_temp_c: 28, air_temp_c: 19 }));
  const fuelLine = old.lines.find((l) => l.label === 'Fuel at start');
  check('a lap without fuel says "not recorded" rather than omitting it',
    fuelLine && fuelLine.value === 'not recorded' && fuelLine.muted === true);

  // Plausibility: junk reads as not recorded, never as a number.
  const junk = BC.conditionsOf({ session_type: 'qualifying', track_temp_c: 900, fuel_start_l: 0, fuel_capacity_l: 0, compound: '' });
  check('a 900 °C track is not shown', junk && junk.trackTempC === null);
  check('0 L fuel is "not recorded", not an empty tank', junk && junk.fuelStartL === null);
  check('fuel over capacity gives no percentage',
    BC.conditionsOf({ fuel_start_l: 130, fuel_capacity_l: 100 }).fuelPct === null);
  check('an unknown session type is not shown as one',
    BC.conditionsOf({ session_type: 'hotlap', track_temp_c: 20 }).session === null);
  check('numeric strings from PostgREST are read',
    BC.conditionsOf({ track_temp_c: '31.4' }).trackTempC === 31.4);

  const html = BC.timeHtml(NEW_ROW, '2:18.420');
  check('marked time carries the card data', /data-cond="\{/.test(html));
  check('…is a focus stop', html.includes('tabindex="0"'));
  check('…suppresses the row title underneath', html.includes(' title=""'));
  check('…has an aria-label with the conditions', /aria-label="2:18\.420\. Set in qualifying\. Track 31°C/.test(html));
  check('…shows the Q marker', html.includes('data-session="qualifying" aria-hidden="true">Q</span>'));
  check('…and still shows the time', html.endsWith('2:18.420</span>'));
  check('inside a button it is not a focus stop',
    !BC.timeHtml(NEW_ROW, '2:18.420', { focusable: false }).includes('tabindex'));

  const evil = BC.timeHtml({ ...NEW_ROW, compound: '"><img src=x onerror=alert(1)>' }, '2:18.420');
  check('a hostile compound string cannot break out of the attribute',
    !evil.includes('<img') && !/"><img/.test(evil));
  const parsed = JSON.parse(
    evil.match(/data-cond="([^"]*)"/)[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&'),
  );
  check('…and round-trips as data', parsed.compound === '"><img src=x onerror=alert(1)>'.slice(0, 24));

  // The DOM path the Leaderboard tab uses, on a minimal fake document.
  const doc = fakeDocument();
  const span = doc.createElement('span');
  span.textContent = '2:18.420';
  check('decorate() leaves an old row alone', BC.decorate(span, OLD_ROW, '2:18.420') === false && span.children.length === 0);
  check('decorate() marks a 0043 row', BC.decorate(span, NEW_ROW, '2:18.420') === true);
  check('…with the marker first, then the time',
    span.children[0].className === 'lbcond__mark' && span.children[0].textContent === 'Q' && span.children[1].textContent === '2:18.420');
  check('…and the card data + focus stop', span.attrs['data-cond'] && span.tabIndex === 0 && span.classes.has('lbcond'));
}

function fakeDocument() {
  const doc = {
    createElement(tag) {
      const el = {
        tag,
        ownerDocument: doc,
        attrs: {},
        classes: new Set(),
        children: [],
        tabIndex: -1,
        className: '',
        _text: '',
        get textContent() {
          return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
        },
        set textContent(v) {
          this.children = [];
          this._text = String(v);
        },
        setAttribute(k, v) { this.attrs[k] = String(v); },
        append(...nodes) { this.children.push(...nodes); },
      };
      el.classList = { add: (c) => el.classes.add(c) };
      return el;
    },
    createTextNode(text) {
      return { textContent: String(text), className: '' };
    },
  };
  return doc;
}

/* -------------------------------------------------------------------------- */
/*  5. Training's Chase list passes the columns through                       */
/* -------------------------------------------------------------------------- */

function training() {
  console.log('\ntraining: the Chase list carries the same columns\n');
  const tr = require(path.join(ROOT, 'electron', 'trainingReference.js'));
  check('no columns → null (old server)', tr.boardConditionFields({ lap_ms: 1, driver_id: 'a' }) === null);
  const f = tr.boardConditionFields({ lap_ms: 1, session_type: 'race', fuel_start_l: 40, compound: null });
  check('present columns copied, nulls dropped',
    f && f.session_type === 'race' && f.fuel_start_l === 40 && !('compound' in f), JSON.stringify(f));
}

uploadShape()
  .catch((err) => check('the upload test threw', false, err && err.stack))
  .then(() => {
    migration();
    drawing();
    training();
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
  });
