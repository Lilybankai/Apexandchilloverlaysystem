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
  │               tyres · fuel · pedals · radar     │
  │               (Canvas) · limits                 │
  │  js/audio.js  synthesised cues (no assets)      │
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
- **`lmuTraceLimits.ts` + `trackLimits.ts`** — the track-limits pair. The first
  tails the game's own trace log for the stewards' **points**: what each cut was
  charged, and the discharge when the allowance earns its drive-through. It is
  the only live source for those numbers anywhere — shared memory and the REST
  API publish the consequence and never the total (see
  `docs/TRACK-LIMITS-POINTS.md`). The second is what is left of a geometric
  excursion detector that reconstructed those points from `mPathLateral` /
  `mTrackEdge` before the real ones were reachable: now just the penalty count's
  two edges (issued, served), which is pure logic with real edges in it and
  belongs under a headless test (`scripts/test-tracklimits.js`) rather than
  behind a Windows-only read. All three providers share it; the simulator
  fabricates the trace half so the widget's states are reachable in demo mode.
- **`lapLog.ts`** — the lap database. Watches the driven car's completed-lap
  count and appends one record per lap to `~/.apex-overlay/laps/<date>.jsonl`:
  track, car, class, the **sim's own** lap time, conditions, and whether the lap
  was clean. Also owns the rolling-window summary the control panel's "Your week"
  card reads back.

  Two deliberate splits. **Detection is pure** — the recorder does no file IO, so
  a whole stint can be scripted headlessly (`scripts/test-laplog.js`) — and
  **nothing here touches the network**: laps land on disk, and uploading them
  later belongs to the desktop app, which is the half of the system that holds
  the account. That keeps a race weekend with no internet counting, keeps
  headless `npm start` runs counting, and keeps the eventual cloud tables holding
  aggregates rather than four hundred practice laps.

  Cleanliness is **our rule, not the sim's** — LMU publishes no per-lap validity,
  only `mNumPenalties` once a penalty has landed — so it is defined in one place
  and labelled as the league's rule wherever it is shown.

  It also owns `buildUploadPlan()` / `diffPlan()`: what the league database
  *should* hold given these files, and what of that has not been sent. Those are
  pure, so `scripts/test-lapupload.js` can exercise the whole decision without a
  network. `electron/lapUpload.js` adds only HTTP and a timer.

  **There is no queue and no cursor.** Both server RPCs are idempotent — the day
  counter keeps the greater value, a best lap only replaces a slower one — so the
  client recomputes the desired state and sends it rather than maintaining a
  position in a stream that can desync from the data. `lap-sync.json` is a cache
  that stops redundant re-sends; deleting it costs bandwidth, never correctness.

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
- **`js/audio.js`** — the cue engine: three short tones, **synthesised** with an
  oscillator and a gain envelope rather than shipped as sound files. Same
  rationale as the no-Electron and no-web-fonts choices above — an asset would
  be fetched, decoded and held resident by every Browser Source in a scene and
  by the in-game layer for a whole stint, where a cue costs two Web Audio nodes
  that are created, played and thrown away. On/off and volume ride the
  appearance channel with the other operator settings.
- **`js/appearance.js`** — applies the operator's global widget-background
  setting as the `--panel-alpha` token every surface colour in `theme.css`
  resolves through. Loaded synchronously in `<head>` so the value is in place
  before the first paint. A widget named in `widgetOpacity` opts out of that
  global and gets its own alpha written onto its own section instead — which
  means re-declaring the surface tokens there, since a custom property resolves
  where it is *declared*, not where it is used (see the `[data-alpha="own"]`
  block in `theme.css`, a deliberate mirror of the `:root` one). Like the
  sponsor manifest this is operator
  configuration fetched over HTTP (`/appearance.json`), never telemetry — the
  in-game layer is pushed it over IPC instead, so the layer that draws over the
  sim does no polling at all.

### Control panel (`electron/control-panel/`)

Plain HTML wired up by id — no framework, and deliberately so: the panel's CSP is
`default-src 'none'` with `script-src 'self'`, so nothing can be fetched at
runtime, and the app sits beside a running sim where a second framework runtime
earns nothing.

