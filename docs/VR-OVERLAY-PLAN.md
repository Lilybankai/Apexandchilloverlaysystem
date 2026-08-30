# VR Overlay Plan — Apex & Chill in the headset

**Status:** proposal, 2026-08-12. Nothing here is built yet.
**Goal:** a driver wearing a VR headset in Le Mans Ultimate sees the Apex & Chill
in-game widgets inside the headset — without hurting frame rate, without adding
any cost for non-VR users, and without ever touching the game process (EAC).

---

## Why the current overlay is invisible in VR

The in-game layer is a transparent always-on-top **desktop window**. In VR the
driver isn't looking at the desktop — the game renders directly to the headset
through the VR compositor. Our window still draws (over the flat mirror window),
but the headset never sees it. To appear in VR, our pixels must be handed to the
**VR compositor** itself, which composites them over the game every headset frame.

There are only two ways to do that, and the choice is the whole plan:

| | A. SteamVR overlay (`IVROverlay`) | B. OpenXR API layer (OpenKneeboard-style) |
|---|---|---|
| Where our code runs | **Our own process** — talks to the SteamVR compositor | A DLL **loaded inside the game process** |
| Anti-cheat exposure | **None.** The game process is untouched | Exactly the class EAC blocked in LMU (Dec 2025, OpenXR Toolkit) until Epic whitelisted it |
| Works when | SteamVR is the compositor (LMU's official "SteamVR" launch option, or SteamVR set as the OpenXR runtime) | Any OpenXR runtime, incl. Oculus/PimaxXR/VDXR |
| Maturity | First-class Valve API, used by Desktop+, OVR Toolkit, XSOverlay, SimHub VR, RaceLab's OpenVR path | Doable (OpenKneeboard, RaceLab's OpenXR path) but heavy: native DLL, D3D hooking, per-game quirks |

**Decision: build on A.** LMU is an OpenVR (rF2-engine) title whose official VR
path since v1.0 *is* SteamVR, and A carries zero anti-cheat risk — the same
reason our telemetry reader (shared memory, like Crew Chief/SimHub) has
coexisted with EAC since v1.2. B is deferred to a possible Phase 5 and would
require a whitelisting conversation with Studio 397/Epic first.

The known cost of choosing A: a user who launches LMU with `+VR` targeting a
**non-SteamVR** OpenXR runtime (Meta's runtime, PimaxXR, VDXR) won't see
SteamVR overlays. Mitigation is documentation, not code: every PC VR headset
can use SteamVR, and RaceLab's LMU users are steered the same way. We say
plainly in the panel: *"VR overlays need SteamVR."*

### LMU facts this rests on (researched 2026-08-12)

- VR beta Sep 2024 (`+VR` launch option); **v1.0 (Jul 2025)** made "SteamVR" an
  official Steam launch choice; **v1.4 (Jul 2026)** added an OpenXR path via an
  **OpenComposite** translator Studio 397 ships inside the game.
- **EAC (kernel-level) since v1.2 (Dec 2025).** Online requires the protected
  launcher; `Le Mans Ultimate.exe +VR` directly bypasses EAC = offline only.
- Dec 2025 precedent: EAC **blocked OpenXR Toolkit** (in-process API layer) at
  v1.2 launch; restored ~24 Dec only after Epic whitelisted the DLLs. In-process
  injection in LMU is whitelist-gated, not safe-by-default.
- LMU is **D3D11**, and RaceLab's compatibility docs confirm LMU VR overlay
  support works today (their note: "this game always uses OpenComposite").

### The performance model (why VR does NOT mean heavy)

The compositor **re-samples every overlay quad at headset refresh rate no
matter how often we update its texture**. Head tracking stays perfectly smooth
even if our widget content updates at 10–15 fps. This is the industry pattern:
OVR Toolkit cut idle updates to 30 fps for exactly this reason; OpenKneeboard's
FAQ states the only real recurring cost is the compositor blending the extra
layer. So the budget levers are:

1. **Few quads.** Each overlay = one compositor blend per eye per frame. We
   merge widgets onto **1–3 panels**, not one overlay per widget.
2. **Low content rate.** Offscreen page capped at 10–15 fps and dirty-rect
   driven — a static standings panel costs ~zero between changes.
3. **Zero-copy textures** (Phase 3): Electron 33.2's `useSharedTexture` paints
   straight into a GPU texture that SteamVR can consume — no CPU pixel copies.

---

## Architecture

Everything upstream is untouched — same server, same WebSocket, same widgets.
VR is a **second presentation target** for the page we already have:

```
                       (unchanged)
game ─ shared memory ─→ provider ─→ ws://127.0.0.1:17080/ws
                                         │
             ┌───────────────────────────┴────────────────┐
             ▼                                            ▼
   in-game window (desktop)                 vr.html in an OFFSCREEN
   ingame.html — exists today              BrowserWindow (never shown,
                                           frameRate capped ~15)
                                                  │ paint frames
                                                  ▼
                                        VR bridge (electron/vr/)
                                        koffi → openvr_api.dll
                                        IVROverlay: 1–3 quads
                                                  │
                                                  ▼
                                        SteamVR compositor → headset
```

- **`overlay/vr.html`** — a sibling of `ingame.html` that mounts the *same*
  widget modules, but grouped into panel-sized stages (one DOM region per VR
  panel). Widgets need no changes; this is layout + which-widgets config.
- **VR bridge (`electron/vr/`)** — lazy-required module in the Electron main
  process. Binds `openvr_api.dll`'s flat C API with **koffi** (already a
  dependency; same optional-degrade pattern as `lmuLocalCar.ts` — no VR, no
  SteamVR, koffi missing → clean no-op). Creates one overlay handle per panel,
  sets HMD-relative transforms, pushes frames.
