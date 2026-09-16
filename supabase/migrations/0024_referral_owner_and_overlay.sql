-- ===========================================================================
-- 0024_referral_owner_and_overlay — hand a partner their own code, and a
-- stream overlay to put it on screen with.
--
-- 0023 shipped `referral_codes.owner_user_id` and `my_referral_code()`, so a
-- partner who owned a code already saw their link and their numbers in
-- Settings → Account. What it did not ship was any way to SET that column
-- outside a hand-written SQL statement, which meant the feature existed and
-- nobody could reach it. This fixes that, and adds the one thing a partner
-- actually wants next: a branded overlay for their stream carrying the code.
--
-- Two additions:
--
--   admin_set_referral_owner  — link (or unlink) a code to an account, BY
--                               EMAIL, because an email is what an admin has
--                               and a uuid is not.
--   my_referral_code()        — now also returns `overlayUrl`, so the partner
--                               can copy an OBS browser source straight from
--                               their account page.
--
-- Re-runnable.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. referral_overlay_url — the OBS browser source for a code.
--
--    Beside referral_url() and for the same reason: the desktop app ships
--    slowly, so the address lives here where changing it is a migration rather
--    than a release everyone has to install.
-- ---------------------------------------------------------------------------
create or replace function public.referral_overlay_url(p_code text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select 'https://apexandchillracing.co.uk/r/' || upper(coalesce(p_code, '')) || '/overlay';
$$;

grant execute on function public.referral_overlay_url(text) to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- 2. admin_set_referral_owner — point a code at a driver's account.
--
--    Takes the owner's EMAIL, not their user id. An admin issuing a code to a
--    streamer has their email in front of them; asking for a uuid would mean
--    looking it up in a second place every time, which is how a field ends up
--    left blank.
--
--    Passing null/'' UNLINKS, so a code can be moved between accounts or
--    detached without deleting it and losing its history.
--
--    Deliberately does NOT create an account. A code can be issued long before
--    its owner has ever opened the app — that is the normal case — and it
--    simply stays unlinked until they exist. Saying so plainly beats silently
--    succeeding against nobody.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_referral_owner(
  p_code  text,
  p_email text
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code  text := public.referral_normalise(p_code);
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_uid   uuid;
  v_name  text;
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;

  if not exists (select 1 from public.referral_codes where code = v_code) then
    return json_build_object('ok', false, 'error', 'No such code.');
  end if;

  -- Empty email = unlink. The code and every number on it stay exactly where
  -- they are; only the partner's view of it goes away.
  if v_email = '' then
    update public.referral_codes set owner_user_id = null where code = v_code;
    return json_build_object('ok', true, 'linked', false);
  end if;

  select u.id into v_uid from auth.users u where lower(u.email) = v_email;
  if v_uid is null then
    return json_build_object(
      'ok', false,
      'error', 'No account with that email. The code still works — link it once they have signed up.'
    );
  end if;

  -- One account, one code. A driver with two would see an arbitrary one of
  -- them in Settings (my_referral_code takes the oldest), which is worse than
  -- refusing: they would promote a link whose numbers they cannot see.
  if exists (
    select 1 from public.referral_codes
     where owner_user_id = v_uid and code <> v_code and active and revoked_at is null
  ) then
    return json_build_object(
      'ok', false,
      'error', 'That account already owns an active code. Unlink or turn off the other one first.'
    );
  end if;

  update public.referral_codes set owner_user_id = v_uid where code = v_code;

  select coalesce(p.display_name, '') into v_name from public.profiles p where p.id = v_uid;
  return json_build_object('ok', true, 'linked', true, 'driver', coalesce(v_name, ''));
end;
$$;

revoke all on function public.admin_set_referral_owner(text, text) from public, anon;
grant execute on function public.admin_set_referral_owner(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. my_referral_code — unchanged except for `overlayUrl`.
--
--    Recreated in full rather than patched, because `create or replace` needs
--    the whole body anyway. Every existing key is byte-for-byte what 0023
--    returned, so an older panel reading this sees no difference.
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
    'overlayUrl', public.referral_overlay_url(v_row.code),
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
-- 4. admin_referral_list — carries the owner's email and the overlay URL.
--
--    The email so the Referrals pane can show WHO a code is linked to rather
--    than a bare "yes"; the overlay URL so an admin can send a partner both
--    links without going and building one by hand.
--
--    This is the one admin read that names a person, and it is the same
--    deliberate exception the driver roster already makes: it is about
--    identity, not about how anyone drives. It still shows nothing at all
--    about who USED a code.
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
               (select u.email from auth.users u where u.id = c.owner_user_id) as "ownerEmail",
               public.referral_url(c.code)           as url,
               public.referral_overlay_url(c.code)   as "overlayUrl",
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
-- 5. admin_issue_referral_code — issue and link in one step.
--
--    Same function, one extra optional argument: the owner's email. Issuing a
--    code and linking it are one action from the admin's point of view, and
--    making them two is how the second half gets forgotten.
--
--    The old 4-argument signature is DROPPED rather than left alongside. Two
--    overloads that differ only by a defaulted argument leave PostgREST unable
--    to resolve a call by named arguments — the same trap migration 0021 hit
--    with `leaderboard`.
--
--    A bad email does not lose the code: it is created, the failure to link is
--    reported, and the admin can link it afterwards.
-- ---------------------------------------------------------------------------
drop function if exists public.admin_issue_referral_code(text, text, uuid, text);

create or replace function public.admin_issue_referral_code(
  p_code          text,
  p_owner_name    text default '',
  p_owner_user_id uuid default null,
  p_note          text default '',
  p_owner_email   text default ''
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code  text := public.referral_normalise(p_code);
  v_email text := lower(btrim(coalesce(p_owner_email, '')));
  v_uid   uuid := p_owner_user_id;
  v_warn  text := null;
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
  if exists (
    select 1 from public.league_codes c where public.referral_normalise(c.code) = v_code
  ) then
    return json_build_object('ok', false, 'error', 'That clashes with a league access code.');
  end if;

  -- Resolve the email if one was given and no explicit id was.
  if v_uid is null and v_email <> '' then
    select u.id into v_uid from auth.users u where lower(u.email) = v_email;
    if v_uid is null then
      v_warn := 'No account with that email yet — the code works, but link it once they sign up.';
    elsif exists (
      select 1 from public.referral_codes
       where owner_user_id = v_uid and active and revoked_at is null
    ) then
      v_uid  := null;
      v_warn := 'That account already owns an active code, so this one was left unlinked.';
    end if;
  end if;

  insert into public.referral_codes (code, owner_user_id, owner_name, note, created_by)
  values (v_code, v_uid, left(coalesce(p_owner_name, ''), 80),
          left(coalesce(p_note, ''), 200), auth.uid());

  return json_build_object(
    'ok', true,
    'code', v_code,
    'url', public.referral_url(v_code),
    'overlayUrl', public.referral_overlay_url(v_code),
    'linked', v_uid is not null,
    'warning', v_warn
  );
end;
$$;

revoke all on function public.admin_issue_referral_code(text, text, uuid, text, text) from public, anon;
grant execute on function public.admin_issue_referral_code(text, text, uuid, text, text) to authenticated;
