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

The control panel is built to the Apex & Chill design system's Hub layout — a
tabbed top nav, a card grid, and a status bar along the bottom:

- **Dashboard** — the server, the feed and the in-game layer at a glance: feed
  state, the address overlays are served at, update rate, how many widgets are
  on, plus the **Show in game** switch, **Edit layout** and the toggle hotkey.
- **Overlays** — one card per widget. Each has two independent destinations:
  **OBS** (its Browser-Source URL, with copy and preview) and **In game** (the
  on-screen layer). A widget can be on in one and off in the other. The
  all-in-one page URL and the sponsor rotator live here too.
- **Settings** (the gear, top right) — **Server** (port, update rate, demo mode,
  track-limits threshold), **Appearance** (widget background, text size, radar car
  size — all applying live), **Audio & feedback** (cues, volume, change glow) and
  **Bindings** (keyboard and wheel).
- **Leaderboard · Setups · Suggestions** — not built yet; each says so and lists
  what is coming. **Training** mode is shown in the top-right toggle but disabled
  for the same reason.
- **Status pill** — LIVE / DEMO DATA / NO DATA / STOPPED at a glance, mirrored in
  the footer along with the port and the running version.

The chosen tab is remembered between launches. Update and error banners sit above
the tabs rather than inside one, so a failed server start is visible wherever you
happen to be.

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

### Accounts

The app opens on the **account screens** — sign in, create account, or reset a
password — implemented from the Apex & Chill design system (Hub kit). An account
is what will carry your lap database, leaderboard entries and settings between
PCs; **Continue offline** skips it entirely and every overlay still works. That
choice is remembered, and the top bar keeps a **Sign in** button for later.

Accounts live in Supabase (project `Apexoverlaysystem`). Two things are worth
knowing about how it is wired:

- **All Supabase traffic happens in the Electron main process** (`electron/auth.js`),
  never in the renderer. The panel's CSP is `default-src 'none'`, and access and
  refresh tokens never cross the preload bridge — the renderer only ever receives
  a sanitised user object. The session is stored at
  `%APPDATA%/apex-overlay-system/session.json`, and only when **Remember me** is
  ticked.
- **Password reset is a code, not a link.** A desktop app has no web page for a
  recovery link to land on, so the reset screen asks for the code from the email
  (it also accepts the whole link pasted in, and pulls the token out). For a plain
  code to arrive, the recovery email template needs `{{ .Token }}` in it —
  Supabase dashboard → *Authentication → Emails → Reset password*.

Signing up creates a row in `public.profiles` (display name, primary sim,
email opt-in) via the `on_auth_user_created` trigger. RLS lets a driver read and
write only their own row.

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
- **Radar** — a spotter's-eye strip of the cars around you, drawn to scale, plus
  the pit-release light (see below)
- **Track limits** — excursions this session, the sim's own penalties, and how
  much road you have left right now (see below)
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
| `?icons=50`   | Pins icon size, 30..150%, for this source only — otherwise it follows the control panel's **Radar car size** slider |
| `?range=18`   | Longitudinal range each way, metres (clamped 8..150) — the same knob from the other end; wins over both of the above |
| `?reveal=<m>` | Replaces the fade-perimeter reveal with a plain distance gate (metres) |
| `?opacity=0.4`| HUD opacity, same contract as the Motion/Damage widgets                |

**The scale is isotropic and the cars are drawn at their real size.** One metre
is the same number of pixels across the strip as up it, and each icon is its
car's true footprint — 5.10 × 2.00 m for a Hypercar, 4.76 × 2.05 m for a GT3. So
**icons touching means cars touching**, on both axes and at any angle between
them, whatever the range is set to and however large the widget has been dragged.

**Icon size and range are one control, deliberately.** The control panel's
**Radar car size** slider (30–150%, default 50%) sets the display range: 100% is
the classic 18 m, 50% is 36 m and so half-size cars. It is not a multiplier laid
over the geometry — that is exactly the fixed-pixel icon this widget was rebuilt
to get rid of, and it would break the property above. Zooming out shrinks the
cars *and* the metres they stand on together, so contact still reads true at
every setting. The lateral half-width follows from the range and lands at about a
track width (~13 m) at 100%. It rides the appearance channel with the background
and text sliders, so one drag retunes every live source, in game and in OBS.

