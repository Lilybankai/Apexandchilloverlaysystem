/**
 * electron/team-cloud.js — teams, invite codes, and the pit-wall relay.
 * -----------------------------------------------------------------------------
 * Phase 2 of docs/TEAM-ENGINEER-PAGE.md. Three jobs, all against the Supabase
 * RPCs from migration `team_engineer_phase2`, all through the injected auth
 * module (which owns the URL, key and token refresh — see lapUpload.js for
 * the precedent):
 *
 *   1. **Roster** — my_teams()/create/join/leave/… wrapped for IPC, with the
 *      caller's teams cached here and pushed to the panel on every change.
 *   2. **Publisher** — every PUBLISH_MS, while the driver is actually at the
 *      wheel of a live car, upsert the pruned snapshot (team-snapshot.js) to
 *      the active team's relay row. Every member publishes to their OWN row;
 *      nobody fights over a shared one. Eligibility is the SimEndurance rule
 *      in reverse: only the machine with real local tyre data is driving, so
 *      only frames carrying tyres are worth relaying.
 *      Since migration `web_pit_wall` (2026-09-07) the same call also writes
 *      the driver's OWN row (public.driver_relay), team or no team, so the
 *      web pit wall at aio.apexandchillracing.co.uk can show "My car" in a browser
 *      — the Settings ▸ Application switch (`webRelay`) turns that half off.
 *   3. **Reader** — while the Team tab is open in "Team" view, poll
 *      team_relay_read every READ_MS and hand the panel the active source:
 *      freshest row that has tyre data (the car being driven), else the
 *      freshest row full stop. The heavy blocks (learned circuit shape, race
 *      history) ride only when their revision moved — same contract as the
 *      local 1 Hz feed.
 *      The same poll also runs while this PC is watching OUR car with a
 *      teammate at the wheel (setOverlayWanted), whatever tab is open: every
 *      fresh driving row but our own goes to the overlay server, whose gate
 *      (telemetry/teammateRelay.ts) puts only the teammate in our session, in
 *      our car, on the overlays — or only the pinned one, or nobody, per the
 *      Relay source setting (resolveRelaySource). Linear THE-34.
 *
 * Pure decision helpers (eligibleToPublish, pickActiveSource, thinHistory,
 * normalizeCode) are exported for scripts/test-teamcloud.js.
 */

'use strict';

const stall = require('./stall-watch');

/** Publish cadence — Carl moved it to 1 s (2026-08-26; was 3 s at launch). */
const PUBLISH_MS = 1000;
/**
 * Stamped into every relayed payload as `v`. A second reader (the web pit
 * wall) now consumes this shape, so it has to be able to tell a payload it
 * understands from one written by a newer desktop — bump this when a field the
 * board reads changes meaning, never for additions.
 */
const RELAY_VERSION = 1;
/** Read cadence while watching. Same rhythm; worst-case staleness ~2 s. */
const READ_MS = 1000;
/**
 * Rows older than this are not handed to the overlays at all. The server
 * applies its own, slightly tighter, gate on top (teammateRelay.ts), counting
 * the time since this read as well.
 */
const OVERLAY_MAX_AGE_SEC = 6;
/** Re-send the race history at most this often — it is the one heavy block. */
const HISTORY_EVERY_MS = 60 * 1000;
/** The server refuses history over 256 KB; stay clear of the line. */
const HISTORY_MAX_BYTES = 240 * 1024;
/** After this many consecutive publish failures, sit out a few beats. */
const FAILS_BEFORE_BACKOFF = 3;
const BACKOFF_TICKS = 5;

/* -------------------------------------------------------------------------- */
/*  Pure decision helpers (tested offline)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Should this machine publish this frame? Only when it is genuinely the car
 * being driven here: a live (non-demo) frame, on track, with local tyre data —
 * tyres never exist for spectated/remote cars, so their presence IS the
 * "I am the driving PC" signal.
 */
