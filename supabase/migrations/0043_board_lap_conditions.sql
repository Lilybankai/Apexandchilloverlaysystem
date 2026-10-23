-- 0043_board_lap_conditions.sql — what a board lap was set in, on hover.
--
-- Carl, 2026-10-23: "lots of people set their fastest times as quali laps, and
-- there's no accurate way to show the conditions a lap was set in." The board
-- row carried driver, car and time; hovering a time now shows the session it
-- was set in, track and air temperature, the fuel in the car as the lap began
-- (and that as a share of the tank), the virtual energy left, and the compound.
--
-- NO NEW COLUMN. Every one of those values already lives, or from this release
-- will live, in `driver_best_laps.conditions` — the jsonb `submit_lap` has
-- stored since the board existed (as sent, minus `pace`, see 0034):
--
--   sessionType, trackTempC, ambientTempC   on every row (719 of 719, 2026-10-23)
--   fuelStartL, capacityL, veStartPct,      sent by 1.3.13+ (lapLog.boardLapConditions);
--   compound                                absent on every row before that
--
-- So the client needed no new RPC argument (a new argument costs a PostgREST
-- overload, the 0021 trap) and an old server stores the new keys untouched.
-- What was missing is the READ: `leaderboard()` returned a ranking and nothing
-- about the lap. This migration only widens what the two board functions
-- return. It writes no rows and changes no table.
--
-- Typed columns rather than the raw jsonb: the app gets numbers it does not
-- have to re-validate, and a key a future client adds to `conditions` does not
-- leak onto every board by accident. Each value is extracted defensively —
-- `::real` on a string that is not a number would raise and take the WHOLE
-- board down for every driver, so a field is cast only when its jsonb type is
-- 'number' and is null otherwise. (`jsonb_typeof(NULL)` is NULL, not false,
-- the 0020 trap — the CASE below treats that as "no value", which is right.)
--
-- Return-type change means DROP and CREATE (Postgres cannot CREATE OR REPLACE
-- a function into a different result shape). The argument lists are UNCHANGED,
-- so no overload appears and every installed client resolves exactly as
-- before; old clients ignore the extra columns, new clients reading an old
-- server just find them missing and draw no marker.
--
-- The 0021 ACL trap applies to both functions: a recreated function loses its
-- ACL and picks up Supabase's default privileges, which grant EXECUTE to anon.
-- `revoke ... from public` does not remove that, so anon is revoked by name.
-- Before applying, snapshot:
--
--   select p.oid::regprocedure, p.proacl from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname in ('leaderboard', 'board_for_lap');
--
-- Both read {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
-- on 2026-10-23 and must read exactly that again afterwards.
--
-- One transaction: a failure part-way leaves the old functions in place.

begin;

-- ---------------------------------------------------------------------------
-- 1. leaderboard — the ranking, plus the lap's conditions
-- ---------------------------------------------------------------------------

drop function if exists public.leaderboard(text, uuid, text, text, integer, text);

create function public.leaderboard(
  p_sim text default 'lmu',
  p_track_id uuid default null,
  p_car_class text default null,
  p_car text default null,
  p_limit integer default 100,
  p_condition text default 'dry'
)
returns table(
  rank integer, driver_id uuid, display_name text, car text,
  lap_ms integer, gap_ms integer, set_at timestamptz, is_you boolean,
  has_trace boolean, has_line boolean, condition text, wetness real,
  legacy_wet boolean,
  -- 0043: the conditions the lap was set in. Null when not recorded.
  session_type text, track_temp_c real, air_temp_c real,
  fuel_start_l real, fuel_capacity_l real, ve_start_pct real, compound text
)
language sql
stable
set search_path to 'public'
as $function$
  with board as (
    select
      b.driver_id,
      coalesce(d.display_name, 'Driver') as display_name,
      b.car,
      b.lap_ms,
      b.set_at,
      b.condition,
      nullif(b.conditions ->> 'wetness', '')::real as wetness,
      (b.conditions ->> 'wetness' is null
        and coalesce((b.conditions ->> 'wet')::boolean, false))      as legacy_wet,
      (t.lap_ms is not null and t.lap_ms = b.lap_ms)                as has_trace,
      (t.lap_ms is not null and t.lap_ms = b.lap_ms and t.has_line) as has_line,
      -- Session category as the app names it: practice | qualifying | race |
      -- warmup | testday. Bounded, because it is a client-supplied string.
      nullif(left(btrim(case when jsonb_typeof(b.conditions -> 'sessionType') = 'string'
                             then b.conditions ->> 'sessionType' end), 16), '') as session_type,
      case when jsonb_typeof(b.conditions -> 'trackTempC') = 'number'
           then (b.conditions ->> 'trackTempC')::real end              as track_temp_c,
      case when jsonb_typeof(b.conditions -> 'ambientTempC') = 'number'
           then (b.conditions ->> 'ambientTempC')::real end            as air_temp_c,
      -- Litres in the tank as the lap BEGAN — read at the line by the lap
      -- recorder, not at upload time.
      case when jsonb_typeof(b.conditions -> 'fuelStartL') = 'number'
           then (b.conditions ->> 'fuelStartL')::real end              as fuel_start_l,
      case when jsonb_typeof(b.conditions -> 'capacityL') = 'number'
           then (b.conditions ->> 'capacityL')::real end               as fuel_capacity_l,
      case when jsonb_typeof(b.conditions -> 'veStartPct') = 'number'
           then (b.conditions ->> 'veStartPct')::real end              as ve_start_pct,
      nullif(left(btrim(case when jsonb_typeof(b.conditions -> 'compound') = 'string'
                             then b.conditions ->> 'compound' end), 32), '') as compound
    from public.driver_best_laps b
    left join public.public_drivers d on d.id = b.driver_id
    left join public.lap_traces t
           on t.driver_id = b.driver_id
          and t.track_id  = b.track_id
          and t.car_class = b.car_class
    where b.sim = coalesce(p_sim, b.sim)
      and (p_track_id is null or b.track_id = p_track_id)
      and (p_car_class is null or b.car_class = p_car_class)
      and (p_car is null or b.car = p_car)
      and (p_condition is null or b.condition = lower(btrim(p_condition)))
  )
  select
    (row_number() over (order by lap_ms asc, set_at asc))::int as rank,
    driver_id,
    display_name,
    car,
    lap_ms,
    nullif(lap_ms - min(lap_ms) over (), 0)::int as gap_ms,
    set_at,
    coalesce(driver_id = auth.uid(), false) as is_you,
    has_trace,
    has_line,
    condition,
    wetness,
    legacy_wet,
    session_type,
    track_temp_c,
    air_temp_c,
    fuel_start_l,
    fuel_capacity_l,
    ve_start_pct,
    compound
  from board
  order by lap_ms asc, set_at asc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$function$;

revoke all on function public.leaderboard(text, uuid, text, text, integer, text) from public, anon;
grant execute on function public.leaderboard(text, uuid, text, text, integer, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. board_for_lap — Review's entry point, same columns through `l.*`
-- ---------------------------------------------------------------------------
--
-- Its body is unchanged; it is recreated only because `l.*` now carries seven
-- more columns and the declared result has to say so.

drop function if exists public.board_for_lap(text, text, text, integer, text);

create function public.board_for_lap(
  p_sim text,
  p_track_key text,
  p_car_class text,
  p_limit integer default 200,
  p_condition text default 'dry'
)
returns table(
  track_id uuid, rank integer, driver_id uuid, display_name text, car text,
  lap_ms integer, gap_ms integer, set_at timestamptz, is_you boolean,
  has_trace boolean, has_line boolean, condition text, wetness real,
  legacy_wet boolean,
  session_type text, track_temp_c real, air_temp_c real,
  fuel_start_l real, fuel_capacity_l real, ve_start_pct real, compound text
)
language sql
stable
set search_path to 'public'
as $function$
  with t as (
    select a.track_id
    from public.track_aliases a
    where a.sim = lower(btrim(coalesce(p_sim, '')))
      and a.raw_key = lower(btrim(coalesce(p_track_key, '')))
    limit 1
  )
  select t.track_id, l.*
  from t, public.leaderboard(
    lower(btrim(coalesce(p_sim, ''))),
    t.track_id,
    upper(btrim(coalesce(p_car_class, ''))),
    null,
    p_limit,
    lower(btrim(coalesce(p_condition, 'dry')))
  ) l;
$function$;

revoke all on function public.board_for_lap(text, text, text, integer, text) from public, anon;
grant execute on function public.board_for_lap(text, text, text, integer, text)
  to authenticated, service_role;

commit;

-- After applying, check (all read-only):
--   1. the proacl snapshot above is unchanged for both functions;
--   2. has_function_privilege('anon', 'public.leaderboard(text,uuid,text,text,integer,text)', 'execute') is false;
--   3. a board still ranks identically, e.g. md5 over (rank, driver_id, lap_ms, gap_ms)
--      of the busiest dry board before and after;
--   4. select count(*) filter (where track_temp_c is not null) from the same board
--      equals its row count (every existing row carries temperatures).
