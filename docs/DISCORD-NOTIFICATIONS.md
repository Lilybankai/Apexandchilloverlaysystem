# Discord notifications

Records and race results into a league's Discord channel, the way MyLMU does it
for free — but posting a third as many messages, which is the whole design.

Started 2026-09-17 from three screenshots Carl sent of MyLMU's embeds.

## The decisions, and who made them

**One message per event, not per achievement.** Those three screenshots are
*one lap and one race*: 2:00.830 posted twice (all-time car record, all-time
class record) and then the session result for the same race, best lap 2:00.829.
Three notifications, one driver, 43 minutes of racing — and one of them
announced an 11th place. A lap that earns two records here is one embed with
two achievement lines.

**A community owns a channel, not a team.** `teams` exists and has invite
codes, but it caps at six (`electron/team-cloud.js:240`) because it models an
endurance lineup. A league Discord is forty people who never share a car. Carl:
*"drop the team and make it community"*. So `communities` is a new object with
the same proven shape — one persistent join code, rotatable, owner can remove
people — and no cap.

**Two subscription axes.** Carl: *"the apex channel should be strictly team
league members only but if someone from outside our org beats a lap time for
example on the leaderboard it should also land in ours"*. Those are two
different questions and only one of them needs a roster:

| axis | answers | needs a roster? |
|---|---|---|
| `members` | whose events go to this channel | yes — that's what a community is |
| `boards` | which records this channel cares about, whoever set them | **no** — it routes on the board |

A stranger with no community and no idea Apex exists takes a record on a board
Apex has laps on, and it fires into Apex's channel. Nothing about them needs to
be known.

**Solo laps only count if they beat a record.** Carl's rule, and nothing
implements it, because nothing needs to: a lap only ever emits an event by
*changing a board leader*. A PB that beats nobody emits nothing whether it was
set in a 24-hour race or alone at midnight. Which is fortunate — the app cannot
currently tell an online session from an offline one, and this way it doesn't
need to until session results arrive, and those are online by construction.

**The webhook URL is a capability, not a setting.** Anyone holding one can post
to that channel forever. It is stored like a secret: RLS on with no policies,
every door `security definer`, and every read path returns it masked. A member
who joined a league's channel must never be able to read its webhook back out
of our API.

## The pieces

| file | what it does |
|---|---|
| `supabase/migrations/0026_discord_communities.sql` | communities + roster, channels, the event/outbox tables, `submit_lap` emitting board events, fan-out, the dispatcher's three doors, prune |
| `supabase/functions/discord-dispatch/index.ts` | woken every minute by pg_cron. Fans out, claims what's due, renders the embed, posts or edits, records the outcome |
| `electron/discord-cloud.js` | the app side. Every RPC, plus the two validators that mirror the SQL, plus the one place the app posts to a webhook itself |
| `electron/control-panel/discord-panel.js` | Settings ▸ Discord. Containers are contracted in the parity test; every row inside them is built per community and per channel |
| `scripts/test-discord.js` | `npm run test:discord` — parity with 0026, and that nothing can ping a server by accident |
| `supabase/migrations/0027_event_results.sql` | official race results: the event + participants tables, the hold, and the fan-out rewritten to route them |
| `src/telemetry/raceosResults.ts` | the RaceOS fetch and the projection — the whitelist that decides what can ever reach a public channel |
| `electron/results-harvest.js` | when to look, the on-disk ledger, and the upload |
| `scripts/test-results.js` | `npm run test:results` — the whitelist, and that a quiet poll costs one request |

## How a record becomes a message

1. `submit_lap` upserts the driver's board row, and — **only** when the lap
   changes the board leader — writes one `notification_events` row. The two
   reads it needs (who led, how many drivers were on the board) happen *before*
   the upsert, because afterwards the answers are gone. The whole emitter is
   wrapped: a fault there raises a warning in the Postgres log and never
   rejects somebody's lap.
2. `fanout_notification_events()` turns each event into at most one
   `notification_outbox` row per channel, applying the two axes plus the
   "our member was the one displaced" case.
3. `claim_notifications()` hands due rows to the dispatcher with
   `for update skip locked`, so two overlapping cron runs can't double-post.
4. The dispatcher posts with `?wait=true`, keeps the message id, and a later
   improvement on the same board by the same driver **edits that message**
   instead of posting again.

## Traps, each of which cost something to find

- **A record on an empty board is not news.** Boards key by track × class ×
  surface (0021) — several hundred of them, every one starting empty, and the
  first lap on an empty board is technically an all-time record. Without
  `min_board_entries` — distinct drivers, counted *before* the incoming lap —
  the week a new track lands is a wall of trophies won against nobody. Three
  while the boards are thin (Carl, 2026-09-17); five is the number it wants at
  scale. Set it too high too early and the feature reads as broken instead.
- **An exact tie is not a record.** `rank = 1` counts times *strictly* faster,
  and a dead heat leaves the earlier lap on top by the motorsport tie-break. The
  emitter requires `lap_ms < leader_ms` as well.
- **`?wait=true` or no edits.** Without it Discord answers 204 with no body, the
  message id is gone, and every improvement becomes a new post.
- **`allowed_mentions: { parse: [] }` on every payload.** A driver display name
  is user-supplied text on its way into someone else's Discord. Without it, a
  driver called `@everyone` is an incident in forty servers at once.
- **A deleted webhook 404s forever.** 404/401/403 are permanent: the row fails
  and the channel pauses itself with the reason on it. Retrying those is how a
  queue fills up. An *edit* that 404s is the message being gone, not the
  webhook — that one retries as a fresh post instead of pausing the channel.
