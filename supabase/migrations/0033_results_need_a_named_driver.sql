-- 0033_results_need_a_named_driver — a race is only ours if one of us was in it.
--
-- What the first day showed (2026-09-18, 39 uploads from 12 accounts): the
-- desktop reads `api/v1/results`, which is RaceOS's GLOBAL recent-results feed,
-- not the account's own history. Any app with the game open uploaded whatever
-- finished last on the platform — 24 of the 39 uploads named no driver of ours
-- at all, and the fan-out routed a race to a community on the bare fact that
-- a member's app had uploaded it. First message in a league's channel would
-- have been a podium of strangers with no "your drivers" section.
--
-- Three changes, all re-runnable:
--   1. submit_event_results refuses an upload that cannot name the uploader in
--      the classification (`not_in_race`). The client skips these too; the
--      server is the half that is ours to enforce.
--   2. fanout_notification_events routes a session_result only through a
--      participant row whose driver_name is set — an upload that found its
--      driver — never through the row every upload leaves behind.
--   3. The races already stored that nobody of ours was matched in are
--      removed, participants with them (cascade), and their held/skipped
--      notification rows too. Nothing sent has ever referenced them.
--
-- Two fixes on the client side in the same commit: the driver's name is now
-- normalised before comparing (RaceOS shows "Ryan Harris#5182" where the game
-- says "Ryan Harris"), and the harvest waits until it has a name at all — the
-- startup look fired 60 s after launch, usually before any frame, which is
-- why Sam Keesee and Matt Haskins were "not in" races they were plainly in.

-- ---------------------------------------------------------------------------
-- 1. submit_event_results — refuse a race the uploader was not in
-- ---------------------------------------------------------------------------

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
  -- The uploader has to be IN the race. `api/v1/results` is the service's
  -- global recent-results feed, so an app that has not identified its own
  -- row is offering a stranger's race — and a stranger's race is not this
  -- account's to record. The client already skips these; this is the half
  -- that is ours to enforce.
  if coalesce(btrim(p_me), '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'not_in_race');
  end if;
  if not exists (
    select 1 from jsonb_array_elements(p_classification) e
    where lower(btrim(e ->> 'name')) = lower(btrim(p_me))
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_in_race');
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


-- ---------------------------------------------------------------------------
-- 2. Fan-out — route a result only through a matched participant
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 3. Purge what should not have been stored
-- ---------------------------------------------------------------------------
-- Order matters: the notification rows are found through participants, so
-- they go before the results (whose cascade would take the participants).

delete from public.notification_events n
 where n.kind = 'session_result'
   and not exists (
     select 1 from public.event_participants p
     where p.event_key = n.payload ->> 'event_key'
       and p.driver_name <> ''
   );

delete from public.event_results r
 where not exists (
   select 1 from public.event_participants p
   where p.event_key = r.event_key and p.driver_name <> ''
 );

-- A participant row with no name is the trace of an upload that should not
-- have happened. On a race we keep, it is noise beside the real rows.
delete from public.event_participants where driver_name = '';
