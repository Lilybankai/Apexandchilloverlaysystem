/**
 * habits-ipc.js — "Your driving" (the AI driving coach's habits view) for the
 * Practice tab: `practice:habits`.
 * =============================================================================
 *
 *   practice:habits  { trackKey, carClass } → { ok, report: HabitsReport | null, error? }
 *
 * The report is src/telemetry/drivingHabits.ts's: the session-by-session
 * trend, per-corner consistency and the whole-lap habits at one track in one
 * class, each number with a CoachFact. Built by drivingHabitsLoad.ts, which
 * keeps a per-lap feature cache in `~/.apex-overlay/coach/` so a visit after
 * the first parses only the laps driven since (cold ~0.2–0.3 s on the
 * biggest track on the dev PC, warm ~12 ms) — and does even the cold pass
 * asynchronously, yielding every few ms, because this is Electron's main
 * process and the in-game overlay hangs off it.
 *
 * Beta-only like the rest of the Practice tab: off the beta channel it answers
 * `ok: false` and the panel hides the piece.
 *
 * Wired from main.js with one line next to the `practice:*` handlers:
 *
 *   require('./habits-ipc').register(ipcMain, {
 *     allowed: () => practiceOnThisChannel(loadSettings()),
 *     reviewDir: practiceReviewsDir,
 *   });
 *
 * Lazily requires `dist/` for the same reason the practice handlers do: an
 * unbuilt `dist/` must cost this view its content, not the window.
 */

'use strict';

const path = require('path');

/**
 * @param {Electron.IpcMain} ipcMain
 * @param {{ allowed?: () => boolean, reviewDir?: () => string, distDir?: string, log?: Pick<Console, 'log' | 'error'> }} deps
 */
function register(ipcMain, deps = {}) {
  const distDir = deps.distDir || path.join(__dirname, '..', 'dist');
  const log = deps.log || console;

  ipcMain.handle('practice:habits', async (_evt, req) => {
    const trackKey = req && typeof req.trackKey === 'string' ? req.trackKey : '';
    const carClass = req && typeof req.carClass === 'string' ? req.carClass : '';
    if (!trackKey) return { ok: false, report: null, error: 'no track' };
    try {
      if (typeof deps.allowed === 'function' && !deps.allowed()) {
        return { ok: false, report: null, error: 'beta only' };
      }
    } catch {
      return { ok: false, report: null, error: 'beta only' };
    }
    try {
      const { loadDrivingHabits } = require(path.join(distDir, 'telemetry', 'drivingHabitsLoad.js'));
      let reviewDir;
      try {
        reviewDir = typeof deps.reviewDir === 'function' ? deps.reviewDir() : deps.reviewDir;
      } catch {
        reviewDir = undefined;
      }
      const report = await loadDrivingHabits(
        { trackKey, carClass },
        {
          ...(reviewDir ? { reviewDir } : {}),
          onStats: (s) => {
            // One line per cold pass, so a slow first visit shows up in the log.
            if (s.extracted > 0 || s.accuracyBuilt > 0) {
              log.log(`[habits] ${trackKey} ${carClass}: ${s.ms} ms, ${s.tracesRead} traces read, ${s.extracted} laps extracted`);
            }
          },
        },
      );
      return report ? { ok: true, report } : { ok: false, report: null, error: 'no sessions here' };
    } catch (err) {
      log.error('[app] driving habits unavailable:', err && err.message);
      return { ok: false, report: null, error: (err && err.message) || 'failed' };
    }
  });
}

module.exports = { register };
