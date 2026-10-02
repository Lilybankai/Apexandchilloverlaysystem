/**
 * @file src/telemetry/sessionPhrases.ts
 * @module telemetry/sessionPhrases
 *
 * **The words for the qualifying/practice calls** (`sessionCalls.ts`). Kept out
 * of `engineerPhrases.ts` so that file only grows a `case` that delegates here.
 *
 * Unlike the race kinds, these calls are COMPOSED: the lap summary, the clock
 * and the grid slot all land at the same line crossing and are offered in one
 * frame on purpose, so they arrive as one cue. A real engineer says that as one
 * breath — "1:51.8, personal best, P4. Time for one more after this." — so the
 * composer reads every session trigger in the cue (whichever one leads by
 * priority) and joins at most two of them. Same house rules as the phrasebook:
 * variant banks with index 0 canonical, numbers only through engineerCommands'
 * speakable helpers, about a dozen words a part.
 */

import type { EngineerCue, EngineerTrigger } from './triggers';
import { UNKNOWN_VALUE } from './types';
import { speakableGap, speakableLapTime } from './engineerCommands';
import type { SessionCallKind } from './sessionCalls';

const SESSION_KINDS: ReadonlySet<string> = new Set<SessionCallKind>([
  'qualiLap',
  'qualiPole',
  'qualiBeaten',
  'qualiTimeLeft',
  'qualiGrid',
  'practiceLap',
  'sectorImproved',
]);

/** Whether a kind's words live here. */
export function isSessionCallKind(kind: string): kind is SessionCallKind {
  return SESSION_KINDS.has(kind);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v !== UNKNOWN_VALUE ? v : undefined;
}

function pick(variant: number, bank: readonly string[]): string {
  return bank[Math.abs(variant) % bank.length]!;
}

function surname(name: unknown): string {
  const s = String(name ?? '').trim();
  if (!s) return 'the car';
  const parts = s.split(/\s+/);
  return parts[parts.length - 1] ?? s;
}

const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const SECTOR_WORDS: Record<number, string> = { 1: 'one', 2: 'two', 3: 'three' };

/**
 * A small time difference the way an engineer says it: "a tenth", "three
 * tenths", "less than a tenth"; a second or more goes through
 * {@link speakableGap} ("1.4 seconds").
 */
export function speakableTenths(sec: number): string {
  const abs = Math.abs(sec);
  if (abs < 0.05) return 'less than a tenth';
  const tenths = Math.round(abs * 10);
  if (tenths >= 10) return speakableGap(abs);
  if (tenths === 1) return 'a tenth';
  return `${SMALL[tenths]} tenths`;
}

/** Clock remaining, rounded the way it is said over the radio. */
function spokenTimeLeft(sec: number): string {
  if (sec < 60) return 'Under a minute left';
  if (sec < 90) return 'About a minute left';
  return `${Math.round(sec / 60)} minutes left`;
}

/** "P4 in class" in a multiclass field, "P4" otherwise. */
function classPos(f: EngineerTrigger['facts'], at: unknown = f.classPosition): string | null {
  const cls = num(at);
  if (cls === undefined) return null;
  return f.multiclass === true ? `P${cls} in class` : `P${cls}`;
}

/* ---- one part per kind ----------------------------------------------------- */

function lapPart(t: EngineerTrigger, v: number): string | null {
  const f = t.facts;
  if (f.verdict === 'deleted') {
    return pick(v, ["Lap's deleted — track limits.", "That one's deleted, track limits.", 'Track limits — lap deleted.']);
  }
  const sec = num(f.lapSec);
  if (sec === undefined) return null;
  const time = speakableLapTime(sec);

  if (t.kind === 'practiceLap') {
    const gain = num(f.gainSec);
    return pick(v, [
      `Personal best, ${time}.`,
      gain !== undefined ? `New best — ${time}, ${speakableTenths(gain)} quicker.` : `New best — ${time}.`,
      `${time}, that's a personal best.`,
    ]);
  }

  const pos = classPos(f);
  if (f.verdict === 'pb' || f.verdict === 'first') {
    if (f.pole === true && f.keptPole === true) {
      return pick(v, [`Personal best, ${time} — still on pole.`, `${time}, quicker again. Still on pole.`]);
    }
    if (f.pole === true) {
      return pick(v, [`Provisional pole! ${time}.`, `That's provisional pole — ${time}.`, `${time} — provisional pole.`]);
    }
    if (f.verdict === 'first') {
      return pos ? pick(v, [`${time} on the board, ${pos}.`, `${time} — that's ${pos}.`]) : `${time} on the board.`;
    }
    return pos
      ? pick(v, [`Personal best, ${time}, ${pos}.`, `${time}, personal best — ${pos}.`, `Personal best — ${time}. That's ${pos}.`])
      : `Personal best, ${time}.`;
  }
  // A push lap that did not improve.
  const off = num(f.offSec) ?? 0;
  const gap = speakableTenths(off);
  const same = f.samePosition === true;
  const onPole = num(f.classPosition) === 1;
  const where = !pos ? '' : onPole ? (same ? 'still on pole' : 'on pole') : same ? `still ${pos}` : `${pos} now`;
  return pick(v, [
    `${time}, ${gap} off your best${where ? `, ${where}` : ''}.`,
    `${time} — ${gap} off.${where ? ` ${where.charAt(0).toUpperCase()}${where.slice(1)}.` : ''}`,
  ]);
}

