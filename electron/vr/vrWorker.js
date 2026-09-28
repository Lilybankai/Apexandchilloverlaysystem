/**
 * electron/vr/vrWorker.js — the headset panel's own thread.
 * -----------------------------------------------------------------------------
 * Every OpenVR call happens here, never on the main thread. The main thread is
 * the one compositing every overlay frame, and this app has already paid for a
 * synchronous call parked on it (see electron/stall-watch.js, and the gamepad
 * enumeration that froze the layer for 10 s at a time). SteamVR is a separate
 * process that can hang, restart or vanish mid-race; when it does, this thread
 * waits on it and the desktop overlays carry on.
 *
 * Lifecycle, driven by a 3 s check for SteamVR's server process:
 *   waiting    — SteamVR is not running. We do NOT call VR_Init to find out:
 *                an overlay app's init launches SteamVR, which must never
 *                happen to a driver racing on a monitor tonight.
 *   connected  — overlay created and world-locked; frames go straight to it.
 *   quit       — SteamVR asked every app to leave. We acknowledge, disconnect
 *                and stay down until its server has actually exited, so we
 *                cannot restart the SteamVR that is shutting down.
 *   error      — init or the overlay failed; retried on a slower clock.
 *
 * Protocol (main → worker):
 *   {cmd:'start'} · {cmd:'stop'} · {cmd:'placement', placement}
 *   {cmd:'visible', visible} · {cmd:'frame', buffer, width, height}
 * Worker → main:
 *   {ev:'state', state, detail?, runtime?} · {ev:'ack'} (one per frame)
 *   {ev:'stats', uploads, failures, avgMs, maxMs, lastError} (every 10 s while connected)
 */

'use strict';

const { parentPort } = require('node:worker_threads');
const { OpenVR, runtimeDllPath } = require('./openvr');
const { normalizeVr, panelMatrix } = require('./placement');
const { D3DPanelTextures } = require('./d3d11');

if (!parentPort) throw new Error('vrWorker must run as a worker thread');

const POLL_MS = 3000;
const RETRY_AFTER_ERROR_MS = 15000;
const EVENT_POLL_MS = 250;
const STATS_MS = 10000;
const OVERLAY_KEY = 'apexaio.panel.main';
const OVERLAY_NAME = 'Apex AIO';

const post = (msg) => {
  try {
    parentPort.postMessage(msg);
  } catch {
    /* main gone */
  }
};

/* ------------------------------ process check ----------------------------- */

/**
 * Is a process with this exe name running? Toolhelp snapshot through koffi —
 * no child process spawned (the app has been bitten by a synchronous spawn on
 * the main thread before; this is off it anyway, and cheaper still).
 */
let toolhelp = null;
function processRunning(exeLower) {
  if (!toolhelp) {
    const koffi = require('koffi');
    const k32 = koffi.load('kernel32.dll');
    toolhelp = {
      snapshot: k32.func('void *__stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)'),
      first: k32.func('int __stdcall Process32FirstW(void *snap, void *entry)'),
      next: k32.func('int __stdcall Process32NextW(void *snap, void *entry)'),
      close: k32.func('int __stdcall CloseHandle(void *h)'),
      address: (p) => koffi.address(p),
      // PROCESSENTRY32W on x64: szExeFile (WCHAR[260]) at offset 44, 568 bytes.
      entry: Buffer.alloc(568),
    };
  }
  const TH32CS_SNAPPROCESS = 2;
  const snap = toolhelp.snapshot(TH32CS_SNAPPROCESS, 0);
  // INVALID_HANDLE_VALUE is (HANDLE)-1.
  if (!snap || toolhelp.address(snap) === 0xffffffffffffffffn) return false;
  try {
    const e = toolhelp.entry;
    e.writeUInt32LE(e.length, 0);
    for (let ok = toolhelp.first(snap, e); ok; ok = toolhelp.next(snap, e)) {
      let end = 44;
      while (end < 564 && (e[end] !== 0 || e[end + 1] !== 0)) end += 2;
      if (e.toString('utf16le', 44, end).toLowerCase() === exeLower) return true;
    }
    return false;
  } finally {
    toolhelp.close(snap);
  }
}

function steamVrRunning() {
  return processRunning('vrserver.exe');
}

/* --------------------------------- state ---------------------------------- */

let running = false;
let state = 'idle';
let vr = null;
let handle = null;
let gpu = null;
let placement = normalizeVr({});
let wantVisible = false;
let shown = false;
let haveFrame = false;
let awaitingServerExit = false;
let retryAt = 0;
let pollTimer = null;
let eventTimer = null;
let statsTimer = null;
const stats = { uploads: 0, failures: 0, totalMs: 0, maxMs: 0, lastError: '' };

function setState(next, detail) {
  if (next === state && !detail) return;
  state = next;
  post({ ev: 'state', state: next, detail: detail || '', runtime: vr ? vr.runtimeVersion() : '' });
}

function applyPlacement() {
  if (!vr || handle === null) return;
  vr.setWidth(handle, placement.width);
  vr.setSeatedTransform(handle, panelMatrix(placement));
}

