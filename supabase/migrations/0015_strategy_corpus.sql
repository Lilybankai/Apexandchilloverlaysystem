-- 0015_strategy_corpus.sql — the strategy corpus: every driver's pit stops and
-- per-lap fuel/tyre consumption, gathered in one place.
--
-- ## Why
-- The strategy engine (docs/RACE-STRATEGY-ENGINE.md) fits its coefficients —
-- refuel rate, burn per lap, tyre degradation, service time — from two local
-- logs the app has kept since 0.96.0: ~/.apex-overlay/stops (one record per
-- pit visit) and the consumption block on every lap in ~/.apex-overlay/laps.
-- Both stayed on the driver's PC. One machine produces a handful of real race
-- stops a week, and the grid the table needs is (car class × track), so the
-- corpus only becomes a fit when every driver's rows land together. That is
-- what these two tables are.
--
-- ## Shape
-- Raw rows, one per stop / one per lap, with the record's own client-minted
-- UUID as the primary key. That makes every submit idempotent (a re-send after
-- a crash is a no-op) and keeps the log re-interrogable: no judgement is
-- applied at write time — a two-second garage visit is stored beside a real
-- refuel stop and the QUERY decides which is which, the same rule stopLog.ts
-- follows locally. Columns rather than a jsonb blob so the fit can be run in
-- SQL (see admin_strategy_corpus below).
--
-- ## Who sees what
-- Nobody but the owner and the admin aggregate. A stop or a lap is not a board
-- entry; there is no reason for one driver to read another's fuel numbers.
-- Both tables are select-OWN (so a driver can always be shown their own data)
-- and have no client write policy: writes go through the two SECURITY DEFINER
-- RPCs, which pin driver_id to auth.uid(). Admins see counts and medians via
-- admin_strategy_corpus(), never rows — the 0001 rule.
--
-- Both tables hang off profiles(id) ON DELETE CASCADE, so the delete-account
-- function's single auth delete empties them along with everything else.
--
-- Re-runnable: `if not exists` / `create or replace` / `drop policy if exists`.

-- ---------------------------------------------------------------------------
-- pit_stops — one row per completed pit visit (stopLog.ts StopRecord)
-- ---------------------------------------------------------------------------
create table if not exists public.pit_stops (
  -- The client's record id. Idempotency key: the uploader re-offers a row until
  -- the server says accepted, and a duplicate offer must not become two stops.
  id              uuid primary key,
  driver_id       uuid not null references public.profiles(id) on delete cascade,
  sim             text not null,
  track_id        uuid not null references public.tracks(id) on delete cascade,
  car_class       text not null,
  car             text not null default '',
  session_type    text not null default '',
  -- Lane exit, wall clock.
  stopped_at      timestamptz not null,
  -- Laps completed when the car entered the lane; which stop of the session.
  lap             integer not null default 0,
  stop_no         integer not null default 0,
  -- Entry to exit, seconds, limiter crawl included.
  lane_sec        real not null,
  -- Wheels-stopped seconds. NULL when the client had no speed channel
  -- (spectating, shared memory down) — never zero, which would read as an
  -- instant stop and poison a refuel-rate median.
  stationary_sec  real,
  -- The sim's own booked-service total, seconds: a prediction, kept so its
  -- accuracy against stationary_sec can be measured.
  booked_sec      real,
  fuel_added_l    real,
  fuel_before_l   real,
  fuel_after_l    real,
  ve_added_pct    real,
  -- Any corner's wear rose across the stop. A stop that changed tyres says
  -- nothing about refuel rate (LMU services in parallel), so the fit filters on
  -- this — but the row is stored either way.
  tyres_changed   boolean not null default false,
  -- [FL, FR, RL, RR], 1 = new.
  wear_before     real[],
  wear_after      real[],
  compound_fitted text,
  app_version     text not null default '',
  created_at      timestamptz not null default now()
);