function eligibleToPublish(frame, snapshot) {
  if (!frame || frame.connected === false) return false;
  // A frame carrying a TEAMMATE's relayed tyres is theirs, not ours: this PC
  // is spectating. Re-publishing it would echo their data back as our own.
  if (frame.player && frame.player.relayed) return false;
  if (frame.session && frame.session.onTrack === false) return false;
  // On LMU the payload's car identity (number, class, DRIVER) comes off the
  // watched row, so the watched row must be the car driven here. Otherwise a
  // PC parked in its stall with the camera on a teammate would publish its
  // own parked car's tyres under the teammate's name — exactly the identity
  // the readers' gate (teammateRelay.ts) trusts.
  if (frame.source === 'lmu' && Array.isArray(frame.standings)) {
    const focus = frame.standings.find((r) => r && r.isPlayer);
    if (!focus || focus.isOwn !== true) return false;
  }
  if (!snapshot || !snapshot.car) return false;
  const t = snapshot.car.tyres;
  if (!t || !t.frontLeft || typeof t.frontLeft.wear !== 'number') return false;
  return true;
}

/**
 * Pick the source to show from team_relay_read's rows: the freshest one whose
 * payload carries tyre data (the car being driven), else the freshest row of
 * any kind (better a stale pit-wall than a blank one). Rows arrive newest
 * first but this does not rely on that. Returns null for an empty team.
 *
 * Sticky: `prevUserId` (the row shown last time) keeps the board while it is
 * still a fresh driving row, so two teammates driving at once — one in the
 * race, one lapping a practice server (THE-34) — do not flip the board every
 * read as their ages leapfrog.
 */
function pickActiveSource(sources, prevUserId) {
  if (!Array.isArray(sources) || !sources.length) return null;
  const age = (s) => (typeof s.age_sec === 'number' ? s.age_sec : Infinity);
  const driving = sources.filter((s) => {
    const car = s && s.payload && s.payload.car;
    return !!(car && car.tyres && car.tyres.frontLeft
      && typeof car.tyres.frontLeft.wear === 'number');
  });
  if (prevUserId) {
    const prev = driving.find((s) => s.user_id === prevUserId && age(s) <= OVERLAY_MAX_AGE_SEC);
    if (prev) return prev;
  }
  const pool = driving.length ? driving : sources;
  return pool.reduce((best, s) => (age(s) < age(best) ? s : best), pool[0]);
}

/**
 * The stored Relay source setting ('auto' | 'off' | a teammate's user id)
 * resolved against the active team: a pin on somebody no longer in the team
 * falls back to auto. Returns `{ mode, pinUserId?, pinName? }` in
 * teammateRelay.ts's RelayMode terms.
 */
function resolveRelaySource(setting, team) {
  if (setting === 'off') return { mode: 'off' };
  if (typeof setting === 'string' && setting && setting !== 'auto') {
    const members = team && Array.isArray(team.members) ? team.members : [];
    const m = members.find((x) => x && x.user_id === setting);
    if (m) return { mode: 'pin', pinUserId: m.user_id, pinName: m.name || 'Teammate' };
  }
  return { mode: 'auto' };
}

/**
 * Shrink a race history under the relay's size cap by keeping every k-th lap
 * point per car (always keeping each car's latest, so current positions stay
 * exact). The charts read thinned data fine — a position line through half
 * the laps is the same line. Returns the original object when it already
 * fits, null when even 1-in-8 cannot fit (give up rather than ship junk).
 */
function thinHistory(history, maxBytes = HISTORY_MAX_BYTES) {
  if (!history) return null;
  const size = (h) => JSON.stringify(h).length;
  if (size(history) <= maxBytes) return history;
  for (const k of [2, 4, 8]) {
    const thin = {
      ...history,
      cars: (history.cars || []).map((c) => ({
        ...c,
        laps: (c.laps || []).filter((_, i, arr) => i % k === 0 || i === arr.length - 1),
      })),
      wear: (history.wear || []).filter((_, i, arr) => i % k === 0 || i === arr.length - 1),
    };
    if (size(thin) <= maxBytes) return thin;
  }
  return null;
}

/** Uppercase, trim, restore the APX- prefix people drop. '' when hopeless. */
function normalizeCode(raw) {
  let code = String(raw || '').trim().toUpperCase();
  if (/^[A-Z2-9]{6}$/.test(code)) code = `APX-${code}`;
  return /^APX-[A-Z2-9]{6}$/.test(code) ? code : '';
}

