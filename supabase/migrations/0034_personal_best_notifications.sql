-- 0034_personal_best_notifications.sql — every improvement, not just the lead.
--
-- Carl, 2026-09-28, once the record embeds had proved themselves: "we want to
-- include anyone that improves their time and where that puts them on the
-- [leaderboard] and what reference pace they have according to the reference
-- pace widget".
--
-- Three changes, all on the paths 0026/0033 already built:
--
--   1. submit_lap emits a new kind, `personal_best`, when a driver beats their
--      OWN board time without taking the lead. It carries the board position
--      before and after, the board size, and who leads and by how much.
--      The record kinds are unchanged except that they now carry the same
--      position and pace fields.
--
--   2. The reference pace comes from the APP, riding in p_conditions.pace.
--      The server cannot score a lap itself: resolving the layout needs the
--      sim's trackConfig and scene name (see referencePace.ts — Monza, Le Mans
--      and Fuji are 4-16 s apart between layouts), and a wrong score is worse
--      than none. So the client scores it with the same scoreLap() the widget
--      uses, and the server only CHECKS it: the percentage must be what
--      lap_ms / ref_ms actually says, or the pace is dropped. A client cannot
--      claim "Alien" for a lap the arithmetic says is Midpack. `pace` is
--      stripped before `conditions` is stored — it is a message, not a fact
--      about the weather. No new argument, so `create or replace` keeps the
--      grants and every installed client (see 0026 on the 0021 overload trap).
--
--   3. Fan-out routes `personal_best` on the MEMBER axis only, and only for a
--      member whose share is 'all'. A stranger's PB is not news in a league's
--      channel (no boards axis), and a member who chose "records only" meant
--      exactly that. Nobody is displaced, so there is no subject axis either.
--
-- Volume: improvements share the record's collapse key (board + driver), so a
-- practice session of five PBs edits ONE message in place, and a PB that later
-- becomes a record edits into the record. First laps on a board (no previous
-- time) are not improvements and emit nothing, same as before.

-- ---------------------------------------------------------------------------
-- 1. submit_lap
-- ---------------------------------------------------------------------------

