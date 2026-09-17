/**
 * scripts/test-reminders.js — the race reminder scheduler.
 * -----------------------------------------------------------------------------
 * A reminder has exactly one job and exactly one way of failing at it: being
 * silent when it should speak, or speaking when the race has already gone. Both
 * are invisible until the moment they matter, and neither shows up in a
 * screenshot or a typecheck.
 *
 * The cases below are the ways this breaks, and each is a real mechanism rather
 * than a hypothetical:
 *
 *   - a laptop sleeps through the five-minute mark and wakes at three. The
 *     driver must be told "two minutes" and never "five", because "five" is
 *     a lie about when the race starts.
 *   - it sleeps through BOTH marks and wakes after the start. Nothing should
 *     be said at all.
 *   - the app is shut overnight and opened the next morning with yesterday's
 *     bells still in the file. Nothing should fire, and nothing should linger.
 *   - a bell is put on twice. It is one bell, not two announcements.
 *
 * `due`, `nextDueAt` and `expired` are pure functions of (reminders, settings,
 * now), which is what lets all of that be asserted standing at a fixed instant
 * with no timers, no toasts and no Electron.
 *
 * Run: node scripts/test-reminders.js
 */

'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const reminders = require('../electron/race-reminders');

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

const START = Date.parse('2026-09-17T12:00:00Z');
const at = (minsBeforeStart) => START - minsBeforeStart * 60_000;

function bell(over = {}) {
  return {
    id: 'daily:LMGT3 Fixed:2026-09-17T12:00:00.000Z',
    kind: 'daily',
    key: 'LMGT3 Fixed',
    title: 'LMGT3 Fixed',
    track: '8 Hours of Bahrain',
    startsAt: '2026-09-17T12:00:00.000Z',
    registrationOpens: '2026-09-17T11:30:00.000Z',
    fired: [],
    ...over,
  };
}

const CFG = { toast: true, voice: false, entriesOpen: false };
const CFG_ENTRIES = { ...CFG, entriesOpen: true };

/* -------------------------------------------------------------------------- */

console.log('\nWhen a reminder is due');
{
  check('nothing at ten minutes out', reminders.due([bell()], CFG, at(10)).length === 0);
  const five = reminders.due([bell()], CFG, at(5));
  check('the five-minute mark fires', five.length === 1 && five[0].lead === 5, five[0] && five[0].lead);
  const two = reminders.due([bell({ fired: ['5'] })], CFG, at(2));
  check('then the two-minute mark', two.length === 1 && two[0].lead === 2, two[0] && two[0].lead);
  const one = reminders.due([bell({ fired: ['5', '2'] })], CFG, at(1));
  check('then the one-minute mark - the one that moves you', one.length === 1 && one[0].lead === 1, one[0] && one[0].lead);
  check('and nothing after all three', reminders.due([bell({ fired: ['5', '2', '1'] })], CFG, at(0.5)).length === 0);
  check('one announcement per wake, not three', reminders.due([bell()], CFG, at(1)).length === 1);
}

console.log('\nA machine that slept');
{
  /* Woken at three minutes out, having missed the five-minute mark entirely. */
  const r = bell();
  const out = reminders.due([r], CFG, at(3));
  check('the missed five is not announced late', !out.some((x) => x.lead === 5), JSON.stringify(out.map((x) => x.lead)));
  check('…and is marked spent so it never will be', r.fired.includes('5'));
  check('nothing is claimed at three minutes', out.length === 0);
  const later = reminders.due([r], CFG, at(2));
  check('the two-minute mark still lands', later.length === 1 && later[0].lead === 2);

  /* Woken after the start: the race is gone, so say nothing. */
  const missed = bell();
  const after = reminders.due([missed], CFG, START + 60_000);
  check('a race already started announces nothing', after.length === 0, JSON.stringify(after.map((x) => x.lead)));
  check('…and both marks are spent', missed.fired.includes('5') && missed.fired.includes('2'));

  /* Within the grace window it is still worth saying. */
  const fresh = bell();
  const justLate = reminders.due([fresh], CFG, at(5) + 30_000);
  check('thirty seconds late still counts as five minutes', justLate.length === 1 && justLate[0].lead === 5);
}

