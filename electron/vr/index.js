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
const { enabledWidgets } = require('./placement');

/** Content fps. See the note above: head tracking does not depend on it. */
const FRAME_RATE = 15;
/**
 * Pixels drawn per CSS pixel. The PSVR2 tester found the relative softer than
 * fpsVR at 1× (2026-09-28): a 400 px widget shown ~25 cm wide lands on about
 * as many headset pixels as it has, and small text then goes soft through the
 * lens correction. At 2× every glyph and canvas is drawn with twice the
 * pixels and the compositor scales down — the way fpsVR draws its own panel.
 * Four times the bytes per frame, still ~1 ms of upload, on the worker.
 */
const RENDER_SCALE = 2;
/** How often the page is asked where its widgets are (heights are data-driven). */
const LAYOUT_POLL_MS = 1000;
/** Size the window starts at, before the page has said how big it needs to be. */
const START_WIDTH = 1024;
const START_HEIGHT = 512;

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
    this.vr = null;
    /** Where the page last said each widget is: {width, height, rects} in CSS px. */
    this.pageLayout = null;
    this.lastLayoutSent = '';
    this.layoutTimer = null;
    this.visible = false;
    this.inFlight = false;
    this.pending = null;
    this.info = { state: 'off', detail: '', runtime: '', fps: 0, uploadMs: 0, mainMs: 0, failures: 0, lastError: '' };
    /**
     * Main-thread time per frame (bitmap copy + hand-off), averaged over the
     * worker's 10 s stats window. This is the thread that composites every
     * overlay, so it is measured rather than assumed.
     */
    this.mainStats = { total: 0, count: 0 };
  }

  /** Current state for the control panel. */
  status() {
    return { ...this.info };
  }

  /**
   * Bring everything in line with the settings. Cheap to call often — main.js
   * calls it wherever it re-syncs the desktop layer.
   * @param {{enabled: boolean, baseUrl: string, vr: object}} want — `vr` is
   *   the normalised settings block (placement.normalizeVr).
   */
  sync({ enabled, baseUrl, vr }) {
    if (!enabled) {
      this.stop();
      return;
    }
    this.vr = vr;
    // The MFD always hides itself when idle in the headset — it is summoned by
    // the wheel's MFD buttons or its hotkey (toggleMfd), not left floating.
    const hideMs = (vr.mfdHideSec || 3) * 1000;
    const url = `${baseUrl}/vr.html?widgets=${enabledWidgets(vr).join(',')}&fade=on&fadems=${hideMs}`;
    this.url = url;
    if (!this.worker && !this.startWorker()) return;
    if (this.win && !this.win.isDestroyed() && this.win.vrUrl !== url) {
      // A different set of widgets: their rectangles are about to move, so
      // forget the old ones rather than point new panels at stale regions.
      this.win.vrUrl = url;
      this.pageLayout = null;
      void this.win.loadURL(url);
    }
    this.sendLayout();
  }

  /** Follow the desktop layer's show/hide (auto show/hide, edit mode…). */
  setVisible(visible) {
    visible = !!visible;
    if (visible === this.visible) return;
    this.visible = visible;
    if (this.worker) this.worker.postMessage({ cmd: 'visible', visible });
    this.applyPainting();
  }

  /**
   * The headset MFD's show/hide hotkey (the `vr.mfd` action). Shown → hidden
   * now; hidden → up until it has been idle for the driver's hide time. The
   * wheel's own MFD buttons need none of this: they move the server's cursor,
   * which the page polls, and a moved cursor brings the widget back by itself.
   */
  async toggleMfd() {
    if (!this.vr || !this.vr.widgets || !this.vr.widgets.mfd || !this.vr.widgets.mfd.on) {
      return { ok: false, error: 'the MFD is not switched on in the VR tab' };
    }
    const win = this.win;
    if (!win || win.isDestroyed() || this.info.state !== 'connected') {
      return { ok: false, error: 'the headset panels are not running — is SteamVR up?' };
    }
    try {
      const now = await win.webContents.executeJavaScript(
        'window.ApexMfd && window.ApexMfd.toggleShown ? window.ApexMfd.toggleShown() : null',
        true,
      );
      if (!now) return { ok: false, error: 'the headset MFD is still loading' };
      return { ok: true, value: now };
    } catch (err) {
      return { ok: false, error: (err && err.message) || 'the headset page did not answer' };
    }
  }

  stop() {
    this.destroyWindow();
    this.lastLayoutSent = '';
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
    this.setInfo({ state: 'off', detail: '', runtime: '', fps: 0, uploadMs: 0, mainMs: 0, failures: 0, lastError: '' });
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
    this.lastLayoutSent = '';
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
        ...(connected ? {} : { fps: 0, uploadMs: 0, mainMs: 0, failures: 0 }),
      });
      if (m.state === 'connected') this.ensureWindow();
      else this.destroyWindow();
      return;
    }
    if (m.ev === 'stats') {
      const ms = this.mainStats;
      const mainMs = ms.count ? Math.round((ms.total / ms.count) * 10) / 10 : 0;
      this.mainStats = { total: 0, count: 0 };
      this.setInfo({
        mainMs,
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
      width: START_WIDTH,
      height: START_HEIGHT,
      transparent: true,
      frame: false,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        offscreen: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        zoomFactor: RENDER_SCALE,
      },
    });
    win.webContents.setFrameRate(FRAME_RATE);
    // Every load re-measures; the poll after that follows data-driven heights.
    win.webContents.on('did-finish-load', () => {
      win.webContents.setZoomFactor(RENDER_SCALE);
      void this.pollLayout();
    });
    win.webContents.on('paint', (_evt, _dirty, image) => this.onPaint(image));
    win.webContents.on('render-process-gone', (_evt, details) => {
      this.log(`[vr] panel renderer gone (${details && details.reason}) — rebuilding`);
      this.destroyWindow();
      if (this.info.state === 'connected') setTimeout(() => this.ensureWindow(), 1000).unref();
    });
    win.vrUrl = this.url;
    this.win = win;
    this.pageLayout = null;
    this.applyPainting();
    void win.loadURL(this.url);
    this.layoutTimer = setInterval(() => void this.pollLayout(), LAYOUT_POLL_MS);
    this.layoutTimer.unref();
  }

  destroyWindow() {
    const win = this.win;
    this.win = null;
    this.inFlight = false;
    this.pending = null;
    this.pageLayout = null;
    if (this.layoutTimer) clearInterval(this.layoutTimer);
    this.layoutTimer = null;
    if (win && !win.isDestroyed()) win.destroy();
  }

  /**
   * Ask the page where each widget is (overlay/js/vr-layout.js), size the
   * window to hold them all, and pass any change on to the worker.
   */
  async pollLayout() {
    const win = this.win;
    if (!win || win.isDestroyed() || win.webContents.isLoading()) return;
    let got;
    try {
      got = await win.webContents.executeJavaScript('window.__apexVrLayout ? window.__apexVrLayout() : null', true);
    } catch {
      return;
    }
    if (win !== this.win || win.isDestroyed() || !got || !got.rects) return;
    // The window is in device pixels; the page lays out in CSS pixels, drawn
    // RENDER_SCALE times over.
    const w = Math.ceil(got.width * RENDER_SCALE);
    const h = Math.ceil(got.height * RENDER_SCALE);
    const [cw, ch] = win.getContentSize();
    if (cw !== w || ch !== h) win.setContentSize(w, h);
    this.pageLayout = got;
    this.sendLayout();
  }

  /**
   * Tell the worker which panels to show, where each sits and which region
   * of the page texture it shows. Regions go as fractions of the page (CSS px
   * over CSS px), so they hold whatever scale the page is drawn at. Sent only
   * when something changed — the poll runs every second.
   */
  sendLayout() {
    if (!this.worker || !this.vr) return;
    const L = this.pageLayout;
    const panels = [];
    if (L) {
      for (const id of enabledWidgets(this.vr)) {
        const r = L.rects[id];
        if (!r) continue;
        panels.push({
          id,
          placement: this.vr.widgets[id],
          uv: [r.x / L.width, r.y / L.height, (r.x + r.w) / L.width, (r.y + r.h) / L.height],
        });
      }
    }
    const msg = { cmd: 'layout', panels };
    const key = JSON.stringify(msg);
    if (key === this.lastLayoutSent) return;
    this.lastLayoutSent = key;
    this.worker.postMessage(msg);
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
    const t0 = performance.now();
    const { width, height } = image.getSize();
    if (!width || !height) return;
    const frame = { bitmap: image.toBitmap(), width, height };
    if (this.inFlight) {
      this.pending = frame; // newest wins; the stale one is simply dropped
    } else {
      this.send(frame);
    }
    this.mainStats.total += performance.now() - t0;
    this.mainStats.count++;
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

module.exports = { VrOverlay, FRAME_RATE, RENDER_SCALE };
