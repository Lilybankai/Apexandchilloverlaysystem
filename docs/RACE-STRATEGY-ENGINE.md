# Race strategy engine — fuel save / balanced / push

**Status:** spec, nothing built. **Blocked on Phase 0** (see *The corpus does not exist yet*).

The decision this makes, and the only one worth making:

> *Save 0.35 L/lap. Costs you 0.9 s/lap, saves a stop. Net **+22 s** at the flag —
> you come out ahead of the 91.*

Not "PUSH". A mode name is not a decision. The engine's output is a **time
delta and a position outcome** for each of three points on one curve, and it
refuses to answer at all when it cannot answer honestly.

---

## 1. The loop

Carl's sketch, which is the right shape:

1. record fuel every update
2. detect a completed lap
3. compute fuel used that lap
4. rolling average, weighted to recent laps
5. predict fuel needed for the rest of the race
6. enumerate pit strategies
7. compare by total predicted race time
8. update the recommendation

Steps 1–5 **already exist and are tested** — that is `FuelCalculator`. The work
is 6–8, and the difficulty in 6–8 is not the fuel. It is the **cost model for a
stop** and the **pace consequence of carrying fuel and saving it**. Those are
coefficients, and coefficients have to be fitted to real laps.

### One correction to the loop

Do not recompute the plan on every telemetry update. Recompute the **readouts**
every frame (they are subtractions); recompute the **plan** at lap boundaries
and on pit-state changes. Enumerating strategies at 60 Hz is wasted work, and
worse, it chatters: the recommendation flips between two near-equal strategies
several times a second and the driver stops believing it. `FuelCalculator`
already solved this once — `pitArmed` is latched, not recomputed, for exactly
this reason. The strategy call needs the same treatment: a new recommendation
must beat the standing one by a **margin** before it replaces it.

---

## 2. What already exists

| Need | Where | State |
|---|---|---|
| Per-lap burn, rolling average, pit-lap rejection | `src/telemetry/fuelCalculator.ts` | Done, tested |
| Laps still to run (multiclass-correct) | `src/telemetry/lapsToFlag.ts` | Done, tested |
| Pit loss, measured not configured | `src/telemetry/pitExit.ts` (`PitLossModel`) | Done — median of observed stops |
| Where you rejoin, in positions | `src/telemetry/pitExit.ts` (`PitExitProjection`) | Done |
| Sim's own booked-stop length | `src/telemetry/damage.ts:262` `stopLengthSeconds` | Done |
| Field pace, rolling 5 | `src/telemetry/paceAverage.ts` | Done |
| Tyre wear rate + laps to the cliff | `electron/team-history.js` `tyreProjection()` | Done, session-only, in memory |
| Virtual energy per car | `veFraction` on the standings wire | Done |
| Stops per car | `src/telemetry/pitStopCounter.ts` | Done (2026-08-30) |

That is most of a strategy engine already. Three things are missing, and one of
them is a wall.

---

## 3. The corpus does not exist yet — Phase 0

**`LapRecord` stores no fuel and no tyre data.** Grep `src/telemetry/lapLog.ts`
for `fuel|tyre|wear|compound`: zero matches. Lap traces
(`src/telemetry/lapTrace.ts`) capture throttle, brake, steer, gear, speed, gs,
TC and ABS — no fuel level, no wear. `team-history.js` does record per-lap wear,
but only for our own car, only in memory, and it is thrown away with the
session.

So **the coefficients cannot be fitted from anything we currently keep.** Every
number in §5 would be invented. That is the one outcome this codebase's whole
posture is against — `pitExit.ts` refuses to estimate a pit loss until it has
watched a real stop, and this must refuse on the same terms.

Phase 0 is therefore capture, and it ships before any strategy maths is written.

**`LapRecord` v5 adds:**

```ts
fuelStartL?: number;      // level at the line, start of this lap
fuelEndL?: number;        // level at the line, end of it
fuelUsedL?: number;       // the burn, pit laps excluded as today
capacityL?: number;       // so load can be expressed as a fraction
veStartPct?: number;      // energy classes — the binding constraint there
veEndPct?: number;
wearAtLine?: [number, number, number, number];   // fl fr rl rr
compound?: string;
stintLap?: number;        // laps since the last stop — the tyre-deg x-axis
isOutLap?: boolean;
isInLap?: boolean;
```

**A new stop record**, one row per pit visit, which nothing captures today:

```ts
lap: number;
stationarySec: number;    // measured, box entry to box exit
fuelAddedL: number;
tyresChanged: boolean;
compoundFitted?: string;
totalLossSec: number;     // reuse PitLossModel's observation for our own car
```

Those two together are the training set. `stintLap` × `lapMs` gives tyre
degradation; `fuelStartL` × `lapMs` at matched tyre age gives the fuel-load
coefficient; `fuelAddedL` ÷ `stationarySec` gives the refuel rate. All of it
falls out of a handful of races once it is being written down.

**Cost of Phase 0: small.** Every value above is already on the frame at the lap
boundary — this is plumbing, not new telemetry.

---

## 4. Architecture

