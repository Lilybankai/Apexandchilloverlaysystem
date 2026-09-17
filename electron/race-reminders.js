/**
 * electron/race-reminders.js — "tell me when this race is about to start".
 * -----------------------------------------------------------------------------
 * The Schedule tab knows, to the second, when every daily and special race
 * begins. This is the half that acts on it: a driver puts a bell on a start,
 * and gets told at five minutes and at two.
 *
 * ## Why the reminders live in the main process
 * The control panel is a window someone closes. The overlay system is what
 * stays running, so a reminder scheduled in the renderer would quietly stop
 * mattering the moment the panel was out of the way — which is precisely when
 * it is needed. Everything here is main-side and survives the panel being
 * closed; it does not survive the APP being closed, and the tab says so.
 *
 * ## Getting the channel right matters more than the timer
 * A Windows toast is the obvious answer and it is right when the driver is on
 * the desktop. It is the wrong answer in the case that matters most: Focus
 * Assist silences toasts while a fullscreen game has focus, and a driver
 * waiting for a daily race is usually sitting in Le Mans Ultimate's menus.
 *
 * The overlay is not a fallback either — it is gated on being on track, so it
 * is hidden in exactly that situation (see `session-ontrack-signal`).
 *
 * So audio is the channel that actually reaches someone in a sim, and the app
 * already has a voice: the race engineer. A spoken "your Bahrain GT3 race
 * starts in five minutes" lands whether or not Windows is willing to draw
 * anything, which is why `voice` is a first-class channel here and not a
 * novelty.
 *
 * ## One timer
 * Not one per reminder. A `setTimeout` per bell would multiply into dozens of
 * live timers over a day of belling races, and every one of them is a wake-up
 * this app promised not to make (see the stall work). Instead the soonest due
 * moment schedules a single timer, and firing re-arms it.
 *
 * Node's timers also cannot be trusted over long spans — a laptop that sleeps
 * for two hours wakes with its timer still pending — so the timer never runs
 * longer than `MAX_SLEEP_MS`, re-checking the wall clock each time. That makes
 * a missed reminder impossible to cause by suspending the machine, and it costs
 * one wake a minute at worst.
 *
 * Scheduling and firing are pure functions of (reminders, settings, now), so
 * `scripts/test-reminders.js` can stand at any instant and assert what fires
 * without a clock, a toast or a voice.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Lead times offered, in minutes before the start. Announced most-distant
 * first, and the LAST one is the one that gets a driver out of the menus — so
 * it sits at one minute, not two.
 */
const LEADS = [5, 2, 1];

/** Longest a single timer is allowed to run before re-checking the clock. */
const MAX_SLEEP_MS = 60_000;

/**
 * How late a reminder may fire and still be worth firing. A machine asleep
 * through the five-minute mark should still be told at two; one that wakes
 * after the race has started should be told nothing, because a notification
 * about a race you have already missed is just noise.
 */
const GRACE_MS = 90_000;

/**
 * The grace a single mark actually gets. Never longer than the mark's own lead,
 * or a late wake-up announces a race that has already started — at the
 * one-minute mark a flat 90 s grace would happily say "1 minute" thirty seconds
 * AFTER the lights. Entries-open has no such ceiling: the lobby stays open, so
 * being told late is still useful.
 */
function graceFor(lead) {
  const mins = Number(lead);
  return Number.isFinite(mins) ? Math.min(GRACE_MS, mins * 60_000) : GRACE_MS;
}

/** Reminders are dropped this long after their start — the race is gone. */
const EXPIRY_MS = 30 * 60_000;

/* -------------------------------------------------------------------------- */
/*  The store                                                                 */
/* -------------------------------------------------------------------------- */

let storePath = null;
/** id → reminder. `fired` records which leads have already gone out. */
let reminders = new Map();
let settings = { toast: true, voice: false, overlay: true, entriesOpen: false };

/**
 * A reminder's identity. Two bells on the same start are the same bell, so the
 * id is derived rather than generated — which also makes the renderer able to
 * ask "is this one belled?" without holding any state of its own.
 */
function idOf(kind, key, startsAt) {
  return `${kind}:${key}:${startsAt}`;
}

function load() {
  if (!storePath) return;
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (raw && typeof raw === 'object') {
      settings = {
        toast: raw.settings?.toast !== false,
        voice: !!raw.settings?.voice,
        overlay: raw.settings?.overlay !== false,
        entriesOpen: !!raw.settings?.entriesOpen,
      };
      reminders = new Map(
        (Array.isArray(raw.reminders) ? raw.reminders : [])
          .filter((r) => r && r.id && r.startsAt && !Number.isNaN(Date.parse(r.startsAt)))
          .map((r) => [r.id, { ...r, fired: Array.isArray(r.fired) ? r.fired : [] }]),
      );
    }
  } catch {
    /* absent or corrupt: start empty rather than refuse to run */
  }
}

