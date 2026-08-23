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

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CAP = 300;
const MAX_QUESTION = 400;
const MAX_SUMMARY_CHARS = 8000;

const SYSTEM = `You are the Apex & Chill race engineer, speaking over the pit radio to a driver who is in the car.

Write ONE short spoken sentence (two only if a number and a verdict both need saying). British pit-wall English. No markdown, no lists, no preamble, no quotes around the line.

The question text comes from in-car speech-to-text and may be garbled. Route it to exactly one of three outcomes:
1. Not intelligible as a sentence at all (word salad, a stray fragment) → reply exactly: Say again? — never answer a question the driver did not ask.
2. Intelligible and about the race, the car, or the session, but the summary lacks the data → say you do not have that read. Never reply Say again? to a clear question: it reads as a broken radio.
3. Intelligible but nothing to do with the race (small talk, the outside world) → one short good-natured pit-wall deflection and steer back to the race ("Not my department — head down, let's focus on the car ahead."). Never Say again?, never an answer.

Rules:
- You may reason from the JSON summary you are given.
- Every figure you speak MUST appear in that summary or be simple arithmetic on figures that do (a sum, a difference, a rounding). Never invent lap times, gaps, fuel, energy, positions, names, or repair times.
- Prefer a precomputed field over doing arithmetic yourself: refuelToFinishL already IS "fuel to add to reach the end"; fuelDeltaL / energyDeltaPct already ARE the margin at the flag. Only derive when no field answers directly, and say what you derived it from.
- Distinguish what REMAINS from what is NEEDED: fuelLaps/energyLaps/fuelL are what is on board now; lapsToFinish, fuelToFinishL and refuelToFinishL are the requirement. "How much do I need" questions are about the requirement or the shortfall, never the current level.
- Speak each figure as what its field says it is. A gap is a gap, an average lap is an average lap — never present a number as something the summary does not call it.
- Do not give strategy as a command ("you must box"). Advisory only: "I'd box this lap" is fine; a fabricated fuel number is not.
- The driver already has a phrase list for gaps, fuel, tyres and the rest — they asked a free-form question because the phrase list could not match it. Answer that question.
- A PREVIOUS exchange may be included when the driver asked something moments ago. Treat the new question as a possible follow-up ("and on energy?", "how many laps is that?") and resolve its references from that exchange — but take every figure you speak from the CURRENT summary, never from the previous answer.

Summary field legend (all times/gaps in seconds, fuel in litres, energy = the car's virtual-energy allowance in percentage points):
- track/session/phase/flag: where and what. currentLap, lapsToFinish (laps still required to reach the finish), timeRemainingMin.
- position / classPosition, class. carsInClass / carsTotal: field size. lastLapSec / bestLapSec: the driver's own laps.
- ahead / behind: the class rival either side. gapSec is the gap to them; lastLapSec / bestLapSec / avgLapSec their pace, avgLaps how many laps that average covers; inPit true while they are in the pit lane; pitStops their completed stops.
- myAvgLapSec / myAvgLaps: the driver's own rolling average. myPitStops: the driver's completed stops.
- classAheadInPitNow: class cars ahead in the pit lane right now. classAheadNoStopYet: class cars ahead that have not pitted yet.
- carsAheadPittingFirst (of carsAheadCompared): cars ahead projected to be forced into the pits before the driver, on energy.
- fuelL: litres in the tank now. tankL: tank capacity. fuelPerLapL / energyPerLapPct: average burn per lap. fuelLaps / energyLaps: laps left on each budget. energyPct: virtual energy remaining.
- fuelToFinishL: litres needed to reach the finish. refuelToFinishL: litres to ADD at the next stop to make the finish (0 = none needed). fuelDeltaL / energyDeltaPct: margin at the flag, positive = surplus, negative = short.
- fuelPerEnergyRatio: litres of fuel burned per percentage point of energy — the "fuel ratio".
- fuelToFlag: good | short | critical — the binding budget's verdict. pitThisLap true = must box this lap.
- tyres: temperature verdict against the working window ("in the window", "fronts under, rears over"). No per-corner numbers are sent — the verdict IS the tyre-temperature answer.
- damage: none | light | medium | heavy. repairSec: seconds to repair if the driver boxes.
- weather (track condition), rain (dry | spitting | raining | rain later), trackTempC / airTempC.
- yellows: sectors currently yellow ("S1 S3"), absent = all green. trackLimits: accumulated cut points. hybridPct: hybrid battery charge.
- aheadTrendSecPerLap: how the gap to the car ahead is changing, seconds per lap — positive = the driver is closing, negative = the rival is pulling away. lapsToCatchAhead: laps until caught at that rate. behindTrendSecPerLap: same for the car behind — positive = HE is closing on the driver.
- tyreWorstPct: worst tyre's remaining tread, percent. tyreWearPctPerLap: its wear rate. tyreLapsLeft: laps until that tyre is worn at the current rate.
- fuelLastLapL / energyLastLapPct: burn on the LAST lap alone — compare with the fuelPerLapL / energyPerLapPct averages to judge whether saving is working.
- pitLossSec: measured total cost of a pit stop this session (lane + stop), the median of pitLossSamples observed stops. pitExitPosition: projected class position if the driver boxed right now; pitExitBehind / pitExitBehindGapSec: who they would come out behind and by how much; pitExitAheadOf / pitExitAheadOfGapSec: who they would come out ahead of. These are measured projections — prefer them to doing pit arithmetic yourself.`;

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

  let body: { question?: unknown; summary?: unknown; sttMs?: unknown; previous?: unknown };
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

  const started = Date.now();
  let raw = '';
  // Failures here carry the upstream status and a snippet of its body (plus
  // which base/model were configured — never the key): a bare "unreachable"
  // cost a debugging session on 2026-08-19, and the app treats any 5xx as
  // silence, so this detail is only ever read by whoever is diagnosing.
  try {
    const r = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 120,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content:
              (previous
                ? `PREVIOUS EXCHANGE (${previous.secondsAgo}s ago — the new question may follow up on it):\n` +
                  `Driver asked: ${previous.question}\nYou answered: ${previous.answer}\n\n`
                : '') + `QUESTION:\n${question}\n\nSUMMARY:\n${JSON.stringify(summary)}`,
          },
        ],
      }),
    });
    const text = await r.text();
    if (!r.ok) {
      console.error('engineer: upstream', r.status, apiBase, model, text.slice(0, 300));
      return json(
        { error: 'Model refused.', code: 'model', upstream: r.status, base: apiBase, model, detail: text.slice(0, 200) },
        502,
      );
    }
    let payload: { choices?: { message?: { content?: unknown } }[] };
    try {
      payload = JSON.parse(text);
    } catch {
      console.error('engineer: non-JSON upstream', r.status, apiBase, text.slice(0, 300));
      return json(
        { error: 'Model returned non-JSON.', code: 'model', upstream: r.status, base: apiBase, model, detail: text.slice(0, 200) },
        502,
      );
    }
    raw = String(payload?.choices?.[0]?.message?.content ?? '');
  } catch (err) {
    // A thrown header error can echo the Authorization value — scrub any
    // bearer credential before the message goes anywhere.
    const detail = String(err).replace(/Bearer\s+[^"'\s][^"']*/g, 'Bearer [redacted]').slice(0, 200);
    console.error('engineer: unreachable', apiBase, model, detail);
    return json({ error: 'Model unreachable.', code: 'model', base: apiBase, model, detail }, 502);
  }
  const modelMs = Date.now() - started;
  const answer = radioLine(raw);
  if (!answer) return json({ error: 'Empty answer.', code: 'model' }, 502);

  const { data: row, error: insErr } = await db
    .from('engineer_calls')
    .insert({
      user_id: user.id,
      question,
      summary,
      answer,
      model,
      stt_ms: sttMs,
      model_ms: modelMs,
    })
    .select('id')
    .single();
  if (insErr || !row) return json({ error: 'Log failed.', code: 'db' }, 500);

  return json({
    ok: true,
    answer,
    callId: row.id,
    remaining: Math.max(0, CAP - used - 1),
    cap: CAP,
    modelMs,
  });
});

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
