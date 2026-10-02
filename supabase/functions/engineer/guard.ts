// engineer/guard.ts — the number guard, and the lap-clock formatting either side
// of the model.
// -----------------------------------------------------------------------------
// Pure functions, no Deno APIs: `scripts/test-engineer-guard.js` transpiles
// this file and runs it under Node, so what the test checks is what deploys.
//
// WHY A GUARD (2026-10-02). The late-September call log had the model answer
// questions about cars it had no data for with a neighbour's figure:
//   "what is the pace of P5?"         → "P5 is doing 79.4 seconds." (79.4 was
//                                        the Competitive pace TARGET)
//   "gap to P10."                     → "twenty point nine seconds" (the gap to
//                                        the car directly ahead, P15)
//   "update me on class leaders times" → "9.4 behind the leader, who just did
//                                        an 81.9" (both were P2's numbers)
// Every one of those figures WAS in the summary, so "is this number in the
// payload?" alone catches none of them. The guard therefore scopes: when the
// question names a car (P5, the leader, car 7, a surname), the figures spoken
// must come from THAT car's data — its timing-sheet row, the leader block, or
// the ahead/behind block when that is the same car — plus the question and the
// previous exchange. Only a question about the driver's own car (my, I, …)
// widens the pool to the driver's own lap, gap and sector figures.
//
// What it does NOT do: judge routing ("so on." answered with a readout), the
// class-vs-overall position mix-up, or rounding style. Those are prompt work.
// It also accepts any figure in the pool, so a right number attributed to the
// wrong field of the SAME car slips through — the scope is the car, not the
// field.

/* -------------------------------------------------------------------------- */
/*  Lap clock                                                                 */
/* -------------------------------------------------------------------------- */

/** 106.42 → "1:46.4". Sub-minute values are not lap-clock material: null. */
export function lapClock(sec: number): string | null {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 60) return null;
  const tenths = Math.round(sec * 10);
  const m = Math.floor(tenths / 600);
  const rest = (tenths - m * 600) / 10;
  return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}

/** Top-level summary keys that hold a lap time in seconds. */
const LAP_KEYS = new Set([
  'lastLapSec',
  'bestLapSec',
  'myAvgLapSec',
  'paceBestLapSec',
  'paceAlienRaceSec',
  'paceAlienHotlapSec',
  'paceCompetitiveSec',
  'paceMidpackSec',
]);
/** Keys inside ahead / behind / classLeader that hold a lap time. */
const CAR_LAP_KEYS = new Set(['lastLapSec', 'bestLapSec', 'avgLapSec']);
/** Keys inside a classStandings row that hold a lap time. */
const ROW_LAP_KEYS = new Set(['last', 'best', 'avg']);

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clockKeys(obj: Json, keys: Set<string>): Json {
  const out: Json = { ...obj };
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (keys.has(k) && typeof v === 'number') {
      const c = lapClock(v);
      if (c) out[k] = c;
    }
  }
  return out;
}

/**
 * The model's view of the summary: every lap time of a minute or more as an
 * "m:ss.s" string. gpt-4o-mini turned 106.4 into "one oh six point four" (a
 * 1:46.4) despite a v12 rule saying otherwise; a model reads "1:46.4" right
 * every time. Done HERE rather than in the app so every installed version
 * benefits on deploy. The logged row keeps the app's raw seconds.
 */
export function clockify(summary: Json): Json {
  const out = clockKeys(summary, LAP_KEYS);
  for (const k of ['ahead', 'behind', 'classLeader']) {
    if (isObj(out[k])) out[k] = clockKeys(out[k] as Json, CAR_LAP_KEYS);
  }
  if (Array.isArray(out.classStandings)) {
    out.classStandings = (out.classStandings as unknown[]).map((r) =>
      isObj(r) ? clockKeys(r, ROW_LAP_KEYS) : r,
    );
  }
  return out;
}

/**
 * The answer as Piper should hear it: "1:46.4" → "1 46.4", "1:03.4" →
 * "1 oh 3.4" — exactly the shape Tier 1's speakableLapTime writes, which Piper
 * reads as "one forty-six point four". The model writes the colon form because
 * that is what the guard (and a human reading the log) can parse.
 */
export function speakable(answer: string): string {
  return String(answer || '').replace(/\b(\d{1,2}):([0-5]\d)(\.\d+)?\b/g, (_m, min, ss, frac) => {
    const sec = `${ss}${frac || ''}`;
    return ss[0] === '0' ? `${min} oh ${sec.slice(1)}` : `${min} ${sec}`;
  });
}

