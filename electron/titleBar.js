'use strict';

/**
 * electron/titleBar.js — the control panel's own title bar.
 * -----------------------------------------------------------------------------
 * The main window draws no Windows caption bar. The panel's top strip
 * (`.topbar` in hub.css) runs to the top edge and is the window's drag area,
 * and Windows still draws the real minimise / maximise / close buttons on top
 * of it through Electron's title bar overlay, coloured to match.
 *
 * Why the overlay and not hand-drawn buttons: the overlay keeps the genuine
 * caption buttons, so Snap Layouts on the maximise button, the red close hover,
 * hit-testing at the screen edge when maximised, Alt+Space and screen readers
 * all behave exactly as they do in every other Windows app. Hand-drawn buttons
 * would have to re-implement each of those and would still miss Snap Layouts.
 *
 * The page finds the buttons through the CSS `env(titlebar-area-*)` variables
 * (see hub.css / auth.css), so nothing here has to know the button width,
 * which Windows varies with the display scale.
 *
 * The main window and the Terms & Privacy window use this. The in-game,
 * training and VR layers are frameless on purpose.
 */

/*
 * The panel's top strip is 46px including its 1px bottom rule (hub.css
 * `.topbar`). The buttons fill the 45px above the rule, so the rule runs
 * unbroken under them and a hovered button never paints over it.
 */
const TOPBAR_HEIGHT = 46;
const OVERLAY_HEIGHT = TOPBAR_HEIGHT - 1;

/*
 * The strip's colour is rgba(6,10,18,0.97) over the page's #060a12, which is
 * #060a12 — control-panel.css `--bg`. The glyphs are `--text-2`, the panel's
 * secondary text, so they sit at the same weight as the strip's other chrome
 * rather than shouting in pure white. Windows derives the hover fill from
 * these, and keeps its own red for close.
 *
 * The panel has one theme. If it ever gains a light one, add it here and call
 * `win.setTitleBarOverlay(titleBarOverlay(theme))` when it changes.
 */
const OVERLAY_COLOURS = Object.freeze({
  color: '#060a12',
  symbolColor: '#9aa4b8',
});

/** The `titleBarOverlay` options, also valid for `win.setTitleBarOverlay`. */
function titleBarOverlay() {
  return { ...OVERLAY_COLOURS, height: OVERLAY_HEIGHT };
}

/** Spread into the main window's BrowserWindow options. */
function mainWindowChrome() {
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
  };
}

/*
 * The Terms & Privacy window (control-panel/legal.html). Its header is the
 * document's own `--panel` (#0b1120), a shade lighter than the control
 * panel's strip, with `--dim` (#8b96ad) secondary text; the buttons take
 * those so they read as part of that header. Same 46px header, same 45px
 * buttons above its 1px rule.
 */
const LEGAL_OVERLAY_COLOURS = Object.freeze({
  color: '#0b1120',
  symbolColor: '#8b96ad',
});

/** Spread into the Terms & Privacy window's BrowserWindow options. */
function legalWindowChrome() {
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...LEGAL_OVERLAY_COLOURS, height: OVERLAY_HEIGHT },
  };
}

module.exports = {
  TOPBAR_HEIGHT,
  OVERLAY_HEIGHT,
  titleBarOverlay,
  mainWindowChrome,
  legalWindowChrome,
};
