-- 0026_discord_communities.sql — records and results into a league's Discord.
--
-- Carl, 2026-09-17, looking at MyLMU's webhook embeds: "when someone beats a
-- lap time in the leaderboard... the app automatically puts the Discord
-- notification into a specified channel". Three screenshots came with it, and
-- they are the specification for what NOT to do: one lap produced two embeds
-- (all-time car record, all-time class record) and the race it was set in
-- produced a third, announcing an 11th place. One driver, one 43-minute race,
-- three notifications. At ten users that is charming. At five hundred it is
-- the reason the channel gets muted, and a muted channel is worth nothing to
-- anybody.
--
-- So the unit here is the EVENT, not the achievement: one row per thing that
-- happened, carrying however many achievements it earned, and the dispatcher
-- turns it into exactly one message.
--
-- ── Who gets told: two axes, only one of which needs a roster ───────────────
--
-- A target subscribes on two independent axes, and separating them is what
-- makes "an outsider beats our record and it lands in our Discord" possible
-- without dragging every user of the app into that Discord:
--
--   members — whose events go to this channel. Needs a roster.
--   boards  — which records this channel cares about, whoever set them. Needs
--             no roster at all: it routes on the BOARD, so a stranger with no
--             community and no idea Apex exists fires into Apex's channel the
--             moment they take a record on a board Apex races on.
--
-- ── Why communities and not teams ──────────────────────────────────────────
--
-- `teams` already exists, has invite codes, and would have been free. It is
-- also capped at six members (electron/team-cloud.js: "That team already has 6
-- members") because it models an endurance lineup doing driver swaps. A league
-- Discord is forty people who never share a car. Carl, asked which one owns a
-- channel: "drop the team and make it community". So a community is a new
-- object with the same proven shape — one persistent join code, owner rotates
-- it and can remove people — and no cap.
--
-- Most users never touch it. A driver who is in nobody's league pastes their
-- own webhook, gets a personal target (community_id null), and no roster
-- exists anywhere. That is the default path, and it is the answer to "what
-- about people outside the Apex community".
--
-- ── The webhook URL is a capability, not a setting ─────────────────────────
--
-- Anyone holding a Discord webhook URL can post to that channel, as that
-- channel's app, forever, until someone deletes it in Discord. It is therefore
-- stored like a secret and never leaves the server: these tables have RLS on
-- with NO policies, every door is SECURITY DEFINER, and the read side returns
-- a MASKED url. A league admin who can see their own webhook can already see
-- it in Discord; a member who merely joined their channel must never be able
-- to read it out of our API and post to the league themselves.
--
-- ── The trap this migration exists to avoid ────────────────────────────────
--
-- A record on an empty board is not news. Boards key by track x class x
-- surface (0021), which is several hundred boards, every one of them starting
-- empty — and the first lap on an empty board is technically an all-time
-- record, as is the second, as is the third, for as long as one person is
-- beating themselves. Ship without a floor and the week a new track lands the
-- channel becomes a wall of trophies won against nobody. `min_board_entries`
-- is that floor, counted in DISTINCT DRIVERS and evaluated BEFORE the incoming
-- lap, and `record_extended` (you beat your own) is off by default everywhere
-- but a personal channel.
--
-- ── Where the solo-lap rule went ───────────────────────────────────────────
--
-- Carl: "offline solo laps only count if they beat a record on the
-- leaderboard". Nothing below implements that rule, because nothing needs to:
-- a lap only ever emits an event by CHANGING A BOARD LEADER. A personal best
-- that beats nobody emits nothing, whether it was set in a 24-hour race or
-- alone at midnight. The rule falls out of the design, which is fortunate —
-- the app cannot presently tell an online session from an offline one, no such
-- signal exists in lmuRestProvider yet, and this way it does not need one
-- until session RESULTS arrive, which are online by construction.
--
-- Re-runnable: `if not exists`, `create or replace`, idempotent throughout.

-- ---------------------------------------------------------------------------
-- 1. communities — the league, and the code that lets someone into it
-- ---------------------------------------------------------------------------

create table if not exists public.communities (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  owner_id   uuid references auth.users(id) on delete set null,
  join_code  text not null unique,
  created_at timestamptz not null default now()
);

comment on table public.communities is
  'A racing community — a league, a Discord, a group of friends. Owns Discord targets and a roster. Unlike teams (capped at 6, for driver swaps) a community has no size limit and no bearing on telemetry: it exists only to route notifications.';

comment on column public.communities.join_code is
  'The persistent invite code, XXXX-XXXX. Pasted in the community''s own Discord for members to enter in the app. Rotatable by the owner, because a leaked code is a stranger publishing into your channel.';

create table if not exists public.community_members (
  community_id uuid not null references public.communities(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'member',
  share        text not null default 'all',
  joined_at    timestamptz not null default now(),
  primary key (community_id, user_id)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'community_members_role_check') then
    alter table public.community_members
      add constraint community_members_role_check check (role in ('owner', 'admin', 'member'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'community_members_share_check') then
    alter table public.community_members
      add constraint community_members_share_check check (share in ('none', 'records', 'all'));
  end if;
end $$;

comment on column public.community_members.share is
  'The MEMBER''s own floor, set by them and never by the admin: none | records | all. Joining a league channel puts your name in someone else''s Discord — a driver who wants their all-time records posted but not their 11th places should not have to ask permission for that. The channel''s filters are the ceiling; this is the floor.';

create index if not exists community_members_user_idx
  on public.community_members (user_id);

-- ---------------------------------------------------------------------------
-- 2. discord_targets — one channel, its filters, and its budget
-- ---------------------------------------------------------------------------

create table if not exists public.discord_targets (
  id                uuid primary key default gen_random_uuid(),
  community_id      uuid references public.communities(id) on delete cascade,
  owner_id          uuid not null references auth.users(id) on delete cascade,
  label             text not null default '',
  webhook_url       text not null,
  kinds             text[] not null default array['record_taken', 'record_set'],
  watch_boards      boolean not null default true,
  min_board_entries int not null default 3,
  daily_cap         int not null default 20,
  paused_at         timestamptz,
  failures          int not null default 0,
  last_error        text,
  last_sent_at      timestamptz,
  created_at        timestamptz not null default now()
);

comment on table public.discord_targets is
  'One Discord channel we post to. community_id null = a personal target: one user, their own server, no roster anywhere. Never selected directly by a client — webhook_url is a capability token and only leaves this database inside the dispatcher.';

comment on column public.discord_targets.watch_boards is
  'The boards axis: post records set on boards this community already has laps on, whoever set them. This is what makes a rival taking your record land in your channel, and it needs no roster.';

comment on column public.discord_targets.min_board_entries is
  'Distinct drivers a board must already carry before a record on it is worth announcing, counted BEFORE the incoming lap. A trophy won against nobody reads as noise the first time and as a bug the tenth. Three while the boards are still thin (Carl, 2026-09-17) — five is the number this wants at scale, and raising it is a one-line update per channel.';

comment on column public.discord_targets.daily_cap is
  'Ceiling on outsider records per UTC day. Displacing one of this community''s own members is exempt — that message is always wanted, and it is the whole point of the feature.';

create index if not exists discord_targets_community_idx
  on public.discord_targets (community_id);

-- ---------------------------------------------------------------------------
-- 3. notification_events — what happened, once, for everyone
-- ---------------------------------------------------------------------------
-- Append-only and target-agnostic. submit_lap writes here and nothing else, so
-- a lap upload never waits on the routing tables and a routing bug can never
-- reject a lap. Fan-out is a separate pass (section 6), which also means the
-- routing rules can change without touching the hot path.
--
-- The payload is DENORMALISED at emit time — driver name, track name, car,
-- both lap times, the displaced holder's name. The embed for an event that
-- happened in September should read the way it read in September, not the way
-- the row would join today.

create table if not exists public.notification_events (
  id            bigserial primary key,
  kind          text not null,
  actor_id      uuid references auth.users(id) on delete set null,
  subject_id    uuid references auth.users(id) on delete set null,
  board_key     text,
  collapse_key  text,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  fanned_out_at timestamptz
);

comment on table public.notification_events is
  'One row per thing that happened, whoever it reaches. kind: record_taken (a leader displaced, someone else had held it), record_set (leader of a board that had nobody), record_extended (you beat your own).';

comment on column public.notification_events.subject_id is
  'The driver DISPLACED by this event, when there was one. A community whose member is the subject always hears about it, cap or no cap.';

comment on column public.notification_events.board_key is
  'track_id|class|condition — what the boards axis matches on.';

comment on column public.notification_events.collapse_key is
  'Events that should occupy ONE message in a channel share this. A driver improving their own record four times in a practice session edits one embed instead of posting four.';

create index if not exists notification_events_pending_idx
  on public.notification_events (created_at) where fanned_out_at is null;

-- ---------------------------------------------------------------------------
-- 4. notification_outbox — one row per (event, channel)
-- ---------------------------------------------------------------------------

create table if not exists public.notification_outbox (
  id           bigserial primary key,
  target_id    uuid not null references public.discord_targets(id) on delete cascade,
  event_id     bigint references public.notification_events(id) on delete cascade,
  dedupe_key   text not null,
  collapse_key text,
  axis         text not null default 'member',
  payload      jsonb not null,
  status       text not null default 'pending',
  not_before   timestamptz not null default now(),
  message_id   text,
  attempts     int not null default 0,
  last_error   text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'notification_outbox_status_check') then
    alter table public.notification_outbox
      add constraint notification_outbox_status_check
      check (status in ('pending', 'sending', 'sent', 'failed', 'skipped'));
  end if;
end $$;

comment on column public.notification_outbox.axis is
  'Which subscription put this row here: member (this driver publishes here), subject (this channel''s own member was the one displaced) or boards (a stranger, on a board this community races). Only `boards` is rate-capped — the other two are always wanted.';

comment on column public.notification_outbox.dedupe_key is
  'Unique per target. The same race relayed by twelve members'' apps, or the same event fanned out twice by overlapping cron runs, collapses to one message here rather than twelve.';

comment on column public.notification_outbox.not_before is
  'The coalesce window. An event waits a few minutes before it is sent, so the improvements that follow it fold into the same message.';

comment on column public.notification_outbox.message_id is
  'Discord''s id for the message we posted, kept so a later improvement PATCHes it instead of posting again. Requires the webhook POST to have been made with ?wait=true — without that Discord returns 204 and no body, and the chance to edit is gone.';

create unique index if not exists notification_outbox_target_dedupe_key
  on public.notification_outbox (target_id, dedupe_key);

create index if not exists notification_outbox_due_idx
  on public.notification_outbox (not_before) where status = 'pending';

create index if not exists notification_outbox_collapse_idx
  on public.notification_outbox (target_id, collapse_key, sent_at desc)
  where status = 'sent';

-- Nothing here is client-readable. Every door is a SECURITY DEFINER function.
alter table public.communities         enable row level security;
alter table public.community_members   enable row level security;
alter table public.discord_targets     enable row level security;
alter table public.notification_events enable row level security;
alter table public.notification_outbox enable row level security;

-- ---------------------------------------------------------------------------
-- 5. submit_lap — the same function, now emitting board events
-- ---------------------------------------------------------------------------
-- `create or replace` with the IDENTICAL signature on purpose. 0021 had to drop
-- and recreate because it was adding an argument, and paid for it with the
-- PostgREST overload problem and a lost ACL; this change adds no argument, so
-- replacing in place keeps both the grants and every installed client working.
--
-- Two reads happen BEFORE the upsert, because afterwards the answers are gone:
-- who led this board, and how many drivers were on it. Everything after the
-- upsert is wrapped so that a fault in the notification path can never reject
-- somebody's lap — a missed embed is a shrug, a refused personal best is a bug
-- report.

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
  v_kind        text;
begin
  if v_uid is null then
    raise exception 'submit_lap: not authenticated';
  end if;
  if not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'submit_lap: no profile for this account';
  end if;

  -- A lap whose class we do not know cannot be placed on a class board. It is
  -- still a lap in the driver's own local history; it just has no board to go on.
  if v_class = '' then
    return jsonb_build_object('accepted', false, 'reason', 'unknown_class');
  end if;
  -- An unrecognised surface is treated as dry rather than refused: a client
  -- sending a band this server has not heard of is a client from the future,
  -- and losing the lap entirely would be the worse of the two answers.
  if v_cond not in ('dry', 'damp', 'wet') then
    v_cond := 'dry';
  end if;
  if p_lap_ms is null or p_lap_ms < 5000 or p_lap_ms > 3600000 then
    return jsonb_build_object('accepted', false, 'reason', 'implausible_time');
  end if;
  -- A clock far enough out to matter is a broken client, not a fast lap. Allowed
  -- to be slightly ahead of the server (ordinary clock drift), and to be as old
  -- as the queue might plausibly be after a long offline spell.
  if v_set_at > now() + interval '1 day' or v_set_at < now() - interval '365 days' then
    return jsonb_build_object('accepted', false, 'reason', 'clock_skew');
  end if;

  v_track_id := public.resolve_track(p_sim, p_track_key, p_track_name, p_track_length_m);

  select lap_ms into v_prev_ms
  from public.driver_best_laps
  where driver_id = v_uid and track_id = v_track_id
    and car_class = v_class and condition = v_cond;

  -- Who held this board, and how many people were on it. Read now; the upsert
  -- below is about to make both unanswerable.
  select b.driver_id, b.lap_ms, b.set_at
    into v_lead_id, v_lead_ms, v_lead_set_at
  from public.driver_best_laps b
  where b.track_id = v_track_id and b.car_class = v_class and b.condition = v_cond
  order by b.lap_ms asc, b.set_at asc
  limit 1;

  select count(distinct b.driver_id) into v_entries
  from public.driver_best_laps b
  where b.track_id = v_track_id and b.car_class = v_class and b.condition = v_cond;

  -- A strict `>` keeps the EARLIER of two identical times, which is the ordinary
  -- motorsport tie-break and also means a re-sent queue never rewrites set_at.
  insert into public.driver_best_laps (
    driver_id, track_id, car_class, condition, lap_ms, car, sim, set_at,
    conditions, app_version
  ) values (
    v_uid, v_track_id, v_class, v_cond, p_lap_ms, btrim(coalesce(p_car, '')),
    lower(btrim(coalesce(p_sim, ''))), v_set_at,
    coalesce(p_conditions, '{}'::jsonb), coalesce(p_app_version, '')
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

  -- What is actually on the board now — which is the incoming lap only if it beat
  -- what was there.
  v_best_ms := least(p_lap_ms, coalesce(v_prev_ms, p_lap_ms));

  -- Ranked against its own surface. A wet lap reported as P9 because the dry
  -- board has eight faster times on it would be the same conflation 0021 exists
  -- to undo.
  select count(*) + 1 into v_rank
  from public.driver_best_laps b
  where b.track_id = v_track_id
    and b.car_class = v_class
    and b.condition = v_cond
    and b.lap_ms < v_best_ms;

  -- ── The notification event ───────────────────────────────────────────────
  -- Only a change of BOARD LEADER is an event. A personal best that beats
  -- nobody is not news anywhere, which is also how Carl's "solo laps only
  -- count if they beat a record" rule is honoured without this function ever
  -- having to know whether anyone else was on track.
  -- `v_rank = 1` alone would fire on an exact tie: the rank counts times
  -- STRICTLY faster, and a dead heat leaves the earlier lap on top by the
  -- motorsport tie-break above. Beating the leader has to mean beating them.
  if v_improved and v_rank = 1 and (v_lead_ms is null or p_lap_ms < v_lead_ms) then
    begin
      v_kind := case
        when v_lead_id is null    then 'record_set'
        when v_lead_id = v_uid    then 'record_extended'
        else 'record_taken'
      end;

      insert into public.notification_events (
        kind, actor_id, subject_id, board_key, collapse_key, payload
      )
      select
        v_kind,
        v_uid,
        case when v_kind = 'record_taken' then v_lead_id else null end,
        v_track_id::text || '|' || v_class || '|' || v_cond,
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
          'previous_ms',    v_lead_ms,
          'gap_ms',         case when v_lead_ms is null then null else v_lead_ms - p_lap_ms end,
          'held_since',     v_lead_set_at,
          'holder',         prev.display_name,
          'holder_id',      v_lead_id,
          'board_entries',  v_entries,
          'session_type',   nullif(coalesce(p_conditions, '{}'::jsonb) ->> 'sessionType', ''),
          'sim',            lower(btrim(coalesce(p_sim, ''))),
          'app_version',    coalesce(p_app_version, ''),
          'set_at',         v_set_at
        ))
      from public.profiles me
      left join public.profiles prev on prev.id = v_lead_id
      left join public.tracks t on t.id = v_track_id
      where me.id = v_uid;
    exception when others then
      -- A missed embed is a shrug. A refused lap is a bug report. But a
      -- swallow with no trace is how this feature dies quietly months from
      -- now, so leave one in the Postgres log on the way past.
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

-- Replacing in place keeps the ACL 0021 fought for, but say it anyway: this
-- file must never leave submit_lap reachable by a signed-out caller.
revoke all on function public.submit_lap(
  text, text, text, integer, text, text, integer, timestamptz, jsonb, text, text) from public, anon;
grant execute on function public.submit_lap(
  text, text, text, integer, text, text, integer, timestamptz, jsonb, text, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Communities — the doors a member uses
-- ---------------------------------------------------------------------------

-- The join code, in the shape 0007 already uses for league vouchers. No prefix:
-- these codes belong to other people's leagues, not to Apex.
create or replace function public.new_join_code()
returns text
language sql
volatile
as $$
  select substr(h, 1, 4) || '-' || substr(h, 5, 4)
  from (select upper(replace(gen_random_uuid()::text, '-', '')) as h) g;
$$;

create or replace function public.create_community(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := left(btrim(coalesce(p_name, '')), 60);
  v_id   uuid;
  v_code text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if v_name = '' then
    return jsonb_build_object('ok', false, 'reason', 'no_name');
  end if;
  -- One person running four leagues is plausible. One person running forty is
  -- someone enumerating join codes.
  if (select count(*) from public.communities where owner_id = v_uid) >= 10 then
    return jsonb_build_object('ok', false, 'reason', 'too_many');
  end if;

  loop
    v_code := public.new_join_code();
    begin
      insert into public.communities (name, owner_id, join_code)
      values (v_name, v_uid, v_code)
      returning id into v_id;
      exit;
    exception when unique_violation then
      -- 1-in-4-billion collision: roll again.
    end;
  end loop;

  insert into public.community_members (community_id, user_id, role)
  values (v_id, v_uid, 'owner');

  return jsonb_build_object('ok', true, 'id', v_id, 'name', v_name, 'code', v_code);
end;
$$;

create or replace function public.join_community(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_row  public.communities%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  -- Typed by a human off a Discord message: tolerate the missing dash and the
  -- lowercase, refuse everything else.
  v_code := regexp_replace(v_code, '[^A-Z0-9]', '', 'g');
  if length(v_code) <> 8 then
    return jsonb_build_object('ok', false, 'reason', 'bad_code');
  end if;
  v_code := substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4);

  select * into v_row from public.communities where join_code = v_code;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_such_code');
  end if;

  insert into public.community_members (community_id, user_id)
  values (v_row.id, v_uid)
  on conflict (community_id, user_id) do nothing;

  return jsonb_build_object('ok', true, 'id', v_row.id, 'name', v_row.name);
end;
$$;

create or replace function public.leave_community(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  -- The owner leaving would orphan the channels. They delete the community or
  -- hand it over; they do not walk out of it.
  if exists (select 1 from public.communities where id = p_id and owner_id = v_uid) then
    return jsonb_build_object('ok', false, 'reason', 'owner_cannot_leave');
  end if;
  delete from public.community_members where community_id = p_id and user_id = v_uid;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.set_community_share(p_id uuid, p_share text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_share text := lower(btrim(coalesce(p_share, '')));
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if v_share not in ('none', 'records', 'all') then
    return jsonb_build_object('ok', false, 'reason', 'bad_share');
  end if;
  update public.community_members
     set share = v_share
   where community_id = p_id and user_id = v_uid;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_member');
  end if;
  return jsonb_build_object('ok', true, 'share', v_share);
end;
$$;

create or replace function public.rotate_community_code(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_code text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if not exists (
    select 1 from public.community_members
    where community_id = p_id and user_id = v_uid and role in ('owner', 'admin')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_admin');
  end if;
  loop
    v_code := public.new_join_code();
    begin
      update public.communities set join_code = v_code where id = p_id;
      exit;
    exception when unique_violation then
    end;
  end loop;
  return jsonb_build_object('ok', true, 'code', v_code);
end;
$$;

create or replace function public.remove_community_member(p_id uuid, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if not exists (
    select 1 from public.community_members
    where community_id = p_id and user_id = v_uid and role in ('owner', 'admin')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_admin');
  end if;
  if exists (select 1 from public.communities where id = p_id and owner_id = p_user) then
    return jsonb_build_object('ok', false, 'reason', 'cannot_remove_owner');
  end if;
  delete from public.community_members where community_id = p_id and user_id = p_user;
  return jsonb_build_object('ok', true);
end;
$$;

-- What the settings panel draws. The join code is returned only to someone who
-- can actually hand it out, and webhook urls are masked for everyone.
create or replace function public.my_communities()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(x)::jsonb order by x.joined_at)
    from (
      select
        c.id,
        c.name,
        m.role,
        m.share,
        m.joined_at,
        (m.role in ('owner', 'admin')) as can_admin,
        case when m.role in ('owner', 'admin') then c.join_code else null end as join_code,
        (select count(*) from public.community_members mm where mm.community_id = c.id) as members,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',                t.id,
            'label',             t.label,
            'webhook',           public.mask_webhook(t.webhook_url),
            'kinds',             to_jsonb(t.kinds),
            'watch_boards',      t.watch_boards,
            'min_board_entries', t.min_board_entries,
            'daily_cap',         t.daily_cap,
            'paused',            (t.paused_at is not null),
            'failures',          t.failures,
            'last_error',        t.last_error,
            'last_sent_at',      t.last_sent_at
          ) order by t.created_at)
          from public.discord_targets t
          where t.community_id = c.id and m.role in ('owner', 'admin')
        ), '[]'::jsonb) as channels
      from public.community_members m
      join public.communities c on c.id = m.community_id
      where m.user_id = v_uid
    ) x
  ), '[]'::jsonb);
end;
$$;

create or replace function public.community_roster(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not exists (
    select 1 from public.community_members where community_id = p_id and user_id = v_uid
  ) then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', m.user_id,
      'name',    coalesce(p.display_name, 'Driver'),
      'role',    m.role,
      'share',   m.share,
      'joined',  m.joined_at
    ) order by m.joined_at)
    from public.community_members m
    left join public.profiles p on p.id = m.user_id
    where m.community_id = p_id
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Channels — saving a webhook without ever handing one back
-- ---------------------------------------------------------------------------

create or replace function public.mask_webhook(p_url text)
returns text
language sql
immutable
as $$
  select case
    when coalesce(p_url, '') = '' then ''
    -- .../webhooks/<id>/<token> — the id is harmless and identifies the row to
    -- a human; the token is the whole of the secret and never comes back out.
    else regexp_replace(p_url, '^(https://[^/]+/api/webhooks/[0-9]+/).*$', '\1' || repeat('.', 8))
  end;
$$;

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

  -- A community channel is the admins' to configure. A personal one is simply
  -- the caller's.
  if p_community is not null and not exists (
    select 1 from public.community_members
    where community_id = p_community and user_id = v_uid and role in ('owner', 'admin')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_admin');
  end if;

  -- The dispatcher POSTs to whatever is stored here, so what is stored here is
  -- not allowed to be an arbitrary URL. Discord's own hosts only — otherwise a
  -- saved "webhook" is a request our server makes on a stranger's behalf, to
  -- anywhere it can reach.
  if v_url <> '' and v_url !~ '^https://(canary\.|ptb\.)?discord(app)?\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]+$' then
    return jsonb_build_object('ok', false, 'reason', 'not_a_discord_webhook');
  end if;

  if p_id is null then
    if v_url = '' then
      return jsonb_build_object('ok', false, 'reason', 'no_webhook');
    end if;
    -- A personal channel starts with record_extended ON, and a community's
    -- starts with it off. Beating your own record is news to you and to nobody
    -- else, and the difference between those two audiences is the whole reason
    -- a personal target exists.
    insert into public.discord_targets (community_id, owner_id, label, webhook_url, kinds)
    values (
      p_community, v_uid, left(btrim(coalesce(p_label, '')), 60), v_url,
      coalesce(
        p_kinds,
        case
          when p_community is null
            then array['record_taken', 'record_set', 'record_extended']
          else array['record_taken', 'record_set']
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
         -- Any edit is a fresh start: an admin who has just pasted a new url
         -- should not inherit the old one's failure count.
         failures          = case when v_url = '' then t.failures else 0 end,
         last_error        = case when v_url = '' then t.last_error else null end
   where t.id = v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

create or replace function public.delete_discord_target(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  delete from public.discord_targets t
  where t.id = p_id
    and (
      t.owner_id = v_uid
      or exists (
        select 1 from public.community_members m
        where m.community_id = t.community_id and m.user_id = v_uid
          and m.role in ('owner', 'admin')
      )
    );
  return jsonb_build_object('ok', found);
end;
$$;

create or replace function public.my_discord_targets()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',                t.id,
      'community_id',      t.community_id,
      'label',             t.label,
      'webhook',           public.mask_webhook(t.webhook_url),
      'kinds',             to_jsonb(t.kinds),
      'watch_boards',      t.watch_boards,
      'min_board_entries', t.min_board_entries,
      'daily_cap',         t.daily_cap,
      'paused',            (t.paused_at is not null),
      'failures',          t.failures,
      'last_error',        t.last_error,
      'last_sent_at',      t.last_sent_at
    ) order by t.created_at)
    from public.discord_targets t
    where t.community_id is null and t.owner_id = v_uid
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Fan-out — the only place the routing rules live
-- ---------------------------------------------------------------------------
-- Service role only, driven by cron. One pass turns each event into at most one
-- outbox row per channel, applying the two axes plus the "our member was the
-- one displaced" case, which is exempt from the daily cap because it is the
-- single message this whole feature exists to deliver.

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
begin
  for v_evt in
    select * from public.notification_events
    where fanned_out_at is null
    order by id
    limit greatest(1, least(coalesce(p_limit, 200), 2000))
  loop
    v_track := nullif(split_part(coalesce(v_evt.board_key, ''), '|', 1), '')::uuid;
    v_class := split_part(coalesce(v_evt.board_key, ''), '|', 2);
    v_cond  := split_part(coalesce(v_evt.board_key, ''), '|', 3);

    for v_tgt in
      select
        t.id,
        t.daily_cap,
        case
          -- Whose channel this is, in order of how much they want it.
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
          -- member axis
          (t.community_id is null and t.owner_id = v_evt.actor_id)
          or exists (
            select 1 from public.community_members m
            where m.community_id = t.community_id
              and m.user_id = v_evt.actor_id
              and m.share <> 'none'
          )
          -- our member was displaced
          or exists (
            select 1 from public.community_members m
            where m.community_id = t.community_id
              and m.user_id = v_evt.subject_id
          )
          -- boards axis: a board this community actually races, with enough
          -- people on it to make a record mean something
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
        )
    loop
      -- The cap is on strangers only, and it is counted per UTC day.
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

      insert into public.notification_outbox (
        target_id, event_id, dedupe_key, collapse_key, axis, payload, not_before
      ) values (
        v_tgt.id,
        v_evt.id,
        'evt:' || v_evt.id::text,
        v_evt.collapse_key,
        v_tgt.axis,
        v_evt.payload || jsonb_build_object('axis', v_tgt.axis),
        -- The coalesce window: long enough for the next improvement in the same
        -- session to fold into this message, short enough that a record still
        -- feels like news.
        now() + interval '4 minutes'
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
-- 9. The dispatcher's three doors
-- ---------------------------------------------------------------------------
-- claim → post → mark. Claiming is `for update skip locked` so two overlapping
-- cron runs cannot both post the same message, and it is the ONLY function in
-- this file that returns a webhook url in the clear.

create or replace function public.claim_notifications(p_limit int default 20)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  with due as (
    select o.id
    from public.notification_outbox o
    join public.discord_targets t on t.id = o.target_id
    where o.status = 'pending'
      and o.not_before <= now()
      and t.paused_at is null
    order by o.not_before
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update of o skip locked
  ),
  claimed as (
    update public.notification_outbox o
       set status = 'sending', attempts = o.attempts + 1
      from due
     where o.id = due.id
    returning o.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',          c.id,
    'webhook_url', t.webhook_url,
    'payload',     c.payload,
    'axis',        c.axis,
    -- The message to EDIT instead of posting, when this channel showed the same
    -- board and driver recently enough for a second post to read as spam.
    'edit_message_id', (
      select prev.message_id
      from public.notification_outbox prev
      where prev.target_id = c.target_id
        and prev.collapse_key is not null
        and prev.collapse_key = c.collapse_key
        and prev.status = 'sent'
        and prev.message_id is not null
        and prev.sent_at > now() - interval '30 minutes'
      order by prev.sent_at desc
      limit 1
    )
  )), '[]'::jsonb) into v_rows
  from claimed c
  join public.discord_targets t on t.id = c.target_id;

  return v_rows;
end;
$$;

create or replace function public.mark_notification_sent(p_id bigint, p_message_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.notification_outbox
     set status = 'sent', sent_at = now(), message_id = nullif(btrim(coalesce(p_message_id, '')), ''),
         last_error = null
   where id = p_id;

  update public.discord_targets t
     set last_sent_at = now(), failures = 0, last_error = null
    from public.notification_outbox o
   where o.id = p_id and t.id = o.target_id;
end;
$$;

-- A channel that has been deleted in Discord answers 404 forever. Retrying that
-- until the end of time is how a queue fills up, so the caller passes
-- p_permanent and the channel pauses itself rather than being retried.
create or replace function public.mark_notification_failed(
  p_id        bigint,
  p_error     text,
  p_permanent boolean default false,
  p_retry_at  timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.notification_outbox%rowtype;
begin
  select * into v_row from public.notification_outbox where id = p_id;
  if not found then
    return;
  end if;

  update public.notification_outbox
     set status     = case
                        when p_permanent or v_row.attempts >= 5 then 'failed'
                        else 'pending'
                      end,
         not_before = coalesce(p_retry_at, now() + (interval '1 minute' * power(3, least(v_row.attempts, 4)))),
         last_error = left(coalesce(p_error, ''), 500)
   where id = p_id;

  update public.discord_targets
     set failures   = failures + 1,
         last_error = left(coalesce(p_error, ''), 500),
         paused_at  = case when p_permanent then coalesce(paused_at, now()) else paused_at end
   where id = v_row.target_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Grants
-- ---------------------------------------------------------------------------
-- Supabase's default privileges grant EXECUTE on new public functions to anon,
-- and revoking PUBLIC does not take that with it (0021 learned this the hard
-- way). Every function here is revoked from anon explicitly.

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.create_community(text)',
    'public.join_community(text)',
    'public.leave_community(uuid)',
    'public.set_community_share(uuid, text)',
    'public.rotate_community_code(uuid)',
    'public.remove_community_member(uuid, uuid)',
    'public.my_communities()',
    'public.community_roster(uuid)',
    'public.my_discord_targets()',
    'public.save_discord_target(uuid, uuid, text, text, text[], boolean, int, int, boolean)',
    'public.delete_discord_target(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_fn);
    execute format('grant execute on function %s to authenticated, service_role', v_fn);
  end loop;

  -- The dispatcher's doors, and the code generator behind the join codes, are
  -- not the client's business at all.
  foreach v_fn in array array[
    'public.new_join_code()',
    'public.mask_webhook(text)',
    'public.fanout_notification_events(int)',
    'public.claim_notifications(int)',
    'public.mark_notification_sent(bigint, text)',
    'public.mark_notification_failed(bigint, text, boolean, timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 11. Housekeeping
-- ---------------------------------------------------------------------------
-- The outbox is a log of every message ever posted and would otherwise grow for
-- ever. Sent rows are kept long enough to be useful for "why did that not
-- appear" and no longer; events are kept a little longer, because they are the
-- only record of what happened once the outbox row is gone.
--
-- The one thing NOT swept is a sent row whose message_id another row might yet
-- edit — hence 7 days rather than 24 hours, comfortably past the 30-minute
-- collapse window.

create or replace function public.notification_prune()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gone int := 0;
  v_n    int;
begin
  delete from public.notification_outbox
   where status in ('sent', 'skipped') and created_at < now() - interval '7 days';
  get diagnostics v_n = row_count;
  v_gone := v_gone + v_n;

  -- A failed row that nobody has looked at in a month is not going to be
  -- looked at. The channel's own last_error survives it.
  delete from public.notification_outbox
   where status = 'failed' and created_at < now() - interval '30 days';
  get diagnostics v_n = row_count;
  v_gone := v_gone + v_n;

  delete from public.notification_events
   where fanned_out_at is not null and created_at < now() - interval '90 days';
  get diagnostics v_n = row_count;
  v_gone := v_gone + v_n;

  return v_gone;
end;
$$;

revoke all on function public.notification_prune() from public, anon, authenticated;
grant execute on function public.notification_prune() to service_role;
