// coach — the AI driving coach's words over the app's measurements.
// -----------------------------------------------------------------------------
// 2026-10-29. The desktop app measures a practice session (or one lap, or the
// driver's habits) and builds CoachFacts: one number each, with a template
// sentence. This function asks a small model to RANK and WORD those facts into
// a headline and up to three takeaways, citing facts by id, and checks the
// reply (validate.ts) before it goes anywhere. The model never types a number.
//
// Members only (entitlement_status, as `engineer`). NO monthly cap — Carl's
// decision for the beta — but every model call is logged in coach_calls, and a
// soft burst limit stops a runaway client loop from burning credit.
//
// Cache: same user + same input_hash + same prompt version → the stored reply,
// no model call. The app keeps its own cache too (userData/coach-cache), so a
// reopened session normally never reaches here.
//
// Secrets (supabase secrets set) — all optional, the ENGINEER_* ones are reused:
//   COACH_API_KEY    — else ENGINEER_API_KEY
//   COACH_API_BASE   — else ENGINEER_API_BASE, else https://openrouter.ai/api/v1
//   COACH_MODEL      — else anthropic/claude-haiku-5.5 on OpenRouter, else
//                      ENGINEER_MODEL (a non-OpenRouter base has no Haiku slug)
//
// Needs migration 0045_coach_calls.sql. Without it the function still answers
// (nothing cached, nothing logged) and says so in the function log.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { COACH_JSON_SCHEMA, COACH_SYSTEM, correction, parseReply, userContent, validateCoachReply } from './validate.ts';
import type { CoachAiResultLite, CoachFactLite } from './validate.ts';

/** Bump when COACH_SYSTEM or the checks change: older cached replies are not reused. */
const PROMPT_V = 1;
const MAX_FACTS = 60;
const MAX_BODY_CHARS = 24000;
/** Soft burst limit: model calls per user per minute. */
const BURST_PER_MIN = 12;
const MAX_TOKENS = 700;
const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-haiku-5.5';

