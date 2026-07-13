# Changelog

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
