/**
 * electron/preload.js — safe bridge between the control panel and main process.
 * -----------------------------------------------------------------------------
 * Runs with context isolation, so the renderer (control-panel/) gets ONLY the
 * small `window.apex` API defined here — no direct Node/Electron access. Every
 * method maps to an IPC handler in main.js.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apex', {
  /** Full initial state: settings, overlay catalog (with URLs), status. */
  getState: () => ipcRenderer.invoke('app:getState'),

  /** Persist a partial settings change; returns the fresh state. */
  updateSettings: (partial) => ipcRenderer.invoke('settings:update', partial),

  /** Start the telemetry server. */
  startServer: () => ipcRenderer.invoke('server:start'),

  /** Stop the telemetry server. */
  stopServer: () => ipcRenderer.invoke('server:stop'),

  /** Copy text (an overlay URL) to the clipboard. */
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),

  /** Open an overlay URL in the default browser (for previewing). */
  openInBrowser: (url) => ipcRenderer.invoke('overlay:openInBrowser', url),

  /* ---- Sponsor logos ---- */

  /** Filenames of the installed sponsor logos, in rotation order. */
  sponsorsList: () => ipcRenderer.invoke('sponsors:list'),
  /** Open a file picker and copy the chosen images in; returns the new list. */
  sponsorsAdd: () => ipcRenderer.invoke('sponsors:add'),
  /** Delete one logo by filename; returns the new list. */
  sponsorsRemove: (name) => ipcRenderer.invoke('sponsors:remove', name),

  /* ---- Bindable actions ---- */

  /** Every bindable action with its current keyboard binding. */
  actionsList: () => ipcRenderer.invoke('actions:list'),
  /** Bind one action to an accelerator; '' clears it. Returns {ok, error?}. */
  actionBind: (actionId, accelerator) => ipcRenderer.invoke('actions:bind', actionId, accelerator),
  /** Trigger an action now (the per-row Test button). `dir` is ±1 for deltas. */
  actionRun: (actionId, dir) => ipcRenderer.invoke('actions:run', actionId, dir),

  /* ---- LMU's own controls file ---- */

  /** What the overlay would bind in LMU, and what is already bound. */
  lmuBindPlan: () => ipcRenderer.invoke('lmuBind:plan'),
  /** Write the missing bindings. Refuses while LMU is running. */
  lmuBindApply: () => ipcRenderer.invoke('lmuBind:apply'),
  /** Put the newest backup of LMU's controls file back. */
  lmuBindRestore: () => ipcRenderer.invoke('lmuBind:restore'),

  /* ---- Wheel / controller bindings ---- */

  /** Attached controllers + whether background reading works on this host. */
  wheelDevices: () => ipcRenderer.invoke('wheel:devices'),
  /** Wait for the next wheel button press (for binding capture). */
  wheelCapture: () => ipcRenderer.invoke('wheel:capture'),
  /** Bind one direction of an action to a wheel button; null binding clears. */
  wheelBind: (actionId, dir, binding) => ipcRenderer.invoke('wheel:bind', actionId, dir, binding),

  /* ---- In-game overlay layer ---- */

  /** Unlock the in-game layer for on-screen drag/resize editing. */
  ingameEditStart: () => ipcRenderer.invoke('ingame:editStart'),
  /** Re-lock the in-game layer (click-through again). */
  ingameEditStop: () => ipcRenderer.invoke('ingame:editStop'),
  /** Reset every in-game widget to its default position. */
  ingameLayoutReset: () => ipcRenderer.invoke('ingame:layoutReset'),

  /* ---- Lap database ---- */

  /**
   * Rolling 7-day driving summary read from the local lap files:
   * `{ laps, cleanLaps, distanceM, drivingMs, tracks, bests[], days[] }`.
   *
   * Local-only for now — no account needed and no network involved, so it works
   * offline and before the driver has ever signed in.
   */
  lapsWeek: () => ipcRenderer.invoke('laps:week'),

  /**
   * Your best clean laps scored against the class reference:
   * `{ rows[], best, credit, sheetUpdated }`.
   *
   * `credit` is Ohne Speed's attribution for the reference times, and it comes
   * down with the data on purpose — the panel cannot show a score without it.
   */
  lapsPace: () => ipcRenderer.invoke('laps:pace'),

  /**
   * Score laps the renderer already holds: `[{ track, trackLengthM, carClass,
   * car, lapMs, trackConfig?, simTrackName? }]` → the same rows `lapsPace()`
   * returns, in the same order.
   *
   * For the two lists `lapsPace()` cannot answer for — the Dashboard's laps
   * from THIS WEEK (it reads all-time bests) and another driver's lap clicked
   * on a league board (not a local lap at all).
   */
  lapsScore: (laps) => ipcRenderer.invoke('laps:score', laps),

  /* ---- Setup editor ----
   *
   * The Setups tab's line to the car. Each call is one fresh read or write
   * against LMU's local REST API — no cache, no timer, so the tab costs
   * nothing while closed. Goes over IPC (not fetch) because the panel's CSP
   * has no connect-src, and because setup editing must work with the overlay
   * server stopped.
   */
  setup: {
    /** The whole current setup: `{ connected, car, carClass, symmetric, settings[] }`. */
    state: () => ipcRenderer.invoke('setup:state'),
    /** Write one setting (clamped server-side): `{ ok, applied?, appliedText?, setting? }`. */
    write: (key, value) => ipcRenderer.invoke('setup:write', { key, value }),
    /** Apply a staged macro: `{ ok, results[], state }` — skips locked keys, reports each. */
    writeBatch: (writes) => ipcRenderer.invoke('setup:writeBatch', { writes }),
  },

  /* ---- League leaderboard ----
   *
   * Unlike everything else on this bridge, these two read the league's database
   * rather than local files, so both can come back `{ ok: false, signedOut }`.
   * That is a state, not an error: laps keep recording either way.
   */

  /** Track/class/car combinations that have laps: `{ ok, rows[], error? }`. */
  leaderboardFilters: () => ipcRenderer.invoke('leaderboard:filters'),

  /** One ranked board: `{ trackId, carClass, car }` → `{ ok, rows[], error? }`. */
  leaderboardRows: (query) => ipcRenderer.invoke('leaderboard:rows', query),

  /** Where the uploader has got to: `{ status, lastOkAt, pending, sent, error }`. */
  lapsSyncState: () => ipcRenderer.invoke('laps:syncState'),

  /** Push everything pending to the league now, rather than on the next tick. */
  lapsSync: () => ipcRenderer.invoke('laps:sync'),

  /** Subscribe to uploader state changes. Returns an unsubscribe function. */
  onLapSync: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('laps:sync', listener);
    return () => ipcRenderer.removeListener('laps:sync', listener);
  },

  /* ---- Account (Supabase) ----
   *
   * Every call is handled in the main process (electron/auth.js). Access and
   * refresh tokens never cross this bridge — the renderer only ever receives
   * the sanitised `user` object and `{ ok, error }` results. */
  auth: {
    /** { signedIn, user, configured, primarySims, lastEmail }. */
    getState: () => ipcRenderer.invoke('auth:getState'),
    /** { email, password, remember } → { ok, error?, field?, state? }. */
    signIn: (payload) => ipcRenderer.invoke('auth:signIn', payload),
    /** { displayName, email, password, primarySim, marketingOptIn }. */
    register: (payload) => ipcRenderer.invoke('auth:register', payload),
    /** Re-send the signup confirmation email: { email }. */
    resendConfirmation: (payload) => ipcRenderer.invoke('auth:resendConfirmation', payload),
    /** Step 1 of reset — email a recovery code: { email }. */
    requestReset: (payload) => ipcRenderer.invoke('auth:requestReset', payload),
    /** Step 2 of reset — { email, token, password }. */
    resetPassword: (payload) => ipcRenderer.invoke('auth:resetPassword', payload),
    /** Sign out and return to the account screens. */
    signOut: () => ipcRenderer.invoke('auth:signOut'),
    /** Leave the account screens for the control panel (after signing in). */
    enterApp: () => ipcRenderer.invoke('auth:enterApp'),
    /** Skip signing in; remembered so it doesn't ask again next launch. */
    continueOffline: () => ipcRenderer.invoke('auth:continueOffline'),
    /** Go back to the account screens from the control panel. */
    showAuth: () => ipcRenderer.invoke('auth:showAuth'),
    /** Subscribe to account-state pushes. Returns an unsubscribe function. */
    onChange: (callback) => {
      const listener = (_evt, payload) => callback(payload);
      ipcRenderer.on('auth:changed', listener);
      return () => ipcRenderer.removeListener('auth:changed', listener);
    },
  },

  /* ---- Feedback (Suggestions tab) ----
   *
   * Anyone signed in can file one. Like the leaderboard reads, this hits the
   * league database, so it can come back `{ ok: false, signedOut }` — a state,
   * not an error. */
  feedback: {
    /** File one suggestion/bug: `{ kind, message }` → `{ ok, id?, signedOut?, error? }`. */
    submit: (payload) => ipcRenderer.invoke('feedback:submit', payload),
  },

  /* ---- Admin panel ----
   *
   * League-staff only. Every call is authorised server-side (the RPCs check
   * is_admin), so a non-admin gets `{ ok: false }` and the renderer simply never
   * shows the tab. Handled in the main process like every other Supabase call. */
  admin: {
    /** Is the signed-in driver an admin? `{ ok, isAdmin }`. Decides the tab. */
    whoami: () => ipcRenderer.invoke('admin:whoami'),
    /** Headline usage numbers: `{ ok, data, signedOut?, error? }`. */
    overview: () => ipcRenderer.invoke('admin:overview'),
    /** The feedback inbox: `{ status? }` → `{ ok, rows[], signedOut?, error? }`. */
    feedback: (query) => ipcRenderer.invoke('admin:feedback', query),
    /**
     * The driver roster: `{ search?, sort? }` → `{ ok, rows[], signedOut?, error? }`.
     * One row per account — name, email, app opens, last active. The only admin
     * read that is per-person rather than aggregate; see the migration's note.
     */
    users: (query) => ipcRenderer.invoke('admin:users', query),
    /** Triage one item: `{ id, status }` → `{ ok, error? }`. */
    setFeedbackStatus: (payload) => ipcRenderer.invoke('admin:setFeedbackStatus', payload),
  },

  /* ---- Streaming chat linking (YouTube + Twitch) ----
   *
   * Twitch is read anonymously, so linking it is only a channel name. YouTube's
   * OAuth runs entirely in the main process (electron/chatLink.js) — the Google
   * token never crosses this bridge, only the sanitised link state. */
  chatLink: {
    /** { twitchChannel, twitchLinked, youTubeConfigured, youTubeLinked, youTubeAccount, youTubeLive }. */
    status: () => ipcRenderer.invoke('chatLink:status'),
    /** Remember (or clear) the Twitch channel: name → { ok, state }. */
    setTwitchChannel: (name) => ipcRenderer.invoke('chatLink:setTwitchChannel', name),
    /** Run the Google consent flow in the browser: → { ok, error?, state }. */
    linkYouTube: () => ipcRenderer.invoke('chatLink:linkYouTube'),
    /** Forget the YouTube link: → { ok, state }. */
    unlinkYouTube: () => ipcRenderer.invoke('chatLink:unlinkYouTube'),
    /** Subscribe to link-state pushes. Returns an unsubscribe function. */
    onChange: (callback) => {
      const listener = (_evt, payload) => callback(payload);
      ipcRenderer.on('chatState:changed', listener);
      return () => ipcRenderer.removeListener('chatState:changed', listener);
    },
  },

  /** Subscribe to live status pushes. Returns an unsubscribe function. */
  onStatus: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('status:update', listener);
    return () => ipcRenderer.removeListener('status:update', listener);
  },

  /**
   * Subscribe to settings pushes from the main process (e.g. when the global
   * hotkey toggles "Show in game"). Returns an unsubscribe function.
   */
  onSettings: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  },

  /* ---- App updates (electron-updater via GitHub Releases) ---- */

  /** Current update state (idle/checking/available/downloading/ready/none/error). */
  getUpdateState: () => ipcRenderer.invoke('update:getState'),
  /** Manually check GitHub Releases for a newer version. */
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  /**
   * Follow the 'stable' or 'beta' release feed. Persisted, and re-checks
   * immediately — switching channel is only ever done to move build now.
   */
  setUpdateChannel: (channel) => ipcRenderer.invoke('update:setChannel', channel),
  /** Download the available update. */
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  /** Quit and install the downloaded update. */
  installUpdate: () => ipcRenderer.invoke('update:install'),
  /** Subscribe to update-state pushes. Returns an unsubscribe function. */
  onUpdate: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  },

  /* ---- What's new (release notes from the bundled CHANGELOG.md) ---- */

  changelog: {
    /**
     * Releases this driver has not read yet, i.e. everything between the build
     * they last opened and this one: `{ show, current, from, entries }`.
     * `entries` are parsed block trees, never HTML — see electron/changelog.js.
     */
    pending: () => ipcRenderer.invoke('changelog:pending'),
    /** The full release history, for the notes opened from the footer version. */
    history: () => ipcRenderer.invoke('changelog:history'),
    /** Record that the notes for this version have been read. */
    markSeen: () => ipcRenderer.invoke('changelog:markSeen'),
  },
});