/* -------------------------------------------------------------------------- */
/*  Numbers in text                                                           */
/* -------------------------------------------------------------------------- */

/** One figure read out of the answer: the value, its decimal places. */
interface Figure {
  value: number;
  decimals: number;
}

/**
 * One spoken quantity with its readings. "one twenty-two point three" is 122.3
 * or 1:22.3 (82.3); it is supported when ANY reading is fully supported.
 */
interface Spoken {
  text: string;
  readings: Figure[][];
  /** Position labels (P5) are checked against every position in the data. */
  kind: 'figure' | 'position';
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

function isNumberWord(w: string): boolean {
  return w in UNITS || w in TEENS || w in TENS || w === 'hundred' || w === 'point' || w === 'oh';
}

function decimalsOf(s: string): number {
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/**
 * Parse one run of number words. Returns null for a run that is not a number
 * (a lone "oh").
 */
function parseWordRun(words: string[]): Figure[][] | null {
  const groups: number[] = [];
  let decimals = '';
  let minutesAt = -1;
  let hundredPending = false;
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (w === 'point') {
      i++;
      while (i < words.length && (words[i]! in UNITS || words[i] === 'oh')) {
        decimals += words[i] === 'oh' ? '0' : String(UNITS[words[i]!]);
        i++;
      }
      break;
    }
    if (w === 'minute' || w === 'minutes') {
      minutesAt = groups.length;
      i++;
      continue;
    }
    if (w === 'and') {
      i++;
      continue;
    }
    if (w === 'hundred') {
      if (groups.length) {
        groups[groups.length - 1]! *= 100;
        hundredPending = true;
      }
      i++;
      continue;
    }
    let g: number | null = null;
    if (w in TENS) {
      g = TENS[w]!;
      const nx = words[i + 1];
      if (nx && nx in UNITS && UNITS[nx]! > 0) {
        g += UNITS[nx]!;
        i++;
      }
    } else if (w in TEENS) g = TEENS[w]!;
    else if (w in UNITS) g = UNITS[w]!;
    else if (w === 'oh') {
      const nx = words[i + 1];
      if (!groups.length || !nx || !(nx in UNITS)) {
        i++;
        continue; // "Oh," — an interjection, not a zero
      }
      g = UNITS[nx]!;
      i++;
    }
    i++;
    if (g === null) continue;
    if (hundredPending && groups.length) {
      groups[groups.length - 1]! += g;
      hundredPending = false;
    } else groups.push(g);
  }
  if (!groups.length) return null;
  const frac = decimals ? Number(`0.${decimals}`) : 0;
  const d = decimals.length;
  const fig = (v: number, withFrac: boolean): Figure =>
    withFrac ? { value: v + frac, decimals: d } : { value: v, decimals: 0 };
  const readings: Figure[][] = [];
  if (minutesAt > 0 && groups.length === minutesAt + 1) {
    readings.push([fig(groups[0]! * 60 + groups[minutesAt]!, true)]);
  }
  if (groups.length === 1) readings.push([fig(groups[0]!, true)]);
  if (groups.length === 2) {
    const [a, b] = groups as [number, number];
    if (b < 100) readings.push([fig(a * 100 + b, true)]); // "one oh six" = 106
    if (b < 60) readings.push([fig(a * 60 + b, true)]); // "one twenty-two" = 1:22
  }
  if (groups.length >= 2) {
    // Separate quantities ("two cars, three laps" read as one run).
    readings.push(groups.map((g, k) => fig(g, k === groups.length - 1)));
  }
  return readings;
}

const ORDINAL_WORDS = new Set([
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth',
  'eighteenth', 'nineteenth', 'twentieth',
]);

/** Every quantity the answer speaks, digits and words alike. */
export function spokenFigures(answer: string): Spoken[] {
  let text = ` ${String(answer || '')} `;
  const out: Spoken[] = [];
  const blank = (s: string) => ' '.repeat(s.length);

  // 1. Lap clock "1:46.4".
  text = text.replace(/\b(\d{1,2}):([0-5]\d(?:\.\d+)?)\b/g, (m, min, ss) => {
    out.push({ text: m, kind: 'figure', readings: [[{ value: Number(min) * 60 + Number(ss), decimals: decimalsOf(ss) }]] });
    return blank(m);
  });
  // 2. Tier 1's spoken clock "1 46.4" / "1 oh 3.4" (it arrives in `previous`).
  text = text.replace(/\b(\d) (oh )?(\d{1,2}\.\d)\b/g, (m, min, oh, ss) => {
    const s = Number(ss);
    const readings: Figure[][] = [[{ value: Number(min), decimals: 0 }, { value: s, decimals: decimalsOf(ss) }]];
    if (s < 60 && (!!oh || s >= 10)) readings.unshift([{ value: Number(min) * 60 + s, decimals: decimalsOf(ss) }]);
    out.push({ text: m, kind: 'figure', readings });
    return blank(m);
  });
  // 3. Labels: P5 / P 5 / position 5 are positions; S1 / sector 1 / turn 3
  //    and ordinals (5th) name things rather than measure them.
  text = text.replace(/\b(?:p|pos(?:ition)?)\s?(\d{1,2})\b/gi, (m, n) => {
    out.push({ text: m, kind: 'position', readings: [[{ value: Number(n), decimals: 0 }]] });
    return blank(m);
  });
  // "S1"/"T3" only unspaced: "it's 3 laps" must keep its 3.
  // The lookahead keeps a decimal whole: in "sector 1 and 1.1 in sector 2"
  // the 1.1 is a figure, not a second sector label.
  text = text.replace(/\b(?:[st]\d{1,2}|(?:sectors?|turn)\s\d{1,2}(?:\s*(?:and|,|&)\s*\d{1,2})?)\b(?!\.\d)/gi, blank);
  text = text.replace(/\b(?:sectors?|turn)\s(?:one|two|three)(?:\s*(?:and|,|&)\s*(?:one|two|three))?\b/gi, blank);
  text = text.replace(/\b\d{1,3}(?:st|nd|rd|th)\b/gi, blank);
  // 4. Plain digits.
  text = text.replace(/\d+(?:,\d{3})*(?:\.\d+)?/g, (m) => {
    const clean = m.replace(/,/g, '');
    out.push({ text: m, kind: 'figure', readings: [[{ value: Number(clean), decimals: decimalsOf(clean) }]] });
    return blank(m);
  });
  // 5. Number words. Runs break on anything that is not a number word.
  const words = text.toLowerCase().replace(/-/g, ' ').split(/[^a-z]+/).filter(Boolean);
  let run: string[] = [];
  const flush = () => {
    if (run.length) {
      const readings = parseWordRun(run);
      if (readings) out.push({ text: run.join(' '), kind: 'figure', readings });
    }
    run = [];
  };
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!;
    if (ORDINAL_WORDS.has(w)) {
      flush();
      continue;
    }
    const inRun = run.length > 0;
    if (isNumberWord(w) || (inRun && (w === 'minute' || w === 'minutes' || (w === 'and' && run.includes('hundred'))))) {
      if (w === 'oh' && !inRun) continue; // a sentence-opening "Oh"
      run.push(w);
    } else flush();
  }
  flush();
  return out;
}

