-- 0047_iracing_boards.sql — iRacing gets its own leaderboards; LMU's are untouched.
--
-- 2026-11-10. The owner asked for "a whole new area specifically for iRacing
-- that has its own system, but runs and looks the exact same way as the LMU
-- stuff". The schema was built for this from day one: `tracks` is unique on
-- (sim, slug), `track_aliases` is keyed (sim, raw_key), `resolve_track` makes
-- one tracks row per sim, and every board table (driver_best_laps, lap_traces,
-- driver_activity_days, lap_consumption, notification_events.board_key) keys
-- on track_id. An iRacing lap at "Spa" therefore resolves to a DIFFERENT
-- tracks row from LMU's Spa and can never land on, displace or rank against an
-- LMU board row. Every read RPC already takes p_sim, and every installed
-- client sends p_sim => 'lmu' explicitly. No parallel tables.
--
-- What this file adds, and nothing else:
--   1. Known sims only. tracks / track_aliases are checked to ('lmu',
--      'iracing'); resolve_track raises on anything else; submit_lap,
--      submit_lap_trace and submit_activity REFUSE an unknown sim with
--      { accepted: false, reason: 'unknown_sim' } before touching anything —
--      a refusal the uploader caches, so a junk row is never retried.
--   2. submit_lap keeps the reference pace on LMU laps only (Ohne Speed's sheet
--      is LMU lap times; an iRacing lap must never carry a score to Discord).
--   3. driver_best_laps.sim and lap_traces.sim are pinned to their track's sim
--      by a trigger, so the column the board RPCs filter on can never disagree
--      with the track the row is keyed on.
--   4. The board index is repaired. 0021's `create index if not exists` was a
--      no-op because the old index had the same name: live it is still the
--      pre-0021 (track_id, car_class, lap_ms). Rebuilt with the condition in it,
--      plus an index on sim for leaderboard_filters(p_sim).
--   5. Discord: discord_targets.sims (default {lmu}) and the fan-out honours it,
--      so iRacing PBs and records never post into an LMU league's channel. A
--      channel announces iRacing only when its owner adds it.
--
-- Signatures: every function below is CREATE OR REPLACE with its LIVE
-- signature and defaults (bodies taken from pg_get_functiondef on 2026-11-10,
-- with only the marked 0047 lines added). Unchanged signatures mean no
-- PostgREST overload (the 0021 trap) and no ACL reset (the drop/recreate ->
-- anon trap): CREATE OR REPLACE keeps each function's existing grants. The one
-- NEW function (the trigger function) has EXECUTE revoked from public, anon
-- and authenticated explicitly, because new functions pick up Supabase's
-- default grants.
--
-- No row is written. No backfill: every existing row is sim = 'lmu' (820 best
-- laps, 35 tracks, 35 aliases, 635 traces, all LMU on 2026-11-10).
--
-- Deliberately NOT changed: the unique keys (sim is implied by track_id), the
-- lap_traces PK, the leaderboard / leaderboard_filters / board_for_lap /
-- track_keys / get_lap_trace signatures, and submit_lap_consumption /
-- submit_pit_stop (they reach resolve_track, which now raises on an unknown
-- sim; the app does not upload corpus rows for non-LMU laps at all).

begin;

-- ------------------------------------------------------------- 1. known sims
-- NOT VALID + VALIDATE: the check is added under a light lock and the scan
-- that proves the existing rows is a separate, non-blocking step.
alter table public.tracks
  add constraint tracks_sim_check check (sim in ('lmu', 'iracing')) not valid;
alter table public.tracks validate constraint tracks_sim_check;

alter table public.track_aliases
  add constraint track_aliases_sim_check check (sim in ('lmu', 'iracing')) not valid;
alter table public.track_aliases validate constraint track_aliases_sim_check;

