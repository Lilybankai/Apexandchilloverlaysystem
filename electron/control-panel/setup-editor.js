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
 * THE RESOURCE RULE — this tab costs nothing while closed. The only timer and
 * the only animation frame in the whole panel live here, and both run solely
 * while (a) the setups view is the active tab AND (b) the document is visible.
 * The tab router calls window.apexSetup.shown()/hidden() on every switch;
 * visibilitychange covers the minimised window. There is no other entry point.
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
  let staged = new Map(); // key -> target value (macro preview overlay)
  let writesFrozen = false;
  let failedWrites = 0;

  // 3D scene — lazy-loaded on first show, optional forever after.
  let scene = null;
  let sceneLoading = false;
  const THREE_D_PREF_KEY = 'apex.setup.3d';

  /* ====================================================================== */
  /*  Lifecycle                                                             */
  /* ====================================================================== */

  function shown() {
    if (active) return;
    if (document.visibilityState !== 'visible') return; // visibilitychange will call back
    active = true;
    schedulePoll(0);
    ensureScene();
    if (scene && !canvasCollapsed()) scene.start();
  }

  function hidden() {
    active = false;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (scene) scene.stop();
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
  }

  function applyState(state) {
    const firstPaint = !lastState || !lastState.connected;
    lastState = state;
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

    if (scene) scene.applySetup(settingsMap, staged);
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
        if (scene) scene.applySetup(settingsMap, staged);
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
   * Recomputes the whole staged overlay from the BASE values plus every macro
   * at its current clicks, in panel order. Recomputing from scratch (rather
   * than nudging) keeps staging deterministic: dragging a macro to +3 and back
   * to 0 stages exactly nothing.
   */
  function restage() {
    staged = new Map();
    if (!lastState || !lastState.connected) return;
    const carClass = lastState.carClass || '';

    // Effective view: base values with earlier macros' staging applied.
    const effective = new Map();
    for (const [key, s] of settingsMap) {
      effective.set(key, { value: s.value, min: s.min, max: s.max, isFree: s.isFree, available: s.available });
    }

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
    elStaged.hidden = staged.size === 0;
    if (staged.size > 0) {
      elStagedCount.textContent =
        `${staged.size} setting${staged.size === 1 ? '' : 's'} staged` +
        (skippedCount ? ` · ${skippedCount} skipped (locked or not on this car)` : '');
    }
    if (scene) scene.applySetup(settingsMap, staged);
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
    elApply.disabled = false;
    resetMacros();
    staged = new Map();
    if (res && res.state && res.state.connected) {
      const okCount = (res.results || []).filter((r) => r.ok).length;
      const skipped = (res.results || []).filter((r) => r.skipped);
      applyState(res.state);
      elStaged.hidden = false;
      elStagedCount.textContent =
        `Applied ${okCount} change${okCount === 1 ? '' : 's'}` +
        (skipped.length ? ` · ${skipped.length} skipped` : '');
      setTimeout(() => {
        if (staged.size === 0) elStaged.hidden = true;
      }, 4000);
    } else {
      elStaged.hidden = false;
      elStagedCount.textContent = 'Apply failed — is the sim still in the garage?';
      restage();
    }
  });

  elRevert.addEventListener('click', () => {
    resetMacros();
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
    if (e.key === 'Escape' && !elPop.hidden) elPop.hidden = true;
  });

  /* ====================================================================== */
  /*  3D scene (lazy, optional)                                             */
  /* ====================================================================== */

  function canvasCollapsed() {
    return localStorage.getItem(THREE_D_PREF_KEY) === 'off';
  }

  function paint3dToggle() {
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
    paint3dToggle();
    if (scene) {
      if (off) scene.stop();
      else if (active) {
        scene.start();
        if (lastState) scene.applySetup(settingsMap, staged);
      }
    } else if (!off) {
      ensureScene();
    }
  });

  /** Loads a classic script once; resolves when it has executed. */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) {
        resolve();
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`failed to load ${src}`));
      document.body.appendChild(s);
    });
  }

  function ensureScene() {
    if (scene || sceneLoading || canvasCollapsed()) return;
    sceneLoading = true;
    // Classic scripts injected in dependency order, not ES modules: module
    // loading over file:// is exactly the kind of environment-sensitive
    // machinery this panel avoids, and three is vendored as an IIFE anyway.
    // ~700 KB parses once, only when someone actually opens the 3D card.
    loadScript('vendor/three.bundle.js')
      .then(() => loadScript('setup-3d/car-model.js'))
      .then(() => loadScript('setup-3d/car-scene.js'))
      .then(() => {
        scene = window.ApexCarScene.createCarScene(elCanvasWrap);
        sceneLoading = false;
        if (active && !canvasCollapsed()) {
          scene.start();
          if (lastState && lastState.connected) scene.applySetup(settingsMap, staged);
        }
      })
      .catch((err) => {
        sceneLoading = false;
        console.error('[setups] 3D scene unavailable:', err);
        const hint = document.createElement('span');
        hint.className = 'su-canvas__hint';
        hint.textContent = '3D view unavailable';
        elCanvasWrap.appendChild(hint);
      });
  }

  paint3dToggle();
})();
