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
import { speakableWhere } from './yellowCause';
import { sessionCallSentence } from './sessionPhrases';
import { trafficSentence, yieldWhereSuffix } from './trafficCalls';

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

/** Signed derived deltas may legitimately equal -1, the telemetry sentinel. */
function signedNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** One of the bank, by the resolved variant number. Index 0 is canonical. */
function pick(variant: number, bank: readonly string[]): string {
  return bank[Math.abs(variant) % bank.length]!;
}

/** Sector numbers as the radio says them — "sector two", never "sector 2". */
const SECTOR_WORDS: Record<string, string> = { '1': 'one', '2': 'two', '3': 'three' };

/** The driver's position for speech — class position when the cue knows it. */
function spokenPosition(cue: EngineerCue): string | null {
  const cls = num(cue.context.classPosition);
  if (cls !== undefined) return `P${cls}`;
  const overall = num(cue.context.position);
  return overall !== undefined ? `P${overall}` : null;
}

/**
 * One track-limits charge as the radio says it. LMU charges in quarter points,
 * and "nought point two five" is three words of noise for "a quarter".
 */
function speakableCharge(pts: number): string {
  if (pts === 0.25) return 'a quarter point';
  if (pts === 0.5) return 'half a point';
  if (pts === 0.75) return 'three quarters';
  if (pts === 1) return 'a full point';
  return `${+pts.toFixed(2)} points`;
}

/**
 * The track-limits call's facts, read once for every tone: what the cut cost
 * ("a quarter point — "), the running total ("2.5 of 5"), and how close the
 * drive-through is. `near` = within one point of the allowance; `gone` = at or
 * past it (the penalty line normally leads that cue instead).
 */
