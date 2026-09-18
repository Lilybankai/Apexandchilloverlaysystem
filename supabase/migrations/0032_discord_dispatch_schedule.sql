-- 0032_discord_dispatch_schedule — switch the Discord dispatcher on.
--
-- 0026/0027 built the pipeline and the app has been filling it since
-- 2026-09-17, but the cloud half (docs/DISCORD-NOTIFICATIONS.md ▸ Setup) was
-- never scheduled: no cron, no vault key, no deployed function. Every event
-- sat with fanned_out_at null and the outbox stayed empty. This is steps 4
-- (schedule) of that section, done as a migration because the MCP's SQL tool
-- is read-only and a migration is the only write path — the same reason 0031
-- exists.
--
-- The dispatch key: the function reads DISCORD_DISPATCH_KEY from its own
-- secrets (dashboard), and the cron reads the same value from the vault. The
-- value is NOT in this file. At apply time the caller prepends
--   set local apex.discord_dispatch_key = '<value>';
-- and the block below creates the vault row from that setting, once. Re-run
-- without the setting (or with the row already there) it does nothing.
--
-- The backlog: fanout_notification_events() has no age cutoff, so the first
-- run would have replayed a day of events into the channel. A record six
-- minutes late has stopped being news (docs, "every minute"), so everything
-- emitted before the dispatcher existed is marked fanned-out and skipped. The
-- cutoff is a fixed timestamp, never now(), so this file can never eat a live
-- event on a re-run.
--
-- Re-runnable: cron.schedule upserts on the job name.

do $$
declare
  v_key text := coalesce(current_setting('apex.discord_dispatch_key', true), '');
begin
  if v_key <> '' and not exists (
    select 1 from vault.secrets where name = 'discord_dispatch_key'
  ) then
    perform vault.create_secret(v_key, 'discord_dispatch_key');
  end if;
end $$;

select cron.schedule('apex-discord-dispatch', '* * * * *', $job$
  select net.http_post(
    url     := 'https://svtyxuhbsbbodsecbnsc.supabase.co/functions/v1/discord-dispatch',
    headers := jsonb_build_object(
                 'Content-Type',   'application/json',
                 'Authorization',  'Bearer sb_publishable_Q-0gsoTW_r-AzgKQ6NqNSQ_vGegMK8w',
                 'x-dispatch-key', (select decrypted_secret from vault.decrypted_secrets
                                     where name = 'discord_dispatch_key')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 50000
  );
$job$);

select cron.schedule('apex-notification-prune', '20 4 * * 0',
  $job$ select public.notification_prune(); $job$);

-- Everything emitted before the dispatcher existed. See the header.
update public.notification_events
   set fanned_out_at = now()
 where fanned_out_at is null
   and created_at < timestamptz '2026-09-18 10:45:00+00';