function save() {
  if (!storePath) return;
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({ settings, reminders: [...reminders.values()] }, null, 2),
    );
  } catch {
    /* a read-only profile loses reminders on restart, nothing worse */
  }
}

/* -------------------------------------------------------------------------- */
/*  What is due                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every reminder that should fire at `now` and has not already, newest lead
 * first — so a machine that wakes past both marks announces "two minutes",
 * which is the true one, rather than "five".
 *
 * Pure: give it a clock and it tells you the same thing every time.
 */
function due(list, cfg, now) {
  const out = [];
  for (const r of list) {
    const start = Date.parse(r.startsAt);
    if (Number.isNaN(start)) continue;

    const marks = [];
    for (const lead of LEADS) marks.push({ lead, at: start - lead * 60_000 });
    if (cfg.entriesOpen && r.registrationOpens) {
      const opens = Date.parse(r.registrationOpens);
      if (!Number.isNaN(opens)) marks.push({ lead: 'entries', at: opens });
    }

    // Soonest-to-the-start first, so the most urgent unfired mark wins.
    marks.sort((a, b) => b.at - a.at);
    for (const mark of marks) {
      const tag = String(mark.lead);
      if (r.fired.includes(tag)) continue;
      if (now < mark.at) continue;
      if (now - mark.at > graceFor(mark.lead)) {
        // Missed it — mark it spent so it never fires late, but keep looking:
        // the two-minute mark may still be ahead.
        r.fired.push(tag);
        continue;
      }
      out.push({ reminder: r, lead: mark.lead });
      break; // one announcement per reminder per wake
    }
  }
  return out;
}

/** The next moment anything could need doing, or null when nothing is pending. */
function nextDueAt(list, cfg, now) {
  let soonest = Infinity;
  for (const r of list) {
    const start = Date.parse(r.startsAt);
    if (Number.isNaN(start)) continue;
    const marks = LEADS.map((lead) => ({ tag: String(lead), at: start - lead * 60_000 }));
    if (cfg.entriesOpen && r.registrationOpens) {
      const opens = Date.parse(r.registrationOpens);
      if (!Number.isNaN(opens)) marks.push({ tag: 'entries', at: opens });
    }
    for (const mark of marks) {
      if (r.fired.includes(mark.tag)) continue;
      if (mark.at >= now && mark.at < soonest) soonest = mark.at;
    }
  }
  return soonest === Infinity ? null : soonest;
}

/** Reminders whose race is long gone. Returned rather than deleted, for tests. */
function expired(list, now) {
  return list.filter((r) => {
    const start = Date.parse(r.startsAt);
    return Number.isNaN(start) || now - start > EXPIRY_MS;
  });
}

/* -------------------------------------------------------------------------- */
/*  Wording                                                                   */
/* -------------------------------------------------------------------------- */

/** What a toast says. Title is the race; body is when and where. */
function toastFor(reminder, lead) {
  if (lead === 'entries') {
    return {
      title: `Entries open — ${reminder.title}`,
      body: `${reminder.track}. The lobby is open now.`,
    };
  }
  const mins = Number(lead);
  return {
    title: `${reminder.title} in ${mins} minute${mins === 1 ? '' : 's'}`,
    body: `${reminder.track}. Get into the lobby.`,
  };
}

/**
 * What the engineer says. Deliberately not the toast text read aloud: a spoken
 * line is heard once, over engine noise, so it leads with the number and drops
 * everything the driver can see for themselves.
 */
function speechFor(reminder, lead) {
  if (lead === 'entries') return `Entries are open for ${reminder.title}.`;
  const mins = Number(lead);
  return `${mins} minute${mins === 1 ? '' : 's'} to your ${reminder.title} race at ${reminder.track}.`;
}

/**
 * What the in-game layer is given.
 *
 * `{ kind, text, dwellMs }` — the shape `showNotice` in overlay/js/ingame.js
 * already renders for bound-action feedback, NOT a new one. That notice strip
 * exists, is placed with the rest of the chrome, and caps itself at three
 * stacked messages; inventing a second banner beside it would be two things
 * doing one job.
 *
 * `kind` stays 'ok': 'error' is red and buys a 6 s dwell, and a race starting
 * on schedule is not an error. The dwell is set long instead — this is a notice
 * that asks the driver to go and DO something (leave the practice server and
 * get into the lobby), which is the case the sender-set dwell was added for,
 * and it grows as the start gets closer.
 */
function noticeFor(reminder, lead) {
  const where = reminder.track ? ` — ${reminder.track}` : '';
  /* `race: true` is how the layer tells a reminder from the bound-action
     feedback that shares this channel. A reminder belongs IN the race control
     banner, beside the flags, rather than in the floating strip; everything
     else still goes to the strip. */
  if (lead === 'entries') {
    return { kind: 'ok', race: true, text: `Entries open: ${reminder.title}${where}`, dwellMs: 6000 };
  }
  const mins = Number(lead);
  return {
    kind: 'ok',
    race: true,
    text: `${reminder.title} starts in ${mins} minute${mins === 1 ? '' : 's'}${where}`,
    // The last call is the one that has to be acted on, so it stays up longest.
    dwellMs: mins <= 1 ? 12000 : mins <= 2 ? 9000 : 6000,
  };
}

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

