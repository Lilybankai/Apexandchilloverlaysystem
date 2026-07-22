# Changelog

## Unreleased

### Removed

- **The Chassis widget.** It rendered, but a wireframe car with load columns
  turned out not to earn its screen space next to the data a driver actually
  acts on. Removed from the catalog, both overlay pages, the shell registry,
  the in-game defaults and the stylesheet — `overlay/js/widgets/chassis.js` is
  deleted with them.

  **The telemetry it fed is kept**: `src/telemetry/chassis.ts`, the load and
  suspension channels on both providers, the `chassis` block on `PlayerState`
  and all 29 tests. Those are provider-level, verified, and the natural input
  to a damage or suspension readout later. Restoring the widget itself is
  `git checkout v0.9.1 -- overlay/js/widgets/chassis.js` plus the six
  registration points listed in the 0.9.1 notes.

## 0.9.1 — 2026-07-22

Fixes 0.9.0, in which the Chassis widget shipped complete and could not be
seen. The widget itself was fine; it was never registered in the three places
that decide where a widget goes and whether it is offered at all.

### Fixed

- **Chassis is now in the control panel's overlay catalog.** `OVERLAY_CATALOG`
  in `electron/main.js` is the list the panel renders, the source of the
  per-widget OBS URL, and what `defaultSettings()` walks to enable a widget on
  a fresh install. Chassis was absent from it, so the installed app offered no
  way to switch it on and no URL to add to OBS. Existing installs pick it up
  enabled, because `loadSettings()` starts from the defaults and only overrides
  keys the stored file actually contains.
- **Chassis now has a position on the combined overlay page.** Every `.widget`
  is `position: absolute`, and a widget with no rule in the layout block does
  not fall back to a sensible corner — it lands at its static position, behind
  whatever is already drawn there. It now mirrors Motion on the left edge.
- **Chassis now has an in-game default position.** Without an entry in
  `defaultsFor()` it fell through to the `{24, 24}` fallback and spawned on top
  of standings — the same failure Pace Delta hit in 0.6.6. It opens bottom-left,
  right of the vertical inputs readout, which clears its ~400px height.

### Added

- **The running version in the control panel's top bar**, under the wordmark,
  from `app.getVersion()` so it is the packaged build's own number and cannot
  drift from it. A bug report can now say which version it came from.

## 0.9.0 — 2026-07-22 "Corners"

One new overlay, and the second batch of **telemetry channels** recovered from a
struct we were already reading: the per-wheel load and suspension block was
sitting in every wheel record, being skipped past to get to the tyre temps.

### Added

- **Chassis**, a new widget: a wireframe GT3 drawn from the mid-point between
  directly behind and directly above, pivoting about a point inside the body at
  mid-wheelbase, with per-corner load columns, overload and wheel-lift flags,
  and a four-corner suspension readout. Three independently switchable modes
  (`?car` / `?susp` / `?dist`), as the Motion widget established.

  The **body rotates and the wheels do not**. They stay on the road and move
  only by their own suspension travel, so the gap between body and wheel is the
  compression. Rotating the wheels with the body would have made the car a rigid
  model being waggled, and the suspension invisible — which is most of what the
  widget exists to show.

  Body rotation is **exaggerated** (`?gain`, default ×7) because a GT3 rolls
  about 1.5° and pitches under 2°, and at true scale the car looks welded solid.
  The header always carries the **true** degrees, and says `×7`, so the picture
  is an amplifier and the numbers stay the instrument. `?gain=1` for the honest
  angle.

- **Four-corner load and suspension channels** — `mTireLoad`,
  `mSuspensionDeflection`, `mRideHeight`, `mSuspForce` and `mGripFract`, for
  both the LMU and rF2 providers. No offset probing was needed: the four
  already-verified offsets in the same wheel record (brake temp +24, pressure
  +120, temperature +128, wear +152) pin the standard ISI `TelemWheelV01` field
  order, and the load/suspension group falls out of it. LMU's shorter 260-byte
  record shares rF2's 848-byte wheel base, which the existing surface-temp and
  brake-disc offsets independently confirm.

### The calibration problem, and what was not done

A corner load of 3200 N means nothing without the car's mass, weight
distribution and aero — none of which LMU or rF2 publish. Hard-coding a GT3 mass
and a 45/55 split would have produced a number that looks calibrated and is
wrong in every car that is not the one it was tuned against.

So the widget reports load two ways, both honest: **share of total**, which is
instantaneous, exact and needs no calibration at all; and a **ratio** against a
slow average of each corner's *own* load, which self-calibrates live and so
reads the same in a GT3, a Hypercar or an LMP2. The header shows `CAL…` while
that reference converges, and the flags stay off until it has. Same principle as
0.8.0's refusal to fabricate an understeer/oversteer number.

