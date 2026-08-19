/**
 * @file src/telemetry/engineerCommands.ts
 * @module telemetry/engineerCommands
 *
 * **When the driver asks.** The pull side of the race engineer: a fixed set of
 * questions a driver can put to the pit wall — gap ahead, laps left, five-lap
 * pace — answered from the telemetry the server already normalizes, as one
 * short sentence written to be *spoken*.
 *
 * This is the Tier-1 layer of the v2 engineer plan and, like `triggers.ts`, it
 * deliberately contains no network, no model, no audio and no speech
 * recognition. It answers exactly one question: *given this intent and the
 * frames seen so far, what would the engineer say*. The recognizer that maps a
 * phrase to a {@link CommandIntent} and the voice that reads the sentence out
 * are separate concerns (`scripts/spike-voice-engineer.js`), so this file can
 * be unit-tested headless and replayed against recorded races
 * (`scripts/test-commands.js`), exactly the split that let P0 ship untuned
 * risk-free.
 *
 * ## Why this layer is stateful at all
 * Almost every answer is a pure read of the latest frame. The exception is the
 * five-lap average: no frame carries lap *history*, only each car's
 * `lastLapSec`, so the class keeps a small rolling window per car, fed by
 * edge-detecting `lastLapSec` changes in {@link EngineerCommands.update}. That
 * update is the same shape as the trigger layer's tick — a handful of scalar
 * compares per standings row, no allocation when nothing changed — so it rides
 * the existing loop without moving the CPU needle.
 *
 * ## Answers refuse rather than guess
 * Every path that would need a number the sim hasn't published returns an
 * honest "no data" line instead of arithmetic on {@link UNKNOWN_VALUE}. A
 * confident wrong answer over the radio is worse than none — the same remit
 * line the push side draws.
 *
 * ## Class-first, like the standings
 * "Gap ahead" means the car ahead **in your class** — what a multiclass field
 * actually races for — falling back to the nearest car ahead on track only when
 * class data is missing. Mirrors the per-class framing of `lapLog.ts` and the
 * leaderboard.
 */

import { UNKNOWN_VALUE } from './types';
import type { StandingEntry, TelemetryFrame } from './types';
import { sessionKeyOf } from './triggers';

/* -------------------------------------------------------------------------- */
/*  What the driver can ask                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The questions the engineer can answer. A closed, short list on purpose: every
 * entry is answerable from fields the frame already carries, which is what
 * keeps Tier 1 free to run and impossible to hallucinate. Free-form questions
 * are Tier 2's job (the cloud proxy) and never reach this module.
 */
export type CommandIntent =
  | 'gapAhead'
  | 'gapBehind'
  | 'avgAhead'
  | 'carAhead'
  | 'carBehind'
  | 'traffic'
  | 'lapsLeft'
  | 'fuel'
  | 'lastLap'
  | 'position'
  // Track A of the v3 plan (2026-08-19): the wider ask-set. Same rules as the
  // first ten — a read or arithmetic over fields the frame already carries,
  // bucketed and compared the way an engineer talks, refusing when the sim
  // hasn't published the number.
  | 'tyres'
  | 'pressures'
  | 'damage'
  | 'brakes'
  | 'pitStop'
  | 'pitWindow'
  | 'energy'
  | 'hybrid'
  | 'pace'
  | 'bestLap'
  | 'fieldFastest'
  | 'leader'
  | 'gridStart'
  | 'trackLimits'
  | 'flags'
  | 'weather'
  | 'brakeBias'
  | 'tractionControl';

/** Every intent, for iteration in tests and the recognizer grammar. */
export const COMMAND_INTENTS: readonly CommandIntent[] = [
  'gapAhead',
  'gapBehind',
  'avgAhead',
  'carAhead',
  'carBehind',
  'traffic',
  'lapsLeft',
  'fuel',
  'lastLap',
  'position',
  'tyres',
  'pressures',
  'damage',
  'brakes',
  'pitStop',
  'pitWindow',
  'energy',
  'hybrid',
  'pace',
  'bestLap',
  'fieldFastest',
  'leader',
  'gridStart',
  'trackLimits',
  'flags',
  'weather',
  'brakeBias',
  'tractionControl',
];

/**
 * How many recent laps the pace comparison averages over. Five is the number in
 * the feature request ("5 laps avr. front") and a good window: long enough to
 * absorb one scrappy lap, short enough to reflect the current stint.
 */
export const AVG_WINDOW_LAPS = 5;

