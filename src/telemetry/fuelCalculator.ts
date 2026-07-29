/**
 * @file src/telemetry/fuelCalculator.ts
 * @module telemetry/fuelCalculator
 *
 * Pure fuel-strategy math for the fuel-calculator widget. Given a stream of
 * per-frame fuel readings it tracks per-lap consumption and derives the numbers
 * a driver actually wants mid-race: average burn, laps of fuel left, laps still
 * to run, fuel needed to finish, the surplus/deficit, and when the pit window
 * opens.
 *
 * The class is deliberately free of any sim/shared-memory concerns so it is
 * deterministic and unit-testable: feed it {@link FuelUpdate}s and read back a
 * {@link FuelState}. Both the rF2 provider and (optionally) the simulator can
 * reuse it.
 */

import { UNKNOWN_VALUE, type FuelState } from './types';

/** Per-frame inputs the calculator needs to update its estimate. */
export interface FuelUpdate {
  /** Current fuel in the tank, litres. */
  currentFuelLiters: number;
  /** Tank capacity, litres (`<= 0` / unknown allowed). */
  capacityLiters: number;
  /** Player laps completed so far (monotonic; used to detect lap boundaries). */
  lapsCompleted: number;
  /**
   * Total race laps, or `0`/{@link UNKNOWN_VALUE} for a timed race (in which
   * case {@link timeRemainingSec} + {@link avgLapTimeSec} estimate the laps
   * left).
   */
  totalRaceLaps: number;
  /** Seconds left in a timed race, or {@link UNKNOWN_VALUE} if lap-based. */
  timeRemainingSec: number;
  /** Reference lap time in seconds, used to convert remaining time → laps. */
  avgLapTimeSec: number;
  /**
   * How far round the current lap the car is, `0..1`. Required for
   * {@link FuelState.pitThisLap} — "can I get round again" depends on how much
   * of this lap is still to pay for. {@link UNKNOWN_VALUE} (or omitted) when the
   * road position isn't known, in which case the alarm is simply not raised.
   */
  lapFraction?: number;
}

/** Default number of recent laps averaged for the burn estimate. */
const DEFAULT_SAMPLE_WINDOW = 5;

/**
 * Absolute upper bound (litres) on a single lap's recorded burn. A lap can
 * never consume more than the tank holds, so the known tank capacity is used
 * when available and this is only the fallback when capacity is unknown.
 */
const MAX_PLAUSIBLE_LAP_BURN_L = 100;

/**
 * Once a rolling average exists, reject a new per-lap sample larger than this
 * multiple of it. Real per-lap fuel use is very stable within a stint, so a
 * sample several times the running average is almost certainly a bad reading
 * that slipped the provider's frame gate on a lap boundary; recording it would
 * skew the average for a full window of laps. Bootstrapping samples (before any
 * average exists) are always accepted.
 */
const BURN_OUTLIER_FACTOR = 3;

/**
 * How much of a lap's burn a driver can realistically claw back by saving —
 * lifting and coasting, short-shifting, leaning the mix — expressed as a
 * fraction of the rolling average.
 *
 * This constant sets what the "pit this lap" alarm *means*. The alarm's whole
 * job is to say that saving has stopped being an option, so it has to model how
 * much saving was on the table. Assume too much and the alarm waits until the
 * situation is beyond hope, arriving after the pit entry it was supposed to
 * warn about. Assume too little and it cries wolf on laps a driver could
 * comfortably have nursed home.
 *
 * 10% sits at the low end of what lift-and-coast actually returns in these cars
 * (roughly 5–15%, at around a second a lap), which errs the right way: the alarm
 * fires a little sooner than strictly necessary rather than a little too late.
 * A missed pit call costs a race; an early one costs a few seconds.
 */
const MAX_SAVE_FRACTION = 0.1;

/**
 * Fuel held back beyond the arithmetic, as a fraction of one lap's burn. Covers
 * what the model does not: the lap you are on may be slower than the average,
 * the in-lap still has to reach the box, and a pump does not run a tank to
 * literally zero. 5% of a lap is a few hundred millilitres — enough to absorb
 * the noise, too little to move the call by a whole lap.
 */
const PIT_RESERVE_LAPS = 0.05;

/**
 * Stateful fuel-usage tracker. One instance per player car / session; call
 * {@link reset} when the session or car changes.
 */