- **Texture path, two stages:**
  - *Prototype:* offscreen **bitmap** `paint` events → `SetOverlayRaw` (CPU
    pixels). Simplest possible; known caveat that raw/unshared submission can
    flicker or stall after long runs — acceptable for a spike, not for release.
  - *Production:* `offscreen: { useSharedTexture: true }` → the `paint` event
    hands a **D3D11 shared texture handle** → a tiny native piece imports it and
    calls `SetOverlayTexture` with a `D3D11_RESOURCE_MISC_SHARED` texture (the
    documented-reliable path). This is the one place a compiled native addon may
    be unavoidable (D3D11 device + handle import); model it on `electron-spout`,
    ship it prebuilt, keep it optional at runtime like koffi.

### Panels (initial set — merge, don't sprawl)

The MVP widget set is decided (Carl, 2026-08-12): **relative, radar, delta,
speedo, fuel, tyres, standings.**

| Panel | Widgets | Default placement | Update feel |
|---|---|---|---|
| **Cluster** | speedo, delta, fuel, tyres | low-center, like a dash extension | the "fast" panel — drives the 15 fps cap |
| **Race** | relative, radar | left or right of center, eye height | mostly event-driven |
| **Standings** | standings | opposite side from Race, eye height | changes a few times a lap |
| **Alerts** (later) | race control flags, damage, MFD | top edge, small | appears on event, else hidden |

Standings is the legibility risk on a Quest 2 (full-field text through Link
compression). Plan for a **condensed VR variant** — leader window + the cars
around you in class — sized by what Phase 0 shows; full-field stays available
if it proves readable.

Head-locked (HMD-relative) transforms first — that's the mode SteamVR does
rock-solid (RaceLab documents world-locked "floatiness" as a SteamVR-side
limitation, not fixable from outside). Seat-fixed/world-locked is a later
experiment, not the MVP.

### Guardrails (non-negotiable constraints)

- **Zero weight for non-VR users.** The bridge and the offscreen window exist
  only when the user flips a **VR toggle (default OFF)** in the control panel
  *and* SteamVR is actually running. Detection is polling for the `vrmonitor.exe`
  process (cheap, out-of-process) — **not** repeated `VR_Init`/`VR_IsHmdPresent`
  calls, which are documented to leak. Toggle off / SteamVR gone → offscreen
  window destroyed, DLL binding dropped. No VR code on any hot path otherwise.
- **Never in the game process.** No injection, no API layers, no hooks — ever,
  in any phase we ship without Studio 397's blessing.
- **Perf budget:** ≤ ~1% extra CPU on the tester's rig with all 3 panels live, and
  no measurable headset fps change vs overlays-off. Measured, not assumed —
  fpsVR / SteamVR's own frame timing graph before/after in the same session.
- **Auto show/hide rides the existing on-track signal** (gamePhase + realtime
  byte) — panels vanish in menus/garage exactly like the desktop layer.

---

## Phases

### Phase 0 — Prove the concept with zero code (tester, ~an evening)
Use existing free tools to validate every risky assumption on the one VR rig we
have, before writing anything.

**The rig: Meta Quest 2.** PCVR on a Quest is streamed — Link cable, Air Link,
Virtual Desktop, or Meta's Steam Link app — and our overlays appear only when
**SteamVR is the compositor**. The trap specific to this headset: Meta's own
OpenXR runtime is the default on a Link install, and Virtual Desktop defaults
to its own (VDXR); LMU launched `+VR` through either bypasses SteamVR entirely
and no SteamVR overlay can ever appear. So the setup step is not optional
hygiene, it is the test:

1. Tester connects via Link cable (most stable; Air Link/Steam Link fine) and
   runs LMU **online (EAC active)** via the **"SteamVR" launch option** in
   Steam's launcher picker.
2. Install **Desktop+** (free, open-source SteamVR overlay) and pin a region of
   the desktop showing our *current* in-game overlay window into the headset.