/* -------------------------------------------------------------------------- */
/*  Wiring                                                                    */
/* -------------------------------------------------------------------------- */

let auth = null;
/** () => ({ frame, snapshot, mapShape, history }) — supplied by main, which
 *  owns the status feed, the snapshot builder and the race memory. */
let collect = null;
/** Persisted settings bridge: getActiveTeam() / setActiveTeam(id) /
 *  getWebRelay() — whether the driver's own row is published for the web. */
let store = {
  getActiveTeam: () => null,
  setActiveTeam: () => {},
  getWebRelay: () => true,
  getRelaySource: () => 'auto',
  setRelaySource: () => {},
};
/** () => RelayStatus | null — the overlay server's latest gate decision. */
let getOverlayStatus = () => null;
let onTeams = () => {};
let onRelay = () => {};
/** Every fresh driving row, for the overlay server — or null to clear it. */
let onOverlayRelay = () => {};

const state = {
  teams: [],
  activeTeamId: null,
  /** 'off' | 'waiting' | 'publishing' | 'error' — for the crew header. */
  publishStatus: 'off',
  /** Where the last publish went: 'team' (team + own row), 'web' (own row
   *  only — no team selected) or null. The crew header words its status
   *  from this. */
  publishTarget: null,
  lastPublishAt: null,
  publishError: null,
  watching: false,
  /** This PC is watching our car while a teammate drives it, so the overlays want the relay. */
  overlayWanted: false,
};
/** The user id of the Team tab's last active source, for pickActiveSource. */
let lastActiveUserId = null;
/** Last relay status text pushed to the panel, so it only re-pushes on change. */
let lastRelayStatusText = '';

let publishTimer = null;
let readTimer = null;
let publishing = false;
let reading = false;
let failStreak = 0;
let backoffLeft = 0;
let lastShapeRevSent = null;
let lastHistorySentAt = 0;
let lastHistoryRevSent = null;
/** Reader-side caches of the heavy blocks, keyed by the revision inside. */
let relayShape = null;
let relayHistory = null;

function signedIn() {
  try {
    return !!(auth && auth.stateForUi().signedIn);
  } catch {
    return false;
  }
}

/** Snapshot of the cloud-team state for the renderer. */
function stateForUi() {
  return {
    signedIn: signedIn(),
    teams: state.teams,
    activeTeamId: state.activeTeamId,
    publishStatus: state.publishStatus,
    publishTarget: state.publishTarget,
    lastPublishAt: state.lastPublishAt,
    publishError: state.publishError,
    watching: state.watching,
    webRelay: webRelayOn(),
    relaySource: relaySourceSetting(),
    relaySourceEffective: currentRelaySource(),
    relayStatus: relayStatusNow(),
    // So the Relay source picker can leave "me" out of the teammate list.
    selfUserId: selfUserId(),
  };
}

function activeTeam() {
  return state.teams.find((t) => t && t.id === state.activeTeamId) || null;
}

/**
 * The stored Relay source, cached: it is consulted several times a second
 * while the relay runs, and main's loadSettings is a synchronous disk read.
 * Re-read at init and whenever main says the setting changed.
 */
let relaySourceValue = 'auto';
function loadRelaySource() {
  try {
    const v = store.getRelaySource ? store.getRelaySource() : 'auto';
    relaySourceValue = typeof v === 'string' && v ? v : 'auto';
  } catch {
    relaySourceValue = 'auto';
  }
}
function relaySourceSetting() {
  return relaySourceValue;
}

/** The setting resolved against the active team's roster. */
function currentRelaySource() {
  return resolveRelaySource(relaySourceSetting(), activeTeam());
}

/** The status line for the Relay source picker. */
function relayStatusNow() {
  const src = currentRelaySource();
  if (src.mode === 'off') {
    return { state: 'off', text: "Relay off — teammates' telemetry is never put on your overlays." };
  }
  if (!state.activeTeamId) return { state: 'idle', text: 'No active team selected.' };
  if (!state.overlayWanted) return { state: 'idle', text: 'Waiting for a teammate to drive your car.' };
  let s = null;
  try {
    s = getOverlayStatus();
  } catch {
    s = null;
  }
  return s && typeof s.text === 'string' ? s : { state: 'idle', text: 'Waiting for relay data…' };
}

