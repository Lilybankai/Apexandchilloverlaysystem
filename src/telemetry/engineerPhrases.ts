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
 * ## Every call has more than one way of being said
 * A fixed sentence per kind sounds like a screen reader by the third fastest
 * lap. Each kind therefore carries a small bank of **variants** — same facts,
 * different delivery — and one is picked per cue. Adding a line is adding one
 * string to the array; the facts are interpolated the same way in all of them.
 *
 * The pick is **deterministic, not random**: it is derived from the cue's own
 * timestamp, so replaying a recording produces the same radio every time (the
 * tuning loop depends on that), while consecutive cues in a live race land on
 * different lines. Tests pass an explicit `variant` to pin a wording; index 0
 * is always the canonical line.
 *
 * The rules, from the v3 plan (§6), unchanged:
 *
 * - **One fact, one sentence.** A cue that carries several triggers leads with
 *   the highest-priority one; at most one short addon survives, and only when
 *   it is something a driver must not miss.
 * - **Never read the screen out.** The push side earns its place on things
 *   you'd otherwise miss.
 * - **Numbers through one formatter.** Every lap time and gap goes through
 *   `engineerCommands`' speakable helpers, so the radio can never round or
 *   phrase a number differently from an asked-for answer (seam 1).
 *
 * Pure and headless like its siblings: no audio, no state, no clock.
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

/** One of the bank, by the resolved variant number. Index 0 is canonical. */
function pick(variant: number, bank: readonly string[]): string {
  return bank[Math.abs(variant) % bank.length]!;
}

/** The driver's position for speech — class position when the cue knows it. */
function spokenPosition(cue: EngineerCue): string | null {
  const cls = num(cue.context.classPosition);
  if (cls !== undefined) return `P${cls}`;
  const overall = num(cue.context.position);
  return overall !== undefined ? `P${overall}` : null;
}

