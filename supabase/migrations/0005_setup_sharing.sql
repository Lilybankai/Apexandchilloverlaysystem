-- 0005_setup_sharing.sql — public setup sharing: the community's tunes.
--
-- A published setup is a library entry that left the building: the raw .svm
-- text (playable by ANY LMU install, exactly as the sim wrote it) plus the
-- parsed REST-space values (so the app can stage it key-by-key), plus the
-- metadata a stranger needs to trust it — who made it, for what track and
-- class, the maker's verified best lap there, and character tags.
--
-- Identity is deliberately NOT the leaderboard's track_id. A setup's home is
-- LMU's own Settings subfolder name (track_folder): it is identical across
-- installs, it is where a downloaded file must land to appear in the game,
-- and the garage API publishes it live (currentTrackFolder) — so the client
-- can match "setups for where you are right now" without resolve_track().
--
-- Ratings are stars + the rater's own verified pace, and they are gated:
-- you can only rate what you have downloaded (setup_downloads is the proof),
-- and never your own setup. Aggregates are computed at read time — at this
-- league's scale a GROUP BY over hundreds of rows costs nothing.

create table public.setups (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references public.profiles(id) on delete cascade,
  sim           text not null default 'lmu',
  name          text not null,
  notes         text not null default '',
  -- LMU Settings subfolder ("Spa") — the download destination and the
  -- auto-match key. Same string on every install.
  track_folder  text not null,
  -- Pretty session name ("Circuit de Spa-Francorchamps"), display + matching.
  track_name    text not null default '',
  car           text not null default '',
  car_class     text not null,
  -- The .svm header's VehicleClassSetting line — the compat token for loads.
  vehicle_class text not null default '',
  session_type  text not null default '' check (session_type in ('', 'race', 'quali')),
  -- Character chips ("Sharp", "Low drag", …): auto-suggested by the app from
  -- the setup's values, adjusted by the uploader before publishing.
  tags          text[] not null default '{}',
  -- The tune in REST key space (VM_/WM_ key -> step index), staged on load.
  data          jsonb not null,
  -- The raw .svm exactly as the sim authored it. Kept whole so the download
  -- works for any LMU player even if the key map ever drifts.
  svm           text not null,
  -- The uploader's best clean lap for this track+class from their local lap
  -- database at publish time. Attached by the app, never typed — "verified".
  best_lap_ms   int check (best_lap_ms is null or (best_lap_ms >= 5000 and best_lap_ms <= 3600000)),
  downloads     int not null default 0,
  is_public     boolean not null default true,
  app_version   text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.setups is
  'Published car setups. Written only via publish_setup(); read via browse_setups()/download_setup().';

-- Republishing the same name for the same track replaces your own share
-- rather than piling up near-duplicates.
create unique index setups_owner_track_name on public.setups (owner_id, track_folder, name);
create index setups_browse on public.setups (is_public, created_at desc);

-- Who fetched what — the proof-of-download that gates rating, and the
-- source of the downloads counter (first fetch per driver counts once).
create table public.setup_downloads (
  setup_id   uuid not null references public.setups(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (setup_id, user_id)
);

create table public.setup_ratings (
  setup_id   uuid not null references public.setups(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  stars      int not null check (stars between 1 and 5),
  -- The rater's verified best clean lap for the setup's track+class, attached
  -- by the app from the local lap database — opinion next to evidence.
  lap_ms     int check (lap_ms is null or (lap_ms >= 5000 and lap_ms <= 3600000)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (setup_id, user_id)
);

alter table public.setups enable row level security;
alter table public.setup_downloads enable row level security;
alter table public.setup_ratings enable row level security;

-- Public setups are readable by anyone signed in; your own always are.
create policy setups_select_authenticated
  on public.setups for select to authenticated
  using (is_public or owner_id = (select auth.uid()));

-- Your download receipts are yours alone to see.
create policy setup_downloads_select_own
  on public.setup_downloads for select to authenticated
  using (user_id = (select auth.uid()));

-- Ratings are public opinion — same visibility as the setups they judge.
create policy setup_ratings_select_authenticated
  on public.setup_ratings for select to authenticated using (true);

-- No insert/update/delete policies anywhere: all writes go through the
-- SECURITY DEFINER RPCs below, each pinned to auth.uid().

/* ---------------------------------------------------------------- publish */

create or replace function public.publish_setup(
  p_name          text,
  p_notes         text,
  p_track_folder  text,
  p_track_name    text,
  p_car           text,
  p_car_class     text,
  p_vehicle_class text,
  p_session_type  text,
  p_tags          text[],
  p_values        jsonb,
  p_svm           text,
  p_best_lap_ms   int default null,
  p_app_version   text default '',
  p_sim           text default 'lmu'
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
  -- A real .svm is tens of KB. Ten times that is a different (or misbehaving)
  -- client, and refusing is permanent by design — same rule as lap traces.
  if pg_column_size(p_svm) > 262144 then
    return jsonb_build_object('ok', false, 'reason', 'file_too_large');
  end if;
  if p_values is null or jsonb_typeof(p_values) <> 'object' then
    return jsonb_build_object('ok', false, 'reason', 'no_values');
  end if;
  if pg_column_size(p_values) > 131072 then
    return jsonb_build_object('ok', false, 'reason', 'values_too_large');
  end if;

  -- At most 8 tags, each a short trimmed label; empties dropped.
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
    vehicle_class, session_type, tags, data, svm, best_lap_ms, app_version
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
    left(coalesce(p_app_version, ''), 40)
  )
  on conflict (owner_id, track_folder, name) do update
    set notes         = excluded.notes,
        track_name    = excluded.track_name,
        car           = excluded.car,
        car_class     = excluded.car_class,
        vehicle_class = excluded.vehicle_class,
        session_type  = excluded.session_type,
        tags          = excluded.tags,
        data          = excluded.data,
        svm           = excluded.svm,
        best_lap_ms   = excluded.best_lap_ms,
        app_version   = excluded.app_version,
        is_public     = true,
        updated_at    = now()
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

/* ------------------------------------------------------------- unpublish */

create or replace function public.unpublish_setup(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_n   int;
begin
  if v_uid is null then
    raise exception 'unpublish_setup: not authenticated';
  end if;
  delete from public.setups where id = p_id and owner_id = v_uid;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', v_n > 0);
end;
$$;

/* ---------------------------------------------------------------- browse */

-- Every public setup, light rows only (no svm text, no values — those travel
-- on download). The client filters and sorts locally, the same way the setup
-- library card does: at league scale that is simpler and faster than three
-- filter round-trips. Newest first, capped defensively.
create or replace function public.browse_setups()
returns jsonb
language sql
security definer
set search_path to ''
as $$
  select coalesce(jsonb_agg(r order by r->>'createdAt' desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',            s.id,
      'name',          s.name,
      'notes',         s.notes,
      'trackFolder',   s.track_folder,
      'trackName',     s.track_name,
      'car',           s.car,
      'carClass',      s.car_class,
      'vehicleClass',  s.vehicle_class,
      'sessionType',   s.session_type,
      'tags',          to_jsonb(s.tags),
      'bestLapMs',     s.best_lap_ms,
      'downloads',     s.downloads,
      'createdAt',     s.created_at,
      'updatedAt',     s.updated_at,
      'ownerName',     coalesce(d.display_name, 'Driver'),
      'mine',          s.owner_id = (select auth.uid()),
      'downloaded',    exists (
                         select 1 from public.setup_downloads dl
                         where dl.setup_id = s.id and dl.user_id = (select auth.uid())
                       ),
      'myStars',       (select r.stars from public.setup_ratings r
                        where r.setup_id = s.id and r.user_id = (select auth.uid())),
      'avgStars',      (select round(avg(r.stars)::numeric, 1) from public.setup_ratings r
                        where r.setup_id = s.id),
      'ratingCount',   (select count(*) from public.setup_ratings r
                        where r.setup_id = s.id),
      'ratersBestMs',  (select min(r.lap_ms) from public.setup_ratings r
                        where r.setup_id = s.id)
    ) as r
    from public.setups s
    left join public.public_drivers d on d.id = s.owner_id
    where s.is_public or s.owner_id = (select auth.uid())
    order by s.created_at desc
    limit 500
  ) b;
$$;

/* -------------------------------------------------------------- download */

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

  -- First fetch per driver counts once; your own setup never bumps the tally.
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
      'svm',          v_row.svm,
      'values',       v_row.data
    )
  );
end;
$$;

/* ------------------------------------------------------------------ rate */

create or replace function public.rate_setup(
  p_id     uuid,
  p_stars  int,
  p_lap_ms int default null
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
  -- The gate: only drivers who actually fetched the setup get an opinion.
  if not exists (
    select 1 from public.setup_downloads
    where setup_id = p_id and user_id = v_uid
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_downloaded');
  end if;

  insert into public.setup_ratings (setup_id, user_id, stars, lap_ms)
  values (
    p_id, v_uid, p_stars,
    case when p_lap_ms between 5000 and 3600000 then p_lap_ms else null end
  )
  on conflict (setup_id, user_id) do update
    set stars      = excluded.stars,
        lap_ms     = excluded.lap_ms,
        updated_at = now();

  return jsonb_build_object(
    'ok', true,
    'avgStars', (select round(avg(stars)::numeric, 1) from public.setup_ratings where setup_id = p_id),
    'ratingCount', (select count(*) from public.setup_ratings where setup_id = p_id)
  );
end;
$$;

-- Callable by signed-in clients only; definer rights stay locked down.
revoke all on function public.publish_setup(text, text, text, text, text, text, text, text, text[], jsonb, text, int, text, text) from public, anon;
revoke all on function public.unpublish_setup(uuid) from public, anon;
revoke all on function public.browse_setups() from public, anon;
revoke all on function public.download_setup(uuid) from public, anon;
revoke all on function public.rate_setup(uuid, int, int) from public, anon;
grant execute on function public.publish_setup(text, text, text, text, text, text, text, text, text[], jsonb, text, int, text, text) to authenticated;
grant execute on function public.unpublish_setup(uuid) to authenticated;
grant execute on function public.browse_setups() to authenticated;
grant execute on function public.download_setup(uuid) to authenticated;
grant execute on function public.rate_setup(uuid, int, int) to authenticated;
