-- =============================================================================
-- Billing — Stripe subscription state, league voucher codes, and the single
-- entitlement question the app asks: "may this account use the app?"
-- =============================================================================
-- Apply this in the Apex & Chill Supabase project (SQL editor, or the Supabase
-- CLI). It is the cloud half of the paywall: the desktop app calls
-- entitlement_status() through the same auth.rpc() path everything else uses,
-- and the Stripe webhook edge function (service role) writes
-- billing_subscriptions as Stripe reports changes.
--
-- Everything is written to be RE-RUNNABLE: `if not exists`, `create or replace`,
-- and `drop policy if exists` before each policy, so applying it twice is safe.
--
-- Design notes:
--   * The app is now PAID: £4.99/month, 7-day card-upfront trial. An account is
--     entitled when it has a live Stripe subscription (trialing / active /
--     past_due — past_due keeps access through Stripe's retry window rather
--     than cutting a driver off over one failed card) OR a free-access grant.
--   * Free access ("league comp") is admin-controlled, not role/Discord-based:
--     the Discord league roles are self-attested in the signup bot, so they
--     prove nothing. Admins either issue single-use voucher codes from the
--     Admin tab or grant an account directly (beta testers). Revocation is a
--     one-click admin action when someone leaves the league.
--   * billing_subscriptions is written ONLY by the webhook (service role).
--     Clients can read their own row; there is deliberately no client write
--     path, so a hacked client cannot promote itself. Same doctrine as the
--     admin panel: UI hiding is convenience, the server is the boundary.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Free-access grant on profiles. `reason` doubles as the source label shown
--    in the admin list ('league', 'beta', ...); null means "pays like anyone".
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists free_access_reason text,
  add column if not exists free_access_note   text not null default '',
  add column if not exists free_access_at     timestamptz;

-- ---------------------------------------------------------------------------
-- 2. billing_subscriptions — one row per account, mirrored from Stripe by the
--    stripe-webhook edge function. `status` is Stripe's vocabulary verbatim.
-- ---------------------------------------------------------------------------
create table if not exists public.billing_subscriptions (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id     text unique,
  stripe_subscription_id text,
  status                 text not null default 'none',
  price_id               text,
  cancel_at_period_end   boolean not null default false,
  trial_end              timestamptz,
  current_period_end     timestamptz,
  updated_at             timestamptz not null default now()
);
create index if not exists billing_subs_customer_idx
  on public.billing_subscriptions(stripe_customer_id);

alter table public.billing_subscriptions enable row level security;

drop policy if exists "own subscription readable" on public.billing_subscriptions;
create policy "own subscription readable" on public.billing_subscriptions
  for select using (user_id = auth.uid());
-- No insert/update/delete policies on purpose: only the service role writes.

-- ---------------------------------------------------------------------------
-- 3. league_codes — single-use vouchers. The code itself is the primary key;
--    `note` is the admin's reminder of who it was cut for.
-- ---------------------------------------------------------------------------
create table if not exists public.league_codes (
  code        text primary key,
  note        text not null default '',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  redeemed_by uuid references auth.users(id) on delete set null,
  redeemed_at timestamptz,
  revoked_at  timestamptz
);

alter table public.league_codes enable row level security;
-- No policies at all: clients never touch the table. Redemption and admin
-- management go through the SECURITY DEFINER functions below.

-- ---------------------------------------------------------------------------
-- 4. entitlement_status — THE question the app asks after sign-in and on every
--    focus/auth change. Never raises; a signed-out caller just gets
--    entitled:false so the caller can't tell an error from a "no".
-- ---------------------------------------------------------------------------
create or replace function public.entitlement_status()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_reason text;
  v_sub    public.billing_subscriptions%rowtype;
  v_live   boolean := false;
