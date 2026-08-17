-- 0009_lap_trace_setup_link.sql — link a shared setup to the trace of the lap it
-- was driven on: the data groundwork for the Training section.
--
-- The training flow is "click a board lap and learn from it" (the trace, see
-- 0004_lap_traces.sql). This migration adds the other half a coach wants next to
-- that trace: the SETUP the lap was actually driven on, when the driver has
-- shared it. So a driver studying someone's fastest Spa GT3 lap can also grab the
-- car that set it, not just watch the inputs.
--
-- The link is the same integrity anchor the attribution feature already uses
-- (0006_setup_attribution.sql): the setup fingerprint stamped on the lap. A
-- trace now carries that fingerprint, and it is joined to the driver's OWN
-- published setup whose fingerprint matches (or, failing a stamp, whose attached
-- board time is exactly this lap). Only the driver's own setups are ever linked —
-- "this is the tune I drove that lap on" is a claim only its owner can make.
--
-- The link is kept current from both directions:
--   * submit_lap_trace() resolves it when the trace arrives, and
--   * a trigger on public.setups (re)resolves it when a setup is published,
--     re-published with a different tune, or taken down —
-- so it does not matter whether the lap or the share happened first.
--
-- Re-runnable: `if not exists`, `create or replace`, `drop … if exists`.

-- ---------------------------------------------------------------------------
-- 1. Link columns on the trace row.
-- ---------------------------------------------------------------------------
alter table public.lap_traces
  add column if not exists setup_id uuid references public.setups(id) on delete set null,
  add column if not exists fingerprint text not null default '';

comment on column public.lap_traces.setup_id is
  'The driver''s own published setup this board lap was driven on, when shared. Resolved from the lap''s setup fingerprint, or its board time. NULL when the tune was never shared.';
comment on column public.lap_traces.fingerprint is
  'Setup fingerprint stamped on this lap (setupFingerprint.ts) — the join key to public.setups.fingerprint.';

create index if not exists lap_traces_setup_idx on public.lap_traces(setup_id);
create index if not exists lap_traces_fingerprint_idx
  on public.lap_traces(driver_id, car_class, fingerprint);

-- ---------------------------------------------------------------------------
-- 2. The resolver — a driver''s own shared setup that a given board lap was
--    driven on. Fingerprint match wins; a matching attached board time is the
--    fallback for laps recorded before stamping existed. NULL when neither
--    matches, which is the honest "never shared this tune" answer.
-- ---------------------------------------------------------------------------
create or replace function public.match_lap_setup(
  p_owner       uuid,
  p_car_class   text,
  p_lap_ms      integer,
  p_fingerprint text
) returns uuid
language sql
stable
security definer
set search_path to ''
as $$
  select s.id
  from public.setups s
  where s.owner_id = p_owner
    and s.car_class = upper(btrim(coalesce(p_car_class, '')))
    and (
      -- Best: the shared setup carries this exact lap''s fingerprint.
      (coalesce(p_fingerprint, '') <> '' and s.fingerprint = p_fingerprint)
      -- Fallback: the setup''s own attached board time IS this lap.
      or (s.best_lap_on_setup and s.best_lap_ms is not null and s.best_lap_ms = p_lap_ms)
    )
  order by
    -- Prefer a real fingerprint match over the board-time fallback, then the
    -- most recently touched share.
    (coalesce(p_fingerprint, '') <> '' and s.fingerprint = p_fingerprint) desc,
    s.updated_at desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 3. submit_lap_trace — recreated with the lap''s fingerprint, storing it and
--    resolving the setup link. Dropped-and-recreated (not replaced) because the
--    argument list changes; PostgREST cannot carry two overloads cleanly.
-- ---------------------------------------------------------------------------
drop function if exists public.submit_lap_trace(
  text, text, text, integer, text, text, integer, timestamptz,
  integer, integer, integer, jsonb, text);

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
  p_app_version    text default '',
  p_fingerprint    text default ''
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
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
  where driver_id = v_uid and track_id = v_track_id and car_class = v_class;

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
$$;

revoke all on function public.submit_lap_trace(
  text, text, text, integer, text, text, integer, timestamptz,
  integer, integer, integer, jsonb, text, text) from public, anon;
