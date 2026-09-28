-- 0035_hold_personal_best.sql — personal bests wait for the dispatcher.
--
-- 0034 went on 2026-09-28 but the discord-dispatch deploy that renders the new
-- kind did not go with it. The live dispatcher (v10) has no style for
-- `personal_best` and falls back to record_set's — "🏆 New record … sets the
-- GT3 record" — for a lap that is nothing of the kind. So the channels that
-- 0034 switched on are switched off again until the new dispatcher is live.
-- Events emitted meanwhile fan out to no channel and are simply not posted.
--
-- To switch back on AFTER `supabase functions deploy discord-dispatch`:
--
--   update public.discord_targets
--      set kinds = kinds || array['personal_best']
--    where 'record_extended' = any(kinds)
--      and not ('personal_best' = any(kinds));
--
-- (0036, when it is run — the same statement 0034 ended with.)

update public.discord_targets
   set kinds = array_remove(kinds, 'personal_best')
 where 'personal_best' = any(kinds);
