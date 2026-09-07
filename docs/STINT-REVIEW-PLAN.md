# Stint Review — the session reviewer, and the groundwork for training

**Status:** in progress, 2026-09-07. Phases 0 (capture) and 1 (the Review tab)
are built; phases 2-5 are unstarted. Decisions settled with Carl the same day —
see the bottom.
**Goal:** after a session, a driver opens Apex and sees every stint they drove —
lap times, sectors, fuel, wear, limits — clicks a lap, and studies what they
actually did: throttle, brake, speed and delta against distance, and the line
they took drawn on the circuit. Then overlays a second lap on top of the first
and reads the difference corner by corner.

It lives in the control panel **and** on the web pit wall, which costs nothing
extra: `scripts/build-web.js` copies `electron/control-panel/*` verbatim into
`web/dist`, so a component built there is on aio.apexandchillracing.co.uk the
next time Pages deploys.

The end of this road is the training module. Stint review is not a detour from
it — it is its first three phases, and every byte captured here is a byte the
trainer will want.

---

## What we are aiming at (Coach Dave Delta, recon 2026-09-07)

From four screenshots of Delta v6.1.1. Four screens, in the order a driver
meets them:

**Session report** — a modal summarising the session: best lap, *optimal* lap
(the sum of your own best sectors), average lap, average VE per lap, drive time,
plus scored judgements — consistency %, clean driving %, "untapped potential" in
seconds, faster-than-others %, a 30-day trend line.

**Timing** — the stint table. One row per lap: S1/S2/S3, lap time, delta to
your best, air and track temp, fuel litres, VE%. A lap-time sparkline sits above
the table with each lap as a node. A right-hand rail carries the stint's
average / best / optimal, a consistency bar, four tyre temperatures, duration,
fuel used, VE used and V-max. Stints are collapsible; laps colour-code purple
(session best) / green / red.

**Data** — the telemetry view. Stacked channel charts (delta, speed, throttle,
brake) with a scrub cursor that reads both laps' values at that point, beside a
**zoomed track map showing both driven lines** — the reference in green, yours
dashed in yellow, with the cursor's position marked. Along the bottom, per
micro-sector deltas (SQ1…SQ13) as clickable chips.

Delta has a fourth screen, a dual synchronised video replay. **We are not
building it** (Carl, 2026-09-07) — recorded gameplay is a different product with
a different cost model, and the map-plus-channels view is the one that tells a
driver *why* they were slow. Recorded here only so it does not get re-proposed.

The micro-sector chips are the load-bearing idea in all of it. They are how you
get from "I was 0.7 s slower" to "I was 0.18 s slower in SQ3", and they are the
click target that focuses everything else on one corner.

---

## What we already have (codebase map, 2026-09-07)

More than it looks like. The capture side has been running since August.

**`src/telemetry/lapLog.ts`** — a `LapRecord` per lap, already recording: `id`,
lap time, the three sector splits, the clean/dirty verdict with its reason
(`pit` / `limits` / `penalty` / `partial` / `implausible`), `fuelStartL`,
`fuelEndL`, `fuelUsedL`, per-corner tyre wear, `compound`, `stintLap` (1-based,
out-lap is 1), and `trackTempC` / `ambientTempC`. That is most of Delta's
timing table already on disk.

**`src/telemetry/lapTrace.ts`** — a distance-indexed trace for **every** flying
lap, not just personal bests: throttle, brake, steer, gear, speed, lateral and
longitudinal G, TC and ABS, decimated at `MIN_D_STEP` = 0.001 of a lap (~4–7 m,
a sample every 60–100 ms through a braking zone). Written to
`~/.apex-overlay/traces/<day>/<lapId>.json`, and kept forever (see below).

On the build machine today: **658 traces, 30 MB.** A real one — Spa, 2:13.9,
927 points — is 45 KB raw, **12.6 KB gzipped**.

**`src/telemetry/trackMap.ts`** — the learned circuit as `[x, z, y]` points at
10 cm resolution, with `halfWidthM` measured from the sim's own `mTrackEdge`.
**`y` is elevation**, already stored, already used by the overlay. 33 shapes ship
in `data/trackmaps/` (620 KB total) and more are learned per machine.

**`electron/control-panel/team-charts.js`** — DPR-aware canvas painters with no
library (the panel CSP forbids one), including a track-map painter. The house
style for every chart below already exists.

