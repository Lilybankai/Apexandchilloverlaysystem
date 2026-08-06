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

  /**
   * Desktop geometry the layout is expressed against:
   * `{ padX, padY, width, height, primary: {width, height}, rects: [...] }`.
   * The window spans every display, so on a triple-screen rig this is what
   * tells the page that there is canvas either side of the main screen —
   * and where the bezels fall, so a widget cannot be dropped into the dead
   * space a staggered arrangement leaves in the desktop rectangle.
   */
  getScreens: () => ipcRenderer.invoke('ingame:screensGet'),

  /** Desktop changed shape (monitor plugged in, resolution changed). */
  onScreens: (callback) => {
    ipcRenderer.on('ingame:screens', (_evt, screens) => callback(screens));
  },

  /** Leave edit mode (the page's "Done" button); re-locks the window. */
  editDone: () => ipcRenderer.invoke('ingame:editDone'),

  /** Reset every widget to its default position. */
  layoutReset: () => ipcRenderer.invoke('ingame:layoutReset'),

  /** Edit-mode toggled from the control panel. */
  onEdit: (callback) => {
    ipcRenderer.on('ingame:edit', (_evt, editing) => callback(!!editing));
  },

  /** Interact-mode toggled (whole layer clickable) from the hotkey/main. */
  onInteract: (callback) => {
    ipcRenderer.on('ingame:interact', (_evt, on) => callback(!!on));
  },

  /** Leave interact mode from the page banner; re-locks the window. */
  interactStop: () => ipcRenderer.invoke('ingame:interactStop'),

  /** Layout was reset from the control panel. */
  onLayoutReset: (callback) => {
    ipcRenderer.on('ingame:layout-reset', () => callback());
  },

  /**
   * Widget-background opacity pushed from the control panel's slider:
   * `{ panelOpacity: 0..100 }`. Consumed by overlay/js/appearance.js, which
   * uses this instead of polling the server precisely because this layer
   * repaints over the running sim.
   */
  onAppearance: (callback) => {
    ipcRenderer.on('ingame:appearance', (_evt, appearance) => callback(appearance));
  },
});
