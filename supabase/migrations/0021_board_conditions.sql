-- 0021_board_conditions.sql — the league boards split by track surface.
--
-- Carl, 2026-09-15: "they're not going to beat that overall best lap time... I
-- don't know whether we need to add a filter and accept times that have been
-- done in a wet session as well". That is the right instinct, and it is also
-- the reason a tag alone would not have delivered it: `driver_best_laps` is
-- unique on (driver, track, class) and `submit_lap` only overwrites when the
-- incoming lap is FASTER, so a wet lap — slower by construction — never
-- survived long enough to be tagged. Of the 280 rows on the boards when this
-- was written, exactly one was set in the wet, and only because it was that
-- driver's only lap there.
--
-- So the surface becomes part of the key. Three boards per (track, class):
--
--   dry   — wetness < 0.02, the feed's own floor
--   damp  — 0.02 … 0.2, a dry line exists and the rest of the circuit does not
--   wet   — 0.2 and up, the dry line has gone
--
-- The bands are the weather card's own (`wetnessBand`, lmuRestProvider.ts) with
-- its top three collapsed: WET / VERY WET / SATURATED are degrees of the same
-- lap, and three more boards in a league this size would have one name on each.
-- DAMP earns its place because it is neither of the others — times within a few
-- seconds of dry pace, set on a circuit nobody would call dry.
--
-- Client compatibility is the constraint that shapes the rest of this file.
-- Installed copies older than this release call `submit_lap` with ten named
-- arguments and know nothing about a surface. Adding an eleventh DEFAULTED
-- argument alongside the existing function would leave PostgREST with two
-- candidate overloads for those ten names and it would refuse the call, so each
-- function here is DROPPED and recreated rather than added to. Old clients then
-- resolve to the new function and take the default — dry — which is where their
-- laps belong anyway: they have no wetness channel to have read.
--
-- Re-runnable: `if not exists`, `drop … if exists`, idempotent backfill.

-- ---------------------------------------------------------------------------
-- 1. The column, and the key it becomes part of
-- ---------------------------------------------------------------------------

alter table public.driver_best_laps
  add column if not exists condition text not null default 'dry';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.driver_best_laps'::regclass
      and conname = 'driver_best_laps_condition_check'
  ) then
    alter table public.driver_best_laps
      add constraint driver_best_laps_condition_check
      check (condition in ('dry', 'damp', 'wet'));
  end if;
end $$;

comment on column public.driver_best_laps.condition is
  'Track surface this time was set on: dry | damp | wet, banded from the wettest point on the circuit during the lap (lapLog.conditionOf). Part of the board key — a driver holds one best per surface.';

-- Every row that existed before this migration is dry, including the one set in
-- the wet. That is deliberate, and it is the narrower claim: those laps carry a
-- `wet` BOOLEAN in `conditions` and no number, and the boolean fires at any
-- moisture anywhere on the circuit — it cannot tell damp from saturated. Moving
-- that row to a band would be inventing which band. It stays where it has always
-- been ranked, and `leaderboard()` returns the old flag beside it so the client
-- can mark it as set in the wet without pretending to know how wet.

-- The constraint FIRST, then the index. Postgres refuses to drop an index that
-- backs a unique constraint ("...because constraint ... requires it"), so the
-- other order aborts the whole migration on the first run and leaves nothing
-- applied. Dropping the constraint takes its index with it; the second line is
-- for the case where a plain index of that name is all that is left.
alter table public.driver_best_laps
  drop constraint if exists driver_best_laps_driver_id_track_id_car_class_key;
drop index if exists driver_best_laps_driver_id_track_id_car_class_key;

create unique index if not exists driver_best_laps_driver_track_class_condition_key
  on public.driver_best_laps (driver_id, track_id, car_class, condition);

-- The board query filters on it before it ranks.
create index if not exists driver_best_laps_board_idx
  on public.driver_best_laps (track_id, car_class, condition, lap_ms);

-- ---------------------------------------------------------------------------
-- 2. submit_lap — one best per surface
-- ---------------------------------------------------------------------------

drop function if exists public.submit_lap(
  text, text, text, integer, text, text, integer, timestamptz, jsonb, text);