/** Re-push the roster state when the status line's wording has changed. */
function refreshRelayStatus() {
  const text = relayStatusNow().text;
  if (text === lastRelayStatusText) return;
  lastRelayStatusText = text;
  pushTeams();
}

/** Main calls this after the Relay source setting changes. */
function relaySourceChanged() {
  loadRelaySource();
  if (currentRelaySource().mode === 'off') overlayRelaySafe(null);
  syncReadTimer();
  lastRelayStatusText = '';
  refreshRelayStatus();
}

function isOverlayWanted() {
  return state.overlayWanted;
}

/** The Settings ▸ Application switch: publish my own row for the browser. */
function webRelayOn() {
  try {
    return store.getWebRelay ? store.getWebRelay() !== false : true;
  } catch {
    return true;
  }
}

function pushTeams() {
  try {
    onTeams(stateForUi());
  } catch {
    /* window mid-teardown */
  }
}

/* -------------------------------------------------------------------------- */
/*  Roster                                                                    */
/* -------------------------------------------------------------------------- */

/** Re-fetch the caller's teams and reconcile the active pick. */
async function refreshTeams() {
  if (!signedIn()) {
    state.teams = [];
    pushTeams();
    return { ok: false, signedOut: true };
  }
  const res = await auth.rpc('my_teams', {});
  if (!res.ok) return { ok: false, error: res.error };
  state.teams = Array.isArray(res.body) ? res.body : [];
  // The active team must be one we are still in; otherwise fall back to the
  // only team, or to nothing.
  const ids = new Set(state.teams.map((t) => t.id));
  if (!ids.has(state.activeTeamId)) {
    state.activeTeamId = state.teams.length === 1 ? state.teams[0].id : null;
    store.setActiveTeam(state.activeTeamId);
  }
  dropDepartedPin();
  pushTeams();
  return { ok: true };
}

/**
 * A pinned Relay source whose teammate is no longer on the active team goes
 * back to Auto — persisted, so they do not silently become the pin again if
 * they rejoin. Only ever run against a roster that actually loaded: before
 * that, an empty team list would look like "everybody left".
 */
function dropDepartedPin() {
  const setting = relaySourceSetting();
  if (setting === 'auto' || setting === 'off') return;
  const team = activeTeam();
  if (!team || !Array.isArray(team.members)) return;
  if (team.members.some((m) => m && m.user_id === setting)) return;
  relaySourceValue = 'auto';
  try {
    if (store.setRelaySource) store.setRelaySource('auto');
  } catch {
    /* the effective source is Auto regardless — resolveRelaySource */
  }
}

/**
 * One team operation: call the RPC, translate refusals to friendly text, and
 * refresh the roster on success so every path out of here leaves the panel
 * looking at the truth.
 */
const REASON_TEXT = {
  name_too_short: 'Give the team a name (2–40 characters).',
  too_many_owned: 'You already own the maximum number of teams.',
  too_many_teams: 'You are in the maximum number of teams — leave one first.',
  not_found: 'No team has that code. Check it with whoever shared it.',
  team_full: 'That team already has 6 members.',
  not_owner: 'Only the team owner can do that.',
  not_member: 'You are not in that team.',
  cannot_remove_self: 'Use Leave team instead.',
};

async function op(fn, args) {
  if (!signedIn()) return { ok: false, error: 'Sign in to use teams.' };
  const res = await auth.rpc(fn, args);
  if (!res.ok) {
    return { ok: false, error: res.signedOut ? 'Sign in to use teams.' : res.error };
  }
  const body = res.body || {};
  if (body.ok === false) {
    return { ok: false, error: REASON_TEXT[body.reason] || `Refused: ${body.reason}` };
  }
  await refreshTeams();
  return { ok: true, ...body };
}

