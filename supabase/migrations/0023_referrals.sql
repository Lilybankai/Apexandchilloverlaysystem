-- ===========================================================================
-- 0023_referrals — partner referral codes, and the 10% they hand out.
--
-- A partner (a streamer, a league admin, someone with an audience) is issued a
-- code. They promote `apexandchillracing.co.uk/r/THEIRCODE`. Anyone who arrives
-- that way and enters the code in the app gets **10% off the subscription, for
-- as long as they keep it**. The partner gets nothing today — this is a
-- promotion tool, not an affiliate payout scheme — but everything needed to pay
-- one later is recorded from day one, because attribution you did not collect
-- is attribution you cannot backfill.
--
-- ## The gap this works around
-- A link cannot carry the discount. The click happens in a browser; the payment
-- happens a week later inside a signed desktop app, after a 285 MB download, an
-- install and a sign-up. No cookie, session or UTM survives that. So the link
-- carries a CODE, the code is typed once on the subscribe screen, and the
-- discount is attached server-side at Checkout. The link is marketing; this
-- table is the mechanism.
--
-- That also means the code works when there was never a link at all — read out
-- on a stream, posted in Discord, printed on a sticker. Which is most of how
-- these are actually shared.
--
-- ## Stripe
-- ONE coupon, not one per partner. `percent_off = 10, duration = forever`,
-- created once (see docs/REFERRALS.md) and named by the `REFERRAL_COUPON_ID`
-- secret on create-checkout-session. Per-partner attribution lives HERE, in
-- `referral_attributions`, rather than as N promotion codes in Stripe: it is
-- one object to manage instead of one per partner, and it keeps "who referred
-- whom" queryable next to everything else the admin panel reads. Adding a
-- payout later is then a report over this table, not a migration.
--
-- Re-runnable: `if not exists`, `create or replace`, `drop policy if exists`.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. referral_codes — one row per partner.
--
--    `owner_user_id` is NULLABLE on purpose. A code is often issued to someone
--    who has not installed the app yet — that is rather the point of giving
--    them one — and refusing to mint it until they have an account would make
--    the common case the awkward one. It is filled in later (or never) and only
--    ever used to show the partner their own link inside the app.
-- ---------------------------------------------------------------------------
create table if not exists public.referral_codes (
  -- Stored EXACTLY as it should be shown: upper case, A-Z0-9 only. Matching is
  -- done on this same normalised form, so `craig`, `Craig` and ` CRAIG ` all
  -- find CRAIG without storing three spellings.
  code           text primary key
                   check (code = upper(code) and code ~ '^[A-Z0-9]{3,24}$'),
  owner_user_id  uuid references auth.users(id) on delete set null,
  -- Shown to the person being referred ("Craig sent you"), so it is a display
  -- name and never an email.
  owner_name     text not null default '',
  -- The league's own note. Never leaves the admin pane.
  note           text not null default '',
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users(id) on delete set null,
  revoked_at     timestamptz
);

create index if not exists referral_codes_owner_idx on public.referral_codes(owner_user_id);

comment on table public.referral_codes is
  'Partner referral codes. A code grants the PERSON WHO USES IT 10% off; the owner is paid nothing today. Read publicly (name only) via referral_code_lookup().';

alter table public.referral_codes enable row level security;
-- No client policy at all: every read and write goes through the security-
-- definer functions below, which decide what each caller may see. A partner
-- reads their own row through my_referral_code(), the website reads a name
-- through referral_code_lookup(), and nobody gets the table.

-- ---------------------------------------------------------------------------
-- 2. referral_click_days — how many people opened a partner's link.
--
--    The top of the funnel, and the only part of it the website can see. A
--    daily counter rather than a row per click, for the same reasons as
--    feature_usage (0022): it is a number, not a timeline, and a table of
--    individual clicks with timestamps is a browsing history nobody asked for.
--    No IP, no user agent, no referrer — just "this code was opened N times on
--    this day".
-- ---------------------------------------------------------------------------
create table if not exists public.referral_click_days (
  code   text not null references public.referral_codes(code) on delete cascade,
  day    date not null,
  clicks int  not null default 0,
  primary key (code, day)
);

comment on table public.referral_click_days is
  'Daily open-count per referral link. Counts only — no IP, user agent or referrer is stored.';