/** A spoken answer plus which intent produced it (for logs and tests). */
export interface CommandAnswer {
  intent: CommandIntent;
  /** The sentence, written for TTS — see {@link speakableLapTime}. */
  text: string;
  /** False when the honest answer was "no data" rather than a number. */
  ok: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Formatting for a voice, not a screen                                      */
/* -------------------------------------------------------------------------- */

/**
 * A lap time as a TTS engine reads it naturally: `103.42` → `"1 43.4"`, which
 * SAPI and friends speak as "one forty-three point four" — the way a real
 * engineer says it. Sub-minute values keep the unit ("43.4 seconds") so a gap
 * and a lap time can't be confused.
 */
export function speakableLapTime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return 'no time';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  if (m <= 0) return `${s.toFixed(1)} seconds`;
  // Pad so 1:03.4 reads "one oh three point four", not "one three point four".
  const ss = s < 10 ? `oh ${s.toFixed(1)}` : s.toFixed(1);
  return `${m} ${ss}`;
}

/**
 * A gap in seconds for speech: one decimal, always with the unit. Exported for
 * the phrasebook (`engineerPhrases.ts`) — every number the engineer speaks is
 * formatted here, whichever side of the radio initiated the line.
 */
export function speakableGap(sec: number): string {
  const abs = Math.abs(sec);
  const val = abs >= 60 ? speakableLapTime(abs) : `${abs.toFixed(1)} seconds`;
  return val;
}

/** Corner names in the frame's fixed [FL, FR, RL, RR] order, for speech. */
const CORNER_NAMES = ['front left', 'front right', 'rear left', 'rear right'] as const;

/**
 * Damage severity in the three words a driver would use — the same buckets the
 * trigger layer speaks in (`triggers.ts`), so the answer to "how bad is it" can
 * never disagree with the call that announced the contact.
 */
function damageWord(worst: number): string {
  if (worst >= 0.5) return 'heavy';
  if (worst >= 0.2) return 'moderate';
  return 'light';
}

/**
 * How far from the sim's single optimal temperature still counts as "in the
 * window", °C. The same ±8 the tyre widget uses (`widgets/tyres.js`) — the
 * radio and the screen must agree on whether a tyre is working.
 */
const TYRE_WINDOW_C = 8;

/** Surname-ish display name: last whitespace-separated token, for radio brevity. */
function radioName(entry: StandingEntry): string {
  const name = (entry.driverName || '').trim();
  if (!name) return entry.carNumber ? `car ${entry.carNumber}` : 'the car';
  const parts = name.split(/\s+/);
  return parts[parts.length - 1] ?? name;
}

function known(n: number | undefined): n is number {
  return typeof n === 'number' && n !== UNKNOWN_VALUE && Number.isFinite(n);
}

/* -------------------------------------------------------------------------- */
/*  The engineer                                                              */
/* -------------------------------------------------------------------------- */

/** Rolling window of a car's most recent completed lap times, newest last. */
interface LapWindow {
  lastSeen: number;
  laps: number[];
}

export class EngineerCommands {
  private frame: TelemetryFrame | null = null;
  private sessionKey = '';
  private windows = new Map<number, LapWindow>();

  /** Drop all history — new session, or a caller that knows better. */
  reset(): void {
    this.frame = null;
    this.sessionKey = '';
    this.windows.clear();
  }

  /**
   * Feed the latest frame. Cheap on the nothing-happened path: one compare per
   * standings row. Lap windows only mutate on a `lastLapSec` edge.
   */
  update(frame: TelemetryFrame): void {
    const key = sessionKeyOf(frame);
    if (key !== this.sessionKey) {
      this.windows.clear();
      this.sessionKey = key;
    }
    this.frame = frame;

    for (const entry of frame.standings) {
      const last = entry.lastLapSec;
      if (!known(last) || last <= 0) continue;
      let win = this.windows.get(entry.slotId);
      if (!win) {
        win = { lastSeen: last, laps: [last] };
        this.windows.set(entry.slotId, win);
        continue;
      }
      if (last !== win.lastSeen) {
        win.lastSeen = last;
        win.laps.push(last);
        if (win.laps.length > AVG_WINDOW_LAPS) win.laps.shift();
      }
    }
  }