create or replace function public.submit_lap(
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
  -- The board as it stood before this lap.
  v_lead_id     uuid;
  v_lead_ms     integer;
  v_lead_set_at timestamptz;
  v_entries     integer := 0;
  v_prev_rank   integer;
  v_kind        text;
  -- The reference pace the app sent, once checked.
  v_pace_in     jsonb := coalesce(p_conditions, '{}'::jsonb) -> 'pace';
  v_pace        jsonb;
  v_ref_ms      integer;
  v_pct         numeric;
begin
  if v_uid is null then
    raise exception 'submit_lap: not authenticated';
  end if;
  if not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'submit_lap: no profile for this account';
  end if;

  if v_class = '' then
    return jsonb_build_object('accepted', false, 'reason', 'unknown_class');
  end if;
  if v_cond not in ('dry', 'damp', 'wet') then
    v_cond := 'dry';
  end if;
  if p_lap_ms is null or p_lap_ms < 5000 or p_lap_ms > 3600000 then
    return jsonb_build_object('accepted', false, 'reason', 'implausible_time');
  end if;
  if v_set_at > now() + interval '1 day' or v_set_at < now() - interval '365 days' then
    return jsonb_build_object('accepted', false, 'reason', 'clock_skew');
  end if;

  v_track_id := public.resolve_track(p_sim, p_track_key, p_track_name, p_track_length_m);

  select lap_ms into v_prev_ms
  from public.driver_best_laps
  where driver_id = v_uid and track_id = v_track_id
    and car_class = v_class and condition = v_cond;

  -- Who held this board, how many people were on it, and where THIS driver sat.
  -- Read now; the upsert below is about to make all three unanswerable.
  select b.driver_id, b.lap_ms, b.set_at
    into v_lead_id, v_lead_ms, v_lead_set_at
  from public.driver_best_laps b
  where b.track_id = v_track_id and b.car_class = v_class and b.condition = v_cond
  order by b.lap_ms asc, b.set_at asc
  limit 1;

  select count(distinct b.driver_id) into v_entries
  from public.driver_best_laps b
  where b.track_id = v_track_id and b.car_class = v_class and b.condition = v_cond;

  if v_prev_ms is not null then
    select count(*) + 1 into v_prev_rank
    from public.driver_best_laps b
    where b.track_id = v_track_id and b.car_class = v_class and b.condition = v_cond
      and b.lap_ms < v_prev_ms;
  end if;

  -- `- 'pace'`: the score is a message for the notification below, not a fact
  -- about the conditions the lap was driven in.
  insert into public.driver_best_laps (
    driver_id, track_id, car_class, condition, lap_ms, car, sim, set_at,
    conditions, app_version
  ) values (
    v_uid, v_track_id, v_class, v_cond, p_lap_ms, btrim(coalesce(p_car, '')),
    lower(btrim(coalesce(p_sim, ''))), v_set_at,
    coalesce(p_conditions, '{}'::jsonb) - 'pace', coalesce(p_app_version, '')
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

  v_best_ms := least(p_lap_ms, coalesce(v_prev_ms, p_lap_ms));

  select count(*) + 1 into v_rank
  from public.driver_best_laps b
  where b.track_id = v_track_id
    and b.car_class = v_class
    and b.condition = v_cond
    and b.lap_ms < v_best_ms;

  -- ── The notification event ───────────────────────────────────────────────
  -- A change of board leader is a record (0026, unchanged). Any other
  -- improvement on a time the driver already had is a personal best. A first
  -- lap on a board is neither: it improved nothing.
  if v_improved then
    begin
      v_kind := case
        when v_rank = 1 and (v_lead_ms is null or p_lap_ms < v_lead_ms) then
          case
            when v_lead_id is null then 'record_set'
            when v_lead_id = v_uid then 'record_extended'
            else 'record_taken'
          end
        when v_prev_ms is not null then 'personal_best'
        else null
      end;

      -- The pace is checked, never trusted: the percentage has to be what
      -- this lap against that reference actually works out to. Dry only — the
      -- sheet's times are dry laps, and the app never scores a wet one.
      if v_kind is not null and v_cond = 'dry' and jsonb_typeof(v_pace_in) = 'object' then
        v_ref_ms := case when (v_pace_in ->> 'ref_ms') ~ '^[0-9]{4,7}$'
                         then (v_pace_in ->> 'ref_ms')::integer end;
        if v_ref_ms between 5000 and 3600000 then
          v_pct := round(p_lap_ms::numeric * 100 / v_ref_ms, 1);
          if v_pct between 80 and 200
             and (v_pace_in ->> 'percent') ~ '^[0-9]{2,3}(\.[0-9]+)?$'
             and abs(v_pct - (v_pace_in ->> 'percent')::numeric) <= 0.2
             and coalesce(v_pace_in ->> 'band', '') ~ '^[A-Za-z][A-Za-z -]{0,23}$' then
            v_pace := jsonb_build_object(
              'percent',  v_pct,
              'band',     v_pace_in ->> 'band',
              'ref_ms',   v_ref_ms,
              'delta_ms', p_lap_ms - v_ref_ms,
              'assumed',  coalesce(v_pace_in ->> 'assumed', '') = 'true'
            );
          end if;
        end if;
      end if;

      if v_kind is not null then
        insert into public.notification_events (
          kind, actor_id, subject_id, board_key, collapse_key, payload
        )
        select
          v_kind,
          v_uid,
          case when v_kind = 'record_taken' then v_lead_id else null end,
          v_track_id::text || '|' || v_class || '|' || v_cond,
          -- Shared by every kind: a PB that later becomes the record edits
          -- into it rather than posting beside it.
          'board:' || v_track_id::text || ':' || v_class || ':' || v_cond || ':' || v_uid::text,
          jsonb_strip_nulls(jsonb_build_object(
            'kind',           v_kind,
            'driver',         coalesce(me.display_name, 'A driver'),
            'driver_id',      v_uid,
            'track',          t.name,
            'track_id',       v_track_id,
            'car',            btrim(coalesce(p_car, '')),
            'car_class',      v_class,
            'condition',      v_cond,
            'lap_ms',         p_lap_ms,
            -- Records: the time that fell and who held it (0026's meaning,
            -- which the dispatcher already renders). A PB has no holder.
            'previous_ms',    case when v_kind = 'personal_best' then null else v_lead_ms end,
            'gap_ms',         case when v_kind = 'personal_best' or v_lead_ms is null
                                   then null else v_lead_ms - p_lap_ms end,
            'held_since',     case when v_kind = 'personal_best' then null else v_lead_set_at end,
            'holder',         case when v_kind = 'personal_best' then null else prev.display_name end,
            'holder_id',      case when v_kind = 'personal_best' then null else v_lead_id end,
            -- A PB: the driver's own time it replaced, and who is still ahead.
            'own_previous_ms', v_prev_ms,
            'leader',         case when v_kind = 'personal_best' then prev.display_name end,
            'leader_ms',      case when v_kind = 'personal_best' then v_lead_ms end,
            -- Where it puts them. board_entries keeps 0026's meaning (drivers
            -- BEFORE this lap — the fan-out's floor reads it); board_size is
            -- the board as it now stands, for the embed.
            'rank',           v_rank,
            'previous_rank',  v_prev_rank,
            'board_entries',  v_entries,
            'board_size',     v_entries + case when v_prev_ms is null then 1 else 0 end,
            'pace',           v_pace,
            'session_type',   nullif(coalesce(p_conditions, '{}'::jsonb) ->> 'sessionType', ''),
            'sim',            lower(btrim(coalesce(p_sim, ''))),
            'app_version',    coalesce(p_app_version, ''),
            'set_at',         v_set_at
          ))
        from public.profiles me
        left join public.profiles prev on prev.id = v_lead_id
        left join public.tracks t on t.id = v_track_id
        where me.id = v_uid;
      end if;
    exception when others then
      raise warning 'submit_lap: notification event not emitted (%): %',
        sqlstate, sqlerrm;
    end;
  end if;

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

revoke all on function public.submit_lap(
  text, text, text, integer, text, text, integer, timestamptz, jsonb, text, text) from public, anon;
grant execute on function public.submit_lap(
  text, text, text, integer, text, text, integer, timestamptz, jsonb, text, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Fan-out — 0033's, with personal_best on the member axis only
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
          when v_evt.kind in ('session_result', 'personal_best') then 'member'
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
          case
          when v_evt.kind = 'session_result' then
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
          when v_evt.kind = 'personal_best' then
            -- The driver's own channel, or a league they share EVERYTHING
            -- with. Never a stranger's, never on the boards axis.
            (t.community_id is null and t.owner_id = v_evt.actor_id)
            or exists (
              select 1 from public.community_members m
              where m.community_id = t.community_id
                and m.user_id = v_evt.actor_id
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

      v_mine := null;
      if v_evt.kind = 'session_result' then
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
-- 3. Switch it on where it was asked for
-- ---------------------------------------------------------------------------
-- Every existing channel already taking improvements to a record wants the
-- rest of the improvements too — that is the request. Channels without
-- record_extended were set up to hear about leaders only and are left alone.

update public.discord_targets
   set kinds = kinds || array['personal_best']
 where 'record_extended' = any(kinds)
   and not ('personal_best' = any(kinds));

comment on table public.notification_events is
  'One row per thing that happened, whoever it reaches. kind: record_taken (a leader displaced, someone else had held it), record_set (leader of a board that had nobody), record_extended (you beat your own record), personal_best (you beat your own time without taking the lead — member axis only), session_result (an official race).';
