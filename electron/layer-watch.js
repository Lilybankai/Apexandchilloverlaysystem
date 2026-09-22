/**
 * electron/layer-watch.js — notice when the in-game layer stops painting, and
 * bring it back without the driver pressing Stop/Start.
 * -----------------------------------------------------------------------------
 * The stall log can only see the main process. By 1.1.0 it had gone quiet —
 * the one race-time entry left on the 22 Sep log is 350 ms of a PARKED thread
 * (`cpu=7%`, `hot=(idle)`), Windows descheduling us rather than anything we
 * ran — and a tester still had the overlays freeze in the same race, some of
 * them for good until Stop/Start. So the freeze that remains is not in main.
 *
 * What Stop/Start actually does to the layer is destroy its window and build a
 * new one: a fresh renderer and a fresh compositor surface. That it cures the
 * freeze says the thing that wedged lives in one of those — a renderer that
 * hung or died, a GPU process that restarted underneath a transparent window,
 * or Windows deciding the always-on-top layer is occluded and Chromium
 * stopping its frames. None of them is visible to anything that already
 * watches the layer:
 *
 *   - the page's own stale-feed watchdog (overlay/js/client.js) checks that
 *     frames ARRIVE, and they still do — the socket is fine;
 *   - main's status feed checks the server, which is fine too.
 *
 * Nothing checks that a frame was PAINTED. So the page now reports, at most
 * once a second, that its rAF actually ran a frame through the widgets, and
 * this decides what to do when those reports stop while they should not:
 *
 *   1. quiet for {@link QUIET_MS} with the layer on screen and the feed live
 *      → reload the page (new document, same window);
 *   2. quiet again within {@link ESCALATE_MS} of a reload → recreate the
 *      window, which is exactly what Stop/Start did by hand;
 *   3. more than {@link MAX_RECOVERIES} recoveries in {@link BUDGET_MS} →
 *      stop trying and say so once, so a fault this cannot fix costs a log
 *      line rather than a window flickering every ten seconds all race.
 *
 * Pure: no Electron, no timers of its own. main.js feeds it facts and acts on
 * the verdict; scripts/test-layerwatch.js feeds it invented ones.
 */

'use strict';

/**
 * How long the layer may go without painting before it is treated as frozen.
 * Longer than the page's own recovery on purpose: a socket that went quiet is
 * noticed at 5 s and redialled well inside 10, and that is the page healing
 * itself, not a wedge worth a reload.
 */
const QUIET_MS = 10000;
/** A second freeze this soon after a reload means the reload did not help. */
const ESCALATE_MS = 60000;
/** At most this many recoveries per {@link BUDGET_MS}, then give up loudly. */
const MAX_RECOVERIES = 4;
const BUDGET_MS = 10 * 60 * 1000;

function createLayerWatch() {
  /** Last paint report from the page, or the last moment it was excused. */
  let since = 0;
  /**
   * Only a layer that has painted at least once is held to account. A page
   * that never reports — an old build served by mistake, a page that failed
   * to boot — would otherwise be reloaded forever for something a reload
   * cannot fix. Survives reloads and recreates on purpose: a layer that
   * painted, froze and came back from a reload unable to paint is the case
   * escalation exists for.
   */
  let armed = false;
  /** When each recovery was taken, oldest first — the escalation and the budget. */
  let recoveries = [];
  let gaveUp = false;

  return {
    /** The page painted a frame. */
    painted(now) {
      since = now;
      armed = true;
    },

    /**
     * Start the quiet clock again without claiming a paint: the window was
     * just shown, loaded or created, and deserves the full grace period.
     */
    excuse(now) {
      since = now;
    },

    /** A deliberate stop — the next layer starts with a clean record. */
    forget() {
      since = 0;
      armed = false;
      recoveries = [];
      gaveUp = false;
    },

    /**
     * @param {{ now: number, visible: boolean, loading: boolean, feedLive: boolean }} s
     * @returns {{ action: 'ok' | 'reload' | 'recreate' | 'give-up', quietMs: number }}
     */
    check({ now, visible, loading, feedLive }) {
      // Hidden (auto show/hide in the menus), mid-load, or nothing to paint:
      // silence is expected, so it must not count once the layer is back.
      if (!visible || loading || !feedLive || !armed) {
        since = now;
        return { action: 'ok', quietMs: 0 };
      }
      const quietMs = now - since;
      if (quietMs < QUIET_MS) return { action: 'ok', quietMs };
      if (gaveUp) return { action: 'ok', quietMs };

      recoveries = recoveries.filter((at) => now - at < BUDGET_MS);
      if (recoveries.length >= MAX_RECOVERIES) {
        gaveUp = true;
        return { action: 'give-up', quietMs };
      }
      const lastAt = recoveries.length ? recoveries[recoveries.length - 1] : -Infinity;
      recoveries.push(now);
      since = now;
      return { action: now - lastAt < ESCALATE_MS ? 'recreate' : 'reload', quietMs };
    },
  };
}

module.exports = { createLayerWatch, QUIET_MS, ESCALATE_MS, MAX_RECOVERIES, BUDGET_MS };