**Opponents fade with distance**, and the whole-HUD reveal is tied to the same
perimeter: the HUD wakes the moment a car crosses the ring, which is exactly when
that car's icon starts fading up from nothing. The fade starts at your own icon's
centre line and reaches nothing at **6 car lengths** fore and aft and **4.5 car
widths** to each side (≈29 m and ≈9 m for a GT3) — an ellipse in metres, so a car
coming diagonally fades on the same curve as one up the inside. Six lengths is
about two seconds of run-up at a modest closing speed; sideways stays tighter
because past four car widths you are looking at the far side of the track, not at
anyone who can hit you.

A car arriving alongside lights a soft red bloom on that side, anchored at the
car's own position up the strip, brightest level with it, decaying to nothing
exactly on your centre line, and feathered at every edge so nothing it draws ends
on a hard line.

Faster-class cars carry a halo ring; a car you are lapping draws as a ghost.
Blip positions come from `src/telemetry/radar.ts`, which owns the world→local
projection and is unit-tested headless in `scripts/test-radar.js`.

**The pit release lives here too** — the pit-lane light gantry, on the widget you
are already staring at during a stop. A **red ring** sits around your car while
the crew is on it; the instant they let you go, a **green ring sweeps outward**
and fades, with a rising two-tone cue if audio is on. The radar wakes itself for
both, since an empty pit box has nobody within the reveal perimeter.

It is on the radar rather than on the Damage widget's stop countdown because the
countdown answers *how much longer* — and by the time the answer is "now", nobody
is watching it any more. The radar is the widget still worth looking at for the
two seconds after the release, and it is the only one that answers the question
the release immediately creates: **is anything coming down the lane.** The
release is detected as the moment the stop *ends*, not as the arrival of the
"exiting" stage, so a feed that skips a phase still tells you.

### Track limits widget

LMU judges track limits in **points**, not strikes, so this widget does too. Every
infringement scores — the sim weighs how far off you went, whether you were on the
throttle, and whether you were at the speed expected for that part of the track — and
a drive-through is issued once the running total passes a threshold the *session*
configures. A single infringement worth **3 points** is an instant drive-through on
its own.

- **POINTS** (the headline, amber) — the running total, with pips filling toward the
  limit. Past it the row starts again in red.
- **PEN** (a red chip) — penalties **the sim itself** has issued. Not our opinion.
- A bar showing **how much road is left**, which is useful *before* the mistake.

**Lift, and it costs you nothing.** This is the important part. LMU raises a Race
Control notice the moment you are **at risk** and gives you a brief opportunity to
slow down while the violation is calculated — lift inside that window and the
infringement scores nothing.

So the widget goes **LIFT** in amber and the audio cue fires **at the start of that
window**, not when the points land: a tone announcing points already taken is telling
you about something you can no longer do anything about. Lift and it flips to a green
**SAVED** and the cue goes quiet — a prompt that keeps sounding after you have
complied is how people learn to ignore prompts. The cue fires **once** per excursion,
on the edge, not repeatedly while you are out there.

A **negated** count tracks how many you have given back. It is the one encouraging
number on the widget, and the one that tells you the lift is working.

| Param         | Shows                                              |
| ------------- | -------------------------------------------------- |
| `?limits=<n>` | Points limit, for a league running its own number   |

**Tuning the threshold.** *Track limits threshold* in the control panel sets how far
past the edge of the road your car has to be before it counts (0.5–5.0 m, applies
live). The sim's own "edge" sits at or inside the white line, so **the kerb is
already past it** — at the default **2.4 m** all four wheels are clear of the kerb
before anything counts. Drop it toward **1.0 m** for the strict
all-four-wheels-past-the-line reading.

**What this is not.** LMU publishes neither its points nor its thresholds — not over
REST, not in shared memory. (CrewChief falls back to its own heuristics for the same
reason.) The only thing the sim exposes is the *consequence*, `mNumPenalties`, once a
penalty has already landed. So the points here are derived from the car's lateral
position and throttle, will not always match the sim's own tally, and are never added
to the penalty count. Set the limit to match the figure your league publishes on the
event page. The logic lives in `src/telemetry/trackLimits.ts` behind 68 headless
assertions (`npm run test:tracklimits`).

### Audio cues

Three short tones, for the things you cannot see coming with your eyes on the
track. On by default; **Audio cues** and **Cue volume** in the control panel's
Settings card turn them down or off, and the Test button previews them.