create function public.submit_lap(
  p_sim text,
  p_track_key text,
  p_track_name text,
  p_track_length_m integer,
  p_car_class text,
  p_car text,
  p_lap_ms integer,
  p_set_at timestamptz default now(),
  p_conditions jsonb default '{}'::jsonb,
  p_app_version text default '',
  p_condition text default 'dry'
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid      uuid := (select auth.uid());
  v_class    text := upper(btrim(coalesce(p_car_class, '')));
  v_cond     text := lower(btrim(coalesce(p_condition, 'dry')));
  v_set_at   timestamptz := coalesce(p_set_at, now());
  v_track_id uuid;
  v_prev_ms  integer;
  v_rows     integer;
  v_improved boolean := false;
  v_best_ms  integer;
  v_rank     integer;
begin
  if v_uid is null then
    raise exception 'submit_lap: not authenticated';
  end if;
  if not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'submit_lap: no profile for this account';
  end if;

  -- A lap whose class we do not know cannot be placed on a class board. It is
  -- still a lap in the driver's own local history; it just has no board to go on.
  if v_class = '' then
    return jsonb_build_object('accepted', false, 'reason', 'unknown_class');
  end if;
  -- An unrecognised surface is treated as dry rather than refused: a client
  -- sending a band this server has not heard of is a client from the future,
  -- and losing the lap entirely would be the worse of the two answers.
  if v_cond not in ('dry', 'damp', 'wet') then
    v_cond := 'dry';
  end if;
  if p_lap_ms is null or p_lap_ms < 5000 or p_lap_ms > 3600000 then
    return jsonb_build_object('accepted', false, 'reason', 'implausible_time');
  end if;
  -- A clock far enough out to matter is a broken client, not a fast lap. Allowed
  -- to be slightly ahead of the server (ordinary clock drift), and to be as old
  -- as the queue might plausibly be after a long offline spell.
  if v_set_at > now() + interval '1 day' or v_set_at < now() - interval '365 days' then
    return jsonb_build_object('accepted', false, 'reason', 'clock_skew');
  end if;

  v_track_id := public.resolve_track(p_sim, p_track_key, p_track_name, p_track_length_m);

  select lap_ms into v_prev_ms
  from public.driver_best_laps
  where driver_id = v_uid and track_id = v_track_id
    and car_class = v_class and condition = v_cond;

  -- A strict `>` keeps the EARLIER of two identical times, which is the ordinary
  -- motorsport tie-break and also means a re-sent queue never rewrites set_at.
  insert into public.driver_best_laps (
    driver_id, track_id, car_class, condition, lap_ms, car, sim, set_at,
    conditions, app_version
  ) values (
    v_uid, v_track_id, v_class, v_cond, p_lap_ms, btrim(coalesce(p_car, '')),
    lower(btrim(coalesce(p_sim, ''))), v_set_at,
    coalesce(p_conditions, '{}'::jsonb), coalesce(p_app_version, '')
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

  -- What is actually on the board now — which is the incoming lap only if it beat
  -- what was there.
  v_best_ms := least(p_lap_ms, coalesce(v_prev_ms, p_lap_ms));

  -- Ranked against its own surface. A wet lap reported as P9 because the dry
  -- board has eight faster times on it would be the same conflation this
  -- migration exists to undo.
  select count(*) + 1 into v_rank
  from public.driver_best_laps b
  where b.track_id = v_track_id
    and b.car_class = v_class
    and b.condition = v_cond
    and b.lap_ms < v_best_ms;

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

-- `from public` is not enough, and this is the trap in every drop-and-recreate
-- here: a recreated function loses its ACL and picks up the project's DEFAULT
-- PRIVILEGES, and Supabase's default grants EXECUTE on new public functions to
-- anon. Revoking PUBLIC leaves that explicit anon grant in place, so the
-- function comes back reachable by a signed-out caller — wider than it was.
-- Verified against pg_proc.proacl after applying: these three end up with
-- exactly {postgres, authenticated, service_role}, as they were.
revoke all on function public.submit_lap(
  text, text, text, integer, text, text, integer, timestamptz, jsonb, text, text) from public, anon;
grant execute on function public.submit_lap(
  text, text, text, integer, text, text, integer, timestamptz, jsonb, text, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. leaderboard — one surface at a time
-- ---------------------------------------------------------------------------

drop function if exists public.leaderboard(text, uuid, text, text, integer);

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
  legacy_wet boolean
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
      -- The measured number behind the band, when the lap carried one. Null on
      -- every lap set before v7 records existed.
      nullif(b.conditions ->> 'wetness', '')::real as wetness,
      -- A pre-v7 lap that recorded only the old boolean, and recorded it true.
      -- It sits on the dry board because its band is unknowable, and the client
      -- marks it rather than silently ranking it as a dry time.
      (b.conditions ->> 'wetness' is null
        and coalesce((b.conditions ->> 'wet')::boolean, false))      as legacy_wet,
      (t.lap_ms is not null and t.lap_ms = b.lap_ms)                as has_trace,
      (t.lap_ms is not null and t.lap_ms = b.lap_ms and t.has_line) as has_line
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
      -- Null means every surface on one board, which is what the old function
      -- did and what nothing in the app asks for any more. Kept as an escape
      -- hatch for the admin panel rather than as a default.
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
    legacy_wet
  from board
  order by lap_ms asc, set_at asc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$function$;

revoke all on function public.leaderboard(text, uuid, text, text, integer, text) from public, anon;
grant execute on function public.leaderboard(text, uuid, text, text, integer, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. leaderboard_filters — which surfaces actually have laps
-- ---------------------------------------------------------------------------
--
-- The client builds its controls from what the boards HOLD, never from a
-- hardcoded list (the note in control-panel.js says why: offering thirty-one
-- circuits when three have laps on them is the fastest way to make a working
-- feature look broken). The same rule now decides whether a Damp chip appears.

drop function if exists public.leaderboard_filters(text);

create function public.leaderboard_filters(p_sim text default 'lmu')
returns table(
  track_id uuid, track_name text, track_length_m integer,
  car_class text, car text, condition text, laps integer
)
language sql
stable
set search_path to 'public'
as $function$
  select
    b.track_id,
    t.name as track_name,
    t.length_m as track_length_m,
    b.car_class,
    b.car,
    b.condition,
    count(*)::int as laps
  from public.driver_best_laps b
  join public.tracks t on t.id = b.track_id
  where b.sim = coalesce(p_sim, b.sim)
  group by b.track_id, t.name, t.length_m, b.car_class, b.car, b.condition
  order by t.name, b.car_class, b.car, b.condition;
$function$;

-- Public execute, as before: the filter list names tracks and classes, not
-- drivers or times.
grant execute on function public.leaderboard_filters(text)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. board_for_lap — the Review tab's entry point
-- ---------------------------------------------------------------------------
--
-- Review compares against a board lap's TRACE, and `lap_traces` is keyed
-- (driver, track, class) with no room for a surface — so only the dry board's
-- laps have traces beside them (see `traceNeedsSend` in lapLog.ts). This
-- defaults to dry for that reason, rather than by copying the default above.

drop function if exists public.board_for_lap(text, text, text, integer);

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
  legacy_wet boolean
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
