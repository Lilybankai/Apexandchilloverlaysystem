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
 * Nothing checks that a frame was PAINTED. So the page now reports, once a
 * second, how many frames its rAF actually drew ({@link createLayerDiagnosis}
 * turns those reports into log lines), and this decides what to do when the
 * drawing stops while it should not:
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

/* -------------------------------------------------------------------------- */
/*  Diagnosis: what KIND of freeze it was                                      */
/* -------------------------------------------------------------------------- */

/** The page reports once a second; a report this much later was blocked. */
const REPORT_MS = 1000;
/** Same line the main-process stall log draws: past this a human sees a freeze. */
const BLOCKED_FLOOR_MS = 250;
/**
 * A second in which fewer than this share of the frames that arrived were drawn
 * is a "drawing slowly" second. Low on purpose: rAF legitimately coalesces a
 * 120 Hz feed onto a 60 Hz screen (half), and that must never read as a fault.
 */
const SLOW_SHARE = 0.25;
/** Below this many arrivals a second the share above is too noisy to judge. */
const SLOW_MIN_RECEIVED = 10;

/**
 * Turn the page's once-a-second health reports into stalls.log lines that say
 * which of the ways a layer can freeze this one was. Each answers a different
 * fix, which is the point — "the overlays froze" has been one symptom with at
 * least four causes, and until now the log could only speak for one of them:
 *
 *   - `LAYER STALL Nms blocked` — the page's own thread held for N ms; the
 *     report names the slowest widget and the longest task in that second.
 *     A widget to fix.
 *   - `LAYER not drawing` — frames reach the page, the thread is idle, and the
 *     rAF never runs: Chromium has stopped producing frames for the window
 *     (occlusion, the GPU process, the compositor). Not our JavaScript.
 *   - `LAYER drawing slowly` — the same, partially: most frames dropped.
 *   - `LAYER no frames` — the page's socket is starving while main's is fed.
 *
 * Episodes are logged when they start and when they end, with the duration,
 * so a freeze that heals itself leaves exactly two lines and one that does
 * not leaves the line that says what it was.
 */
function createLayerDiagnosis() {
  let lastReportAt = 0;
  /** Current episode: null, or `{ kind, since }`. */
  let episode = null;

  function classify(r, { visible, feedLive }) {
    if (!visible) return null; // hidden: not drawing is the whole idea
    if (r.received === 0) return feedLive ? 'no frames' : null;
    if (r.painted === 0) return 'not drawing';
    if (r.received >= SLOW_MIN_RECEIVED && r.painted < r.received * SLOW_SHARE) {
      return 'drawing slowly';
    }
    return null;
  }

  return {
    /**
     * @param {number} now
     * @param {{ at?: number, received: number, painted: number, worstMs: number,
     *           worstWidget: string, longMs: number, visibility: string }} r
     * @param {{ visible: boolean, feedLive: boolean }} facts
     * @returns {string[]} lines for stalls.log (without timestamp)
     */
    report(now, r, facts) {
      const lines = [];
      // Timed by the PAGE's clock when it gives one: a report can also arrive
      // late because main was busy, and that is the main stall log's line to
      // write, not a renderer stall.
      const sentAt = typeof r.at === 'number' ? r.at : now;
      const late = lastReportAt ? sentAt - lastReportAt - REPORT_MS : 0;
      lastReportAt = sentAt;
      if (late >= BLOCKED_FLOOR_MS && facts.visible) {
        const worst = r.worstWidget ? ` worst=${r.worstWidget}/${r.worstMs}ms` : '';
        lines.push(`LAYER STALL ${late}ms blocked${worst} long=${r.longMs}ms`);
      }
      const kind = classify(r, facts);
      const counts = `received=${r.received} painted=${r.painted} page=${r.visibility}`;
      if (episode && episode.kind !== kind) {
        lines.push(`LAYER ${episode.kind} ended after ${now - episode.since}ms`);
        episode = null;
      }
      if (kind && !episode) {
        // The report covers the second just gone, so that is when it started.
        episode = { kind, since: now - REPORT_MS };
        lines.push(`LAYER ${kind} (${counts})`);
      }
      return lines;
    },

    /** The window went away or was rebuilt: its episode goes with it. */
    reset() {
      lastReportAt = 0;
      episode = null;
    },
  };
}

module.exports = {
  createLayerWatch,
  createLayerDiagnosis,
  QUIET_MS,
  ESCALATE_MS,
  MAX_RECOVERIES,
  BUDGET_MS,
  BLOCKED_FLOOR_MS,
};