3. Record: does it render over LMU? EAC objections? fpsVR CPU/GPU frame-time
   cost with the panel visible vs hidden — noting the Quest's Link encoder is
   already eating PC headroom, so this is the strict version of the perf test?
   Is 30 fps-ish desktop capture legible at cockpit distance *through the Link
   video compression*? (Quest 2 is 1832×1920/eye plus stream compression — fine
   text will smear; this calibrates how hard Phase 2's type bump must go.)

**Exit criteria:** overlay visible over online LMU, no EAC complaint, compositor
cost acceptable. This de-risks the entire plan for the cost of an email to the
tester. (It's also the interim workaround we can document for VR users today.)

### Phase 1 — Bridge spike: our pixels in the headset (1–2 weeks dev)
- koffi binding of `openvr_api.dll` (init as `VRApplication_Overlay`,
  `IVROverlay` FnTable): create one quad, HMD-relative, show a static PNG.
- Add offscreen `BrowserWindow` loading a stripped `vr.html` (relative +
  speedo), bitmap `paint` → `SetOverlayRaw` at 10 fps.
- Dev harness: SteamVR **null driver** (headsetless) on the dev box renders the
  compositor view in a flat window — most iteration needs no headset and no sim
  (demo telemetry feed already exists).
- **Exit criteria:** live demo-feed widgets visible in the null-driver
  compositor; a build the tester can run; note any `SetOverlayRaw`
  flicker/stall over a 1-hour soak.

### Phase 2 — MVP the tester can race with (2–3 weeks dev)
- `vr.html` panel layout: Cluster + Race + Standings panels, same widget
  modules (standings gets its condensed VR variant here if Phase 0 says so).
- Control panel: **VR section** — enable toggle, per-panel widget pick, panel
  size/distance/height presets (positioning via the desktop panel; in-VR
  drag-editing is out of scope for MVP).
- Lifecycle: SteamVR detection, lazy create/destroy, auto show/hide on-track,
  settings persistence, F8-family hotkey parity.
- Ship on the **beta channel** to the VR tester; iterate on legibility (panel
  scale, font sizes at VR resolution — likely need a 1.25–1.5× type bump).
- **Exit criteria:** tester completes real online race stints using it; perf
  budget held on their rig; no EAC incidents.

### Phase 3 — Performance hardening (production texture path)
- Swap bitmap `paint` for `useSharedTexture: true` and the native
  D3D11-shared-handle → `SetOverlayTexture` piece (prebuilt binary, runtime
  optional). Kills the CPU copy and the raw-path flakiness in one move.
- Dirty-region discipline in `vr.html` (widgets already reconcile minimally);
  verify near-zero paints when nothing changes.
- Perf telemetry: log our own CPU + paint rate while VR is on, so tester
  reports come with numbers.
- Soak test: full race distance, texture-handle leak check (`texture.release()`
  discipline), SteamVR restart / headset standby recovery.
- **Exit criteria:** measured ≤1% CPU with all 3 panels; 4-hour soak clean.

### Phase 4 — Comfort & reach (each item optional, ordered by value)
- Gaze-fade (panel goes translucent unless looked at — RaceLab's signature VR
  comfort feature; HMD pose is available from the same API).
- World/seat-locked placement experiment; per-car saved layouts.
- Alerts panel (race control / damage) with show-on-event.
- rF2 support check (same engine, same OpenVR runtime — likely free).
- Public beta beyond the one tester.

### Phase 5 — deliberately NOT now: OpenXR API layer
Only if real users are stuck on non-SteamVR runtimes *and* Studio 397/Epic will
whitelist us. In-process DLL, D3D11 hook at `xrEndFrame`, OpenKneeboard as the
reference. This is a separate project with an anti-cheat conversation as its
first milestone — never ship it quietly.

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `SetOverlayRaw` flicker/stall in long sessions (documented) | Medium | Prototype-only; Phase 3 shared-texture path is the fix. If it bites the MVP, pull Phase 3's native piece forward |
| koffi can't cleanly call the IVROverlay FnTable | Low-Medium | FnTable is plain C function pointers (koffi handles these); fallback is moving the whole bridge into the Phase 3 native addon a phase early |
| Tester's Quest 2 defaults to the Meta/VDXR runtime, not SteamVR | High (it's the default) | Phase 0 step 1 is literally "use the SteamVR launch option"; document it as *the* setup requirement for Quest users |
| Quest 2 legibility (per-eye res + Link stream compression) | High | Phase 0 measures it; Phase 2 type bump treated as a floor, panels kept large and sparse |
| EAC posture changes | Low | We are out-of-process by design; shared-memory reading already has 8 months of EAC coexistence |
| Native addon build/distribution pain (Phase 3) | Medium | Prebuilt for win-x64 only (all sim VR is win-x64); runtime-optional like koffi; electron-spout as the template |
| VR legibility needs real design work | High (certain) | Budgeted in Phase 2; panels get their own type scale |

## Decisions from Carl (2026-08-12)

- **Tester hardware: Meta Quest 2** — Phase 0 written around it above. The
  strictest reasonable test rig: streamed compositor, encoder overhead, and
  compression-limited legibility. If the budget holds there, it holds anywhere.
- **VR is eventually a main, stable-channel feature** — not a beta perk. So the
  channel path is: Phases 1–2 live on **beta**, and **Phase 3 (zero-copy
  texture path + soak) is the gate to stable**. The `SetOverlayRaw` prototype
  path never ships to stable.
- **MVP widgets: relative, radar, delta, speedo, fuel, tyres, standings** —
  grouped onto the three panels above. Standings carries the condensed-variant
  caveat.

No open questions — the plan is ready for Phase 0.
