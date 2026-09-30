# Race Log — a written timeline of your race, with a jump into the game's replay

**Status:** planned, 2026-09-30. Nothing built. Every data source below was
probed against the running game or real files on this machine the same day;
the replay jump was driven end to end on two real replays and confirmed on
screen by Carl.
**Goal:** after an official race, a driver opens Apex and reads their race as a
timeline: one line per event, `race time · lap · type · description`. Start,
flags, every lap time with its status, places gained and lost, every contact
naming the other car, damage graded the way the game's HUD grades it, track
limits verdicts and penalties, pit stops, the finish. Clicking a contact loads
the game's own replay of that race and drops the camera on our car five
seconds before it. Small incidents get settled without anyone scrubbing a
four-hour replay.

```
 0:00.0  L1   START     Green flag. Started P12 (P5 in GT3)
 0:02:14 L1   POSITION  Gained 3 places, now P9 (P3 in GT3)
 0:04:40 L2   CONTACT   Contact with Peter Dempsey (#23)             ▶ replay
 0:04:41 L2   DAMAGE    Major damage: front-left suspension, bodywork
 0:05:57 L2   LAP       Lap 2  1:52.671  invalid (track limits)
 0:06:20 L3   LIMITS    Track limits: warning (2 of 5 points)
 0:47:03 L22  PENALTY   Drive-through for Track Limits
 1:20:11 L41  FINISH    Chequered flag. Finished P8 (P2 in GT3), 41 laps
```

---

## Decisions (Carl, 2026-09-30)

