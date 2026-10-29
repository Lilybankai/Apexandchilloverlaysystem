// coach/validate.ts — what the model may say, checked before anyone reads it.
// -----------------------------------------------------------------------------
// Pure functions, no Deno APIs: `scripts/test-coachvalidate.js` transpiles this
// file with the repo's TypeScript and runs it under Node (the engineer guard's
// arrangement), so what the test checks is what deploys.
//
// THE RULE (2026-10-29, the AI driving coach). The app measures; the model only
// words and ranks. Every number a driver reads comes from a CoachFact the app
// computed, and the model may only CITE facts by id. So a reply is rejected when:
//
//   1. it is not the CoachAiResult shape (1–3 takeaways, short strings);
//   2. it cites a fact id the request did not hold, or names a corner (C7) that
//      no fact is about;
//   3. it types a number that is not in the text of a fact it cites (number
//      words too — "five metres" is a number);
//   4. its advice runs against a fact's sign — "brake later" in a corner where
//      the facts say the driver ALREADY brakes later than the target, "carry
//      more speed to the apex" where they are already faster there, "get on
//      the throttle sooner" where they already pick up earlier;
//   5. it talks about car setup, driver aids or the rules — the coach has no
//      facts about any of those, so anything said there is invented.
//
// A rejected reply gets ONE corrective retry (the reasons, as a user turn);
// a second failure answers ok:false and the app keeps its template words.

export interface CoachFactLite {
  id: string;
  cornerId?: string;
  kind: string;
  value: number;
  unit?: string;
  text: string;
}

export interface CoachAiResultLite {
  headline: string;
  takeaways: { title: string; body: string; factIds: string[]; cornerIds: string[] }[];
  sequences: { cornerIds: string[]; narrative: string; factIds: string[] }[];
}

export type CoachVerdict = { ok: true; result: CoachAiResultLite } | { ok: false; reasons: string[] };

export const LIMITS = {
  headline: 140,
  title: 80,
  body: 320,
  narrative: 280,
  takeaways: 3,
  sequences: 3,
} as const;

/** A difference below these is "the same", and no direction can contradict it. */
const BRAKE_M = 3;
const APEX_KPH = 1;
const PICKUP_M = 5;

/** The structured-output schema the model is asked for (CoachAiResult). */
export const COACH_JSON_SCHEMA = {
  name: 'coach_result',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['headline', 'takeaways', 'sequences'],
    properties: {
      headline: { type: 'string' },
      takeaways: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'body', 'factIds', 'cornerIds'],
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            factIds: { type: 'array', items: { type: 'string' } },
            cornerIds: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      sequences: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['cornerIds', 'narrative', 'factIds'],
          properties: {
            cornerIds: { type: 'array', items: { type: 'string' } },
            narrative: { type: 'string' },
            factIds: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
} as const;

/* -------------------------------------------------------------------------- */
/*  Reading the reply                                                         */
/* -------------------------------------------------------------------------- */

/** The model's text as JSON: code fences and any chatter around the object removed. */
export function parseReply(text: string): unknown {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1]!.trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/* -------------------------------------------------------------------------- */
/*  Numbers                                                                   */
/* -------------------------------------------------------------------------- */

const CORNER_RE = /\bC\d{1,3}\b/g;
const SECTOR_RE = /\bsector\s+([1-3])\b/gi;
const NUMBER_RE = /\d+(?:[.:,]\d+)*/g;
/**
 * Number words. "one" is left out on purpose — "treat them as one", "the one
 * that matters" — it is far likelier to be a pronoun than a figure.
 */
const NUMBER_WORDS =
  /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|dozen|tenths?|hundredths?|half a second|quarter of a second)\b/i;

/** The corners a text names. */
export function cornersIn(text: string): string[] {
  return (String(text).match(CORNER_RE) || []).map((c) => c.toUpperCase());
}

/** The figures in a text, corner ids and (allowed) sector numbers taken out first. */
export function figuresIn(text: string, sectors: ReadonlySet<string> = new Set()): string[] {
  const s = String(text)
    .replace(CORNER_RE, ' ')
    .replace(SECTOR_RE, (m, n: string) => (sectors.has(n) ? ' ' : m));
  return (s.match(NUMBER_RE) || []).map((x) => x.replace(/,/g, ''));
}

/* -------------------------------------------------------------------------- */
/*  Directions                                                                */
/* -------------------------------------------------------------------------- */

type Sign = -1 | 1;
interface Claim {
  kind: 'brakeDeltaM' | 'minKphDelta' | 'pickupDeltaM';
  /** The sign the claim implies the fact's value has. */
  sign: Sign;
  phrase: string;
}

