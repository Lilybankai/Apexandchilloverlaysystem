/**
 * web-bridge.js — `window.apex` for a browser.
 * -----------------------------------------------------------------------------
 * The desktop control panel talks to its main process through the bridge that
 * preload.js builds. The web pit wall runs the SAME renderer files (auth.js,
 * team-panel.js, team-dashboard.js, team-charts.js, team-fuel.js, team-guide.js
 * — copied verbatim by scripts/build-web.js) against this file instead, which
 * implements the slice of that bridge those files call:
 *
 *   • `apex.auth.*` / `apex.billing.*` / `apex.legal.*` — the account screens.
 *     A straight port of electron/auth.js and electron/billing.js: GoTrue over
 *     REST, one shared token refresh, the same error wording. The refresh
 *     token lives in localStorage ("Remember me") or sessionStorage, which is
 *     the browser's version of the desktop's session.json.
 *   • `apex.team*` — the pit wall's data. Where the desktop reads its own car
 *     from shared memory and a teammate's from the relay, a browser has no
 *     local telemetry, so BOTH sources are relays: "My car" polls
 *     driver_relay_read (my own desktop's row, migration web_pit_wall) and
 *     "Team" polls team_relay_read exactly as electron/team-cloud.js does.
 *     Same 1 Hz cadence, same revision-gated shape/history, same
 *     pickActiveSource rule.
 *
 * Nothing here is a framework and nothing loads from a CDN: the page's CSP is
 * `script-src 'self'`, matching the desktop, and the Supabase publishable key
 * is designed to ship in clients — Row Level Security and the SECURITY DEFINER
 * RPCs are the boundary, not this file.
 *
 * `?demo=1` swaps the network for web/dev/demo.json (built by
 * scripts/make-web-demo.js) so the board can be looked at without a sim, an
 * account or a relay — the screenshot route for layout work.
 */

