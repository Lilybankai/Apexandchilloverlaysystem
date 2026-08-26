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
import { PitLossModel } from './pitExit';
import type { PitExitProjection } from './pitExit';
import {
  deltaToReferencePaceTarget,
  referencePaceTarget,
} from './paceTargets';
import type { ReferencePaceTargetId } from './paceTargets';

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
  | 'sectors'
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
  | 'fuelRatio'
  | 'hybrid'
  | 'pace'
  | 'paceAlien'
  | 'paceCompetitive'
  | 'paceMidpack'
  // The trend set (2026-08-23): the questions drivers actually ask are about
  // CHANGE — is he catching me, will the tyres last — and a snapshot cannot
  // answer them. Fed by the per-lap history sampled in update().
  | 'catching'
  | 'defending'
  | 'tyreLife'
  | 'pitExit'
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
  'sectors',
  'position',
  'tyres',
  'pressures',
  'damage',
  'brakes',
  'pitStop',
  'pitWindow',
  'energy',
  'fuelRatio',
  'hybrid',
  'pace',
  'paceAlien',
  'paceCompetitive',
  'paceMidpack',
  'catching',
  'defending',
  'tyreLife',
  'pitExit',
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

/**
 * One sector split for a list. Sub-minute values drop the unit — "28.1, 48.3,
 * 32.7" is how an engineer reads three splits, and repeating "seconds" three
 * times is noise. A minute-plus split (Le Mans) uses {@link speakableLapTime}.
 */
export function speakableSplit(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return 'no time';
  if (sec >= 60) return speakableLapTime(sec);
  return sec.toFixed(1);
}

/**
 * Cumulative S1/S2 boundaries plus the lap time → three split durations, or
 * null. Same all-or-nothing rule as `lapLog.sectorSplits`: a withheld or torn
 * pair (`-1`, a boundary past the lap time) is no data, not two real splits
 * and one invented one.
 */