- **The dispatcher POSTs to whatever is stored.** `save_discord_target` refuses
  anything that isn't `https://discord.com/api/webhooks/<id>/<token>` (plus the
  canary/ptb/discordapp spellings). Otherwise a saved "webhook" is a request our
  server makes on a stranger's behalf, to anywhere it can reach.
- **A race result routes on who was IN it, not on a board.** `event_participants`
  is built one row per upload — an account is in it because its own app said so.
  Matching classification names against our account names instead would put a
  stranger's result in a league's channel the first time two drivers shared a
  name.
- **One event is ~230 KB.** The probe measured 2.3 MB for ten. A poll that asks
  for ten events every five minutes is megabytes an hour to learn nothing; the
  harvester asks for one and stops if it recognises it.
- **`create or replace`, not drop-and-recreate.** 0021 had to drop `submit_lap`
  because it was adding an argument, and paid with the PostgREST overload
  problem and a lost ACL. This change adds no argument, so replacing in place
  keeps both the grants and every installed client working.

## Setup

Done on 2026-09-18, a day after the app half shipped — the tables filled for
24 hours with nothing scheduled to drain them (61 events, empty outbox), which
from inside a Discord looks like "it's broken". Step 4 lives in
`0032_discord_dispatch_schedule.sql` because the MCP's SQL tool is read-only
and a migration is its only write path; that file also skips the pre-launch
backlog, since the fan-out has no age cutoff of its own.

1. Apply `0026_discord_communities.sql`, then `0027_event_results.sql`.
2. Set `DISCORD_DISPATCH_KEY` in the function secrets (dashboard ▸ Edge
   Functions ▸ Secrets). Same value as the vault row — the cron sends it, the
   function compares it, and a mismatch is a silent 403 every minute.
3. Deploy: `supabase functions deploy discord-dispatch`.
4. Schedule it, once — same shape as the email dispatcher (0032 does this):

```sql
select vault.create_secret('<the DISCORD_DISPATCH_KEY value>', 'discord_dispatch_key');

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
```

Every minute, unlike the email dispatcher's hour: the coalesce window is four
minutes and a record that lands six minutes late has stopped being news.

`POST ?dry=1` fans out and returns the count without claiming or sending
anything — safe against live data.

## How a race becomes a message

1. The desktop polls — but only when the game is running and something has been
   driven, and it asks for **one** event first (~230 KB). If that event is
   already in the local ledger, nothing has finished since the last look and
   the poll stops there. Only a genuinely new one triggers the wider `take=3`
   fetch.
2. `projectResults()` cuts the payload down to a whitelist of ten fields per
   driver. Nothing downstream ever sees the raw response, which carries team
   rosters, livery URLs and per-driver rating adjustments — and, from the
   neighbouring `api/v1/player`, an account email and a live verification code.
3. `submit_event_results` dedupes on the RaceOS event id. The first upload
   writes the classification and emits the notification; every later one adds
   only its own row to `event_participants`, which is how a community learns
   that one of *its* people was in the race.
4. That notification is **held for ten minutes** (`notification_events.hold_until`).
   At the instant of the first upload the answer to "who of yours was in this"
   is "one — the uploader"; the other eleven apps are minutes behind. Ten
   minutes is forever for a record and nothing for a race that took forty.
5. Fan-out resolves the members-of-this-channel rows per target and folds them
   into the payload, so the embed can say *and yours finished 4th and 11th*
   without the dispatcher knowing what a community is.

## Two things the app side decides on its own

- **The test message is posted by the app, not the dispatcher.** The "Send a
  test message" button fires straight from the driver's machine using the URL
  they have only just typed, before it is ever saved. That is the last moment
  the app legitimately holds the URL in the clear, so the check costs no round
  trip, needs no stored secret, and answers the only question that matters —
  did something appear in the channel — while they are still looking at
  Discord. It goes through Chromium's fetch first for the same reason the voice
  downloads do (undici ignores the system proxy and the Windows certificate
  store).
- **An empty webhook box means "keep the one you have".** The editor cannot
  show the stored URL, because the server will not hand it back. So a blank box
  on an existing channel is sent as `null` and the stored value survives —
  which is what lets an admin retune the filters without having to go and fetch
  the webhook out of Discord again.

## Still owed

- **Confirm the RaceOS field names against a live payload.** `ROW_PATHS` in
  `src/telemetry/raceosResults.ts` is the one thing here that has never met the
  real service: it was written from the *shape* `scripts/probe-raceos-results.js`
  printed (gridPos / position / classPos / bestLapTime / finishTime / Laps /
  finishStatus), not from a saved sample, which is why every field is a LIST of
  candidate names. Run the probe with LMU up and `--out`, then correct them.
  Everything else in that file is shape-independent, and `test:results` holds
  the projection to its whitelist either way.
- **`results-for-users` is still owed** (the probe's own note): the UI derives
  its leaderboard id from one it already holds, so a hand-built id answers
  empty. Not needed for any of the above — `api/v1/results` carries the
  classification — but it is the route to a *board* rather than an event.
- **A daily-cap review.** `daily_cap` (20/day, strangers only, displacements
  exempt) is a guess. Watch the first busy week before trusting it.
- **Weekly boards.** Only all-time leader changes emit today. `board_key`
  carries no window, so adding weekly means deciding whether a weekly P1 is
  news or churn.
- **League races that are not official events.** A private server's race is
  invisible to RaceOS, so it has no result here. Our own telemetry could carry
  one, but then the per-session dedupe has to be built from scratch (twelve
  members, twelve relays, one race) — which is precisely the work RaceOS's
  event id does for free.
