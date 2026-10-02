# Race engineer, phase 0: when it speaks

The trigger layer for the AI race engineer — the part that decides *which moments in
a session deserve a radio call*, built and tuneable before any of the expensive parts
exist. There is no model here, no prompt, no network and no words: this layer answers
only "should the engineer say something right now, and about what".

Code: `src/telemetry/triggers.ts`.
Tooling: `scripts/test-triggers.js` (unit suite **and** replay), `scripts/record-session.js`.
Plan: `raceengineerplan.html` §7, §9 (P0).

## Why this is the first thing built

Everything downstream costs something. The cloud proxy costs a key and an account; the
model costs tokens; the voice costs a decision about what the engineer sounds like.
The trigger layer costs nothing, and it is the piece that decides whether the feature
is any good — a perfect model on the wrong moments is a nuisance, and a mediocre one
on the right moments sounds like a race engineer.

It is also what keeps the feature inside the overlay's "stay light" brief. The rule is
**never per frame**: the 30 Hz loop already reads the sim, computes fuel and tracks
penalties, so this layer only compares a handful of scalars against the previous tick.
Measured at **0.24 µs per frame** on a quiet lap (`test-triggers.js` §9) — about
0.001% of one core at 30 Hz. A layer that cannot fire per frame also cannot bill per
frame, which is what pins the eventual API cost near zero.

## What it fires on

Every trigger is a **state change the telemetry can prove**. There is no `slowPace` or
`rivalPitted`, not because they would be hard to detect but because acting on them
means asserting a strategy we cannot verify.

| Kind | Edge | Read from |
| --- | --- | --- |
| `raceStart` | pre-green → green (first time) | `session.phase`, `session.notStarted` |
| `restart` | green again after FCY/red | `session.phase` |
| `fullCourseYellow` | → full-course yellow | `session.phase`, `session.flag` |
| `redFlag` | → red | `session.phase`, `session.flag` |
| `incident` | `damage.hasDamage` false → true, or `damage.worst` jumping ≥ 0.15 between frames | `player.damage` |
| `penalty` | the sim's penalty count rising | `player.trackLimits.penalties` |
| `penaltyServed` | that count falling | `player.trackLimits.penalties` |
| `fuelWindow` | laps left crossing down through 3 | `fuel.lapsRemaining`, `fuel.virtualEnergyLapsRemaining` |
| `fuelCritical` | `fuel.pitThisLap` false → true | `fuel.pitThisLap`, `pitThisLapReason` |
| `finalLap` | → white | `session.flag` |
| `checkered` | → chequered | `session.flag`, `session.phase` |

The Standard-preset kinds (v3, 2026-08-19) — the race-story layer, same law, race-only
except `yieldTo`:

| Kind | Edge | Read from |
| --- | --- | --- |
| `fastestLapSelf` | the player's best lap **improves** (never the first best) | `standings[player].bestLapSec` |
| `fastestLapField` | the class fastest changes **owner** — not merely improves, and a vanishing holder is not a purple | `standings[].bestLapSec` |
| `positionChange` | `position` steps, outside lap 1 and own pit cycles | `standings[player].position`, `pit.phase` |
| `rivalPitted` | the class neighbour ahead/behind: `inPit` false → true | `standings[].inPit`, `classPosition` |
| `pitWindowOpen` | current lap reaches `fuel.pitWindowOpenLap` (self-re-arming) | `fuel.pitWindowOpenLap`, `session.currentLap` |
| `yieldTo` | any relative row's `yieldTo` false → true — `yieldAlert.ts` owns the rule | `relative[].yieldTo` |

These baselines are **seeded on the priming frame** like everything else: attach
mid-race and the current fastest-lap holder, the neighbours' pit state and an
already-open window are all levels, not edges.

Notes on the ones that are not simply "read the field":

- **The plan named `damage.anyDamage`.** The field is `damage.hasDamage`; the block is
  LMU-over-REST only and is *absent* — not zeroed — while spectating or on rf2, so an
  undefined previous reading keeps the detector quiet rather than announcing a car it
  has only just started watching.
- **A second impact is a jump, not a level.** "Worse than when I last spoke" stays true
  for the rest of the stint, so it would re-announce the moment the cooldown expired —
  telling the driver their car is worse than they thought thirty seconds after they hit
  the wall. A step change between consecutive frames is a real second contact.
