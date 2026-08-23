-- ===========================================================================
-- 0014_grace_aware_admin_counts — the admin numbers learn about the deadline.
--
-- 0013 gave `past_due` a 14-day life and stopped entitling it afterwards, but
-- only entitlement_status() was taught the rule. Everywhere else still asked
-- `status = 'past_due'` and got "yes", so an account the app had already locked
-- out still counted as a live subscription on the Billing pane and still sorted
-- among the paying members on the roster. The lock was right and the reporting
-- was wrong.
--
-- The fix is to stop spelling the rule out more than once. `billing_is_live()`
-- is now the only place that knows what a live subscription is, and all three
-- callers ask it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- billing_is_live — does this subscription still buy access?
--
-- STABLE, not immutable: it reads now(). Takes the two columns rather than a
-- user id so it can be used inside a join without a correlated subquery per
-- row.
--
-- The null-past_due_since case says LIVE, matching 0013: a row that has not
-- been stamped yet has no deadline to have missed, and no reporting query
-- should be the thing that decides someone is locked out.
-- ---------------------------------------------------------------------------
create or replace function public.billing_is_live(
  p_status         text,
  p_past_due_since timestamptz
) returns boolean
language sql
stable
set search_path = public
as $$
  select case coalesce(p_status, 'none')
           when 'trialing' then true
           when 'active'   then true
           when 'past_due' then
             p_past_due_since is null
             or p_past_due_since + make_interval(days => public.billing_grace_days()) > now()
           else false
         end
$$;