1. **Our car only.** The log follows the car we drove, across driver swaps (the
   car, not the person, so a team event's log carries both stints). The whole
   field can come later. The XML has everything needed, so it is a
   filter change, not a new pipeline.
2. **Damage graded like the game's HUD: minor / major / critical.** LMU has no
   "light / moderate / heavy" damage wording anywhere (bundle, locales, exe
   strings checked). Its only scale is the in-car HUD tint:
   `damageColourNone/Minor/Major/Critical`. The thresholds are compiled into
   the exe and unknown, so phase 5 measures them.
3. **Local only.** No Supabase table, no upload.
4. **Click an incident → the game's replay jumps there**, the way lmu-steward
   does it.

---

## Where the data comes from (all verified 2026-09-30)

### A. The results XML (after the race, and every past race)
`<LMU>\UserData\Log\Results\YYYY_MM_DD_HH_MM_SS-xxR1.xml`: 207 races on this
machine already. rFactor 2 format, **not JSON**. `findLmuLogDir()`
(`src/telemetry/lmuTraceLimits.ts:737`) already finds `UserData\Log`.

| Element | Gives | Notes |
|---|---|---|
| `<Driver>` | name, CarClass, CarNumber, GridPos/ClassGridPos, Position/ClassPosition, FinishStatus, DNFReason, `<Swap>` | `isPlayer` is 1 for **every human** in MP, useless for "me" |
| `<Lap num p et s1 s2 s3 pit>` | overall position at lap end, lap-start `et`, sectors, pit flag; text = lap time, `--.----` = invalid / no time | class position must be derived |
| `<Incident et>` | `A(slot) reported contact (n) with another vehicle B(slot)` or `with Immovable` | one row **per reporting car**, so a contact appears twice. `n` has no unit (median ~176, max ~7300) |
| `<TrackLimits Driver ID Lap WarningPoints CurrentPoints Resolution>` | verdict text: No Further Action / Warning / Invalid Lap Cut Track / Invalid Lap Off Track / Drive Through / Stop Go / Time / Disqualify | **every line written twice** |
| `<Penalty Driver ID Penalty Time Reason>` | given, served, "finished before serving, added N s" | some Reasons localised |
| `<Sector>` | "reports new suspension damage" / "new engine damage" | the XML's **only** damage info |
| `<Score>` | every timing line for every car; `t=-1.000` invalid; `Checkered for X` | |
| `<DriverChange>`, `<Sent>` | driver swaps by slot | |

**Timing:** the file is written **once**, about 80 s after the chequered flag.
A crash means **no file** (the 25 September 5 h race has none).
**No flag events** (green, yellow, FCY, red) are in the file.
**Clock:** every `et` is session-elapsed seconds; race start = Lap 1 `et`.
The number in `Name(n)` is the car's **slot**: the same number the replay's
standings use, and stable across driver swaps.

### B. The live feed (while racing)
- **Flags and phases:** already in the frame. `session.phase/flag`,
  `startLights`, per-sector yellows from shared-memory bytes 122–124, `finalLap`,
  `player.finished` (see `docs/race-control-signals.md`).
- **Our damage:** `damage.ts` from REST `RepairAndRefuel`: `aero` (one number for
  all bodywork), `suspension[FL,FR,RL,RR]`, detached parts, polled every 3 s. REST
  gives **no zones for bodywork**, so we say "bodywork", never "rear bodywork".
- **Contacts:** `GET /rest/watch/getIncidentsList/0` → `[{player, contactWith, et}]`
  for the whole field, names only, no strength. Never polled by the app today.
  The `replaymetrics` websocket's `latestIncidentET` (port 6398) can trigger the
  poll.
- **Track limits and penalties:** already read live by `LmuTraceLimitsReader`
  (points, verdicts, penalty kind), our stints only, up to ~25 s late.
- **Laps:** `LapRecorder` → `~/.apex-overlay/laps/<day>.jsonl` with `clean` /
  `dirty[]`.
- **Positions:** `/rest/watch/standings`; identify our car by `isOwn` / the
  team-car logic, **not** `isPlayer` (it follows the camera).

### C. The replay (driven live 2026-09-30)
| Step | Call | Verified |
|---|---|---|
| Pair the race to a replay | `GET /rest/watch/replays`, filter `metadata.session==='RACE'` + `sceneDesc`, nearest `timestamp` to XML `<DateTime>` (+3–4 s); tie-break on `.Vcr` mtime ≈ XML mtime | 33/40 recent races paired; 7 had no replay left |
| Must be at the menu | `/navigation/state` → `NAV_MAIN_MENU` + `GSTATE_SETUP` | yes |
| Load | `GET /rest/watch/play/{id}` (a GET that **changes state**) → `7` = OK. `id` is a list position: re-fetch the list first | yes |
| Ready | poll `/navigation/state` until `settingMode=SETTING_REPLAY_PLAYBACK` **and** `gameState=GSTATE_DYN`. The loading bar ending is ~6 s too early; calls 400 until DYN | 25 s for 642 MB, 38 s for 2.6 GB |
| Camera | `PUT /rest/watch/focus/{slot}` with the XML slot. **Never look up by name**: after a swap the standings show the current driver | yes |
| Seek | `PUT /rest/watch/replayTime/{et − 5}`. The replay clock **is** session `et` (`replayStartET` 0) | landed 3½ h in, in under 1.5 s |
| Play | `PUT /rest/watch/replayCommand/VCRCOMMAND_PLAY` | yes |
| Leave | `POST /navigation/action/NAV_TO_MAIN_MENU` | ~2 s |

Gotchas found live:
- **A PUT with no `Content-Length` returns 400 with an empty body.** Node's
  `fetch` sends it; a bare `curl -X PUT` doesn't.
- Once a replay is loaded, every further jump in that race is instant.
- The game keeps **only 5 replays per track and session type**
  (`Number Track Replays: 5`). Recording is automatic, MP included.
- The game **can't say which replay is loaded** (`isactive` is only true or
  false), so we remember what we loaded.

---

## Architecture

```
 live frames ──► RaceLogRecorder (server loop) ──► ~/.apex-overlay/racelog/<day>.jsonl
                     │  flags, our damage, live contacts, laps, limits, penalties
                     ▼
 results XML ──► resultsXml.ts (parse) ──► raceLog.ts (build + merge) ──► review:racelog IPC
                                                                              │
                                                  Review tab timeline ◄───────┘
                                                        │ click ▶
                                                        ▼
                                              lmuReplay.ts ──► LMU REST :6397
```

All the parsing and building is **pure TypeScript in `src/telemetry/`**, like
`stintReview.ts`, so it's testable against real files without the game.

---

## Phases

### Phase 1: the log from the results XML (post-race, every past race)
The biggest win for the least risk. It works for all 207 races already on
disk, needs nothing live, and covers 4 of the 5 requested categories.

- `src/telemetry/resultsXml.ts`: a pure parser, file text → typed
  `ResultsSession { track, sessionType, startedAt, raceStartEt, drivers[],
  laps[slot][], stream[] }`. Decode `&quot;` etc.; tolerate truncated or odd files
  (return null, never throw into the IPC).