export class FuelCalculator {
  private readonly window: number;
  /** Rolling per-lap consumption samples (litres). */
  private readonly burns: number[] = [];
  /** Last observed completed-lap count, to detect a new lap. */
  private lastLapsCompleted: number = UNKNOWN_VALUE;
  /** Fuel level captured at the start of the current lap. */
  private fuelAtLapStart: number = UNKNOWN_VALUE;
  /**
   * Whether the "pit this lap" call has been made and is standing.
   *
   * Latched rather than recomputed clean each frame. The call is a decision, not
   * a reading: the margin it turns on closes slowly, so around the boundary the
   * raw condition can sit on the fence and chatter — and an alarm that blinks
   * out just as the driver reaches the pit entry is worse than one that never
   * fired, because they will have started to believe it. Cleared only by fuel
   * actually going in.
   */
  private pitArmed = false;
  /**
   * Fuel level at the previous sample, so a refuel is spotted the moment the
   * level rises rather than a lap later. {@link UNKNOWN_VALUE} before the first.
   */
  private lastFuel: number = UNKNOWN_VALUE;

  /**
   * @param sampleWindow - How many recent laps to average (default 5). Smaller
   *   reacts faster to pace/tyre changes; larger is steadier.
   */
  public constructor(sampleWindow: number = DEFAULT_SAMPLE_WINDOW) {
    this.window = Math.max(1, Math.floor(sampleWindow));
  }

  /** Clears all history. Call on session change or car swap. */
  public reset(): void {
    this.burns.length = 0;
    this.lastLapsCompleted = UNKNOWN_VALUE;
    this.fuelAtLapStart = UNKNOWN_VALUE;
    this.pitArmed = false;
    this.lastFuel = UNKNOWN_VALUE;
  }

  /**
   * Seeds the rolling average with a known per-lap figure (e.g. from a prior
   * stint), so the widget shows a sensible estimate before a full lap has been
   * observed. Ignored for non-positive values.
   */
  public seedPerLap(litersPerLap: number): void {
    if (litersPerLap > 0) this.burns.push(litersPerLap);
  }

  /** Current rolling-average burn, litres/lap, or {@link UNKNOWN_VALUE}. */
  public get perLapAverage(): number {
    if (this.burns.length === 0) return UNKNOWN_VALUE;
    const sum = this.burns.reduce((a, b) => a + b, 0);
    return sum / this.burns.length;
  }