function polePart(t: EngineerTrigger, beaten: EngineerTrigger | undefined, v: number): string | null {
  const f = t.facts;
  const sec = num(f.lapSec);
  const who = surname(f.name);
  const time = sec !== undefined ? speakableLapTime(sec) : null;
  // Where that leaves us, when it moved us (the beaten call rode in this cue)
  // or the pole was ours.
  const pos = beaten ? classPos(beaten.facts, beaten.facts.to) : classPos(f);
  if (f.wasMine === true) {
    return pick(v, [
      `${who} takes pole off you${time ? ` — ${time}` : ''}.${pos ? ` You're ${pos}.` : ''}`,
      `Pole's gone — ${who}${time ? `, ${time}` : ''}.${pos ? ` ${pos} now.` : ''}`,
    ]);
  }
  const tail = beaten && pos ? ` You're ${pos} now.` : '';
  return pick(v, [
    `New pole: ${who}${time ? `, ${time}` : ''}.${tail}`,
    `${who} goes to pole${time ? `, ${time}` : ''}.${tail}`,
    `Pole changes — ${who}${time ? `, ${time}` : ''}.${tail}`,
  ]);
}

function beatenPart(t: EngineerTrigger, v: number): string | null {
  const f = t.facts;
  const pos = classPos(f, f.to);
  if (!pos) return null;
  const n = num(f.count) ?? 1;
  if (n <= 1 && typeof f.name === 'string' && f.name) {
    const who = surname(f.name);
    return pick(v, [
      `${who}'s gone quicker — you're ${pos} now.`,
      `${who} beats your time. ${pos} now.`,
      `Lost a place to ${who} — ${pos}.`,
    ]);
  }
  if (n <= 1) return pick(v, [`Someone's gone quicker — you're ${pos} now.`, `Down a place — ${pos}.`]);
  const cars = SMALL[n] ?? String(n);
  return pick(v, [
    `${cars.charAt(0).toUpperCase()}${cars.slice(1)} cars have gone quicker — you're ${pos} now.`,
    `Down to ${pos} — ${cars} cars improved.`,
  ]);
}

function timeLeftPart(t: EngineerTrigger, v: number): string | null {
  const f = t.facts;
  const left = num(f.timeLeftSec);
  const clock = left !== undefined ? spokenTimeLeft(left) : null;
  switch (f.verdict) {
    case 'oneMore':
      return pick(v, [
        `${clock ?? 'Clock check'} — time for one more after this.`,
        `${clock ? `${clock}. ` : ''}That's one more go after this lap.`,
      ]);
    case 'last':
      return pick(v, ['No time for another after this one.', `${clock ? `${clock} — ` : ''}this is the last lap you'll start.`]);
    case 'tight':
      return pick(v, ["It's tight — the clock runs out around the end of this lap."]);
    default:
      return null;
  }
}

function gridPart(t: EngineerTrigger, short: boolean, v: number): string | null {
  const f = t.facts;
  const cls = num(f.classPosition);
  if (cls === undefined) return null;
  const overall = num(f.position);
  const where =
    f.multiclass === true && overall !== undefined ? `P${cls} in class, P${overall} overall` : `P${cls}`;
  if (f.provisional === true) {
    return short
      ? `That's the flag — provisionally ${where}.`
      : pick(v, [`That's the flag. Provisionally ${where}, cars still running.`, `Session's done for us — provisionally ${where}.`]);
  }
  return short
    ? `That's the flag — you'll start ${where}.`
    : pick(v, [`That's the flag. You'll start ${where}.`, `Qualifying done — you'll start ${where}.`]);
}

function sectorPart(t: EngineerTrigger, v: number): string | null {
  const f = t.facts;
  const s = SECTOR_WORDS[num(f.sector) ?? 0];
  if (!s) return null;
  if (f.purple === true) return pick(v, [`Purple sector ${s}.`, `Purple in sector ${s}.`, `Sector ${s}, purple.`]);
  const d = num(f.deltaSec) ?? (typeof f.deltaSec === 'number' ? f.deltaSec : undefined);
  if (d === undefined || d >= 0) return null;
  const gain = speakableTenths(d);
  return pick(v, [
    `Sector ${s}, ${gain} up.`,
    `Up ${gain} through sector ${s}.`,
    `${gain.charAt(0).toUpperCase()}${gain.slice(1)} up in sector ${s}.`,
  ]);
}

/**
 * The sentence for a cue led by a qualifying/practice kind — composed from
 * every session trigger the cue carries, at most two parts.
 */
export function sessionCallSentence(cue: EngineerCue, v: number): string | null {
  const by = (k: SessionCallKind): EngineerTrigger | undefined => cue.triggers.find((t) => t.kind === k);
  const lap = by('qualiLap') ?? by('practiceLap');
  const grid = by('qualiGrid');
  const pole = by('qualiPole');
  const beaten = by('qualiBeaten');
  const time = by('qualiTimeLeft');
  const sector = by('sectorImproved');

  const parts: string[] = [];
  const add = (s: string | null): void => {
    if (s && parts.length < 2) parts.push(s);
  };
  if (lap) {
    add(lapPart(lap, v));
    // The lap already says where we are, so a position-loss line is redundant.
    if (grid) add(gridPart(grid, true, v));
    else if (pole) add(polePart(pole, undefined, v));
    else if (time) add(timeLeftPart(time, v));
  } else if (grid) {
    add(gridPart(grid, false, v));
  } else if (pole) {
    add(polePart(pole, beaten, v));
    if (time) add(timeLeftPart(time, v));
  } else if (beaten) {
    add(beatenPart(beaten, v));
    if (time) add(timeLeftPart(time, v));
  } else if (time) {
    add(timeLeftPart(time, v));
  } else if (sector) {
    add(sectorPart(sector, v));
  }
  return parts.length ? parts.join(' ') : null;
}