alter table public.referral_click_days enable row level security;

-- ---------------------------------------------------------------------------
-- 3. referral_attributions — who used whose code.
--
--    One row per referred driver, keyed by the driver, so a person can be
--    referred by exactly one partner and the question "who brought them in"
--    has one answer.
--
--    Changeable until they are PAYING, then fixed. A code mistyped as another
--    partner's should be fixable, and until money has changed hands nothing is
--    owed to anyone; once a subscription is live the attribution is a financial
--    fact and stops moving. `redeem_referral_code` enforces that.
-- ---------------------------------------------------------------------------
create table if not exists public.referral_attributions (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  code        text not null references public.referral_codes(code) on delete cascade,
  attached_at timestamptz not null default now(),
  -- Stamped by the webhook path the first time a discounted subscription goes
  -- live, so "did the discount actually reach Stripe" is answerable without
  -- calling Stripe.
  applied_at  timestamptz
);

create index if not exists referral_attributions_code_idx on public.referral_attributions(code);

comment on table public.referral_attributions is
  'Which partner code each driver used. Written only via redeem_referral_code(). Cascades with the account, so erasure removes it.';

alter table public.referral_attributions enable row level security;

drop policy if exists "own attribution readable" on public.referral_attributions;
create policy "own attribution readable" on public.referral_attributions
  for select using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. referral_url — the one place that knows the address.
