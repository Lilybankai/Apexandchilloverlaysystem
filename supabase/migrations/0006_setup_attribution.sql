-- 0006_setup_attribution.sql — lap-to-setup attribution: "verified pace"
-- comes to mean "driven on THIS setup".
--
-- The client stamps every recorded lap with a fingerprint of the garage
-- setup it was driven on (see src/telemetry/setupFingerprint.ts — a hash of
-- the tune excluding per-stint keys like fuel). A published setup carries its
-- own fingerprint, so both sides of every lap claim can now be checked
-- client-side: the uploader's headline time and each rater's pace are marked
-- `on_setup` when the lap's stamp matches the setup's fingerprint, and left
-- unmarked (a labelled track/class best) when it doesn't. Laps recorded
-- before this feature simply never match — the soft fallback, by design.
--
-- publish_setup and rate_setup are DROPPED and recreated rather than
-- overloaded: adding defaulted parameters to a copy would leave two
-- overloads and ambiguous PostgREST dispatch.

alter table public.setups
  add column fingerprint text not null default '',
  add column best_lap_on_setup boolean not null default false;

comment on column public.setups.fingerprint is
  'Client-computed hash of the tune (setupFingerprint.ts). Matches lap stamps for attribution.';

alter table public.setup_ratings
  add column lap_on_setup boolean not null default false;

drop function if exists public.publish_setup(
  text, text, text, text, text, text, text, text, text[], jsonb, text, int, text, text);
drop function if exists public.rate_setup(uuid, int, int);

/* ---------------------------------------------------------------- publish */

