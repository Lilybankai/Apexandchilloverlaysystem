-- 0031_email_announce_send.sql — the 1.0 announcement goes out.
--
-- 0030 built the campaign and deliberately left `announce_at` null, so applying
-- it sent nothing. This is the send: it sets the anchor, and within the hour the
-- dispatcher picks up everyone who had an account at this moment and has not
-- opted out. Recorded as a migration rather than run by hand because "when did
-- we mail everybody" is worth having in the same history as everything else.
--
-- `where announce_at is null` makes it safe to re-run: the anchor is set once
-- and a second application changes nothing. Without that, re-running would move
-- the anchor forward and hand a fresh attempt to anybody whose first one failed,
-- which is not what a re-run of a migration should mean.
--
-- Nobody gets it twice regardless — `email_sends` has a unique index on
-- (user_id, campaign, step) for status 'sent', so the dispatcher cannot send the
-- same step to the same person a second time even if it runs concurrently.
--
-- Checked before applying: `enabled` true, the send window is 09–20 Europe/London
-- and it is inside it, 42 accounts qualify, none opted out, none suppressed,
-- the unsubscribe and bounce-webhook functions are ACTIVE, the dispatcher has
-- been redeployed with the template bundled, and the masthead the mail links to
-- answers 200 for the first time since the sequences were switched on.
--
-- To stop it: `update public.email_settings set announce_at = null where id = true;`
-- Anything already sent has gone, but nothing further will be scheduled.

update public.email_settings
   set announce_at = now()
 where id = true
   and announce_at is null;
