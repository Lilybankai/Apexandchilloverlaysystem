-- =============================================================================
-- AI driving coach — the call log, and the cache it doubles as.
-- =============================================================================
-- 2026-10-29. The desktop app measures a practice session / a lap / a driver's
-- habits and posts the measurements as CoachFacts to the `coach` Edge Function
-- (supabase/functions/coach). The model ranks and words them, citing facts by
-- id; the function checks the reply (validate.ts) and logs it here.
--
-- One row per MODEL call (a cache hit writes nothing):
--   input_hash  the app's hash of { report version, kind, context, facts } —
--               the same user asking the same thing gets the stored reply back
--               without a model call (only rows with ok = true and the current
--               prompt_v are reused);
--   prompt_v    the function's PROMPT_V: a prompt or check change makes older
--               replies stale without deleting them;
--   request     what was sent (context + facts), for review;
--   reply       the validated CoachAiResult, or { rejected: [{ text, reasons }] }
--               when both attempts failed the checks (ok = false);
--   tokens, ms  cost and latency.
--
-- No monthly cap (Carl, 2026-10-29: no limit on AI reports for now), so
-- nothing here counts a budget; the function's soft burst limit reads
-- (user_id, created_at).
--
-- RLS on, NO policies: no client may read or write this table. Only the
-- function, with the service role, touches it. The driver's view of a reply is
-- the function's answer and the app's own cache.
--
-- Re-runnable: `if not exists` throughout.
-- =============================================================================

create table if not exists public.coach_calls (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  kind        text not null,
  input_hash  text not null,
  prompt_v    integer not null default 1,
  model       text not null default '',
  request     jsonb not null default '{}'::jsonb,
  reply       jsonb,
  ok          boolean not null default false,
  tokens      integer,
  ms          integer,
  constraint coach_calls_kind_chk check (kind in ('session', 'lap', 'habits'))
);

-- The cache lookup: same user, kind, hash and prompt version, newest first.
create index if not exists coach_calls_cache_idx
  on public.coach_calls (user_id, kind, input_hash, prompt_v, created_at desc);

-- The burst limit and any per-user review.
create index if not exists coach_calls_user_created_idx
  on public.coach_calls (user_id, created_at desc);

alter table public.coach_calls enable row level security;
-- Deliberately no policies: service role only.

revoke all on table public.coach_calls from anon, authenticated;

comment on table public.coach_calls is
  'AI driving coach: one row per model call (supabase/functions/coach). Doubles as the per-user reply cache keyed by input_hash + prompt_v. Service role only.';
