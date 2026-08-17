/**
 * electron/streamBot.js — persistence and policy for the stream bot.
 * -----------------------------------------------------------------------------
 * The bot's ENGINE lives in the server (src/server/streamBot.ts), where the
 * chat feed is. This module is the desktop half, in the same shape as
 * chatLink.js: it owns the on-disk config (<userData>/streambot.json), the
 * YouTube quota ledger, validation of everything the panel edits, and the
 * recomputation of the engine's working config whenever anything changes —
 * settings, a goal ticking up, or an account being (un)linked.
 *
 * Nothing in here is secret (commands, timers, templates, counts — no tokens),
 * but the file still travels through the same 0600 write path as chatlink.json
 * because consistency is cheaper than a judgement call per file.
 *
 * ## The quota ledger
 * YouTube sends cost 50 units each against the Cloud project's shared
 * 10,000/day (docs/youtube-chat-quota.md). The engine enforces the caps; this
 * module is the durable memory behind them: `quotaLedger` survives restarts so
 * a relaunch mid-stream cannot double the day's budget, and it rolls over at
 * midnight PACIFIC time because that is when Google resets the quota day.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* -------------------------------------------------------------------------- */
/*  Limits (what the panel may store, not what the engine may send)            */
/* -------------------------------------------------------------------------- */

const MAX_COMMANDS = 50;
const MAX_TIMERS = 20;
const MAX_GOALS = 10;
const MAX_TEXT = 400;
/** 200 msgs × 50 units = the whole 10k project day — the absolute ceiling. */
const MAX_DAILY_CAP = 200;
const MAX_SESSION_CAP = 200;
/** YouTube timers may never run hotter than this (minutes). */
const MIN_YT_TIMER_MIN = 10;
/** Twitch timers: fixed floor, not configurable (minutes). */
const MIN_TWITCH_TIMER_MIN = 2;

const ALERT_KEYS = ['sub', 'resub', 'gift', 'membership', 'superchat'];

/* -------------------------------------------------------------------------- */
/*  State                                                                     */
/* -------------------------------------------------------------------------- */

let userDataDir = null;
let onChange = () => {};
/** Push the engine's working config to the (possibly not yet started) server. */
let applyBotConfig = () => {};
/** The chat-link state (linked accounts, scopes) — capability + self names. */
let getLinkState = () => ({});

let store = defaults();
/** Messages sent this app session (runtime only — resets on relaunch). */
let usedSession = 0;
let rolloverTimer = null;

function defaults() {
  return {
    enabled: false,
    platforms: { twitch: true, youtube: true },
    commands: [],
    timers: [],
    alerts: {
      sub: { enabled: true, template: 'Thanks {user} for the Tier {tier} sub! 💜' },
      resub: { enabled: true, template: '{user} resubbed — {months} months strong!' },
      gift: { enabled: true, template: '{user} just gifted {count} sub(s) — legend!' },
      membership: { enabled: true, template: 'Welcome to the members, {user}! 🎉' },
      superchat: { enabled: true, template: '{user} sent {amount} — thank you so much!' },
    },
    goals: [],
    youtubeBudget: { sessionCap: 60, dailyCap: 150, minTimerIntervalMin: 10 },
    quotaLedger: { date: '', messagesSentToday: 0 },
  };
}

/* -------------------------------------------------------------------------- */
/*  Persistence                                                               */
/* -------------------------------------------------------------------------- */

function storePath() {
  return path.join(userDataDir || '.', 'streambot.json');
}

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    const base = defaults();
    return {
      enabled: raw.enabled === true,
      platforms: {
        twitch: raw.platforms ? raw.platforms.twitch !== false : true,
        youtube: raw.platforms ? raw.platforms.youtube !== false : true,
      },
      commands: sanitizeCommands(raw.commands),
      timers: sanitizeTimers(raw.timers),
      alerts: sanitizeAlerts(raw.alerts, base.alerts),
      goals: sanitizeGoals(raw.goals),
      youtubeBudget: sanitizeBudget(raw.youtubeBudget),
      quotaLedger:
        raw.quotaLedger && typeof raw.quotaLedger.date === 'string'
          ? {
              date: raw.quotaLedger.date,
              messagesSentToday: clampInt(raw.quotaLedger.messagesSentToday, 0, 100000, 0),
            }
          : { date: '', messagesSentToday: 0 },
    };
  } catch {
    return defaults();
  }
}

function writeStore() {
  if (!userDataDir) return;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8');
    try {
      fs.chmodSync(storePath(), 0o600);
    } catch {
      /* filesystem doesn't support it */
    }
  } catch (err) {
    console.error('[streamBot] could not persist:', err.message);
  }
}

/* -------------------------------------------------------------------------- */
/*  Validation — the panel sends whole sections, this is the only gate         */
/* -------------------------------------------------------------------------- */

