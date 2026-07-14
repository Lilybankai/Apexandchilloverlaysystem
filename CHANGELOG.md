# Changelog

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
