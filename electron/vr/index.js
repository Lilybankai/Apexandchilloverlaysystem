/**
 * electron/vr/index.js — the headset panel, main-process side.
 * -----------------------------------------------------------------------------
 * Owns two things and nothing else:
 *   1. the VR worker thread (vrWorker.js), which does every OpenVR call;
 *   2. an OFFSCREEN BrowserWindow rendering overlay/vr.html, whose painted
 *      frames are passed to the worker as they arrive.
 *
 * Both exist only while the driver has "Show in VR headset" switched on. The
 * window exists only while SteamVR is actually connected, and paints only
 * while the panel is meant to be visible — off track, with auto show/hide on,
 * it stops painting altogether. A driver who never touches VR pays for none
 * of this: no worker, no window, no DLL, no timer.
 *
 * ## Frames
 *
 * Chromium paints the page into a CPU bitmap (`paint` event), which crosses to
 * the worker as a transferred ArrayBuffer; the worker copies it into a D3D11
 * texture and hands that to SteamVR (see d3d11.js for why it is not the
 * simpler SetOverlayRaw). The page is capped at {@link FRAME_RATE} fps: the
 * compositor re-samples the panel at the headset's full refresh no matter how
 * often the pixels change, so head movement stays perfectly smooth while a
 * gauge updates at 15 fps. At most one frame is in flight; a newer paint
 * replaces the one waiting, so a slow upload drops stale frames instead of
 * queueing them. Skipping the CPU bitmap altogether (Electron's
 * useSharedTexture) is what remains of Phase 3 in docs/VR-OVERLAY-PLAN.md.
 */

'use strict';

const path = require('node:path');

/** Content fps. See the note above: head tracking does not depend on it. */
const FRAME_RATE = 15;
/**
 * The panel page's size in CSS px — and therefore the texture's. Fits the
 * speedo cluster (902×425 natural) and the relative (400 wide) side by side,
 * plus vr.css's 8px padding and 16px gap.
 */
const PANEL_WIDTH = 1340;
const PANEL_HEIGHT = 450;

class VrOverlay {
  /**
   * @param {object} deps
   * @param {typeof import('electron').BrowserWindow} deps.BrowserWindow
   * @param {(info: object) => void} [deps.onChange] status changed (for the panel UI)
   * @param {(line: string) => void} [deps.log]
   */
  constructor({ BrowserWindow, onChange, log }) {
    this.BrowserWindow = BrowserWindow;
    this.onChange = onChange || (() => {});
    this.log = log || (() => {});
    this.worker = null;
    this.win = null;
    this.url = '';
    this.placement = null;
    this.visible = false;
    this.inFlight = false;
    this.pending = null;
    this.info = { state: 'off', detail: '', runtime: '', fps: 0, uploadMs: 0, failures: 0, lastError: '' };
  }

  /** Current state for the control panel. */
  status() {
    return { ...this.info };
  }

  /**
   * Bring everything in line with the settings. Cheap to call often — main.js
   * calls it wherever it re-syncs the desktop layer.
   * @param {{enabled: boolean, url: string, placement: object}} want
   */
  sync({ enabled, url, placement }) {
    if (!enabled) {
      this.stop();
      return;
    }
    this.placement = placement;
    this.url = url;
    if (!this.worker && !this.startWorker()) return;
    this.worker.postMessage({ cmd: 'placement', placement });
    if (this.win && !this.win.isDestroyed() && this.win.vrUrl !== url) {
      this.win.vrUrl = url;
      void this.win.loadURL(url);
    }
  }

  /** Follow the desktop layer's show/hide (auto show/hide, edit mode…). */
  setVisible(visible) {
    visible = !!visible;
    if (visible === this.visible) return;
    this.visible = visible;
    if (this.worker) this.worker.postMessage({ cmd: 'visible', visible });
    this.applyPainting();
  }

  stop() {
    this.destroyWindow();
    if (this.worker) {
      const w = this.worker;
      this.worker = null;
      try {
        w.postMessage({ cmd: 'stop' });
      } catch {
        /* already gone */
      }
      // Give it a moment to shut SteamVR's connection down cleanly (a killed
      // client leaves SteamVR waiting on a pipe), then make sure it is gone.
      setTimeout(() => void w.terminate(), 1500).unref();
    }
    this.setInfo({ state: 'off', detail: '', runtime: '', fps: 0, uploadMs: 0, failures: 0, lastError: '' });
  }

  /* ------------------------------------------------------------------------ */