function clampInt(v, min, max, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function text(v, max = MAX_TEXT) {
  return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

function id(v) {
  const s = String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  return s || crypto.randomBytes(6).toString('hex');
}

function sanitizeCommands(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const c of list.slice(0, MAX_COMMANDS)) {
    if (!c || typeof c !== 'object') continue;
    // Stored WITHOUT the bang, lowercase — the engine matches it that way.
    const name = String(c.name || '').replace(/^!+/, '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32);
    const response = text(c.response);
    if (!name || !response || seen.has(name)) continue;
    seen.add(name);
    out.push({
      id: id(c.id),
      name,
      response,
      cooldownSec: clampInt(c.cooldownSec, 0, 3600, 10),
      enabled: c.enabled !== false,
    });
  }
  return out;
}

function sanitizeTimers(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const t of list.slice(0, MAX_TIMERS)) {
    if (!t || typeof t !== 'object') continue;
    const body = text(t.text);
    if (!body) continue;
    out.push({
      id: id(t.id),
      text: body,
      intervalMin: clampInt(t.intervalMin, 1, 1440, 15),
      onlyWhileLive: t.onlyWhileLive !== false,
      platforms: {
        twitch: t.platforms ? t.platforms.twitch !== false : true,
        youtube: t.platforms ? t.platforms.youtube === true : false,
      },
      enabled: t.enabled !== false,
    });
  }
  return out;
}

function sanitizeAlerts(raw, base) {
  const out = {};
  for (const key of ALERT_KEYS) {
    const a = raw && typeof raw === 'object' ? raw[key] : null;
    out[key] = {
      enabled: a ? a.enabled !== false : base[key].enabled,
      template: a && a.template !== undefined ? text(a.template) : base[key].template,
    };
  }
  return out;
}

function sanitizeGoals(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const g of list.slice(0, MAX_GOALS)) {
    if (!g || typeof g !== 'object') continue;
    const label = text(g.label, 60);
    if (!label) continue;
    out.push({
      id: id(g.id),
      type: g.type === 'yt_members' ? 'yt_members' : 'twitch_subs',
      label,
      target: clampInt(g.target, 1, 1000000, 10),
      current: clampInt(g.current, 0, 1000000, 0),
      announceEveryN: clampInt(g.announceEveryN, 1, 1000, 5),
      enabled: g.enabled !== false,
      templates: {
        progress: g.templates ? text(g.templates.progress) : '{label}: {current}/{target}!',
        complete: g.templates ? text(g.templates.complete) : 'GOAL COMPLETE — {label} hit {target}! 🏁',
      },
    });
  }
  return out;
}

function sanitizeBudget(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  return {
    sessionCap: clampInt(b.sessionCap, 0, MAX_SESSION_CAP, 60),
    dailyCap: clampInt(b.dailyCap, 0, MAX_DAILY_CAP, 150),
    minTimerIntervalMin: clampInt(b.minTimerIntervalMin, MIN_YT_TIMER_MIN, 1440, 10),
  };
}

/* -------------------------------------------------------------------------- */
/*  The quota day (Pacific — Google's reset clock, not the streamer's)         */
/* -------------------------------------------------------------------------- */

