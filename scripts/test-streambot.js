/**
 * scripts/test-streambot.js — the stream bot's deterministic core.
 * -----------------------------------------------------------------------------
 * Everything here is the arithmetic that decides whether the bot speaks:
 * command matching + cooldowns, timer cadence (and the per-platform minimum
 * interval that protects the YouTube quota), the YouTube budget's priority
 * shedding, goal boundary announcements, the gift-bomb double-count guard, and
 * the self-message loop guard. All driven by an injected clock — no sockets,
 * no Google project, no waiting.
 *
 * Runs against the compiled module: npm run build && node scripts/test-streambot.js
 */

'use strict';

const { StreamBot, YouTubeBudget, renderTemplate, commandNameFromText, alertKeyForEvent } =
  require('../dist/server/streamBot');

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

/** A chat line as the hub would deliver it. */
function line(platform, author, text, event) {
  const msg = {
    id: `${platform}-${Math.random()}`,
    platform,
    author,
    color: '',
    badges: [],
    segments: [{ kind: 'text', text }],
    ts: 0,
  };
  if (event) msg.event = event;
  return msg;
}

/** A bot + spies, with a controllable clock. Overrides merge into the config. */
function harness(cfgOverrides, depsOverrides) {
  const state = {
    t: 0,
    twitch: [],
    youtube: [],
    quota: 0,
    goals: [],
    live: { twitch: true, youtube: true },
  };
  const bot = new StreamBot(
    Object.assign(
      {
        now: () => state.t,
        sendTwitch: (text) => {
          state.twitch.push(text);
          return true;
        },
        sendYouTube: (text) => {
          state.youtube.push(text);
          return Promise.resolve(true);
        },
        onQuotaUsed: (n) => {
          state.quota += n;
        },
        onGoalChanged: (id, current) => {
          state.goals.push({ id, current });
        },
        isLive: (p) => state.live[p],
      },
      depsOverrides || {},
    ),
  );
  bot.setConfig(
    Object.assign(
      {
        enabled: true,
        platforms: { twitch: true, youtube: true },
        commands: [],
        timers: [],
        alerts: {},
        goals: [],
        youtube: {
          sendAllowed: true,
          sessionCap: 60,
          dailyCap: 150,
          usedSession: 0,
          usedToday: 0,
          minTimerIntervalMs: 600000,
        },
        twitch: { sendAllowed: true, minTimerIntervalMs: 120000 },
        selfNames: { twitch: 'streamer', youtube: 'Streamer Channel' },
      },
      cfgOverrides || {},
    ),
  );
  return { bot, state };
}

/* -------------------------------------------------------------------------- */
console.log('\npure helpers');
/* -------------------------------------------------------------------------- */

{
  check('template fills known placeholders',
    renderTemplate('Thanks {user}, tier {tier}!', { user: 'A', tier: '2' }) === 'Thanks A, tier 2!');
  check('unknown placeholder stays literal (typo stays visible)',
    renderTemplate('{userr} hi', { user: 'A' }) === '{userr} hi');
  check('command name is lowercased first token', commandNameFromText('  !Discord please') === 'discord');
  check('mid-line bang is not a command', commandNameFromText('go !discord') === '');
  check('bare text is not a command', commandNameFromText('discord') === '');
  check('gift kinds share one alert', alertKeyForEvent('subgift') === 'gift' && alertKeyForEvent('giftbomb') === 'gift');
}

/* -------------------------------------------------------------------------- */
console.log('\ncommands — matching + cooldowns + self-guard');
/* -------------------------------------------------------------------------- */

