-- =============================================================================
-- Tier 2 race engineer — monthly question budget and the call log testers rate.
-- =============================================================================
-- The desktop app transcribes free-form questions locally (audio never leaves
-- the PC) and posts { question, summary } to the `engineer` Edge Function.
-- This migration is the database half: one row per answered question, a
-- monthly cap, and a thumbs-up/down the driver hits in the pits — not mid-corner.
--
-- Re-runnable: `if not exists`, `create or replace`, drop-policy-then-create.
-- =============================================================================

create table if not exists public.engineer_calls (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  question   text not null,
  summary    jsonb not null default '{}'::jsonb,
  answer     text not null,
  model      text not null default '',
  stt_ms     integer,
  model_ms   integer,
  rating     text,
  rated_at   timestamptz,
  constraint engineer_calls_rating_chk
    check (rating is null or rating in ('useful', 'wrong'))
);

create index if not exists engineer_calls_user_created_idx
  on public.engineer_calls (user_id, created_at desc);

alter table public.engineer_calls enable row level security;

drop policy if exists "own engineer calls readable" on public.engineer_calls;
create policy "own engineer calls readable"
  on public.engineer_calls for select
  using (user_id = auth.uid());
-- No insert/update/delete policies: the Edge Function writes with the service
-- role; ratings go through rate_engineer_call() below.

-- ---------------------------------------------------------------------------
-- Monthly budget snapshot the Engineer tab draws. Cap is a starting guess
-- (the v3 plan's 300); real usage from this table is what right-sizes it.
-- ---------------------------------------------------------------------------
create or replace function public.engineer_budget()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_cap  int := 300;
  v_used int := 0;
  v_last public.engineer_calls%rowtype;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'Not signed in.');
  end if;

  select count(*)::int into v_used
    from public.engineer_calls
   where user_id = v_uid
     and created_at >= date_trunc('month', timezone('utc', now()));

  select * into v_last
    from public.engineer_calls
   where user_id = v_uid
   order by created_at desc
   limit 1;

  return json_build_object(
    'ok', true,
    'used', v_used,
    'cap', v_cap,
    'remaining', greatest(0, v_cap - v_used),
    'lastCall', case
      when v_last.id is null then null
      else json_build_object(
        'id', v_last.id,
        'question', v_last.question,
        'answer', v_last.answer,
        'rating', v_last.rating,
        'createdAt', v_last.created_at
      )
    end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Driver marks the last free-form reply useful or wrong. Own rows only.
-- ---------------------------------------------------------------------------
create or replace function public.rate_engineer_call(p_id uuid, p_rating text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_n   int;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'Not signed in.');
  end if;
  if p_rating not in ('useful', 'wrong') then
    return json_build_object('ok', false, 'error', 'Rating must be useful or wrong.');
  end if;

  update public.engineer_calls
     set rating = p_rating, rated_at = now()
   where id = p_id and user_id = v_uid;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return json_build_object('ok', false, 'error', 'Call not found.');
  end if;
  return json_build_object('ok', true);
end;
$$;

revoke all on function public.engineer_budget() from public;
revoke all on function public.rate_engineer_call(uuid, text) from public;
grant execute on function public.engineer_budget() to authenticated;
grant execute on function public.rate_engineer_call(uuid, text) to authenticated;
