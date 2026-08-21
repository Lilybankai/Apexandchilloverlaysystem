# Apex AIO System

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
npm run app:dist     # -> release/Apex AIO System Setup <version>.exe
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
- **Settings** (the gear, top right) — **Server** (port, update rate, demo mode),
  **Appearance** (widget background, text size, radar car size — all applying
  live), **Audio & feedback** (cues, volume, change glow) and **Bindings**
  (keyboard and wheel).
- **Leaderboard** — the league's best clean laps, ranked, filtered by track, car
  class and car, with your own row marked; plus your pace against the class
  reference. See [Reference pace](#reference-pace) and
  [League boards](#league-boards).
- **Suggestions** — send an idea or a bug report straight from the app; it goes
  to the league with your app version attached. **Setups** is not built yet and
  says so. **Training** mode is shown in the top-right toggle but disabled for the
  same reason.
- **Admin** *(league staff only)* — hidden unless your account is flagged as an
  admin. Shows how many people are using the app and how often (active
  today / week / month, a 14-day trend, version adoption), a **driver list** of every
  account with its app-open count and last-active time, and the feedback inbox, where
  each suggestion can be triaged. Every read is authorised server-side, and nothing
  about how anyone drives is exposed. See [Admin panel](#admin-panel).
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
auto-installed, so a live stream is not interrupted. When the release carries
notes, the banner also offers **What's new**, so the decision to restart
mid-session is an informed one.

The first launch on a new build opens **What's new**: every release between the
build that was last opened and this one, read from the `CHANGELOG.md` packaged
inside the app (so it needs no network and cannot disagree with the version
running). The version in the footer re-opens it at any time.

To publish a new version:

```bash
# 1. Write the release notes FIRST — a new section at the top of CHANGELOG.md:
#      ## 0.57.0 — 2026-08-10
#      ### Added / Changed / Fixed / Removed
#      - **Headline in bold.** What changed, and why it matters to a driver.
# 2. Bump "version" in package.json to match, then:
GH_TOKEN=$(gh auth token) npm run release   # builds + uploads to GitHub Releases
```

`npm run release` will not start unless `CHANGELOG.md` has a dated, non-stub
section for the version in `package.json` — that check is `npm run
changelog:check`, and it runs automatically as npm's `prerelease` hook.

The same section becomes the GitHub release body: `scripts/release-notes.js`
writes it to `build/release-notes.md`, and `scripts/publish-notes.js` puts it on
the release afterwards (npm's `postrelease` hook), so the release page no longer
needs a hand-written `gh release edit --notes-file`. electron-builder is *also*
pointed at that file via `build.releaseInfo`, but it published v0.56.0 with an
empty body regardless — hence the explicit step, which reads the body back to
prove it took. If a release ever does go out blank, repair it with:

```bash
npm run release:body            # or: node scripts/publish-notes.js 0.56.0
```

Existing installs (v0.4.0+) will offer the update automatically. Note: builds are
unsigned, so Windows SmartScreen shows an "unknown publisher" prompt on first
install and on each update ("More info → Run anyway").

## Overlays

Positioned to sit on top of the LMU/RaceLab HUD with solid, opaque backgrounds
(turn them down or off with **Widget background** — see below):

- **Standings** (top-left) — full field, gaps, pit status
- **Relative / timing** (top-right) — nearest cars on track, live delta, each
  tagged with the class it is in (`HY`, `P2`, `P3`, `GT3`, `GTE`, `GT4`) in that
  class's colour — the same colour the standings tower and the radar use, so a
  car arriving is placed as a rival for position or as a faster class coming
  through before the gap beside it is even read
- **Speedo cluster** (bottom-centre) — speed, revs and gear with the whole panel
  lighting up from the floor as the revs rise, green through amber to red, plus
  fuel, virtual energy, projected lap and the hybrid battery (see below)
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
- **Track map** — the whole circuit as a raised 2.5-D ribbon with every car on
  it, learned from your own first lap at each track (see below)
- **Track limits** — how much of the points allowance you have left, what each
  cut cost you, and the sim's own penalties (see below)
- **Tyre temps** — four-corner temperatures
- **Weather forecast** — current + short forecast
- **Fuel calculator** — per-lap use, laps remaining, fuel-to-finish, pit window
- **MFD** — a read-only, colour-grouped readout of the in-game pit menu and
  driving aids. See below; LMU only
- **Reference pace** — your best lap as a percentage of the pace an alien runs
  in the same class at the same track layout, on the Alien → Offline ladder.
  See below

### Speedo cluster

Everything you read on a straight, in one panel, with the shift point readable
without looking at it: **the background illuminates from the bottom up as the
revs rise**, green through amber to red, and the top of the range flashes. That
is the point of the widget. A rev number you have to focus on is no use at
300 km/h; a panel that goes red underneath you is.

The bands are fractions of your own car's rev limit, so a Hypercar revving to
9000 and a GT3 to 7200 light up at the same place in their own range — one widget
for every car in the field.

Around the speed and gear sit the four budgets: **fuel** and **virtual energy**
on the left, each with the laps it is worth; **projected lap time** and the
**hybrid battery** on the right. The battery is the Hypercar's ERS state of
charge — the one that empties down a straight and comes back under braking — and
it is *not* virtual energy, which is the stint allowance that only goes down.

It is drawn as a **battery icon**, and it **lights up green and glows whenever
regen is feeding charge back in** — which is the part you can catch without
looking straight at it. The arrow under it says which way the charge is going:
▲ DEPLOY or ▼ REGEN.

Underneath, a chip strip: the **pit limiter**, **REGEN** (your selected level,
lit green whenever charge is actually flowing back in), and the **TC** map with
its two sub-settings (**PWR**, the power cut, and **SLIP**, the slip threshold)
plus **ABS**. TC and ABS light amber while they are actually intervening; the
settings themselves flash when you change them. Where the sim has its own word
for a setting — `200kW`, `P6`, `1.5% F` — that is what is shown, not an index.

Three of these are hidden rather than shown empty when the car or the feed does
not have them — the battery on anything without a hybrid, virtual energy on a
class that does not run an energy budget, the TC chips outside LMU. An empty
gauge is a claim; no gauge is not.

Speed follows the app's own kph/mph setting like every other panel, so the
cluster and the pedal traces can never disagree. Browser Source options:
`?bg=off` drops the illumination, `?rev=off` drops the rev bar.

### Reference pace

Answers "am I actually quick here?" without needing anyone else on track. Your
best lap is compared to a published reference for your **class** at your **track
layout**, and the percentage lands on a six-rung ladder — Alien (≤100%),
Competitive (101%), Good (≤103%), Midpack (≤105%), Tail-ender (≤106%), Offline
beyond. 100% is alien *race* pace, and 107% is the traditional cutoff.

The same number drives three surfaces: the overlay widget, the Dashboard's
**Pace rank** tile, and the **Leaderboard** tab, which scores your best clean lap
at every track and class you have driven. The overlay scores the sim's session
best; the panel scores your best *clean* lap, because that screen is closer to a
claim about you than a live readout.

**Click any lap in that list** to load it into the pace cards — the percentage,
band, gap and "what would get you to the next rung" line all follow your
selection. Click it again to go back to your best.

**Some laps come back unscored, on purpose.** LMU's feed names the venue and
never the layout, and Monza's two layouts are ~10 s apart in GT3 — so where the
layout cannot be established from the sim's own scene name, the lap length or a
published config, the app says so instead of guessing. GT4 is unrated because
the reference data does not cover it.

### League boards

The **Leaderboard** tab also carries the real thing: every member's best clean
lap, ranked, for one **track** and **car class** at a time, with your own row
marked. A **car** filter narrows the board further.

Two rules worth knowing, because they are deliberate:

- **Boards are per class, not per car.** Your entry is your best in that class
  whichever car set it; the car travels with the time as metadata. In a league
  this size, per-car boards would have one name on each. The car filter narrows
  a board rather than splitting it, so *All cars* is the real board.
- **The filters only offer boards that exist.** Pick a track and you get the
  classes with laps there, then the cars driven in that class — never a
  dropdown of every circuit in the game.

This is the one part of the lap database that needs an account and a connection,
because it is the one part that is about other people. Signed out it says so, and
your laps keep recording either way — they upload next time you sign in.

#### Credit

**The reference times, and the Alien → Offline band names, are
[Ohne Speed](https://www.youtube.com/@ohne_speed)'s work**, published in the
[LMU laptimes spreadsheet](https://docs.google.com/spreadsheets/d/e/2PACX-1vTN03UvJDm99byA6vQPZHKOCYVvfxLu1zkJAzdaKyROykzEKY2-Xl1rl1q5znZEf36m88dxMKsY2eaO/pubhtml),
with lap times contributed by **beAlien**, **Go** and **Hymo**. Apex AIO
System only reads them, and credits them in the app wherever a score is shown.
Ohne Speed's Discord is [here](https://discord.com/invite/dFAqhnuSXH).

The table is **baked at build time**, not fetched at runtime, so scores work
offline and cannot break when the sheet moves. Refresh it after an LMU patch:

```bash
npm run reference-times          # fetch the sheet and rewrite the data file
npm run reference-times:check    # fetch and diff only; exits 1 if it changed
```

It fails loudly if the sheet gains a track the app cannot place, or renames one
it could — see `scripts/reference-tracks.js`, which is the hand-written map from
what the sim calls a track to what the spreadsheet calls it.

### Admin panel

The **Admin** tab is the league's own view of the tool — how many people use it,
how often, and what they are asking for. It is hidden for everyone else: the tab
only appears once `admin_whoami` confirms the signed-in account is an admin, and
every number behind it comes from a security-definer RPC that checks `is_admin`
again, so the hidden tab is a convenience and the database is the boundary. Most of
it is **aggregate** — active users (today / week / month), sessions, a 14-day
active-users chart, version adoption, and the feedback inbox.

**Drivers** is the one per-person view: every account with its name, email, how many
times it has opened the app, and when it was last active, searchable by name or email
and sortable by last active / most logins / name / newest. An account that has never
launched the app is listed too, reading `0` and *Never* — "signed up and never came
back" is the row a league most needs. This is a deliberate exception to the aggregate
rule and is scoped to identity and presence; nothing about how anyone *drives* is
exposed — no laps, no telemetry, no session detail. `admin_users_list` is security
definer and re-checks `is_admin`, so the boundary is still the server's.

Two things to know when reading it: **logins count app opens**, not Supabase
sign-ins — one per run, from the same heartbeat below — and that heartbeat only
started recording in **v0.49.0**, so older accounts read `0` until their next launch.
The card says so under the list. Search and sort run server-side.

**Usage** is measured by a light heartbeat. Until now the league could only see
usage when someone *completed laps* (`submit_activity`), which misses anyone who
ran overlays without touching the lap counter. `electron/usageReporter.js` writes
one `app_sessions` row when the app opens and refreshes it every five minutes,
carrying only the app version and a coarse OS label — no telemetry, nothing about
what is on screen. The write is idempotent on a per-run session id (the server
keeps the later `last_seen`), like the lap uploader, so a dropped or repeated beat
costs nothing. It is signed-in only, by design.

**Feedback** is the [Suggestions](#desktop-app) tab: an idea/bug/other form that
files one row via `submit_feedback` with the app version attached. Admins triage
each item's status (new → planned → in progress → done / declined) from the inbox.

The Supabase side lives in the repo as re-runnable migrations:
`supabase/migrations/0001_admin_panel.sql` — the two tables, the `is_admin` flag,
and the six RPCs the app calls — and `0002_admin_users.sql`, which adds the driver
list's `admin_users_list` (one function, no schema changes). The schema is versioned
here even though the project it applies to is not, the same way the leaderboard's
RPCs are: the app only ever *calls* these functions. To turn it on:

```sql
-- 1. apply supabase/migrations/0001_admin_panel.sql, then 0002_admin_users.sql,
--    in the Supabase SQL editor
-- 2. make yourself an admin:
update public.profiles set is_admin = true where id = (
  select id from auth.users where email = 'you@example.com'
);
```

Sign in on the desktop app and the Admin tab appears.

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

**Per widget.** Every card in the **Overlays** tab carries its own `BG` slider,
which is that widget's exception to the global one. Fade the whole set to 50% for
a clean stream and keep the one panel you actually read at speed — fuel, the
relative table — at 100%: it is a one-card edit, not a rebuild of the layout. A
card sitting on **Auto** (the default, and dimmed to say so) has no override and
follows the global slider as you drag it; touching its slider creates the
override, and the **Auto** button beside it gives the widget back. Overrides
travel on the same live channel as everything else here, so they reach the
in-game layer and existing OBS sources with no reload.

Per source, `?bg=` on the URL overrides the app's setting and pins that page
(`?bg=0` for a bare HUD, `?bg=100` for solid, `?bg=40` for a light tint). It pins
the per-widget overrides too — the param exists so one OBS source can look
exactly one way regardless of the app, and honouring half the setting would not
be that. This is separate from the Motion/Damage/MFD/Radar `?opacity=` control,
which fades a single widget's **contents**; `bg` only ever touches the box behind
them.

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


### Track map widget

The circuit, extruded off the plane and viewed at an angle, with a dot for every
car in the session — your own in white with a ring round it, everyone else in
their class colour, cars in the pit lane faded. Where the radar answers "who is
beside me", this answers "where is everybody" — traffic two corners ahead, how
far back the car you are chasing really is, whether a yellow is on your part of
the track.

| Param            | Shows                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| `?style=classic` | The infographic red of a printed circuit map. The default                 |
| `?style=brand`   | The overlay's cyan→magenta running round the lap                          |
| `?rotate=<deg>`  | Overrides the automatic orientation                                       |
| `?tilt=0.55`     | How steeply the view looks down, 0.2 (flat plan) .. 0.9                    |
| `?ground=0`      | Drops the ground plane and the extrusion, leaving the road floating       |

**It is one material, lit by one light.** Not a light road with a coloured wall
glued on — that reads as a paper cutout. Every segment's surface and sides are
shaded from the direction the road is actually going, so a straight and the
corner it feeds are visibly two faces of one solid; the road's two edges are
chamfered so they catch the light along the outside of the ribbon. The palette
only sets the base hue, and the lighting makes every other shade from it.

**The circuits come with the app — and any that don't, it learns.** LMU packs
its tracks into encrypted archives and no API publishes the shape of the road,
but the sim does publish where your car is, thirty times a second, with a lap
distance beside it, which is enough to build the map by driving it. Because those
positions are in the *sim's* world axes, a circuit learned on one machine is
correct on every other one — so the laps have been driven here and the results
ship with the installer. **32 circuits and layouts draw on your first lap of
your first session, with nothing to set up and nothing to register** — the full
list is `data/trackmaps/index.json`.

Anywhere else, the learner takes over exactly as before: a new season's track, a
layout nobody has driven yet, a mod, rF2. The widget shows a progress read
(`LEARNING THE CIRCUIT — 62%`) and builds the map as you go, then caches it in
`~/.apex-overlay/tracks/` so it draws instantly ever after.

Your own map always wins over the bundled one, and a bundled map that turns out
to be wrong repairs itself: if the car disagrees with it for 200 m of road, it is
thrown out, relearned from your lap, and not loaded again on that machine.
Set `APEX_BUILTIN_TRACKMAPS=0` to ignore the bundle entirely and learn everything
from the car.

Because the shape is measured in the sim's own world coordinates, the car dots
need no fitting to sit on it — they are the same numbers. A car running wide is
drawn running wide; a car in the pit lane is drawn in the pit lane. When the sim
publishes no positions at all (spectating a broadcast), the dots fall back to lap
distance and ride the centre of the road instead.

**Elevation is exaggerated, deliberately.** A circuit moves ±30 m vertically
across a 1.5 km footprint — under 2% of the map's width, invisible at true scale.
The lift is scaled to a fixed share of the map's own size instead, so Spa's hill
reads at a glance and a flat circuit stays flat.

**And the elevation is a solid.** The circuit stands on a ground plane, with the
road extruded down to meet it all the way round, so the height of that mass at
any point is the height of the track there. The hill is no longer a gap between
the road and its shadow that you have to notice — it is something with a foot,
and a climb reads as the road pulling away from its own base. The plane itself is
a soft pool of light rather than a plate, so it stays a surface rather than
becoming a second panel when you run the widget background transparent.

The ribbon is then drawn over its own silhouette, projected onto the ground plane
with the lift removed and blurred. The shadow stays flat while the road climbs
away from it, so the gap between the two *is* the hill — and on a genuinely flat
circuit they nearly coincide and it becomes an ordinary contact shadow instead.

One lap is one file of about 40 KB, fetched once over HTTP (`/trackmap.json`) and
re-fetched only when the track changes; the ribbon is rendered once to an
offscreen canvas and each frame after that is a blit plus the dots.

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

LMU judges track limits in **points**, not strikes, and every number on this widget is
the sim's own. The stewards charge each cut on the time it gained — quarter-points, so
a wheel over the line is 0.25 and a cut that actually gained something is 1.00 — and a
drive-through is issued once the running total reaches the session's allowance.

- **LEFT** (the headline) — how much of the allowance you have got left. It counts
  **down**, because that is the number you act on: "1.75" says a couple more careless
  kerbs and you are walking down the pit lane. In practice and qualifying, where LMU
  invalidates the lap instead and lets the total run, it shows points **spent**.
- A bar under it draining as the allowance goes, amber under half and red under a
  fifth — so peripheral vision gets the answer without reading the number.
- **CUTS** — what each of the last five cuts was charged: `0.25 · 0.5 · 1.0`. This is
  the one that changes behaviour. Three 0.25s in a row is one kerb you are clipping
  every lap and can fix by moving your line a foot; a single 1.00 is one mistake
  already made.
- **PEN** (a red chip) — penalties the sim has issued, named where it names them
  (`DRIVE THRU`, `STOP/GO`), plus a green **PENALTY SERVED** when one is discharged.

**The flash.** When the total goes up, the widget flashes yellow with the amount —
`+0.25`, `+1` — for two seconds, and the audio cue fires once. That is the only thing
that makes it shout, because it is the only thing on it you did not already know: you
knew you ran wide; what you did not know is what the stewards charged you for it.

| Param         | Shows                                              |
| ------------- | -------------------------------------------------- |
| `?limits=<n>` | Points limit, for a league running its own number   |

**Where the numbers come from, and the one catch.** LMU publishes neither its points
nor its per-cut charges over REST or in shared memory — only the *consequence*,
`mNumPenalties`, once a penalty has landed. It does write them to its own trace log,
which the overlay tails (`src/telemetry/lmuTraceLimits.ts`); the reader was validated
against a session-end results file, reproducing all thirteen of that race's charges in
order and to the exact 5.00 that earned the drive-through. The catch is that the game
flushes that log a block at a time, so a charge can reach you anywhere from a tenth of
a second to **~25 s** after the cut. The total is right; sometimes it is right late.
Full workings in [`docs/TRACK-LIMITS-POINTS.md`](docs/TRACK-LIMITS-POINTS.md).

On plain rF2, which writes no such log, the widget shows the penalty count and says it
cannot see a total rather than inventing one.

> **Retired in v0.47.0.** Earlier versions reconstructed the points from the car's
> lateral position against the track edge, with a tunable *Track limits threshold*, an
> at-risk **LIFT** prompt and a "+1 POINT" callout. All of it existed because the real
> numbers were unreachable; once they were not, an estimate sitting next to the
> stewards' own figure and disagreeing with it was worse than no estimate. The
> threshold slider and the `APEX_LIMITS_MARGIN` variable are gone with it.

### Audio cues

Three short tones, for the things you cannot see coming with your eyes on the
track. On by default; **Audio cues** and **Cue volume** in the control panel's
Settings card turn them down or off, and the Test button previews them.

| Cue     | Sound                    | Fires when                        |
| ------- | ------------------------ | --------------------------------- |
| Limit   | one mid blip             | the stewards charge you for a cut |
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

**Controls must be bound to a KEY, and the app can do it for you.** The overlay
presses LMU's own bindings, and a wheel-button binding cannot be pressed from
outside the game — so anything you have only on the wheel is unusable from here
until it also has a key. Settings → **LMU controls** shows what is bound, what
isn't, and binds the missing ones in one click.

The keys it claims are scancodes Windows maps to **no virtual key at all** — no
keyboard sold produces them, which is the entire point: you cannot already have bound
them in LMU, and no OBS or Discord hotkey can be listening for them. Fifteen of them
are verified against the running game, against thirteen functions, so even a rig with
nothing bound is covered.

**F16–F24 are deliberately not used**, though they work. DirectInput's names stop at
F15 so `0x67`–`0x6F` look like free space, but Windows maps them onto the F16+ virtual
keys — and F13–F24 is exactly what a **Stream Deck** emits for "a key no game uses".
They work *because* they are ordinary function keys, which is why they are unsafe. Anything you *have* bound is left exactly
as it is, a key already in your file is never handed out twice, a timestamped backup
is taken first, and **Undo** puts it back. It refuses while LMU is running — the game
rewrites that file from memory when it exits, so a change made now would be thrown
away at the next launch.

The manual route is still there, and is what you want for a one-off. With
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
| `?aids=off`   | Hide the driving-aids section (brake bias, TC, ABS, motor map, and on a Hypercar brake migration, both anti-roll bars and regen) |
| `?opacity=0.4`| Panel opacity, same contract as the Motion/Damage widgets             |

Pit strategy is read from LMU's REST garage API and projected in
`src/telemetry/mfdControl.ts`; the selected row lives in `src/server/pitCursor.ts`
so a wheel button, a hotkey and a click on the widget all move the same one. The
pit menu is polled twice a second (the heavier setup read stays on its slow
timer), and any change made through the widget or a bound button is read back
immediately rather than waiting for the next frame — so the value moving is
prompt confirmation that the command landed.
**Every aid is read live from the car**, not inferred: brake bias, the TC map, its
two sub-settings (**TC Slip** and **TC Power Cut**), ABS and the motor map all come
off the telemetry record in shared memory, each shown as its step against the
maximum the car allows (`7/11`). They were *counted* until v0.30.0, on the finding
that LMU published no live value for them. That finding was wrong twice over: the
values are single **bytes** in what stock rF2 leaves as reserved space, so a scan
for doubles steps straight over them — and every car except the driver's own
publishes zeros there, so probing the wrong record looks exactly like "not
supported".

`±` appears only on the aids LMU has a **keyboard** bind for, since a key the game
has not bound does nothing however perfectly it is sent. TC Slip and TC Power Cut
have no keyboard function in LMU, so they read live but carry no controls, and
▲ ▼ walk past them. The frozen setup value from the REST garage data survives as
the fallback for brake bias when there is no live car — in the garage, or
spectating. **LMU only** — the widget shows "No MFD data" out of a session or on
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

**Track limits on LMU:** also driven-car only, and from two sources at once. The
**points** come from the game's trace log, the only place LMU publishes its
stewarding live (`src/telemetry/lmuTraceLimits.ts`). The **penalty count** comes
from shared memory — the **Scoring** buffer rather than the Telemetry one, since
`mNumPenalties` lives there and LMU's REST feed carries no penalty detail;
`src/telemetry/lmuScoring.ts` reads just that one car's record, and
`scripts/probe-lmu-scoring.js` re-verifies the offsets against a running game,
deriving the record stride from the data rather than trusting a header.
Spectating omits the block entirely rather than reporting a clean sheet nobody
earned.

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
npm start        # builds and starts the server (http://127.0.0.1:17080)
```

Then add `http://127.0.0.1:17080/` as an OBS Browser Source (see
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
| `APEX_HTTP_PORT`   | `17080`     | HTTP + overlay port                           |
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
| `APEX_TWITCH_CHANNEL` | _(none)_ | Twitch channel for the Chat overlay (read anonymously — no login) |
| `APEX_YT_LIVE_CHAT_ID` | _(none)_ | YouTube live-chat id for the Chat overlay (see below) |
| `APEX_YT_TOKEN`    | _(none)_    | YouTube OAuth access token for the Chat overlay (see below) |
| `APEX_VERBOSE`     | `false`     | Verbose logging                               |

### Stream chat overlay (YouTube + Twitch)

The **Chat** widget (`/widget.html?w=chat`, or the in-game layer) shows your
YouTube and Twitch chat as one scrolling column — the widget triple-screen users
park on a side monitor's dead space. It rides its own `/chat` WebSocket, not the
telemetry frame; the server does the platform-specific work and hands the widget
one normalized message shape, so the widget stays a thin, XSS-safe renderer.

- **Twitch** is read anonymously over IRC — set `APEX_TWITCH_CHANNEL` to your
  channel name and that half just works, no account link, no credential.
- **YouTube** has no anonymous read, so it needs Google OAuth. In the **desktop
  app** this is a one-click link (Overlays → *Streaming chat* → *Link YouTube*),
  which runs the sign-in in the main process, finds your active broadcast's live
  chat, and keeps the token fresh — no token ever reaches the browser. For a
  standalone server you can instead supply `APEX_YT_LIVE_CHAT_ID` and a valid
  `APEX_YT_TOKEN` directly.

#### Setting up YouTube linking (Google OAuth client)

The one-click *Link YouTube* button needs a Google OAuth **Desktop app** client.
This is a one-time setup for whoever builds the app — end users never see it,
they just click *Link YouTube* and sign in. Twitch needs none of this.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create (or pick) a project.
2. **APIs & Services → Library →** enable the **YouTube Data API v3**.
3. **APIs & Services → OAuth consent screen** — configure it (External is fine),
   and add the scope `.../auth/youtube.readonly`. While the app is in *Testing*,
   add each streamer's Google account under **Test users** (or *Publish* the
   consent screen so anyone can link).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID →
   Application type: _Desktop app_.** Google issues a client id and a client
   secret. For a desktop app neither is confidential — the flow uses PKCE and a
   loopback redirect (`http://127.0.0.1:<random-port>/callback`), which is
   registered automatically, so there is nothing else to configure.
5. Provide the two values to the app via `APEX_GOOGLE_CLIENT_ID` and
   `APEX_GOOGLE_CLIENT_SECRET` (env vars, or bake them into your build). Until
   they are set, the control panel shows *"YouTube linking isn't available on
   this build"* and only the Twitch field appears — Twitch never depends on this.

**Quota note:** reading live chat costs ~5 units per poll against the default
10,000 units/day, and the widget obeys the API's own `pollingIntervalMillis`
(≈5 s) rather than polling harder — enough for several hours of streaming a day.
If you run long every day, request a quota increase for the project.

## Project layout

```
src/
  telemetry/
    types.ts             # normalized TelemetryFrame contract (shared schema)
    provider.ts          # TelemetryProvider interface
    simulatorProvider.ts # synthetic data for demos / dev
    rf2Provider.ts       # rF2/LMU shared-memory reader (falls back to simulator)
    lmuScoring.ts        # LMU Scoring buffer: the sim's own penalty count
    lmuTraceLimits.ts    # LMU trace log: the stewards' track-limit points
    trackLimits.ts       # penalty edges (issued / served) — unit-tested
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
  lapUpload.js           #   background lap/activity uploader (idempotent aggregates)
  usageReporter.js       #   usage heartbeat → app_sessions (admin panel)
  control-panel/         #   the window UI (choose overlays, copy URLs, status)
    auth.html/.css/.js   #     sign in / register / reset password screens
supabase/
  migrations/            # SQL applied to the league's Supabase project
    0001_admin_panel.sql #   app_sessions + feedback + admin RPCs (is_admin)
    0002_admin_users.sql #   admin_users_list — the driver roster read
docs/                    # OBS setup + architecture notes
scripts/                 # Windows launcher
```

## Telemetry contract

`src/telemetry/types.ts` defines `TelemetryFrame`, the single normalized schema
shared between the telemetry producers and the overlays. Every provider maps its
raw data into this shape, so the overlays never depend on which sim is running.
The schema is versioned via `TELEMETRY_SCHEMA_VERSION`.

## Credits

Reference lap times and the Alien → Offline pace bands come from **Ohne Speed's
LMU laptimes spreadsheet**, with times contributed by **beAlien**, **Go** and
**Hymo**. See [Reference pace](#reference-pace).

## License

UNLICENSED — internal to the Apex & Chill Racing League.