**`supabase/migrations/0004`, `0009`** — the `lap_traces` table and
`submit_lap_trace()` / `get_lap_trace()`. Deliberately **one row per (driver,
track, class)**: the board-best lap only, with a hard rule that the trace must
match the lap currently on the leaderboard, and a 512 KB payload cap.

> That table is **not** the stint store and must not become one. It answers
> "click a leaderboard time and learn from it", and its integrity rule — the
> trace must equal the board lap — is exactly what a stint archive must not
> have. Leave it alone; the stint work is a parallel store.

---

## Built 2026-09-07: the driven line, and tyre temperature

The one thing the trace could not do was say **where the car was**. It recorded
`d`, a lap-distance fraction. Rendered on a track map every lap draws on the
identical centreline, so a tidy apex and a wide one look the same — the "Data"
screen above is impossible from a v1 trace, and no later work can recover it:
either the position was recorded while the lap was driven or it is gone.

So capture shipped first, as it did for the traces themselves:

- `TraceChannels` gains optional `x` / `z` — world metres on the ground plane,
  the same axes and 10 cm rounding a `TrackMapPath` point uses, so a trace and a
  learned map render in one coordinate system with no fitting.
- `CompletedTrace` gains `x[]` / `z[]`, present together or not at all. A lap
  that was only half placed (shared memory answered part way through) carries no
  line rather than half of one. A single dropped field read is bridged by
  carrying the last position forward — tens of milliseconds, a couple of metres,
  and the columns stay index-aligned.
- `TraceFile.v` is now `1 | 2`. Nothing migrates: a v1 lap was never placed on
  the circuit and never can be. A reader draws its channel graphs and leaves the
  map empty.
- `lmuRestProvider` hoists the one whole-field shared-memory sweep above the
  trace recorder, so the radar, the track map and the trace share a single read.

**Elevation is deliberately not recorded per lap.** The `y` of a lap is the
road's, not the driver's — two laps differ there only by suspension travel — so
it comes from the track map at draw time. Storing it per lap would cost a third
of the file to repeat the same numbers every lap. Carl's point about elevation
helping a driver see where a braking point actually is still lands: the map has
it, and the map is what gets drawn.

**Measured cost**, the real Spa trace with a plausible line added:

| | raw | gzipped |
|---|---|---|
| v1 (no line) | 45.0 KB | 12.6 KB |
| v2 (with line) | 56.7 KB | 17.6 KB |

+26% raw, +40% gzipped, for the feature the whole map view depends on.

**And per-corner tyre temperature at the line** — `LapRecord.tempAtLine` (v6),
`[FL, FR, RL, RR]` in °C from `TyreState.tempC`, the inner-liner mean LMU's own
HUD shows, so the stint table quotes what the driver saw in the car. All four
corners or none: a dead sensor reads as a cold tyre otherwise, and a stint
table has no way to tell those apart. It is stored per lap because that is how
a stint gets read backwards — a lap that fell away with the fronts ten degrees
over is a different story from one that fell away with them cold.

---

## Derived, not stored

Everything Delta scores is a function of data we already hold. None of it needs
a column, and computing it client-side means it improves without a migration:

- **Optimal lap** — sum of your own best S1/S2/S3 in the session.
- **Untapped potential** — best lap minus optimal lap.
- **Consistency** — standard deviation of clean laps against the stint median,
  expressed as a percentage the way Delta does.
- **Clean driving %** — clean laps ÷ total, straight off the `dirty` array,
  which also names *why* each dirty lap was dirty. We can be more specific than
  Delta here: "3 laps lost to track limits" rather than a bare percentage.
- **Micro-sectors** — split the lap into N equal-distance segments and
  difference the two traces' `t` at each boundary. N scales with track length
  (decision 3): ~500 m each, clamped 8–20, so a micro-sector is about one corner
  complex at every circuit rather than a third of a lap at Le Mans. Pure
  arithmetic on `d` and `t`, needs nothing stored.
- **Fuel and wear per lap** — already on the record. Fuel-per-lap trending up
  across a stint as the tyres go off is a genuinely useful plot nobody else shows.

**Virtual energy per lap is already recorded** — `veStartPct` / `veEndPct`
landed with the v5 consumption block, fed from `playerCar.veFraction`, with a
flat 0 correctly filtered out as "this class has no energy budget" rather than
stored as an empty tank. Delta's VE column needs no new capture.

The one real gap was **per-corner tyre temperature at the line**, added
2026-09-07 as `LapRecord.tempAtLine` (v6) — see below.

---

