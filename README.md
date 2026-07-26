# Apex Overlay System

Lightweight **rFactor 2 / Le Mans Ultimate** telemetry overlay system for the
**Apex & Chill Racing League** live streams.

It reads sim telemetry from the rF2/LMU shared-memory plugin, normalizes it, and
broadcasts it over a local WebSocket to a set of branded browser overlays that
are added to OBS as **Browser Sources** and positioned over the sim's own HUD.

```
 rF2 / LMU  ──(shared memory)──►  Node telemetry server  ──(WebSocket JSON)──►  OBS Browser Source overlays
 (telemetry plugin)               (this app, lightweight)                        (standings, pedals, relative,
                                                                                  weather, tyres, fuel)
```

## Two ways to run it

- **Desktop app (recommended for streamers)** — a Windows installer (`Setup.exe`)
  that installs a small control-panel app. Open it, tick the overlays you want,
  set the port / update rate / demo mode, and copy each overlay's URL into OBS.
  No terminal, no commands. See [Desktop app](#desktop-app).
- **Headless server (developers)** — run the Node server directly with
  `npm start`. See [Getting started](#getting-started).

The telemetry engine is identical in both; the desktop app just wraps the same
server in an Electron window for people who don't want a command line. Overlays
still render inside the Chromium instance **OBS already runs** for Browser
Sources, so there is no extra renderer on stream. Telemetry is broadcast as
compact JSON at a configurable rate (default 30 Hz).

## Desktop app

Build the installer:

```bash
npm install
npm run app:dist     # -> release/Apex Overlay System Setup <version>.exe
```

Run the app in development (no packaging):

```bash
npm run app          # builds the server, then launches the Electron window
```

The control panel:

- **Overlays** — tick the ones you want; each has its own URL + **Copy** and
  **Preview** buttons. Add each as a **separate OBS Browser Source** and drag it
  into position inside OBS.
- **Settings** — server port, update rate (1–120 Hz), a **Demo mode** toggle
  that forces simulated data (no sim/plugin needed), and **Widget background**,
  which fades every widget's panel background live — at 0% only the data is left
  over the game (see [Widget background](#widget-background)).
- **Status pill** — shows LIVE / DEMO DATA / NO DATA / STOPPED at a glance.

### In-game layout editor

With **Show in game** on, **Edit layout** unlocks the overlay layer so widgets
can be arranged over the sim. Drag a widget anywhere to move it, and resize it
three ways:

| Handle          | Does                                                              |
| --------------- | ----------------------------------------------------------------- |
| **Right edge**  | Sets the widget's **width** — it reflows, so a wider standings tower gives its driver names more room rather than magnifying everything |
| **Bottom edge** | Sets its **height** — the body is boxed and clipped to fit, which is how a 20-car field is cropped to the top few rows |
| **Corner**      | Scales the whole widget uniformly; nothing inside reflows          |

Double-click a handle to hand that dimension back to automatic. Placement is
saved per widget in `config.json`; **Reset layout** clears the lot.

Settings are saved to `%APPDATA%/apex-overlay-system/config.json` and restored on
next launch. The server starts automatically when the app opens.

### Auto-update

The app checks GitHub Releases on launch (via `electron-updater`). When a newer
version is published, a banner appears in the control panel: **Download &
install** fetches it, then **Restart & update** applies it. Updates are never
auto-installed, so a live stream is not interrupted.

To publish a new version:

```bash
# bump "version" in package.json, then:
GH_TOKEN=$(gh auth token) npm run release   # builds + uploads to GitHub Releases
```

Existing installs (v0.4.0+) will offer the update automatically. Note: builds are
unsigned, so Windows SmartScreen shows an "unknown publisher" prompt on first
install and on each update ("More info → Run anyway").

## Overlays

Positioned to sit on top of the LMU/RaceLab HUD with solid, opaque backgrounds
(turn them down or off with **Widget background** — see below):

- **Standings** (top-left) — full field, gaps, pit status
- **Relative / timing** (top-right) — nearest cars on track, live delta
- **Pedal inputs** (bottom-center) — throttle/brake trace, trail-braking style
- **Pedal inputs (vertical)** — the same channels a quarter-turn round: pedals as
  levels rising from the bottom, steering as a needle sweeping an arc from a
  fixed centre-bottom pivot. An alternate to the above, not a replacement.
- **Motion** — G-force, rotation and attitude, in three independently
  switchable modes (see below)
- **Damage & Repair** — component damage, the sim's own repair time, and a live
  countdown once the crew is on the car (see below; LMU only)
- **Radar** — a spotter's-eye strip of the cars around you, drawn to scale (see
  below)
- **Tyre temps** — four-corner temperatures
- **Weather forecast** — current + short forecast
- **Fuel calculator** — per-lap use, laps remaining, fuel-to-finish, pit window
- **MFD** — a read-only, colour-grouped readout of the in-game pit menu and
  driving aids. See below; LMU only

### Widget background

One slider in the control panel's **Settings** card fades the panel behind
**every** widget at once — background, header strip, row shading, borders, the
brand accent bar and the drop shadow. At **0%** they are all gone and nothing but
the live data floats over the game; at 100% (the default) the overlay is the
original solid design that fully occludes the sim's own HUD. Below 100% the text
picks up a shadow and the dimmest labels are lifted, so readings stay legible
over pale tarmac or sky.

It applies **live** — in game and to OBS Browser Sources that are already added,
with no restart, reload or re-copied URL. Two deliberate exceptions keep things
usable: the Fuel Planner's steppers and setup fields keep a faint background so
they can still be clicked in interact mode (F7), and the in-game **layout
editor** puts every panel back to solid while it is open, since a widget faded to
nothing can be dragged but not found.

Per source, `?bg=` on the URL overrides the app's setting and pins that page
(`?bg=0` for a bare HUD, `?bg=100` for solid, `?bg=40` for a light tint). This is
separate from the Motion/Damage/MFD/Radar `?opacity=` control, which fades a
single widget's **contents**; `bg` only ever touches the box behind them.

### Motion widget modes

Each mode is switched from the Browser Source URL and defaults **on**; append
`=off` to drop one. Turning all three off renders a message rather than an empty
panel.

| Param      | Mode         | Shows                                                        |
| ---------- | ------------ | ------------------------------------------------------------ |
| `?g=off`   | **G-meter**  | Traction circle with a fading trail and a decaying peak ring |
| `?rot=off` | **Rotation** | Yaw rate vs slip angle, plus an understeer/oversteer chip    |
| `?att=off` | **Attitude** | Pitch and roll as a horizon under a fixed car reference      |

A disabled mode costs no height — the canvas is sized from the enabled set.

The canvas bitmap tracks the element, so the traction circle stays a true circle
at any widget width. Resizing a widget in the in-game editor used to leave the
bitmap stale and the browser squashed it to fit, drawing the circle as an
ellipse.

Hovering the widget reveals an **opacity slider**, so it can sit over the track
as a see-through practice HUD; below 100% the panel background and border are
dropped entirely. The choice persists per browser, and `?opacity=0.4` sets it
from the URL — the only route that works in OBS and in the locked in-game layer,
where the pointer never reaches the widget and hover can never fire.

Longitudinal G is reported with **braking positive**, so the G-meter dot moves
forward under brakes the way the driver is thrown, while lateral follows the
direction the acceleration points (the dot sits on the side of the corner you
are turning into). That pairing is deliberate and was chosen from real laps; the
textbook g-g convention read backwards at speed. See `src/telemetry/motion.ts`.

### Damage & Repair widget

What is broken, and what the sim says it costs to fix — the question you ask
mid-stint and cannot answer from the cockpit.

| Param          | Mode           | Shows                                                  |
| -------------- | -------------- | ------------------------------------------------------ |
| `?dmg=off`     | **Components** | Aero and the four suspension corners, as severity bars |
| `?repair=off`  | **Repair**     | The sim's own repair seconds and the pit-menu choice   |
| `?brakes=on`   | **Discs**      | Brake disc thickness per corner, mm                    |
| `?exact=on`    | **Exact**      | Precise published seconds instead of the game-rounded ones |

Components and repair default **on**; discs default **off** — disc thickness is
wear rather than damage, and it is the only channel here that is not about the
pit decision. Hovering reveals the same **opacity slider** the Motion widget has,
with the same `?opacity=` URL override.

Bars split at 15% severity: below is amber, at or above is red, and an undamaged
component stays the same muted grey as the "no data" text — at zero there is
nothing to look at. `Do Not Repair` selected while the car is damaged is flagged
amber, because that is a deliberate choice rather than the default.

The repair figure is **the sim's own live estimate**, read straight through from
`FixAllDamage`, and it scales with severity (measured: 35.1 s at 9.5% aero /
19.5% FR, 93.7 s at 35.7% / 52.1%). Nothing here models, scales or calibrates
it. When the sim publishes no figure the widget says `NO ESTIMATE` rather than
showing a plausible zero.

If tyres are selected in the pit menu, a **separate tyre line** appears under it
— priced from the sim's `TwoTireChange` / `FourTireChange` against the corners
actually selected. The two are shown **side by side and never summed**: whether
they overlap is decided by `TireTimeConcurrent`, which has not been verified
against a real stop, so a total could be wrong by the whole tyre time. Two
honest figures the driver adds up beat one that might be wrong.

**Both figures are rounded to match the game.** LMU rounds its own pit message
**up to the nearest 5 s** — it showed `Damage 95 sec` against a published `93.7`,
and `Tyres: 5 sec` against `4.5` — so the widget does the same and the overlay
never disagrees with the message on the driver's screen. The rounding is
pessimistic, which is the safe direction for a pit decision. `?exact=on` shows
the precise published values instead (they read lower).

Severity is shown exactly as the sim reports it (`0..1`). It is not remapped to a
"car health" percentage, because that curve would be ours rather than the sim's.

> **LMU only.** Damage comes from LMU's repair screen over REST, not shared
> memory: the inherited rF2 damage block is present in the struct but LMU does
> not populate it (verified through a real impact — `mLastImpactET` never fires,
> engine temps read 0 °C). rF2 has no equivalent endpoint, so the widget shows
> `NO DATA` there, and between sessions where the endpoint 404s. The block is
> **absent, not zeroed**, so "no data" can never be mistaken for an undamaged
> car. See `src/telemetry/damage.ts` and `scripts/probe-lmu-damage.js`.

#### The stop countdown

The moment the car comes to rest in its box, the repair estimate has done its
job — the decision is made and the driver is sitting there watching a crew. So
the same slot switches to a **countdown from when work begins to when the car is
released**, with a bar for how far through the stop is.

It counts down the length the stop was **booked** for, captured at the instant
work starts and then held — the pit menu keeps changing as the crew works
through it, and re-reading it would move the target mid-countdown.

Past zero it keeps going and says so (`ANY MOMENT`, `+3.2s over booked`), because
the booked figure is a floor and not a prediction: LMU draws `FixRandomDelay`
(≤5 s) and `RandomTireDelay` (≤1 s) when the stop happens and publishes only the
caps. Freezing on `0` and hoping would be the one confidently-wrong number this
widget is otherwise careful never to show. When the car is released it holds the
**actual** stop length for five seconds, so it can still be read by someone who
was watching their mirrors.

If the repair screen was not answering when the car stopped there is nothing to
count down to, and the widget counts **up** instead (`IN THE BOX`) rather than
inventing a target.

> The stop phase comes from `pitState` on LMU's standings feed, cross-checked
> against the car's own speed so the clock starts when the car is actually
> stationary. The clock itself runs on the server, so a browser source reloading
> mid-stop rejoins the same countdown. See `PitState` in `src/telemetry/types.ts`.


### Radar widget

A spotter's-eye strip: the cars around you as they are in space, with you fixed
at the centre. The relative/timing widget is 1-D — how far round the lap — so it
cannot tell you a car is drawing alongside on your **left**. This can.

| Param         | Shows                                                                 |
| ------------- | --------------------------------------------------------------------- |
| `?range=18`   | Longitudinal range each way, metres (default 18, clamped 8..150)       |
| `?reveal=12`  | Radius within which a car makes the HUD fade in (default 12 m)         |
| `?opacity=0.4`| HUD opacity, same contract as the Motion/Damage widgets                |

**The scale is isotropic and the cars are drawn at their real size.** One metre
is the same number of pixels across the strip as up it, and each icon is its
car's true footprint — 5.10 × 2.00 m for a Hypercar, 4.76 × 2.05 m for a GT3. So
**icons touching means cars touching**, on both axes and at any angle between
them, whatever the range is set to and however large the widget has been dragged.

`?range=` is the only scale knob, deliberately: the lateral half-width follows
from it and lands at about a track width (~13 m) at the default. Making it a
second knob would be making the two axes disagree again. A wider range is
available and the cars shrink to match.

The HUD is invisible until a car comes within the reveal radius, then fades in —
so it costs nothing in clear air. A car arriving alongside lights a soft red
bloom on that side, anchored at the car's own position up the strip, brightest
level with it, and feathered at every edge so nothing it draws ends on a hard
line.

Faster-class cars carry a halo ring; a car you are lapping draws as a ghost.
Blip positions come from `src/telemetry/radar.ts`, which owns the world→local
projection and is unit-tested headless in `scripts/test-radar.js`.


### MFD widget

A **read-only readout** of the in-game Multi-Function Display for the player's
car: a **PIT STRATEGY** section (colour-coded by category — tyres, pressures,
ducts, aero, fuel, brakes — so related lines read as a group) and a **DRIVING
AIDS** section showing **live brake bias**. It mirrors what you've set in-game;
it does not change anything.

| Param         | Shows                                                                 |
| ------------- | --------------------------------------------------------------------- |
| `?pit=off`    | Hide the pit-strategy section (fuel, energy, tyres, wing, pressures, ducts, repairs) |
| `?aids=off`   | Hide the driving-aids section (live brake bias)                       |
| `?opacity=0.4`| Panel opacity, same contract as the Motion/Damage widgets             |

Pit strategy is read from LMU's REST garage API and projected in
`src/telemetry/mfdControl.ts`. **Brake bias is read live from shared memory**
(`mRearBrakeBias`) and updates as the driver shifts the balance — the REST garage
data only reports the frozen *setup* value, so it can't show live aids. The other
aids (TC/ABS/engine maps) aren't shown at all: LMU exposes no live value for them
anywhere, and a frozen setup number that never moves reads as broken. **LMU
only** — the widget shows "No MFD data" out of a session or on rF2.

## Live telemetry sources

The server can read live data three ways (set `APEX_PROVIDER`, default `lmu`):

| Provider     | Source                                   | Best for                                  |
| ------------ | ---------------------------------------- | ----------------------------------------- |
| `lmu` (default) | **Le Mans Ultimate REST API** on `http://localhost:6397` | Broadcasting/directing — whole-field standings, gaps, timing, weather, fuel. Robust across LMU updates. |
| `rf2`        | rF2/LMU **shared-memory** plugin         | Showing the **locally-driven** car's pedals, gear, RPM, tyres. |
| `simulator`  | Built-in synthetic data                  | Demos / building overlays with no sim open. |

Any provider that can't reach its source falls back to the **simulator** so the
overlays keep running (flagged as demo) instead of freezing.

**LMU REST API (recommended):** no plugin needed — it's LMU's own built-in web
API (the one behind `http://localhost:6397/swagger`). Just have LMU running.
Because the API exposes the *whole field*, it drives standings, relative/timing,
weather and fuel for the whole grid.

For the **locally-driven car**, the `lmu` provider additionally reads shared
memory (when the plugin is present) to add that car's **pedal inputs** and
**fuel in litres** — so a driver-streamer gets a live pedal trace and the full
fuel calculator on top of the REST timing. This is automatic and best-effort: no
local car (pure spectating) simply means those come from REST (fuel) or stay
empty (pedals).

**Tyre temps on LMU:** available for the locally-driven car. LMU publishes the
per-wheel `mTemperature[3]` bands (inner/centre/outer, in Kelvin) in shared
memory; the reader averages the three into a per-corner °C. They read absolute
zero (0 K) whenever the car isn't running on track (garage/pits), which is
reported as unknown so the widget falls back to tread %. As with pedals, this is
the *driven* car only — a purely spectated remote car has no tyre temps.

**Shared-memory (`rf2`):** requires the **rF2 Shared Memory Map Plugin**
(`rFactor2SharedMemoryMapPlugin64.dll`) in the sim's `Bin64/Plugins/` folder.
Note: LMU changes its struct layout between updates, so shared-memory field
offsets are version-sensitive.

## Requirements

- **Node.js 18+** (server runtime), or just run the desktop app.

## Getting started

```bash
npm install      # install dependencies (ws + TypeScript toolchain)
npm start        # builds and starts the server (http://127.0.0.1:8080)
```

Then add `http://127.0.0.1:8080/` as an OBS Browser Source (see
`docs/OBS-SETUP.md`).

### Development

```bash
npm run dev        # tsc watch build
npm run typecheck  # type-check without emitting
```

## Configuration

All settings are environment variables with lightweight defaults
(see `src/server/config.ts`):

| Variable           | Default     | Description                                   |
| ------------------ | ----------- | --------------------------------------------- |
| `APEX_HOST`        | `127.0.0.1` | Bind host                                     |
| `APEX_HTTP_PORT`   | `8080`      | HTTP + overlay port                           |
| `APEX_WS_PORT`     | = HTTP port | WebSocket port (shares HTTP server)           |
| `APEX_WS_PATH`     | `/ws`       | WebSocket endpoint path                       |
| `APEX_UPDATE_HZ`   | `30`        | Telemetry broadcast rate (1–120 Hz)           |
| `APEX_OVERLAY_DIR` | `overlay`   | Static overlay asset directory                |
| `APEX_FORCE_SIM`   | `false`     | Force the simulator provider (demo mode)      |
| `APEX_PROVIDER`    | `lmu`       | Live source: `lmu` / `rf2` / `simulator`      |
| `APEX_LMU_PORT`    | `6397`      | LMU REST API port (when `provider` is `lmu`)  |
| `APEX_PANEL_OPACITY` | `100`     | Widget background opacity % (0 = none), 0–100 |
| `APEX_VERBOSE`     | `false`     | Verbose logging                               |

## Project layout

```
src/
  telemetry/
    types.ts             # normalized TelemetryFrame contract (shared schema)
    provider.ts          # TelemetryProvider interface
    simulatorProvider.ts # synthetic data for demos / dev
    rf2Provider.ts       # rF2/LMU shared-memory reader (falls back to simulator)
    fuelCalculator.ts    # fuel/lap, laps remaining, fuel-to-finish, pit window
  server/
    config.ts            # runtime config (ports, update rate)
    wsServer.ts          # WebSocket broadcast server
    index.ts             # HTTP static server + telemetry loop entrypoint
overlay/                 # browser overlays (HTML/CSS/JS) — OBS Browser Source
  index.html             #   all-in-one page (every widget, fixed 1080p canvas)
  widget.html            #   standalone single-widget page (?w=<name>) per source
electron/                # desktop control-panel app (Electron)
  main.js                #   runs the dist/server in-process; persists settings
  preload.js             #   safe IPC bridge to the renderer
  control-panel/         #   the window UI (choose overlays, copy URLs, status)
docs/                    # OBS setup + architecture notes
scripts/                 # Windows launcher
```

## Telemetry contract

`src/telemetry/types.ts` defines `TelemetryFrame`, the single normalized schema
shared between the telemetry producers and the overlays. Every provider maps its
raw data into this shape, so the overlays never depend on which sim is running.
The schema is versioned via `TELEMETRY_SCHEMA_VERSION`.

## License

UNLICENSED — internal to the Apex & Chill Racing League.
