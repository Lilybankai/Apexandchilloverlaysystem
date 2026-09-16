-- ===========================================================================
-- 0025_referral_click_from_web — let the website count a link open.
--
-- 0023 granted `referral_record_click` to `service_role` alone, on the
-- reasoning that anon access would let anyone inflate a partner's numbers from
-- a browser console. Correct in isolation, and wrong about the deployment:
--
--   the website  lives in Supabase project yfgvsiqrrxuucrkkqmqy
--   Apex AIO     lives in Supabase project svtyxuhbsbbodsecbnsc
--
-- They are different projects. The website's service-role key opens its own
-- database — join submissions and merch orders — and has no more access to the
-- referral tables than a stranger does. So the click was never being recorded,
-- and the lookup behind the landing-page banner was never resolving either:
-- both were asking a database that has never heard of `referral_codes`.
--
-- The lookup is easy — `referral_code_lookup` is already granted to `anon`, and
-- the AIO project's anon key is public by construction (it ships inside every
-- installer). The website just has to point at the right project.
--
-- The click is the judgement call. The options were:
--
--   1. Give the website the AIO project's SERVICE-ROLE key. That key bypasses
--      RLS on accounts, billing and lap data. Handing it to a marketing site to
--      increment a counter is a spectacularly bad trade.
--   2. Leave it service-role and let clicks simply never be counted. Honest,
--      but the admin pane then shows every partner sitting on zero opens
--      forever, which reads as broken rather than as unmeasured.
--   3. Grant it to `anon`, and bound the damage.
--
-- (3), with a cap. What an attacker gains is a wrong number in a column nobody
-- is paid on: clicks buy nothing, and `redeemed` / `paying` are the columns
-- that decide whether a partnership continues — neither can be faked from
-- outside, because both require a real account and a real Stripe subscription.
-- The cap keeps a bored script from turning the number into a headline.
--
-- Re-runnable.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- referral_record_click — now anon-callable, and capped per code per day.
--
-- The cap is deliberately far above any real link: a partner whose stream sends
-- five thousand people to one URL in a day has a much better problem than an
-- inaccurate counter. Past it the function silently stops counting rather than
-- raising — this is called from the redirect path, and a visitor must never see
-- an error because a counter hit a ceiling.
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
  on conflict (code, day) do update
    set clicks = case when d.clicks >= 5000 then d.clicks else d.clicks + 1 end;
end;
$$;

revoke all on function public.referral_record_click(text) from public;
grant execute on function public.referral_record_click(text) to anon, authenticated, service_role;
