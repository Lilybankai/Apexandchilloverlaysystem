# Race-control signals: findings + plan (probed live 2026-08-04, Daytona AI races)

Two instrumented AI races (rolling starts, 25 cars) with deliberate track cuts, a
pit-lane speeding penalty, a served stop/go and a car parked on track. Raw
captures: `~/.apex-overlay/race-probe-2026-08-04T19-54-48.jsonl` (+ the 19-53-24
file for the first two minutes), `race-probe-telemetry-2026-08-04T19-54-48.bin`
(player telemetry record @5 Hz), `penalty-probe.jsonl`. Recorder:
`scripts/probe-race-start.js`.

## What each signal is and where it lives (all VERIFIED live unless marked)

### Session phase / green flag
- `GET /rest/sessions/GetGameState` → `gamePhase` **string**: saw
  `GPHASE_BEFORE`, `GPHASE_FORMATION`, `GPHASE_GREEN`. Clean transition
  FORMATION→GREEN at the flag.
- `GET /rest/watch/sessionInfo` → `gamePhase` **numeric**: 0 (pre), 3
  (formation), 5 (green), 9 (paused/monitor/garage). 4 (standing-start
  countdown) UNSEEN — both races were Fast Rolling, which jumps 3→5.
- Per-car `gamePhase`/`flag` strings in `/rest/watch/standings` mirror this
  (`FORMATION`, `GREEN`).

### Start lights
- `sessionInfo.numRedLights` = 5 (how many lights to draw).
- `sessionInfo.startLightFrame`: 0 during formation, jumped to **6** exactly at
  the green (frame > numRedLights ⇒ lights-out/green), back to 0 ~10 s later.
  On a rolling start frames 1..5 never appear; expect them to animate on a
  standing start (UNVERIFIED — needs one standing start to confirm cadence).

### Pit limiter (the "engage/disengage limiter" prompts)
- Shared-memory Telemetry record (base 16, stride 1888, same record
  `lmuLocalCar.ts` already copies): **byte offset 604, uint8 0/1 = limiter
  off/on**. Evidence: flipped exactly with the driver's formation-lap toggles
  and switched off 1 s after the green; on again during the pit stop.
