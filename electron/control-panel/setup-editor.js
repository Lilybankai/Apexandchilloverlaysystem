/**
 * setup-editor.js — the Setups tab: a live, two-way editor for the car in the
 * garage.
 * -----------------------------------------------------------------------------
 * Reads and writes go through window.apex.setup (IPC — the panel's CSP has no
 * connect-src, and editing must work with the overlay server stopped). The sim
 * is the single source of truth: every row renders the garage's own current
 * value and wording, edits POST through main to LMU, and in-game changes land
 * on the next poll tick.
 *
 * THE RESOURCE RULE — this tab costs nothing while closed. The only timer in
 * the whole panel lives here, and it runs solely while (a) the setups view is
 * the active tab AND (b) the document is visible. The tab router calls
 * window.apexSetup.shown()/hidden() on every switch; visibilitychange covers
 * the minimised window. There is no other entry point.
 *
 * The car card is a still image for now — the live three.js wireframe was
 * removed in v0.67.0-beta.2 (recoverable from git along with vendor/ and
 * setup-3d/); only its hide/show preference survives it.
 *
 * Rows are built with createElement and kept references (the opacityRow()
 * pattern in control-panel.js) — never per-key element ids, which would defeat
 * the parity test's id contract.
 */

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const GROUPS = window.APEX_SETUP_GROUPS;
  const INFOAPI = window.APEX_SETUP_INFO;
  const MACROAPI = window.APEX_SETUP_MACROS;
  const GUIDEAPI = window.APEX_SETUP_GUIDE; // the first-run walkthrough

  /* ---- static frame ------------------------------------------------------ */

  const view = document.querySelector('[data-view="setups"]');
  const elStatus = $('#setup-status');
  const elCar = $('#setup-car');
  const elClass = $('#setup-class');
  const elSym = $('#setup-sym');
  const elOffline = $('#setup-offline');
  const elBody = $('#setup-body');
  // The car + engineer rail is a sibling of the editor now (the community list
  // took the third column), so it has to be shown and hidden alongside it.
  const elSide = $('#setup-side');
  const elTabs = $('#setup-tabs');
  const elRows = $('#setup-rows');
  const elCanvasWrap = $('#setup-canvas-wrap');
  const el3dToggle = $('#setup-3d-toggle');
  const elMacroList = $('#setup-macro-list');
  const elStaged = $('#setup-staged');
  const elStagedCount = $('#setup-staged-count');
  const elApply = $('#setup-apply');
  const elRevert = $('#setup-revert');
  const elPop = $('#setup-info-pop');
  const elPopTitle = $('#setup-info-title');
  const elPopBody = $('#setup-info-body');
  const elPopClose = $('#setup-info-close');

  // Library card + its two dialogs.
  const elLibImport = $('#setup-lib-import');
  const elLibSave = $('#setup-lib-save');
  const elLibTrack = $('#setup-lib-track');
  const elLibCar = $('#setup-lib-car');
  const elLibSession = $('#setup-lib-session');
  const elLibColors = $('#setup-lib-colors');
  const elLibSort = $('#setup-lib-sort');
  const elLibList = $('#setup-lib-list');
  const elLibEmpty = $('#setup-lib-empty');
  const elSavePop = $('#setup-save-pop');
  const elSaveName = $('#setup-save-name');
  const elSaveSession = $('#setup-save-session');
  const elSaveColors = $('#setup-save-colors');
  const elSaveConfirm = $('#setup-save-confirm');
  const elSaveCancel = $('#setup-save-cancel');
  const elSaveError = $('#setup-save-error');
  const elSharePop = $('#setup-share-pop');
  const elShareText = $('#setup-share-text');
  const elShareCopy = $('#setup-share-copy');
  const elShareFile = $('#setup-share-file');
  const elShareCancel = $('#setup-share-cancel');
  const elSharePublish = $('#setup-share-publish');

  // Community card + publish/rate dialogs.
  const elComFollow = $('#setup-com-follow');
  const elComRefresh = $('#setup-com-refresh');
  const elComTrack = $('#setup-com-track');
  const elComCar = $('#setup-com-car');
  const elComClass = $('#setup-com-class');
  const elComSort = $('#setup-com-sort');
  const elComList = $('#setup-com-list');
  const elComEmpty = $('#setup-com-empty');
  const elPubPop = $('#setup-pub-pop');
  const elPubName = $('#setup-pub-name');
  const elPubNotes = $('#setup-pub-notes');
  const elPubTags = $('#setup-pub-tags');
  const elPubTagHint = $('#setup-pub-taghint');
  const elPubLap = $('#setup-pub-lap');
  const elPubConfirm = $('#setup-pub-confirm');
  const elPubCancel = $('#setup-pub-cancel');
  const elRatePop = $('#setup-rate-pop');
  const elRateText = $('#setup-rate-text');
  const elRateStars = $('#setup-rate-stars');
  const elRateCancel = $('#setup-rate-cancel');
  // Setups feedback dialog + the "share your setups" nudge.
  const elComFeedback = $('#setup-com-feedback');
  const elFbPop = $('#setup-feedback-pop');
  const elFbKind = $('#setup-feedback-kind');
  const elFbMessage = $('#setup-feedback-message');
  const elFbStatus = $('#setup-feedback-status');
  const elFbSend = $('#setup-feedback-send');
  const elFbCancel = $('#setup-feedback-cancel');
  const elNudge = $('#setup-share-nudge');
  const elNudgeText = $('#setup-nudge-text');
  const elNudgeShare = $('#setup-nudge-share');

  /* ---- state -------------------------------------------------------------- */

  const POLL_MS = 750; // in-game edits appear within one tick
  const POLL_OFFLINE_MS = 3000; // don't hammer a sim that isn't there
  const WRITE_DEBOUNCE_MS = 200; // trailing, per key
  const PENDING_TIMEOUT_MS = 1500; // a write that never settles unfreezes its row

  let active = false; // tab shown and document visible
  let pollTimer = null;
  let polling = false; // an in-flight state read (coalesce)
  let lastState = null; // last full state payload
  let settingsMap = new Map(); // key -> projected setting (base, un-staged)
  let currentTab = null; // active sub-tab name
  const rowsByKey = new Map(); // key -> { paint(setting, stagedTo) }
  const dirtyLocal = new Map(); // key -> timeout id; rows the user is mid-editing
  const writeTimers = new Map(); // key -> debounce timeout id
  const macroClicks = new Map(); // macro id -> clicks (-RANGE..RANGE)
  const macroSliders = new Map(); // macro id -> { input, clicks } elements
  let staged = new Map(); // key -> target value (the preview overlay)
  let loadedStage = null; // {name, values: Map, skipped, warnings[]} — a staged library tune
  let shownVehId = ''; // whose artwork the Car card currently shows
  let writesFrozen = false;
  let failedWrites = 0;

  const THREE_D_PREF_KEY = 'apex.setup.3d';

  // Community card state — declared HERE, above the lifecycle self-start,
  // because shown() (which can run synchronously at load) kicks off
  // refreshCommunity() and these must exist by then.
  const TAGAPI = window.APEX_SETUP_TAGS;
  const COM_FOLLOW_KEY = 'apex.setup.community.follow';
  let comRows = [];
  let comState = 'loading'; // 'loading' | 'ok' | 'signedOut' | 'error'
  let comError = '';
  let comRequest = 0; // monotonic guard against out-of-order replies
  let pubTarget = null; // library entry being published
  let pubTags = new Set(); // chips currently toggled on
  let rateTarget = null; // community row being rated

  /* ====================================================================== */
  /*  Lifecycle                                                             */
  /* ====================================================================== */

  function shown() {
    if (active) return;
    if (document.visibilityState !== 'visible') return; // visibilitychange will call back
    active = true;
    schedulePoll(0);
    void refreshLibrary(); // one read per show, never on a timer
    void refreshCommunity(); // ditto — one cloud read per show
    // First visit only, and it decides that for itself — this tab is a wall of
    // sliders to someone who has never seen it. Offline is fine: the
    // walkthrough explains the tab, it does not read the car.
    GUIDEAPI?.maybeAutoOpen();
  }

  function hidden() {
    active = false;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    GUIDEAPI?.cancelAutoOpen();
  }

  document.addEventListener('visibilitychange', () => {
    const tabActive = view && view.getAttribute('data-active') === 'true';
    if (document.visibilityState === 'visible' && tabActive) shown();
    else hidden();
  });

  window.apexSetup = { shown, hidden };

  // Boot order: control-panel.js restores the last tab BEFORE this file loads,
  // so a session that reopens straight onto Setups has already had its
  // shown() call happen into thin air. Self-start covers it.
  if (view && view.getAttribute('data-active') === 'true') shown();

  /* ====================================================================== */
  /*  Poll loop                                                             */
  /* ====================================================================== */

  function schedulePoll(delay) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, delay);
  }

  async function poll() {
    pollTimer = null;
    if (!active || polling) return;
    if (!window.apex || !window.apex.setup) {
      paintOffline('The app needs a restart to pick up the setup bridge.');
      return;
    }
    polling = true;
    let state = null;
    try {
      state = await window.apex.setup.state();
    } catch {
      state = null;
    }
    polling = false;
    if (!active) return;

    if (!state || !state.connected) {
      paintOffline();
      schedulePoll(POLL_OFFLINE_MS);
      return;
    }
    applyState(state);
    schedulePoll(POLL_MS);
  }

  /* ====================================================================== */
  /*  State → DOM                                                           */
  /* ====================================================================== */

  function paintOffline(message) {
    const wasConnected = Boolean(lastState && lastState.connected);
    lastState = null;
    elStatus.textContent = 'OFFLINE';
    elStatus.setAttribute('data-state', 'offline');
    elOffline.hidden = false;
    if (message) {
      const p = elOffline.querySelector('p');
      if (p) p.textContent = message;
    }
    elBody.hidden = true;
    elSide.hidden = true;
    writesFrozen = false;
    failedWrites = 0;
    elLibSave.disabled = true;
    if (wasConnected) {
      renderLibraryList(); // Load buttons pick up the new state
      renderCommunityList(); // follow-mode falls back to manual filters
    }
  }

  function applyState(state) {
    const firstPaint = !lastState || !lastState.connected;
    lastState = state;
    elLibSave.disabled = false;
    if (firstPaint) {
      renderLibraryList(); // arm the Load buttons
      renderCommunityList(); // follow-mode locks onto this car & track
    } else if (comFollowKey() !== comShownFollowKey) {
      // Swapped car, or the session moved to another track: the followed list
      // is about somewhere the driver no longer is. Repaint it, no refetch —
      // every published row is already in hand.
      renderCommunityList();
    }

    // The Car card shows THIS car, in its own livery — a custom paint comes
    // from raceos.gg, stock art from the game — fetched once per .VEH and
    // swapped only when the car actually changes.
    // The neon sketch in the markup stays as the fallback for fetch failures.
    if (state.vehId && state.vehId !== shownVehId) {
      shownVehId = state.vehId;
      void window.apex.setup.carImage().then((res) => {
        const img = elCanvasWrap.querySelector('img');
        if (img && res && res.ok && res.dataUrl) img.src = res.dataUrl;
      });
    }
    settingsMap = new Map();
    for (const s of state.settings) settingsMap.set(s.key, s);

    elStatus.textContent = 'LIVE';
    elStatus.setAttribute('data-state', 'garage');
    elCar.textContent = state.car || '';
    elClass.textContent = state.carClass || '';
    elClass.hidden = !state.carClass;
    elSym.hidden = !state.symmetric;
    elOffline.hidden = true;
    elBody.hidden = false;
    elSide.hidden = false;

    if (firstPaint) {
      buildTabs();
      renderTab(currentTab || GROUPS.TABS[0]);
      buildMacros();
    } else {
      // Repaint values in place. Rows mid-edit keep their optimistic value.
      for (const [key, row] of rowsByKey) {
        if (dirtyLocal.has(key)) continue;
        row.paint(settingsMap.get(key), staged.has(key) ? staged.get(key) : null);
      }
    }
    const wroteOk = failedWrites === 0;
    if (wroteOk) writesFrozen = false;
  }

  /* ---- sub-tabs ----------------------------------------------------------- */

  function buildTabs() {
    elTabs.textContent = '';
    for (const tab of GROUPS.TABS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = tab;
      btn.setAttribute('data-active', String(tab === (currentTab || GROUPS.TABS[0])));
      btn.addEventListener('click', () => {
        currentTab = tab;
        for (const b of elTabs.children) b.setAttribute('data-active', String(b === btn));
        renderTab(tab);
      });
      elTabs.appendChild(btn);
    }
    if (!currentTab) currentTab = GROUPS.TABS[0];
  }

  /**
   * The render plan for one tab: its sections in declared order, each with the
   * renderable items — a VM key as a scalar row, a WM family as one corner row.
   * Built fresh per render from whatever keys the car actually has.
   */
  function planTab(tab) {
    const sections = new Map(); // section name -> items[]
    const sectionOrder = [];
    const seenFamilies = new Set();

    const push = (section, item, order) => {
      if (!sections.has(section)) {
        sections.set(section, []);
        sectionOrder.push(section);
      }
      sections.get(section).push({ ...item, order });
    };

    for (const s of lastState.settings) {
      const c = GROUPS.classifyKey(s.key);
      if (c.tab !== tab) continue;
      if (c.corner) {
        if (seenFamilies.has(c.family)) continue;
        seenFamilies.add(c.family);
        const corners = ['FL', 'FR', 'RL', 'RR']
          .map((corner) => ({ corner, setting: settingsMap.get(`${c.family}-W_${corner}`) }))
          .filter((x) => x.setting && x.setting.available);
        if (corners.length === 0) continue;
        push(c.section, { kind: 'corners', family: c.family, corners }, c.order);
      } else {
        if (!s.available) continue;
        push(c.section, { kind: 'scalar', setting: s }, c.order);
      }
    }
    for (const items of sections.values()) items.sort((a, b) => a.order - b.order);
    return { sections, sectionOrder };
  }

  function renderTab(tab) {
    currentTab = tab;
    elRows.textContent = '';
    // Only the visible tab's rows exist — the registry follows.
    rowsByKey.clear();
    if (!lastState || !lastState.connected) return;

    const { sections, sectionOrder } = planTab(tab);
    for (const name of sectionOrder) {
      const sec = document.createElement('section');
      sec.className = 'su-section';
      const h = document.createElement('h3');
      h.className = 'su-section__title';
      h.textContent = name;
      sec.appendChild(h);
      for (const item of sections.get(name)) {
        sec.appendChild(item.kind === 'corners' ? cornerRow(item) : scalarRow(item.setting));
      }
      elRows.appendChild(sec);
    }
  }

  /* ---- row builders -------------------------------------------------------- */

  function labelFor(key) {
    const family = key.replace(/-W_(FL|FR|RL|RR)$/, '');
    const info = INFOAPI.infoFor(family);
    if (info) return info.title;
    // Fallback: humanize the raw key.
    return family
      .replace(/^(VM_|WM_)/, '')
      .toLowerCase()
      .replace(/_/g, ' ');
  }

  function infoButton(key) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'su-row__info';
    btn.title = 'What does this do?';
    btn.innerHTML = '<svg class="icon"><use href="#i-info" /></svg>';
    btn.addEventListener('click', () => openInfo(key));
    return btn;
  }

  function lockIcon() {
    const s = document.createElement('span');
    s.innerHTML = '<svg class="icon su-row__lock"><use href="#i-lock" /></svg>';
    return s.firstChild;
  }

  /** value cell text: sim wording, plus dirty dot / staged ghost / pending. */
  function paintValueCell(cell, setting, stagedTo, pending) {
    cell.textContent = '';
    if (!setting) return;
    const cur = document.createElement('span');
    cur.textContent = setting.stringValue || String(setting.value);
    cell.appendChild(cur);
    if (stagedTo !== null && stagedTo !== undefined && stagedTo !== setting.value) {
      const ghost = document.createElement('span');
      ghost.className = 'su-row__staged';
      ghost.textContent = ` → ${stagedTo}`;
      ghost.title = 'Staged by the race engineer — Apply to send';
      cell.appendChild(ghost);
    }
    if (setting.dirty) {
      const dot = document.createElement('span');
      dot.className = 'su-row__dirty';
      dot.title = 'Differs from the saved setup file';
      cell.appendChild(dot);
    }
    cell.setAttribute('data-pending', String(Boolean(pending)));
  }

  function scalarRow(setting) {
    const row = document.createElement('div');
    row.className = 'su-row';

    const head = document.createElement('span');
    head.className = 'su-row__head';
    const label = document.createElement('span');
    label.className = 'su-row__label';
    label.textContent = labelFor(setting.key);
    head.appendChild(label);
    head.appendChild(infoButton(setting.key));
    if (!setting.isFree) head.appendChild(lockIcon());
    row.appendChild(head);

    const fixed = setting.min >= setting.max || !setting.isFree;
    row.setAttribute('data-locked', String(fixed));

    let range = null;
    if (fixed) {
      // Nothing to drag — the value cell alone tells the story.
      const spacer = document.createElement('span');
      row.appendChild(spacer);
    } else {
      range = document.createElement('input');
      range.type = 'range';
      range.className = 'field__range';
      range.min = String(setting.min);
      range.max = String(setting.max);
      range.step = '1';
      range.value = String(setting.value);
      wireRange(range, setting.key);
      row.appendChild(range);
    }

    const value = document.createElement('span');
    value.className = 'su-row__value';
    row.appendChild(value);
    paintValueCell(value, setting, staged.get(setting.key) ?? null, false);

    rowsByKey.set(setting.key, {
      paint(next, stagedTo) {
        if (!next) return;
        if (range && document.activeElement !== range) range.value = String(next.value);
        paintValueCell(value, next, stagedTo, dirtyLocal.has(setting.key));
        row.setAttribute('data-staged', String(stagedTo !== null && stagedTo !== undefined));
      },
      flash() {
        row.classList.remove('su-row--flash');
        void row.offsetWidth; // restart the animation
        row.classList.add('su-row--flash');
      },
    });
    return row;
  }

  function cornerRow(item) {
    const row = document.createElement('div');
    row.className = 'su-row su-row--corners';

    const top = document.createElement('div');
    top.className = 'su-row__top';
    const head = document.createElement('span');
    head.className = 'su-row__head';
    const label = document.createElement('span');
    label.className = 'su-row__label';
    label.textContent = labelFor(item.family);
    head.appendChild(label);
    head.appendChild(infoButton(item.family));
    top.appendChild(head);
    row.appendChild(top);

    const grid = document.createElement('div');
    grid.className = 'su-corners';
    grid.setAttribute('data-linked', String(Boolean(lastState && lastState.symmetric)));
    row.appendChild(grid);

    // FL FR / RL RR reading order.
    for (const { corner, setting } of item.corners) {
      const cell = document.createElement('div');
      cell.className = 'su-corner';
      const tag = document.createElement('span');
      tag.className = 'su-corner__tag';
      tag.textContent = corner;
      cell.appendChild(tag);

      const fixed = setting.min >= setting.max || !setting.isFree;
      let range = null;
      if (fixed) {
        cell.appendChild(document.createElement('span'));
      } else {
        range = document.createElement('input');
        range.type = 'range';
        range.className = 'field__range';
        range.min = String(setting.min);
        range.max = String(setting.max);
        range.step = '1';
        range.value = String(setting.value);
        wireRange(range, setting.key);
        cell.appendChild(range);
      }

      const value = document.createElement('span');
      value.className = 'su-corner__value';
      cell.appendChild(value);
      paintValueCell(value, setting, staged.get(setting.key) ?? null, false);

      rowsByKey.set(setting.key, {
        paint(next, stagedTo) {
          if (!next) return;
          if (range && document.activeElement !== range) range.value = String(next.value);
          paintValueCell(value, next, stagedTo, dirtyLocal.has(setting.key));
          row.setAttribute('data-staged', String(stagedTo !== null && stagedTo !== undefined));
        },
      });
      grid.appendChild(cell);
    }
    return row;
  }

  /* ---- writes --------------------------------------------------------------- */

  function wireRange(range, key) {
    range.addEventListener('input', () => {
      markDirtyLocal(key);
      const row = rowsByKey.get(key);
      if (row) row.paint({ ...settingsMap.get(key), value: Number(range.value), stringValue: `step ${range.value}` }, null);
      if (writeTimers.has(key)) clearTimeout(writeTimers.get(key));
      writeTimers.set(
        key,
        setTimeout(() => {
          writeTimers.delete(key);
          void writeKey(key, Number(range.value));
        }, WRITE_DEBOUNCE_MS),
      );
    });
  }

  function markDirtyLocal(key) {
    if (dirtyLocal.has(key)) clearTimeout(dirtyLocal.get(key));
    dirtyLocal.set(
      key,
      setTimeout(() => dirtyLocal.delete(key), PENDING_TIMEOUT_MS),
    );
  }

  async function writeKey(key, value) {
    if (writesFrozen) return;
    markDirtyLocal(key);
    let res = null;
    try {
      res = await window.apex.setup.write(key, value);
    } catch {
      res = null;
    }
    if (dirtyLocal.has(key)) {
      clearTimeout(dirtyLocal.get(key));
      dirtyLocal.delete(key);
    }
    const row = rowsByKey.get(key);
    if (res && res.ok) {
      failedWrites = 0;
      if (res.setting) {
        settingsMap.set(key, res.setting);
        if (row) {
          row.paint(res.setting, staged.get(key) ?? null);
          // The sim may have clamped or reworded — a flash says "this is what took".
          if (row.flash && res.setting.value !== value) row.flash();
        }
      }
    } else {
      failedWrites += 1;
      if (row) row.paint(settingsMap.get(key), staged.get(key) ?? null);
      if (failedWrites >= 3) {
        // Something is systematically wrong (on track? sim gone?) — stop
        // machine-gunning failures; the next good poll unfreezes.
        writesFrozen = true;
      }
    }
  }

  /* ====================================================================== */
  /*  Race engineer macros                                                  */
  /* ====================================================================== */

  function buildMacros() {
    elMacroList.textContent = '';
    macroSliders.clear();
    for (const macro of MACROAPI.MACROS) {
      const wrap = document.createElement('div');
      wrap.className = 'su-macro';

      const label = document.createElement('span');
      label.className = 'su-macro__label';
      label.textContent = macro.label;
      label.title = macro.hint;
      wrap.appendChild(label);

      const clicks = document.createElement('span');
      clicks.className = 'su-macro__clicks';
      clicks.textContent = '0';
      wrap.appendChild(clicks);

      const range = document.createElement('input');
      range.type = 'range';
      range.className = 'field__range';
      range.min = String(-MACROAPI.RANGE);
      range.max = String(MACROAPI.RANGE);
      range.step = '1';
      range.value = '0';
      range.addEventListener('input', () => {
        const v = Number(range.value);
        macroClicks.set(macro.id, v);
        clicks.textContent = v > 0 ? `+${v}` : String(v);
        clicks.setAttribute('data-active', String(v !== 0));
        restage();
      });
      wrap.appendChild(range);

      macroSliders.set(macro.id, { range, clicks });
      elMacroList.appendChild(wrap);
    }
  }

  /**
   * Recomputes the whole staged overlay from the BASE values, plus a loaded
   * library tune (if any) underneath, plus every macro at its current clicks
   * on top, in panel order. Recomputing from scratch (rather than nudging)
   * keeps staging deterministic: dragging a macro to +3 and back to 0 stages
   * exactly nothing, and a loaded tune plus a macro tweak compose cleanly.
   */
  function restage() {
    staged = new Map();
    if (!lastState || !lastState.connected) {
      paintStagedUi(0);
      return;
    }
    const carClass = lastState.carClass || '';

    // Effective view: base values, overlaid as staging accumulates.
    const effective = new Map();
    for (const [key, s] of settingsMap) {
      effective.set(key, { value: s.value, min: s.min, max: s.max, isFree: s.isFree, available: s.available });
    }

    // 1 ─ the loaded library tune, if one is staged.
    if (loadedStage) {
      for (const [key, to] of loadedStage.values) {
        staged.set(key, to);
        const e = effective.get(key);
        if (e) e.value = to;
      }
    }

    // 2 ─ macros compound on top.
    let skippedCount = 0;
    for (const macro of MACROAPI.MACROS) {
      const clicks = macroClicks.get(macro.id) || 0;
      if (clicks === 0) continue;
      const { changes, skipped } = MACROAPI.resolveMacro(macro, clicks, effective, carClass);
      skippedCount += skipped.length;
      for (const ch of changes) {
        staged.set(ch.key, ch.to);
        effective.get(ch.key).value = ch.to;
      }
    }
    // Staging what is already the current value stages nothing.
    for (const [key, to] of [...staged]) {
      const base = settingsMap.get(key);
      if (base && base.value === to) staged.delete(key);
    }

    for (const [key, row] of rowsByKey) {
      if (dirtyLocal.has(key)) continue;
      row.paint(settingsMap.get(key), staged.has(key) ? staged.get(key) : null);
    }
    paintStagedUi(skippedCount);
  }

  /** The Apply bar + the orange tab glow, from the current staged overlay. */
  function paintStagedUi(macroSkipped) {
    // The Apply bar never hides — it arms. A control that only appears after
    // an invisible precondition is a control nobody finds.
    elStaged.setAttribute('data-ready', String(staged.size > 0));
    elApply.disabled = staged.size === 0;
    elRevert.disabled = staged.size === 0;

    if (staged.size === 0) {
      elStagedCount.textContent = loadedStage
        ? `“${loadedStage.name}” already matches the car.`
        : 'Drag a slider to stage changes.';
    } else {
      const parts = [];
      if (loadedStage) parts.push(`“${loadedStage.name}” loaded`);
      parts.push(`${staged.size} setting${staged.size === 1 ? '' : 's'} staged`);
      const skipped = (loadedStage ? loadedStage.skipped : 0) + (macroSkipped || 0);
      if (skipped) parts.push(`${skipped} skipped (locked or not on this car)`);
      if (loadedStage && loadedStage.warnings.length) parts.push(loadedStage.warnings.join('; '));
      elStagedCount.textContent = `${parts.join(' · ')} — Apply sends it to the car.`;
    }

    // Which sub-tabs hold staged settings? Their buttons glow so an edit on a
    // page you are not looking at cannot slip past.
    const touched = new Set();
    for (const key of staged.keys()) touched.add(GROUPS.classifyKey(key).tab);
    for (const btn of elTabs.children) {
      btn.setAttribute('data-touched', String(touched.has(btn.textContent)));
    }
  }

  function resetMacros() {
    macroClicks.clear();
    for (const { range, clicks } of macroSliders.values()) {
      range.value = '0';
      clicks.textContent = '0';
      clicks.setAttribute('data-active', 'false');
    }
  }

  elApply.addEventListener('click', async () => {
    if (staged.size === 0) return;
    const writes = [...staged].map(([key, value]) => ({ key, value }));
    elApply.disabled = true;
    elStagedCount.textContent = `Applying ${writes.length}…`;
    let res = null;
    try {
      res = await window.apex.setup.writeBatch(writes);
    } catch {
      res = null;
    }
    resetMacros();
    loadedStage = null;
    staged = new Map();
    if (res && res.state && res.state.connected) {
      const okCount = (res.results || []).filter((r) => r.ok).length;
      const skipped = (res.results || []).filter((r) => r.skipped);
      applyState(res.state);
      restage(); // repaints rows, disarms the bar, clears the tab glow
      elStagedCount.textContent =
        `Applied ${okCount} change${okCount === 1 ? '' : 's'}` +
        (skipped.length ? ` · ${skipped.length} skipped` : '');
      setTimeout(() => {
        if (staged.size === 0) elStagedCount.textContent = 'Drag a slider to stage changes.';
      }, 4000);
    } else {
      restage();
      elStagedCount.textContent = 'Apply failed — is the sim still in the garage?';
    }
  });

  elRevert.addEventListener('click', () => {
    resetMacros();
    loadedStage = null;
    restage();
  });

  /* ====================================================================== */
  /*  Info popover                                                          */
  /* ====================================================================== */

  function openInfo(keyOrFamily) {
    const info = INFOAPI.infoFor(keyOrFamily);
    elPopTitle.textContent = info ? info.title : labelFor(keyOrFamily);
    elPopBody.textContent = '';
    const what = document.createElement('p');
    what.textContent = info ? info.what : 'A car-specific setting LMU exposes without further description.';
    elPopBody.appendChild(what);
    if (info && info.effect) {
      const eff = document.createElement('p');
      eff.className = 'su-pop__effect';
      eff.textContent = info.effect;
      elPopBody.appendChild(eff);
    }
    elPop.hidden = false;
  }

  elPopClose.addEventListener('click', () => (elPop.hidden = true));
  elPop.addEventListener('click', (e) => {
    if (e.target === elPop) elPop.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!elPop.hidden) elPop.hidden = true;
    if (!elSavePop.hidden) elSavePop.hidden = true;
    if (!elSharePop.hidden) elSharePop.hidden = true;
    if (!elPubPop.hidden) elPubPop.hidden = true;
    if (!elRatePop.hidden) elRatePop.hidden = true;
  });

  /* ====================================================================== */
  /*  Setup library                                                         */
  /* ====================================================================== */
  /* App-owned .svm archive. Reads/writes go through window.apex.setup.lib*;
   * the list refreshes on tab show and after every mutation — never on a
   * timer, keeping the zero-cost rule intact. */

  const LIB_COLORS = ['', 'red', 'amber', 'green', 'cyan', 'purple', 'pink'];
  let libEntries = [];
  const libFilter = { track: '', carClass: '', session: '', color: null };
  const saveDraft = { session: '', color: '' };
  let shareTarget = null;

  function fmtLap(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const m = Math.floor(ms / 60000);
    const s = ((ms % 60000) / 1000).toFixed(3).padStart(6, '0');
    return `${m}:${s}`;
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
  }

  /** A colour dot button. */
  function colorChip(color, onPick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'su-color';
    b.setAttribute('data-color', color);
    b.title = color || 'no colour';
    b.addEventListener('click', () => onPick(color, b));
    return b;
  }

  function paintChipSelection(container, selected) {
    for (const chip of container.querySelectorAll('.su-color')) {
      chip.setAttribute('data-active', String(chip.getAttribute('data-color') === selected));
    }
  }

  /** A .seg group built from [value, label] pairs. */
  function segGroup(container, options, selected, onPick) {
    container.textContent = '';
    for (const [value, label] of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('data-active', String(value === selected));
      b.addEventListener('click', () => {
        for (const o of container.children) o.setAttribute('data-active', String(o === b));
        onPick(value);
      });
      container.appendChild(b);
    }
  }

  async function refreshLibrary() {
    if (!window.apex || !window.apex.setup || !window.apex.setup.libList) return;
    let res = null;
    try {
      res = await window.apex.setup.libList();
    } catch {
      res = null;
    }
    libEntries = res && res.ok ? res.entries : [];
    renderLibraryFilters();
    renderLibraryList();
  }

  function renderLibraryFilters() {
    const fill = (select, values, allLabel, current) => {
      select.textContent = '';
      const all = document.createElement('option');
      all.value = '';
      all.textContent = allLabel;
      select.appendChild(all);
      for (const v of values) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = v;
        select.appendChild(o);
      }
      select.value = values.includes(current) ? current : '';
    };
    fill(
      elLibTrack,
      [...new Set(libEntries.map((e) => e.trackName || e.trackFolder).filter(Boolean))],
      'All tracks',
      libFilter.track,
    );
    fill(
      elLibCar,
      [...new Set(libEntries.map((e) => e.carClass).filter(Boolean))],
      'All classes',
      libFilter.carClass,
    );
    if (!elLibSession.childElementCount) {
      segGroup(
        elLibSession,
        [['', 'All'], ['race', 'Race'], ['quali', 'Quali']],
        libFilter.session,
        (v) => {
          libFilter.session = v;
          renderLibraryList();
        },
      );
    }
    if (!elLibColors.childElementCount) {
      for (const c of LIB_COLORS.slice(1)) {
        elLibColors.appendChild(
          colorChip(c, (color) => {
            // Clicking the active filter chip clears the filter.
            libFilter.color = libFilter.color === color ? null : color;
            paintChipSelection(elLibColors, libFilter.color ?? '—none—');
            renderLibraryList();
          }),
        );
      }
    }
  }

  function libRow(entry) {
    const li = document.createElement('li');
    li.className = 'su-lib__row';

    // Colour dot — clicking cycles the palette, which IS the categorisation.
    const dot = colorChip(entry.color || '', async () => {
      const next = LIB_COLORS[(LIB_COLORS.indexOf(entry.color || '') + 1) % LIB_COLORS.length];
      entry.color = next;
      dot.setAttribute('data-color', next);
      try {
        await window.apex.setup.libUpdate(entry.id, { color: next });
      } catch {
        /* next list refresh corrects it */
      }
    });
    dot.setAttribute('data-color', entry.color || '');
    li.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'su-lib__name';
    name.textContent = entry.name;
    name.title = [entry.vehicleClass, entry.notes].filter(Boolean).join('\n');
    li.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'su-lib__meta';
    const chips = [
      entry.trackName || entry.trackFolder,
      entry.carClass,
      fmtDate(entry.savedAt),
    ].filter(Boolean);
    for (const text of chips) {
      const c = document.createElement('span');
      c.className = 'su-chip';
      c.textContent = text;
      meta.appendChild(c);
    }
    if (entry.sessionType) {
      const c = document.createElement('span');
      c.className = `su-chip su-chip--${entry.sessionType}`;
      c.textContent = entry.sessionType === 'race' ? 'RACE' : 'QUALI';
      meta.appendChild(c);
    }
    li.appendChild(meta);

    const lap = document.createElement('span');
    lap.className = 'su-lib__lap';
    const best = entry.bestLap && fmtLap(entry.bestLap.lapMs);
    lap.textContent = best || 'no lap';
    lap.setAttribute('data-none', String(!best));
    lap.title = best ? 'Your best clean lap on this track in this class' : 'No clean lap on record yet';
    li.appendChild(lap);

    const buttons = document.createElement('span');
    buttons.className = 'su-lib__buttons';

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'btn btn--accent btn--sm';
    loadBtn.textContent = 'Load';
    const noValues = !entry.values || Object.keys(entry.values).length === 0;
    loadBtn.disabled = !(lastState && lastState.connected) || noValues;
    loadBtn.title = noValues
      ? 'This file could not be read as a setup'
      : loadBtn.disabled
        ? 'Start LMU and enter the garage to load'
        : 'Stage this tune in the editor — Apply sends it to the car';
    loadBtn.addEventListener('click', () => stageLibraryEntry(entry));
    buttons.appendChild(loadBtn);

    // A dedicated "make it public" action, straight to the community publish
    // dialog — distinct from Share, which keeps its several options (copy the
    // file to a teammate, save as a file, or publish). `noValues` is reused from
    // the Load button above: a file we could not parse cannot be published.
    const publicBtn = document.createElement('button');
    publicBtn.type = 'button';
    publicBtn.className = 'btn btn--sm su-lib__public';
    publicBtn.textContent = 'Public';
    publicBtn.disabled = noValues;
    publicBtn.title = noValues
      ? 'This file could not be read as a setup, so it cannot be published'
      : 'Publish this setup to the community board';
    publicBtn.addEventListener('click', () => openPublishPop(entry));
    buttons.appendChild(publicBtn);

    const shareBtn = document.createElement('button');
    shareBtn.type = 'button';
    shareBtn.className = 'btn btn--ghost btn--sm';
    shareBtn.textContent = 'Share';
    shareBtn.title = 'Copy the .svm to a teammate, save it as a file, or publish it';
    shareBtn.addEventListener('click', () => openSharePop(entry));
    buttons.appendChild(shareBtn);

    // Two-step delete: arm, then confirm within 3 s.
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn--ghost btn--sm';
    delBtn.textContent = 'Delete';
    let armTimer = null;
    delBtn.addEventListener('click', async () => {
      if (delBtn.getAttribute('data-armed') !== 'true') {
        delBtn.setAttribute('data-armed', 'true');
        delBtn.textContent = 'Sure?';
        armTimer = setTimeout(() => {
          delBtn.setAttribute('data-armed', 'false');
          delBtn.textContent = 'Delete';
        }, 3000);
        return;
      }
      clearTimeout(armTimer);
      try {
        await window.apex.setup.libDelete(entry.id);
      } catch {
        /* refresh below shows the truth either way */
      }
      void refreshLibrary();
    });
    buttons.appendChild(delBtn);

    li.appendChild(buttons);
    return li;
  }

  function renderLibraryList() {
    const track = elLibTrack.value;
    const carClass = elLibCar.value;
    libFilter.track = track;
    libFilter.carClass = carClass;

    let rows = libEntries.filter(
      (e) =>
        (!track || (e.trackName || e.trackFolder) === track) &&
        (!carClass || e.carClass === carClass) &&
        (!libFilter.session || e.sessionType === libFilter.session) &&
        (libFilter.color === null || e.color === libFilter.color),
    );
    const sort = elLibSort.value;
    if (sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'bestlap') {
      rows.sort((a, b) => (a.bestLap?.lapMs ?? Infinity) - (b.bestLap?.lapMs ?? Infinity));
    } else rows.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));

    elLibList.textContent = '';
    for (const e of rows) elLibList.appendChild(libRow(e));
    elLibEmpty.hidden = libEntries.length > 0;
    if (libEntries.length > 0 && rows.length === 0) {
      elLibEmpty.hidden = false;
      elLibEmpty.textContent = 'Nothing matches these filters.';
    } else if (libEntries.length === 0) {
      elLibEmpty.textContent =
        'Nothing saved yet — get the car how you like it and hit “Save current setup”.';
    }
    updateShareNudge();
  }

  /**
   * The "share your setups" nudge. Shown whenever the driver has saved tunes —
   * the encouragement to put one on the community board. We deliberately do not
   * try to prove a given save is not already public (that needs a per-setup
   * cloud match); the nudge is a gentle prompt, not an accusation, and the
   * Share button on each row is where the actual publish happens.
   */
  function updateShareNudge() {
    if (!elNudge) return;
    const n = libEntries.length;
    elNudge.hidden = n === 0;
    if (n === 0) return;
    elNudgeText.textContent =
      `You have ${n} saved setup${n === 1 ? '' : 's'}. Publishing one puts your name on the ` +
      `community board, earns ratings and downloads, and helps every driver in the league go faster.`;
  }

  elLibTrack.addEventListener('change', renderLibraryList);
  elLibCar.addEventListener('change', renderLibraryList);
  elLibSort.addEventListener('change', renderLibraryList);

  elLibImport.addEventListener('click', async () => {
    try {
      const res = await window.apex.setup.libImport();
      if (res && res.ok) void refreshLibrary();
    } catch {
      /* dialog cancelled or bridge missing — nothing to show */
    }
  });

  /* ---- save dialog -------------------------------------------------------- */

  function openSavePop() {
    if (!lastState || !lastState.connected) return;
    const trackBit = lastState.trackName || '';
    const sess = String(lastState.session || '').toUpperCase();
    saveDraft.session = sess.includes('RACE') ? 'race' : sess.includes('QUAL') ? 'quali' : '';
    saveDraft.color = '';
    elSaveName.value = [trackBit, lastState.carClass, fmtDate(new Date().toISOString())]
      .filter(Boolean)
      .join(' — ');
    segGroup(
      elSaveSession,
      [['', 'Untagged'], ['race', 'Race'], ['quali', 'Quali']],
      saveDraft.session,
      (v) => (saveDraft.session = v),
    );
    if (!elSaveColors.childElementCount) {
      for (const c of LIB_COLORS) {
        elSaveColors.appendChild(
          colorChip(c, (color) => {
            saveDraft.color = color;
            paintChipSelection(elSaveColors, color);
          }),
        );
      }
    }
    paintChipSelection(elSaveColors, saveDraft.color);
    elSaveError.hidden = true;
    elSaveError.textContent = '';
    elSavePop.hidden = false;
    elSaveName.focus();
    elSaveName.select();
  }

  elLibSave.addEventListener('click', openSavePop);
  elSaveCancel.addEventListener('click', () => (elSavePop.hidden = true));
  elSavePop.addEventListener('click', (e) => {
    if (e.target === elSavePop) elSavePop.hidden = true;
  });

  elSaveConfirm.addEventListener('click', async () => {
    elSaveConfirm.disabled = true;
    let res = null;
    try {
      res = await window.apex.setup.libSave({
        name: elSaveName.value,
        sessionType: saveDraft.session,
        color: saveDraft.color,
      });
    } catch {
      res = null;
    }
    elSaveConfirm.disabled = false;
    if (res && res.ok) {
      elSavePop.hidden = true;
      void refreshLibrary();
    } else {
      // The message stays until the dialog closes — a 2.5s tooltip cost us a
      // whole diagnosis round-trip with a tester once.
      elSaveError.textContent =
        'Save failed — ' + ((res && res.error) || 'is the sim still in the garage?');
      elSaveError.hidden = false;
      elSaveConfirm.textContent = 'Failed';
      setTimeout(() => {
        elSaveConfirm.textContent = 'Save';
      }, 2500);
    }
  });

  /* ---- loading = staging ----------------------------------------------------
   *
   * Load does NOT write to the sim. It stages the tune's values in the editor
   * (rows preview old → new, the touched tabs glow, Apply arms and pulses),
   * and Apply sends them key-by-key — the one write path that provably
   * repaints LMU's own setup screen. The API's whole-file load was tried and
   * dropped: it changes the garage state but the game's setup menu never
   * repaints for an external load, which reads as "nothing happened".
   */

  function stageLibraryEntry(entry) {
    if (!lastState || !lastState.connected || !entry.values) return;
    resetMacros();
    const values = new Map();
    let skipped = 0;
    for (const [key, raw] of Object.entries(entry.values)) {
      const s = settingsMap.get(key);
      if (!s || !s.available || !s.isFree || s.min >= s.max) {
        skipped += 1;
        continue;
      }
      values.set(key, Math.min(s.max, Math.max(s.min, raw)));
    }
    const warnings = [];
    if (entry.carClass && lastState.carClass && entry.carClass !== lastState.carClass) {
      warnings.push(`saved for ${entry.carClass}, this car is ${lastState.carClass}`);
    }
    if (entry.trackName && lastState.trackName && entry.trackName !== lastState.trackName) {
      warnings.push(`saved at ${entry.trackName}`);
    }
    loadedStage = { name: entry.name, values, skipped, warnings };
    restage();
  }

  /* ---- share dialog ---------------------------------------------------------- */

  function openSharePop(entry) {
    shareTarget = entry;
    elShareText.textContent =
      `“${entry.name}” as a .svm file — any LMU driver can use it, with or without this app.`;
    elShareCopy.textContent = 'Copy file — paste into Discord / WhatsApp';
    elShareCopy.disabled = false;
    elSharePop.hidden = false;
  }

  elShareCancel.addEventListener('click', () => (elSharePop.hidden = true));
  elSharePop.addEventListener('click', (e) => {
    if (e.target === elSharePop) elSharePop.hidden = true;
  });

  elShareCopy.addEventListener('click', async () => {
    if (!shareTarget) return;
    elShareCopy.disabled = true;
    let res = null;
    try {
      res = await window.apex.setup.libClip(shareTarget.id);
    } catch {
      res = null;
    }
    elShareCopy.disabled = false;
    if (res && res.ok) {
      elShareCopy.textContent = 'Copied — paste into the chat with Ctrl+V';
    } else {
      elShareCopy.textContent = 'Copy failed — use “Save as file…” instead';
    }
  });

  elShareFile.addEventListener('click', async () => {
    if (!shareTarget) return;
    try {
      const res = await window.apex.setup.libExport(shareTarget.id);
      if (res && res.ok) elSharePop.hidden = true;
    } catch {
      /* dialog cancelled */
    }
  });

  /* ====================================================================== */
  /*  Community setups                                                      */
  /* ====================================================================== */
  /* The cloud half of the library. One read per tab show (plus Refresh and
   * after any mutation) — the zero-cost-when-closed rule holds. Rows are
   * filtered and sorted locally; in follow mode, with the sim connected, the
   * list shows ONLY what was published for the exact car and track the driver
   * is sitting in — a class-mate's tune does not load onto a different car,
   * so matching the car (not the class) is what makes the list usable. */

  const comFollowing = () =>
    elComFollow.checked &&
    Boolean(lastState && lastState.connected && (lastState.trackName || lastState.trackFolder));

  /** What follow mode is currently locked onto; '' when it is not following. */
  const comFollowKey = () =>
    comFollowing()
      ? [lastState.trackFolder || '', lastState.trackName || '', lastState.car || ''].join('|')
      : '';
  let comShownFollowKey = null; // last key painted, so a car/track change repaints

  try {
    elComFollow.checked = localStorage.getItem(COM_FOLLOW_KEY) !== 'off';
  } catch {
    /* storage disabled — default stays on */
  }

  async function refreshCommunity() {
    if (!window.apex || !window.apex.setup || !window.apex.setup.cloudList) return;
    const req = ++comRequest;
    let res = null;
    try {
      res = await window.apex.setup.cloudList();
    } catch {
      res = null;
    }
    if (req !== comRequest) return; // a newer refresh superseded this one
    if (res && res.ok) {
      comRows = res.rows || [];
      comState = 'ok';
    } else {
      comRows = [];
      comState = res && res.signedOut ? 'signedOut' : 'error';
      comError = (res && res.error) || 'Community unavailable.';
    }
    renderCommunityFilters();
    renderCommunityList();
  }

  function renderCommunityFilters() {
    const fill = (select, values, allLabel, current) => {
      select.textContent = '';
      const all = document.createElement('option');
      all.value = '';
      all.textContent = allLabel;
      select.appendChild(all);
      for (const v of values) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = v;
        select.appendChild(o);
      }
      select.value = values.includes(current) ? current : '';
    };
    fill(
      elComTrack,
      [...new Set(comRows.map((r) => r.trackName || r.trackFolder).filter(Boolean))],
      'All tracks',
      elComTrack.value,
    );
    fill(
      elComCar,
      [...new Set(comRows.map((r) => r.car).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
      'All cars',
      elComCar.value,
    );
    fill(
      elComClass,
      [...new Set(comRows.map((r) => r.carClass).filter(Boolean))],
      'All classes',
      elComClass.value,
    );
  }

  /** Five glyphs beat "★ 4.2": the shape of a rating reads before the number,
   *  and an unrated row reads as five empty stars rather than a word. */
  function starsEl(row) {
    const stars = document.createElement('span');
    stars.className = 'su-com__stars';
    stars.setAttribute('data-none', String(!row.ratingCount));
    const avg = row.ratingCount ? Number(row.avgStars) : 0;
    const glyphs = document.createElement('span');
    glyphs.className = 'su-com__glyphs';
    for (let i = 1; i <= 5; i += 1) {
      const s = document.createElement('span');
      s.className = 'su-com__star';
      // Round half up, so 4.2 lights four and 4.6 lights five.
      s.setAttribute('data-lit', String(row.ratingCount > 0 && avg >= i - 0.5));
      s.textContent = '★';
      glyphs.appendChild(s);
    }
    stars.appendChild(glyphs);
    const num = document.createElement('span');
    num.className = 'su-com__starnum';
    num.textContent = row.ratingCount ? `${avg.toFixed(1)} (${row.ratingCount})` : 'unrated';
    stars.appendChild(num);
    const ratersOnSetup = fmtLap(row.ratersBestOnSetupMs);
    const ratersBest = fmtLap(row.ratersBestMs);
    stars.title =
      (row.ratingCount
        ? `${row.ratingCount} rating${row.ratingCount === 1 ? '' : 's'} from drivers who downloaded it`
        : 'No ratings yet — nobody who downloaded it has scored it') +
      (ratersOnSetup
        ? ` · fastest rater on this setup: ${ratersOnSetup} ✓`
        : ratersBest
          ? ` · fastest rater (any setup): ${ratersBest}`
          : '');
    return stars;
  }

  /* Laps only compare inside one track and one class — a delta across either is
   * a lie. This is the key both the delta chip and the Recommended sort group
   * by, and the folder is preferred because two layouts share a track name. */
  const comPaceKey = (r) =>
    `${String(r.trackFolder || r.trackName || '').toLowerCase()}|${String(r.carClass || '').toLowerCase()}`;

  /** Saved tunes are auto-named "<track> — <class> — <date>", and the track
   *  half is both the longest and the one part every row on a filtered board
   *  repeats. Drop that one segment — the chip or the pinned filter already
   *  says it — and leave everything else, which is what tells two rows apart.
   *  A hand-typed name has no track segment and comes back untouched. */
  function comShortName(row) {
    const full = String(row.name || '').trim();
    const track = [row.trackName, row.trackFolder]
      .filter(Boolean)
      .map((v) => String(v).trim().toLowerCase());
    if (track.length) {
      const parts = full.split(/\s+[—–]\s+/).filter((p) => p.trim());
      if (parts.length > 1) {
        const kept = parts.filter((p) => !track.includes(p.trim().toLowerCase()));
        if (kept.length) return kept.join(' — ');
      }
    }
    return full || 'Untitled setup';
  }

  /** How well a row answers "would this one be good for me?" — the Recommended
   *  sort. Weighed the way a driver would: a lap actually proven on this setup
   *  first, then how close that lap is to the quickest one on the board, then
   *  what raters thought (discounted while there are only one or two of them),
   *  and last how many people took it. */
  function comScore(row, paceRef) {
    let s = 0;
    if (Number.isFinite(row.bestLapMs) && row.bestLapMs > 0 && row.bestLapOnSetup) {
      s += 2;
      const ref = paceRef.get(comPaceKey(row));
      if (ref) s += 3 * Math.max(0, 1 - (row.bestLapMs - ref) / 5000); // 5 s adrift = no pace credit
    }
    if (row.ratingCount) {
      s += 2.5 * (Number(row.avgStars) / 5) * (row.ratingCount / (row.ratingCount + 2));
    }
    s += Math.min(1, Math.log10(1 + (row.downloads || 0)) / 2);
    return s;
  }

  function communityRow(row, ctx) {
    const li = document.createElement('li');
    li.className = 'su-lib__row su-com__row';

    const who = document.createElement('span');
    who.className = 'su-com__who';
    const name = document.createElement('span');
    name.className = 'su-com__title';
    name.textContent = comShortName(row);
    name.title = row.name || '';
    who.appendChild(name);
    const by = document.createElement('span');
    by.className = 'su-com__owner';
    // Downloads belong with the author, not with the rating: both are "how much
    // has this been trusted by other people", and the pace column stays pace.
    by.textContent =
      (row.mine ? 'by you' : `by ${row.ownerName}`) +
      (row.downloads ? ` · ${row.downloads} download${row.downloads === 1 ? '' : 's'}` : '');
    by.title = by.textContent;
    who.appendChild(by);
    li.appendChild(who);

    const meta = document.createElement('span');
    meta.className = 'su-lib__meta';
    // The car earns its chip: a tune is for one car, and the class alone does
    // not say which — it is the first thing to check before downloading. But a
    // filter (or follow mode) that has already pinned one makes its chip pure
    // repetition on every row, so it is dropped rather than shown fifteen times.
    // The class survives in most auto-names once the track is stripped, so its
    // chip would print the same word twice on one row; the headline wins.
    const titleSaysClass =
      row.carClass &&
      name.textContent
        .split(/\s+[—–]\s+/)
        .some((p) => p.trim().toLowerCase() === String(row.carClass).toLowerCase());
    const chips = [
      ctx.hideTrack ? '' : row.trackName || row.trackFolder,
      ctx.hideCar ? '' : row.car,
      titleSaysClass ? '' : row.carClass,
    ].filter(Boolean);
    for (const text of chips) {
      const c = document.createElement('span');
      c.className = 'su-chip su-chip--id';
      c.textContent = text;
      meta.appendChild(c);
    }
    if (row.sessionType) {
      const c = document.createElement('span');
      c.className = `su-chip su-chip--${row.sessionType}`;
      c.textContent = row.sessionType === 'race' ? 'RACE' : 'QUALI';
      meta.appendChild(c);
    }
    // The handling tags are the only thing on the row that answers "will this
    // suit the way I drive", so they lead their own line rather than queueing
    // behind the identity chips.
    const tags = row.tags || [];
    if (tags.length) {
      const traits = document.createElement('span');
      traits.className = 'su-com__traits';
      traits.title = 'How the uploader describes the way it drives';
      for (const tag of tags) {
        const c = document.createElement('span');
        c.className = 'su-chip su-chip--tag';
        c.textContent = tag;
        traits.appendChild(c);
      }
      meta.appendChild(traits);
    }
    if (row.notes) {
      const noteLine = document.createElement('span');
      noteLine.className = 'su-com__notes';
      noteLine.textContent = row.notes;
      noteLine.title = row.notes;
      meta.appendChild(noteLine);
    }
    li.appendChild(meta);

    // Pace column: the uploader's verified lap, how far off the board's best it
    // is, and the community's verdict — the three numbers a download rests on.
    const lap = document.createElement('span');
    lap.className = 'su-lib__lap su-com__lap';
    const best = fmtLap(row.bestLapMs);
    const maker = document.createElement('span');
    // The ✓ is attribution: the uploader's lap log proves this time was driven
    // on THIS setup (fingerprint match), not merely at this track in this class.
    maker.className = 'su-com__time';
    maker.textContent = best ? (row.bestLapOnSetup ? `${best} ✓` : best) : 'no lap';
    maker.setAttribute('data-none', String(!best));
    maker.setAttribute('data-onsetup', String(Boolean(best && row.bestLapOnSetup)));
    maker.title = best
      ? row.bestLapOnSetup
        ? `${row.mine ? 'Your' : `${row.ownerName}'s`} best clean lap driven on this exact setup — verified`
        : `${row.mine ? 'Your' : `${row.ownerName}'s`} best clean lap for this track & class — not proven on this setup`
      : 'The uploader had no clean lap on record';
    lap.appendChild(maker);

    // A bare 2:05.032 says nothing on its own; against the quickest verified
    // setup for the same car class and track it says everything. Only verified
    // laps take part, on both sides — comparing a proven lap with an unproven
    // one would invent a gap that nobody drove.
    const ref = ctx.paceRef.get(comPaceKey(row));
    if (best && row.bestLapOnSetup && ref && (ctx.paceCount.get(comPaceKey(row)) || 0) > 1) {
      const gap = row.bestLapMs - ref;
      const delta = document.createElement('span');
      delta.className = 'su-com__delta';
      delta.setAttribute('data-best', String(gap <= 0));
      delta.textContent = gap <= 0 ? 'FASTEST' : `+${(gap / 1000).toFixed(3)}`;
      delta.title =
        gap <= 0
          ? 'Quickest verified lap of any setup shared here for this car class and track'
          : `${(gap / 1000).toFixed(3)}s off the quickest verified setup shared here`;
      lap.appendChild(delta);
    }

    lap.appendChild(starsEl(row));
    li.appendChild(lap);

    const buttons = document.createElement('span');
    buttons.className = 'su-lib__buttons';

    const getBtn = document.createElement('button');
    getBtn.type = 'button';
    // Accent is reserved for setups the driver has not tried. A row already in
    // the library is not the one to click, so it stops shouting for the click.
    getBtn.className = `btn btn--sm ${row.downloaded ? 'btn--ghost' : 'btn--accent'}`;
    getBtn.textContent = row.downloaded ? 'Get again' : 'Get';
    getBtn.title = 'Download into the game’s setup screen and your library';
    getBtn.addEventListener('click', async () => {
      getBtn.disabled = true;
      getBtn.textContent = '…';
      let res = null;
      try {
        res = await window.apex.setup.cloudDownload(row.id);
      } catch {
        res = null;
      }
      if (res && res.ok) {
        if (!row.downloaded && !row.mine) row.downloads += 1;
        row.downloaded = true;
        getBtn.textContent = res.inGame ? 'In the game ✓' : 'In library ✓';
        getBtn.title = res.inGame
          ? 'Saved into LMU’s setup folder — load it from the game’s setup screen'
          : 'LMU install not found — saved to your library only';
        void refreshLibrary();
        renderCommunityList();
      } else {
        getBtn.disabled = false;
        getBtn.textContent = 'Failed';
        getBtn.title = (res && res.error) || 'Download failed.';
        setTimeout(() => (getBtn.textContent = row.downloaded ? 'Get again' : 'Get'), 2500);
      }
    });
    buttons.appendChild(getBtn);

    if (row.mine) {
      // Two-step unpublish, same idiom as library delete. Local copies stay.
      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'btn btn--ghost btn--sm';
      rmBtn.textContent = 'Unpublish';
      rmBtn.title = 'Take it off the community list — your local files stay';
      let armTimer = null;
      rmBtn.addEventListener('click', async () => {
        if (rmBtn.getAttribute('data-armed') !== 'true') {
          rmBtn.setAttribute('data-armed', 'true');
          rmBtn.textContent = 'Sure?';
          armTimer = setTimeout(() => {
            rmBtn.setAttribute('data-armed', 'false');
            rmBtn.textContent = 'Unpublish';
          }, 3000);
          return;
        }
        clearTimeout(armTimer);
        try {
          await window.apex.setup.cloudUnpublish(row.id);
        } catch {
          /* refresh shows the truth */
        }
        void refreshCommunity();
      });
      buttons.appendChild(rmBtn);
    } else {
      const rateBtn = document.createElement('button');
      rateBtn.type = 'button';
      rateBtn.className = 'btn btn--ghost btn--sm';
      rateBtn.textContent = row.myStars ? `★ ${row.myStars}` : 'Rate';
      rateBtn.disabled = !row.downloaded;
      rateBtn.title = row.downloaded
        ? row.myStars
          ? 'Change your rating'
          : 'Score it — how good is it really?'
        : 'Download it first — only drivers who tried a setup can rate it';
      rateBtn.addEventListener('click', () => openRatePop(row));
      buttons.appendChild(rateBtn);
    }

    li.appendChild(buttons);
    return li;
  }

  function renderCommunityList() {
    const following = comFollowing();
    comShownFollowKey = comFollowKey();
    elComTrack.disabled = following;
    elComCar.disabled = following;
    elComClass.disabled = following;
    if (following) {
      // The selects display exactly what follow mode locked onto — the track
      // and the car. Class is left on "All": with the car pinned it can only
      // hide matching rows whose class string was written differently.
      const track = lastState.trackName || lastState.trackFolder || '';
      const car = lastState.car || '';
      const pin = (select, value) => {
        if (value && ![...select.options].some((o) => o.value === value)) {
          const o = document.createElement('option');
          o.value = value;
          o.textContent = value;
          select.appendChild(o);
        }
        select.value = value;
      };
      pin(elComTrack, track);
      pin(elComCar, car);
      elComClass.value = '';
    }

    if (comState !== 'ok') {
      elComList.textContent = '';
      elComEmpty.hidden = false;
      elComEmpty.textContent =
        comState === 'loading'
          ? 'Loading community setups…'
          : comState === 'signedOut'
            ? 'Sign in (Account tab) to browse and share community setups.'
            : comError;
      return;
    }

    const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
    let rows;
    if (following) {
      // The sim's own Settings folder is the authoritative track identity —
      // two layouts of one circuit share a name but never a folder. Rows
      // published before the folder was recorded fall back to the name.
      const folder = lastState.trackFolder || '';
      const trackName = lastState.trackName || '';
      const car = lastState.car || '';
      const cls = lastState.carClass || '';
      rows = comRows.filter((r) => {
        const sameTrack =
          folder && r.trackFolder
            ? eq(r.trackFolder, folder)
            : eq(r.trackName || r.trackFolder, trackName || folder);
        if (!sameTrack) return false;
        if (!car) return true;
        // A row that never recorded its car (an imported file) is judged on
        // class instead of being dropped from a list it may well belong in.
        return r.car ? eq(r.car, car) : !cls || eq(r.carClass, cls);
      });
    } else {
      const track = elComTrack.value;
      const car = elComCar.value;
      const cls = elComClass.value;
      rows = comRows.filter(
        (r) =>
          (!track || eq(r.trackName || r.trackFolder, track)) &&
          (!car || eq(r.car, car)) &&
          (!cls || eq(r.carClass, cls)),
      );
    }
    // The pace yardstick, per track+class, taken only from laps proven on the
    // setup that claims them. Built from what is on screen, so filtering the
    // list re-bases the deltas onto the setups the driver is choosing between.
    const paceRef = new Map();
    const paceCount = new Map();
    for (const r of rows) {
      if (!r.bestLapOnSetup || !Number.isFinite(r.bestLapMs) || r.bestLapMs <= 0) continue;
      const k = comPaceKey(r);
      const cur = paceRef.get(k);
      if (cur === undefined || r.bestLapMs < cur) paceRef.set(k, r.bestLapMs);
      paceCount.set(k, (paceCount.get(k) || 0) + 1);
    }

    const sort = elComSort.value;
    if (sort === 'stars') {
      rows.sort((a, b) => (b.avgStars ?? -1) - (a.avgStars ?? -1) || b.ratingCount - a.ratingCount);
    } else if (sort === 'downloads') rows.sort((a, b) => b.downloads - a.downloads);
    else if (sort === 'bestlap') {
      rows.sort((a, b) => (a.bestLapMs ?? Infinity) - (b.bestLapMs ?? Infinity));
    } else if (sort === 'newest') {
      rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    } else {
      // Recommended, the default: proven pace, then ratings, then reach, with
      // the newest breaking a tie so a fresh upload is not buried for ever.
      rows.sort(
        (a, b) =>
          comScore(b, paceRef) - comScore(a, paceRef) || (a.createdAt < b.createdAt ? 1 : -1),
      );
    }

    const ctx = {
      paceRef,
      paceCount,
      hideTrack: Boolean(elComTrack.value),
      hideCar: Boolean(elComCar.value),
    };
    elComList.textContent = '';
    for (const r of rows) elComList.appendChild(communityRow(r, ctx));

    if (rows.length > 0) {
      elComEmpty.hidden = true;
    } else {
      elComEmpty.hidden = false;
      elComEmpty.textContent =
        comRows.length === 0
          ? 'Nothing shared yet — be the first: Share a saved setup, then “Publish to the community”.'
          : following
            ? `Nothing shared for ${lastState.car || 'this car'} at ${lastState.trackName || lastState.trackFolder} yet — you could be first, or untick “Follow my car & track” to browse everything.`
            : 'Nothing matches these filters.';
    }
  }

  elComTrack.addEventListener('change', renderCommunityList);
  elComCar.addEventListener('change', renderCommunityList);
  elComClass.addEventListener('change', renderCommunityList);
  elComSort.addEventListener('change', renderCommunityList);
  elComRefresh.addEventListener('click', () => void refreshCommunity());
  elComFollow.addEventListener('change', () => {
    try {
      localStorage.setItem(COM_FOLLOW_KEY, elComFollow.checked ? 'on' : 'off');
    } catch {
      /* storage disabled */
    }
    renderCommunityList();
  });

  /* ---- share nudge --------------------------------------------------------- */

  // The nudge's CTA opens the share dialog for the newest saved setup, which is
  // the shortest path to "Publish to the community…".
  if (elNudgeShare) {
    elNudgeShare.addEventListener('click', () => {
      if (!libEntries.length) return;
      const byNewest = [...libEntries].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
      // The nudge is about going PUBLIC, so jump straight to the community
      // publish dialog for the newest tune we can actually publish; fall back to
      // the multi-option share menu only when none have parsed values.
      const publishable = byNewest.find((e) => e.values && Object.keys(e.values).length > 0);
      if (publishable) openPublishPop(publishable);
      else openSharePop(byNewest[0]);
    });
  }

  /* ---- setups feedback dialog ---------------------------------------------- */

  // Feedback about the setups feature, routed to the same league inbox the
  // Suggestions tab uses. Tagged "[Setups]" so it is triageable in context.
  let feedbackKind = 'idea';

  function openFeedbackPop() {
    feedbackKind = 'idea';
    if (elFbKind && !elFbKind.childElementCount) {
      segGroup(
        elFbKind,
        [['idea', 'Idea'], ['bug', 'Problem']],
        feedbackKind,
        (v) => (feedbackKind = v),
      );
    }
    elFbMessage.value = '';
    elFbStatus.hidden = true;
    elFbStatus.textContent = '';
    elFbSend.disabled = false;
    elFbSend.textContent = 'Send';
    elFbPop.hidden = false;
    elFbMessage.focus();
  }

  if (elComFeedback) elComFeedback.addEventListener('click', openFeedbackPop);
  if (elFbCancel) elFbCancel.addEventListener('click', () => (elFbPop.hidden = true));
  if (elFbPop) {
    elFbPop.addEventListener('click', (e) => {
      if (e.target === elFbPop) elFbPop.hidden = true;
    });
  }
  if (elFbSend) {
    elFbSend.addEventListener('click', async () => {
      const msg = (elFbMessage.value || '').trim();
      if (!msg) {
        elFbStatus.textContent = 'Type a message first.';
        elFbStatus.hidden = false;
        elFbMessage.focus();
        return;
      }
      elFbSend.disabled = true;
      elFbSend.textContent = 'Sending…';
      elFbStatus.hidden = true;
      let res = null;
      try {
        res = await window.apex.feedback.submit({ kind: feedbackKind, message: `[Setups] ${msg}` });
      } catch {
        res = null;
      }
      if (res && res.ok) {
        elFbPop.hidden = true;
        return;
      }
      elFbSend.disabled = false;
      elFbSend.textContent = 'Failed — retry';
      elFbStatus.textContent =
        (res && res.error) ||
        (res && res.signedOut ? 'Sign in to send feedback.' : 'Could not send — try again.');
      elFbStatus.hidden = false;
    });
  }

  /* ---- publish dialog ------------------------------------------------------ */

  function paintPubTags() {
    elPubTags.textContent = '';
    for (const tag of TAGAPI.PRESETS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'su-tag';
      b.textContent = tag;
      b.setAttribute('data-active', String(pubTags.has(tag)));
      b.addEventListener('click', () => {
        if (pubTags.has(tag)) pubTags.delete(tag);
        else if (pubTags.size < 8) pubTags.add(tag);
        b.setAttribute('data-active', String(pubTags.has(tag)));
      });
      elPubTags.appendChild(b);
    }
  }

  function openPublishPop(entry) {
    pubTarget = entry;
    elPubName.value = entry.name;
    elPubNotes.value = entry.notes || '';

    // Auto-suggest character tags from the tune — honest only when the same
    // car is in the garage (the bounds are the car's own). Otherwise the
    // uploader picks by hand.
    const canSuggest =
      lastState &&
      lastState.connected &&
      entry.values &&
      (!entry.carClass || !lastState.carClass || entry.carClass === lastState.carClass);
    const suggested = canSuggest ? TAGAPI.suggest(entry.values, settingsMap) : [];
    pubTags = new Set(suggested);
    paintPubTags();
    elPubTagHint.textContent = suggested.length
      ? 'Suggested from the setup’s own values — tap to adjust before publishing.'
      : canSuggest
        ? 'Pick the chips that match how it drives.'
        : 'Start LMU with this car in the garage for automatic suggestions — or pick by hand.';

    const best = entry.bestLap && fmtLap(entry.bestLap.lapMs);
    elPubLap.textContent = best
      ? `Verified lap attached: ${best} — marked “driven on this setup” automatically when your lap log proves it.`
      : 'No clean lap on record for this track & class — it publishes without a time.';
    elPubLap.setAttribute('data-none', String(!best));

    elPubConfirm.disabled = false;
    elPubConfirm.textContent = 'Publish';
    elSharePop.hidden = true;
    elPubPop.hidden = false;
    elPubName.focus();
  }

  elSharePublish.addEventListener('click', () => {
    if (shareTarget) openPublishPop(shareTarget);
  });
  elPubCancel.addEventListener('click', () => (elPubPop.hidden = true));
  elPubPop.addEventListener('click', (e) => {
    if (e.target === elPubPop) elPubPop.hidden = true;
  });

  elPubConfirm.addEventListener('click', async () => {
    if (!pubTarget) return;
    elPubConfirm.disabled = true;
    elPubConfirm.textContent = 'Publishing…';
    let res = null;
    try {
      res = await window.apex.setup.cloudPublish({
        id: pubTarget.id,
        name: elPubName.value,
        notes: elPubNotes.value,
        tags: [...pubTags],
      });
    } catch {
      res = null;
    }
    if (res && res.ok) {
      elPubPop.hidden = true;
      void refreshCommunity();
    } else {
      elPubConfirm.disabled = false;
      elPubConfirm.textContent = 'Failed — retry';
      elPubConfirm.title = (res && res.error) || 'Publish failed.';
      elPubTagHint.textContent = (res && res.error) || 'Publish failed.';
    }
  });

  /* ---- rate dialog --------------------------------------------------------- */

  function openRatePop(row) {
    rateTarget = row;
    elRateText.textContent = `“${row.name}” by ${row.ownerName} — how good is it really?`;
    elRateStars.textContent = '';
    for (let n = 1; n <= 5; n++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'su-star';
      b.textContent = '★';
      b.setAttribute('aria-label', `${n} star${n === 1 ? '' : 's'}`);
      b.setAttribute('data-lit', String(Boolean(row.myStars && n <= row.myStars)));
      b.addEventListener('mouseenter', () => {
        for (let i = 0; i < 5; i++) {
          elRateStars.children[i].setAttribute('data-lit', String(i < n));
        }
      });
      b.addEventListener('click', () => void submitRating(n));
      elRateStars.appendChild(b);
    }
    elRatePop.hidden = false;
  }

  // One listener for the popover's lifetime — openRatePop rebuilds only the
  // star buttons, so binding here would stack a copy per open.
  elRateStars.addEventListener('mouseleave', () => {
    for (let i = 0; i < elRateStars.children.length; i++) {
      elRateStars.children[i].setAttribute(
        'data-lit',
        String(Boolean(rateTarget && rateTarget.myStars && i < rateTarget.myStars)),
      );
    }
  });

  async function submitRating(stars) {
    if (!rateTarget) return;
    const row = rateTarget;
    let res = null;
    try {
      res = await window.apex.setup.cloudRate({
        id: row.id,
        stars,
        trackName: row.trackName || '',
        carClass: row.carClass || '',
        fingerprint: row.fingerprint || '',
      });
    } catch {
      res = null;
    }
    elRatePop.hidden = true;
    if (res && res.ok) {
      row.myStars = stars;
      row.avgStars = res.avgStars;
      row.ratingCount = res.ratingCount;
      renderCommunityList();
    } else {
      elComEmpty.hidden = false;
      elComEmpty.textContent = (res && res.error) || 'Rating failed.';
      setTimeout(() => renderCommunityList(), 3000);
    }
  }

  elRateCancel.addEventListener('click', () => (elRatePop.hidden = true));
  elRatePop.addEventListener('click', (e) => {
    if (e.target === elRatePop) elRatePop.hidden = true;
  });

  /* ====================================================================== */
  /*  Car card                                                              */
  /* ====================================================================== */
  /* A still image, hide/show only. The preference keeps the key the live 3D
   * view used, so anyone who hid the old canvas keeps their choice when (if)
   * the wireframe returns. */

  function canvasCollapsed() {
    return localStorage.getItem(THREE_D_PREF_KEY) === 'off';
  }

  function paintCarToggle() {
    const off = canvasCollapsed();
    el3dToggle.textContent = off ? 'Show' : 'Hide';
    elCanvasWrap.setAttribute('data-collapsed', String(off));
  }

  el3dToggle.addEventListener('click', () => {
    const off = !canvasCollapsed();
    try {
      localStorage.setItem(THREE_D_PREF_KEY, off ? 'off' : 'on');
    } catch {
      /* storage disabled */
    }
    paintCarToggle();
  });

  paintCarToggle();
})();
