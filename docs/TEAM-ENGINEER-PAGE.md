# Team Engineer Page — relaying the driving teammate's telemetry to the pit wall

**Status:** exploration, 2026-08-24. Nothing here is built yet.
**Goal:** a "Team" page in the control panel where, during a team endurance
event, anyone on the team — engineer, resting driver, race control PC — sees the
full telemetry of the car *as the person currently driving it sees it*: fuel and
virtual energy, tyre wear and temperatures, damage, weather, position on the
track map. The Fuel planner (currently the beta Fuel tab) would move into this
page and gain live inputs.

This document records what we learned from studying SimEndurance (the
competitor that already does this), what we already have in the codebase, and a
recommended build path.

---

## Why this sidesteps the spectator-telemetry wall

We proved live (see `spectator-focused-car-telemetry` findings) that LMU
publishes gear/rpm/pedals/dents for **remote** cars, but **not tyres, temps or
fuel**. Those exist only in shared memory on the PC of the person actually
driving. No amount of local probing on the engineer's machine can recover them.

The escape is the same one SimEndurance found: **don't read the car from the
outside — have the driver's own app publish what it already knows.** Every
teammate runs Apex; whoever is in the car has the full `TelemetryFrame`
locally; their app relays it; everyone else's app receives it. The sim never
has to publish anything it doesn't already.

This is the identical precondition `TEAM-LIMITS-SYNC.md` already establishes
for track-limit points: *every driver in the rotation must be running Apex and
signed in.* The two features stand on the same foundation and should share it.

---

## What SimEndurance actually is (recon, 2026-08-24)

