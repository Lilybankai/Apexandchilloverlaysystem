-- ===========================================================================
-- 0013_billing_grace_period — a failed payment now has a deadline.
--
-- 0007 put `past_due` in the entitled set with no time limit, so "one bounced
-- card doesn't black-screen a race weekend". That reasoning still holds for the
-- first fortnight, but as written it never ends: an account whose card died in
-- January keeps full access forever, because Stripe leaves a subscription in
-- `past_due` until its own dunning settings decide otherwise — and if those are
-- set to "leave it past_due", that is never.
--
-- So the grace window becomes explicit and OURS: 14 days from the first failed
-- payment, then entitlement stops. It no longer depends on how Stripe's retry
-- schedule happens to be configured, which is a dashboard setting anyone can
-- change without touching this repo.
--
-- `past_due_since` is stamped by the webhook when the subscription first enters
-- past_due and cleared the moment it leaves. Deriving it here instead — from
-- current_period_end, say — would be wrong: that field moves when Stripe rolls
-- the period forward, and the driver would silently get a fresh 14 days.
-- ===========================================================================

alter table public.billing_subscriptions
  -- When the run of failed payments began. Null whenever status is not past_due.
  add column if not exists past_due_since   timestamptz,
  -- The open invoice, so the app can name a figure and link straight to paying
  -- it. Minor units (pence), matching monthly_pence.
  add column if not exists amount_due_pence int,
  add column if not exists invoice_url      text;

-- ---------------------------------------------------------------------------
-- billing_grace_days — the window, in one place.
--
-- A function rather than a bare constant so both entitlement_status() and the
-- admin overview read the same number, and changing the policy is one edit.
-- ---------------------------------------------------------------------------
create or replace function public.billing_grace_days()
returns int
language sql
immutable
as $$ select 14 $$;

-- ---------------------------------------------------------------------------
-- entitlement_status — as 0008, plus the grace deadline.
--
-- The behaviour change is one line: past_due is live only while the deadline is
-- still ahead. Everything else is additive — the app needs the deadline itself
-- to warn about it, and the amount to say what is owed.
--
-- A past_due row with NO `past_due_since` is treated as still inside the window
-- rather than locked out. That is the deliberate choice for the accounts that
-- were already past_due when this shipped: nobody gets cut off by a migration
-- running. The webhook stamps them on the next event from Stripe, and the
-- backfill at the bottom of this file gives them a deadline immediately.
-- ---------------------------------------------------------------------------
create or replace function public.entitlement_status()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_reason   text;
  v_is_admin boolean := false;
  v_sub      public.billing_subscriptions%rowtype;
  v_live     boolean := false;
  v_lockout  timestamptz;
begin
  if v_uid is null then
    return json_build_object('entitled', false, 'source', null);
  end if;

  select p.free_access_reason, coalesce(p.is_admin, false)
    into v_reason, v_is_admin
    from public.profiles p where p.id = v_uid;

  select * into v_sub
    from public.billing_subscriptions s where s.user_id = v_uid;

  -- When the access actually stops, if nothing is paid. Null unless past_due.
  if coalesce(v_sub.status, 'none') = 'past_due' and v_sub.past_due_since is not null then
    v_lockout := v_sub.past_due_since + make_interval(days => public.billing_grace_days());
  end if;

  -- trialing/active are live outright. past_due rides a 14-day grace window so
  -- one bounced card doesn't black-screen a race weekend — but only 14 days of
  -- them, and an unstamped row is treated as still inside it (see above).
  v_live := case coalesce(v_sub.status, 'none')
              when 'trialing' then true
              when 'active'   then true
              when 'past_due' then (v_lockout is null or v_lockout > now())
              else false
            end;

  return json_build_object(
    'entitled', (v_reason is not null) or v_live or v_is_admin,
    -- A comp wins the label even alongside a live sub: it's the stronger claim.
    -- An admin with neither reads as 'staff', which is what they are; note that
    -- this is NOT a row in profiles, so such an account does not appear in the
    -- Free access list until someone comps it properly.
    'source', case
                when v_reason is not null then 'free'
                when v_live then 'stripe'
                when v_is_admin then 'free'
                else null
              end,
    'freeReason', coalesce(v_reason, case when v_is_admin then 'staff' end),
    'status', coalesce(v_sub.status, 'none'),
    'cancelAtPeriodEnd', coalesce(v_sub.cancel_at_period_end, false),
    'trialEnd', v_sub.trial_end,
    'currentPeriodEnd', v_sub.current_period_end,
    'hasCustomer', v_sub.stripe_customer_id is not null,
    -- Everything the overdue banner needs, so it is one round trip like the
    -- rest of the card.
    'pastDueSince', v_sub.past_due_since,
    'lockoutAt', v_lockout,
    'graceDays', public.billing_grace_days(),
    'amountDuePence', v_sub.amount_due_pence,
    'invoiceUrl', v_sub.invoice_url
  );
end;
$$;

grant execute on function public.billing_grace_days() to authenticated;
grant execute on function public.entitlement_status() to authenticated;

-- ---------------------------------------------------------------------------
-- admin_billing_past_due — who is in the window, and how long they have left.
--
-- The Admin tab's Billing section can already count past_due accounts; this
-- names them and sorts by who runs out first, which is the only version of the
-- question worth acting on. Overdue amounts are money owed to the league, so
-- this is admin-only like every other per-person read.
-- ---------------------------------------------------------------------------
create or replace function public.admin_billing_past_due()
returns table (
  user_id          uuid,
  driver           text,
  past_due_since   timestamptz,
  lockout_at       timestamptz,
  days_left        int,
  amount_due_pence int,
  locked_out       boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;
  return query
    select b.user_id,
           coalesce(p.display_name, 'Driver') as driver,
           b.past_due_since,
           b.past_due_since + make_interval(days => public.billing_grace_days()) as lockout_at,
           -- Ceiling, so "0 days left" means today is the last day rather than
           -- appearing the moment the clock passes a whole day.
           ceil(
             extract(epoch from
               (b.past_due_since + make_interval(days => public.billing_grace_days())) - now()
             ) / 86400.0
           )::int as days_left,
           b.amount_due_pence,
           (b.past_due_since + make_interval(days => public.billing_grace_days())) <= now()
             as locked_out
      from public.billing_subscriptions b
      left join public.profiles p on p.id = b.user_id
     where b.status = 'past_due'
       and b.past_due_since is not null
     order by lockout_at asc;
end;
$$;

grant execute on function public.admin_billing_past_due() to authenticated;

-- ---------------------------------------------------------------------------
-- Backfill.
--
-- Any account ALREADY sitting in past_due has no stamp, and would otherwise
-- wait for its next Stripe event to get one. Stamp them from `updated_at` —
-- the last time the webhook wrote the row, which for a past_due row is when it
-- became past_due — so the deadline is honest rather than restarting the clock
-- at migration time.
--
-- `where past_due_since is null` keeps this re-runnable: applying the migration
-- twice must not push anyone's deadline back.
-- ---------------------------------------------------------------------------
update public.billing_subscriptions
   set past_due_since = updated_at
 where status = 'past_due'
   and past_due_since is null;
