/**
 * scripts/test-session-headline.js — the session strip's contract.
 * -----------------------------------------------------------------------------
 * The strip across the top of the standings tower and the fuel calculator
 * answers one question — *how much of this session is left* — and the answer
 * has three different shapes depending on how the session ends:
 *
 *   lap-limited     LAP 12/40   · 29 LAPS LEFT
 *   timed race      LAP 12      · 28:14 · ~24 LAPS LEFT
 *   practice/quali  PRACTICE    · 28:14
 *
 * That last row is the one worth a test. Practice and qualifying have a clock
 * but no lap total, so a counter there is a personal tally being shown where a
 * position in the session belongs — "LAP 5" with nothing to be five of. The rule
 * is easy to write and just as easy to undo by adding a case above it.
 *
 * Both panels take the wording from the same function so they cannot disagree
 * about how many laps are to go, which is a subtraction the driver makes between
 * the two panels ("29 laps left, 14 laps of fuel"). One of them counting the lap
 * being run and the other not would be off by one, silently, all race.
 *
 * No test framework in this repo — plain node, run with
 * `npm run test:session-headline`. The overlay is browser-side IIFE script, so
 * client.js is evaluated here against a minimal DOM stub rather than imported.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/* -------------------------------------------------------------------------- */
/*  A DOM small enough to run client.js, big enough to see what it wrote       */
/* -------------------------------------------------------------------------- */

function makeElement(tag) {
  return {
    tagName: tag,
    className: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    children: [],
    attrs: {},
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    querySelector() { return null; },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c, on) { on ? this._set.add(c) : this._set.delete(c); },
    },
  };
}

/** Load overlay/js/client.js and hand back the runtime it exposes. */
function loadRuntime() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'overlay', 'js', 'client.js'), 'utf8');
  const documentEl = makeElement('html');
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    // "loading" so the boot path parks on DOMContentLoaded and never runs: this
    // test is about what the strip says, not about connecting a socket.
    document: {
      readyState: 'loading',
      documentElement: documentEl,
      createElement: makeElement,
      querySelector: () => null,
      getElementById: () => null,
      addEventListener: () => {},
    },
    window: { addEventListener: () => {}, location: { search: '', protocol: 'http:' } },
  };
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'client.js' });
  if (!sandbox.window.ApexOverlay) throw new Error('client.js exposed no ApexOverlay');
  return sandbox;
}

const sandbox = loadRuntime();
const { sessionHeadline, sessionStrip } = sandbox.window.ApexOverlay;

/** A green, running session; every field the headline reads, overridable. */
const session = (over) => Object.assign({
  type: 'race',
  phase: 'green',
  notStarted: false,
  currentLap: 12,
  totalLaps: 0,
  lapsRemaining: -1,
  timeRemainingSec: -1,
  scheduledLengthSec: -1,
}, over);

/* -------------------------------------------------------------------------- */

console.log('1) A lap-limited race counts laps done and laps left');
{
  // 29, not 28: the lap being run still has to be driven, and still has to be
  // fuelled for. This is the same count the fuel calculator finishes the race
  // on (`lapsToFinish` = totalRaceLaps − lapsCompleted, fuelCalculator.ts), so
  // "29 LAPS LEFT" and the litres beside it are answers to the same question.
  const h = sessionHeadline(session({ currentLap: 12, totalLaps: 40 }));
  check('the counter names both ends', h.primary === 'LAP 12/40', h.primary);
  check('laps left counts the lap being run', h.note === '29 LAPS LEFT', h.note);
  check('no countdown beside it', h.clock === '', h.clock);
}

console.log('\n2) …and keeps counting to the flag');
{
  const last = sessionHeadline(session({ currentLap: 40, totalLaps: 40 }));
  check('the final lap says one, singular', last.note === '1 LAP LEFT', last.note);
  const done = sessionHeadline(session({ currentLap: 41, totalLaps: 40 }));
  check('past the flag it says nothing rather than a negative', done.note === '', done.note);
  const unknown = sessionHeadline(session({ currentLap: -1, totalLaps: 40 }));
  check('an unknown lap invents no laps-left', unknown.note === '', unknown.note);
  check('and still names the distance', unknown.primary === 'LAP —/40', unknown.primary);
}

console.log('\n3) A timed race counts laps too, with the clock beside them');
{
  const h = sessionHeadline(session({
    currentLap: 12, totalLaps: 0, timeRemainingSec: 3600, lapsRemaining: 24,
  }));
  check('the counter has no total to give', h.primary === 'LAP 12', h.primary);
  check('the clock carries the hour', h.clock === '1:00:00', h.clock);
  check('laps left is marked an estimate', h.note === '~24 LAPS LEFT', h.note);
  check('not urgent with an hour to run', h.urgent === false, String(h.urgent));

  const end = sessionHeadline(session({
    currentLap: 30, totalLaps: 0, timeRemainingSec: 45, lapsRemaining: 1,
  }));
  check('the final minute is urgent', end.urgent === true, String(end.urgent));
  check('and the last lap is singular there too', end.note === '~1 LAP LEFT', end.note);
}