  /** Answer one question from the latest state. Never throws; never guesses. */
  answer(intent: CommandIntent): CommandAnswer {
    const no = (text: string): CommandAnswer => ({ intent, text, ok: false });
    const yes = (text: string): CommandAnswer => ({ intent, text, ok: true });
    const frame = this.frame;
    if (!frame) return no('No telemetry yet.');

    switch (intent) {
      case 'gapAhead': {
        const g = this.classGap(frame, -1);
        if (g === 'leader') return yes("You're leading the class.");
        if (g) {
          const lapped = g.lapsApart
            ? `${g.lapsApart} ${g.lapsApart === 1 ? 'lap' : 'laps'} and `
            : '';
          return yes(`Gap ahead, ${lapped}${speakableGap(g.gapSec)}, to ${g.name}.`);
        }
        const t = this.trackGap(frame, +1);
        if (t) return yes(`Gap ahead on track, ${speakableGap(t.gapSec)}, to ${t.name}.`);
        return no('No gap data yet.');
      }

      case 'gapBehind': {
        const g = this.classGap(frame, +1);
        if (g === 'leader') return yes('Nobody behind in class.');
        if (g) {
          const lapped = g.lapsApart
            ? `${g.lapsApart} ${g.lapsApart === 1 ? 'lap' : 'laps'} and `
            : '';
          return yes(`Gap behind, ${lapped}${speakableGap(g.gapSec)}, to ${g.name}.`);
        }
        const t = this.trackGap(frame, -1);
        if (t) return yes(`Gap behind on track, ${speakableGap(t.gapSec)}, to ${t.name}.`);
        return no('No gap data yet.');
      }

      case 'avgAhead': {
        const me = frame.standings.find((e) => e.isPlayer);
        if (!me) return no('No standings yet.');
        const ahead = this.neighbour(frame, me, -1);
        if (!ahead) return no("You're leading the class — nobody ahead to compare.");
        const mine = this.averageOf(me.slotId);
        const theirs = this.averageOf(ahead.slotId);
        if (!mine || !theirs) return no('Not enough laps recorded yet for an average.');
        const n = Math.min(mine.count, theirs.count);
        const diff = mine.avg - theirs.avg;
        const verdict =
          Math.abs(diff) < 0.05
            ? 'Dead even.'
            : diff > 0
              ? `${radioName(ahead)} is ${diff.toFixed(1)} quicker.`
              : `You're ${(-diff).toFixed(1)} quicker.`;
        const window = n === 1 ? 'Last lap' : `Last ${n} laps`;
        return yes(
          `${window}, ${radioName(ahead)} averaging ${speakableLapTime(theirs.avg)}, ` +
            `you ${speakableLapTime(mine.avg)}. ${verdict}`,
        );
      }

      case 'carAhead':
      case 'carBehind': {
        const dir = intent === 'carAhead' ? -1 : 1;
        const me = frame.standings.find((e) => e.isPlayer);
        if (!me) return no('No standings yet.');
        const other = this.neighbour(frame, me, dir as -1 | 1);
        if (!other) {
          return intent === 'carAhead'
            ? yes("You're leading the class — nobody ahead.")
            : yes('Nobody behind in class.');
        }
        const where = intent === 'carAhead' ? 'Ahead is' : 'Behind is';
        const g = this.classGap(frame, dir as -1 | 1);
        const gap =
          g && g !== 'leader'
            ? `, ${g.lapsApart ? `${g.lapsApart} ${g.lapsApart === 1 ? 'lap' : 'laps'} and ` : ''}${speakableGap(g.gapSec)}`
            : '';
        const pace: string[] = [];
        if (known(other.lastLapSec) && other.lastLapSec > 0) {
          pace.push(`Last lap ${speakableLapTime(other.lastLapSec)}`);
        }
        const avg = this.averageOf(other.slotId);
        if (avg && avg.count >= 2) {
          pace.push(`averaging ${speakableLapTime(avg.avg)} over ${avg.count}`);
        }
        const paceText = pace.length ? ` ${pace.join(', ')}.` : ' No lap time on him yet.';
        return yes(`${where} ${radioName(other)}${gap}.${paceText}`);
      }

      case 'traffic': {
        // The relative feed already decides what counts as traffic: trafficAhead
        // is a backmarker the player is arriving on, yieldTo is a car with the
        // right of way closing from behind. This intent just reads the flags —
        // one place owns the blue-flag rules, and it isn't here.
        const ahead = frame.relative
          .filter((r) => r.trafficAhead && known(r.relativeGapSec) && r.relativeGapSec > 0)
          .sort((a, b) => a.relativeGapSec - b.relativeGapSec);
        const behind = frame.relative
          .filter((r) => r.yieldTo && known(r.relativeGapSec) && r.relativeGapSec < 0)
          .sort((a, b) => b.relativeGapSec - a.relativeGapSec);
        if (ahead.length) {
          const first = ahead[0]!;
          const name = first.driverName.split(/\s+/).pop() || first.driverName;
          const closing =
            known(first.closingRateSec) && first.closingRateSec! > 0.05
              ? " — you're closing"
              : '';
          const head =
            ahead.length === 1
              ? `Backmarker ahead — ${name}, ${speakableGap(first.relativeGapSec)}${closing}.`
              : `${ahead.length} backmarkers ahead. Nearest ${name}, ${speakableGap(first.relativeGapSec)}${closing}.`;
          const mirror = behind.length ? ' And watch your mirrors — faster car behind.' : '';
          return yes(head + mirror);
        }
        if (behind.length) {
          const first = behind[0]!;
          const name = first.driverName.split(/\s+/).pop() || first.driverName;
          return yes(
            `No backmarkers ahead. ${name} is ${speakableGap(first.relativeGapSec)} behind with the right of way — expect blue flags.`,
          );
        }
        if (!frame.relative.length) return no('No cars around you to report.');
        return yes('No traffic around you — clear road.');
      }

      case 'lapsLeft': {
        const s = frame.session;
        if (known(s.totalLaps) && s.totalLaps > 0 && known(s.currentLap) && s.currentLap > 0) {
          const left = Math.max(0, s.totalLaps - s.currentLap + 1);
          return yes(
            left <= 1 ? 'This is the last lap.' : `${left} laps to go, including this one.`,
          );
        }
        if (known(s.timeRemainingSec) && s.timeRemainingSec >= 0) {
          const mins = Math.round(s.timeRemainingSec / 60);
          const laps =
            known(s.lapsRemaining) && s.lapsRemaining > 0
              ? `, about ${s.lapsRemaining} laps`
              : '';
          if (mins < 1) return yes(`Under a minute left${laps}.`);
          return yes(`${mins} ${mins === 1 ? 'minute' : 'minutes'} left${laps}.`);
        }
        return no('No session length data yet.');
      }

      case 'fuel': {
        // LMU cars run a tank AND a virtual-energy allowance, and the driver
        // pits for whichever runs out first — so "am I good to the end" is a
        // question about the TIGHTER budget, exactly as the trigger layer's
        // fuelWindow reads it. Answering off the tank alone told a driver with
        // 24 laps of energy and 27 to run that he was good to the finish
        // (caught in the 2026-08-19 race replay).
        const f = frame.fuel;
        if (!f || !known(f.lapsRemaining)) return no('No fuel read yet.');
        const tankLaps = f.lapsRemaining;
        const energyLaps = known(f.virtualEnergyLapsRemaining)
          ? f.virtualEnergyLapsRemaining!
          : undefined;
        const state =
          energyLaps !== undefined
            ? `Fuel for ${tankLaps.toFixed(1)} laps, energy for ${energyLaps.toFixed(1)}.`
            : `Fuel for ${tankLaps.toFixed(1)} laps.`;
        if (f.pitThisLap) return yes(`${state} Box this lap — you will not make another.`);

        const bindingLaps = energyLaps !== undefined ? Math.min(tankLaps, energyLaps) : tankLaps;
        if (known(f.lapsToFinish) && f.lapsToFinish > 0) {
          const short = f.lapsToFinish - bindingLaps;
          if (short <= 0) return yes(`${state} Good to the finish.`);
          const which =
            energyLaps !== undefined && energyLaps < tankLaps ? 'on energy' : 'on fuel';
          return yes(
            `${state} That's ${short.toFixed(1)} laps short ${which} — you'll need a stop.`,
          );
        }
        // No laps-to-finish projection: the litre delta is the tank-only
        // fallback, so it only speaks when the tank is the binding budget.
        if (known(f.fuelDeltaLiters) && (energyLaps === undefined || tankLaps <= energyLaps)) {
          if (f.fuelDeltaLiters >= 0) return yes(`${state} Good to the finish.`);
          return yes(
            `${state} You're ${Math.abs(f.fuelDeltaLiters).toFixed(1)} litres short of the finish.`,
          );
        }
        return yes(state);
      }

      case 'lastLap': {
        const me = frame.standings.find((e) => e.isPlayer);
        if (!me || !known(me.lastLapSec) || me.lastLapSec <= 0)
          return no('No completed lap yet.');
        const best =
          known(me.bestLapSec) && me.bestLapSec > 0 && me.lastLapSec <= me.bestLapSec
            ? ' Personal best.'
            : '';
        return yes(`Last lap, ${speakableLapTime(me.lastLapSec)}.${best}`);
      }

      case 'position': {
        const me = frame.standings.find((e) => e.isPlayer);
        if (!me || !known(me.position)) return no('No standings yet.');
        if (known(me.classPosition) && me.carClass) {
          return yes(`P${me.classPosition} in class, P${me.position} overall.`);
        }
        return yes(`P${me.position}.`);
      }

      /* ---- Track A: the wider ask-set (v3, 2026-08-19) --------------------- */

      case 'tyres': {
        // Bucket, compare, lead with the exception — never four raw numbers.
        const t = frame.player?.tyres;
        if (!t) return no('No tyre data.');
        const corners = [t.frontLeft, t.frontRight, t.rearLeft, t.rearRight];
        const core = corners.map((c) => (known(c?.coreC) ? c.coreC! : known(c?.tempC) ? c.tempC : undefined));
        if (core.every((c) => c === undefined)) return no('No tyre data yet.');

        const parts: string[] = [];
        const optimal = corners.map((c) => (known(c?.optimalTempC) ? c!.optimalTempC! : undefined));
        const axleDelta = (i: number, j: number): number | undefined => {
          const ds = [i, j]
            .filter((k) => core[k] !== undefined && optimal[k] !== undefined)
            .map((k) => core[k]! - optimal[k]!);
          return ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : undefined;
        };
        const word = (d: number): string =>
          Math.abs(d) <= TYRE_WINDOW_C
            ? 'in the window'
            : d > 0
              ? `about ${Math.round(d)} over`
              : `about ${Math.round(-d)} under`;
        const front = axleDelta(0, 1);
        const rear = axleDelta(2, 3);
        if (front !== undefined && rear !== undefined) {
          if (Math.abs(front) <= TYRE_WINDOW_C && Math.abs(rear) <= TYRE_WINDOW_C) {
            parts.push('Tyres are in the window.');
          } else {
            parts.push(`Fronts ${word(front)}, rears ${word(rear)}.`);
          }
        } else {
          // No optimal published — report the hottest corner rather than judge.
          let hot = -1;
          for (let i = 0; i < 4; i++) {
            if (core[i] !== undefined && (hot === -1 || core[i]! > core[hot]!)) hot = i;
          }
          parts.push(`Hottest tyre ${CORNER_NAMES[hot]}, ${Math.round(core[hot]!)} degrees.`);
        }

        const wears = corners.map((c) => (known(c?.wear) && c!.wear >= 0 ? c!.wear : undefined));
        let worst = -1;
        for (let i = 0; i < 4; i++) {
          if (wears[i] !== undefined && (worst === -1 || wears[i]! < wears[worst]!)) worst = i;
        }
        if (worst !== -1) {
          const pct = Math.round(wears[worst]! * 100);
          if (wears[worst]! <= 0.15) {
            parts.push(`${CORNER_NAMES[worst]} is nearly done — ${pct} percent left.`);
          } else if (wears[worst]! <= 0.4) {
            parts.push(`Worst tread ${pct} percent, ${CORNER_NAMES[worst]}.`);
          } else {
            parts.push(`Tread's good.`);
          }
        }
        return yes(parts.join(' '));
      }

      case 'pressures': {
        const t = frame.player?.tyres;
        if (!t) return no('No tyre data.');
        const p = [t.frontLeft, t.frontRight, t.rearLeft, t.rearRight].map((c) =>
          known(c?.pressureKpa) && c!.pressureKpa! > 0 ? c!.pressureKpa! : undefined,
        );
        const axle = (i: number, j: number): number | undefined => {
          const vals = [p[i], p[j]].filter((v): v is number => v !== undefined);
          return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
        };
        const front = axle(0, 1);
        const rear = axle(2, 3);
        if (front === undefined && rear === undefined) return no('No pressure readings.');
        if (front !== undefined && rear !== undefined) {
          return yes(`Pressures — fronts ${Math.round(front)}, rears ${Math.round(rear)} kPa.`);
        }
        const one = front ?? rear!;
        return yes(`Pressures around ${Math.round(one)} kPa — only one axle reading.`);
      }

      case 'damage': {
        const d = frame.player?.damage;
        if (!d) return no('No damage data — not in the car.');
        if (!d.hasDamage) return yes(`Car's clean — no damage.`);
        const worst = known(d.worst) ? d.worst : 0;
        const parts: string[] = [];
        const suspWorst = Math.max(...d.suspension.filter((s) => known(s)));
        if (suspWorst >= 0.2) {
          let i = d.suspension.findIndex((s) => s === suspWorst);
          if (i < 0) i = 0;
          parts.push(`${damageWord(worst)} damage — suspension, ${CORNER_NAMES[i]}.`);
        } else if (known(d.aero) && d.aero >= 0.2) {
          parts.push(`${damageWord(worst)} damage — aero.`);
        } else {
          parts.push(`${damageWord(worst)} damage, bodywork.`);
        }
        // Capitalise the first word of the composed line.
        parts[0] = parts[0]!.charAt(0).toUpperCase() + parts[0]!.slice(1);
        if (known(d.partsDetached) && d.partsDetached > 0) {
          parts.push(d.partsDetached === 1 ? `Something's hanging off.` : `${d.partsDetached} parts hanging off.`);
        }
        if (known(d.repairSeconds) && d.repairSeconds > 0) {
          parts.push(`About ${Math.round(d.repairSeconds)} seconds to fix if you box.`);
        }
        return yes(parts.join(' '));
      }

      case 'brakes': {
        const mm = frame.player?.damage?.brakeThicknessMm;
        if (!mm || !mm.some((v) => known(v) && v > 0)) return no('No brake readings.');
        let thin = -1;
        for (let i = 0; i < 4; i++) {
          if (known(mm[i]) && mm[i]! > 0 && (thin === -1 || mm[i]! < mm[thin]!)) thin = i;
        }
        return yes(`Thinnest brake ${CORNER_NAMES[thin]}, ${mm[thin]!.toFixed(1)} millimetres.`);
      }

      case 'pitStop': {
        const d = frame.player?.damage;
        const p = frame.player?.pit;
        const len =
          known(d?.stopLengthSeconds) && d!.stopLengthSeconds > 0
            ? d!.stopLengthSeconds
            : known(p?.plannedSec) && p!.plannedSec > 0
              ? p!.plannedSec
              : undefined;
        if (len === undefined) return no('No stop planned yet.');
        const parts = [`Planned stop about ${Math.round(len)} seconds.`];
        if (known(d?.tyreCornersSelected)) {
          const n = d!.tyreCornersSelected;
          parts.push(n === 0 ? 'No tyres.' : n === 4 ? 'Four tyres.' : `${n} tyres.`);
        }
        if (d && d.repairSelection !== 'none' && d.repairSelection !== 'unavailable') {
          parts.push(d.repairSelection === 'all' ? 'Full repairs.' : 'Body repairs.');
        }
        return yes(parts.join(' '));
      }

      case 'pitWindow': {
        const f = frame.fuel;
        if (!f) return no('No pit window projection yet.');
        const open = f.pitWindowOpenLap;
        const lap = frame.session.currentLap;
        if (!known(open) || !known(lap) || lap <= 0) return no('No pit window projection yet.');
        if (lap >= open!) {
          const left = known(f.lapsRemaining) ? ` Fuel for ${f.lapsRemaining.toFixed(1)} more laps.` : '';
          return yes(`Pit window is open.${left}`);
        }
        const away = open! - lap;
        return yes(`Window opens lap ${open} — ${away} ${away === 1 ? 'lap' : 'laps'} away.`);
      }

      case 'energy': {
        const f = frame.fuel;
        if (!f || !known(f.virtualEnergyPct)) return no('No virtual energy on this car.');
        const parts = [`Energy at ${Math.round(f.virtualEnergyPct!)} percent`];
        if (known(f.virtualEnergyLapsRemaining)) {
          parts[0] += `, ${f.virtualEnergyLapsRemaining!.toFixed(1)} laps`;
        }
        parts[0] += '.';
        // The verdict that matters: does the allowance reach the flag?
        if (known(f.virtualEnergyLapsRemaining) && known(f.lapsToFinish) && f.lapsToFinish > 0) {
          const short = f.lapsToFinish - f.virtualEnergyLapsRemaining!;
          parts.push(
            short <= 0
              ? 'Enough to the finish.'
              : `${short.toFixed(1)} laps short of the finish.`,
          );
        }
        if (known(f.veLapsInHandVsNext) && f.veLapsInHandVsNext! > 0) {
          parts.push(
            `${f.veLapsInHandVsNext!.toFixed(1)} ${f.veLapsInHandVsNext! >= 2 ? 'laps' : 'lap'} in hand on the car ahead.`,
          );
        }
        if (known(f.veCarsAheadPittingFirst) && f.veCarsAheadPittingFirst! > 0) {
          parts.push(
            f.veCarsAheadPittingFirst === 1
              ? 'One of the cars ahead has to stop before you.'
              : `${f.veCarsAheadPittingFirst} of the cars ahead have to stop before you.`,
          );
        }
        return yes(parts.join(' '));
      }

      case 'hybrid': {
        const h = frame.player?.hybrid;
        if (!h || !known(h.chargeFraction)) return no('No hybrid on this car.');
        return yes(`Battery at ${Math.round(h.chargeFraction * 100)} percent.`);
      }

      case 'pace': {
        const ps = frame.player?.paceScore;
        if (ps && ps.ok && known(ps.percent)) {
          const band = ps.bandLabel ? ` — ${ps.bandLabel}` : '';
          const off =
            known(ps.deltaSec) && ps.deltaSec! > 0.05
              ? ` ${ps.deltaSec!.toFixed(1)} off the reference.`
              : '';
          return yes(`Pace score ${Math.round(ps.percent!)} percent${band}.${off}`);
        }
        const predicted = frame.player?.paceDeltas?.predictedLapSec;
        if (known(predicted) && predicted! > 0) {
          return yes(`On for ${speakableLapTime(predicted!)} this lap.`);
        }
        return no('No pace read yet.');
      }

      case 'bestLap': {
        const me = frame.standings.find((e) => e.isPlayer);
        if (!me || !known(me.bestLapSec) || me.bestLapSec <= 0) return no('No lap on the board yet.');
        const rivals = frame.standings.filter(
          (e) =>
            !e.isPlayer &&
            (!me.carClass || e.carClass === me.carClass) &&
            known(e.bestLapSec) &&
            e.bestLapSec > 0,
        );
        const fastest = rivals.length ? Math.min(...rivals.map((e) => e.bestLapSec)) : Infinity;
        const tag = me.bestLapSec <= fastest ? ' Fastest in class.' : '';
        return yes(`Your best, ${speakableLapTime(me.bestLapSec)}.${tag}`);
      }

      case 'fieldFastest': {
        const me = frame.standings.find((e) => e.isPlayer);
        const pool = frame.standings.filter(
          (e) =>
            known(e.bestLapSec) && e.bestLapSec > 0 && (!me?.carClass || e.carClass === me.carClass),
        );
        if (!pool.length) return no('No lap times on the board yet.');
        const holder = pool.reduce((a, b) => (b.bestLapSec < a.bestLapSec ? b : a));
        if (holder.isPlayer) return yes(`Fastest lap is yours — ${speakableLapTime(holder.bestLapSec)}.`);
        return yes(`Fastest lap, ${radioName(holder)}, ${speakableLapTime(holder.bestLapSec)}.`);
      }

      case 'leader': {
        const me = frame.standings.find((e) => e.isPlayer);
        if (!me) return no('No standings yet.');
        const lead =
          known(me.classPosition) && me.carClass
            ? frame.standings.find((e) => e.carClass === me.carClass && e.classPosition === 1)
            : frame.standings.find((e) => e.position === 1);
        if (!lead) return no('No leader in the standings yet.');
        if (lead.isPlayer) {
          const g = this.classGap(frame, +1);
          const cushion =
            g && g !== 'leader' ? ` ${speakableGap(g.gapSec)} over ${g.name}.` : '';
          return yes(`You're the leader.${cushion}`);
        }
        const parts = [`${radioName(lead)} leads.`];
        if (known(lead.lastLapSec) && lead.lastLapSec > 0) {
          parts.push(`Last lap ${speakableLapTime(lead.lastLapSec)}.`);
        }
        const myGap = known(me.gapToClassLeaderSec) ? me.gapToClassLeaderSec : me.gapToLeaderSec;
        if (known(myGap) && myGap! > 0) parts.push(`You're ${speakableGap(myGap!)} back.`);
        return yes(parts.join(' '));
      }

      case 'gridStart': {
        const me = frame.standings.find((e) => e.isPlayer);
        if (!me || !known(me.gridPosition) || !known(me.position)) {
          return no('No grid data for this session.');
        }
        const diff = me.gridPosition! - me.position;
        const move =
          diff > 0
            ? `up ${diff}`
            : diff < 0
              ? `down ${-diff}`
              : 'holding station';
        return yes(`Started P${me.gridPosition}, running P${me.position} — ${move}.`);
      }

      case 'trackLimits': {
        const tl = frame.player?.trackLimits;
        if (!tl || !known(tl.points)) return no('No track-limits data.');
        const parts: string[] = [];
        if (tl.lapValid === false) parts.push(`This lap's been invalidated.`);
        parts.push(
          known(tl.pointsLimit) && tl.pointsLimit > 0
            ? `Track limits — ${tl.points} of ${tl.pointsLimit} points.`
            : `Track limits — ${tl.points} points.`,
        );
        if (known(tl.penalties) && tl.penalties > 0) {
          parts.push(
            tl.penaltyType
              ? `${tl.penalties === 1 ? 'A penalty' : `${tl.penalties} penalties`} outstanding — ${tl.penaltyType}.`
              : `${tl.penalties === 1 ? 'A penalty' : `${tl.penalties} penalties`} outstanding.`,
          );
        } else if (tl.lapValid !== false) {
          parts.push(`You're clean.`);
        }
        return yes(parts.join(' '));
      }

      case 'flags': {
        const s = frame.session;
        if (s.phase === 'fullCourseYellow') return yes('Full course yellow — field is neutralised.');
        if (s.phase === 'redFlag' || s.flag === 'red') return yes('Red flag — session stopped.');
        const sectors = s.sectorFlags;
        if (!sectors) return no('No flag data.');
        const yellow = sectors
          .map((f, i) => (f === 'yellow' || f === 'doubleYellow' ? i + 1 : 0))
          .filter((n) => n > 0);
        if (!yellow.length) return yes('All clear — green all round.');
        return yes(
          yellow.length === 1
            ? `Yellow in sector ${yellow[0]}.`
            : `Yellows in sectors ${yellow.join(' and ')}.`,
        );
      }

      case 'weather': {
        // Guarded on the whole block: recordings trim frames, and a replayed
        // frame without weather must refuse, not throw (2026-08-19 replay).
        const w = frame.weather;
        if (!w || !known(w.trackTempC)) return no('No weather data.');
        const parts: string[] = [];
        if (known(w.rainIntensity) && w.rainIntensity > 0) {
          parts.push(`It's raining now.`);
        } else {
          // First forecast slot inside ~40 minutes with a real rain risk.
          const risk = (w.forecast || []).find(
            (slot) => known(slot.rainChance) && slot.rainChance >= 0.3 && slot.minutesAhead <= 40,
          );
          if (risk) {
            parts.push(
              `Rain risk ${Math.round(risk.rainChance * 100)} percent in about ${risk.minutesAhead} minutes.`,
            );
          } else {
            parts.push('No rain coming.');
          }
        }
        let track = `Track ${Math.round(w.trackTempC)} degrees`;
        if (w.trackTrend === 'drying') track += ', and drying';
        else if (w.trackTrend === 'wetting') track += ', and getting wetter';
        parts.push(track + '.');
        return yes(parts.join(' '));
      }

      case 'brakeBias': {
        const aid = frame.mfd?.aids?.find((a) => /bias|balance/i.test(a.key) || /bias|balance/i.test(a.label));
        if (!aid) return no('No bias reading — MFD not available.');
        // The MFD renders bias as "56.0:44.0" (front:rear); speak the front.
        const m = /^([\d.]+):[\d.]+$/.exec(aid.text.trim());
        return yes(m ? `Brake bias ${m[1]} front.` : `Brake bias ${aid.text.trim()}.`);
      }

      case 'tractionControl': {
        const aids = frame.mfd?.aids;
        if (!aids || !aids.length) return no('No aid readings — MFD not available.');
        const tc = aids.find((a) => /traction|(^|_)TC($|_)/i.test(a.key) || /traction|^TC\b/i.test(a.label));
        if (!tc) return no('No traction control on this car.');
        return yes(`${tc.label} ${tc.text.trim() || tc.value}.`);
      }
    }
  }

