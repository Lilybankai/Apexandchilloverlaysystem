-- =============================================================================
-- Leaderboard filters — return the track's length.
-- =============================================================================
-- One added column: `leaderboard_filters` now returns `track_length_m`.
--
-- WHY, because a length on a filter row looks like clutter until you know what
-- it is for. The panel scores a clicked board lap against the reference times,
-- and to do that it has to know WHICH LAYOUT of a circuit the lap was set on.
-- Several circuits in the reference table have more than one — Circuit of the
-- Americas has the Grand Prix and the National, ~1.8 km apart — and a lap
-- scored against the wrong one is out by ten seconds and looks authoritative.
--
-- A board row carries no track metadata at all: `leaderboard` returns a ranking
-- (name, car, lap, gap), not the laps' identity. The client shipped in v0.56.0
-- tried to recover the length by parsing it out of the track id, on the
-- assumption that the id was the lap log's `trackKey` string
-- (`${slug}_${metres}`). It is not — `track_id` is the `tracks.id` UUID, so the
-- parse never matched and every board was scored with no length hint at all.
-- Single-layout circuits still resolved (there is nothing to choose between);
-- every multi-layout one reported "ambiguous layout" and its rows went unscored
-- and unclickable. That is the bug this fixes.
--
-- `tracks.length_m` is the sim's own measurement, recorded when the lap was
-- submitted, which is the same number the local scorer uses for the driver's
-- own laps — so a board lap and a local lap at the same place now resolve the
-- same way, rather than by two different routes that can disagree.
--
-- Changing a function's RETURNS TABLE means DROP then CREATE; `create or
-- replace` cannot alter a return type. The grants are restored below because
-- DROP takes them with it. Nothing else about the function changes: still
-- SECURITY INVOKER, still reading only rows RLS already allows.
--
-- Apply after 0002_admin_users.sql. Re-runnable.
-- =============================================================================

drop function if exists public.leaderboard_filters(text);

create function public.leaderboard_filters(p_sim text default 'lmu')
returns table (
  track_id uuid,
  track_name text,
  -- The sim's measured lap distance in metres, for layout resolution. Nullable:
  -- a track row written before the length was known stores null, and the client
  -- treats that as "no hint" rather than as a length of zero.
  track_length_m int,
  car_class text,
  car text,
  laps int
)
language sql
stable
set search_path to 'public'
as $$
  select
    b.track_id,
    t.name as track_name,
    t.length_m as track_length_m,
    b.car_class,
    b.car,
    count(*)::int as laps
  from public.driver_best_laps b
  join public.tracks t on t.id = b.track_id
  where b.sim = coalesce(p_sim, b.sim)
  group by b.track_id, t.name, t.length_m, b.car_class, b.car
  order by t.name, b.car_class, b.car;
$$;

grant execute on function public.leaderboard_filters(text) to authenticated, service_role;
