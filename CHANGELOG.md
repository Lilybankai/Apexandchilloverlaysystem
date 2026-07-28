# Changelog

## 0.32.0 — 2026-07-28

### Fixed

- **Traction control moving on its own when a pit value changed.** Not a
  misreading — two actions on one button. The bindings panel offered a delta
  action per driving aid (`aid.tc`, `aid.abs`, …) alongside the four MFD cursor
  controls, and nothing stopped one wheel button carrying both. On the rig this
  was found on, button 46 was `pit.rowUp` **and** `aid.tc` inc, button 48 was
  `pit.valueInc` **and** `aid.tc` dec. A wheel button is not consumed, so both
  fired every time: scrolling the cursor up raised TC, raising a pit value
  lowered it.

  The per-aid actions are removed. They were redundant as well as harmful — the
  MFD cursor walks the aid rows along with everything else, so ▲ ▼ + − reach
  every aid without a binding of their own, which is the entire point of having
  four buttons instead of twenty.

- **Bindings left behind by removed actions are cleaned up on launch.** A stale
  binding is not just untidy: a global hotkey for an action that no longer
  exists still **consumes the key**, so it stops reaching the sim and does
  nothing in exchange, and neither it nor a stale wheel binding is visible in
  the UI, because the row it belonged to is gone. Only ids this app has actually
  removed are dropped — an explicit list, never a sweep against the live
  registry, because half of it is conditional and a bad load would otherwise eat
  a driver's pit bindings.

- **The "×" on a binding row now clears the wheel binding too.** It only ever
  cleared the *key*, which is not what a row-level clear says it does: the wheel
  binding stayed and kept firing, and the only way to remove it was a
  right-click on a chip that advertised nothing. That right-click still works
  and now says so in its tooltip.

## 0.31.0 — 2026-07-28

### Added

