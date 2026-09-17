-- 0027_event_results.sql — official race results, posted once, with the field.
--
-- The second half of docs/DISCORD-NOTIFICATIONS.md. 0026 posts records; this
-- posts the races themselves, and it exists because of what MyLMU's third
-- screenshot got wrong: "Josh Christie finished 11th". One driver's row, out of
-- a field of 23, announced as though it were the news. A league with twelve
-- members running the same daily would get twelve of those.
--
-- ── Where the results come from ────────────────────────────────────────────
--
-- Not from our own telemetry. RaceOS (raceos.gg — the service LMU's own lobby
-- talks to) publishes the FULL classification of every official daily, weekly,
-- special and championship event: grid, finish, class position, best lap, laps,
-- status, for every driver in it, including the twenty who have never heard of
-- this app. That is a far better message than one row of it, and it is
-- authoritative in a way a self-reported lap can never be.
--
-- It also cannot be fetched from here. The token is bought with a Steam session
-- ticket from the running game (see src/telemetry/raceosRanks.ts), so the
-- DESKTOP harvests and this database receives — which makes the shape of this
-- migration inevitable: an upload arrives once per member who was in the race,
-- carrying the same classification every time, and everything below is about
-- turning twelve of those into one message.
--
-- ── Why nothing is posted for ten minutes ──────────────────────────────────
--
-- The first upload wins: it writes the event and emits the notification. But
-- the notification's whole content is "which of YOUR members were in this",
-- and at the instant of the first upload the answer is "one — the uploader".
-- The other eleven apps are minutes behind, each waiting on its own poll.
--
-- So `notification_events.hold_until` (added here, and honoured by the fan-out)
-- keeps a result invisible until the stragglers have landed. Ten minutes is a
-- long time for a record and nothing at all for a race result: the race took
-- forty minutes and the standings are not going to change.
--
-- ── What is deliberately not stored ────────────────────────────────────────
--
-- `api/v1/player` hands back the account's email address and a LIVE email
-- verification code beside the racing data. Nothing in this pipeline calls it,
-- and `submit_event_results` takes a fixed set of named columns rather than a
-- blob, so a client that starts sending more cannot quietly widen what we keep.
-- This is the one path in the product that ends in a public Discord message;
-- it holds names, positions and lap times, which is what the game shows
-- everyone, and nothing else. No ratings either — RaceOS redacts other
-- players' Elo, and republishing a rating that leaks would be our doing.
--
-- Re-runnable: `if not exists`, `create or replace`, idempotent throughout.

-- ---------------------------------------------------------------------------
-- 1. hold_until — an event that is not ready to be told
-- ---------------------------------------------------------------------------

alter table public.notification_events
  add column if not exists hold_until timestamptz not null default now();

comment on column public.notification_events.hold_until is
  'Fan-out ignores this row until now() passes it. A record is ready the moment it is set; a race result has to wait for the other members'' apps to upload the same race, because "who of ours was in it" is the entire message.';

-- The pending index has to know about it too, or the fan-out scan keeps
-- finding rows it will only skip.
drop index if exists notification_events_pending_idx;
create index if not exists notification_events_pending_idx
  on public.notification_events (hold_until) where fanned_out_at is null;

-- ---------------------------------------------------------------------------
-- 2. event_results — one row per official event, whoever uploaded it
-- ---------------------------------------------------------------------------

create table if not exists public.event_results (
  event_key      text primary key,
  source         text not null default 'raceos',
  event_type     text not null default '',
  name           text not null default '',
  track          text not null default '',
  started_at     timestamptz,
  classification jsonb not null default '[]'::jsonb,
  first_seen_by  uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now()
);

comment on table public.event_results is
  'The classification of one official LMU event, as RaceOS publishes it, projected down by the desktop app before upload. Written only via submit_event_results(). The first upload wins and every later one is a no-op on this table — the classification is the same race whoever fetched it.';

comment on column public.event_results.event_key is
  'RaceOS''s own id for the event, prefixed by source. The dedupe key that turns twelve members'' uploads into one row and one message.';

