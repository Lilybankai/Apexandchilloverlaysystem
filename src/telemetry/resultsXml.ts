/**
 * @file src/telemetry/resultsXml.ts
 * @module telemetry/resultsXml
 *
 * Reads LMU's **session results file**, `UserData\Log\Results\*.xml`, into
 * typed data. Pure: text in, object out, no disk and no clock. Phase 1 of
 * `docs/RACE-LOG-PLAN.md`; `raceLog.ts` turns the result into a timeline.
 *
 * ## Why a hand parser
 * No XML library is a dependency, and this format does not need one. It is
 * rFactor 2's results file: one element per line, no nesting inside the
 * `<Stream>`, no CDATA, attributes always double-quoted. A tolerant scan over
 * that is ~20 lines and reads a 3 MB four-hour race in tens of milliseconds,
 * in steps a caller can yield between ({@link parseResultsSteps}). Anything it
 * cannot make sense of returns `null`; nothing here throws.
 *
 * ## Facts about the file, measured on the 207 race files on Carl's PC (2026-09-30)
 * - It is written **once**, ~80 s after the chequered flag. A file without
 *   `</RaceResults>` is one caught mid-write or cut short, and is refused.
 * - The number in `Name(n)` and the `ID=` attribute are the car's **slot**.
 *   `<Driver>` blocks carry **no slot at all** and are not in slot order
 *   (Long Beach 2026-09-24: the first block is slot 0, the second slot 32).
 *   See {@link assignSlots} for how the two are joined.
 * - `<Lap num=N et=…>` stamps the **start** of lap N: its `et` equals the
 *   stream's `lap=N-1 point=0` crossing, and every car's lap 1 shares one `et`,
 *   the green flag. The text is lap N's time, `--.----` when it did not count.
 * - A client that **joined mid-race** gets the laps it missed back-filled with
 *   `p="105"` and `topspeed="0.00"`. Their times look real; their positions are
 *   junk. Such a lap keeps its time and reads `p: null`.
 * - Every `<TrackLimits>` line is **written twice**, byte for byte. The parser
 *   keeps one. `Driver=` can carry a leading tab (`"\tCarl Jones"`), so every
 *   name is trimmed.
 * - An `<Incident>` is logged once **per reporting car**, so a car-to-car
 *   contact usually appears twice with two different magnitudes. That pairing
 *   is the builder's job; this keeps both rows as written.
 * - `isPlayer` is 1 for every human in multiplayer. It is not read.
 * - Some `<Penalty Reason=…>` strings are in the server's language
 *   (`Erlaubtes Energielimit überschritten.`), kept verbatim.
 */

/* -------------------------------------------------------------------------- */
/*  Shapes                                                                    */
/* -------------------------------------------------------------------------- */

export type ResultsSessionType = 'race' | 'qualify' | 'practice' | 'warmup';

export interface ResultsLap {
  num: number;
  /** Overall position at the end of this lap; null on a back-filled lap. */
  p: number | null;
  /** Session-elapsed seconds at the START of this lap. */
  et: number;
  s1: number | null;
  s2: number | null;
  s3: number | null;
  /** Lap time in seconds; null for `--.----` (no time counted). */
  lapTime: number | null;
  /** The car entered the pits during this lap. */
  pit: boolean;
  topSpeed: number;
  /** Filled in by the server for a client that joined later; position unknown. */
  backfilled: boolean;
}

export interface ResultsSwap {
  startLap: number;
  endLap: number;
  name: string;
}

export interface ResultsDriver {
  /** The driver in the seat when the file was written. */
  name: string;
  /** The car's slot, or null when nothing in the file ties this block to one. */
  slot: number | null;
  carNumber: string;
  carClass: string;
  /** `<VehName>`, e.g. `Oreca 07 ELMS Custom Team 2025 #397`. */
  vehicle: string;
  carType: string;
  team: string;
  gridPos: number | null;
  classGridPos: number | null;
  position: number | null;
  classPosition: number | null;
  /** `Finished Normally`, `DNF`, `DQ` or `None`. */
  finishStatus: string;
  /** `Suspension`, `Engine`, `Accident`, `Fuel`, `DNF`; `''` when absent. */
  dnfReason: string;
  laps: number;
  pitstops: number;
  bestLapTime: number | null;
  finishTime: number | null;
  swaps: ResultsSwap[];
  lapList: ResultsLap[];
}

