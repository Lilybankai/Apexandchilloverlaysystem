-- 0020_board_compare.sql — compare a lap against anyone's board lap.
--
-- The Review tab compares two of the driver's own laps (docs/STINT-REVIEW-PLAN.md,
-- phase 3). Carl widened that on 2026-09-12: the comparison lap may now be any
-- lap on the league leaderboard. The trace itself has been in `lap_traces` since
-- 0004 and readable by every signed-in driver since day one (`get_lap_trace`,
-- 0009); what was missing is the two lookups either side of it:
--
--   1. A board row does not say whether a trace exists for it, so the client
--      could not tell a comparable row from a bare time. `leaderboard()` now
--      carries `has_trace` and `has_line` per row.
--   2. The Review tab starts from a LOCAL lap, which knows its `trackKey` and
--      class but not the board's `track_id`; the Leaderboard tab starts from a
--      board row, which knows the `track_id` but not the local key. Both
--      directions go through `track_aliases` — the same table the uploader's
--      `resolve_track()` fills — read-only, so a lookup can never create a
--      track the way an upload does.
--
-- `has_line` is a stored flag, not `data ? 'x'` evaluated per board call: the
-- trace is ~20 KB of jsonb and a board is up to 500 rows, and detoasting ten
-- megabytes to answer a boolean is the kind of thing that works on a laptop
-- and pages on a phone. A trigger keeps it true to the payload.
--
-- Re-runnable: `if not exists`, `create or replace`, `drop … if exists`.

-- ---------------------------------------------------------------------------
-- 1. Does this trace carry the driven line? Stored, kept current by trigger.
-- ---------------------------------------------------------------------------
alter table public.lap_traces
  add column if not exists has_line boolean not null default false;

comment on column public.lap_traces.has_line is
  'The trace carries the driven line (data.x/data.z, trace v2). Set by trigger from data; a v1 trace compares on its channels but cannot be drawn on the map.';

create or replace function public.lap_trace_has_line()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  -- coalesce, because a v1 trace has no `x` at all and jsonb_typeof(NULL) is
  -- NULL, which would make the whole test NULL and violate the not-null.
  new.has_line := coalesce(
    new.data is not null
    and jsonb_typeof(new.data -> 'x') = 'array'
    and jsonb_typeof(new.data -> 'z') = 'array'
    and jsonb_array_length(new.data -> 'x') > 1
    and jsonb_array_length(new.data -> 'x') = jsonb_array_length(new.data -> 'z'),
    false);
  return new;
end;
$$;

drop trigger if exists lap_traces_has_line on public.lap_traces;
create trigger lap_traces_has_line
  before insert or update of data on public.lap_traces
  for each row execute function public.lap_trace_has_line();

-- Backfill what is already there (the trigger only sees writes from now on).
update public.lap_traces
   set has_line = coalesce(
     jsonb_typeof(data -> 'x') = 'array'
     and jsonb_typeof(data -> 'z') = 'array'
     and jsonb_array_length(data -> 'x') > 1
     and jsonb_array_length(data -> 'x') = jsonb_array_length(data -> 'z'),
     false)
 where has_line is distinct from coalesce(
     jsonb_typeof(data -> 'x') = 'array'
     and jsonb_typeof(data -> 'z') = 'array'
     and jsonb_array_length(data -> 'x') > 1
     and jsonb_array_length(data -> 'x') = jsonb_array_length(data -> 'z'),
     false);

-- ---------------------------------------------------------------------------
-- 2. leaderboard() — two more columns. Dropped and recreated because a
--    RETURNS TABLE cannot be altered in place. Body otherwise unchanged from
--    create_lap_database_tables.
--
--    `has_trace` means the trace on file is THIS lap's — the join is on
--    (driver, track, class) and `submit_lap_trace` refuses any trace whose time
--    is not the board time, but a best that arrived without its trace leaves
--    an older trace on the row until the next upload run settles it.
-- ---------------------------------------------------------------------------
drop function if exists public.leaderboard(text, uuid, text, text, integer);

create or replace function public.leaderboard(
  p_sim       text    default 'lmu',
  p_track_id  uuid    default null,
  p_car_class text    default null,
  p_car       text    default null,
  p_limit     integer default 100
)
returns table (
  rank         integer,
  driver_id    uuid,
  display_name text,
  car          text,
  lap_ms       integer,
  gap_ms       integer,
  set_at       timestamptz,
  is_you       boolean,
  has_trace    boolean,
  has_line     boolean
)
language sql
stable
set search_path to 'public'
as $$
  with board as (
    select
      b.driver_id,
      coalesce(d.display_name, 'Driver') as display_name,
      b.car,
      b.lap_ms,
      b.set_at,
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
    has_line
  from board
  order by lap_ms asc, set_at asc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

revoke all on function public.leaderboard(text, uuid, text, text, integer) from public, anon;
grant execute on function public.leaderboard(text, uuid, text, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. board_for_lap — the board a LOCAL lap belongs on, from the lap's own key.
--    Read-only resolution through track_aliases: an unknown key answers with
--    no rows, never with a new track. The class is normalised the way
--    submit_lap_trace stores it.
-- ---------------------------------------------------------------------------
create or replace function public.board_for_lap(
  p_sim       text,
  p_track_key text,
  p_car_class text,
  p_limit     integer default 200
)
returns table (
  track_id     uuid,
  rank         integer,
  driver_id    uuid,
  display_name text,
  car          text,
  lap_ms       integer,
  gap_ms       integer,
  set_at       timestamptz,
  is_you       boolean,
  has_trace    boolean,
  has_line     boolean
)
language sql
stable
set search_path to 'public'
as $$
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
    p_limit
  ) l;
$$;

revoke all on function public.board_for_lap(text, text, text, integer) from public, anon;
grant execute on function public.board_for_lap(text, text, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. track_keys — the inverse: every local key that resolves to a board track,
--    so the Leaderboard tab can find the driver's own laps for a board row.
--    Aliases, plural: an admin may have merged two sightings of one circuit,
--    and laps recorded under either key are laps on this track.
-- ---------------------------------------------------------------------------
create or replace function public.track_keys(
  p_sim      text,
  p_track_id uuid
)
returns setof text
language sql
stable
set search_path to 'public'
as $$
  select a.raw_key
  from public.track_aliases a
  where a.sim = lower(btrim(coalesce(p_sim, '')))
    and a.track_id = p_track_id;
$$;

revoke all on function public.track_keys(text, uuid) from public, anon;
grant execute on function public.track_keys(text, uuid) to authenticated;
