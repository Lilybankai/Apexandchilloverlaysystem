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
  | 'position';

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

/** A gap in seconds for speech: one decimal, always with the unit. */
function speakableGap(sec: number): string {
  const abs = Math.abs(sec);
  const val = abs >= 60 ? speakableLapTime(abs) : `${abs.toFixed(1)} seconds`;
  return val;
}

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
        const mine = this.average(me.slotId);
        const theirs = this.average(ahead.slotId);
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
        const avg = this.average(other.slotId);
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
        const f = frame.fuel;
        if (!known(f.lapsRemaining)) return no('No fuel read yet.');
        const laps = `Fuel for ${f.lapsRemaining.toFixed(1)} laps.`;
        if (f.pitThisLap) return yes(`${laps} Box this lap — you will not make another.`);
        if (known(f.fuelDeltaLiters) && known(f.lapsToFinish)) {
          if (f.fuelDeltaLiters >= 0) return yes(`${laps} Good to the finish.`);
          return yes(
            `${laps} You're ${Math.abs(f.fuelDeltaLiters).toFixed(1)} litres short of the finish.`,
          );
        }
        return yes(laps);
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

  /** Mean of a car's rolling lap window; null until it has at least one lap. */
  private average(slotId: number): { avg: number; count: number } | null {
    const win = this.windows.get(slotId);
    if (!win || win.laps.length === 0) return null;
    const sum = win.laps.reduce((a, b) => a + b, 0);
    return { avg: sum / win.laps.length, count: win.laps.length };
  }
}
