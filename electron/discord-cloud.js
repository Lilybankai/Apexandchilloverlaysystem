/**
 * electron/discord-cloud.js — communities, and the Discord channels they post to.
 * -----------------------------------------------------------------------------
 * The app side of docs/DISCORD-NOTIFICATIONS.md. Everything here is a thin
 * wrapper over the RPCs in migration 0026, through the injected auth module
 * (which owns the URL, key and token refresh — same arrangement as
 * team-cloud.js and lapUpload.js).
 *
 * Three things are worth knowing before changing anything in here:
 *
 *   1. **A community is not a team.** Teams cap at six because they model an
 *      endurance lineup sharing a car. A community is a league Discord — forty
 *      people, no cap, no bearing on telemetry. The only thing it does is route
 *      notifications. A driver who is in nobody's league never touches one:
 *      they paste a webhook and get a personal channel with no roster at all.
 *
 *   2. **The webhook URL leaves here exactly once.** It goes to
 *      save_discord_target() and is never read back — every server read path
 *      returns it masked, deliberately, because anyone holding that URL can
 *      post to that channel forever. So this module does not cache it, and the
 *      panel shows `.../webhooks/1234567890/........` from then on.
 *
 *   3. **The two validators here MUST agree with the server's.** A join code
 *      that the app rejects but the database would have accepted is a driver
 *      staring at a code from their league's Discord that "doesn't work", and
 *      a webhook the app accepts but the database refuses is a save that fails
 *      for no visible reason. normalizeJoinCode() and isDiscordWebhook() are
 *      line-for-line mirrors of the SQL in 0026, and scripts/test-discord.js
 *      asserts that they stay that way.
 *
 * The pure helpers (normalizeJoinCode, isDiscordWebhook, maskWebhook,
 * reasonText) are exported for scripts/test-discord.js.
 */

'use strict';

/** The event kinds a channel can subscribe to, in the order the panel lists them. */
const KINDS = [
  {
    id: 'record_taken',
    label: 'Records taken',
    hint: 'Someone beats a record another driver held. The best one — leave it on.',
  },
  {
    id: 'record_set',
    label: 'New records',
    hint: 'A record on a board that had no one on top of it yet.',
  },
  {
    id: 'record_extended',
    label: 'Records improved',
    hint: 'A driver beats their own record. Off by default: it is news to them, not to forty people.',
  },
  {
    id: 'session_result',
    label: 'Race results',
    hint:
      "Official daily, weekly and special events — the whole classification, once, with your people's finishes picked out. Nothing is posted for ten minutes, so everyone's app has time to report the same race.",
  },
];

/** What a NEW channel subscribes to, mirroring save_discord_target's own
 *  defaults: "records improved" is for a channel of your own, where the only
 *  reader is the person who set the lap. */
const DEFAULT_KINDS = ['record_taken', 'record_set', 'session_result'];
const DEFAULT_KINDS_PERSONAL = [...DEFAULT_KINDS, 'record_extended'];

/* -------------------------------------------------------------------------- */
/*  Pure helpers (tested offline, and mirrored in SQL)                        */
/* -------------------------------------------------------------------------- */

/**
 * Uppercase, strip whatever punctuation survived the copy/paste, and put the
 * dash back. '' when it cannot be a code.
 *
 * Mirrors join_community()'s own normalisation: it does
 * `regexp_replace(upper(code), '[^A-Z0-9]', '', 'g')`, demands eight
 * characters, and reassembles XXXX-XXXX. Codes are read off a Discord message,
 * so the dash and the case are the two things people lose.
 */
function normalizeJoinCode(raw) {
  const code = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : '';
}

/**
 * Mirrors the pattern in save_discord_target(). The server checks it because
 * the dispatcher POSTs to whatever is stored — a "webhook" pointing anywhere
 * else is a request our server makes on a stranger's behalf. This side checks
 * it so the driver is told which part is wrong while the URL is still in front
 * of them.
 */
const WEBHOOK_RE =
  /^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/;

function isDiscordWebhook(url) {
  return WEBHOOK_RE.test(String(url || '').trim());
}

/** The same masking the server applies, for the moment before the reload. */
function maskWebhook(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  const m = s.match(/^(https:\/\/[^/]+\/api\/webhooks\/[0-9]+\/).*$/);
  return m ? `${m[1]}........` : '';
}