A new pure module, same shape as its siblings: no clock, no network, no sim
concerns, fed frames and unit-tested from synthetic ones.

```
src/telemetry/raceStrategy.ts        the engine (pure)
src/telemetry/strategyCoefficients.ts  the fitted table + lookup + refusal rules
scripts/test-strategy.js             synthetic races with a known right answer
scripts/fit-strategy.js              offline: lap log + stop log -> coefficients
```

### Data flow

```
                    lmuRestProvider (per frame)
                              |
        +---------------------+---------------------+
        |          |          |          |          |
    FuelState  lapsToFlag  PitLoss   tyreProj   standings
     (exists)   (exists)   (exists)  (exists)    (exists)
        |          |          |          |          |
        +---------------------+---------------------+
                              v
                    RaceStrategy.update()
                              |
                    coefficients(car, class, track)
                              |
                              v
                       StrategyState
                     /        |        \
              Fuel tab   overlay widget   engineer triggers
```

It hooks in exactly where `buildFuel` is called
(`src/telemetry/lmuRestProvider.ts`, the `buildFuel(...)` call site) and takes
the `FuelState` that call already produced. It adds **no new sim reads**. That
matters: everything it needs is already on the wire, so it cannot break the feed
and it costs nothing on the main thread beyond a lap-boundary recompute.

### The output

```ts
interface StrategyOption {
  mode: 'save' | 'balanced' | 'push';
  liftTargetLPerLap: number;   // 0 for push
  stops: number;
  stopLaps: number[];
  totalTimeSec: number;        // predicted, whole race
  deltaSec: number;            // vs balanced; negative is faster
  projectedPosition?: number;  // from PitExitProjection
  aheadName?: string;          // the car this outcome puts you near
  behindName?: string;
  confidence: 'measured' | 'partial' | 'none';
}

interface StrategyState {
  options: StrategyOption[];   // empty when confidence is 'none' for all
  recommended: 'save' | 'balanced' | 'push';
  fuelMarginL: number;         // to the flag on the recommended plan
  whyNot?: string;             // "no pit loss measured yet" — say it, don't guess
}
```

`whyNot` is not decoration. It is the difference between a widget that is
blank because it is broken and one that is blank because it is being honest.

---

## 5. The model

### Race time

```
T(S) = Σ lapTime(i) + Σ pitLoss(stop)
```

### Lap time

```
lapTime(i) = basePaceSec
           + kFuelSecPerL      × fuelLoadL(i)
           + tyreDeg(compound, stintLap(i))
           + kLiftSecPerLPerLap × liftTarget
```

`kFuel` is the one people underestimate. At an LMP2-ish 0.03 s/L a 75 L tank is
**2.3 s/lap** between full and empty — bigger than most tyre deg over a stint,
and the entire reason a short-fill strategy can win.

### Tyre degradation

Linear then a cliff, because that is what tyres do and what
`tyreProjection()` already models with its 25% threshold:

```
tyreDeg(c, n) = linSecPerLap × n
              + (n > cliffLap ? cliffSecPerLap × (n − cliffLap) : 0)
```

### Fuel

```
burn(i) = burnBaseLPerLap × (1 − saveFraction × liftTarget)
```

`liftTarget` is litres/lap saved. `kLift` converts that to seconds/lap lost.
**This is the hardest coefficient to fit** and the one most likely to be absent,
because drivers in the corpus rarely lift deliberately. Until it can be fitted,
`save` returns `confidence: 'none'` and the engine offers two options, not
three. That is the correct behaviour, not a degraded one.

### Pit loss

```
pitLoss = observedMedianSec                        // PitLossModel
        + max(0, fuelAddedL / refuelLPerSec − referenceStationarySec)
```

Start from the **measured** loss — it already contains the lane transit, which
is track-specific and which LMU publishes nowhere — and adjust only for a fuel
load that differs from the stops observed. Where the sim offers its own booked
stop length (`damage.ts` `stopLengthSeconds`), prefer it for the stationary part:
it is the game's own arithmetic on the actual booked service.

### The search

Small enough to brute-force; no optimiser, no solver.

```
minStops = ceil(fuelToFinishL / capacityL) − 1
candidates = { minStops, minStops + 1 }
```

For each stop count, stop laps are constrained to a feasible window (you cannot
stop before the tank allows, or after it runs dry), quantised to whole laps.
That is a few hundred candidates in a long race. Evaluate all of them, keep the
best per mode. Milliseconds, once per lap.

---

## 6. The coefficient table

One row per `(carClass, car, trackKey)`. Shipped as a JSON table fitted offline,
overridden by locally-fitted rows once enough local laps exist — same
local-first pattern as the lap database.

```json
{
  "carClass": "LMP2",
  "car": "Oreca 07",
  "trackKey": "daytona_5730",
  "n": 412,
  "fittedAt": "2026-09-14",
  "source": "local",

  "basePaceSec": 100.31,
  "burnBaseLPerLap": 2.97,
  "capacityL": 75,

  "kFuelSecPerL": 0.0312,

  "tyre": {
    "medium": { "linSecPerLap": 0.021, "cliffLap": 28, "cliffSecPerLap": 0.19 }
  },

  "kLiftSecPerLPerLap": 3.1,
  "saveFractionMax": 0.18,

  "refuelLPerSec": 2.6,
  "pitLaneLossSec": 44.2,

  "confidence": { "kFuel": "measured", "tyre": "measured", "kLift": "none" }
}
```