  /* ---- internals --------------------------------------------------------- */

  /** The car `dir` class positions away from the player (−1 ahead, +1 behind). */
  private neighbour(
    frame: TelemetryFrame,
    me: StandingEntry,
    dir: -1 | 1,
  ): StandingEntry | null {
    if (known(me.classPosition) && me.carClass) {
      const want = me.classPosition + dir;
      return (
        frame.standings.find(
          (e) => e.carClass === me.carClass && e.classPosition === want,
        ) ?? null
      );
    }
    const want = me.position + dir;
    return frame.standings.find((e) => e.position === want) ?? null;
  }

  /**
   * Race gap to the class neighbour, from the same `gapToClassLeaderSec` chain
   * the standings widget renders — so the radio and the screen can never
   * disagree. `'leader'` when there is no neighbour in that direction.
   */
  private classGap(
    frame: TelemetryFrame,
    dir: -1 | 1,
  ): { gapSec: number; lapsApart: number; name: string } | 'leader' | null {
    const me = frame.standings.find((e) => e.isPlayer);
    if (!me) return null;
    const other = this.neighbour(frame, me, dir);
    if (!other) {
      // 'leader' only when the standings can PROVE there is nobody in that
      // direction; an incomplete chain falls through to the on-track fallback
      // rather than announcing a podium position we can't establish.
      if (dir === -1) {
        const atFront = (known(me.classPosition) ? me.classPosition : me.position) === 1;
        return atFront ? 'leader' : null;
      }
      if (known(me.classPosition) && me.carClass) {
        const anyBehind = frame.standings.some(
          (e) =>
            e.carClass === me.carClass &&
            known(e.classPosition) &&
            e.classPosition! > me.classPosition!,
        );
        return anyBehind ? null : 'leader';
      }
      return null; // class unknown: never claim 'last', let the track gap answer
    }
    const useClass =
      known(me.gapToClassLeaderSec) && known(other.gapToClassLeaderSec);
    const useOverall = known(me.gapToLeaderSec) && known(other.gapToLeaderSec);
    if (!useClass && !useOverall) return null;
    const gapSec = useClass
      ? Math.abs(me.gapToClassLeaderSec! - other.gapToClassLeaderSec!)
      : Math.abs(me.gapToLeaderSec - other.gapToLeaderSec);
    const lapsApart =
      known(me.classLapsBehind) && known(other.classLapsBehind)
        ? Math.abs(me.classLapsBehind! - other.classLapsBehind!)
        : 0;
    return { gapSec, lapsApart, name: radioName(other) };
  }