{
  const { bot, state } = harness({
    commands: [{ id: 'c1', name: 'discord', response: 'join: <link>', cooldownSec: 10, enabled: true }],
  });
  bot.handleMessage(line('twitch', 'viewer', '!discord'));
  check('command answers on the platform it came from', state.twitch.length === 1 && state.youtube.length === 0);
  check('response text used', state.twitch[0] === 'join: <link>');

  state.t = 5000;
  bot.handleMessage(line('twitch', 'viewer2', '!DISCORD'));
  check('cooldown blocks a repeat at 5s', state.twitch.length === 1);
  state.t = 10000;
  bot.handleMessage(line('twitch', 'viewer3', '!Discord'));
  check('case-insensitive match fires again after cooldown', state.twitch.length === 2);

  state.t = 30000;
  bot.handleMessage(line('twitch', 'Streamer', '!discord'));
  check('the streamer can trigger their own commands', state.twitch.length === 3);

  state.t = 60000;
  bot.handleMessage(line('youtube', 'ytviewer', '!discord'));
  check('same command works from YouTube, answered on YouTube', state.youtube.length === 1);
  check('YouTube reply reported to the quota ledger', state.quota === 1);
}
{
  // The bot speaks AS the streamer, so its replies come back down the feed
  // authored by the streamer. Only those exact echoed lines are dropped —
  // otherwise a reply starting with "!" re-triggers a command forever.
  const { bot, state } = harness({
    commands: [
      { id: 'a', name: 'a', response: '!b hi', cooldownSec: 0, enabled: true },
      { id: 'b', name: 'b', response: 'boom', cooldownSec: 0, enabled: true },
    ],
  });
  bot.handleMessage(line('twitch', 'viewer', '!a'));
  check('reply that looks like a command is sent', state.twitch.length === 1 && state.twitch[0] === '!b hi');
  state.t = 3000;
  bot.handleMessage(line('twitch', 'Streamer', '!b hi')); // the echo of our own reply
  check('echoed own reply does not re-trigger (loop broken)', state.twitch.length === 1);
  state.t = 20000; // past the 15s echo window
  bot.handleMessage(line('twitch', 'Streamer', '!b hi')); // genuinely typed this time
  check('the same text typed later by the streamer works', state.twitch.length === 2 && state.twitch[1] === 'boom');
  state.t = 25000;
  bot.handleMessage(line('twitch', 'viewer2', '!b hi')); // a viewer is never echo-suppressed
  check('a viewer typing bot-reply text is never suppressed', state.twitch.length === 3);
}
{
  const { bot, state } = harness({
    enabled: false,
    commands: [{ id: 'c1', name: 'discord', response: 'x', cooldownSec: 0, enabled: true }],
  });
  bot.handleMessage(line('twitch', 'v', '!discord'));
  check('master switch off → silent', state.twitch.length === 0);
}

/* -------------------------------------------------------------------------- */
console.log('\ntimers — cadence, platform minimums, live gating');
/* -------------------------------------------------------------------------- */

{
  const { bot, state } = harness({
    timers: [
      {
        id: 't1',
        text: 'follow the socials',
        intervalMin: 2,
        onlyWhileLive: true,
        platforms: { twitch: true, youtube: true },
        enabled: true,
      },
    ],
  });
  bot.tick();
  check('first tick arms, never fires immediately', state.twitch.length === 0);
  state.t = 120000;
  bot.tick();
  check('twitch timer fires at its 2min interval', state.twitch.length === 1);
  check('youtube held back by the 10min platform minimum', state.youtube.length === 0);
  state.t = 600000;
  bot.tick();
  check('youtube fires once the platform minimum has passed', state.youtube.length === 1);
}
{
  // Live gating: an offline platform never fires a live-only timer.
  const { bot, state } = harness({
    timers: [
      {
        id: 't1',
        text: 'x',
        intervalMin: 2,
        onlyWhileLive: true,
        platforms: { twitch: true, youtube: false },
        enabled: true,
      },
    ],
  });
  state.live.twitch = false;
  bot.tick();
  state.t = 6000000;
  bot.tick();
  check('offline platform never fires a live-only timer', state.twitch.length === 0);
  state.live.twitch = true;
  state.t = 6120000;
  bot.tick(); // going live arms the timer; a full interval must pass first
  check('going live does not fire instantly', state.twitch.length === 0);
  state.t = 6240000;
  bot.tick();
  check('fires one interval after going live', state.twitch.length === 1);
}

/* -------------------------------------------------------------------------- */
console.log('\nYouTubeBudget — caps + priority shedding');
/* -------------------------------------------------------------------------- */

