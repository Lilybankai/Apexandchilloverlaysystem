# LMU track limits: where the numbers come from

How Le Mans Ultimate's track-limits points system is read, measured live rather than
inferred. Every value here is either read from the sim or checked against something
the sim wrote; where something is still unknown, it says so.

Tooling: `scripts/probe-lmu-penalty.js`, `scripts/test-tracelimits.js`.
Code: `src/telemetry/lmuTraceLimits.ts`, `src/telemetry/trackLimits.ts`,
`src/telemetry/lmuRestProvider.ts`.

## The three sources, and what each one can do

| Source | Carries | Live? |
| --- | --- | --- |
| `/rest/sessions` | `SESSSET_cuts_allowed` (the threshold), `SESSSET_cut_rules` | yes |
| `UserData/Log/trace_*.txt` | per-incident charge, verdict, lap, lap distance, the scoring inputs | **yes** |
| `UserData/Log/Results/*.xml` | per-incident `WarningPoints`, running `CurrentPoints`, verdict, lap invalidation | no — session end only |

### What carries nothing

Checked live in a race session, because these are where such data would normally live:

- **Shared memory.** `Extended`, `PitInfo` and `Rules` are all mapped and contain
  **zero printable strings**: LMU maps rF2's `mLSI*` message fields and the
  track-rules participant messages and never writes to them.
- **REST, apart from the threshold.** Every candidate message, incident and
  race-control endpoint 404s (`/rest/watch/messages`, `/eventLog`, `/raceControl`,
  `/incidents`, `/trackLimits`, `/penalties`, …). The player's standings row has 46
  fields, of which exactly one is penalty-shaped: `penalties`, the count of penalties
  already issued.

So the message a driver sees on the HUD is rendered by the game and published in no
API. The trace log is the only live route to the numbers behind it.

## The threshold

```
SESSSET_cuts_allowed = { currentValue: 5,  numStepsTotal: 63 }
SESSSET_cut_rules    = { currentValue: 1,  stringValue: "Default" }
```

`cuts_allowed` is **points, not cuts** — a single deep cut charged 1.00 and left four
to go. `LmuRestProvider.refreshRules` reads it every 30 s and passes it as
`pointsLimit`, replacing a hard-coded default of `10`; the widget had been counting to
twice the real allowance.

`cut_rules` has three states and only `1` → `"Default"` has been observed, so nothing
acts on it. Whether `0` or `2` is a "show but never penalise" mode that should suppress
the countdown is unknown. (`"Show but Never Penalize"` appears in the same payload but
belongs to `SESSSET_blue_flags` — not a cut-rules label.)

## How a charge is decided

The trace writes a verdict line and a scoring breakdown for every excursion:

```
4205: Track Limits: Off Track WP: 633 … LapDistance: 2938.04 LeftTrack: 0.22
4822: Track Limits: Back On Track; Lap: 1 LapDist: 3029.19
 626: Track Limits: WarnPts: 1.00 Pts: 0.84 … TimeSkipped: 0.33 … MaxOffTrack: 12.91
4083: Track Limits: Warning; Lap: 1 LapDist: 3183.09
```

**The charge is driven by time gained, not by how far off the road the car went.** The
breakdown names its own inputs — `TimeSkipped`, `TimeRatio`, `OffTime`, `DistPts`,
`PtsScaling` — and `Pts` goes *negative* when the driver lost time going off, which is
then charged as zero. A 0.93 m excursion at 183 kph charged nothing; a 9.92 m cut that
gained 0.33 s charged 1.00. `WarnPts` is the quantised charge, always a multiple of
0.25.

**Every excursion is evaluated twice, and only the second one counts.** There is a
provisional evaluation the instant the car rejoins (`Back On Track`) and a settled one
when the stewarding resolves (`Warning` or `No Track Cut`). Only the breakdown
following a `Warning` is a charge. The provisional figures can read 3.75 where the
settled verdict charges 0.25, and they appear nowhere in the results XML; counting them
put a session's total at 22 points against an allowance of 5.

**The total is per session** and resets on `steward.cpp: SessionName="…"`, which covers
a race restart as well as a change of session. It also resets when the accumulated
points earn their penalty, which the sim logs as
`Local penalty et=… "Track Limits"` — that exact wording, alongside the explicit
`"Drive Through Penalty"` and `"Stop/Go Penalty"` spellings. A pit-lane speeding
penalty must not discharge it, which is why the discharge matches on wording rather
than on "a penalty appeared".

### The reader agrees with the sim exactly

For the race that ended 22:38:30 on 2026-07-29, replaying the trace produced:

```
0.5 + 0.25 + 0.75 + 0.25 + 0.5 + 0.25 + 0.75 + 0.25 + 0.25 + 0.25 + 0.25 + 0.5 + 0.25 = 5.00
```

