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

  /** Subscribe to live status pushes. Returns an unsubscribe function. */
  onStatus: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('status:update', listener);
    return () => ipcRenderer.removeListener('status:update', listener);
  },

  /* ---- App updates (electron-updater via GitHub Releases) ---- */

  /** Current update state (idle/checking/available/downloading/ready/none/error). */
  getUpdateState: () => ipcRenderer.invoke('update:getState'),
  /** Manually check GitHub Releases for a newer version. */
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
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
});