function quotaDay() {
  try {
    // en-CA formats as YYYY-MM-DD, which sorts and compares as a plain string.
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Roll the ledger if Google's quota day has changed since it was written. */
function rollLedger() {
  const today = quotaDay();
  if (store.quotaLedger.date !== today) {
    store.quotaLedger = { date: today, messagesSentToday: 0 };
    writeStore();
    return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Wire the module up. Called once from main.js after app is ready.
 * @param {{userDataDir:string, onChange:function, applyBotConfig:function, getLinkState:function}} deps
 */
function init(deps) {
  userDataDir = deps.userDataDir;
  onChange = typeof deps.onChange === 'function' ? deps.onChange : () => {};
  applyBotConfig = typeof deps.applyBotConfig === 'function' ? deps.applyBotConfig : () => {};
  getLinkState = typeof deps.getLinkState === 'function' ? deps.getLinkState : () => ({});
  store = readStore();
  rollLedger();
  pushServerConfig();
  // A stream that runs across midnight Pacific gets its budget back on time.
  if (rolloverTimer) clearInterval(rolloverTimer);
  rolloverTimer = setInterval(() => {
    if (rollLedger()) {
      pushServerConfig();
      emitChange();
    }
  }, 60_000);
  rolloverTimer.unref?.();
  emitChange();
}

/** Everything the panel renders. No tokens live in this module at all. */
function stateForUi() {
  const b = store.youtubeBudget;
  return {
    enabled: store.enabled,
    platforms: { ...store.platforms },
    commands: store.commands.map((c) => ({ ...c })),
    timers: store.timers.map((t) => ({ ...t, platforms: { ...t.platforms } })),
    alerts: JSON.parse(JSON.stringify(store.alerts)),
    goals: store.goals.map((g) => ({ ...g, templates: { ...g.templates } })),
    youtubeBudget: { ...b },
    usage: {
      usedSession,
      usedToday: store.quotaLedger.messagesSentToday,
      sessionCap: b.sessionCap,
      dailyCap: b.dailyCap,
      // What this install has spent of the SHARED project day, in units.
      unitsToday: store.quotaLedger.messagesSentToday * 50,
    },
  };
}

function emitChange() {
  try {
    onChange(stateForUi());
  } catch (err) {
    console.error('[streamBot] onChange failed:', err.message);
  }
}

/** Recompute the engine's working config and push it to the server. */
function pushServerConfig() {
  let link = {};
  try {
    link = getLinkState() || {};
  } catch {
    /* chatLink not ready yet — capabilities read as absent */
  }
  const b = store.youtubeBudget;
  try {
    applyBotConfig({
      enabled: store.enabled,
      platforms: { ...store.platforms },
      commands: store.commands,
      timers: store.timers,
      alerts: store.alerts,
      goals: store.goals.map((g) => ({ ...g, templates: { ...g.templates } })),
      youtube: {
        sendAllowed: !!link.youTubeCanSend,
        sessionCap: b.sessionCap,
        dailyCap: b.dailyCap,
        usedSession,
        usedToday: store.quotaLedger.messagesSentToday,
        minTimerIntervalMs: b.minTimerIntervalMin * 60_000,
      },
      twitch: {
        sendAllowed: !!link.twitchAuthed,
        minTimerIntervalMs: MIN_TWITCH_TIMER_MIN * 60_000,
      },
      selfNames: {
        twitch: link.twitchAccount || '',
        youtube: link.youTubeAccount || '',
      },
    });
  } catch (err) {
    console.error('[streamBot] applyBotConfig failed:', err.message);
  }
}

/**
 * Replace one whole section, validated. The panel edits a list locally and
 * sends it back complete — no per-row patch grammar to get wrong.
 * @param {'commands'|'timers'|'alerts'|'goals'|'settings'} section
 */
function update(section, value) {
  if (section === 'commands') store.commands = sanitizeCommands(value);
  else if (section === 'timers') store.timers = sanitizeTimers(value);
  else if (section === 'alerts') store.alerts = sanitizeAlerts(value, store.alerts);
  else if (section === 'goals') store.goals = sanitizeGoals(value);
  else if (section === 'settings') {
    const v = value && typeof value === 'object' ? value : {};
    if (v.enabled !== undefined) store.enabled = v.enabled === true;
    if (v.platforms && typeof v.platforms === 'object') {
      if (v.platforms.twitch !== undefined) store.platforms.twitch = v.platforms.twitch === true;
      if (v.platforms.youtube !== undefined) store.platforms.youtube = v.platforms.youtube === true;
    }
    if (v.youtubeBudget !== undefined) store.youtubeBudget = sanitizeBudget(v.youtubeBudget);
  } else {
    return { ok: false, error: `Unknown section "${section}".` };
  }
  writeStore();
  pushServerConfig();
  emitChange();
  return { ok: true, state: stateForUi() };
}

function setEnabled(on) {
  store.enabled = on === true;
  writeStore();
  pushServerConfig();
  emitChange();
  return { ok: true, state: stateForUi() };
}

/** Manual ± on a goal from the panel (corrections, offline subs, …). */
function goalAdjust(goalId, delta) {
  const goal = store.goals.find((g) => g.id === goalId);
  if (!goal) return { ok: false, error: 'No such goal.' };
  goal.current = clampInt(goal.current + clampInt(delta, -1000, 1000, 0), 0, 1000000, goal.current);
  writeStore();
  pushServerConfig();
  emitChange();
  return { ok: true, state: stateForUi() };
}

/** The engine sent `n` YouTube messages — the durable half of the budget. */
function noteQuotaUsed(n) {
  const count = clampInt(n, 0, 1000, 0);
  if (!count) return;
  rollLedger();
  usedSession += count;
  store.quotaLedger.messagesSentToday += count;
  writeStore();
  // No pushServerConfig here: the engine already spent these against its own
  // counters; pushing would only echo the same numbers back.
  emitChange();
}

/** The engine moved a goal (a sub came in) — persist so restarts keep it. */
function noteGoalChanged(goalId, current) {
  const goal = store.goals.find((g) => g.id === goalId);
  if (!goal) return;
  goal.current = clampInt(current, 0, 1000000, goal.current);
  writeStore();
  emitChange();
}

module.exports = {
  init,
  stateForUi,
  update,
  setEnabled,
  goalAdjust,
  noteQuotaUsed,
  noteGoalChanged,
  pushServerConfig,
};