Thirteen charges. That is the same count, the same values, in the same order as the
`WarningPoints` sequence in that session's results XML, whose own `CurrentPoints`
column climbs 0.5 → 0.75 → 1.5 → … → 4.75 and then resets to 0 on the drive-through at
exactly 5.00. The two events also align in time — XML `et=382.4` ↔ trace `16313.45s`,
XML `et=451.4` ↔ trace `16382.48s`.

That is the check on the one derived number here: the running total is accumulated by
us, not read, so the session-end XML is what proves it right.

## Retractions

Earlier notes in this file, written before the trace log was found, concluded that the
charge scaled with **depth past the track edge** and put a scoring threshold between
1.31 m and 1.57 m. **Both are wrong.** Depth is a correlate of gaining time, not the
input, and the apparent threshold was an artefact of a handful of samples. The same
notes read the XML's `Resolution` attribute as the session threshold because one file
showed `Resolution="5"` beside `cuts_allowed = 5`; it is a verdict code
(`2` = Drive Through Penalty, `4` = Warning, `5` = Invalid Lap Cut Track,
`7` = No Further Action) and the match was a coincidence.

## The flush lag — the open problem, and what is already ruled out

**Charges are correct but late.** LMU does not flush its trace per line; it writes in
bursts. Measured with a watcher that timestamps each line's arrival against when the
event happened: one burst carried **27 seconds of game time in a single write**, the
oldest line in it landing **24.5 s** after the fact.

```
12:00:26   Off Track WP: 450     lag  1.2s
---        26 seconds of nothing
12:00:52   626: WarnPts 0.00     lag 24.5s   <- held in the buffer this long
12:00:52   No Track Cut          lag -2.1s   <- caught up
```

**What appears to "trigger" an update is only log volume.** Confirmed on track: the
total moves when crossing the start/finish line after a clean lap, when transiting the
pit lane, or on a brief four-wheels-off that draws no assessment from the HUD at all.
None of those cause the charge — they each write lines, which pushes the buffer past
its threshold so the charge already sitting in it gets flushed out.

### Ruled out

- **`RealTimeLogging`** (`Settings.JSON` → `Game Options`, documented as
  `"0=off, 1=Accurate"`). Set to `1` with the game closed; it survived a subsequent
  rewrite of the file by the game, so the change was live. **No effect on the lag.**
  Revert it unless a reason to keep it emerges — backup kept beside it as
  `Settings.apex-backup-2026-07-30T00-25-00.JSON`.
- **It is not the telemetry recorder.** No new `UserData/Telemetry/*.duckdb` appeared
  after enabling it, and those files are physics traces (13–20 MB a session), not
  stewarding decisions.
- **There is no separate steward log.** Nothing in `UserData/Log` carries steward or
  penalty output; it all goes to the trace.
- **Polling faster does not help** and never will: the bytes are inside the game's
  process, not on disk.

### Next candidates, in order

1. **Find where the in-game HUD gets it.** The HUD shows the assessment immediately, so
   the value exists in the process the instant it is decided. LMU's UI is web-based and
   the REST API on `:6397` is the same server — the endpoint list we enumerated was
   guessed at, not discovered. Reading the shipped UI assets for whatever the
   track-limits HUD element subscribes to would find a genuinely live source and make
   the trace redundant.
2. **`Steward Log Level`** (currently `1`, described only as *"Where to log steward
   messages"*). Its other values are unobserved; one may write to a file the game
   flushes promptly, or raise the volume enough to shorten the lag.
3. **Anything that raises trace verbosity.** More bytes means the buffer fills sooner,
   which shortens the lag without fixing it. A blunt instrument, and it costs disk.
4. **Accept it and say so on the widget.** Our own geometry sees the excursion
   immediately, so the widget could mark that a cut is awaiting judgement — turning the
   lag from a wrong number into a visibly pending one. Decision not taken; it adds an
   element to the panel.

## Open questions

- **Lap invalidation is not in the trace.** The XML reports it (`Invalid Lap Cut
  Track`, 727 entries in one evening) and the trace has no equivalent line, so nothing
  claims it live yet. The likeliest live signal is `countLapFlag` in the standings row
  (rF2's `mCountLapFlag`), which reads `COUNT_NEITHER` in the garage; whether it flips
  on a cut is unverified.
- **The trace lines carry no driver name.** They are taken to be the player's on two
  grounds: the scoring-line count is far lower than the player's own excursion count
  from geometry, so it cannot be the whole field; and three consecutive `Off Track` lap
  distances matched three consecutive player excursions exactly. Pass-monitoring lines
  (`score.cpp 547`) *do* name other drivers and are ignored.
- **Flush latency is unmeasured.** The file grows within seconds of an event, but how
  long after rejoining the charge appears has not been timed.
- **`INSTANT_PENALTY_POINTS = 3` remains a guess.** Single charges of 3.00 and above do
  appear in the XML, but nothing confirms a 3-point cut is an immediate drive-through
  on its own.
- Whether the threshold or the charge varies by track. All measurements here are Laguna
  Seca, one car, one driver.