- **Find "our car"** (the XML can't say):
  1. match the lap log: the slot whose lap times equal our `LapRecord.lapMs`
     for that session (±2 ms) is ours. That works across driver swaps and
     needs no settings;
  2. otherwise fall back to our known driver name(s) (the names the app has
     seen for the player, stored locally) against `<Name>` / `DriverChange`;
  3. otherwise the log opens with a car picker ("Which car was yours?"),
     remembered for that file.
- `src/telemetry/raceLog.ts`: `buildRaceLog(results, slot) → RaceLogEvent[]`:
  - **START**: grid slot (overall and class) at Lap 1 `et`;
  - **LAP**: every lap: time, `invalid` (`--.----`, or a TrackLimits Invalid
    Lap verdict on that lap), `personal best`, `class fastest` (compare
    same-class laps up to that moment), `pit in`;
  - **POSITION**: change in overall and class position between consecutive
    lap ends. Class position = rank among same-class cars by (laps completed,
    crossing `et`) at our crossing, built from `<Score point=0>` rows. Include
    lap 1: the engineer skips it, a log must not;
  - **CONTACT**: dedupe the two reports (same pair, |Δet| < 1 s) into one event,
    keep the larger strength, name the other car (`Name #CarNumber`) or
    "the wall / a sign / a cone" for `Immovable/Sign/Cone/Post`;
  - **DAMAGE (XML)**: "new suspension damage" / "new engine damage";
  - **LIMITS**: dedupe the doubled lines; "warning (2 of 5 points)", "lap
    invalidated", "no further action";
  - **PENALTY**: given / served / converted at the finish, with kind and reason;
  - **PIT**, **DRIVER** (swap in or out), **FINISH / DNF** (+ reason).
- Timestamps: shown as race time from Lap 1 `et`; `et` is kept on every event
  for the replay jump.
- `review:racelog` IPC next to `review:session` (`electron/main.js:3783`),
  lazily required from `dist/` like its neighbours; `review:racelogs` lists
  which XML races exist.
- **Tests:** `scripts/test-racelog.js` over real XMLs copied into
  `scripts/fixtures/results/`:
  - Long Beach 2026-09-24 (33 cars, a sprint race);
  - Silverstone ELMS 2026-09-20 (4 h, the slot-9 driver swap);
  - a mid-race-join file (Stream starting at `et` 4403, junk back-filled
    laps with `p="105"`);
  - one with localised penalty reasons.

  Add it to `npm test`.

### Phase 2: the live recorder (what the XML can't give, and crash safety)
- `src/telemetry/raceLogRecorder.ts`, run **in the server loop** beside the
  provider (`src/server/index.ts` ~1050), so it records whether or not the
  engineer or any panel is open. Race sessions only (practice/qualy later if
  wanted).
- **Lossless:** reuse the edge logic of `EngineerTriggers.detect*`
  (`src/telemetry/triggers.ts:798–1163`), but **none** of its coalescing,
  cooldowns, global gate or lap-1/pit exclusions. Best done by moving the pure
  edge detection into shared helpers both classes call, rather than copying it.
- Records:
  - **flags**: green, start lights, FCY, sector yellows / clear, red,
    restart, final lap, chequered;
  - **our damage**, graded minor / major / critical with zones (see phase 5);
  - **live contacts**: poll `getIncidentsList` every ~2 s during a race,
    filtered to our car by name. The live list has names only, so the swap
    rule comes from team identity (`mPlayerName` + teams map);
  - **laps and limits** from the existing lap log and trace reader.
- Stamp each event with **session `et`**, the same clock as the XML and the
  replay, plus wall time.
- Append to `~/.apex-overlay/racelog/<day>.jsonl`, keyed by track + session
  type + session start (not `sessionKeyOf`, which resets on MP joins and leaves).
- **Merge** in `raceLog.ts`: the XML is authoritative for laps, positions,
  limits and penalties; the live log adds flags and our graded damage; live
  contacts are superseded by XML contacts (same `et` ±1 s) once the file
  lands. **No XML (crash)** → the live log alone is the race log, marked
  "provisional: the game didn't save results".
- **Tests:** replay `recordings/*.jsonl` through the recorder
  (`scripts/test-triggers.js --replay` pattern), plus `serve-fixture` race-finish
  fixtures.

### Phase 3: the timeline in the Review tab
- A **Race log** view on a race session in the Review tab
  (`electron/control-panel/review-panel.js`), also offered for XML races with
  no lap-log match (older races, or ones driven before Apex was installed).
- One row per event: race time, lap, a type chip, the description. Contact
  rows carry a ▶ Replay button.
- Filters by type (Contacts, Limits and penalties, Positions, Laps, Flags);
  "Only incidents" toggle for the steward use case.
- **Copy as text**: the plain `timestamp + type + description` format from the
  request, for pasting into a league Discord or protest.
- Build it against `docs/`'s design system and the existing review-panel
  styles; add it to the Review tour, which must stay reachable from the Get
  started checklist.

### Phase 4: jump to the replay
- `src/server/lmuReplay.ts`: `findReplayFor(results)`, `openAt({replayId, slot,
  et, leadS: 5})`, following table C exactly. A small state machine
  (idle → loading → ready) that remembers what's loaded, so a second click in
  the same race is just focus + seek.
- **Guards:**
  - only when `navigationState` is `NAV_MAIN_MENU`, or a replay we loaded is
    showing;
  - **never** from a live session. The button says "Leave your session to
    watch the replay" rather than yanking the driver out.
- UI states:
  - "Loading replay… (big replays take ~40 s)", with a progress bar from
    `loadingStatus.percentage`;
  - "This race's replay has been replaced by the game" when pairing finds
    nothing (5-per-track retention). The ▶ button shows that before the click.
- Optional **Keep this replay**: copy the `.Vcr` to `~/.apex-overlay/replays/`
  so retention can't delete it. It's out of the game's list, so re-importing
  it is a question for later (see open questions).
- `review:replayOpen` / `review:replayStatus` IPC.

### Phase 5: damage grading, calibrated
- **Measure the HUD thresholds** with Carl on track: bump a wall in practice
  at increasing strength while logging `aero`, `suspension[]`, `detachableParts`
  from REST next to a screenshot of the HUD's colour for each zone. Record the
  None / Minor / Major / Critical cut-offs in `damage.ts`.
- **One scale everywhere:** today `damage.ts:62 HEAVY_SEVERITY = 0.15` (widget
  red) disagrees with `triggers.ts:422 damageBucket` (0.2 moderate / 0.5 heavy),
  so a 0.19 hit is red on the widget and "light" to the engineer. Replace both
  with one `damageGrade(sev) → 'none'|'minor'|'major'|'critical'` in `damage.ts`
  and use it in the widget, the engineer and the log.
- Log wording: "Major damage: front-left suspension, bodywork", with one line
  per worsening (none → minor → major), not per 3 s poll.
- Until the calibration is done, ship with the current 0.15 / 0.5 cut-offs
  labelled minor / major / critical, and say so in the changelog.

---

## Order and size

| Phase | Ships | Needs the game? |
|---|---|---|
| 1 XML log + tests | a usable log for every past race | no |
| 3 Review UI | what Carl sees | no (stub harness) |
| 4 Replay jump | the ▶ button | yes, a menu-state test like today's |
| 2 Live recorder | flags, graded damage, crash survival | a real race to verify |
| 5 Damage calibration | HUD-true grades | yes, ten minutes on track |

1 → 3 → 4 gives a complete, useful feature with no live-race dependency.
2 and 5 then enrich it. Beta first, per the release channels convention.

---

## Open questions
1. **Contact strength wording.** The XML's number is unitless. The game's
   steward screens use **Light Contact / Heavy Contact**, but where the split
   sits is unknown. Show the raw number, split at a guessed value, or leave
   strength out until measured?
2. **Kept replays.** If we copy a `.Vcr` out to protect it, can the game play
   it from elsewhere, or do we copy it back into `Replays\` on demand? Needs a
   test.
3. **Practice and qualifying.** The XML exists for them too. Log them, or races
   only?
4. **Class vs overall** positions in the headline wording. Multiclass races
   read better in class ("P2 in GT3"); should overall be shown too, or only on
   hover?

## Not tested yet (low risk, before phase 4 ships)
- A replay of a race **joined mid-way** (`replayStartET > 0`): seeking to an
  `et` before it.
- Two replays with the same track and start time (a restart): the mtime
  tie-break.