  /** On-track fallback: the nearest car ahead (+1) or behind (−1) of the player. */
  private trackGap(
    frame: TelemetryFrame,
    sign: 1 | -1,
  ): { gapSec: number; name: string } | null {
    let best: { gapSec: number; name: string } | null = null;
    for (const r of frame.relative) {
      const g = r.relativeGapSec;
      if (!known(g) || g === 0 || Math.sign(g) !== sign) continue;
      if (!best || Math.abs(g) < best.gapSec) {
        best = { gapSec: Math.abs(g), name: r.driverName.split(/\s+/).pop() || r.driverName };
      }
    }
    return best;
  }

  /**
   * Mean of a car's rolling lap window; null until it has at least one lap.
   * Public because the Tier-2 summary builder borrows this history: the cloud
   * kept being asked "last five average" in wordings the closed grammar missed
   * (2026-08-19 engineer_calls log), and it can only answer with numbers we
   * send — so the same windows that feed `avgAhead` now feed the summary too.
   */
  averageOf(slotId: number): { avg: number; count: number } | null {
    const win = this.windows.get(slotId);
    if (!win || win.laps.length === 0) return null;
    const sum = win.laps.reduce((a, b) => a + b, 0);
    return { avg: sum / win.laps.length, count: win.laps.length };
  }
}
