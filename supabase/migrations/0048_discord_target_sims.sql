-- 0048_discord_target_sims.sql — let a channel opt into iRacing posts.
--
-- 2026-11-10. 0047 gave discord_targets a `sims` column (default {lmu}) and
-- made the fan-out honour it, so an iRacing PB or record never posts into an
-- LMU league's Discord. But nothing could ever change the column: iRacing
-- events were written to notification_events and then matched no channel at
-- all (inventory finding 5: "written but never delivered").
--
-- This file adds the two doors the app needs, and nothing else:
--   1. set_discord_target_sims(p_id, p_sims) — the same permission rule as
--      save_discord_target / delete_discord_target (your own personal channel,
--      or a community channel you own or admin). Only 'lmu' and 'iracing' are
--      accepted, at least one, de-duplicated and sorted.
--   2. my_discord_target_sims() — { id, sims } for every channel the caller can
--      edit (the same rows my_discord_targets and my_communities' `channels`
--      return), so the panel can draw the switches.
--
-- Deliberately NEW functions rather than a new parameter on
-- save_discord_target / a new field in my_discord_targets: their live bodies
-- could not be read from here (pg_get_functiondef refused), and replacing a
-- body from the repo copy risks undoing a change made live. A new signature on
-- save_discord_target would also have left two overloads (the 0021 trap). The
-- dispatcher needs no change: discord-dispatch already titles an iRacing post
-- ("iRacing" in the title, see embedFor), and the fan-out filters on sims.
--
-- No row is written. Every channel stays {lmu} until its owner adds iRacing.
--
-- Verify after applying:
--   select proname, proacl from pg_proc where proname in
--     ('set_discord_target_sims', 'my_discord_target_sims');   -- authenticated + service_role only
--   select sims, count(*) from public.discord_targets group by sims;   -- unchanged

create or replace function public.set_discord_target_sims(p_id uuid, p_sims text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_sims text[];
  v_id   uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select coalesce(array_agg(distinct s order by s), array[]::text[])
    into v_sims
  from unnest(coalesce(p_sims, array[]::text[])) as u(raw)
  cross join lateral (select lower(btrim(coalesce(u.raw, ''))) as s) n
  where n.s <> '';

  if cardinality(v_sims) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_sims');
  end if;
  if not (v_sims <@ array['lmu', 'iracing']::text[]) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_sim');
  end if;

  update public.discord_targets t
     set sims = v_sims
   where t.id = p_id
     and (
       (t.community_id is null and t.owner_id = v_uid)
       or exists (
         select 1 from public.community_members m
         where m.community_id = t.community_id and m.user_id = v_uid
           and m.role in ('owner', 'admin')
       )
     )
  returning t.id into v_id;

  if v_id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_such_channel');
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'sims', to_jsonb(v_sims));
end;
$$;

create or replace function public.my_discord_target_sims()
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
    select jsonb_agg(jsonb_build_object('id', t.id, 'sims', to_jsonb(t.sims)) order by t.created_at)
    from public.discord_targets t
    where (t.community_id is null and t.owner_id = v_uid)
       or exists (
         select 1 from public.community_members m
         where m.community_id = t.community_id and m.user_id = v_uid
           and m.role in ('owner', 'admin')
       )
  ), '[]'::jsonb);
end;
$$;

-- New functions pick up Supabase's default grants (anon included): close them.
revoke all on function public.set_discord_target_sims(uuid, text[]) from public, anon;
grant execute on function public.set_discord_target_sims(uuid, text[]) to authenticated, service_role;
revoke all on function public.my_discord_target_sims() from public, anon;
grant execute on function public.my_discord_target_sims() to authenticated, service_role;