const createTeam = (name) => op('create_team', { p_name: String(name || '') });
async function joinTeam(rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, error: 'Codes look like APX-XXXXXX.' };
  const res = await op('join_team', { p_code: code });
  // Joining your first team should also select it.
  if (res.ok && res.id && !state.activeTeamId) setActiveTeam(res.id);
  return res;
}
const leaveTeam = (id) => op('leave_team', { p_team_id: String(id || '') });
const deleteTeam = (id) => op('delete_team', { p_team_id: String(id || '') });
const removeMember = (id, userId) =>
  op('remove_member', { p_team_id: String(id || ''), p_user_id: String(userId || '') });
const rotateCode = (id) => op('rotate_invite_code', { p_team_id: String(id || '') });
const renameTeam = (id, name) =>
  op('rename_team', { p_team_id: String(id || ''), p_name: String(name || '') });

function setActiveTeam(id) {
  const ids = new Set(state.teams.map((t) => t.id));
  state.activeTeamId = ids.has(id) ? id : null;
  store.setActiveTeam(state.activeTeamId);
  // A different team is a different relay: drop the caches so the next read
  // pulls that team's shape and history fresh.
  relayShape = null;
  relayHistory = null;
  lastActiveUserId = null;
  lastShapeRevSent = null;
  lastHistoryRevSent = null;
  lastHistorySentAt = 0;
  pushTeams();
  return stateForUi();
}

/* -------------------------------------------------------------------------- */
/*  Publisher                                                                 */
/* -------------------------------------------------------------------------- */

async function publishTick() {
  if (publishing) return;
  // Two reasons to publish: a team to relay to, or the web pit wall wanting
  // my own car. Neither, or signed out, and the relay is off.
  const toTeam = !!state.activeTeamId;
  const toWeb = webRelayOn();
  if (!signedIn() || (!toTeam && !toWeb)) {
    setPublishStatus('off');
    return;
  }
  if (backoffLeft > 0) {
    backoffLeft--;
    return;
  }
  const bundle = collect ? collect() : null;
  const frame = bundle && bundle.frame;
  const snapshot = bundle && bundle.snapshot;
  if (!eligibleToPublish(frame, snapshot)) {
    setPublishStatus('waiting');
    return;
  }

  const args = {
    p_payload: { ...snapshot, v: RELAY_VERSION },
    p_team_id: toTeam ? state.activeTeamId : null,
    p_driver: toWeb,
    p_map_shape: null,
    p_history: null,
  };
  const shape = bundle.mapShape;
  if (shape && shape.revision !== lastShapeRevSent) args.p_map_shape = shape;
  const history = bundle.history;
  const now = Date.now();
  if (
    history &&
    history.revision !== lastHistoryRevSent &&
    now - lastHistorySentAt >= HISTORY_EVERY_MS
  ) {
    // thinHistory stringifies the whole race history up to four times to find
    // a size that fits — the heaviest synchronous thing this module does.
    stall.mark('relay:thinHistory');
    args.p_history = thinHistory(history);
    stall.mark('idle');
    // Charge the attempt to the clock whether or not it produced anything. The
    // success path below only advances lastHistorySentAt when a history was
    // actually built, so a history too big to fit even at 1-in-8 left the
    // 60 s gate permanently open and re-ran those stringifies on EVERY 1 Hz
    // tick for the rest of the race — worst exactly when the race is longest.
    if (!args.p_history) lastHistorySentAt = now;
  }

  publishing = true;
  try {
    const res = await auth.rpc('relay_publish', args);
    if (res.ok && res.body && res.body.ok !== false) {
      failStreak = 0;
      state.lastPublishAt = Date.now();
      if (args.p_map_shape) lastShapeRevSent = shape.revision;
      if (args.p_history) {
        lastHistorySentAt = now;
        lastHistoryRevSent = history.revision;
      }
      // The server says whether the team half landed. A team we were removed
      // from mid-race must read as an error on the crew header, not as
      // "publishing" — the own-row half succeeding is not what the driver
      // cares about when they picked a team.
      if (toTeam && res.body.team === 'not_member') {
        setPublishStatus('error', 'not a member of the selected team');
      } else {
        state.publishTarget = toTeam ? 'team' : 'web';
        setPublishStatus('publishing');
      }
    } else {
      failStreak++;
      if (failStreak >= FAILS_BEFORE_BACKOFF) backoffLeft = BACKOFF_TICKS;
      const why = res.signedOut
        ? 'signed out'
        : (res.body && res.body.reason) || res.error || 'publish failed';
      setPublishStatus('error', String(why));
    }
  } catch (err) {
    failStreak++;
    if (failStreak >= FAILS_BEFORE_BACKOFF) backoffLeft = BACKOFF_TICKS;
    setPublishStatus('error', err.message);
  } finally {
    publishing = false;
  }
}

