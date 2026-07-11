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

## Why it stays light

Overlay tools are notorious for being heavy. This system deliberately avoids
Electron: the only always-on process is a small Node server. Rendering happens
inside the Chromium instance **OBS already runs** for Browser Sources, so there
is no second browser/renderer. Telemetry is broadcast as compact JSON at a
configurable rate (default 30 Hz).

## Overlays

Positioned to sit on top of the LMU/RaceLab HUD with solid, opaque backgrounds:

- **Standings** (top-left) — full field, gaps, pit status
- **Relative / timing** (top-right) — nearest cars on track, live delta
- **Pedal inputs** (bottom-center) — throttle/brake trace, trail-braking style
- **Tyre temps** — four-corner temperatures
- **Weather forecast** — current + short forecast
- **Fuel calculator** — per-lap use, laps remaining, fuel-to-finish, pit window

## Requirements

- **Node.js 18+** (server runtime)
- **rF2 Shared Memory Map Plugin** (`rFactor2SharedMemoryMapPlugin64.dll`)
  installed in the sim's `Plugins/` folder for live data. Without it, the server
  automatically falls back to a built-in **simulator** so the overlays still run.

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