comment on column public.event_results.classification is
  'Array of {pos, classPos, gridPos, name, car, carClass, laps, bestLapMs, totalMs, status}. Capped and projected on the CLIENT: the raw payload is 2.3 MB for ten events and must never be stored or forwarded.';

create table if not exists public.event_participants (
  event_key   text not null references public.event_results(event_key) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  driver_name text not null default '',
  created_at  timestamptz not null default now(),
  primary key (event_key, user_id)
);

comment on table public.event_participants is
  'Which of OUR accounts were in an event, and under what name in the classification. Built one row per upload — an account appears here only because its own app said so, never by matching names, which would put a stranger''s result in a league''s channel the first time two drivers shared a name.';

create index if not exists event_participants_user_idx
  on public.event_participants (user_id);

alter table public.event_results      enable row level security;
alter table public.event_participants enable row level security;

-- ---------------------------------------------------------------------------
-- 3. submit_event_results — the one door in
-- ---------------------------------------------------------------------------
-- Idempotent by construction, because it is called by every member who was in
-- the race and (after a reinstall) possibly twice by the same one.

create or replace function public.submit_event_results(
  p_event_key      text,
  p_event_type     text,
  p_name           text,
  p_track          text,
  p_started_at     timestamptz,
  p_classification jsonb,
  p_me             text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_key   text := left(btrim(coalesce(p_event_key, '')), 200);
  v_rows  int;
  v_fresh boolean := false;
begin
  if v_uid is null then
    raise exception 'submit_event_results: not authenticated';
  end if;
  if v_key = '' then
    return jsonb_build_object('ok', false, 'reason', 'no_event_key');
  end if;
  if p_classification is null or jsonb_typeof(p_classification) <> 'array' then
    return jsonb_build_object('ok', false, 'reason', 'no_classification');
  end if;
  -- A field of 200 is not an LMU race, it is a client sending something else.
  -- The cap is here as well as on the client because only this side is ours.
  if jsonb_array_length(p_classification) = 0
     or jsonb_array_length(p_classification) > 120 then
    return jsonb_build_object('ok', false, 'reason', 'implausible_field');
  end if;
  if pg_column_size(p_classification) > 65536 then
    return jsonb_build_object('ok', false, 'reason', 'too_big');
  end if;

  -- Every row must be an object with a NUMERIC pos and a name, checked at the
  -- door rather than trusted.
  --
  -- Not defensiveness for its own sake: the podium below and the per-channel
  -- member list in the fan-out both `order by (e ->> 'pos')::int`, and a single
  -- row carrying "abc" would raise inside fanout_notification_events() — which
  -- processes every pending event in one loop. One malformed upload would
  -- therefore stop every notification for every community until someone found
  -- it. The client projection already guarantees this shape; this is the half
  -- that is ours to enforce.
  if exists (
    select 1
    from jsonb_array_elements(p_classification) e
    where jsonb_typeof(e) <> 'object'
       or jsonb_typeof(e -> 'pos') <> 'number'
       or coalesce(btrim(e ->> 'name'), '') = ''
  ) then
    return jsonb_build_object('ok', false, 'reason', 'bad_row');
  end if;

  insert into public.event_results (
    event_key, event_type, name, track, started_at, classification, first_seen_by
  ) values (
    v_key,
    left(btrim(coalesce(p_event_type, '')), 40),
    left(btrim(coalesce(p_name, '')), 120),
    left(btrim(coalesce(p_track, '')), 120),
    p_started_at,
    p_classification,
    v_uid
  )
  on conflict (event_key) do nothing;

  get diagnostics v_rows = row_count;
  v_fresh := v_rows > 0;

  -- Always, first upload or twelfth: this is how a community learns that one
  -- of ITS people was in the race.
  insert into public.event_participants (event_key, user_id, driver_name)
  values (v_key, v_uid, left(btrim(coalesce(p_me, '')), 80))
  on conflict (event_key, user_id) do update
    set driver_name = excluded.driver_name
    where public.event_participants.driver_name = '';

  -- Emitted once, by whoever got here first, and held long enough for the
  -- others to add themselves above.
  if v_fresh then
    begin
      insert into public.notification_events (
        kind, actor_id, board_key, collapse_key, hold_until, payload
      ) values (
        'session_result',
        v_uid,
        null,
        'event:' || v_key,
        now() + interval '10 minutes',
        jsonb_build_object(
          'kind',       'session_result',
          'event_key',  v_key,
          'event_type', left(btrim(coalesce(p_event_type, '')), 40),
          'name',       left(btrim(coalesce(p_name, '')), 120),
          'track',      left(btrim(coalesce(p_track, '')), 120),
          'started_at', p_started_at,
          'entries',    jsonb_array_length(p_classification),
          -- Only the sharp end travels in the payload. The rest of the field
          -- is in event_results if anyone ever wants it, but no embed can show
          -- forty rows and stay readable on a phone.
          -- The guard is a CASE, not two ANDed conditions: Postgres is free to
          -- reorder AND, so `where x ~ '^[0-9]+$' and x::int <= 3` can still
          -- evaluate the cast first and raise on the row the regex existed to
          -- exclude. CASE is the one construct that guarantees the order.
          'podium',     (
            select coalesce(jsonb_agg(e order by (e -> 'pos')), '[]'::jsonb)
            from jsonb_array_elements(p_classification) e
            where case
                    when jsonb_typeof(e -> 'pos') = 'number'
                      then (e ->> 'pos')::numeric <= 3
                    else false
                  end
          )
        )
      );
    exception when others then
      raise warning 'submit_event_results: notification not emitted (%): %',
        sqlstate, sqlerrm;
    end;
  end if;

  return jsonb_build_object('ok', true, 'stored', v_fresh, 'event_key', v_key);
end;
$$;

revoke all on function public.submit_event_results(
  text, text, text, text, timestamptz, jsonb, text) from public, anon;
grant execute on function public.submit_event_results(
  text, text, text, text, timestamptz, jsonb, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Fan-out — results route on who was in them, not on boards
-- ---------------------------------------------------------------------------
-- Replaces the 0026 function. Two changes: hold_until is honoured, and a
-- `session_result` reaches a channel when one of that community's own members
-- was in the race — with the members' own rows folded into the payload, so the
-- embed can say "and yours finished 4th and 11th" without the dispatcher
-- needing to know what a community is.

create or replace function public.fanout_notification_events(p_limit int default 200)
returns int
language plpgsql
security definer
set search_path = public
as $$
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
          when v_evt.kind = 'session_result' then 'member'
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
        and (
          case when v_evt.kind = 'session_result' then
            -- A race reaches a channel when one of its people was in it. A
            -- personal channel means the owner; a community, any member who
            -- has not opted out.
            (
              t.community_id is null
              and exists (
                select 1 from public.event_participants p
                where p.event_key = v_evt.payload ->> 'event_key'
                  and p.user_id = t.owner_id
              )
            )
            or exists (
              select 1
              from public.event_participants p
              join public.community_members m
                on m.user_id = p.user_id and m.community_id = t.community_id
              where p.event_key = v_evt.payload ->> 'event_key'
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

      -- The rows belonging to THIS channel's people, resolved here because the
      -- dispatcher has no idea who is in which community. `share = 'all'` is
      -- already required above; a member set to 'records' is simply not named.
      v_mine := null;
      if v_evt.kind = 'session_result' then
        -- Ordered by the jsonb number itself, never by a cast of its text:
        -- submit_event_results refuses a non-numeric pos, and this ordering is
        -- the reason it has to.
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
        -- A result has already waited ten minutes to be told; it does not need
        -- the record coalesce window on top.
        case when v_evt.kind = 'session_result' then now() else now() + interval '4 minutes' end
      )
      on conflict (target_id, dedupe_key) do nothing;

      v_made := v_made + 1;
    end loop;

    update public.notification_events set fanned_out_at = now() where id = v_evt.id;
  end loop;

  return v_made;
end;
$$;

revoke all on function public.fanout_notification_events(int) from public, anon, authenticated;
grant execute on function public.fanout_notification_events(int) to service_role;

-- ---------------------------------------------------------------------------
-- 5. New channels hear about races too
-- ---------------------------------------------------------------------------
-- The column default only applies to rows this file's own insert does not name,
-- but save_discord_target names it, so both have to move together.

alter table public.discord_targets
  alter column kinds set default array['record_taken', 'record_set', 'session_result'];

-- A default only applies to rows made after it, so any channel configured
-- between 0026 and this file would silently never receive a result — the
-- fan-out filters on `kind = any(kinds)` and would simply never match. There is
-- no "off" to respect yet, because until this migration there was nothing to
-- turn off, so every existing channel is opted in once and can opt out in the
-- panel afterwards.
update public.discord_targets
   set kinds = kinds || array['session_result']
 where not ('session_result' = any(kinds));

create or replace function public.save_discord_target(
  p_id           uuid    default null,
  p_community    uuid    default null,
  p_label        text    default '',
  p_webhook      text    default null,
  p_kinds        text[]  default null,
  p_watch_boards boolean default null,
  p_min_entries  int     default null,
  p_daily_cap    int     default null,
  p_paused       boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_url text := btrim(coalesce(p_webhook, ''));
  v_id  uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if p_community is not null and not exists (
    select 1 from public.community_members
    where community_id = p_community and user_id = v_uid and role in ('owner', 'admin')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_admin');
  end if;

  if v_url <> '' and v_url !~ '^https://(canary\.|ptb\.)?discord(app)?\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]+$' then
    return jsonb_build_object('ok', false, 'reason', 'not_a_discord_webhook');
  end if;

  if p_id is null then
    if v_url = '' then
      return jsonb_build_object('ok', false, 'reason', 'no_webhook');
    end if;
    insert into public.discord_targets (community_id, owner_id, label, webhook_url, kinds)
    values (
      p_community, v_uid, left(btrim(coalesce(p_label, '')), 60), v_url,
      coalesce(
        p_kinds,
        case
          when p_community is null
            then array['record_taken', 'record_set', 'record_extended', 'session_result']
          else array['record_taken', 'record_set', 'session_result']
        end
      )
    )
    returning id into v_id;
  else
    select t.id into v_id
    from public.discord_targets t
    where t.id = p_id
      and (
        t.owner_id = v_uid
        or exists (
          select 1 from public.community_members m
          where m.community_id = t.community_id and m.user_id = v_uid
            and m.role in ('owner', 'admin')
        )
      );
    if v_id is null then
      return jsonb_build_object('ok', false, 'reason', 'no_such_channel');
    end if;
  end if;

  update public.discord_targets t
     set label             = coalesce(left(btrim(p_label), 60), t.label),
         webhook_url       = case when v_url = '' then t.webhook_url else v_url end,
         kinds             = coalesce(p_kinds, t.kinds),
         watch_boards      = coalesce(p_watch_boards, t.watch_boards),
         min_board_entries = greatest(0, least(coalesce(p_min_entries, t.min_board_entries), 100)),
         daily_cap         = greatest(0, least(coalesce(p_daily_cap, t.daily_cap), 500)),
         paused_at         = case
                               when p_paused is null then t.paused_at
                               when p_paused then coalesce(t.paused_at, now())
                               else null
                             end,
         failures          = case when v_url = '' then t.failures else 0 end,
         last_error        = case when v_url = '' then t.last_error else null end
   where t.id = v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

revoke all on function public.save_discord_target(
  uuid, uuid, text, text, text[], boolean, int, int, boolean) from public, anon;
grant execute on function public.save_discord_target(
  uuid, uuid, text, text, text[], boolean, int, int, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Housekeeping
-- ---------------------------------------------------------------------------
-- Results are kept far longer than the messages made from them: they are the
-- only record of a race anyone can point at afterwards, and they are small.

create or replace function public.event_results_prune()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gone int;
begin
  delete from public.event_results where created_at < now() - interval '400 days';
  get diagnostics v_gone = row_count;
  return v_gone;
end;
$$;

revoke all on function public.event_results_prune() from public, anon, authenticated;
grant execute on function public.event_results_prune() to service_role;
