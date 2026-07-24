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
- **Settings** — server port, update rate (1–120 Hz), and a **Demo mode** toggle
  that forces simulated data (no sim/plugin needed).
- **Status pill** — shows LIVE / DEMO DATA / NO DATA / STOPPED at a glance.

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

Positioned to sit on top of the LMU/RaceLab HUD with solid, opaque backgrounds:

- **Standings** (top-left) — full field, gaps, pit status
- **Relative / timing** (top-right) — nearest cars on track, live delta
- **Pedal inputs** (bottom-center) — throttle/brake trace, trail-braking style
- **Pedal inputs (vertical)** — the same channels a quarter-turn round: pedals as
  levels rising from the bottom, steering as a needle sweeping an arc from a
  fixed centre-bottom pivot. An alternate to the above, not a replacement.
- **Motion** — G-force, rotation and attitude, in three independently
  switchable modes (see below)
- **Damage & Repair** — component damage and the sim's own repair time, so the
  pit decision can be made from the overlay (see below; LMU only)
- **Tyre temps** — four-corner temperatures
- **Weather forecast** — current + short forecast
- **Fuel calculator** — per-lap use, laps remaining, fuel-to-finish, pit window
- **MFD** — a read-only, colour-grouped readout of the in-game pit menu and
  driving aids. See below; LMU only

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


### MFD widget

A **read-only readout** of the in-game Multi-Function Display for the player's
car: two clearly headed sections, **PIT STRATEGY** and **DRIVING AIDS**, with
every row colour-coded by category — tyres, pressures, ducts, aero, fuel, brakes,
traction, engine, hybrid — so related lines read as a group at a glance. It
mirrors what you've set in-game; it does not change anything.

| Param         | Shows                                                                 |
| ------------- | --------------------------------------------------------------------- |
| `?pit=off`    | Hide the pit-strategy section (fuel, energy, tyres, wing, pressures, ducts, repairs) |
| `?aids=off`   | Hide the driving-aids section (brake bias, ABS/TC maps, engine, regen) |
| `?opacity=0.4`| Panel opacity, same contract as the Motion/Damage widgets             |

The MFD state rides along in the telemetry frame like every other widget (read
from LMU's REST garage API and projected in `src/telemetry/mfdControl.ts`), and
is overlaid even before a session's timing feed is live, so it works at the
garage/setup screen. **LMU only** — it shows "No MFD data" out of a session or on
rF2.

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
