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

  /* ---- Shared-memory plugin ---- */

  /** Is the plugin installed, enabled, and able to load? Writes nothing. */
  pluginStatus: () => ipcRenderer.invoke('plugin:status'),
  /** Install/enable it now — used after the game has been closed. */
  pluginInstall: () => ipcRenderer.invoke('plugin:install'),

  /* ---- Race engineer ---- */

  /** Everything the Engineer tab renders: voices, install state, running state. */
  engineerStatus: () => ipcRenderer.invoke('engineer:status'),
  /** Download the Piper engine (first time) + one voice. Resolves when done. */
  engineerDownload: (voiceId) => ipcRenderer.invoke('engineer:download', voiceId),
  /** Speak the sample line with an INSTALLED voice, through the radio channel. */
  engineerPreview: (voiceId) => ipcRenderer.invoke('engineer:preview', voiceId),
  /** "Radio check" — proves the running pipeline end to end. */
  engineerTest: () => ipcRenderer.invoke('engineer:test'),
  /** Push-to-talk from the panel (same path as the bound wheel button). */
  engineerAsk: () => ipcRenderer.invoke('engineer:ask'),
  /** One-time whisper.cpp + base.en download for free-form questions. */
  engineerDownloadStt: () => ipcRenderer.invoke('engineer:downloadStt'),
  /** Delete one downloaded voice. Never the selected one, never a bundled one. */
  engineerRemoveVoice: (voiceId) => ipcRenderer.invoke('engineer:removeVoice', voiceId),
  /** Delete every downloaded voice except the one on the radio. */
  engineerRemoveUnusedVoices: () => ipcRenderer.invoke('engineer:removeUnusedVoices'),
  /** Mark the last free-form reply useful or wrong. */
  engineerRate: (id, rating) => ipcRenderer.invoke('engineer:rate', id, rating),
  /** Status pushes: download progress, running state. Returns unsubscribe. */
  onEngineerStatus: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('engineer:status', listener);
    return () => ipcRenderer.removeListener('engineer:status', listener);
  },

  /* ---- Team (pit-wall view) ---- */

  /** Start the 1 Hz snapshot pushes; resolves with the current snapshot (or null). */
  teamSubscribe: () => ipcRenderer.invoke('team:subscribe'),
  /** Stop the pushes — the tab costs nothing while another view is active. */
  teamUnsubscribe: () => ipcRenderer.invoke('team:unsubscribe'),
  /** Snapshot pushes while subscribed (null = feed stopped). Returns unsubscribe. */
  onTeamUpdate: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('team:update', listener);
    return () => ipcRenderer.removeListener('team:update', listener);
  },

  /* ---- Teams + relay (Phase 2: crew roster, invite codes, watched car) ---- */

  /** Roster/publish state right now (also pushed via onTeamCloud on change). */
  teamCloudState: () => ipcRenderer.invoke('team:cloudState'),
  /** Re-fetch my teams from the server; resolves with the fresh state. */
  teamRefresh: () => ipcRenderer.invoke('team:refreshTeams'),
  teamCreate: (name) => ipcRenderer.invoke('team:create', name),
  teamJoin: (code) => ipcRenderer.invoke('team:join', code),
  teamLeave: (id) => ipcRenderer.invoke('team:leave', id),
  teamDelete: (id) => ipcRenderer.invoke('team:delete', id),
  teamRemoveMember: (id, userId) => ipcRenderer.invoke('team:removeMember', id, userId),
  teamRotateCode: (id) => ipcRenderer.invoke('team:rotateCode', id),
  teamRename: (id, name) => ipcRenderer.invoke('team:rename', id, name),
  teamSetActive: (id) => ipcRenderer.invoke('team:setActive', id),
  /** Start/stop the 3 s relay poll (Team source on the pit wall). */
  teamWatch: (on) => ipcRenderer.invoke('team:watch', on),
  /** Roster/publish-status pushes. Returns unsubscribe. */
  onTeamCloud: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('team:cloud', listener);
    return () => ipcRenderer.removeListener('team:cloud', listener);
  },
  /** Relay pushes while watching (the teammate's car). Returns unsubscribe. */
  onTeamRelay: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('team:relay', listener);
    return () => ipcRenderer.removeListener('team:relay', listener);
  },

  /* ---- Wheel / controller bindings ---- */

  /** Attached controllers + whether background reading works on this host. */
  wheelDevices: () => ipcRenderer.invoke('wheel:devices'),
  /** Wait for the next wheel button press (for binding capture). */
  wheelCapture: () => ipcRenderer.invoke('wheel:capture'),
  /** Bind one direction of an action to a wheel button; null binding clears. */
  wheelBind: (actionId, dir, binding) => ipcRenderer.invoke('wheel:bind', actionId, dir, binding),
  /**
   * Subscribe to wheel-list pushes — fired when the reader's own re-scan finds
   * a device appeared, vanished, or was recreated by its driver. Same payload
   * as wheelDevices(). Returns an unsubscribe function.
   */
  onWheelDevices: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('wheel:devices-changed', listener);
    return () => ipcRenderer.removeListener('wheel:devices-changed', listener);
  },

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
    /** The current car's own-livery render, custom paints included: `{ ok, vehId?, dataUrl? }`. */
    carImage: () => ipcRenderer.invoke('setup:carImage'),

    /* ---- the setup library (save/load/share .svm files) ---- */
    /** All saved setups, each with `bestLap: {lapMs, setAt}|null` for its track+class. */
    libList: () => ipcRenderer.invoke('setuplib:list'),
    /** Archive the sim's CURRENT garage setup: `{ name, sessionType?, color? }`. */
    libSave: (meta) => ipcRenderer.invoke('setuplib:save', meta),
    /** Edit name/colour/session/notes. */
    libUpdate: (id, patch) => ipcRenderer.invoke('setuplib:update', { id, patch }),
    libDelete: (id) => ipcRenderer.invoke('setuplib:delete', { id }),
    /** Share: OS save dialog handing out the raw .svm. */
    libExport: (id) => ipcRenderer.invoke('setuplib:export', { id }),
    /** Share: the .svm onto the clipboard as a FILE — Ctrl+V into Discord/WhatsApp. */
    libClip: (id) => ipcRenderer.invoke('setuplib:clip', { id }),
    /** Import a .svm someone sent you (OS open dialog). */
    libImport: () => ipcRenderer.invoke('setuplib:import'),
    /** Install into LMU's own custom setups for its car+track, leaving the car
     *  alone: `{ ok, inGameName, trackFolder, entry, error? }`. */
    libToGame: (id) => ipcRenderer.invoke('setuplib:togame', { id }),

    /* ---- community setups (cloud) ----
     * The library's public half. All five can come back `{ ok: false,
     * signedOut: true }` — a state, not an error, same as the leaderboard. */
    /** Every published setup, light rows: `{ ok, rows[], signedOut?, error? }`. */
    cloudList: () => ipcRenderer.invoke('setupcloud:list'),
    /** Publish a library entry: `{ id, name?, notes?, tags? }` — main attaches the verified lap. */
    cloudPublish: (payload) => ipcRenderer.invoke('setupcloud:publish', payload),
    /** Take your own share down (the cloud copy only; local files stay). */
    cloudUnpublish: (id) => ipcRenderer.invoke('setupcloud:unpublish', { id }),
    /** Fetch into the sim's Settings tree AND the library:
     *  `{ ok, inGame, inGameName, inGameError, trackName, entry }`. */
    cloudDownload: (id) => ipcRenderer.invoke('setupcloud:download', { id }),
    /** Rate a downloaded setup 1–5: `{ id, stars, trackName, carClass, fingerprint }` —
     *  main attaches your verified lap, preferring one driven on that very setup. */
    cloudRate: (payload) => ipcRenderer.invoke('setupcloud:rate', payload),
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
    /**
     * GDPR erasure: permanently delete the account and every cloud record it
     * owns, cancel any subscription, and sign out. → { ok, error? }. The
     * renderer collects typed confirmation BEFORE calling this — there is no
     * undo on the other side.
     */
    deleteAccount: () => ipcRenderer.invoke('auth:deleteAccount'),
    /**
     * Leave the account screens for the control panel — if the account is
     * entitled. Returns `{ ..., entitled, billing }`; when `entitled` is false
     * the caller shows the subscribe screen instead.
     */
    enterApp: () => ipcRenderer.invoke('auth:enterApp'),
    /** Go back to the account screens from the control panel. */
    showAuth: () => ipcRenderer.invoke('auth:showAuth'),
    /** Subscribe to account-state pushes. Returns an unsubscribe function. */
    onChange: (callback) => {
      const listener = (_evt, payload) => callback(payload);
      ipcRenderer.on('auth:changed', listener);
      return () => ipcRenderer.removeListener('auth:changed', listener);
    },
  },

  /* ---- Terms of Use / Privacy Policy ----
   *
   * Bundled documents (control-panel/legal.html) opened in their own window —
   * readable offline and before signing in. `section` is 'terms' | 'privacy'. */
  legal: {
    open: (section) => ipcRenderer.invoke('legal:open', section),
  },

  /* ---- Billing (Stripe subscription / league free access) ----
   *
   * Handled in the main process (electron/billing.js). Checkout and the
   * Customer Portal open in the system browser; this bridge only ever carries
   * the sanitised entitlement snapshot — no card data, no Stripe ids. */
  billing: {
    /** Fresh-ish entitlement snapshot: { entitled, source, status, trialEnd, ... }. */
    status: () => ipcRenderer.invoke('billing:status'),
    /** Open Stripe Checkout in the browser: → { ok, alreadySubscribed?, error? }. */
    checkout: () => ipcRenderer.invoke('billing:checkout'),
    /** Open the Stripe Customer Portal (manage / cancel / card) in the browser. */
    portal: () => ipcRenderer.invoke('billing:portal'),
    /** Redeem a league voucher code: → { ok, error? }. */
    redeemCode: (code) => ipcRenderer.invoke('billing:redeemCode', code),
    /** Subscribe to entitlement pushes. Returns an unsubscribe function. */
    onChange: (callback) => {
      const listener = (_evt, payload) => callback(payload);
      ipcRenderer.on('billing:changed', listener);
      return () => ipcRenderer.removeListener('billing:changed', listener);
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
    /**
     * League replies this driver has not read: `{ ok, rows[], signedOut? }`.
     * Signed out comes back as an empty list, not an error — the panel asks
     * this at boot, before a session necessarily exists.
     */
    unreadReplies: () => ipcRenderer.invoke('feedback:unreadReplies'),
    /** Acknowledge one reply: `{ id }` → `{ ok, error? }`. */
    markReplySeen: (payload) => ipcRenderer.invoke('feedback:markReplySeen', payload),
  },

  /* ---- League schedule (SimGrid) ----
   *
   * Thursday and Saturday championships. Fetched in the main process so the
   * GridOS token never reaches the renderer — only names, times and https
   * signup URLs come back. `force` bypasses the five-minute cache. */
  schedule: {
    /** `{ force? }` → `{ ok, leagues[], fetchedAt, error? }`. */
    get: (query) => ipcRenderer.invoke('schedule:get', query || {}),
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
    /**
     * Answer one item: `{ id, reply, status? }` → `{ ok, error? }`. Passing a
     * status triages and replies in one go. The driver sees the reply as an
     * alert the next time the panel opens.
     */
    replyFeedback: (payload) => ipcRenderer.invoke('admin:replyFeedback', payload),
    /** Withdraw a reply: `{ id }` → `{ ok, error? }`. */
    clearFeedbackReply: (payload) => ipcRenderer.invoke('admin:clearFeedbackReply', payload),
    /**
     * Accounts with a failed payment: `{ ok, rows[], signedOut?, error? }`.
     * Each row carries the server's lockout date and days left, so the list
     * agrees with the entitlement by construction.
     */
    pastDue: () => ipcRenderer.invoke('admin:pastDue'),
    /** Free access: codes issued + comped accounts → `{ ok, data, error? }`. */
    freeAccess: () => ipcRenderer.invoke('admin:freeAccess'),
    /** Cut league codes: `{ count, note }` → `{ ok, codes[], error? }`. */
    issueCodes: (payload) => ipcRenderer.invoke('admin:issueCodes', payload),
    /** Revoke an account's free access: `{ userId }` → `{ ok, error? }`. */
    revokeFree: (payload) => ipcRenderer.invoke('admin:revokeFree', payload),
    /** Grant free access: `{ userId, reason, note? }` → `{ ok, error? }`. */
    grantFree: (payload) => ipcRenderer.invoke('admin:grantFree', payload),
    /**
     * Subscription mix, run rate, and twelve months of MRR + churn:
     * → `{ ok, data, error? }`. Drives the Billing section's charts.
     */
    billing: () => ipcRenderer.invoke('admin:billing'),
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
    /**
     * Link the streamer's Twitch account for the bot (Device Code Grant). The
     * user code to type appears via onChange (`twitchLinkPending`) while this
     * promise is pending. → { ok, error?, state }.
     */
    linkTwitch: () => ipcRenderer.invoke('chatLink:linkTwitch'),
    /** Forget the Twitch login (the read channel is kept): → { ok, state }. */
    unlinkTwitch: () => ipcRenderer.invoke('chatLink:unlinkTwitch'),
    /** Subscribe to link-state pushes. Returns an unsubscribe function. */
    onChange: (callback) => {
      const listener = (_evt, payload) => callback(payload);
      ipcRenderer.on('chatState:changed', listener);
      return () => ipcRenderer.removeListener('chatState:changed', listener);
    },
  },

  /* ---- Stream bot (commands, timers, alerts, goals) ----
   *
   * Config only — validation and persistence live in electron/streamBot.js,
   * the engine in the server. Nothing on this bridge carries a credential. */
  streamBot: {
    /** Full bot state for the panel (lists + budget usage). */
    get: () => ipcRenderer.invoke('streamBot:get'),
    /** Replace one section: ('commands'|'timers'|'alerts'|'goals'|'settings', value) → { ok, state }. */
    update: (section, value) => ipcRenderer.invoke('streamBot:update', { section, value }),
    /** Master switch: → { ok, state }. */
    setEnabled: (on) => ipcRenderer.invoke('streamBot:setEnabled', on),
    /** Manual ± on a goal's current value: (goalId, delta) → { ok, state }. */
    goalAdjust: (goalId, delta) => ipcRenderer.invoke('streamBot:goalAdjust', { goalId, delta }),
    /** Subscribe to bot-state pushes. Returns an unsubscribe function. */
    onChange: (callback) => {
      const listener = (_evt, payload) => callback(payload);
      ipcRenderer.on('streamBot:changed', listener);
      return () => ipcRenderer.removeListener('streamBot:changed', listener);
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
