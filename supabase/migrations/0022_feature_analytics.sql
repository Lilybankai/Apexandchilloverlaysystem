-- ===========================================================================
-- 0022_feature_analytics — what the app is actually USED for.
--
-- Until now the league could see that someone opened the app (0001's
-- app_sessions) and that they drove (driver_activity_days), and nothing at all
-- in between. "Is anyone using the Review tab?" and "which overlays are worth
-- the maintenance?" had no answer, so every product decision was a guess.
--
-- Two new tables close that gap, and one admin read turns them into the Usage
-- pane:
--
--   feature_usage  — per driver, per day, per feature slug: how many times it
--                    was opened/used and how long it was on screen.
--   overlay_usage  — per driver, per day, per overlay id: was it switched on,
--                    how many times an OBS browser source loaded it, and how
--                    long the in-game layer carried it.
--
-- ## Why daily aggregates and not an event log
-- The same reasoning as submit_activity (see lapUpload.js): four hundred tab
-- switches become one row saying "400", not four hundred rows. That keeps the
-- table small enough to query without a warehouse, keeps the upload idempotent
-- (the client recomputes the day and re-sends it, the server keeps the GREATER
-- counter), and — the part that matters most — it means the cloud never holds a
-- timeline of what one named person did minute by minute. An admin reads
-- totals; there is no RPC here that returns a driver's rows, by construction.
--
-- ## Why the counters are monotonic
-- `greatest(existing, excluded)` on every counter is what makes a re-send free.
-- The client holds the day's running totals locally and offers the whole day
-- each heartbeat, so a dropped upload, an app restart or a second machine can
-- never double-count and can never go backwards. It also means a counter can
-- only ever under-report (a machine that never got online), which is the right
-- direction to be wrong in for a number you are about to base a roadmap on.
--
-- Both tables hang off auth.users with ON DELETE CASCADE, so the GDPR erasure
-- in supabase/functions/delete-account keeps working with no change.
--
-- Re-runnable: `if not exists`, `create or replace`, `drop policy if exists`.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. feature_usage — one row per driver, day and feature slug.
--
--    `feature` is a free-text slug the CLIENT names, not an enum, and that is
--    deliberate: an enum means every new button in the app needs a migration
--    before it can be measured, which is exactly the friction that leaves a
--    feature unmeasured. The slugs are namespaced by the app (`tab:review`,
--    `action:setup.download`) and the admin pane groups on that prefix;
--    anything it does not recognise still shows, under "Other", rather than
--    being silently dropped.
-- ---------------------------------------------------------------------------
create table if not exists public.feature_usage (
  user_id     uuid not null references auth.users(id) on delete cascade,
  day         date not null,
  feature     text not null,
  -- How many times it was used that day. For a tab that is arrivals; for an
  -- action it is presses.
  uses        int  not null default 0,
  -- How long it was the thing on screen, in whole seconds. Zero for an action
  -- that has no dwell (a button press), and the reason a tab that is opened
  -- once and lived in all evening does not read the same as one opened forty
  -- times and bounced off.
  seconds     int  not null default 0,
  app_version text not null default '',
  updated_at  timestamptz not null default now(),
  primary key (user_id, day, feature)
);

create index if not exists feature_usage_day_idx     on public.feature_usage(day);
create index if not exists feature_usage_feature_idx on public.feature_usage(feature, day);

comment on table public.feature_usage is
  'Per-driver daily counters for each named app feature. Written only via submit_feature_usage(); read in aggregate only, via admin_feature_analytics().';

alter table public.feature_usage enable row level security;

drop policy if exists "own feature usage readable"  on public.feature_usage;
drop policy if exists "own feature usage writable"  on public.feature_usage;
drop policy if exists "own feature usage updatable" on public.feature_usage;

create policy "own feature usage readable"  on public.feature_usage
  for select using (user_id = auth.uid());
create policy "own feature usage writable"  on public.feature_usage
  for insert with check (user_id = auth.uid());