begin
  if v_uid is null then
    return json_build_object('entitled', false, 'source', null);
  end if;

  select p.free_access_reason into v_reason
    from public.profiles p where p.id = v_uid;

  select * into v_sub
    from public.billing_subscriptions s where s.user_id = v_uid;

  -- trialing/active are obviously live; past_due rides Stripe's dunning window
  -- so one bounced card doesn't black-screen a race weekend.
  v_live := coalesce(v_sub.status, 'none') in ('trialing', 'active', 'past_due');

  return json_build_object(
    'entitled', (v_reason is not null) or v_live,
    -- A comp wins the label even alongside a live sub: it's the stronger claim.
    'source', case
                when v_reason is not null then 'free'
                when v_live then 'stripe'
                else null
              end,
    'freeReason', v_reason,
    'status', coalesce(v_sub.status, 'none'),
    'cancelAtPeriodEnd', coalesce(v_sub.cancel_at_period_end, false),
    'trialEnd', v_sub.trial_end,
    'currentPeriodEnd', v_sub.current_period_end,
    'hasCustomer', v_sub.stripe_customer_id is not null
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. redeem_league_code — a driver types a code on the subscribe screen.
--    Case/whitespace-forgiving; one code, one account, forever (until revoked).
-- ---------------------------------------------------------------------------
create or replace function public.redeem_league_code(p_code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_row  public.league_codes%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if length(v_code) < 8 then
    return json_build_object('ok', false, 'error', 'That doesn’t look like a code.');
  end if;

  -- Stored codes are APEX-XXXX-XXXX; compare on the stripped form.
  select * into v_row
    from public.league_codes c
   where upper(regexp_replace(c.code, '[^A-Za-z0-9]', '', 'g')) = v_code
   for update;

  if not found then
    return json_build_object('ok', false, 'error', 'That code isn’t recognised.');
  end if;
  if v_row.revoked_at is not null then
    return json_build_object('ok', false, 'error', 'That code has been revoked.');
  end if;
  if v_row.redeemed_by is not null and v_row.redeemed_by <> v_uid then
    return json_build_object('ok', false, 'error', 'That code has already been used.');
  end if;

  update public.league_codes
     set redeemed_by = v_uid, redeemed_at = coalesce(redeemed_at, now())
   where code = v_row.code;

  update public.profiles
     set free_access_reason = 'league',
         free_access_note   = v_row.note,
         free_access_at     = now(),
         updated_at         = now()
   where id = v_uid;

  return json_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. admin_issue_league_codes — cut N codes with a shared note. Codes are
--    APEX-XXXX-XXXX from gen_random_uuid() hex: unguessable enough for a
--    single-use code that is also rate-limited by human patience.
-- ---------------------------------------------------------------------------
create or replace function public.admin_issue_league_codes(
  p_count int,
  p_note  text
) returns setof text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n    int := greatest(1, least(coalesce(p_count, 1), 50));
  v_hex  text;
  v_code text;
  i      int;
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;
  for i in 1..v_n loop
    loop
      v_hex  := upper(replace(gen_random_uuid()::text, '-', ''));
      v_code := 'APEX-' || substr(v_hex, 1, 4) || '-' || substr(v_hex, 5, 4);
      begin
        insert into public.league_codes (code, note, created_by)
        values (v_code, left(btrim(coalesce(p_note, '')), 120), auth.uid());
        exit;
      exception when unique_violation then
        -- 1-in-4-billion collision: roll again.
      end;
    end loop;
    return next v_code;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. admin_free_access_list — everything the Free access admin card shows:
--    outstanding + redeemed codes, and every account currently comped.
-- ---------------------------------------------------------------------------
create or replace function public.admin_free_access_list()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;
  return json_build_object(
    'codes', (
      select coalesce(json_agg(row_to_json(c) order by c.created_at desc), '[]'::json)
      from (
        select lc.code, lc.note, lc.created_at, lc.redeemed_at, lc.revoked_at,
               p.display_name as redeemed_by_name
        from public.league_codes lc
        left join public.profiles p on p.id = lc.redeemed_by
        limit 500
      ) c
    ),
    'comps', (
      select coalesce(json_agg(row_to_json(u) order by u.free_access_at desc nulls last), '[]'::json)
      from (
        select p.id, p.display_name, p.free_access_reason, p.free_access_note,
               p.free_access_at
        from public.profiles p
        where p.free_access_reason is not null
        limit 500
      ) u
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. admin_grant_free_access / admin_revoke_free_access — the direct switch,
--    used for beta testers (no code needed) and for pulling access when a
--    racer leaves the league. Revoking also burns any code they redeemed so
--    it cannot be passed on.
-- ---------------------------------------------------------------------------
create or replace function public.admin_grant_free_access(
  p_user_id uuid,
  p_reason  text,
  p_note    text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text := lower(btrim(coalesce(p_reason, 'league')));
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;
  if v_reason not in ('league', 'beta', 'friend', 'staff') then
    v_reason := 'league';
  end if;
  update public.profiles
     set free_access_reason = v_reason,
         free_access_note   = left(btrim(coalesce(p_note, '')), 120),
         free_access_at     = now(),
         updated_at         = now()
   where id = p_user_id;
  if not found then
    raise exception 'no_such_user';
  end if;
end;
$$;

create or replace function public.admin_revoke_free_access(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;
  update public.profiles
     set free_access_reason = null,
         free_access_note   = '',
         free_access_at     = null,
         updated_at         = now()
   where id = p_user_id;
  update public.league_codes
     set revoked_at = now()
   where redeemed_by = p_user_id and revoked_at is null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Grants.
-- ---------------------------------------------------------------------------
grant execute on function public.entitlement_status()                        to authenticated;
grant execute on function public.redeem_league_code(text)                    to authenticated;
grant execute on function public.admin_issue_league_codes(int, text)         to authenticated;
grant execute on function public.admin_free_access_list()                    to authenticated;
grant execute on function public.admin_grant_free_access(uuid, text, text)   to authenticated;
grant execute on function public.admin_revoke_free_access(uuid)              to authenticated;
