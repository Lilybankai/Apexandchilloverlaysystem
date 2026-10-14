-- =============================================================================
-- Cancellations, by name — who stopped their trial or their subscription.
-- =============================================================================
-- Apply after 0014. Re-runnable (`create or replace`; the function is new).
--
-- The Billing section already COUNTS churn per month; this names the people,
-- for the Members pane, so the question "who left, and had they paid?" is
-- answered next to the roster rather than in Stripe's dashboard.
--
-- Two states, both read off columns the stripe-webhook already writes:
--
--   ended    `ended_at` is set — Stripe considers the subscription finished.
--   ending   still live (trialing/active/past_due) but `cancel_at_period_end`
--            is on: they pressed cancel, access runs to the end of the period.
--            Listed because it is the one state still worth a message.
--
-- And two kinds:
--
--   trial         it stopped at or before the trial's end, so no money was
--                 ever taken. Stripe ends a trial cancelled "at period end"
--                 exactly ON trial_end; the hour of slack absorbs clock skew
--                 between the two timestamps without swallowing a real
--                 first-month cancellation.
--   subscription  anything else — at least one payment was due.
--
-- `incomplete_expired` is a checkout that never got a card, not a cancellation,
-- so it is left out. The one-row-per-account limit from 0008 applies: someone
-- who cancelled and later resubscribed reads as live, not as a past leaver.
-- =============================================================================

create or replace function public.admin_billing_cancellations(
  p_limit int default 200
) returns table (
  user_id            uuid,
  driver             text,
  email              text,
  kind               text,
  state              text,
  started_at         timestamptz,
  trial_end          timestamptz,
  ends_at            timestamptz,
  monthly_pence      int,
  free_access_reason text,
  last_seen_at       timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_limit int := greatest(1, least(coalesce(p_limit, 200), 1000));
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;

  return query
  with c as (
    select b.user_id                                         as uid,
           case when b.ended_at is not null then 'ended' else 'ending' end as st,
           -- When access stops (or stopped): the end itself once it has
           -- happened, otherwise the period it is booked to run out at.
           coalesce(b.ended_at, b.current_period_end)          as ends,
           b.started_at                                        as started,
           b.trial_end                                         as trial,
           b.monthly_pence                                     as pence
      from public.billing_subscriptions b
     where b.status <> 'incomplete_expired'
       and (
         b.ended_at is not null
         or (b.cancel_at_period_end
             and b.status in ('trialing', 'active', 'past_due'))
       )
  ),
  sess as (
    select a.user_id as uid, max(a.last_seen_at) as last_seen
      from public.app_sessions a
     group by a.user_id
  )
  select c.uid,
         coalesce(nullif(btrim(p.display_name), ''), 'Driver')::text,
         coalesce(u.email, '')::text,
         case
           when c.trial is not null
            and c.ends is not null
            and c.ends <= c.trial + interval '1 hour'
           then 'trial'
           else 'subscription'
         end::text,
         c.st::text,
         c.started,
         c.trial,
         c.ends,
         c.pence,
         p.free_access_reason::text,
         s.last_seen
    from c
    left join public.profiles p on p.id = c.uid
    left join auth.users u      on u.id = c.uid
    left join sess s            on s.uid = c.uid
   -- Still-cancelling first (the only rows anyone can still act on), then
   -- the most recent leavers.
   order by (c.st = 'ending') desc, c.ends desc nulls last
   limit v_limit;
end;
$$;

grant execute on function public.admin_billing_cancellations(int) to authenticated;