/** The lead trigger's sentence. Returns null only for a kind with no words yet. */
function leadSentence(
  cue: EngineerCue,
  lead: EngineerTrigger,
  frame: TelemetryFrame | null,
  v: number,
): string | null {
  const f = lead.facts;
  switch (lead.kind) {
    case 'raceStart': {
      const pos = spokenPosition(cue);
      const cars = num(cue.context.numCars);
      const where = pos ? ` ${pos}${cars ? `, ${cars} cars` : ''}.` : '';
      return pick(v, [
        `Green green green.${where}`,
        `Lights out — we're racing.${where}`,
        `Green flag, green flag.${where} Clean first lap now.`,
      ]);
    }

    case 'restart': {
      const pos = spokenPosition(cue);
      const where = pos ? ` ${pos}.` : '';
      return pick(v, [
        `Green flag — we're racing again.${where}`,
        `Back to green.${where} Heads up into turn one.`,
        `And we go again — green green green.${where}`,
      ]);
    }

    case 'fullCourseYellow':
      return pick(v, [
        'Full course yellow — safety car. No overtaking, watch your delta.',
        'Safety car, safety car. Hold position, watch the delta.',
        'Full course yellow. Slow it down, no passing — think about the stop.',
      ]);

    case 'redFlag':
      return pick(v, [
        "Red flag, red flag. Session's stopped.",
        'Red flag — everything stops. Come back to the pits, slowly.',
      ]);

    case 'finalLap': {
      const pos = spokenPosition(cue);
      // No "white flag": Le Mans Ultimate never shows one — the chequered flag
      // comes out and the cars still running complete the lap they are on
      // (probed through a full race finish, 2026-08-22). Saying a flag the
      // driver cannot see is the engineer describing a different race.
      return pick(
        v,
        pos
          ? [
              `Last lap. ${pos} — bring it home.`,
              `Chequered's out — this is the last one. ${pos}. Keep it clean.`,
              `Final lap, ${pos}. Nothing silly now.`,
            ]
          : [
              'Last lap — bring it home.',
              "Chequered's out. This lap is the last one.",
              'Final lap. Nothing silly now.',
            ],
      );
    }

    case 'checkered': {
      // The LATCHED result the trigger carries, not the live position in the
      // context: by the time this is spoken the rest of the field is still
      // coming round, and the number on the screen has already moved.
      const cls = num(f.classPosition) ?? num(cue.context.classPosition);
      const overall = num(f.position) ?? num(cue.context.position);
      const pos = cls !== undefined ? `P${cls}` : overall !== undefined ? `P${overall}` : null;
      const me = frame?.standings?.find((e) => e.isPlayer);
      const best =
        me && num(me.bestLapSec) !== undefined && me.bestLapSec > 0
          ? ` Best lap ${speakableLapTime(me.bestLapSec)}.`
          : '';
      const where = pos ? ` ${pos}.` : '';
      return pick(v, [
        `Chequered flag.${where}${best} Good drive.`,
        `That's the flag.${where}${best} Well done today.`,
        `Chequered flag — we're done.${where}${best} Nice job.`,
      ]);
    }

    case 'incident': {
      const severity = String(f.severity ?? 'light');
      const repair = num(f.repairSeconds);
      const again = f.repeat === true;
      if (severity === 'heavy') {
        const fix = repair ? ` Repairs about ${Math.round(repair)} seconds — think about boxing.` : '';
        return pick(v, [
          `${again ? 'More contact — ' : ''}Heavy damage.${fix}`,
          `${again ? 'Again — ' : ''}That's a big one. Heavy damage.${fix}`,
        ]);
      }
      if (severity === 'moderate') {
        const fix = repair ? ` About ${Math.round(repair)} seconds to fix if you box.` : '';
        return pick(v, [
          `${again ? 'More contact' : 'Contact'} — moderate damage.${fix}`,
          `${again ? 'Contact again' : 'Contact'} — you've picked up moderate damage.${fix}`,
        ]);
      }
      return pick(v, [
        `${again ? 'More contact' : 'Contact'} — light damage, keep going.`,
        `${again ? 'Contact again' : 'Contact'} — it's light, nothing to worry about.`,
        `${again ? 'More contact' : 'Contact'} — cosmetic only. Push on.`,
      ]);
    }

    case 'penalty': {
      const type = typeof f.penaltyType === 'string' && f.penaltyType ? f.penaltyType : null;
      return pick(
        v,
        type
          ? [`Penalty — ${type}.`, `Stewards have given us a ${type}.`, `That's a penalty — ${type}. We'll deal with it.`]
          : ['Penalty from race control.', "Stewards' decision against us — penalty."],
      );
    }

    case 'penaltyServed':
      return pick(v, [
        "Penalty served — you're clear.",
        "That's the penalty done. Clean slate — go.",
        'Penalty cleared. Back to racing.',
      ]);

    case 'fuelWindow': {
      const laps = num(f.lapsLeft);
      const budget = f.budget === 'energy' ? 'energy' : 'fuel';
      if (laps === undefined) return `Pit window — ${budget} is getting low.`;
      const n = laps.toFixed(1);
      return pick(v, [
        `Pit window — ${n} laps of ${budget} left.`,
        `We're in the window. ${n} laps of ${budget} on board.`,
        `${n} laps of ${budget} left — window's open when you want it.`,
      ]);
    }

    case 'fuelCritical': {
      const reason = f.reason === 'energy' ? 'energy' : 'fuel';
      return pick(v, [
        `Box this lap, box box — the ${reason} won't do another.`,
        `Box box box. This lap — we're out of ${reason} otherwise.`,
      ]);
    }

    case 'fastestLapSelf': {
      const sec = num(f.lapSec);
      if (sec === undefined) return "That's your quickest lap.";
      const t = speakableLapTime(sec);
      return pick(v, [
        `That's your quickest — ${t}.`,
        `Personal best, ${t}. Keep that rhythm.`,
        `Quickest lap yet — ${t}. Car's underneath you.`,
        `${t} — that's your best of the race.`,
      ]);
    }

    case 'fastestLapField': {
      const sec = num(f.lapSec);
      const who = surname(f.name);
      if (sec === undefined) return `Fastest lap to ${who}.`;
      const t = speakableLapTime(sec);
      return pick(v, [
        `Fastest lap, ${who}, ${t}.`,
        `${who} goes quickest — ${t}.`,
        `Purple for ${who}, ${t}. That's the benchmark.`,
      ]);
    }

    case 'positionChange': {
      const to = num(f.to);
      if (to === undefined) return null;
      return pick(
        v,
        f.gained === true
          ? [`Up to P${to}. Keep it rolling.`, `That's P${to}. Nicely done.`, `P${to} now — good work, keep at it.`]
          : [`P${to} now. Head down.`, `Back to P${to}. Deep breath, get it back.`, `P${to}. Forget it — next corner.`],
      );
    }

    case 'rivalPitted': {
      const where = f.where === 'behind' ? 'behind' : 'ahead';
      const who = surname(f.name);
      return pick(v, [
        `${who}, the car ${where}, has boxed.`,
        `${who} ${where} of us is in the pits.`,
        `The car ${where} — ${who} — just pitted. This is our window to respond.`,
      ]);
    }

    case 'pitWindowOpen':
      return pick(v, [
        "Pit window's open.",
        "Window's open — box when you're ready.",
        'Pit window is open. Talk to me when you want the stop.',
      ]);

    case 'yieldTo': {
      const gap = num(f.gapSec);
      const who = typeof f.name === 'string' && f.name ? surname(f.name) : null;
      if (who && gap !== undefined) {
        const g = speakableGap(gap);
        return pick(v, [
          `Blue flags — ${who} closing, ${g} back. Hold your line.`,
          `Faster class behind — ${who}, ${g}. Stay predictable, don't lose time.`,
          `${who} coming through, ${g} back. Blue flags — hold your line, they'll find a way.`,
        ]);
      }
      return pick(v, [
        'Blue flags — faster car closing. Hold your line.',
        'Faster class behind. Stay on line, let them work it out.',
      ]);
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
 * One cue → the sentence the voice speaks.
 *
 * @param frame - Optional context for the few kinds that read beyond the cue
 *   (the chequered-flag best lap); everything else comes from the cue's own
 *   facts, captured at the moment of the edge.
 * @param variant - Which line of each kind's bank to use. Omit it and the
 *   choice is derived from the cue's timestamp — stable in replays, varied
 *   live. Tests pass `0` to pin the canonical wording.
 */
export function phraseForCue(
  cue: EngineerCue,
  frame: TelemetryFrame | null = null,
  variant?: number,
): string | null {
  const lead = cue.triggers[0];
  if (!lead) return null;
  // Knuth's multiplicative hash over the cue time, keeping the HIGH bits — a
  // plain divide correlates with race rhythm (cues land on lap-ish multiples
  // and every "fastest lap" drew the same line), and a multiplicative hash's
  // low bits merely echo the input. Still a pure function of the cue, so a
  // replay reads the same radio every run.
  const v = variant ?? (Math.imul(Math.floor(cue.atMs / 200), 2654435761) >>> 13);
  const sentence = leadSentence(cue, lead, frame, v);
  if (!sentence) return null;
  for (const extra of cue.triggers.slice(1)) {
    const addon = addonFor(extra.kind);
    if (addon) return `${sentence} ${addon}`;
  }
  return sentence;
}
