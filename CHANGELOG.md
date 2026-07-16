# Changelog

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
