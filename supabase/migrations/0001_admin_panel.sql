-- =============================================================================
-- Admin panel backend — usage sessions, in-app feedback, and admin-only reads.
-- =============================================================================
-- Apply this in the Apex & Chill Supabase project (SQL editor, or the Supabase
-- CLI). It is the cloud half of the desktop app's admin panel; the app-side code
-- (electron/usageReporter.js, the Suggestions form, the Admin view) calls the
-- RPCs defined here through the same auth.rpc() path the leaderboard already uses.
--
-- Everything is written to be RE-RUNNABLE: `if not exists`, `create or replace`,
-- and `drop policy if exists` before each policy, so applying it twice is safe.
--
-- After applying, make yourself an admin so the Admin tab appears:
--     update public.profiles set is_admin = true where id = (
--       select id from auth.users where email = 'you@example.com'
--     );
--
-- Design notes:
--   * All reads/writes go through SECURITY DEFINER functions that check the
--     caller. The base tables are never exposed to clients beyond own-row RLS —
--     an admin only ever sees AGGREGATES, never another driver's raw rows.
--   * record_session is idempotent (upsert on session_id, keeping the later
--     last_seen), matching submit_activity / submit_lap: the client recomputes
--     and re-sends rather than maintaining a cursor.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Admin flag on profiles + a helper the RPCs share.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists is_admin boolean not null default false;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------------------
-- 2. app_sessions — one row per app run, upserted as the app heartbeats.
--    This is the ONLY new data source: activity/laps already flow, but they
--    only land when someone completes laps. A session row lands the moment the
--    app opens, so "how many people, how often" covers streamers who never
--    touch the lap counter too.
-- ---------------------------------------------------------------------------
create table if not exists public.app_sessions (
  session_id   uuid primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  app_version  text not null default '',
  os           text not null default '',
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
create index if not exists app_sessions_user_idx      on public.app_sessions(user_id);
create index if not exists app_sessions_last_seen_idx on public.app_sessions(last_seen_at);

alter table public.app_sessions enable row level security;

drop policy if exists "own sessions readable"  on public.app_sessions;
drop policy if exists "own sessions insertable" on public.app_sessions;
drop policy if exists "own sessions updatable"  on public.app_sessions;

create policy "own sessions readable"  on public.app_sessions
  for select using (user_id = auth.uid());
create policy "own sessions insertable" on public.app_sessions
  for insert with check (user_id = auth.uid());
create policy "own sessions updatable"  on public.app_sessions
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 3. feedback — the Suggestions tab's inbox.
-- ---------------------------------------------------------------------------
create table if not exists public.feedback (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users(id) on delete set null,
  kind        text not null default 'idea'
                check (kind in ('idea', 'bug', 'other')),
  message     text not null,
  app_version text not null default '',
  status      text not null default 'new'
                check (status in ('new', 'planned', 'in_progress', 'done', 'declined')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists feedback_status_idx  on public.feedback(status);
create index if not exists feedback_created_idx on public.feedback(created_at desc);

alter table public.feedback enable row level security;

drop policy if exists "own feedback readable"   on public.feedback;
drop policy if exists "own feedback insertable" on public.feedback;

-- A driver can read back and file their own; the admin inbox reads everyone's
-- through admin_feedback_list (security definer), not through this policy.
create policy "own feedback readable"   on public.feedback
  for select using (user_id = auth.uid());
create policy "own feedback insertable" on public.feedback
  for insert with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. record_session — idempotent heartbeat upsert.
-- ---------------------------------------------------------------------------
create or replace function public.record_session(
  p_session_id  uuid,
  p_app_version text,
  p_os          text,
  p_started_at  timestamptz,
  p_last_seen_at timestamptz
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  insert into public.app_sessions as s
    (session_id, user_id, app_version, os, started_at, last_seen_at)
  values
    (p_session_id, auth.uid(), coalesce(p_app_version, ''), left(coalesce(p_os, ''), 32),
     coalesce(p_started_at, now()), coalesce(p_last_seen_at, now()))
  on conflict (session_id) do update
    set last_seen_at = greatest(s.last_seen_at, excluded.last_seen_at),
        app_version  = excluded.app_version
    -- A session_id is client-generated; the where-clause stops one client
    -- clobbering another's row even if an id somehow collided.
    where s.user_id = auth.uid();
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. submit_feedback — file one suggestion/bug from the app.
-- ---------------------------------------------------------------------------
create or replace function public.submit_feedback(
  p_kind        text,
  p_message     text,
  p_app_version text
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id   bigint;
  v_kind text := lower(coalesce(p_kind, 'idea'));
  v_msg  text := btrim(coalesce(p_message, ''));
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  if v_kind not in ('idea', 'bug', 'other') then
    v_kind := 'other';
  end if;
  if length(v_msg) = 0 then
    raise exception 'empty_message';
  end if;
  v_msg := left(v_msg, 4000);
  insert into public.feedback (user_id, kind, message, app_version)
  values (auth.uid(), v_kind, v_msg, left(coalesce(p_app_version, ''), 32))
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. admin_whoami — cheap boolean the renderer calls to decide whether to show
--    the Admin tab. Never raises, so a non-admin just gets `false`.
-- ---------------------------------------------------------------------------
create or replace function public.admin_whoami()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select public.is_admin(); $$;

-- ---------------------------------------------------------------------------
-- 7. admin_usage_overview — the headline numbers, as one JSON object.
--    Raises 'not_admin' for anyone else (defense in depth behind the tab gate).
-- ---------------------------------------------------------------------------
create or replace function public.admin_usage_overview()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result json;
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;
  select json_build_object(
    'totalUsers',   (select count(*) from public.profiles),
    'activeToday',  (select count(distinct user_id) from public.app_sessions
                       where last_seen_at >= now() - interval '1 day'),
    'activeWeek',   (select count(distinct user_id) from public.app_sessions
                       where last_seen_at >= now() - interval '7 days'),
    'activeMonth',  (select count(distinct user_id) from public.app_sessions
                       where last_seen_at >= now() - interval '30 days'),
    'sessionsWeek', (select count(*) from public.app_sessions
                       where started_at >= now() - interval '7 days'),
    'newFeedback',  (select count(*) from public.feedback where status = 'new'),
    'versions', (
      select coalesce(json_agg(row_to_json(v) order by v.users desc), '[]'::json)
      from (
        select app_version, count(distinct user_id) as users
        from public.app_sessions
        where last_seen_at >= now() - interval '30 days' and app_version <> ''
        group by app_version
      ) v
    ),
    'daily', (
      select coalesce(json_agg(row_to_json(d) order by d.day), '[]'::json)
      from (
        select to_char(date_trunc('day', last_seen_at), 'YYYY-MM-DD') as day,
               count(distinct user_id) as users,
               count(*)                as sessions
        from public.app_sessions
        where last_seen_at >= now() - interval '14 days'
        group by 1
      ) d
    )
  ) into result;
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. admin_feedback_list — the inbox, joined to the driver's display name.
-- ---------------------------------------------------------------------------
create or replace function public.admin_feedback_list(
  p_status text default null,
  p_limit  int  default 100
) returns table (
  id          bigint,
  kind        text,
  message     text,
  app_version text,
  status      text,
  created_at  timestamptz,
  updated_at  timestamptz,
  driver      text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;
  return query
    select f.id, f.kind, f.message, f.app_version, f.status,
           f.created_at, f.updated_at,
           coalesce(p.display_name, 'Driver') as driver
    from public.feedback f
    left join public.profiles p on p.id = f.user_id
    where (p_status is null or f.status = p_status)
    order by f.created_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. admin_feedback_set_status — triage one item.
-- ---------------------------------------------------------------------------
create or replace function public.admin_feedback_set_status(
  p_id     bigint,
  p_status text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;
  if p_status not in ('new', 'planned', 'in_progress', 'done', 'declined') then
    raise exception 'bad_status';
  end if;
  update public.feedback
     set status = p_status, updated_at = now()
   where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Grants — everything is callable by signed-in drivers; the admin functions
--     gate themselves internally on is_admin().
-- ---------------------------------------------------------------------------
grant execute on function public.is_admin()                                              to authenticated;
grant execute on function public.record_session(uuid, text, text, timestamptz, timestamptz) to authenticated;
grant execute on function public.submit_feedback(text, text, text)                       to authenticated;
grant execute on function public.admin_whoami()                                          to authenticated;
grant execute on function public.admin_usage_overview()                                  to authenticated;
grant execute on function public.admin_feedback_list(text, int)                          to authenticated;
grant execute on function public.admin_feedback_set_status(bigint, text)                 to authenticated;