export type StreamEntry =
  | {
      type: 'incident';
      et: number;
      name: string;
      slot: number;
      /** LMU's unitless contact strength. */
      magnitude: number;
      otherName: string | null;
      otherSlot: number | null;
      /** `Immovable`, `Post`, `Sign`, `Wheel`, `Wing`, `Cone` when not a car. */
      object: string | null;
    }
  | {
      type: 'limits';
      et: number;
      name: string;
      slot: number;
      /** The `Lap=` attribute: laps completed when it happened. */
      lap: number;
      /** Points this excursion added. */
      warningPoints: number;
      /** The running total after it. */
      currentPoints: number;
      /** 0 DQ, 1 stop-go, 2 drive-through, 3 time, 4 warning, 5 invalid lap, 7 no further action. */
      resolution: number;
      verdict: string;
    }
  | {
      type: 'penalty';
      et: number;
      action: 'given';
      name: string;
      slot: number;
      /** `Drive Thru`, `Stop/Go`, `Time`, `Disqualify`. */
      penalty: string;
      seconds: number;
      reason: string;
    }
  | { type: 'penalty'; et: number; action: 'served'; name: string; penalty: string }
  | { type: 'penalty'; et: number; action: 'converted'; name: string; seconds: number }
  | { type: 'penalty'; et: number; action: 'other'; text: string }
  | {
      type: 'sector';
      et: number;
      name: string;
      slot: number;
      /** `suspension` / `engine` for a damage report; null for a sector best. */
      damage: string | null;
      text: string;
    }
  | {
      type: 'score';
      et: number;
      name: string;
      slot: number;
      /** Laps completed at this timing line. */
      lap: number;
      /** 0 the finish line, 1 and 2 the sector lines. */
      point: number;
      /** Lap time (point 0) or sector time; null for `t=-1` (not counted). */
      t: number | null;
      /** The precise crossing time (3 decimals), from the text. */
      atEt: number;
    }
  | { type: 'checkered'; et: number; name: string; laps: number }
  | { type: 'driverChange'; et: number; slot: number; vehicle: string; oldName: string; newName: string }
  | { type: 'sent'; et: number; text: string }
  | { type: 'chat'; et: number; text: string };

export interface ResultsHeader {
  trackVenue: string;
  trackCourse: string;
  trackEvent: string;
  /** Metres. */
  trackLength: number;
  gameVersion: string;
  /** `Multiplayer` / `Offline`. */
  setting: string;
  /** The event's `<DateTime>`, unix seconds. */
  eventDateTime: number;
}

export interface ResultsSession {
  header: ResultsHeader;
  sessionType: ResultsSessionType;
  /** The session element's own name: `Race`, `Qualify`, `Practice1`… */
  sessionTag: string;
  /**
   * The session's `<DateTime>`, unix seconds: when this PC's session clock read
   * zero, or the moment it joined, for a mid-race join.
   */
  startedAt: number;
  minutes: number;
  drivers: ResultsDriver[];
  /** Every stream row in file order, TrackLimits doubles removed. */
  stream: StreamEntry[];
  /** `et` of the green flag: the earliest lap-1 start. Null with no laps. */
  raceStartEt: number | null;
  /** `et` of the first stream row; far above zero on a mid-race join. */
  firstStreamEt: number | null;
  /** Largest `et` anywhere in the file. */
  lastEt: number;
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The position LMU writes on a back-filled lap. Every one of the ~46 000
 * back-filled laps on disk reads 105 with `topspeed="0.00"`; either marks it.
 */
export const BACKFILL_POSITION = 105;

/**
 * How close a lap's start `et` (4 decimals) and a stream crossing (3 decimals)
 * must be to be the same crossing, seconds. Rounding alone accounts for 0.0005.
 */
const CROSSING_MATCH_S = 0.002;

/* -------------------------------------------------------------------------- */
/*  Low-level scanning                                                        */
/* -------------------------------------------------------------------------- */

const NAMED_ENTITIES: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" };

/** Decode the five XML entities and numeric references. Unknown ones stay as written. */
export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body] ?? m;
  });
}

function attrsOf(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([A-Za-z_][\w.-]*)="([^"]*)"/g)) out[m[1]!] = decodeEntities(m[2]!);
  return out;
}

/** First `<tag>value</tag>` inside `block`, decoded; `''` when absent. */
function tagText(block: string, tag: string): string {
  const i = block.indexOf(`<${tag}>`);
  if (i < 0) return '';
  const j = block.indexOf(`</${tag}>`, i);
  if (j < 0) return '';
  return decodeEntities(block.slice(i + tag.length + 2, j)).trim();
}