console.log('\nGrace never outlives the mark it belongs to');
{
  check('five minutes gets the full 90s', reminders.graceFor(5) === 90000, String(reminders.graceFor(5)));
  check('two minutes gets the full 90s', reminders.graceFor(2) === 90000, String(reminders.graceFor(2)));
  check('ONE minute is capped at 60s, not 90', reminders.graceFor(1) === 60000, String(reminders.graceFor(1)));
  check('entries-open keeps the default', reminders.graceFor('entries') === 90000, String(reminders.graceFor('entries')));

  /* The reason the cap exists: a flat 90 s grace on a 60 s lead would announce
     "1 minute" thirty seconds AFTER the race had started. */
  const late = reminders.due([bell({ fired: ['5', '2'] })], CFG, START + 30000);
  check('a one-minute mark never fires after the start', late.length === 0, JSON.stringify(late.map((x) => x.lead)));
  const justInTime = reminders.due([bell({ fired: ['5', '2'] })], CFG, at(1) + 30000);
  check('...but thirty seconds late is still in time', justInTime.length === 1 && justInTime[0].lead === 1);
}

console.log('\nEntries-open, when it is switched on');
{
  check('off by default, so nothing at the half hour', reminders.due([bell()], CFG, at(30)).length === 0);
  const on = reminders.due([bell()], CFG_ENTRIES, at(30));
  check('on, it fires when the lobby opens', on.length === 1 && on[0].lead === 'entries', on[0] && String(on[0].lead));
  check(
    'a reminder with no registration time is unaffected',
    reminders.due([bell({ registrationOpens: null })], CFG_ENTRIES, at(30)).length === 0,
  );
  /* The five-minute mark must still win over a not-yet-fired entries mark when
     both are behind us — the nearer one to the start is the true one. */
  const both = reminders.due([bell()], CFG_ENTRIES, at(5));
  check('at five minutes it says five, not "entries open"', both.length === 1 && both[0].lead === 5, String(both[0].lead));
}

console.log('\nWhen to wake up next');
{
  check('the five-minute mark', reminders.nextDueAt([bell()], CFG, at(60)) === at(5));
  check('then the two', reminders.nextDueAt([bell({ fired: ['5'] })], CFG, at(4)) === at(2));
  check('then the one', reminders.nextDueAt([bell({ fired: ['5', '2'] })], CFG, at(4)) === at(1));
  check('nothing left to wake for', reminders.nextDueAt([bell({ fired: ['5', '2', '1'] })], CFG, at(0.5)) === null);
  check('entries-open comes first when it is on', reminders.nextDueAt([bell()], CFG_ENTRIES, at(60)) === at(30));
  check('an empty list never schedules a wake', reminders.nextDueAt([], CFG, at(60)) === null);
  const two = [bell(), bell({ id: 'b', startsAt: '2026-09-17T12:45:00.000Z', registrationOpens: null })];
  check('the soonest of several wins', reminders.nextDueAt(two, CFG, at(60)) === at(5));
}

console.log('\nClearing out');
{
  check('a race half an hour ago is not expired yet', reminders.expired([bell()], START + 29 * 60_000).length === 0);
  check('an hour later it is', reminders.expired([bell()], START + 60 * 60_000).length === 1);
  check('an unparseable start is dropped rather than kept forever', reminders.expired([bell({ startsAt: 'soon' })], START).length === 1);
}

console.log('\nWording');
{
  const t = reminders.toastFor(bell(), 5);
  check('the toast title leads with the race and the number', t.title === 'LMGT3 Fixed in 5 minutes', t.title);
  check('the body says where', /Bahrain/.test(t.body), t.body);
  check('one minute is not "1 minutes"', reminders.toastFor(bell(), 1).title.endsWith('in 1 minute'));
  const e = reminders.toastFor(bell(), 'entries');
  check('entries-open reads as an opening, not a countdown', /^Entries open/.test(e.title), e.title);
  const s = reminders.speechFor(bell(), 2);
  check('speech leads with the number, not the name', /^2 minutes/.test(s), s);
  check('…and names the circuit, because it is heard once', /Bahrain/.test(s), s);
}