`expectedLeftShare()` cross-checks the load channel against the independent
lateral-G channel — the chassis equivalent of `motionConsistency()`. It is used
by the tests to catch an inverted or mis-offset load block, never to produce a
displayed number.

### Changed

- `PlayerState` gains an optional `chassis` block. **Absent, not zeroed**, when
  spectating or when the wheel block fails its guards, so the widget can tell
  "no data" from "a car sitting perfectly flat" — the same contract `motion`
  uses.
- Demo mode synthesises a plausible load block and runs it through the **real**
  decoder, so the thresholds, warm-up gate and reference average are exercised
  without a sim running. Only the raw numbers are invented.

### Notes

- `?yaw` defaults to `0` — exactly on the car's centreline, as specified. The
  cost is geometric and unavoidable: on-axis, a wheel's circle is edge-on to the
  view and projects to a bar rather than a disc. `?yaw=15` trades a little
  attitude purity for wheels that read as round.
- `scripts/test-chassis.js` (29 cases) joins the suite.

## 0.8.0 — 2026-07-20 "Attitude"

Two new overlays, and the first new **telemetry channels** since the tyre temps:
the vehicle motion block — G-force, rotation rate and orientation — was sitting
in the shared-memory record all along, being read past every frame.

### Added

- **Inputs V**, an alternate pedal-inputs widget. The original is untouched and
  neither replaces the other. Where that one scrolls throttle and brake along a
  time axis, this is the same widget a quarter-turn round: the pedals become
  full-width levels rising from the bottom of the readout, and steering stops
  being a line on a time axis and becomes what it physically is — an angle. The
  needle is pinned at the centre-bottom and only its tip moves, sweeping a ±70°
  arc, so the wheel is read the way you read the wheel itself.

  Losing the time axis costs the trail-braking overlap history, so both levels
  are drawn translucent in one box: where they overlap you are on both pedals,
  which is the reading the scrolling trace existed to give. A fan of ten fading
  ghosts trails the needle, because a bare needle shows where the wheel *is* and
  nothing about how it got there — the exact failing that retired the original
  steering dot in 0.7.0.

- **Motion**, a new widget with three independently switchable modes: a
  **G-meter** (traction circle, fading trail, decaying peak ring), **rotation**
  (yaw rate against slip angle, with an understeer/oversteer chip) and
  **attitude** (pitch and roll as a horizon under a fixed car reference). Each
  is toggled from the Browser Source URL and a disabled mode costs no height —
  the canvas is sized from whichever modes are enabled, and turning all three
  off says so rather than rendering an empty panel.

  Deliberately **not** a calibrated understeer/oversteer number: that needs
  wheelbase and steering ratio per car, which LMU does not publish. Two honest
  channels beat one fabricated one, so it shows yaw rate and slip angle and only
  calls a verdict past 4° of slip. Slip angle comes from the velocity vector
  alone, so it needs no per-car calibration and reads the same in any car.

- **A hover opacity slider on the Motion widget**, so it can sit over the track
  as a see-through HUD while learning a circuit. Below 100% the panel background
  and border are dropped entirely rather than faded — a translucent dark
  rectangle over a track still reads as a rectangle. The value persists per
  browser, and `?opacity=` sets it from the URL, which is the only route that
  works in OBS and in the locked in-game layer where hover can never fire.

- **Vehicle motion telemetry** — `mLocalAccel`, `mOri[3]` and `mLocalRot`, all
  decoded through one new module (`telemetry/motion.ts`) that owns every sign
  decision, since both providers read the same struct and a flipped sign
  produces a readout that looks plausible and is backwards.

  These offsets were not scanned for. `mLocalVel.z = 200` and `mGear = 352` were
  already verified live, and the three vectors plus the 3×24-byte orientation
  matrix fill 184→352 exactly — the block is bracketed on both sides by
  known-good offsets, which is stronger evidence than a scan could give.

- `npm run test:motion` — 30 checks over the axis convention, each asserting a
  situation with only one correct answer (braking, a right-hander, a nose-up
  car), plus the `latAccel = speed × yawRate` identity that makes an inverted
  lateral detectable rather than merely suspected.

- `scripts/probe-lmu-motion.js`, a read-only live probe for re-verifying the
  motion offsets if a future build shifts the layout.

### Notes on the axis convention

Two decisions here are counter-intuitive on purpose and are the kind of thing a
later tidy-up would quietly undo, so both are pinned by tests:

