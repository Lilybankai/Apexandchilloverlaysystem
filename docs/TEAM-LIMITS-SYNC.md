# Team Track-Limit Points — sharing the car's total between teammates

**Status:** proposal, 2026-08-22. Nothing here is built yet.
**Goal:** in a driver-swap event, the Track Limits panel counts down the **car's**
remaining allowance, not just the points charged during the stints driven at
this PC.

---

## Why this needs the cloud at all

Everything else about the panel was fixed locally (shipped in the same change as
this proposal): the penalty **count** comes from the car's own scoring record, so
it already survives a handover and keeps running while a teammate drives.

The **points** cannot follow, and it is worth being precise about why, because
the reason forecloses every cheaper option. LMU writes its track-limits rulings
to the *local* trace log, and only while the driver at this PC is in the car.
Established from a live race, not assumed:

| | game clock |
|---|---|
| `DriverSwap: Getting in vehicle` | 8394.95 s |
| first `score.cpp 626` charge line | 8727.12 s |
| last `score.cpp 626` charge line | 15145.20 s |
| `DriverSwap: Getting out of vehicle` | 15372.12 s |

All 56 charge lines fell inside the stint. **None fell outside it.** A teammate's
cuts are not merely absent from this machine — they are unobservable from it. No
REST endpoint carries a running total either (`/rest/sessions` publishes the
*allowance*, `SESSSET_cuts_allowed`, and the standings row publishes the penalty
*count*; neither publishes points), and the results XML is written only when the
session ends.

So the only machine that can see a stint's charges is the machine that drove it.
Making the total whole means those machines telling each other. **Every driver in
the rotation must be running Apex and signed in** — that is the hard precondition,
and it is why the honesty work below is half the job rather than a trimming.

---

## The precondition is also the main design problem

A partial total is a *worse* failure than no total. Today the panel says
`MY STINT` and shows points spent — a number the driver knows is theirs. If the
cloud total silently covers two drivers out of three, the panel goes back to
counting down an allowance, and the countdown is wrong in the dangerous
direction: it promises room the car does not have.

So the system must know the difference between **"every stint is accounted for"**
and **"some stints are"**, and only the first may show a countdown.

Roster size cannot answer that: an endurance entry routinely lists six drivers
and runs three. The test has to be about stints actually driven, and happily
every app can observe those without any cooperation — our car's standings row
carries the current `driverName`, and it is visible while spectating. So each app
can independently record "driver X was in our car from t1 to t2".

Coverage is then: **every observed stint has a driver who published a report.**
A driver with no cuts publishes a zero, which is what makes "clean stint" and
"not running the app" distinguishable at all.

---

## Design A — one row per driver, upserted (recommended)

Each app keeps publishing a single small fact about itself: *how many points I
have been charged on this car in this session since the last discharge.* The
total is the sum across drivers.

```
team_limit_reports
  session_key   text        -- teamId | track | sessionType
  team_id       text        -- the GUID from /rest/multiplayer/teams
  driver_name   text        -- as the standings spell it
  user_id       uuid        -- auth.uid(), the RLS anchor
  points        numeric     -- my charged points since the last discharge
  charged       int         -- how many incidents that was
  covers_from   numeric     -- server session time my coverage starts
  covers_to     numeric     -- ...and the last moment I was reporting
  updated_at    timestamptz
  primary key (session_key, user_id)
```

```
team_limit_stints           -- who drove, observed by everyone independently
  session_key text, driver_name text, first_seen numeric, last_seen numeric
  primary key (session_key, driver_name)
```

- **Writes:** an upsert every ~5 s while in the session, and immediately on a
  charge. Tiny — a handful of rows per session.
- **Reads:** poll the two tables every ~10 s. Realtime would work but buys
  nothing at this cadence and adds a socket to keep alive for six hours.
- **Total:** `sum(points)` over reports whose driver appears in the stint list.
- **Coverage:** `stints ⊆ reports` → countdown; otherwise → today's `MY STINT`
  presentation, plus "2 of 3 stints reporting".

### Discharges are the subtle part

A track-limits drive-through zeroes the **car's** account, so every teammate's
contribution must zero with it — including the stale rows of drivers who are no
longer at the wheel and may have closed the app.

Handle it with a session-scoped high-water mark rather than by mutating other
people's rows:

```
team_limit_discharges (session_key, at_event_time numeric, user_id, created_at)
```

The app that sees the penalty writes one row. Every app then ignores any report
whose `covers_to` predates the newest discharge, and each app zeroes its own
`points` when it sees one. Two properties make this safe: only the driving app
can observe the discharge reason (its own trace names it `Track Limits`), and
every app can corroborate it, because the car's penalty count rises for all of
them.

### Ordering across machines — use the server's clock, not the sim's

`atGameSec` from the trace is **seconds since that PC's game launched**. It is
not comparable between teammates and must never be used to order events. The
comparable clock is `/rest/watch/sessionInfo` → `currentEventTime`, the server's
own session elapsed time, which every client sees identically. All the time
fields above (`covers_from`, `covers_to`, `at_event_time`) are in that clock.

---

## Design B — a full event log

Same tables, but one row per incident (`points`, `lap`, `at_event_time`, a
per-app monotonic `seq` with `unique(session_key, user_id, seq)` for idempotent
retries). The total becomes "sum of charges after the latest discharge".

**More work, and the extra buys one thing:** the CUTS strip could show the car's
last few charges with whose they were, and a post-race review could attribute the
drive-through. If that is wanted, build B; otherwise A answers the actual
question — how much room is left — with materially less machinery.

---

## Work breakdown

| | |
|---|---|
| Supabase migration: 3 tables + RLS + an aggregate RPC | 0.5 d |
| `src/telemetry/teamLimits.ts` — session key, upsert loop, poll, coverage, discharge high-water mark | 1 d |
| `lmuTraceLimits` — surface discharges as events (charges already counted) | 0.25 d |
| Provider wiring + `TrackLimitsState.teamPoints` / `coverage` | 0.5 d |
| Widget — team countdown, "n of m stints reporting", offline fallback | 0.5 d |
| Tests (all pure: coverage, discharge ordering, stale-row exclusion) | 0.5 d |
| **Build total** | **~3 days** |
| Live verification in a real team race with 2+ signed-in testers | the long pole |

That last row is not padding. Every failure mode here is a *multi-machine timing*
failure — a discharge racing an upsert, a driver closing the app mid-stint, a red
flag restarting the session — and none of them reproduce solo. Budget a league
race for it, and ship it behind the beta channel first.

---

## Risks

- **The precondition.** If a teammate doesn't run Apex, the feature does nothing
  except correctly say so. Worth confirming the crew will before building.
- **Session key stability.** A red flag or a session restart must start a new
  key, or last session's points leak into this one. `teamId | track |
  sessionType` does not distinguish two races on the same server on the same
  night; add the server's session start time from `sessionInfo`.
- **RLS is weak by nature here.** Membership in a `session_key` is self-asserted
  — nothing the client can prove. The data is track-limit points, so the blast
  radius of a bad actor is nil, but don't reuse this pattern for anything that
  matters.
- **Offline must be invisible.** Any failure — no network, signed out, no
  subscription — has to fall back to today's `MY STINT` panel without a stall or
  an error state. The panel is read at 200 kph.

---

## The cheaper thing already shipped

Worth stating plainly so this is a real choice, not a foregone one. The penalty
**count** is already the car's and already correct through handovers, and the
count is what actually costs a lap. The countdown is the refinement; the alarm
already works. If the crew won't all run the app, this proposal buys nothing —
and if they will, it buys an accurate number for the one question the panel
exists to answer.
