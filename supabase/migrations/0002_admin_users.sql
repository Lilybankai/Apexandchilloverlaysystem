-- =============================================================================
-- Admin panel — the driver list.
-- =============================================================================
-- Adds one function: `admin_users_list`, the per-account roster behind the
-- Admin tab's Drivers card — who has an account, how many times they have
-- opened the app, and when they were last active.
--
-- Apply after 0001_admin_panel.sql. Re-runnable (`create or replace`).
--
-- A NOTE ON THE PRIVACY BOUNDARY, because this deliberately moves it:
-- 0001 said an admin sees "AGGREGATES only, never another driver's raw rows".
-- This function is the considered exception — it returns one row per account
-- with the driver's name and email, because the league needs to know WHO is
-- using the system and not merely how many. What it still never exposes is
-- anything about how they drive: no laps, no telemetry, no session detail
-- beyond a count and a timestamp. The gate is unchanged and checked here too:
-- SECURITY DEFINER + `is_admin()`, so a non-admin calling this directly gets
-- an exception rather than a roster.
--
-- `logins` counts rows in app_sessions — one per app run, i.e. app OPENS, not
-- Supabase sign-ins. Sessions only started being recorded in v0.49.0, so an
-- account that predates it reads 0 / "Never" until its next launch. The UI says
-- so rather than letting the number be read as "has never used the app".
-- =============================================================================

create or replace function public.admin_users_list(
  p_search text default null,
  p_sort   text default 'last_seen',
  p_limit  int  default 200
) returns table (
  user_id       uuid,
  name          text,
  email         text,
  logins        bigint,
  last_seen_at  timestamptz,
  first_seen_at timestamptz,
  app_version   text,
  joined_at     timestamptz,
  is_admin      boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_sort   text := lower(coalesce(p_sort, 'last_seen'));
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_limit  int  := greatest(1, least(coalesce(p_limit, 200), 1000));
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;
  -- Whitelist rather than interpolate: the sort arrives from the renderer, and
  -- the order-by below is static SQL precisely so it can never be anything else.
  if v_sort not in ('last_seen', 'logins', 'name', 'joined') then
    v_sort := 'last_seen';
  end if;

  return query
  with sess as (
    select a.user_id           as uid,
           count(*)            as n_logins,
           min(a.started_at)   as first_seen,
           max(a.last_seen_at) as last_seen
    from public.app_sessions a
    group by a.user_id
  ),
  lastver as (
    -- The version each driver most recently ran, so "still on an old build" is
    -- answerable per person and not just in aggregate.
    select distinct on (a.user_id) a.user_id as uid, a.app_version as ver
    from public.app_sessions a
    where a.app_version <> ''
    order by a.user_id, a.last_seen_at desc
  )
  -- Driven from profiles, not from sessions: an account that has never opened
  -- the app is exactly the row a league most wants to see, and an inner join
  -- would hide it.
  select p.id,
         coalesce(nullif(btrim(p.display_name), ''), 'Driver')::text,
         coalesce(u.email, '')::text,
         coalesce(s.n_logins, 0)::bigint,
         s.last_seen,
         s.first_seen,
         coalesce(l.ver, '')::text,
         p.created_at,
         coalesce(p.is_admin, false)
  from public.profiles p
  left join auth.users u on u.id  = p.id
  left join sess s       on s.uid = p.id
  left join lastver l    on l.uid = p.id
  where v_search is null
     or p.display_name ilike '%' || v_search || '%'
     or u.email ilike '%' || v_search || '%'
  order by
    case when v_sort = 'logins' then coalesce(s.n_logins, 0) end desc nulls last,
    case when v_sort = 'name'   then lower(nullif(btrim(p.display_name), '')) end asc nulls last,
    case when v_sort = 'joined' then p.created_at end desc nulls last,
    case when v_sort = 'last_seen' then s.last_seen end desc nulls last,
    -- Tie-break, and the whole order for the sorts above once their key ties:
    -- most recently seen first, then alphabetical, so the list never shuffles
    -- between two identical refreshes.
    s.last_seen desc nulls last,
    lower(coalesce(p.display_name, ''))
  limit v_limit;
end;
$$;

grant execute on function public.admin_users_list(text, text, int) to authenticated;
