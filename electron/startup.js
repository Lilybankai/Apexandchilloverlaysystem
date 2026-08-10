/**
 * electron/startup.js — launch-at-login and how a launch presents itself.
 * -----------------------------------------------------------------------------
 * Two questions the desktop app has to answer before it draws anything:
 *
 *   1. What do we write into Windows' Run key so the app comes back after a
 *      reboot — and, just as importantly, when must we write NOTHING?
 *   2. Given how this process was started, does the window belong on screen, in
 *      the tray, or on the taskbar?
 *
 * Both are one-liners with a trap underneath, and both are invisible from the
 * running app: a wrong Run-key entry only shows up at the next reboot, on
 * someone else's PC. So they live here as pure functions over plain values —
 * no Electron, no registry, no filesystem — and are asserted directly by
 * scripts/test-startup.js.
 */

'use strict';

/**
 * The flag the login-item entry carries. A machine boot should not throw a
 * maximised window over whatever the person is doing; it should put the app
 * where it can work quietly. So the auto-start entry launches the same exe with
 * this flag, and the app reads it to decide where to open.
 *
 * A flag rather than a setting because it distinguishes THIS launch's origin
 * (Windows started us) from the operator's preferences, which cannot tell the
 * difference between a boot and a double-click.
 */
const HIDDEN_FLAG = '--hidden';

/** Was this process started by the login item (i.e. by Windows, at boot)? */
function wantsHiddenStart(argv) {
  if (!Array.isArray(argv)) return false;
  return argv.some((a) => typeof a === 'string' && a.trim().toLowerCase() === HIDDEN_FLAG);
}

/**
 * What to hand `app.setLoginItemSettings`, or `null` when the entry must not be
 * touched at all.
 *
 * `null` for a DEV run is the point of this function. An unpackaged run's
 * `process.execPath` is node_modules/electron/dist/electron.exe — writing that
 * into the Run key registers a bare Electron with no app path behind it, so
 * every boot of the developer's machine opens an empty grey window forever,
 * long after the checkout is gone. The setting is still saved either way; it is
 * only the registry write that waits for a real install.
 *
 * `path` and `args` are passed when DISABLING too: Electron matches the entry
 * it removes against them, and a disable that quietly matched nothing would
 * leave the app auto-starting with the switch showing off.
 */
function loginItemSettingsFor({ enabled, execPath, isPackaged } = {}) {
  if (!isPackaged) return null;
  if (typeof execPath !== 'string' || !execPath.trim()) return null;
  return {
    openAtLogin: !!enabled,
    path: execPath,
    args: [HIDDEN_FLAG],
  };
}

/**
 * Where this launch's window goes:
 *
 *   'maximized'  the operator opened the app — fill the screen
 *   'tray'       Windows opened it and the tray icon exists — go there
 *   'minimized'  Windows opened it but the OS refused the tray icon — the
 *                taskbar is the only place left the operator can find it again
 *
 * `trayAvailable` is a fact about this run (did the Tray actually get
 * created?), not a preference: minimise-to-tray used to be a setting, and its
 * off position was nothing but a taskbar button people read as a regression.
 * The third case is why this is a function and not a boolean — starting hidden
 * with no tray icon would leave a running app with no way back to it short of
 * Task Manager.
 */
function initialWindowMode({ argv, trayAvailable } = {}) {
  if (!wantsHiddenStart(argv)) return 'maximized';
  return trayAvailable ? 'tray' : 'minimized';
}

module.exports = {
  HIDDEN_FLAG,
  wantsHiddenStart,
  loginItemSettingsFor,
  initialWindowMode,
};