grant execute on function public.submit_lap_trace(
  text, text, text, integer, text, text, integer, timestamptz,
  integer, integer, integer, jsonb, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Keep the link current from the setup side. Publishing, re-publishing with a
--    different tune, or changing the attached board time re-resolves which of
--    the owner''s traces point at this setup — and drops any that no longer do.
--    (Deleting a setup is handled by the FK''s ON DELETE SET NULL.)
-- ---------------------------------------------------------------------------
create or replace function public.link_setup_to_traces()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  -- Drop stale links first: a trace pointing here that no longer matches the
  -- setup''s current fingerprint or board time (e.g. after a re-publish).
  update public.lap_traces t
     set setup_id = null, updated_at = now()
   where t.setup_id = new.id
     and not (
       (coalesce(new.fingerprint, '') <> '' and t.fingerprint = new.fingerprint)
       or (new.best_lap_on_setup and new.best_lap_ms is not null and t.lap_ms = new.best_lap_ms)
     );

  -- Adopt this owner''s matching traces that are not already pointing here.
  update public.lap_traces t
     set setup_id = new.id, updated_at = now()
   where t.driver_id = new.owner_id
     and t.car_class = new.car_class
     and t.setup_id is distinct from new.id
     and (
       (coalesce(new.fingerprint, '') <> '' and t.fingerprint = new.fingerprint)
       or (new.best_lap_on_setup and new.best_lap_ms is not null and t.lap_ms = new.best_lap_ms)
     );

  return new;
end;
$$;

drop trigger if exists setups_link_traces on public.setups;
create trigger setups_link_traces
  after insert or update of fingerprint, best_lap_ms, best_lap_on_setup, car_class
  on public.setups
  for each row
  execute function public.link_setup_to_traces();

-- ---------------------------------------------------------------------------
-- 5. get_lap_trace — the Training section''s read: one driver''s board-lap trace
--    for a track+class, plus the shared setup it was driven on (metadata only —
--    the heavy .svm/values travel on download_setup()). Keyed by track_id, which
--    the leaderboard row already carries, so no track resolution is needed here.
-- ---------------------------------------------------------------------------
create or replace function public.get_lap_trace(
  p_driver_id uuid,
  p_track_id  uuid,
  p_car_class text
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_class text := upper(btrim(coalesce(p_car_class, '')));
  v_t     public.lap_traces%rowtype;
  v_setup jsonb := null;
begin
  if v_uid is null then
    raise exception 'get_lap_trace: not authenticated';
  end if;

  select * into v_t
  from public.lap_traces
  where driver_id = p_driver_id and track_id = p_track_id and car_class = v_class;

  if not found then
    return jsonb_build_object('found', false);
  end if;

  if v_t.setup_id is not null then
    select jsonb_build_object(
      'id',             s.id,
      'name',           s.name,
      'ownerName',      coalesce(d.display_name, 'Driver'),
      'car',            s.car,
      'carClass',       s.car_class,
      'trackFolder',    s.track_folder,
      'trackName',      s.track_name,
      'tags',           to_jsonb(s.tags),
      'downloads',      s.downloads,
      'bestLapMs',      s.best_lap_ms,
      'bestLapOnSetup', s.best_lap_on_setup,
      'fingerprint',    s.fingerprint,
      'isPublic',       s.is_public,
      'avgStars',       (select round(avg(r.stars)::numeric, 1) from public.setup_ratings r
                         where r.setup_id = s.id),
      'ratingCount',    (select count(*) from public.setup_ratings r where r.setup_id = s.id)
    )
    into v_setup
    from public.setups s
    left join public.public_drivers d on d.id = s.owner_id
    where s.id = v_t.setup_id and (s.is_public or s.owner_id = v_uid);
  end if;

  return jsonb_build_object(
    'found',    true,
    'driverId', v_t.driver_id,
    'trackId',  v_t.track_id,
    'carClass', v_t.car_class,
    'sim',      v_t.sim,
    'car',      v_t.car,
    'lapMs',    v_t.lap_ms,
    's1Ms',     v_t.s1_ms,
    's2Ms',     v_t.s2_ms,
    's3Ms',     v_t.s3_ms,
    'setAt',    v_t.set_at,
    'data',     v_t.data,
    'setup',    v_setup
  );
end;
$$;

revoke all on function public.match_lap_setup(uuid, text, integer, text) from public, anon;
revoke all on function public.get_lap_trace(uuid, uuid, text)            from public, anon;
grant execute on function public.match_lap_setup(uuid, text, integer, text) to authenticated;
grant execute on function public.get_lap_trace(uuid, uuid, text)            to authenticated;