Studied from their website (simendurance.com/simbridge) and the installed app
at `C:\Users\carla\AppData\Local\SimEndurance` (v0.1.1, "early desktop
release"). Findings, so we design with open eyes:

**Product shape.** A Tauri desktop app (`app.exe`, Rust + WebView2) plus a
separate Node.js single-executable bridge (`SimEnduranceBridge.exe`). The
desktop app replaced their earlier website-first "SimBridge" workflow.
Accounts are Supabase (email/password), same as ours.

**Telemetry source.** The Iron Wolf's `rFactor2SharedMemoryMapPlugin64.dll` —
**the exact plugin we already ship and auto-install** (`src/server/pluginInstaller.ts`).
They make the user download and install it by hand, with a README. Their bridge
doesn't even open shared memory itself: a feeder pushes the rF2 V01 structs as
JSON over local UDP (default port 5000) into the bridge, throttled to 5 Hz
scoring / 10 Hz telemetry.

**The relay.** The bridge connects out to a "live server" over WebSocket
(`LIVE_WS_URL`; the production host is injected at runtime, not baked in).
Auth is a short **pair code** — not the account JWT — answered with a
`sessionId`/`sourceId`. Data flows as batched, sequence-numbered event frames:
`session.update`, `lap.completed`, `pit.in`, flag events.

**Active-driver selection** — their one genuinely clever idea, and it's small:
every team member's app is a *source*; the relay follows **whichever source is
sending fresh tyre data**. Tyre data only exists on the driving PC, so
freshness of that one field *is* the "who's in the car" signal. No manual
handover, no configuration. During a swap the followed source flips
automatically.

**What their engineer screen shows** (from the marketing screenshots): global
standings with VE/best/last/sectors per car, a circular track map with all
cars + pit-exit traffic prediction ("pit exit after −51s", "traffic risk: 2
cars within ±3s"), pit/stint/VE panel (VE now, VE/lap, laps on VE, VE to
finish, target laps), per-corner tyre life + carcass/inner temps + brake
temps, car telemetry (speed/rpm/gear/water/oil/pit status/limiter), weather
panel with full remaining-race forecast timeline, and a full-race position
history graph with stint/pit-stop tooltips.

**Where we're ahead of them:**
- Plugin install: ours is automatic; theirs is a manual DLL copy + JSON edit.
- Ingest: we read shared memory in-process at 30 Hz *and* poll the richer REST
  API (standings, weather forecast, pit menu, teams roster) — their bridge only
  gets the V01 structs over UDP.
- Team identity: LMU's own `/rest/multiplayer/teams` roster + `mPlayerName`
  give us the real crew and car number (`learnOurTeam()`); they rely on
  account pairing only.
- We already have a tested, band-bucketed engineer summary designed for
  exactly this kind of transmission.
- We already do pit-loss measurement and pit-exit traffic prediction locally
  (`src/telemetry/pitExit.ts`) — their headline map feature.

**Where they're ahead:** it exists and it's shipped. Also the position-history
graph and the weather-timeline modal are genuinely good engineer-screen UI we
don't have anywhere yet.

---

## What we already have (codebase map, 2026-08-24)

The exploration found the feature is mostly assembly, not invention:

| need | already exists | where |
|---|---|---|
| Full local telemetry when driving | `TelemetryFrame` @ 30 Hz over local `/ws` | `src/server/index.ts`, `wsServer.ts` |
| Rich REST data (standings, weather forecast, teams) | `LmuRestProvider` | `src/telemetry/lmuRestProvider.ts` |
| Who is our team / our car / is a mate driving | `learnOurTeam()`, `trackTeamStint()`, `findOurCar()`, `teammateDriving` | `lmuRestProvider.ts:1095–1224` |
| Who is at *this* PC (survives a swap) | `mPlayerName` from Scoring header | `lmuScoring.ts:395–420` |
| A compact "everything an engineer needs" payload | `EngineerSummary` (~200 tokens, pure, tested) | `src/telemetry/engineerSummary.ts` |
| Cloud auth + RPC + edge-function plumbing (main process) | `authService.rpc()` / `functionsInvoke()` | `electron/auth.js:498/515` |
| Background upload pattern (cache, idempotent RPC, offline-safe) | lap upload, usage reporter | `electron/lapUpload.js`, `usageReporter.js` |
| A second WS endpoint sharing the local HTTP server | `/chat` precedent | `src/server/chatWsServer.ts`, upgrade router `index.ts:816` |
| Panel tab pattern + beta gating | Fuel tab, `applyFuelTabVisibility()` | `control-panel.js:4526`, engineer-panel.js as template |
| Fuel/stint strategy math | `fuel-strategy.js` (planner), `fuelCalculator.ts` (live) | `electron/control-panel/`, `src/telemetry/` |
| Cross-machine clock + session identity rules | already worked out | `docs/TEAM-LIMITS-SYNC.md` |

What does **not** exist:
- Any team tables in Supabase (migrations 0001–0014 contain zero occurrences
  of "team").
- Supabase Realtime — nowhere in the codebase. Would be net-new, and must live
  in the **main process** (renderer CSP is `default-src 'none'`; it can never
  hold a token anyway, per the architecture rule).
- Any UI for standings-around-the-car, position history, or a weather timeline
  in a *panel* context (the overlay widgets exist but are built for the
  in-game layer).

---

## Proposed architecture

### Identity: real teams, not self-asserted session keys

`TEAM-LIMITS-SYNC.md` warns that RLS on a self-asserted `session_key` is not a
real access control — acceptable for cut points, not for a live telemetry feed
of your car during a competitive race. The engineer page justifies doing
identity properly:

- `teams` (id, name, owner) and `team_members` (team_id, user_id, role) tables,
  invite-code joining, RLS scoped to membership. This is durable value: the
  same tables serve team-limits sync, setup sharing within a team, and any
  future league features.
- A *race session* within a team is keyed
  `team_id | track | sessionType | server session start time` — the start time
  disambiguates two races on the same server in one evening (established in
  TEAM-LIMITS-SYNC).
- The LMU-side identity (`teamCarNumber` + `teamDriverNames` from
  `learnOurTeam()`) tells each app which car is ours *inside the sim*; the
  Supabase team tells the relay who may read the feed. They meet at the session
  row.

### Active-source selection: steal the freshness trick

Adopt SimEndurance's rule, with our richer signals: every member's app
publishes; the *active* source is the one whose payload carries **live local-car
data** — `connected: true`, `inRealtime` (Scoring byte 127), and fresh tyre
wear. Watchers follow the active source automatically. During a driver swap the
old driver's payload goes stale/spectator within seconds and the new driver's
becomes live; no button anywhere. Tie-break (two people claiming to be live,
e.g. a test session): most recent `currentEventTime` wins.

### Clock: `currentEventTime`, never wall clock

All ordering across machines uses `/rest/watch/sessionInfo → currentEventTime`
(the server's session-elapsed clock, identical on every client) — the
TEAM-LIMITS finding. `Date.now()` only ever decides *staleness* of a source,
never ordering of events.

### Payload: the engineer summary, enriched — not the 30 Hz frame

Relaying `TelemetryFrame` at 30 Hz is wrong on every axis (bandwidth, quota,
privacy, and the receiver doesn't need it — an engineer screen is a 1 Hz
instrument). Instead, a `TeamRelayPayload` built in the main process from the
local feed:

- **Car state @ ~1 Hz:** `EngineerSummary` as-is (fuel/VE, tyre bands, damage,
  pit-loss, trends…) **plus** the precise numbers the summary deliberately
  bands away for the cloud engineer: per-corner tyre wear/temps/pressures,
  exact fuel litres, `FuelState` whole, `PitState`, `HybridState`. The summary
  stays bands-only when it goes to the *LLM*; teammates get numbers.
- **Map + standings digest @ ~0.5 Hz:** per car `slotId, position,
  classPosition, carNumber, carClass, lapFraction, inPit, pitStops, last/best,
  gaps` — enough to drive the track map and standings table on the engineer's
  machine. ~5–10 KB for a 35-car grid.
- **Weather + forecast @ change-only** (the forecast array only moves when LMU
  updates a node).
- **Events, append-only:** lap completed, pit in/out, stint start/end, flag
  changes — these become the position-history graph and stint log, and they're
  what must never be lost (latest-wins is fine for everything above; events
  need the sequence-number treatment SimEndurance uses).

### Transport: two candidate shapes, phased

**Shape A — RPC upsert + poll (zero new infrastructure).**
Driving app upserts the payload via `authService.rpc('team_relay_publish', …)`
every 2–5 s; watchers poll a read RPC every 2–5 s. Exactly the `lapUpload.js`
pattern. Worst-case staleness ~5–10 s. Survives offline/sign-out trivially;
nothing new to operate. This is *enough for fuel, tyres, stint planning,
weather* — everything strategic. It is too slow only for the "watch the car
move around the map" experience.

**Shape B — Supabase Realtime broadcast channel (sub-second).**
Main process joins a channel per team session; the active source broadcasts,
watchers receive. Net-new: either `@supabase/supabase-js` in the main process
or hand-rolling the Phoenix protocol over the existing `ws` dependency.
Concerns from TEAM-LIMITS still apply (a socket held alive for a six-hour
race; reconnect/backoff discipline), and Realtime broadcast is fire-and-forget
— the event log still wants the RPC path for durability.

**Recommendation: start with Shape A, design the payload so Shape B can be
slotted under it later.** The page's value is strategy, not animation; a 3 s
cadence map is still a perfectly good map (SimEndurance itself runs scoring at
5 Hz *locally* and batches uploads). If live testing says the map matters at
higher rate, add the broadcast channel for the digest only and keep RPC for
car state + events.

### Receive side: feed it in as a provider, not a parallel universe

The cleanest landing for received relay data is a **third telemetry source**
next to `lmu`/`rf2`/`simulator`: a `TeamRelayProvider` that synthesizes frames
from the relayed payload. Then the *entire existing render stack* — panel
widgets, potentially even overlay widgets on the race-control PC — consumes the
teammate's car through the same `TelemetryFrame` shape it already understands,
with `source: 'relay'` and honest `connected` semantics. The engineer page then
has a source toggle exactly like SimEndurance's: **My car / Team**.

(Not literal at first — Phase 2 can render the payload directly in the panel;
the provider shape is the end-state that makes overlays work on a pit-wall PC.)

---

## The page itself

New beta-gated tab `data-tab="team"` following the Fuel/Engineer tab pattern
exactly (`team-panel.js` + `team-panel.css`, `shown()`/`hidden()` lifecycle,
`applyTeamTabVisibility()` mirroring the fuel one, `test-panel-parity.js`
kept green). Content, roughly in build order:

1. **Team + session header** — team name, car number, crew list with
   who's-in-the-car highlighted, active-source indicator, session + time
   remaining.
2. **Car strip** — fuel/VE block (current, per-lap, laps left, to-finish
   delta), per-corner tyres (wear %, temps, pressures), damage, last/best/avg
   laps, pit state. All from the relay payload; all identical to what the
   driving app shows its own driver.
3. **Fuel strategy, dynamic (Carl, 2026-08-24)** — the existing beta Fuel tab
   moves in here and becomes a *live* strategy tool, equally usable in a
   single-player race (fed from local telemetry) and a team race (fed from the
   relay). `fuel-strategy.js` stays the engine, but instead of hand-typed
   inputs it continuously re-plans from what the car is **actually** doing:
   real consumption trend (`fuelPerLapAvg` / `energyPerLapPct` and the
   last-lap figures), real laps/time remaining, real tank level. Output is a
   living plan: stints left, litres/VE% per stop, and **save targets** — the
   per-lap consumption the driver must hit to make the current plan work,
   updating as the race evolves (a safety-car lap or a fuel-save phase changes
   the plan within a lap or two). Manual override stays for what-if planning.
4. **Standings + track map** — reuse the overlay leaderboard/trackmap logic in
   panel form, driven by the standings digest.
5. **Stint log & position history** — built from the append-only event stream;
   this is the SimEndurance position-history graph, and it's also the stint
   coverage record TEAM-LIMITS needs.
6. **Weather timeline** — the forecast array is already in the frame
   (`WeatherState.forecast`); nobody renders it as a timeline yet.

---

## Phasing

**Phase 1 — the page, local-only (no cloud, ~3–4 days).**
Build the Team tab rendering *our own* live telemetry as an engineer screen:
car strip, live-input fuel planner, weather timeline. This ships value to solo
drivers immediately (an "engineer view" of your own race on a second monitor),
builds all the UI against data we already have, and none of it needs a second
machine to test. Beta channel.

**Phase 2 — teams + relay publish/read (Shape A, ~4–5 days).**
Supabase: `teams`, `team_members`, invite codes, session rows,
`team_relay_publish`/`team_relay_read` RPCs, event append. App: publisher in
main (active-source rule), Team page gains the My car / Team toggle and the
crew header. The long pole is live multi-machine verification, same as
TEAM-LIMITS says — needs two signed-in machines in one session (Carl + one
tester, or Carl driving + a laptop spectating).

**Phase 3 — history + polish.**
Position-history graph and stint log from the event stream, standings digest +
panel track map, pit-exit prediction surfaced for the *engineer* (we already
compute it), staleness/handover UX hardening (the dangerous failure is a
confident-looking stale screen — the page must wear its data age visibly).

**Phase 4 — convergence.**
`TeamRelayProvider` as a real source (overlays on a pit-wall PC), TEAM-LIMITS
sync riding the same team/session identity, possibly opponent-VE from the
digest feeding `veCarsAhead*` on the watcher side.

---

## Decisions (Carl, 2026-08-24)

1. **Team model: persistent teams with easy add/remove.** Line-ups vary
   slightly between endurance events, so the roster must be editable in
   seconds — invite code to add, one click to remove. The `teams` /
   `team_members` tables stand; membership is just expected to churn, so the
   UI must make add/remove first-class (not buried in settings), and RLS/
   session logic must tolerate a member joining mid-event.
2. **Cadence: ~3 s is fine.** Shape A (RPC upsert + poll) confirmed as the
   transport; trim later only if testers ask. Realtime (Shape B) stays a
   documented option, not planned work.
3. **Entitlement: every team member needs their own subscription.** Deliberate
   — each seat gets the full app, which is the selling point. No special
   watcher tier; league vouchers remain the free path for league deals.
4. **Fuel tab becomes the dynamic fuel strategy tool inside the Team section**
   (see item 3 under "The page itself") — live re-planning from actual
   consumption and race remaining, with save targets, usable solo and in team
   races. The standalone beta Fuel tab retires when this lands (name it
   explicitly in the release notes per the promotion rule).

## Water / oil temperature — blocked on a live probe

The SimEndurance car-telemetry panel shows engine water and oil °C. Ours
doesn't yet, deliberately: `mEngineWaterTemp` / `mEngineOilTemp` have **no
verified offsets** in this codebase — LMU shortens the ISI structs, so the
rF2 reference offsets cannot be trusted, and the damage-widget rule applies:
never guess struct offsets. Next time LMU is running, probe them the same way
as the wheel anchors (they sit in the main telemetry record near the RPM
fields; verify against the in-game display at idle vs running temperature),
then add two tiles to the Team tab's Car telemetry card and two fields to
`LocalCarPhysics` + `team-snapshot.js`. Everything else on their panel is
already live.

## CPU cost (asked 2026-08-24)

Short answer: **not measurable against what the app already does.** The design
adds no new high-frequency work anywhere — the expensive things (30 Hz frame
building, 150 ms REST polling, shared-memory reads) already run today and are
untouched.

Per machine, what's actually new:

- **Driving PC (the one that matters for FPS):** once every ~3 s, in the
  Electron server process — build `EngineerSummary` (pure function over the
  current frame, well under 1 ms), build the ~5–10 KB standings digest,
  `JSON.stringify`, one HTTPS POST (async I/O, keep-alive). Order of 1 ms of
  CPU every 3 s ≈ ~0.03% of one core. For scale: the existing REST provider
  parses a larger standings JSON every 150 ms — the publisher is ~1/20th of
  work the app already does continuously. Network: a few KB/s up. The game
  process is not touched at all.
- **Watcher PC:** one RPC poll every ~3 s plus panel rendering — and it isn't
  running the sim, so headroom is huge anyway.
- **Phase 1 (local-only)** adds only panel rendering of data already produced.

The one real perf rule is on the render side: the Team page updates at 3 s
cadence by mutating text nodes/attributes in place (the existing panel style),
never rebuilding the DOM per update — a full rebuild every 3 s would still be
cheap, but a 6-hour race in a `backgroundThrottling:false` window deserves the
tidy version. If we ever want proof, wrap the publisher in the usual headless
test script and time 10k cycles.

## Phase 2 — BUILT 2026-08-25 (v0.91.0-beta.8)

Server: migration `team_engineer_phase2` (+ `team_caps_search_path`) on the
live project — `teams` / `team_members` / `team_relay`, all writes through
SECURITY DEFINER RPCs, member-read RLS via `is_team_member()`, every user FK
`ON DELETE CASCADE` so delete-account keeps its promise untouched. Verified
end-to-end in SQL (create → join → publish → read → leave) before any app
code.

Decisions locked with Carl 2026-08-25:

- **Team size cap: 6** (`team_caps()`; also caps owned teams at 8 and
  memberships at 16). Everything stays beta-gated for now.
- **One persistent invite code per team**, Discord-invite style:
  `APX-` + six characters from an unambiguous alphabet. Any member may share
  it (the Share invite button copies a ready-made Discord message with the
  download link); only the owner may rotate it. This one mechanism covers
  both joining cases: an existing Apex user pastes the code into the Team
  tab; a new user installs, registers, subscribes (every seat is a full
  subscription — decision #3 above), then pastes the same code.
- **Owner leaving hands the team to the earliest-joined member**; the last
  member out deletes the team. No separate transfer UI needed.
- **Relay is one row per (team, publisher)** — everyone MAY publish, nobody
  fights over a row. The client publishes only when it is genuinely the
  driving PC (live frame + on-track + local tyre data — the SimEndurance
  rule); the reader follows the freshest row WITH tyre data, else the
  freshest row. Payload = the same `buildTeamSnapshot` the local tab renders
  (with tyrePlan attached); the learned map shape and the race history ride
  in their own columns, sent/returned only when their revision moved
  (history at most every 60 s, thinned under 240 KB for Le Mans-sized
  fields).

App: `electron/team-cloud.js` (roster RPCs, 3 s publisher gated by
`eligibleToPublish`, 3 s reader while the tab watches Team view; pure
helpers tested in `scripts/test-teamcloud.js`), IPC surface `team:*` in
main + preload, `teamActiveId` persisted in settings. Panel: crew card
(create/join/roster/kick/rotate/leave, publish status, driving/online dots)
above the empty/live split, My car / Team seg in the view head, and every
renderer reads through `viewSnap()/viewHistory()/viewShape()` so all four
screens work identically on relayed data. Age pill in Team view reads
`RELAY · <name>` and goes STALE past 12 s.

Still open for Phase 2 live verification (needs two signed-in machines in
one session): publisher eligibility against a real driver swap, relay
staleness across a six-hour race, and whether 3 s cadence feels right on the
watcher's map.