function setPublishStatus(status, error) {
  const next = error ? String(error) : null;
  if (state.publishStatus === status && state.publishError === next) return;
  state.publishStatus = status;
  state.publishError = next;
  pushTeams();
}

/* -------------------------------------------------------------------------- */
/*  Reader                                                                    */
/* -------------------------------------------------------------------------- */

function setWatching(on) {
  const want = !!on;
  if (want === state.watching) return stateForUi();
  state.watching = want;
  syncReadTimer();
  pushTeams();
  return stateForUi();
}

/**
 * The overlays' half of the reader: main turns it on while the watched car is
 * not the one driven here. Off clears the overlay server at once, so nothing
 * relayed outlives the reason for showing it.
 */
function setOverlayWanted(on) {
  const want = !!on;
  if (want === state.overlayWanted) return;
  state.overlayWanted = want;
  if (!want) overlayRelaySafe(null);
  syncReadTimer();
  refreshRelayStatus();
}

/** One timer serves both readers; it runs while either wants it. */
function syncReadTimer() {
  const want = state.watching || overlayReadWanted();
  if (want && readTimer) return;
  if (readTimer) {
    clearInterval(readTimer);
    readTimer = null;
  }
  if (want) {
    readTimer = setInterval(() => void readTick(), READ_MS);
    readTimer.unref?.();
    void readTick(); // paint now, not a tick from now
  }
}

/** The overlays want the relay, and the driver has not switched it off. */
function overlayReadWanted() {
  return state.overlayWanted && currentRelaySource().mode !== 'off';
}

/** The signed-in user's id, so their own relay row is never a source. */
function selfUserId() {
  try {
    const u = auth && auth.stateForUi().user;
    return u && u.id ? String(u.id) : null;
  } catch {
    return null;
  }
}

/**
 * The rows worth handing the overlays: fresh, carrying tyre data (a car
 * actually being driven), and not our own. Which of them is the WATCHED car —
 * same session, same car, the driver LMU has in it — is decided in the server
 * against the live frame (teammateRelay.ts), not here.
 */
function overlaySources(sources, selfId) {
  if (!Array.isArray(sources)) return [];
  return sources
    .filter((s) => {
      if (selfId && s && s.user_id === selfId) return false;
      const car = s && s.payload && s.payload.car;
      return !!(car && car.tyres && car.tyres.frontLeft
        && typeof car.tyres.frontLeft.wear === 'number'
        && typeof s.age_sec === 'number' && s.age_sec <= OVERLAY_MAX_AGE_SEC);
    })
    .map((s) => ({ userId: s.user_id, name: s.name, ageSec: s.age_sec, snapshot: s.payload }));
}