console.log('\nThe in-game notice');
{
  /* It must match the shape overlay/js/ingame.js showNotice() already renders:
     it bails on anything without `text`, and reads `kind` and `dwellMs`. A
     notice shaped any other way is silently dropped on the layer, which is the
     failure this whole channel exists to avoid. */
  const n = reminders.noticeFor(bell(), 5);
  check('it has the text showNotice requires', typeof n.text === 'string' && n.text.length > 0, n.text);
  check('kind is ok, not error — a race starting is not a fault', n.kind === 'ok', n.kind);
  check('it names the race and the circuit', /LMGT3 Fixed/.test(n.text) && /Bahrain/.test(n.text));
  check('one minute is not "1 minutes"', /in 1 minute\b/.test(reminders.noticeFor(bell(), 1).text), reminders.noticeFor(bell(), 1).text);

  /* The last call is the one that has to be acted on, so it stays up longest —
     and every dwell is inside the 12 s ceiling showNotice clamps to. */
  const d5 = reminders.noticeFor(bell(), 5).dwellMs;
  const d2 = reminders.noticeFor(bell(), 2).dwellMs;
  const d1 = reminders.noticeFor(bell(), 1).dwellMs;
  check('dwell grows as the start approaches', d5 < d2 && d2 < d1, [d5, d2, d1].join(' < '));
  check('and never exceeds the overlay ceiling', d1 <= 12000, String(d1));

  const e = reminders.noticeFor(bell(), 'entries');
  check('entries-open reads as an opening', /^Entries open/.test(e.text), e.text);

  /* `race: true` is what routes it into the race control banner rather than the
     floating strip. Without the flag it lands in the strip — which is where it
     was, and what Carl asked to have changed. */
  check('it is flagged as race information', n.race === true);
  check('…on every lead', [5, 2, 1, 'entries'].every((l) => reminders.noticeFor(bell(), l).race === true));

  /* A reminder with no track must not leave a dangling separator. */
  const bare = reminders.noticeFor(bell({ track: '' }), 2);
  check('no circuit means no trailing dash', !/[—-]\s*$/.test(bare.text), JSON.stringify(bare.text));

  /* The overlay is a channel like the others, and off means silent. */
  const seen = [];
  reminders.reset();
  reminders.init({ overlay: (x) => seen.push(x), toast: () => {} });
  reminders.setSettings({ overlay: false });
  check('the overlay channel can be switched off', reminders.list().settings.overlay === false);
  reminders.setSettings({ overlay: true });
  check('…and on again', reminders.list().settings.overlay === true);
  check('it is on by default', (reminders.reset(), reminders.init({}), reminders.list().settings.overlay) === true);
  reminders.reset();
}

console.log('\nThe store, on disk');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-reminders-'));
  const file = path.join(dir, 'reminders.json');

  reminders.reset();
  reminders.init({ storePath: file });
  const soon = new Date(Date.now() + 40 * 60_000).toISOString();

  const on = reminders.toggle({ kind: 'daily', key: 'LMGT3 Fixed', title: 'LMGT3 Fixed', track: 'Bahrain', startsAt: soon });
  check('a bell goes on', on.ok === true && on.on === true);
  check('and is listed', reminders.list().reminders.length === 1);

  const again = reminders.toggle({ kind: 'daily', key: 'LMGT3 Fixed', title: 'LMGT3 Fixed', track: 'Bahrain', startsAt: soon });
  check('belling the same start again takes it off', again.on === false);
  check('…leaving none', reminders.list().reminders.length === 0);

  reminders.toggle({ kind: 'daily', key: 'LMGT3 Fixed', title: 'LMGT3 Fixed', track: 'Bahrain', startsAt: soon });
  const past = reminders.toggle({ kind: 'daily', key: 'Old', title: 'Old', track: 'X', startsAt: '2020-01-01T00:00:00.000Z' });
  check('a race that has already started refuses the bell', past.ok === false, past.error);
  check('…with a reason worth showing', /already started/.test(past.error || ''));
  check('a start that is not a time is refused', reminders.toggle({ title: 'X', startsAt: 'whenever' }).ok === false);

  reminders.setSettings({ voice: true, nonsense: 1 });
  check('a known channel is stored', reminders.list().settings.voice === true);
  check('an unknown key is not', !('nonsense' in reminders.list().settings));

  /* Reopening the app reads it all back. */
  reminders.reset();
  reminders.init({ storePath: file });
  check('reminders survive a restart', reminders.list().reminders.length === 1, String(reminders.list().reminders.length));
  check('…and so do the channels', reminders.list().settings.voice === true);

  /* Yesterday's bells, opened this morning: nothing fires, nothing lingers. */
  const spoke = [];
  reminders.reset();
  fs.writeFileSync(
    file,
    JSON.stringify({
      settings: { toast: true, voice: true },
      reminders: [bell({ startsAt: '2020-01-01T00:00:00.000Z' })],
    }),
  );
  reminders.init({ storePath: file, toast: () => spoke.push('toast'), speak: () => spoke.push('voice') });
  check('a stale reminder announces nothing on launch', spoke.length === 0, spoke.join());
  check('…and is cleared out', reminders.list().reminders.length === 0);

  reminders.reset();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\nA corrupt store is not a crash');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-reminders-'));
  const file = path.join(dir, 'reminders.json');
  fs.writeFileSync(file, '{ not json at all');
  reminders.reset();
  reminders.init({ storePath: file });
  check('it starts empty rather than refusing to run', reminders.list().reminders.length === 0);
  check('…with the default channels', reminders.list().settings.toast === true);
  reminders.reset();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed ? 'FAILED' : 'OK'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
