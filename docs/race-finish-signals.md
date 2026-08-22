# The last lap and the chequered flag — what LMU actually publishes

**Probed live 2026-08-22**, a 6-hour ELMS team race at Silverstone (35 cars),
from the last six minutes through every car taking the flag.
Reproduce with `node scripts/probe-race-finish.js` (read-only; nothing is
written to the game).

---

## The three moments, and how far apart they are

They are three different events, and treating any two as one is what made the
old detectors wrong.

| | when | channel |
|---|---|---|
| **the flag comes out** | t+0 | `sessionInfo.sectorFlag` → `CHECKERED`; MMF sector byte → `3` |
| **the leader finishes** | t+23 s | `gamePhase` → `8` / `GPHASE_CHECKERED` |
| **our car finishes** | t+46 s | that car's `finishStatus` → `FSTAT_FINISHED` |

Twenty-three seconds and forty-six. A "last lap" call hung off the session phase
lands after the leader has already taken the flag, and a "well done, you
finished" hung off the same thing congratulates a driver with most of a lap
still to run. In a bigger field the second gap is a whole lap or more.

## There is no white flag

Not "we did not see one" — the marshalling channel goes **clear → CHEQUERED**
with nothing in between. `flag === 'white'` was the only thing the engineer's
`finalLap` trigger listened for, so on LMU it had never once fired.

## Field by field

### `/rest/watch/sessionInfo`

- `sectorFlag: string[3]` — `"UNKNOWN"` for a clear sector (not `"GREEN"`, not
  `"NONE"`), then `"YELLOW"`, `"RED"`, `"CHECKERED"`.
  **All three entries always carry the same value.** Measured: shared memory
  held `2,3,11` — three genuinely different sectors — at an instant this endpoint
  reported `["RED","RED","RED"]`. So the per-sector rail is one flag drawn three
  times on the REST path. Per-sector truth needs the shared-memory bytes.
- `gamePhase: 8` at the leader's crossing. (`9` is still the ESC/monitor screen —
  see the race-control note.)
- `raceCompletion.timeCompletion` — 0..1 through the race. Reached 0.9906 with
  ~200 s to run.
- `maximumLaps: 4294967295` in a timed race; `maxTime`/`endEventTime` carry the
  booked length.

### `/rest/watch/standings`, per car

- `finishStatus` — `FSTAT_NONE` → `FSTAT_FINISHED`. Also seen: `FSTAT_DNF`
  (4 cars were already carrying it six minutes from the end) and `FSTAT_DSQ`.
  **This is the only channel that says a particular car is done.**
- `countLapFlag` — `COUNT_LAP_AND_TIME` normally, `COUNT_NEITHER` on a DNF.
- `flag` — per-car, `GREEN` / `BLUE`. Stayed `GREEN` through the finish, so it
  is not a finish signal.

### `/rest/sessions/GetGameState`

- `gamePhase` → `GPHASE_CHECKERED`, in step with the numeric one.
- `raceFinished` stayed **false** through the entire finish, including after
  every car had taken the flag. It is not the signal it looks like.

### Shared memory `$rFactor2SMMP_Scoring$`

The `rF2ScoringInfo` layout is `#pragma pack(4)` with the results-stream pointer
present, which puts `mPlayerName` at `SI.base + 116` — already verified
independently (see the team-event note), so the rest of the header is bracketed
rather than assumed:

```
 68 mCurrentET   76 mEndET      84 mMaxLaps     88 mLapDist
104 mNumVehicles 108 mGamePhase 109 mYellowFlagState
110 mSectorFlag[3]              113 mStartLight
114 mNumRedLights               115 mInRealtime  116 mPlayerName[32]
```

Sector flag byte values, read off the live finish: **11 = clear, 1 = yellow,
3 = chequered, 2 = the state REST calls RED.** The `2`/`3` alternation seen
after the flag is not yet explained — it may be the flag being waved — so
nothing here depends on telling those two apart.

Per vehicle record (stride 584): `mSector` at `+102` and **`mFinishStatus` at
`+103`**, the two bytes between the already-verified `mTotalLaps` (100) and
`mLapDist` (104). Confirmed live, not inferred: the count of records with
`mFinishStatus > 0` tracked the REST `FSTAT_FINISHED` count exactly, car for
car, from 4 to 22 across the finish. Values are `0` none, `1` finished, `2` DNF,
`3` DSQ.

---

## What the app does with it

- `session.finalLap` — the flag is out. Set from `sectorFlag` containing
  `CHECKERED`, or the session phase, whichever comes first.
- `player.finished` / `finishPosition` / `finishClassPosition` — from the focused
  car's own `finishStatus`, with the position **latched** at the crossing,
  because a live position keeps moving for the minutes it takes the field to
  come round.
- `player.finished` is published even while `false`. It is tri-state by absence:
  a provider that cannot see finishes omits it entirely, and only that provider
  falls back to announcing the leader's flag.

## Still open

- **Per-sector flags on the REST path** are collapsed to one value (above). The
  fix is to read `SI.base + 110..112` from shared memory, where the three bytes
  are genuinely different. Worth doing for sector yellows, which is what the
  rail is really for.
- **What `2` means** in the sector byte, and why it alternates with `3` after
  the flag.
