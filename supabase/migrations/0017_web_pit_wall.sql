-- 0017_web_pit_wall.sql — the pit wall in a browser (aio.apexandchillracing.co.uk)
-- -----------------------------------------------------------------------------
-- Phase 1 of docs/COMPANION-APP-PLAN.md. The web app shows the same two
-- screens the desktop Team tab has — "My car" and "Team" — but a browser has
-- no local telemetry, so BOTH have to come from a relay:
--
--   • Team view already works: team_relay + team_relay_read (migration
--     team_engineer_phase2) carry whoever is driving to every member.
--   • My car view needs a row that exists WITHOUT a team: a driver alone in a
--     hosted race opening the pit wall on the tablet next to the rig. That is
--     public.driver_relay below — one row per account, written by that
--     account's own desktop app, readable by that account only.
--
-- The desktop publishes both rows with ONE call (relay_publish) so a driver in
-- a team does not pay two round trips a second. team_relay_publish is left in
-- place untouched for installs that predate this migration.

-- ── The driver's own row ───────────────────────────────────────────────────
create table if not exists public.driver_relay (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  payload      jsonb not null,
  map_shape    jsonb,
  history      jsonb,
  published_at timestamptz not null default now()
);

comment on table public.driver_relay is
  'Pit-wall relay of a driver''s own car, published ~1 Hz by their desktop app while they drive. Read only by the same account (web My car view). Rows older than an hour are swept on publish.';

alter table public.driver_relay enable row level security;
-- No policies on purpose: the SECURITY DEFINER functions below are the only
-- way in or out, exactly as team_relay is handled.

-- ── Publish (desktop → cloud) ─────────────────────────────────────────────
-- Writes the caller's driver_relay row, and — when p_team_id is given and the
-- caller is a member — the team_relay row too. Returns which of the two
-- landed so the desktop can show an honest relay status.
create or replace function public.relay_publish(
  p_payload    jsonb,
  p_team_id    uuid    default null,
  p_map_shape  jsonb   default null,
  p_history    jsonb   default null,
  p_driver     boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_team text := null;
begin
  if v_uid is null then
    raise exception 'relay_publish: not authenticated';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    return jsonb_build_object('ok', false, 'reason', 'no_payload');
  end if;
  if pg_column_size(p_payload) > 65536 then
    return jsonb_build_object('ok', false, 'reason', 'payload_too_large');
  end if;
  if p_map_shape is not null and pg_column_size(p_map_shape) > 65536 then
    return jsonb_build_object('ok', false, 'reason', 'shape_too_large');
  end if;
  if p_history is not null and pg_column_size(p_history) > 262144 then
    return jsonb_build_object('ok', false, 'reason', 'history_too_large');
  end if;

  if coalesce(p_driver, true) then
    insert into public.driver_relay (user_id, payload, map_shape, history)
    values (v_uid, p_payload, p_map_shape, p_history)
    on conflict (user_id) do update
      set payload      = excluded.payload,
          map_shape    = coalesce(excluded.map_shape, driver_relay.map_shape),
          history      = coalesce(excluded.history, driver_relay.history),
          published_at = now();
    -- Housekeeping on the way through: a row nobody refreshed in an hour is a
    -- finished race, not a live feed. The table is one row per active driver,
    -- so the sweep is cheap.
    delete from public.driver_relay where published_at < now() - interval '1 hour';
  end if;

  if p_team_id is not null then
    if not exists (select 1 from public.team_members
                   where team_id = p_team_id and user_id = v_uid) then
      v_team := 'not_member';
    else
      insert into public.team_relay (team_id, user_id, payload, map_shape, history)
      values (p_team_id, v_uid, p_payload, p_map_shape, p_history)
      on conflict (team_id, user_id) do update
        set payload      = excluded.payload,
            map_shape    = coalesce(excluded.map_shape, team_relay.map_shape),
            history      = coalesce(excluded.history, team_relay.history),
            published_at = now();
      delete from public.team_relay
        where team_id = p_team_id and published_at < now() - interval '1 hour';
      v_team := 'ok';
    end if;
  end if;

  return jsonb_build_object('ok', true, 'team', v_team);
end;
$$;

revoke all on function public.relay_publish(jsonb, uuid, jsonb, jsonb, boolean) from public, anon;
grant execute on function public.relay_publish(jsonb, uuid, jsonb, jsonb, boolean) to authenticated;

-- ── Read (browser ← cloud) ────────────────────────────────────────────────
-- The caller's own row, if it was published in the last two minutes. The
-- heavy blocks ride only when their revision differs from what the reader
-- already holds — the same contract as team_relay_read and the desktop's
-- local 1 Hz feed.
create or replace function public.driver_relay_read(
  p_shape_rev   integer default null,
  p_history_rev integer default null
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object('ok', true, 'source', (
    select jsonb_build_object(
      'user_id', r.user_id,
      'name', coalesce(pd.display_name, 'Driver'),
      'age_sec', round(extract(epoch from (now() - r.published_at)))::int,
      'payload', r.payload,
      'map_shape', case
        when r.map_shape is null then null
        when p_shape_rev is null then r.map_shape
        when (r.map_shape->>'revision')::int is distinct from p_shape_rev then r.map_shape
        else null end,
      'history', case
        when r.history is null then null
        when p_history_rev is null then r.history
        when (r.history->>'revision')::int is distinct from p_history_rev then r.history
        else null end
    )
    from public.driver_relay r
    left join public.public_drivers pd on pd.id = r.user_id
    where r.user_id = (select auth.uid())
      and r.published_at > now() - interval '2 minutes'
  ));
$$;

revoke all on function public.driver_relay_read(integer, integer) from public, anon;
grant execute on function public.driver_relay_read(integer, integer) to authenticated;
