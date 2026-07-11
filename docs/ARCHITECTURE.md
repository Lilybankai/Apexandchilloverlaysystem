# Architecture — Apex & Chill Overlay System

A lightweight overlay stack for live sim-racing streams. It reads telemetry from
**rFactor 2 / Le Mans Ultimate**, normalizes it, and renders branded broadcast
widgets that sit on top of the sim's own overlays in OBS.

The design has one overriding constraint from the brief: **stay light on a
streaming PC.** Overlay tools are notorious for eating CPU/GPU that the streamer
needs for the game and the encoder. Every choice below is made in service of
that.

---

## Data flow

```
  ┌──────────────────────────┐
  │  rFactor 2 / Le Mans      │   game process
  │  Ultimate                 │
  │   + rF2 Shared Memory     │   TheIronWolf plugin publishes named
  │     Map Plugin  (DLL)     │   memory-mapped buffers ($rFactor2SMMP_*$)
  └───────────┬──────────────┘
              │  shared memory (read-only)
              ▼
  ┌──────────────────────────────────────────────┐
  │  Telemetry provider           src/telemetry/  │
  │  ─────────────────────────────────────────────│
  │  TelemetryProvider (interface)   provider.ts   │
  │    ├─ SimulatorProvider      simulatorProvider │  synthetic demo feed
  │    └─ Rf2Provider            rf2Provider (E)    │  reads the MMF buffers
  │           + FuelCalculator   fuelCalculator (E) │  fuel/lap, laps-to-finish
  │                                                │
  │  Each poll() returns a normalized              │
  │  TelemetryFrame  (types.ts, schema v1)         │
  └───────────────┬────────────────────────────────┘
                  │  pull: server calls poll() at updateRateHz
                  ▼
  ┌──────────────────────────────────────────────┐
  │  Server  (single Node process)   src/server/  │
  │  ─────────────────────────────────────────────│
  │  index.ts     static HTTP + telemetry loop     │
  │  wsServer.ts  WebSocket broadcast (ws)          │
  │  config.ts    ports / rate / env overrides      │
  │                                                │
  │  • Serves overlay/ over HTTP (one port)        │
  │  • Broadcasts each frame as JSON over ws://…/ws │
  └───────────────┬────────────────────────────────┘
                  │  ws://127.0.0.1:8080/ws   (JSON TelemetryFrame @ 30 Hz)
                  │  http://127.0.0.1:8080/   (overlay assets)
                  ▼
  ┌──────────────────────────────────────────────┐
  │  Overlay (browser)              overlay/       │
  │  ─────────────────────────────────────────────│
  │  index.html   1920×1080 stage, 6 widget mounts │
  │  css/         theme tokens + layout            │
  │  js/client.js WS connect → parse → dispatch     │
  │  js/widgets/  standings · relative · weather ·  │
  │               tyres · fuel · pedals (Canvas)    │
  └───────────────┬────────────────────────────────┘
                  │  rendered as an OBS Browser Source (Chromium/CEF)
                  ▼
             Live stream
```

The pipeline is **one direction, one hop**: game → provider → WebSocket →
browser. There is no database, no message broker, no cloud round-trip.

---

## Components

### Telemetry provider (`src/telemetry/`)
- **`types.ts`** — the shared contract. `TelemetryFrame` (schema v1) is a fully
  **normalized, source-agnostic** snapshot: session, player car (pedals, gear,
  lap timing, 4-corner tyres), full-field `standings[]`, on-track `relative[]`,
  `weather` (+ forecast timeline) and computed `fuel` strategy. Units are
  display-ready (°C, seconds, litres, 0..1 inputs, −1..1 steering); unknown
  values use a `-1` sentinel so the wire stays plain JSON.
- **`provider.ts`** — the `TelemetryProvider` interface. The server uses a
  **pull model**: it calls `poll(nowMs, dtMs)` once per tick. Providers must
  never throw from `poll()` — on data loss they return a best-effort frame with
  `connected: false` instead of crashing the loop.
- **`simulatorProvider.ts`** — a synthetic feed (moving standings, oscillating
  pedals, evolving tyre temps/fuel/weather). Lets the overlay be built, tested
  and positioned with **no game running**.
- **`rf2Provider.ts` + `fuelCalculator.ts`** *(Task E)* — reads the rF2/LMU
  shared-memory buffers into a `TelemetryFrame` and computes the fuel strategy.
  Falls back to the simulator when the plugin/game is absent.

### Server (`src/server/`)
- **`index.ts`** — boots three things in one process: a tiny static HTTP server
  for `overlay/`, the WebSocket server, and the fixed-rate telemetry loop
  (`setInterval` at `updateRateHz`). `selectProvider()` chooses the live reader
  when the game is running and the simulator otherwise. The static server
  confines requests to the overlay directory (path-traversal guard).