console.log('\n4) Practice and qualifying show the session, not a lap tally');
{
  for (const [type, label] of [
    ['practice', 'PRACTICE'], ['qualifying', 'QUALIFYING'],
    ['warmup', 'WARM-UP'], ['testday', 'TEST DAY'],
  ]) {
    const h = sessionHeadline(session({ type, currentLap: 5, timeRemainingSec: 1694 }));
    check(type + ' is named rather than counted', h.primary === label, h.primary);
    check('  with its clock', h.clock === '28:14', h.clock);
    check('  and no laps-left claim', h.note === '', h.note);
  }
}

console.log('\n5) The lap limit decides, not the name');
{
  // A lap-limited qualifying session is unusual and entirely legal. The reason
  // practice loses the counter is that there is no total to count towards — so
  // when there is one, the counter is right again.
  const h = sessionHeadline(session({ type: 'qualifying', currentLap: 3, totalLaps: 8 }));
  check('a lap-limited qualifying counts laps', h.primary === 'LAP 3/8', h.primary);
  check('and says what is left', h.note === '6 LAPS LEFT', h.note);
}

console.log('\n6) Before the flag drops, the strip introduces the session');
{
  const grid = sessionHeadline(session({
    type: 'race', phase: 'countdown', notStarted: true,
    currentLap: 0, totalLaps: 40, timeRemainingSec: 12,
  }));
  check('the session is named', grid.primary === 'RACE', grid.primary);
  check('its booked length is the lap total', grid.clock === '40 LAPS', grid.clock);
  check('and the grid is called out', grid.note === 'ON THE GRID', grid.note);

  const garage = sessionHeadline(session({
    type: 'practice', phase: 'garage', notStarted: true,
    currentLap: 0, scheduledLengthSec: 1800, timeRemainingSec: 300,
  }));
  check('a booked length beats the remaining clock', garage.clock === '30 MIN', garage.clock);
  check('the garage adds nothing', garage.note === '', garage.note);

  const unbooked = sessionHeadline(session({
    type: 'practice', phase: 'garage', notStarted: true, currentLap: 0,
  }));
  check('an unpublished length invents no duration', unbooked.clock === '', unbooked.clock);
}

console.log('\n7) The strip draws what the headline says');
{
  const parent = makeElement('div');
  const set = sessionStrip(parent, { small: true });
  const strip = parent.children[0];
  const [primary, clock, note] = strip.children;
  check('it appends one strip', parent.children.length === 1 && strip.children.length === 3,
    'children=' + parent.children.length);
  check('the small variant is marked', /sessionstrip--sm/.test(strip.className), strip.className);
  check('the counter and the note glow, the clock does not',
    /is-crit/.test(primary.className) && /is-crit/.test(note.className)
      && !/is-crit/.test(clock.className),
    [primary.className, clock.className, note.className].join(' | '));

  set(session({ currentLap: 12, totalLaps: 40 }));
  check('a lap race shows the counter', primary.textContent === 'LAP 12/40', primary.textContent);
  check('  hides the clock it has no use for', clock.hidden === true, String(clock.hidden));
  check('  and shows the laps left', note.textContent === '29 LAPS LEFT' && note.hidden === false,
    note.textContent + ' hidden=' + note.hidden);

  set(session({ type: 'practice', currentLap: 5, totalLaps: 0, timeRemainingSec: 1694 }));
  check('switching to practice renames the counter', primary.textContent === 'PRACTICE',
    primary.textContent);
  check('  shows the clock', clock.textContent === '28:14' && clock.hidden === false,
    clock.textContent + ' hidden=' + clock.hidden);
  check('  and retires the stale laps-left', note.hidden === true, String(note.hidden));

  set(session({ type: 'practice', currentLap: 5, totalLaps: 0, timeRemainingSec: 30 }));
  check('the final minute flashes the clock', clock.classList.contains('is-urgent'), '');
  set(session({ type: 'practice', currentLap: 5, totalLaps: 0, timeRemainingSec: 300 }));
  check('and stops flashing when it is no longer true',
    !clock.classList.contains('is-urgent'), '');

  // A frame with no session block at all (a widget bound before the first
  // frame lands) must leave the strip as it was rather than blanking it.
  set(null);
  check('a missing session leaves the strip alone', primary.textContent === 'PRACTICE',
    primary.textContent);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
