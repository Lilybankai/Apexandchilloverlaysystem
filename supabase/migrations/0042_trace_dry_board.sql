-- 0042 — submit_lap_trace compares against the DRY board lap.
--
-- Since 0021 a driver can hold three rows in driver_best_laps per
-- (track, class): dry, damp and wet. submit_lap_trace still selected "the"
-- board time without naming a condition, so for anyone who also had a damp or
-- wet lap there, `select ... into` took whichever row came first. A wet time
-- never equals the dry lap being traced, so the trace was refused as
-- `not_board_lap`, the client settled it, and the dry board showed no Compare
-- button for that driver from then on (found 2026-10-17: 13 board rows across
-- Le Mans, Fuji, Road Atlanta, Silverstone, Daytona, Monza).
--
-- Only dry traces are ever sent (lap_traces has no condition key, see
-- lapLog.traceNeedsSend), so the dry row is the only right comparison.
--
-- CREATE OR REPLACE with the identical signature: keeps the function's ACL
-- (no anon re-grant, the 0021 trap) and adds no PostgREST overload.

create or replace function public.submit_lap_trace(
  p_sim text,
  p_track_key text,
  p_track_name text,
  p_track_length_m integer,
  p_car_class text,
  p_car text,
  p_lap_ms integer,
  p_set_at timestamp with time zone default now(),
  p_s1_ms integer default null::integer,
  p_s2_ms integer default null::integer,
  p_s3_ms integer default null::integer,
  p_data jsonb default null::jsonb,
  p_app_version text default ''::text,
  p_fingerprint text default ''::text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid      uuid := (select auth.uid());
  v_class    text := upper(btrim(coalesce(p_car_class, '')));
  v_fp       text := left(btrim(coalesce(p_fingerprint, '')), 32);
  v_track_id uuid;
  v_best_ms  integer;
  v_setup_id uuid;
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
  if pg_column_size(p_data) > 524288 then
    return jsonb_build_object('accepted', false, 'reason', 'trace_too_large');
  end if;

  if v_s1 is null or v_s2 is null or v_s3 is null
     or v_s1 <= 0 or v_s2 <= 0 or v_s3 <= 0 then
    v_s1 := null; v_s2 := null; v_s3 := null;
  end if;

  v_track_id := public.resolve_track(p_sim, p_track_key, p_track_name, p_track_length_m);

  select lap_ms into v_best_ms
  from public.driver_best_laps
  where driver_id = v_uid and track_id = v_track_id and car_class = v_class
    and condition = 'dry';

  if v_best_ms is null then
    return jsonb_build_object('accepted', false, 'reason', 'no_board_lap');
  end if;
  if v_best_ms <> p_lap_ms then
    return jsonb_build_object('accepted', false, 'reason', 'not_board_lap');
  end if;

  -- The setup this lap was driven on, if the driver has shared it.
  v_setup_id := public.match_lap_setup(v_uid, v_class, p_lap_ms, v_fp);

  insert into public.lap_traces (
    driver_id, sim, track_id, car_class, lap_ms, car, set_at,
    s1_ms, s2_ms, s3_ms, data, app_version, fingerprint, setup_id
  ) values (
    v_uid, lower(btrim(coalesce(p_sim, ''))), v_track_id, v_class, p_lap_ms,
    btrim(coalesce(p_car, '')), coalesce(p_set_at, now()),
    v_s1, v_s2, v_s3, p_data, coalesce(p_app_version, ''), v_fp, v_setup_id
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
        fingerprint = excluded.fingerprint,
        setup_id    = excluded.setup_id,
        updated_at  = now();

  return jsonb_build_object('accepted', true, 'lap_ms', p_lap_ms, 'setupId', v_setup_id);
end;
$function$;