function lastLapSplits(
  s1Sec: number | undefined,
  s2Sec: number | undefined,
  lapSec: number,
): [number, number, number] | null {
  if (!known(s1Sec) || !known(s2Sec) || !known(lapSec) || lapSec <= 0) return null;
  const s1 = s1Sec;
  const s2 = s2Sec - s1Sec;
  const s3 = lapSec - s2Sec;
  if (s1 <= 0 || s2 <= 0 || s3 <= 0) return null;
  return [s1, s2, s3];
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

/** One target-time answer shared by the Alien, Competitive and Midpack intents. */
function referencePaceAnswer(
  frame: TelemetryFrame,
  id: ReferencePaceTargetId,
): string | null {
  const score = frame.player?.paceScore;
  const target = referencePaceTarget(score, id);
  if (!score || !target) return null;

  const identity =
    score.sheetClass && score.layoutName
      ? ` for ${score.sheetClass} at ${score.layoutName}`
      : score.sheetClass
        ? ` for ${score.sheetClass}`
        : score.layoutName
          ? ` at ${score.layoutName}`
          : '';
  const targetLine =
    `${target.label} race pace${identity} is ${speakableLapTime(target.lapSec)} or better.`;
  const delta = deltaToReferencePaceTarget(score, target);
  if (delta === null || !known(score.lapSec)) return targetLine;

  const best = `Your best is ${speakableLapTime(score.lapSec)}.`;
  if (delta > 0.05) {
    return `${targetLine} ${best} ${delta.toFixed(1)} seconds to find.`;
  }
  if (delta < -0.05) {
    return `${targetLine} ${best} ${Math.abs(delta).toFixed(1)} seconds faster than that target.`;
  }
  return `${targetLine} ${best} Right on that target.`;
}

/* -------------------------------------------------------------------------- */
/*  The engineer                                                              */
/* -------------------------------------------------------------------------- */

/** Rolling window of a car's most recent completed lap times, newest last. */
interface LapWindow {
  lastSeen: number;
  laps: number[];
}

/** One per-lap sample of the gap to a class neighbour, tagged with who it was. */
interface GapSample {
  lap: number;
  slotId: number;
  gapSec: number;
}

/** One per-lap sample of a player-side scalar (wear fraction, litres, pct). */
interface LapValue {
  lap: number;
  value: number;
}

/** How many per-lap samples the trend windows keep. */
const HISTORY_LAPS = 6;

/** A per-lap rate under this reads as "holding steady", seconds. */
const TREND_FLAT_SEC = 0.05;

/** The wear fraction the tyre-life answer counts down to (matches "nearly done"). */
const WEAR_FLOOR = 0.15;

/** A gap/wear/burn trend read over the recent per-lap history. */
interface TrendRead {
  /** Per-lap rate; sign convention is the caller's (see each use). */
  ratePerLap: number;
  /** Newest sampled value. */
  latest: number;
  /** How many laps the read spans. */
  laps: number;
}

/** Oldest-vs-newest rate over a window; null under two samples or zero span. */
function trendOf(values: { lap: number; value: number }[]): TrendRead | null {
  if (values.length < 2) return null;
  const oldest = values[0]!;
  const newest = values[values.length - 1]!;
  const laps = newest.lap - oldest.lap;
  if (laps <= 0) return null;
  return {
    ratePerLap: (oldest.value - newest.value) / laps,
    latest: newest.value,
    laps,
  };
}

export class EngineerCommands {
  private frame: TelemetryFrame | null = null;
  private sessionKey = '';
  private windows = new Map<number, LapWindow>();
  private playerLapSeen = 0;
  private gapAheadHist: GapSample[] = [];
  private gapBehindHist: GapSample[] = [];
  private wearHist: LapValue[] = [];
  private fuelHist: LapValue[] = [];
  private energyHist: LapValue[] = [];
  private pitModel = new PitLossModel();

  /** Drop all history — new session, or a caller that knows better. */
  reset(): void {
    this.frame = null;
    this.sessionKey = '';
    this.windows.clear();
    this.clearHistory();
    this.pitModel.reset();
  }

  private clearHistory(): void {
    this.playerLapSeen = 0;
    this.gapAheadHist = [];
    this.gapBehindHist = [];
    this.wearHist = [];
    this.fuelHist = [];
    this.energyHist = [];
  }

  /**
   * Feed the latest frame. Cheap on the nothing-happened path: one compare per
   * standings row. Lap windows only mutate on a `lastLapSec` edge, and the
   * player-side trend history only on the player's own lap edge.
   */
  update(frame: TelemetryFrame): void {
    const key = sessionKeyOf(frame);
    if (key !== this.sessionKey) {
      this.windows.clear();
      this.clearHistory();
      this.sessionKey = key;
    }
    this.frame = frame;
    this.pitModel.update(frame);

    for (const entry of frame.standings) {
      const last = entry.lastLapSec;
      if (!known(last) || last <= 0) continue;
      let win = this.windows.get(entry.slotId);
      if (!win) {
        win = { lastSeen: last, laps: [last] };
        this.windows.set(entry.slotId, win);
        if (entry.isPlayer) this.sampleLap(frame, entry);
        continue;
      }
      if (last !== win.lastSeen) {
        win.lastSeen = last;
        win.laps.push(last);
        if (win.laps.length > AVG_WINDOW_LAPS) win.laps.shift();
        if (entry.isPlayer) this.sampleLap(frame, entry);
      }
    }
  }

  /**
   * The player just completed a lap: take one sample of everything the trend
   * answers need. Per-lap sampling is what makes "0.3 a lap" honest — the same
   * cadence a timing screen reads gaps at.
   */
  private sampleLap(frame: TelemetryFrame, me: StandingEntry): void {
    const lap = known(me.lapsCompleted) ? me.lapsCompleted : this.playerLapSeen + 1;
    if (lap <= this.playerLapSeen) return;
    this.playerLapSeen = lap;
    const push = <T>(arr: T[], v: T): void => {
      arr.push(v);
      if (arr.length > HISTORY_LAPS) arr.shift();
    };

    for (const dir of [-1, 1] as const) {
      const other = this.neighbour(frame, me, dir);
      const g = this.classGap(frame, dir);
      if (other && g && g !== 'leader' && !g.lapsApart) {
        push(dir === -1 ? this.gapAheadHist : this.gapBehindHist, {
          lap,
          slotId: other.slotId,
          gapSec: g.gapSec,
        });
      }
    }

    const t = frame.player?.tyres;
    if (t) {
      const wears = [t.frontLeft, t.frontRight, t.rearLeft, t.rearRight]
        .map((c) => (known(c?.wear) && c!.wear >= 0 ? c!.wear : undefined))
        .filter((w): w is number => w !== undefined);
      if (wears.length) push(this.wearHist, { lap, value: Math.min(...wears) });
    }
    const f = frame.fuel;
    if (f && known(f.levelLiters) && f.levelLiters >= 0) {
      push(this.fuelHist, { lap, value: f.levelLiters });
    }
    if (f && known(f.virtualEnergyPct)) {
      push(this.energyHist, { lap, value: f.virtualEnergyPct! });
    }
  }

  /**
   * The gap trend to the class neighbour: only samples against the SAME car
   * count (an undercut swaps the neighbour and the old numbers describe a
   * different fight). Positive rate = the gap is closing.
   */
  private gapTrend(dir: -1 | 1): (TrendRead & { name: string }) | null {
    const hist = dir === -1 ? this.gapAheadHist : this.gapBehindHist;
    if (!hist.length || !this.frame) return null;
    const current = hist[hist.length - 1]!;
    // The neighbour right now must still be the sampled car.
    const me = this.frame.standings.find((e) => e.isPlayer);
    const other = me ? this.neighbour(this.frame, me, dir) : null;
    if (!other || other.slotId !== current.slotId) return null;
    const run = hist.filter((s) => s.slotId === current.slotId);
    const t = trendOf(run.map((s) => ({ lap: s.lap, value: s.gapSec })));
    if (!t) return null;
    return { ...t, name: radioName(other) };
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
        // Counted off the leader of the DRIVER'S class, not the overall leader:
        // the flag falls on the leader, so a lapped car does not get its laps
        // back, and in a multiclass LMU race the overall leader is a Hypercar
        // whose lap count has nothing to do with a GT3's race. Same number the
        // standings strip prints, which is the point — the driver must not be
        // able to get two different answers by asking twice.
        const lead = known(s.classLeaderLap) && s.classLeaderLap > 0 ? s.classLeaderLap : s.currentLap;
        if (known(s.totalLaps) && s.totalLaps > 0 && known(lead) && lead > 0) {
          // The provider's prediction when it has one — a lap total belongs to
          // the car winning the race, and a slower class covers fewer laps in
          // the same time (telemetry/lapsToFlag). It is published only when it
          // really is a guess, so "about" is said exactly when it is earned.
          const pred = known(s.lapsRemaining) && s.lapsRemaining > 0 ? s.lapsRemaining : 0;
          const left = pred || Math.max(0, s.totalLaps - lead + 1);
          if (left <= 1) return yes('This is the last lap.');
          return yes(
            pred
              ? `About ${left} laps to go, including this one.`
              : `${left} laps to go, including this one.`,
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

      case 'sectors': {
        const me = frame.standings.find((e) => e.isPlayer);
        if (!me || !known(me.lastLapSec) || me.lastLapSec <= 0)
          return no('No completed lap yet.');
        const splits = lastLapSplits(me.lastSector1Sec, me.lastSector2Sec, me.lastLapSec);
        if (!splits) return no('No sector times for that lap.');
        return yes(
          `Last lap sectors — ${speakableSplit(splits[0])}, ${speakableSplit(splits[1])}, ${speakableSplit(splits[2])}.`,
        );
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

      case 'fuelRatio': {
        // Asked twice on day one (2026-08-19 engineer_calls log) and refused.
        // Prefer the sim's own MFD aid if this car exposes one; otherwise the
        // observed burn ratio — litres per percentage point of virtual energy —
        // which is the number the driver is steering their refuel around.
        const aid = frame.mfd?.aids?.find(
          (a) => /fuel.*ratio/i.test(a.key) || /fuel.*ratio/i.test(a.label),
        );
        if (aid && aid.text.trim()) return yes(`Fuel ratio ${aid.text.trim()}.`);
        const f = frame.fuel;
        if (
          f &&
          known(f.perLapAvgLiters) && f.perLapAvgLiters > 0 &&
          known(f.virtualEnergyPerLapPct) && f.virtualEnergyPerLapPct! > 0
        ) {
          const ratio = f.perLapAvgLiters / f.virtualEnergyPerLapPct!;
          return yes(`You're burning ${ratio.toFixed(2)} litres per percent of energy.`);
        }
        return no('No fuel-ratio read on this car.');
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
              ? ` ${ps.deltaSec!.toFixed(1)} off alien race pace.`
              : '';
          const best = known(ps.lapSec) && ps.lapSec > 0
            ? `Your best is ${speakableLapTime(ps.lapSec)}. `
            : '';
          return yes(`${best}Pace score ${Math.round(ps.percent!)} percent${band}.${off}`);
        }
        const predicted = frame.player?.paceDeltas?.predictedLapSec;
        if (known(predicted) && predicted! > 0) {
          return yes(`On for ${speakableLapTime(predicted!)} this lap.`);
        }
        return no('No pace read yet.');
      }

      case 'paceAlien':
      case 'paceCompetitive':
      case 'paceMidpack': {
        const targetId: ReferencePaceTargetId =
          intent === 'paceAlien'
            ? 'alien'
            : intent === 'paceCompetitive'
              ? 'competitive'
              : 'midpack';
        const answer = referencePaceAnswer(frame, targetId);
        if (answer) return yes(answer);
        return no(frame.player?.paceScore?.detail || 'No reference pace for this class and layout.');
      }

      case 'catching': {
        const me = frame.standings.find((e) => e.isPlayer);
        if (!me) return no('No standings yet.');
        if (!this.neighbour(frame, me, -1)) {
          return yes("You're leading the class — nobody to catch.");
        }
        const t = this.gapTrend(-1);
        if (!t) return no('No trend on the car ahead yet — give me a couple of laps.');
        if (Math.abs(t.ratePerLap) < TREND_FLAT_SEC) {
          return yes(`Gap to ${t.name} is holding around ${speakableGap(t.latest)}.`);
        }
        if (t.ratePerLap > 0) {
          const laps = t.latest / t.ratePerLap;
          const when =
            laps <= 30
              ? ` — with him in about ${Math.max(1, Math.round(laps))} laps.`
              : ` — but it'll be a long chase at this rate.`;
          return yes(`You're taking ${t.ratePerLap.toFixed(1)} a lap out of ${t.name}${when}`);
        }
        return yes(
          `${t.name}'s pulling away — ${(-t.ratePerLap).toFixed(1)} a lap over the last ${t.laps}.`,
        );
      }

      case 'defending': {
        const me = frame.standings.find((e) => e.isPlayer);
        if (!me) return no('No standings yet.');
        if (!this.neighbour(frame, me, 1)) {
          return yes('Nobody behind in class.');
        }
        const t = this.gapTrend(1);
        if (!t) return no('No trend on the car behind yet — give me a couple of laps.');
        if (Math.abs(t.ratePerLap) < TREND_FLAT_SEC) {
          return yes(`Gap to ${t.name} behind is holding around ${speakableGap(t.latest)}.`);
        }
        if (t.ratePerLap > 0) {
          const laps = t.latest / t.ratePerLap;
          const when =
            laps <= 30
              ? ` — with you in about ${Math.max(1, Math.round(laps))} laps.`
              : ` — but he's a long way off at that rate.`;
          return yes(`${t.name}'s taking ${t.ratePerLap.toFixed(1)} a lap out of you${when}`);
        }
        return yes(
          `You're pulling away from ${t.name} — ${(-t.ratePerLap).toFixed(1)} a lap over the last ${t.laps}.`,
        );
      }

      case 'tyreLife': {
        if (!this.wearHist.length) return no('No tyre wear read on this car.');
        const worst = this.wearHist[this.wearHist.length - 1]!.value;
        const pct = Math.round(worst * 100);
        if (worst <= WEAR_FLOOR) {
          return yes(`They're about done — ${pct} percent on the worst corner. Box soon.`);
        }
        const t = trendOf(this.wearHist);
        if (!t) return no(`Worst tread ${pct} percent — no wear rate yet, give me another lap.`);
        if (t.ratePerLap <= 0.001) {
          return yes(`Tyres are hardly wearing — worst tread ${pct} percent. Plenty left.`);
        }
        const lapsLeft = (worst - WEAR_FLOOR) / t.ratePerLap;
        const perLap = (t.ratePerLap * 100).toFixed(1);
        if (lapsLeft < 1) {
          return yes(`Worst tread ${pct} percent and dropping ${perLap} a lap — they're about done.`);
        }
        return yes(
          `Worst tread ${pct} percent, dropping about ${perLap} a lap — good for roughly ${Math.floor(lapsLeft)} more laps.`,
        );
      }

      case 'pitExit': {
        const proj = this.pitModel.project(frame);
        if (!proj) {
          const d = frame.player?.damage;
          const p = frame.player?.pit;
          const len =
            known(d?.stopLengthSeconds) && d!.stopLengthSeconds > 0
              ? d!.stopLengthSeconds
              : known(p?.plannedSec) && p!.plannedSec > 0
                ? p!.plannedSec
                : undefined;
          return no(
            len !== undefined
              ? `No pit-loss read yet — nobody's made a stop to measure. Your stationary time would be about ${Math.round(len)} seconds.`
              : `No pit-loss read yet — nobody's made a stop to measure.`,
          );
        }
        const where = proj.aheadName
          ? `, about ${speakableGap(proj.aheadGapSec ?? 0)} behind ${proj.aheadName}`
          : proj.behindName
            ? `, ${speakableGap(proj.behindGapSec ?? 0)} clear of ${proj.behindName}`
            : '';
        const parts = [`Box now and you'd come out around P${proj.position}${where}.`];
        if (proj.aheadStillToStop) {
          parts.push(
            proj.aheadStillToStop === 1
              ? 'One of those cars still has to stop.'
              : `${proj.aheadStillToStop} of those cars still have to stop.`,
          );
        }
        parts.push(
          proj.samples === 1
            ? `That's off the one stop we've timed.`
            : `That's off the ${proj.samples} stops we've timed.`,
        );
        return yes(parts.join(' '));
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

  /**
   * The trend + pit-exit read for the Tier-2 summary — the same history the
   * spoken answers use, so the cloud and the radio can never disagree about
   * whether the gap is closing. All values pre-rounded for the payload.
   */
  summaryExtras(): {
    aheadTrendSecPerLap?: number;
    lapsToCatchAhead?: number;
    behindTrendSecPerLap?: number;
    tyreWorstPct?: number;
    tyreWearPctPerLap?: number;
    tyreLapsLeft?: number;
    fuelLastLapL?: number;
    energyLastLapPct?: number;
    pitLossSec?: number;
    pitLossSamples?: number;
    pitExitPosition?: number;
    pitExitBehind?: string;
    pitExitBehindGapSec?: number;
    pitExitAheadOf?: string;
    pitExitAheadOfGapSec?: number;
  } {
    const r1 = (n: number): number => Math.round(n * 10) / 10;
    const out: ReturnType<EngineerCommands['summaryExtras']> = {};
    const ahead = this.gapTrend(-1);
    if (ahead) {
      out.aheadTrendSecPerLap = r1(ahead.ratePerLap);
      if (ahead.ratePerLap >= TREND_FLAT_SEC) {
        out.lapsToCatchAhead = Math.max(1, Math.round(ahead.latest / ahead.ratePerLap));
      }
    }
    const behind = this.gapTrend(1);
    if (behind) out.behindTrendSecPerLap = r1(behind.ratePerLap);

    if (this.wearHist.length) {
      out.tyreWorstPct = Math.round(this.wearHist[this.wearHist.length - 1]!.value * 100);
      const wt = trendOf(this.wearHist);
      if (wt && wt.ratePerLap > 0.001) {
        out.tyreWearPctPerLap = r1(wt.ratePerLap * 100);
        out.tyreLapsLeft = Math.max(0, Math.floor((wt.latest - WEAR_FLOOR) / wt.ratePerLap));
      }
    }
    const lastBurn = (hist: LapValue[]): number | undefined => {
      if (hist.length < 2) return undefined;
      const a = hist[hist.length - 2]!;
      const b = hist[hist.length - 1]!;
      const laps = b.lap - a.lap;
      if (laps <= 0) return undefined;
      const burn = (a.value - b.value) / laps;
      return burn > 0 ? burn : undefined; // negative = a refuel, not a burn
    };
    const fb = lastBurn(this.fuelHist);
    if (fb !== undefined) out.fuelLastLapL = r1(fb);
    const eb = lastBurn(this.energyHist);
    if (eb !== undefined) out.energyLastLapPct = r1(eb);

    if (this.frame) {
      const proj: PitExitProjection | null = this.pitModel.project(this.frame);
      if (proj) {
        out.pitLossSec = proj.lossSec;
        out.pitLossSamples = proj.samples;
        out.pitExitPosition = proj.position;
        if (proj.aheadName) {
          out.pitExitBehind = proj.aheadName;
          if (proj.aheadGapSec !== undefined) out.pitExitBehindGapSec = proj.aheadGapSec;
        }
        if (proj.behindName) {
          out.pitExitAheadOf = proj.behindName;
          if (proj.behindGapSec !== undefined) out.pitExitAheadOfGapSec = proj.behindGapSec;
        }
      }
    }
    return out;
  }
}