- **Braking is POSITIVE longitudinal.** A textbook g-g diagram would put it
  below the origin, which is what was built first and what read backwards on
  track. The dot now moves forward under brakes, the way the driver is thrown,
  while lateral still follows the direction the acceleration points so the dot
  sits on the side of the corner being turned into. The pairing is mixed by
  intent.
- **Vertical G is zero-centred, not 1 g.** LMU cancels gravity against the
  normal force, so flat ground reads ~0.00 at any speed (measured: ±0.06 at
  200 kph). It is a deviation channel — positive over a compression, negative
  over a crest. The first implementation assumed an accelerometer convention and
  the demo provider synthesised ~1 g to match; the first live probe disproved
  both, and demo mode was corrected so it cannot disagree with the sim.

## 0.7.1 — 2026-07-20

### Added
- **Backmarker ghost in the relative widget** — the mirror of 0.7.0's blue flag.
  A 👻 marks a slower car **ahead of you on the road** that you are arriving on:
  either a lap down, or in a slower class, and being caught. Where the blue flag
  says *let this car past*, the ghost says *you have to get past this one*, so
  the two are deliberately different colours — blue for yield, amber for traffic.
  They are also provably mutually exclusive: no car can ever show both.

  Unlike the blue flag, the ghost requires that you are **actually closing**,
  even on a car a lap down. One holding station ahead of you is not a problem you
  are about to have, and without that test the icon would sit lit for most of a
  stint on anything you never reach.

  Drawn as inline SVG rather than the emoji glyph: an emoji renders in whatever
  colour the system emoji font decides (so it can't be tinted to the row state),
  its size and baseline drift between the OBS Browser Source and the in-game
  layer, and the in-game layer scales widgets with a CSS transform — where a
  bitmap-backed emoji goes soft but a vector stays crisp. The overlay also ships
  no web fonts by design, so depending on an emoji font being installed is
  exactly the dependency the rest of the theme avoids.

## 0.7.0 — 2026-07-20 "On track"

First slice of the Carl + Scot roadmap: the items that are visible on stream and
need no new infrastructure.

### Added
- **Position in class, and the gap to your class leader.** The standings tower
  already grouped cars by category, but every number in the row was still an
  *overall* number — a GT3 leading its class read "P7, +2 laps", which is a
  contradiction under a GT3 header. The position column now counts within the
  class and the gap column measures to that class's leader; the overall figures
  move to the cell tooltips rather than being dropped.
- **A BEST lap column**, with the fastest lap of the race in purple and each
  class's fastest in green. In a multiclass field only one car can hold the
  purple, so without the per-class colour the LMP2 and GT3 benchmarks were
  invisible.
- **A fastest-lap-of-the-race banner** under the lap counter, naming the holder
  and the time. It persists once set — a fastest lap is a race fact, so it stays
  up after the holder pits or retires, which is when a viewer most wants it.
- **Blue-flag / backmarker alert in the relative widget.** A pulsing banner and a
  highlighted row when a car that is *behind you on the road but ahead of you in
  the race* is inside three seconds: either a lap up (an unambiguous blue flag,
  alerted regardless of closing rate) or in a faster class **and actually
  closing**. That last test is what stops the banner latching on to a Hypercar
  that is merely circulating at your pace and never arrives.
- **Virtual-energy overlap readout** — "⚡ 2 of 5 ahead pit first · +1.9 laps in
  hand" in the fuel widget. Each of those cars is a position that comes back on
  strategy alone. It sits *outside* the widget's 20-second FUEL/ENERGY rotation,
  because a strategy call you can only see for half the time is not much use.
  The comparison is restricted to cars in your own class and reports how many it
  drew from: LMU publishes every car's remaining energy but not its burn rate, so
  a car's remaining *laps* has to be estimated from someone else's burn, and that
  only holds within a class. Cross-class cars are excluded rather than guessed at.
- **The steering trace is now a trace.** Steering was a dot on a strip — it told
  you where the wheel was *right now* and nothing about how it got there. It is
  now a centre-anchored line drawn through the pedal trace on the same time axis,
  so turn-in rate, corrections and how much lock is still wound on when the
  throttle comes back are all one glance. `?steer=dot` restores the old readout,
  `?steer=off` removes it.
- **Rotating sponsor logos** under the standings tower, the way a broadcast
  timing graphic carries its partners. Add images in the control panel (they are
  copied into the app's data folder, so moving or deleting the originals later
  can't break a race) and set the seconds per logo. Two stacked images cross-fade
  on a CSS opacity transition, so the strip costs nothing per telemetry frame.
- `npm run test:multiclass` — 30 checks over the class normalisation, the
  position-in-class/class-gap derivation and the blue-flag rule. All are pure
  functions, so they run without the sim.

### Changed
- **Car classes are normalised before anything sees them.** LMU spells the same
  category several ways depending on the entry list (`Hypercar`, `HYPER`, `LMH`,
  `LMDh`, `GTP`; `LMGT3` vs `GT3`), which split one category into several groups
  in the tower. They now collapse onto a canonical set with a known speed order —
  which is also what lets the relative widget reason about "a faster car is
  coming" without hardcoding class names. An unrecognised class is passed through
  rather than discarded, and is never ranked as faster or slower than a known one,
  so a mod entry can't fire a false blue flag.
- **Demo mode is now a realistic multiclass field.** The simulator's three
  classes were cosmetic labels over a field that was covered by four seconds, so
  no faster car ever actually caught a slower one and nothing keyed on real
  multiclass behaviour — the blue flag, the energy overlap, lapping — could be
  seen without the game running. The classes now run WEC-shaped pace (~11 s from
  Hypercar to GT3), start interleaved on track rather than sorted by class, and
  the player is no longer the fastest car in its own class by construction.
- The LAST column no longer paints purple. The purple marks the fastest lap of
  the race, which is a *best* lap and now has its own column; painting LAST purple
  as well claimed the holder's most recent lap was the fastest one, which it
  usually isn't. The green flash for a freshly-set personal best is unchanged.

### Fixed
- **Pace Delta spawned on top of Standings** in the in-game layer. It had no
  entry in the default-position table, so it fell through to the same corner as
  the tower and looked like the overlay had failed to load.
- **The standings table clipped the tenths off its lap times.** Adding a column
  pushed the fixed widths past the panel; the time columns are now sized for a
  full `1:58.492` at the size the CSS actually gives them.
- **The control panel re-rendered once a second, forever.** The feed watchdog
  pushed its status unconditionally on a 1 Hz timer instead of only when the
  live/demo/no-data state changed. The push now happens on the transition, from
  both directions.
- **The simulator reset every car's pace on every completed lap**, re-deriving it
  from the slot id and throwing away the car's class offset — so a GT3's lap time
  snapped to Hypercar pace the moment it crossed the line and the tower disagreed
  with its own gaps.
- Environment-supplied ports (`APEX_HTTP_PORT`, `APEX_WS_PORT`, `APEX_LMU_PORT`)
  are clamped to 1..65535 on the `npm start` path, matching what the desktop app
  already did. `APEX_PROVIDER` and `APEX_LMU_PORT` were also missing from the
  documented list despite being implemented.
- Removed `LocalLapDeltaTracker`, superseded by the pace-delta engine and unused
  since; its stale offline test went with it (`npm run test:delta` covers the
  live engine).

## 0.6.7 — 2026-07-20

### Fixed
- **A part-lap could be adopted as your best lap, and overwrite your PB.** This
  was the real cause of the delta reading nonsense or "—" for a whole lap. When
  the overlay attached part-way round a lap — starting it mid-session, leaving
  the pits, a track reset — the tracker timed from wherever the car happened to
  be, and the moment you crossed the line it recorded that **fragment as a
  completed lap**. A half lap timed 48 s, which then beat a genuine 94 s best on
  a plain `lapSec <` comparison and was adopted as session best, as all-time
  best, and **persisted over the real PB** in `~/.apex-overlay/pb`. Every delta
  afterwards read unknown: a fragment's trace only covers part of the lap, and
  its times are measured from a start line it never crossed. Nothing could ever
  displace it either, because no real lap can beat an impossible time. Now:
  - only a lap that **began at an observed start/finish crossing** can become a
    reference — the first part-lap after attaching is used for display and then
    discarded;
  - laps that are implausibly **fast** are rejected as well as implausibly slow
    (previously only the slow side was checked, which is exactly how a 48 s
    half-lap got through);
  - a trace with a hole in it (car recovered to the track, or a feed dropout) is
    rejected rather than interpolated across;
  - a **persisted PB is re-validated on load**, so an already-corrupted file
    written by an earlier build is ignored instead of poisoning the session.

  If a bad PB was already saved for a track, delete that track's file in
  `~/.apex-overlay/pb` — it re-records on your next clean lap.
- Added `npm run test:delta` — regression checks for the above, plus delta
  stability, runnable without a test framework.
- **Lap delta no longer jumps around.** The delta was sawtoothing by up to
  **±0.15 s** several times a second — it would read a genuine three tenths, then
  snap to zero and climb again. Cause: the delta's two inputs tick at very
  different rates. The time axis (`mElapsedTime`, shared memory) is fresh every
  frame at ~30-60 Hz, but the position axis (REST `lapDistance`) only refreshes
  every 150 ms. With the position frozen between REST packets, `t − t_ref(d)`
  climbed at a full second per second and snapped back the instant a new packet
  landed. The sawtooth amplitude was exactly the poll interval. Three changes:
  - **The position is now dead-reckoned forward** by the snapshot's age × the
    car's own velocity (the same extrapolation the relative widget already used),
    so both axes advance together. Measured on a simulated 100 s lap at 60 fps
    against a 150 ms feed, this alone cuts the worst frame-to-frame movement from
    **0.1496 s to 0.0002 s**.
  - **Lap boundaries are interpolated to the sub-poll moment of the line
    crossing** instead of being stamped at whichever frame first noticed the wrap.
    That frame is up to one poll late, at random, which shifted each lap's whole
    time axis by a different 0-150 ms — a constant per-lap offset that made the
    delta read a tenth or two wrong from the moment a lap started.
  - **The readout is slew-limited and low-pass filtered** (max 1.5 s of delta per
    second of driving, 0.25 s time constant) to absorb what's left — REST
    distance quantisation, poll jitter, packet latency. The filter resets at each
    lap boundary, so the legitimate snap back to ~0 on a new lap is instant.

  Only genuine REST samples are stored as reference-lap points now; extrapolated
  positions are used for display but never baked into the lap you compare against.

### Changed
- **Delta and Pace Delta now read to 2 decimals** (`+0.30`) instead of 4
  (`+0.3021`) — what every sim's delta shows. The third and fourth digits churn
  constantly even on a perfectly stable delta, which reads as flicker rather than
  detail. The wire value keeps its 4-decimal precision, since the smoothing
  filters integrate across frames and would step if fed display-rounded input.

## 0.6.6 — 2026-07-19

### Added
- **New "Pace Delta" widget — Pacelogic-style Δt + Δv.** Replicates the two
  delta readouts of SimHub's "Pacelogic Intro Dash" for the car you're driving,
  shown as a compact 2×3 grid so every value is visible at once:
  - **Δt (Delta T)** — time delta at the same **track position** (`t_now −
    t_ref(d)`); the classic predictive delta bar. Matches SimHub
    `…LiveDeltaSeconds`.
  - **Δv (Delta V)** — progress delta at the same **elapsed time**: how far
    ahead/behind in track progress right now, converted to seconds via the
    reference pace. Matches SimHub `…LiveDeltaProgressSeconds`.

  Each is shown against three references — **SESSION** best, **ALL-TIME** best
  (persisted per track under `~/.apex-overlay/pb` so it survives restarts), and
  **LAST** lap. Signed **4-decimal** readout (`0.0000`, matching LMU); green when
  ahead, red when behind; each cell reads "—" until its reference lap exists. Add
  it as its own `?w=pacedelta` OBS Browser Source or via the in-game layer;
  `?rows=t|v|both` narrows it to a single flavour.

### Fixed
- **Lap delta now works for the driven car.** The delta engine's **time axis is
  the sim's real-time clock `mElapsedTime`** (shared memory), with lap distance
  from the REST feed and lap boundaries detected by the distance fraction
  wrapping past the line. Two dead ends were ruled out along the way:
  - the shared-memory **`mLapStartET`** reports wrong, irregular lap durations on
    current LMU builds (176 s / 252 s for real ~109 s laps), so lap timing can't
    be derived from it;
  - REST **`timeIntoLap`** is a *position-derived estimate* — identical at a
    given distance on every lap — so comparing laps against it always yields ~0
    (the delta looked "stuck at 0.00"). LMU exposes no live delta-to-best of its
    own in the REST API, so the delta has to be built from the real clock.

  `mElapsedTime` genuinely differs between fast and slow laps, so the delta now
  tracks pace correctly. The "current lap time" readout uses REST `timeIntoLap`.
- **Delta bar direction matches LMU.** The single Delta widget's fill now grows
  **right when ahead** (green) and **left when behind** (red), the reverse of
  before, to match the on-screen LMU delta.

## 0.6.5 — 2026-07-16

### Changed
- **Delta rebuilt on the real lap clock.** For the car you're driving, the delta
  now runs off the sim's shared-memory lap clock (`mElapsedTime − mLapStartET`):
  exact, physics-rate, and immune to the REST `timeIntoLap` quirk where the
  clock pauses while the car is stationary (proven to lag real lap time by tens
  of seconds). It does exactly the intuitive thing — record your fastest lap's
  trace, compare the current lap against it live, adopt a new trace when you go
  quicker — arming on your first flying lap. Spectated cars keep the REST-based
  tracker. The "Current" lap time in the Relative strip uses the exact clock too.
- **Relative widget latency cut.** Every car's road position is now
  dead-reckoned forward by its own velocity between REST snapshots (which are up
  to 150 ms stale), so gaps move smoothly at the full frame rate instead of
  stepping ~7×/second; the widget also redraws every 60 ms (was 120 ms).

### Fixed
- **Update-rate slider now works above 30 Hz.** Windows coalesces JS timers to
  ~15.6 ms multiples, so the broadcast loop silently capped at ~32 fps no matter
  how high the slider was set (60 Hz delivered 32). The loop now ticks on a fast
  cadence and broadcasts when a frame is due — measured 59 fps at the 60 Hz
  setting (was 32), 10 fps at 10 Hz. Below ~30 Hz behaviour is unchanged.

## 0.6.4 — 2026-07-16

### Fixed
- **Relative widget now shows the right cars, in the right order.** Three bugs
  compounded (verified against a live multiclass session):
  - gaps were scaled by LMU's *session-wide* pace estimate (the fastest class's
    lap time) instead of **your car's own** lap time, reading ~20% short for
    slower classes;
  - the display order was inverted — the nearest car ahead was printed at the
    *top* of the ahead group and the farthest shown car behind sat right under
    your row (it now reads furthest-ahead → nearest-ahead → YOU → nearest-behind
    → furthest-behind, like the in-game display);
  - cars parked in their garage stalls appeared as phantom entries near the pit
    straight (now excluded).
- **Lap delta now arms after your first flying lap.** Previously it silently
  needed two full laps (one thrown away, one to build the reference) before
  showing anything. A partial first lap is now used as a valid reference for the
  part of the track it covered — the delta appears as soon as it can be honest,
  shows "—" elsewhere, and upgrades to full-lap coverage at the next line
  crossing. Out-laps/crawls are rejected as references (must be within ~40% of
  the car's best), and this feeds both the Delta pill and the Relative widget's
  Δ cell.

### Added
- **Virtual energy in the fuel widget.** When the car runs an LMU virtual-energy
  budget, the widget rotates every **20 s** between the FUEL view and a new
  **VIRTUAL ENERGY** view — remaining %, average % per lap, laps left on energy,
  and the margin at the flag (colour-coded like fuel) — with a small header chip
  naming the active view. Cars without VE keep the plain fuel view.

## 0.6.3 — 2026-07-16

### Added
- **Estimated laps-to-go in the standings.** Timed races (LMU only publishes a
  countdown clock) now also show an estimated **"~N laps left"** in the session
  strip, derived from the time remaining and the leader's lap pace — so the tower
  reads both the clock *and* how many laps that works out to.
- **Real weather forecast.** The weather widget now reads LMU's actual per-session
  forecast (`START → 25% → 50% → 75% → FINISH`) instead of projecting the current
  conditions forward. Each slot shows its **temperature** and rain chance (plus
  humidity/wind under the hood), so the strip is a genuine look-ahead rather than
  a flat repeat of "now".

### Fixed
- **Virtual energy no longer shows a false red "0%".** Cars/classes that don't run
  a virtual-energy budget (e.g. LMP2) report a flat `0` all race; that now reads
  as **"—"** (not applicable) instead of a critical-red `0%` that looked like a
  car out of energy. Classes that do use VE (Hypercar, GT3) are unaffected.
- **Live lap delta now works.** The predictive delta bar was adopting a *partial*
  lap as its reference whenever the overlay started (or focus switched to a car)
  mid-lap, which produced wild bogus values (e.g. −78 s) for the rest of each lap.
  The reference is now only trusted when a lap was captured flag-to-flag, is kept
  **per car** so it survives broadcast camera cuts, and is sanity-clamped.

## 0.6.2 — 2026-07-16

### Added
- **Global hotkey for "Show in game".** Toggle the in-game overlay without
  alt-tabbing out of the sim. Defaults to **F8** and is rebindable from the
  control panel — click the **Toggle hotkey** chip and press any combination
  (e.g. `Ctrl+Alt+O`), or clear it with the `×` to unbind. The key works while
  the sim has focus; flipping it updates the control-panel switch live.

  (A middle-mouse double-click trigger is planned as a follow-up — it needs a
  low-level Windows mouse hook, so it ships separately once verified in-game.)

## 0.6.1 — 2026-07-16

### Fixed
- **Delta widget is now in the control panel.** The new Delta overlay was missing
  from the app's widget catalog, so it couldn't be switched on/off, wasn't added
  to the in-game layer, and didn't appear in the app's widget list. It's now a
  first-class overlay alongside the others (enabled by default, and its own
  `?w=delta` OBS Browser Source), so it shows with live **and** demo data.

## 0.6.0 — 2026-07-16

### Added
- **Standings grouped by class.** The tower now splits the field into class
  groups (Hypercar, LMP2, LMP3, GT3, GT4, …) under a bold subheader showing the
  class name, a class colour dot and the car count, so it's instantly clear which
  category each block of cars belongs to. Classes are ordered by their leader's
  position; colours are stable per class.
- **Positions gained / lost column.** A new `±` column shows each car's movement
  vs. the grid — green ▲ for places gained, red ▼ for places lost — computed from
  LMU's `qualification` (grid) field.
- **Virtual energy column.** Every car shows its remaining **virtual energy** as
  a percentage over a colour-coded fill bar (healthy → low → critical), from
  LMU's real per-car `veFraction` — the same figure LMU's native overlay shows
  for the cars ahead. The leader running low on energy now reads at a glance.
- **Fastest-lap highlighting.** The holder of the race's fastest lap is shown in
  **purple** (with a purple row accent); any car that sets a new personal-best
  lap **flashes green** for a few seconds, then fades.
- **Bigger lap counter + countdown clock.** A prominent session strip tops the
  standings: an enlarged `LAP x/y` counter, plus a live ⏱ countdown clock for
  timed sessions (from LMU's `timeRemainingInGamePhase`) that flashes red inside
  the final minute.
- **New Delta widget — live predictive lap delta.** A centre-anchored delta bar
  (green/left when up on your best lap, red/right when down) with a signed value
  pill, mirroring a sim's on-screen delta. The provider builds it predictively
  from the focused car's distance→time trace against its own reference lap.

### Fixed
- **Relative widget now shows Current lap time and Delta.** Both were hard-wired
  to the unknown sentinel on the LMU path, so the CURRENT and Δ cells always read
  "—". The provider now feeds the live current-lap time (from `timeIntoLap`) and
  the predictive delta. (Δ populates once a clean reference lap has been driven
  while the overlay is running — a predictive delta needs a captured lap; REST
  exposes no trace of a lap set before the overlay started.)

### Changed
- Standings driver names use the broadcast-style `T. Pereira` format and the
  panel is slightly wider so names don't truncate against the new columns.
## 0.5.5 — 2026-07-14

### Added
- **Live tyre temperatures are here.** The long-standing "LMU publishes no tyre
  temps" conclusion was wrong on two counts: the per-car record stride was
  mis-set (the same 2880-vs-1888 bug behind the pedal saga), and any check made
  in the garage reads absolute zero because LMU reports **0 K for a car not
  running on track**. With the correct stride, the whole rF2 wheel struct lines
  up (the brake-disc temp at wheel-start +24 pins it), exposing the channels the
  reader now surfaces for your own driven car:
  - **Inner-liner temp** — the mean of the `mTireInnerLayerTemperature[3]` bands
    at record offset `976 + wheel*260 + 84`. This is the number LMU's **in-game
    HUD** shows — verified against the game's own tyre MFD, matching within a few
    tenths of a degree across all four corners.
  - **Surface (contact-patch) temp** — the mean of the `mTemperature[3]`
    inner/centre/outer bands at `976 + wheel*260`.

  Surface offsets were pinned live against a SimHub reference (matched to
  0.01 °C) and the HUD channel against the game's own MFD; SimHub was only a
  calibration oracle — nothing at runtime depends on it.
- **Tyre widget shows both temps.** Each corner leads with the **inner-liner**
  temp (matches the game HUD) and shows the **surface** temp on the sub-line as
  `surf NN°`, to one decimal. It falls back to tread-% when no temperature is
  available (spectating, or the car in the garage).

### Fixed
- **No brake-disc contamination.** Each tyre band is clamped to a plausible tyre
  range (−20…200 °C), so a torn/misaligned read that slid onto a brake-disc
  channel (hundreds of °C, packed 104 bytes before each tyre block) or a 0 K
  garage value can never leak into a corner's number.
- **No tread-depth flicker.** A single missed shared-memory poll no longer blanks
  the pedals/temps to "unknown" for one frame (which read as flashing); the last
  good local-car physics is held for 0.5 s to bridge the gap.
- `scripts/scan-lmu-wheels.js` used the old 2880 stride (so it could never find
  the temps it was built to find); corrected to 1888 and given a known-offset
  confirmation line.

## 0.5.4 — 2026-07-14

### Fixed
- **The pedal trace is finally, correctly YOURS.** Root cause of the entire
  "shows another car's inputs" saga was a single wrong constant: the
  shared-memory per-car record stride was **2880 bytes; it's actually 1888**. At
  the wrong stride only the very first record ever aligned, so every other car
  (including yours whenever you weren't in slot 0) decoded as garbage — which
  masqueraded as "LMU only publishes one car", "mID is a foreign namespace", and
  "the record rotates through pit cars". None of that was real. With the correct
  stride, LMU publishes the **whole field** (all ~30 cars, live physics), and
  the player's record is matched by exact `mID === REST slotID`. Verified live:
  shared-memory speed matches the REST speed to the km/h, so it is provably your
  car — real throttle/brake/TC/ABS/gear/rpm and litre fuel.
- Player is now identified by **id, not car number** — racing numbers repeat
  across classes (a field can contain two #21s), ids don't.

### Notes
- Tyre **temperatures** remain unavailable: re-checked on the correct car at the
  correct stride while driving — LMU simply doesn't publish per-wheel temps to
  shared memory. The tyre widget stays on remaining-tread **wear** (from REST).

## 0.5.3 — 2026-07-14

### Fixed
- **Pedal trace and fuel are back.** v0.5.2's "strict slot match" assumed LMU's
  telemetry `mID` shares the REST `slotID` namespace. Live debugging at
  Interlagos proved it does not — the driven car reads `mID=4` while its REST
  slot id is `54`, so the strict match could never succeed and always returned
  *nothing*: no throttle/brake trace, no litre-based fuel (only the REST speed
  survived, which is why the speedo still matched). The reader again falls back
  to the first live-looking record (the one car LMU actually publishes), so your
  inputs, TC/ABS and fuel litres come through while driving.
- **Still yours, not the spectated car's.** The anti-"P1's inputs" guard now
  lives where it belongs: the provider only reads local physics when the REST
  feed says *you* currently have camera focus (driving in-car). Spectate another
  car and the trace/fuel go blank rather than showing their data.

### Changed
- **Tyre widget leads with wear.** Since LMU publishes no tyre temperatures,
  each corner now shows remaining tread % as the primary readout, colour-coded
  green → amber → red as it wears, instead of a large blank "—" over a tiny wear
  line. Temperature reappears as a sub-line automatically if a future build
  exposes it.

## 0.5.2 — 2026-07-13

### Fixed
- **Inputs really are yours now.** Live debugging against a running online
  session showed LMU publishes physics for exactly ONE car — whichever car
  the game camera is watching — so v0.5.1's fallback could still pick up the
  spectated car (P1). The reader now only accepts the record whose ID matches
  *your* player slot: your inputs, fuel, TC and ABS when you're driving;
  blank (never someone else's) when you're spectating.

### Added
- **Tyre wear** per corner in the Tyre Temps widget (remaining tread %),
  fed live from the game for your own car. Verified against a live session.
- Tyre **temperatures** are confirmed unavailable from LMU on current builds
  (published neither in shared memory nor the REST API) — the widget shows
  wear now and will pick up temps if a future LMU build exposes them.

## 0.5.1 — 2026-07-13

### Fixed
- **Inputs/fuel showed another car's data** — the shared-memory reader could
  pick P1's record instead of yours (every locally-simulated car has one).
  It now matches the record against your player slot from the game's own
  standings feed, so pedal inputs and fuel litres are always your car's.

### Added
- **Live TC / ABS indicators** in the Inputs widget: the throttle bar turns
  yellow while traction control cuts power and the brake bar turns orange
  while ABS releases pressure; TC/ABS chips glow with intervention strength;
  and the trace draws the post-aid line so you can read modulation depth.
- `scripts/scan-lmu-wheels.js` — diagnostic to locate LMU's tyre-temperature
  memory offsets (groundwork for live tyre temps).

## 0.5.0 — 2026-07-13

### Added
- **In-game overlays** — show overlays on screen in the game itself, in OBS, or
  both. New "Show in game" switch plus a per-widget "In game" toggle in the
  control panel. A single transparent, click-through, always-on-top window
  hosts every enabled widget (one renderer process — minimal resource cost),
  and is fully closed whenever it's not in use.
- **Edit layout** — unlock the in-game layer to drag widgets around the screen
  and resize them with the corner handle. Placement is saved per widget;
  "Reset layout" restores the defaults.
  Note: the sim must run in **Borderless / Windowed** mode (exclusive
  fullscreen draws over every overlay app).
- **Apex & Chill branding** — the league logo is now the installer, app and
  window icon, and the control panel has a full redesign in the logo palette.

### Fixed
- **Pedal input lag (~0.5–1 s)** — the shared-memory reader was copying the
  whole ~368 KB telemetry buffer up to 8× per poll at 30 Hz, stalling the
  server loop. It now reads only the driven car's record (a few KB at most),
  so pedal inputs reach the overlay at full rate with no backlog.
- Empty banner strips no longer appear at the top of the control panel.

## 0.4.0

- In-app auto-update via GitHub Releases.
- Live LMU telemetry: REST API (whole field) + shared memory (local car
  inputs & fuel in litres).
- Desktop app, installer, OBS overlay fixes.
