-- 0004_lap_traces.sql — driving traces for board laps: the training feature's data.
--
-- One trace per (driver, sim, track, class) — the same identity as
-- driver_best_laps, because the trace stored here is the one belonging to the
-- lap on the board. When a faster lap replaces the board entry, its trace
-- replaces this row. History is not kept server-side: the driver's own machine
-- keeps every lap's trace locally (~/.apex-overlay/traces); the cloud holds
-- exactly what the "click a lap time and learn from it" flow needs.
--
-- The trace payload is a columnar JSON object recorded by the overlay at frame
-- rate (see src/telemetry/lapTrace.ts): index-aligned arrays for lap-distance
-- fraction, lap time, throttle, brake, steering, gear, speed, lateral and
-- longitudinal G, and TC/ABS intervention. ~1000–2000 points, tens of KB as
-- jsonb.

create table public.lap_traces (
  driver_id   uuid not null references public.profiles(id) on delete cascade,
  sim         text not null,
  track_id    uuid not null references public.tracks(id) on delete cascade,
  car_class   text not null,
  -- The lap this trace was driven on. Must equal the driver_best_laps row's
  -- lap_ms at submit time, which is the whole integrity story: a trace can
  -- only ever describe the lap the board is showing.
  lap_ms      int  not null,
  car         text not null default '',
  set_at      timestamptz not null,
  -- Sector splits in ms (durations, not cumulative), when the sim published
  -- them for this lap. All three or none, enforced at submit.
  s1_ms       int,
  s2_ms       int,
  s3_ms       int,
  data        jsonb not null,
  app_version text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Same identity as driver_best_laps: sim is a property of the track row
  -- (resolve_track is per-sim), not part of the key.
  primary key (driver_id, track_id, car_class)
);

comment on table public.lap_traces is
  'Driving trace of each driver''s board-best lap per track/class. Written only via submit_lap_trace().';

alter table public.lap_traces enable row level security;

-- Anyone signed in can read any trace — that is the point: you click someone
-- else''s lap time to learn from it. Same visibility as driver_best_laps.
create policy lap_traces_select_authenticated
  on public.lap_traces for select to authenticated using (true);

-- No insert/update/delete policies: writes go through the RPC below, which is
-- SECURITY DEFINER and pins the row to auth.uid().

create or replace function public.submit_lap_trace(
  p_sim            text,
  p_track_key      text,
  p_track_name     text,
  p_track_length_m integer,
  p_car_class      text,
  p_car            text,
  p_lap_ms         integer,
  p_set_at         timestamptz default now(),
  p_s1_ms          integer default null,
  p_s2_ms          integer default null,
  p_s3_ms          integer default null,
  p_data           jsonb default null,
  p_app_version    text default ''
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_class    text := upper(btrim(coalesce(p_car_class, '')));
  v_track_id uuid;
  v_best_ms  integer;
  v_s1       integer := p_s1_ms;
  v_s2       integer := p_s2_ms;
  v_s3       integer := p_s3_ms;
begin
  if v_uid is null then
    raise exception 'submit_lap_trace: not authenticated';
  end if;

  if v_class = '' then
    return jsonb_build_object('accepted', false, 'reason', 'unknown_class');
  end if;
  if p_lap_ms is null or p_lap_ms < 5000 or p_lap_ms > 3600000 then
    return jsonb_build_object('accepted', false, 'reason', 'implausible_time');
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    return jsonb_build_object('accepted', false, 'reason', 'no_trace');
  end if;
  -- A trace is a few tens of KB. Ten times that is not a bigger trace, it is a
  -- different (or misbehaving) client, and refusing is permanent by design.
  if pg_column_size(p_data) > 524288 then
    return jsonb_build_object('accepted', false, 'reason', 'trace_too_large');
  end if;

  -- Sector splits stand together or not at all — two real sectors and a wrong
  -- one reads as a timing screen that lies (same rule as the client's lapLog).
  if v_s1 is null or v_s2 is null or v_s3 is null
     or v_s1 <= 0 or v_s2 <= 0 or v_s3 <= 0 then
    v_s1 := null; v_s2 := null; v_s3 := null;
  end if;

  v_track_id := public.resolve_track(p_sim, p_track_key, p_track_name, p_track_length_m);

  -- The trace must describe the lap that is actually ON the board. The client
  -- sends bests before traces inside a run, so by the time a trace arrives the
  -- board row exists; a mismatch means a faster lap has since replaced it, and
  -- this trace is permanently stale rather than retryable.
  select lap_ms into v_best_ms
  from public.driver_best_laps
  where driver_id = v_uid and track_id = v_track_id and car_class = v_class;

  if v_best_ms is null then
    return jsonb_build_object('accepted', false, 'reason', 'no_board_lap');
  end if;
  if v_best_ms <> p_lap_ms then
    return jsonb_build_object('accepted', false, 'reason', 'not_board_lap');
  end if;

  insert into public.lap_traces (
    driver_id, sim, track_id, car_class, lap_ms, car, set_at,
    s1_ms, s2_ms, s3_ms, data, app_version
  ) values (
    v_uid, lower(btrim(coalesce(p_sim, ''))), v_track_id, v_class, p_lap_ms,
    btrim(coalesce(p_car, '')), coalesce(p_set_at, now()),
    v_s1, v_s2, v_s3, p_data, coalesce(p_app_version, '')
  )
  on conflict (driver_id, track_id, car_class) do update
    set sim         = excluded.sim,
        lap_ms      = excluded.lap_ms,
        car         = excluded.car,
        set_at      = excluded.set_at,
        s1_ms       = excluded.s1_ms,
        s2_ms       = excluded.s2_ms,
        s3_ms       = excluded.s3_ms,
        data        = excluded.data,
        app_version = excluded.app_version,
        updated_at  = now();

  return jsonb_build_object('accepted', true, 'lap_ms', p_lap_ms);
end;
$$;

-- Callable by signed-in clients only; definer rights stay locked down.
revoke all on function public.submit_lap_trace from public, anon;
grant execute on function public.submit_lap_trace to authenticated;
