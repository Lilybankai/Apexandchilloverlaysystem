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

  /* ---- static frame ------------------------------------------------------ */

  const view = document.querySelector('[data-view="setups"]');
  const elStatus = $('#setup-status');
  const elCar = $('#setup-car');
  const elClass = $('#setup-class');
  const elSym = $('#setup-sym');
  const elOffline = $('#setup-offline');
  const elBody = $('#setup-body');
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
  const elSharePop = $('#setup-share-pop');
  const elShareText = $('#setup-share-text');
  const elShareCopy = $('#setup-share-copy');
  const elShareFile = $('#setup-share-file');
  const elShareCancel = $('#setup-share-cancel');

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

  /* ====================================================================== */
  /*  Lifecycle                                                             */
  /* ====================================================================== */

  function shown() {
    if (active) return;
    if (document.visibilityState !== 'visible') return; // visibilitychange will call back
    active = true;
    schedulePoll(0);
    void refreshLibrary(); // one read per show, never on a timer
  }

  function hidden() {
    active = false;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
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
    writesFrozen = false;
    failedWrites = 0;
    elLibSave.disabled = true;
    if (wasConnected) renderLibraryList(); // Load buttons pick up the new state
  }

  function applyState(state) {
    const firstPaint = !lastState || !lastState.connected;
    lastState = state;
    elLibSave.disabled = false;
    if (firstPaint) renderLibraryList(); // arm the Load buttons

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

    const shareBtn = document.createElement('button');
    shareBtn.type = 'button';
    shareBtn.className = 'btn btn--ghost btn--sm';
    shareBtn.textContent = 'Share';
    shareBtn.title = 'Send the .svm to a teammate';
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
      elSaveConfirm.textContent = res && res.error ? 'Failed' : 'Failed — in garage?';
      elSaveConfirm.title = (res && res.error) || '';
      setTimeout(() => {
        elSaveConfirm.textContent = 'Save';
        elSaveConfirm.title = '';
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