function limitsFacts(f: Readonly<Record<string, string | number | boolean>>): {
  cost: string;
  tally: string;
  near: boolean;
  gone: boolean;
} | null {
  const points = num(f.points);
  if (points === undefined) return null;
  const charge = num(f.charge);
  const limit = num(f.pointsLimit);
  const total = `${+points.toFixed(2)}`;
  const left = limit !== undefined ? limit - points : undefined;
  return {
    cost: charge !== undefined ? speakableCharge(charge) : 'points charged',
    tally: limit !== undefined ? `${total} of ${+limit.toFixed(2)}` : `${total} points`,
    near: left !== undefined && left > 0 && left <= 1,
    gone: left !== undefined && left <= 0,
  };
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

    case 'sectorYellow': {
      // `all` = every sector reads yellow at once. On a REST-only rig that is
      // one flag copied three times, so the line must not claim three separate
      // incidents — "yellows out" is everything that is actually known.
      const secs = String(f.sectors ?? '')
        .split(',')
        .filter(Boolean)
        .map((s) => SECTOR_WORDS[s] ?? s);
      // The car behind it, when one is stopped in a flagged sector: who, and
      // how far up the road from us. Either half alone is still worth saying.
      const who = typeof f.driver === 'string' && f.driver ? surname(f.driver) : null;
      const where = speakableWhere(num(f.aheadM), num(f.lapM));
      if (who) {
        const causeSec = SECTOR_WORDS[String(f.causeSector ?? '')];
        const sec =
          causeSec && (f.all === true || secs.length !== 1)
            ? `sector ${causeSec}`
            : secs.length === 1
              ? `sector ${secs[0]}`
              : null;
        const zone = sec ? `Yellow in ${sec}` : 'Yellow flags out';
        const at = where ? `, ${where}` : '';
        return pick(v, [
          // ≤ 14 words with the distance in (test-radio-gate): the rule
          // reminder rides only when there is no distance to say.
          `${zone} — ${who} is stopped${at}.${at ? '' : ' No passing in the zone.'}`,
          `${zone}. ${who}'s off${at} — careful.`,
          `Caution — ${who} stopped${at}. ${sec ? `Yellow, ${sec}.` : 'Keep it tidy.'}`,
        ]);
      }
      if (f.all === true || secs.length === 0) {
        return pick(v, [
          'Yellow flags out — expect a slow car, no overtaking under the yellow.',
          'Caution, caution — yellows showing. Watch for a stopped car.',
        ]);
      }
      if (secs.length === 1) {
        return pick(v, [
          `Yellow flag, sector ${secs[0]} — watch for a slow car through there.`,
          `Local yellow in sector ${secs[0]}. No passing in the zone.`,
          `Caution in sector ${secs[0]} — someone's off. Keep it tidy through there.`,
        ]);
      }
      return pick(v, [
        `Yellow flags in sectors ${secs.slice(0, -1).join(', ')} and ${secs[secs.length - 1]} — take care.`,
        `Local yellows, sectors ${secs.join(' and ')}. No passing in the zones.`,
      ]);
    }

    case 'sectorClear':
      return pick(v, [
        'Track is clear — green all round, you can push.',
        "Yellow's been withdrawn. All clear — back to it.",
        'All sectors green again. Push on.',
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
      // The HUD's grades (damage.ts damageGrade), the game's own words.
      const severity = String(f.severity ?? 'minor');
      const repair = num(f.repairSeconds);
      const again = f.repeat === true;
      if (severity === 'critical') {
        const fix = repair ? ` Repairs about ${Math.round(repair)} seconds — think about boxing.` : '';
        return pick(v, [
          `${again ? 'More contact — ' : ''}Critical damage.${fix}`,
          `${again ? 'Again — ' : ''}That's a big one. Critical damage.${fix}`,
        ]);
      }
      if (severity === 'major') {
        const fix = repair ? ` ${Math.round(repair)} seconds to fix if you box.` : '';
        return pick(v, [
          `${again ? 'More contact' : 'Contact'} — major damage.${fix}`,
          `${again ? 'Contact again' : 'Contact'} — you've picked up major damage.${fix}`,
        ]);
      }
      return pick(v, [
        `${again ? 'More contact' : 'Contact'} — minor damage, keep going.`,
        `${again ? 'Contact again' : 'Contact'} — it's minor, nothing to worry about.`,
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

    case 'trackLimits': {
      const t = limitsFacts(f);
      if (!t) return null;
      if (t.gone) return pick(v, [`Track limits — ${t.tally}. That's the allowance gone.`]);
      if (t.near) {
        return pick(v, [
          `Track limits, ${t.cost}. ${t.tally} — one more and it's a penalty.`,
          `That cut cost ${t.cost}. ${t.tally} now — you're on the limit.`,
        ]);
      }
      return pick(v, [
        `Track limits — ${t.cost}. That's ${t.tally}.`,
        `Cut charged, ${t.cost}. ${t.tally} points now.`,
        `That cut cost ${t.cost}. ${t.tally} — keep it tidy.`,
      ]);
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

    case 'rivalStop':
      return rivalStopSentence(f, v);

    case 'rivalRejoin': {
      const g = num(f.gapSec);
      if (g === undefined) return null;
      const who = surname(f.name);
      const gap = speakableGap(g);
      return pick(
        v,
        f.where === 'ahead'
          ? [`${who}'s out, ${gap} ahead.`, `${who}'s rejoined ${gap} up the road.`, `${who} is back out — ${gap} ahead of you.`]
          : [`${who}'s out, ${gap} behind.`, `${who}'s rejoined ${gap} behind you.`, `${who} is back out — ${gap} behind.`],
      );
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
      // A car a lap up in the player's OWN class (or a slower one) is lapping
      // them, not "faster class behind" — the blanket wording was wrong for it.
      if (f.lapping === true) {
        const cls = f.sameClass === true ? ', same class,' : '';
        if (who && gap !== undefined) {
          const g = speakableGap(gap);
          return pick(v, [
            `Blue flags — ${who}${cls} lapping you, ${g} back. Let them through.`,
            `${who} coming to lap you, ${g} behind. Hold your line, don't fight it.`,
            `Car a lap up — ${who}, ${g}. Blue flags, make it easy for them.`,
          ]);
        }
        return pick(v, [
          'Blue flags — car behind is lapping you. Hold your line.',
          "You're being lapped — car behind is a lap up. Let them through cleanly.",
        ]);
      }
      if (who && gap !== undefined) {
        const g = speakableGap(gap);
        return pick(v, [
          `Blue flags — ${who} closing, ${g} back. Hold your line.`,
          `Faster class behind — ${who}, ${g}. Stay predictable, don't lose time.`,
          `${who} coming through, ${g} back. Blue flags — hold your line.`,
        ]);
      }
      return pick(v, [
        'Blue flags — faster car closing. Hold your line.',
        'Faster class behind. Stay on line, let them work it out.',
      ]);
    }

    // Timed traffic: the words live beside the rules (trafficCalls.ts), and the
    // countdown is recomputed against THIS cue's emit time — null if stale.
    case 'trafficBehind':
    case 'trafficAhead':
      return trafficSentence(lead.kind, f, cue.atMs, v, frame?.radar);

    case 'practicePace': {
      const lap = num(f.lapSec);
      if (lap === undefined) return null;
      const time = speakableLapTime(lap);
      const band = typeof f.band === 'string' && f.band ? f.band : 'reference';
      const alienDelta = signedNum(f.deltaAlienSec);
      const competitiveDelta = signedNum(f.deltaCompetitiveSec);
      const target =
        alienDelta !== undefined && alienDelta <= 0.05
          ? 'on alien race pace'
          : competitiveDelta !== undefined && competitiveDelta > 0.05
            ? `${speakableGap(competitiveDelta)} to competitive pace`
            : alienDelta !== undefined
              ? `${speakableGap(alienDelta)} off alien race pace`
              : `${band} pace`;
      const reason = String(f.reason ?? 'periodic');
      if (reason === 'first') {
        return pick(v, [
          `First benchmark, ${time}. ${band} pace — ${target}.`,
          `Reference pace is live. Best ${time}, ${band} band — ${target}.`,
          `We've got a benchmark: ${time}. ${band} pace, ${target}.`,
        ]);
      }
      if (reason === 'band-improved') {
        return pick(v, [
          `That moves us into ${band} pace — ${time}, ${target}.`,
          `Good step. ${time} — ${band} band, ${target}.`,
          `New pace band: ${band}. Best is ${time}, ${target}.`,
        ]);
      }
      return pick(v, [
        `Practice pace check: best is ${time}, ${band} band — ${target}.`,
        `Reference check: ${time} remains the best, ${band} pace — ${target}.`,
        `Current benchmark, ${time}. We're in the ${band} band, ${target}.`,
      ]);
    }

    // Qualifying/practice hotlap calls: composed from every session trigger
    // the cue carries (the lap, the clock and the grid land together).
    case 'qualiLap':
    case 'qualiPole':
    case 'qualiBeaten':
    case 'qualiTimeLeft':
    case 'qualiGrid':
    case 'practiceLap':
    case 'sectorImproved':
      return sessionCallSentence(cue, v);
  }
}

/**
 * A projection said as one: whole seconds, "about", never a false tenth — the
 * rival keeps lapping while it is in the lane. Measured gaps keep their tenth
 * via {@link speakableGap}; this is only for projections.
 */
function aboutGap(sec: number): string {
  const s = Math.round(Math.abs(sec));
  if (s <= 1) return 'about a second';
  return `about ${speakableGap(s).replace(/\.0 /, ' ')}`;
}

/**
 * The rival-stop line (`rivalStop.ts` decides whether there is one). Facts:
 * `outcome`, `where`, `name`, `gapSec` (at pit entry), `rejoinSec` (projected,
 * + = still ahead of you), optional `energyLapsInHand`, `alsoName`,
 * `othersInPit`. Never a verdict on whether an undercut works — only where the
 * car comes out and what that means for the place.
 */
function rivalStopSentence(
  f: Readonly<Record<string, string | number | boolean>>,
  v: number,
): string | null {
  const who = surname(f.name);
  const also = typeof f.alsoName === 'string' && f.alsoName ? surname(f.alsoName) : null;
  const others = num(f.othersInPit);
  // "Brown's boxed" / "Brown's boxed, Smith too" / "…, with 3 others".
  const boxed = also
    ? `${who}'s boxed, ${also} too`
    : others !== undefined && others >= 2
      ? `${who}'s boxed with ${others} others`
      : `${who}'s boxed`;
  const gap = num(f.gapSec);
  const g = gap !== undefined ? speakableGap(gap) : null;
  const rejoin = signedNum(f.rejoinSec);
  const r = rejoin !== undefined ? aboutGap(rejoin) : null;
  const lapsInHand = num(f.energyLapsInHand);
  const energy =
    lapsInHand !== undefined && lapsInHand >= 1
      ? ` ${lapsInHand} ${lapsInHand === 1 ? 'lap' : 'laps'} more energy.`
      : '';
  const two = f.where === 'ahead2';

  switch (f.outcome) {
    case 'dropsBehind':
      if (!r) return null;
      return (
        pick(
          v,
          two
            ? [`${who}, two ahead, has boxed — projected out ${r} behind you.`]
            : [
                `${boxed} — projected out ${r} behind you.`,
                `Car ahead's in. ${who} should rejoin ${r} behind you.`,
                `${who} pitted from ${g ?? 'just'} ahead — out ${r} behind you.`,
              ],
        ) + energy
      );
    case 'level':
      return (
        pick(v, [
          `${boxed} — projected out right around you. Eyes up at the exit.`,
          `Car ahead's in. ${who} should rejoin right alongside you.`,
        ]) + energy
      );
    case 'closeAhead':
      if (!r) return null;
      return (
        pick(v, [
          `${boxed} — projected out ${r} ahead of you.`,
          `Car ahead's in. ${who} should rejoin ${r} up the road.`,
        ]) + energy
      );
    case 'closeBehind':
      if (!r) return null;
      return pick(v, [
        `${boxed} — projected out ${r} behind you.`,
        `Car behind's in. ${who} should rejoin ${r} back.`,
      ]);
    case 'undercut':
      return (
        pick(v, [
          // Kept to 9-10 words so the energy clause still lands inside 14.
          `${who}'s boxed from ${g ?? 'just'} behind — close after your stop.`,
          `Car behind's in, ${g ?? 'just'} back. Close after your stop.`,
        ]) + energy
      );
    case 'fact': {
      const side = f.where === 'behind' ? 'behind' : 'ahead';
      return (
        pick(v, [
          `${who}, the car ${side}, has boxed${g ? ` from ${g}` : ''}.`,
          `Car ${side}'s in the pits — ${who}${g ? `, ${g} ${side === 'ahead' ? 'up the road' : 'back'}` : ''}.`,
        ]) + energy
      );
    }
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Mature radio                                                               */
/* -------------------------------------------------------------------------- */

/**
 * How rude the engineer is allowed to be (Engineer tab → "Mature radio"; a
 * Discord request, 2026-10-08). `clean` is every line above and the default;
 * `banter` swears mildly and takes the mick; `savage` swears properly.
 */
export type RadioTone = 'clean' | 'banter' | 'savage';
export const RADIO_TONES: readonly RadioTone[] = ['clean', 'banter', 'savage'];

/**
 * The mature line for a driver's MISTAKE, or null to say the clean one. The
 * mistakes the trigger layer can see: damage, a penalty, a lost place, a
 * track-limits charge and a lap deleted for limits — plus blue flags, where
 * the roast is the order to get out of the way. Every line here still
 * carries the clean line's facts (severity, repair time, penalty type, the new
 * position, the points): the roast rides on the information, it never
 * replaces it. Same ≤ {@link MAX_SPOKEN_WORDS} rule.
 */
function matureSentence(lead: EngineerTrigger, tone: RadioTone, v: number, alone: boolean): string | null {
  if (tone === 'clean') return null;
  const savage = tone === 'savage';
  const f = lead.facts;
  switch (lead.kind) {
    case 'incident': {
      const severity = String(f.severity ?? 'minor');
      const repair = num(f.repairSeconds);
      const again = f.repeat === true;
      if (severity === 'critical') {
        const fix = repair ? ` ${Math.round(repair)} seconds to fix — box.` : ' Think about boxing.';
        return pick(
          v,
          savage
            ? [
                `${again ? 'Again?! ' : ''}Critical damage. You've fucking destroyed it, you muppet.${fix}`,
                `Critical damage. Car's fucked, and so's your race.${fix}`,
                `Critical damage. You absolute wrecking ball.${fix}`,
              ]
            : [`${again ? 'Again? ' : ''}Critical damage. Bloody marvellous.${fix}`, `Critical damage. Well, that was daft.${fix}`],
        );
      }
      if (severity === 'major') {
        const fix = repair ? ` ${Math.round(repair)} seconds if you box.` : '';
        return pick(
          v,
          savage
            ? [
                `${again ? 'More contact' : 'Contact'} — major damage. Fucking hell, you absolute bellend.${fix}`,
                `${again ? 'Again?! ' : ''}Major damage. Shit driving. Utter shit.${fix}`,
                `Major damage. You've fucked the car, genius.${fix}`,
              ]
            : [`${again ? 'More contact' : 'Contact'} — major damage. Bloody hell.${fix}`, `${again ? 'Again? ' : ''}Major damage. Well, that was stupid.${fix}`],
        );
      }
      return pick(
        v,
        savage
          ? [
              `${again ? 'Again?! ' : ''}Contact — minor damage. What the fuck was that, you clown?`,
              `${again ? 'More contact' : 'Contact'} — minor. Are you fucking blind?`,
              `${again ? 'Contact again' : 'Contact'} — minor damage. For fuck's sake. Keep going.`,
              `${again ? 'More contact' : 'Contact'} — minor. Drive like a twat, get hit like one.`,
            ]
          : [
              `${again ? 'Again? ' : ''}Contact — minor damage. Bloody hell, keep going.`,
              `${again ? 'More contact' : 'Contact'} — minor. Car's fine, my nerves aren't.`,
              `${again ? 'Contact again' : 'Contact'} — minor damage. What the hell was that?`,
            ],
      );
    }

    case 'penalty': {
      const type = typeof f.penaltyType === 'string' && f.penaltyType ? f.penaltyType : null;
      if (savage) {
        return pick(
          v,
          type
            ? [
                `Penalty — ${type}. For fuck's sake, you absolute weapon.`,
                `Stewards gave us a ${type}. Nice fucking work, genius.`,
                `Penalty — ${type}. Shit. Fucking brilliant. We'll deal with it.`,
              ]
            : ["Penalty from race control. For fuck's sake, you clown.", "Stewards' decision — penalty. Fucking unbelievable."],
        );
      }
      return pick(
        v,
        type
          ? [`Penalty — ${type}. Brilliant. Absolutely brilliant.`, `Stewards have given us a ${type}. Cheers for that.`, `Penalty — ${type}. Bloody hell, mate.`]
          : ['Penalty from race control. Lovely, just lovely.', "Stewards' decision against us — penalty. Bloody hell."],
      );
    }

    case 'positionChange': {
      const to = num(f.to);
      if (to === undefined || f.gained === true) return null;
      return pick(
        v,
        savage
          ? [
              `P${to} now. What the fuck was that? Get it back.`,
              `Back to P${to}. Wake the fuck up.`,
              `P${to}. My nan's quicker, and she's in a shopping trolley.`,
              `P${to}. You just got mugged. Fucking get it back.`,
            ]
          : [`P${to} now. Bloody hell, get it back.`, `Back to P${to}. Asleep at the wheel, mate?`, `P${to}. Well, that was crap — next corner.`],
      );
    }

    case 'trackLimits': {
      const t = limitsFacts(f);
      if (!t || t.gone) return null; // the allowance gone is the penalty's line
      if (t.near) {
        return pick(
          v,
          savage
            ? [`Track limits — ${t.tally}. One more fucking cut and it's a penalty.`, `Track limits, ${t.cost}. ${t.tally}. Trying to get penalised, dickhead?`]
            : [`Track limits — ${t.tally}. One more and it's a penalty. Behave.`, `Track limits, ${t.cost}. ${t.tally}. Living dangerously, mate.`],
        );
      }
      return pick(
        v,
        savage
          ? [`Track limits — ${t.cost}. ${t.tally}. Stay on the fucking track.`, `Cut charged, ${t.cost}. ${t.tally}. Can't you see the fucking lines?`, `Cut charged — ${t.cost}. ${t.tally}. Stop cutting, you muppet.`]
          : [`Track limits — ${t.cost}. ${t.tally}. Stay on the bloody track.`, `Cut charged, ${t.cost}. ${t.tally}. The white lines aren't decoration.`, `That cut cost ${t.cost}. ${t.tally}. Use the road, mate.`],
      );
    }

    // A lap deleted for track limits in practice or qualifying — only when it
    // is the whole call (alone): a bundle with the grid or the clock keeps the
    // session phrasing, which already fits two facts in the line.
    case 'qualiLap':
    case 'practiceLap': {
      if (!alone || f.verdict !== 'deleted') return null;
      return pick(
        v,
        savage
          ? ["Lap's deleted — track limits. Fucking pointless lap, that.", "That one's deleted. Track limits, you absolute weapon.", 'Track limits — lap deleted. Shit. Do it properly this time.']
          : ["Lap's deleted — track limits. Bloody hell.", "That one's deleted, track limits. What a waste.", 'Track limits — lap deleted. Use the road next time.'],
      );
    }

    // Blue flags: a faster car is behind you. The order to let it by and its
    // name and gap stay in every line; the sector suffix still rides after
    // (phraseForCue), so these keep to nine words with a name and gap.
    case 'yieldTo': {
      const gap = num(f.gapSec);
      const who = typeof f.name === 'string' && f.name ? surname(f.name) : null;
      const g = gap !== undefined ? speakableGap(gap) : null;
      if (f.lapping === true) {
        if (who && g) {
          return pick(
            v,
            savage
              ? [`Blue flags — ${who} lapping you, ${g}. Get out the fucking way.`, `${who}'s lapping you, ${g} back. Move, mobile chicane.`]
              : [`Blue flags — ${who} lapping you, ${g}. Shift over, mate.`, `${who}'s lapping you, ${g} back. Let them by, you're traffic.`],
          );
        }
        return pick(
          v,
          savage
            ? ["Blue flags — you're being lapped. Get out the fucking way.", "Car behind's a lap up. Move, you fucking mobile chicane."]
            : ["Blue flags — you're being lapped, mate. Let them through.", "Car behind's a lap up. You're traffic now — let them by."],
        );
      }
      if (who && g) {
        return pick(
          v,
          savage
            ? [`Blue flags — ${who}, ${g} back. Hold your fucking line.`, `Faster class — ${who}, ${g}. Don't do anything stupid.`]
            : [`Blue flags — ${who}, ${g} back. Hold your line, mate.`, `Faster class — ${who}, ${g}. Don't do anything daft.`],
        );
      }
      return pick(
        v,
        savage
          ? ['Blue flags — faster car closing. Hold your fucking line.', "Faster class behind. Stay predictable, for fuck's sake."]
          : ['Blue flags — faster car closing. Hold your line, mate.', "Faster class behind. Don't do anything daft."],
      );
    }

    default:
      return null;
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
 * @param tone - The driver's "Mature radio" setting. Only a lone mistake is
 *   roasted: a cue carrying a must-not-miss addon (damage + fuel, say) keeps
 *   the clean wording so the extra fact still fits in the line.
 */
export function phraseForCue(
  cue: EngineerCue,
  frame: TelemetryFrame | null = null,
  variant?: number,
  tone: RadioTone = 'clean',
): string | null {
  const lead = cue.triggers[0];
  if (!lead) return null;
  // Knuth's multiplicative hash over the cue time, keeping the HIGH bits — a
  // plain divide correlates with race rhythm (cues land on lap-ish multiples
  // and every "fastest lap" drew the same line), and a multiplicative hash's
  // low bits merely echo the input. Still a pure function of the cue, so a
  // replay reads the same radio every run.
  const v = variant ?? (Math.imul(Math.floor(cue.atMs / 200), 2654435761) >>> 13);
  const hasAddon = cue.triggers.slice(1).some((t) => addonFor(t.kind) !== null);
  const rude = hasAddon ? null : matureSentence(lead, tone, v, cue.triggers.length === 1);
  const said = rude ?? leadSentence(cue, lead, frame, v);
  if (!said) return null;
  // A blue flag the traffic tracker could place gains where it lands.
  const sentence = lead.kind === 'yieldTo' ? said + yieldWhereSuffix(lead.facts) : said;
  for (const extra of cue.triggers.slice(1)) {
    const addon = addonFor(extra.kind);
    if (addon) return `${sentence} ${addon}`;
  }
  return sentence;
}

/* -------------------------------------------------------------------------- */
/*  Line discipline                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The longest a proactive line may run, in spoken words. Real engineers are
 * brief because the driver is busy: at Piper's ~2.8 words a second, fourteen
 * words is five seconds of radio — most of a straight. Every bank above is
 * held to it by scripts/test-radio-gate.js; a new kind gets the same check by
 * adding its facts to that sweep.
 */
export const MAX_SPOKEN_WORDS = 14;

/** Spoken words in a line — dashes and other bare punctuation are not words. */
export function spokenWordCount(text: unknown): number {
  return String(text ?? '')
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w)).length;
}

/** `true` when a line breaks {@link MAX_SPOKEN_WORDS}. */
export function lineTooLong(text: unknown, max: number = MAX_SPOKEN_WORDS): boolean {
  return spokenWordCount(text) > max;
}