/** Server refusal → something a human can act on. */
const REASON_TEXT = {
  no_name: 'Give the community a name.',
  too_many: 'You already own the maximum number of communities.',
  bad_code: 'Codes look like ABCD-1234.',
  no_such_code: 'No community has that code. Check it with whoever shared it.',
  not_admin: 'Only an owner or admin of that community can do that.',
  not_member: 'You are not in that community.',
  bad_share: 'Pick what to share: nothing, records only, or everything.',
  no_webhook: 'Paste the webhook URL from Discord first.',
  not_a_discord_webhook:
    'That is not a Discord webhook URL. In Discord: Channel settings ▸ Integrations ▸ Webhooks ▸ Copy Webhook URL.',
  no_such_channel: 'That channel has gone — reload and try again.',
  owner_cannot_leave: 'You own this community. Hand it over or delete it instead of leaving.',
  cannot_remove_owner: 'The owner cannot be removed.',
};

function reasonText(reason) {
  return REASON_TEXT[reason] || `Refused: ${reason}`;
}

/* -------------------------------------------------------------------------- */
/*  Wiring                                                                    */
/* -------------------------------------------------------------------------- */

let auth = null;
let onState = () => {};

const state = {
  /** Communities I am in, each with its roster count and (for admins) channels. */
  communities: [],
  /** My own channels — the ones with no community behind them. */
  personal: [],
  loaded: false,
};

function signedIn() {
  try {
    return !!(auth && auth.stateForUi().signedIn);
  } catch {
    return false;
  }
}

function stateForUi() {
  return {
    signedIn: signedIn(),
    communities: state.communities,
    personal: state.personal,
    loaded: state.loaded,
    kinds: KINDS,
  };
}

function push() {
  try {
    onState(stateForUi());
  } catch {
    /* window mid-teardown */
  }
}

/** Re-read both lists. Every mutation below ends here, so the panel is never
 *  drawing from what it hoped happened. */
async function refresh() {
  if (!signedIn()) {
    state.communities = [];
    state.personal = [];
    state.loaded = false;
    push();
    return { ok: false, signedOut: true };
  }
  const [mine, personal] = await Promise.all([
    auth.rpc('my_communities', {}),
    auth.rpc('my_discord_targets', {}),
  ]);
  if (!mine.ok) return { ok: false, error: mine.error };
  state.communities = Array.isArray(mine.body) ? mine.body : [];
  state.personal = personal.ok && Array.isArray(personal.body) ? personal.body : [];
  state.loaded = true;
  push();
  return { ok: true };
}

/**
 * One operation: call the RPC, translate a refusal, and refresh on success so
 * every path out of here leaves the panel looking at the truth.
 */
async function op(fn, args) {
  if (!signedIn()) return { ok: false, error: 'Sign in to use Discord notifications.' };
  const res = await auth.rpc(fn, args);
  if (!res.ok) {
    return {
      ok: false,
      error: res.signedOut ? 'Sign in to use Discord notifications.' : res.error,
    };
  }
  const body = res.body || {};
  if (body.ok === false) return { ok: false, error: reasonText(body.reason) };
  await refresh();
  return { ok: true, ...body };
}

/* -------------------------------------------------------------------------- */
/*  Communities                                                               */
/* -------------------------------------------------------------------------- */

const createCommunity = (name) => op('create_community', { p_name: String(name || '') });

async function joinCommunity(rawCode) {
  const code = normalizeJoinCode(rawCode);
  // Caught here rather than at the server so the message names the shape.
  if (!code) return { ok: false, error: REASON_TEXT.bad_code };
  return op('join_community', { p_code: code });
}

const leaveCommunity = (id) => op('leave_community', { p_id: String(id || '') });
const rotateCode = (id) => op('rotate_community_code', { p_id: String(id || '') });
const removeMember = (id, userId) =>
  op('remove_community_member', { p_id: String(id || ''), p_user: String(userId || '') });
const setShare = (id, share) =>
  op('set_community_share', { p_id: String(id || ''), p_share: String(share || 'all') });

/** The roster is read on demand — a member list is not worth polling. */
async function roster(id) {
  if (!signedIn()) return { ok: false, error: 'Sign in to use Discord notifications.' };
  const res = await auth.rpc('community_roster', { p_id: String(id || '') });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, members: Array.isArray(res.body) ? res.body : [] };
}

/* -------------------------------------------------------------------------- */
/*  Channels                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Save a channel. `webhook` is only sent when it has changed — an empty string
 * means "keep the one you have", which is how the panel can offer the filters
 * for editing without ever holding the secret it is editing them for.
 */
async function saveChannel(input) {
  const opts = input || {};
  const webhook = String(opts.webhook || '').trim();
  if (webhook && !isDiscordWebhook(webhook)) {
    return { ok: false, error: REASON_TEXT.not_a_discord_webhook };
  }
  if (!opts.id && !webhook) return { ok: false, error: REASON_TEXT.no_webhook };

  const kinds = Array.isArray(opts.kinds)
    ? opts.kinds.filter((k) => KINDS.some((known) => known.id === k))
    : null;

  return op('save_discord_target', {
    p_id: opts.id ? String(opts.id) : null,
    p_community: opts.communityId ? String(opts.communityId) : null,
    p_label: String(opts.label || ''),
    p_webhook: webhook || null,
    p_kinds: kinds && kinds.length ? kinds : null,
    p_watch_boards: typeof opts.watchBoards === 'boolean' ? opts.watchBoards : null,
    p_min_entries: Number.isFinite(opts.minEntries) ? Math.round(opts.minEntries) : null,
    p_daily_cap: Number.isFinite(opts.dailyCap) ? Math.round(opts.dailyCap) : null,
    p_paused: typeof opts.paused === 'boolean' ? opts.paused : null,
  });
}