| Cue     | Sound                    | Fires when                        |
| ------- | ------------------------ | --------------------------------- |
| Limit   | one mid blip             | a track-limits warning is counted |
| Penalty | two descending low tones | the sim issues a penalty          |
| Release | two rising tones         | the crew lets you go              |

They are **synthesised**, not sound files: an oscillator and a gain envelope, two
nodes created and thrown away per cue. Nothing is downloaded, decoded, buffered
or held resident, which keeps the "no assets, no network" property the rest of
the overlay has — it matters most in the in-game layer, which is resident for a
whole stint. Add `?audio=off` to a Browser Source URL to silence just that one,
which is what you want when several overlay sources share an OBS scene and would
otherwise all cue the same event at once.


### MFD widget

The in-game Multi-Function Display for the player's car: a **RACE CONTROL** section,
a **PIT STRATEGY** section (the sim's own menu, colour-coded by category — tyres,
pressures, ducts, aero, fuel, brakes — so related lines read as a group) and a
**DRIVING AIDS** section.

**One row per setting.** PIT STRATEGY is LMU's menu, including its own all-four
`TIRES:` row — the overlay adds nothing of its own to it. It used to draw a second,
collapsed tyre row at the top of the section, which duplicated that entry and, being
the widget's invention rather than a row the server walks, was the one row ▲ ▼ could
never reach.

**The TIRES row sets all four corners, and only offers real compounds.** Its `±`
cycles `No Change → New Medium → New Wet` — and `New Soft` / `New Hard` when the car
and the event have them, because the list comes from the sim and nothing here knows
what a compound is. Two slots the sim publishes are deliberately never landed on:
`INVALID`, which is a compound this car does not run at this event, and `Mixed Tyres`,
which is a *state* (the corners disagree), not a choice. It clamps at both ends rather
than wrapping, so one extra blind press cannot roll `New Wet` round to `No Change` and
silently cancel the tyres you just booked. The per-corner rows are untouched below for
anyone who wants one corner, and they skip `INVALID` the same way.

The row reads from the corners, not from itself: LMU leaves `TIRES:` on `Mixed Tyres`
even when all four corners agree, so the widget shows what the crew will actually fit
and says `Mixed` only when the corners really do differ. And because the sim does not
always take a tyre write, the value is read back from the game before it is reported —
if LMU refuses a compound, the row shows what LMU kept, not what was asked for.

**RACE CONTROL** carries what the sim is doing *to* you, and the two replies — all as
rows, in the same shape as everything else on the widget:

| Row             | Does                                                                    |
| --------------- | ----------------------------------------------------------------------- |
| **PENALTIES**   | Outstanding count, lit for four seconds when one lands. A readout — the only line here ▲ ▼ walk past, because there is nothing to set |
| **SERVE**       | `OFF → DRIVE-THRU → STOP/GO` — arms one, stripping the stop back to no service |
| **PIT REQUEST** | `NO → YES` — requests a normal stop                                     |

The two penalty types differ in a way that matters. Both strip the next stop back to
no service — a penalty taken with your normal strategy loaded gets a full service,
which does not discharge it and loses you the stop as well. But a **stop/go** means
stopping in your box, so the pit stop *is* requested; a **drive-through** means
driving the length of the lane without stopping, so it deliberately does **not**
request one. Requesting a stop for a drive-through is how drivers turn a
drive-through into a drive-through *plus* a pit stop.

Wing, ducts, pressures and **fuel ratio** are deliberately left alone by both — none
adds time on its own, and wiping your setup as a side effect of serving a penalty
would be worse than the penalty. All four are bindable actions too
(`pit.serveStopGo`, `pit.request`, `pit.clearService`, `pit.tyreCompound`).

**Pit Request must be bound to a KEY.** LMU exposes no pit-request route anywhere in
its API, so the overlay presses the game's own bind — and a wheel-button binding
cannot be pressed from outside. If it is unbound the row says so. To fix it, with
**LMU closed**:

```bash
node scripts/bind-lmu-key.js            # binds Pit Request to a free F-key
node scripts/bind-lmu-key.js --list     # what is bound now
node scripts/bind-lmu-key.js --restore  # undo
```

It refuses to run while LMU is open, because the game rewrites `keyboard.json` from
memory when it exits — an edit made with it running looks like it worked and is gone
the next time you launch. A timestamped backup is written before any change.