grant execute on function public.billing_is_live(text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- entitlement_status — same behaviour as 0013, but the rule now comes from
-- billing_is_live() instead of being written out a second time here.
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

  if coalesce(v_sub.status, 'none') = 'past_due' and v_sub.past_due_since is not null then
    v_lockout := v_sub.past_due_since + make_interval(days => public.billing_grace_days());
  end if;

  v_live := public.billing_is_live(v_sub.status, v_sub.past_due_since);

  return json_build_object(
    'entitled', (v_reason is not null) or v_live or v_is_admin,
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
    'pastDueSince', v_sub.past_due_since,
    'lockoutAt', v_lockout,
    'graceDays', public.billing_grace_days(),
    'amountDuePence', v_sub.amount_due_pence,
    'invoiceUrl', v_sub.invoice_url
  );
end;
$$;

grant execute on function public.entitlement_status() to authenticated;

-- ---------------------------------------------------------------------------
-- admin_billing_overview — one line of 0008 changes: the `past_due` bucket.
--
-- A past_due account still inside its window keeps the 'past_due' bucket, which
-- reads as "failed, chase them, they can still use it". One PAST the deadline
-- now falls into 'lapsed' alongside every other cancelled subscription, because
-- that is what it is — the app already refuses it. The mix chart and the "How
-- everyone is covered" card both draw straight from these buckets, so they now
-- agree with the door.
--
-- MRR is untouched: it counted 'active' only, which was already correct.
-- ---------------------------------------------------------------------------
create or replace function public.admin_billing_overview()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result json;
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;

  with cls as (
    select p.id,
           case
             when p.free_access_reason is not null then 'free'
             when b.status = 'trialing' then 'trial'
             when b.status = 'active'   then 'paying'
             -- Still inside the grace window: chaseable. Past it: lapsed.
             when b.status = 'past_due' then
               case when public.billing_is_live(b.status, b.past_due_since)
                    then 'past_due' else 'lapsed' end
             when b.status is not null and b.status <> 'none' then 'lapsed'
             else 'none'
           end as bucket
      from public.profiles p
      left join public.billing_subscriptions b on b.user_id = p.id
  ),
  months as (
    select gs::date as m,
           (gs + interval '1 month')::timestamptz as m_next
      from generate_series(
             date_trunc('month', now()) - interval '11 months',
             date_trunc('month', now()),
             interval '1 month') gs
  ),
  series as (
    select mo.m,
           least(mo.m_next, now()) as t_end,
           mo.m::timestamptz       as t_start,
           mo.m_next               as m_next
      from months mo
  )
  select json_build_object(
    'mix', (
      select coalesce(json_object_agg(bucket, n), '{}'::json)
        from (select bucket, count(*) as n from cls group by bucket) g
    ),
    'freeByReason', (
      select coalesce(json_agg(json_build_object('reason', reason, 'users', n)
                               order by n desc, reason), '[]'::json)
        from (select coalesce(free_access_reason, 'league') as reason, count(*) as n
                from public.profiles
               where free_access_reason is not null
               group by 1) r
    ),
    'totalAccounts', (select count(*) from public.profiles),
    'mrrPence', (
      select coalesce(sum(monthly_pence), 0)
        from public.billing_subscriptions
       where status = 'active'
    ),
    'currency', (
      select coalesce(max(currency), 'gbp')
        from public.billing_subscriptions
       where currency is not null
    ),
    'series', (
      select coalesce(json_agg(json_build_object(
               'month',     to_char(s.m, 'YYYY-MM'),
               'mrrPence',  p.mrr_pence,
               'active',    p.active_now,
               'started',   p.started,
               'churned',   p.churned,
               'churnRate', case when p.active_start > 0
                                 then round((p.churned::numeric / p.active_start) * 100, 1)
                                 else null end,
               'activeStart', p.active_start
             ) order by s.m), '[]'::json)
        from series s
        cross join lateral (
          select
            coalesce(sum(b.monthly_pence) filter (
              where b.started_at <= s.t_end
                and (b.ended_at is null or b.ended_at > s.t_end)
                and (b.trial_end is null or b.trial_end <= s.t_end)
            ), 0)::bigint as mrr_pence,
            count(*) filter (
              where b.started_at <= s.t_end
                and (b.ended_at is null or b.ended_at > s.t_end)
                and (b.trial_end is null or b.trial_end <= s.t_end)
            )::bigint as active_now,
            count(*) filter (
              where b.started_at <= s.t_start
                and (b.ended_at is null or b.ended_at > s.t_start)
                and (b.trial_end is null or b.trial_end <= s.t_start)
            )::bigint as active_start,
            count(*) filter (
              where b.started_at >= s.t_start and b.started_at < s.m_next
            )::bigint as started,
            count(*) filter (
              where b.ended_at >= s.t_start and b.ended_at < s.m_next
            )::bigint as churned
          from public.billing_subscriptions b
        ) p
    )
  ) into result;

  return result;
end;
$$;

grant execute on function public.admin_billing_overview() to authenticated;

-- ---------------------------------------------------------------------------
-- admin_users_list — same shape as 0008, with the 'access' sort taught the
-- deadline. A locked-out account now sorts with "neither comped nor paying",
-- which is the group that sort exists to surface.
--
-- `billing_status` deliberately keeps Stripe's raw vocabulary: it is that
-- account's real Stripe status, and the Failed payments card is where the
-- deadline belongs. Changing it here would mean a RETURNS TABLE drop and a new
-- word the renderer would have to learn, to say something already on screen.
-- ---------------------------------------------------------------------------
create or replace function public.admin_users_list(
  p_search text default null,
  p_sort   text default 'last_seen',
  p_limit  int  default 200
) returns table (
  user_id            uuid,
  name               text,
  email              text,
  logins             bigint,
  last_seen_at       timestamptz,
  first_seen_at      timestamptz,
  app_version        text,
  joined_at          timestamptz,
  is_admin           boolean,
  free_access_reason text,
  billing_status     text
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_sort   text := lower(coalesce(p_sort, 'last_seen'));
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_limit  int  := greatest(1, least(coalesce(p_limit, 200), 1000));
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;
  if v_sort not in ('last_seen', 'logins', 'name', 'joined', 'access') then
    v_sort := 'last_seen';
  end if;

  return query
  with sess as (
    select a.user_id           as uid,
           count(*)            as n_logins,
           min(a.started_at)   as first_seen,
           max(a.last_seen_at) as last_seen
    from public.app_sessions a
    group by a.user_id
  ),
  lastver as (
    select distinct on (a.user_id) a.user_id as uid, a.app_version as ver
    from public.app_sessions a
    where a.app_version <> ''
    order by a.user_id, a.last_seen_at desc
  )
  select p.id,
         coalesce(nullif(btrim(p.display_name), ''), 'Driver')::text,
         coalesce(u.email, '')::text,
         coalesce(s.n_logins, 0)::bigint,
         s.last_seen,
         s.first_seen,
         coalesce(l.ver, '')::text,
         p.created_at,
         coalesce(p.is_admin, false),
         p.free_access_reason::text,
         coalesce(b.status, 'none')::text
  from public.profiles p
  left join auth.users u                     on u.id      = p.id
  left join sess s                           on s.uid     = p.id
  left join lastver l                        on l.uid     = p.id
  left join public.billing_subscriptions b   on b.user_id = p.id
  where v_search is null
     or p.display_name ilike '%' || v_search || '%'
     or u.email ilike '%' || v_search || '%'
  order by
    case when v_sort = 'logins' then coalesce(s.n_logins, 0) end desc nulls last,
    case when v_sort = 'name'   then lower(nullif(btrim(p.display_name), '')) end asc nulls last,
    case when v_sort = 'joined' then p.created_at end desc nulls last,
    case when v_sort = 'last_seen' then s.last_seen end desc nulls last,
    case when v_sort = 'access' then
      case
        when p.free_access_reason is not null then 0
        when public.billing_is_live(b.status, b.past_due_since) then 1
        else 2
      end
    end asc nulls last,
    s.last_seen desc nulls last,
    lower(coalesce(p.display_name, ''))
  limit v_limit;
end;
$$;

grant execute on function public.admin_users_list(text, text, int) to authenticated;