-- ------------------------------------------------------------ 2. resolve_track
-- Live body + the known-sims guard.
CREATE OR REPLACE FUNCTION public.resolve_track(p_sim text, p_raw_key text, p_name text, p_length_m integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_track_id uuid;
  v_sim      text := lower(btrim(coalesce(p_sim, '')));
  v_key      text := lower(btrim(coalesce(p_raw_key, '')));
  v_name     text := btrim(coalesce(p_name, ''));
begin
  if v_sim = '' or v_key = '' then
    raise exception 'resolve_track: sim and track key are required';
  end if;
  -- 0047: the sims that have boards. The submit_* writers refuse anything
  -- else with `unknown_sim` before they get here; this is for every other
  -- caller (the corpus writers), and the tracks/track_aliases checks back it.
  if v_sim not in ('lmu', 'iracing') then
    raise exception 'resolve_track: unknown sim %', v_sim using errcode = '22023';
  end if;
  if v_name = '' then
    v_name := v_key;
  end if;

  -- Known key? Then we already know which track it means, even if an admin has
  -- since pointed it somewhere other than the track it originally created.
  select track_id into v_track_id
  from public.track_aliases
  where sim = v_sim and raw_key = v_key;

  if v_track_id is not null then
    return v_track_id;
  end if;

  -- First sighting. ON CONFLICT rather than a check-then-insert because two
  -- drivers can land on a brand-new circuit in the same second.
  insert into public.tracks (sim, slug, name, length_m)
  values (v_sim, v_key, v_name, nullif(p_length_m, 0))
  on conflict (sim, slug) do update
    set name = coalesce(nullif(excluded.name, ''), public.tracks.name)
  returning id into v_track_id;

  insert into public.track_aliases (sim, raw_key, track_id)
  values (v_sim, v_key, v_track_id)
  on conflict (sim, raw_key) do nothing;

  return v_track_id;
end;
$function$;

-- --------------------------------------------------------------- 3. submit_lap
-- Live body (as deployed: 0021 + 0026 + 0034) + v_sim, the unknown_sim
-- refusal, and the reference pace for LMU laps only.
CREATE OR REPLACE FUNCTION public.submit_lap(p_sim text, p_track_key text, p_track_name text, p_track_length_m integer, p_car_class text, p_car text, p_lap_ms integer, p_set_at timestamp with time zone DEFAULT now(), p_conditions jsonb DEFAULT '{}'::jsonb, p_app_version text DEFAULT ''::text, p_condition text DEFAULT 'dry'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid      uuid := (select auth.uid());
  v_sim      text := lower(btrim(coalesce(p_sim, '')));
  v_class    text := upper(btrim(coalesce(p_car_class, '')));
  v_cond     text := lower(btrim(coalesce(p_condition, 'dry')));
  v_set_at   timestamptz := coalesce(p_set_at, now());
  v_track_id uuid;
  v_prev_ms  integer;
  v_rows     integer;
  v_improved boolean := false;
  v_best_ms  integer;
  v_rank     integer;
  v_lead_id     uuid;
  v_lead_ms     integer;
  v_lead_set_at timestamptz;
  v_entries     integer := 0;
  v_prev_rank   integer;
  v_kind        text;
  v_pace_in     jsonb := coalesce(p_conditions, '{}'::jsonb) -> 'pace';
  v_pace        jsonb;
  v_ref_ms      integer;
  v_pct         numeric;
begin
  if v_uid is null then
    raise exception 'submit_lap: not authenticated';
  end if;
  if not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'submit_lap: no profile for this account';
  end if;

  -- 0047: only the sims that have boards. A settled refusal, not an error:
  -- the uploader caches `accepted: false` and never retries the row.
  if v_sim not in ('lmu', 'iracing') then
    return jsonb_build_object('accepted', false, 'reason', 'unknown_sim');
  end if;
  if v_class = '' then
    return jsonb_build_object('accepted', false, 'reason', 'unknown_class');
  end if;
  if v_cond not in ('dry', 'damp', 'wet') then
    v_cond := 'dry';
  end if;
  if p_lap_ms is null or p_lap_ms < 5000 or p_lap_ms > 3600000 then
    return jsonb_build_object('accepted', false, 'reason', 'implausible_time');
  end if;
  if v_set_at > now() + interval '1 day' or v_set_at < now() - interval '365 days' then
    return jsonb_build_object('accepted', false, 'reason', 'clock_skew');
  end if;

  v_track_id := public.resolve_track(p_sim, p_track_key, p_track_name, p_track_length_m);

  select lap_ms into v_prev_ms
  from public.driver_best_laps
  where driver_id = v_uid and track_id = v_track_id
    and car_class = v_class and condition = v_cond;

  select b.driver_id, b.lap_ms, b.set_at
    into v_lead_id, v_lead_ms, v_lead_set_at
  from public.driver_best_laps b
  where b.track_id = v_track_id and b.car_class = v_class and b.condition = v_cond
  order by b.lap_ms asc, b.set_at asc
  limit 1;

  select count(distinct b.driver_id) into v_entries
  from public.driver_best_laps b
  where b.track_id = v_track_id and b.car_class = v_class and b.condition = v_cond;

  if v_prev_ms is not null then
    select count(*) + 1 into v_prev_rank
    from public.driver_best_laps b
    where b.track_id = v_track_id and b.car_class = v_class and b.condition = v_cond
      and b.lap_ms < v_prev_ms;
  end if;

  insert into public.driver_best_laps (
    driver_id, track_id, car_class, condition, lap_ms, car, sim, set_at,
    conditions, app_version
  ) values (
    v_uid, v_track_id, v_class, v_cond, p_lap_ms, btrim(coalesce(p_car, '')),
    lower(btrim(coalesce(p_sim, ''))), v_set_at,
    coalesce(p_conditions, '{}'::jsonb) - 'pace', coalesce(p_app_version, '')
  )
  on conflict (driver_id, track_id, car_class, condition) do update
    set lap_ms      = excluded.lap_ms,
        car         = excluded.car,
        sim         = excluded.sim,
        set_at      = excluded.set_at,
        conditions  = excluded.conditions,
        app_version = excluded.app_version,
        updated_at  = now()
    where public.driver_best_laps.lap_ms > excluded.lap_ms;

  get diagnostics v_rows = row_count;
  v_improved := v_rows > 0;

  v_best_ms := least(p_lap_ms, coalesce(v_prev_ms, p_lap_ms));

  select count(*) + 1 into v_rank
  from public.driver_best_laps b
  where b.track_id = v_track_id
    and b.car_class = v_class
    and b.condition = v_cond
    and b.lap_ms < v_best_ms;

  if v_improved then
    begin
      v_kind := case
        when v_rank = 1 and (v_lead_ms is null or p_lap_ms < v_lead_ms) then
          case
            when v_lead_id is null then 'record_set'
            when v_lead_id = v_uid then 'record_extended'
            else 'record_taken'
          end
        when v_prev_ms is not null then 'personal_best'
        else null
      end;

      -- 0047: the reference pace is Ohne Speed's LMU sheet. A pace riding on
      -- another sim's lap is dropped, whatever the client sent.
      if v_kind is not null and v_cond = 'dry' and v_sim = 'lmu'
         and jsonb_typeof(v_pace_in) = 'object' then
        v_ref_ms := case when (v_pace_in ->> 'ref_ms') ~ '^[0-9]{4,7}$'
                         then (v_pace_in ->> 'ref_ms')::integer end;
        if v_ref_ms between 5000 and 3600000 then
          v_pct := round(p_lap_ms::numeric * 100 / v_ref_ms, 1);
          if v_pct between 80 and 200
             and (v_pace_in ->> 'percent') ~ '^[0-9]{2,3}(\.[0-9]+)?$'
             and abs(v_pct - (v_pace_in ->> 'percent')::numeric) <= 0.2
             and coalesce(v_pace_in ->> 'band', '') ~ '^[A-Za-z][A-Za-z -]{0,23}$' then
            v_pace := jsonb_build_object(
              'percent',  v_pct,
              'band',     v_pace_in ->> 'band',
              'ref_ms',   v_ref_ms,
              'delta_ms', p_lap_ms - v_ref_ms,
              'assumed',  coalesce(v_pace_in ->> 'assumed', '') = 'true'
            );
          end if;
        end if;
      end if;

      if v_kind is not null then
        insert into public.notification_events (
          kind, actor_id, subject_id, board_key, collapse_key, payload
        )
        select
          v_kind,
          v_uid,
          case when v_kind = 'record_taken' then v_lead_id else null end,
          v_track_id::text || '|' || v_class || '|' || v_cond,
          'board:' || v_track_id::text || ':' || v_class || ':' || v_cond || ':' || v_uid::text,
          jsonb_strip_nulls(jsonb_build_object(
            'kind',           v_kind,
            'driver',         coalesce(me.display_name, 'A driver'),
            'driver_id',      v_uid,
            'track',          t.name,
            'track_id',       v_track_id,
            'car',            btrim(coalesce(p_car, '')),
            'car_class',      v_class,
            'condition',      v_cond,
            'lap_ms',         p_lap_ms,
            'previous_ms',    case when v_kind = 'personal_best' then null else v_lead_ms end,
            'gap_ms',         case when v_kind = 'personal_best' or v_lead_ms is null
                                   then null else v_lead_ms - p_lap_ms end,
            'held_since',     case when v_kind = 'personal_best' then null else v_lead_set_at end,
            'holder',         case when v_kind = 'personal_best' then null else prev.display_name end,
            'holder_id',      case when v_kind = 'personal_best' then null else v_lead_id end,
            'own_previous_ms', v_prev_ms,
            'leader',         case when v_kind = 'personal_best' then prev.display_name end,
            'leader_ms',      case when v_kind = 'personal_best' then v_lead_ms end,
            'rank',           v_rank,
            'previous_rank',  v_prev_rank,
            'board_entries',  v_entries,
            'board_size',     v_entries + case when v_prev_ms is null then 1 else 0 end,
            'pace',           v_pace,
            'session_type',   nullif(coalesce(p_conditions, '{}'::jsonb) ->> 'sessionType', ''),
            'sim',            lower(btrim(coalesce(p_sim, ''))),
            'app_version',    coalesce(p_app_version, ''),
            'set_at',         v_set_at
          ))
        from public.profiles me
        left join public.profiles prev on prev.id = v_lead_id
        left join public.tracks t on t.id = v_track_id
        where me.id = v_uid;
      end if;
    exception when others then
      raise warning 'submit_lap: notification event not emitted (%): %',
        sqlstate, sqlerrm;
    end;
  end if;

  return jsonb_build_object(
    'accepted',    true,
    'improved',    v_improved,
    'previous_ms', v_prev_ms,
    'lap_ms',      v_best_ms,
    'rank',        v_rank,
    'track_id',    v_track_id,
    'car_class',   v_class,
    'condition',   v_cond
  );
end;
$function$;

-- --------------------------------------------------------- 4. submit_lap_trace
-- Live body (as deployed: 0009 + 0042) + v_sim and the unknown_sim refusal.
CREATE OR REPLACE FUNCTION public.submit_lap_trace(p_sim text, p_track_key text, p_track_name text, p_track_length_m integer, p_car_class text, p_car text, p_lap_ms integer, p_set_at timestamp with time zone DEFAULT now(), p_s1_ms integer DEFAULT NULL::integer, p_s2_ms integer DEFAULT NULL::integer, p_s3_ms integer DEFAULT NULL::integer, p_data jsonb DEFAULT NULL::jsonb, p_app_version text DEFAULT ''::text, p_fingerprint text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid      uuid := (select auth.uid());
  v_sim      text := lower(btrim(coalesce(p_sim, '')));
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

  -- 0047: only the sims that have boards (see submit_lap).
  if v_sim not in ('lmu', 'iracing') then
    return jsonb_build_object('accepted', false, 'reason', 'unknown_sim');
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

-- ---------------------------------------------------------- 5. submit_activity
-- Live body (applied via MCP in 2026-07, never in the repo) + v_sim and the
-- unknown_sim refusal.
CREATE OR REPLACE FUNCTION public.submit_activity(p_sim text, p_track_key text, p_track_name text, p_track_length_m integer, p_car_class text, p_day date, p_laps integer, p_clean_laps integer, p_distance_m bigint, p_driving_ms bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid       uuid := (select auth.uid());
  v_sim       text := lower(btrim(coalesce(p_sim, '')));
  v_class     text := upper(btrim(coalesce(p_car_class, '')));
  v_track_id  uuid;
  v_laps      integer := greatest(coalesce(p_laps, 0), 0);
  v_clean     integer := greatest(coalesce(p_clean_laps, 0), 0);
  v_distance  bigint  := greatest(coalesce(p_distance_m, 0), 0);
  v_driving   bigint  := greatest(coalesce(p_driving_ms, 0), 0);
  v_stored    public.driver_activity_days%rowtype;
begin
  if v_uid is null then
    raise exception 'submit_activity: not authenticated';
  end if;
  if not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'submit_activity: no profile for this account';
  end if;
  -- 0047: only the sims that have boards (see submit_lap).
  if v_sim not in ('lmu', 'iracing') then
    return jsonb_build_object('accepted', false, 'reason', 'unknown_sim');
  end if;
  if p_day is null or p_day > (now() at time zone 'utc')::date + 1
     or p_day < (now() at time zone 'utc')::date - 365 then
    return jsonb_build_object('accepted', false, 'reason', 'bad_day');
  end if;

  -- Unlike a lap time, an unknown class does not make a lap uncountable — the
  -- weekly total is "what did you drive", and a mod car with no recognised class
  -- was still driven. It goes in its own bucket rather than being dropped.
  if v_class = '' then
    v_class := 'UNKNOWN';
  end if;

  -- Ceilings, not rejections. A day holds 1440 minutes, so these are far above
  -- anything real and exist only to stop a broken client writing a number that
  -- would make someone's week meaningless.
  v_laps     := least(v_laps, 5000);
  v_clean    := least(v_clean, v_laps);
  v_distance := least(v_distance, 50000000);          -- 50 000 km
  v_driving  := least(v_driving, 86400000);           -- 24 h

  v_track_id := public.resolve_track(p_sim, p_track_key, p_track_name, p_track_length_m);

  -- greatest() on every counter. The client sends its own ABSOLUTE total for
  -- this key, so a retry, a double flush, or a queue drained twice after an
  -- offline weekend all land on the same number instead of stacking.
  insert into public.driver_activity_days (
    driver_id, day, track_id, car_class, laps, clean_laps, distance_m, driving_ms
  ) values (
    v_uid, p_day, v_track_id, v_class, v_laps, v_clean, v_distance, v_driving
  )
  on conflict (driver_id, day, track_id, car_class) do update
    set laps       = greatest(public.driver_activity_days.laps,       excluded.laps),
        clean_laps = greatest(public.driver_activity_days.clean_laps, excluded.clean_laps),
        distance_m = greatest(public.driver_activity_days.distance_m, excluded.distance_m),
        driving_ms = greatest(public.driver_activity_days.driving_ms, excluded.driving_ms),
        updated_at = now()
  returning * into v_stored;

  return jsonb_build_object(
    'accepted',   true,
    'day',        v_stored.day,
    'laps',       v_stored.laps,
    'clean_laps', v_stored.clean_laps,
    'distance_m', v_stored.distance_m,
    'driving_ms', v_stored.driving_ms
  );
end;
$function$;

-- ------------------------------------------- 6. a board row's sim is its track's
-- The board RPCs filter on driver_best_laps.sim; the row is keyed on track_id,
-- and tracks.sim is what actually separates the boards. This keeps the two
-- from ever disagreeing — a merge of two tracks by an admin, or a writer that
-- passes a differently-cased sim, cannot leave a row filed under one sim and
-- ranked on another's track. Invoker rights: the writers are SECURITY DEFINER
-- and read tracks as its owner; there are no client write policies.
create or replace function public.board_row_sim_from_track()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  new.sim := coalesce(
    (select t.sim from public.tracks t where t.id = new.track_id),
    new.sim
  );
  return new;
end;
$$;

-- A trigger function, never an RPC: no role but the owner needs EXECUTE.
revoke all on function public.board_row_sim_from_track() from public, anon, authenticated;

drop trigger if exists driver_best_laps_sim_from_track on public.driver_best_laps;
create trigger driver_best_laps_sim_from_track
  before insert or update of track_id, sim on public.driver_best_laps
  for each row execute function public.board_row_sim_from_track();

drop trigger if exists lap_traces_sim_from_track on public.lap_traces;
create trigger lap_traces_sim_from_track
  before insert or update of track_id, sim on public.lap_traces
  for each row execute function public.board_row_sim_from_track();

-- ---------------------------------------------------------- 7. board indexes
-- Live is still the pre-0021 (track_id, car_class, lap_ms) — see the header.
drop index if exists public.driver_best_laps_board_idx;
create index driver_best_laps_board_idx
  on public.driver_best_laps (track_id, car_class, condition, lap_ms);
-- leaderboard_filters(p_sim) filters the whole table on sim.
create index if not exists driver_best_laps_sim_idx
  on public.driver_best_laps (sim);

-- ------------------------------------------------- 8. Discord: sims per channel
-- Which sims a channel announces. Defaulted to LMU-only, so every existing
-- channel keeps exactly today's behaviour and iRacing posts are opt-in.
alter table public.discord_targets
  add column if not exists sims text[] not null default array['lmu']::text[];
alter table public.discord_targets
  add constraint discord_targets_sims_check
  check (cardinality(sims) >= 1 and sims <@ array['lmu', 'iracing']::text[]) not valid;
alter table public.discord_targets validate constraint discord_targets_sims_check;

-- Live body (as deployed) + the sims filter on the target query.
CREATE OR REPLACE FUNCTION public.fanout_notification_events(p_limit integer DEFAULT 200)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_evt   public.notification_events%rowtype;
  v_tgt   record;
  v_made  int := 0;
  v_track uuid;
  v_class text;
  v_cond  text;
  v_today int;
  v_mine  jsonb;
begin
  for v_evt in
    select * from public.notification_events
    where fanned_out_at is null and hold_until <= now()
    order by id
    limit greatest(1, least(coalesce(p_limit, 200), 2000))
  loop
    v_track := nullif(split_part(coalesce(v_evt.board_key, ''), '|', 1), '')::uuid;
    v_class := split_part(coalesce(v_evt.board_key, ''), '|', 2);
    v_cond  := split_part(coalesce(v_evt.board_key, ''), '|', 3);

    for v_tgt in
      select
        t.id,
        t.community_id,
        t.owner_id,
        t.daily_cap,
        case
          when v_evt.kind in ('session_result', 'personal_best') then 'member'
          when exists (
            select 1 from public.community_members m
            where m.community_id = t.community_id
              and m.user_id = v_evt.subject_id
          ) then 'subject'
          when t.community_id is null and t.owner_id = v_evt.actor_id then 'member'
          when exists (
            select 1 from public.community_members m
            where m.community_id = t.community_id
              and m.user_id = v_evt.actor_id
              and m.share <> 'none'
          ) then 'member'
          else 'boards'
        end as axis
      from public.discord_targets t
      where t.paused_at is null
        and v_evt.kind = any(t.kinds)
        -- 0047: a channel hears only the sims it announces. Every channel is
        -- {lmu} unless its owner adds iRacing, so an iRacing record never posts
        -- into an LMU league's Discord. An event with no sim (race results,
        -- anything from before 0034) is LMU's.
        and coalesce(nullif(v_evt.payload ->> 'sim', ''), 'lmu') = any(t.sims)
        and (
          case
          when v_evt.kind = 'session_result' then
            (
              t.community_id is null
              and exists (
                select 1 from public.event_participants p
                where p.event_key = v_evt.payload ->> 'event_key'
                  and p.user_id = t.owner_id
                  and p.driver_name <> ''
              )
            )
            or exists (
              select 1
              from public.event_participants p
              join public.community_members m
                on m.user_id = p.user_id and m.community_id = t.community_id
              where p.event_key = v_evt.payload ->> 'event_key'
                and p.driver_name <> ''
                and m.share = 'all'
            )
          when v_evt.kind = 'personal_best' then
            (t.community_id is null and t.owner_id = v_evt.actor_id)
            or exists (
              select 1 from public.community_members m
              where m.community_id = t.community_id
                and m.user_id = v_evt.actor_id
                and m.share = 'all'
            )
          else
            (t.community_id is null and t.owner_id = v_evt.actor_id)
            or exists (
              select 1 from public.community_members m
              where m.community_id = t.community_id
                and m.user_id = v_evt.actor_id
                and m.share <> 'none'
            )
            or exists (
              select 1 from public.community_members m
              where m.community_id = t.community_id
                and m.user_id = v_evt.subject_id
            )
            or (
              t.watch_boards
              and t.community_id is not null
              and v_track is not null
              and coalesce((v_evt.payload ->> 'board_entries')::int, 0) >= t.min_board_entries
              and exists (
                select 1
                from public.driver_best_laps b
                join public.community_members m
                  on m.user_id = b.driver_id and m.community_id = t.community_id
                where b.track_id = v_track and b.car_class = v_class and b.condition = v_cond
              )
            )
          end
        )
    loop
      if v_tgt.axis = 'boards' and v_tgt.daily_cap > 0 then
        select count(*) into v_today
        from public.notification_outbox o
        where o.target_id = v_tgt.id
          and o.axis = 'boards'
          and o.created_at >= date_trunc('day', now());
        if v_today >= v_tgt.daily_cap then
          continue;
        end if;
      end if;

      v_mine := null;
      if v_evt.kind = 'session_result' then
        select coalesce(jsonb_agg(e order by (e -> 'pos')), '[]'::jsonb)
          into v_mine
        from public.event_results r
        join lateral jsonb_array_elements(r.classification) e on true
        join public.event_participants p
          on p.event_key = r.event_key and lower(p.driver_name) = lower(e ->> 'name')
        where r.event_key = v_evt.payload ->> 'event_key'
          and (
            (v_tgt.community_id is null and p.user_id = v_tgt.owner_id)
            or exists (
              select 1 from public.community_members m
              where m.community_id = v_tgt.community_id
                and m.user_id = p.user_id and m.share = 'all'
            )
          );
      end if;

      insert into public.notification_outbox (
        target_id, event_id, dedupe_key, collapse_key, axis, payload, not_before
      ) values (
        v_tgt.id,
        v_evt.id,
        'evt:' || v_evt.id::text,
        v_evt.collapse_key,
        v_tgt.axis,
        v_evt.payload
          || jsonb_build_object('axis', v_tgt.axis)
          || case when v_mine is null then '{}'::jsonb else jsonb_build_object('mine', v_mine) end,
        case when v_evt.kind = 'session_result' then now() else now() + interval '4 minutes' end
      )
      on conflict (target_id, dedupe_key) do nothing;

      v_made := v_made + 1;
    end loop;

    update public.notification_events set fanned_out_at = now() where id = v_evt.id;
  end loop;

  return v_made;
end;
$function$;

commit;

-- =============================================================================
-- VERIFICATION (run by hand, read-only; NOT part of the migration)
-- =============================================================================
--
-- BEFORE applying, snapshot these two and keep the output:
--
--   -- (a) every board row, fingerprinted
--   select count(*), md5(string_agg(driver_id::text || track_id::text || car_class
--          || condition || lap_ms::text || set_at::text, ',' order by id))
--     from public.driver_best_laps;
--
--   -- (b) the ACL of every function this file touches
--   select p.proname, pg_get_function_identity_arguments(p.oid), p.proacl::text
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('resolve_track', 'submit_lap', 'submit_lap_trace',
--                        'submit_activity', 'fanout_notification_events',
--                        'board_row_sim_from_track')
--    order by 1;
--
-- AFTER applying:
--
--   -- (a) again: count and md5 must be IDENTICAL (no row was written).
--   -- (b) again: identical for the five existing functions; and
--   --     board_row_sim_from_track must show only {postgres=X/postgres, ...}
--   --     with no anon / authenticated entry.
--   select has_function_privilege('anon', 'public.submit_lap(text,text,text,integer,text,text,integer,timestamptz,jsonb,text,text)', 'execute') as anon_can_submit,          -- false
--          has_function_privilege('anon', 'public.board_row_sim_from_track()', 'execute') as anon_can_trigger;  -- false
--
--   -- the constraints, triggers, index and column are in place
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conname in ('tracks_sim_check', 'track_aliases_sim_check', 'discord_targets_sims_check');
--   select tgname from pg_trigger where tgname like '%sim_from_track';
--   select indexdef from pg_indexes where indexname in ('driver_best_laps_board_idx', 'driver_best_laps_sim_idx');
--   select sims, count(*) from public.discord_targets group by sims;          -- every row {lmu}
--
--   -- the LMU boards read exactly as before (compare with a pre-apply run)
--   select count(*), md5(string_agg(track_id::text || car_class || car || condition || laps::text, ','
--          order by track_id, car_class, car, condition))
--     from public.leaderboard_filters('lmu');
--   select count(*) from public.leaderboard_filters('iracing');               -- 0 until the first iRacing lap
--
--   -- every board row's sim agrees with its track's (0 rows)
--   select b.id from public.driver_best_laps b join public.tracks t on t.id = b.track_id where b.sim <> t.sim
--   union all
--   select null from public.lap_traces l join public.tracks t on t.id = l.track_id where l.sim <> t.sim;
--
-- Then record it (the remote history mixes 00xx and timestamp versions; do
-- not use `db push`):
--   insert into supabase_migrations.schema_migrations (version, name)
--   values ('20261110120000', '0047_iracing_boards');