let timer = null;
let sinks = { toast: null, speak: null, overlay: null, changed: null };

function clearTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/**
 * Re-arms the single timer. Capped at MAX_SLEEP_MS so a suspended machine
 * re-checks the wall clock on waking instead of trusting a stale countdown.
 */
function arm() {
  clearTimer();
  const list = [...reminders.values()];
  const next = nextDueAt(list, settings, Date.now());
  if (next === null) return;
  const wait = Math.max(0, Math.min(next - Date.now(), MAX_SLEEP_MS));
  timer = setTimeout(tick, wait);
  if (typeof timer.unref === 'function') timer.unref();
}

/** Fire anything due, drop anything stale, re-arm. */
function tick() {
  const now = Date.now();
  const list = [...reminders.values()];
  let dirty = false;

  for (const { reminder, lead } of due(list, settings, now)) {
    reminder.fired.push(String(lead));
    dirty = true;
    if (settings.toast && sinks.toast) {
      try {
        sinks.toast(toastFor(reminder, lead));
      } catch {
        /* a channel that fails must not take the other one down */
      }
    }
    if (settings.voice && sinks.speak) {
      try {
        sinks.speak(speechFor(reminder, lead));
      } catch {
        /* as above */
      }
    }
    if (settings.overlay && sinks.overlay) {
      try {
        sinks.overlay(noticeFor(reminder, lead));
      } catch {
        /* as above */
      }
    }
  }

  for (const gone of expired(list, now)) {
    reminders.delete(gone.id);
    dirty = true;
  }

  if (dirty) {
    save();
    if (sinks.changed) {
      try {
        sinks.changed();
      } catch {
        /* the panel refreshes on its own next visit */
      }
    }
  }
  arm();
}

/**
 * Wires the service up. `toast` and `speak` are injected so this file never
 * imports Electron and the tests never need one.
 */
function init(opts = {}) {
  storePath = opts.storePath || null;
  sinks = {
    toast: typeof opts.toast === 'function' ? opts.toast : null,
    speak: typeof opts.speak === 'function' ? opts.speak : null,
    overlay: typeof opts.overlay === 'function' ? opts.overlay : null,
    changed: typeof opts.changed === 'function' ? opts.changed : null,
  };
  load();
  // A reminder whose race ran while the app was shut is dropped on the way in,
  // rather than fired late at whoever opens the app tomorrow morning.
  tick();
}

/** Puts a bell on a start, or takes it off. Returns the new state. */
function toggle(entry) {
  if (!entry || !entry.startsAt || Number.isNaN(Date.parse(entry.startsAt))) {
    return { ok: false, error: 'That race has no start time.' };
  }
  const id = idOf(entry.kind || 'daily', entry.key || entry.title || '?', entry.startsAt);
  if (reminders.has(id)) {
    reminders.delete(id);
    save();
    arm();
    return { ok: true, on: false, id };
  }
  if (Date.parse(entry.startsAt) < Date.now()) {
    return { ok: false, error: 'That race has already started.' };
  }
  reminders.set(id, {
    id,
    kind: entry.kind || 'daily',
    key: entry.key || entry.title || '?',
    title: String(entry.title || 'Race'),
    track: String(entry.track || ''),
    startsAt: entry.startsAt,
    registrationOpens: entry.registrationOpens || null,
    fired: [],
  });
  save();
  arm();
  return { ok: true, on: true, id };
}

/** Every live reminder, soonest first, plus the channel settings. */
function list() {
  const rows = [...reminders.values()].sort(
    (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt),
  );
  return { ok: true, reminders: rows, settings: { ...settings }, leads: [...LEADS] };
}

/** Changes a channel. Unknown keys are ignored rather than stored. */
function setSettings(partial) {
  if (partial && typeof partial === 'object') {
    if (typeof partial.toast === 'boolean') settings.toast = partial.toast;
    if (typeof partial.voice === 'boolean') settings.voice = partial.voice;
    if (typeof partial.overlay === 'boolean') settings.overlay = partial.overlay;
    if (typeof partial.entriesOpen === 'boolean') settings.entriesOpen = partial.entriesOpen;
    save();
    arm();
  }
  return { ok: true, settings: { ...settings } };
}

/** Test seam: drops everything in memory and stops the timer. */
function reset() {
  clearTimer();
  reminders = new Map();
  settings = { toast: true, voice: false, overlay: true, entriesOpen: false };
  storePath = null;
  sinks = { toast: null, speak: null, overlay: null, changed: null };
}

module.exports = {
  LEADS,
  MAX_SLEEP_MS,
  GRACE_MS,
  EXPIRY_MS,
  idOf,
  graceFor,
  due,
  nextDueAt,
  expired,
  toastFor,
  speechFor,
  noticeFor,
  init,
  toggle,
  list,
  setSettings,
  reset,
};