  /**
   * Feeds one frame of data and returns the current fuel strategy.
   *
   * Consumption is measured across completed laps only: when
   * {@link FuelUpdate.lapsCompleted} increments, the fuel used since the last
   * lap boundary is recorded (positive deltas only, so a refuel/pit stop does
   * not corrupt the average).
   *
   * @param u - Current frame inputs.
   * @returns A fully-populated {@link FuelState}. Unknown quantities use
   *   {@link UNKNOWN_VALUE}.
   */
  public update(u: FuelUpdate): FuelState {
    const fuel = Math.max(0, u.currentFuelLiters);

    // Fuel went IN — a stop, or a reset to a full tank. That is the one event
    // that answers the pit call, so it is the one thing that stands it down.
    //
    // Measured SAMPLE TO SAMPLE, not against the level at the start of the lap.
    // Burning fuel only ever takes the level down, so any rise beyond float
    // noise is the rig putting some in, and that is true the instant the hose
    // goes on. Comparing against the lap's starting level — which is what this
    // did first — is a whole lap stale by the time a driver reaches their box:
    // take on two laps' worth after a lap that burned three and the level is
    // still BELOW where the lap began, so the alarm never stands down and
    // follows the driver back out onto the circuit.
    const eps = (u.capacityLiters > 0 ? u.capacityLiters : 1) * 0.002;
    if (this.lastFuel !== UNKNOWN_VALUE && fuel > this.lastFuel + eps) this.pitArmed = false;
    this.lastFuel = fuel;

    // --- lap-boundary detection -> record per-lap burn ------------------
    let crossedLine = false;
    if (this.lastLapsCompleted === UNKNOWN_VALUE) {
      // First observation: anchor the lap-start fuel, no burn yet.
      this.lastLapsCompleted = u.lapsCompleted;
      this.fuelAtLapStart = fuel;
    } else if (u.lapsCompleted < this.lastLapsCompleted) {
      // Laps went backwards (session restart / new car): re-anchor.
      this.reset();
      this.lastLapsCompleted = u.lapsCompleted;
      this.fuelAtLapStart = fuel;
    } else if (u.lapsCompleted > this.lastLapsCompleted) {
      const burn = this.fuelAtLapStart - fuel;
      // A lap cannot burn more than the tank holds; fall back to an absolute
      // ceiling when capacity is unknown.
      const maxBurn = u.capacityLiters > 0 ? u.capacityLiters : MAX_PLAUSIBLE_LAP_BURN_L;
      // Reject a spike well above the established average (a bad reading on a lap
      // boundary) so it cannot poison the rolling average; the first samples,
      // before any average exists, are always accepted to bootstrap it.
      const avg = this.perLapAverage;
      const isOutlier = avg > 0 && burn > avg * BURN_OUTLIER_FACTOR;
      // Only count plausible consumption (ignore refuel/telemetry noise, values
      // beyond the tank, and outlier spikes).
      if (burn > 0 && burn <= maxBurn && !isOutlier && Number.isFinite(burn)) {
        this.burns.push(burn);
        while (this.burns.length > this.window) this.burns.shift();
      }
      this.lastLapsCompleted = u.lapsCompleted;
      this.fuelAtLapStart = fuel;
      crossedLine = true;
    }

    // --- derive strategy -------------------------------------------------
    const perLap = this.perLapAverage;
    const capacity = u.capacityLiters > 0 ? u.capacityLiters : UNKNOWN_VALUE;

    const lapsRemaining = perLap > 0 ? fuel / perLap : UNKNOWN_VALUE;
    const lapsToFinish = this.lapsToFinish(u);
    const fuelToFinish =
      perLap > 0 && lapsToFinish !== UNKNOWN_VALUE ? lapsToFinish * perLap : UNKNOWN_VALUE;
    const fuelDelta = fuelToFinish !== UNKNOWN_VALUE ? fuel - fuelToFinish : UNKNOWN_VALUE;
    const refuel = fuelDelta !== UNKNOWN_VALUE ? Math.max(0, -fuelDelta) : 0;

    const state: FuelState = {
      levelLiters: round1(fuel),
      capacityLiters: capacity === UNKNOWN_VALUE ? UNKNOWN_VALUE : round1(capacity),
      perLapAvgLiters: perLap > 0 ? round2(perLap) : UNKNOWN_VALUE,
      lapsRemaining: lapsRemaining !== UNKNOWN_VALUE ? round1(lapsRemaining) : UNKNOWN_VALUE,
      lapsToFinish,
      fuelToFinishLiters: fuelToFinish !== UNKNOWN_VALUE ? round1(fuelToFinish) : UNKNOWN_VALUE,
      fuelDeltaLiters: fuelDelta !== UNKNOWN_VALUE ? round1(fuelDelta) : UNKNOWN_VALUE,
      refuelToFinishLiters: round1(refuel),
    };

    // Pit window: earliest lap by which the tank runs dry — i.e. the last lap
    // you can complete before needing fuel. Only meaningful when we know burn.
    if (lapsRemaining !== UNKNOWN_VALUE && lapsRemaining >= 0) {
      state.pitWindowOpenLap = u.lapsCompleted + Math.floor(lapsRemaining);
    }

    // The call is taken once per lap, as the line is crossed — see
    // {@link decideAtLine} for why it cannot be a running comparison.
    if (crossedLine) this.pitArmed = this.decideAtLine(lapsRemaining, lapsToFinish);
    if (this.strandedThisLap(u, lapsRemaining, lapsToFinish)) this.pitArmed = true;
    if (this.pitArmed) state.pitThisLap = true;

    return state;
  }

  /**
   * Taken as the car crosses the line: **from here, can it get round twice?**
   * If not, it has to come in at the end of the lap it is just starting.
   *
   * Worked in **laps of fuel** rather than litres, so the same arithmetic serves
   * the litre tank, the 0..1 fuel fraction of a spectated car, and the virtual
   * energy budget in percent — the units cancel and only the ratios matter. Not
   * pitting costs this lap plus a whole further one, each at
   * `1 − MAX_SAVE_FRACTION` of an average lap if driven as economically as
   * anyone realistically can, plus {@link PIT_RESERVE_LAPS}.
   *
   * ## Why this is a per-lap decision and not a running comparison
   * The obvious implementation re-asks the question every frame, against the
   * fuel left and the road still to cover. It is wrong in the one case that
   * matters. Both sides of that comparison fall as the lap runs — the tank
   * drains at the real burn rate, the requirement shrinks at the *saving* rate —
   * so the margin between them erodes by only the difference, a tenth of a lap's
   * fuel over a whole lap. A car that begins the lap a hair inside the limit
   * therefore trips it a hair before the line: the alarm arrives at the pit
   * entry it was meant to warn about, which is the one outcome that makes it
   * useless.
   *
   * Deciding at the line instead gives an answer that is stable for the whole
   * lap and arrives with a whole lap in hand — which is the point. The driver
   * learns on the pit straight that this is the lap, not at the last corner.
   */
  private decideAtLine(lapsRemaining: number, lapsToFinish: number): boolean {
    // No burn history yet — nothing to project with, so make no claim.
    if (lapsRemaining === UNKNOWN_VALUE || lapsRemaining < 0) return false;
    // The last lap of the race: there is no further lap to carry fuel for, and
    // sending someone down the pit lane on it would cost them the finish the
    // alarm exists to protect. An unknown race length (practice, or a timed
    // session we can't read) is NOT treated as the last lap — running dry there
    // still ruins the run.
    if (lapsToFinish !== UNKNOWN_VALUE && lapsToFinish <= 1) return false;
    return lapsRemaining < 2 * (1 - MAX_SAVE_FRACTION) + PIT_RESERVE_LAPS;
  }