- **`wsServer.ts`** — attaches a `ws` server to the same HTTP server (so OBS
  only needs one URL/port) and broadcasts each frame as JSON.
- **`config.ts`** — all tunables in one place, resolved from `APEX_*` environment
  variables over frozen defaults (host `127.0.0.1`, port `8080`, path `/ws`, rate
  `30 Hz`, clamped 1..120).

### Overlay (`overlay/`)
- **`index.html`** — a fixed **1920×1080 design stage** with six absolutely
  positioned, **opaque** widget panels mounted to match the LMU layout, plus a
  connection pill and brand wordmark. A tiny inline scaler fits the stage to any
  source size.
- **`css/theme.css`** — Apex & Chill design tokens: the cyan→purple→magenta
  gradient, near-black surfaces, and **Windows-native fonts** (Bahnschrift for
  condensed headings, Consolas for monospace data) so nothing is downloaded at
  runtime.
- **`css/overlay.css`** — widget positioning + component styles.
- **`js/client.js`** — connects to the WebSocket (URL derived from the page
  location), parses each `TelemetryFrame`, and dispatches it to every registered
  widget. Auto-reconnects with capped backoff; shows a DEMO badge when the feed
  is simulated.
- **`js/widgets/*.js`** — one self-contained module per widget, registered
  against the `window.ApexOverlay` runtime.

---

## Why it's lightweight (the "no Electron" rationale)

Resource use was the stated top concern, so the architecture optimises for it:

1. **No Electron for the overlay.** The overlay is plain HTML/CSS/JS rendered by
   the Chromium instance **OBS already runs** (its Browser Source / CEF). We ship
   zero extra browser runtime. Bundling an Electron app would mean a *second*
   full Chromium + Node process resident the entire stream — the most common
   reason overlay tools are heavy. We simply don't.
2. **A single small Node server.** Static file serving, the WebSocket, and the
   telemetry loop all live in one process on one port. No framework, no bundler
   at runtime — just Node's `http` + `ws`.
3. **Pull-based providers, one clock.** The server ticks once per broadcast and
   pulls a frame; providers hold no internal timers or event emitters. Frame
   production is allocation-light and easy to reason about.
4. **Bounded broadcast rate.** 30 Hz by default (configurable, clamped 1..120) —
   smooth pedal traces without flooding the socket or the render thread.
5. **Render discipline in the widgets.** Widgets that don't need 30 Hz
   (standings, relative, weather, tyres, fuel) are **throttled** and use keyed
   DOM reconcilers that touch only changed text; only the pedal trace runs every
   frame, and it draws two short polylines from a fixed-size ring buffer on a
   `<canvas>`. No per-frame framework re-render, and **no `backdrop-filter`/blur**
   (expensive to composite live) — panels use solid backgrounds, which also
   satisfies the "cover the sim's overlay" requirement.
6. **No web fonts / no network.** Windows-native fonts and self-contained assets:
   the overlay never phones home.

### Telemetry mechanism
rFactor 2 and Le Mans Ultimate (both on the S397/rF2 engine) expose telemetry
via the **rF2 Shared Memory Map Plugin** (`rFactor2SharedMemoryMapPlugin64.dll`,
by TheIronWolf) — the "rfactor telemetry.dll" from the brief. It is dropped into
the sim's `Plugins/` folder and enabled in config; it publishes named,
paging-file-backed memory buffers (`$rFactor2SMMP_Telemetry$`, `_Scoring$`,
`_Weather$`, `_Extended$`, …). Our app is a pure **consumer**: it opens those
buffers read-only and maps the structs into `TelemetryFrame`. No game modding
beyond installing the plugin. (Reader implementation and the torn-read guard live
in `rf2Provider.ts`, Task E.)

---

## Extending it

- **New widget:** add `overlay/js/widgets/<name>.js` that registers against
  `window.ApexOverlay`, add a mount `<section data-widget="<name>">` to
  `index.html`, and (if needed) new fields to `TelemetryFrame` — bump
  `TELEMETRY_SCHEMA_VERSION` on any breaking change.
- **New telemetry source:** implement `TelemetryProvider` and wire it into
  `selectProvider()`; nothing downstream changes.

## Future work
- A native (C#/.NET or Rust) shared-memory reader would idle even lighter than
  Node; revisit only if resource use becomes an issue — Node + no-Electron
  already meets the brief.
- Tighten the two signed-field sentinels (`LapTiming.delta`,
  `FuelState.fuelDeltaLiters`) in a v2 schema if exact `-1.0` values ever matter.
