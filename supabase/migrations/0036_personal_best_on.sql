-- 0036_personal_best_on.sql — the dispatcher is live, so personal bests are too.
--
-- discord-dispatch v11 (which renders `personal_best`) was deployed on
-- 2026-09-28 10:26Z. This undoes 0035's hold: the same statement 0034 ended
-- with, for every channel that already takes improvements to a record.

update public.discord_targets
   set kinds = kinds || array['personal_best']
 where 'record_extended' = any(kinds)
   and not ('personal_best' = any(kinds));