## Storage: what goes where, and why not jsonb

The instinct is to put traces in Postgres because the board-best trace already
is. It does not scale to stints, and the reason is shape, not size: a stint's
traces are never queried *inside* — they are fetched whole, by lap, when someone
opens the detail view. In Postgres that payload rides in every backup, every WAL
segment and every careless `select *`, at Postgres prices, to be handed back
verbatim. That is object storage's job.

**Three tiers:**

| Tier | Holds | Where | Rough size |
|---|---|---|---|
| Local | every lap + every trace | `~/.apex-overlay/` | 30 MB per 658 laps |
| Row data | session, stint and lap rows — times, sectors, fuel, wear, temps, verdict | Postgres | ~300 B/lap |
| Traces | the gzipped per-lap columns | **Supabase Storage** | ~18 KB/lap |

Local stays the source of truth and works offline. Postgres holds only what a
list, a sort or a summary needs — which is every screen except "Data". Storage
holds the blobs, fetched one lap at a time on click.

**Proposed schema** (migration 0018, sketch):

```
sessions(id, driver_id, sim, track_id, car, car_class, session_type,
         started_at, ended_at, app_version)
session_laps(session_id, lap_no, stint_no, stint_lap, lap_ms,
             s1_ms, s2_ms, s3_ms, dirty text[], fuel_used_l, fuel_end_l,
             energy_pct, tyre_wear real[4], tyre_temp_c real[4], compound,
             track_temp_c, air_temp_c, trace_path text null)
```

`trace_path` is the Storage object key or null — the one join between the tiers.
Objects live at `traces/{driver_id}/{session_id}/{lap_id}.json.gz`, so an RLS
policy on the path prefix is the whole access story, and deleting a driver
deletes a prefix.

**Cost.** A 40-lap session is ~700 KB of objects and ~12 KB of rows. Two
hundred active drivers doing three sessions a week is ~420 MB/week, ~22 GB/year
before retention — comfortably inside the 100 GB a Pro project includes, and
~£0.02/GB/month past it. **Nothing is pruned** (decision 1) — so this grows
without bound by design, at roughly 22 GB/year at that population. That is
~£5/month of Storage per year of history accumulated, which is the right trade
for never telling a driver their session is gone. Revisit if the population
grows an order of magnitude, not before.

**Upload discipline.** Batch at session end, not per lap — a compressed object
per lap, uploaded in the background, resumable, and never while the car is on
track. This is the same lesson as `lapUpload.js`: the sync must not be able to
cost a driver a lap.

**The web app needs the map too.** The line is drawn against a `TrackMapPath`,
which today lives on the driver's disk. `data/trackmaps/` is 33 shapes and
620 KB — small enough for `build-web.js` to copy wholesale. Maps a driver has
learned that aren't bundled should ride up with the session (a few tens of KB,
once per track), which incidentally grows the bundled set over time.


---

## Built 2026-09-07: phase 1, the Review tab

A new top-level tab, `data-tab="review"`, in the Driving group beside Setups
and Team. Not gated on anything: it reads the lap files this machine has
already got, so it has content on a fresh stable install and works signed out.

**`src/telemetry/stintReview.ts`** — the reading side, pure and testable. It
does one thing the lap log cannot: **infer a session**, because the log is a
flat stream of laps and records the session TYPE but never which *sitting* a lap
belonged to. A session here is a run of consecutive laps agreeing on sim,
track, car, class and type with no idle gap over `SESSION_GAP_MS` (30 min).
That inference is wrong in exactly one direction — a driver who parks for over
half an hour gets two cards instead of one — which is the safe way round.
Stints need far less inference: `stintLap`, `isOutLap` and `isInLap` are already
on the record, and only pre-v5 laps fall back to an idle gap.

Everything the report shows is derived at read time, per "derived, not stored"
above: optimal lap, untapped potential, consistency, clean %, fuel and energy
per lap, tyre temperature averaged over the stint, wear as the stint left it,
the 30-day trend, and the personal best to compare the session against.

**Consistency has a defined scale.** It is the coefficient of variation of the
clean laps, mapped logarithmically from `CV_GOOD` (0.15%, scores 100) to
`CV_BAD` (2%, scores 0) — logarithmic because lap-time spread is: 0.15% vs 0.3%
is professional vs quick amateur, while 1.5% vs 1.65% is no difference at all.
The percentage is only ever the fill of a bar. **Every screen leads with
`spreadMs`** — "±0.31 s" — because a driver can act on a spread in seconds and
cannot act on "84%".