/* -------------------------------------------------------------------------- */
/*  The pool of figures an answer may use                                     */
/* -------------------------------------------------------------------------- */

/** Every number in a value: numbers, numeric strings, "1:46.4" clocks inside strings. */
function collect(v: unknown, into: number[]): number[] {
  if (typeof v === 'number' && Number.isFinite(v)) into.push(Math.abs(v));
  else if (typeof v === 'string') {
    for (const s of spokenFigures(v)) {
      for (const r of s.readings) for (const f of r) into.push(Math.abs(f.value));
    }
  } else if (Array.isArray(v)) for (const x of v) collect(x, into);
  else if (isObj(v)) for (const x of Object.values(v)) collect(x, into);
  return into;
}

function supported(f: Figure, pool: number[]): boolean {
  const tol = 0.5 * Math.pow(10, -f.decimals) + 1e-6;
  const v = Math.abs(f.value);
  return pool.some((p) => Math.abs(p - v) <= tol);
}

export interface Target {
  kind: 'pos' | 'name' | 'car';
  pos?: number;
  name?: string;
  car?: string;
  /** "overall P5": the timing sheet is class-ordered, so it cannot resolve. */
  overall?: boolean;
  label: string;
}

const WORD_NUM: Record<string, number> = { ...UNITS, ...TEENS, twenty: 20 };

/**
 * Display names that are also ordinary radio words. A real driver row was
 * named "Racing" on 2026-09-27; "how's the racing?" must not scope to him.
 */
