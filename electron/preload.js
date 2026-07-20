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

  /* ---- In-game overlay layer ---- */

  /** Unlock the in-game layer for on-screen drag/resize editing. */
  ingameEditStart: () => ipcRenderer.invoke('ingame:editStart'),
  /** Re-lock the in-game layer (click-through again). */
  ingameEditStop: () => ipcRenderer.invoke('ingame:editStop'),
  /** Reset every in-game widget to its default position. */
  ingameLayoutReset: () => ipcRenderer.invoke('ingame:layoutReset'),

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