const deleteChannel = (id) => op('delete_discord_target', { p_id: String(id || '') });

/**
 * Post a "connected" message straight from the app, using the URL the driver
 * has only just typed and before it is ever saved.
 *
 * Doing it here rather than through the dispatcher is the whole point: the app
 * is the last place that legitimately holds this URL in the clear, so the check
 * costs no round trip, needs no stored secret, and answers the only question
 * that matters — did something appear in the channel — in the two seconds while
 * they are still looking at Discord.
 */
async function testWebhook(url) {
  const target = String(url || '').trim();
  if (!isDiscordWebhook(target)) return { ok: false, error: REASON_TEXT.not_a_discord_webhook };

  const body = JSON.stringify({
    username: 'Apex AIO System',
    // Same rule as the dispatcher: this app never causes a ping.
    allowed_mentions: { parse: [] },
    embeds: [
      {
        color: 0x4a9d5b,
        title: '✅ Channel connected',
        description:
          'Records set by this community will appear here.\nNothing else has been posted yet.',
        footer: { text: 'Apex AIO System' },
      },
    ],
  });

  const stacks = fetchStacks();
  for (let i = 0; i < stacks.length; i++) {
    try {
      const res = await stacks[i].fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (res.ok) return { ok: true };
      if (res.status === 404) {
        return { ok: false, error: 'Discord does not know that webhook — it may have been deleted.' };
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: 'Discord refused that webhook. Copy the URL again.' };
      }
      if (res.status === 429) {
        return { ok: false, error: 'Discord is rate limiting that channel. Try again in a moment.' };
      }
      return { ok: false, error: `Discord answered ${res.status}.` };
    } catch (err) {
      // Try the next stack before blaming the network: undici does not use the
      // system proxy or the Windows certificate store, so a driver behind a
      // VPN or a TLS-inspecting antivirus fails here and succeeds on
      // Chromium's. Same reason engineer.js orders them this way.
      if (i === stacks.length - 1) return { ok: false, error: describeFetchError(err) };
    }
  }
  return { ok: false, error: 'Could not reach Discord.' };
}

/**
 * Chromium's stack first, Node's as the fallback — see the long note on
 * fetchStacks() in engineer.js for why that order is not arbitrary. Outside
 * Electron (the test scripts) require('electron') resolves to a path string,
 * hence the shape check rather than a bare try/catch.
 */
function fetchStacks() {
  const stacks = [];
  try {
    const { net } = require('electron');
    if (net && typeof net.fetch === 'function') stacks.push({ fetch: net.fetch.bind(net) });
  } catch {
    /* plain Node — the test scripts */
  }
  stacks.push({ fetch: globalThis.fetch });
  return stacks;
}

/** undici buries the real reason in `err.cause`; that is the part worth showing. */
function describeFetchError(err) {
  const parts = [];
  let e = err;
  for (let hops = 0; e && hops < 4; hops++) {
    const msg = e.message ? String(e.message) : String(e);
    if (!parts.includes(msg)) parts.push(msg);
    e = Array.isArray(e.errors) && e.errors.length ? e.errors[0] : e.cause;
  }
  return parts.join(' — ');
}

/* -------------------------------------------------------------------------- */
/*  Lifecycle                                                                 */
/* -------------------------------------------------------------------------- */

function init(opts) {
  auth = opts.auth;
  if (typeof opts.onState === 'function') onState = opts.onState;
  if (signedIn()) void refresh();
}

/** Signing out must not leave another account's communities on screen. */
function onAuthChanged() {
  if (!signedIn()) {
    state.communities = [];
    state.personal = [];
    state.loaded = false;
    push();
    return;
  }
  void refresh();
}

module.exports = {
  init,
  onAuthChanged,
  stateForUi,
  refresh,
  createCommunity,
  joinCommunity,
  leaveCommunity,
  rotateCode,
  removeMember,
  setShare,
  roster,
  saveChannel,
  deleteChannel,
  testWebhook,
  // Pure helpers, exported for scripts/test-discord.js.
  normalizeJoinCode,
  isDiscordWebhook,
  maskWebhook,
  reasonText,
  KINDS,
  DEFAULT_KINDS,
  DEFAULT_KINDS_PERSONAL,
};
