# Changelog

<!-- Unreleased — move under the next version heading when it is cut. The
     parser only reads "## x.y.z" headings, so nothing below is shown in the
     app until it is renamed. -->

### Added

- **The Get started checklist walks you through the app.** Shipped to everyone
  in v0.90.2 — see that section below for what it does. On the beta channel it
  carries one extra step the stable build has no control for: **magnetic
  docking**, in the on-screen-layer tour. Twenty-six steps here, twenty-five
  there; a step whose feature is not in the build drops itself and the tour
  renumbers.

## 0.91.0-beta.8 — 2026-08-25

### Added

- **Teams.** The Team tab now has a crew card: create a team, or join one by
  pasting its invite code — a short `APX-XXXXXX` code that works like a
  Discord invite. Any member can copy the code, or hit **Share invite** to
  copy a ready-made message (download link, sign-up steps, the code) for the
  team Discord; the owner can issue a new code, rename the team, and remove
  members with one click. Teams hold up to 6 drivers, you can be in more than
  one (pick the active one from the dropdown), and if the owner leaves, the
  team passes to the longest-serving member.
- **The pit wall goes live for the whole crew.** While you're driving, the
  app quietly relays your car's telemetry to your team every 3 seconds —
  only when you're genuinely the one on track. Teammates flip the new
  **My car / Team** switch on the Team page and all four screens — timing,
  positions, strategy, telemetry — show the driving car instead: fuel and
  energy, the live tyre widgets, damage, weather, the track map, the charts.
  The pill in the corner reads `RELAY · <driver>` and turns stale the moment
  the feed is more than a few seconds old, and the crew list shows who's
  online and who's in the car. Nothing to configure, no port forwarding —
  it rides each member's signed-in account.

### Fixed

- **The new speedo designs blew up when you scaled the widget.** Drag the
  cluster bigger in the in-game editor and, on release, the Apex Real design and
  all ten LMGT3 dashboards jumped to roughly four times the size they should be
  and were cut off by the widget's own frame — at 2x the plate drew itself 4x,
  at 3x it drew itself 9x. The original Apex and LMP2 designs were never
  affected. The canvas was sizing itself from its on-screen rectangle, which
  already includes the widget's scale, so the scale was applied twice: once to
  the canvas and once again by the widget around it. It now measures the
  unscaled box, and separately gives the bitmap the extra pixels a scaled-up
  widget needs — so the plates stay in their frame and stay sharp at any size.
- **The BG slider now fades the new designs' plate**, not just the values drawn
  on top of it. The background was painted once when the design loaded and kept
  that setting for the session.

## 0.91.0-beta.7 — 2026-08-24

### Added