{
  const b = new YouTubeBudget();
  b.configure({ sessionCap: 10, dailyCap: 100, usedSession: 0, usedToday: 0 });
  check('fresh budget allows all priorities',
    b.canSend('timer') && b.canSend('command') && b.canSend('alert'));
  b.configure({ sessionCap: 10, dailyCap: 100, usedSession: 8, usedToday: 8 });
  check('timers shed at ≤25% remaining', b.canSend('timer') === false);
  check('commands still ok at 20% remaining', b.canSend('command') === true);
  b.configure({ sessionCap: 10, dailyCap: 100, usedSession: 9, usedToday: 9 });
  check('commands shed at ≤10% remaining', b.canSend('command') === false);
  check('alerts run to the last message', b.canSend('alert') === true);
  b.configure({ sessionCap: 10, dailyCap: 100, usedSession: 10, usedToday: 10 });
  check('exhausted session blocks even alerts', b.canSend('alert') === false);
  // The DAILY cap binds even with session headroom (a second stream that day).
  b.configure({ sessionCap: 60, dailyCap: 100, usedSession: 0, usedToday: 100 });
  check('daily cap binds across sessions', b.canSend('alert') === false);
  check('remainingMessages is the scarcer window', b.remainingMessages() === 0);
  b.configure({ sessionCap: 10, dailyCap: 100, usedSession: 0, usedToday: 0 });
  b.noteSend();
  check('noteSend spends both windows', b.remainingMessages() === 9);
}
{
  // Caps are opt-in: 0 = no cap, and that is the default — the bot never
  // rations a chat the streamer didn't ask it to.
  const b = new YouTubeBudget();
  b.configure({ sessionCap: 0, dailyCap: 0, usedSession: 9999, usedToday: 9999 });
  check('uncapped allows every priority regardless of spend',
    b.canSend('timer') && b.canSend('command') && b.canSend('alert'));
  check('uncapped remaining is unbounded', b.remainingMessages() === Infinity);
  // One cap set, the other 0: only the set one takes part.
  b.configure({ sessionCap: 0, dailyCap: 100, usedSession: 9999, usedToday: 40 });
  check('a lone daily cap governs alone', b.remainingMessages() === 60 && b.canSend('timer'));
  b.configure({ sessionCap: 0, dailyCap: 100, usedSession: 0, usedToday: 100 });
  check('a lone daily cap still hard-stops at zero', b.canSend('alert') === false);
}
{
  // End-to-end: an exhausted budget silences YouTube but not Twitch.
  const { bot, state } = harness({
    commands: [{ id: 'c1', name: 'discord', response: 'x', cooldownSec: 0, enabled: true }],
    youtube: {
      sendAllowed: true,
      sessionCap: 10,
      dailyCap: 100,
      usedSession: 10,
      usedToday: 10,
      minTimerIntervalMs: 600000,
    },
  });
  bot.handleMessage(line('youtube', 'v', '!discord'));
  check('over budget → no YouTube send', state.youtube.length === 0);
  state.t = 10000;
  bot.handleMessage(line('twitch', 'v', '!discord'));
  check('Twitch unaffected by the YouTube budget', state.twitch.length === 1);
}

/* -------------------------------------------------------------------------- */
console.log('\nalerts + goals — events, boundaries, gift bombs');
/* -------------------------------------------------------------------------- */

