// engineer — Tier 2 free-form pit-wall answers.
// -----------------------------------------------------------------------------
// The desktop app transcribes the question locally (whisper.cpp). This function
// never sees audio. It authenticates the driver, checks the monthly budget,
// calls the model with a bucketed telemetry summary, logs the exchange, and
// returns one plain-text radio line.
//
// Secrets (supabase secrets set):
//   ENGINEER_API_KEY   — OpenAI-compatible key (OpenRouter, Groq, OpenAI, …)
//   ENGINEER_API_BASE  — e.g. https://openrouter.ai/api/v1
//   ENGINEER_MODEL     — e.g. openai/gpt-4o-mini; swap without an app release
//
// The model MAY reason from the summary. It MUST NOT invent numbers that are
// not in the payload. Anything the closed grammar can answer never reaches here.
//
// v9 (2026-08-19, from the day-one engineer_calls log):
//   - garbled STT transcripts were getting confident position reports; the
//     prompt now routes unintelligible input to "Say again?"
//   - "plus five average" was answered by re-labelling the gap-ahead number as
//     an "average gap"; the prompt now forbids describing a figure as anything
//     other than what its field says it is
//   - a field legend, because the app now sends rival pace averages and the
//     class pit picture (summary v2)
//
// v10 (2026-08-23, from the first-week engineer_calls log):
//   - "What are my tyre temperatures?" — a perfectly clear question — got
//     "Say again?": the escape hatch was swallowing intelligible questions the
//     model lacked data for. Three outcomes are now spelled out separately:
//     garbled → Say again; clear but no data → no read; clear but off-topic →
//     a short pit-wall deflection ("Say again?" to a clear sentence reads as a
//     broken radio).
//   - "how many laps of fuel do I need to put in" was answered with the laps
//     REMAINING, not the shortfall: the model was doing (and fumbling) the
//     arithmetic. Summary v3 precomputes the strategy numbers (refuelToFinishL,
//     fuelDeltaL, energyDeltaPct, fuelPerEnergyRatio) and the prompt orders
//     precomputed fields ahead of derived arithmetic.
//   - the legend now covers EVERY field — the model treated undocumented
//     fields (tyres bands among them) as unusable.
//
// v11 (2026-08-23, the trends-and-follow-ups release):
//   - the app now sends per-lap TREND fields (gap closing rates, tyre wear
//     rate, last-lap burns) and a measured pit-exit projection — the summary
//     stops being a snapshot, so "is he catching me" has a real answer.
//   - an optional `previous` exchange rides the request: drivers chain
//     questions ("how much fuel to the end?" … "how many laps worth is
//     that?") and each call used to be stateless. The model resolves the new
//     question's references from it but takes every figure from the CURRENT
//     summary.
//
// v12 (2026-08-31, from the second-week engineer_calls log):
//   - 64% of calls (27 of 42) carried no information. The off-topic deflection
//     had become the catch-all: it answered "weather", "what are my tyre
//     temperatures?" and "what time do I need to be competitive" — all with
//     the fields present in the payload — and outcome 2 fired ZERO times in
//     two weeks. Racing questions with no field now route to a plain no-read,
//     and the deflection is reserved for the genuinely off-topic.
//   - the deflection was quoted verbatim in the prompt, so the model glued it
//     onto real answers ("Weather is dry — head down, let's focus on the car
//     ahead."). It is now described, not quoted, and must be varied.
//   - "hello" was deflected and rated wrong: greetings are their own outcome.
//   - lap times went out as raw seconds ("ninety-six point two seconds" for a
//     1:36.2). Anything over a minute is now spoken as minutes and seconds.
//   - STT hears "tyre temps" as "two attempts" / "tie attempts" (three calls,
//     two drivers): a known-mishearing line covers it until the app
//     normalises the transcript.
//
// v13 (2026-09-06, from the 104-call log):
//   - a FABRICATED RULE. "box to retire the car." was answered "We can't
//     retire just yet; heavy damage means a pit stop is needed first" — an
//     invented regulation. v9's ban covered invented FIGURES only, so the
//     model was free to make up procedure. The ban now covers rules,
//     regulations, penalties and what the driver is permitted to do.
//   - v12's new greeting outcome over-fired: "session update" — a request for
//     a readout — was answered "Copy that." A greeting is now only a greeting
//     when there is no request in it, and a status ask gets a real short
//     readout (which the model already does well when it tries: "You've got
//     one lap to go, tyres are in the window, and no damage").
//   - v12 swung "Say again?" from zero to 19% of calls, now catching short
//     but clearly racing fragments ("retired a car", "round of the pack").
//     Any racing noun in the text routes to the no-read instead. From the next
//     app release the client also filters silence, echo and whisper loops
//     before they ever get here (electron/engineer.js radioNoise) — until that
//     ships, empty audio still arrives and outcome 2 is what catches it.
//   - "Vary the wording every time" was ignored: the same deflection went out
//     twice in a row at 15:23 on 2026-08-31. The rule is now anchored to the
//     PREVIOUS exchange, which the model can actually see.
//   - "watch your advice" (a deflected banter reading) is "what's your
//     advice"; added to the known mishearings.
//   - `connected` was reaching the model undocumented — the v10 lesson is that
//     an undocumented field is treated as unusable.
//
// v14 (2026-10-02, from the 22-call log of 2026-09-27..10-01):
//   - NEIGHBOUR SUBSTITUTION, the worst failure yet. "what is the pace of P5?"
//     → "79.4 seconds" (the Competitive pace TARGET); "gap to P10." → the gap
//     to the car ahead (P15); "class leader times" → P2's gap and lap. The
//     summary had nothing on those cars, so the model borrowed a figure that
//     was there. Three fixes together:
//       · summary v5 (app side) carries the class timing sheet
//         (classStandings), the class leader, last-lap sector splits and
//         per-corner tyre numbers, so the questions drivers ask have real data;
//       · the prompt now says a question about a specific car is answered
//         ONLY from that car's own entry, and an absent car is a no-read;
//       · a server-side NUMBER GUARD (guard.ts) checks every figure in the
//         answer against the data for the car(s) asked about. A failing answer
//         gets one corrective retry if the first call was quick enough, else
//         (or if the retry also fails) a no-read naming the car is spoken.
//         Logged in engineer_calls.guard (migration 0039).
//   - "what's my average?" → "one oh six point four" for a 1:46.4: v12's
//     minutes-and-seconds rule was not followed. Lap times now reach the model
//     already written "1:46.4" (clockify, in guard.ts — server side, so every
//     installed app benefits), the model writes all figures as digits (which
//     the guard can parse), and the answer is reshaped for Piper ("1 46.4",
//     Tier 1's own spoken form) on the way out.
//   - the model may no longer do arithmetic: the common differences are
//     precomputed (toMe, interval, lastSectorsVsLeaderSec, paceDeltaTo*,
//     fuelDeltaL…) and a derived figure cannot be checked by the guard.
//   - class position by default; "overall" only when asked ("Position eleven"
//     was spoken to a driver running P4 in class).
//   - "so on." got a confident three-clause readout. A fragment that asks
//     nothing is never a cue for a readout.
//   - "turn off engineer" → "You're in the green."; "be quiet until end of
//     session" → "Understood" — a promise the engineer cannot keep. Behaviour
//     requests now get an honest line pointing at the Engineer tab.
//   - "that is incorrect" and "what's the last thing that I said?" got
//     "Say again?" with `previous` sitting right there; corrections are now
//     acknowledged and re-read, meta questions answered from `previous`.
//   - a complaint ("you didn't give me any sector updates") was deflected; it
//     now gets a brief acknowledgement.
//
// v15 (2026-10-08, "Mature radio" — a Discord request):
//   - an optional `tone` rides the request: 'banter' (mild swearing, taking
//     the mick) or 'savage' (strong language). Absent or anything else = the
//     prompt as it was. The addendum only changes the WORDS around an answer;
//     every figure rule, outcome and the number guard apply unchanged, and it
//     never turns a safety fact into a joke.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { clockify, guardAnswer, noReadLine, speakable } from './guard.ts';
import type { GuardVerdict } from './guard.ts';