**What is deliberately not Delta's:**

- The session report is the top of the page, not a modal. It is the thing the
  tab is for.
- A dirty lap says WHY, from the log's own `dirty` array: "2 laps lost to track
  limits", not a bare clean-driving percentage.
- Air and track temperature are the RANGE the stint ran through, on the stint's
  rail, rather than a column repeating the same two numbers down forty rows.
  The movement is the information.
- Tyre-corner colour reads each corner against **the car's own mean**, not an
  absolute window. The right operating range depends on compound, class and
  weather, none of which are ours to assume; an axle running ten degrees over
  the other one is an imbalance in any of them.

**Files:** `src/telemetry/stintReview.ts`, `electron/control-panel/review-panel.{js,css}`,
`electron/control-panel/review-charts.js` (the two canvas painters, split off
the way `team-charts.js` is), the `review:sessions` / `review:session` IPC pair,
and the tab's markup and router hook. Tests: `npm run test:stintreview` (the
grouping and the derived numbers) and `npm run test:reviewcharts` (the lap
chart's scale clamping and hit map, driven against a recording 2D context).
`scripts/make-shot-harness.js` grows a Review fixture built by running the
compiled module over a synthetic lap log, so `?tab=review` renders the real
shape rather than hand-written JSON.

**Not yet done in this phase:** nothing goes to the cloud and nothing appears on
the web pit wall — the browser bridge has no `reviewSessions`, and there is no
row data up there to serve. That is phase 4.

---

## Phasing

**Phase 0 — capture. Done 2026-09-07.** The driven line on the trace (v2) and
per-corner tyre temperature on the `LapRecord` (v6, `tempAtLine`). Virtual
energy needed nothing — it was already there. Ship in the next beta so the data
starts accumulating while the UI is built, and raise the local trace-retention
window in the same release (see "Consequence of keep everything" below).

**Phase 1 — Sessions list and stint table, local only. Done 2026-09-07.** See
the section below.

**Phase 2 — Lap detail, one lap.** Channel charts against distance in
`team-charts.js` style, sector boundaries marked, the driven line on the track
map with elevation shading, a scrub cursor tying the two together.

**Phase 3 — Lap comparison.** Two laps overlaid, the delta trace between them,
micro-sector chips, and click-a-chip-to-zoom on both the charts and the map.
This is the expensive phase and the one drivers will actually use daily.

**Phase 4 — Cloud + web.** Migration 0018, Storage upload, and the same
components running on the pit wall. The reference lap stays **your own**
(decision 2); what the cloud buys at this phase is durability and reading your
own history from any machine or the web.

**Phase 5 — Training.** Reference laps, target braking points, and coaching
against a faster driver's line. Out of scope here; every phase above is a
deposit on it.

---

## Decisions (Carl, 2026-09-07)

1. **Retention: keep everything.** No rolling window, no session type pruned,
   no starring. Every session a driver ever drove stays available.
2. **Compare against your own laps only**, for now. Broadening to teammates or
   the leaderboard is a later decision; the schema below does not preclude it
   (traces are per-driver objects, so widening is an RLS policy change, not a
   migration).
3. **Micro-sector count scales with track length.** ~500 m per micro-sector,
   clamped to a sane 8-20, so Silverstone National gets ~6-8 and Le Mans ~20
   rather than both getting Delta's fixed 13.
4. **Its own top-level tab** in the control panel — the first new one since
   Team, and therefore the first one the web build picks up for free.
5. **No video.** Dropped outright, see above.

---

## Done 2026-09-07: the local prune is gone

`TRACE_KEEP_DAYS = 60` used to delete trace day-folders after two months. That
was written when the only trace worth keeping was the driver's board best and
the cloud held that one. Under "keep everything" it was the only thing on the
system destroying history, with no cloud archive to restore from until Phase 4.

`pruneTraces()` and `TRACE_KEEP_DAYS` are **removed** — not lengthened, removed,
so there is no window to get wrong later — along with the once-per-run call in
`lmuRestProvider.start()`. A test asserts the module exports no pruner, so
nobody reintroduces one by reflex.

The cost is small enough not to argue about: ~18 KB a lap, so a driver doing
2 000 laps a year accumulates ~35 MB. If this ever needs a limit it should be a
size budget the driver can see and set, not a silent age cutoff.

**Traces written before ~July 2026 are already gone** on machines that have been
running the app — nothing can bring those back. Everything from here is kept.
