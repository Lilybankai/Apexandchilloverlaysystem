/**
 * electron/ingame-preload.js — bridge for the in-game overlay layer window.
 * -----------------------------------------------------------------------------
 * Loaded by the transparent always-on-top window that renders widgets over the
 * sim (overlay/ingame.html, served from the local telemetry server). Exposes
 * only the layout/edit surface the page needs; everything else stays isolated.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apexIngame', {
  /** Saved widget placement: { [id]: {x, y, scale} }. */
  getLayout: () => ipcRenderer.invoke('ingame:layoutGet'),

  /** Persist widget placement (merged per-widget in the main process). */
  saveLayout: (layout) => ipcRenderer.invoke('ingame:layoutSave', layout),

  /** Leave edit mode (the page's "Done" button); re-locks the window. */
  editDone: () => ipcRenderer.invoke('ingame:editDone'),

  /** Reset every widget to its default position. */
  layoutReset: () => ipcRenderer.invoke('ingame:layoutReset'),

  /** Edit-mode toggled from the control panel. */
  onEdit: (callback) => {
    ipcRenderer.on('ingame:edit', (_evt, editing) => callback(!!editing));
  },

  /** Layout was reset from the control panel. */
  onLayoutReset: (callback) => {
    ipcRenderer.on('ingame:layout-reset', () => callback());
  },
});
