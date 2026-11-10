/**
 * @file src/telemetry/irEngineerAnswers.ts
 * @module telemetry/irEngineerAnswers
 *
 * The phrase-list answers iRacing needs said differently. `engineerCommands`
 * asks here first on an iRacing frame; `null` means "answer as usual".
 *
 * - **trackLimits** — iRacing's Track Limits block carries INCIDENT points
 *   against the DQ limit, not LMU's stewarding points.
 * - **flags** — iRacing has full-course cautions, a white flag, per-car black
 *   and meatball flags, and a local yellow at the player's own station; it
 *   has no per-sector flags, which is all the generic answer reads.
 * - **damage** — no per-component damage is published; the meatball (and the
 *   repair warning) is what there is.
 * - **lapsLeft** in a lap-limited qualifying run — the run's laps, not a race
 *   distance counted off the leader.
 * - Questions only LMU has data for (virtual energy, hybrid, aids, reference
 *   pace, sector splits, brake wear, the planned stop) — said plainly rather
 *   than "no data", so the driver knows it is not a fault.
 */

import { UNKNOWN_VALUE } from './types';
import type { TelemetryFrame } from './types';
import type { CommandAnswer, CommandIntent } from './engineerCommands';

/** Intents with no iRacing data (keep in step with engineer-panel.js LMU_ONLY_INTENTS). */
export const LMU_ONLY_INTENTS: ReadonlySet<string> = new Set([
  'energy',
  'fuelRatio',
  'hybrid',
  'pace',
  'paceAlien',
  'paceCompetitive',
  'paceMidpack',
  'sectors',
  'mySector',
  'sectorsVs',
  'brakes',
  'brakeBias',
  'tractionControl',
  'pitStop',
]);

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const word = (n: number): string => WORDS[n] ?? String(n);

function known(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n !== UNKNOWN_VALUE;
}

/** iRacing's answer to `intent`, or null to fall through to the generic one. */
export function iracingAnswer(intent: CommandIntent, frame: TelemetryFrame): CommandAnswer | null {
  if (frame.source !== 'iracing') return null;
  const yes = (text: string): CommandAnswer => ({ intent, text, ok: true });
  const no = (text: string): CommandAnswer => ({ intent, text, ok: false });
  const rc = frame.iracing;

  if (LMU_ONLY_INTENTS.has(intent)) {
    return no("iRacing doesn't give us that one — it's Le Mans Ultimate only.");
  }

  switch (intent) {
    case 'trackLimits': {
      const tl = frame.player?.trackLimits;
      if (!tl || !known(tl.points)) return no('No incident data — not in the car.');
      if (tl.disqualified || rc?.disqualified) return yes(`Disqualified — ${tl.points} incidents.`);
      const parts: string[] = [];
      if (known(tl.pointsLimit) && tl.pointsLimit > 0) {
        const left = tl.pointsLimit - tl.points;
        parts.push(`Incidents — ${tl.points} of ${tl.pointsLimit}.`);
        if (left <= 4) parts.push(left <= 1 ? "One more and you're out." : `${word(left)} to the DQ.`.replace(/^./, (c) => c.toUpperCase()));
      } else {
        parts.push(tl.points === 0 ? 'No incidents.' : `${tl.points} incidents.`);
      }
      if (rc?.black) parts.push('Black flag outstanding — serve it in the pit lane.');
      return yes(parts.join(' '));
    }

    case 'flags': {
      const s = frame.session;
      if (s.phase === 'redFlag' || s.flag === 'red') return yes('Red flag — session stopped.');
      if (!rc) return s.phase === 'fullCourseYellow' ? yes("Caution — pace car's out.") : no('No flag data.');
      if (rc.disqualified) return yes("We've been disqualified.");
      const parts: string[] = [];
      if (rc.caution) {
        parts.push(rc.oneLapToGreen ? "Caution — pace car's in this lap, one to green." : "Caution — pace car's out.");
        parts.push(rc.pitsOpen ? 'Pits are open.' : 'Pits are closed.');
      }
      if (rc.black) parts.push('Black flag for us — serve it in the pit lane.');
      else if (rc.furled) parts.push('Black-and-white warning for us.');
      if (rc.meatball) parts.push('Meatball — the car needs repairs.');
      if (!rc.caution && rc.localYellow) parts.push('Yellow at our station — trouble ahead.');
      if (rc.checkered) parts.push('Chequered flag is out.');
      else if (rc.white) parts.push('White flag — last lap.');
      return yes(parts.length ? parts.join(' ') : 'All clear — green.');
    }

    case 'damage': {
      if (!rc) return no('No damage data — not in the car.');
      if (rc.meatball) return yes('Meatball flag — the car needs repairs. Box for them.');
      if (rc.towSec > 0) return yes(`We're being towed in — about ${Math.round(rc.towSec)} seconds.`);
      return yes("No repair flag — iRacing doesn't give us more detail than that.");
    }

    case 'lapsLeft': {
      if (frame.session.type !== 'qualifying' || !rc || rc.lapLimit <= 0) return null;
      const limit = rc.lapLimit;
      if (rc.sessionDone) return yes("Your run's done.");
      if (rc.outLap || !known(rc.lapsCompleted)) {
        return yes(`Out lap, then ${word(limit)} timed ${limit === 1 ? 'lap' : 'laps'}.`);
      }
      const left = limit - rc.lapsCompleted;
      if (left <= 1) return yes('This is your last timed lap.');
      return yes(`${word(left).replace(/^./, (c) => c.toUpperCase())} timed laps left, including this one.`);
    }

    default:
      return null;
  }
}