--
--    The desktop app ships slowly and a domain change should not need a release
--    to follow it, so the full link is built here and handed to the app ready
--    to copy, rather than assembled from a constant baked into the installer.
-- ---------------------------------------------------------------------------
create or replace function public.referral_url(p_code text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select 'https://apexandchillracing.co.uk/r/' || upper(coalesce(p_code, ''));
$$;

grant execute on function public.referral_url(text) to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- 5. referral_normalise — the matching rule, written once.
--
--    Every lookup in this file goes through it, so a code typed with a stray
--    dash, a space or the wrong case resolves the same way everywhere. A second
--    spelling of this rule somewhere else is how `CRAIG` stops matching CRAIG.
-- ---------------------------------------------------------------------------
create or replace function public.referral_normalise(p_code text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

grant execute on function public.referral_normalise(text) to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- 6. referral_code_lookup — what the WEBSITE may know about a code.
--
--    Anon-callable, because the landing page renders "Craig sent you" before
--    anyone has signed in. Deliberately returns the owner's display NAME and
--    nothing else: not the email, not the user id, not the note, not how many
--    people have used it. A public endpoint that answered any of those would be
--    a way to enumerate partners and their performance from outside.
--
--    An unknown or revoked code answers `ok:false` rather than raising, so the
--    page can fall back to the ordinary download rather than showing an error
--    to someone who did nothing wrong.
-- ---------------------------------------------------------------------------
create or replace function public.referral_code_lookup(p_code text)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_row public.referral_codes%rowtype;
begin
  select * into v_row
    from public.referral_codes c
   where c.code = public.referral_normalise(p_code);

  if not found or not v_row.active or v_row.revoked_at is not null then
    return json_build_object('ok', false);
  end if;

  return json_build_object(
    'ok', true,
    'code', v_row.code,
    'ownerName', v_row.owner_name,
    'percentOff', 10
  );
end;
$$;

revoke all on function public.referral_code_lookup(text) from public;
grant execute on function public.referral_code_lookup(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. referral_record_click — the website counts an opened link.
--
--    service_role only. The website calls it from a route handler with its
--    admin client; exposing it to `anon` would let anyone inflate a partner's
--    numbers from a browser console, and these numbers exist to be read by
--    someone deciding who to keep working with.
--
--    Unknown codes are ignored rather than rejected: a typo in a shared link
--    should be a quiet zero, not a 500 on a landing page.
-- ---------------------------------------------------------------------------
create or replace function public.referral_record_click(p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := public.referral_normalise(p_code);
begin
  if not exists (select 1 from public.referral_codes where code = v_code) then
    return;
  end if;
  insert into public.referral_click_days as d (code, day, clicks)
  values (v_code, current_date, 1)
  on conflict (code, day) do update set clicks = d.clicks + 1;
end;
$$;

revoke all on function public.referral_record_click(text) from public, anon, authenticated;
grant execute on function public.referral_record_click(text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. redeem_referral_code — a driver attaches a partner's code to themselves.
--
--    Returns the same `{ok, ...}` json shape as redeem_league_code, so the
--    subscribe screen can report either outcome without knowing which happened.
--
--    The rule about changing it: allowed until a subscription is LIVE, then
--    fixed. Until money moves nobody is owed anything and a typo should be
--    fixable; once it does, the attribution is a financial record.
-- ---------------------------------------------------------------------------
create or replace function public.redeem_referral_code(p_code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_code    text := public.referral_normalise(p_code);
  v_row     public.referral_codes%rowtype;
  v_current public.referral_attributions%rowtype;
  v_live    boolean;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_row from public.referral_codes c where c.code = v_code;
  if not found then
    return json_build_object('ok', false, 'error', 'That code isn’t recognised.');
  end if;
  if not v_row.active or v_row.revoked_at is not null then
    return json_build_object('ok', false, 'error', 'That code is no longer active.');
  end if;

  -- A partner using their own link adds nothing and looks like gaming the
  -- numbers the moment there is a payout, so it is refused now rather than
  -- becoming a rule change later.
  if v_row.owner_user_id is not null and v_row.owner_user_id = v_uid then
    return json_build_object('ok', false, 'error', 'That’s your own code.');
  end if;

  select bs.status is not null
         and public.billing_is_live(bs.status, bs.past_due_since)
    into v_live
    from public.billing_subscriptions bs
   where bs.user_id = v_uid;

  select * into v_current from public.referral_attributions a where a.user_id = v_uid;

  if found and v_current.code = v_code then
    -- Idempotent: re-entering the same code is a no-op success, not an error.
    return json_build_object(
      'ok', true, 'kind', 'referral', 'code', v_row.code,
      'ownerName', v_row.owner_name, 'percentOff', 10, 'alreadyApplied', true
    );
  end if;

  if found and coalesce(v_live, false) then
    return json_build_object(
      'ok', false,
      'error', 'Your subscription is already running, so the code it started on can’t be changed.'
    );
  end if;

  insert into public.referral_attributions (user_id, code, attached_at)
  values (v_uid, v_code, now())
  on conflict (user_id) do update set code = excluded.code, attached_at = now();

  return json_build_object(
    'ok', true, 'kind', 'referral', 'code', v_row.code,
    'ownerName', v_row.owner_name, 'percentOff', 10
  );
end;
$$;

revoke all on function public.redeem_referral_code(text) from public, anon;
grant execute on function public.redeem_referral_code(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. redeem_code — the ONE door the subscribe screen's box calls.
--
--    That box has always taken a league access code. It now also takes a
--    referral code, and the driver should not have to know which kind they
--    were given — they were handed "a code". So the routing happens here, in
--    one place, rather than as two calls and a guess in the client.
--
--    League first: those are APEX-XXXX-XXXX and unmistakable, and free access
--    beats a discount if some code were ever somehow both.
-- ---------------------------------------------------------------------------
create or replace function public.redeem_code(p_code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := public.referral_normalise(p_code);
  v_res  json;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  if length(v_code) < 3 then
    return json_build_object('ok', false, 'error', 'That doesn’t look like a code.');
  end if;

  -- A league code exists? Take that path and return its own answer verbatim.
  if exists (
    select 1 from public.league_codes c
     where public.referral_normalise(c.code) = v_code
  ) then
    v_res := public.redeem_league_code(p_code);
    -- Tag the kind so the panel can say "free access" rather than "10% off".
    -- Cast back to json explicitly: the concatenation operator only exists on
    -- jsonb, and this function's return type is json.
    if coalesce((v_res ->> 'ok')::boolean, false) then
      return (v_res::jsonb || jsonb_build_object('kind', 'league'))::json;
    end if;
    return v_res;
  end if;

  if exists (select 1 from public.referral_codes where code = v_code) then
    return public.redeem_referral_code(p_code);
  end if;

  return json_build_object('ok', false, 'error', 'That code isn’t recognised.');
end;
$$;

revoke all on function public.redeem_code(text) from public, anon;
grant execute on function public.redeem_code(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. my_referral — "is a discount attached to me?"
--
--     Read by the subscribe screen so it can say so BEFORE the driver commits,
--     and by Settings afterwards. Returns null-ish rather than raising when
--     there is nothing attached, which is the common case.
-- ---------------------------------------------------------------------------
create or replace function public.my_referral()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_out json;
begin
  if v_uid is null then
    return json_build_object('ok', false);
  end if;
  select json_build_object(
           'ok', true,
           'code', a.code,
           'ownerName', c.owner_name,
           'percentOff', 10,
           'attachedAt', a.attached_at,
           -- A revoked code stops discounting new subscriptions; say so rather
           -- than promising 10% the checkout will not give.
           'active', c.active and c.revoked_at is null
         )
    into v_out
    from public.referral_attributions a
    join public.referral_codes c on c.code = a.code
   where a.user_id = v_uid;

  return coalesce(v_out, json_build_object('ok', false));
end;
$$;

revoke all on function public.my_referral() from public, anon;
grant execute on function public.my_referral() to authenticated;

-- ---------------------------------------------------------------------------
-- 11. my_referral_code — "do I OWN a code, and how is it doing?"
--
--     What Settings → Account shows a partner: their link, ready to copy, and
--     the three numbers that say whether it is working. Anyone without a code
--     gets `ok:false` and the card never appears.
--
--     A partner sees their own totals and no one else's, and never a name or
--     an email of anyone who used it — the counts are aggregates for the same
--     reason the admin panel's are.
-- ---------------------------------------------------------------------------
create or replace function public.my_referral_code()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.referral_codes%rowtype;
begin
  if v_uid is null then
    return json_build_object('ok', false);
  end if;

  select * into v_row
    from public.referral_codes c
   where c.owner_user_id = v_uid and c.active and c.revoked_at is null
   order by c.created_at
   limit 1;

  if not found then
    return json_build_object('ok', false);
  end if;

  return json_build_object(
    'ok', true,
    'code', v_row.code,
    'url', public.referral_url(v_row.code),
    'percentOff', 10,
    'clicks',  (select coalesce(sum(d.clicks), 0)
                  from public.referral_click_days d where d.code = v_row.code),
    'signups', (select count(*)
                  from public.referral_attributions a where a.code = v_row.code),
    'paying',  (select count(*)
                  from public.referral_attributions a
                  join public.billing_subscriptions b on b.user_id = a.user_id
                 where a.code = v_row.code
                   and public.billing_is_live(b.status, b.past_due_since))
  );
end;
$$;

revoke all on function public.my_referral_code() from public, anon;
grant execute on function public.my_referral_code() to authenticated;

-- ---------------------------------------------------------------------------
-- 12. admin_referral_list — the Referrals pane.
--
--     Aggregates per code, never a list of the people behind them: the same
--     rule the rest of the admin panel follows. "28 signed up, 11 paying" is
--     what decides whether a partnership is working; who they are is not the
--     league's business to browse.
-- ---------------------------------------------------------------------------
create or replace function public.admin_referral_list()
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

  select json_build_object(
    'percentOff', 10,
    'totals', json_build_object(
      'codes',   (select count(*) from public.referral_codes where active and revoked_at is null),
      'clicks',  (select coalesce(sum(clicks), 0) from public.referral_click_days),
      'signups', (select count(*) from public.referral_attributions),
      'paying',  (select count(*)
                    from public.referral_attributions a
                    join public.billing_subscriptions b on b.user_id = a.user_id
                   where public.billing_is_live(b.status, b.past_due_since))
    ),
    'rows', (
      select coalesce(json_agg(row_to_json(r) order by r.paying desc, r.signups desc, r.code), '[]'::json)
      from (
        select c.code,
               c.owner_name                          as "ownerName",
               c.note,
               c.active and c.revoked_at is null     as active,
               to_char(c.created_at, 'YYYY-MM-DD')   as "createdAt",
               c.owner_user_id is not null           as "ownerLinked",
               public.referral_url(c.code)           as url,
               (select coalesce(sum(d.clicks), 0)::int
                  from public.referral_click_days d where d.code = c.code) as clicks,
               (select count(*)::int
                  from public.referral_attributions a where a.code = c.code) as signups,
               (select count(*)::int
                  from public.referral_attributions a
                  join public.billing_subscriptions b on b.user_id = a.user_id
                 where a.code = c.code
                   and public.billing_is_live(b.status, b.past_due_since)) as paying
        from public.referral_codes c
      ) r
    )
  ) into result;

  return result;
end;
$$;

revoke all on function public.admin_referral_list() from public, anon;
grant execute on function public.admin_referral_list() to authenticated;

-- ---------------------------------------------------------------------------
-- 13. admin_issue_referral_code — mint one.
--
--     The owner is named as free text and optionally linked to an account. The
--     link is what makes the partner's own link appear in their Settings; it is
--     optional because a code is usually issued before that person has ever
--     opened the app.
-- ---------------------------------------------------------------------------
create or replace function public.admin_issue_referral_code(
  p_code       text,
  p_owner_name text default '',
  p_owner_user_id uuid default null,
  p_note       text default ''
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := public.referral_normalise(p_code);
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;
  if v_code !~ '^[A-Z0-9]{3,24}$' then
    return json_build_object('ok', false,
      'error', 'A code is 3–24 letters or digits — no spaces or punctuation.');
  end if;
  if exists (select 1 from public.referral_codes where code = v_code) then
    return json_build_object('ok', false, 'error', 'That code already exists.');
  end if;
  -- A referral code that collides with a league code would be unreachable:
  -- redeem_code checks league codes first and would take that branch forever.
  if exists (
    select 1 from public.league_codes c where public.referral_normalise(c.code) = v_code
  ) then
    return json_build_object('ok', false, 'error', 'That clashes with a league access code.');
  end if;

  insert into public.referral_codes (code, owner_user_id, owner_name, note, created_by)
  values (v_code, p_owner_user_id, left(coalesce(p_owner_name, ''), 80),
          left(coalesce(p_note, ''), 200), auth.uid());

  return json_build_object('ok', true, 'code', v_code, 'url', public.referral_url(v_code));
end;
$$;

revoke all on function public.admin_issue_referral_code(text, text, uuid, text) from public, anon;
grant execute on function public.admin_issue_referral_code(text, text, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 14. admin_set_referral_active — turn one off (or back on).
--
--     Deactivating stops NEW redemptions. It deliberately does not touch anyone
--     already attached: their subscription is discounted in Stripe and ending a
--     partnership is not a reason to put someone's bill up without warning.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_referral_active(p_code text, p_active boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := public.referral_normalise(p_code);
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;
  update public.referral_codes
     set active     = coalesce(p_active, true),
         revoked_at = case when coalesce(p_active, true) then null else now() end
   where code = v_code;
  if not found then
    return json_build_object('ok', false, 'error', 'No such code.');
  end if;
  return json_build_object('ok', true);
end;
$$;

revoke all on function public.admin_set_referral_active(text, boolean) from public, anon;
grant execute on function public.admin_set_referral_active(text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 15. referral_for_checkout — what create-checkout-session asks.
--
--     service_role only; the edge function calls it with the service key after
--     it has already identified the caller from their JWT. Answers "should this
--     user's Checkout Session carry the coupon", and nothing else.
-- ---------------------------------------------------------------------------
create or replace function public.referral_for_checkout(p_user_id uuid)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_out json;
begin
  select json_build_object('ok', true, 'code', a.code, 'ownerName', c.owner_name)
    into v_out
    from public.referral_attributions a
    join public.referral_codes c on c.code = a.code
   where a.user_id = p_user_id
     and c.active
     and c.revoked_at is null;
  return coalesce(v_out, json_build_object('ok', false));
end;
$$;

revoke all on function public.referral_for_checkout(uuid) from public, anon, authenticated;
grant execute on function public.referral_for_checkout(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 16. referral_mark_applied — the discount reached Stripe.
--
--     Stamped by create-checkout-session once the session is created carrying
--     the coupon, so "did it actually apply" is answerable from our own tables
--     instead of by reading Stripe back.
-- ---------------------------------------------------------------------------
create or replace function public.referral_mark_applied(p_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.referral_attributions
     set applied_at = coalesce(applied_at, now())
   where user_id = p_user_id;
$$;

revoke all on function public.referral_mark_applied(uuid) from public, anon, authenticated;
grant execute on function public.referral_mark_applied(uuid) to service_role;
