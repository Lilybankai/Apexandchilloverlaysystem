/**
 * control-panel.js — renderer logic for the Apex Overlay System window.
 * -----------------------------------------------------------------------------
 * Talks to the main process only through the `window.apex` bridge (preload.js).
 * Responsibilities:
 *   - Load and render current settings + the overlay catalog (with OBS URLs).
 *   - Persist setting changes as the operator edits them.
 *   - Start/stop the server and reflect the live feed status pill.
 *   - Copy overlay URLs to the clipboard.
 */

'use strict';

(function () {
  const $ = (sel) => document.querySelector(sel);

  // --- Elements ------------------------------------------------------------
  const feedPill = $('#feed-pill');
  const feedText = $('#feed-text');
  const powerBtn = $('#power-btn');
  const portInput = $('#port-input');
  const portEcho = $('#port-echo');
  const rateRange = $('#rate-range');
  const rateEcho = $('#rate-echo');
  const demoToggle = $('#demo-toggle');
  const ingameToggle = $('#ingame-toggle');
  const igEditBtn = $('#ig-edit-btn');
  const igResetBtn = $('#ig-reset-btn');
  const igHotkeyBtn = $('#ig-hotkey');
  const igHotkeyClear = $('#ig-hotkey-clear');
  const sponsorsToggle = $('#sponsors-toggle');
  const sponsorRange = $('#sponsor-range');
  const sponsorEcho = $('#sponsor-echo');
  const sponsorList = $('#sponsor-list');
  const sponsorAdd = $('#sponsor-add');
  const overlayList = $('#overlay-list');
  const combinedUrl = $('#combined-url');
  const toast = $('#toast');
  const errorBanner = $('#error-banner');
  const errorText = $('#error-text');
  const updateBanner = $('#update-banner');
  const updateText = $('#update-text');
  const updateAction = $('#update-action');

  // Human-readable label + dot colour per feed state.
  const FEED_LABEL = {
    live: 'LIVE',
    demo: 'DEMO DATA',
    'no-data': 'NO DATA',
    stopped: 'STOPPED',
  };

  let toastTimer = null;
  function showToast(message) {
    toast.textContent = message;
    toast.setAttribute('data-show', 'true');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.removeAttribute('data-show'), 1400);
  }

  // --- Rendering -----------------------------------------------------------

  // Latest known status/settings — the in-game buttons depend on both.
  let lastStatus = { running: false };
  let lastIngameEnabled = false;

  function syncIngameControls() {
    // Editing needs a live in-game layer: server running + display enabled.
    const canEdit = !!lastStatus.running && lastIngameEnabled;
    const editing = !!lastStatus.ingameEditing;
    igEditBtn.disabled = !canEdit;
    igEditBtn.textContent = editing ? 'Finish editing' : 'Edit layout';
    igEditBtn.setAttribute('data-active', String(editing));
  }

  function renderStatus(status) {
    lastStatus = status;
    const feed = status.running ? status.feed || 'no-data' : 'stopped';
    feedPill.setAttribute('data-feed', feed);
    feedText.textContent = FEED_LABEL[feed] || feed.toUpperCase();
    powerBtn.textContent = status.running ? 'Stop' : 'Start';
    powerBtn.setAttribute('data-running', String(!!status.running));

    // Surface a start-up failure (e.g. busy port) as a persistent banner.
    if (status.error && !status.running) {
      errorText.textContent = status.error;
      errorBanner.hidden = false;
    } else {
      errorBanner.hidden = true;
    }
    syncIngameControls();
  }

  function renderSettings(settings) {
    portInput.value = settings.httpPort;
    portEcho.textContent = settings.httpPort;
    rateRange.value = settings.updateRateHz;
    rateEcho.textContent = settings.updateRateHz;
    demoToggle.checked = !!settings.forceSimulator;
    sponsorsToggle.checked = !!settings.sponsorsEnabled;
    sponsorRange.value = settings.sponsorIntervalSec;
    sponsorEcho.textContent = settings.sponsorIntervalSec;
    ingameToggle.checked = !!settings.ingameEnabled;
    lastIngameEnabled = !!settings.ingameEnabled;
    if (!capturingHotkey) renderHotkey(settings.ingameToggleShortcut);
    syncIngameControls();
  }

  // --- In-game toggle hotkey capture --------------------------------------

  let capturingHotkey = false;
  let lastShortcut = 'F8';

  function renderHotkey(accel) {
    lastShortcut = accel || '';
    igHotkeyBtn.textContent = accel || 'Click to set';
    igHotkeyBtn.setAttribute('data-empty', String(!accel));
  }

  // Map a keydown event to an Electron accelerator string, or null if the key
  // is only a modifier / not bindable on its own.
  function eventToAccelerator(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');

    let key = e.key;
    if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') {
      return null; // a bare modifier — wait for the real key
    }
    if (key === ' ' || key === 'Spacebar') key = 'Space';
    else if (key === '+') key = 'Plus';
    else if (/^F\d{1,2}$/.test(key)) {
      /* function keys pass through as-is */
    } else if (key.length === 1) {
      key = key.toUpperCase();
    } else {
      // Named keys (ArrowUp, Escape, Tab, …) — Electron accepts most verbatim.
      key = key.charAt(0).toUpperCase() + key.slice(1);
    }
    return [...mods, key].join('+');
  }

  async function commitHotkey(accel) {
    const state = await window.apex.updateSettings({ ingameToggleShortcut: accel });
    renderHotkey(state.settings.ingameToggleShortcut);
  }

  function renderOverlays(overlays, combined) {
    overlayList.innerHTML = '';
    for (const o of overlays) {
      const li = document.createElement('li');
      li.className = 'overlay-row';
      li.setAttribute('data-enabled', String(o.enabled));

      const check = document.createElement('label');
      check.className = 'overlay-row__check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = o.enabled;
      cb.addEventListener('change', () => toggleOverlay(o.id, cb.checked));
      check.appendChild(cb);

      const info = document.createElement('div');
      info.className = 'overlay-row__info';
      info.innerHTML =
        '<div class="overlay-row__label"></div><div class="overlay-row__desc"></div>';
      info.querySelector('.overlay-row__label').textContent = o.label;
      info.querySelector('.overlay-row__desc').textContent = o.description;

      // Per-widget "show in game" toggle (takes effect when the in-game
      // display master switch is on).
      const ig = document.createElement('label');
      ig.className = 'overlay-row__ig';
      ig.setAttribute('data-on', String(!!o.ingame));
      const igCb = document.createElement('input');
      igCb.type = 'checkbox';
      igCb.checked = !!o.ingame;
      igCb.addEventListener('change', async () => {
        ig.setAttribute('data-on', String(igCb.checked));
        await window.apex.updateSettings({ ingameOverlays: { [o.id]: igCb.checked } });
      });
      const igText = document.createElement('span');
      igText.textContent = 'In game';
      ig.appendChild(igCb);
      ig.appendChild(igText);

      const urlWrap = document.createElement('div');
      urlWrap.className = 'overlay-row__url url-box';
      const urlInput = document.createElement('input');
      urlInput.className = 'url-box__input';
      urlInput.type = 'text';
      urlInput.readOnly = true;
      urlInput.value = o.url;
      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn btn--ghost btn--sm';
      copyBtn.type = 'button';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', () => copyUrl(o.url, o.label));
      const previewBtn = document.createElement('button');
      previewBtn.className = 'btn btn--ghost btn--sm';
      previewBtn.type = 'button';
      previewBtn.textContent = 'Preview';
      previewBtn.addEventListener('click', () => window.apex.openInBrowser(o.url));
      urlWrap.appendChild(urlInput);
      urlWrap.appendChild(copyBtn);
      urlWrap.appendChild(previewBtn);

      li.appendChild(check);
      li.appendChild(info);
      li.appendChild(ig);
      li.appendChild(urlWrap);
      overlayList.appendChild(li);
    }
    combinedUrl.value = combined;
  }

  /**
   * The running build, in the top bar under the wordmark. Only rendered once,
   * from the initial state — the version cannot change while the app is open.
   */
  function renderVersion(version) {
    const el = $('#app-version');
    if (!el) return;
    el.textContent = version ? 'v' + version : '';
  }

  function renderAll(state) {
    renderSettings(state.settings);
    renderOverlays(state.overlays, state.combinedUrl);
    renderStatus(state.status);
    renderVersion(state.appVersion);
  }

  // --- Actions -------------------------------------------------------------

  async function copyUrl(url, label) {
    await window.apex.copy(url);
    showToast((label ? label + ' URL' : 'URL') + ' copied');
  }

  async function toggleOverlay(id, enabled) {
    const state = await window.apex.updateSettings({
      enabledOverlays: { [id]: enabled },
    });
    renderOverlays(state.overlays, state.combinedUrl);
  }

  // Debounce rapid edits (typing a port, dragging the rate slider) so we don't
  // restart the server on every keystroke.
  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  const commitPort = debounce(async (value) => {
    const state = await window.apex.updateSettings({ httpPort: value });
    renderSettings(state.settings);
    renderOverlays(state.overlays, state.combinedUrl);
    renderStatus(state.status);
  }, 600);

  const commitRate = debounce(async (value) => {
    const state = await window.apex.updateSettings({ updateRateHz: value });
    renderStatus(state.status);
  }, 350);

  // --- Wiring --------------------------------------------------------------

  portInput.addEventListener('input', () => {
    portEcho.textContent = portInput.value;
    const n = parseInt(portInput.value, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 65535) commitPort(n);
  });

  rateRange.addEventListener('input', () => {
    rateEcho.textContent = rateRange.value;
    commitRate(parseInt(rateRange.value, 10));
  });

  demoToggle.addEventListener('change', async () => {
    const state = await window.apex.updateSettings({ forceSimulator: demoToggle.checked });
    renderStatus(state.status);
  });

  // --- Sponsor logos -------------------------------------------------------

  /**
   * Render the installed logo list. Empty is the normal state for most users,
   * so it gets a plain explanatory row rather than looking like a failure.
   */
  function renderSponsors(names) {
    sponsorList.innerHTML = '';
    if (!names || names.length === 0) {
      const li = document.createElement('li');
      li.className = 'sponsor-list__empty';
      li.textContent = 'No logos added yet.';
      sponsorList.appendChild(li);
      return;
    }
    names.forEach((name) => {
      const li = document.createElement('li');
      li.className = 'sponsor-list__item';
      const label = document.createElement('span');
      label.className = 'sponsor-list__name';
      label.textContent = name;
      const remove = document.createElement('button');
      remove.className = 'btn btn--ghost btn--sm';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        renderSponsors(await window.apex.sponsorsRemove(name));
      });
      li.appendChild(label);
      li.appendChild(remove);
      sponsorList.appendChild(li);
    });
  }

  sponsorsToggle.addEventListener('change', async () => {
    const state = await window.apex.updateSettings({ sponsorsEnabled: sponsorsToggle.checked });
    renderStatus(state.status);
  });

  const commitSponsorInterval = debounce(async (value) => {
    const state = await window.apex.updateSettings({ sponsorIntervalSec: value });
    renderStatus(state.status);
  }, 350);

  sponsorRange.addEventListener('input', () => {
    sponsorEcho.textContent = sponsorRange.value;
    commitSponsorInterval(parseInt(sponsorRange.value, 10));
  });

  sponsorAdd.addEventListener('click', async () => {
    sponsorAdd.disabled = true;
    try {
      renderSponsors(await window.apex.sponsorsAdd());
    } finally {
      sponsorAdd.disabled = false;
    }
  });

  ingameToggle.addEventListener('change', async () => {
    const state = await window.apex.updateSettings({ ingameEnabled: ingameToggle.checked });
    renderSettings(state.settings);
    renderStatus(state.status);
    if (ingameToggle.checked && !state.status.running) {
      showToast('Press Start to show the overlays');
    }
  });

  igEditBtn.addEventListener('click', async () => {
    const editing = !!lastStatus.ingameEditing;
    const status = editing
      ? await window.apex.ingameEditStop()
      : await window.apex.ingameEditStart();
    renderStatus(status);
  });

  igResetBtn.addEventListener('click', async () => {
    await window.apex.ingameLayoutReset();
    showToast('In-game layout reset');
  });

  // Click the hotkey chip, then press a combination to bind it.
  igHotkeyBtn.addEventListener('click', () => {
    capturingHotkey = true;
    igHotkeyBtn.textContent = 'Press a key…';
    igHotkeyBtn.setAttribute('data-capturing', 'true');
    igHotkeyBtn.focus();
  });

  function stopCapture() {
    capturingHotkey = false;
    igHotkeyBtn.removeAttribute('data-capturing');
  }

  igHotkeyBtn.addEventListener('keydown', (e) => {
    if (!capturingHotkey) return;
    e.preventDefault();
    if (e.key === 'Escape') {
      stopCapture();
      renderHotkey(lastShortcut);
      return;
    }
    const accel = eventToAccelerator(e);
    if (!accel) return; // still holding only modifiers
    stopCapture();
    lastShortcut = accel;
    void commitHotkey(accel);
    showToast('Hotkey set to ' + accel);
  });

  igHotkeyBtn.addEventListener('blur', () => {
    if (capturingHotkey) {
      stopCapture();
      renderHotkey(lastShortcut);
    }
  });

  igHotkeyClear.addEventListener('click', async () => {
    stopCapture();
    lastShortcut = '';
    await commitHotkey('');
    showToast('Hotkey cleared');
  });

  powerBtn.addEventListener('click', async () => {
    const running = powerBtn.getAttribute('data-running') === 'true';
    powerBtn.disabled = true;
    const status = running ? await window.apex.stopServer() : await window.apex.startServer();
    renderStatus(status);
    // Refresh overlay URLs in case the port changed while stopped.
    const state = await window.apex.getState();
    renderOverlays(state.overlays, state.combinedUrl);
    powerBtn.disabled = false;
  });

  // Copy buttons that reference a target input by id (the combined URL box).
  document.querySelectorAll('[data-copy-target]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = document.getElementById(btn.getAttribute('data-copy-target'));
      if (target) await copyUrl(target.value, 'All-in-one');
    });
  });

  // Live status pushes from the main process.
  window.apex.onStatus((status) => renderStatus(status));

  // Settings pushes — e.g. the global hotkey flipped "Show in game" while the
  // panel was open. Keep the toggle and controls in sync without a reload.
  window.apex.onSettings((settings) => {
    if (settings) renderSettings(settings);
  });

  // --- App updates ---------------------------------------------------------

  function renderUpdate(u) {
    if (!u) return;
    // Show the banner only when there's something actionable to report.
    switch (u.status) {
      case 'available':
        updateBanner.hidden = false;
        updateText.textContent = `Version ${u.version} is available.`;
        updateAction.hidden = false;
        updateAction.disabled = false;
        updateAction.textContent = 'Download & install';
        updateAction.onclick = () => window.apex.downloadUpdate();
        break;
      case 'downloading':
        updateBanner.hidden = false;
        updateText.textContent = `Downloading update… ${u.percent}%`;
        updateAction.disabled = true;
        updateAction.textContent = 'Downloading…';
        break;
      case 'ready':
        updateBanner.hidden = false;
        updateText.textContent = `Version ${u.version} is ready to install.`;
        updateAction.hidden = false;
        updateAction.disabled = false;
        updateAction.textContent = 'Restart & update';
        updateAction.onclick = () => window.apex.installUpdate();
        break;
      case 'error':
        // Stay quiet on background errors (offline, no releases yet).
        updateBanner.hidden = true;
        break;
      default:
        // idle / checking / none → keep the banner hidden.
        updateBanner.hidden = true;
    }
  }

  window.apex.onUpdate(renderUpdate);
  window.apex.getUpdateState().then(renderUpdate);

  // --- Boot ----------------------------------------------------------------
  window.apex.getState().then(renderAll);
  // The logo list lives on disk, not in settings, so it is fetched separately.
  window.apex.sponsorsList().then(renderSponsors);
})();