const DESCRIBE_RE = /\b(you|you're|youre|you’re|are|were|is|was|been)\s*$/i;

/**
 * The directions a clause asserts or advises, each turned into the sign it
 * implies for the matching fact. Advice "brake later" implies the driver now
 * brakes EARLIER (brakeDeltaM < 0); a description "you brake later" or
 * "braking too late" implies LATER (> 0). Same for speed and throttle.
 */
export function claimsIn(clause: string): Claim[] {
  const out: Claim[] = [];
  const c = clause.toLowerCase();
  // Braking: "brake later", "braking point later", "you brake earlier", "braking too late".
  const brakeRe = /\b(brak\w*|brake point|braking point)\s+((?:[a-z’']+\s+){0,3}?)(earlier|sooner|early|later|late)\b/g;
  let m: RegExpExecArray | null;
  while ((m = brakeRe.exec(c))) {
    const before = c.slice(Math.max(0, m.index - 24), m.index);
    const later = m[3] === 'later' || m[3] === 'late';
    // "you brake later", "by braking early", "braking too late" describe;
    // "brake later", "try braking later" advise.
    const described = DESCRIBE_RE.test(before) || /\bby\s*$/.test(before) || /\btoo\b/.test(m[2] || '');
    // Described: the words say what the driver DOES. Advised: what to do instead.
    out.push({ kind: 'brakeDeltaM', sign: (described ? later : !later) ? 1 : -1, phrase: m[0] });
  }
  const laterOnBrakes = /\b(later|earlier)\s+(?:on|onto|into)\s+(?:the\s+)?brakes?\b/g;
  while ((m = laterOnBrakes.exec(c))) {
    out.push({ kind: 'brakeDeltaM', sign: m[1] === 'later' ? -1 : 1, phrase: m[0] });
  }
  // Apex speed: only phrases that are about the middle of the corner.
  const apexWords = /(apex|minimum|mid-corner|mid corner|middle|through the corner|into the corner)/;
  const moreSpeed = /\b(?:more|higher|extra)\s+(?:[a-z-]+\s+){0,2}?speed\b|\bcarry(?:ing)?\s+more\b|\btoo\s+slow\b|\bslower\s+(?:at|through|in)\b/g;
  while ((m = moreSpeed.exec(c))) {
    if (!apexWords.test(c)) continue;
    out.push({ kind: 'minKphDelta', sign: -1, phrase: m[0] });
  }
  const lessSpeed = /\b(?:less|lower)\s+(?:[a-z-]+\s+){0,2}?speed\b|\bcarry(?:ing)?\s+less\b|\btoo\s+(?:fast|much speed)\b|\bover-?speed\w*/g;
  while ((m = lessSpeed.exec(c))) {
    if (!apexWords.test(c)) continue;
    out.push({ kind: 'minKphDelta', sign: 1, phrase: m[0] });
  }
  // Throttle pick-up: "on the throttle sooner", "earlier on the power", "pick up the throttle earlier".
  const throttleSoon =
    /\b(?:throttle|power|gas|accelerat\w*)\s+(?:[a-z]+\s+){0,2}?(?:earlier|sooner)\b|\b(?:earlier|sooner)\s+(?:on|onto)\s+(?:the\s+)?(?:throttle|power|gas)\b/g;
  while ((m = throttleSoon.exec(c))) {
    const before = c.slice(Math.max(0, m.index - 24), m.index);
    out.push({ kind: 'pickupDeltaM', sign: DESCRIBE_RE.test(before) ? -1 : 1, phrase: m[0] });
  }
  const throttleLate =
    /\b(?:throttle|power|gas)\s+(?:[a-z]+\s+){0,2}?later\b|\blater\s+(?:on|onto)\s+(?:the\s+)?(?:throttle|power|gas)\b|\bwait\s+longer\s+(?:before|for)\s+(?:the\s+)?(?:throttle|power|gas)\b/g;
  while ((m = throttleLate.exec(c))) {
    const before = c.slice(Math.max(0, m.index - 24), m.index);
    out.push({ kind: 'pickupDeltaM', sign: DESCRIBE_RE.test(before) ? 1 : -1, phrase: m[0] });
  }
  return out;
}

const THRESHOLD: Record<Claim['kind'], number> = { brakeDeltaM: BRAKE_M, minKphDelta: APEX_KPH, pickupDeltaM: PICKUP_M };

/** Sentences, then clauses; a clause's corners are its own, else its sentence's, else the item's. */
function clausesOf(text: string, itemCorners: readonly string[]): { clause: string; corners: string[] }[] {
  const out: { clause: string; corners: string[] }[] = [];
  for (const sentence of String(text).split(/[.;!?]+/)) {
    if (!sentence.trim()) continue;
    const sc = cornersIn(sentence);
    for (const clause of sentence.split(/,\s*(?:and|but|while|then)\s+|\s+(?:but|while|whereas)\s+/i)) {
      const cc = cornersIn(clause);
      out.push({ clause, corners: cc.length ? cc : sc.length ? sc : [...itemCorners] });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Setup and rules                                                           */
/* -------------------------------------------------------------------------- */

const OFF_LIMITS =
  /\b(set-?ups?|wings?|aero|downforce|tyre pressures?|tire pressures?|pressures|camber|toe|ride height|dampers?|springs?|anti-?roll|arb|brake bias|bias|brake duct|differential|diff|gear ratios?|gearing|final drive|ballast|bop|balance of performance|traction control|tc|abs|engine map|fuel map|penalt(?:y|ies)|track limits|stewards?|drive[- ]through|stop[- ]and[- ]go|regulations?|rules?|disqualif\w*)\b/i;

/* -------------------------------------------------------------------------- */
/*  The check                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Check one model reply against the facts it was given. `reply` is the parsed
 * JSON (see {@link parseReply}). On success the result is returned trimmed,
 * with corner ids upper-cased; on failure, every reason found (they become the
 * retry's correction).
 */
export function validateCoachReply(reply: unknown, facts: readonly CoachFactLite[]): CoachVerdict {
  const reasons: string[] = [];
  if (!isObj(reply)) return { ok: false, reasons: ['reply is not a JSON object'] };

  const byId = new Map<string, CoachFactLite>();
  for (const f of facts) if (f && typeof f.id === 'string') byId.set(f.id, f);
  const knownCorners = new Set<string>();
  for (const f of facts) {
    if (f.cornerId) knownCorners.add(String(f.cornerId).toUpperCase());
    for (const c of cornersIn(f.text)) knownCorners.add(c);
  }
  const sectors = new Set<string>();
  for (const f of facts) {
    const m = /^S([1-3])\./.exec(f.id);
    if (m) sectors.add(m[1]!);
  }

  const headline = typeof reply.headline === 'string' ? reply.headline.trim() : '';
  if (!headline) reasons.push('headline missing');
  else if (headline.length > LIMITS.headline) reasons.push('headline too long');

  const rawT = Array.isArray(reply.takeaways) ? reply.takeaways : null;
  if (!rawT || rawT.length < 1 || rawT.length > LIMITS.takeaways) reasons.push('takeaways must be 1 to 3 items');
  const rawS = reply.sequences === undefined ? [] : Array.isArray(reply.sequences) ? reply.sequences : null;
  if (!rawS || rawS.length > LIMITS.sequences) reasons.push('sequences must be a list of at most 3');
  if (reasons.length) return { ok: false, reasons };

  const allCited = new Set<string>();
  const result: CoachAiResultLite = { headline, takeaways: [], sequences: [] };

  /** Every check for one piece of text that cites `factIds` about `corners`. */
  const checkText = (where: string, text: string, factIds: readonly string[], corners: readonly string[]): void => {
    // Corners named must exist.
    for (const c of cornersIn(text)) if (!knownCorners.has(c)) reasons.push(`${where} names ${c}, which no fact is about`);
    // Figures must come from a cited fact's text.
    const pool = new Set<string>();
    for (const id of factIds) for (const x of figuresIn(byId.get(id)?.text || '', sectors)) pool.add(x);
    for (const x of figuresIn(text, sectors)) {
      if (!pool.has(x)) reasons.push(`${where} types the number ${x}, which no cited fact says`);
    }
    const word = NUMBER_WORDS.exec(text);
    if (word) reasons.push(`${where} writes a number in words ("${word[0]}")`);
    // Off limits.
    const off = OFF_LIMITS.exec(text);
    if (off) reasons.push(`${where} talks about "${off[0]}" (setup, aids or rules)`);
    // Directions against the facts.
    for (const { clause, corners: cs } of clausesOf(text, corners)) {
      for (const claim of claimsIn(clause)) {
        for (const c of cs) {
          const f = facts.find((x) => x.kind === claim.kind && String(x.cornerId || '').toUpperCase() === c);
          if (!f || !Number.isFinite(f.value) || Math.abs(f.value) < THRESHOLD[claim.kind]) continue;
          if (Math.sign(f.value) !== claim.sign) {
            reasons.push(`${where}: "${claim.phrase.trim()}" contradicts ${f.id} (${f.text})`);
          }
        }
      }
    }
  };

  const checkIds = (where: string, factIds: unknown, cornerIds: unknown): { f: string[]; c: string[] } | null => {
    if (!strArr(factIds) || !strArr(cornerIds)) {
      reasons.push(`${where}: factIds and cornerIds must be lists of strings`);
      return null;
    }
    if (!factIds.length) reasons.push(`${where} cites no fact`);
    for (const id of factIds) {
      if (!byId.has(id)) reasons.push(`${where} cites unknown fact ${id}`);
      allCited.add(id);
    }
    const c = cornerIds.map((x) => x.trim().toUpperCase());
    for (const id of c) if (!knownCorners.has(id)) reasons.push(`${where} lists unknown corner ${id}`);
    return { f: factIds, c };
  };

  rawT!.forEach((t, i) => {
    const where = `takeaway ${i + 1}`;
    if (!isObj(t)) {
      reasons.push(`${where} is not an object`);
      return;
    }
    const title = typeof t.title === 'string' ? t.title.trim() : '';
    const body = typeof t.body === 'string' ? t.body.trim() : '';
    if (!title || !body) reasons.push(`${where} needs a title and a body`);
    if (title.length > LIMITS.title) reasons.push(`${where} title too long`);
    if (body.length > LIMITS.body) reasons.push(`${where} body too long`);
    const ids = checkIds(where, t.factIds, t.cornerIds);
    if (!ids) return;
    const corners = [...new Set([...ids.c, ...ids.f.map((id) => String(byId.get(id)?.cornerId || '').toUpperCase()).filter(Boolean)])];
    checkText(where, `${title}. ${body}`, ids.f, corners);
    result.takeaways.push({ title, body, factIds: ids.f, cornerIds: ids.c });
  });

  rawS!.forEach((s, i) => {
    const where = `sequence ${i + 1}`;
    if (!isObj(s)) {
      reasons.push(`${where} is not an object`);
      return;
    }
    const narrative = typeof s.narrative === 'string' ? s.narrative.trim() : '';
    if (!narrative) reasons.push(`${where} needs a narrative`);
    if (narrative.length > LIMITS.narrative) reasons.push(`${where} narrative too long`);
    const ids = checkIds(where, s.factIds, s.cornerIds);
    if (!ids) return;
    checkText(where, narrative, ids.f, ids.c);
    result.sequences.push({ cornerIds: ids.c, narrative, factIds: ids.f });
  });

  // The headline cites nothing of its own: its figures must be in some fact cited below it.
  checkText('headline', headline, [...allCited], []);

  return reasons.length ? { ok: false, reasons: [...new Set(reasons)] } : { ok: true, result };
}

/* -------------------------------------------------------------------------- */
/*  The words around the model                                                */
/* -------------------------------------------------------------------------- */

export const COACH_SYSTEM = `You are the Apex AIO driving coach for Le Mans Ultimate. A driver has finished driving; the app has measured where they lose time against a reference lap and hands you those measurements as FACTS, each with an id and a sentence.

Write JSON only, matching the schema: a one-sentence headline, one to three takeaways (title of at most eight words, body of one or two short sentences), and optionally one narrative per linked-corner sequence that has a seq.* fact.

Rules — a reply that breaks any of them is thrown away:
1. NEVER write a number: no digits and no number words. The app shows the figures from the facts you cite. Refer to corners only by their ids (C1, C13 …) and only corners that appear in the facts.
2. Every takeaway and narrative lists in factIds EVERY fact it relies on, using ids exactly as given, and in cornerIds the corners it talks about.
3. Never contradict a fact. If a fact says the driver already brakes later than the target in a corner, do not tell them to brake later there; if they are already faster at the apex, do not tell them to carry more speed there.
4. Time a fact says came from a tow or straight-line speed is not the driver's: never blame them for it.
5. Coach the driving only. Never mention car setup, driver aids, the rules, penalties or track limits.
6. Rank by what is worth most per lap and say what to DO. Plain British English, second person, encouraging and direct. No preamble.`;

/** The user turn: the context and the facts, as compact as the model needs them. */
export function userContent(req: {
  kind: string;
  context?: Record<string, unknown> | null;
  facts: readonly CoachFactLite[];
}): string {
  const ctx = req.context || {};
  const lines = [
    `KIND: ${req.kind}`,
    `TRACK: ${String(ctx.track ?? '')}`,
    `CAR: ${String(ctx.car ?? '')} (${String(ctx.carClass ?? '')})`,
    `REFERENCE: ${String(ctx.targetLabel ?? '')}`,
    '',
    'FACTS:',
    ...req.facts.map((f) => `${f.id} | ${f.text}`),
  ];
  return lines.join('\n');
}

/** The retry's instruction, as a user turn (some routers refuse a second system message). */
export function correction(reasons: readonly string[]): string {
  return (
    'CHECK FAILED — your reply was thrown away for these reasons:\n- ' +
    reasons.slice(0, 8).join('\n- ') +
    '\nReply again with the whole JSON object, fixing every one. No numbers at all; cite facts by id.'
  );
}
