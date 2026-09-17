-- 0030_email_announce.sql — the one-off release announcement.
--
-- 1.0 is the first release worth writing to everybody about, and there was no
-- way to write to everybody: the lifecycle system has exactly two campaigns and
-- both are sequences anchored on something the person did (started a trial,
-- signed up and did not). A broadcast is neither.
--
-- It could have been a script that loops over `profiles` and calls Resend. It
-- is not, because everything that makes a mass send safe already exists in here
-- and none of it would have come along: the opt-out (`lifecycle_opt_out`), the
-- suppression list fed by Resend's bounce webhook, the unsubscribe token and
-- link, the send window, the retry cap, the send log — and the unique index on
-- (user_id, campaign, step) that makes a double-send impossible even if the
-- dispatcher runs twice. So the broadcast becomes a third campaign and inherits
-- all of it.
--
-- ## The switch, and why it is a date rather than a boolean
--
-- `email_settings.announce_at` is null here, which means nobody is due and
-- applying this migration sends nothing. Setting it is the send:
--
--   update public.email_settings set announce_at = now() where id = true;
--
-- A timestamp rather than a flag because the scheduler is built on anchors: the
-- mail is "due" at announce_at, which makes it obey `send_window_start/end`
-- like everything else, and makes it visible in the same `email_lifecycle_due()`
-- output as the rest. It also means the existing anti-backfill guard applies
-- unchanged — `due >= greatest(activated_at, now() - stale_after)` — so a date
-- set in the past by accident quietly sends nothing rather than mailing forty
-- people at four in the morning.
--
-- Only accounts that existed when the announcement was made are included
-- (`p.created_at <= announce_at`). Somebody who signs up next week is getting
-- 1.0 as their first version and does not need to be told what changed.
--
-- To stop it mid-flight: set `announce_at` back to null, or use the campaign's
-- own `active` flag in `email_lifecycle_steps`. The main kill switch
-- (`email_settings.enabled`) covers it too, as it covers everything here.
--
-- Re-runnable: `add column if not exists`, `on conflict do nothing`,
-- `create or replace`.

-- ---------------------------------------------------------------------------
-- 1. The switch
-- ---------------------------------------------------------------------------

alter table public.email_settings
  add column if not exists announce_at timestamptz;

comment on column public.email_settings.announce_at is
  'When the one-off release announcement went out, and the anchor every recipient is scheduled against. Null means it has not been sent and nobody is due. Setting it IS the send.';

-- ---------------------------------------------------------------------------
-- 2. The campaign
-- ---------------------------------------------------------------------------
-- offset_hours 0: due the moment announce_at passes. respect_window true: it is
-- an announcement, not an alert, and it can wait for a civil hour.

insert into public.email_lifecycle_steps (campaign, step, position, offset_hours, respect_window)
values ('announce', 'v1', 1, 0, true)
on conflict (campaign, step) do nothing;

-- ---------------------------------------------------------------------------
-- 3. The scheduler learns one more anchor
-- ---------------------------------------------------------------------------
-- Byte-for-byte the live function with one CTE added and one line of the union
-- changed. Everything downstream of `base` — the window, the opt-out, the
-- suppression check, the dedupe, the failure cap, the ordering and the limit —
-- is untouched and now covers the announcement too.

create or replace function public.email_lifecycle_due(p_limit integer default 50)
returns table(user_id uuid, email text, first_name text, campaign text, step text,
              due_at timestamptz, unsubscribe_token uuid, variant text,
              opened_app boolean, trial_end timestamptz, days_left integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cfg public.email_settings%rowtype;
  v_hour int;
begin
  select * into v_cfg from public.email_settings where id = true;
  if not found or not v_cfg.enabled then
    return;
  end if;

  v_hour := extract(hour from (now() at time zone 'Europe/London'))::int;

  insert into public.email_prefs (user_id)
  select p.id from public.profiles p
  where not exists (select 1 from public.email_prefs e where e.user_id = p.id)
  on conflict do nothing;

  return query
  with
  opened as (
    select a.user_id as uid from public.app_sessions a group by a.user_id
  ),
  trial_base as (
    select b.user_id                                    as uid,
           b.started_at                                 as anchor,
           'trial'::text                                as camp,
           b.trial_end                                  as t_end,
           case when b.status = 'trialing' then 'convert' else 'thanks' end as var
    from public.billing_subscriptions b
    where b.trial_end   is not null
      and b.started_at  is not null
      and b.status in ('trialing', 'active', 'past_due')
      and not b.cancel_at_period_end
  ),
  nudge_base as (
    select p.id                    as uid,
           p.created_at            as anchor,
           'nudge'::text           as camp,
           null::timestamptz       as t_end,
           'default'::text         as var
    from public.profiles p
    left join public.billing_subscriptions b on b.user_id = p.id
    where coalesce(b.status, 'none') in ('none', 'incomplete', 'incomplete_expired')
      and b.started_at is null
      and p.free_access_reason is null
  ),
  -- The broadcast. Everyone who had an account when it was made, anchored on
  -- the announcement itself rather than on anything they did — which is what
  -- makes it a one-off rather than a sequence. Null announce_at yields no rows.
  announce_base as (
    select p.id                    as uid,
           v_cfg.announce_at       as anchor,
           'announce'::text        as camp,
           null::timestamptz       as t_end,
           'default'::text         as var
    from public.profiles p
    where v_cfg.announce_at is not null
      and p.created_at <= v_cfg.announce_at
  ),
  base as (
    select * from trial_base
    union all
    select * from nudge_base
    union all
    select * from announce_base
  ),
  candidate as (
    select b.uid,
           b.camp,
           s.step,
           s.position,
           b.anchor + make_interval(mins => (s.offset_hours * 60)::int) as due,
           s.respect_window,
           b.t_end,
           b.var
    from base b
    join public.email_lifecycle_steps s
      on s.campaign = b.camp and s.active
  )
  select c.uid,
         u.email::text,
         coalesce(nullif(split_part(btrim(pr.display_name), ' ', 1), ''), '')::text,
         c.camp,
         c.step,
         c.due,
         ep.unsubscribe_token,
         c.var,
         (o.uid is not null),
         c.t_end,
         case when c.t_end is null then null
              else greatest(0, ceil(extract(epoch from (c.t_end - now())) / 86400)::int)
         end
  from candidate c
  join public.profiles     pr on pr.id      = c.uid
  join auth.users          u  on u.id       = c.uid
  join public.email_prefs  ep on ep.user_id = c.uid
  left join opened         o  on o.uid      = c.uid
  where c.due <= now()
    and c.due >= greatest(v_cfg.activated_at, now() - v_cfg.stale_after)
    and (not c.respect_window
         or v_hour between v_cfg.send_window_start and v_cfg.send_window_end)
    and coalesce(u.email, '') <> ''
    and not ep.lifecycle_opt_out
    and not exists (select 1 from public.email_suppressions sup where sup.email = u.email)
    and not exists (
      select 1 from public.email_sends es
      where es.user_id = c.uid and es.campaign = c.camp and es.step = c.step
        and es.status = 'sent')
    and (select count(*) from public.email_sends es
         where es.user_id = c.uid and es.campaign = c.camp and es.step = c.step
           and es.status = 'failed') < 3
  order by c.due asc
  limit greatest(1, least(coalesce(p_limit, 50), 500));
end;
$function$;