const KINDS = new Set(['session', 'lap', 'habits']);

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

  let raw: string;
  let body: { kind?: unknown; inputHash?: unknown; context?: unknown; facts?: unknown };
  try {
    raw = await req.text();
    if (raw.length > MAX_BODY_CHARS) return json({ error: 'Request too large.', code: 'bad' }, 400);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Bad JSON.', code: 'bad' }, 400);
  }

  const kind = String(body.kind ?? '');
  if (!KINDS.has(kind)) return json({ error: 'Unknown kind.', code: 'bad' }, 400);
  const inputHash = String(body.inputHash ?? '');
  if (!/^[0-9a-f]{16,128}$/i.test(inputHash)) return json({ error: 'Bad input hash.', code: 'bad' }, 400);
  const facts = cleanFacts(body.facts);
  if (!facts.length) return json({ error: 'No facts.', code: 'bad' }, 400);
  const context = body.context && typeof body.context === 'object' && !Array.isArray(body.context)
    ? body.context as Record<string, unknown>
    : {};

  const db = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  // The cache. A missing table (0045 not applied) is not an error here.
  let tableOk = true;
  {
    const { data, error } = await db
      .from('coach_calls')
      .select('reply')
      .eq('user_id', user.id)
      .eq('kind', kind)
      .eq('input_hash', inputHash)
      .eq('prompt_v', PROMPT_V)
      .eq('ok', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      tableOk = false;
      console.error('coach: cache read failed — is migration 0045 applied?', error.code, error.message);
    } else if (data && data.reply) {
      return json({ ok: true, ai: data.reply, cached: true });
    }
  }

  // Soft burst limit: a loop, not a driver, makes a dozen fresh calls a minute.
  if (tableOk) {
    const since = new Date(Date.now() - 60_000).toISOString();
    const { count } = await db
      .from('coach_calls')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .gte('created_at', since);
    if ((count ?? 0) >= BURST_PER_MIN) return json({ ok: false, code: 'burst', error: 'Too many coach requests — try again in a minute.' }, 429);
  }

  // Secrets, whitespace-proofed as the engineer's are (pasted secrets arrive padded).
  const apiKey = (Deno.env.get('COACH_API_KEY') ?? Deno.env.get('ENGINEER_API_KEY') ?? '').replace(/\s+/g, '');
  const apiBase = (Deno.env.get('COACH_API_BASE') ?? Deno.env.get('ENGINEER_API_BASE') ?? 'https://openrouter.ai/api/v1')
    .trim()
    .replace(/\/$/, '');
  const isOpenRouter = apiBase.includes('openrouter.ai');
  const model = (
    Deno.env.get('COACH_MODEL') ??
    (isOpenRouter ? DEFAULT_OPENROUTER_MODEL : Deno.env.get('ENGINEER_MODEL') ?? 'gpt-4o-mini')
  ).trim();
  if (!apiKey) return json({ error: 'Coach is not configured.', code: 'config' }, 503);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (isOpenRouter) {
    headers['HTTP-Referer'] = 'https://apexandchill.com';
    headers['X-Title'] = 'Apex AIO Coach';
  }

  const messages: { role: string; content: string }[] = [
    { role: 'system', content: COACH_SYSTEM },
    { role: 'user', content: userContent({ kind, context, facts }) },
  ];

  let tokens = 0;
  // Structured output and low reasoning effort first; a router or model that
  // refuses either (HTTP 400) is asked again plainly — the reply is parsed and
  // validated the same way whichever way it came back.
  let plain = false;
  const ask = async (msgs: { role: string; content: string }[]): Promise<{ ok: true; text: string } | { ok: false; status: number; detail: string }> => {
    const call = async (fancy: boolean) => {
      const payload: Record<string, unknown> = { model, max_tokens: MAX_TOKENS, temperature: 0.2, messages: msgs };
      if (fancy) {
        payload.response_format = { type: 'json_schema', json_schema: COACH_JSON_SCHEMA };
        if (isOpenRouter) payload.reasoning = { effort: 'low', exclude: true };
      }
      return await fetch(`${apiBase}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(payload) });
    };
    try {
      let r = await call(!plain);
      if (r.status === 400 && !plain) {
        console.error('coach: upstream refused structured request, retrying plain', model, (await r.text()).slice(0, 200));
        plain = true;
        r = await call(false);
      }
      const text = await r.text();
      if (!r.ok) {
        console.error('coach: upstream', r.status, apiBase, model, text.slice(0, 300));
        return { ok: false, status: r.status, detail: text.slice(0, 200) };
      }
      const p = JSON.parse(text) as { choices?: { message?: { content?: unknown } }[]; usage?: { total_tokens?: number } };
      tokens += Number(p?.usage?.total_tokens) || 0;
      return { ok: true, text: String(p?.choices?.[0]?.message?.content ?? '') };
    } catch (err) {
      const detail = String(err).replace(/Bearer\s+[^"'\s][^"']*/g, 'Bearer [redacted]').slice(0, 200);
      console.error('coach: unreachable', apiBase, model, detail);
      return { ok: false, status: 0, detail };
    }
  };

  const started = Date.now();
  const first = await ask(messages);
  if (!first.ok) {
    return json({ ok: false, code: 'model', error: 'Model unavailable.', upstream: first.status, model, detail: first.detail }, 502);
  }
  let verdict = validateCoachReply(parseReply(first.text), facts);
  const attempts: Record<string, unknown>[] = [];
  if (!verdict.ok) {
    attempts.push({ text: first.text.slice(0, 2000), reasons: verdict.reasons });
    const retry = await ask([
      ...messages,
      { role: 'assistant', content: first.text.slice(0, 4000) },
      { role: 'user', content: correction(verdict.reasons) },
    ]);
    if (retry.ok) {
      verdict = validateCoachReply(parseReply(retry.text), facts);
      if (!verdict.ok) attempts.push({ text: retry.text.slice(0, 2000), reasons: verdict.reasons });
    }
  }
  const ms = Date.now() - started;
  const ok = verdict.ok;
  const reply: CoachAiResultLite | null = verdict.ok ? verdict.result : null;
  if (!ok) console.log('coach: rejected', JSON.stringify({ kind, attempts: attempts.length, reasons: attempts.map((a) => a.reasons) }));

  if (tableOk) {
    const { error } = await db.from('coach_calls').insert({
      user_id: user.id,
      kind,
      input_hash: inputHash,
      prompt_v: PROMPT_V,
      model,
      request: { context, facts },
      reply: reply ?? { rejected: attempts },
      ok,
      tokens: tokens || null,
      ms,
    });
    if (error) console.error('coach: log failed', error.code, error.message);
  }

  if (!ok) return json({ ok: false, code: 'rejected', error: 'The coach reply failed its checks.', ms });
  return json({ ok: true, ai: reply, cached: false, model, ms });
});

/** Facts as the model and the validator see them: known fields, short text, capped count. */
function cleanFacts(v: unknown): CoachFactLite[] {
  if (!Array.isArray(v)) return [];
  const out: CoachFactLite[] = [];
  const seen = new Set<string>();
  for (const f of v) {
    if (!f || typeof f !== 'object') continue;
    const x = f as Record<string, unknown>;
    const id = String(x.id ?? '').slice(0, 64);
    const text = String(x.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const value = Number(x.value);
    if (!id || !text || !Number.isFinite(value) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      cornerId: typeof x.cornerId === 'string' ? x.cornerId.slice(0, 16) : undefined,
      kind: String(x.kind ?? '').slice(0, 32),
      value,
      unit: typeof x.unit === 'string' ? x.unit.slice(0, 8) : undefined,
      text,
    });
    if (out.length >= MAX_FACTS) break;
  }
  return out;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