  startWorker() {
    let worker;
    try {
      const { Worker } = require('node:worker_threads');
      worker = new Worker(path.join(__dirname, 'vrWorker.js'));
    } catch (err) {
      this.setInfo({ state: 'error', detail: `VR support could not start: ${err.message}` });
      return false;
    }
    worker.unref();
    worker.on('message', (m) => this.onWorkerMessage(worker, m));
    worker.on('error', (err) => {
      this.log(`[vr] worker error: ${err && err.message}`);
      if (this.worker === worker) {
        this.worker = null;
        this.destroyWindow();
        this.setInfo({ state: 'error', detail: `VR support stopped: ${err && err.message}` });
      }
    });
    worker.on('exit', () => {
      if (this.worker === worker) {
        this.worker = null;
        this.destroyWindow();
      }
    });
    this.worker = worker;
    worker.postMessage({ cmd: 'visible', visible: this.visible });
    worker.postMessage({ cmd: 'start' });
    this.setInfo({ state: 'waiting', detail: '' });
    return true;
  }

  onWorkerMessage(worker, m) {
    if (worker !== this.worker || !m) return;
    if (m.ev === 'ack') {
      this.inFlight = false;
      if (this.pending) {
        const next = this.pending;
        this.pending = null;
        this.send(next);
      }
      return;
    }
    if (m.ev === 'state') {
      if (m.state !== this.info.state) this.log(`[vr] ${m.state}${m.detail ? ` — ${m.detail}` : ''}`);
      const connected = m.state === 'connected';
      this.setInfo({
        state: m.state,
        detail: m.detail || '',
        runtime: m.runtime || this.info.runtime,
        // Rates describe a live connection; do not leave the last one showing.
        ...(connected ? {} : { fps: 0, uploadMs: 0, failures: 0 }),
      });
      if (m.state === 'connected') this.ensureWindow();
      else this.destroyWindow();
      return;
    }
    if (m.ev === 'stats') {
      this.setInfo({
        fps: Math.round((m.uploads / 10) * 10) / 10,
        uploadMs: Math.round(m.avgMs * 10) / 10,
        failures: m.failures || 0,
        lastError: m.lastError || '',
      });
    }
  }

  setInfo(patch) {
    const next = { ...this.info, ...patch };
    const changed = Object.keys(next).some((k) => next[k] !== this.info[k]);
    this.info = next;
    if (changed) this.onChange(this.status());
  }

  /* ------------------------------ the page -------------------------------- */

  ensureWindow() {
    if ((this.win && !this.win.isDestroyed()) || !this.url) return;
    const win = new this.BrowserWindow({
      show: false,
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      transparent: true,
      frame: false,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        offscreen: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.webContents.setFrameRate(FRAME_RATE);
    win.webContents.on('paint', (_evt, _dirty, image) => this.onPaint(image));
    win.webContents.on('render-process-gone', (_evt, details) => {
      this.log(`[vr] panel renderer gone (${details && details.reason}) — rebuilding`);
      this.destroyWindow();
      if (this.info.state === 'connected') setTimeout(() => this.ensureWindow(), 1000).unref();
    });
    win.vrUrl = this.url;
    this.win = win;
    this.applyPainting();
    void win.loadURL(this.url);
  }

  destroyWindow() {
    const win = this.win;
    this.win = null;
    this.inFlight = false;
    this.pending = null;
    if (win && !win.isDestroyed()) win.destroy();
  }

  /** Paint only while the panel is meant to be seen. */
  applyPainting() {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    if (this.visible) win.webContents.startPainting();
    else win.webContents.stopPainting();
  }

  onPaint(image) {
    if (!this.worker || this.info.state !== 'connected') return;
    const { width, height } = image.getSize();
    if (!width || !height) return;
    const frame = { bitmap: image.toBitmap(), width, height };
    if (this.inFlight) {
      this.pending = frame; // newest wins; the stale one is simply dropped
      return;
    }
    this.send(frame);
  }

  send({ bitmap, width, height }) {
    // Hand over the bytes rather than copying them: a whole ArrayBuffer is
    // transferred, so only slice when the Buffer is a view into a bigger one.
    const whole = bitmap.byteOffset === 0 && bitmap.buffer.byteLength === bitmap.byteLength;
    const buffer = whole
      ? bitmap.buffer
      : bitmap.buffer.slice(bitmap.byteOffset, bitmap.byteOffset + bitmap.byteLength);
    this.inFlight = true;
    try {
      this.worker.postMessage({ cmd: 'frame', buffer, width, height }, [buffer]);
    } catch (err) {
      this.inFlight = false;
      this.log(`[vr] frame not sent: ${err && err.message}`);
    }
  }
}

module.exports = { VrOverlay, FRAME_RATE, PANEL_WIDTH, PANEL_HEIGHT };