create or replace function public.publish_setup(
  p_name              text,
  p_notes             text,
  p_track_folder      text,
  p_track_name        text,
  p_car               text,
  p_car_class         text,
  p_vehicle_class     text,
  p_session_type      text,
  p_tags              text[],
  p_values            jsonb,
  p_svm               text,
  p_best_lap_ms       int default null,
  p_app_version       text default '',
  p_sim               text default 'lmu',
  p_fingerprint       text default '',
  p_best_lap_on_setup boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_name   text := left(btrim(coalesce(p_name, '')), 60);
  v_folder text := left(btrim(coalesce(p_track_folder, '')), 80);
  v_class  text := upper(btrim(coalesce(p_car_class, '')));
  v_tags   text[];
  v_id     uuid;
begin
  if v_uid is null then
    raise exception 'publish_setup: not authenticated';
  end if;
  if v_name = '' then
    return jsonb_build_object('ok', false, 'reason', 'no_name');
  end if;
  if v_folder = '' then
    return jsonb_build_object('ok', false, 'reason', 'no_track');
  end if;
  if v_class = '' then
    return jsonb_build_object('ok', false, 'reason', 'no_class');
  end if;
  if p_svm is null or btrim(p_svm) = '' then
    return jsonb_build_object('ok', false, 'reason', 'no_file');
  end if;
  if pg_column_size(p_svm) > 262144 then
    return jsonb_build_object('ok', false, 'reason', 'file_too_large');
  end if;
  if p_values is null or jsonb_typeof(p_values) <> 'object' then
    return jsonb_build_object('ok', false, 'reason', 'no_values');
  end if;
  if pg_column_size(p_values) > 131072 then
    return jsonb_build_object('ok', false, 'reason', 'values_too_large');
  end if;

  select coalesce(array_agg(distinct t), '{}')
    into v_tags
    from (
      select left(btrim(x), 24) as t
      from unnest(coalesce(p_tags, '{}')) as x
      limit 8
    ) s
    where t <> '';

  insert into public.setups (
    owner_id, sim, name, notes, track_folder, track_name, car, car_class,
    vehicle_class, session_type, tags, data, svm, best_lap_ms, app_version,
    fingerprint, best_lap_on_setup
  ) values (
    v_uid,
    lower(btrim(coalesce(p_sim, 'lmu'))),
    v_name,
    left(coalesce(p_notes, ''), 500),
    v_folder,
    left(btrim(coalesce(p_track_name, '')), 120),
    left(btrim(coalesce(p_car, '')), 120),
    v_class,
    left(btrim(coalesce(p_vehicle_class, '')), 200),
    case when p_session_type in ('race', 'quali') then p_session_type else '' end,
    v_tags,
    p_values,
    p_svm,
    case when p_best_lap_ms between 5000 and 3600000 then p_best_lap_ms else null end,
    left(coalesce(p_app_version, ''), 40),
    left(coalesce(p_fingerprint, ''), 32),
    coalesce(p_best_lap_on_setup, false) and p_best_lap_ms is not null
  )
  on conflict (owner_id, track_folder, name) do update
    set notes             = excluded.notes,
        track_name        = excluded.track_name,
        car               = excluded.car,
        car_class         = excluded.car_class,
        vehicle_class     = excluded.vehicle_class,
        session_type      = excluded.session_type,
        tags              = excluded.tags,
        data              = excluded.data,
        svm               = excluded.svm,
        best_lap_ms       = excluded.best_lap_ms,
        app_version       = excluded.app_version,
        fingerprint       = excluded.fingerprint,
        best_lap_on_setup = excluded.best_lap_on_setup,
        is_public         = true,
        updated_at        = now()
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

/* ------------------------------------------------------------------ rate */

create or replace function public.rate_setup(
  p_id           uuid,
  p_stars        int,
  p_lap_ms       int default null,
  p_lap_on_setup boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_owner uuid;
begin
  if v_uid is null then
    raise exception 'rate_setup: not authenticated';
  end if;
  if p_stars is null or p_stars < 1 or p_stars > 5 then
    return jsonb_build_object('ok', false, 'reason', 'bad_stars');
  end if;

  select owner_id into v_owner from public.setups
  where id = p_id and (is_public or owner_id = v_uid);
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_owner = v_uid then
    return jsonb_build_object('ok', false, 'reason', 'own_setup');
  end if;
  if not exists (
    select 1 from public.setup_downloads
    where setup_id = p_id and user_id = v_uid
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_downloaded');
  end if;

  insert into public.setup_ratings (setup_id, user_id, stars, lap_ms, lap_on_setup)
  values (
    p_id, v_uid, p_stars,
    case when p_lap_ms between 5000 and 3600000 then p_lap_ms else null end,
    coalesce(p_lap_on_setup, false) and p_lap_ms is not null
  )
  on conflict (setup_id, user_id) do update
    set stars        = excluded.stars,
        lap_ms       = excluded.lap_ms,
        lap_on_setup = excluded.lap_on_setup,
        updated_at   = now();

  return jsonb_build_object(
    'ok', true,
    'avgStars', (select round(avg(stars)::numeric, 1) from public.setup_ratings where setup_id = p_id),
    'ratingCount', (select count(*) from public.setup_ratings where setup_id = p_id)
  );
end;
$$;

/* ---------------------------------------------------------------- browse */

-- Adds fingerprint (so the client can match its own laps against each row),
-- bestLapOnSetup, and the raters' best split into on-setup / any.
create or replace function public.browse_setups()
returns jsonb
language sql
security definer
set search_path to ''
as $$
  select coalesce(jsonb_agg(r order by r->>'createdAt' desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',              s.id,
      'name',            s.name,
      'notes',           s.notes,
      'trackFolder',     s.track_folder,
      'trackName',       s.track_name,
      'car',             s.car,
      'carClass',        s.car_class,
      'vehicleClass',    s.vehicle_class,
      'sessionType',     s.session_type,
      'tags',            to_jsonb(s.tags),
      'bestLapMs',       s.best_lap_ms,
      'bestLapOnSetup',  s.best_lap_on_setup,
      'fingerprint',     s.fingerprint,
      'downloads',       s.downloads,
      'createdAt',       s.created_at,
      'updatedAt',       s.updated_at,
      'ownerName',       coalesce(d.display_name, 'Driver'),
      'mine',            s.owner_id = (select auth.uid()),
      'downloaded',      exists (
                           select 1 from public.setup_downloads dl
                           where dl.setup_id = s.id and dl.user_id = (select auth.uid())
                         ),
      'myStars',         (select r.stars from public.setup_ratings r
                          where r.setup_id = s.id and r.user_id = (select auth.uid())),
      'avgStars',        (select round(avg(r.stars)::numeric, 1) from public.setup_ratings r
                          where r.setup_id = s.id),
      'ratingCount',     (select count(*) from public.setup_ratings r
                          where r.setup_id = s.id),
      'ratersBestMs',    (select min(r.lap_ms) from public.setup_ratings r
                          where r.setup_id = s.id),
      'ratersBestOnSetupMs', (select min(r.lap_ms) from public.setup_ratings r
                              where r.setup_id = s.id and r.lap_on_setup)
    ) as r
    from public.setups s
    left join public.public_drivers d on d.id = s.owner_id
    where s.is_public or s.owner_id = (select auth.uid())
    order by s.created_at desc
    limit 500
  ) b;
$$;

/* -------------------------------------------------------------- download */

-- Adds fingerprint to the returned setup, for the library entry's metadata.
create or replace function public.download_setup(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.setups%rowtype;
  v_new int;
begin
  if v_uid is null then
    raise exception 'download_setup: not authenticated';
  end if;

  select * into v_row
  from public.setups
  where id = p_id and (is_public or owner_id = v_uid);
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  insert into public.setup_downloads (setup_id, user_id)
  values (p_id, v_uid)
  on conflict (setup_id, user_id) do nothing;
  get diagnostics v_new = row_count;
  if v_new > 0 and v_row.owner_id <> v_uid then
    update public.setups set downloads = downloads + 1 where id = p_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'setup', jsonb_build_object(
      'id',           v_row.id,
      'name',         v_row.name,
      'notes',        v_row.notes,
      'trackFolder',  v_row.track_folder,
      'trackName',    v_row.track_name,
      'car',          v_row.car,
      'carClass',     v_row.car_class,
      'vehicleClass', v_row.vehicle_class,
      'sessionType',  v_row.session_type,
      'tags',         to_jsonb(v_row.tags),
      'fingerprint',  v_row.fingerprint,
      'svm',          v_row.svm,
      'values',       v_row.data
    )
  );
end;
$$;

revoke all on function public.publish_setup(text, text, text, text, text, text, text, text, text[], jsonb, text, int, text, text, text, boolean) from public, anon;
revoke all on function public.rate_setup(uuid, int, int, boolean) from public, anon;
grant execute on function public.publish_setup(text, text, text, text, text, text, text, text, text[], jsonb, text, int, text, text, text, boolean) to authenticated;
grant execute on function public.rate_setup(uuid, int, int, boolean) to authenticated;
