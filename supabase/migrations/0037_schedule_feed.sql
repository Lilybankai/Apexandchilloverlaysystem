-- 0037_schedule_feed.sql — the Schedule tab on the web pit wall
-- -----------------------------------------------------------------------------
-- The desktop Schedule tab reads two calendars live: the league's Thursday and
-- Saturday championships from SimGrid, and Le Mans Ultimate's own daily,
-- weekly and special races from RaceOS. A browser can read neither — SimGrid
-- sends no CORS headers, and RaceOS only answers a Steam ticket minted by a
-- running copy of the game — so the web page shows the calendar a desktop app
-- last PUBLISHED here (electron/schedule-cloud.js).
--
-- One row per calendar, shared by everyone: the calendar is the same for every
-- driver. The one personal field in it ("you are entered") is cleared by the
-- desktop before it publishes (forPublish in control-panel/schedule-core.js).
--
-- Newest wins, by the time the DESKTOP read the source (p_fetched_at), not the
-- time it reached us — so a copy that was slow to arrive can never overwrite a
-- fresher one. A row younger than ten minutes is left alone, which caps writes
-- at six an hour per calendar however many desktops are running.

create table if not exists public.schedule_feed (
  source       text primary key check (source in ('league', 'dailies')),
  payload      jsonb not null,
  fetched_at   timestamptz not null,
  published_at timestamptz not null default now(),
  published_by uuid references auth.users(id) on delete set null
);

comment on table public.schedule_feed is
  'The Schedule tab''s two calendars (league = SimGrid, dailies = RaceOS) as a desktop app last read them, for the web pit wall. Shared by everyone; per-driver fields are cleared before publishing.';

alter table public.schedule_feed enable row level security;
-- No policies on purpose: the SECURITY DEFINER functions below are the only
-- way in or out, as with driver_relay and team_relay.

-- ── How old is each calendar? (desktop, before it spends a fetch) ──────────
-- The desktop asks this first and only reads a source when the shared copy is
-- stale, so a room full of running apps costs RaceOS one read, not one each.
create or replace function public.schedule_feed_age()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'ok', true,
    'league',  (select round(extract(epoch from (now() - fetched_at)))::int
                from public.schedule_feed where source = 'league'),
    'dailies', (select round(extract(epoch from (now() - fetched_at)))::int
                from public.schedule_feed where source = 'dailies')
  );
$$;

revoke all on function public.schedule_feed_age() from public, anon;
grant execute on function public.schedule_feed_age() to authenticated;

-- ── Publish (desktop → cloud) ─────────────────────────────────────────────
create or replace function public.schedule_feed_publish(
  p_source     text,
  p_payload    jsonb,
  p_fetched_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_prev public.schedule_feed%rowtype;
begin
  if v_uid is null then
    raise exception 'schedule_feed_publish: not authenticated';
  end if;
  -- The row is shown to every member, so only a member may write it: a
  -- lapsed or never-paid account can sign in, but cannot set the calendar.
  if coalesce((public.entitlement_status()->>'entitled')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'reason', 'not_entitled');
  end if;
  if p_source is null or p_source not in ('league', 'dailies') then
    return jsonb_build_object('ok', false, 'reason', 'bad_source');
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or (p_payload->>'ok') is distinct from 'true' then
    return jsonb_build_object('ok', false, 'reason', 'no_payload');
  end if;
  -- The shapes the renderer walks. Anything else is not a calendar.
  if p_source = 'league' and jsonb_typeof(p_payload->'leagues') is distinct from 'array' then
    return jsonb_build_object('ok', false, 'reason', 'no_payload');
  end if;
  if p_source = 'dailies' and jsonb_typeof(p_payload->'tiers') is distinct from 'array' then
    return jsonb_build_object('ok', false, 'reason', 'no_payload');
  end if;
  -- A day's calendar with every circuit outline is ~40 KB; this is headroom.
  if pg_column_size(p_payload) > 262144 then
    return jsonb_build_object('ok', false, 'reason', 'payload_too_large');
  end if;
  -- A clock that runs fast must not pin its copy as "newest" for hours.
  if p_fetched_at is null or p_fetched_at > now() + interval '5 minutes' then
    return jsonb_build_object('ok', false, 'reason', 'bad_time');
  end if;

  select * into v_prev from public.schedule_feed where source = p_source;
  if found then
    if v_prev.fetched_at >= p_fetched_at then
      return jsonb_build_object('ok', true, 'stored', false, 'reason', 'not_newer');
    end if;
    if v_prev.published_at > now() - interval '10 minutes' then
      return jsonb_build_object('ok', true, 'stored', false, 'reason', 'fresh');
    end if;
  end if;

  insert into public.schedule_feed (source, payload, fetched_at, published_at, published_by)
  values (p_source, p_payload, least(p_fetched_at, now()), now(), v_uid)
  on conflict (source) do update
    set payload      = excluded.payload,
        fetched_at   = excluded.fetched_at,
        published_at = excluded.published_at,
        published_by = excluded.published_by;

  return jsonb_build_object('ok', true, 'stored', true);
end;
$$;

revoke all on function public.schedule_feed_publish(text, jsonb, timestamptz) from public, anon;
grant execute on function public.schedule_feed_publish(text, jsonb, timestamptz) to authenticated;

-- ── Read (browser ← cloud) ────────────────────────────────────────────────
-- Both calendars in one call. Who published is deliberately not returned.
create or replace function public.schedule_feed_read()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'ok', true,
    'league', (select jsonb_build_object(
                 'payload', payload,
                 'fetched_at', fetched_at,
                 'age_sec', round(extract(epoch from (now() - fetched_at)))::int)
               from public.schedule_feed where source = 'league'),
    'dailies', (select jsonb_build_object(
                  'payload', payload,
                  'fetched_at', fetched_at,
                  'age_sec', round(extract(epoch from (now() - fetched_at)))::int)
                from public.schedule_feed where source = 'dailies')
  );
$$;

revoke all on function public.schedule_feed_read() from public, anon;
grant execute on function public.schedule_feed_read() to authenticated;