  /**
   * The continuous safety net: not enough left to reach the line at all, so the
   * car is going to stop on track during this lap.
   *
   * This one has to be live rather than per-lap, because it catches what the
   * line decision cannot see — attaching mid-lap, a reading that was wrong when
   * the call was taken, or fuel disappearing faster than any lap average
   * predicted. Being past the pit entry when it fires is not a flaw here: at
   * this point the choice is between coasting to the pit lane and stopping on
   * the circuit, and the driver deserves to know which one they are doing.
   */
  private strandedThisLap(u: FuelUpdate, lapsRemaining: number, lapsToFinish: number): boolean {
    const frac = u.lapFraction;
    if (typeof frac !== 'number' || frac < 0 || frac > 1) return false;
    if (lapsRemaining === UNKNOWN_VALUE || lapsRemaining < 0) return false;
    if (lapsToFinish !== UNKNOWN_VALUE && lapsToFinish <= 1) return false;
    return lapsRemaining < (1 - frac) * (1 - MAX_SAVE_FRACTION) + PIT_RESERVE_LAPS;
  }

  /**
   * Laps still required to reach the finish. Uses the lap count directly for a
   * lap race, or estimates from remaining time and lap pace for a timed race.
   */
  private lapsToFinish(u: FuelUpdate): number {
    if (u.totalRaceLaps > 0) {
      return Math.max(0, u.totalRaceLaps - u.lapsCompleted);
    }
    if (u.timeRemainingSec > 0 && u.avgLapTimeSec > 0) {
      // Round up: you must complete the lap you are on when time expires.
      return Math.max(0, Math.ceil(u.timeRemainingSec / u.avgLapTimeSec));
    }
    return UNKNOWN_VALUE;
  }
}

/**
 * Resolve the "pit this lap" alarm across the two budgets — the ONLY place
 * {@link FuelState.pitThisLap} may be set on an outgoing frame.
 *
 * Either the tank or the energy allowance can be the one that runs out first,
 * and the alarm has to name which: a fuel call and an energy call send the
 * driver to different rows of the pit menu, and a driver told to pit for fuel
 * who then refuels and finds the alarm still up has been told the wrong thing.
 * Energy wins a tie because in these cars it is nearly always the tighter of the
 * two, so when both trip it is the one that actually decides the stop.
 *
 * Cleared outright while the car is in the pit lane: the alarm exists to get the
 * driver to come in, and once they have, it is only noise sitting over the
 * numbers they now need to read.
 *
 * ## Why the flag is deleted before the decision is applied
 * Both budgets run their own {@link FuelCalculator}, and each publishes its own
 * `pitThisLap` inside the block it returns. A plain
 * `{...fuel, ...energy, ...decision}` therefore cannot switch the alarm OFF: a
 * decision of "no alarm" is an *absent* key, and an absent key does not
 * overwrite a present one. The in-pit suppression silently did nothing, and an
 * energy-driven alarm reached the widgets with no reason attached — so it
 * rendered with the default wording and told a driver who was low on virtual
 * energy to pit for fuel, over and over, right through the stop that fixed
 * neither.
 *
 * @param base       - The merged fuel + energy block, before the decision.
 * @param fuelArmed  - The litre budget's own call.
 * @param energyArmed- The virtual-energy budget's own call.
 * @param inPit      - Whether the car is in the pit lane or its garage stall.
 */
export function resolvePitCall(
  base: FuelState,
  fuelArmed: boolean,
  energyArmed: boolean,
  inPit: boolean,
): FuelState {
  const out: FuelState = { ...base };
  delete out.pitThisLap;
  delete out.pitThisLapReason;
  if (inPit) return out;
  if (energyArmed) return { ...out, pitThisLap: true, pitThisLapReason: 'energy' };
  if (fuelArmed) return { ...out, pitThisLap: true, pitThisLapReason: 'fuel' };
  return out;
}

/** Rounds to one decimal place. */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Rounds to two decimal places. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