function applyVisibility() {
  if (!vr || handle === null) return;
  const want = wantVisible && haveFrame;
  if (want === shown) return;
  if (want) vr.show(handle);
  else vr.hide(handle);
  shown = want;
}

function connect() {
  const dll = runtimeDllPath();
  if (!dll) {
    setState('unavailable', 'SteamVR is not installed on this PC.');
    return;
  }
  try {
    vr = OpenVR.connect(dll);
    gpu = new D3DPanelTextures(vr.adapterIndex());
    handle = vr.createOverlay(OVERLAY_KEY, OVERLAY_NAME);
    shown = false;
    haveFrame = false;
    applyPlacement();
    setState('connected');
    eventTimer = setInterval(pollEvents, EVENT_POLL_MS);
  } catch (err) {
    stats.lastError = String((err && err.message) || err);
    disconnect();
    retryAt = Date.now() + RETRY_AFTER_ERROR_MS;
    setState('error', stats.lastError);
  }
}

function disconnect() {
  if (eventTimer) clearInterval(eventTimer);
  eventTimer = null;
  if (vr) {
    if (handle !== null) {
      try {
        vr.destroyOverlay(handle);
      } catch {
        /* SteamVR may already be gone */
      }
    }
    vr.shutdown();
  }
  // After the overlay is gone, so SteamVR is no longer holding our texture.
  if (gpu) gpu.release();
  gpu = null;
  vr = null;
  handle = null;
  shown = false;
  haveFrame = false;
}

function pollEvents() {
  if (!vr) return;
  let quit = false;
  try {
    quit = vr.pollQuit();
  } catch (err) {
    stats.lastError = String((err && err.message) || err);
  }
  if (quit) {
    vr.acknowledgeQuit();
    disconnect();
    awaitingServerExit = true;
    setState('waiting', 'SteamVR closed.');
  }
}

function tick() {
  if (!running) return;
  let up = false;
  try {
    up = steamVrRunning();
  } catch (err) {
    setState('error', `Could not check for SteamVR: ${(err && err.message) || err}`);
    return;
  }
  if (!up) {
    awaitingServerExit = false;
    if (vr) disconnect();
    setState('waiting');
    return;
  }
  if (vr || awaitingServerExit) return;
  if (Date.now() < retryAt) return;
  connect();
}

/* --------------------------------- frames --------------------------------- */

/**
 * One painted frame into the headset: copied into a GPU texture (d3d11.js —
 * which is also where the reason SetOverlayRaw is not used here is written
 * down), then that texture handed to the overlay.
 */
function uploadFrame(buffer, width, height) {
  if (!vr || handle === null || !gpu) return;
  const t0 = performance.now();
  let code;
  try {
    code = vr.setTexture(handle, gpu.upload(Buffer.from(buffer), width, height));
  } catch (err) {
    stats.failures++;
    stats.lastError = String((err && err.message) || err);
    return;
  }
  const ms = performance.now() - t0;
  if (code !== 0) {
    stats.failures++;
    stats.lastError = `SetOverlayTexture: ${vr.errorName(code)}`;
    return;
  }
  stats.uploads++;
  stats.totalMs += ms;
  if (ms > stats.maxMs) stats.maxMs = ms;
  if (!haveFrame) {
    haveFrame = true;
    applyVisibility();
  }
}

function flushStats() {
  if (state !== 'connected') return;
  post({
    ev: 'stats',
    uploads: stats.uploads,
    failures: stats.failures,
    avgMs: stats.uploads ? stats.totalMs / stats.uploads : 0,
    maxMs: stats.maxMs,
    lastError: stats.lastError,
  });
  stats.uploads = 0;
  stats.failures = 0;
  stats.totalMs = 0;
  stats.maxMs = 0;
}

/* -------------------------------- protocol -------------------------------- */

parentPort.on('message', (m) => {
  if (!m || typeof m.cmd !== 'string') return;
  try {
    switch (m.cmd) {
      case 'start':
        if (running) break;
        running = true;
        tick();
        pollTimer = setInterval(tick, POLL_MS);
        statsTimer = setInterval(flushStats, STATS_MS);
        break;
      case 'stop':
        running = false;
        if (pollTimer) clearInterval(pollTimer);
        if (statsTimer) clearInterval(statsTimer);
        pollTimer = statsTimer = null;
        disconnect();
        setState('idle');
        break;
      case 'placement':
        placement = normalizeVr(m.placement);
        applyPlacement();
        break;
      case 'visible':
        wantVisible = !!m.visible;
        applyVisibility();
        break;
      case 'frame':
        // Always acknowledged, uploaded or not: main holds at most one frame
        // in flight and waits for this before sending the next.
        try {
          if (m.buffer instanceof ArrayBuffer) uploadFrame(m.buffer, m.width, m.height);
        } finally {
          post({ ev: 'ack' });
        }
        break;
      default:
        break;
    }
  } catch (err) {
    stats.lastError = String((err && err.message) || err);
    post({ ev: 'state', state, detail: stats.lastError });
  }
});
