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

  function renderStatus(status) {
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
  }

  function renderSettings(settings) {
    portInput.value = settings.httpPort;
    portEcho.textContent = settings.httpPort;
    rateRange.value = settings.updateRateHz;
    rateEcho.textContent = settings.updateRateHz;
    demoToggle.checked = !!settings.forceSimulator;
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
      li.appendChild(urlWrap);
      overlayList.appendChild(li);
    }
    combinedUrl.value = combined;
  }

  function renderAll(state) {
    renderSettings(state.settings);
    renderOverlays(state.overlays, state.combinedUrl);
    renderStatus(state.status);
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
})();