async function readTick() {
  if (reading || !(state.watching || overlayReadWanted())) return;
  // Say WHY the pit wall went quiet. A dropped session used to early-return
  // here without a word, so a relay that stopped mid-race looked identical to
  // a team that simply had nobody driving — see the refresh race fixed in
  // auth.js (2026-08-30).
  if (!signedIn()) {
    onRelaySafe({ at: Date.now(), error: 'Signed out — sign in again to see the team.', sources: [], active: null });
    return;
  }
  if (!state.activeTeamId) {
    onRelaySafe({ at: Date.now(), error: 'No active team selected.', sources: [], active: null });
    return;
  }
  reading = true;
  try {
    const res = await auth.rpc('team_relay_read', {
      p_team_id: state.activeTeamId,
      p_shape_rev: relayShape ? relayShape.revision : null,
      p_history_rev: relayHistory ? relayHistory.revision : null,
    });
    if (!res.ok || !res.body || res.body.ok === false) {
      onRelaySafe({ at: Date.now(), error: res.error || (res.body && res.body.reason) || 'read failed', sources: [], active: null });
      return;
    }
    const sources = Array.isArray(res.body.sources) ? res.body.sources : [];
    const active = pickActiveSource(sources, lastActiveUserId);
    lastActiveUserId = active ? active.user_id : null;
    // The heavy blocks arrive on whichever row carries them; cache by content.
    for (const s of sources) {
      if (s.map_shape) relayShape = s.map_shape;
      if (s.history) relayHistory = s.history;
    }
    if (overlayReadWanted()) {
      const self = selfUserId();
      const src = currentRelaySource();
      // Handed over even when empty: a pinned teammate with no fresh row is a
      // status the driver should read ("isn't sending"), not a silent blank.
      overlayRelaySafe({
        receivedAt: Date.now(),
        sources: overlaySources(sources, self),
        ...(self ? { selfUserId: self } : {}),
        ...src,
      });
    }
    refreshRelayStatus();
    if (!state.watching) return;
    onRelaySafe({
      at: Date.now(),
      sources: sources.map((s) => ({ userId: s.user_id, name: s.name, ageSec: s.age_sec })),
      active: active
        ? {
            userId: active.user_id,
            name: active.name,
            ageSec: active.age_sec,
            snapshot: active.payload,
          }
        : null,
      mapShape: relayShape,
      history: relayHistory,
    });
  } catch (err) {
    onRelaySafe({ at: Date.now(), error: err.message, sources: [], active: null });
  } finally {
    reading = false;
  }
}

function onRelaySafe(update) {
  // Error updates reach this from every failure path, so the overlay half is
  // cleared here too: a failed read must not leave a relayed block standing.
  // (The server's own age gate would drop it within seconds anyway.)
  if (update && update.error && state.overlayWanted) overlayRelaySafe(null);
  if (update && update.error) refreshRelayStatus();
  if (!state.watching) return;
  try {
    onRelay(update);
  } catch {
    /* window mid-teardown */
  }
}

function overlayRelaySafe(relay) {
  try {
    onOverlayRelay(relay);
  } catch {
    /* server mid-restart */
  }
}

/* -------------------------------------------------------------------------- */
/*  Lifecycle                                                                 */
/* -------------------------------------------------------------------------- */

/** Called when the auth session changes either way. */
function onAuthChanged() {
  if (signedIn()) {
    void refreshTeams();
  } else {
    state.teams = [];
    setWatching(false);
    overlayRelaySafe(null);
    setPublishStatus('off');
    pushTeams();
  }
}

function init(opts) {
  auth = opts.auth;
  collect = opts.collect;
  if (opts.store) store = opts.store;
  if (typeof opts.onTeams === 'function') onTeams = opts.onTeams;
  if (typeof opts.onRelay === 'function') onRelay = opts.onRelay;
  if (typeof opts.onOverlayRelay === 'function') onOverlayRelay = opts.onOverlayRelay;
  if (typeof opts.getOverlayStatus === 'function') getOverlayStatus = opts.getOverlayStatus;
  state.activeTeamId = store.getActiveTeam() || null;
  loadRelaySource();

  stop();
  publishTimer = setInterval(() => void publishTick(), PUBLISH_MS);
  publishTimer.unref?.();
  if (signedIn()) void refreshTeams();
}

function stop() {
  if (publishTimer) {
    clearInterval(publishTimer);
    publishTimer = null;
  }
  if (readTimer) {
    clearInterval(readTimer);
    readTimer = null;
  }
}

module.exports = {
  init,
  stop,
  stateForUi,
  refreshTeams,
  createTeam,
  joinTeam,
  leaveTeam,
  deleteTeam,
  removeMember,
  rotateCode,
  renameTeam,
  setActiveTeam,
  setWatching,
  setOverlayWanted,
  isOverlayWanted,
  relaySourceChanged,
  onAuthChanged,
  // Pure helpers, exported for scripts/test-teamcloud.js.
  eligibleToPublish,
  pickActiveSource,
  overlaySources,
  resolveRelaySource,
  thinHistory,
  normalizeCode,
  PUBLISH_MS,
  READ_MS,
  HISTORY_MAX_BYTES,
  RELAY_VERSION,
};