(function () {
  'use strict';

  const SUPABASE_URL = 'https://svtyxuhbsbbodsecbnsc.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_Q-0gsoTW_r-AzgKQ6NqNSQ_vGegMK8w';

  /** Refresh the access token this long before it actually expires. */
  const REFRESH_SKEW_SEC = 60;
  /** Relay read cadence while the tab is visible — the desktop's READ_MS. */
  const READ_MS = 1000;
  /** …and while it is in the background: a hidden tab does not need 1 Hz. */
  const HIDDEN_READ_MS = 5000;
  /** A relay row this old is a driver who stopped, not a live feed. */
  const LIVE_SEC = 5;

  const SESSION_KEY = 'apex.web.session';
  const PREFS_KEY = 'apex.web.prefs';

  const query = new URLSearchParams(location.search);
  const DEMO = query.get('demo') === '1';

  /* ------------------------------------------------------------------------ */
  /*  Small helpers                                                           */
  /* ------------------------------------------------------------------------ */

  const store = (persist) => (persist ? localStorage : sessionStorage);

  function readJson(storage, key) {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeJson(storage, key, value) {
    try {
      if (value === null || value === undefined) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage disabled — the value simply does not persist */
    }
  }

  /** Listener lists, one per push channel the renderer subscribes to. */
  const channels = new Map();
  function on(name) {
    return (cb) => {
      if (!channels.has(name)) channels.set(name, new Set());
      channels.get(name).add(cb);
      return () => channels.get(name).delete(cb);
    };
  }
  function emit(name, payload) {
    const set = channels.get(name);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`[bridge] ${name} listener threw`, err);
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Preferences (the few Settings the board reads)                          */
  /* ------------------------------------------------------------------------ */

  const prefs = Object.assign(
    { tempUnit: 'c', activeTeamId: null, lastEmail: '' },
    readJson(localStorage, PREFS_KEY) || {},
  );
  const savePrefs = () => writeJson(localStorage, PREFS_KEY, prefs);

  const settingsForUi = () => ({ tempUnit: prefs.tempUnit === 'f' ? 'f' : 'c', webRelay: true });

  /* ------------------------------------------------------------------------ */
  /*  Session (port of electron/auth.js)                                      */
  /* ------------------------------------------------------------------------ */

  let session = null;
  let refreshInFlight = null;

  function readStoredSession() {
    for (const [storage, persist] of [[localStorage, true], [sessionStorage, false]]) {
      const raw = readJson(storage, SESSION_KEY);
      if (raw && typeof raw.refresh_token === 'string' && raw.refresh_token) {
        return { ...raw, persist };
      }
    }
    return null;
  }

  function writeStoredSession() {
    if (session) {
      writeJson(store(session.persist), SESSION_KEY, session);
      writeJson(store(!session.persist), SESSION_KEY, null);
    } else {
      writeJson(localStorage, SESSION_KEY, null);
      writeJson(sessionStorage, SESSION_KEY, null);
    }
  }

  function adoptSession(tokens, persist) {
    const expiresAt =
      Number(tokens.expires_at) ||
      Math.floor(Date.now() / 1000) + (Number(tokens.expires_in) || 3600);
    session = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt,
      user: tokens.user || (session && session.user) || null,
      persist: persist === undefined ? !!(session && session.persist) : !!persist,
    };
    writeStoredSession();
    emit('auth', authState());
    return session;
  }

  function clearSession() {
    session = null;
    writeStoredSession();
    emit('auth', authState());
  }

  function errorMessage(body, res) {
    const raw =
      (body && (body.error_description || body.msg || body.message || body.error)) || '';
    const text = String(raw).trim();
    if (!text) return `Sign-in service error (HTTP ${res.status}).`;
    if (/invalid login credentials/i.test(text)) return 'That email and password don’t match.';
    if (/email not confirmed/i.test(text)) {
      return 'Your email isn’t confirmed yet — check your inbox for the confirmation link.';
    }
    if (/user already registered|already been registered/i.test(text)) {
      return 'There’s already an account with that email. Try signing in instead.';
    }
    if (/token has expired|expired.*token|invalid.*token|email link is invalid/i.test(text)) {
      return 'That reset code has expired or isn’t valid. Request a new one.';
    }
    if (/for security purposes|rate limit|too many/i.test(text)) {
      return 'Too many attempts — wait a minute and try again.';
    }
    return text;
  }

  function timeoutSignal(ms) {
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), ms);
    return ctl.signal;
  }

  /** One REST call. `{ ok, status, body }`; never throws for HTTP errors. */
  async function api(pathname, { method = 'POST', body, token, headers, timeoutMs } = {}) {
    let res;
    try {
      res = await fetch(`${SUPABASE_URL}${pathname}`, {
        method,
        headers: {
          apikey: SUPABASE_KEY,
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeoutSignal(timeoutMs || 20000),
      });
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return {
        ok: false,
        status: 0,
        error: timedOut
          ? 'The account service didn’t respond. Check your connection and try again.'
          : 'Can’t reach the account service — you appear to be offline.',
      };
    }
    let parsed = null;
    const text = await res.text();
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!res.ok) return { ok: false, status: res.status, error: errorMessage(parsed, res) };
    return { ok: true, status: res.status, body: parsed || {} };
  }

  function publicUser(user) {
    if (!user) return null;
    const meta = user.user_metadata || {};
    const name = (meta.display_name || '').trim() || (user.email || '').split('@')[0] || 'Driver';
    const initials =
      name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'A';
    return {
      id: user.id,
      email: user.email || '',
      displayName: name,
      initials,
      primarySim: meta.primary_sim || '',
      marketingOptIn: !!meta.marketing_opt_in,
      emailConfirmed: !!(user.email_confirmed_at || user.confirmed_at),
    };
  }

  function authState() {
    if (DEMO) {
      return {
        signedIn: true,
        configured: true,
        primarySims: ['rFactor 2 / LMU'],
        lastEmail: '',
        user: { id: 'demo', email: 'driver@example.com', displayName: 'Demo Driver', initials: 'DD', emailConfirmed: true },
      };
    }
    return {
      signedIn: !!(session && session.access_token),
      user: publicUser(session && session.user),
      configured: true,
      primarySims: ['rFactor 2 / LMU'],
      lastEmail: prefs.lastEmail || '',
    };
  }

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const MIN_PASSWORD = 8;
  const badEmail = (email) =>
    typeof email !== 'string' || !EMAIL_RE.test(email.trim()) ? 'Enter a valid email address.' : null;
  const badPassword = (pw) =>
    typeof pw !== 'string' || pw.length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters.` : null;

  async function accessToken() {
    if (!session || !session.refresh_token) return null;
    const now = Math.floor(Date.now() / 1000);
    if (session.access_token && session.expires_at - REFRESH_SKEW_SEC > now) {
      return session.access_token;
    }
    // One refresh at a time: Supabase rotates the refresh token on use, so two
    // pollers refreshing together would sign the driver out (see auth.js).
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        const res = await api('/auth/v1/token?grant_type=refresh_token', {
          body: { refresh_token: session.refresh_token },
        });
        if (!res.ok) {
          if (res.status >= 400 && res.status < 500) clearSession();
          return null;
        }
        adoptSession(res.body);
        return session ? session.access_token : null;
      })().finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  async function rpc(fn, body) {
    const token = await accessToken();
    if (!token) return { ok: false, signedOut: true, error: 'Not signed in.' };
    const res = await api(`/rest/v1/rpc/${fn}`, { body: body || {}, token });
    if (!res.ok && res.status === 401) return { ...res, signedOut: true };
    return res;
  }

  async function functionsInvoke(fn, body) {
    const token = await accessToken();
    if (!token) return { ok: false, signedOut: true, error: 'Not signed in.' };
    const res = await api(`/functions/v1/${fn}`, { body: body || {}, token });
    if (!res.ok && res.status === 401) return { ...res, signedOut: true };
    return res;
  }

  async function signIn({ email, password, remember } = {}) {
    const emailErr = badEmail(email);
    if (emailErr) return { ok: false, error: emailErr, field: 'email' };
    if (!password) return { ok: false, error: 'Enter your password.', field: 'password' };
    const res = await api('/auth/v1/token?grant_type=password', {
      body: { email: String(email).trim(), password },
    });
    if (!res.ok) return { ok: false, error: res.error };
    prefs.lastEmail = String(email).trim();
    savePrefs();
    adoptSession(res.body, remember !== false);
    return { ok: true, state: authState() };
  }

  async function register({ email, password, displayName, marketingOptIn } = {}) {
    const emailErr = badEmail(email);
    if (emailErr) return { ok: false, error: emailErr, field: 'email' };
    const pwErr = badPassword(password);
    if (pwErr) return { ok: false, error: pwErr, field: 'password' };
    if (!displayName || !String(displayName).trim()) {
      return { ok: false, error: 'Choose a display name.', field: 'displayName' };
    }
    const res = await api('/auth/v1/signup', {
      body: {
        email: String(email).trim(),
        password,
        data: {
          display_name: String(displayName).trim().slice(0, 60),
          primary_sim: 'rFactor 2 / LMU',
          marketing_opt_in: !!marketingOptIn,
        },
      },
    });
    if (!res.ok) return { ok: false, error: res.error };
    if (res.body && res.body.access_token) {
      prefs.lastEmail = String(email).trim();
      savePrefs();
      adoptSession(res.body, true);
      return { ok: true, needsConfirmation: false, state: authState() };
    }
    return { ok: true, needsConfirmation: true, email: String(email).trim(), state: authState() };
  }

  async function resendConfirmation({ email } = {}) {
    const emailErr = badEmail(email);
    if (emailErr) return { ok: false, error: emailErr, field: 'email' };
    const res = await api('/auth/v1/resend', { body: { type: 'signup', email: String(email).trim() } });
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }

  async function requestReset({ email } = {}) {
    const emailErr = badEmail(email);
    if (emailErr) return { ok: false, error: emailErr, field: 'email' };
    const res = await api('/auth/v1/recover', { body: { email: String(email).trim() } });
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }

  function parseRecoveryToken(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    if (/[?&#]/.test(raw) || raw.includes('://')) {
      const hash = /[?&#]token_hash=([^&#\s]+)/.exec(raw);
      if (hash) return { kind: 'hash', value: decodeURIComponent(hash[1]) };
      const tok = /[?&#]token=([^&#\s]+)/.exec(raw);
      if (tok) return { kind: 'hash', value: decodeURIComponent(tok[1]) };
      if (/[?&#]code=/.test(raw)) return { kind: 'pkce', value: '' };
      return null;
    }
    if (/^[A-Za-z0-9-]{6,}$/.test(raw)) return { kind: 'otp', value: raw };
    return null;
  }

  async function verifyRecovery(email, parsed) {
    if (parsed.kind === 'pkce') {
      return { ok: false, error: 'That link is not usable here. Ask for a new code and paste the code itself.' };
    }
    const asHash = { type: 'recovery', token_hash: parsed.value };
    const asOtp = { type: 'recovery', email, token: parsed.value };
    const order = parsed.kind === 'hash' ? [asHash, asOtp] : [asOtp, asHash];
    let last = null;
    for (const body of order) {
      last = await api('/auth/v1/verify', { body });
      if (last.ok) return last;
      if (last.status === 0 || last.status >= 500) return last;
    }
    return last;
  }

  async function resetPassword({ email, token, password } = {}) {
    const emailErr = badEmail(email);
    if (emailErr) return { ok: false, error: emailErr, field: 'email' };
    const parsed = parseRecoveryToken(token);
    if (!parsed) {
      return { ok: false, error: 'Paste the code (or the whole reset link) from the email.', field: 'token' };
    }
    const pwErr = badPassword(password);
    if (pwErr) return { ok: false, error: pwErr, field: 'password' };
    const verified = await verifyRecovery(String(email).trim(), parsed);
    if (!verified.ok) return { ok: false, error: verified.error, field: 'token' };
    const tokens = verified.body;
    const updated = await api('/auth/v1/user', { method: 'PUT', token: tokens.access_token, body: { password } });
    if (!updated.ok) return { ok: false, error: updated.error, field: 'password' };
    await api('/auth/v1/logout', { token: tokens.access_token }).catch(() => {});
    return { ok: true, email: String(email).trim() };
  }

  async function signOut() {
    const token = session && session.access_token;
    stopOwn();
    stopRelay();
    clearSession();
    if (token) await api('/auth/v1/logout', { token }).catch(() => {});
    return { ok: true, state: authState() };
  }

  /** Turn a remembered refresh token into a live session and a fresh user. */
  async function restore() {
    if (DEMO || !session) return authState();
    const token = await accessToken();
    if (!token) return authState();
    const res = await api('/auth/v1/user', { method: 'GET', token });
    if (res.ok && res.body && res.body.id) {
      session.user = res.body;
      writeStoredSession();
      emit('auth', authState());
    }
    return authState();
  }

  /* ------------------------------------------------------------------------ */
  /*  Entitlement + billing (port of electron/billing.js)                     */
  /* ------------------------------------------------------------------------ */

  async function billingStatus() {
    if (DEMO) return { entitled: true, source: 'free', freeReason: 'league', hasCustomer: false, status: 'none' };
    const res = await rpc('entitlement_status', {});
    if (!res.ok) return { entitled: false, source: null, error: res.error, signedOut: !!res.signedOut, unknown: true };
    const b = res.body || {};
    return { ...b, entitled: !!b.entitled };
  }

  /** Where the account screens hand over to the board. */
  const BOARD_PAGE = 'board.html';
  const AUTH_PAGE = 'index.html';

  async function enterApp() {
    const b = await billingStatus();
    if (b.entitled) {
      location.replace(BOARD_PAGE);
      return { ...authState(), ok: true, entitled: true, billing: b };
    }
    return { ...authState(), ok: true, entitled: false, billing: b.unknown ? null : b };
  }

  async function checkout() {
    const res = await functionsInvoke('create-checkout-session', {});
    if (!res.ok) return { ok: false, error: res.signedOut ? 'Sign in first.' : res.error || 'Could not start checkout.' };
    const body = res.body || {};
    if (body.alreadySubscribed) return { ok: true, alreadySubscribed: true };
    if (!body.url) return { ok: false, error: 'Checkout did not answer with a payment page.' };
    location.href = body.url;
    return { ok: true };
  }

  async function portal() {
    const res = await functionsInvoke('create-portal-session', {});
    if (!res.ok) return { ok: false, error: res.signedOut ? 'Sign in first.' : res.error || 'Could not open the billing page.' };
    const body = res.body || {};
    if (!body.url) return { ok: false, error: 'The billing page did not answer.' };
    location.href = body.url;
    return { ok: true };
  }

  async function redeemCode(code) {
    const text = typeof code === 'string' ? code.trim() : '';
    if (!text) return { ok: false, error: 'Type the code first.' };
    const res = await rpc('redeem_league_code', { p_code: text.slice(0, 40) });
    if (!res.ok) return { ok: false, error: res.signedOut ? 'Sign in first.' : res.error || 'Could not check that code.' };
    const body = res.body || {};
    if (!body.ok) return { ok: false, error: body.error || 'That code was not accepted.' };
    return { ok: true };
  }

  /* ------------------------------------------------------------------------ */
  /*  Teams + the two relays (port of electron/team-cloud.js)                 */
  /* ------------------------------------------------------------------------ */

  const team = {
    teams: [],
    activeTeamId: prefs.activeTeamId || null,
    watching: false,
    subscribed: false,
    /** "My car": my own desktop's row. */
    own: null,        // the latest snapshot handed to the panel (or null)
    ownAgeSec: null,  // server-reported age of that row at the last read
    ownShape: null,
    ownHistory: null,
    /** "Team": the relay caches, keyed by the revision inside. */
    relayShape: null,
    relayHistory: null,
    lastRelay: null,
    /** Last derived publish status, so the crew header only re-renders on change. */
    publishStatus: 'off',
  };

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

  const signedIn = () => authState().signedIn;

  /**
   * What the crew header shows as the relay status. The browser publishes
   * nothing itself; what it can honestly report is whether MY desktop's row
   * is fresh — the same fact the desktop reports as "publishing".
   */
  function publishStatus() {
    if (team.ownAgeSec === null) return 'off';
    return team.ownAgeSec <= LIVE_SEC ? 'publishing' : 'off';
  }

  function cloudState() {
    return {
      signedIn: signedIn(),
      teams: team.teams,
      activeTeamId: team.activeTeamId,
      publishStatus: publishStatus(),
      publishTarget: team.activeTeamId ? 'team' : 'web',
      lastPublishAt: null,
      publishError: null,
      watching: team.watching,
      webRelay: true,
    };
  }

  const pushTeams = () => emit('team:cloud', cloudState());

  async function refreshTeams() {
    if (DEMO) {
      team.teams = demoTeams();
      if (!team.activeTeamId) team.activeTeamId = team.teams[0].id;
      pushTeams();
      return { ok: true };
    }
    if (!signedIn()) {
      team.teams = [];
      pushTeams();
      return { ok: false, signedOut: true };
    }
    const res = await rpc('my_teams', {});
    if (!res.ok) return { ok: false, error: res.error };
    team.teams = Array.isArray(res.body) ? res.body : [];
    const ids = new Set(team.teams.map((t) => t.id));
    if (!ids.has(team.activeTeamId)) {
      team.activeTeamId = team.teams.length === 1 ? team.teams[0].id : null;
      prefs.activeTeamId = team.activeTeamId;
      savePrefs();
    }
    pushTeams();
    return { ok: true };
  }

  async function op(fn, args) {
    if (DEMO) return { ok: false, error: 'Team changes are off in the demo.' };
    if (!signedIn()) return { ok: false, error: 'Sign in to use teams.' };
    const res = await rpc(fn, args);
    if (!res.ok) return { ok: false, error: res.signedOut ? 'Sign in to use teams.' : res.error };
    const body = res.body || {};
    if (body.ok === false) return { ok: false, error: REASON_TEXT[body.reason] || `Refused: ${body.reason}` };
    await refreshTeams();
    return { ok: true, ...body };
  }

  function normalizeCode(raw) {
    let code = String(raw || '').trim().toUpperCase();
    if (/^[A-Z2-9]{6}$/.test(code)) code = `APX-${code}`;
    return /^APX-[A-Z2-9]{6}$/.test(code) ? code : '';
  }

  function setActiveTeam(id) {
    const ids = new Set(team.teams.map((t) => t.id));
    team.activeTeamId = ids.has(id) ? id : null;
    prefs.activeTeamId = team.activeTeamId;
    savePrefs();
    team.relayShape = null;
    team.relayHistory = null;
    pushTeams();
    // A different team is a different relay: read it now, not a tick from now.
    if (team.watching) kick(relayLoop);
    return cloudState();
  }

  function pickActiveSource(sources) {
    if (!Array.isArray(sources) || !sources.length) return null;
    const age = (s) => (typeof s.age_sec === 'number' ? s.age_sec : Infinity);
    const driving = sources.filter((s) => {
      const car = s && s.payload && s.payload.car;
      return !!(car && car.tyres && car.tyres.frontLeft && typeof car.tyres.frontLeft.wear === 'number');
    });
    const pool = driving.length ? driving : sources;
    return pool.reduce((best, s) => (age(s) < age(best) ? s : best), pool[0]);
  }

  /* ---- polling loops ----------------------------------------------------- */

  /**
   * A loop is a setTimeout chain with one in-flight guard. Two of them: my own
   * row while the board is open, the team relay while it is in Team view. A
   * hidden tab polls five times slower; coming back kicks both immediately.
   */
  function makeLoop(name, tick) {
    const loop = { name, timer: 0, running: false, busy: false };
    loop.schedule = (ms) => {
      clearTimeout(loop.timer);
      if (!loop.running) return;
      loop.timer = setTimeout(loop.run, ms);
    };
    loop.run = async () => {
      if (!loop.running || loop.busy) return;
      loop.busy = true;
      try {
        await tick();
      } catch (err) {
        console.error(`[bridge] ${name} tick failed`, err);
      } finally {
        loop.busy = false;
        loop.schedule(document.hidden ? HIDDEN_READ_MS : READ_MS);
      }
    };
    return loop;
  }

  function start(loop) {
    if (loop.running) return;
    loop.running = true;
    void loop.run();
  }
  function stop(loop) {
    loop.running = false;
    clearTimeout(loop.timer);
    loop.timer = 0;
  }
  function kick(loop) {
    if (loop.running && !loop.busy) {
      clearTimeout(loop.timer);
      void loop.run();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      kick(ownLoop);
      kick(relayLoop);
    }
  });

  /** Attach the cached heavy blocks the way the desktop's pusher does. */
  function withExtras(payload, shape, history) {
    const snap = { ...payload };
    if (history) snap.history = history;
    if (shape) snap.mapShape = shape;
    return snap;
  }

  function setPublishStatusIfChanged() {
    const next = publishStatus();
    if (next !== team.publishStatus) {
      team.publishStatus = next;
      pushTeams();
    }
  }

  async function ownTick() {
    if (DEMO) {
      const d = await demoData();
      if (!d) return;
      team.own = withExtras({ ...d.snapshot, at: Date.now(), connected: true }, d.mapShape, d.history);
      team.ownAgeSec = 0;
      emit('team:update', team.own);
      setPublishStatusIfChanged();
      return;
    }
    if (!signedIn()) return;
    const res = await rpc('driver_relay_read', {
      p_shape_rev: team.ownShape ? team.ownShape.revision : null,
      p_history_rev: team.ownHistory ? team.ownHistory.revision : null,
    });
    // A failed read keeps the last snapshot on screen: the age pill goes STALE
    // on its own, which is the honest picture. Only a successful read that
    // finds no row (driver stopped >2 min ago) blanks the board.
    if (!res.ok || !res.body || res.body.ok === false) return;
    const src = res.body.source;
    if (!src) {
      if (team.own) {
        team.own = null;
        emit('team:update', null);
      }
      team.ownAgeSec = null;
      setPublishStatusIfChanged();
      return;
    }
    if (src.map_shape) team.ownShape = src.map_shape;
    if (src.history) team.ownHistory = src.history;
    team.ownAgeSec = typeof src.age_sec === 'number' ? src.age_sec : 0;
    // `at` is what the age pill reads. Rebase it on the server's own age so
    // the desktop's clock and this device's clock never disagree about
    // freshness — a tablet five minutes fast would otherwise read LIVE forever.
    const at = Date.now() - Math.max(0, team.ownAgeSec) * 1000;
    team.own = withExtras({ ...src.payload, at }, team.ownShape, team.ownHistory);
    emit('team:update', team.own);
    setPublishStatusIfChanged();
  }

  async function relayTick() {
    const fail = (error) =>
      emit('team:relay', (team.lastRelay = { at: Date.now(), error, sources: [], active: null }));
    if (DEMO) {
      const d = await demoData();
      if (!d) return;
      const me = authState().user;
      emit('team:relay', (team.lastRelay = {
        at: Date.now(),
        sources: [{ userId: me.id, name: me.displayName, ageSec: 1 }, { userId: 'demo2', name: 'Sam Rivers', ageSec: 900 }],
        active: { userId: me.id, name: me.displayName, ageSec: 1, snapshot: { ...d.snapshot, at: Date.now(), connected: true } },
        mapShape: d.mapShape,
        history: d.history,
      }));
      return;
    }
    if (!signedIn()) return fail('Signed out — sign in again to see the team.');
    if (!team.activeTeamId) return fail('No active team selected.');
    const res = await rpc('team_relay_read', {
      p_team_id: team.activeTeamId,
      p_shape_rev: team.relayShape ? team.relayShape.revision : null,
      p_history_rev: team.relayHistory ? team.relayHistory.revision : null,
    });
    if (!res.ok || !res.body || res.body.ok === false) {
      return fail(res.error || (res.body && res.body.reason) || 'read failed');
    }
    const sources = Array.isArray(res.body.sources) ? res.body.sources : [];
    const active = pickActiveSource(sources);
    for (const s of sources) {
      if (s.map_shape) team.relayShape = s.map_shape;
      if (s.history) team.relayHistory = s.history;
    }
    emit('team:relay', (team.lastRelay = {
      at: Date.now(),
      sources: sources.map((s) => ({ userId: s.user_id, name: s.name, ageSec: s.age_sec })),
      active: active
        ? { userId: active.user_id, name: active.name, ageSec: active.age_sec, snapshot: active.payload }
        : null,
      mapShape: team.relayShape,
      history: team.relayHistory,
    }));
  }

  const ownLoop = makeLoop('own', ownTick);
  const relayLoop = makeLoop('relay', relayTick);

  function stopOwn() {
    team.subscribed = false;
    stop(ownLoop);
  }
  function stopRelay() {
    team.watching = false;
    stop(relayLoop);
  }

  /* ---- demo ---------------------------------------------------------------- */

  let demoPromise = null;
  function demoData() {
    if (!demoPromise) {
      demoPromise = fetch('dev/demo.json', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    }
    return demoPromise;
  }

  function demoTeams() {
    const me = authState().user;
    return [{
      id: 'demo-team',
      name: 'Apex Demo Team',
      invite_code: 'APX-DEMO77',
      role: 'owner',
      members: [
        { user_id: me.id, name: me.displayName, role: 'owner', joined_at: '2026-08-25T10:00:00Z' },
        { user_id: 'demo2', name: 'Sam Rivers', role: 'member', joined_at: '2026-08-25T10:05:00Z' },
        { user_id: 'demo3', name: 'Priya Nair', role: 'member', joined_at: '2026-08-26T18:30:00Z' },
      ],
    }];
  }

  /* ------------------------------------------------------------------------ */
  /*  The bridge                                                              */
  /* ------------------------------------------------------------------------ */

  session = DEMO ? null : readStoredSession();

  window.apex = {
    // Settings — only what the board reads (the temperature unit).
    getState: () => Promise.resolve({ settings: settingsForUi() }),
    updateSettings: (partial) => {
      if (partial && (partial.tempUnit === 'c' || partial.tempUnit === 'f')) {
        prefs.tempUnit = partial.tempUnit;
        savePrefs();
        emit('settings', settingsForUi());
      }
      return Promise.resolve({ settings: settingsForUi() });
    },
    onSettings: on('settings'),
    openInBrowser: (url) => {
      window.open(url, '_blank', 'noopener');
      return Promise.resolve(true);
    },
    copy: (text) => navigator.clipboard.writeText(String(text)).then(() => true, () => false),

    // My car.
    teamSubscribe: () => {
      team.subscribed = true;
      start(ownLoop);
      return Promise.resolve(team.own);
    },
    teamUnsubscribe: () => {
      stopOwn();
      return Promise.resolve();
    },
    onTeamUpdate: on('team:update'),

    // Teams.
    teamCloudState: () => Promise.resolve(cloudState()),
    teamRefresh: () => refreshTeams().then(() => cloudState()),
    teamCreate: (name) => op('create_team', { p_name: String(name || '') }),
    teamJoin: async (raw) => {
      const code = normalizeCode(raw);
      if (!code) return { ok: false, error: 'Codes look like APX-XXXXXX.' };
      const res = await op('join_team', { p_code: code });
      if (res.ok && res.id && !team.activeTeamId) setActiveTeam(res.id);
      return res;
    },
    teamLeave: (id) => op('leave_team', { p_team_id: String(id || '') }),
    teamDelete: (id) => op('delete_team', { p_team_id: String(id || '') }),
    teamRemoveMember: (id, userId) =>
      op('remove_member', { p_team_id: String(id || ''), p_user_id: String(userId || '') }),
    teamRotateCode: (id) => op('rotate_invite_code', { p_team_id: String(id || '') }),
    teamRename: (id, name) => op('rename_team', { p_team_id: String(id || ''), p_name: String(name || '') }),
    teamSetActive: (id) => Promise.resolve(setActiveTeam(id)),
    teamWatch: (onOff) => {
      const want = !!onOff;
      if (want !== team.watching) {
        team.watching = want;
        if (want) start(relayLoop);
        else stop(relayLoop);
        pushTeams();
      }
      return Promise.resolve(cloudState());
    },
    onTeamCloud: on('team:cloud'),
    onTeamRelay: on('team:relay'),

    // Account.
    auth: {
      getState: () => Promise.resolve(authState()),
      restore,
      signIn,
      register,
      resendConfirmation,
      requestReset,
      resetPassword,
      signOut,
      enterApp,
      showAuth: () => {
        location.replace(AUTH_PAGE);
        return Promise.resolve({ ok: true });
      },
      onChange: on('auth'),
    },
    billing: {
      status: billingStatus,
      checkout,
      portal,
      redeemCode,
      onChange: on('billing'),
    },
    legal: {
      open: (kind) => {
        window.open(`legal.html#${kind === 'privacy' ? 'privacy' : 'terms'}`, '_blank', 'noopener');
        return Promise.resolve({ ok: true });
      },
    },
  };

  /** Extras the web shell uses that the desktop renderer never needs. */
  window.APEX_WEB = {
    DEMO,
    READ_MS,
    BOARD_PAGE,
    AUTH_PAGE,
    refreshTeams,
    parseRecoveryToken, // exposed for the offline test
    pickActiveSource,
    normalizeCode,
  };
})();
