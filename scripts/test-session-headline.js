/**
 * scripts/test-session-headline.js — the session strip's contract.
 * -----------------------------------------------------------------------------
 * The strip across the top of the standings tower and the fuel calculator
 * answers one question — *how much of this session is left* — and the answer
 * has three different shapes depending on how the session ends:
 *
 *   lap-limited     LAP 12/40   · 29 LAPS LEFT
 *   timed race      LAP 12      · 28:14 · ~24 LAPS LEFT
 *   practice/quali  LAP 5       · 28:14 · PRACTICE
 *
 * That last row is the one worth a test. Practice and qualifying have no lap
 * total, so the counter there is the DRIVER's tally — laps they have completed,
 * counting up — rather than where the session is up to, and it is read off
 * their own standings row rather than off `session.currentLap`, which is the
 * leader's. Wiring it to the wrong one would look right in a single-car test
 * session and be wrong the moment anyone else is on track.
 *
 * Both panels take the wording from the same function so they cannot disagree
 * about how many laps are to go, which is a subtraction the driver makes between
 * the two panels ("29 laps left, 14 laps of fuel"). One of them counting the lap
 * being run and the other not would be off by one, silently, all race.
 *
 * The last section covers the other readout in that header, the driver's own
 * position: the field reading ("35 / 38") or their class one ("GT3 10 / 13"),
 * an operator setting. What is asserted there is mostly the FALLBACK — every
 * way the class figure can fail to be known has to land back on the field
 * reading, because a header showing "— / —" mid-race is worse than one
 * answering a slightly different question.
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
const { sessionHeadline, sessionStrip, playerLapsCompleted, positionMeta } =
  sandbox.window.ApexOverlay;

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

console.log('\n4) Practice and qualifying count the laps the DRIVER has done');
{
  for (const [type, label] of [
    ['practice', 'PRACTICE'], ['qualifying', 'QUALIFYING'],
    ['warmup', 'WARM-UP'], ['testday', 'TEST DAY'],
  ]) {
    // currentLap here is 12 — the LEADER's lap, and deliberately nothing like
    // the driver's 5. Reading the wrong one is the whole failure mode.
    const h = sessionHeadline(session({ type, currentLap: 12, timeRemainingSec: 1694 }), 5);
    check(type + ' counts the driver\'s own laps', h.primary === 'LAP 5', h.primary);
    check('  with its clock', h.clock === '28:14', h.clock);
    check('  and keeps the session named beside it', h.note === label, h.note);
  }
}

console.log('\n5) That tally counts completed laps, from zero, with no total');
{
  const out = sessionHeadline(session({ type: 'practice', timeRemainingSec: 1694 }), 0);
  check('an out-lap has completed nothing', out.primary === 'LAP 0', out.primary);
  const first = sessionHeadline(session({ type: 'practice', timeRemainingSec: 1694 }), 1);
  check('one lap in the books reads LAP 1', first.primary === 'LAP 1', first.primary);
  const ten = sessionHeadline(session({ type: 'practice', timeRemainingSec: 1694 }), 10);
  check('and it keeps counting up', ten.primary === 'LAP 10', ten.primary);
  check('never inventing a total to be out of', !ten.primary.includes('/'), ten.primary);

  // Spectating or replaying: there is no driver whose laps these would be, so
  // the counter has nothing honest to say and the session's name takes the slot.
  const none = sessionHeadline(session({ type: 'practice', timeRemainingSec: 1694 }), -1);
  check('no player row falls back to the session name', none.primary === 'PRACTICE',
    none.primary);
  check('  and claims nothing beside it', none.note === '', none.note);
  const absent = sessionHeadline(session({ type: 'practice', timeRemainingSec: 1694 }));
  check('an omitted tally does the same', absent.primary === 'PRACTICE', absent.primary);
}

console.log('\n6) The tally comes off the player\'s own standings row');
{
  const field = (over) => [
    { slotId: 1, isPlayer: false, lapsCompleted: 12 },
    Object.assign({ slotId: 2, isPlayer: true, lapsCompleted: 5 }, over),
    { slotId: 3, isPlayer: false, lapsCompleted: 9 },
  ];
  check('the player row wins, not the leader',
    playerLapsCompleted({ standings: field() }) === 5,
    String(playerLapsCompleted({ standings: field() })));
  check('a player yet to complete one is zero, not unknown',
    playerLapsCompleted({ standings: field({ lapsCompleted: 0 }) }) === 0,
    String(playerLapsCompleted({ standings: field({ lapsCompleted: 0 }) })));
  check('an unpublished count is zero too',
    playerLapsCompleted({ standings: field({ lapsCompleted: -1 }) }) === 0,
    String(playerLapsCompleted({ standings: field({ lapsCompleted: -1 }) })));
  check('a field with no player at all is unknown',
    playerLapsCompleted({ standings: field({ isPlayer: false }) }) === -1,
    String(playerLapsCompleted({ standings: field({ isPlayer: false }) })));
  check('and so is a frame with no field yet',
    playerLapsCompleted({}) === -1 && playerLapsCompleted(null) === -1, '');
}

console.log('\n7) The lap limit decides, not the name');
{
  // A lap-limited qualifying session is unusual and entirely legal. The reason
  // practice counts the driver's own laps is that there is no total to count
  // towards — so when there is one, the race-shaped counter is right again, and
  // it beats the tally even when one is passed in.
  const h = sessionHeadline(session({ type: 'qualifying', currentLap: 3, totalLaps: 8 }), 5);
  check('a lap-limited qualifying counts laps', h.primary === 'LAP 3/8', h.primary);
  check('and says what is left', h.note === '6 LAPS LEFT', h.note);
}

console.log('\n8) Before the flag drops, the strip introduces the session');
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
  }), 0);
  check('a session yet to go green is named, not counted',
    garage.primary === 'PRACTICE', garage.primary);
  check('a booked length beats the remaining clock', garage.clock === '30 MIN', garage.clock);
  check('the garage adds nothing', garage.note === '', garage.note);

  const unbooked = sessionHeadline(session({
    type: 'practice', phase: 'garage', notStarted: true, currentLap: 0,
  }));
  check('an unpublished length invents no duration', unbooked.clock === '', unbooked.clock);
}

console.log('\n9) The strip draws what the headline says');
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

  set(session({ type: 'practice', currentLap: 12, totalLaps: 0, timeRemainingSec: 1694 }), 5);
  check('switching to practice keeps a counter in the same slot',
    primary.textContent === 'LAP 5', primary.textContent);
  check('  shows the clock', clock.textContent === '28:14' && clock.hidden === false,
    clock.textContent + ' hidden=' + clock.hidden);
  check('  and replaces the stale laps-left with the session name',
    note.textContent === 'PRACTICE' && note.hidden === false,
    note.textContent + ' hidden=' + note.hidden);

  set(session({ type: 'practice', currentLap: 12, totalLaps: 0, timeRemainingSec: 30 }), 6);
  check('the counter follows the driver across the line',
    primary.textContent === 'LAP 6', primary.textContent);
  check('the final minute flashes the clock', clock.classList.contains('is-urgent'), '');
  set(session({ type: 'practice', currentLap: 12, totalLaps: 0, timeRemainingSec: 300 }), 6);
  check('and stops flashing when it is no longer true',
    !clock.classList.contains('is-urgent'), '');

  // A frame with no session block at all (a widget bound before the first
  // frame lands) must leave the strip as it was rather than blanking it.
  set(null);
  check('a missing session leaves the strip alone', primary.textContent === 'LAP 6',
    primary.textContent);
}

console.log('\n10) The header position reads the field, or the driver\'s own class');
{
  // A multiclass field: the player is a GT3 mid-pack overall and near the front
  // of their own category — the case the class reading exists for, and the one
  // where getting it wrong still looks plausible.
  // 38 cars: 25 in the quicker categories, then a 13-car GT3 class the player
  // sits 10th in — 35th overall.
  const field = [];
  for (let i = 1; i <= 25; i++) {
    field.push({ slotId: 200 + i, position: i, carClass: 'Hypercar', classPosition: i });
  }
  for (let i = 1; i <= 13; i++) {
    const slot = 100 + i;
    field.push({
      slotId: i === 10 ? 7 : slot,
      position: 25 + i,
      carClass: 'GT3',
      classPosition: i,
      ...(i === 10 ? { isPlayer: true } : {}),
    });
  }

  const frame = (over) => Object.assign({
    player: { slotId: 7, position: 35 },
    session: { numCars: 38 },
    standings: field,
  }, over);

  check('the default reading is the whole field',
    positionMeta(frame()) === '35 / 38', positionMeta(frame()));
  check('the class reading counts inside the class, and names it',
    positionMeta(frame(), 'class') === 'GT3 10 / 13', positionMeta(frame(), 'class'));

  // Every way the class reading can fail falls back to the field one: a header
  // reading "— / —" mid-race is worse than one answering the other question.
  const noClass = frame({
    standings: [{ slotId: 7, position: 35, isPlayer: true }],
  });
  check('a sim with no class falls back to the field',
    positionMeta(noClass, 'class') === '35 / 38', positionMeta(noClass, 'class'));

  const noClassPos = frame({
    standings: [{ slotId: 7, position: 35, carClass: 'GT3', isPlayer: true }],
  });
  check('a missing class position falls back too',
    positionMeta(noClassPos, 'class') === '35 / 38', positionMeta(noClassPos, 'class'));

  const spectating = frame({ standings: [] });
  check('no player row falls back rather than blanking',
    positionMeta(spectating, 'class') === '35 / 38', positionMeta(spectating, 'class'));

  // A single-class field: the two readings are the same numbers, and the tag is
  // what says so. A class of ONE is different — there is no race in it to report.
  const oneMake = frame({
    player: { slotId: 7, position: 3 },
    session: { numCars: 3 },
    standings: [
      { slotId: 5, position: 1, carClass: 'GT3', classPosition: 1 },
      { slotId: 6, position: 2, carClass: 'GT3', classPosition: 2 },
      { slotId: 7, position: 3, carClass: 'GT3', classPosition: 3, isPlayer: true },
    ],
  });
  check('a single-class field still names the class it counted',
    positionMeta(oneMake, 'class') === 'GT3 3 / 3', positionMeta(oneMake, 'class'));

  const alone = frame({
    player: { slotId: 7, position: 35 },
    standings: [
      { slotId: 1, position: 1, carClass: 'Hypercar', classPosition: 1 },
      { slotId: 7, position: 35, carClass: 'GT3', classPosition: 1, isPlayer: true },
    ],
  });
  check('a class of one says nothing a class of one can say',
    positionMeta(alone, 'class') === '35 / 38', positionMeta(alone, 'class'));

  // The player row found by slotId rather than the isPlayer flag — rF2 fills one
  // and LMU the other on some frames.
  const bySlot = frame({
    standings: [
      { slotId: 1, position: 1, carClass: 'GT3', classPosition: 1 },
      { slotId: 7, position: 35, carClass: 'GT3', classPosition: 2 },
    ],
  });
  check('the driver is found by slot when nothing is flagged',
    positionMeta(bySlot, 'class') === 'GT3 2 / 2', positionMeta(bySlot, 'class'));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
