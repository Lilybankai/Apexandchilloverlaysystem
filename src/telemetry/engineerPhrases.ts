/**
 * @file src/telemetry/engineerPhrases.ts
 * @module telemetry/engineerPhrases
 *
 * **What the engineer actually says.** The push side's phrasebook: one
 * {@link EngineerCue} in, one spoken sentence out. `triggers.ts` decides *when*
 * to speak and renders only a tuning-log line; this module owns the words, so
 * the two can be judged separately — the moment can be right while the phrasing
 * is bad, and vice versa.
 *
 * The rules, from the v3 plan (§6):
 *
 * - **One fact, one sentence.** A cue that carries several triggers leads with
 *   the highest-priority one; at most one short addon survives, and only when it is
 *   something a driver must not miss (a penalty, damage, a critical fuel call).
 * - **Never read the screen out.** Nothing here repeats a number a widget shows
 *   continuously; the push side earns its place on things you'd otherwise miss.
 * - **Numbers through one formatter.** Every lap time and gap goes through
 *   `engineerCommands`' speakable helpers, so the radio can never round or
 *   phrase a number differently from an asked-for answer (seam 1).
 *
 * Pure and headless like its siblings: no audio, no state, no clock — which is
 * what lets the replay harness print a whole race's radio verbatim.
 */

import type { EngineerCue, EngineerTrigger } from './triggers';
import type { TelemetryFrame } from './types';
import { UNKNOWN_VALUE } from './types';
import { speakableLapTime, speakableGap } from './engineerCommands';

/** Surname-ish token for radio brevity, mirroring engineerCommands' habit. */
function surname(name: unknown): string {
  const s = String(name ?? '').trim();
  if (!s) return 'the car';
  const parts = s.split(/\s+/);
  return parts[parts.length - 1] ?? s;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v !== UNKNOWN_VALUE ? v : undefined;
}

/** The driver's position for speech — class position when the cue knows it. */
function spokenPosition(cue: EngineerCue): string | null {
  const cls = num(cue.context.classPosition);
  if (cls !== undefined) return `P${cls}`;
  const overall = num(cue.context.position);
  return overall !== undefined ? `P${overall}` : null;
}

/** The lead trigger's sentence. Returns null only for a kind with no words yet. */
function leadSentence(cue: EngineerCue, lead: EngineerTrigger, frame: TelemetryFrame | null): string | null {
  const f = lead.facts;
  switch (lead.kind) {
    case 'raceStart': {
      const pos = spokenPosition(cue);
      const cars = num(cue.context.numCars);
      const where = pos ? ` ${pos}${cars ? `, ${cars} cars` : ''}.` : '';
      return `Green green green.${where}`;
    }

    case 'restart': {
      const pos = spokenPosition(cue);
      return `Green flag — we're racing again.${pos ? ` ${pos}.` : ''}`;
    }

    case 'fullCourseYellow':
      return 'Full course yellow — safety car. No overtaking, watch your delta.';

    case 'redFlag':
      return "Red flag, red flag. Session's stopped.";

    case 'finalLap': {
      const pos = spokenPosition(cue);
      return pos ? `Last lap. ${pos} — bring it home.` : 'Last lap — bring it home.';
    }

    case 'checkered': {
      const pos = spokenPosition(cue);
      const me = frame?.standings?.find((e) => e.isPlayer);
      const best =
        me && num(me.bestLapSec) !== undefined && me.bestLapSec > 0
          ? ` Best lap ${speakableLapTime(me.bestLapSec)}.`
          : '';
      return `Chequered flag.${pos ? ` ${pos}.` : ''}${best} Good drive.`;
    }

    case 'incident': {
      const severity = String(f.severity ?? 'light');
      const repair = num(f.repairSeconds);
      const again = f.repeat === true;
      if (severity === 'heavy') {
        return `${again ? 'More contact — ' : ''}Heavy damage.${
          repair ? ` Repairs about ${Math.round(repair)} seconds — think about boxing.` : ''
        }`;
      }
      if (severity === 'moderate') {
        return `${again ? 'More contact' : 'Contact'} — moderate damage.${
          repair ? ` About ${Math.round(repair)} seconds to fix if you box.` : ''
        }`;
      }
      return `${again ? 'More contact' : 'Contact'} — light damage, keep going.`;
    }

    case 'penalty': {
      const type = typeof f.penaltyType === 'string' && f.penaltyType ? f.penaltyType : null;
      return type ? `Penalty — ${type}.` : 'Penalty from race control.';
    }

    case 'penaltyServed':
      return "Penalty served — you're clear.";

    case 'fuelWindow': {
      const laps = num(f.lapsLeft);
      const budget = f.budget === 'energy' ? 'energy' : 'fuel';
      return laps !== undefined
        ? `Pit window — ${laps.toFixed(1)} laps of ${budget} left.`
        : `Pit window — ${budget} is getting low.`;
    }

    case 'fuelCritical': {
      const reason = f.reason === 'energy' ? 'energy' : 'fuel';
      return `Box this lap, box box — the ${reason} won't do another.`;
    }

    case 'fastestLapSelf': {
      const sec = num(f.lapSec);
      return sec !== undefined
        ? `That's your quickest — ${speakableLapTime(sec)}.`
        : "That's your quickest lap.";
    }

    case 'fastestLapField': {
      const sec = num(f.lapSec);
      const who = surname(f.name);
      return sec !== undefined
        ? `Fastest lap, ${who}, ${speakableLapTime(sec)}.`
        : `Fastest lap to ${who}.`;
    }

    case 'positionChange': {
      const to = num(f.to);
      if (to === undefined) return null;
      return f.gained === true ? `Up to P${to}. Keep it rolling.` : `P${to} now. Head down.`;
    }

    case 'rivalPitted': {
      const where = f.where === 'behind' ? 'behind' : 'ahead';
      return `${surname(f.name)}, the car ${where}, has boxed.`;
    }

    case 'pitWindowOpen':
      return "Pit window's open.";

    case 'yieldTo': {
      const gap = num(f.gapSec);
      if (typeof f.name === 'string' && f.name) {
        return gap !== undefined
          ? `Blue flags — ${surname(f.name)} closing, ${speakableGap(gap)} back. Hold your line.`
          : `Blue flags — ${surname(f.name)} closing. Hold your line.`;
      }
      return 'Blue flags — faster car closing. Hold your line.';
    }
  }
}

/**
 * The short must-not-miss addon for a secondary trigger folded into the same
 * cue. Deliberately tiny: coalescing exists so simultaneous events become one
 * calm line, not a paragraph. Anything not in this table is simply dropped —
 * "a cue that has three things to say has one thing to say and two to discard."
 */
function addonFor(kind: EngineerTrigger['kind']): string | null {
  switch (kind) {
    case 'penalty':
      return "And there's a penalty — check the list.";
    case 'incident':
      return "And you've picked up damage.";
    case 'fuelCritical':
      return 'And box this lap for fuel.';
    default:
      return null;
  }
}

/**
 * One cue → the sentence the voice speaks. `frame` is optional context for the
 * few kinds that read beyond the cue (the chequered-flag best lap); everything
 * else comes from the cue's own facts, captured at the moment of the edge.
 */
export function phraseForCue(cue: EngineerCue, frame: TelemetryFrame | null = null): string | null {
  const lead = cue.triggers[0];
  if (!lead) return null;
  const sentence = leadSentence(cue, lead, frame);
  if (!sentence) return null;
  for (const extra of cue.triggers.slice(1)) {
    const addon = addonFor(extra.kind);
    if (addon) return `${sentence} ${addon}`;
  }
  return sentence;
}