const NAME_STOPWORDS = new Set([
  'racing', 'race', 'team', 'driver', 'the', 'car', 'cars', 'pit', 'pits', 'box', 'fuel', 'leader', 'gap',
  'ahead', 'behind', 'lap', 'laps', 'pace', 'best', 'last', 'class', 'sector', 'tyre', 'tyres', 'tire',
  'tires', 'time', 'times', 'position', 'front', 'back', 'you', 'me', 'him', 'player', 'guest', 'motorsport',
]);

function namesIn(summary: Json): string[] {
  const names: string[] = [];
  const add = (n: unknown) => {
    if (typeof n !== 'string') return;
    const s = n.trim().toLowerCase();
    if (s.length >= 3 && !NAME_STOPWORDS.has(s)) names.push(s);
  };
  for (const k of ['ahead', 'behind', 'classLeader']) if (isObj(summary[k])) add((summary[k] as Json).name);
  if (Array.isArray(summary.classStandings)) {
    for (const r of summary.classStandings as unknown[]) if (isObj(r) && !r.me) add(r.name);
  }
  return [...new Set(names)];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The cars a question asks about, by position, number or name. */
export function questionTargets(question: string, summary: Json): Target[] {
  const q = ` ${String(question || '').toLowerCase()} `;
  const overall = /\boverall\b/.test(q);
  const out: Target[] = [];
  const pos = (n: number) => {
    if (n >= 1 && n <= 99 && !out.some((t) => t.kind === 'pos' && t.pos === n)) {
      out.push({ kind: 'pos', pos: n, overall, label: `P${n}` });
    }
  };
  for (const m of q.matchAll(/\b(?:p|pos(?:ition)?)\s?(\d{1,2})\b/g)) pos(Number(m[1]));
  for (const m of q.matchAll(/\b(?:p|position)\s(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/g)) {
    pos(WORD_NUM[m[1]!]!);
  }
  if (/\b(?:class )?leaders?\b|\bleading\b|\bfirst place\b/.test(q)) {
    if (!out.some((t) => t.kind === 'pos' && t.pos === 1)) out.push({ kind: 'pos', pos: 1, label: 'the leader' });
  }
  for (const m of q.matchAll(/(?:\bcar|\bnumber|#)\s?(\d{1,3})\b/g)) {
    out.push({ kind: 'car', car: m[1]!, label: `car ${m[1]}` });
  }
  for (const n of namesIn(summary)) {
    if (new RegExp(`\\b${escapeRe(n)}\\b`).test(q)) out.push({ kind: 'name', name: n, label: n });
  }
  return out;
}

/** "my", "I", "compared": the driver's own figures may join the answer. */
function selfReferenced(question: string): boolean {
  return /\b(my|mine|i|i'm|im|me and|than me|to me|from me|on me|compared|versus|vs|difference|delta)\b/i.test(question);
}

/** "that", "it", "him": a follow-up that inherits the previous question's cars. */
function followUp(question: string): boolean {
  return /\b(that|it|him|his|he|they|their|them|this|those|same|again|in minutes|in seconds)\b/i.test(question);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** The driver's own comparable figures: laps, gaps, sectors, positions. */
function ownPool(summary: Json): number[] {
  const pool: number[] = [];
  for (const k of [
    'position', 'classPosition', 'lastLapSec', 'bestLapSec', 'myAvgLapSec', 'myAvgLaps', 'myPitStops',
    'paceBestLapSec', 'lastSectorsSec', 'lastSectorsVsLeaderSec', 'classBestLastSectorsSec',
    'currentLap', 'lapsToFinish',
  ]) collect(summary[k], pool);
  if (Array.isArray(summary.classStandings)) {
    for (const r of summary.classStandings as unknown[]) if (isObj(r) && r.me) collect(r, pool);
  }
  return pool;
}

/**
 * Figures that belong to one target car. Null when the data has nothing on it
 * at all — the answer may then speak no figure about it beyond the question's.
 */
function targetPool(t: Target, summary: Json): { pool: number[]; isSelf: boolean; found: boolean } {
  const myClassPos = num(summary.classPosition);
  const rows = Array.isArray(summary.classStandings)
    ? (summary.classStandings as unknown[]).filter(isObj)
    : [];
  const pool: number[] = [];
  let found = false;
  const take = (v: unknown) => {
    found = true;
    collect(v, pool);
  };
  if (t.kind === 'pos' && t.pos !== undefined) {
    pool.push(t.pos);
    if (t.overall) {
      return { pool, isSelf: num(summary.position) === t.pos, found: false };
    }
    if (myClassPos === t.pos) return { pool, isSelf: true, found: true };
    for (const r of rows) if (num(r.pos) === t.pos) take(r);
    if (t.pos === 1 && isObj(summary.classLeader)) {
      take(summary.classLeader);
      collect(summary.lastSectorsVsLeaderSec, pool);
    }
    if (myClassPos !== undefined && isObj(summary.ahead) && t.pos === myClassPos - 1) take(summary.ahead);
    if (myClassPos !== undefined && isObj(summary.behind) && t.pos === myClassPos + 1) take(summary.behind);
  } else if (t.kind === 'car' && t.car) {
    pool.push(Number(t.car));
    for (const r of rows) if (String(r.car ?? '') === t.car) take(r);
  } else if (t.kind === 'name' && t.name) {
    const is = (o: unknown) => isObj(o) && String(o.name ?? '').toLowerCase() === t.name;
    for (const r of rows) if (is(r)) take(r);
    for (const k of ['ahead', 'behind', 'classLeader']) if (is(summary[k])) take(summary[k]);
    if (is(summary.classLeader)) collect(summary.lastSectorsVsLeaderSec, pool);
  }
  return { pool, isSelf: false, found };
}

export interface GuardInput {
  question: string;
  answer: string;
  /** The summary the MODEL saw (clockified). */
  summary: Json;
  previous?: { question: string; answer: string } | null;
}

export interface GuardVerdict {
  ok: boolean;
  /** The spoken figures that had no source, as written in the answer. */
  unsupported: string[];
  /** The cars the question was scoped to ([] = the whole summary). */
  targets: string[];
  /** True when a named car had no data at all. */
  missingTarget: boolean;
}

/**
 * Does every figure in the answer have a source? See the file header for the
 * scoping rule. Figures 0 and 1 are always allowed ("one lap", "no stops").
 */
export function guardAnswer(input: GuardInput): GuardVerdict {
  const summary = isObj(input.summary) ? input.summary : {};
  const question = String(input.question || '');
  const prev = input.previous || null;
  let targets = questionTargets(question, summary);
  let inherited = false;
  if (!targets.length && prev && followUp(question)) {
    targets = questionTargets(prev.question, summary);
    inherited = targets.length > 0;
  }

  const base: number[] = [0, 1];
  collect(question, base);
  const prevNums: number[] = [];
  if (prev) {
    collect(prev.question, prevNums);
    collect(prev.answer, prevNums);
  }
  const everything = collect(summary, [...base, ...prevNums]);

  const scoped = targets.map((t) => ({ t, ...targetPool(t, summary) })).filter((x) => !x.isSelf);
  let pool: number[];
  if (!scoped.length) pool = everything;
  else {
    // The previous exchange's figures belong to its subject: usable when this
    // question follows up on it ("give me that in minutes"), not when it names
    // cars of its own (F8: "gap between P5 and P6" must not borrow the 0.9 the
    // last answer gave for the car ahead).
    pool = inherited ? [...base, ...prevNums] : base.slice();
    for (const s of scoped) pool.push(...s.pool);
    if (selfReferenced(question)) pool.push(...ownPool(summary));
  }

  const unsupported: string[] = [];
  for (const s of spokenFigures(input.answer)) {
    const p = s.kind === 'position' ? everything : pool;
    if (!s.readings.some((r) => r.every((f) => supported(f, p)))) unsupported.push(s.text.trim());
  }
  return {
    ok: unsupported.length === 0,
    unsupported,
    targets: scoped.map((s) => s.t.label),
    missingTarget: scoped.some((s) => !s.found),
  };
}

/**
 * The line spoken instead of an answer whose figures had no source. Names the
 * car when the question did, so it reads as an answer and not a fault; avoids
 * repeating the previous line word for word (v13's radio-stuck rule).
 */
export function noReadLine(verdict: GuardVerdict, previousAnswer?: string): string {
  const who = verdict.targets[0];
  const lines = who
    ? who === 'the leader'
      ? ["No timing on the leader from here, I'm afraid.", "I haven't got the leader's numbers right now."]
      : [`No timing on ${who} from here, I'm afraid.`, `I haven't got ${who}'s numbers right now.`]
    : ["No solid number on that, I'm afraid.", "I can't give you a reliable figure on that one."];
  const prev = String(previousAnswer || '').trim();
  return lines.find((l) => l !== prev) ?? lines[0]!;
}