**Driving the whole MFD from four buttons.** Exactly one row is highlighted — the
row the bindable `Pit menu ▲ / ▼ / + / −` actions are aimed at. Bind them to wheel
buttons, a Stream Deck or global hotkeys in the control panel's Bindings section
and every adjustable row is reachable the way the in-game MFD does it: scroll down
to `FL TIRE`, press `+`, get a new medium.

▲ ▼ walk **one list covering all three sections**, in the order they are drawn:
the race-control rows, then the sim's pit menu, then the driving aids. Anything
with a `±` on it can be reached; the only line skipped is the PENALTIES readout.
Pit changes go over LMU's REST API, so the in-game MFD never has to be on screen
and the sim does not even have to be the focused window — the aid rows are the
exception, since they are keystrokes and LMU must be frontmost to receive one
(the row says so if it is not).

Clicking a row's own ± aims the cursor at that row too, so the mouse and the
buttons never disagree about which row is selected. The cursor is anchored by a
**section-scoped row key**, not an index — the list's shape changes with the car,
the session and what the driver has bound, and an index alone would quietly slide
onto a brake duct or, worse, resolve one section's row against another's.

| Param         | Shows                                                                 |
| ------------- | --------------------------------------------------------------------- |
| `?pit=off`    | Hide the pit-strategy section (fuel, energy, tyres, wing, pressures, ducts, repairs) |
| `?aids=off`   | Hide the driving-aids section (brake bias, TC, ABS, motor map)        |
| `?opacity=0.4`| Panel opacity, same contract as the Motion/Damage widgets             |

Pit strategy is read from LMU's REST garage API and projected in
`src/telemetry/mfdControl.ts`; the selected row lives in `src/server/pitCursor.ts`
so a wheel button, a hotkey and a click on the widget all move the same one. The
pit menu is polled twice a second (the heavier setup read stays on its slow
timer), and any change made through the widget or a bound button is read back
immediately rather than waiting for the next frame — so the value moving is
prompt confirmation that the command landed.
**Brake bias is read live from shared memory**
(`mRearBrakeBias`) and updates as the driver shifts the balance — the REST garage
data only reports the frozen *setup* value, so it can't show live aids. TC, ABS
and the motor map have no live value anywhere in LMU, so they are **counted, not
read**: seeded from the setup value and stepped by every press the overlay makes
*and* every press on the wheel buttons LMU has them bound to. They are tagged
`est` for exactly that reason — an estimate the driver knows is an estimate is
useful, one passed off as a reading is a hazard. **LMU only** — the widget shows
"No MFD data" out of a session or on rF2.

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

**Track limits on LMU:** also driven-car only, and also from shared memory —
this time the **Scoring** buffer rather than the Telemetry one, since the three
channels involved (`mPathLateral`, `mTrackEdge`, `mNumPenalties`) live there and
LMU's REST feed carries none of them. `src/telemetry/lmuScoring.ts` reads just
that one car's record; `scripts/probe-lmu-scoring.js` re-verifies the offsets
against a running game, deriving the record stride from the data rather than
trusting a header. Spectating omits the block entirely rather than reporting a
clean sheet nobody earned.

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
| `APEX_AUDIO_CUES`  | `true`      | Play the synthesised audio cues                |
| `APEX_AUDIO_VOLUME`| `60`        | Cue master volume % (0 = silent), 0–100        |
| `APEX_LIMITS_MARGIN`| `2.4`      | Track-limits threshold, metres past the track edge, 0.5–5 |
| `APEX_VERBOSE`     | `false`     | Verbose logging                               |

## Project layout

```
src/
  telemetry/
    types.ts             # normalized TelemetryFrame contract (shared schema)
    provider.ts          # TelemetryProvider interface
    simulatorProvider.ts # synthetic data for demos / dev
    rf2Provider.ts       # rF2/LMU shared-memory reader (falls back to simulator)
    lmuScoring.ts        # LMU Scoring buffer: lateral position + the sim's penalties
    trackLimits.ts       # excursion counting (hysteresis, guards) — unit-tested
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
  auth.js                #   Supabase accounts (main-process only; owns the session)
  control-panel/         #   the window UI (choose overlays, copy URLs, status)
    auth.html/.css/.js   #     sign in / register / reset password screens
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
