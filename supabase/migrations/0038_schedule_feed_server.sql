-- 0038_schedule_feed_server.sql — the calendar fills itself
-- -----------------------------------------------------------------------------
-- 0037 made the Schedule tab's calendars shareable, but only members' desktop
-- apps wrote them — and the daily races only from an app whose driver had LMU
-- running. So with the game shut, the web page and the app itself showed no
-- races at all. The edge function schedule-refresh now writes from the server
-- every two hours:
--
--   dailies_public — the daily rotation from racecontrol.gg's public page (no
--                    game needed; fewer details than RaceOS)
--   league         — SimGrid's two championships
--
-- The app's RaceOS copy ('dailies') stays the richer one and is preferred
-- while it is this week's; control-panel/schedule-core.js makes that choice
-- and fills the public copy in from it. Apps cannot write 'dailies_public':
-- schedule_feed_publish still accepts only 'league' and 'dailies'.

alter table public.schedule_feed drop constraint if exists schedule_feed_source_check;
alter table public.schedule_feed add constraint schedule_feed_source_check
  check (source in ('league', 'dailies', 'dailies_public'));

-- Read: all three rows, same shape per row as before.
create or replace function public.schedule_feed_read()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'ok', true,
    'league', (select jsonb_build_object(
                 'payload', payload,
                 'fetched_at', fetched_at,
                 'age_sec', round(extract(epoch from (now() - fetched_at)))::int)
               from public.schedule_feed where source = 'league'),
    'dailies', (select jsonb_build_object(
                  'payload', payload,
                  'fetched_at', fetched_at,
                  'age_sec', round(extract(epoch from (now() - fetched_at)))::int)
                from public.schedule_feed where source = 'dailies'),
    'dailies_public', (select jsonb_build_object(
                  'payload', payload,
                  'fetched_at', fetched_at,
                  'age_sec', round(extract(epoch from (now() - fetched_at)))::int)
                from public.schedule_feed where source = 'dailies_public')
  );
$$;

revoke all on function public.schedule_feed_read() from public, anon;
grant execute on function public.schedule_feed_read() to authenticated;

-- Every two hours, seven minutes past (clear of the top-of-hour crowd). The
-- function needs no secret: it only re-reads public calendars and throttles
-- itself. Re-runnable: cron.schedule upserts on the job name.
select cron.schedule('apex-schedule-refresh', '7 */2 * * *', $job$
  select net.http_post(
    url     := 'https://svtyxuhbsbbodsecbnsc.supabase.co/functions/v1/schedule-refresh',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer sb_publishable_Q-0gsoTW_r-AzgKQ6NqNSQ_vGegMK8w'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 50000
  );
$job$);