Per-coefficient confidence, not one flag for the row. A table can know the fuel
coefficient cold and know nothing about lift-and-coast, and the engine must be
able to offer `balanced` and `push` on that basis while refusing `save`.

`burnBaseLPerLap: 2.97` is not a placeholder — that is the measured Daytona LMP2
figure from the 2026-08-30 probe (2.94 L over 5.67 km).

### Fitting

`scripts/fit-strategy.js`, offline, over the lap log + stop log:

- **`kFuel`** — regress `lapMs` on `fuelStartL`, controlling for `stintLap`.
  Needs laps at a spread of fuel loads, which every stint provides for free.
- **`tyre`** — regress `lapMs` on `stintLap` at matched fuel load. Segmented fit
  for the cliff; refuse the cliff term until a stint has actually run past it.
- **`kLift`** — regress `lapMs` on `fuelUsedL` at matched load and tyre age.
  The weak one. Needs deliberate variation.
- **`refuelLPerSec`** — `fuelAddedL / stationarySec` across our own stops.
- Refuse any coefficient with `n` below a floor, rather than fitting noise.

---

## 7. Three modes, one curve

They are not three calculations. Compute the optimum, then sample either side:

- **balanced** — `liftTarget` that minimises `T`. Usually not zero: the optimum
  is often a small lift that comfortably secures the stop count.
- **push** — `liftTarget = 0`. Fastest laps, most fuel, sometimes an extra stop.
- **save** — the *smallest* lift that removes one stop. Not "maximum saving" —
  the interesting number is the least sacrifice that changes the stop count,
  because past that point you are giving away lap time for nothing.

If no lift removes a stop, `save` is reported as **not available** with the
reason, rather than offering a slower strategy that achieves nothing. Refusing
to show a pointless option is a feature.

Each option reports its time delta **and** its projected position via
`PitExitProjection`. Track position is the whole ballgame and the reason a
mathematically optimal strategy loses races.

---

## 8. Where AI belongs — and does not

**Not in the loop.** The maths is deterministic, must be right at 60 Hz, must be
explainable when the driver asks *why*, and must work when the connection drops
mid-stint. A model in the recompute path fails all four.

**In the engineer, which already exists.** `engineer.js` and
`engineerCommands.ts` are the right home for:

- speaking the recommendation on a trigger ("box this lap or save 0.3")
- answering *"how much do I need to save?"* as a question
- explaining a recommendation that changed, in a sentence

That is the split the app already runs everywhere else: deterministic telemetry,
conversational delivery. The strategy engine becomes another fact source for
`engineerSummary.ts`; nothing about the engineer changes structurally.

---

## 9. Phases

| Phase | What | Blocks |
|---|---|---|
| **0** | `LapRecord` v5 + stop log. Capture only, no UI. | Everything |
| **1** | `raceStrategy.ts` with pit-loss + fuel-load terms only. Two options: push / balanced. Fuel tab card. | Phase 0 shipped, a few races driven |
| **2** | Fit `kFuel` and `tyre` from the corpus; `scripts/fit-strategy.js`; ship the table. | Phase 1 |
| **3** | `kLift` and the `save` option, once enough deliberate variation exists. | Phase 2 |
| **4** | Engineer triggers and the spoken call. | Phase 3 |
| **5** | Virtual energy as an alternative binding constraint for Hypercar. | Phase 2 |

Phase 1 is genuinely useful on its own: "you are on a 3-stop, the last one is
lap 148, you have 4 L in hand" is a real pit wall, and it needs no fitted
coefficients at all.

---

## 10. Virtual energy

Do not build this on litres alone. `veFraction` is already on the wire and
Hypercar runs an **energy** budget where LMP2 does not — flat 0 all race, which
is why the VE column blanks in LMP2 sessions. A strategy engine that optimises
litres for a car actually limited by energy will recommend confidently wrong
stops.

Same loop either way. The engine takes a **budget** — litres or energy points —
and picks whichever is the binding constraint for the class. `FuelCalculator`
already generalised this once (`const budget = ...`, its thresholds are shares
of a budget precisely so one set of constants serves litres, fractions and
energy). Follow that.

---

## 11. What this must refuse

Consistent with `pitExit.ts` and the rest of the engineer:

- No pit loss observed yet → no strategy. Say *"no stop seen to measure"*.
- No coefficients for this car/track → fuel-only planning, and say so.
- Fewer than 3 clean green laps → no burn confidence, no plan.
- Race length unknown → no plan (`lapsToFlag` already refuses here).
- A `save` option that removes no stop → not offered, with the reason.

A strategy engine that always has an answer is worse than one that sometimes
says "not yet". The first kind gets believed on the lap it is wrong.