- **The Apex Real cluster.** A new speedo design (Design dropdown → "Apex Real —
  machined cluster") that repaints the house cluster as a physical instrument:
  graphite body lit from above, machined rim with a gasket seam and metal
  grain, blue rim-light on the shoulders, backlit LCD wells, red shift lamps,
  and the rev bar as light filling a machined groove. The gear sits ABOVE the
  speed, the way a driver reads a real DDU. The LCDs carry the GT3 staples the
  feed knows: four-corner tyre pressures and temperatures, brake bias and
  aids on the left; last/best/projected laps, fuel and position on the right.
  Same silhouette and notch as the original Apex design — which is untouched
  and stays the default — so the delta widget docks identically.
- **Ten LMGT3 per-car dashboards.** One speedo design per car in the class —
  Porsche 911 GT3 R, Aston Martin Vantage, BMW M4, Corvette Z06, Ferrari 296,
  Ford Mustang, Lamborghini Huracán, Lexus RC F, McLaren 720S and
  Mercedes-AMG — each an original recreation of that car's real display
  character, drawn from photographs of the actual dashes: the Porsche's
  colour-bordered telemetry boxes, the Aston's white gear ring and rotary
  row, the BMW's chunky tiles, the Lexus's rainbow rev band, the McLaren's
  papaya-on-black, and so on. All run on live telemetry, all follow the house
  rule that nothing is invented — a channel the feed does not carry reads
  "—", and no manufacturer logos are drawn. Selectable per source with
  `?design=` like every other design.

## 0.91.0-beta.6 — 2026-08-24

### Added

- **The Team tab becomes four screens.** A pit wall is not one scroll, so the
  page now has its own sections. **Timing**: the full sheet, grouped by class
  — positions in class and overall, pit status and stop counts, last / best /
  five-lap average, gap to the class leader, interval to the car ahead,
  Virtual Energy and compound, with your car highlighted. **Positions**: the
  whole race drawn lap by lap, every car a line, overall or in-class, with
  click-to-hide driver chips. **Strategy**: the fuel plan joined by a tyre
  plan — wear rate measured lap over lap per corner, laps until the 25%
  cliff, and the verdict that matters: do the tyres outlast the fuel stint?
  **Telemetry**: a big 2D map of the learned circuit with every car placed on
  it live, the tyre and car widgets, weather, and a lap-time comparison
  graph with pickable drivers. The position and lap-time charts remember the
  whole race even if you open the page on lap 40 — the app records the field
  from the moment the server starts.

## 0.91.0-beta.5 — 2026-08-24

### Added

- **The MFD Control widget can lie down.** A DESIGN dropdown on its card offers
  the original stacked column or a **horizontal layout** with the sections side
  by side — for a rig that has more width than height to give it: a bottom
  edge, an ultrawide's flank. `?layout=row` pins one OBS source, same idiom as
  the speedo's `?design=`.
- **MFD auto-fade.** (Off by default — Settings → Display → MFD auto-fade.)
  The widget fades itself out after three seconds untouched and comes straight
  back the moment the pit-menu cursor moves — the bound ▲ ▼ + − buttons — or
  the pointer arrives. The pointer resting on it holds it awake, because fading
  a menu out from under a mouse that is aiming at it turns clicks into
  misclicks; and it never fades while the in-game layout is being edited, since
  an invisible widget cannot be dragged. The pit menu on screen only while it
  is actually being worked.

## 0.91.0-beta.4 — 2026-08-24

### Fixed

- **The delta widget now measures the notch instead of guessing at it.** The cut
  in its bottom edge was three pixel values hand-converted from the cluster's
  silhouette at one specific width (490px) and pasted into the stylesheet, with
  nothing connecting the copy back to the original. It was therefore correct at
  exactly one size: scaling or stretching either widget slid the notch out from
  under a cut that stayed where it was. The shape is now read from the cluster
  itself every time either widget moves or resizes, so the two stay seated at
  any size, any scale and any text size. Three things the hand-converted numbers
  could never account for come with it: the cluster's own 1px border, the
  letterboxing that shifts and shrinks the artwork when the cluster is
  height-boxed, and a delta that is not centred on the notch — which used to
  shear the cut off the recess entirely.
- The delta's default placement is now measured after layout rather than derived
  from a hardcoded guess at its own height, which was wrong at every text scale
  but 1.0 and seated the tip below the plateau.

### Added

- **Magnetic window docking.** (Off by default — Overlay → Magnetic docking.)
  While laying out the in-game overlay, a widget dragged or resized near another
  one snaps flush against it and takes the neighbour's measurement along the
  edge they share: side by side matches height, stacked matches width. A magnet
  mark shows on the seam that is about to take. Holding **Alt** suppresses it
  for a drag that wants to land somewhere a snap would fight. Corner-scale drags
  are deliberately left alone — scale moves in 1% steps, so the edge being aimed
  at is frequently not reachable, and a magnet that visibly refuses to land is
  worse than none.

## 0.91.0-beta.3 — 2026-08-24

### Added

- **The Team tab now reads like a real pit wall.** Each tyre corner is a
  proper widget: tyre life, pressure, a three-bar tread strip showing
  inner/middle/outer temperatures against the compound's own window, the
  inner-layer average, and — new to the whole app — the **brake disc
  temperature** at that corner, read from a channel the telemetry reader had
  verified long ago but never published. A Car telemetry card joins it:
  speed, revs, gear, worst tyre, pit status, pit limiter, compound and hybrid
  charge. The weather line gains track wetness. Engine water/oil temperatures
  are the one gap left, waiting on a live offset probe rather than a guess.

## 0.91.0-beta.2 — 2026-08-24

### Changed

- **The delta widget docks into the speedo cluster.** Its bottom edge is now
  cut to the cluster's top-centre notch — flat flanks that rest on the bezel
  rim, chamfers matching the silhouette's, and a tip that seats on the notch
  plateau — so the two read as one instrument instead of a bar floating over a
  recess shaped for it. It spawns there by default (above the cluster's own
  default spot, on the same centre line) and stays a normal widget: drag it
  anywhere, stretch it wider, or corner-scale it — corner-scaling by the same
  factor as the cluster is what re-fits the shape to a resized cluster.
- The delta widget's brand gradient strip is gone: on a symmetric,
  centre-anchored widget docked into the bezel it read as a misaligned edge,
  and its 3px sat the whole bar fractionally off the notch's centreline.

## 0.91.0-beta.1 — 2026-08-24

### Added

- **The Team tab: a pit wall for the car.** (Beta channel.) A new panel page
  showing the race the way an engineer wants it: fuel or Virtual Energy with
  laps in the tank and the margin at the flag, all four tyre corners with wear,
  temperature against the compound's window and pressures, damage and repair
  time, position and lap times, current conditions and the remaining-race rain
  timeline. A data-age pill says LIVE, DEMO or STALE at all times — the page
  never lets old numbers look current. This is Phase 1 of the team engineer
  plan (docs/TEAM-ENGINEER-PAGE.md): today it shows your own car from local
  telemetry; the team relay that shows whoever is driving comes next.
- **Fuel strategy that replans itself.** The Team tab's strategy card answers
  "from here to the flag" from what the car is actually using: stops still
  needed, the pit window in laps, each remaining stint's length and fill, and
  a live save target — the per-lap number that would drop a stop, flagged
  honestly when no realistic lift-and-coast could reach it. Works in litres
  and Virtual Energy, and updates every second. The grid-planning Fuel tab is
  unchanged; this is the in-race half it never had.

## 0.90.2 — 2026-08-25

### Added

- **The Get started checklist now walks you through it.** Clicking a row no
  longer just drops you on the right card: it starts a guided tour of that
  section and steps through its controls one at a time, ringing each one and
  explaining it beside itself. Twenty-five steps across five tours — Settings
  (the plugin, giving the sim's own MFD and pit controls a key, binding your
  own), Overlays (the two destinations per widget, the Copy button and what
  OBS does with it, the all-in-one page), the on-screen layer (Show in game,
  the hotkey that cycles into edit mode), the race engineer (voice,
  push-to-talk, how much it volunteers) and the setup screen. **Take the full
  tour** on the card runs the lot end to end.
- **The page stays live throughout.** The dim is drawn around the highlighted
  control rather than over the page, so you can press the button a step is
  describing while the step is on screen, and the checklist re-ticks itself
  when the tour closes.
- **A seventh checklist row: the setup screen.** It was missing entirely, and
  it is the tab with the one behaviour that surprises everybody — nothing you
  change reaches the car until you press Apply.

### Fixed

- **Two walkthroughs could open on top of each other.** A tour arriving at the
  Setups or Streamers tab tripped that tab's own first-visit modal, because a
  tour navigates exactly the way a person does. The modals now treat an open
  tour as a busy screen, and a tour closes any that is already up.

## 0.90.1 — 2026-08-25

### Added

- **A Get started checklist on the Dashboard.** Six things to do once, at the
  top of the first screen a new install shows — the telemetry plugin, giving
  the sim's own controls a key, binding your own buttons, getting an overlay
  on screen, laying the widgets out, and setting up the race engineer. Each
  row **ticks itself** when the thing is genuinely done, so it tells you what
  is left rather than asking whether you did it, and clicking a row takes you
  straight to the card that does it — the right tab, the right settings pane,
  the card scrolled to and lit up. Rows that cannot be finished yet say why
  ("close Le Mans Ultimate first", "no voice downloaded yet") instead of just
  sitting there unticked. **Hide this** puts it away for good, and it says so
  when all six are done.

## 0.90.0 — 2026-08-23

### Added

- **"Am I catching him?" now has a real answer.** The engineer keeps a per-lap
  history of the gap to the cars either side, so instead of today's number you
  get the story: "You're taking 0.6 a lap out of Smith — with him in about 6
  laps", or the honest bad news that he's pulling away. "Is he catching me?"
  works the same for the car behind. Trends only speak once there are a couple
  of laps against the same car — an undercut that swaps your rival never gets
  to reuse the old numbers.
- **"How long will the tyres last?"** Wear is now tracked lap over lap: worst
  corner, rate per lap, and roughly how many laps remain before that tyre is
  done. Until a rate exists you get the tread figure and "give me another lap",
  not a guess.
- **"If I box now, where do I come out?"** The engineer times real pit stops
  as they happen in your class — lane plus stationary, measured off the field,
  because the sim publishes no pit-lane delta anywhere — and projects your
  exit: position, who you'd come out behind, by how much, and how many of
  those cars still owe a stop. Until someone has actually pitted it says so
  rather than inventing a number.
- **Follow-up questions work.** Ask "how much fuel to the end?" then "and how
  many laps is that?" — the advanced engineer now remembers the previous
  exchange for a minute and a half, so the second question doesn't land on a
  blank slate. Every figure still comes from live telemetry, never from the
  earlier answer.
- The advanced engineer's telemetry summary now carries all of the above —
  gap trends, tyre life, last-lap fuel and energy burn (so "is the saving
  working?" compares your last lap against your average), and the measured
  pit-loss projection — so free-form wordings of these questions get the same
  numbers the phrase list speaks.

## 0.89.0 — 2026-08-23

### Added

- **Ask the engineer for your fuel ratio.** "Fuel ratio" was asked twice in the
  first week and refused — it's now a phrase-list question answered on the spot:
  the sim's own MFD value when the car exposes one, otherwise your observed burn
  — litres per percentage point of virtual energy.
- **The free-form engineer knows your fuel numbers now.** Litres on board, tank
  size, litres to the flag, litres to add at the stop, the margin either side,
  virtual-energy percent and margin, track and air temperature, and field size
  all ride along with a question — so "how much fuel do I need to put in to get
  to the end" is answered with the shortfall, not what happens to be in the
  tank. (The old answer read the remaining laps back to you — the one number
  the question wasn't about.)

### Changed

- **More ways of asking land on the instant answers.** "Gap to car ahead",
  "what's the gap", "tyre temperatures" (and the American "tire temp" the
  transcriber likes to write), "when should I pit", "how many laps till I need
  to pit", "track temperature", "fuel to finish" — all were falling through to
  the paid free-form path for answers the phrase list already had. A one-letter
  mishear of a multi-word phrase ("lust five average") now routes home too;
  single words are never guess-matched, because a near-miss deserves "say
  again", not a confident wrong answer.
- **The engineer hears racing words better.** The transcriber is now primed
  with the pit-wall vocabulary drivers actually use, so "gap in front" stops
  arriving as "strap-in-front" and "fuel" as a surname.
- **A clear question is never answered with "Say again?".** That reply is
  reserved for genuinely unintelligible audio; a real question the pit wall has
  no data for gets "I don't have that read", and an off-topic one gets a
  good-natured deflection instead of a broken-radio impression. Silence and
  coughs no longer spend a free-form call from your monthly allotment to find
  out they weren't questions.

## 0.88.0 — 2026-08-23

### Added

- **The league can answer your suggestions, and you get told.** Feedback used to
  be a drop box: you sent an idea, it got a status, and you never heard anything
  back. Staff can now write a reply against any item in the Admin tab's Feedback
  inbox — sending it also sets the status, so "yes, this is planned" is one
  action — and the next time that driver opens the app a card shows them their
  original message and the answer. Several replies are stepped through one at a
  time. A reply is only marked read when the driver presses **Got it**, so
  closing the app half way through leaves the rest waiting.
- The inbox shows what was already said against each item, who said it, and
  whether the driver has read it yet — so an unanswered-looking item is not
  answered twice, and silence after a reply reads as "not opened the app since"
  rather than "ignored me".

- **A failed payment now has a visible deadline instead of a silent one.** If a
  charge bounces, a banner sits across the top of every tab — what is owed, the
  exact date access ends, and a **Pay now** button that opens the outstanding
  invoice. It cannot be dismissed, because the whole failure it exists for is a
  driver who never noticed the charge failed and found out when the app stopped
  letting them in. The last two days turn it red.
- **Overdue subscriptions now lapse after 14 days.** `past_due` used to keep
  full access indefinitely — the grace window had a start but no end, so a card
  that died in January still worked in June. It is now 14 days from the first
  failed payment, counted by us rather than inherited from whatever Stripe's
  retry settings happen to be. Paying at any point during the window clears it
  completely, and a later failure starts a fresh 14 days rather than picking up
  where the old one left off.
- **A Failed payments card in the Admin tab's Billing section**, soonest
  deadline first: who owes what, how long they have left, and who has already
  lapsed. It hides itself when nobody owes anything, and the days-left figure
  comes from the same expression that decides entitlement, so the list can
  never disagree with who is actually locked out.
- **The Billing numbers count lapsed accounts as lapsed.** An overdue account
  past its deadline used to still read as a live subscription on the mix chart
  and sort among the paying members on the roster, because only the entitlement
  had been taught about the deadline. There is now one function that decides
  what a live subscription is, and the entitlement, the mix and the roster all
  ask it. Revenue is unchanged — it only ever counted accounts that had actually
  paid.

### Fixed

- **The app's icon vanished from the Start menu and desktop shortcuts.** The
  rename to Apex AIO System pushed the description NSIS writes into the shortcut
  past its 259-character limit. The truncated string desynced every length-
  prefixed field after it — including the icon path — so Windows fell back to
  the blank-document icon. The shortcut still launched, which is what made it so
  quiet. The description is short again and the build now refuses to run if it
  ever grows back past the limit.

## 0.87.0 — 2026-08-22

### Added

- **The end of the race, on the Race Control panel and on the radio.** A
  **FINAL LAP** banner the moment the chequered flag comes out, and
  **CHEQUERED FLAG — FINISHED P28 (GT3 P12)** when your own car crosses the line
  for the last time. The engineer calls both: "last lap, P4 — bring it home",
  then your result once you are actually done.
- **The sector rail shows red and chequered flags**, not only yellows.

### Fixed

- **Cars showed "1 lap down" when they were fifteen seconds apart.** In a
  multiclass race the tower would put a phantom lap between two cars in the same
  class whenever the overall leader was on the road between them — which is most
  of a stint, since that leader is forever working through the slower classes.
  The seconds gap disappeared at the same time, so the column stopped answering
  the question it exists for. Laps down are now counted from where the cars
  actually are on track rather than from each car's own count of laps down to the
  race leader, which the game steps car by car as the leader goes past. Both
  readings of the column are fixed — the gap to the class leader and the interval
  to the car in front — and a car that really is a lap down still says so.
- **The standings tower lost its BEST column.** Every car's best lap quietly
  disappeared from the tower, the virtual-energy figure slid over into its
  place, and the pit flag drifted off the right-hand edge — a whole column of
  the table shifted one across. Introduced with the optional AVG column in
  0.82.0 and present in every release since, whenever AVG was left off (the
  default). BEST is back where it belongs, and the columns line up again with
  AVG on or off.
- **Track Limits went blank during a teammate's stint, then restarted from a
  clean sheet.** In a driver-swap event Le Mans Ultimate flags no car as yours
  while somebody else is driving it, so the whole panel dropped out — and when
  you swapped back in it came back showing zero penalties on a car that was
  carrying them. Apex now identifies your car by your team's race number rather
  than by who is holding the wheel, so the penalty count is the **car's**: it
  keeps running through your teammate's stint and survives every handover.
  Nothing changes while you are the one driving.
- **A penalty your teammate picked up was thrown away as a rival's.** The
  stewards name a penalty after whoever was in the seat, and Apex only ever
  recognised the current driver — so a drive-through earned during someone
  else's stint never showed on the panel, and never cleared the track-limit
  points it had just paid off. Penalties are now matched against your whole
  crew.

### Changed

- **The relative panel counts in class in a multiclass race.** The cars nearest
  you on track are mostly from other categories, so an overall position there
  was the one number nobody in the picture is racing for. Each row now shows
  that car's place in **its own** class, next to the class tag that names it.
  A single-class field is unchanged — the two readings are identical there.
- **Track Limits says when its points only cover your own stints.** Once a car
  has been shared, the countdown is replaced by the points you have been
  charged, headed `MY STINT`. LMU only writes track-limit rulings to your PC
  while you are in the car, so a teammate's cuts cannot be seen from here — and
  counting down an allowance using half the charges against it promises room
  that may not be there.

## 0.86.0 — 2026-08-21

### Fixed

- **No telemetry, even though the plugin installed fine.** On some PCs Le Mans
  Ultimate published nothing at all — no delta, no radar, no track map, no tyre
  temperatures — while everything looked correctly installed. The cause: the
  shared-memory plugin needs the **Visual C++ 2013 Redistributable (x64)**, and
  on a machine without it Windows cannot load the plugin, so LMU silently skips
  it and starts up as if nothing happened. Nothing anywhere said so, and
  reinstalling the app or restarting the game could never fix it. Apex now
  detects the missing runtime and tells you, with a button to go and get it.

### Added

- **A Telemetry plugin card** at the top of Settings → General. It shows the
  three things that must be true before LMU publishes anything — the plugin
  file is in the game folder, it is switched on in LMU, and Windows can load it
  — and marks the one that is wrong in red. If the plugin just needs
  installing, there is a button for that too (close the game first: LMU
  overwrites its plugin config on exit).

### Changed

- The shared-memory diagnostic script now checks for the runtime as well, and
  no longer mistakes a Realtek Bluetooth service for Le Mans Ultimate and tells
  you your game is running as administrator when it is not.


## 0.85.0 — 2026-08-21

### Added

- **A Schedule tab for the league calendar.** Thursday and Saturday Apex & Chill championships, pulled live from SimGrid: the next race, remaining rounds, grid spots, and a **Sign up on SimGrid** button that opens the championship page in your browser so you can enter from the app.
- **Engineer callouts on a button.** Last lap, sector times, best lap, gaps,
  who's ahead, position, laps left, fuel, track-limit points, damage, tyres
  and yellow flags can each be bound to a wheel button, a key or a Stream
  Deck — press it and the engineer speaks the number, no microphone. Same
  bindings list as everything else (Settings → Controls). Push-to-talk is
  still there for the rest of the phrase list, and you can still ask
  "sectors" or "track limits" out loud.
- **A Stream Deck & other devices walkthrough on the Bindings card.** Next
  to Scan for wheels: how to bind a Stream Deck, button box or macro pad
  (they just type a key — no plugin, no detector), which keys to pick
  (F13–F24), and why a wheel is a different path.

## 0.84.0 — 2026-08-21

### Changed

- **Settings is no longer one long scroll.** It now opens as four short
  sections — **General** (how the app runs), **Display & audio**,
  **Controls** (your keys, wheel and LMU's own bindings) and **Account**
  (subscription, legal, deletion) — with a section bar up top, and it
  remembers where you left off. And when every LMU control already has a
  key, the 22-row "already bound" list folds away behind a single line —
  it only unfolds itself when there is actually something to set up.

## 0.83.0 — 2026-08-21

### Changed

- **The app is now called Apex AIO System.** Same app, clearer name — it
  stopped being "just overlays" a long time ago. The installer, the window,
  the desktop shortcut and the Start-menu entry all carry the new name. The
  update arrives like any other: your settings, laps, account and sign-in all
  carry straight over, and the old "Apex Overlay System" install is replaced
  in place, not left behind.

### Added

- **Delete your account — properly.** Settings → Account & privacy →
  **Delete account & data** permanently erases everything your account owns
  on our servers: profile, leaderboard laps and traces, published setups and
  ratings, engineer questions, usage history, feedback and billing record,
  and cancels any live subscription. Type DELETE to confirm; there is no
  undo. Your local lap history and settings stay on your PC — they are yours.
- **Terms of Use and a Privacy Policy, in the app.** Both documents ship
  inside the app — no internet needed — and are one click away from the
  Settings → Account & privacy card and from the account screens, where
  creating an account now links to the exact documents you are agreeing to.
  The privacy policy says plainly what is collected, what never leaves your
  PC (your voice, your streaming logins, your full lap history), who can see
  what, and how to be forgotten.

## 0.82.0 — 2026-08-20

### Fixed

- **The penalty readout now tells you WHICH penalty you have.** A penalty used
  to show as just "1 PENALTY" on the Track Limits widget and the MFD, leaving
  you to guess between a drive-through and a stop-and-go — and serving the
  wrong one costs you a lap. The game names the penalty in its own log the
  moment it issues one, and the overlay now reads it from there: the chip and
  the MFD say **DRIVE THROUGH** or **STOP/GO 10S**, the banner adds what it
  was for ("DRIVE THROUGH — TRACK LIMITS"), and when the pit menu carries a
  serve deadline it reads as "SERVE IN 3 LAPS" instead of the game's cryptic
  "Yes(3Laps)". If the stewards disqualify you, the widget says
  **DISQUALIFIED** rather than leaving a stale penalty count on screen.
- **The track-limits points no longer reset mid-race in online sessions.** In
  a multiplayer race, another driver being given a track-limits penalty could
  wipe YOUR accumulated points back to zero — the game writes everyone's
  penalties into the same log, and the overlay assumed every line was yours.
  Penalties are now matched to your car before they touch your total.
- **The engineer now understands the natural ways of asking how long is
  left.** "Time left", "time remaining", "how much time", "laps to go" and
  "how long is left" all fell through to the slow path or got refused — only
  the exact wordings "laps left" and "how long left" were recognised. The
  whole family now gets the instant answer, which in a timed race is the
  clock plus the estimated laps.

### Added

- **An average-pace column for the standings tower.** Overlays → Standings →
  AVG adds a column showing each driver's average over their last five laps —
  the pace they are actually running, next to the one-off BEST. Laps through
  the pit lane don't count against anyone's average. The in-game panel grows
  by exactly the column's width while it's on and gives it back when it's
  off; for an OBS source, add `avg=on` to the `?standings=` address (and
  widen the source to match).

### Added

- **A volume slider for the race engineer.** On the Engineer tab, under Radio
  calls — turn her up over loud sim audio or down under your spotter, 0 to
  100%. It applies from the next line she speaks (the chirp and voice
  previews follow it too), so hit Radio check to hear the new level.

## 0.80.0 — 2026-08-20

### Changed

- **Friendlier to antivirus software.** The race engineer's helpers now run
  as ordinary signed script files instead of command-line tricks that some
  antivirus products mistake for something dodgy, and voice downloads happen
  inside the app itself rather than through system tools. Nothing about how
  the engineer works or how much of your PC it uses has changed — it just
  looks as harmless to your antivirus as it actually is. Every part of the
  app is signed by The Lilybank Agency Ltd.

### Added

- **A repair tool for broken installs.** If an antivirus quarantine or a
  half-finished uninstall ever leaves your PC refusing to install the app,
  download **Apex-Repair-Tool.exe** from the release page and double-click
  it. It closes stuck copies of the app, clears the leftovers that block the
  installer, and tells you what it did. Your settings and lap history aren't
  touched.

## 0.79.0 — 2026-08-20

### Changed

- **The race engineer now comes built in — nothing to download.** The voice
  engine, the default engineer voice (Alan) and everything advanced questions
  need are installed with the app, ready the moment you flip the switch. No
  more in-app downloads for the basics, and no more antivirus software
  grabbing the files mid-download — everything the engineer runs is now
  signed by us and ships inside the installer, which is what antivirus
  expects trustworthy software to look like. The other five voices are still
  a one-click download on the Engineer tab if you fancy a change from Alan.
  The installer is bigger (about 330 MB, roughly one onboard lap of video) —
  that's where the built-in engineer lives. Nothing about the app while
  you're driving has changed: same CPU use, same footprint, and updates stay
  small because unchanged parts aren't re-downloaded.

## 0.78.0 — 2026-08-19

### Improved

- **The engineer now answers the questions drivers actually asked on day
  one.** From the first day's radio logs: "last 5 average", "top 5 average
  lap" and the like now reach the built-in five-lap pace comparison instead
  of being refused (said digits included — "5" and "five" both work), and
  free-form questions get real data on rival pace, who's pitted and who
  hasn't, cars ahead that must stop before you, and fuel and energy burn per
  lap — so "how many cars are pitting before me" gets an answer now.

- **The engineer asks you to repeat instead of guessing.** When the radio
  mishears you into gibberish, it now comes back with "Say again?" rather
  than confidently reading out something you didn't ask for.

## 0.77.2 — 2026-08-19

### Fixed

- **Antivirus software can no longer crash the app.** If your antivirus
  blocks or quarantines the engineer's voice files (Norton is known to), the
  app used to go down with them. Now the engineer switches itself off
  cleanly, the rest of the app carries on, and the Engineer tab tells you
  what happened.

- **The Engineer tab now says when your voice files have been removed.**
  Previously, if the files disappeared after downloading — an antivirus
  quarantine, usually — the voice toggle simply did nothing. The tab now
  spots it and tells you to restore the files or re-download the voice. If
  this happens to you, add your antivirus's exclusion for the app's data
  folder before re-downloading.

## 0.77.1 — 2026-08-19

### Changed

- **The Fuel tab returns to the beta channel.** It went out in 0.77.0 ahead
  of schedule; it is back to beta-only while we finish it. If you are on the
  beta channel (or running a beta build) nothing changes — the tab stays
  exactly where it was. Everything else in 0.77.0, the race engineer
  included, is unaffected.

## 0.77.0 — 2026-08-19

### Added

- **A race engineer on the radio.** Bind a wheel button, press it, wait for
  the chirp, and ask. Twenty-eight questions are answered instantly from your
  live telemetry, on your PC, free and offline — gaps, who's ahead and their
  pace, backmarkers, fuel and energy to the flag, tyres, damage and repair
  time, brake bias, track-limit points, yellows, the weather and more. The
  full phrase list lives on the new Engineer tab, grouped and searchable, and
  phrases work inside a sentence — "mate, what's the gap ahead right now"
  lands the same as "gap ahead". The answer comes back through a proper comms
  channel — band-limited, squelch, hiss under the voice — in one of six
  neural voices you pick on the tab (each is a one-time download and works
  offline after that). The engineer only answers what the telemetry can
  prove, and says "no data" instead of guessing. The microphone is only live
  for the few seconds after you press the button — never in the background.

- **The engineer calls the race, quietly.** A Radio calls dial on the
  Engineer tab, shipping on Essential: green flag, chequered, final lap,
  safety car, red flag, penalties given and served, damage, and the fuel
  window — the calls that change the rules or end races. Turn it to Standard
  for the race story on top: your fastest laps, the field's, places gained
  and lost, the rivals' pit stops, blue flags. Or Quiet to keep it
  answer-only. It never reads out what's already on your screen, stays
  silent while you're side by side or deep in the brakes, drops a call
  rather than delivering it late, and your question always cuts in front.
  It also varies how it says things, so the tenth fastest lap doesn't sound
  like the first.

- **Advanced questions.** Ask anything the phrase list can't answer —
  "should I pit under this safety car?" — and the engineer works it out from
  your live race. Your voice is understood on your own PC (a one-time
  download on the Engineer tab) and never leaves the machine; only the
  written question and a small race snapshot are sent to fetch the one-line
  answer. You get 300 advanced questions a month; the phrase list is always
  unlimited. **Early days:** not every question will get a good answer yet.
  To improve the engineer, advanced questions and their replies are saved to
  our database while we train it — and once we're happy with it, all of that
  saved engineer data will be deleted in its entirety.

- **A Fuel tab, next to Setups.** The fuel & strategy calculator is now
  built into the panel. Pick a circuit, class and car and it plans the whole
  race: total fuel or Virtual Energy, how many stops, every stint's fill and
  lap count, and what each stop costs with LMU's sequential
  refuel-then-tyres rule. Hypercar and LMGT3 plan in Virtual Energy, the
  other classes in litres — including LMP2's 75-litre cap at Le Mans. Timed
  races account for time lost in the pits, and an Alternative Strategies
  list shows what consumption would save a stop — and tells you when that
  target is a fantasy.

### Changed

- **The installer is signed.** Windows no longer shows the "Windows
  protected your PC" screen, and the publisher reads as The Lilybank Agency
  Ltd instead of "Unknown publisher".

## 0.76.4 — 2026-08-19

### Fixed

- **In-game overlays now cover the whole of every screen, whatever each one is
  scaled to.** If your monitors are set to different scaling percentages in
  Windows — a 4K screen at 150% next to a 1080p one at 100%, say — the overlay
  layer only reached part of the way across the scaled screen, and widgets
  refused to be dragged into the rest of it. Most obvious on stacked setups,
  where one driver could not move anything down to the bottom of his lower
  screen. Rigs whose monitors all share a scaling percentage were never
  affected and are untouched by this, and nobody’s saved layout moves.

- **The editing toolbar now appears on your main screen.** It was centred on the
  whole desktop, which put it on the wrong monitor for anyone with a screen
  stacked above their main one — the “Editing overlays” bar and its Done button
  sat a screen away from the widgets being moved. The interact banner and the
  button-feedback messages move with it. Unchanged on single and triple-screen
  rigs.

## 0.76.3 — 2026-08-18

### Added

- **The telemetry plugin installs itself.** The app now ships the rF2 Shared
  Memory Map Plugin (the same one CrewChief bundles) and puts it into Le Mans
  Ultimate for you: on startup it finds your install — any Steam library, any
  drive — copies the plugin in if it's missing and switches it on in the
  game's config. No more downloading a DLL from a forum post, no more hidden
  "why is my delta/radar/map frozen on demo data" first-run failure. If LMU is
  open the app simply waits and installs the moment you close the game (the
  sim only loads plugins at launch, so restart LMU after the first install).
  A plugin you already have is left exactly as it is, whatever the version.

## 0.76.2 — 2026-08-18

### Changed

- **The reference pace bar now reads like the app’s RankBar.** The ladder runs
  slow on the left to Alien on the right — the same direction as the rank bar
  in the Apex app — and the discrete segment colours are replaced with the
  app’s blue→green→orange→purple gradient, so your marker means the same
  thing in both places. Segment widths are drawn correctly for the new
  slow-to-fast ordering.

## 0.76.1 — 2026-08-17

### Changed

- **The YouTube usage card is a plain tally now.** It simply counts what the
  bot has posted — this stream and today — and the meter bar only appears when
  you have set a cap for it to measure against.

## 0.76.0 — 2026-08-17

### Added

- **The Streamers tab explains itself.** A six-step walkthrough — the same kind
  the Setups tab has — opens the first time you visit, and "How it works"
  beside the title brings it back any time. It covers what actually needs
  knowing: linking Twitch by short code and YouTube by Google sign-in (and why
  a relink prompt can appear), the three bot switches and when the bot can
  speak at all, putting the chat overlay in OBS or in the sim, and what every
  field on Commands, Timers, Alerts and Goals does — cooldowns are seconds,
  timer intervals are minutes, and `{user}`-style placeholders are listed where
  you use them.

## 0.75.3 — 2026-08-17

### Fixed

- **You can trigger your own bot commands now.** The bot ignored every message
  from the linked account to stop its replies re-triggering commands forever —
  but since the bot speaks AS you, that also swallowed you typing `!discord`
  to your own chat, which is the most normal thing a streamer does. It now
  ignores only the exact lines it just sent (a fifteen-second echo window);
  everything you actually type works, from either side of the keyboard.

### Changed

- **The bot editors say their units.** Column headers over Commands, Timers
  and Goals — most importantly "Every (min)" and "Cooldown (sec)", so nobody
  types thirty seconds into a minutes box.

## 0.75.2 — 2026-08-17

### Fixed

- **StreamBot rows no longer vanish while you edit them.** Adding a command and
  clicking Add again could eat the first one, deleting a row could clear the
  whole list, and edits made moments after a save could silently not stick —
  across Commands, Timers, Alerts and Goals alike. The cause was the panel
  swapping its working copy for the app's saved echo mid-edit: half-typed rows
  (which the validator rightly holds back until complete) disappeared with the
  swap, and the inputs on screen kept writing into the discarded copy. The
  panel now merges instead of swapping — a section only adopts the saved state
  once it has nothing unsaved — each section saves on its own timer (a settings
  change no longer cancels a pending command save), and rows keep a stable
  identity from the moment they are created.

## 0.75.1 — 2026-08-17

### Changed

- **The StreamBot no longer caps YouTube messages by default.** 0.75.0 shipped
  with per-stream and per-day send caps switched on; they are now opt-in (0 =
  no cap, and 0 is the default), and the 10-minute floor between YouTube timed
  messages is gone — timers run at whatever interval you set, on both
  platforms. The Accounts pane keeps the usage meter purely as information. If
  you do set a cap, the rationing behaviour is unchanged — timers pause first,
  then command replies, and alerts always get the last word.

## 0.75.0 — 2026-08-17

### Added

- **A Streamers tab, and a StreamBot that types in your chat.** The new tab
  gathers everything broadcast-facing in one place, split into panes: Accounts,
  the Chat overlay, and the bot's Commands, Timers, Alerts and Goals. The bot
  speaks as **your own account** on Twitch and YouTube — no third-party bot to
  invite, no cloud relay; your logins stay on this PC.
  - **!commands** — a viewer types `!discord`, the bot answers with your link.
    Case-insensitive, with a per-command cooldown so a busy chat can't turn one
    command into spam.
  - **Timed messages** — recurring lines (socials, the Discord invite, a sponsor
    shout) posted only while you are live, per platform.
  - **Chat alerts** — thank-you lines for new subs, resubs, gifted subs, new
    YouTube members and Super Chats, with `{user}`/`{tier}`/`{count}`-style
    templates. A 20-sub gift bomb is one alert and counts as twenty, not twenty
    alerts.
  - **Goals** — set a sub or member goal and the bot counts events as they
    happen, announcing progress every N and on completion. Progress survives a
    restart, and you can correct the count by hand.
- **Twitch sign-in for the bot.** Linking is a short code at twitch.tv/activate
  — no password typed into the app. Reading chat is unchanged (still anonymous,
  still just a channel name); the sign-in is only what lets the bot type, and
  the app keeps the login alive with Twitch's required hourly checks.
- **A YouTube message budget.** Every YouTube bot message spends API quota that
  all installs share, so the bot rations itself: per-stream and per-day caps
  (defaults 60 and 150), a 10-minute floor between YouTube timed messages, and
  priority shedding — timers pause first, then command replies, and alerts run
  to the last message. The Accounts pane shows a meter of what today has spent;
  Twitch has no such cost and keeps running when YouTube pauses.

### Changed

- **The Stream Chat widget card and account linking moved to the Streamers
  tab.** The Overlays grid is for on-track widgets again; the chat card renders
  in Streamers → Chat overlay (same URLs, same OBS/In-game switches, nothing to
  reconfigure) and the Twitch/YouTube linking card sits beside the bot settings
  in Streamers → Accounts. The chat card also finally has its own icon instead
  of the generic monitor.
- **New YouTube links ask for send permission.** The Google sign-in now requests
  the scope that lets the bot post to your live chat. An existing link keeps
  reading chat exactly as before, and the Accounts pane shows a relink prompt if
  the bot should speak on YouTube.
- **Sub, membership and Super Chat events now reach the chat overlay.** They
  were parsed and dropped; they now render as lines (Twitch's own wording, or
  the Super Chat's comment with its amount) as well as feeding the bot.

## 0.74.0 — 2026-08-17

### Changed

- **The community setups list now says which setup is worth taking.** It listed
  what had been shared and left the judgement entirely to you. Three things
  changed that. Every verified lap carries its gap to the quickest verified
  setup on the board for the same car class and track, so a time reads as
  `FASTEST` or `+1.458` rather than as a number with nothing to measure it
  against — and only laps proven on the setup itself take part on either side,
  so a gap is never invented out of a time that was merely driven at the same
  circuit. Ratings show as five stars with the average and the count instead of
  a grey "unrated", and downloads move up beside the uploader's name. The list
  opens on a new **Recommended** order: a lap driven on the setup counts for
  most, then ratings — discounted while only one or two drivers have scored it —
  then how many drivers have taken it. Newest first, best rated, most downloaded
  and fastest verified lap are all still in the sort menu.
- **Setup names are no longer sliced off mid-word.** In the Setups rail the name
  had one line and no ellipsis, so "Circuit de Spa-Francorchamps — LMP2_ELMS —
  …" simply stopped, hiding the part that told two setups apart. Names wrap to
  two lines now, and the track is dropped from the headline — saved tunes are
  auto-named after their track, and the chip below the name (or the filter above
  the list) already says which circuit it is.
- **The row reads in the order a driver decides in.** The handling tags — the
  only thing on a row that answers "will this suit the way I drive" — get their
  own line, the track, car and class recede to a filing label, and the
  uploader's own notes step up from a dim italic footnote to readable text. A
  track or car you have already picked stops repeating itself on every row.
  "Get again" is now a quiet button: the accent is kept for setups you have not
  tried.

## 0.73.0 — 2026-08-17

### Added

- **A "Public" button on every saved setup.** Publishing a tune to the community
  board was reachable only by opening Share and picking the right option out of
  several — the menu is there to send a file to a teammate, and publishing was
  hiding inside it. Each saved setup now carries its own Public button that goes
  straight to the publish dialog. Share keeps everything it had, and its
  description now says what it actually offers.
- **The Setups screen asks for your feedback.** A dedicated dialog on the
  community list, for an idea or a problem with setups specifically. It goes to
  the same inbox as the Suggestions tab, tagged so it can be read in context
  rather than guessed at.
- **A nudge to share what you have.** If you have saved tunes, the Setups screen
  now says so and explains what publishing one does — your name on the community
  board, ratings and downloads, and a quicker field. It is a prompt, not a
  nag: it does not claim your setups are unshared, because proving that would
  take a per-setup cloud check the screen does not do.

### Changed

- **The admin overview reports on the setup library.** Three tiles: how many
  drivers have created setups (and how many are shared right now), how many
  drivers have verified pace on a shared setup, and how often setups are
  downloaded — all-time, the last 30 days, and by how many distinct drivers.
  Until now the Admin tab could say how many people were using the app but
  nothing about whether the setup library was doing its job.

## 0.72.1 — 2026-08-17

### Fixed

- **Driver names that arrive already shortened are no longer shortened twice.**
  LMU writes its AI roster as "D. Fisher", and plenty of league entry lists do
  the same. Setting the standings names to the "Matt.H" style then cut the
  surname off a first name that was already an initial, leaving "D..F" — two
  dots and two letters, naming nobody, on every AI car in the field. There was
  no width that could fix it: the name had been thrown away before the column
  was drawn. A name like that now falls back to the "M.Haskins" style, which is
  the most it can carry, and real first names are untouched — "Matt Haskins" is
  still "Matt.H".

### Changed

- **The standings tower starts wider.** The driver cell carries the class tag,
  the manufacturer badge and the DR/SR rating pair as well as the name, and
  those hold about 82px whatever the name is. At the old default width that
  left barely enough for "#23 " and six letters, so the tower clipped the
  column it exists to show — most visibly since the rating marks started riding
  the abbreviated name styles in 0.72.0. It now opens at 560px instead of
  474px, and all 86px of that goes to the name: full names like "Sebastien
  Loeb-Martin" and "Jan Van der Merwe" fit without cutting. If you prefer the
  narrower tower, drag its side edge in — a width you have set is remembered
  and is not overridden by this, so a tower you have already sized stays
  exactly where you put it.

## 0.72.0 — 2026-08-17

### Changed

- **Your car on the track map now wears the Apex colours.** It used to be a
  white dot with a thin cyan ring, which is easy enough to find on an empty lap
  and genuinely hard in a train of same-class cars — white is just another
  colour once there are twelve dots on a circuit. Your marker is now painted in
  the cyan-purple-magenta brand gradient, sits a touch larger than the field,
  and carries a white edge with a brighter cyan halo outside it. It is the only
  multi-coloured dot on the map, so "which one is me" is answered the moment
  your eye lands on it, whatever class you are in.
- **The driver and safety rating badges stay on when names are abbreviated.**
  Setting the standings tower to surnames or forenames used to strip the DR
  plaque and the safety badge off every row, on the reasoning that the marks
  were stealing width the shortened names needed. In practice they bought the
  names almost nothing — rows still ran out of room at the same place — while
  the ratings, which are half of what identifies a driver, disappeared for
  anyone not using full names. Both marks now ride every name style, and the
  cell clips whatever will not fit rather than trading one for the other. Full
  names draw exactly the row they always did.

### Added

- **A shared setup is now linked to the lap it was driven on.** When you upload
  a board lap, the trace carries the fingerprint of the setup you drove it with,
  and the server ties it to your own published setup if you have shared that
  tune. Nothing changes on screen yet — this is the groundwork for the Training
  section, where studying someone's fastest lap will also let you take the car
  that set it, not just watch the inputs. Only your own setups are ever linked,
  and laps recorded before setup stamping simply never link.

## 0.71.1 — 2026-08-16

### Fixed

- **The drawn widgets are now sharp on big screens and 4K streams.** The track
  map, radar, pedal traces, motion box and speedo cluster are drawn rather than
  laid out in text, and they were being drawn at one size and then magnified to
  another — so on a 4K TV, or a stream watched back on one, they looked soft and
  slightly pixelated while the text beside them stayed crisp. It never showed up
  on the PC the overlay was set up on, because at normal size there is nothing
  to magnify. They are now drawn at the size they are actually displayed at,
  wherever that is: scaled up in game, on a high-DPI screen, or in a 4K OBS
  source. Nothing to turn on, and no change to how anything is laid out.
- **Scaling a widget in game re-sharpens it straight away.** Dragging a corner
  to make a widget bigger left the drawn ones on their old, now-magnified
  artwork — about half a second behind for most, and permanently for the track
  map. They now re-cut their artwork as soon as the handle is released.

### Changed

- **The OBS guide now sets the Browser Source to your output resolution.** It
  had always said 1920×1080, which on a 4K stream hands OBS a 1080p image to
  stretch to 2160p — detail no bitrate can put back. The guide now gives the
  size to use for 1080p, 1440p and 4K, and explains why it is the setting that
  decides whether the overlay is sharp on a big screen.

## 0.71.0 — 2026-08-15

### Added

- **Spectators now get the focused car's cockpit telemetry.** Watching a race —
  a team event, a mate's stint, directing a broadcast — the speedo cluster and
  the input traces used to sit empty, because gear, revs and pedals only came
  from the car driven on this PC. LMU actually publishes that telemetry for
  every car in the field, so when nobody is driving here the overlays now
  follow whichever car has the broadcast focus: gear, revs, the rev limit and
  speed on the cluster, and live throttle, brake and steering — including
  TC/ABS intervention — on the traces. Switch the camera to another car and
  the overlays switch with it. Proven live mid-race on a spectated LMP2 before
  it shipped.
- **Only what is real is shown while spectating.** The sim does not publish
  tyres, fuel level, temperatures or damage for a car you are not driving, so
  those widgets show "—" rather than a number nobody measured. Driving is
  untouched: your own car's telemetry path is exactly what it was.

## 0.70.1 — 2026-08-14

### Fixed

- **The game no longer freezes for a moment every minute.** On some PCs the
  sim takes just over a second and a half to hand over its installed-car list
  — the payload the standings widget reads once to put a manufacturer badge on
  each row. The overlay's patience ran out at exactly a second and a half, so
  on those machines the answer never arrived, and the overlay asked again
  every 60 seconds — and every time it asked, the sim visibly hung while it
  built the reply. The overlay now waits as long as that one request needs,
  keeps the answer, and never asks twice. Cars the sim's own list cannot name
  (some custom liveries) are remembered as unknowable instead of being asked
  about again.
- **A stutter in the sim can no longer snowball.** When the game briefly stops
  answering (loading into a session does this for a few seconds), the overlay
  used to keep sending its regular requests anyway, piling dozens of them onto
  the game right when it was busiest and stretching the stall out. Each poll
  now waits for its previous request to come back before sending the next, so
  a busy moment in the sim stays exactly as long as the sim needed.

## 0.70.0 — 2026-08-14

### Changed

- **The Apex Overlay System is now a subscription — £4.99 a month, with the
  first 7 days free.** Building this has become a real piece of work and
  keeping it running costs real money, so from this release a new account
  starts a free trial, and the app asks for a card up front so nothing breaks
  on day 8. Cancel any time before then and you pay nothing. Everything is
  handled by Stripe on Stripe's own pages — the app never sees your card.
- **If you are already using the app, nothing changes for you.** Every account
  that existed before this release has been given free access permanently.
  You will not be asked for a card, you will not be charged, and no overlay
  you use today stops working. If you are in a league with us, that is what
  free access is for.
- **Settings now has a Subscription card.** It shows how your account is
  covered — free access, trial, or paying — and takes you to Stripe's billing
  page to change a card, see invoices, or cancel. It only appears once you are
  signed in.
- **The app needs to be signed in to run.** The subscription is what unlocks
  it, and the app cannot tell whether you are entitled without knowing who you
  are. If your internet drops, a confirmed subscription keeps working offline
  for three days, so a race weekend away from home is not a problem.

### Added

- **League codes.** If you race with Apex & Chill, we can hand you a code that
  turns free access on for your account. Redeem it on the subscribe screen —
  there is a box for it under the payment button.

### Fixed

- **The app could close itself when it shut a chat connection down.** If a
  Twitch chat socket was still connecting at the moment the app tried to close
  it, the error had nowhere to go and took the whole app with it. It has
  probably always been able to happen; it started happening often enough to
  notice now that losing access stops the server. Both halves are fixed: the
  error is caught, and a half-open connection is cut rather than asked
  politely.

### For league staff

- **The Admin tab is now four sections instead of one very long page.**
  Overview, Members, Billing and Feedback, behind the same segmented control
  the Setups page uses, and it remembers where you were. The tab was answering
  four unrelated questions stacked on top of each other; now each has a home.
- **A Billing section, with the numbers that decide whether any of this
  works.** How many people ride free, how many are on trial, how many pay,
  what that is worth a month, and twelve months of revenue and churn.
  Revenue counts live subscriptions only — a trial is worth nothing until it
  converts, and a failed payment is money that has not arrived — because a
  flattering number is a useless one. A month with no subscribers to lose is
  left blank on the churn chart rather than drawn as 0%.
- **Free access is now managed from the driver's own row.** Every account in
  the Drivers list carries a control showing how it is covered, and setting
  someone back to Paying is how you end free access when they leave the
  community. Accounts with a live Stripe subscription show their status as
  text instead — comping someone who is already paying would leave them
  charged and free, and cancelling a card is Stripe's job, not this panel's.
  The separate list of comped accounts has gone: it said less than the roster
  does and disagreed with it the moment either changed.
- **The version list no longer runs off the bottom of the card.** Sixty-odd
  builds have shipped and every beta earned a row. It now shows the top six
  with a "Show all" toggle, and says how many builds and drivers are folded
  away rather than quietly dropping them.
- **An admin can no longer lock themselves out of the Admin tab.** The tab is
  where free access is granted, and it sat behind the subscription gate — so
  an admin whose own access lapsed could not reach the one tool that would
  restore it. Being an admin is now enough on its own.
- Ships as `supabase/migrations/0007_billing.sql` and
  `0008_billing_admin.sql`, plus four Supabase edge functions. The revenue and
  churn charts are computed from each subscription's lifetime rather than from
  a nightly snapshot, so there is no job to keep running and no history to
  lose.

## 0.69.1 — 2026-08-14

### Fixed

- **Positions gained now mean positions in your class.** The ± column on the
  standings tower counted every car you got past, whatever it was — so a GT3
  driver working through a Hypercar, or a Hypercar lapping through GT3
  traffic, showed places gained in a race they weren't in. It now scores you
  against your own class only: where you started among your classmates
  against where you are among them now. In a single-class race nothing
  changes.

## 0.69.0 — 2026-08-14

### Fixed

- **Your wheel can no longer quietly disappear mid-race.** Some wheels'
  software rebuilds the controller it shows to Windows after a USB power
  blip, and the app was left listening to the old one — which kept
  pretending everything was fine while reporting nothing. No error, no
  sign, just MFD buttons that stopped doing anything until you found the
  Scan button. The app now checks every few seconds that the wheels it is
  listening to are still the wheels that exist, and reconnects by itself
  the moment they differ. You should never need the Scan button mid-race
  again.
- **A button held down while the wheel reconnects no longer fires by
  itself.** Reconnecting used to treat anything already pressed as a
  brand-new press.

### Added

- **The bindings page finds your wheel on its own.** It scans the moment
  the page opens instead of waiting for you to press "Scan for wheels",
  and the readout updates by itself when a wheel appears, vanishes, or
  comes back.
- **"Reconnect wheel" is now a bindable action.** Put it on a keyboard
  key, a Stream Deck button, or a button on a second device (a button
  box), and it does exactly what the Scan button does — with the result
  shown as an in-game notice. One honest caveat: a button on the wheel
  that lost its connection cannot deliver the press, so bind it somewhere
  that stays alive; the automatic reconnect above is the real safety net.

## 0.68.2 — 2026-08-14

### Fixed

- **YouTube chat no longer runs out three hours into a stream.** The app was
  asking YouTube for new chat messages every five seconds, and a long stream
  could exhaust what YouTube allows an app in a day — after which chat simply
  stopped arriving until the following day. It now holds one connection open
  and YouTube pushes messages down it as they are posted, which is what Google
  recommends for exactly this. Messages also show up faster than a
  five-second poll could ever manage. If the connection drops it picks up
  where it left off rather than replaying what you have already seen.
- **The app stopped quietly asking YouTube what you were streaming, all day.**
  Once a minute, whether or not you were live and whether or not chat was even
  on screen, it checked for an active broadcast — a steady, pointless drain
  from an app sitting idle in the background. It now looks
  every five minutes while you are off air, not at all while a chat is already
  running, and immediately when a chat ends and there might be a new one to
  find.

## 0.68.1 — 2026-08-12

### Fixed

- **Setup saves work when Steam lives on another drive.** The app finds your
  LMU install by asking Steam itself (the registry) where it is, instead of
  only looking under `C:\Program Files`. A Steam installed on D:\ (or anywhere
  else) meant every "Save current setup" failed with a red FAILED button while
  the rest of the app worked fine — applying setups, telemetry, overlays all
  use the sim's own connection and never noticed. Found by a beta tester at
  Barcelona, first save he ever tried.
- **When a setup save does fail, the dialog now says why.** The reason used to
  hide in a tooltip on the FAILED button for 2.5 seconds; now it appears in the
  dialog and stays put, and the app logs it too.

## 0.68.0 — 2026-08-12

### Changed

- **The league's setups sit beside the race engineer now, not under
  everything.** Maximise the panel and the Setups tab uses the whole window:
  the car's settings on the left, the engineer in the middle, and Community
  setups as a column of its own on the right — visible the moment you open the
  tab instead of two screens down past your own library. Narrow the window and
  it folds sensibly: the community list moves under the settings, then to a
  single column, and it stays above your library at every size. In a column
  each shared setup reads as three lines — who made it and their pace, what
  it's for, then Get and Rate — and the list scrolls inside its own card so the
  page never runs away from you. With the sim closed, the community list takes
  the space the engineer would have used rather than leaving a hole.
- **Community setups follow the exact car you are in, not just its class.**
  With the sim running, the Community list now shows only what was published
  for your car at your track — a class-mate's tune does not load onto a
  different car, so a GT3 list full of other manufacturers was noise. It also
  keeps up: swap cars in the garage, or move to another track, and the list
  re-filters itself instead of staying pinned to wherever you were when the
  panel first saw the sim. Tracks are matched on the sim's own setup folder,
  so two layouts of one circuit no longer bleed into each other. With follow
  turned off there is now a **Car** filter beside Track and Class, and every
  row carries the car it was made for.

### Fixed

- **The relative panel and the standings agree about the car behind you.**
  The relative was estimating that gap — road distance divided by your lap
  average — which is wrong by however much the stretch between you differs
  from an average lap: measured against a captured field, anywhere from 30%
  short for a car in a slow corner to 50% long for one on a straight. It now
  reads the sim's own timing, the same number the standings tower uses, so
  the two can no longer contradict each other. The same fix applies to
  rFactor 2.

## 0.67.1 — 2026-08-12

### Added

- **The Setups tab explains itself now.** Open it for the first time and a
  short walkthrough introduces the tab in six steps: that the car on screen is
  the one the sim is holding rather than a file, what the padlocks and amber
  dots are telling you, how the race engineer stages changes instead of
  applying them, what the library files away for you, and how a community
  setup’s stars and verified pace are earned. It appears once, on the Setups
  tab only — never on the way to your overlays — and closing it any way you
  like counts as read. It also waits its turn behind the release notes after
  an update rather than landing on top of them, and it reads perfectly well
  with the sim closed. **How it works**, beside the Setups title, brings it
  back any time.

## 0.67.0 — 2026-08-12

The setup release. The Setups tab stops being a placeholder and becomes the
whole car: a live editor for every setting the garage has, a race engineer who
speaks in intent rather than clicks, a library of your own tunes filed by track
and car — and, new in this release, the league's setups shared between all of
you, with the pace beside them read from real laps instead of typed in.

### Added

- **The Setups tab is real: a live editor for the whole car.** Every setting
  the garage has — 170 of them on a GT3, from tyre pressures and camber per
  corner to third springs, diff ramps and gear stacks — laid out across the
  same six pages the game uses (Basic, Powertrain, Wheels & Brakes, Suspension,
  Dampers, Chassis & Aero). It is the same car the sim is holding: drag a
  slider here and the garage screen moves before you look up; change something
  in the game and the panel shows it within a second. Values the ruleset fixes
  show a padlock, values your car simply doesn't have don't appear at all —
  an LMP2 never sees an ABS row — and an amber dot marks anything that differs
  from your saved setup file, exactly like the game's own asterisk.
- **Every control explains itself.** The ⓘ next to each setting says what the
  part physically does and which way to turn it for which handling change —
  camber's tread-temperature window, why rear toe-in calms the car, what a
  third spring is actually for. Written once, true for any car.
- **A race engineer's panel.** Ten intent sliders — front turn-in, rear
  traction, top speed, softer over kerbs, braking stability and friends — each
  moving a weighted set of real settings at once. Nothing touches the car
  while you drag: affected rows preview old → new, the count says what's
  staged, and one Apply sends the lot (Revert forgets it). Settings the
  ruleset locks are skipped and say so. On a Hypercar the same sliders know
  about torque split; on a GT3 they simply don't reach for it. Apply and Revert
  sit visible from the start — disabled until there is something to send — and
  when changes land on pages you are not looking at, those tab buttons glow
  amber until you apply or revert, so a staged edit can never hide behind the
  tab you happen to have open.
- **A setup library.** Below the editor: save the car exactly as the garage
  holds it, name it, tag it Race or Quali, give it a colour, and it files
  itself under the track and car it came from. Filter by any of those; sort by
  newest, name — or by **your best clean lap** on that track in that class,
  pulled live from your lap database so the number never goes stale. The sim
  itself writes every file (it alone knows a setup file's full truth), and the
  app keeps its own copies where the game can never rename or prune them.
- **Load a tune, and see it before it lands.** Pick a saved setup and hit Load
  and it stages in the editor rather than silently changing the car: every row
  previews its old → new value, and Apply sends the changes setting-by-setting
  down the one path the game's own setup screen provably repaints for. Nothing
  touches the car until you press Apply, so loading is free to inspect and back
  out of — with a warning first when the tune was saved for a different car or
  circuit.
- **Share a tune — as a file, or straight into a chat.** Share hands you the
  raw .svm to send to a teammate: "Save as file…" for everything else, and
  "Copy file — paste into Discord / WhatsApp" to put the .svm on your clipboard
  so Ctrl+V drops it into any chat that takes attachments. It works in any LMU
  install, whether they run this app or not, and Import files a received .svm
  straight into your library.
- **Community setups — share your tunes, and grab everyone else's.** A new
  card on the Setups tab lists every setup the league has published, and with
  the sim running it automatically follows the car and track you're in (a
  "Follow my car & track" toggle brings back manual filters). Share any
  library entry with the new "Publish to the community…" option: write a note
  ("my race setup for Spa — give it a try"), and the app suggests character
  chips read from the setup's own numbers — Sharp turn-in, Stable & safe,
  Low drag, High downforce and friends — which you can adjust before it goes
  up. Unpublish any time; your local files are never touched.
- **Downloads land where you actually need them.** Get a setup and the .svm
  is written straight into LMU's own setup folder for that track — it appears
  in the game's setup screen, no restart — and filed into your library so you
  can stage and Apply it from the panel like any of your own.
- **Ratings you can trust: stars, gated on proof.** Only drivers who have
  downloaded a setup can rate it (1–5 stars), never its author, and every
  pace shown next to an opinion is read from the lap database, never typed.
  Better still, every lap you record from this build on quietly remembers
  which setup it was driven on — so when your best clean lap was set on the
  very setup you're rating (or publishing), the card marks it with a ✓ as
  driven on that exact setup. Laps from before this build can't prove what
  the car was running, so they show as your plain track best, dimmed and
  labelled — shown, but not sworn to.
- **The Setups tab shows YOUR car — in your livery.** The car card pulls the
  game's own 3/4 studio render of the exact car sitting in the garage, liveried
  as it really is, and swaps it the moment you change cars. It is the same
  artwork LMU's livery selector uses, served by the game itself, so every car
  and every skin is covered without shipping a single image. A neon cutaway
  render stands in whenever the sim is closed.
- **Custom skins show their real paint, too.\*** If the car in the garage is
  wearing one of your own liveries, the card shows the same studio render the
  game's event and livery screens show — your actual paint, not the bare
  carbon template. The render comes from LMU's online service using the sim's
  own sign-in, so it needs the game running and logged in; stock liveries keep
  coming from the game's local artwork exactly as before, and if the service is
  out of reach the card quietly falls back to that stock art. If more than one
  of your teams has a paint for the same car, the newest upload is shown.

  \* **Experimental.** First release of the online-livery path — if the card
  ever shows the wrong paint (or none) for a custom skin, that's a bug worth
  reporting.
- **It costs nothing until you open it.** The tab polls the sim only while it
  is on screen and stops the moment you switch away or minimise — no timers,
  no frames, no requests from a closed tab.

### Fixed

- **Setups save into the right track folder.** The sim will happily write a
  setup into any folder it is told, including the wrong track's — where the
  game's setup screen for your actual circuit would never show it. The app now
  asks the sim itself which folder the current track saves under, the same
  answer the game's own save dialog uses.
- **Per-widget mode changes from the control panel now actually save.** The
  settings handler silently dropped them — only a bound hotkey could ever
  switch a widget's mode.


## 0.66.3 — 2026-08-11

### Added

- **The speedo cluster comes in designs — first up, a real LMP2 dash.** A new
  Design dropdown on the Speedo Cluster card picks the cluster's whole look:
  the familiar twin-rev-bar cluster stays the default, and "LMP2 — Cosworth
  CDU" redraws it as the boxy, mono-spaced display an actual LMP2 runs. Big
  gear glyph, running lap time that holds your finished lap (gold on a
  personal best), signed live delta, fuel and energy row, TC / brake bias /
  TC cut boxes that flash green the moment you step a setting, tyre pressures
  and temps in the centre grid, brake and throttle strips along the floor —
  and the full-width shouts: PIT SPEED LIMITER (going red the moment you're
  over the limit) and ENGINE STALL with your clutch beside it. The choice
  applies live in OBS and in game, no reload; `?design=lmp2` pins it on a
  single Browser Source. More GT3 and prototype designs to come.

### Fixed

- **Abbreviated driver names now actually fit — the rating marks stand aside
  for them.** Picking "M.Haskins" or "Matt.H" barely changed what you could
  read: the DRIVER column is 138px of content and the marks in it — class dot,
  car badge, DR plaque, driver badge — hold 82px of that, so shortening a name
  moved the ellipsis by about two characters and every row still read
  "#7 K.Ko…". Abbreviating is you saying the NAME is what identifies this grid,
  so it now costs the two rating marks and keeps the car badge: 48px back, and
  the names read in full. Nothing changes for anyone on the default "in full"
  setting, and the ratings are still drawn in the relative panel, which is the
  panel that answers who the car beside you is.
- **The NAMES and DECIMALS settings reach OBS Browser Sources.** Both were
  dropped in transit: the appearance the server hands to browser sources is
  rebuilt field by field, and these two were never added to that list, so a
  source drew full names at three decimals whatever the panel said. The in-game
  layer is pushed the settings directly and honoured them all along — which is
  why the tower could show one thing in game and another in OBS at the same
  time.
- **Switching the speedo back to the Apex design works without a restart.**
  Picking the default design (or any widget's default mode) removed the stored
  choice, but the overlays only ever heard about modes that were SET — a
  removed one was never delivered, so the cluster stayed on the LMP2 dash until
  the app was relaunched. The overlays now treat a vanished entry as "back to
  the default" and rebuild on the spot, live in OBS and in game.
- **The pit limiter no longer sticks on the cluster after you leave the car.**
  The ESC and garage screens freeze the sim's telemetry block at its last
  values, so a limiter that was on when you stepped out kept reading as on —
  the cluster sat glowing purple with the LIMITER chip lit until you drove
  again. The limiter reading is now dropped while the sim says you're in its
  menus (the same signal the LMP2 dash's banners and the race-control callouts
  already respect), so the cluster returns to a live state the moment the data
  stops being live.
- **A telemetry frame without a player block can no longer freeze the Apex
  cluster mid-paint.** The LMP2 design already guarded against it; the Apex
  design now skips such a frame cleanly instead of stopping at whatever it last
  drew.
## 0.66.2 — 2026-08-11

### Added

- **Choose how precise the standings GAP column is.** Settings → Overlays →
  Standings now has a DECIMALS control: thousandths (`+1.234`, what the tower
  has always shown and still the default), hundredths (`+1.23`) or tenths
  (`+1.2`). The third decimal changes every single frame whatever the cars are
  actually doing, so at a glance mid-corner it is movement that means nothing —
  at one place the number only moves when something has happened. The column
  also gives back the width it no longer needs, and that width goes straight to
  the driver names, which is the one column in the tower with none to spare.

- **Choose how driver names are written.** A NAMES control in the same card,
  with the three forms spelled out as they will appear: `Matt Haskins` in full
  (the default, unchanged), `M.Haskins`, or `Matt.H`. Which half of a name
  identifies a driver is a fact about the grid, not something the app can
  guess — a league that races by first name wants one, a broadcast wants the
  other — so it is now yours to set instead of ours to assume. A name with no
  space in it is left alone, a two-part surname keeps both parts
  (`J.Van der Merwe`), and the name in full is always on the row's tooltip, so
  abbreviating hides nothing. The fastest-lap banner follows the same setting,
  so a driver is never named two ways on one panel.

  Both controls also ride the `?standings=` parameter for OBS sources —
  `?standings=all,decimals=1,names=surname`.

### Changed

- **The "YOU" tag is gone from your standings row.** Your row is already
  unmistakable — the cyan position number, the bold name, the full-strength
  text and the accent down the edge — and the tag was the one thing in the
  DRIVER column that pushed a row's contents sideways out of line with every
  row above and below it. A tower is read by running your eye straight down it,
  and a single row that steps out of the column costs more than the word was
  buying.

## 0.66.1 — 2026-08-10

### Changed

- **Minimising is just minimising now.** The notification-area icon is gone
  entirely. Since 0.65.0 the minimise button made the panel vanish into the
  tray overflow flyout — the little hidden-icons panel by the clock — which
  read as the app disappearing somewhere weird rather than as a minimised app.
  The window now behaves like every other app on the machine: minimise puts a
  button in the taskbar, clicking it brings the panel back, closing the window
  shuts the whole app down. Everything still runs while it is minimised — the
  server, the in-game overlays and lap uploads never lived in that window.
  "Launch on startup" now starts the app minimised to the taskbar.

## 0.66.0 — 2026-08-10

### Added

- **Every driver's rating badges, live in the panels.** The Bronze→Platinum
  rank plaques from the game's lobby — Driver Rating and Safety Rating, tier
  and all — now appear beside the names of every connected driver in an online
  session. The relative panel carries the full pair (DR then SR, the lobby's
  order), because "who is this car alongside me and how do they drive" is
  exactly what that panel is for. The standings tower carries the DR plaque
  alone: the pair measurably cost every row half its driver name, and the
  tower is the performance ladder, so the performance rating is the one that
  earns the space. Hover either plaque for the full reading.

  How it works, plainly: the ranks live behind the game's own online service,
  not in anything it publishes on your PC — so the overlay signs in exactly the
  way the game's lobby does, using the same Steam ticket your running game
  already hands out, and asks for the drivers in your session by name. Only
  ranks come back (the service keeps everyone's actual rating numbers private
  to their owner, which is why the panels show shields and not numbers — there
  are no numbers to show). Nothing is stored, nothing extra is sent, and if
  the service is unreachable — or a driver has no racecontrol account — those
  badges simply don't appear and the rows render exactly as they did before.
  AI drivers never get a badge: ranks are only looked up for the humans the
  server lists as connected, so a roster name can never wear a real person's
  shield.

## 0.65.2 — 2026-08-10

### Changed

- **Minimising always goes to the notification area again.** The "Minimise to
  tray" switch introduced in 0.65.0 is gone: its off position bought nothing
  but a taskbar button for a window whose whole job carries on while nobody is
  looking at it, and any install where it ended up off read as the app having
  stopped living in the tray. The tray icon is now always there, minimise
  always sends the panel to it, and nothing slows down while it is away — the
  server, the in-game overlays and lap uploads run outside the panel window.
  "Launch on startup" is unchanged, and still brings the app back straight to
  the tray after a boot.

## 0.65.1 — 2026-08-10

### Fixed

- **Reopening from the tray no longer brings back a dead panel.** Opening the
  app again after minimising it could bring up a window that painted but
  ignored every click — it looked frozen, and only quitting from the tray and
  relaunching recovered it. Windows had been asked to restore the window in an
  order it can't honour (un-minimise while still hidden), which left the window
  believing it was on screen while the OS had never actually put it back. It is
  now shown first and restored second, which Windows honours every time.

- **Reopening while the sim is running now puts the panel in front of it.**
  Opening the app from its icon mid-session used to leave the panel behind the
  game where it appeared to have not opened at all — Windows refuses to hand
  focus across processes, and asking politely just flashes the taskbar. The
  panel now lifts itself above everything for the moment it opens, so "open
  the app" means the app is what you're looking at.

## 0.65.0 — 2026-08-10

The release the app stops being a window you have to manage.

### Added

- **Driver badges in the standings and relative panels.** The safety badge LMU
  shows beside names in an online session — Rookie, Good Driver, Trusted Racer,
  the contact Warning, plus the special grants like the Studio 397 mark — now
  sits between the car's brand and the driver's name in both tables, using the
  game's own artwork. It is the same fact the game shows in its own entry list,
  read from the game on the same PC (`/rest/multiplayer/teams`), so the panels
  and the sim can never disagree about who wears what. Hover a badge for what it
  means.

  That badge is deliberately the whole feature. The Driver Rating and Safety
  Rating **numbers** live behind the game's authenticated online service — the
  game itself only shows them on its lobby and profile screens, never in-session
  beside a name — so the overlay shows exactly what the game publishes locally
  and invents nothing. Most drivers carry no badge at all, and their rows render
  exactly as before; offline and AI sessions show none, because the game grants
  none there.

- **It opens full screen.** The panel now maximises on launch instead of opening
  at a fixed 1180×820 in the middle of the screen. The Hub's nav — five tabs, the
  mode toggle, the feed pill, the account chip — was always laid out for room it
  wasn't being given, and the leaderboard and lap tables have wanted the width
  since they arrived. Un-maximise and it still restores to the old size, so the
  small window is a choice rather than the starting point.

- **Launch on startup** (Settings → Application). Apex starts with Windows and
  goes straight to the notification area — the server is up, the in-game layer is
  armed and your laps are logging before you've opened the sim, with no window
  thrown over whatever you were doing at boot. Off by default; nothing installs
  itself into your startup without being asked.

- **Minimise to tray** (Settings → Application, on by default). The minimise
  button sends the panel to the notification area instead of the taskbar.
  Double-click the icon to bring it back, or use **Quit** there to close
  everything down.

  **Nothing slows down while it is away.** The telemetry server, the in-game
  overlays and the lap uploader all live outside the panel window and never saw
  it in the first place; the panel's own renderer is explicitly exempted from
  Chromium's hidden-window timer throttling, so the feed watcher and lap sync keep
  their normal tick rather than dropping to once a minute. Turning the setting off
  while the window is already hidden brings it straight back, and the first
  minimise says where the window went so it can't be mistaken for the app quitting.

### Changed

- **The pit flag stands off the edge of the standings tower.** The `P` on a car
  in the pit lane sat 3px from the panel border while the class subheader's car
  count and the fastest-lap banner directly above it stood 8px clear — against
  footage that read as the flag having fallen off the edge rather than as a tight
  column. It now uses the same 8px inset, and the column was widened to match so
  the gutter came out of the panel rather than out of the chip. The driver-name
  column gives up 5px for it.

- **The Fuel Planner card says it has been rebuilt.** A banner across the top of
  its card on the Overlays screen. A reworked widget is invisible to everyone who
  already made their mind up about the old one — a driver who switched the planner
  off a season ago never opens its card again — and the card is where the decision
  to use a widget actually gets made.

### Fixed

- **A second launch opens the app you already have running.** Double-clicking the
  desktop shortcut while Apex sat in the tray used to start a whole second copy,
  which then failed to bind the server port and reported it as busy — from the
  outside, clicking the icon appeared to do nothing except break the running app.
  The second launch now hands its request to the first one and brings the window
  forward.

## 0.64.0 — 2026-08-10

The release the Speedo becomes an instrument cluster, the Hypercar's own
controls arrive on the MFD, and a pit request finally works whichever button
you press it with.

### Added

- **The Speedo is now a full instrument cluster, and it lights up with the
  revs.** One widget carrying everything you read on a straight: speed and gear
  big in the middle, the four budgets in a pod either side — fuel and virtual
  energy on the left, projected lap and the hybrid battery on the right, each
  with its "≈ n laps" line — and a chip strip along the chin for the pit
  limiter, TC (with its power-cut and slip sub-settings), ABS and regen.

  The headline is the **illumination**. Two rev bars start at the bottom outer
  corners, climb the outer edges and meet head-on just above the speed, and the
  panel itself fills from the floor upward as the revs rise — green, through
  gold, into red, with both bars flashing white together at the moment to pull
  the next gear. A rev counter you have to focus on is useless at 300 km/h; the
  shift point has to be readable with your eyes still on the braking zone, and a
  panel that turns red underneath you is. Two things arriving at one point catch
  the eye in a way a bar filling up never did.

  The bands are fractions of your **own** car's rev limit, which is what lets one
  widget serve the whole field: a Hypercar at 9000 and a GT3 at 7200 go amber,
  red and shift at the same point in their own range.

  The battery is the Hypercar's ERS charge — the one that empties down a straight
  and comes back under braking — drawn as a proper battery glyph that **goes
  green and blooms whenever charge is flowing back in**. It is deliberately kept
  apart from virtual energy, which is the stint allowance that only ever goes
  down; showing one where the other was meant would have a driver lifting to save
  something that recharges itself. An arrow says which way it is flowing:
  ▲ DEPLOY or ▼ REGEN.

  Readouts your car or the feed does not have are hidden rather than shown empty
  — the battery on anything without a hybrid, virtual energy on a class with no
  energy budget, the TC chips outside LMU. An empty gauge is a claim; no gauge is
  not. Speed follows the app's kph/mph setting like every other panel, so the
  cluster and the pedal traces can never disagree.

- **Aid changes pop under the gear.** Step traction control, brake bias, TC slip,
  TC power cut or ABS — in the MFD or on a wheel button — and the new setting
  appears under the gear glyph for a few seconds ("TC 9/11", "BIAS 56.5:43.5").
  The press gets its acknowledgement in the middle of the cluster, without the
  MFD widget on screen and without moving your eyes off the road. Latest change
  wins: work a control through three steps and the pop shows where you landed,
  not the journey.

- **The pit limiter turns the whole cluster purple.** The limiter is the most
  expensive thing to forget on a car, and it had one small cyan chip to its name.
  With the limiter on, the cluster's illumination now holds full-height Apex
  purple — a colour the rev range can never produce — so the state is unmissable
  in peripheral vision, exactly where a driver leaving the pit lane is not
  looking. The rev bars keep showing the revs; the chip still lights.

- **The prototype driving aids arrive on the MFD, as controls.** Regen, front
  anti-roll bar, rear anti-roll bar and brake migration — the rows only a
  Hypercar, LMP2 or LMP3 has, which is why a GT3 never shows them. All four read
  live and all four step from the widget, from a wheel button, or from the MFD
  cursor's ▲ ▼ + −, exactly like traction control and ABS already did. Brake
  migration reads as the percentage the in-car MFD shows, not a raw step index,
  and its `+` raises the number you are looking at.

  **This needs the keys writing once.** Open the LMU bindings section of the
  control panel with **Le Mans Ultimate closed** and press Apply — eight new rows
  are waiting there — then start the game so it picks them up. The game rewrites
  its own key config when it exits, so a write made while it is running would be
  thrown away; the app refuses to write in that state rather than let you think
  it worked.

  One row behaves differently and it is worth knowing why. **Regen is the only
  control the game publishes no live value for anywhere.** Its number comes from
  the garage, which is right until you change it and then stale — so the row shows
  a dash once anything has moved it, rather than a figure it cannot stand behind,
  and gets a real number back next time you visit the garage. The + and − work
  normally; it is the reading that is unreliable, not the control.

- **Settings are shown in the sim's own words** where it has one — `200kW`, `P6`,
  `1.5% F` — rather than a step index. The index is still the fallback when the
  two sources disagree about which step they are describing, because a confident
  label on the wrong setting is worse than a number.

### Changed

- **The PIT REQUEST row reads the sim, not its own memory.** LMU publishes the
  pit request on its standings feed, and the MFD row now shows that reading
  directly: book a stop with the game's **own** wheel bind, with Apex's bound
  button, or from the row itself, and it flips to **YES** either way — and flips
  back when the game cancels it, since LMU treats the request as a toggle.
  Previously the row only knew about presses made through Apex, which is why a
  button bound inside LMU never moved it.

  One reminder falls out of this: keep the request on **one** binding — either
  LMU's own controller bind *or* Apex's — because the same physical button bound
  in both places will now toggle the request twice per press.

- **Pit-request confirmations live in the Race Control bar.** Instead of a
  floating pop-up, Race Control shows a steady green **PIT REQUESTED** while the
  sim says a stop is booked — whoever booked it — and flashes an amber **PIT
  REQUEST CANCELLED** for four seconds when it is toggled off out on track.
  Driving into the lane consumes the request quietly, with the existing PIT ENTRY
  countdown taking over inside 900 m, and the cancelled flash never sits over a
  limiter warning. The red failure notice still appears when a press achieved
  nothing.

- **The Fuel Planner is offline while it is rebuilt.** The widget shows a
  REBUILDING banner instead of its numbers. It stays in saved layouts — it says
  why it is empty and will come back in place when the rebuild ships.

### Fixed

- **Wheel buttons no longer go dead until you press "Scan".** If Apex started
  before your wheel was ready — a boot-with-Windows rig, or a base switched on
  after the app — it never looked for the wheel again, so every wheel binding
  silently did nothing. The MFD controls were the obvious casualty: ▲ ▼ + − on
  the wheel did nothing at all, and the only cure was the **Scan** button buried
  in Settings → Bindings. Apex now looks again by itself, both when it finds no
  wheel at startup and when a wheel disappears mid-session — a base power-cycled
  between sessions used to kill the bindings for the rest of the night. Plug a
  wheel in while Apex is running and it is usable within a couple of seconds. The
  **Scan** button still does the same thing on demand.

- **A bound button that can't do its job now says so, on screen.** Press your
  pit-request button, nothing happens, and the button reads as dead. It wasn't:
  the action was failing quietly and the reason only went to a log nobody has
  open while driving. Any bound button whose action fails now puts the reason
  over the sim in a small notice — for a pit request that is almost always
  *"Pit Request" is not bound to a KEY in LMU*, which the **LMU controls** card in
  Settings fixes in one click with the game closed. And when your button is bound
  in *both* places, Apex checks the sim's own request flag before crying wolf, so
  a press the game handled gets a quiet confirmation rather than a red error.

- **The track map no longer goes blank for good when you change its style.**
  Switching between the classic and brand looks could stop the map dead for the
  rest of the session, needing a restart to bring it back. A second, rarer version
  of the same fault — triggered by resizing the widget — is fixed too.

- **The MFD cursor no longer stops on a row that isn't there.** Scrolling the rows
  could land on an invisible entry where + and − did nothing. It was ABS: a
  Hypercar, LMP2 and LMP3 don't have it, so the widget correctly stopped drawing
  the row — but the cursor was working from the keys you have bound rather than
  from what the car in front of you actually offers, and you have ABS bound
  because you also race a GT3. The cursor now walks exactly the rows on screen, in
  the order they are on screen. Nothing changes for a car that does have ABS.

- **Demo mode drives like a car again.** The demo revs ignored the gear, so they
  sat pinned near the limiter and never sawtoothed — leaving the Speedo's shift
  band unreachable without a sim running — and demo published no driving-aid
  settings at all, so the MFD's aid section and the TC chips could only ever be
  seen empty. Both fixed. The pit menu stays empty on purpose: it is a read/write
  mirror of a real menu, and fabricating rows would give the MFD buttons that
  write to a sim that is not there.

- **What's New could open empty after an update.** Version numbers were compared
  with their prerelease tag treated as one lump of text, which holds up only
  while a beta series stays in single digits — "beta.10" counts as *older* than
  "beta.9" that way. This release is the first with a double-digit beta behind
  it, and anyone stepping over that boundary would have opened the app to a
  panel with nothing in it. Numbers are now compared as numbers, in the same one
  place the app's "have they seen this yet?" check reads.

### Worth knowing before you update

- **The cluster is wider than the old Speedo panel and keeps a fixed shape**, so
  it will need dragging back into place once in the in-game editor. Drag a corner
  to size it — the whole thing scales together, text included, so there is only
  one dimension to get right.
- The radar and the track map are **still separate widgets**, placed and switched
  on independently, exactly as they were in 0.63.1.

## 0.63.1 — 2026-08-07

### Fixed

- **The overlays now hide on the pit menu and car setup pages too.** 0.63.0's
  auto show/hide caught the ESC menu but left the overlays sitting over the
  garage pages — pit strategy, car setup — because the sim reports those
  screens differently. The overlays now read the sim's own "driver is in the
  car" flag as well, so every one of its screens hides them and getting back
  in the car brings them straight back. On a PC where that flag isn't
  readable, behaviour simply stays as it was in 0.63.0 — the overlays are
  never wrongly hidden.

## 0.63.0 — 2026-08-07

### Added

- **The overlays now appear and disappear by themselves.** Get in the car and
  they're on screen; press ESC, sit in the garage, or leave the session and
  they're gone — back the moment you drive again. No more toggling the
  overlay hotkey every session. Nothing to set up: leave **Show in game** on
  and it just works. If you preferred the overlays staying up everywhere,
  turn off **Auto show & hide** next to "Show in game". Edit layout always
  brings the overlays up so you can arrange them from any screen, and OBS
  Browser Sources are not affected.

- **A fastest lap for every class, not just the fastest car on track.** In a
  multiclass race the fastest-lap banner was always a Hypercar's lap — nothing
  to do with your race if you're in a GT3. The banner now shows one fastest
  lap per class, each in its class colour with the driver who holds it, and
  the purple BEST times in the tower mark each class's benchmark too. Want
  the old single-lap banner? Overlays tab → Standings card → **Fastest** →
  *Fastest overall* (OBS: `?standings=fastest=overall`).

- **The standings header can count your position in class.** A GT3 running
  35th overall can be leading its class — but 35 was the big number on the
  panel. Set **Position** → *In my class* (Overlays tab, Standings card) and
  the header reads `GT3 10 / 13` instead. The default is unchanged, and if
  the sim can't say what class you're in you get the overall figure as
  before (OBS: `?standings=pos=class`).

- **Every lap you drive now records how it was driven.** Throttle, brake,
  steering, gear, speed and G-forces are kept alongside the lap time, sampled
  every few metres, with sector splits for valid laps. Traces stay on your own
  machine (60 days), and only your best clean lap per track and class goes up
  to the league board with its time. Nothing changes on screen yet — this is
  the groundwork for the training feature, where you'll click a leaderboard
  time and see exactly where that driver brakes and gets back on the power.
  Laps driven from today onwards are the ones you'll be able to study.

### Changed

- **Your own row in the standings is now impossible to miss.** It carries a
  **YOU** tag, sits on a cyan tint bracketed down both edges, and keeps its
  numbers at full brightness while the rest of the field dims to context. The
  tag matters because colour alone can't do the job — the tint fades out as
  you wind the Widget background slider down, but the word stays. Hold the
  fastest lap too and the purple sits inside the cyan, so you keep both.

## 0.62.0 — 2026-08-06

### Added

- **Manufacturer badges in the standings and relative panels.** Every car's row
  now carries its maker's badge — the Ferrari shield, the Porsche crest, the
  BMW roundel — sitting between the class marker and the driver's name, the way
  a broadcast timing tower reads. The artwork is Le Mans Ultimate's own badge
  set, matched through the sim's car list, so every entry down to a custom team
  resolves to the right brand with nothing to set up; a car the sim can't name
  gets its neutral badge instead. The badges scale with the Text size slider,
  and OBS on a second PC gets them too — the overlay serves them itself rather
  than pointing at the game. Other sims and demo mode draw exactly the rows
  they always did.

- **Practice and qualifying now count your laps.** A race has always shown
  `LAP 1/16` at the top of the standings tower, but a practice session had no
  lap total to count towards, so that spot only carried the session name and the
  clock. It now counts the laps *you* have completed — `LAP 1` once the first
  one is in the books, `LAP 10` at ten — in exactly the place the race counter
  sits, with the session's name moved alongside it. It is your own tally, read
  off your row rather than the leader's, so a busy practice session with cars on
  every different schedule still tells you how much running **you** have done.
  The fuel panel's strip counts the same way.

## 0.61.0 — 2026-08-06

### Added

- **The standings GAP column can show the gap to the car in front.** It has
  always counted the gap to the leader of your class, which is the right number
  for a broadcast and the wrong one when you're racing the car you can see. On
  the Overlays tab, the Standings card now has a **Gap** setting: *To the
  leader* (unchanged, still the default) or *To the car ahead*, which shows the
  interval to the car directly in front of you in your class. Everything else
  about the column is the same — a class leader shows a dash, a lap down shows
  +1L — and hovering a gap tells you the other number. It works with any tower
  size, including one trimmed to a few cars: the interval is always to the car
  you're really chasing, not to whichever row happens to be above yours. OBS
  sources can pin it per source with `?standings=gap=ahead`.

### Fixed

- **Triple screens: you can put widgets on your side monitors.** If you run
  three screens *without* NVIDIA Surround, Windows treats them as three separate
  displays — and the in-game layer was only ever your middle one, so there was
  simply nowhere to drag a widget to. Nothing you could change in the sim or in
  the app would have helped; borderless windowed was never the problem. The
  layer now covers all three. Hit **edit layout** and drag anything where you
  want it: delta on the right screen, standings in the middle, tyres on the
  left. Edit mode outlines each monitor so you can see where one ends and the
  next begins, and a widget dropped in a gap between two mismatched screens is
  pulled back onto the nearest one instead of disappearing. **Your current
  layout doesn't move** — everything stays exactly where you put it, and if
  you're on one monitor or on Surround, nothing about this changes for you.

- **The overlay reached to the bottom of your screen.** It was actually stopping
  short by the height of your taskbar — about 48 pixels on a normal setup — so
  the widgets that sit along the bottom (tyres, pedals, damage) were riding
  that bit high, and the strip underneath them couldn't be used at all. The
  layer now covers the whole screen. Bottom-anchored widgets you've placed
  yourself stay put; if you've never moved them, they'll settle a little lower,
  where they were meant to be.

- **Plugging in a monitor mid-session no longer needs the overlay switched off
  and on.** Adding, removing or changing the resolution of a screen now resizes
  the layer straight away.

## 0.60.0 — 2026-08-05

Four things drivers told us about this week, all fixed.

### Fixed

- **Your track map no longer vanishes mid-session.** If the app decided the
  shipped circuit didn't match where your car actually was, it threw the map
  away and started learning again from scratch — usually somewhere in the
  middle of a stint, at a track that had been drawing perfectly fine, and it
  wouldn't come back the next time you loaded either. That check is gone for
  good. Once a circuit is on screen it stays on screen. **If you already lost a
  map this way, you get it back the first time you open this version** — nothing
  to delete, nothing to reinstall.

- **A cut on the last corner no longer voids your *next* lap.** The sim tells
  us about a track-limits cut up to 25 seconds after you take it, which is
  often most of the way round the following lap — so the lap that ran wide was
  going on the board clean, and the good lap after it was being thrown out for
  a mistake it didn't make. Every lap is now judged on its own cuts, using the
  sim's own record of which lap it charged. Nothing else about the rule has
  changed: a cut LMU charges you points for still voids the lap, and one it
  waves through still doesn't.

- **No delta, no track map and a blank car name on some PCs.** The app reads
  two separate data feeds from the sim, and one of them gave up permanently the
  first time Windows answered a routine question about it oddly — no error,
  nothing in the app to say so. Everything else kept working, which is exactly
  why it was hard to spot. If your pedals showed but your delta never armed and
  your map never drew, this was why.

### Changed

- **Widgets can be resized from the top and left as well.** Every widget now
  has handles on all four sides and both corners, so one that's ended up with
  its bottom edge below the screen can still be made smaller — previously the
  only handles were on the bottom and right, and if those were off-screen your
  only way out was resetting the whole layout. Anything already hanging off the
  screen is pulled back into view when you enter edit mode. Double-click any
  handle to reset that dimension, same as before.

## 0.59.0 — 2026-08-05

### Added

- **Every circuit now draws on your first lap — the track maps ship with the
  app.** The map has always been learned from your own car, because nothing in
  LMU will tell us the shape of the road, and that meant a lap of `LEARNING THE
  CIRCUIT — 62%` the first time you visited anywhere. But the positions the map
  is built from are the *sim's* coordinates, not your PC's, so a circuit learned
  on one machine is exactly right on every other one — the lap only ever had to
  be driven once, by anybody. So we drove them, and **32 circuits and layouts
  now ship inside the installer**: both Sarthe configurations, five Paul Ricard
  layouts, four Bahrains, three Silverstones, Spa and Spa Endurance, Monza and
  Curva Grande, COTA and COTA National, Fuji and Fuji Classic, Sebring and the
  School circuit, Lusail long and short, plus Daytona, Imola, Interlagos,
  Barcelona, Algarve and Laguna Seca. Fresh install, first session, no laps:
  the circuit is there.

  Nothing about learning has gone away — it is what covers a track that isn't in
  the box, and it always will be: a new season's circuit, a layout nobody has
  driven yet, a mod, rF2. Your own maps still win over the shipped ones, so a
  circuit you have already learned is still drawn from your lap. And a shipped
  map is not privileged: if your car disagrees with it for 200 m of road it is
  thrown out and relearned from you, exactly as a bad cached map always was, and
  it will not come back on the next launch.

## 0.58.0 — 2026-08-05

Everything below shipped to the beta channel as 0.58.0-beta.1 and beta.2 and
was proven in a live session before coming to stable.

### Added

- **Race Control widget — the calls the stock HUD makes, without the stock
  HUD.** Turn LMU's own overlays off and you also lose the moments race control
  talks to you: nobody says engage your limiter before the start, nobody counts
  the lights down, nobody tells you it's green, or yellow, or that the pit
  entry is coming up. The game publishes every one of those — we went and found
  where, in an instrumented race with deliberate rule-breaking — and the new
  widget gives them back: **ENGAGE PIT LIMITER** on the formation lap while
  yours is off, the start gantry lamp by lamp, a four-second **GREEN FLAG**
  (replaced by **LIMITER STILL ON** if that's the truer news), **FULL COURSE
  YELLOW**, a live **PIT ENTRY** countdown in metres once you've requested a
  stop — with a limiter alarm inside the last 150 m — and an S1/S2/S3 rail lit
  from the sim's own per-sector flags. Every prompt is the sim's own state, and
  the limiter prompts say nothing at all when the limiter can't be read
  (spectating, plain rF2) rather than guess at a race start. Find it in the
  overlay list as **Race Control** — it's on by default in the in-game layer.

- **Track Limits now warns you *during* the lap — while a lift can still save
  it.** The sim decides live whether the lap you're on still counts: it voids
  the time the moment you leave the road at a policed corner, holds a few
  seconds' grace to give the time back, and quietly restores the lap if you
  do — exactly what its own HUD shows as the yellow "calculating" that turns
  green. That verdict now reaches the Track Limits widget as it happens. The
  instant the time is void the panel lights up — an amber **EVALUATING** chip
  with the whole box glowing and breathing, built to catch the corner of your
  eye at racing speed — and if you lift in time it simply goes quiet, lap
  saved. Only when the sim stops being willing to forgive does it harden into
  a steady red **LAP INVALID**, which stands until you start a lap that
  counts. Loud while there's something to do, calm once there isn't. No more
  finding out at the line.

## 0.57.7 — 2026-08-04

### Fixed

- **Le Mans laps score now.** It was the last circuit that always came back
  "these laps can't be scored against the reference", on the pace widget and on
  the league board alike, and the reason was a missing fact rather than a bug:
  Circuit de la Sarthe has two layouts, both 13,626 m on paper, and the overlay
  had never been told what the second one calls itself. Every other way of
  telling them apart had already failed — identical length, no layout published
  over the timing feed — so it refused rather than guess, which was right. The
  two are **15 seconds a lap apart in GT3**: a guess would not have been a
  slightly-worse number, it would have been a confidently wrong one, and always
  in the same direction.

  A session was finally run on the other layout and settled it. The full circuit
  reports itself as **"Circuit de la Sarthe"**; the one without the Mulsanne
  chicanes reports **"Circuit de la Sarthe Mulsanne"**. Both are now recognised,
  so a Le Mans lap scores against the layout it was actually set on. A lap of
  4:11.469 that showed nothing before now reads 106.7% — and 114.1% is what it
  would have read had the wrong layout been assumed.

- **Two sources that disagree about the layout no longer pick a winner.** Le
  Mans publishes the venue and the full circuit's course name as the *same*
  string, so a lap arriving with the venue where a course name was expected is
  indistinguishable from one genuinely on the full circuit. Where something else
  on the same lap says otherwise, that is a disagreement rather than an answer,
  and it now scores nothing instead of believing whichever was checked first.
  Same habit as everywhere else here: say what the sim published, and say
  nothing where it did not.

## 0.57.6 — 2026-08-04

### Fixed

- **Wheel button mapping now works on every wheel, not just MOZA.** Reported by a
  tester on a Simagic Alpha base with a GT Neo rim, who could not bind anything
  at all. The cause was not Simagic-specific in the end, and it was worse than it
  looked: the overlay asked DirectInput for a fixed block of **128 buttons**, and
  `SetDataFormat` rejects the *entire* format with `E_INVALIDARG` the moment it
  describes even one more control than the device actually has. Measured on a
  MOZA R5 here: 128 buttons is accepted, 129 is refused.

  A MOZA R5 reports exactly 128 buttons. That is the only reason it ever worked
  — the request happened to fit it precisely. Any wheel reporting fewer failed
  this call, and the failure was discarded without a word, so the device simply
  never appeared and there was nothing to bind to and nothing to explain it.
  Every control on the format is now marked optional, so the request is a
  superset that fits any wheel instead of a shape only one wheel happens to be.

- **A rim's 7-way "funky" switches can be bound.** The overlay described buttons
  only, and a POV hat is not a button — MOZA reports its directional switch as
  four ordinary buttons, Simagic reports the GT Neo's two funky switches as
  hats, so those presses were not being missed so much as never delivered. Hats
  are now read and offered as eight directions each, shown as "hat 1 up" rather
  than a raw number, and existing bindings are untouched.

  One Simagic setting still matters: a knob switched to **absolute value mode**
  becomes an axis rather than a button, and an axis cannot be bound here — the
  steering and pedals live in that same list and would seize every capture.
  Leave the knob in incremental mode, which is its default, and it binds.

- **A wheel plugged in after the app started is now found.** Enumeration only
  ever ran once, on first use, so the bindings page kept answering with whatever
  was attached at boot however many times it was reopened — despite a comment in
  the code claiming otherwise. It now re-scans on request.

### Added

- **"Scan for wheels" on the Bindings page**, listing each controller with what
  it really exposes — buttons, hats and axes — plus any device that could not be
  opened and why. "My wheel does nothing" has two causes that look identical
  from outside: the device is not being seen at all, or it is, but the control
  being pressed is not a button. This tells the two apart at a glance.

## 0.57.5 — 2026-08-04

### Fixed

- **The track map no longer gets stuck learning the circuit forever at fast
  tracks.** Found live at Daytona, where the map never appeared: the learning
  read climbed to 99%, reset to nothing, and started again — every lap, with no
  way out of it. Fast, banked circuits were the worst affected, and a map that
  never publishes is also a map that never gets saved, so every session at that
  track started from zero.

  The circuit is learned by pairing where the car IS with how far round the lap
  it is, and LMU publishes those two things at very different rates: positions
  come from shared memory every frame, lap distance arrives over the timing feed
  about every 150 ms — twelve position updates per distance update, measured on
  track. Every one of those frames was being filed, so a stretch of road ended
  up recorded as a position from the start of one distance update sitting right
  next to a position from the end of another. On Daytona's banking that put two
  points 24 metres apart in the world where the road between them is 6 metres.

  The overlay has a check that asks whether a learned shape is a continuous
  circuit at all, so that a half-learned map with a line ruled across it is never
  drawn or saved. That check is what kept firing — correctly, on evidence that
  had been distorted before it got there. The faster the circuit, the worse the
  distortion, so the tracks that failed were the quick ones, which is precisely
  backwards for a check meant to catch something broken.

  Frames that only repeat a lap distance already recorded are now skipped rather
  than filed against a car that has since moved on. The same Daytona lap that
  used to be rejected now completes and is saved, and the check that was firing
  is left exactly as strict as it was.

  That check is also now asked of the finished, smoothed shape — the one that
  actually gets saved and drawn — rather than of the rough one behind it. It had
  been reading the rough version while the overlay's *other* copy of the same
  check, the one that vets a map loaded back from disk, read the finished one, so
  the two could disagree about the same circuit. They now agree, and measuring
  the finished shape takes the last of the sampling scatter out of the reading
  rather than out of the map: the Daytona lap clears the bound by 58% instead of
  by 4%, so the quick circuits have real room rather than scraping past. A map
  with a section missing is still refused — that shape measures eleven times over
  the line, and there is a test holding it there.

## 0.57.4 — 2026-08-04

### Fixed

- **The lap delta no longer measures you against a lap that cut the track.**
  Reported by a beta tester, who proved it by blazing through the first corners
  at Monza: that lap came back as the fastest of the session, the delta took it
  as the one to beat, and every clean lap afterwards read seconds down against a
  time that had not been driven round the circuit.

  The delta timed each lap itself, checked it was a plausible whole lap, and
  adopted the fastest one — with no notion of whether the stewards had charged
  it. The same lap is also saved as your all-time best and preferred over
  anything learned later, so one cut lap could sit there setting an impossible
  target at that track for good.

  It now asks the question the rest of the overlay already asks. Your weekly
  clean-lap count and the league board both refuse a lap the stewards charged,
  and the delta was the last place taking the stopwatch at its word: a lap with a
  cut, a penalty or a pit stop in it can no longer become your session best or
  your all-time best.

  **Last lap is deliberately unchanged.** It still shows the lap you just drove,
  cut or not — when you have run wide, what it cost you is exactly the thing
  worth knowing.

  Two things to expect the first time you run this. All-time bests saved before
  today cannot say whether they were clean, so they are set aside and your first
  clean flying lap in each car writes a new one — if a delta reads as unknown for
  a lap, that is why. And the sim reports a cut up to twenty-five seconds after
  you take it, so a cut in the final corner can be charged to the lap that
  follows it; that lap is passed over as a reference and the next clean one takes
  its place.

## 0.57.3 — 2026-08-04

### Fixed

- **The track map no longer draws half a circuit with a line ruled across it.**
  Reported by King. XILE GT, from Daytona: the final sector missing, a chord
  closing the gap, and the field driving off the bottom-right of the panel
  through the part that was never learned.

  A lap distance that ticks backwards — a spin, a car rolling back out of the
  gravel, a scoring read arriving out of order — was counted forward round the
  lap instead, so a car that had moved a metre appeared to have covered nearly a
  whole circuit. Every stretch of road not yet learned was filled in with the one
  spot the car was standing on, the map declared itself complete, and it was both
  drawn and saved that way.

  Three checks now stand between that and your screen. A shape is refused if
  neighbouring points are further apart than the road could be — complete is not
  the same as continuous. Saved maps are asked the same question when they are
  read, so a bad one already on disk is dropped rather than drawn. And the map is
  checked against the car every frame: two hundred metres of road disagreeing
  about where you are and it is thrown away and relearned, with the panel reading
  **Rebuilding the circuit** so it is visibly a repair rather than a fault.

  That last threshold is a length of road, not a number of frames, so a car sat
  in the barriers or in its garage cannot cost you a good map however long it
  stays there.

- **ELMS LMP2 laps can be scored again.** Reported from the Daytona board, where
  a lap in the ELMS Oreca came back "No reference times for LMP2_ELMS" even
  though the reference sheet has had those times all along.

  LMU races the two LMP2 rulesets as separate categories and says so — its entry
  lists carry `LMP2` and `LMP2_ELMS`, and the ELMS car is a different power level,
  around three and a half seconds a lap at Bahrain. Only the first of those two
  names was recognised, so the second was treated as a category nobody had ever
  heard of: no reference, no colour of its own in the standings tower, and a
  two-letter tag derived from the spelling.

  It is now a class in its own right. It reads the sheet's ELMS row outright —
  with nothing assumed, because the sim already said which ruleset it was — and
  it reads as **LMP2 ELMS** wherever a class is named, in its own shade of the
  LMP2 blue.

  The two boards stay separate, which is the point: they are different cars, and
  a single LMP2 board would rank them against each other.

- **Monza, Fuji and Paul Ricard laps now score, on your board and everyone
  else's.** These used to answer "…has 2 layouts with reference times and the sim
  did not say which one this is", which turned out not to be true.

  LMU's track name is the **course** name, not the venue name — the same string
  it writes into its own result files — and the course *is* the layout. The venue
  is a separate field that never reaches us. "Autodromo Nazionale Monza" is the
  Grand Prix layout; the other one arrives as "Monza Curva Grande Circuit", and
  the two are around ten seconds a lap apart. The names were being read as though
  they said nothing.

  They are matched whole rather than by fragment, which matters more than it
  sounds: "Fuji Speedway" is the start of "Fuji Speedway Classic", and those two
  are 3.8% apart. A layout is listed only where a real session on it has been
  played and its name read off LMU's output, so a name we have not seen still
  scores nothing rather than something wrong.

  This is also what makes **other people's** laps scoreable at those circuits. A
  league board row carries a track name and a lap time and nothing else, so no
  amount of extra detail recorded alongside your own laps could ever have reached
  it.

  Le Mans is deliberately still unscored. Only the full circuit has been
  observed, and the Mulsanne without its chicanes is sixteen seconds a lap
  quicker — a wrong number there would look exactly as authoritative as a right
  one.

- Reference times re-baked from Ohne Speed's sheet as updated 4 August.

## 0.57.2 — 2026-08-04

### Added

- **Speed in mph, if that is how you read it.** Suggested by a beta tester.
  **Settings → Appearance → Speed units** switches every speed the overlays show
  between km/h and mph, live, with no restart.

  It is one setting rather than one per widget on purpose. Three widgets show
  speed — both **Inputs** panels and **Motion** — and the failure worth
  preventing is not the wrong unit, it is two panels disagreeing: 168 on one and
  104 on the next, which reads as a broken overlay rather than a preference. The
  conversion now happens in one place for all three.

  An OBS source can pin its own with `?units=mph`, so a source built for one
  audience does not change because the driver prefers the other on their own
  screen.

## 0.57.1 — 2026-08-04

### Added

- **Choose how much of the field the standings tower shows.** Suggested by a
  beta tester. A full grid is 20–30 rows — right for a broadcast, most of your
  screen while driving.

  On the **Overlays** tab the Standings card now has a **Show** setting. Leave it
  on *Whole field* and nothing changes. Switch it to *Just these cars…* and you
  get three numbers: how many **leaders** to keep, how many cars **ahead** of
  you, and how many **behind** — counted either within your own class or across
  the whole field.

  Those three cover the things people actually ask for, including the two that
  prompted it: "three in front and three behind" is 0 leaders with a 3/3 window,
  and "top ten of each class" is 10 leaders counted per class. Anything between
  them works too, without it having to be a preset someone thought of first.

  Two rules the tower keeps whatever you set it to. **You are never filtered out
  of your own standings** — if the numbers would drop you, your row stays
  anyway. And **the numbers on screen still describe the race, not the panel**:
  the purple fastest lap, each class's benchmark and the car counts on the class
  headers are all read from the full field, so a trimmed tower says "3 OF 9
  CARS" rather than pretending GT3 has three cars in it.

  An OBS source can pin its own view with `?standings=all` or
  `?standings=top=10,scope=class`, so a source set up to show the front of the
  race does not change because a driver adjusted theirs.

### Changed

- **The overlay hotkey now cycles: shown → off → edit layout → shown.** Suggested
  by a beta tester. Moving a widget used to mean alt-tabbing out of the game to
  the control panel, clicking Edit layout, tabbing back to drag it, and tabbing
  out again to finish — for a thing you can only judge by looking at it over the
  running game. Edit layout is now on the same key as showing the overlay, so
  laying it out never means leaving the sim.

  The trade is that coming back from off to shown passes through edit layout —
  press it twice. Nothing is lost on the way through: a layout only changes if
  you drag something, and edit mode is obvious when you are in it.

  Interact mode (F7 by default) is unchanged and still has its own key.

- **New installs use port 17080 instead of 8080.** 8080 is the most contested
  alternate-HTTP port on Windows — dev servers, routers, NAS boxes, printers and
  SimHub's own web server all reach for that band — and it is one of the ports
  most likely to sit inside one of those Windows reservations. 17080 is clear of
  all of it, clear of the things a sim racer actually runs (OBS's WebSocket,
  Discord, Steam, LMU's own API), and below the range Windows draws its
  reservations from.

  **Nothing changes for anyone already running.** This is only the starting
  point for a fresh install; your port is saved, so your OBS sources keep
  working exactly as they are.

### Fixed

- **"listen EACCES: permission denied 127.0.0.1:8080" — the app could refuse to
  start at all.** Reported by the first beta tester, within a day of the first
  five going out.

  That message means something different from the one it looks like. It is not
  "port 8080 is busy" — that would say `EADDRINUSE`. It means *nothing* is
  listening there and Windows still will not hand the port over, which is what
  happens when Hyper-V, WSL or Docker has reserved a block of ports covering it.
  There is no process to find and close, so the only advice the app was offering
  was a Node error string.

  The app now moves itself. If the port it is told to use is refused, it tries
  the next few, then jumps well clear — a Windows reservation is a *block*,
  routinely hundreds of ports wide, so nudging up by one can land inside the
  same reservation every time. It starts on the first port that works, remembers
  it, and says plainly that it moved and that any OBS browser source you already
  added is pointing at the old number.

  If every port it tries is refused, it now names the actual cause and what to
  do about it, instead of repeating the error verbatim.

## 0.57.0 — 2026-08-04

### Added

- **Two release channels, so the app can be worked on and driven at the same
  time.** Until now there was one kind of release and everyone got it the moment
  it was published. That is the right answer for a finished thing and the wrong
  one for a platform being tested by the community while it is still being
  built: any change had to be either safe enough for everybody or held back
  entirely.

  There are now two feeds from the same place. **Stable** is what every driver
  gets and what the league runs. **Beta** is the same installer published as a
  prerelease, for the people building it — those builds arrive first, and they
  break first. A stable install cannot be handed a beta by accident: it asks
  GitHub for the latest release, and a prerelease is not one, whatever its
  version number says.

  Beta builds are not a separate branch of the app. A beta tester still receives
  stable releases as they come, so a beta being promoted is a non-event for the
  people who were testing it — they move onto the release like everyone else.

- **A release channel picker in Settings.** League staff only, behind the same
  check as the Admin tab. It is not a lock — the beta releases are public — but
  a driver testing the overlay should not be one dropdown away from a build we
  are midway through breaking.

  Switching back to stable while running a beta does the thing you would expect
  and the app previously could not: it moves you *back*. A beta is numerically
  newer than every stable release, so without this the app would report "up to
  date" and quietly leave you on it. This is the only case where the app will
  ever install a version lower than the one it is running.

  Anything offered from the beta feed is named as a beta everywhere it appears,
  including the banner you press to install it.

### Changed

- **`npm run release` now decides the channel from the version number.** A
  version of `0.57.1-beta.1` publishes to beta; a plain `0.57.1` publishes to
  everyone. There is no flag to remember, because the failure that matters here
  is handing a half-finished build to the people testing the platform, and a
  flag you can forget is exactly how that happens. The published release is read
  back afterwards and its channel repaired if it landed on the wrong one.

  Promoting a beta means folding its notes into one section for the release: the
  changelog gate refuses to publish `0.57.1` while `0.57.1-beta.*` sections are
  still listed separately, since drivers on stable never ran those builds and
  need the release rather than a diary of how it got there. The whole process is
  written down in `docs/RELEASING.md`.

## 0.56.1 — 2026-08-04

### Fixed

- **Clicking another driver's lap on a league board did nothing.** The feature
  shipped yesterday scores a board lap against the reference times, and to do
  that it has to know which LAYOUT of a circuit the lap was set on. It tried to
  read the track's length out of the board's track id, on the assumption that
  the id was the lap log's own `slug_metres` key. It is not — it is a database
  UUID — so the length was never found and every board was scored with no layout
  hint at all.

  Circuits with a single layout were unaffected, which is why this got out: those
  boards scored fine. Every multi-layout circuit came back "ambiguous layout",
  and an unscorable row is deliberately not a button — so the whole thing
  presented as a click that did nothing. Bahrain, Circuit of the Americas,
  Lusail, Sebring and Silverstone are all scored on their boards again. The
  length now comes from the leaderboard itself, which is the same measurement
  the app already uses to score your own laps at the same place.

  Four circuits still cannot be placed from a board row, and that is a limit of
  the data rather than of this fix: Monza and Le Mans hold two layouts of
  identical recorded length, Fuji's two are 37 m apart, and Paul Ricard's Grand
  Prix shares its length with the 1A-V2. Nothing in a board row can separate
  those, so they say so instead of guessing. Your own laps at the same circuits
  are usually still scored, because a lap you drove also carries the sim's scene
  name and its declared configuration — a board row carries neither.

- **A board that genuinely cannot be scored now says so before you click.**
  Some circuits cannot be resolved at all — Monza's two layouts are ten seconds
  apart in pace and identical in recorded length, so nothing in a board row can
  separate them, and refusing to score is the correct answer. It was also an
  invisible one: the invitation to click a lap stayed on screen and the
  explanation was a grey line under the board. That invitation is now hidden
  when nothing on the board can be scored, so it never promises a click it
  cannot honour.

### Changed

- **Boards carry a Pace column.** The grade used to be behind a click, which
  made a lap with no score indistinguishable from a broken button. Every row now
  shows its percentage where you can read the whole field at once, in the band's
  colour, with an em dash where the reference cannot place the lap. Clicking a
  row still opens the full breakdown beside the board.

## 0.56.0 — 2026-08-04

### Added

- **Every lap time on a league board is now clickable, and tells you where that
  lap sits against the reference.** A board answers one question — who is
  quickest — and then leaves the more useful one hanging: is the driver 1.4s up
  the road running alien pace, or is the whole board having a quiet Tuesday?
  Those two situations look identical in a gap column and mean opposite things
  about whether the time is worth chasing. Click any row and the card beside the
  board takes that driver's name and fills with their percentage, band, gap to
  the reference and position on the ladder — the same spreadsheet, the same
  bands, the same arithmetic used on your own laps. Click the row again to hand
  the card back to yourself.

  The whole board is scored when it loads rather than on each click, so a row
  knows whether it can be scored before you click it, and one that cannot stays
  inert instead of accepting a click and then admitting there was no answer.
  Board rows carry no track metadata — the league returns a ranking, not the
  laps' identity — so the layout is resolved from the length stored inside the
  board's own track id. Where that cannot separate two layouts of one circuit
  (Monza's are the same length to the metre) the rows go unscored and a line
  under the board says why, because a percentage against the wrong Monza is
  worse than no percentage: it looks like an answer.

  Only that card follows the board. The Dashboard's Pace rank stays yours
  whatever you click here — a tab about your own driving that could be left
  showing a stranger's lap is a trap you would find days later, wondering when
  you got quick at Sebring.

- **The Dashboard's best laps this week are clickable too.** They now carry the
  same Track / Class / Best lap / Pace columns as the Leaderboard's list, with
  the band colour on each row, and clicking one loads that lap into Pace rank
  above. Laps the reference cannot place are shown with the reason on the row
  rather than dropped, so a known limitation stays a known limitation instead of
  becoming a mystery.

  The lap you are shown is the lap you clicked. This list holds *this week's*
  bests and the Leaderboard's holds *all-time* bests, so at a track where you
  went quicker last month both carry a row for the same track, class and car
  with different times on them. The selection remembers which list it came from
  for exactly that reason — otherwise clicking this week's 2:20.4 would answer
  with the all-time 2:19.5, three lines above a row that says otherwise.

  The stat tile still always reports your best. A tile that changed when you
  clicked a list further down the page would stop being a stat.

- **The app tells you what changed when it updates.** Until now an update was
  silent: the banner said a new version was available, you clicked, the app
  restarted, and whatever had been built for you was left to be discovered by
  accident. The first launch on a new build now opens **What's new** — every
  release between the build you last opened and this one, in full. Skip two
  releases and you get both, newest first, rather than only the one you landed
  on.

  The notes are this file. `CHANGELOG.md` ships inside the package, so the panel
  reads its own copy: it works with no network, it appears the instant the
  window opens rather than after a round-trip, and it cannot disagree with the
  version actually running. It is parsed in the main process into a block tree —
  headings, bullets, paragraphs, bold, italic, code, links — and drawn with
  `createElement` and `textContent`, so no markup from a file (or later, from a
  GitHub release body) can reach the panel's DOM.

  The version in the footer is now a button: the place you look to check which
  build you are on is the same place you ask what was in it, and it opens the
  same sheet with the last forty releases. Closing is what records the notes as
  read, not opening — quit part-way through and they are offered again.

- **The update banner can say what an update contains before you install it.**
  Deciding whether to restart mid-session meant guessing. When the release feed
  carries notes, the banner gains a **What's new** button next to the action, and
  it stays available from "available" through to "ready to install". Those notes
  come from the network, so they are flattened to plain text before they are
  shown — never rendered as markup.

### Changed

- **A release cannot be published without notes any more.** `npm run release`
  now runs `scripts/check-changelog.js` first (npm's `prerelease` hook), which
  refuses to build unless this file has a dated, non-stub section for the version
  in `package.json`. That gate exists because the app now *shows* the entry to
  every driver: a missing one is no longer just undocumented, it is an update
  that announces itself and then has nothing to say.

- **The GitHub release body writes itself.** `scripts/release-notes.js` slices
  this file's section for the version being built into `build/release-notes.md`,
  which `build.releaseInfo.releaseNotesFile` hands to electron-builder. Every
  release so far needed a follow-up `gh release edit --notes-file` by hand, and
  a release page was blank whenever that was forgotten. One source of truth now:
  the same text lands in the repo, on the release page, and in the app.

## 0.55.0 — 2026-08-03

### Added

- **The track map's elevation is now a solid.** The circuit stands on a ground
  plane, and the road is extruded straight down to meet it all the way round, so
  the depth of that mass at any point is the height of the track there. Before,
  the only way to read a hill was the gap between the road and its own cast
  shadow — a cue you had to already know to look for, and one that disappeared
  entirely on a browser without canvas filters. Now a climb reads as the road
  pulling away from its own base, and the two ends of a straight visibly sit at
  different heights.

  The plane is a soft pool of light rather than a plate with an edge. This
  projection has no perspective, so any rectangle laid on the ground arrives
  screen-aligned and reads as a card behind the map instead of a surface under
  it — and the widget background is something an operator can turn off entirely,
  which a plate would quietly put back. Something that fades out has no edge to
  give itself away.

  The curtain is lit by the wall above it and keeps falling, darkest at the
  foot, so the solid stays one material under one light rather than a ribbon
  with a skirt attached. The cast shadow keeps its place but changes job: it is
  the contact shadow at the foot now, which is what stops the whole thing
  floating on its own plane — and it goes back to carrying the elevation alone
  on a flat circuit, where there is no curtain to draw.

  Flat circuits pay nothing for any of this and are drawn exactly as before.
  `?ground=0` returns the previous look.

### Fixed

- **A circuit crossing itself could sort the wrong way round.** Where a track
  passes over itself the two roads share a footprint, so the depth sort saw them
  as equally distant and picked between them arbitrarily — it could land either
  way from one rebuild to the next. The sort now accounts for height, which is
  what the view already implies: the higher road is the nearer one. Invisible
  before, when the only thing at stake was six pixels of wall; not invisible
  with a hill hanging underneath.

## 0.54.1 — 2026-08-03

### Fixed

- **The track map was drawn as a mirror image of the circuit.** Every left-hander
  came out a right-hander: at COTA the Turn 1 hairpin climbed *up* the panel and
  the esses ran the wrong way down it. The projection fed the sim's depth axis
  straight into screen Y, and screen Y grows downward — so the plan was flipped
  before it was ever tilted. The sign is corrected at the one place the road, its
  shadow, the lighting normals and the car dots are all built from, so the shape
  now matches the map on the wall and a car turning left is drawn turning left.

## 0.54.0 — 2026-08-03

### Added

- **A 2.5-D track map.** The whole circuit as a road raised off the plane and
  viewed at an angle — corners read as corners, and the elevation of the place is
  drawn rather than implied — with a dot for every car in the session: yours in
  white with a ring round it, everyone else in their class colour, anyone in the
  pit lane faded. It answers the question neither the radar nor the relative panel
  can: not "who is beside me" or "how far back in seconds", but *where is
  everybody*.

  **The circuit is learned from your own first lap.** There was no shape to ship:
  LMU packs each track into an encrypted archive, and no endpoint publishes the
  road as geometry — only a lap *length*. What both sims do publish is where the
  car is, thirty times a second, with a lap distance beside it, and one lap of
  that IS the circuit. So a new track shows `LEARNING THE CIRCUIT — 62%` while you
  drive it, then caches the shape in `~/.apex-overlay/tracks/` and draws instantly
  in every session after. It works at all 17 LMU circuits, at rF2's, and at ones
  that do not exist yet, with no per-track setup — and because the shape is
  measured in the sim's own world coordinates, the car dots are the same numbers
  as the road and need no fitting to land on it. A car running wide is drawn
  running wide.

  Elevation is exaggerated to a fixed share of the map's own size: ±30 m across a
  1.5 km footprint is under 2% of the width and would be invisible at true scale.
  So is the road's width, for the same reason and to the same end — every printed
  circuit map does both. Neither ever moves the centre line, so where a car is
  drawn is unaffected.

  The ribbon is one material lit by one light, not a light road with a coloured
  wall glued to it — which is the difference between a solid object and a paper
  cutout. Each segment's surface and sides are shaded from the direction the road
  is actually going, the two edges are chamfered so they catch the light, and the
  whole thing is drawn over its own blurred silhouette projected onto the ground
  plane. That last part is why the elevation reads: the shadow stays flat while
  the road climbs away from it, so the gap between them *is* the hill.

  Two palettes: `?style=classic` (the infographic red of a printed circuit map —
  the default) and `?style=brand`, which runs the overlay's cyan→magenta round the
  lap so the colour under your dot also says where in the lap you are. Both are
  lit by the same model; only the base hue differs.

  The shape is served over HTTP (`/trackmap.json`) rather than in the telemetry
  frame — 40 KB that changes a handful of times a session has no business being
  sent thirty times a second — and the ribbon is rendered once to an offscreen
  canvas, so each frame is a blit plus the dots.

## 0.53.0 — 2026-08-03

### Added

- **Every car in the Relative panel now says which class it is in.** A small square
  at the head of each row carries the class — `HY`, `P2`, `P3`, `GT3`, `GTE`, `GT4` —
  in that class's colour, the same colour the standings tower and the radar already
  use. The gap alone never said whether the car closing on you is a rival for
  position or a faster class coming through, and those are different decisions taken
  at different moments. The letters take the class colour on a dark square rather
  than the reverse: seven of these stack in one panel, and seven blocks of saturated
  colour would out-shout the gap column, which is the thing actually being raced. A
  class the palette has never seen still gets a tag derived from its name (`TCR Cup`
  → `TCR`, `Porsche Carrera Cup` → `PCC`) rather than an unexplained colour.

  The class palette, the abbreviations and the full names now live once in the shared
  runtime. The colour table had been copy-pasted between the standings tower and the
  radar, one edit away from the two disagreeing about which green is GT3.

### Changed

- **Three lap readouts got bigger.** The `N LAPS LEFT` line beside the session
  counter (on Standings and Fuel) goes from 12px context text to Tier 1 — "8/16" has
  to be subtracted before it means anything, and the number a driver fuels and paces
  against is the one already subtracted. The Relative panel's own `LAP 8/16` goes
  from 15px to 20px: it is the only statement of how much race is left on the panel
  read most often. And in the Fuel widget the two **Laps Left** tiles are promoted
  above their neighbours — laps are the unit a stint is planned in, and the figures
  either side of them are the arithmetic that produced them.

- The Fuel panel moved down the combined 1920×1080 stage to make room for the taller
  Relative table. Measured at both ends of the text-size slider, not guessed.

### Fixed

- **The backmarker ghost was showing on every row of the Relative table**, including
  the player's own, which made the one row it was supposed to mark mean nothing. The
  widget hides it correctly; an author `display` rule silently outranks the browser's
  own `[hidden]` rule, and this one had no counterpart. It only ever went wrong on
  the OBS and browser pages — the in-game layer carries a catch-all that masked it.

- **The two rows either side of you were never actually promoted.** Their gaps are
  the ones being defended or attacked right now and are meant to be the only Tier 1
  numbers in the table; a comment that closed one paragraph early left the rule that
  did it as stray tokens for the CSS parser to swallow, along with the rule itself.
  The panel had been sizing every row alike ever since.

## 0.52.0 — 2026-08-03

### Added

- **A background slider on every widget card — fade the set, keep one solid.** The
  **Widget background** slider in Appearance is all-or-nothing: it moves every panel
  together, so an operator who wants the overlay at 50% over the track has no way to keep
  the one panel they actually read at speed legible. Each card in **Overlays** now carries
  its own `BG` slider, which is that widget's exception to the global one. A card on
  **Auto** (the default, dimmed to say so) has no override and previews the global value
  as you drag it; touching its slider creates the override, and the **Auto** button hands
  the widget back. Overrides ride the same live channel as the global — in game and in
  OBS sources already running, no reload — and `?bg=` on a URL still pins a source's
  whole background, per-widget exceptions included.

### Changed

- **The fuel cubes moved to the top of the widget, beside the bars.** They were at the
  foot, below all the working, which is the wrong way round for the four figures the panel
  exists to produce. Each budget now reads as one row — its bar, then how much is in it,
  then how far that goes — fuel above energy. The bar is the only part that flexes: narrow
  the widget and the bars give up their width while the cubes stay exactly the size they
  were, because a Tier 1 number that shrinks with the panel is no longer Tier 1. Each bar
  also takes its own budget's colour (green for fuel, cyan for energy) to match the stripe
  on the cube beside it — the fuel bar's brand gradient read as a third colour with no
  meaning once the two sat together. A car with no virtual energy loses that whole row.

- **The change glow is amber now, red when the news is bad — and much brighter.** Cyan
  lost two fights at once: it is low contrast against sky and pale tarmac, and several
  widgets already use the brand cyan as their own resting accent, so a cyan bloom landed
  on things that were permanently cyan anyway. Amber appears nowhere in the resting
  palette, so anything wearing it just changed. The bloom itself is four stacked stops
  instead of two, and is held at full strength twice as long (240 ms) — it has to be
  catchable by an eye that is on the track and only sweeps the overlay between corners.
  A change landing on a value that is **already** bad news — fuel short at the flag, a
  tyre past its wear limit, a repair over the budget — burns red instead, so the bloom
  says how bad as well as that it moved.

### Fixed

- **Text size and Change glow did nothing.** The control panel had been sending both
  since they were added, and the settings handler in the desktop app never copied either
  one out of the message — so dragging the text slider or flipping the glow switch saved
  nothing, pushed nothing, and reverted the moment the panel re-read its state.

- **Per-widget settings were forgotten every time the app started.** Widget display modes
  (and now background overrides) are carried on the appearance channel, which the server
  boots empty because neither map has a config field. Nothing re-sent them after a
  start or a port change, so a tyre widget left on `tread` — or a panel kept solid inside
  a faded overlay — quietly rejoined the defaults until the operator touched a setting.

## 0.51.0 — 2026-08-02

### Changed

- **The fuel widget no longer rotates — everything is on screen at once.** It used to
  cycle the FUEL and VIRTUAL ENERGY blocks every 20 seconds, which meant half the time
  the figure you looked down for was the one not showing. A fuel call is made in the two
  seconds before the pit entry, not whenever the rotation next comes round. Both blocks
  are now permanent and headed, so which four figures are litres and which are percent is
  never in question. Cars with no energy budget have no energy block at all rather than an
  empty one.

- **Four cubes at the foot of the fuel widget.** Below a rule, past all the working: fuel
  litres and laps of fuel across the top, energy percent and laps of energy across the
  bottom. How much is in it, and how far that goes, per budget — the answer the rest of
  the panel is arriving at, sized to be read without looking, and found by position
  rather than by reading a label. The laps cubes bloom when a whole lap of range goes;
  the quantities do not, because a glow on every tick of a decimal strobes all race.

### Fixed

- **Serving a penalty no longer leaves you with an empty tank and no way to know.**
  Arming `DRIVE-THRU` or `STOP/GO` on the MFD's SERVE row strips the next stop back to no
  service, which is what makes a stop-and-go a stop-and-go — and it takes the fuel with
  it. A fuel row sitting at 0 is silent: it looks exactly like a row nobody has set yet.
  While a penalty is armed, `FUEL` and `VIRTUAL ENERGY` at zero now flash red and take
  the red for their stripe and tint too, so the row reads as *wrong* rather than as the
  ordinary green fuel line with a small number. Only while armed — 0 fuel with nothing to
  serve is the menu's resting state, and a widget that flashes all race is one you stop
  seeing. `FUEL RATIO` is left out of it, being a plan for later stops rather than an
  amount going in now.

- **Changing your mind about serving one now refills the car.** Scrolling SERVE back to
  `OFF` puts fuel and virtual energy back to a full load. The rest of the cleared stop
  stays cleared — the tyres, the damage choice and the driver change are gone and were
  never copied anywhere, so restoring them would be inventing a pit stop rather than
  returning the driver's. The **driver change in particular is left exactly where the
  clear put it**: re-booking a swap nobody asked for costs a great deal more than a wrong
  fuel load. Fuel is the one part with an unambiguous safe answer, and it is the part
  that would otherwise end the race a lap after the change of mind.

  The Control Panel's bindable **Serve stop/go** button (and `POST /api/mfd/servestopgo`)
  now arm the SERVE row too. They strip the service exactly as the row does while knowing
  nothing about it, which left the row reading `OFF` about a stop that had just been
  emptied — no flash, and nothing to scroll back from. Arming it with the button and
  cancelling it on the row now works. If the pit request itself fails to send, the row
  lands on `DRIVE-THRU` rather than claiming a stop was booked.

## 0.50.0 — 2026-08-01

### Added

- **A driver list in the Admin tab — who, not just how many.** 0.49.0 answered how
  many people use the overlay system and how often; it could not name one of them. The
  Admin tab now carries a **Drivers** card listing every account with its name and email,
  **how many times that driver has opened the app**, and **when they were last active** —
  sorted by last active, most logins, name, or newest account, with a search that matches
  either name or email. An account that has never launched the app reads `0` and *Never*
  rather than being left out, because "signed up and never came back" is the row a league
  most needs to see. Hovering a row gives the version they last ran and the day they joined.

  This deliberately moves a boundary 0.49.0 drew. That release said an admin sees
  aggregates only, never another driver's raw rows; this is the considered exception,
  and it is scoped to identity and presence — a name, an email, a count, a timestamp.
  Nothing about how anyone *drives* is exposed: no laps, no telemetry, no session detail.
  The gate is unchanged and is still the server's: `admin_users_list` is SECURITY DEFINER
  and re-checks `is_admin`, so a non-admin calling it directly gets an exception rather
  than a roster.

  Two details worth knowing when reading the numbers. **Logins count app opens**, not
  Supabase sign-ins — one per run of the app, from the same `app_sessions` heartbeat the
  usage tiles already use. And that heartbeat only started recording in 0.49.0, so an
  account older than it shows `0` until its next launch; the card says so under the list
  rather than letting the column be misread. Search and sort both run **server-side**, so
  a league that grows does not turn into a larger download every time the tab is opened.

  Ships as `supabase/migrations/0002_admin_users.sql` — one new function, no schema
  changes, re-runnable like 0001.

## 0.49.0 — 2026-08-01

### Added

- **An admin panel, for the league rather than the driver.** A new **Admin** tab in the
  control panel answers the three questions the overlay system could not before: how many
  people use it, how often, and what they are asking for. It is hidden for everyone but
  league staff — the tab only appears once `admin_whoami` confirms the account, and every
  number behind it is fetched through a security-definer RPC that checks `is_admin` again,
  so the hidden attribute is convenience and the server is the boundary. What it shows are
  **aggregates only** — active-today / this-week / this-month, sessions, a 14-day
  active-users chart, version adoption, and a feedback inbox — never another driver's raw
  rows.

- **A usage heartbeat — the one new signal.** Everything the league could previously see
  about usage arrived only when someone *completed laps* (`submit_activity`), which misses
  a streamer who ran overlays and never touched the lap counter. `electron/usageReporter.js`
  lands one `app_sessions` row the moment the app opens and refreshes it every five minutes,
  carrying only the app version and a coarse OS label — no telemetry, nothing about what was
  on screen. The write is idempotent on a per-run session id (the server keeps the later
  `last_seen`), exactly like the lap uploader, so a dropped or repeated beat costs nothing.
  Signed-in only, by design: it rides the same `auth.rpc` path and simply waits, quietly,
  until the driver signs in.

- **The Suggestions tab does something now.** It was a "coming soon" placeholder; it is now
  a working feedback form (idea / bug / other) that files one row through `submit_feedback`
  with the app version attached, so the admin inbox reads it in context. Admins triage each
  item's status (new → planned → in progress → done / declined) straight from the inbox.

- **The Supabase side ships as a migration.** `supabase/migrations/0001_admin_panel.sql`
  adds the `app_sessions` and `feedback` tables, an `is_admin` flag on `profiles`, and the
  six RPCs the app calls. It is re-runnable, and the schema lives in the repo even though
  the project it applies to does not — the app only ever calls these functions, the same way
  it calls the leaderboard's. Apply it, set `is_admin = true` on your own profile, and the
  tab appears.

## 0.48.1 — 2026-08-01

### Fixed

- **The published 0.48.0 installer could not link YouTube.** The source was never at
  fault and no work was lost — the binary was simply built on a machine without the
  Google OAuth credentials in its environment, so `scripts/write-oauth-client.js` baked an
  empty client, warned, and let the build continue. Every install updating to 0.48.0 saw
  *"YouTube linking isn't available on this build"*. This release is the same code rebuilt
  with the client present; the shipped package was checked rather than assumed, by reading
  the baked client back out of `app.asar`.

## 0.48.0 — 2026-08-01

### Changed

- **The track-limits widget now shows only the stewards' own numbers.** The headline is
  how much of the points allowance is **left**, counting down — "1.75" answers the
  question a driver actually has, where "3.25 spent" needs arithmetic first. Under it, a
  bar draining as the allowance goes — amber under half of it, red under a fifth — and a
  **CUTS** strip listing what each of the last five cuts was charged: `0.25 · 0.5 · 1.0`.
  That strip is the part that changes behaviour — three 0.25s in a row is one kerb being
  clipped every lap and fixable by moving your line a foot; a single 1.00 is one mistake
  already made, and the running total alone cannot tell those apart.

  The widget now flashes for exactly one thing: the moment the total goes up, in yellow,
  carrying the amount (`+0.25`, `+1`) for two seconds, with the audio cue. That is the
  only event on it a driver has not already seen for themselves — you know you ran wide;
  what you do not know is what it was charged. The flash is a pill in the corner rather
  than the full-panel banner a penalty gets: the question a charge raises is "so where
  does that leave me", and covering the answer to ask it would be perverse.

  In practice and qualifying, where LMU invalidates the lap instead of spending the
  allowance, the headline shows points spent and the bar is hidden — there is no
  drive-through to count down to. On plain rF2, which writes no trace log, the widget
  shows the penalty count and says it cannot see a total rather than inventing one.

### Removed

- **The geometric excursion detector, and everything built on it.** The overlay used to
  reconstruct track-limit points from the car's lateral position against the track edge,
  because nothing published LMU's real ones. Something does now — the trace reader added
  in 0.44 was validated against a session-end results file, reproducing all thirteen of
  that race's charges in order and to the exact 5.00 that earned the drive-through — and
  an estimate sitting beside the stewards' own figure, disagreeing with it, is worse than
  no estimate. It could never have been right in principle either: it scored on how far
  off the road the car got, and the sim charges on time gained.

  Gone with it: the **Track limits threshold** slider in the Control Panel's Server card
  and the `APEX_LIMITS_MARGIN` environment variable (there is no threshold left to tune);
  the at-risk **LIFT** / **SAVED** prompts; the "+1 POINT" callout; the metres-of-road-left
  bar; and the `+?` pending marker. The lap log's clean/dirty flag now keys off the sim's
  own charge count rather than our excursion count.

  The one cost, stated plainly: the sim flushes its log a block at a time, so a charge can
  reach the overlay anywhere from a tenth of a second to ~25 s after the cut. The total is
  right; sometimes it is right late. Full workings in `docs/TRACK-LIMITS-POINTS.md`.

## 0.47.2 — 2026-08-01

### Fixed

- **YouTube chat never appeared, whatever was on air.** Broadcast discovery asked the API
  for `mine=true` and `broadcastStatus=active` together. Those are alternative filters
  rather than a filter and a qualifier, so every call — for every user, since the widget
  shipped — came back `400 incompatibleParameters` and no live chat was ever found. The
  request now sends `broadcastStatus` alone, which already scopes the list to the
  authorized channel. Confirmed against a running stream: the corrected query returns the
  broadcast and its `liveChatId`.

- **The failure was invisible, which is why it took a live stream to find.** Discovery
  acted only on a successful response and discarded everything else, so a malformed
  request, an expired token and a genuinely offline channel were indistinguishable — all
  three showed *"awaiting live stream"*. A non-OK response is now logged with its status
  and reason, and the chat id is cleared rather than left stale.

- **The control panel showed a blank name for a healthy YouTube link.** The channel title
  was read from the broadcast snippet, which does not carry one, so it was always
  `undefined`. It is now fetched from the channel itself, once per link.

## 0.47.1 — 2026-08-01

### Fixed

- **YouTube linking is now available in a distributed build, not just on the machine
  that built it.** The Google OAuth desktop client is baked into the source instead of
  being read only from the builder's environment. Every installed copy but the build
  machine's was showing *"YouTube linking isn't available on this build"*, because the
  client id and secret were supplied by env vars that exist on one PC. Neither value is
  confidential for an installed app — the flow is PKCE on a loopback redirect, so
  possession of them cannot yield anyone's token — which is what makes shipping them the
  correct fix rather than a shortcut. Env still takes precedence, so a fork can point at
  its own Cloud project without editing source. Twitch was never affected.

## 0.47.0 — 2026-08-01

### Added

- **Stream chat overlay — YouTube + Twitch, in one column.** A new **Chat** widget
  shows your live chat over the game, the widget triple-screen streamers can park on
  a side monitor's dead space. It is deliberately not driven by the telemetry frame:
  chat is bursty and ordered where telemetry is a latest-wins firehose, so it rides
  its own lightweight `/chat` WebSocket, and the server does every platform-specific
  thing (Twitch IRC tag parsing, emote ranges, YouTube polling) so the widget stays a
  thin renderer. Untrusted chat text is written with `textContent` and emotes load
  only from an allowlisted CDN, so a chat line can never become markup or an arbitrary
  request; the column is a fixed-size ring buffer, so a multi-hour stream can't leak
  memory.

  The two platforms are asymmetric on purpose. **Twitch** is read anonymously over
  IRC — just a channel name, no login. **YouTube** needs Google OAuth, handled
  entirely in the desktop app's main process (Overlays → *Streaming chat* → *Link
  YouTube*): the token never touches the browser, the active broadcast's live chat is
  found automatically, and the token is refreshed for the length of the stream. A
  standalone server can run the Twitch half from one env var, or supply a YouTube
  live-chat id and token directly.

## 0.46.0 — 2026-08-01

### Added

- **A lamp beside each tyre saying whether it is in its operating window.** Green in the
  window, cyan or amber on the way in or out, blue or red well outside. The window is not
  a number the overlay picked: LMU publishes its own optimal temperature per compound and
  per event, and that is what each corner is judged against — 92 °C for the GT3 medium
  this was built on, 50 °C for the wet, and whatever the next car says for the next car.
  The lamp is dark whenever the sim publishes no optimum, which is what happens when
  spectating or on rF2. That case is the point of the design rather than an oversight: a
  lamp lit green against an invented window would be confidently wrong for every compound
  whose real window sits somewhere else. Temperatures still show; only the verdict
  withholds. The lamp reads the core temperature — the number the in-game HUD shows — and
  shows in every view, because whether the tyre is working is not a function of which
  number you happen to have on screen.

- **A tyre map: the four tyres drawn as tread strips, blue through red.** A fifth entry in
  the tyre widget's cycle, after tread. Each tyre shows its temperature across the tread —
  inner shoulder, centre, outer shoulder — as a colour and a number, with the core
  temperature on the big line and the surface mean beside it. The ramp runs round the hue
  circle from blue to red rather than straight between them, so it passes through cyan,
  green and yellow instead of through purple, where two very different temperatures look
  alike. It is anchored on the sim's optimum where there is one, so the green middle of
  the scale lands on the temperature that actually is optimal for the compound fitted.

  The data was there all along. The shared-memory reader has been reading twelve
  temperature bands per car — three across the tread, for both the surface and the inner
  liner — and averaging each triplet into a single number before anything downstream could
  see it. The bands, the carcass core temperature, and the compound name are now carried
  through to the widget. The compound name is a small side effect worth noting: the tyre
  widget's header showed `—` on LMU until now, because nothing on that path had ever
  supplied one.

### Fixed

- **Tyre shoulder temperatures were mirrored on one side of the car.** The sim publishes
  three temperatures per wheel in a fixed direction across the car — its own tyre screen
  names them left, centre and right — so the first of the three is the *outer* shoulder on
  the left of the car and the *inner* shoulder on the right. They were being read as
  inner-to-outer on all four corners, which mirrored both tyres on one side: every number
  real, every one attributed to the wrong shoulder on half the car. A camber or pressure
  call read off them would have been backwards on two corners. The providers now flip the
  order per side, so `inner` always means the shoulder toward the car's centreline.
  Confirmed on track: all four corners now show the inner shoulder running hottest, which
  is what negative camber does, and the two sides agree instead of appearing to behave
  like different cars.

## 0.45.0 — 2026-07-31

### Added

- **The league leaderboard is live.** Every member's best clean lap, ranked, on the
  Leaderboard tab — filterable by **track**, **car class** and **car**, with your own row
  marked. This is the board the tab has been promising since v0.23.0; the laps have been
  uploading since v0.25.0, so there is already history on it.

  The filters are built from what the boards *actually hold*, not from a hardcoded track
  list: pick a track and you are offered only the classes with laps there, then only the
  cars driven in that class. Offering a dropdown of 31 circuits when three have times on
  them is the quickest way to make a working feature look broken.

  The **car** filter narrows a board; it does not split one. Boards stay keyed on
  (track, class), so your entry is your best in that class whichever car set it — splitting
  per car in a league this size would put one name on every board. Leaving it on *All cars*
  is the real board, and the sidebar says so.

- **Click any lap in Pace vs reference to load it.** The pace cards used to be pinned to
  your single best result, which made them a headline rather than a tool — the lap you want
  to examine is rarely your best one, it's the one that went wrong. Now the list is
  selectable and both cards follow it: the percentage, the band, the gap and the "0.83s
  from 102% pace" line all switch to the lap you picked. Click it again to go back to your
  best. The Dashboard stat tile deliberately does not follow — a stat that moved when you
  clicked a list further down the page would stop being a stat.

### Changed

- The Leaderboard's roadmap list lost **Best-lap database** and **League boards**. Both are
  built; the card above them is them. A roadmap that still promises what is already on the
  screen teaches people to stop reading it.

### Notes

- Two new read functions in Postgres, `leaderboard` and `leaderboard_filters`. They are
  `SECURITY INVOKER` — the rows were already readable under RLS (`driver_best_laps`,
  `public_drivers` and `tracks` each carry a select policy for signed-in users), so the
  functions buy one round trip instead of three and a client-side join, not extra access.
  Running them as `DEFINER` would have granted a privilege the work doesn't use, and would
  have kept returning rows if a policy were ever tightened.

- The board needs an account and a connection — it is the one part of the lap database that
  is inherently about other people. Signed out, it says so; laps keep recording either way.

## 0.44.1 — 2026-07-31

### Fixed

- **The margin at the flag is no longer computed in sessions that have no flag.** In
  practice the widget read `MARGIN −199.9 %` in the colour it reserves for a real
  emergency, on a car with a dozen good laps in the tank. It was doing the arithmetic
  honestly: two and three quarter hours of practice at ninety seconds a lap is 109 laps,
  109 laps is 240 L, and the tank had 26. But nobody drives a practice session to zero on
  one tank, so the finish it was measuring against did not exist. Practice, qualifying,
  warmup and test day now leave laps-to-the-flag, fuel-to-finish, the margin and
  refuel-to-finish blank; a race projects them exactly as before. What is actually in the
  car — burn rate, laps of range, both gauges and the pit alarm — is unchanged, because
  those are true in any session.

- **Laps in and out of the pits no longer count towards the burn rate.** An out-lap starts
  from a standstill in the box and rejoins part way round; an in-lap ends at the limiter.
  Either can be half a green lap's consumption, and both were being averaged in, which is
  where a half-lap disagreement with the car's own NRG readout came from — measured live
  against LMU's dash on the same frame, and against the sim's own per-lap consumption log,
  which flags exactly these laps. The rolling average now skips them, on both budgets and
  on both providers. A *requested* stop is deliberately not counted: a driver asks for the
  box laps before they take it, and those are green laps — the last ones before the stop,
  which are the ones the average most needs.

## 0.44.0 — 2026-07-31

### Added

- **Reference pace — how quick you actually are, without needing anyone else on track.**
  Your best lap is compared to the pace an alien runs in the *same class* at the *same
  track layout*, and the percentage lands on a named band: Alien (≤100%), Competitive
  (101%), Good (≤103%), Midpack (≤105%), Tail-ender (≤106%), Offline beyond. 100% is alien
  *race* pace, not a qualifying lap, and 107% is the traditional cutoff.

  A percentage means something a lap time cannot: 101% at Spa and 101% at Fuji are the same
  achievement, while 2:21 and 1:30 are not comparable at all. It is the first number in the
  app that answers "am I quick?" rather than "was that lap better than my last one".

  Three surfaces, one calculation (`src/telemetry/referencePace.ts`):

  - a **Reference Pace** overlay widget — the percentage, the band, a ladder with your
    marker on it, and your lap beside the reference lap;
  - the Dashboard's fourth stat tile, now **Pace rank**, showing the band;
  - the **Leaderboard** tab, which scores your best clean lap at every track and class you
    have driven, with the design system's RankBar above it.

- **The reference times are [Ohne Speed](https://www.youtube.com/@ohne_speed)'s**, from the
  LMU laptimes spreadsheet, with lap times contributed by **beAlien**, **Go** and **Hymo**.
  The Alien → Offline band names are theirs too. The app only reads their work, and credits
  it wherever a score is shown — the attribution travels on the same payload as the numbers,
  so no screen can render a score without it. `npm run reference-times` refreshes the table
  after an LMU patch; it is baked at build time rather than fetched, so scores survive a
  race weekend with no connection.

### Changed

- **The Leaderboard tab has lost its padlock.** It has real content now. The league's own
  boards are still to come and the page says so, but a lock on a tab that scores every lap
  you have driven was advertising the wrong thing.

- Demo mode runs Silverstone pace at Silverstone. `BASE_LAP_SEC` was a round 118 while the
  demo claimed to be at a circuit whose Hypercar reference is 1:42.9 — 15% out, invisible
  until something started comparing the two and put the entire synthetic field in the
  Offline band. The class offsets are now the real class-to-class gaps there as well, which
  widens the Hypercar→GT3 spread from a hand-picked 11 s to the true 15.6 s.

### Notes

- **Some laps deliberately come back unscored, and the app says why.** LMU's feed names the
  venue and never the layout — and Monza's two layouts are ~10 s apart in GT3, Le Mans's
  ~16 s. Where the layout cannot be established from the sim's own scene name, a published
  config or the lap length, no score is shown and the reason is: *"Circuit de la Sarthe has
  2 layouts with reference times and the sim did not say which one this is."* A wrong score
  in a fixed direction is worse than no score, because a driver told they are 9% off when
  they are on the pace stops reading the number.

  GT4 is unrated — the reference data does not cover it. LMP2 is split into ELMS and WEC
  regulations (3.6 s apart at Bahrain); the car model picks the right one, and where it
  cannot, the fallback is marked with a `?` rather than passed off as certain.

- New: `LmuScoringReader.readTrackName()` reads `rF2ScoringInfo.mTrackName`, the only
  channel in the whole feed that names the loaded *layout*. Lap records gained
  `trackConfig` and `simTrackName` (schema v2, both optional) so a lap can still be scored
  months after the session that set it.

- New test: `npm run test:refpace` (58 assertions), weighted towards the ways a lap gets
  attached to the wrong reference rather than towards the arithmetic.

## 0.43.0 — 2026-07-31

### Added

- **How much of the session is left now sits across the top of the fuel widget as well as
  the standings tower**, and says both halves of it: `LAP 12/40 · 29 LAPS LEFT`. The
  counter is where the race is; the laps left are what has to be fuelled and tyred for,
  and asking a driver to subtract those mid-corner is asking for the wrong answer.

  It matters most on the fuel panel, which had no session context at all. Every figure on
  it is measured against the race length — laps left in the tank only means something
  beside laps left in the race, and "−13.4 L margin" is a margin *to the finish* — so the
  panel was answering a question it never stated. It states it now, directly above the two
  gauges: 29 laps of race, 23.9 laps of fuel, 17.5 of energy.

  Laps left includes the lap being run (lap 12 of 40 leaves 29, not 28). That is the same
  count the fuel calculator finishes the race on, so the strip and the litres under it are
  answers to the same question rather than two that differ by a lap.

- **Practice and qualifying are named instead of counted.** They have a clock but no lap
  total, so `LAP 5` there was a personal tally shown where a position in the session
  belongs — five of nothing. Both panels now read `PRACTICE · 28:14`, the session and what
  is left of it, which is the thing being decided in a session with no finish to reach.
  A lap-limited qualifying session — unusual, entirely legal — still counts laps: the lap
  limit decides this, not the session's name.

### Changed

- The session strip is now one shared component rather than one panel's private markup, so
  the tower and the fuel panel cannot state a different number of laps to go. They are read
  as a pair and the whole strategy call is the subtraction between them; two hand-rolled
  copies that could drift by one lap would make that subtraction worthless. New in
  `scripts/test-session-headline.js` (`npm run test:session-headline`), which pins the
  practice/qualifying rule and the off-by-one, both of which are easy to undo by accident.

## 0.42.0 — 2026-07-30

### Added

- **Each of the fuel and energy bars now says how many laps it is worth.** `62.0 L · 23.9 laps`
  and `83.9 % · 17.5 laps`, on the bar itself, in both widgets. Litres and percent are not
  what anyone plans a race in — laps are — and neither figure converts to laps without
  the burn rate that was sitting two lines further down.

  The figure is per budget rather than shared, because the two do not run out on the
  same lap: the pair above is a car with six more laps of fuel than energy in it, which
  is the entire strategy call, and a single laps-left cell underneath could only ever
  have been right about one of them. It is the same pairing the car's own dash makes
  (`83.0L (37.6 laps)`), kept for each resource separately.

  Blank rather than a dash while the burn rate is still unknown — for the first lap or
  two of a stint there genuinely is no answer. The whole-lap bloom moved here from the
  quantity beside it: losing a whole lap of range is the event worth looking up for,
  and a bloom on every whole litre fired twice as often to say half as much.

### Fixed

- **The pit alarm could fire on lap one of a race with twenty laps of fuel in the car.**
  Not the alarm's arithmetic — the burn rate underneath it. Laps-of-range is level
  divided by burn, so an overstated burn understates the range in exact proportion, and
  the calculator was accepting level changes that were never driven at all.

  Three ways in, all landing on the **first** sample of a stint — the one that defines
  the average every later sample is judged against, and so the one the existing outlier
  test could not help with:

  - A **new session reloads every car's tank from its setup.** Sit out a practice on a
    full tank and start the race on the planner's 50.9 L and no lap ever runs backwards
    to announce the change, so the first race lap was "measured" as 83 L minus 48.7 L —
    a 34 L lap, fifteen times the real one. Measured against a real run: 12.9 L/lap
    recorded where the car burned 2.2, and the alarm arriving on lap one.
  - **Fuel edited in the garage**, or an energy allocation re-cut by a fuel-ratio
    change, is a level rewritten part way through a lap.
  - **Attaching part way round a lap** made the piece that was watched count as a whole
    one — the same error inverted, and the more dangerous of the two, since an alarm
    that reads three laps of fuel as nine simply never fires.

  Level changes consumption cannot explain are now spotted sample to sample, and the lap
  they land in is discarded rather than measured; no sample may exceed a quarter of the
  whole budget (nothing in this game does four laps on a tank); and the fuel and energy
  histories are dropped outright when the session changes, or when the broadcast focus
  moves to a different car — a burn rate carried from one car to another is a
  laps-remaining figure invented out of two.

## 0.41.0 — 2026-07-30

### Added

- **Fuel and virtual energy are now both on screen at all times, in litres and percent.**
  Neither widget previously showed how much fuel was actually in the car alongside the
  energy budget. They are two separate resources: they drain at different rates over a
  stint, run dry on different laps, and are topped up from different rows of the pit
  menu, so neither figure can be worked out from the other — which is exactly the
  calculation a driver was being left to do.

  The **fuel widget** gains a pair of permanent gauges above everything else — `FUEL`
  in litres with the tank fraction as its bar, `ENERGY` in percent with its own. They
  are written every frame and take no part in the 20-second FUEL/ENERGY rotation
  below them, so "how much is in the car" no longer disappears for twenty seconds at
  a time. The panel header carries both at once (`59.5 L · 82%`) instead of swapping
  with the view.

  The **fuel planner**'s live section becomes two permanent rows rather than one that
  switched between them. The budget that will actually end the stint keeps the Tier 1
  size and the other steps down a tier — still readable, since it is still a resource
  being managed, just not the one being driven to.

  On a car with no energy budget the energy bar is hidden rather than drawn empty: an
  empty bar reads as "energy exhausted", not "this car has none". The two bars are
  coloured apart — fuel keeps the house gradient, energy is flat cyan — so a glance
  cannot mistake them for one quantity split in half.

### Fixed

- **A tank that had not been read yet could render as `-1.0 L`.** The new gauges screen
  the fuel level through the provider's `UNKNOWN_VALUE` sentinel rather than a plain
  finite-number check, which would have shown the sentinel itself. A genuinely dry tank
  is still a real reading and still shows `0.0 L`.

## 0.40.3 — 2026-07-30

### Added

- **`+?` — a cut the stewards have not ruled on yet.** The header reads `4.75+? / 5`
  when an excursion has happened that the sim has not yet reported: at least 4.75,
  with more to come. A bare `4.75` would quietly claim the stewards had finished.

  This exists because the delay is now understood and cannot be fixed from outside the
  game. **LMU flushes its log one 4 KB block at a time** — measured, every append
  landing on the boundary (`+4141`, `+4134`, `+4128`, `+8264` for two at once) with
  gaps from 0.1 s to 26 s. So a charge arrives whenever unrelated log output happens to
  complete the block, which is why a lap crossing appeared to "trigger" the update one
  evening and a second cut did it the next. Nothing external can force it: 175 REST
  calls to the game wrote zero bytes, and polling faster cannot help because the bytes
  are still inside the game's process.

  The marker is **positive evidence only**. Our own geometry applies a margin and the
  sim charges on time gained, so a shallow cut that still scores can pass us by:
  present means "more is coming", absent does not promise the total is final.

### Fixed

- **Practice and qualifying no longer count down to a penalty that cannot come.**
  `/rest/sessions` reports `cuts_allowed` for every session type, but only a race
  spends it on a drive-through — practice invalidates the lap and lets the total run
  past the allowance. Observed live at 9.5 against an allowance of 5, with the game's
  own HUD showing the limit as infinity, and corroborated by the 727
  `Invalid Lap Cut Track` rulings in one evening's results files. Outside a race the
  pip row is hidden and the header reads `9.5 PTS` rather than `9.5 / 5`. An explicit
  `?limits=` override still wins.

- **The reader could latch onto a copy of a finished session.** The game keeps a plain
  `trace.txt` beside the dated logs: an exit-time copy of the session that just ended,
  byte-identical and carrying the same mtime — so the tie could win a
  newest-by-mtime comparison and leave the reader tailing a static file. Only
  `trace_<launch>.txt` is considered now.

## 0.40.2 — 2026-07-30

### Fixed

- **The points total read zero for the first ~2.7 hours of every session.** The game
  right-aligns the timestamp into a fixed-width column, so the same line arrives
  padded or not depending only on how long the game has been running:

  ```
  " 114.51s score.cpp   626: Track Limits: WarnPts: 0.25 …"   <- fresh launch, PADDED
  "16313.48s score.cpp   626: Track Limits: WarnPts: 0.50 …"  <- five hours in
  ```

  The parser anchored the timestamp at the start of the line, so it matched only once
  the seconds field grew to five digits — about 2.7 hours of uptime. Reported from a
  freshly launched race where nothing was recorded at all.

  Every fixture in the test suite had been copied from a five-hour-old session, which
  is exactly why 59 assertions passed over a reader that did not work in a new
  session. The suite now carries the padded forms of the same lines.

- **Restarting the *game* mid-stint lost the total the same way a restarting overlay
  used to.** A new trace file was picked up correctly, but the reader seeked to its end
  and started from zero — so any cuts taken before the rescan noticed the new file were
  silently forgiven. Rotation now recovers the session's total exactly as startup does,
  and clears the previous game's figures before it reads, so nothing can leak across
  either.

## 0.40.1 — 2026-07-30

### Fixed

- **Restarting the overlay mid-session reset the points total to zero.** The trace
  reader starts at the *end* of the log so that an old session's cuts are never
  credited to the current one — right for old sessions, wrong for the one in
  progress. Restart four cuts into a race and the driver was shown `0` while the
  stewards had them on 4.75, which is the one direction this number must never be
  wrong in: flattering the driver is what sends them back out to collect a penalty
  they did not know they were one cut away from.

  It now replays from the sim's own `SessionName` marker, and only from the **last**
  one in the file — anything earlier belongs to practice, or to a race that has since
  been restarted. With no marker in the window nothing is replayed and the total
  starts at zero, because lines that cannot be attributed to this session are worse
  than no lines at all. Verified against a live race: recovered 4.75 points from 9
  cuts, matching what the widget had been showing before the restart.

### Known limitation

- **A charge can take up to ~25 seconds to appear.** Measured, not estimated: LMU does
  not flush its trace per line, it writes in bursts, and one burst was observed
  carrying 27 seconds of game time in a single write —

  ```
  12:00:26   Off Track WP: 450     lag  1.2s
  ---        26 seconds of nothing
  12:00:52   626: WarnPts 0.00     lag 24.5s   <- held in the buffer this long
  12:00:52   No Track Cut          lag -2.1s   <- caught up
  ```

  So the driver's next off-track appears to "trigger" the previous charge, when what
  it actually does is generate the log volume that flushes the buffer holding it. The
  figures are correct when they land; nothing outside the game can force the flush,
  and polling faster does not help because the bytes are not on disk yet.

## 0.40.0 — 2026-07-29

### Added

- **The points total is now the sim's, not ours.** The Track Limits widget counted
  excursions from geometry and compared them against a hard-coded limit of 10. LMU's
  real allowance is a per-session setting, and its charges are nothing like an
  excursion count — so the number a driver was watching was wrong twice over. Both
  halves are now read from the sim, and the widget marks which is which: a leading
  `~` in the header means the figure is our estimate, and its absence means it is the
  stewards'.

  **The threshold comes from `/rest/sessions`**, which publishes the session's own
  setup:

  ```
  SESSSET_cuts_allowed = { currentValue: 5,  numStepsTotal: 63 }
  SESSSET_cut_rules    = { currentValue: 1,  stringValue: "Default" }
  ```

  `cuts_allowed` is **points, not cuts** — confirmed by driving it: one deep cut
  charged 1.00 and left four to go. `cut_rules` is deliberately not acted on. It has
  three states and only `"Default"` has been observed, so whether either of the others
  is a show-but-never-penalise mode is unknown, and promising immunity that is not
  there is worse than saying nothing.

  **The charges come from the trace log**, which is the only live source for them
  anywhere. Everything else was ruled out first, live, in a race session: `Extended`,
  `PitInfo` and `Rules` are all mapped and contain **zero printable strings**, so LMU
  never writes rF2's message fields at all; every REST message, incident and
  race-control endpoint 404s; and the standings row's 46 fields carry the penalty
  *count* and nothing else. The results XML holds exactly the right data and is written
  in a single burst when the session **ends**, which is too late to drive by.

  `score.cpp` writes a verdict line and a scoring breakdown for every excursion:

  ```
  4822: Track Limits: Back On Track; Lap: 1 LapDist: 3029.19
   626: Track Limits: WarnPts: 1.00 Pts: 0.84 TimeSkipped: 0.33 … MaxOffTrack: 12.91
  4083: Track Limits: Warning; Lap: 1 LapDist: 3183.09
  ```

  Three things about that took establishing, and each was a bug first. **The charge is
  driven by time gained, not by how far off the road the car went** — `Pts` goes
  negative when the driver *lost* time, which is charged as zero, so a 0.93 m excursion
  at 183 kph cost nothing while a 9.92 m cut that gained 0.33 s cost 1.00. **Every
  excursion is evaluated twice and only the second counts**: a provisional figure the
  instant the car rejoins, then the settled `Warning` or `No Track Cut` — the
  provisional ones read 3.75 where the settled verdict charged 0.25, and counting them
  put one session at 22 points against an allowance of 5. **The discharge is named
  `"Track Limits"`**, not "Drive Through", so the obvious pattern never fires; pit-lane
  speeding must not discharge it either, so the match is on wording rather than on a
  penalty appearing. Totals are per session and reset on `steward.cpp SessionName`,
  which covers a race restart.

  Validated against the sim's own arithmetic rather than by inspection. Replaying one
  race's trace reproduces its thirteen charges, in order, summing to exactly the
  **5.00** that earned the drive-through — the same sequence as that session's XML
  `WarningPoints`, whose `CurrentPoints` climbs to 4.75 and resets at 5.00, with the
  two events aligning in time (XML `et=382.4` ↔ trace `16313.45s`).

  Not included: **lap invalidation**. The XML reports it and the trace has no
  equivalent line, so nothing claims it live. `scripts/probe-lmu-penalty.js` now logs
  `countLapFlag`, the likeliest candidate, so a single cut will settle it.

- **`scripts/test-tracelimits.js`** — 54 assertions on lines copied verbatim out of a
  live trace, now part of `npm run test`. Two are regressions for bugs the real file
  found and hand-written fixtures never would have: JavaScript's `.` does not match
  `\r`, so the CRLF log defeated the `$` anchor and *every* genuine line parsed as
  `null`; and searching for `Pts` matches inside `WarnPts`, silently returning the
  charge where the raw score was asked for.

- **`scripts/probe-lmu-penalty.js` keeps what it finds.** It printed to a terminal that
  gets closed, scrolled past, or killed with the sim — taking the one event it was left
  running for hours to catch with it. Changes now append to
  `~/.apex-overlay/penalty-probe.jsonl` as raw records, and it samples the lateral
  geometry at 4 Hz (an excursion is over in a second; at 1 Hz a fast one is a single
  reading or none), excludes the pit lane, and records the minimum speed through each
  excursion so a spin or a crawl back onto the road is separable from a cut taken at
  racing speed.

## 0.39.0 — 2026-07-29

### Added

- **The tyre grid names the reading it is showing.** It cycles between core
  temperature, surface temperature and remaining tread, and all three are
  two-or-three-digit numbers — so with the view bound to a wheel button, where
  you cannot see what you pressed, there was no way to tell which one was on
  screen. A label now sits above the grid: `CORE TEMP`, `SURFACE TEMP`,
  `TREAD LEFT`. Tread gets the accent colour, being the odd one out among the
  temperatures and the fastest way to see the cycle has wrapped.

  The label names what actually reached the big line, not what was asked for:
  `auto` resolves to one of the three, and an explicit pick falls back when its
  channel is missing, so naming the request would sometimes name something that
  is not on screen. `auto` says so as well, so a deliberate pick is
  distinguishable from the default.

- **Track condition in the weather widget.** The surface in words — `DRY`,
  `DAMP`, `WET`, `VERY WET`, `SATURATED` — with a `▲`/`▼` for whether it is
  getting wetter or drying. A percentage answers "how wet" and not "what does
  that mean for me": the tyre call changes at DAMP→WET, not at 41%. The
  percentage stays alongside it, and the change glow now fires on crossing a
  band rather than on the number, which had been creeping all lap.

  The trend is measured over three minutes rather than between polls. Wetness
  moves slowly and the feed jitters, so differencing consecutive samples reports
  a track flickering between drying and wetting all session.

  **The grip/rubbering-in level is not included, because it is not published.**
  No REST endpoint carries it and the shared-memory buffers that might
  (`Extended`, `PitInfo`) read empty. `scripts/probe-lmu-penalty.js` watches both
  and will show it the moment it appears; until then this readout covers the
  wetness half of what the in-game MFD shows and claims nothing about the rest.

### Fixed

- **The relative strip's CURRENT lap time ran seconds short.** It was REST
  `timeIntoLap`, which is the *position-derived estimate* already known to be
  useless for the delta: it reports the same value at a given distance whatever
  the lap is actually taking, so any lap slower than the pace it assumes reads
  short — by exactly the amount you were losing.

  It now uses the delta engine's own clock, a real elapsed time measured from
  the interpolated start/finish crossing, so the current lap and the delta beside
  it can never disagree. `timeIntoLap` remains the fallback until the engine has
  seen a crossing, because before that an estimate beats nothing.

- **The pit alarm stayed up after the stop that answered it.** Two separate
  faults, and between them they kept it on through the refuel, out of the pit
  lane and round the next lap.

  **The alarm could not be switched off.** Fuel and virtual energy each run their
  own calculator and each publishes its own `pitThisLap` inside the block it
  returns. Those two blocks were merged and a decision spread over the top —
  which cannot clear anything, because "no alarm" is an *absent* key and an
  absent key does not overwrite a present one. So the in-pit suppression that was
  supposed to silence it in the lane silently did nothing, and an energy-driven
  alarm reached the widgets with **no reason attached** — rendering with the
  default wording and telling a driver who was low on virtual energy to pit for
  *fuel*, over and over, right through the stop that fixed neither. The decision
  is now a single pure function that is the only thing allowed to set the flag,
  and it clears the field before applying its answer.

  **Fuel going in was measured against the wrong moment.** The stand-down
  compared the level against where the *lap* started, which is up to a full lap
  stale by the time a driver reaches their box: take on two laps' worth after a
  lap that burned three and the level is still below where the lap began, so the
  alarm never stood down. It now watches for the level *rising* between
  consecutive samples — burning fuel only ever takes it down, so any rise is the
  rig putting some in, and that is true the instant the hose goes on.

  Found from live telemetry mid-stop: `veFraction 0.09` with `fuelFraction 0` and
  `pitting: true` — the tank was fine, the energy was not, and the alarm was
  saying "FOR FUEL". Seven new checks in `npm run test:fuel` (25 there now)
  cover both: a partial splash smaller than the lap's burn still clears it,
  ordinary consumption never does, and an energy-only call names ENERGY.

## 0.38.0 — 2026-07-29

### Added

- **The penalty now says which penalty it is.** With the in-game HUD off, a
  penalty was a bare "1 PENALTY" — the count, never the kind — and a
  drive-through and a stop/go are not served the same way. The Track Limits chip
  and the MFD's RACE CONTROL row now read **STOP/GO** (or `2× STOP/GO`) when the
  sim has named one.

  Where the kind actually lives took finding. LMU publishes the *count* in three
  places and the *kind* in none of them; what it does do is **insert a row into
  the pit menu for the penalty it wants served, named after it**. Confirmed live,
  in both directions, which is what makes it trustworthy rather than a
  coincidence:

  ```
  penalties = 1  →  menu carries  PMC 1  "STOP/GO:" = "Yes(0Laps)"
  penalties = 0  →  that row is absent from the menu entirely
  ```

  The menu is already on the wire every 500 ms for the MFD widget, so this costs
  a lookup and nothing else. The row's *presence* is the signal — its value is a
  choice about this stop, not a statement that the penalty has gone.

  **An unrecognised row produces no claim at all.** Only the stop/go wording has
  been observed; a drive-through has not, so the match list carries the plausible
  spellings and anything outside them falls back to the bare count. Told
  "STOP/GO" a driver stops in their box, and doing that to discharge a
  drive-through does not serve it — it turns twenty seconds into a lap. Being
  unhelpful is recoverable; being confidently wrong here is not.

- **"PENALTY SERVED" — confirmation that it counted.** Green and steady on the
  Track Limits banner for eight seconds, and on the MFD row, when the sim's
  outstanding count *decreases*.

  That decrease is the only confirmation anywhere in the feed: nothing says "that
  drive-through counted". Without it a driver leaves the pit lane not knowing
  whether it took, which is exactly when they go round again to be safe and pay
  for the penalty twice. It outranks a freshly-issued penalty on the banner —
  if both fired, the discharge is the newer event and the one being asked about
  — and it is deliberately *not* red or pulsing: the driver is rejoining
  traffic, and this only has to answer "did that count?".

- **`scripts/probe-lmu-penalty.js`** — watches the penalty count, the pit menu,
  and the `Extended` / `PitInfo` shared-memory buffers, printing a line whenever
  anything penalty-shaped changes. Run it and drive; the next penalty of either
  kind is captured exactly as the sim words it, so the drive-through row can be
  pinned the same way the stop/go was rather than guessed at.

## 0.37.0 — 2026-07-29

### Added

- **The pit call now makes a sound.** A short beep, played as a **triplet**, on
  the same trigger as the flashing bar. The supplied clip is 130 ms on its own,
  which is under the length at which a sound registers as a deliberate signal
  rather than as something that might have been the car; three in quick
  succession is unmistakably a pattern, and the pattern is what makes it
  identifiable as *this* alarm and not the track-limits blip.

  It repeats roughly four or five times over the lap it is up for. Often enough
  that it cannot be missed while the driver is busy, rarely enough that it stays
  an alarm instead of becoming background noise to be tuned out. The widgets
  simply ask for the cue on every frame the alarm holds; the audio layer's
  per-cue rate limit owns how often that is actually heard.

  The cue fires from the shared alarm bar rather than from the widgets, for the
  same reason the bar itself is shared: an alarm the driver can hear but not see
  — or see but not hear — is one they have to stop and reconcile.

### Changed

- **`audio.js` can play samples, not only synthesised tones.** This is the first
  cue with a file behind it, and it is meant to stay close to the last: the
  module's rationale for synthesising everything (no decode, no buffer, no file
  to 404, no network) still holds for routine cues, and is now written down as
  such rather than as an absolute. The fuel call earns the exception because it
  is the only alarm that demands the driver change their race within the lap,
  and it has to be identifiable as itself in the half second before they think
  about it — more than a sine tone can carry. It costs 4 KB, fetched and decoded
  once per source.

  Every sampled cue carries a synthesised `fallback`, played if the file 404s or
  the host refuses to decode it. An alarm that is silent because an asset did not
  load would be the worst possible bug in that file.

- Static server now serves `.mp3`, `.ogg` and `.wav`.

## 0.36.0 — 2026-07-29

### Added

- **"PIT THIS LAP FOR FUEL" — a flashing alarm on both fuel widgets.** Solid
  red, full width, pinned above everything else in the fuel calculator *and* the
  fuel planner. It is deliberately outside the overlay's glance hierarchy: every
  other readout competes for attention politely, in a tier that says how much it
  is worth, and this one is not competing.

  What it means is narrow on purpose. Not "you are getting low" — that is what
  the margin and laps-left are for. It fires when, from where the car is on the
  road right now, there is not enough left to finish this lap and complete
  another one **even driving the rest of it as economically as anyone
  realistically can**. It is the point where saving has stopped being an option
  and the only remaining choice is which lap you come in on.

  Fuel and virtual energy are both checked, and the alarm names which one ran
  out — "FOR FUEL" and "FOR ENERGY" send the driver to different rows of the pit
  menu. Energy wins a tie, being nearly always the tighter of the two in these
  cars. It never fires on the final lap of a race, where pitting would throw
  away the finish the alarm exists to protect, and it stands down the moment
  fuel actually goes in.

  **The timing is the hard part, and the obvious implementation gets it wrong.**
  Re-asking the question every frame — fuel left against road still to cover —
  fails in exactly the case that matters. Both sides of that comparison fall as
  the lap runs: the tank drains at the real burn rate, the requirement shrinks at
  the *saving* rate, so the margin between them erodes by only the difference, a
  tenth of a lap's fuel over a whole lap. A car that begins the lap a hair inside
  the limit therefore trips it a hair before the line — the alarm arrives at the
  pit entry it was meant to warn about. So the call is taken **once, as the line
  is crossed**, which makes it stable for the whole lap and delivers it with a
  whole lap in hand. A continuous net still runs underneath for the case the line
  decision cannot see: not enough left to reach the line at all.

  Covered by `npm run test:fuel` (15 checks), including the regression guard for
  the timing — on the boundary lap the alarm must stay clear on the lap the car
  can still make, and appear within the first tenth of the next one.

- **Demo mode can show it.** The simulator raises the same call as its tank runs
  down. It is the loudest thing the overlay ever does and nobody should first
  meet it in a race.

## 0.35.0 — 2026-07-29

### Added

- **The delta bar now shows the lap it is projecting.** `PROJ` under the bar is
  `sessionBest + delta` — the same projected-lap number LMU's own dashboards
  carry. The delta says how the lap is going; this says what it adds up to,
  which is the one you want when you are chasing a target time. It is Tier 2,
  well under the delta itself, and takes the delta's colour so a glance says
  better-or-worse without reading the digits. Two decimals, not the standings'
  three: it is recomputed every frame off a live delta, so the thousandths never
  sit still and showing them makes a steady projection look like it is churning.

  The engine already computed this — it just had nowhere to go while
  spectating. The REST delta engine now returns its whole pace block rather than
  a bare number, so the projected lap (and the pace widget's session and last
  columns) work for the focused car whoever is driving it. The all-time column
  stays empty for a spectated car by design: a rival's cross-session PB is not
  ours to keep.

- **Chevrons in the delta bar, marching the way the lap is going** — rightward
  as you gain, leftward as you lose, and faster the bigger the delta. Peripheral
  vision reads motion long before it reads digits, which is the point of a bar
  you glance at mid-corner rather than study.

  They take the half-track on the delta's side and sit *above* the fill, not
  inside it: inside, they spend most of their life behind the value, because the
  fill grows outward from the same centre the number occupies. A mask fades them
  out towards the middle so nothing crowds the number, and one `scaleX(-1)` for
  the losing state points them the other way, reverses their travel and mirrors
  the fade in a single property. Drawn as a tiled background rather than DOM
  nodes, so it is one compositor-level animation with no per-frame layout, and
  it costs the same at any bar width. Honours `prefers-reduced-motion`.

- **Demo mode has a pace block.** The simulator emits `paceDeltas` derived from
  its own wandering delta. Demo mode is how the overlay is set up, and how it
  looks whenever LMU is unreachable, so a permanently blank projected lap there
  would read as broken rather than as waiting.

## 0.34.0 — 2026-07-29

### Fixed

- **The delta bar now holds still.** It swayed and twitched instead of settling,
  which made it useless for the one thing it exists for — telling you whether
  the corner you just took was worth anything. The delta is `t − t_ref(d)`, so
  an error of a few metres in *where the car is* lands on screen as tenths of a
  second, and the position axis was carrying three separate errors of exactly
  that size:

  - REST snapshots are published on the game's own clock and arrive over HTTP,
    so each one is already 5–85 ms old when it lands, by an amount that varies
    packet to packet. Extrapolating by the snapshot's measured age (arrival →
    now) cannot recover the part that elapsed before arrival.
  - Because that leftover staleness scales with speed, it was not a constant
    offset cancelling between the live lap and the reference lap. It was a bias
    that changed shape around the lap — measured at −0.07 s mean, drifting
    through the corners, on a lap driven identically to its own reference.
  - Every REST arrival landed as a step, so the readout twitched at the poll
    rate. On top of that, a torn shared-memory read froze the delta's *time*
    axis for a frame while the position axis kept moving, dropping the readout
    at a full second per second until the clock caught up: ±0.09 s of jump on
    its own.

  The position axis is now a complementary filter. Fast motion is integrated
  from the car's own speed — shared memory, same buffer and same instant as the
  delta clock, no network in between — and the REST position is used only to
  correct slow drift, pulled in over a second, which low-passes its noise away.
  Because the prediction uses live speed there is no lag to pay for that long
  time constant, and what lag remains is identical on the live lap and the
  reference lap, so it cancels in the subtraction instead of showing as sway.
  The engine also holds its last answer when the sim clock does not advance.

  Under a rig that models the real feed (braking zones, jittering snapshot
  latency, 5 % torn reads) driving a lap identical to its own reference, where
  the correct readout is a flat 0.00: error spread **0.150 s → 0.045 s**, bias
  **−0.069 s → −0.003 s**, worst frame-to-frame jump **0.084 s → 0.002 s**.
  Committed as regression checks in `npm run test:delta`.

- **Spectated cars now have a delta at all.** Chasing the sway into the
  spectated path turned up something worse than sway: that bar was reading
  `timeIntoLap − refTimeAt(d)`, and REST **`timeIntoLap` is derived from
  position** — at a given distance it returns the same value on a fast lap and a
  slow one. The subtraction cancelled by construction, so the readout sat at
  0.00 whatever the car did. Perfectly steady, and saying nothing. (This was
  written down as a known dead end when the driven car's delta was rebuilt in
  0.6.5, and has been the spectated behaviour ever since.)

  Spectated cars now run the same engine as the driven car, per car: a real
  clock — the sim's `mElapsedTime` when this PC has a car in the session, wall
  time on a spectator or broadcast box — with lap boundaries from the distance
  fraction wrapping past the line, and the same road-position observer on the
  distance axis. On the rig above, a spectated car driving a lap identical to
  its own reference holds to a **0.035 s** spread, and a lap 0.32 s slower now
  reads **+0.34** where it used to read 0.00.

  Two knock-on changes. **Every car in the feed is tracked on every frame**, not
  just whichever one has the camera — a director cuts constantly, and a car
  whose laps were only recorded while it was on screen has nothing to compare
  against the moment it cuts back. Only the focused car's deltas are computed,
  so this costs a lap-boundary check per car, not six interpolations. And a car
  that vanishes for a while (garage, feed dropout) now **re-anchors** rather
  than carrying a lap start from ten minutes ago that would put every delta past
  the sanity limit until it next crossed the line.

  One deliberate loss: the old tracker would arm off a **partial** trace, giving
  a delta over whatever slice of the track it had seen. Times measured against a
  start line the car was never observed crossing can't be trusted now that we
  measure the lap ourselves, so a full lap from the line is required. In
  practice availability improves, because cars are no longer only recorded while
  on camera.

## 0.33.0 — 2026-07-28

### Changed

- **The binder can now cover a bare rig completely — 15 proven keys against 13
  functions.** It shipped with six, three of them assumed rather than tested,
  which meant a driver with nothing bound got Pit Request and five aids and a
  list of "no spare key left" for the rest. Every key in the pool has now been
  bound to a real LMU function, pressed into the running game with `SendInput`,
  and watched moving the car's own value in shared memory. Nothing in it is
  inferred.

- **F16–F24 are excluded, despite working perfectly.** They were the obvious
  candidates — DirectInput's names stop at F15, so `0x67`–`0x6F` look like
  unclaimed space, and all ten drove the game on the first try. Then Windows was
  asked what they actually are: `MapVirtualKey` maps them straight onto the F16+
  virtual keys. F13–F24 is precisely what a **Stream Deck** emits for "a key no
  game uses", so binding them would have put the overlay on a collision course
  with the one peripheral most of this audience owns. They worked *because* they
  are ordinary function keys, which is exactly the disqualification.

  The pool is instead built from scancodes Windows maps to **no virtual key at
  all**, or to unassigned OEM slots — 21 of them exist, 15 are now proven, and
  the remaining six are noted in the source for when they are needed. A test
  asserts the pool can never drift back into the F-key range.

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