- Byte 746 pulses ~1 s in sync with kerb strikes / offs (anti-stall or surface
  flag — unconfirmed, don't build on it yet).

### Pit entry / pit stop state
- `GetGameState.PitEntryDist`: **live signed along-track metres to pit entry**,
  counts down every frame, goes negative once past the commit point. This is
  the "limiter zone approaching" input.
- `GetGameState.PitState`: `NONE → ENTERING → STOPPED → EXITING → NONE`
  observed through a full stop.

### Live track-limits state (the yellow "track limits calculating" HUD)
- `standings[player].countLapFlag` **oscillates in real time**:
  `COUNT_LAP_AND_TIME → COUNT_LAP_ONLY` the moment the car leaves the track at
  a policed corner, and **back** if the sim forgives it (observed flipping
  twice inside one 5 s excursion). Resets to AND_TIME at the line.
  ⇒ LAP_ONLY = "lap time invalid right now"; a restore = the LMU HUD's
  yellow→green "no advantage gained".
- Invalidations are corner-specific: a 0.14 m nick at the Bus Stop (~3.84 km)
  invalidated; 1.6 m cuts elsewhere didn't.
- Own-excursion geometry (already shipped): |pathLateral| > |trackEdge| from
  standings, 17+ excursions correlated this session.
- The wording ("track limits, 0.25") is still rendered by the game and
  published nowhere (re-confirmed; see probe-lmu-penalty.js header).

### Penalties
- Count: `standings[player].penalties`, updates live (not at lap end).
  - Pit-lane speeding ⇒ instant +1.
  - Cuts accumulate silently against `SESSSET_cuts_allowed` (5 here); the
    tipping cut raised the count mid-lap.
- **Type + deadline appear in the pit menu the moment the count rises**:
  `GET /rest/garage/PitMenu/receivePitMenu` grew a row
  `{"name":"STOP/GO:","settings":["No(3Laps)","Yes(3Laps)"],"currentSetting":1}`.
  The "(3Laps)" is the serve deadline. Drive-through row wording still UNSEEN.
- **The trace log names the type the instant it is issued** (probed live
  2026-08-20, public MP race at Silverstone-class server; parsed by
  `lmuTraceLimits` since v0.82.0):
  - `score.cpp 3973: Track Limits Drive Through Penalty` — an explicit kind
    line, written in the same flush as…
  - `score.cpp 1224: Network penalty et=3438.9 "Track Limits" 1 0 0 0` and
    `score.cpp 1365: Local penalty et=3438.9 1 0 0 0 "Track Limits"` — the
    numeric fields ARE the kind: first `1` = drive-through; `0` with a
    positive second field = stop/go of that many seconds (`0 10 0 0` = the
    "Stop/Go penalty, 10s" the steward message named).
  - `steward.cpp 7095: … Msg: <driver> received Stop/Go penalty, 10s, 0laps
    for Exiting Pits Under Red. Result: penalties=1, 1st=Stop/Go,10s` — the
    full story WITH the driver's name, but it only reaches the trace while
    the results file is closed (early session).
  - **CAUTION: `Local penalty` lines fire for OTHER drivers too in MP** — the
    stop/go above was another driver's, on this PC's trace. Anything built on
    these lines must attribute them first (the provider gates on our own
    count edge / the steward-named driver; see `setPenaltyAttribution`).
- DSQ: `standings[player].finishStatus` = `FSTAT_DSQ` (and the trace writes
  `LocalDisqualify() for driver "<name>"`).
- Served: count decremented (2→1) while `PitState == STOPPED`.

### Yellow flags
- `sessionInfo.sectorFlag[3]`: `"UNKNOWN"` when clear; a car parked on track
  ~51 s produced `["YELLOW","YELLOW","YELLOW"]`, cleared back to UNKNOWN after
  rejoining. (All three lit for one stopped car at Daytona; per-sector
  granularity presumably applies with marshalled sectors — treat array as
  authoritative per sector.)
- `sessionInfo.yellowFlagState`: stayed `"NONE"` throughout — reserved for
  full-course-yellow / safety-car states (values UNSEEN; rF2 enum suggests
  PENDING/PITS_CLOSED/PITS_OPEN/RESUME etc.).
- AI contact did NOT raise sector yellows by itself.

### Incidents
- `GET /rest/watch/getIncidentsList/{minSecondsBetween}` → array of
  `{player, contactWith, et}` (et = session seconds; "Immovable" = wall).
  Grows through the session, resets on session change. Filter by player name.

### Misc verified
- `GET /rest/race/getAllowedToStartRacing` → true/false (false during session
  teardown).
- `raceCompletion.timeCompletion` starts ticking 0→1 at the green (timed race
  progress fraction).
- Paused (phase 9) hides nothing else — feeds keep serving last state.

## Implementation plan

New `TelemetryFrame` additions (all from sources the lmu provider already
polls, plus one extra byte from the telemetry record it already copies):

```
race: {
  phase: 'BEFORE'|'FORMATION'|'COUNTDOWN'|'GREEN'|'PAUSED'|...,
  startLights: { frame: number, total: number },   // draw total lamps, fill frame
  sectorFlags: ['GREEN'|'YELLOW', x3],
  fcyState: string,                                 // yellowFlagState verbatim
  pit: { state: 'NONE'|'ENTERING'|'STOPPED'|'EXITING', entryDistM: number },
  limiterOn: boolean,                               // telemetry byte 604
  lapValid: boolean,                                // countLapFlag === COUNT_LAP_AND_TIME
  penalties: { count: number, type: string|null, deadlineLaps: number|null },
}
```

Polling: `GetGameState` + `sessionInfo` at ~5 Hz (cheap, already local);
pit-menu fetch only on penalty-count change.

Widgets (one new `raceControl` widget + touches to existing):
1. **Start sequence banner**: FORMATION ⇒ "FORMATION — ENGAGE LIMITER" if
   limiterOn=false (the pre-green limiter reminder the stock HUD gives);
   COUNTDOWN/lights ⇒ lamp strip from startLights; GREEN edge ⇒ "GREEN FLAG"
   flash 3 s + "LIMITER!" if limiterOn still true.
2. **Track-limits live pill**: off-track (geometry) ⇒ amber "TRACK LIMITS";
   lapValid false ⇒ red "LAP INVALID", restore ⇒ green "OK" 2 s. No more
   end-of-lap-only refresh.
3. **Penalty toast**: count increment ⇒ read pit menu row ⇒
   "STOP/GO — SERVE IN 3 LAPS" persistent chip until count decrements while
   pit.state==STOPPED ⇒ "PENALTY SERVED".
4. **Pit entry marker**: when pit.state==ENTERING or entryDistM < 500 and
   falling ⇒ countdown chip "PIT ENTRY 400 m"; red "LIMITER!" if crossing
   commit point with limiterOn=false.
5. **Flag rail**: S1/S2/S3 sector chips from sectorFlags; whole-rail FCY skin
   when fcyState != NONE (values TBD when first seen).

Simulator/fixture support: extend `simulatorProvider` + fixtures so every state
above is reproducible offline (fixture server renders rare states; see
dev-harnesses memory).

## Open items
- Standing-start light cadence (frames 1..5) — one standing-start session.
- Drive-through PIT-MENU row wording — next drive-through penalty (the type
  itself is no longer blocked on it: the trace names it, see Penalties above).
- `yellowFlagState` FCY values — next safety-car/FCY session.
- Multiplayer parity — re-check on an RC server with XiLE (fields may differ).
- gamePhase 4 (countdown) unverified; treat unknown phases as no-banner.