- **One-click LMU control binding, on keys nobody can be using.** The overlay
  can only press what LMU has bound to a *key*, and most drivers have their aids
  on wheel buttons and nothing else — so on a fresh rig half these controls
  cannot be driven at all until somebody hand-binds a dozen functions in the
  game's menus. Settings now has an **LMU controls** card: it shows what is
  already bound, what it would bind, and writes the missing ones.

  The keys it claims are Japanese and Brazilian keys — `CONVERT`, `NOCONVERT`,
  `YEN`, `KANA`, `ABNT_C1`, `ABNT_C2`. The point is that they exist in
  DirectInput and on no keyboard the driver owns, so **nobody can already have
  bound them** in LMU, and no OBS or Discord global hotkey can be listening for
  them either. Every code is below `0x80` deliberately: the other exotic codes
  resolve to `E0`-prefixed scancodes — the media keys — so binding one would
  mute the driver's music every time the overlay changed a brake bias.

  Verified against the running game rather than assumed: `CONVERT`, `NOCONVERT`
  and `YEN` were each bound to a real LMU function and pressed with `SendInput`,
  and the car's own aid values moved in shared memory. The other three are the
  same class of key and are only used after those three.

  Two safety rules, both tested: a function the driver has already bound is
  never touched, so re-running is a complete no-op (an earlier binder walked a
  binding down the keyboard on every run and quietly took over Quick Chat #9);
  and a key already present anywhere in the file is never handed out, because
  "nobody can press a Japanese key" is a good reason to expect it to be free and
  not a guarantee. A timestamped backup is taken before any write, and **Undo**
  restores it.

  It refuses while LMU is running, and says why. That is not caution: LMU
  rewrites its controls file from memory when it exits, so a write made with the
  game up survives a test and is gone at the next launch — the worst kind of
  failure, because it looks like success.

- **TC Slip and TC Power Cut are adjustable, not just readable.** Their LMU
  function names are in no config file on disk — the game only writes a function
  into `keyboard.json` once it is bound — so they were found by binding
  candidates and seeing which moved the car: `Traction Control Slip Angle Up`
  drives the slip byte, and `Traction Control 2` turns out to be the **power
  cut**, not a second TC map. Both now carry `±` and the cursor walks them.

## 0.30.0 — 2026-07-28

### Changed

- **The driving aids are read from the car now, not counted.** TC, ABS and the
  motor map were *estimates*: seeded from the setup value, stepped by every press
  the overlay made and every press on the wheel buttons LMU had them bound to,
  and tagged `est` because they could drift from the game with no way for the
  driver to tell. They are real readings, live off the telemetry record, and the
  tag is gone.

  The finding they were built on — "no live value anywhere, verified twice" —
  was wrong, and in two ways that are worth writing down because both are easy
  to repeat. The values are single **bytes** in what stock rF2 leaves as
  reserved expansion space, so a scan looking for doubles or ints steps straight
  over them. And every car except the driver's own publishes **zeros** there, so
  a probe on the wrong record shows an empty block, which looks exactly like
  "the sim does not expose this".

  Sampled live against the game to confirm: TC 7/11, ABS 9/9, motor map 1/1 —
  matching both LMU's own MFD and the numbers the overlay had been counting.
  Cross-checked against SimHub's LMU struct, which declares `mRearBrakeBias` at
  the same offset this project had already verified on track.

- **Two aids that were never shown at all: TC Slip and TC Power Cut.** LMU
  carries the traction-control slip angle and power cut as separate settings
  from the TC map, and both are readable. They have no keyboard function in LMU,
  so they read live but carry no `±` and the cursor walks past them — the same
  rule every other unbindable control follows.

- **Aids show their headroom.** A row reads `7/11` rather than `7`, so the step
  and what the car allows are one glance rather than two. A control this car
  does not have (a GT3 with no motor map) is omitted rather than shown as a
  permanent `0`, which reads as "turned off" — a different and more alarming
  thing to tell a driver.

### Removed

- **`server/aidShadow` and everything that fed it.** The estimate tracker, the
  `/api/mfd/aidresync` escape hatch it needed, and the wheel-button polling in
  the desktop app that ran whenever the server was up purely to watch the
  driver's own aid presses. None of it has a job once the values can be read.

- **Reading LMU's controller binds (`direct input.json`).** That file was parsed
  on every bind read so the estimate tracker could watch the buttons the driver
  actually uses. Nothing needs to know what the wheel is bound to now, so the
  parse, the `WheelBind` type and the `incWheel`/`decWheel` fields are gone —
  one fewer file read on a path that runs on every aid press.

## 0.29.0 — 2026-07-28

### Fixed

- **The TIRES row cycles compounds, and nothing else.** `±` on it now goes
  `No Change → New Medium → New Wet`, all four corners together — plus
  `New Soft` / `New Hard` when the car and the event have them, since the list
  comes from the sim and nothing here knows what a compound is.

  Two of the slots LMU publishes on a tyre row are not compounds, and both were
  reachable: `INVALID`, which is a compound this car does not run at this event,
  and `Mixed Tyres`, which is a *state* — what the row reports when the corners
  disagree — rather than something to select. Pressing `+` twice past `New Wet`
  used to book `INVALID`, which is not a tyre. Both are now skipped everywhere,
  including on the per-corner rows.

  The row also clamps at both ends rather than wrapping. That is the rule the
  sim's own rows follow, and here it matters in its own right: wrapping from the
  last compound round to `No Change` would cancel the tyres the driver had just
  booked, on a control they are pressing without looking.

- **The TIRES row shows what the crew will actually fit.** LMU leaves its own
  `TIRES:` row on `Mixed Tyres` even when all four corners agree — set the
  corners individually, or through this overlay, and the row claims a mixed set
  that does not exist. It is now projected from the corners, and reads `Mixed`
  only when they genuinely differ.

- **A tyre change is verified against the sim before it is reported.** LMU does
  not always take a tyre write: observed live in one session, asking for
  `No Change` from `New Medium` left the corners on `New Wet`. Reporting the
  request as though it had landed made a held `−` oscillate between two
  compounds, because the next press computed from the sim's real state while the
  display showed ours. Tyre writes now read back what the game kept.

- **A press can no longer act on a row the driver did not aim at.** When the
  anchored row disappears — the menu changes shape, or the sim leaves its
  session and takes the whole pit list with it — the cursor fell back to an
  index into a list that had just lost twenty rows. That pointed at SERVE, whose
  action strips the entire pit stop. It now re-anchors and refuses the press,
  saying which row it landed on; the next press acts on that row.

## 0.28.0 — 2026-07-28

### Fixed

- **The MFD highlight can no longer land on two rows at once, or appear to jump
  backwards.** The widget fell back to the cursor's INDEX whenever it could not
  find the cursor's row by name in the pit list — and that index counts a
  different list. The server walks `[SERVE, PIT REQUEST, …the sim's rows]`; the
  widget searched the sim's rows alone, so a cursor sitting on `PIT REQUEST`
  (index 1) lit `PIT REQUEST` *and* the second pit row, and `SERVE` (index 0) lit
  `SERVE` and `DAMAGE`. Wrapping off the end of the list into those rows is what
  read as "▼ jumped back up to DAMAGE".

  Every walkable row now carries the server's own section-scoped key
  (`pit:FL TIRE:`), and the highlight matches on that and nothing else. When the
  cursor is on a row this instance is not drawing, nothing is marked — pointing
  at a nearby row is worse than pointing at none, because it tells the driver
  their buttons are aimed somewhere they are not.

- **The race-control rows are drawn in the order the cursor walks them.** The
  list read PIT REQUEST above SERVE while ▼ visited them the other way round, so
  one downward press moved the highlight upward. Both the order and the values
  now come from the cursor poll, so the drawn list and the walked list cannot
  disagree again.

- **The duplicate TIRES row is gone.** The widget drew its own collapsed
  all-four-corners row at the top of PIT STRATEGY, a few lines above the sim's
  own `TIRES:` entry, which does the same job. Being the widget's invention
  rather than a row the server walks, it was also the one row ▲ ▼ could never
  reach. Setting all four corners in one press remains as the bindable
  `pit.tyreCompound` action.

### Changed

- **▲ ▼ + − now reach every adjustable row on the widget, driving aids
  included.** Brake bias, TC, ABS and the motor map were mouse-only; a control
  that can only be clicked is a control a driver cannot use, which is the whole
  reason the cursor exists. The cursor walks ONE list — race control, then the
  sim's pit menu, then the aids, in the order they are drawn — and the only line
  it skips is the PENALTIES readout, which has nothing to set.

  Aids are stepped by pressing LMU's own bound key, so unlike the pit rows they
  need the sim frontmost; the row reports that in those words when it is not.
  Only aids LMU actually has bound are walked, since an unbound function cannot
  be triggered at all. The key press and the shadow-value bookkeeping behind it
  are now one implementation (`src/server/aidRows.ts`) shared by the widget's ±
  and the bindable controls, rather than a copy each.

## 0.27.0 — 2026-07-27

### Changed

- **SERVE and PIT REQUEST are reachable from the four bindable controls.** They
  were rendered as rows but were not IN the list the pit cursor walks, so ▲ ▼
  scrolled straight past them and only a mouse could touch them. That is the
  wrong way round: the single moment a driver most needs to serve a penalty is
  the moment they least want to be finding a mouse.

  The cursor now walks a combined list — the overlay's own rows first, then the
  sim's — so scroll-scroll-plus reaches them exactly as it reaches FL TIRE. They
  behave like every other row: ± changes the value, clicking a row's ± aims the
  cursor at it, and a wheel button and a click stay in agreement because both go
  through the one server-side cursor.

  SERVE cycles `OFF → DRIVE-THRU → STOP/GO`, and the distinction is not
  cosmetic: both strip the stop back to no service, but a stop/go means stopping
  in your box so the pit stop IS requested, while a drive-through means driving
  the lane without stopping so it deliberately is not.

  These rows **clamp** rather than wrap at their ends, unlike the sim's. Wrapping
  is right for a value; it is wrong for a row whose last option strips a pit
  stop, because one extra press on a control the driver is not looking at would
  roll round and do something they were not reaching for.

### Fixed

- **`scripts/bind-lmu-key.js` no longer walks a binding down the keyboard on
  re-runs.** It counted the target function's OWN key as occupied, so the
  auto-picker skipped it and handed out the next one down: run it twice and
  `Pit Request` moved F10 → F11, three times and it was on F9, quietly taking
  over Quick Chat #9. It now ignores the function's own binding, and an
  already-bound function is left alone entirely unless `--key` asks for a
  specific one — so re-running is a proven no-op, which matters for a tool people
  run again when they are unsure it worked.

## 0.26.0 — 2026-07-27

### Changed

- **Track limits are counted in POINTS now, because that is what LMU judges them
  in.** The sim does not run a strike count: every infringement scores, weighed by
  how far off you went, whether you were on the throttle and whether you were at
  the speed expected there, and a drive-through follows once the running total
  passes a threshold the *session* configures. A single infringement worth 3
  points is an instant drive-through on its own.

  So the headline is points against a limit (configurable — leagues publish
  theirs on the event page), a deeper cut scores more than a wheel over the line,
  and the widget stops pretending three strikes is the rule anywhere.

- **The audio cue fires while the point can still be avoided, not after it
  lands.** This is the change that makes the cue worth having. LMU raises a Race
  Control notice the moment you are **at risk** and gives you a brief window to
  slow down while the violation is calculated — lift inside it and the
  infringement costs nothing.

  The widget now shows **LIFT** and sounds the tone at the *start* of that window.
  Lift and it flips to a green **SAVED** and goes quiet; a prompt that keeps
  sounding after you have complied is how people learn to ignore prompts. A
  `negated` count tracks how many you have given back, which is the only
  encouraging number on the widget and the one that proves the lift is working.

  The cue is edge-triggered rather than left to the audio module's rate limit:
  that limit is one second and the window is 1.2, so the old code sounded the tone
  **twice** per excursion — measured. Two beeps for one instruction reads as an
  alarm rather than a prompt, and lengthening the rate limit would have swallowed
  the second of two genuinely separate excursions.

  With no throttle channel (spectating) every excursion scores, rather than
  quietly forgiving ones that did cost the driver points in the sim.

- **Tyres are one MFD row, not a panel of buttons.** The compound choice moved
  onto a **TIRES** row at the top of PIT STRATEGY — where the sim's own all-four
  entry would be, beside the per-corner rows it drives — cycling the compounds the
  car actually has in the sim's own words (`New Medium`, `Used Medium`, `New
  Wet`…). A control that looks different from its neighbours reads as a different
  kind of thing, and this is not a different kind of thing.

- **Pit request and serving a penalty are MFD rows too**, under **RACE CONTROL**,
  alongside the outstanding penalty count.

  `SERVE` now distinguishes **DRIVE-THRU** from **STOP/GO**, which is not
  cosmetic: both strip the stop back to no service, but a stop/go means stopping
  in your box so the pit stop *is* requested, while a drive-through means driving
  the lane without stopping so it deliberately is **not**. Requesting a stop for a
  drive-through is how drivers turn a drive-through into a drive-through plus a
  pit stop.

### Added

- **`scripts/bind-lmu-key.js`** — writes the missing `Pit Request` keyboard
  binding into LMU's own config, so the overlay has something to press. LMU
  exposes no pit-request route in its API and a wheel-button binding cannot be
  synthesised, which is why REQUEST PIT could not work for most drivers.

  It **refuses to run while LMU is open**, and that guard is the reason this is a
  script rather than a file edit: the game rewrites `keyboard.json` from memory
  when it exits, so an edit made with it running appears to work, survives a test,
  and is gone the next time you launch. A timestamped backup is written before any
  change and `--restore` puts it back.

## 0.25.0 — 2026-07-27 "Postbox"

Laps now reach the league. v0.24 recorded them; this connects that record to the
Apex & Chill database so a leaderboard has something to rank.

### Added

- **The lap uploader.** Your best clean lap per track and class, and your daily
  lap counts, are sent up in the background — on launch, when you sign in, every
  few minutes while the app is open, and on demand from the Dashboard.

  What goes up is **two aggregates, not laps**. Four hundred practice laps become
  one row saying "400" and one saying "your best was a 2:18.080". The full lap
  history stays on your machine.

- **A sync line on the "This week" card**, with a *Sync now* button. It reports a
  state rather than a failure, because none of these are errors: signed out means
  your laps are safe on disk and will go up when you sign in; offline means the
  same and it will retry.

- **The database behind it** (Supabase): a track dictionary with an alias table,
  a best-lap row per driver/track/class, and per-day activity counters. Clients
  have **no write access to any of it** — two `security definer` functions are
  the only way in, so every rule about what may reach a board lives in one place.

### Notes

- **There is no upload queue, on purpose.** The obvious design — a queue of laps
  and a cursor — has a failure mode this one cannot have: a cursor that desyncs
  from the data, which either double-counts or silently drops laps with no way to
  tell which. Instead both server functions are idempotent (the day counter keeps
  the *greater* value; a best lap only ever replaces a *slower* one), so the app
  recomputes what the database should say and sends that. Sending it twice is a
  no-op by construction.

  The consequence worth knowing: `lap-sync.json` next to your settings is a
  cache, not a ledger. Deleting it causes one burst of redundant requests and
  changes nothing else. Verified against the live project — re-sending a full
  day's rows after wiping the cache left the totals identical.

- **A row the server refuses for good is never retried.** An impossible time or a
  day outside the accepted range is remembered as refused; without that, one
  malformed lap becomes a request every five minutes for the life of the install.

## 0.24.0 — 2026-07-27 "Logbook"

The lap database. Every lap you drive is now recorded locally, and the Dashboard
carries a rolling 7-day summary of it. This is the foundation the league
leaderboard is built on — the boards themselves come next, once these numbers
have been proven against real driving.

### Added

- **The Dashboard's stat tiles are now about your driving**, as the design
  system's Hub specifies: laps this week, time driven, overlays active, clean
  laps. They replace the feed state, the port and the update rate — all three of
  which the footer status bar already carries, which is presumably why the
  design spends the strip on the driver instead.

- **"This week", on the Dashboard.** The design system's weekly chart: one bar
  per day over a rolling seven, the busiest lit with the brand gradient and
  captioned with its lap count. A chart rather than a total because the question
  a driver asks of their week is *when did I drive* — one number cannot tell
  four solid days from one enormous one. Days with nothing on them still get a
  bar; the gap is the point.

  The window is *rolling* rather than Monday-to-Sunday: it needs no timezone
  policy to mean something, and the card spells out which seven days it is
  counting so "this week" is never ambiguous.

- **Best clean laps this week** — your quickest clean lap at each track in each
  class, in the design system's leaderboard row. Deliberately **unranked**: a
  position only means something within one track and one class, and these rows
  span both, so numbering them would put a 1:31 at Fuji above a 3:27 at Le Mans
  and call it a result. The Leaderboard tab is where real positions belong.

  Everything on it is read from local files, so it works offline and before you
  have signed in. Nothing is uploaded anywhere yet.

- **A local lap log.** Each completed lap is appended to
  `~/.apex-overlay/laps/<date>.jsonl` — track, car, class, the sim's own lap
  time, the conditions, and whether it was clean. Written by the server, so laps
  are recorded whether you run the desktop app or `npm start`.

  The recorded time is the **sim's own** `lastLapTime`, not one reconstructed
  from our sampling. The delta engine builds its own lap clock because it needs a
  distance→time trace; a leaderboard entry is a claim about what the sim said, so
  it uses what the sim said.

  Laps are only recorded from a real sim. Demo mode drives the overlays, not your
  history.

- **A clean-lap rule, and it is ours.** LMU publishes no per-lap validity —
  it judges track limits internally and exposes only `mNumPenalties`, once a
  penalty has landed. So a lap is clean here when it had no pit or garage visit,
  no track-limit excursion by our own geometry, no new penalty from the sim, and
  a plausible time. It is deliberately stricter than the sim, and it is labelled
  as the league's rule rather than the stewards'.

  Laps that fail still count as laps — the weekly total is what you drove, and
  `clean laps` is the subset that could go on a board.

- **The car model is now read from shared memory** (`mVehicleName`). LMU's REST
  standings publish the class, the number and the team but never which car it
  is, so a lap database had nowhere else to look for it.

### Fixed

- **The all-time-best delta was keyed by track alone**, so a lap in one car
  became the reference for a stint in another at the same circuit. In a
  multiclass field that was permanently, uselessly wrong: come back to Spa in a
  GT3 after a Hypercar run and the all-time delta sat ~10 s in the red against a
  trace with completely different braking points. The reference is now keyed by
  track *and* car.

  Traces saved under the old track-only names are orphaned by this, which is
  intended — they hold whichever car happened to set the time. The first flying
  lap in each car writes a correct one.

## 0.23.0 — 2026-07-27 "Paddock"

The control panel is now built to the design system. The account screens in
v0.21.0 were the first thing drawn to the Apex & Chill Hub kit, so the app opened
on a designed screen and then dropped into an undesigned one. That gap is closed.

### Changed

- **The panel has tabs.** A Hub-style top nav — Dashboard, Overlays, Leaderboard,
  Setups, Suggestions — with the Race/Training toggle, feed pill, gear and account
  chip on the right, and a status bar along the bottom carrying the feed state,
  the source, the port and the running version. Switching tabs is a class change,
  not a page load: a reload would drop the status WebSocket and flash the window
  black. The chosen tab is remembered between launches, because the tab someone
  lives in says what they use the app for.

- **Overlays is now a card per widget, with both destinations labelled.** Each card
  carries the widget's icon, what it does, its Browser-Source URL with copy and
  preview, and two switches: **OBS** and **In game**. The first pass had a single
  unlabelled switch beside the widget name, which said nothing about *which*
  destination it controlled — a widget can be on in one and off in the other, and
  collapsing that to one toggle would have removed a real capability.

- **Settings became its own view**, behind the gear, in four cards: Server (port,
  update rate, demo mode, track-limits threshold), Appearance (widget background,
  text size, radar car size), Audio & feedback (cues, volume, change glow) and
  Bindings. The kit has only a gear icon, and ten controls plus two binding tables
  do not belong in a popover.

- **Update and error banners moved above the tabs.** A failed server start has to
  be visible from whichever tab you are on, not only the one that raised it.

- **The window opens at 1180×820** (was 1000×800). Five tabs plus the mode toggle,
  pill, gear, account chip and power button only fit 1000px by dropping the tab
  labels to icons, which is the narrow-window fallback rather than the intended
  first run. Below ~1080px they still do exactly that.

### Added

- **Coming-soon screens for Leaderboard, Setups and Suggestions**, using the kit's
  own pattern from `Setups.jsx` rather than a new one, each listing what is
  actually planned. **Training** mode appears in the toggle but ships disabled with
  the kit's purple chip: it gates a lap database and audio markers that do not
  exist yet, and hiding it would misrepresent where the app is going. No password
  box — in an unpacked-asar Electron app that is decoration, and when there is
  something real behind a tab the gate becomes a server-side account flag.

- **`npm run test:panel-parity`** — a guard on the panel's wiring. The panel is
  plain HTML wired up by id, which is invisible to both a typecheck and a
  screenshot: rename or retype one element and the control silently stops doing
  anything while the panel still looks perfect. It asserts every id the renderer
  looks up exists, that none is declared twice, that no wired control changed
  element type, and that every icon reference resolves. It went in *before* any
  markup moved, and was deliberately broken three ways to prove it bites.

- **`icons.js`** — one inlined SVG sprite (43 symbols, all used), shared with the
  account screens, which drop their own copy. Injected as the first thing in
  `<body>`: a `<use>` whose target does not exist at parse time renders nothing,
  with no error and no warning.

### Notes

- **Nothing was lost and nothing was rewired.** All 47 controls keep their id and
  element type; `control-panel.js`'s logic, its `window.apex.*` calls and every IPC
  handler are untouched. `renderOverlays` — the only markup the renderer builds —
  was restyled by changing class names and nesting, with each listener still
  attached to the element that function creates. Verified by clicking the real
  controls against a logging stub: the OBS and in-game switches, copy, preview, the
  appearance sliders and v0.22.0's track-limits threshold all emit the same calls
  with the same payloads as before.
- The design kit itself is untouched and unused at runtime. `ui_kits/hub/*.jsx` is
  React plus in-browser Babel plus Lucide from a CDN; none of it can load under the
  panel's CSP, so its structure and CSS are ported into the vanilla renderer and
  the JSX stays the reference for what things should look like.
- The old `.overlay-row` CSS is deleted rather than overridden — its
  `align-items:center` centred every child of the new flex-column card.
- The nav's bell and info buttons from the kit are deliberately absent: there are
  no notifications and no about screen, and two dead buttons are worse than a
  plainer nav.

## 0.22.0 — 2026-07-27

### Changed

- **Track limits are far less trigger-happy.** The threshold moved from 1.0 m
  past the sim's track edge to **2.4 m**, and is now a slider in the control
  panel (0.5–5.0 m, live, no restart).

  The original 1 m was half a car's width, on the reasoning that a centre one
  half-width past the edge puts all four wheels past it. The arithmetic was
  right; it was the wrong edge. `mTrackEdge` marks the AIW's *drivable surface*,
  which on most circuits runs at or inside the white line — so the kerb is
  already past it, and riding a kerb the way every driver rides a kerb counted as
  running wide. 2.4 m is a car's half-width plus a kerb, so all four wheels are
  clear of the kerb before anything counts. Turn it down toward 1.0 for the
  strict all-four-wheels-past-the-line reading; up for circuits with unusually
  wide kerbs.

  The demo's synthetic excursion now derives its distance from the tracker's own
  default instead of hard-coding 2.2 m — it silently stopped counting the moment
  the default moved, which took the widget's whole warning path out of reach in
  demo mode without anything appearing to be wrong.

- **The consequence indicator holds for 4 seconds**, down from 6, and is now a
  banner across the Track Limits widget rather than a colour change. It covers
  the readouts on purpose: for those four seconds there is nothing on that widget
  more important than a penalty having just landed. The window is defined once in
  the runtime, because the MFD announces the same event and the two disagreeing
  about how long "just now" lasts would look broken at exactly the moment the
  driver is paying most attention.

- **Lap and time no longer read "LAP —" before the session starts.** Both the
  standings strip and the relative header now show a **pre-session** header while
  in the garage, on the grid or on a formation lap: the session you are about to
  run and how long it is booked for — `RACE · 16 LAPS`, `PRACTICE · 30 MIN` —
  plus `ON THE GRID` / `FORMATION LAP` where that applies.

  This needed two new facts on the frame rather than a widget guess. `notStarted`
  is its own field because "no laps yet" and "this session has no lap count" look
  identical on the wire and mean opposite things; `scheduledLengthSec` is the
  session's *full booked* length, because the remaining clock before the flag
  drops is the countdown to the start, and showing "5 MIN" for a thirty-minute
  practice is worse than showing nothing.

### Added

- **One tyre control in the MFD, named the way the sim names compounds** — `NO
  CHANGE · MEDIUM · WET`, and hards/softs wherever the class runs them, straight
  from the sim's own option list.

  LMU carries the tyre decision as four independent per-corner rows that each
  cycle the same list. Nobody changes one corner, so expressing "put the wets on"
  meant four rows of scrolling, and the section read as a list of indices rather
  than a choice between compounds. This collapses the four into one control and
  writes all four together in a single read-modify-write — not just fewer
  requests, but the only way to avoid a held button interleaving four sequential
  writes into a genuinely mixed set. The per-corner rows are untouched below for
  anyone who does want one corner, and a mixed set is reported as `MIXED` rather
  than resolved to one corner's answer.

- **Penalties and the two things you can do about them, on the MFD.** The
  outstanding count, with the same four-second consequence highlight, plus:

  - **SERVE STOP/GO** — strips the next stop back to no service *and* requests
    it. The clearing is the part that matters: a stop-go taken with a normal
    strategy still loaded gets a full service, which does not discharge the
    penalty and loses the stop as well. Tyres, damage, fuel, virtual energy and
    driver change are cleared; wing, ducts, pressures and **fuel ratio** are
    deliberately not — none of them adds time on its own, and wiping the driver's
    setup as a side effect of serving a penalty would be worse than the penalty.
  - **REQUEST PIT** — a normal stop.

  Both are also bindable actions (`pit.serveStopGo`, `pit.request`,
  `pit.clearService`, `pit.tyreCompound`) so they work from a wheel button or a
  Stream Deck. The request half is a keystroke rather than a REST call because
  LMU exposes no pit-request route — the whole 176-endpoint surface was checked,
  and the nearest thing tells the *AI* driving your car to pit, which would be
  wrong to quietly substitute. When "Pit Request" is bound only to a wheel button
  (where most drivers have it) the failure says exactly that and, after a
  stop-go, confirms the menu was still cleared.

- `scripts/test-mfd.js` — 26 assertions over the two pit-menu decisions that are
  pure judgement rather than plumbing: collapsing the per-corner tyre rows, and
  which rows a stop-and-go may strip. `FUEL RATIO:` is the trap in the second
  one — it reads as fuel and is a strategy setting for later stops.

## 0.21.0 — 2026-07-26 "Paddock Pass"

The first slice of the cloud phase: the app now has **accounts**. Nothing about
the overlays changes if you don't want one — this is the door, not a toll gate.

### Added

- **Sign in, create account and reset password screens**, built to the Apex &
  Chill design system (Hub kit): the split layout with the gradient-lit brand
  panel on the left and a single 380px form column on the right. The window opens
  on them and swaps to the control panel once you're in.

  **Continue offline** is a first-class button, not fine print. Every overlay,
  the in-game layer and the server work exactly as before without an account, and
  the choice is remembered so the screen doesn't ask twice. The top bar keeps a
  **Sign in** button for whenever it becomes worth it, and shows who's signed in
  with a **Sign out** next to it.

  The hero title scales with the window rather than sitting at the design's 44px:
  the panel opens at 1000px wide, where 44px wrapped "BROADCAST-GRADE" and lost
  the intended two-line break.

- **Password reset as a code, not a link.** A recovery link needs a web page to
  land on and this is a desktop app, so the reset flow is three steps in the
  window: request a code, paste it with the new password, done. It accepts the
  whole reset link pasted in too, and pulls the token out — the default Supabase
  template mails a link whose `token=` param is the *hashed* token, which goes to
  a different GoTrue field than a plain one-time code, and getting that wrong
  fails every reset while the code in the email is perfectly good. It tries the
  shape it inferred, then the other one; a rejected verify consumes nothing.

  For a plain code to arrive, the recovery email template needs `{{ .Token }}`
  (Supabase dashboard → *Authentication → Emails → Reset password*).

- **`public.profiles`** — one row per driver (display name, primary sim, email
  opt-in), created by an `on_auth_user_created` trigger from the metadata the
  register screen collects, so no second write can be lost between signup and
  first launch. RLS lets a driver read and write only their own row; the trigger
  function's `EXECUTE` is revoked from `anon` and `authenticated` so it can't be
  called as an RPC.

- `npm run test:auth` — 28 offline checks over the two bits of this that are easy
  to get quietly wrong and impossible to see on a screenshot: which GoTrue field
  a pasted token belongs in, and the shape of the user object handed to the
  renderer (asserted to carry no token fields at all).

- The `APEX_SHOT` capture pass now walks all six states of the account page, not
  just the one it opens on.

### Notes

- **Supabase calls all happen in the main process** (`electron/auth.js`). The
  panel's CSP is `default-src 'none'`, so the renderer couldn't load supabase-js
  or reach supabase.co even if we wanted it to — and this way access and refresh
  tokens never cross the preload bridge. The session file
  (`%APPDATA%/apex-overlay-system/session.json`) is written only when **Remember
  me** is ticked, and mode 0600 where the OS honours it.
- A network failure while restoring a remembered session does **not** sign you
  out; only a 4xx (a genuinely revoked token) clears it. Losing your login
  because the wifi dropped mid-race-weekend is not an acceptable failure.
- No new dependency: GoTrue is plain REST over Node's built-in `fetch`.

## 0.20.0 — 2026-07-26

### Added

- **A Track Limits widget.** How many times you have run wide this session, how
  many penalties the sim has actually issued for it, and — the part that is
  useful *before* the mistake — a bar showing how much road you have left right
  now. The overlay had nothing at all on limits, which is the one mistake in
  endurance racing that compounds silently: you know you ran wide, you do not
  know whether that was the first or the third.

  The two counts are **kept apart on purpose**. The headline (amber, under
  "LIMITS") is ours; the red "PEN" chip is the sim's own `mNumPenalties`. They
  can disagree, because LMU judges limits internally against the white line and
  publishes no warning tally anywhere — not over REST, not in shared memory. An
  earlier build had a fresh penalty take over the headline number for a few
  seconds and it read as a lie: a red "5" under the word LIMITS is five
  penalties to anyone glancing at it, when it was five warnings and one penalty.
  Two differently-sourced numbers get two places.

  The warning count is derived from the two channels that *do* exist —
  `mPathLateral` against `mTrackEdge` — plus half a car's width, since those
  measure the car's centre and the rule everyone races to is all four wheels
  beyond the line. Counting is one excursion per mistake however long it lasts,
  with hysteresis so a car balanced on the limit does not tick over and over, a
  100 ms minimum so a kerb strike is not a run-off, and nothing counted in the
  pit lane or below racing speed. All of that lives in
  `src/telemetry/trackLimits.ts` behind 28 headless assertions
  (`npm run test:tracklimits`) — none of those failure modes is visible on a
  screenshot of a clean lap.

- **A pit-release light on the radar.** A red ring around your own car while the
  crew is on it; a green ring sweeping outward the instant they let you go.

  It is on the radar rather than beside the Damage widget's stop countdown
  because the countdown answers *how much longer*, and by the time the answer is
  "now" nobody is watching it. The radar is the widget still worth looking at
  for the two seconds after a release — and the only one that answers the
  question the release immediately creates: is anything coming down the lane. It
  wakes itself for both states, since an empty pit box has nobody inside the
  reveal perimeter. The release is detected as the moment the stop *ends*, not
  as the arrival of the "exiting" stage, so a feed that drops a phase still
  tells you.

- **Three audio cues** — a blip on a limits warning, a falling two-tone on a
  penalty, a rising two-tone on the pit release — because all three land at
  moments when the driver's eyes are, correctly, somewhere else.

  They are **synthesised**, not sound files: an oscillator and a gain envelope,
  two nodes built and thrown away per cue. Nothing is downloaded, decoded,
  buffered or held resident — which is the whole brief, and matters most in the
  in-game layer that stays resident for a stint. On by default, with **Audio
  cues** and **Cue volume** (plus a Test button) in the control panel, and
  `?audio=off` to silence one Browser Source when several share an OBS scene.
  The in-game window now runs with Chromium's gesture requirement relaxed, or
  the one layer where a cue matters most would be the one layer that stayed
  silent.

### Fixed

- **The one signed field on the frame no longer uses the `-1` sentinel.**
  `TrackLimitsState.beyondEdgeM` is metres-past-the-edge, so it is legitimately
  negative — a car with exactly one metre of road left would have reported the
  sentinel and been read as "no data". It is omitted when unknown instead, which
  has no such ambiguity. Same treatment on the way in, for the raw lateral
  channels. (The two pre-existing instances of this trap, `LapTiming.delta` and
  `FuelState.fuelDeltaLiters`, are unchanged and still noted as future work —
  this simply avoids adding a third.)

## 0.19.0 — 2026-07-26

### Changed

- **The radar shows a car coming, not a car arriving.** The fade perimeter grew
  from 3.5 car lengths to **6** (≈29 m for a GT3) fore and aft, and from 3.5 car
  widths to **4.5** (≈9 m) to each side — six lengths is about two seconds of
  run-up at a modest closing speed, where 3.5 put a car on top of you before it
  had finished appearing. Sideways grew far less on purpose: past about four car
  widths you are looking at the far side of the track, not at anyone who can hit
  you.

- **The whole-HUD reveal is now tied to that perimeter** instead of having a
  radius of its own. Two independent thresholds was the actual bug behind "it only
  shows at the last moment": the reveal gate was 12 m while the fade reached
  17 m, so a car's icon appeared already half solid with no run-up at all. Now the
  HUD wakes at the same instant the icon starts fading up from nothing — measured,
  a car closing from behind now appears at ~29 m and reaches full strength as it
  arrives. `?reveal=<m>` still pins a plain distance gate for a source that wants
  one.

- **Radar car size moved to the control panel**, next to Widget background and
  Text size (30–150%, default 50%). It belongs with the other look-and-feel knobs:
  it rides the same appearance channel, so one drag retunes every live source in
  game and in OBS instead of being set per browser source. The hover slider on the
  widget is gone; `?icons=` still pins one source, and `?range=` still wins over
  both.

- **The MFD keeps up.** The pit menu now has its own **500 ms** poll rather than
  sharing the 3 s garage timer — it is pit strategy, not slow-moving wear data,
  and the widget is a control surface for it. On top of that, a change made
  through the widget or a bound button is read back at once instead of waiting for
  the next frame, and the cursor endpoints carry the row's new value so it appears
  in the same beat as the press. Worst-case confirmation went from ~3 s to ~150 ms.
  The heavy `getPlayerGarageData` read stays on the slow timer, where it belongs:
  those values cannot move mid-session.

- **The selected pit row is far brighter** — a near-solid fill in the row's own
  category colour, a full-strength ring, an outward glow and white text. The first
  pass read as "slightly different" rather than "this one", which is useless at a
  glance mid-corner.

## 0.18.0 — 2026-07-26

### Added

- **The pit menu, from four bindable buttons.** `Pit menu ▲`, `▼`, `+` and `−`
  join the action registry, so a wheel button, a Stream Deck key or a global
  hotkey can drive the whole menu the way the in-game MFD does: scroll down to
  `FL TIRE`, press `+`, get a new medium. It goes over LMU's REST API, so the
  in-game MFD never has to be on screen and the sim does not even have to be the
  focused window.

  The named per-row actions that came before (fuel ratio, virtual energy) do not
  scale — the menu runs to eighteen rows and nobody is binding eighteen pairs of
  buttons. These four cover all of it with one piece of shared state: the
  selected row, which now lives in `src/server/pitCursor.ts` and is highlighted
  on the MFD widget, so a button press and a click on the widget move the same
  cursor. Deliberately four *pulse* actions rather than two `delta` ones — a
  delta action takes both directions from a wheel encoder but only one global
  hotkey, and these have to be bindable from a keyboard too.

  The cursor is anchored by row **name**, not index: LMU's menu changes shape
  with the car, the session and the damage state, and an index alone silently
  slides onto a different row — the driver aims at the left-front tyre and the
  next `+` lands on a brake duct. Covered headless in
  `scripts/test-pitcursor.js`, and verified live against LMU v1.3000.

- **A radar `ICONS` slider (30–150%, default 50%)**, alongside the opacity one.
  The cars were reading larger than they needed to at a glance.

  It sets the display *range* rather than multiplying the artwork — 100% is the
  classic 18 m, 50% is 36 m and therefore half-size cars. A size multiplier laid
  over the geometry would be the fixed-pixel icon 0.17.0 removed, and would break
  the property that makes the widget worth having: an icon's edge is the car's
  edge. Zooming shrinks the cars and the metres they stand on together, so
  contact still reads true at every setting. `?icons=` sets it too; `?range=`
  still wins.

### Changed

- **Radar: opponents fade with distance instead of being clipped by the canvas.**
  The fade starts at the player icon's own centre line and reaches nothing on a
  rounded perimeter 3.5 car widths to each side and 3.5 car lengths fore and aft
  (≈7 m and ≈17 m for a GT3) — an ellipse in metres, so a car coming diagonally
  fades on the same curve as one coming up the inside and no corner of the strip
  lets a blip survive longer than it should. Distance now reads as weight:
  whatever is closest is the most solid thing on screen.

- **Radar: the alongside warning bloom now begins exactly on the player's centre
  line** (reach 0.4 → 0.5 of the strip's width) and brightens outward to the side
  the car is on. Half the width is the most it can reach and still say *which*
  side: the two blooms meet on the centre line at zero, so a car either side
  lights both flanks and leaves the middle clear. A car past the fade perimeter
  no longer lights a bloom at all — it was a warning pointing at nothing.

## 0.17.0 — 2026-07-26

### Added

- **A live stop countdown on the damage widget**, from the moment work begins on
  the car to the moment it is released. Once the car is at rest in its box the
  repair estimate has done its job — the decision is made — so the same slot
  switches to counting the stop down, with a bar for how far through it is.

  It counts down the length the stop was **booked** for, snapshotted the instant
  work starts and then held: the pit menu keeps changing as the crew works
  through it, and re-reading it would move the target mid-countdown. Past zero it
  keeps going and says so (`ANY MOMENT`, `+3.2s over booked · up to +6s`), which
  is the honest reading — LMU draws `FixRandomDelay` (≤5 s) and `RandomTireDelay`
  (≤1 s) when the stop happens and publishes only the caps, so freezing on `0`
  would be the one confidently-wrong number this widget is otherwise careful
  never to show. On release it holds the **actual** stop length for five seconds.

- **`PitState` in the telemetry contract** (`src/telemetry/types.ts`), with
  ISI's own `mPitState` stages normalized across providers and the crew's clock
  attached. Decoded from LMU's `pitState` string, cross-checked against the car's
  speed so the clock starts when the car is genuinely stationary rather than when
  the sim first mentions the box. The clock runs on the server, so a browser
  source reloading mid-stop rejoins the same countdown instead of restarting it.
  The simulator provider runs a full stop on a loop — approach, work, overrun,
  release — so the countdown is reachable without a race running.

### Fixed

- **Radar: the icons are drawn at the cars' real size, on one shared scale.**
  Sprites touching now means cars touching, on both axes and at any angle.

  The two axes previously ran at different metres per pixel (±12 m lateral
  against ±70 m longitudinal, so ~5.9 px/m sideways against ~1.6 px/m fore-aft)
  and the icons were a fixed 36 px regardless of either. A 36 px icon is 20 m of
  car at the longitudinal scale, so blips merged a full car length before the
  cars did; the same icon is ~3.3 m wide at the lateral scale on a narrow strip
  and under 2 m on a wide one, so side-by-side contact showed as an overlap or a
  gap depending only on how large the widget had been dragged. Both symptoms were
  reported from a live session.

  One metres-per-pixel now drives both axes, and each icon is its car's published
  footprint (5.10 × 2.00 m Hypercar, 4.76 × 2.05 m GT3), so the class sizing is
  right for free rather than by hand-tuned multiplier. Holding the lateral
  half-width at about a track width fixes the scale at ~6 px/m, which is what
  moves the default `?range=` from 70 m to **18 m** — a spotter's range, and
  still more than the 12 m radius the HUD reveals at.

- **Radar: the edge warning no longer ends on a hard line.** The bloom is
  anchored on the canvas edge, which is where it is at its brightest — so the
  canvas rect cut it at full strength and put a vertical bar down the side of the
  widget, which is exactly what replacing the old solid bar with a soft glow was
  meant to get rid of. All four edges are now feathered after the blooms are
  drawn, so the alpha rises from nothing at the boundary to the bloom's peak a
  few pixels in. Measured across the strip: 1/255 at the edge against a peak of
  23/255 inboard, on both sides.

## 0.14.0 — 2026-07-25

Turns the MFD widget from a readout into a controller, adds a binding layer so
any input source can drive any action, and gives TC / ABS / motor map a value
the driver can actually see. A single-instance lock is still outstanding.

### Added

- **`src/server/aidShadow.ts` — tracked values for the aids LMU will not report.**
  Traction control, ABS and the motor map have **no live source anywhere** —
  verified with a noise-filtered scan of the whole telemetry record and the
  Extended block while each control was worked; REST's `VM_*` numbers are the
  frozen *setup* values and never move in-race. So the overlay counts instead of
  mirroring, seeded from the garage setup value and clamped to LMU's own
  min/max.

  Counting is only trustworthy because **both** routes are watched: the
  overlay's own `/api/mfd/aidkey` presses, and the driver's wheel presses — read
  from the very buttons LMU is bound to in `direct input.json`. A tracker that
  saw only its own writes would drift the instant the wheel was used, and these
  aids *are* bound to the wheel, because that is how people drive. Only presses
  actually **sent** are counted; one refused because the sim was not focused
  changed nothing in game.

  The values are labelled **`est`** in the widget rather than passed off as
  readings, and `POST /api/mfd` `{action:"aidresync"}` re-seeds from the setup
  value for the cases an estimate cannot cover (a change made by hand on the
  keyboard, or an aid moved before the overlay was running).
- **`src/server/lmuKeybinds.ts` — read LMU's OWN key bindings** instead of
  guessing them. `<LMU>/UserData/player/keyboard.json` stores `{function: DIK}`,
  where the integers are DirectInput scancodes — exactly what `SendInput` sends.
  Auto-locates the install via Steam's `libraryfolders.vdf`, decodes
  `DIK >= 0x80` → extended key (verified: `Pit Menu Up` 200 → `0x48`+ext), and
  re-reads on demand so a rebind in game is followed with no config change.
- **`electron/actions.js` — a named-action registry.** One vocabulary that
  keyboard, Stream Deck and wheel bindings all target: overlay toggle/interact/
  layout/background, tyre readout, four driving aids, and pit fuel-ratio /
  virtual-energy. `delta` actions take ±1 so an encoder detent maps to one step.
  Aid actions are built from LMU's bind file, so unbound functions never appear.
- **Keyboard + Stream Deck bindings**, with a Bindings card in the control panel.
  Registered as global hotkeys so they fire while the sim has focus; a Stream
  Deck "Hotkey" button therefore works with no Stream-Deck-specific code.
  Duplicate accelerators are rejected rather than silently last-wins, and a key
  another app owns reports why instead of looking bound.
- **`electron/gamepad.js` — wheel/controller input via DirectInput 8**, reached
  through the `koffi` already shipped (COM vtable dispatch; no native module, no
  new dependency). `BACKGROUND | NONEXCLUSIVE` reads while the game is frontmost
  without disturbing its own use of the device. **winmm was rejected on
  measurement**: it caps at 32 buttons and a MOZA R9 reports 128, with real LMU
  binds at ids 36–104. Polls only while something is bound.
- **MFD widget is now interactive** — ± on all 18 pit rows (LMU REST, needs
  neither focus nor a visible in-game MFD) and on brake bias (keystroke). ±
  appears only where LMU actually has a binding.
- **Switchable tyre readout** (`auto` / `temp` / `surface` / `tread`), delivered
  on the existing appearance channel and bindable to any input. `?tyres=` pins an
  OBS source. `auto` is the default and is byte-identical to previous behaviour.

### Changed

- `keySender` gains a scancode path with **extended-key support** (the old
  virtual-key route could not send the arrow-bound pit-menu keys), a **70 ms
  default hold** because a zero-length press can fall between a game's input
  polls, and a foreground re-check **before every press in a repeat** — a
  sequence validated only once put five keystrokes into an unrelated window.
- `GET /api/mfd/keymap` now reports LMU's real binds and whether its keyboard
  scheme is even enabled.

### Removed

- **`src/server/aidKeymap.ts` and `APEX_AID_KEYMAP`.** It defaulted to F13–F24,
  half of which can never work: DirectInput's keyboard map stops at **F15**, so
  `DIK_F16`..`DIK_F24` do not exist. Superseded by reading LMU's own binds.

### Fixed

- `?bg=` returned early and would have blocked widget-mode delivery entirely.
  Pinning opacity is not a request to freeze the readout; they are independent.
- The MFD aid lookup missed brake bias because the telemetry frame labels it
  `BRAKE_BIAS` while the bind is keyed `VM_BRAKE_BALANCE` — aids now carry
  aliases and match whichever name a row happens to hold.

## 0.13.0 — 2026-07-25

### Added

- **A "Widget background" slider in the control panel, fading every widget's
  panel at once.** One knob (Settings → Widget background) drives the background,
  header strip, row shading, borders, brand accent bar and drop shadow of every
  widget: at **0%** all of it is gone and only the live data floats over the
  game; at 100% — the default — the overlay is byte-for-byte the solid design it
  has always been. Implemented as a single `--panel-alpha` token behind the
  surface colours in `theme.css`, so it reaches every widget at once, including
  any added later, without each one opting in.

  It applies **live**: the in-game layer is pushed the value over IPC, and OBS
  Browser Sources already added to a scene pick it up from the new
  `/appearance.json` route within a second — no restart, reload or re-copied URL,
  and no interruption to a running broadcast. Per source, `?bg=0..100` on the URL
  pins a page and overrides the app.

  Three details that make it usable rather than just transparent: below 100% the
  panel text gains a shadow and the two dimmest text tokens are lifted, so
  readings survive pale tarmac; the Fuel Planner's steppers and setup fields keep
  a faint background of their own so they can still be clicked in interact mode
  (F7); and the in-game **layout editor** forces panels back to solid while it is
  open, because a widget faded to nothing can be dragged but not found.

- **In-game widgets can now be resized horizontally and vertically, not only
  scaled from the corner.** Each widget in the layout editor gains two edge
  handles beside the existing corner one:
  - the **right edge** sets its **width**, and the widget *reflows* into it — a
    wider standings tower spends the extra room on driver names instead of
    magnifying the whole thing, which is all the corner handle could ever do;
  - the **bottom edge** sets its **height**, boxing the body and clipping what
    does not fit — the way a 20-car field gets cropped to the top few rows;
  - the **corner** keeps its original uniform `transform: scale` behaviour.

  Double-click a handle to return that dimension to automatic. Width/height are
  persisted per widget in `ingameLayout` alongside `x`/`y`/`scale`; absent means
  "the widget's own size", so existing saved layouts are unaffected.

### Changed

- `ServerConfig` gains `panelOpacity` (env `APEX_PANEL_OPACITY`, 0–100) as the
  boot value for the above, plus `setAppearance()` / `getAppearance()` on the
  server module so the desktop app can retune it in-process at runtime.

## 0.12.8 — 2026-07-24

### Changed

- **Radar proximity-reveal radius widened from 6 m to 12 m** — icons now fade in
  a little earlier as a car approaches. Still overridable with `?reveal=<metres>`.

## 0.12.7 — 2026-07-24

### Changed

- **The radar is now a proximity alert.** Every icon — the car blips *and* the
  player's own arrow — is invisible by default and **fades in only when a car
  comes within 6 m**, then fades back out as the nearest car leaves that radius.
  The fade is applied to the whole canvas so each icon keeps its own styling.
  Override the trigger distance with `?reveal=<metres>`.
- **Removed the brand gradient bar** on the left edge of the radar, so it is a
  completely bare HUD — nothing but the icons over the game feed.

## 0.12.6 — 2026-07-24

### Fixed

- **The MFD driving-aids readout now shows LIVE brake bias.** It used to read the
  aids from LMU's REST garage data, which only reports the frozen **setup** value
  — so brake bias, TC/ABS maps and the rest never moved when you adjusted them
  in-race and looked broken. Verified with two live tests that LMU exposes **no**
  live value for the TC/ABS/engine maps anywhere, so those rows are removed.
  Brake bias — the one aid with a live value — is now read from **shared memory**
  (`mRearBrakeBias`, offset 664, verified live on the player's own record) and
  updates in real time as you shift the balance, in the sim's own `front:rear`
  format. Added `scripts/probe-lmu-brakebias.js` for re-verifying the offset if
  an LMU update moves it.

## 0.12.5 — 2026-07-24

### Changed

- **The radar is now a pure HUD — totally transparent apart from the icons.** The
  scope backdrop, distance gridlines, axes and the panel box/header are all gone,
  so only the car blips and your own arrow composite over the game feed. In the
  in-game **layout editor** the panel border and header return (plus the usual
  dashed item outline) so the widget can still be found and positioned.
- **Car icons are larger** (18 px half-length) so the per-class silhouettes and
  ghosts read at a glance, and the player's own marker is a bigger, outlined
  arrow that stays visible over any part of the track.

## 0.12.4 — 2026-07-24

### Changed

- **The radar now also ghosts same-class cars a lap down.** A car you've put a
  lap on is lappable traffic whatever its class, so it draws as a Pac-Man ghost
  too — not just genuinely slower classes. A faster-class car is never ghosted
  (its ring still warns you) even if it's temporarily a lap behind. Adds a
  `lapsDown` signal (player laps − car laps) through `RadarBlip` and both
  providers.

## 0.12.3 — 2026-07-24

### Changed

- **Radar blips are now per-class car icons, ~3× larger.** Instead of one small
  coloured dot for every car, each blip is a top-down silhouette drawn to its
  class: a boxy GT car (GT3/GTE/GT4) with a cabin, and distinct Le Mans
  prototype shapes for Hypercar (sharp nose + shark fin), LMP2 and LMP3 (smaller).
  Class colour is unchanged.
- **Backmarkers show as a Pac-Man-style ghost.** A car in a genuinely slower
  class than you — traffic you're catching to lap — is drawn as a ghost (dome,
  wavy skirt, eyes) in its class colour, so lappable traffic reads at a glance
  and is instantly distinct from a same/faster-class car.
- The faster-class marker is now a coloured **ring** around the car rather than a
  filled disc, so the silhouette stays visible. Car numbers moved just below the
  icon (outlined) to keep the shape clean.
- Demo mode gained an **LMP3** class (now Hypercar / LMP2 / LMP3 / GT3) so all
  four icons and the ghost marker are visible without a live session.

## 0.12.2 — 2026-07-24

### Changed

- **The MFD widget is now a clean read-only display.** Removed the interactive
  ◀ ▶ / − + buttons — the MFD mirrors what you've set in-game rather than trying
  to change it. The two sections (**PIT STRATEGY**, **DRIVING AIDS**) now have
  prominent gradient-underlined headers, and every row is **colour-coded by
  category** — tyres, pressures, ducts, aero, fuel, brakes, traction, engine,
  hybrid — with a little air between colour blocks so related lines read as a
  group. Same-category rows share a coloured left stripe and a faint tint.

  The `?readonly` param is gone (the widget is always read-only now); `?pit`,
  `?aids` and `?opacity` are unchanged. The server-side control endpoints remain
  but are no longer used by the widget.

## 0.12.1 — 2026-07-24

### Fixed

- **The MFD widget was missing from the desktop app's overlay list.** It shipped
  in the overlay pages (and worked at `widget.html?w=mfd`), but wasn't added to
  the control panel's `OVERLAY_CATALOG`, so the app neither listed it nor gave it
  a Copy/Preview URL. Added to the catalog. It defaults **out** of the transparent
  in-game layer — it's a clickable control page, not a HUD graphic — and
  `ingame.html` now loads its script so it still renders if enabled there. New
  catalog entries added in a future update now take their catalog default rather
  than being force-enabled in the in-game layer.

## 0.12.0 — 2026-07-24

### Added

- **MFD control widget** (`?w=mfd`) — a new overlay that reads *and writes* the
  in-game Multi-Function Display for the player's car.

  **Pit strategy** is fully live: fuel ratio, virtual energy, tyres and the four
  corners, wing, grille, pressures, brake ducts and repairs, each a ◀ ▶ that
  cycles the row through LMU's own REST garage API
  (`POST /rest/garage/PitMenu/loadPitMenu`). Every change is read back so the
  widget shows the sim's own value rather than a guess, and is clamped to the
  sim's declared option list so it can never post an out-of-range setting.

  **Driving aids** (brake bias, ABS/TC map, engine mixture, regen) are shown and
  settable at the **setup** level (`POST /rest/garage/<VM_KEY>`) — a starting
  value LMU applies on track, not a live in-race adjustment.

  Opacity slider and `?pit` / `?aids` / `?readonly` / `?opacity` params like the
  other widgets. The MFD block is overlaid onto the frame even before a session's
  timing feed is live, so it works at the garage/setup screen. See
  `src/telemetry/mfdControl.ts`, `src/server/mfdRoutes.ts` and the REST map probe
  `scripts/probe-lmu-mfd.js`.

### Notes

- **Live in-race aid control cannot be driven from the overlay.** LMU ignores
  software-injected keystrokes — it reads controls via DirectInput, which filters
  non-hardware input (verified with a standard key fired at confirmed sim focus:
  LMU never captured it). So no keystroke tool — this one, AutoHotkey, or a Stream
  Deck hotkey — can move an aid mid-race. The keystroke scaffolding
  (`src/server/keySender.ts`, `scripts/send-key.js`, `POST /api/mfd/aidkey`,
  default F13–F24 map) is retained for a future **virtual HID controller** (vJoy)
  approach — the only route LMU trusts as real hardware — but is **not wired to
  the widget**.

## 0.11.0 — 2026-07-23

### Added

- **Spatial proximity radar widget** (`?w=radar`) — a car-relative, spotter's-eye
  radar of nearby cars, driven from the driven car's shared-memory world position.

## 0.10.5 — 2026-07-22

### Fixed

- **The traction circle rendered as an ellipse, and the steering arc as a
  flattened dome, on any widget that had been resized.** Both are drawn with
  `arc()` and were always true circles in the bitmap — the distortion was the
  bitmap being scaled to a differently-shaped element on its way to the screen.

  The canvas bitmap was sized from the element but refreshed only on **window**
  resize. Dragging a widget's corner handle in the in-game editor changes the
  element without the window changing at all, so the bitmap stayed at its old
  size and the browser squashed it to fit. Measured on a widget dragged from
  209px to 125px wide: `xScale 0.598` against `yScale 1.000` — a circle 40%
  narrower than it is tall, which is exactly what it looked like.

  Fixed in `motion`, `pedals` and `pedalsv` with a `ResizeObserver` on the
  canvas, plus a periodic re-check in the draw loop. The re-check is not
  belt-and-braces: **ResizeObserver does not deliver while a page is not
  producing frames**, which was verified here — an observer attached to a
  canvas in a hidden page never fired once. An OBS source that is not currently
  rendering, or a resize made while the overlay is in the background, would hit
  exactly that. `sizeCanvas()` is idempotent, so the check costs a few property
  reads when nothing has changed.

- **A second, smaller squash in `motion`**: `theme.css` sets
  `box-sizing: border-box` globally, so the canvas's 1px border came out of the
  height the widget assigned, leaving the content box 2px shorter than the
  bitmap — a 0.8% vertical compression at every size. Content scale is now
  exactly 1.0000 on both axes at every width.

## 0.10.4 — 2026-07-22

### Added

- **An expected-range line under the headline** — `expect 184.5–190.5s`. The
  published total is a **floor, not a prediction**: LMU draws a random delay when
  the stop actually happens (`FixRandomDelay` ≤5 s, `RandomTireDelay` ≤1 s) and
  publishes only the caps. The range counts only the work actually booked, so
  declining repairs or skipping tyres narrows it rather than quoting a blanket
  6 s.

  This is what was behind every "the widget is ~2 s out" report. Three stops,
  published repair figure against the number the game quoted in the cockpit:

  ```
   93.7 -> 95    (+1.3)
  102.75 -> 107  (+4.25)
  180.0 -> 182   (+2.0)
  ```

  Every residual inside `FixRandomDelay: 5`. The third was then timed to
  completion — published total 184.5 s, car released at 187.7 s, a 3.2 s
  residual against a 6 s cap. The widget cannot match the game's quoted number
  because that number contains a draw published nowhere; it can only be honest
  about how much slack the sim has left itself.

  A test asserts the real 187.7 s stop falls inside the range the widget would
  have quoted for it.

### Notes

- This also corrects 0.10.3's claim that `pitStopLength` is "the figure the game
  quotes in the cockpit". It is not — the game's figure includes the random draw.
  `pitStopLength` is the deterministic work time, which is the right thing to
  show, but the two are different quantities and the earlier note conflated them.

## 0.10.3 — 2026-07-22

### Changed

- **The headline is now the sim's own total stop length**, with repairs and
  tyres broken out beneath it — `pitStopLength.timeInSeconds`, read rather than
  derived. It tracks whatever the driver has selected in the pit menu and is the
  figure the game quotes in the cockpit.

- **Repairs and tyres add — confirmed, not assumed.** From a live stop:

  ```
  FixAllDamage                 102.75341796875
  TwoTireChange                  4.5
  sum                          107.25341796875
  pitStopLength.timeInSeconds  107.25341796875
  ```

  Identical to eleven decimal places. That is the concurrency question which
  kept a total off this widget for three releases, answered by the sim's own
  arithmetic rather than by our reading of `TireTimeConcurrent`.

### Fixed

- **Removed the 0.10.2 rounding rule, which was wrong.** `ceil(x / 5) * 5` was
  fitted to two samples and a third refuted it: the game quoted `107`, which is
  not a multiple of 5. The published figure was 102.75 and the game's 107 was
  `pitStopLength` all along — the widget had been reading the wrong field, not
  rounding the right one badly. `?exact=on` goes with it; there is no longer an
  approximate figure to switch away from.

- A stale `repairSec` reference threw a `ReferenceError` on every frame after
  the body had rendered, which left the header stuck on its placeholder `— s`.

### Notes

- The real stop still runs a few seconds beyond the published total —
  `FixRandomDelay` (≤5 s) and `RandomTireDelay` (≤1 s) are drawn when the stop
  happens and appear in nothing published beforehand. A stop measured at 112 s
  against a published 107.3 is those, not an error.

## 0.10.2 — 2026-07-22

### Changed

- **Both times now match the game's own pit message.** LMU rounds its quote
  **up to the nearest 5 s**, and the widget now does the same, so the overlay
  and the cockpit never disagree in front of the driver.

  The rule is `ceil(x / 5) * 5`, derived from one screenshot with the widget and
  the game's message in frame together: a published `93.7` was quoted as
  `Damage 95 sec`, and a published `4.5` as `Tyres: 5 sec`. Both satisfy it.
  That is two data points rather than a proof — so the **precise values are
  kept** on `DamageState` alongside the rounded pair, and `?exact=on` displays
  them. If a third sample contradicts the rule, only `gameRounded()` changes.

  Rounding **up** is deliberate: the game is being pessimistic about the stop,
  and a driver deciding whether to pit should never be handed a cheerier
  estimate than the one the game will quote them.

- New `?exact=on` mode on the Damage widget, for the precise published seconds.

## 0.10.1 — 2026-07-22

### Added

- **A separate tyre line on the Damage widget** — `TYRES · 2 corners · 4.5s`,
  under the repair figure and above the component bars. Priced from the sim's
  own `TwoTireChange` / `FourTireChange` against the corners actually selected
  in the pit menu, and shown even on an undamaged car, where a tyre stop still
  has a length worth knowing.

  It is reported **beside** the repair figure and **never summed with it**. The
  sim's `TireTimeConcurrent` flag decides whether the two overlap and that flag
  is still unverified against a real stop, so two honest figures the driver can
  add up beat one total that could be wrong by the whole tyre time.

  One selected corner is priced as `TwoTireChange`, because that is what the sim
  publishes — there is no one-tyre figure. Confirmed against the game's own pit
  message, which read `Tyres: 5 sec` for a single corner against a published
  `TwoTireChange` of `4.5`. The `TIRES:` all-four shortcut is explicitly not
  counted as a fifth corner, which would push a two-tyre stop into the four-tyre
  price.

### Notes from testing in-game

- **`FixAllDamage` scales properly with severity.** At 9.5% aero / 19.5% FR it
  read 35.1 s; at 35.7% aero / 52.1% FR it read 93.7 s. The one open question
  from 0.10.0 is closed — the widget reads the figure rather than modelling it,
  and the figure moves.
- **The game rounds its own display up to the nearest 5 s.** Its pit message
  read `Damage 95 sec` against a published `93.7`, and `Tyres: 5 sec` against a
  published `4.5`. The widget shows the precise published value rather than the
  rounded one, so a small disagreement with the in-game message is expected and
  is the game being pessimistic, not the widget being wrong.

## 0.10.0 — 2026-07-22 "Contact"

A new widget that answers the question a driver actually asks after contact —
*how hurt am I, and what does fixing it cost?* — and a probe that found where
the answer lives.

### Added

- **Damage & Repair**, a new widget: aero and per-corner suspension severity as
  bars, the sim's own repair time as the headline figure, and what the pit menu
  currently has selected. Three modes (`?dmg` / `?repair` / `?brakes`), the last
  defaulting off since disc thickness is wear rather than damage. The same hover
  opacity control the Motion widget established.

  The repair figure is **LMU's own live estimate**, read straight through. There
  is deliberately **no "total stop time"**: folding tyre and fuel time in would
  mean trusting `FixTimeConcurrent` / `TireTimeConcurrent` / `FuelTimeConcurrent`
  to mean what they appear to, and a wrong reading there produces a confident
  total twenty seconds out. Same restraint as 0.8.0's refusal to fabricate an
  understeer number and 0.9.0's refusal to fabricate a calibrated corner load.

- **Damage telemetry over REST**, via `telemetry/damage.ts`. `PlayerState` gains
  an optional `damage` block — **absent, not zeroed**, when the endpoint is
  stale, when spectating, or on rF2. A zeroed block renders identically to a
  pristine car, and a driver would drive past the pits on it.

- **`scripts/probe-lmu-damage.js`** — a read-only probe that watches both
  candidate damage sources at once, and `npm run test:damage` (47 cases, most of
  them about malformed payloads rather than arithmetic).

### Where damage actually comes from, and where it does not

The inherited rF2 damage block is present in the struct at offsets pinned
exactly by the verified anchors either side of it — and **LMU does not populate
it**. Through a real impact in a live session: `mLastImpactET` never fired,
`mEngineWaterTemp` and `mEngineOilTemp` read 0 °C on a running engine,
`mScheduledStops` read 255. Only `mDentSeverity[0]` moved, to a coarse `1`, then
froze.

`/rest/garage/UIScreen/RepairAndRefuel` reported the same impact as continuous
per-component severities — `wearables.body.aero` `0 → 0.0950`,
`wearables.suspension[1]` `0 → 0.1950` — with
`pitStopTimes.times.FixAllDamage` moving `30 → 35.098` and the `DAMAGE:` pit
menu transforming from a lone `"N/A"` into
`["Do Not Repair", "Repair Body", "Repair All"]`.

That endpoint was **already being polled every cycle** by `lmuRestProvider`,
which read one field out of it (`wearables.tires`). The widget costs no
additional request.

### Fixed

- Demo mode's damage cycle ran on a 15-minute period, not the ~80 s its comment
  claimed — `weatherPhase` advances at 0.02/s, which the multiplier had not been
  set against. Severity was also rounded with `round2`, quantising a `0..1`
  fraction to 1% steps so the measured 9.5% rendered as 10.0%.
- `.damage__clean` / `.damage__hero` now hide under `[hidden]`. A class selector
  that sets `display` outspecifies the UA's `[hidden]` rule, so both states
  rendered at once — "NO DAMAGE" directly beneath "+32.7 SEC".

### Removed

- **The Chassis widget.** It rendered, but a wireframe car with load columns
  turned out not to earn its screen space next to the data a driver actually
  acts on. Removed from the catalog, both overlay pages, the shell registry,
  the in-game defaults and the stylesheet — `overlay/js/widgets/chassis.js` is
  deleted with them.

  **The telemetry it fed is kept**: `src/telemetry/chassis.ts`, the load and
  suspension channels on both providers, the `chassis` block on `PlayerState`
  and all 29 tests. Those are provider-level, verified, and the natural input
  to a damage or suspension readout later. Restoring the widget itself is
  `git checkout v0.9.1 -- overlay/js/widgets/chassis.js` plus the six
  registration points listed in the 0.9.1 notes.

## 0.9.1 — 2026-07-22

Fixes 0.9.0, in which the Chassis widget shipped complete and could not be
seen. The widget itself was fine; it was never registered in the three places
that decide where a widget goes and whether it is offered at all.

### Fixed

- **Chassis is now in the control panel's overlay catalog.** `OVERLAY_CATALOG`
  in `electron/main.js` is the list the panel renders, the source of the
  per-widget OBS URL, and what `defaultSettings()` walks to enable a widget on
  a fresh install. Chassis was absent from it, so the installed app offered no
  way to switch it on and no URL to add to OBS. Existing installs pick it up
  enabled, because `loadSettings()` starts from the defaults and only overrides
  keys the stored file actually contains.
- **Chassis now has a position on the combined overlay page.** Every `.widget`
  is `position: absolute`, and a widget with no rule in the layout block does
  not fall back to a sensible corner — it lands at its static position, behind
  whatever is already drawn there. It now mirrors Motion on the left edge.
- **Chassis now has an in-game default position.** Without an entry in
  `defaultsFor()` it fell through to the `{24, 24}` fallback and spawned on top
  of standings — the same failure Pace Delta hit in 0.6.6. It opens bottom-left,
  right of the vertical inputs readout, which clears its ~400px height.

### Added

- **The running version in the control panel's top bar**, under the wordmark,
  from `app.getVersion()` so it is the packaged build's own number and cannot
  drift from it. A bug report can now say which version it came from.

## 0.9.0 — 2026-07-22 "Corners"

One new overlay, and the second batch of **telemetry channels** recovered from a
struct we were already reading: the per-wheel load and suspension block was
sitting in every wheel record, being skipped past to get to the tyre temps.

### Added

- **Chassis**, a new widget: a wireframe GT3 drawn from the mid-point between
  directly behind and directly above, pivoting about a point inside the body at
  mid-wheelbase, with per-corner load columns, overload and wheel-lift flags,
  and a four-corner suspension readout. Three independently switchable modes
  (`?car` / `?susp` / `?dist`), as the Motion widget established.

  The **body rotates and the wheels do not**. They stay on the road and move
  only by their own suspension travel, so the gap between body and wheel is the
  compression. Rotating the wheels with the body would have made the car a rigid
  model being waggled, and the suspension invisible — which is most of what the
  widget exists to show.

  Body rotation is **exaggerated** (`?gain`, default ×7) because a GT3 rolls
  about 1.5° and pitches under 2°, and at true scale the car looks welded solid.
  The header always carries the **true** degrees, and says `×7`, so the picture
  is an amplifier and the numbers stay the instrument. `?gain=1` for the honest
  angle.

- **Four-corner load and suspension channels** — `mTireLoad`,
  `mSuspensionDeflection`, `mRideHeight`, `mSuspForce` and `mGripFract`, for
  both the LMU and rF2 providers. No offset probing was needed: the four
  already-verified offsets in the same wheel record (brake temp +24, pressure
  +120, temperature +128, wear +152) pin the standard ISI `TelemWheelV01` field
  order, and the load/suspension group falls out of it. LMU's shorter 260-byte
  record shares rF2's 848-byte wheel base, which the existing surface-temp and
  brake-disc offsets independently confirm.

### The calibration problem, and what was not done

A corner load of 3200 N means nothing without the car's mass, weight
distribution and aero — none of which LMU or rF2 publish. Hard-coding a GT3 mass
and a 45/55 split would have produced a number that looks calibrated and is
wrong in every car that is not the one it was tuned against.

So the widget reports load two ways, both honest: **share of total**, which is
instantaneous, exact and needs no calibration at all; and a **ratio** against a
slow average of each corner's *own* load, which self-calibrates live and so
reads the same in a GT3, a Hypercar or an LMP2. The header shows `CAL…` while
that reference converges, and the flags stay off until it has. Same principle as
0.8.0's refusal to fabricate an understeer/oversteer number.

`expectedLeftShare()` cross-checks the load channel against the independent
lateral-G channel — the chassis equivalent of `motionConsistency()`. It is used
by the tests to catch an inverted or mis-offset load block, never to produce a
displayed number.

### Changed

- `PlayerState` gains an optional `chassis` block. **Absent, not zeroed**, when
  spectating or when the wheel block fails its guards, so the widget can tell
  "no data" from "a car sitting perfectly flat" — the same contract `motion`
  uses.
- Demo mode synthesises a plausible load block and runs it through the **real**
  decoder, so the thresholds, warm-up gate and reference average are exercised
  without a sim running. Only the raw numbers are invented.

### Notes

- `?yaw` defaults to `0` — exactly on the car's centreline, as specified. The
  cost is geometric and unavoidable: on-axis, a wheel's circle is edge-on to the
  view and projects to a bar rather than a disc. `?yaw=15` trades a little
  attitude purity for wheels that read as round.
- `scripts/test-chassis.js` (29 cases) joins the suite.

## 0.8.0 — 2026-07-20 "Attitude"

Two new overlays, and the first new **telemetry channels** since the tyre temps:
the vehicle motion block — G-force, rotation rate and orientation — was sitting
in the shared-memory record all along, being read past every frame.

### Added

- **Inputs V**, an alternate pedal-inputs widget. The original is untouched and
  neither replaces the other. Where that one scrolls throttle and brake along a
  time axis, this is the same widget a quarter-turn round: the pedals become
  full-width levels rising from the bottom of the readout, and steering stops
  being a line on a time axis and becomes what it physically is — an angle. The
  needle is pinned at the centre-bottom and only its tip moves, sweeping a ±70°
  arc, so the wheel is read the way you read the wheel itself.

  Losing the time axis costs the trail-braking overlap history, so both levels
  are drawn translucent in one box: where they overlap you are on both pedals,
  which is the reading the scrolling trace existed to give. A fan of ten fading
  ghosts trails the needle, because a bare needle shows where the wheel *is* and
  nothing about how it got there — the exact failing that retired the original
  steering dot in 0.7.0.

- **Motion**, a new widget with three independently switchable modes: a
  **G-meter** (traction circle, fading trail, decaying peak ring), **rotation**
  (yaw rate against slip angle, with an understeer/oversteer chip) and
  **attitude** (pitch and roll as a horizon under a fixed car reference). Each
  is toggled from the Browser Source URL and a disabled mode costs no height —
  the canvas is sized from whichever modes are enabled, and turning all three
  off says so rather than rendering an empty panel.

  Deliberately **not** a calibrated understeer/oversteer number: that needs
  wheelbase and steering ratio per car, which LMU does not publish. Two honest
  channels beat one fabricated one, so it shows yaw rate and slip angle and only
  calls a verdict past 4° of slip. Slip angle comes from the velocity vector
  alone, so it needs no per-car calibration and reads the same in any car.

- **A hover opacity slider on the Motion widget**, so it can sit over the track
  as a see-through HUD while learning a circuit. Below 100% the panel background
  and border are dropped entirely rather than faded — a translucent dark
  rectangle over a track still reads as a rectangle. The value persists per
  browser, and `?opacity=` sets it from the URL, which is the only route that
  works in OBS and in the locked in-game layer where hover can never fire.

- **Vehicle motion telemetry** — `mLocalAccel`, `mOri[3]` and `mLocalRot`, all
  decoded through one new module (`telemetry/motion.ts`) that owns every sign
  decision, since both providers read the same struct and a flipped sign
  produces a readout that looks plausible and is backwards.

  These offsets were not scanned for. `mLocalVel.z = 200` and `mGear = 352` were
  already verified live, and the three vectors plus the 3×24-byte orientation
  matrix fill 184→352 exactly — the block is bracketed on both sides by
  known-good offsets, which is stronger evidence than a scan could give.

- `npm run test:motion` — 30 checks over the axis convention, each asserting a
  situation with only one correct answer (braking, a right-hander, a nose-up
  car), plus the `latAccel = speed × yawRate` identity that makes an inverted
  lateral detectable rather than merely suspected.

- `scripts/probe-lmu-motion.js`, a read-only live probe for re-verifying the
  motion offsets if a future build shifts the layout.

### Notes on the axis convention

Two decisions here are counter-intuitive on purpose and are the kind of thing a
later tidy-up would quietly undo, so both are pinned by tests:

- **Braking is POSITIVE longitudinal.** A textbook g-g diagram would put it
  below the origin, which is what was built first and what read backwards on
  track. The dot now moves forward under brakes, the way the driver is thrown,
  while lateral still follows the direction the acceleration points so the dot
  sits on the side of the corner being turned into. The pairing is mixed by
  intent.
- **Vertical G is zero-centred, not 1 g.** LMU cancels gravity against the
  normal force, so flat ground reads ~0.00 at any speed (measured: ±0.06 at
  200 kph). It is a deviation channel — positive over a compression, negative
  over a crest. The first implementation assumed an accelerometer convention and
  the demo provider synthesised ~1 g to match; the first live probe disproved
  both, and demo mode was corrected so it cannot disagree with the sim.

## 0.7.1 — 2026-07-20

### Added
- **Backmarker ghost in the relative widget** — the mirror of 0.7.0's blue flag.
  A 👻 marks a slower car **ahead of you on the road** that you are arriving on:
  either a lap down, or in a slower class, and being caught. Where the blue flag
  says *let this car past*, the ghost says *you have to get past this one*, so
  the two are deliberately different colours — blue for yield, amber for traffic.
  They are also provably mutually exclusive: no car can ever show both.

  Unlike the blue flag, the ghost requires that you are **actually closing**,
  even on a car a lap down. One holding station ahead of you is not a problem you
  are about to have, and without that test the icon would sit lit for most of a
  stint on anything you never reach.

  Drawn as inline SVG rather than the emoji glyph: an emoji renders in whatever
  colour the system emoji font decides (so it can't be tinted to the row state),
  its size and baseline drift between the OBS Browser Source and the in-game
  layer, and the in-game layer scales widgets with a CSS transform — where a
  bitmap-backed emoji goes soft but a vector stays crisp. The overlay also ships
  no web fonts by design, so depending on an emoji font being installed is
  exactly the dependency the rest of the theme avoids.

## 0.7.0 — 2026-07-20 "On track"

First slice of the Carl + Scot roadmap: the items that are visible on stream and
need no new infrastructure.

### Added
- **Position in class, and the gap to your class leader.** The standings tower
  already grouped cars by category, but every number in the row was still an
  *overall* number — a GT3 leading its class read "P7, +2 laps", which is a
  contradiction under a GT3 header. The position column now counts within the
  class and the gap column measures to that class's leader; the overall figures
  move to the cell tooltips rather than being dropped.
- **A BEST lap column**, with the fastest lap of the race in purple and each
  class's fastest in green. In a multiclass field only one car can hold the
  purple, so without the per-class colour the LMP2 and GT3 benchmarks were
  invisible.
- **A fastest-lap-of-the-race banner** under the lap counter, naming the holder
  and the time. It persists once set — a fastest lap is a race fact, so it stays
  up after the holder pits or retires, which is when a viewer most wants it.
- **Blue-flag / backmarker alert in the relative widget.** A pulsing banner and a
  highlighted row when a car that is *behind you on the road but ahead of you in
  the race* is inside three seconds: either a lap up (an unambiguous blue flag,
  alerted regardless of closing rate) or in a faster class **and actually
  closing**. That last test is what stops the banner latching on to a Hypercar
  that is merely circulating at your pace and never arrives.
- **Virtual-energy overlap readout** — "⚡ 2 of 5 ahead pit first · +1.9 laps in
  hand" in the fuel widget. Each of those cars is a position that comes back on
  strategy alone. It sits *outside* the widget's 20-second FUEL/ENERGY rotation,
  because a strategy call you can only see for half the time is not much use.
  The comparison is restricted to cars in your own class and reports how many it
  drew from: LMU publishes every car's remaining energy but not its burn rate, so
  a car's remaining *laps* has to be estimated from someone else's burn, and that
  only holds within a class. Cross-class cars are excluded rather than guessed at.
- **The steering trace is now a trace.** Steering was a dot on a strip — it told
  you where the wheel was *right now* and nothing about how it got there. It is
  now a centre-anchored line drawn through the pedal trace on the same time axis,
  so turn-in rate, corrections and how much lock is still wound on when the
  throttle comes back are all one glance. `?steer=dot` restores the old readout,
  `?steer=off` removes it.
- **Rotating sponsor logos** under the standings tower, the way a broadcast
  timing graphic carries its partners. Add images in the control panel (they are
  copied into the app's data folder, so moving or deleting the originals later
  can't break a race) and set the seconds per logo. Two stacked images cross-fade
  on a CSS opacity transition, so the strip costs nothing per telemetry frame.
- `npm run test:multiclass` — 30 checks over the class normalisation, the
  position-in-class/class-gap derivation and the blue-flag rule. All are pure
  functions, so they run without the sim.

### Changed
- **Car classes are normalised before anything sees them.** LMU spells the same
  category several ways depending on the entry list (`Hypercar`, `HYPER`, `LMH`,
  `LMDh`, `GTP`; `LMGT3` vs `GT3`), which split one category into several groups
  in the tower. They now collapse onto a canonical set with a known speed order —
  which is also what lets the relative widget reason about "a faster car is
  coming" without hardcoding class names. An unrecognised class is passed through
  rather than discarded, and is never ranked as faster or slower than a known one,
  so a mod entry can't fire a false blue flag.
- **Demo mode is now a realistic multiclass field.** The simulator's three
  classes were cosmetic labels over a field that was covered by four seconds, so
  no faster car ever actually caught a slower one and nothing keyed on real
  multiclass behaviour — the blue flag, the energy overlap, lapping — could be
  seen without the game running. The classes now run WEC-shaped pace (~11 s from
  Hypercar to GT3), start interleaved on track rather than sorted by class, and
  the player is no longer the fastest car in its own class by construction.
- The LAST column no longer paints purple. The purple marks the fastest lap of
  the race, which is a *best* lap and now has its own column; painting LAST purple
  as well claimed the holder's most recent lap was the fastest one, which it
  usually isn't. The green flash for a freshly-set personal best is unchanged.

### Fixed
- **Pace Delta spawned on top of Standings** in the in-game layer. It had no
  entry in the default-position table, so it fell through to the same corner as
  the tower and looked like the overlay had failed to load.
- **The standings table clipped the tenths off its lap times.** Adding a column
  pushed the fixed widths past the panel; the time columns are now sized for a
  full `1:58.492` at the size the CSS actually gives them.
- **The control panel re-rendered once a second, forever.** The feed watchdog
  pushed its status unconditionally on a 1 Hz timer instead of only when the
  live/demo/no-data state changed. The push now happens on the transition, from
  both directions.
- **The simulator reset every car's pace on every completed lap**, re-deriving it
  from the slot id and throwing away the car's class offset — so a GT3's lap time
  snapped to Hypercar pace the moment it crossed the line and the tower disagreed
  with its own gaps.
- Environment-supplied ports (`APEX_HTTP_PORT`, `APEX_WS_PORT`, `APEX_LMU_PORT`)
  are clamped to 1..65535 on the `npm start` path, matching what the desktop app
  already did. `APEX_PROVIDER` and `APEX_LMU_PORT` were also missing from the
  documented list despite being implemented.
- Removed `LocalLapDeltaTracker`, superseded by the pace-delta engine and unused
  since; its stale offline test went with it (`npm run test:delta` covers the
  live engine).

## 0.6.7 — 2026-07-20

### Fixed
- **A part-lap could be adopted as your best lap, and overwrite your PB.** This
  was the real cause of the delta reading nonsense or "—" for a whole lap. When
  the overlay attached part-way round a lap — starting it mid-session, leaving
  the pits, a track reset — the tracker timed from wherever the car happened to
  be, and the moment you crossed the line it recorded that **fragment as a
  completed lap**. A half lap timed 48 s, which then beat a genuine 94 s best on
  a plain `lapSec <` comparison and was adopted as session best, as all-time
  best, and **persisted over the real PB** in `~/.apex-overlay/pb`. Every delta
  afterwards read unknown: a fragment's trace only covers part of the lap, and
  its times are measured from a start line it never crossed. Nothing could ever
  displace it either, because no real lap can beat an impossible time. Now:
  - only a lap that **began at an observed start/finish crossing** can become a
    reference — the first part-lap after attaching is used for display and then
    discarded;
  - laps that are implausibly **fast** are rejected as well as implausibly slow
    (previously only the slow side was checked, which is exactly how a 48 s
    half-lap got through);
  - a trace with a hole in it (car recovered to the track, or a feed dropout) is
    rejected rather than interpolated across;
  - a **persisted PB is re-validated on load**, so an already-corrupted file
    written by an earlier build is ignored instead of poisoning the session.

  If a bad PB was already saved for a track, delete that track's file in
  `~/.apex-overlay/pb` — it re-records on your next clean lap.
- Added `npm run test:delta` — regression checks for the above, plus delta
  stability, runnable without a test framework.
- **Lap delta no longer jumps around.** The delta was sawtoothing by up to
  **±0.15 s** several times a second — it would read a genuine three tenths, then
  snap to zero and climb again. Cause: the delta's two inputs tick at very
  different rates. The time axis (`mElapsedTime`, shared memory) is fresh every
  frame at ~30-60 Hz, but the position axis (REST `lapDistance`) only refreshes
  every 150 ms. With the position frozen between REST packets, `t − t_ref(d)`
  climbed at a full second per second and snapped back the instant a new packet
  landed. The sawtooth amplitude was exactly the poll interval. Three changes:
  - **The position is now dead-reckoned forward** by the snapshot's age × the
    car's own velocity (the same extrapolation the relative widget already used),
    so both axes advance together. Measured on a simulated 100 s lap at 60 fps
    against a 150 ms feed, this alone cuts the worst frame-to-frame movement from
    **0.1496 s to 0.0002 s**.
  - **Lap boundaries are interpolated to the sub-poll moment of the line
    crossing** instead of being stamped at whichever frame first noticed the wrap.
    That frame is up to one poll late, at random, which shifted each lap's whole
    time axis by a different 0-150 ms — a constant per-lap offset that made the
    delta read a tenth or two wrong from the moment a lap started.
  - **The readout is slew-limited and low-pass filtered** (max 1.5 s of delta per
    second of driving, 0.25 s time constant) to absorb what's left — REST
    distance quantisation, poll jitter, packet latency. The filter resets at each
    lap boundary, so the legitimate snap back to ~0 on a new lap is instant.

  Only genuine REST samples are stored as reference-lap points now; extrapolated
  positions are used for display but never baked into the lap you compare against.

### Changed
- **Delta and Pace Delta now read to 2 decimals** (`+0.30`) instead of 4
  (`+0.3021`) — what every sim's delta shows. The third and fourth digits churn
  constantly even on a perfectly stable delta, which reads as flicker rather than
  detail. The wire value keeps its 4-decimal precision, since the smoothing
  filters integrate across frames and would step if fed display-rounded input.

## 0.6.6 — 2026-07-19

### Added
- **New "Pace Delta" widget — Pacelogic-style Δt + Δv.** Replicates the two
  delta readouts of SimHub's "Pacelogic Intro Dash" for the car you're driving,
  shown as a compact 2×3 grid so every value is visible at once:
  - **Δt (Delta T)** — time delta at the same **track position** (`t_now −
    t_ref(d)`); the classic predictive delta bar. Matches SimHub
    `…LiveDeltaSeconds`.
  - **Δv (Delta V)** — progress delta at the same **elapsed time**: how far
    ahead/behind in track progress right now, converted to seconds via the
    reference pace. Matches SimHub `…LiveDeltaProgressSeconds`.

  Each is shown against three references — **SESSION** best, **ALL-TIME** best
  (persisted per track under `~/.apex-overlay/pb` so it survives restarts), and
  **LAST** lap. Signed **4-decimal** readout (`0.0000`, matching LMU); green when
  ahead, red when behind; each cell reads "—" until its reference lap exists. Add
  it as its own `?w=pacedelta` OBS Browser Source or via the in-game layer;
  `?rows=t|v|both` narrows it to a single flavour.

### Fixed
- **Lap delta now works for the driven car.** The delta engine's **time axis is
  the sim's real-time clock `mElapsedTime`** (shared memory), with lap distance
  from the REST feed and lap boundaries detected by the distance fraction
  wrapping past the line. Two dead ends were ruled out along the way:
  - the shared-memory **`mLapStartET`** reports wrong, irregular lap durations on
    current LMU builds (176 s / 252 s for real ~109 s laps), so lap timing can't
    be derived from it;
  - REST **`timeIntoLap`** is a *position-derived estimate* — identical at a
    given distance on every lap — so comparing laps against it always yields ~0
    (the delta looked "stuck at 0.00"). LMU exposes no live delta-to-best of its
    own in the REST API, so the delta has to be built from the real clock.

  `mElapsedTime` genuinely differs between fast and slow laps, so the delta now
  tracks pace correctly. The "current lap time" readout uses REST `timeIntoLap`.
- **Delta bar direction matches LMU.** The single Delta widget's fill now grows
  **right when ahead** (green) and **left when behind** (red), the reverse of
  before, to match the on-screen LMU delta.

## 0.6.5 — 2026-07-16

### Changed
- **Delta rebuilt on the real lap clock.** For the car you're driving, the delta
  now runs off the sim's shared-memory lap clock (`mElapsedTime − mLapStartET`):
  exact, physics-rate, and immune to the REST `timeIntoLap` quirk where the
  clock pauses while the car is stationary (proven to lag real lap time by tens
  of seconds). It does exactly the intuitive thing — record your fastest lap's
  trace, compare the current lap against it live, adopt a new trace when you go
  quicker — arming on your first flying lap. Spectated cars keep the REST-based
  tracker. The "Current" lap time in the Relative strip uses the exact clock too.
- **Relative widget latency cut.** Every car's road position is now
  dead-reckoned forward by its own velocity between REST snapshots (which are up
  to 150 ms stale), so gaps move smoothly at the full frame rate instead of
  stepping ~7×/second; the widget also redraws every 60 ms (was 120 ms).

### Fixed
- **Update-rate slider now works above 30 Hz.** Windows coalesces JS timers to
  ~15.6 ms multiples, so the broadcast loop silently capped at ~32 fps no matter
  how high the slider was set (60 Hz delivered 32). The loop now ticks on a fast
  cadence and broadcasts when a frame is due — measured 59 fps at the 60 Hz
  setting (was 32), 10 fps at 10 Hz. Below ~30 Hz behaviour is unchanged.

## 0.6.4 — 2026-07-16

### Fixed
- **Relative widget now shows the right cars, in the right order.** Three bugs
  compounded (verified against a live multiclass session):
  - gaps were scaled by LMU's *session-wide* pace estimate (the fastest class's
    lap time) instead of **your car's own** lap time, reading ~20% short for
    slower classes;
  - the display order was inverted — the nearest car ahead was printed at the
    *top* of the ahead group and the farthest shown car behind sat right under
    your row (it now reads furthest-ahead → nearest-ahead → YOU → nearest-behind
    → furthest-behind, like the in-game display);
  - cars parked in their garage stalls appeared as phantom entries near the pit
    straight (now excluded).
- **Lap delta now arms after your first flying lap.** Previously it silently
  needed two full laps (one thrown away, one to build the reference) before
  showing anything. A partial first lap is now used as a valid reference for the
  part of the track it covered — the delta appears as soon as it can be honest,
  shows "—" elsewhere, and upgrades to full-lap coverage at the next line
  crossing. Out-laps/crawls are rejected as references (must be within ~40% of
  the car's best), and this feeds both the Delta pill and the Relative widget's
  Δ cell.

### Added
- **Virtual energy in the fuel widget.** When the car runs an LMU virtual-energy
  budget, the widget rotates every **20 s** between the FUEL view and a new
  **VIRTUAL ENERGY** view — remaining %, average % per lap, laps left on energy,
  and the margin at the flag (colour-coded like fuel) — with a small header chip
  naming the active view. Cars without VE keep the plain fuel view.

## 0.6.3 — 2026-07-16

### Added
- **Estimated laps-to-go in the standings.** Timed races (LMU only publishes a
  countdown clock) now also show an estimated **"~N laps left"** in the session
  strip, derived from the time remaining and the leader's lap pace — so the tower
  reads both the clock *and* how many laps that works out to.
- **Real weather forecast.** The weather widget now reads LMU's actual per-session
  forecast (`START → 25% → 50% → 75% → FINISH`) instead of projecting the current
  conditions forward. Each slot shows its **temperature** and rain chance (plus
  humidity/wind under the hood), so the strip is a genuine look-ahead rather than
  a flat repeat of "now".

### Fixed
- **Virtual energy no longer shows a false red "0%".** Cars/classes that don't run
  a virtual-energy budget (e.g. LMP2) report a flat `0` all race; that now reads
  as **"—"** (not applicable) instead of a critical-red `0%` that looked like a
  car out of energy. Classes that do use VE (Hypercar, GT3) are unaffected.
- **Live lap delta now works.** The predictive delta bar was adopting a *partial*
  lap as its reference whenever the overlay started (or focus switched to a car)
  mid-lap, which produced wild bogus values (e.g. −78 s) for the rest of each lap.
  The reference is now only trusted when a lap was captured flag-to-flag, is kept
  **per car** so it survives broadcast camera cuts, and is sanity-clamped.

## 0.6.2 — 2026-07-16

### Added
- **Global hotkey for "Show in game".** Toggle the in-game overlay without
  alt-tabbing out of the sim. Defaults to **F8** and is rebindable from the
  control panel — click the **Toggle hotkey** chip and press any combination
  (e.g. `Ctrl+Alt+O`), or clear it with the `×` to unbind. The key works while
  the sim has focus; flipping it updates the control-panel switch live.

  (A middle-mouse double-click trigger is planned as a follow-up — it needs a
  low-level Windows mouse hook, so it ships separately once verified in-game.)

## 0.6.1 — 2026-07-16

### Fixed
- **Delta widget is now in the control panel.** The new Delta overlay was missing
  from the app's widget catalog, so it couldn't be switched on/off, wasn't added
  to the in-game layer, and didn't appear in the app's widget list. It's now a
  first-class overlay alongside the others (enabled by default, and its own
  `?w=delta` OBS Browser Source), so it shows with live **and** demo data.

## 0.6.0 — 2026-07-16

### Added
- **Standings grouped by class.** The tower now splits the field into class
  groups (Hypercar, LMP2, LMP3, GT3, GT4, …) under a bold subheader showing the
  class name, a class colour dot and the car count, so it's instantly clear which
  category each block of cars belongs to. Classes are ordered by their leader's
  position; colours are stable per class.
- **Positions gained / lost column.** A new `±` column shows each car's movement
  vs. the grid — green ▲ for places gained, red ▼ for places lost — computed from
  LMU's `qualification` (grid) field.
- **Virtual energy column.** Every car shows its remaining **virtual energy** as
  a percentage over a colour-coded fill bar (healthy → low → critical), from
  LMU's real per-car `veFraction` — the same figure LMU's native overlay shows
  for the cars ahead. The leader running low on energy now reads at a glance.
- **Fastest-lap highlighting.** The holder of the race's fastest lap is shown in
  **purple** (with a purple row accent); any car that sets a new personal-best
  lap **flashes green** for a few seconds, then fades.
- **Bigger lap counter + countdown clock.** A prominent session strip tops the
  standings: an enlarged `LAP x/y` counter, plus a live ⏱ countdown clock for
  timed sessions (from LMU's `timeRemainingInGamePhase`) that flashes red inside
  the final minute.
- **New Delta widget — live predictive lap delta.** A centre-anchored delta bar
  (green/left when up on your best lap, red/right when down) with a signed value
  pill, mirroring a sim's on-screen delta. The provider builds it predictively
  from the focused car's distance→time trace against its own reference lap.

### Fixed
- **Relative widget now shows Current lap time and Delta.** Both were hard-wired
  to the unknown sentinel on the LMU path, so the CURRENT and Δ cells always read
  "—". The provider now feeds the live current-lap time (from `timeIntoLap`) and
  the predictive delta. (Δ populates once a clean reference lap has been driven
  while the overlay is running — a predictive delta needs a captured lap; REST
  exposes no trace of a lap set before the overlay started.)

### Changed
- Standings driver names use the broadcast-style `T. Pereira` format and the
  panel is slightly wider so names don't truncate against the new columns.
## 0.5.5 — 2026-07-14

### Added
- **Live tyre temperatures are here.** The long-standing "LMU publishes no tyre
  temps" conclusion was wrong on two counts: the per-car record stride was
  mis-set (the same 2880-vs-1888 bug behind the pedal saga), and any check made
  in the garage reads absolute zero because LMU reports **0 K for a car not
  running on track**. With the correct stride, the whole rF2 wheel struct lines
  up (the brake-disc temp at wheel-start +24 pins it), exposing the channels the
  reader now surfaces for your own driven car:
  - **Inner-liner temp** — the mean of the `mTireInnerLayerTemperature[3]` bands
    at record offset `976 + wheel*260 + 84`. This is the number LMU's **in-game
    HUD** shows — verified against the game's own tyre MFD, matching within a few
    tenths of a degree across all four corners.
  - **Surface (contact-patch) temp** — the mean of the `mTemperature[3]`
    inner/centre/outer bands at `976 + wheel*260`.

  Surface offsets were pinned live against a SimHub reference (matched to
  0.01 °C) and the HUD channel against the game's own MFD; SimHub was only a
  calibration oracle — nothing at runtime depends on it.
- **Tyre widget shows both temps.** Each corner leads with the **inner-liner**
  temp (matches the game HUD) and shows the **surface** temp on the sub-line as
  `surf NN°`, to one decimal. It falls back to tread-% when no temperature is
  available (spectating, or the car in the garage).

### Fixed
- **No brake-disc contamination.** Each tyre band is clamped to a plausible tyre
  range (−20…200 °C), so a torn/misaligned read that slid onto a brake-disc
  channel (hundreds of °C, packed 104 bytes before each tyre block) or a 0 K
  garage value can never leak into a corner's number.
- **No tread-depth flicker.** A single missed shared-memory poll no longer blanks
  the pedals/temps to "unknown" for one frame (which read as flashing); the last
  good local-car physics is held for 0.5 s to bridge the gap.
- `scripts/scan-lmu-wheels.js` used the old 2880 stride (so it could never find
  the temps it was built to find); corrected to 1888 and given a known-offset
  confirmation line.

## 0.5.4 — 2026-07-14

### Fixed
- **The pedal trace is finally, correctly YOURS.** Root cause of the entire
  "shows another car's inputs" saga was a single wrong constant: the
  shared-memory per-car record stride was **2880 bytes; it's actually 1888**. At
  the wrong stride only the very first record ever aligned, so every other car
  (including yours whenever you weren't in slot 0) decoded as garbage — which
  masqueraded as "LMU only publishes one car", "mID is a foreign namespace", and
  "the record rotates through pit cars". None of that was real. With the correct
  stride, LMU publishes the **whole field** (all ~30 cars, live physics), and
  the player's record is matched by exact `mID === REST slotID`. Verified live:
  shared-memory speed matches the REST speed to the km/h, so it is provably your
  car — real throttle/brake/TC/ABS/gear/rpm and litre fuel.
- Player is now identified by **id, not car number** — racing numbers repeat
  across classes (a field can contain two #21s), ids don't.

### Notes
- Tyre **temperatures** remain unavailable: re-checked on the correct car at the
  correct stride while driving — LMU simply doesn't publish per-wheel temps to
  shared memory. The tyre widget stays on remaining-tread **wear** (from REST).

## 0.5.3 — 2026-07-14

### Fixed
- **Pedal trace and fuel are back.** v0.5.2's "strict slot match" assumed LMU's
  telemetry `mID` shares the REST `slotID` namespace. Live debugging at
  Interlagos proved it does not — the driven car reads `mID=4` while its REST
  slot id is `54`, so the strict match could never succeed and always returned
  *nothing*: no throttle/brake trace, no litre-based fuel (only the REST speed
  survived, which is why the speedo still matched). The reader again falls back
  to the first live-looking record (the one car LMU actually publishes), so your
  inputs, TC/ABS and fuel litres come through while driving.
- **Still yours, not the spectated car's.** The anti-"P1's inputs" guard now
  lives where it belongs: the provider only reads local physics when the REST
  feed says *you* currently have camera focus (driving in-car). Spectate another
  car and the trace/fuel go blank rather than showing their data.

### Changed
- **Tyre widget leads with wear.** Since LMU publishes no tyre temperatures,
  each corner now shows remaining tread % as the primary readout, colour-coded
  green → amber → red as it wears, instead of a large blank "—" over a tiny wear
  line. Temperature reappears as a sub-line automatically if a future build
  exposes it.

## 0.5.2 — 2026-07-13

### Fixed
- **Inputs really are yours now.** Live debugging against a running online
  session showed LMU publishes physics for exactly ONE car — whichever car
  the game camera is watching — so v0.5.1's fallback could still pick up the
  spectated car (P1). The reader now only accepts the record whose ID matches
  *your* player slot: your inputs, fuel, TC and ABS when you're driving;
  blank (never someone else's) when you're spectating.

### Added
- **Tyre wear** per corner in the Tyre Temps widget (remaining tread %),
  fed live from the game for your own car. Verified against a live session.
- Tyre **temperatures** are confirmed unavailable from LMU on current builds
  (published neither in shared memory nor the REST API) — the widget shows
  wear now and will pick up temps if a future LMU build exposes them.

## 0.5.1 — 2026-07-13

### Fixed
- **Inputs/fuel showed another car's data** — the shared-memory reader could
  pick P1's record instead of yours (every locally-simulated car has one).
  It now matches the record against your player slot from the game's own
  standings feed, so pedal inputs and fuel litres are always your car's.

### Added
- **Live TC / ABS indicators** in the Inputs widget: the throttle bar turns
  yellow while traction control cuts power and the brake bar turns orange
  while ABS releases pressure; TC/ABS chips glow with intervention strength;
  and the trace draws the post-aid line so you can read modulation depth.
- `scripts/scan-lmu-wheels.js` — diagnostic to locate LMU's tyre-temperature
  memory offsets (groundwork for live tyre temps).

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
