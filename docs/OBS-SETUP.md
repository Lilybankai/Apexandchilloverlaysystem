# OBS Setup — Apex & Chill Overlay

This guide adds the Apex & Chill race overlay to OBS Studio as a **Browser
Source** and positions it over the sim's own overlays (Le Mans Ultimate /
rFactor 2). It takes about two minutes.

> The overlay is served by a small local Node server. It does **not** connect to
> the internet and does **not** use Electron — it renders inside OBS's built-in
> Chromium browser, which is the single biggest reason the tool stays light on a
> streaming PC. See [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 1. Start the overlay server

Double-click **`scripts\launch.bat`** (or run it from a terminal).

- On the **first run** it installs dependencies automatically (needs
  [Node.js 18+](https://nodejs.org/)).
- It then builds and starts the server and prints the URL to use in OBS:

  ```
  OBS Browser Source URL (size 1920 x 1080):
      http://127.0.0.1:17080/
  ```

Leave that window open while you stream. Press **Ctrl+C** in it to stop.

**Options**

| Command | Effect |
|---|---|
| `launch.bat` | Start on the default port `17080`. |
| `launch.bat 9000` | Start on a custom port (if `17080` is taken). |
| `launch.bat sim` | Force the built-in **demo/simulator** feed — useful for setting up and positioning the overlay with no game running. |

The server auto-detects the game when it is running (via the rF2/LMU shared-memory
plugin) and falls back to the simulator feed otherwise, so the overlay always
shows data.

---

## 2. Add the Browser Source in OBS

1. In your scene, click **+** under *Sources* → **Browser**.
2. Name it `Apex Overlay` → **OK**.
3. Set the properties:

   | Field | Value |
   |---|---|
   | **URL** | `http://127.0.0.1:17080/` (match the port from the launcher) |
   | **Width** | `1920` (**`3840` if you stream or record at 4K** — see below) |
   | **Height** | `1080` (**`2160` if you stream or record at 4K**) |
   | **Use custom frame rate** | ✅ enabled |
   | **FPS** | `30` (matches the telemetry broadcast rate) |
   | **Shutdown source when not visible** | ✅ recommended (saves resources) |
   | **Refresh browser when scene becomes active** | ✅ recommended |

   > **Note:** *Shutdown when not visible* is ideal for **scene-based** use — the
   > server replays the latest frame on connect and the overlay reconnects in
   > well under a second, so switching scenes repopulates instantly. If instead
   > you frequently toggle the **overlay source's own visibility** mid-scene,
   > turn this **off** to avoid a brief reconnect/repopulate flash each time.

4. Leave the custom CSS box **empty** — the overlay ships its own styling.
5. Click **OK**.

The overlay canvas is a fixed **1920×1080** design that scales to the source
size, so the six widgets keep their positions at any output resolution. If you
stream at 1080p, size the source to fill the canvas exactly.

### Match the source size to your output resolution

The design canvas is 1920×1080, but the **Browser Source size is what the page
is actually rendered at** — set it to your output resolution, not to the design
size. A 1920×1080 source on a 4K canvas hands OBS a 1080p image to stretch to
2160p, and no amount of bitrate recovers detail that was never rendered. It is
the one setting that decides whether the overlay is sharp on a big screen.

| Streaming/recording at | Width | Height |
|---|---|---|
| 1080p | `1920` | `1080` |
| 1440p | `2560` | `1440` |
| 4K | `3840` | `2160` |

Nothing else changes: the page scales the 1920×1080 design to whatever size the
source is, so every widget keeps its position and proportions, and the text and
the drawn widgets (track map, radar, pedal traces) are both rendered at the full
source resolution.

---

## 3. Position over the sim's overlays

The Apex widgets are laid out to sit **directly on top of** the equivalent
Le Mans Ultimate / RaceLab overlays, and each panel has a **solid, opaque
background** so it fully covers whatever is underneath:

| Widget | Position | Covers |
|---|---|---|
| **Standings** | Top-left | LMU timing tower |
| **Weather** | Top-centre | Weather / forecast strip |
| **Relative + Timing** | Top-right | Lap / last / best / delta block |
| **Fuel** | Mid-right | — (strategy readout) |
| **Tyres** | Bottom-right | Tyre-temp readout |
| **Pedals (trail-brake trace)** | Bottom-centre | Pedal-input HUD |

Because the whole source is one 1920×1080 canvas aligned to the stream frame,
you normally **do not need to move or resize** it — just drop it in at the top
of your scene's source list so it draws above the game capture. If a sim overlay
peeks out at the edges, nudge that widget by tweaking its position in
`overlay/css/overlay.css` (the `#widget-*` rules).

> **Tip:** run `launch.bat sim` and compare against a reference screenshot while
> you fine-tune positions, then switch back to the live feed for the stream.

---

## 4. Verify it's working

- With the server running, open `http://127.0.0.1:17080/` in any browser — you
  should see the six branded panels.
- The small pill at the top-centre shows the link state: **LIVE** (connected),
  **CONNECTING**, or **RECONNECTING**.
- A coral/red **DEMO DATA** badge appears when the feed is simulated (game not
  running or `launch.bat sim`); it disappears once a real sim is detected.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Panels show "Awaiting telemetry…" and the pill says **RECONNECTING** | The server isn't running, or OBS is pointed at the wrong port. Check the launcher window and the Browser Source URL. |
| `launch.bat` closes instantly | Node.js isn't installed or isn't on PATH. Install the LTS build and retry. |
| Port already in use | Start on another port: `launch.bat 9000`, and set the OBS URL to `http://127.0.0.1:9000/`. |
| Overlay looks offset at the edges | Make sure the Browser Source is 1920×1080 and your canvas/output is 16:9. |
| Live game not detected | Confirm the rF2/LMU shared-memory plugin is installed and enabled (see [ARCHITECTURE.md](./ARCHITECTURE.md)); the overlay keeps showing simulator data until then. |