comment on table public.pit_stops is
  'One row per pit visit, from every driver''s local stop log. Written only via submit_pit_stop(). Raw and unfiltered by design.';

create index if not exists pit_stops_track_class_idx on public.pit_stops (track_id, car_class);
create index if not exists pit_stops_driver_idx      on public.pit_stops (driver_id);
create index if not exists pit_stops_created_idx     on public.pit_stops (created_at);

alter table public.pit_stops enable row level security;

drop policy if exists pit_stops_select_own on public.pit_stops;
create policy pit_stops_select_own
  on public.pit_stops for select to authenticated
  using (driver_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- lap_consumption — one row per lap that carried the consumption block
-- (lapLog.ts LapRecord v5: fuel in/out, tyre wear at the line, stint position)
-- ---------------------------------------------------------------------------
create table if not exists public.lap_consumption (
  -- The lap's id (LapRecord.id), same idempotency story as pit_stops.
  id              uuid primary key,
  driver_id       uuid not null references public.profiles(id) on delete cascade,
  sim             text not null,
  track_id        uuid not null references public.tracks(id) on delete cascade,
  car_class       text not null,
  car             text not null default '',
  session_type    text not null default '',
  set_at          timestamptz not null,
  lap_ms          integer not null,
  -- The Apex clean rule as the client judged it, and why not. Stored, not
  -- re-derived: a burn measured on a lap that ran wide is still a burn, but the
  -- pace side of the fit must be able to leave it out.
  clean           boolean not null default false,
  dirty           text[] not null default '{}',
  fuel_start_l    real,
  fuel_end_l      real,
  -- Present only when the difference is a MEASUREMENT (no pit lane, no refuel
  -- mid-lap). The raw levels above are stored even when this is null.
  fuel_used_l     real,
  capacity_l      real,
  ve_start_pct    real,
  ve_end_pct      real,
  -- [FL, FR, RL, RR] at the line, 1 = new.
  wear_at_line    real[],
  compound        text,
  -- 1-based lap of the stint (out-lap = 1); the x-axis of the degradation fit.
  stint_lap       integer,
  is_out_lap      boolean not null default false,
  is_in_lap       boolean not null default false,
  track_temp_c    real,
  ambient_temp_c  real,
  wet             boolean,
  app_version     text not null default '',
  created_at      timestamptz not null default now()
);

comment on table public.lap_consumption is
  'Per-lap fuel and tyre readings from every driver''s local lap log (v5+ laps). Written only via submit_lap_consumption().';

create index if not exists lap_consumption_track_class_idx on public.lap_consumption (track_id, car_class);
create index if not exists lap_consumption_driver_idx      on public.lap_consumption (driver_id);
create index if not exists lap_consumption_created_idx     on public.lap_consumption (created_at);

alter table public.lap_consumption enable row level security;

drop policy if exists lap_consumption_select_own on public.lap_consumption;
create policy lap_consumption_select_own
  on public.lap_consumption for select to authenticated
  using (driver_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- submit_pit_stop — the only door into pit_stops
-- ---------------------------------------------------------------------------
-- Returns {accepted: true} on insert AND on a duplicate id (the row is there,
-- which is all the client needs to know), or {accepted: false, reason} for a
-- row that can never be accepted — the client caches those refusals and never
-- offers the row again, so every refusal here must be permanent by nature.
create or replace function public.submit_pit_stop(
  p_id              text,
  p_sim             text,
  p_track_key       text,
  p_track_name      text,
  p_track_length_m  integer,
  p_car_class       text,
  p_car             text default '',
  p_session_type    text default '',
  p_stopped_at      timestamptz default now(),
  p_lap             integer default 0,
  p_stop_no         integer default 0,
  p_lane_sec        real default null,
  p_stationary_sec  real default null,
  p_booked_sec      real default null,
  p_fuel_added_l    real default null,
  p_fuel_before_l   real default null,
  p_fuel_after_l    real default null,
  p_ve_added_pct    real default null,
  p_tyres_changed   boolean default false,
  p_wear_before     real[] default null,
  p_wear_after      real[] default null,
  p_compound_fitted text default null,
  p_app_version     text default ''
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_id       uuid;
  v_class    text := upper(btrim(coalesce(p_car_class, '')));
  v_track_id uuid;
  v_stat     real := p_stationary_sec;
begin
  if v_uid is null then
    raise exception 'submit_pit_stop: not authenticated';
  end if;

  begin
    v_id := p_id::uuid;
  exception when others then
    return jsonb_build_object('accepted', false, 'reason', 'bad_id');
  end;

  if v_class = '' then
    return jsonb_build_object('accepted', false, 'reason', 'unknown_class');
  end if;
  -- Same window the client's stop recorder discards outside of: under three
  -- seconds is a torn read, over fifteen minutes is a car parked for good.
  if p_lane_sec is null or p_lane_sec < 3 or p_lane_sec > 900 then
    return jsonb_build_object('accepted', false, 'reason', 'implausible_lane');
  end if;
  -- The client sends -1 (UNKNOWN_VALUE) for "no speed channel"; store the
  -- honest NULL rather than a negative duration.
  if v_stat is not null and v_stat < 0 then
    v_stat := null;
  end if;
  if (p_wear_before is not null and array_length(p_wear_before, 1) <> 4)
     or (p_wear_after is not null and array_length(p_wear_after, 1) <> 4) then
    return jsonb_build_object('accepted', false, 'reason', 'bad_wear');
  end if;

  v_track_id := public.resolve_track(p_sim, p_track_key, p_track_name, p_track_length_m);

  insert into public.pit_stops (
    id, driver_id, sim, track_id, car_class, car, session_type, stopped_at,
    lap, stop_no, lane_sec, stationary_sec, booked_sec,
    fuel_added_l, fuel_before_l, fuel_after_l, ve_added_pct,
    tyres_changed, wear_before, wear_after, compound_fitted, app_version
  ) values (
    v_id, v_uid, lower(btrim(coalesce(p_sim, ''))), v_track_id, v_class,
    btrim(coalesce(p_car, '')), lower(btrim(coalesce(p_session_type, ''))),
    coalesce(p_stopped_at, now()),
    coalesce(p_lap, 0), coalesce(p_stop_no, 0), p_lane_sec, v_stat, p_booked_sec,
    p_fuel_added_l, p_fuel_before_l, p_fuel_after_l, p_ve_added_pct,
    coalesce(p_tyres_changed, false), p_wear_before, p_wear_after,
    nullif(btrim(coalesce(p_compound_fitted, '')), ''), coalesce(p_app_version, '')
  )
  on conflict (id) do nothing;

  return jsonb_build_object('accepted', true);
end;
$$;

revoke all on function public.submit_pit_stop from public, anon;
grant execute on function public.submit_pit_stop to authenticated;

-- ---------------------------------------------------------------------------
-- submit_lap_consumption — the only door into lap_consumption
-- ---------------------------------------------------------------------------
create or replace function public.submit_lap_consumption(
  p_id              text,
  p_sim             text,
  p_track_key       text,
  p_track_name      text,
  p_track_length_m  integer,
  p_car_class       text,
  p_car             text default '',
  p_session_type    text default '',
  p_set_at          timestamptz default now(),
  p_lap_ms          integer default null,
  p_clean           boolean default false,
  p_dirty           text[] default '{}',
  p_fuel_start_l    real default null,
  p_fuel_end_l      real default null,
  p_fuel_used_l     real default null,
  p_capacity_l      real default null,
  p_ve_start_pct    real default null,
  p_ve_end_pct      real default null,
  p_wear_at_line    real[] default null,
  p_compound        text default null,
  p_stint_lap       integer default null,
  p_is_out_lap      boolean default false,
  p_is_in_lap       boolean default false,
  p_track_temp_c    real default null,
  p_ambient_temp_c  real default null,
  p_wet             boolean default null,
  p_app_version     text default ''
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_id       uuid;
  v_class    text := upper(btrim(coalesce(p_car_class, '')));
  v_track_id uuid;
begin
  if v_uid is null then
    raise exception 'submit_lap_consumption: not authenticated';
  end if;

  begin
    v_id := p_id::uuid;
  exception when others then
    return jsonb_build_object('accepted', false, 'reason', 'bad_id');
  end;

  if v_class = '' then
    return jsonb_build_object('accepted', false, 'reason', 'unknown_class');
  end if;
  if p_lap_ms is null or p_lap_ms < 5000 or p_lap_ms > 3600000 then
    return jsonb_build_object('accepted', false, 'reason', 'implausible_time');
  end if;
  -- A lap with neither a fuel reading nor a wear reading has nothing to teach
  -- a fit; the client should never offer one, and if it does the answer will
  -- not change on retry.
  if p_fuel_start_l is null and p_wear_at_line is null then
    return jsonb_build_object('accepted', false, 'reason', 'no_consumption');
  end if;
  if p_wear_at_line is not null and array_length(p_wear_at_line, 1) <> 4 then
    return jsonb_build_object('accepted', false, 'reason', 'bad_wear');
  end if;

  v_track_id := public.resolve_track(p_sim, p_track_key, p_track_name, p_track_length_m);

  insert into public.lap_consumption (
    id, driver_id, sim, track_id, car_class, car, session_type, set_at, lap_ms,
    clean, dirty, fuel_start_l, fuel_end_l, fuel_used_l, capacity_l,
    ve_start_pct, ve_end_pct, wear_at_line, compound, stint_lap,
    is_out_lap, is_in_lap, track_temp_c, ambient_temp_c, wet, app_version
  ) values (
    v_id, v_uid, lower(btrim(coalesce(p_sim, ''))), v_track_id, v_class,
    btrim(coalesce(p_car, '')), lower(btrim(coalesce(p_session_type, ''))),
    coalesce(p_set_at, now()), p_lap_ms,
    coalesce(p_clean, false), coalesce(p_dirty, '{}'),
    p_fuel_start_l, p_fuel_end_l, p_fuel_used_l, p_capacity_l,
    p_ve_start_pct, p_ve_end_pct, p_wear_at_line,
    nullif(btrim(coalesce(p_compound, '')), ''), p_stint_lap,
    coalesce(p_is_out_lap, false), coalesce(p_is_in_lap, false),
    p_track_temp_c, p_ambient_temp_c, p_wet, coalesce(p_app_version, '')
  )
  on conflict (id) do nothing;

  return jsonb_build_object('accepted', true);
end;
$$;

revoke all on function public.submit_lap_consumption from public, anon;
grant execute on function public.submit_lap_consumption to authenticated;

-- ---------------------------------------------------------------------------
-- admin_strategy_corpus — "do we have enough data yet?", answered in one call
-- ---------------------------------------------------------------------------
-- Aggregates only, behind is_admin(). The headline counts say how big the
-- corpus is; the per-(class, track) rows say where it is deep enough to fit
-- and what the medians currently read. Definitions, so the numbers mean the
-- same thing every time they are read:
--
--   raceStops     — session_type = 'race' and at least 5 s stationary: a real
--                   service, not a drive-through or a garage visit.
--   fuelStops     — raceStops that added ≥ 5 L and changed no tyres: the only
--                   stops a refuel rate can be divided out of.
--   refuelLPerSec — median of fuel_added_l / stationary_sec over fuelStops.
--   burnLaps      — laps with a measured fuel_used_l on a clean lap.
--   burnLPerLap   — median fuel_used_l over burnLaps.
--   wearLaps      — laps with wear at the line AND a stint position, i.e. a
--                   point that can sit on the degradation curve.
create or replace function public.admin_strategy_corpus()
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
    'stops',      (select count(*) from public.pit_stops),
    'raceStops',  (select count(*) from public.pit_stops
                     where session_type = 'race' and stationary_sec >= 5),
    'fuelStops',  (select count(*) from public.pit_stops
                     where session_type = 'race' and stationary_sec >= 5
                       and fuel_added_l >= 5 and not tyres_changed),
    'stops7d',    (select count(*) from public.pit_stops
                     where created_at >= now() - interval '7 days'),
    'laps',       (select count(*) from public.lap_consumption),
    'burnLaps',   (select count(*) from public.lap_consumption
                     where fuel_used_l is not null and clean),
    'wearLaps',   (select count(*) from public.lap_consumption
                     where wear_at_line is not null and stint_lap is not null),
    'laps7d',     (select count(*) from public.lap_consumption
                     where created_at >= now() - interval '7 days'),
    'drivers',    (select count(*) from (
                     select driver_id from public.pit_stops
                     union
                     select driver_id from public.lap_consumption
                   ) d),
    'rows', (
      select coalesce(json_agg(row_to_json(r) order by (r."burnLaps" + r."raceStops") desc, r."carClass", r.track), '[]'::json)
      from (
        with keys as (
          select track_id, car_class from public.pit_stops
          union
          select track_id, car_class from public.lap_consumption
        ),
        stop_agg as (
          select track_id, car_class,
                 count(*) as stops,
                 count(*) filter (where session_type = 'race' and stationary_sec >= 5) as race_stops,
                 count(*) filter (where session_type = 'race' and stationary_sec >= 5
                                    and fuel_added_l >= 5 and not tyres_changed) as fuel_stops,
                 percentile_cont(0.5) within group (order by fuel_added_l / stationary_sec)
                   filter (where session_type = 'race' and stationary_sec >= 5
                             and fuel_added_l >= 5 and not tyres_changed) as refuel_l_per_sec
          from public.pit_stops
          group by track_id, car_class
        ),
        lap_agg as (
          select track_id, car_class,
                 count(*) as laps,
                 count(*) filter (where fuel_used_l is not null and clean) as burn_laps,
                 percentile_cont(0.5) within group (order by fuel_used_l)
                   filter (where fuel_used_l is not null and clean) as burn_l_per_lap,
                 count(*) filter (where wear_at_line is not null and stint_lap is not null) as wear_laps
          from public.lap_consumption
          group by track_id, car_class
        ),
        driver_agg as (
          select track_id, car_class, count(distinct driver_id) as drivers
          from (
            select track_id, car_class, driver_id from public.pit_stops
            union
            select track_id, car_class, driver_id from public.lap_consumption
          ) u
          group by track_id, car_class
        )
        select k.car_class                                  as "carClass",
               coalesce(t.name, '?')                        as track,
               coalesce(s.stops, 0)                         as stops,
               coalesce(s.race_stops, 0)                    as "raceStops",
               coalesce(s.fuel_stops, 0)                    as "fuelStops",
               round(s.refuel_l_per_sec::numeric, 2)        as "refuelLPerSec",
               coalesce(l.laps, 0)                          as laps,
               coalesce(l.burn_laps, 0)                     as "burnLaps",
               round(l.burn_l_per_lap::numeric, 2)          as "burnLPerLap",
               coalesce(l.wear_laps, 0)                     as "wearLaps",
               coalesce(d.drivers, 0)                       as drivers
        from keys k
        left join public.tracks t on t.id = k.track_id
        left join stop_agg   s on s.track_id = k.track_id and s.car_class = k.car_class
        left join lap_agg    l on l.track_id = k.track_id and l.car_class = k.car_class
        left join driver_agg d on d.track_id = k.track_id and d.car_class = k.car_class
      ) r
    )
  ) into result;
  return result;
end;
$$;

revoke all on function public.admin_strategy_corpus() from public, anon;
grant execute on function public.admin_strategy_corpus() to authenticated;