function num(s: string | undefined): number | null {
  if (s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function int(s: string | undefined): number | null {
  const n = num(s);
  return n === null ? null : Math.trunc(n);
}

/**
 * One attribute's raw value, by name. `raw` starts with a space. A lap carries
 * twenty-odd attributes and a four-hour race ~6 000 laps; picking out the
 * eight read here beats building a map of all of them by about 2×.
 */
function attr(raw: string, name: string): string | undefined {
  const key = ` ${name}="`;
  const i = raw.indexOf(key);
  if (i < 0) return undefined;
  const j = raw.indexOf('"', i + key.length);
  return j < 0 ? undefined : raw.slice(i + key.length, j);
}

/** `Name(12)` → name + slot. Greedy, so a name containing brackets survives. */
const NAME_SLOT = /^(.*)\((\d+)\)$/;

/* -------------------------------------------------------------------------- */
/*  Stream rows                                                               */
/* -------------------------------------------------------------------------- */

const RE_INCIDENT = /^(.*)\((\d+)\) reported contact \(([-\d.]+)\) with (?:another vehicle (.*)\((\d+)\)|(.*))$/;
const RE_SCORE = /^(.*)\((\d+)\) lap=(\d+) point=(\d+) t=([-\d.]+) et=([-\d.]+)$/;
const RE_CHECKERED = /^Checkered for (.*), laps=(\d+)\//;
const RE_DAMAGE = /^(.*)\((\d+)\) reports new (\w+) damage$/;
const RE_SERVED = /^(.*) served \d+(?:st|nd|rd|th) (.+?) penalty/;
const RE_CONVERTED = /^(.*) finished before serving penalty, added ([\d.]+) seconds/;
const RE_DRIVER_CHANGE = /^Slot=(\d+) Vehicle="(.*)" Old="(.*)" New="(.*)"$/;

function parseStreamRow(tag: string, rawAttrs: string, text: string): StreamEntry | null {
  // Most rows are Score lines whose only attribute is `et`; the full map is
  // built only for the rows that carry more.
  const et = num(attr(rawAttrs, 'et'));
  let parsed: Record<string, string> | null = null;
  const A = (): Record<string, string> => (parsed ??= attrsOf(rawAttrs));
  if (et === null) return null;
  switch (tag) {
    case 'Incident': {
      const m = RE_INCIDENT.exec(text);
      if (!m) return null;
      const magnitude = Number(m[3]);
      if (!Number.isFinite(magnitude)) return null;
      const isCar = m[4] !== undefined;
      return {
        type: 'incident',
        et,
        name: m[1]!.trim(),
        slot: Number(m[2]),
        magnitude,
        otherName: isCar ? m[4]!.trim() : null,
        otherSlot: isCar ? Number(m[5]) : null,
        object: isCar ? null : (m[6] ?? '').trim() || null,
      };
    }
    case 'TrackLimits': {
      const slot = int(A().ID);
      if (slot === null) return null;
      return {
        type: 'limits',
        et,
        name: (A().Driver ?? '').trim(),
        slot,
        lap: int(A().Lap) ?? 0,
        warningPoints: num(A().WarningPoints) ?? 0,
        currentPoints: num(A().CurrentPoints) ?? 0,
        resolution: int(A().Resolution) ?? -1,
        verdict: text,
      };
    }
    case 'Penalty': {
      const slot = int(A().ID);
      const penalty = A().Penalty;
      if (slot !== null && penalty !== undefined) {
        return {
          type: 'penalty',
          et,
          action: 'given',
          name: (A().Driver ?? '').trim(),
          slot,
          penalty,
          seconds: num(A().Time) ?? 0,
          reason: (A().Reason ?? '').trim(),
        };
      }
      const served = RE_SERVED.exec(text);
      if (served) return { type: 'penalty', et, action: 'served', name: served[1]!.trim(), penalty: served[2]! };
      const conv = RE_CONVERTED.exec(text);
      if (conv) return { type: 'penalty', et, action: 'converted', name: conv[1]!.trim(), seconds: Number(conv[2]) };
      return { type: 'penalty', et, action: 'other', text };
    }
    case 'Sector': {
      const dmg = RE_DAMAGE.exec(text);
      if (dmg) return { type: 'sector', et, name: dmg[1]!.trim(), slot: Number(dmg[2]), damage: dmg[3]!, text };
      const slot = int(A().ID);
      const ns = NAME_SLOT.exec(text.replace(/ set new best.*$/, ''));
      const s = slot ?? (ns ? Number(ns[2]) : null);
      if (s === null) return null;
      return { type: 'sector', et, name: (A().Driver ?? ns?.[1] ?? '').trim(), slot: s, damage: null, text };
    }
    case 'Score': {
      const m = RE_SCORE.exec(text);
      if (m) {
        const t = Number(m[5]);
        return {
          type: 'score',
          et,
          name: m[1]!.trim(),
          slot: Number(m[2]),
          lap: Number(m[3]),
          point: Number(m[4]),
          t: t < 0 || !Number.isFinite(t) ? null : t,
          atEt: Number(m[6]),
        };
      }
      const c = RE_CHECKERED.exec(text);
      if (c) return { type: 'checkered', et, name: c[1]!.trim(), laps: Number(c[2]) };
      return null;
    }
    case 'DriverChange': {
      const m = RE_DRIVER_CHANGE.exec(text);
      if (!m) return null;
      return { type: 'driverChange', et, slot: Number(m[1]), vehicle: m[2]!, oldName: m[3]!.trim(), newName: m[4]!.trim() };
    }
    case 'Sent':
      return { type: 'sent', et, text };
    case 'ChatMessage':
      return { type: 'chat', et, text };
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Drivers                                                                   */
/* -------------------------------------------------------------------------- */

function parseLap(attrRaw: string, text: string): ResultsLap | null {
  const raw = ` ${attrRaw}`;
  const n = int(attr(raw, 'num'));
  const et = num(attr(raw, 'et'));
  if (n === null || et === null) return null;
  const p = int(attr(raw, 'p'));
  const ts = attr(raw, 'topspeed');
  const topSpeed = num(ts) ?? 0;
  const backfilled = p === BACKFILL_POSITION || (topSpeed === 0 && ts !== undefined);
  const t = num(text.trim());
  return {
    num: n,
    p: backfilled ? null : p,
    et,
    s1: num(attr(raw, 's1')),
    s2: num(attr(raw, 's2')),
    s3: num(attr(raw, 's3')),
    lapTime: t !== null && t > 0 ? t : null,
    pit: attr(raw, 'pit') === '1',
    topSpeed,
    backfilled,
  };
}

function parseDriver(block: string): ResultsDriver | null {
  // The simple `<Tag>value</Tag>` children in one pass: the block is mostly
  // `<Lap>` lines, and eighteen separate searches through them added up.
  const tags = new Map<string, string>();
  for (const m of block.matchAll(/<(\w+)>([^<]*)<\/\1>/g)) {
    if (!tags.has(m[1]!)) tags.set(m[1]!, decodeEntities(m[2]!).trim());
  }
  const T = (tag: string): string => tags.get(tag) ?? '';
  const name = T('Name');
  if (!name) return null;
  const lapList: ResultsLap[] = [];
  for (const m of block.matchAll(/<Lap\s([^>]*)>([^<]*)<\/Lap>/g)) {
    const lap = parseLap(m[1]!, m[2]!);
    if (lap) lapList.push(lap);
  }
  lapList.sort((x, y) => x.num - y.num);
  const swaps: ResultsSwap[] = [];
  for (const m of block.matchAll(/<Swap\s([^>]*)>([^<]*)<\/Swap>/g)) {
    const a = attrsOf(m[1]!);
    swaps.push({ startLap: int(a.startLap) ?? 0, endLap: int(a.endLap) ?? 0, name: decodeEntities(m[2]!).trim() });
  }
  return {
    name,
    slot: null,
    carNumber: T('CarNumber'),
    carClass: T('CarClass'),
    vehicle: T('VehName'),
    carType: T('CarType'),
    team: T('TeamName'),
    gridPos: int(T('GridPos')),
    classGridPos: int(T('ClassGridPos')),
    position: int(T('Position')),
    classPosition: int(T('ClassPosition')),
    finishStatus: T('FinishStatus'),
    dnfReason: T('DNFReason'),
    laps: int(T('Laps')) ?? lapList.length,
    pitstops: int(T('Pitstops')) ?? 0,
    bestLapTime: num(T('BestLapTime')),
    finishTime: num(T('FinishTime')),
    swaps,
    lapList,
  };
}

/**
 * Tie each `<Driver>` block to its slot. The block has no slot field, so two
 * independent keys are tried, strongest first:
 *
 * 1. **Crossing times.** Lap N+1's start `et` is the stream's own `lap=N
 *    point=0` crossing for that slot, to the millisecond. Two cars crossing
 *    within 2 ms of each other on the same lap is the only way this can be
 *    fooled, so the slot with the most matches wins. It needs no names, so
 *    swaps, renames and duplicate names cannot confuse it.
 * 2. **Names**, for a car with no timed crossings (retired on lap 1, joined
 *    and left): every name the block lists (`<Name>` plus `<Swap>`), looked up
 *    against every `Name(n)`, `ID=` and `DriverChange` in the stream. Only an
 *    unambiguous answer is taken.
 *
 * A slot claimed twice keeps its stronger claim; the other block reads null.
 */
function assignSlots(drivers: ResultsDriver[], stream: StreamEntry[]): void {
  const crossings = new Map<number, number[]>(); // rounded ms → slots
  const nameSlots = new Map<string, Set<number>>();
  const addName = (n: string, slot: number) => {
    const k = n.trim().toLowerCase();
    if (!k) return;
    let s = nameSlots.get(k);
    if (!s) nameSlots.set(k, (s = new Set()));
    s.add(slot);
  };
  for (const e of stream) {
    switch (e.type) {
      case 'score':
        if (e.point === 0) {
          const k = Math.round(e.atEt * 1000);
          const list = crossings.get(k);
          if (list) list.push(e.slot);
          else crossings.set(k, [e.slot]);
        }
        addName(e.name, e.slot);
        break;
      case 'incident':
        addName(e.name, e.slot);
        if (e.otherName !== null && e.otherSlot !== null) addName(e.otherName, e.otherSlot);
        break;
      case 'limits':
      case 'sector':
        addName(e.name, e.slot);
        break;
      case 'penalty':
        if (e.action === 'given') addName(e.name, e.slot);
        break;
      case 'driverChange':
        addName(e.oldName, e.slot);
        addName(e.newName, e.slot);
        break;
      default:
        break;
    }
  }

  const tol = Math.round(CROSSING_MATCH_S * 1000);
  const claims: { d: ResultsDriver; slot: number; strength: number }[] = [];
  for (const d of drivers) {
    const votes = new Map<number, number>();
    for (const lap of d.lapList) {
      if (lap.num < 2) continue;
      const k = Math.round(lap.et * 1000);
      const seen = new Set<number>();
      for (let dk = -tol; dk <= tol; dk++) {
        for (const s of crossings.get(k + dk) ?? []) seen.add(s);
      }
      for (const s of seen) votes.set(s, (votes.get(s) ?? 0) + 1);
    }
    let best: number | null = null;
    let bestN = 0;
    for (const [s, n] of votes) {
      if (n > bestN) {
        best = s;
        bestN = n;
      }
    }
    if (best !== null) {
      claims.push({ d, slot: best, strength: 1000 + bestN });
      continue;
    }
    const names = [d.name, ...d.swaps.map((s) => s.name)];
    const cands = new Set<number>();
    for (const n of names) for (const s of nameSlots.get(n.trim().toLowerCase()) ?? []) cands.add(s);
    if (cands.size === 1) claims.push({ d, slot: [...cands][0]!, strength: 1 });
  }
  claims.sort((a, b) => b.strength - a.strength);
  const taken = new Set<number>();
  for (const c of claims) {
    if (taken.has(c.slot)) continue;
    taken.add(c.slot);
    c.d.slot = c.slot;
  }
}

/* -------------------------------------------------------------------------- */
/*  Entry point                                                               */
/* -------------------------------------------------------------------------- */

const SESSION_TAG = /<(Race\d*|Qualify\d*|Practice\d*|Warmup)>\s*<DateTime>/;

function sessionTypeOf(tag: string): ResultsSessionType {
  if (tag.startsWith('Race')) return 'race';
  if (tag.startsWith('Qualify')) return 'qualify';
  if (tag.startsWith('Warmup')) return 'warmup';
  return 'practice';
}

/**
 * Parse one results file. Returns null for anything that is not a complete
 * LMU/rF2 results file, and never throws.
 */
export function parseResultsXml(text: string): ResultsSession | null {
  const it = parseResultsSteps(text);
  for (;;) {
    const step = it.next();
    if (step.done) return step.value;
  }
}

/** Stream rows parsed between two of {@link parseResultsSteps}' yields. */
const ROWS_PER_STEP = 1024;

/**
 * {@link parseResultsXml} as steps: it yields every {@link ROWS_PER_STEP}
 * stream rows and after every driver block, so a caller on Electron's main
 * process can hand the event loop back. The largest race on Carl's PC (5.2 MB,
 * 29 000 stream rows) takes 40–57 ms to parse, too long for one turn of the
 * process that also runs the overlays. Never throws.
 */
export function* parseResultsSteps(text: string): Generator<void, ResultsSession | null, void> {
  try {
    return yield* parseUnsafe(text);
  } catch {
    return null;
  }
}

function* parseUnsafe(text: string): Generator<void, ResultsSession | null, void> {
  if (typeof text !== 'string' || text.indexOf('<RaceResults>') < 0) return null;
  if (text.lastIndexOf('</RaceResults>') < 0) return null; // cut short mid-write
  const sm = SESSION_TAG.exec(text);
  if (!sm) return null;
  const sessionTag = sm[1]!;
  const sStart = sm.index;
  const sEnd = text.indexOf(`</${sessionTag}>`, sStart);
  if (sEnd < 0) return null;
  const head = text.slice(0, sStart);
  const body = text.slice(sStart, sEnd);

  const header: ResultsHeader = {
    trackVenue: tagText(head, 'TrackVenue'),
    trackCourse: tagText(head, 'TrackCourse'),
    trackEvent: tagText(head, 'TrackEvent'),
    trackLength: num(tagText(head, 'TrackLength')) ?? 0,
    gameVersion: tagText(head, 'GameVersion'),
    setting: tagText(head, 'Setting'),
    eventDateTime: int(tagText(head, 'DateTime')) ?? 0,
  };
  const startedAt = int(tagText(body, 'DateTime'));
  if (startedAt === null) return null;

  // The stream: flat rows, one per line.
  const stream: StreamEntry[] = [];
  let lastEt = 0;
  let firstStreamEt: number | null = null;
  const si = body.indexOf('<Stream>');
  const se = si < 0 ? -1 : body.indexOf('</Stream>', si);
  if (si >= 0 && se > si) {
    const seenLimits = new Set<string>();
    const streamText = body.slice(si + 8, se);
    let rows = 0;
    for (const m of streamText.matchAll(/<(\w+)((?:\s[^>]*)?)>([^<]*)<\/\1>/g)) {
      if (++rows % ROWS_PER_STEP === 0) yield;
      const tag = m[1]!;
      if (tag === 'TrackLimits') {
        const key = m[0];
        if (seenLimits.has(key)) continue;
        seenLimits.add(key);
      }
      const row = parseStreamRow(tag, m[2] ?? '', decodeEntities(m[3]!).trim());
      if (!row) continue;
      stream.push(row);
      if (firstStreamEt === null || row.et < firstStreamEt) firstStreamEt = row.et;
      if (row.et > lastEt) lastEt = row.et;
      if (row.type === 'score' && row.atEt > lastEt) lastEt = row.atEt;
    }
  }

  // Drivers.
  const drivers: ResultsDriver[] = [];
  let di = body.indexOf('<Driver>', se > 0 ? se : 0);
  while (di >= 0) {
    const dj = body.indexOf('</Driver>', di);
    if (dj < 0) return null;
    const d = parseDriver(body.slice(di, dj));
    if (d) drivers.push(d);
    di = body.indexOf('<Driver>', dj);
    yield;
  }

  let raceStartEt: number | null = null;
  for (const d of drivers) {
    for (const lap of d.lapList) {
      const end = lap.et + (lap.lapTime ?? 0);
      if (end > lastEt) lastEt = end;
      if (lap.num === 1 && (raceStartEt === null || lap.et < raceStartEt)) raceStartEt = lap.et;
    }
  }

  assignSlots(drivers, stream);

  return {
    header,
    sessionType: sessionTypeOf(sessionTag),
    sessionTag,
    startedAt,
    minutes: int(tagText(body, 'Minutes')) ?? 0,
    drivers,
    stream,
    raceStartEt,
    firstStreamEt,
    lastEt,
  };
}

/** The driver block for a slot, or undefined. */
export function driverOfSlot(s: ResultsSession, slot: number): ResultsDriver | undefined {
  return s.drivers.find((d) => d.slot === slot);
}