- **Fuel takes the tighter of the two budgets.** LMU cars run a tank *and* a
  virtual-energy allowance and either can be the binding one; the driver pits for
  whichever runs out first, and the cue names which.
- **`fuelCritical` rides `fuel.pitThisLap`.** That projection already exists in the fuel
  calculator and one place owns that arithmetic. This layer re-derives nothing.

## The four gates

A crash reads as "damaged" for several seconds and a safety car churns the flag state,
so a candidate has to pass all of:

1. **Edge only** — the transition, never the level.
2. **Per-trigger cooldown** — 30 s by default (20–25 s for incidents and penalties,
   60–90 s for fuel), so a car grinding down a barrier is one call, not eight.
3. **Coalesce window** — candidates buffer for 1.5 s and emit as *one* cue carrying the
   whole set, priority-ordered: red flag > FCY > incident > penalty > fuel > the rest.
   Contact, a penalty and a lost place inside two seconds are one thing that happened.
4. **Global minimum interval** — at most one cue every 15 s, whatever fired.

### Held lines expire rather than queue

When the global gate is shut, buffered candidates are held for **4 seconds and then
dropped**. This is the one place a queue would have been the obvious implementation and
the wrong one: an engineer telling you about contact twenty-five seconds after you felt
it is not late information, it is wrong information, and it arrives while you are
dealing with whatever came next. Silence is the better failure.

### Nothing fires on the frame we arrive on

Every detector needs the previous value, so the first frame after a reset only records
levels — including the fuel window's hysteresis, which is a level rather than an edge
and is armed from where the car actually is. Attach to a car that is already bent,
already penalised and already three laps from empty and the engineer says **nothing**:
the driver was there for all of it.

A session change (`sessionKeyOf` — source + track + type + car count) wipes everything,
for the same reason `trackLimits.ts` does: a penalty served in qualifying is not news in
the race. So does a clock that jumps backwards, which is a replay looping or a feed
being reattached — without that, every cooldown would sit in the future forever.

## Tuning against real races

The whole point of P0 is to settle the thresholds on real sessions before spending
anything. Two commands:

```sh
# 1. Record. Attaches to the running overlay server as a widget does — no hooks in
#    the loop, nothing to remember to turn off. Ctrl-C to stop.
npm run record                      # → recordings/session-<stamp>.jsonl

# 2. Replay, and read every line it would have fired.
node scripts/test-triggers.js --replay recordings/session-<stamp>.jsonl
```

```
Replaying session-2026-08-04T19-22-05.jsonl
  coalesce=1500ms  global=15000ms  cooldown=30000ms  fuelWindow=3 laps

  00:00:18  [raceStart] green flag · P5 (LMP2 P2) · lap 5
  00:41:07  [incident] contact — moderate damage + penalty issued · P7 (GT3 P3) · lap 22

  4210 frames read (4210 live)
  2 cues fired: raceStart×1, incident×1
  suppressed — cooldown 3, global interval 1, stale 0, once-only 0, wrong session 0
```

**Read the suppressions as the tuning signal.** A high *global interval* count means the
minimum gap is eating real news; a high *cooldown* count means a detector is chattering.
Both are tuneable from the command line without touching the module:

```sh
node scripts/test-triggers.js --replay <file> --global 25000 --cooldown 40000 --fuel-laps 4
```

Recordings are decimated to 4 Hz and trimmed to the blocks this layer reads (~30 MB an
hour instead of ~1 GB). That is well inside the debounce — the coalesce window is 1.5 s
and the shortest cooldown is 20 s, so nothing here is decided in less than a quarter of
a second. `--full` keeps whole frames at the broadcast rate. `--demo` replays simulator
frames, which are marked `connected: false` and ignored by default: an engineer talking
over demo data is talking about a car nobody is driving.

`/recordings/` is gitignored. The detector is what ships, not the evidence it was tuned
on.

## Where the boundary sits now (v3, 2026-08-19)

The layer IS wired in as of Track B: `electron/engineer.js` feeds it the frames it
already receives over the app's own WebSocket (a client, like a widget — the 30 Hz loop
is untouched), and speaks a cue through the same Piper + radio pipeline as the voice
answers. The division of labour is deliberate and unchanged:

- **This module decides *when*.** Detection always runs, whatever the dial says, so its
  stats keep feeding tuning.
- **`engineerPhrases.ts` decides *the words*.** `EngineerTrigger.detail` and
  `EngineerCue.line` are still the tuning log's rendering, not speech — the phrasebook
  can be rewritten without touching a detector, and vice versa.
