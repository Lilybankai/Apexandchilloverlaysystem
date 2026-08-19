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

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CAP = 300;
const MAX_QUESTION = 400;
const MAX_SUMMARY_CHARS = 8000;

const SYSTEM = `You are the Apex & Chill race engineer, speaking over the pit radio to a driver who is in the car.

Write ONE short spoken sentence (two only if a number and a verdict both need saying). British pit-wall English. No markdown, no lists, no preamble, no quotes around the line.

Rules:
- You may reason from the JSON summary you are given.
- Every figure you speak MUST appear in that summary. Do not invent lap times, gaps, fuel, energy, positions, names, or repair times.
- If the summary does not contain what you need, say you do not have that read. Never guess.
- Do not give strategy as a command ("you must box"). Advisory only: "I'd box this lap" is fine; a fabricated fuel number is not.
- The driver already has a phrase list for gaps, fuel, tyres and the rest — they asked a free-form question because the phrase list could not match it. Answer that question.`;

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

  let body: { question?: unknown; summary?: unknown; sttMs?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Bad JSON.', code: 'bad' }, 400);
  }

  const question = String(body.question ?? '').replace(/\s+/g, ' ').trim();
  if (question.length < 3 || question.length > MAX_QUESTION) {
    return json({ error: 'Question missing.', code: 'bad' }, 400);
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

  const apiKey = Deno.env.get('ENGINEER_API_KEY') ?? '';
  const apiBase = (Deno.env.get('ENGINEER_API_BASE') ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const model = Deno.env.get('ENGINEER_MODEL') ?? 'openai/gpt-4o-mini';
  if (!apiKey) return json({ error: 'Engineer is not configured.', code: 'config' }, 503);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (apiBase.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://apexandchill.com';
    headers['X-Title'] = 'Apex Overlay Engineer';
  }

  const started = Date.now();
  let raw = '';
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
            content: `QUESTION:\n${question}\n\nSUMMARY:\n${JSON.stringify(summary)}`,
          },
        ],
      }),
    });
    const payload = await r.json();
    if (!r.ok) {
      return json({ error: 'Model refused.', code: 'model' }, 502);
    }
    raw = String(payload?.choices?.[0]?.message?.content ?? '');
  } catch {
    return json({ error: 'Model unreachable.', code: 'model' }, 502);
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