const CAP = 300;
const MAX_QUESTION = 400;
const MAX_SUMMARY_CHARS = 8000;
/**
 * The guard's retry costs a second model round-trip. Only when the first came
 * back inside this budget — gpt-4o-mini via OpenRouter is ~0.7–1.5 s, so a
 * normal call retries and a slow one goes straight to the no-read rather than
 * leaving the driver waiting 6+ s for a corrected figure.
 */
const RETRY_BUDGET_MS = 2500;

const SYSTEM = `You are the Apex & Chill race engineer, speaking over the pit radio to a driver who is in the car.

Write ONE short spoken sentence (two only if a number and a verdict both need saying). British pit-wall English. No markdown, no lists, no preamble, no quotes around the line.

The question text comes from in-car speech-to-text and may be garbled. Route it to exactly one of these outcomes:
1. A bare greeting, radio check or acknowledgement and NOTHING ELSE ("hello", "mate", "you there", "received", "copy that", "races starting") → answer as a pit wall would, in three words or fewer: Go ahead. / Reading you. / Copy that. Never a deflection, never Say again? If the line contains any request as well, it is not this outcome — answer the request.
2. Not intelligible as a request at all — word salad, or a fragment that asks for nothing and has no racing word in it ("so on.", "and then the", "uh what was I") → reply exactly: Say again? NEVER answer a fragment with a situation readout: a readout is only ever given when the driver asked for one. A short line is NOT automatically this outcome: if it names anything about the race — a tyre, the fuel, the pack, the standings, a rival, a retirement, a flag, a lap — it is outcome 3 or an answer.
3. Intelligible and about the race, the car, the tyres, the fuel, the track, the weather, the session or the driver's own equipment, but the summary carries no field for it → say plainly that you have no read on it, in your own words ("No read on brake bias, I'm afraid."). This is the DEFAULT for anything racing-related you cannot answer. Never reply Say again? to a clear question, and never send it away as off-topic: it IS your department, you simply do not have the number.
4. Intelligible and genuinely nothing to do with the race — the outside world, the driver's evening, a joke at your expense → one short good-natured deflection that steers back to the race. Never Say again?, never an answer.
5. A request to change how YOU behave — be quiet, shut up, turn off, stop talking, more or fewer callouts, give me sector updates, call my gaps every lap → you cannot change your own settings from the radio, and you must say so honestly in one line and point to where it lives: the Radio calls setting (Quiet / Essential / Standard) or the Race engineer switch, both in the app's Engineer tab. NEVER say "understood", "will do" or anything that promises the change — you will keep talking whatever you say here.
6. A complaint about you ("you were useless", "you didn't tell me", "that was late") → a brief, genuine acknowledgement ("Fair point, noted."), plus one useful fact only if the complaint asks for one. Never brush it off and never deflect it as off-topic.
7. A correction ("that's wrong", "that is incorrect", "no, I meant P5") → acknowledge it and re-read the relevant figure from the CURRENT summary for what the PREVIOUS question asked; if the summary has nothing for it, say so plainly ("Fair call — I've no timing on P5 at all."). Never Say again? to a correction when a previous exchange is included.
8. A question about the conversation itself ("what did I just say?", "what did you say?", "repeat that") → answer from the PREVIOUS exchange, which is your memory of it. Say again? only if no previous exchange is included.

Never combine two outcomes in one reply. If you have a figure to give, that figure is the whole reply — never append a deflection, a "not my department" or a "head down, focus on the car ahead" to an answer you have actually made.

An open ask for the situation — "status", "session update", "how are we doing", "where are we" — is a REQUEST, not an acknowledgement. Give a two-clause readout of what matters most right now from the summary: class position and laps or time left, plus whichever of fuel, tyres or damage is the pressing one.

Rules:
- You may reason from the JSON summary you are given.
- Every figure you speak MUST appear in the summary exactly (you may round it). Do NOT add, subtract, multiply or convert figures yourself — the differences drivers ask for are precomputed (toMe, interval, gap, lastSectorsVsLeaderSec, paceDeltaTo*, fuelDeltaL, refuelToFinishL…). If a question needs arithmetic no field covers, give the source figures instead ("He's on 1:22.4, you're on 1:22.9"). A server-side check compares every number you write with the data; a figure it cannot find is not spoken.
- A question about a SPECIFIC car — a position (P5, P10, "the leader", "P1 in class"), a car number or a name — is answered ONLY from that car's own data: its classStandings row (matched by pos, car or name), classLeader for the class leader, or ahead/behind when that is the same car. If that car is not in the data, say you have no timing on it — NEVER substitute a figure from another car, from ahead/behind, from your own laps or from the pace reference. "Gap to P10" is P10's toMe; "gap between P5 and P6" is P6's interval; "pace of P5" is P5's last/best/avg.
- Positions are CLASS positions by default: say "P4" or "fourth in class" from classPosition. Only use the overall position when the driver says "overall". classStandings is in class order and pos is the class position; there are no overall positions for other cars, so "overall P5" is a no-read.
- Write every figure as DIGITS, never as words: "20.9 seconds", "8 laps", "P5", "45 litres". Lap times arrive as "m:ss.s" strings ("1:46.4") — write them exactly like that, colon and all. The radio voice reads them correctly.
- The same ban covers RULES, not just numbers. Never state a regulation, a procedure, a requirement or a restriction on what the driver may do — never say a stop is required first, that something is not allowed yet, or that a penalty applies — unless the summary says so. You are not the rulebook. If the driver announces an intention (retiring, boxing, pitting, switching something), acknowledge it or give the relevant figure you do have; do not tell them whether they are permitted to do it.
- Prefer a precomputed field: refuelToFinishL already IS "fuel to add to reach the end"; fuelDeltaL / energyDeltaPct already ARE the margin at the flag.
- Distinguish what REMAINS from what is NEEDED: fuelLaps/energyLaps/fuelL are what is on board now; lapsToFinish, fuelToFinishL and refuelToFinishL are the requirement. "How much do I need" questions are about the requirement or the shortfall, never the current level.
- Speak each figure as what its field says it is. A gap is a gap, an average lap is an average lap — never present a number as something the summary does not call it.
- Pace targets are race-pace bands from the named reference source. Never call paceAlienRaceSec a qualifying time; paceAlienHotlapSec is the separate qualifying/hotlap benchmark. Use the precomputed paceDeltaTo* field for "how far off" questions. A pace target is never another car's lap time.
- Do not give strategy as a command ("you must box"). Advisory only: "I'd box this lap" is fine; a fabricated fuel number is not.
- Tyre temperatures: give the tyres verdict, plus the tyreCoreC figures against tyreOptimalC when the driver asks for numbers or a corner. If only the verdict is present, the verdict IS the answer.
- Known speech-to-text mishearings — read these as the racing question they plainly are: "two attempts", "tie attempts", "tyre attempts" and "tire temp" all mean tyre temperatures; "watch your advice" means "what's your advice".
- The driver already has a phrase list for gaps, fuel, tyres and the rest — they asked a free-form question because the phrase list could not match it. Answer that question.
- A PREVIOUS exchange may be included when the driver asked something moments ago. Treat the new question as a possible follow-up ("and on energy?", "how many laps is that?", "give me that in minutes") and resolve its references — which car, which figure — from that exchange, but take every figure from the CURRENT summary. A follow-up about a car inherits the car: "that" after "pace of P5" is still P5.
- When a PREVIOUS exchange is included, your reply must not repeat its answer's wording. Reach for a different sentence even when the meaning is the same — two identical lines in a row make the driver think the radio is stuck. This matters most for deflections and no-reads, which is where you are most tempted to reuse a phrase.

Summary field legend (gaps and deltas in seconds; lap times as "m:ss.s" strings, or plain seconds when under a minute; fuel in litres; energy = the car's virtual-energy allowance in percentage points):
- track/session/phase/flag: where and what. currentLap, lapsToFinish (laps still required to reach the finish), timeRemainingMin. connected: whether the app is reading live telemetry — false means every other field is stale, so say you have no live read rather than quoting one.
- classPosition (the default), position (overall — only when asked), class. carsInClass / carsTotal: field size. lastLapSec / bestLapSec: the driver's own laps. classRetired: class cars retired or disqualified.
- classStandings: the class timing sheet in class order, one row per car. pos = class position; name; car = car number; me = the driver's own row; gap = seconds behind the class leader, or lapsDown = whole laps down on the class leader (a lapped car has no seconds gap); interval = seconds to the class car directly in front (intervalLaps when a lap or more apart); toMe = seconds between that car and the driver (lapsToMe when a lap or more apart) — the row's pos says whether it is ahead or behind; last / best / avg = their last lap, best lap and rolling average (avgN laps); stops = completed pit stops; inPit = in the pit lane now; out = retired; tyre = compound. classStandingsPartial true means some class cars were left out to save space: a position missing from the sheet is NOT in the data.
- classLeader (absent when the driver leads the class): name; gapSec = the DRIVER's gap to the leader (lapsDown instead when lapped); lastLapSec / bestLapSec / avgLapSec; sectorsSec = the leader's last-lap S1/S2/S3; pitStops; inPit.
- lastSectorsSec: the driver's last-lap S1/S2/S3 split times. lastSectorsVsLeaderSec: the driver's splits minus the leader's, per sector — positive = the driver was SLOWER there. classBestLastSectorsSec: quickest of each split across the class cars' most recent laps (not session-best sectors). There are no best-sector or sector-history figures — those are a no-read.
- paceBestLapSec / pacePercent / paceBand: the best lap scored against the resolved reference. paceAlienRaceSec is the 100% alien RACE-PACE benchmark; paceAlienHotlapSec is the separate qualifying/hotlap benchmark. paceCompetitiveSec and paceMidpackSec are the slowest laps still inside those bands. paceDeltaToAlienSec / paceDeltaToCompetitiveSec / paceDeltaToMidpackSec are best-minus-target, so positive means time still to find and zero/negative means the target is met. paceLayout / paceClass identify the matched source row; paceReferenceAssumed means the match was partly assumed and must be described as approximate; paceReferenceSource names the data source.
- ahead / behind: the class rival either side. gapSec is the gap to them; lastLapSec / bestLapSec / avgLapSec their pace, avgLaps how many laps that average covers; inPit true while they are in the pit lane; pitStops their completed stops.
- myAvgLapSec / myAvgLaps: the driver's own rolling average. myPitStops: the driver's completed stops.
- classAheadInPitNow: class cars ahead in the pit lane right now. classAheadNoStopYet: class cars ahead that have not pitted yet.
- carsAheadPittingFirst (of carsAheadCompared): cars ahead projected to be forced into the pits before the driver, on energy.
- fuelL: litres in the tank now. tankL: tank capacity. fuelPerLapL / energyPerLapPct: average burn per lap. fuelLaps / energyLaps: laps left on each budget. energyPct: virtual energy remaining.
- fuelToFinishL: litres needed to reach the finish. refuelToFinishL: litres to ADD at the next stop to make the finish (0 = none needed). fuelDeltaL / energyDeltaPct: margin at the flag, positive = surplus, negative = short.
- fuelPerEnergyRatio: litres of fuel burned per percentage point of energy — the "fuel ratio".
- fuelToFlag: good | short | critical — the binding budget's verdict. pitThisLap true = must box this lap.
- tyres: temperature verdict against the working window ("in the window", "fronts under, rears over"). tyreCoreC: core temperature per corner, °C, in the order front-left, front-right, rear-left, rear-right. tyreOptimalC: the sim's optimal temperature (one number, or one per corner). tyrePressureKpa: pressures, kPa, same order. tyreTreadPct: remaining tread per corner, percent. tyreCompound: fitted compound.
- damage: none | light | medium | heavy. repairSec: seconds to repair if the driver boxes.
- weather (track condition), rain (dry | spitting | raining | rain later), trackTempC / airTempC.
- yellows: sectors currently yellow ("S1 S3"), absent = all green. trackLimits: accumulated cut points. hybridPct: hybrid battery charge.
- aheadTrendSecPerLap: how the gap to the car ahead is changing, seconds per lap — positive = the driver is closing, negative = the rival is pulling away. lapsToCatchAhead: laps until caught at that rate. behindTrendSecPerLap: same for the car behind — positive = HE is closing on the driver.
- tyreWorstPct: worst tyre's remaining tread, percent. tyreWearPctPerLap: its wear rate. tyreLapsLeft: laps until that tyre is worn at the current rate.
- fuelLastLapL / energyLastLapPct: burn on the LAST lap alone — compare with the fuelPerLapL / energyPerLapPct averages to judge whether saving is working.
- pitLossSec: measured total cost of a pit stop this session (lane + stop), the median of pitLossSamples observed stops. pitExitPosition: projected class position if the driver boxed right now; pitExitBehind / pitExitBehindGapSec: who they would come out behind and by how much; pitExitAheadOf / pitExitAheadOfGapSec: who they would come out ahead of. These are measured projections — prefer them to doing pit arithmetic yourself.`;