{
  const { bot, state } = harness({
    alerts: {
      sub: { enabled: true, template: 'Thanks {user} for the tier {tier} sub!' },
      gift: { enabled: true, template: '{user} gifted {count} subs!' },
    },
    goals: [
      {
        id: 'g1',
        type: 'twitch_subs',
        label: 'Sub goal',
        target: 10,
        current: 3,
        announceEveryN: 5,
        enabled: true,
        templates: { progress: '{label}: {current}/{target}', complete: 'DONE {label} {target}' },
      },
    ],
  });

  bot.handleMessage(line('twitch', 'NewFan', 'x', { kind: 'sub', tier: '1' }));
  check('sub alert rendered', state.twitch[0] === 'Thanks NewFan for the tier 1 sub!');
  check('goal incremented + persisted', state.goals.length === 1 && state.goals[0].current === 4);
  check('no progress line off-boundary (4 of every-5)', state.twitch.length === 1);

  state.t = 10000;
  bot.handleMessage(line('twitch', 'Fan2', 'x', { kind: 'sub', tier: '2' }));
  check('boundary crossed at 5 → progress announced',
    state.twitch.includes('Sub goal: 5/10'), JSON.stringify(state.twitch));

  // A 20-gift bomb: one alert, one +20, and the shrapnel subgifts are inert.
  state.t = 20000;
  bot.handleMessage(line('twitch', 'Whale', 'x', { kind: 'giftbomb', count: 20 }));
  const afterBomb = state.twitch.length;
  check('bomb alert fired', state.twitch.includes('Whale gifted 20 subs!'));
  check('goal completes through the bomb', state.twitch.includes('DONE Sub goal 10'), JSON.stringify(state.twitch));
  check('goal current reflects the full bomb', state.goals[state.goals.length - 1].current === 25);
  state.t = 21000;
  bot.handleMessage(line('twitch', 'Whale', 'x', { kind: 'subgift', tier: '1', count: 1 }));
  bot.handleMessage(line('twitch', 'Whale', 'x', { kind: 'subgift', tier: '1', count: 1 }));
  check('shrapnel subgifts suppressed after a bomb',
    state.twitch.length === afterBomb && state.goals[state.goals.length - 1].current === 25);
  state.t = 60000;
  bot.handleMessage(line('twitch', 'Gifter', 'x', { kind: 'subgift', tier: '1', count: 1 }));
  check('a lone subgift after the window counts again',
    state.goals[state.goals.length - 1].current === 26);
}
{
  const { bot, state } = harness({
    alerts: { membership: { enabled: true, template: 'Welcome {user}!' } },
    goals: [
      {
        id: 'g2',
        type: 'yt_members',
        label: 'Members',
        target: 3,
        current: 2,
        announceEveryN: 1,
        enabled: true,
        templates: { progress: 'p', complete: 'Members goal hit: {current}/{target}' },
      },
    ],
  });
  bot.handleMessage(line('youtube', 'NewMember', 'x', { kind: 'membership' }));
  check('membership alert on YouTube', state.youtube[0] === 'Welcome NewMember!');
  check('completion line, not a progress line, at the target',
    state.youtube.includes('Members goal hit: 3/3'), JSON.stringify(state.youtube));
  check('completion announced only once', state.youtube.filter((s) => s.startsWith('Members goal')).length === 1);
}
{
  // Disabled alert: the goal still counts, silently.
  const { bot, state } = harness({
    alerts: { sub: { enabled: false, template: 'x' } },
    goals: [
      {
        id: 'g1',
        type: 'twitch_subs',
        label: 'g',
        target: 100,
        current: 0,
        announceEveryN: 50,
        enabled: true,
        templates: { progress: 'p', complete: 'c' },
      },
    ],
  });
  bot.handleMessage(line('twitch', 'v', 'x', { kind: 'sub', tier: '1' }));
  check('disabled alert stays silent but the goal still counts',
    state.twitch.length === 0 && state.goals[0].current === 1);
}

/* -------------------------------------------------------------------------- */
console.log('\nthe global floor — no back-to-back bursts');
/* -------------------------------------------------------------------------- */

{
  const { bot, state } = harness({
    commands: [
      { id: 'a', name: 'a', response: 'ra', cooldownSec: 0, enabled: true },
      { id: 'b', name: 'b', response: 'rb', cooldownSec: 0, enabled: true },
    ],
  });
  bot.handleMessage(line('twitch', 'v1', '!a'));
  bot.handleMessage(line('twitch', 'v2', '!b'));
  check('second line inside 2s floor is dropped', state.twitch.length === 1);
  state.t = 2000;
  bot.handleMessage(line('twitch', 'v2', '!b'));
  check('floor lifts after 2s', state.twitch.length === 2);
}

/* -------------------------------------------------------------------------- */
console.log('\nstreamer-guide — the walkthrough content is complete');
/* -------------------------------------------------------------------------- */

{
  // Same contract test-setup.js runs on the Setups guide: every step whole,
  // and the flag machinery sane — the DOM half is exercised in the app.
  const guide = require('../electron/control-panel/streamer-guide.js');
  check('guide has a full tour', Array.isArray(guide.STEPS) && guide.STEPS.length >= 5, guide.STEPS.length);
  check('every step is whole (id, icon, title, lead, points)',
    guide.STEPS.every((s) => s.id && s.icon && s.title && s.lead && Array.isArray(s.points) && s.points.length > 0));
  check('no duplicate step ids', new Set(guide.STEPS.map((s) => s.id)).size === guide.STEPS.length);
  check('the tour covers the panes that need explaining',
    ['link', 'bot', 'overlay', 'commands', 'timers', 'alerts'].every((id) => guide.STEPS.some((s) => s.id === id)));
  check('placeholders are shown to the user somewhere',
    guide.STEPS.some((s) => s.points.some((p) => p.includes('{user}'))));
  check('seen flag is versioned', typeof guide.GUIDE_VERSION === 'string' && guide.GUIDE_VERSION.length > 0);
}

/* -------------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