create policy "own feature usage updatable" on public.feature_usage
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 2. overlay_usage — one row per driver, day and overlay id.
--
--    Three different questions, three columns, because they genuinely differ:
--
--      enabled        — the driver has this overlay switched ON. Intent. It is
--                       "was on at some point today", not "is on now": the
--                       upsert ORs it, so a card toggled off at 9pm still
--                       counts for the evening it was used. A driver who
--                       leaves it off simply stops appearing on later days.
--      obs_loads      — an OBS browser source (or a browser tab) actually
--                       fetched a page carrying this overlay. Use, not intent
--                       — this is the number that says whether the thing is on
--                       a stream.
--      ingame_seconds — seconds the in-game layer was on screen with this
--                       overlay in its set. The other half of use, for the
--                       majority who never open OBS at all.
--
--    Measuring only `enabled` would have flattered every overlay, because a
--    fresh install turns them all on; measuring only loads would have missed
--    the in-game layer entirely.
-- ---------------------------------------------------------------------------
create table if not exists public.overlay_usage (
  user_id        uuid not null references auth.users(id) on delete cascade,
  day            date not null,
  overlay        text not null,
  enabled        boolean not null default false,
  obs_loads      int not null default 0,
  ingame_seconds int not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (user_id, day, overlay)
);

create index if not exists overlay_usage_day_idx     on public.overlay_usage(day);
create index if not exists overlay_usage_overlay_idx on public.overlay_usage(overlay, day);

comment on table public.overlay_usage is
  'Per-driver daily state and use for each overlay widget. Written only via submit_overlay_usage(); read in aggregate only, via admin_feature_analytics().';

alter table public.overlay_usage enable row level security;

drop policy if exists "own overlay usage readable"  on public.overlay_usage;
drop policy if exists "own overlay usage writable"  on public.overlay_usage;
drop policy if exists "own overlay usage updatable" on public.overlay_usage;

create policy "own overlay usage readable"  on public.overlay_usage
  for select using (user_id = auth.uid());
create policy "own overlay usage writable"  on public.overlay_usage
  for insert with check (user_id = auth.uid());