- **`electron/engineer.js` decides *whether now*.** The preset dial (off / essential /
  standard), the busy-driver hold (a car alongside, deep braking) and the
  answers-pre-empt-readouts queue all live in the service, tested headless in
  `scripts/test-engineer-queue.js`.
- **It still holds no opinions about strategy.** The facts on a cue are bucketed where a
  raw number would be noise (damage severity is the HUD's `minor`/`major`/`critical`, from
  `damage.ts` `damageGrade`, not `0.37`);
  the engineer comments on what it can see.

## Qualifying and practice (2026-10-02)

`src/telemetry/sessionCalls.ts` (detection) and `sessionPhrases.ts` (words) give the
hotlap sessions their own engineer. They plug into `EngineerTriggers` and use its gates
unchanged; `scripts/test-sessioncalls.js` covers them.

| kind | session | preset | example |
|---|---|---|---|
| `qualiLap` | qualifying | Essential | "Personal best, 1 51.8, P4 in class." / "1 52.3, two tenths off your best, still P4." / "Provisional pole! 1 51.2." / "Lap's deleted — track limits." |
| `qualiPole` | qualifying | Essential | "New pole: Ferreira, 1 51.2." / "Ferreira takes pole off you — 1 51.2. You're P2." |
| `qualiBeaten` | qualifying | Essential | "Moreau's gone quicker — you're P5 now." / "Four cars have gone quicker — you're P8 now." |
| `qualiTimeLeft` | qualifying | Essential | "3 minutes left — time for one more after this." / "No time for another after this one." |
| `qualiGrid` | qualifying | Essential | "That's the flag. You'll start P6 in class, P14 overall." (provisional while class cars still run) |
| `practiceLap` | practice / test day / warm-up | Standard | "Personal best, 1 51.8." / "Lap's deleted — track limits." |
| `sectorImproved` | both | Standard | "Purple sector one." / "Sector two, two tenths up." |

Defaults, and why:

- **Flying laps only.** A lap is summarised only if it was seen to start at the line,
  never touched the pit lane (out-laps start there, in-laps end there), ran without
  FCY/red, did not start after our flag, and — when valid — is within 1.5 % of the best
  (slower is a cool-down or an abandoned run). One summary per lap, built 1.2 s after the
  line (the board re-sorts first), and it waits up to 12 s for a free channel rather than
  being clipped by the global gate.
- **Deleted** = LMU's `countLapFlag` (`lapValid`) still false at the line, or false
  during the lap and the sim withheld the time. A cut the sim forgave is a normal lap.
- **Sector calls** (opt-in: Standard preset): only on a flying, still-valid lap; at most
  one per lap; qualifying needs a tenth up on the best LAP through that sector, practice
  three tenths; a purple estimate (best lap's split + the delta through the sector) must
  beat every class car's best split by 0.05 s. Never within 18 s of the line, so the lap
  summary keeps the gate. Needs `paceDeltas` (shared memory); none when spectating.
- **Board news** (pole, beaten) waits until the class times have been still for 2.5 s,
  so an end-of-session burst is one call naming the net position; pole speaks only on a
  change of OWNER; only your class; held while your own lap is about to land.
- **Time left** is pure timing at the line: the lap now starting ends after one best
  lap; if the clock still shows time then, there is "one more after this". It is said
  when exactly one more go remains and when none does — never a statement of what the
  rules let you finish (unverified for LMU qualifying).
- **The grid call** fires once: our car takes the flag (`finished`), or the flag is out
  while we sit in the pit lane, or (no per-car finish channel) the chequered phase. It
  rides with the final lap's summary as one call.
- Push-to-talk "where do I start" / "grid position" answers the current provisional
  slot in qualifying; in a race `gridStart` still answers "where did I start".

Not verified on a real qualifying session (no recording exists): how LMU ends a
qualifying session, and that `countLapFlag` behaves there as it does in a race.

## Next

Tier 2 (the cloud proxy for free-form questions) consumes `EngineerCue` and the same
bucketed facts, and should need to change nothing in this file — if it does, the
boundary is in the wrong place. The Talkative-preset kinds (`paceTrend`, `tyreNote`,
`weatherChange`) are the first ones that would *infer* rather than report; they get
built only after replaying recorded races proves their thresholds, per the v3 plan.