- **`index.html`** — the Hub shell: one `.nav`, one scrolling `.content` holding
  six `[data-view]` sections, one `.foot`. Only the active view is displayed, so
  switching tabs is a class change, never a page load — a reload would drop the
  status WebSocket and flash the window black.
- **`hub.css`** — the shell, ported from the design system's Hub kit
  (`ui_kits/hub/`). That kit is React + Lucide over a CDN and cannot load here, so
  its **structure and CSS** are ported and driven by the vanilla renderer instead.
  Selector names match the kit so the two read side by side; values resolve through
  `control-panel.css`'s logo-native tokens.
- **`control-panel.css`** — the components (`.card`, `.field`, `.switch`, `.btn`).
  These were **not** renamed during the reskin: restyling them in place is what
  let every control keep its id and its wiring.
- **`icons.js`** — one inlined SVG sprite shared with `auth.html`, injected as the
  first thing in `<body>`. A `<use>` whose target does not exist at parse time
  renders nothing at all, so load order is load-bearing.
- **`scripts/test-panel-parity.js`** — the guard on all of the above. It asserts
  every id the JS looks up exists, none is duplicated, no wired control changed
  element type, and every icon reference resolves. Run it after touching panel
  markup: a control that silently stops working still *looks* perfect, and neither
  a typecheck nor a screenshot catches it.

### Accounts (`electron/auth.js` + `electron/control-panel/auth.*`)

Supabase-backed accounts, with one hard rule: **the renderer never talks to
Supabase and never holds a token.**

- `electron/auth.js` runs in the **main process** and owns everything — the
  GoTrue REST calls (plain `fetch`, no SDK), validation, refresh-token rotation,
  and the session file at `<userData>/session.json` (written only when *Remember
  me* is ticked). It is the only module that knows the project URL and key.
- The renderer gets a narrow IPC surface (`window.apex.auth.*` from
  `preload.js`) whose results are `{ ok, error?, field? }` plus a sanitised user
  object — `publicUser()` builds it field by field, so a token cannot leak into
  the DOM by accident. `scripts/test-auth.js` asserts that.
- Two forces this shape: the panel's CSP is `default-src 'none'`
  (`script-src 'self'`), so no CDN bundle can load and no renderer fetch can
  leave the page; and keeping refresh tokens out of a renderer means an XSS in
  the panel cannot exfiltrate a long-lived credential.
- The **window is the router**: one `BrowserWindow` loads either `auth.html` or
  `index.html`, and main swaps it (`loadPage`) on sign-in, sign-out, or
  "Continue offline". Nothing about the telemetry server or the in-game layer
  depends on account state — the app is fully usable signed out, by design.
- **Password reset uses a code, not a redirect**, because there is no companion
  web page for a recovery link to land on. `parseRecoveryToken()` accepts either
  a one-time code or a pasted reset link, and `verifyRecovery()` tries both
  GoTrue token fields (`token` vs `token_hash`) rather than betting the flow on
  which template the project is using.

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

### The radar's spatial data (why it's different)
Every other widget runs on normalized, largely 1-D channels (a gap in seconds, a
lap distance). The **radar** is the exception: telling a car alongside on your
*left* from one on your *right* needs true 2-D position, which no gap carries.
So `telemetry/radar.ts` reads each car's **world position** (`mPos`) and the
driven car's **orientation matrix** (`mOri`) straight from shared memory — the
same block the motion widget uses — and projects every car into the player's own
left/right–ahead/behind frame. It owns that axis convention the way
`telemetry/motion.ts` owns its signs (a flipped sign would put a left-side pass
on your right), and is unit-tested headless in `scripts/test-radar.js`. Both live
providers feed it from the telemetry buffer they already map; the simulator
places its synthetic field on an ellipse and runs the **real** projection, so a
sign regression surfaces in demo mode rather than on track. The result rides the
frame as the optional `radar` field — omitted, like `motion`, whenever there's no
driven-car physics (spectating).

## Future work
- A native (C#/.NET or Rust) shared-memory reader would idle even lighter than
  Node; revisit only if resource use becomes an issue — Node + no-Electron
  already meets the brief.
- Tighten the two signed-field sentinels (`LapTiming.delta`,
  `FuelState.fuelDeltaLiters`) in a v2 schema if exact `-1.0` values ever matter.