/**
 * The "Mature radio" addendum (v15), appended to SYSTEM when the driver opted
 * in. Wording only: it must not loosen a single rule above it.
 */
const TONE_ADDENDUM: Record<string, string> = {
  banter: `

TONE — the driver has chosen BANTER radio. You may swear mildly (bloody, hell, damn, crap, arse) and take the mick out of the driver's mistakes, like a mate on the pit wall. Keep it to a few words on top of the answer, never instead of it. Every rule above still applies in full: the same outcome, the same figures, the same length.`,
  savage: `

TONE — the driver has chosen SAVAGE radio. You may swear properly (including fuck and shit) and roast the driver's mistakes and pace, like a brutally honest engineer who has had enough. Aim it at their driving, never at who they are: no slurs, nothing about race, religion, sexuality, gender or disability. Keep it to a few words on top of the answer, never instead of it. Every rule above still applies in full: the same outcome, the same figures, the same length.`,
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const auth = req.headers.get('Authorization') ?? '';
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: auth } } },
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return json({ error: 'Not signed in.', code: 'auth' }, 401);

  const { data: ent, error: entErr } = await userClient.rpc('entitlement_status');
  if (entErr || !ent || ent.entitled !== true) {
    return json({ error: 'Not entitled.', code: 'entitled' }, 403);
  }

  let body: { question?: unknown; summary?: unknown; sttMs?: unknown; previous?: unknown; tone?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Bad JSON.', code: 'bad' }, 400);
  }

  const question = String(body.question ?? '').replace(/\s+/g, ' ').trim();
  if (question.length < 3 || question.length > MAX_QUESTION) {
    return json({ error: 'Question missing.', code: 'bad' }, 400);
  }
  // Optional follow-up context: the exchange immediately before this ask.
  // Trimmed hard — it exists to resolve "and on energy?", not to grow a chat.
  let previous: { question: string; answer: string; secondsAgo: number } | null = null;
  if (body.previous && typeof body.previous === 'object' && !Array.isArray(body.previous)) {
    const p = body.previous as Record<string, unknown>;
    const pq = String(p.question ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION);
    const pa = String(p.answer ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const ago = Number(p.secondsAgo);
    if (pq && pa && Number.isFinite(ago) && ago >= 0 && ago <= 600) {
      previous = { question: pq, answer: pa, secondsAgo: Math.round(ago) };
    }
  }
  const summary = body.summary && typeof body.summary === 'object' && !Array.isArray(body.summary)
    ? body.summary as Record<string, unknown>
    : {};
  if (JSON.stringify(summary).length > MAX_SUMMARY_CHARS) {
    return json({ error: 'Summary too large.', code: 'bad' }, 400);
  }
  const sttMs = Number.isFinite(Number(body.sttMs)) ? Math.round(Number(body.sttMs)) : null;
  const toneAddendum = body.tone === 'banter' || body.tone === 'savage' ? TONE_ADDENDUM[body.tone] : '';

  const db = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const { count, error: countErr } = await db
    .from('engineer_calls')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('created_at', monthStart.toISOString());
  if (countErr) return json({ error: 'Budget check failed.', code: 'db' }, 500);
  const used = count ?? 0;
  if (used >= CAP) {
    return json({ ok: false, code: 'budget', remaining: 0, cap: CAP });
  }

  // Whitespace-proof all three: secrets pasted into the dashboard arrive
  // padded or line-wrapped more often than not — on 2026-08-19 a padded base
  // URL turned every call into a 404 HTML page, and a key pasted with a line
  // break in the middle made the Authorization header itself invalid. Keys
  // never legitimately contain whitespace, so collapse it everywhere.
  const apiKey = (Deno.env.get('ENGINEER_API_KEY') ?? '').replace(/\s+/g, '');
  const apiBase = (Deno.env.get('ENGINEER_API_BASE') ?? 'https://openrouter.ai/api/v1').trim().replace(/\/$/, '');
  const model = (Deno.env.get('ENGINEER_MODEL') ?? 'openai/gpt-4o-mini').trim();
  if (!apiKey) return json({ error: 'Engineer is not configured.', code: 'config' }, 503);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (apiBase.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://apexandchill.com';
    headers['X-Title'] = 'Apex AIO Engineer';
  }

  // The model's view: lap times as "1:46.4" (see clockify). The guard checks
  // the answer against this same view; the row logs the app's raw summary.
  const modelSummary = clockify(summary);
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: SYSTEM + toneAddendum },
    {
      role: 'user',
      content:
        (previous
          ? `PREVIOUS EXCHANGE (${previous.secondsAgo}s ago — the new question may follow up on it):\n` +
            `Driver asked: ${previous.question}\nYou answered: ${previous.answer}\n\n`
          : '') + `QUESTION:\n${question}\n\nSUMMARY:\n${JSON.stringify(modelSummary)}`,
    },
  ];

  // Failures here carry the upstream status and a snippet of its body (plus
  // which base/model were configured — never the key): a bare "unreachable"
  // cost a debugging session on 2026-08-19, and the app treats any 5xx as
  // silence, so this detail is only ever read by whoever is diagnosing.
  const ask = async (
    msgs: { role: string; content: string }[],
    maxTokens: number,
  ): Promise<{ ok: true; text: string } | { ok: false; response: Response }> => {
    try {
      const r = await fetch(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, temperature: 0.3, max_tokens: maxTokens, messages: msgs }),
      });
      const text = await r.text();
      if (!r.ok) {
        console.error('engineer: upstream', r.status, apiBase, model, text.slice(0, 300));
        return {
          ok: false,
          response: json(
            { error: 'Model refused.', code: 'model', upstream: r.status, base: apiBase, model, detail: text.slice(0, 200) },
            502,
          ),
        };
      }
      let payload: { choices?: { message?: { content?: unknown } }[] };
      try {
        payload = JSON.parse(text);
      } catch {
        console.error('engineer: non-JSON upstream', r.status, apiBase, text.slice(0, 300));
        return {
          ok: false,
          response: json(
            { error: 'Model returned non-JSON.', code: 'model', upstream: r.status, base: apiBase, model, detail: text.slice(0, 200) },
            502,
          ),
        };
      }
      return { ok: true, text: String(payload?.choices?.[0]?.message?.content ?? '') };
    } catch (err) {
      // A thrown header error can echo the Authorization value — scrub any
      // bearer credential before the message goes anywhere.
      const detail = String(err).replace(/Bearer\s+[^"'\s][^"']*/g, 'Bearer [redacted]').slice(0, 200);
      console.error('engineer: unreachable', apiBase, model, detail);
      return { ok: false, response: json({ error: 'Model unreachable.', code: 'model', base: apiBase, model, detail }, 502) };
    }
  };

  const started = Date.now();
  const first = await ask(messages, 120);
  if (!first.ok) return first.response;
  const firstMs = Date.now() - started;
  const firstAnswer = radioLine(first.text);
  if (!firstAnswer) return json({ error: 'Empty answer.', code: 'model' }, 502);

  // The number guard (v14). A figure the data does not hold for the car that
  // was asked about is never spoken: one corrective retry when the first call
  // was quick, otherwise — or when the retry fails too — a no-read.
  let answer = firstAnswer;
  let guardLog: Record<string, unknown> | null = null;
  const verdict = guardAnswer({ question, answer: firstAnswer, summary: modelSummary, previous });
  if (!verdict.ok) {
    const base = {
      first: firstAnswer,
      unsupported: verdict.unsupported,
      targets: verdict.targets,
      firstMs,
    };
    let retryAnswer = '';
    let reason = 'no-budget';
    if (firstMs <= RETRY_BUDGET_MS) {
      const retry = await ask(
        [
          ...messages,
          { role: 'assistant', content: firstAnswer },
          { role: 'user', content: correction(verdict) },
        ],
        80,
      );
      reason = 'retry-error';
      if (retry.ok) {
        retryAnswer = radioLine(retry.text);
        reason = 'retry-failed';
        const second: GuardVerdict | null = retryAnswer
          ? guardAnswer({ question, answer: retryAnswer, summary: modelSummary, previous })
          : null;
        if (second?.ok) {
          answer = retryAnswer;
          guardLog = { verdict: 'retried', ...base };
        }
      }
    }
    if (!guardLog) {
      answer = noReadLine(verdict, previous?.answer);
      guardLog = { verdict: 'replaced', reason, ...base, ...(retryAnswer ? { retry: retryAnswer } : {}) };
    }
    console.log('engineer: guard', JSON.stringify({ question, ...guardLog }));
  }
  const modelMs = Date.now() - started;
  // What Piper hears: "1:46.4" → "1 46.4", Tier 1's own spoken shape.
  answer = speakable(answer);

  const row = {
    user_id: user.id,
    question,
    summary,
    answer,
    model,
    stt_ms: sttMs,
    model_ms: modelMs,
    // Logged from v13 so a later review can tell a follow-up the model
    // fumbled from one it never received (2026-09-06: "and the next lap."
    // answered two ways, and the log could not say why).
    previous,
  };
  // `guard` needs migration 0039. Until it is applied PostgREST rejects the
  // unknown column, so the insert falls back to the pre-v14 row rather than
  // failing the call: the function can be deployed before the migration.
  let ins = await db
    .from('engineer_calls')
    .insert(guardLog ? { ...row, guard: guardLog } : row)
    .select('id')
    .single();
  if (ins.error && guardLog && /guard/i.test(`${ins.error.message ?? ''} ${ins.error.details ?? ''}`)) {
    console.error('engineer: guard column missing — apply migration 0039', ins.error.code);
    ins = await db.from('engineer_calls').insert(row).select('id').single();
  }
  if (ins.error || !ins.data) return json({ error: 'Log failed.', code: 'db' }, 500);

  return json({
    ok: true,
    answer,
    callId: ins.data.id,
    remaining: Math.max(0, CAP - used - 1),
    cap: CAP,
    modelMs,
    ...(guardLog ? { guard: guardLog.verdict } : {}),
  });
});

/**
 * The retry's instruction: which figures had no source, and for which car.
 * Sent as a user turn (some OpenAI-compatible routers reject a second system
 * message mid-conversation).
 */
function correction(v: GuardVerdict): string {
  const cars = v.targets.length ? v.targets.join(' and ') : 'what was asked';
  return (
    `PIT WALL CHECK — not the driver. Your reply used ${v.unsupported.join(', ')}, which the data does not hold for ${cars}. ` +
    (v.missingTarget
      ? `The summary has no timing for ${cars} at all, so say you have no timing on it. `
      : `Use only figures from ${cars}'s own entry, exactly as written there. `) +
    'Never substitute another car\'s figure, your own laps or a pace target, and do no arithmetic. ' +
    'Reply again with the one radio line only, figures in digits.'
  );
}

/** One spoken line: first paragraph, no markdown, capped for Piper. */
function radioLine(text: string): string {
  let s = String(text || '').replace(/\r/g, '').trim();
  s = s.replace(/^```[\s\S]*?```/g, '').trim();
  s = s.replace(/^["“']+|["”']+$/g, '').trim();
  const line = s.split(/\n+/)[0] || '';
  return line.slice(0, 280).trim();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