create policy "own overlay usage updatable" on public.overlay_usage
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 3. usage_counter — read one counter out of a client-supplied jsonb value.
--
--    Both submit_* functions loop over a jsonb array from the app, and the app
--    is a different program on a different release cadence: a build a year from
--    now may send a float, a string, a null or nothing at all where an integer
--    belongs. Casting `->> 'uses'` to int would raise on every one of those,
--    and a raise inside the loop rolls the WHOLE batch back — one stray value
--    would cost a day of everyone else's counters.
--
--    So the type is CHECKED rather than assumed, anything that is not a number
--    reads as zero, and the result is clamped into [0, p_max]. Immutable, so
--    it can be inlined.
-- ---------------------------------------------------------------------------
--    `set search_path` is not decoration: without it the function resolves its
--    operators against whatever path the CALLER happens to have, which is the
--    `function_search_path_mutable` finding Supabase's linter raises. Pinned to
--    pg_catalog, because everything this touches is a built-in.
create or replace function public.usage_counter(p_value jsonb, p_max int)
returns int
language sql
immutable
set search_path = pg_catalog
as $$
  select case
           when jsonb_typeof(p_value) = 'number'
             then least(greatest(floor((p_value #>> '{}')::numeric)::int, 0), p_max)
           else 0
         end;
$$;

-- A helper, not an API. The two submit_* functions are SECURITY DEFINER and
-- call it as the definer, so nothing outside needs to reach it.
revoke all on function public.usage_counter(jsonb, int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. submit_feature_usage — the only door into feature_usage.
--
--    Takes a whole day at once as a jsonb array, because that is what the
--    client holds: one heartbeat offers every feature touched today rather
--    than one request per counter. A malformed element is skipped, not fatal
--    — a bad slug from a future build must never cost the rest of the batch.
--
--    Returns the number of rows written, which is what the uploader logs.
-- ---------------------------------------------------------------------------
create or replace function public.submit_feature_usage(
  p_day         date,
  p_app_version text,
  p_rows        jsonb
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_day     date := coalesce(p_day, current_date);
  v_ver     text := left(coalesce(p_app_version, ''), 32);
  v_written int  := 0;
  v_row     jsonb;
  v_feature text;
  v_uses    int;
  v_seconds int;
begin
  if v_uid is null then
    raise exception 'submit_feature_usage: not authenticated';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    return 0;
  end if;
  -- A day in the future is a clock that is wrong, not data. Tomorrow is
  -- allowed because a driver east of the server rolls over first.
  if v_day > (current_date + 1) or v_day < (current_date - 90) then
    return 0;
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    continue when jsonb_typeof(v_row) is distinct from 'object';
    v_feature := nullif(btrim(coalesce(v_row ->> 'feature', '')), '');
    continue when v_feature is null;
    v_feature := left(lower(v_feature), 64);

    -- Counters are clamped, not trusted. A year of seconds in one day is a bug
    -- in the client, and it must not be able to poison a chart.
    --
    -- Read through jsonb_typeof rather than casting whatever ->> returns: a
    -- string where a number belongs would raise, and a raise here loses the
    -- WHOLE batch to the statement rollback. A future build sending something
    -- unexpected should cost that one counter, nothing else.
    v_uses    := public.usage_counter(v_row -> 'uses', 100000);
    v_seconds := public.usage_counter(v_row -> 'seconds', 86400);
    continue when v_uses = 0 and v_seconds = 0;

    insert into public.feature_usage as f
      (user_id, day, feature, uses, seconds, app_version, updated_at)
    values
      (v_uid, v_day, v_feature, v_uses, v_seconds, v_ver, now())
    on conflict (user_id, day, feature) do update
      set uses        = greatest(f.uses, excluded.uses),
          seconds     = greatest(f.seconds, excluded.seconds),
          app_version = excluded.app_version,
          updated_at  = now();

    v_written := v_written + 1;
  end loop;

  return v_written;
end;
$$;

revoke all on function public.submit_feature_usage(date, text, jsonb) from public, anon;
grant execute on function public.submit_feature_usage(date, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. submit_overlay_usage — the only door into overlay_usage.
--
--    Same shape and the same monotonic rule, with `enabled` ORed rather than
--    maxed: see the table comment for why "was on today" is the question.
-- ---------------------------------------------------------------------------
create or replace function public.submit_overlay_usage(
  p_day  date,
  p_rows jsonb
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_day     date := coalesce(p_day, current_date);
  v_written int  := 0;
  v_row     jsonb;
  v_overlay text;
  v_enabled boolean;
  v_loads   int;
  v_secs    int;
begin
  if v_uid is null then
    raise exception 'submit_overlay_usage: not authenticated';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    return 0;
  end if;
  if v_day > (current_date + 1) or v_day < (current_date - 90) then
    return 0;
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    continue when jsonb_typeof(v_row) is distinct from 'object';
    v_overlay := nullif(btrim(coalesce(v_row ->> 'overlay', '')), '');
    continue when v_overlay is null;
    v_overlay := left(lower(v_overlay), 32);

    v_enabled := jsonb_typeof(v_row -> 'enabled') = 'boolean'
                 and (v_row -> 'enabled')::text = 'true';
    v_loads   := public.usage_counter(v_row -> 'obsLoads', 100000);
    v_secs    := public.usage_counter(v_row -> 'ingameSeconds', 86400);
    continue when not v_enabled and v_loads = 0 and v_secs = 0;

    insert into public.overlay_usage as o
      (user_id, day, overlay, enabled, obs_loads, ingame_seconds, updated_at)
    values
      (v_uid, v_day, v_overlay, v_enabled, v_loads, v_secs, now())
    on conflict (user_id, day, overlay) do update
      set enabled        = o.enabled or excluded.enabled,
          obs_loads      = greatest(o.obs_loads, excluded.obs_loads),
          ingame_seconds = greatest(o.ingame_seconds, excluded.ingame_seconds),
          updated_at     = now();

    v_written := v_written + 1;
  end loop;

  return v_written;
end;
$$;

revoke all on function public.submit_overlay_usage(date, jsonb) from public, anon;
grant execute on function public.submit_overlay_usage(date, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. admin_feature_analytics — the whole Usage pane, as one JSON object.
--
--    One round trip rather than eight, for the same reason admin_usage_overview
--    is one call: the pane is read as a single picture and a half-loaded
--    dashboard is worse than a slightly slower one.
--
--    `p_days` sizes the daily series only (7–90). The headline windows are
--    fixed at today / 7d / 30d because those are the three questions actually
--    asked, and a configurable window invites comparing numbers that were
--    measured over different lengths.
--
--    The `cloud` block is the part that works WITHOUT the client instrumentation
--    that lands alongside this migration: engineer calls, setups, board laps and
--    relay publishes are already in the database, so the pane says something
--    real on day one instead of waiting for the fleet to update.
-- ---------------------------------------------------------------------------
create or replace function public.admin_feature_analytics(
  p_days int default 30
) returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_days   int := least(greatest(coalesce(p_days, 30), 7), 90);
  v_from   date := current_date - (v_days - 1);
  v_active int;
  result   json;
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;

  -- The denominator every adoption percentage is measured against: drivers who
  -- had the app open at all in the last 30 days. Computed once, returned, and
  -- used by the client rather than recomputed per row.
  select count(distinct user_id) into v_active
    from public.app_sessions
   where last_seen_at >= now() - interval '30 days';

  select json_build_object(
    'windowDays',  v_days,
    'generatedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'activeMonth', v_active,

    -- ---- Laps driven, all time and recently -------------------------------
    'laps', (
      select json_build_object(
        'total',       coalesce(sum(a.laps), 0),
        'clean',       coalesce(sum(a.clean_laps), 0),
        'km',          round(coalesce(sum(a.distance_m), 0) / 1000.0),
        'hours',       round(coalesce(sum(a.driving_ms), 0) / 3600000.0),
        'drivers',     count(distinct a.driver_id),
        'today',       coalesce(sum(a.laps) filter (where a.day = current_date), 0),
        'week',        coalesce(sum(a.laps) filter (where a.day >= current_date - 6), 0),
        'month',       coalesce(sum(a.laps) filter (where a.day >= current_date - 29), 0),
        'driversToday', count(distinct a.driver_id) filter (where a.day = current_date),
        'driversWeek',  count(distinct a.driver_id) filter (where a.day >= current_date - 6)
      )
      from public.driver_activity_days a
    ),

    -- Laps per day over the window, for the chart. Days with no driving are
    -- absent; the client fills the gaps so an empty Tuesday reads as a zero
    -- bar rather than closing up.
    'lapsDaily', (
      select coalesce(json_agg(row_to_json(d) order by d.day), '[]'::json)
      from (
        select to_char(a.day, 'YYYY-MM-DD')  as day,
               sum(a.laps)::int              as laps,
               count(distinct a.driver_id)::int as drivers
        from public.driver_activity_days a
        where a.day >= v_from
        group by a.day
      ) d
    ),

    -- ---- Feature usage ----------------------------------------------------
    -- One row per slug. `users30d` over `activeMonth` is the adoption rate the
    -- pane sorts on; `uses` and `minutes` say whether the people who do use it
    -- use it once or live in it.
    'features', (
      select coalesce(json_agg(row_to_json(f) order by f.users30d desc, f.uses30d desc), '[]'::json)
      from (
        -- Aliases are QUOTED so Postgres keeps the camelCase: an unquoted
        -- `usersToday` folds to `userstoday` and row_to_json hands the panel a
        -- key it is not reading. Everything else in this object is camelCase
        -- because json_build_object takes the key as a literal.
        select u.feature,
               count(distinct u.user_id) filter (where u.day = current_date)::int      as "usersToday",
               count(distinct u.user_id) filter (where u.day >= current_date - 6)::int as users7d,
               count(distinct u.user_id)::int                                          as users30d,
               coalesce(sum(u.uses) filter (where u.day >= current_date - 6), 0)::int  as uses7d,
               coalesce(sum(u.uses), 0)::int                                           as uses30d,
               round(coalesce(sum(u.seconds), 0) / 60.0)::int                          as minutes30d,
               to_char(max(u.day), 'YYYY-MM-DD')                                       as "lastDay"
        from public.feature_usage u
        where u.day >= current_date - 29
        group by u.feature
      ) f
    ),

    -- Per-day users for the TAB slugs only, so the pane can draw a trend
    -- without shipping every action's series as well.
    'featuresDaily', (
      select coalesce(json_agg(row_to_json(fd) order by fd.day, fd.feature), '[]'::json)
      from (
        select to_char(u.day, 'YYYY-MM-DD') as day,
               u.feature,
               count(distinct u.user_id)::int as users
        from public.feature_usage u
        where u.day >= v_from and u.feature like 'tab:%'
        group by u.day, u.feature
      ) fd
    ),

    -- ---- Overlays ---------------------------------------------------------
    'overlays', (
      select coalesce(json_agg(row_to_json(o) order by o.users30d desc, o.loads30d desc), '[]'::json)
      from (
        -- Quoted aliases, same reason as `features` above.
        select v.overlay,
               count(distinct v.user_id) filter (where v.day = current_date and v.enabled)::int      as "usersToday",
               count(distinct v.user_id) filter (where v.day >= current_date - 6 and v.enabled)::int as users7d,
               count(distinct v.user_id) filter (where v.enabled)::int                               as users30d,
               count(distinct v.user_id) filter (where v.obs_loads > 0)::int                         as "obsUsers30d",
               coalesce(sum(v.obs_loads), 0)::int                                                    as loads30d,
               round(coalesce(sum(v.ingame_seconds), 0) / 3600.0)::int                               as "ingameHours30d",
               count(distinct v.user_id) filter (where v.ingame_seconds > 0)::int                    as "ingameUsers30d"
        from public.overlay_usage v
        where v.day >= current_date - 29
        group by v.overlay
      ) o
    ),

    -- How MANY overlays a driver runs at once — the shape of the fleet, not
    -- which ones. Counted over the last 7 days per driver, then histogrammed.
    'overlayCounts', (
      select coalesce(json_agg(row_to_json(h) order by h.n), '[]'::json)
      from (
        select n, count(*)::int as drivers
        from (
          select v.user_id, count(*)::int as n
          from public.overlay_usage v
          where v.day >= current_date - 6 and v.enabled
          group by v.user_id
        ) per_driver
        group by n
      ) h
    ),

    -- ---- Facts already in the database ------------------------------------
    -- These need no client version: they are counted from the tables the
    -- features themselves write, so the pane is useful the day it ships.
    'cloud', json_build_object(
      'engineerToday',    (select count(*) from public.engineer_calls where created_at >= current_date),
      'engineer7d',       (select count(*) from public.engineer_calls where created_at >= now() - interval '7 days'),
      'engineerDrivers7d',(select count(distinct user_id) from public.engineer_calls where created_at >= now() - interval '7 days'),
      'engineerDrivers30d',(select count(distinct user_id) from public.engineer_calls where created_at >= now() - interval '30 days'),
      'setupsLive',       (select count(*) from public.setups where is_public),
      'setupDownloads7d', (select count(*) from public.setup_downloads where created_at >= now() - interval '7 days'),
      'setupDrivers30d',  (select count(distinct user_id) from public.setup_downloads where created_at >= now() - interval '30 days'),
      'boardLaps',        (select count(*) from public.driver_best_laps),
      'boardDrivers30d',  (select count(distinct driver_id) from public.driver_best_laps where updated_at >= now() - interval '30 days'),
      'traces',           (select count(*) from public.lap_traces),
      'traceDrivers30d',  (select count(distinct driver_id) from public.lap_traces where updated_at >= now() - interval '30 days'),
      -- driver_relay stamps `published_at`, not `updated_at` (migration 0017).
      'relayDrivers7d',   (select count(distinct user_id) from public.driver_relay where published_at >= now() - interval '7 days')
    )
  ) into result;

  return result;
end;
$$;

revoke all on function public.admin_feature_analytics(int) from public, anon;
grant execute on function public.admin_feature_analytics(int) to authenticated;
