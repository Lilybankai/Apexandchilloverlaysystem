/**
 * @file src/telemetry/types.ts
 * @module telemetry/types
 *
 * The **telemetry contract** for the Apex & Chill overlay system.
 *
 * This module is the single shared schema between the telemetry producers
 * (simulator provider, rFactor2 / Le Mans Ultimate shared-memory provider) and
 * every consumer (WebSocket broadcast + browser overlay widgets). A
 * {@link TelemetryFrame} is a fully **normalized**, source-agnostic snapshot of
 * the current on-track state; providers are responsible for mapping their raw
 * data (shared-memory structs, simulated values, …) into this shape so the
 * overlays never need to know which sim is running.
 *
 * ### Conventions
 * - All angles are in **degrees**, temperatures in **degrees Celsius**,
 *   distances/gaps in **seconds** unless the field name says otherwise
 *   (e.g. `*Kph`, `*Kpa`, `*Liters`).
 * - Normalized inputs (throttle, brake, wear, rain, …) are in the range
 *   **0..1** unless noted (steering is **-1..1**).
 * - Unknown / not-yet-available numeric values use **-1** (never `NaN` or
 *   `null`) so the wire format stays plain JSON and widgets can branch on a
 *   single sentinel.
 * - The schema is additive: new optional fields may be appended, but existing
 *   fields must not change meaning without bumping {@link TELEMETRY_SCHEMA_VERSION}.
 */

/**
 * Schema version of the {@link TelemetryFrame} wire format. Bump on any
 * breaking change so consumers can detect an incompatible producer.
 */
export const TELEMETRY_SCHEMA_VERSION = 1 as const;

/** Sentinel used for unknown / not-yet-available numeric values. */
export const UNKNOWN_VALUE = -1 as const;

/* -------------------------------------------------------------------------- */
/*  Enumerations (string unions — cheap to serialize, self-describing)         */
/* -------------------------------------------------------------------------- */

/** Which producer generated a frame. */
export type TelemetrySource = 'simulator' | 'rf2' | 'lmu';

/** High-level session category. */
export type SessionType =
  | 'unknown'
  | 'testday'
  | 'practice'
  | 'qualifying'
  | 'warmup'
  | 'race';

/** Where the session currently is in its lifecycle. */
export type SessionPhase =
  | 'unknown'
  | 'garage'
  | 'gridwalk'
  | 'formation'
  | 'countdown'
  | 'green'
  | 'fullCourseYellow'
  | 'redFlag'
  | 'checkered'
  | 'cooldown';

/**
 * The phases that come **before** a session is actually running.
 *
 * Lives beside the type it partitions rather than in each provider, because all
 * three of them have to agree on it: a widget that showed a pre-session header
 * on `lmu` and a lap counter on `rf2` for the same moment on the grid would be
 * worse than having neither.
 *
 * `countdown` counts as not-started deliberately — the lights are still on, and
 * the driver on the grid is still being told which session they are about to
 * run rather than what lap they are on. `formation` likewise: the lap does not
 * count.
 */
const PRE_GREEN_PHASES: ReadonlySet<SessionPhase> = new Set<SessionPhase>([
  'garage',
  'gridwalk',
  'formation',
  'countdown',
]);

/** Whether this phase is before the session has gone green. */
export function isPreGreen(phase: SessionPhase): boolean {
  return PRE_GREEN_PHASES.has(phase);
}

/** Global flag state shown to the field. */
export type FlagState =
  | 'none'
  | 'green'
  | 'yellow'
  | 'doubleYellow'
  | 'blue'
  | 'white'
  | 'red'
  | 'checkered';

/** Coarse sky/precipitation descriptor for a weather slot. */
export type SkyState = 'clear' | 'partlyCloudy' | 'overcast' | 'lightRain' | 'rain' | 'storm';

/* -------------------------------------------------------------------------- */
/*  Session                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Session-wide state — the same for every car on track.
 */
export interface SessionState {
  /** Session category (practice / qualifying / race / …). */
  type: SessionType;
  /** Lifecycle phase (countdown / green / checkered / …). */
  phase: SessionPhase;
  /** Global flag currently displayed. */
  flag: FlagState;
  /** Human-readable track name, e.g. `"Silverstone (ELMS)"`. */
  track: string;
  /** Optional layout/config name when the track exposes one. */
  trackConfig?: string;
  /** Seconds remaining in a timed session; {@link UNKNOWN_VALUE} if lap-based. */
  timeRemainingSec: number;
  /** Total laps for a lap-based session; `0` when the session is timed. */
  totalLaps: number;
  /**
   * Estimated laps still to run, for a **timed** race — LMU only gives a clock,
   * so this is derived from the time remaining and the leader's lap pace.
   * {@link UNKNOWN_VALUE} for lap-based sessions or when pace isn't known yet.
   */
  lapsRemaining: number;
  /** Race leader's current lap number (1-based); {@link UNKNOWN_VALUE} if unknown. */
  currentLap: number;
  /** Number of cars/entries in the session. */
  numCars: number;
  /** Optional server / lobby name. */
  serverName?: string;
  /**
   * `true` before the session has actually gone green — sitting in the garage,
   * on the grid, on a formation lap or in the countdown.
   *
   * The widgets need this as its own fact rather than inferring it from an
   * absent lap count, because "no laps yet" and "this session has no lap count"
   * look identical on the wire and mean completely different things. Before the
   * flag drops there is no lap 1 and no clock running down, so a counter is the
   * wrong thing to show; what the driver wants is *which session am I about to
   * run, and how long is it*. See {@link scheduledLengthSec}.
   */
  notStarted: boolean;
  /**
   * The session's **full booked length** in seconds, independent of how much of
   * it is left — so a widget can say "PRACTICE · 30 MIN" while sitting in the
   * garage, where {@link timeRemainingSec} has nothing useful to say yet.
   *
   * {@link UNKNOWN_VALUE} for a lap-based session (use {@link totalLaps}) or
   * when the sim has not published a length.
   */
  scheduledLengthSec: number;
}

/* -------------------------------------------------------------------------- */
/*  Player car                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Raw driver input channels for the player's car.
 * These drive the pedal-input / trail-braking trace widget.
 */
export interface PedalInputs {
  /** Throttle application, `0` (lifted) .. `1` (flat). */
  throttle: number;
  /** Brake application, `0` (off) .. `1` (max). */
  brake: number;
  /** Clutch application, `0` (engaged) .. `1` (fully depressed). */
  clutch: number;
  /** Steering, `-1` (full left) .. `0` (centre) .. `1` (full right). */
  steer: number;
  /**
   * Traction-control intervention strength, `0` (none) .. `1` (fully cut):
   * how much throttle TC is currently taking away from the driver's input
   * (unfiltered − filtered). Omitted/`0` when the sim doesn't expose it.
   */
  tc?: number;
  /**
   * ABS intervention strength, `0` (none) .. `1` (fully released): how much
   * brake ABS is currently bleeding off the driver's input. Omitted/`0` when
   * the sim doesn't expose it.
   */
  abs?: number;
}

/**
 * Vehicle **motion** channels for the player's car — G-forces, rotation rates
 * and attitude. Drives the motion widget's three modes.
 *
 * All values are already normalised out of ISI's axis convention into a
 * driver-facing one by {@link decodeMotion}; see `telemetry/motion.ts` for the
 * sign definitions, which is the only place they should be reasoned about.
 */
export interface MotionState {
  /** Lateral G; positive = acceleration toward the car's RIGHT. */
  latG: number;
  /**
   * Longitudinal G; positive = **braking**, negative = accelerating. This is a
   * deliberate display convention (the dot moves forward under brakes, the way
   * the driver is thrown), not the physics sign — see `telemetry/motion.ts`.
   */
  lonG: number;
  /**
   * Vertical G, **zero-centred**: the sim cancels gravity against the normal
   * force, so flat ground reads ~`0` at any speed. Positive over a compression,
   * negative over a crest. Verified live — see `telemetry/motion.ts`.
   */
  vertG: number;
  /** Yaw rate, rad/s; positive = nose swinging RIGHT. */
  yawRate: number;
  /** Pitch rate, rad/s; positive = nose rising. */
  pitchRate: number;
  /** Roll rate, rad/s; positive = right side rising. */
  rollRate: number;
  /** Pitch attitude, degrees; positive = nose UP. */
  pitch: number;
  /** Roll attitude, degrees; positive = right side UP. */
  roll: number;
  /** World heading, degrees. Only meaningful as a rate of change. */
  heading: number;
  /**
   * Angle between where the nose points and where the car is actually
   * travelling, degrees; positive = travelling to the RIGHT of the nose.
   * {@link UNKNOWN_VALUE} below walking pace, where direction-of-travel is
   * noise. Needs no per-car calibration — unlike a true understeer/oversteer
   * figure, which would require wheelbase and steering ratio.
   */
  slipAngle: number;
  /** Ground-plane speed, m/s. Carried because the yaw/lat consistency check
   * and the slip-angle floor both need it alongside the other channels. */
  speedMs: number;
}

/** Player lap-timing readouts, all times in seconds. */
export interface LapTiming {
  /** Elapsed time on the current lap; {@link UNKNOWN_VALUE} if unknown. */
  current: number;
  /** Last completed lap time; {@link UNKNOWN_VALUE} if none yet. */
  last: number;
  /** Personal best lap this session; {@link UNKNOWN_VALUE} if none yet. */
  best: number;
  /**
   * Live delta to the reference lap (personal best), in seconds.
   * Negative = ahead / faster, positive = behind / slower.
   * {@link UNKNOWN_VALUE} when no reference exists.
   */
  delta: number;
  /** Current sector, `1`..`3`; {@link UNKNOWN_VALUE} if unknown. */
  sector: number;
}

/**
 * Pacelogic-style dual lap deltas (all seconds; negative = ahead / faster,
 * {@link UNKNOWN_VALUE} until the relevant reference lap exists).
 *
 * - **Delta T** — time delta at the same track position (`t_now − t_ref(d)`);
 *   the classic predictive delta bar.
 * - **Delta V** — progress delta at the same elapsed time; how far ahead/behind
 *   in track progress right now, converted to seconds via the reference pace.
 *
 * Each is provided against three references: the **session** best lap, the
 * **all-time** best lap (persisted across sessions), and the **last** lap.
 */
export interface PaceDeltas {
  /** Delta T vs the session-best lap. */
  tSession: number;
  /** Delta T vs the all-time-best lap. */
  tAllTime: number;
  /** Delta T vs the last completed lap. */
  tLast: number;
  /** Delta V vs the session-best lap. */
  vSession: number;
  /** Delta V vs the all-time-best lap. */
  vAllTime: number;
  /** Delta V vs the last completed lap. */
  vLast: number;
  /** Best-based projected time for the current lap (`sessionBest + tSession`). */
  predictedLapSec: number;
  /** Adopted session-best lap time (s), or {@link UNKNOWN_VALUE}. */
  refSessionSec: number;
  /** Adopted all-time-best lap time (s), or {@link UNKNOWN_VALUE}. */
  refAllTimeSec: number;
  /** Last completed lap time (s), or {@link UNKNOWN_VALUE}. */
  lastLapSec: number;
}

/** State of a single tyre/corner. */
export interface TyreState {
  /**
   * Primary/representative temperature in °C — the **inner-liner** temp when the
   * provider has it, which is the number LMU's in-game HUD shows. Falls back to
   * the surface average or `UNKNOWN_VALUE` when unavailable.
   */
  tempC: number;
  /** Surface (contact-patch) average temperature in °C, when available. */
  surfaceTempC?: number;
  /** Inner-shoulder temperature in °C, when available. */
  innerC?: number;
  /** Centre temperature in °C, when available. */
  middleC?: number;
  /** Outer-shoulder temperature in °C, when available. */
  outerC?: number;
  /** Cold/hot pressure in kPa, when available. */
  pressureKpa?: number;
  /** Remaining tread, `0` (worn out) .. `1` (fresh). */
  wear: number;
  /** Fitted compound label (e.g. `"Soft"`, `"Wet"`), when known. */
  compound?: string;
}

/** The four corners of the player's car. */
export interface TyreSet {
  frontLeft: TyreState;
  frontRight: TyreState;
  rearLeft: TyreState;
  rearRight: TyreState;
}

/**
 * Vertical load and suspension state at a single corner.
 *
 * Every threshold and unit here is set in {@link module:telemetry/chassis} —
 * nothing downstream decides what counts as overloaded or airborne.
 */
export interface CornerState {
  /** Vertical tyre load through the contact patch, Newtons. `0` = airborne. */
  loadN: number;
  /**
   * This corner's load as a fraction of all four, `0..1`. Instantaneous and
   * exact — needs no calibration, so it is the channel to trust when
   * {@link ChassisState.calibrated} is false.
   */
  shareOfTotal: number;
  /**
   * Load relative to this corner's own learned normal, where `1` is typical,
   * `>1` loaded and `<1` light. {@link UNKNOWN_VALUE} before the reference has
   * converged. See the calibration note in {@link module:telemetry/chassis}.
   */
  loadRatio: number;
  /** The learned reference load this ratio is measured against, Newtons. */
  referenceLoadN: number;
  /** Suspension travel in mm, positive = compressed. */
  deflectionMm: number;
  /** Chassis height above the road at this corner, mm. */
  rideHeightMm: number;
  /** Pushrod/spring force, Newtons. {@link UNKNOWN_VALUE} when unavailable. */
  suspForceN: number;
  /** Fraction of the contact patch gripping rather than sliding, `0..1`. */
  gripFract: number;
  /** Load has effectively gone — the wheel is off the road. */
  airborne: boolean;
  /** Still touching, but carrying far less than its normal load. */
  light: boolean;
  /** Carrying substantially more than its normal load. */
  overloaded: boolean;
}

/**
 * Four-corner load distribution and suspension state for the player's car.
 *
 * Omitted from {@link PlayerState} when spectating or when the sim does not
 * populate the wheel block — absent rather than zeroed, so a widget can tell
 * "no data" from "a car sitting perfectly flat".
 */
export interface ChassisState {
  frontLeft: CornerState;
  frontRight: CornerState;
  rearLeft: CornerState;
  rearRight: CornerState;
  /** Sum of all four corner loads, Newtons. Tracks downforce with speed. */
  totalLoadN: number;
  /** Front axle's share of total load, `0..1`. `0.5` is an even split. */
  frontShare: number;
  /** Rear axle's share, `0..1`. Always `1 - frontShare`. */
  rearShare: number;
  /** Left side's share of total load, `0..1`. Rises in a right-hand corner. */
  leftShare: number;
  /** Right side's share, `0..1`. Always `1 - leftShare`. */
  rightShare: number;
  /**
   * The FL+RR diagonal's share of total load, `0..1`. `0.5` is a square car;
   * away from it one diagonal is carrying the car.
   */
  crossShare: number;
  /** How many corners are currently reading airborne, `0..4`. */
  wheelsAirborne: number;
  /**
   * Whether the per-corner reference has converged. While `false`, `loadRatio`
   * and the `light`/`overloaded` flags are not yet meaningful and consumers
   * should fall back to {@link CornerState.shareOfTotal}.
   */
  calibrated: boolean;
}

/**
 * What the driver has selected on the sim's `DAMAGE:` pit-menu entry.
 *
 * `'unavailable'` and `'none'` are deliberately distinct: the first means the
 * car is clean so the sim offers nothing to repair, the second means there IS
 * damage and the driver has chosen to drive on with it.
 */
export type RepairSelection = 'none' | 'body' | 'all' | 'unavailable';

/**
 * Chassis **damage** and what the sim says it costs to repair.
 *
 * Sourced from LMU's repair screen over REST, not shared memory — the inherited
 * ISI damage block is present in the struct but LMU does not populate it. See
 * `telemetry/damage.ts` for the probe evidence.
 */
export interface DamageState {
  /** Bodywork/aero damage severity, `0..1`, raw from the sim. */
  aero: number;
  /** Per-corner suspension damage `[FL, FR, RL, RR]`, each `0..1`. */
  suspension: [number, number, number, number];
  /**
   * Brake disc thickness per corner `[FL, FR, RL, RR]` in **mm** (the sim
   * reports metres). {@link UNKNOWN_VALUE} per corner when unpublished.
   */
  brakeThicknessMm: [number, number, number, number];
  /** Count of bodywork parts that have come off, or {@link UNKNOWN_VALUE}. */
  partsDetached: number;
  /** The worst severity across every component, `0..1`. */
  worst: number;
  /** Whether anything is damaged beyond the noise floor. */
  hasDamage: boolean;
  /**
   * Seconds to repair everything — the sim's own live figure
   * (`pitStopTimes.times.FixAllDamage`), which tracks actual damage rather than
   * being a static config value. {@link UNKNOWN_VALUE} when unpublished.
   *
   * Deliberately NOT a whole-stop estimate: tyre and fuel time are not folded
   * in, because that total depends on concurrency flags this codebase has not
   * verified against a real stop.
   */
  repairSeconds: number;
  /** Seconds to repair bodywork only (`FixAeroDamage`), or unknown. */
  repairBodySeconds: number;
  /** What the pit menu currently has selected. */
  repairSelection: RepairSelection;
  /** The live `DAMAGE:` menu options, e.g. `["Do Not Repair", …]`. */
  repairOptions: string[];
  /**
   * Seconds to change the tyres currently selected in the pit menu — `0` when
   * none are, {@link UNKNOWN_VALUE} when the sim publishes no figure.
   *
   * Reported **alongside** {@link repairSeconds}, never summed with it. The
   * sim's `TireTimeConcurrent` flag decides whether the two overlap, and that
   * flag has not been verified against a real stop; two honest figures the
   * driver can add up beat one total that may be wrong by the whole tyre time.
   */
  tyreChangeSeconds: number;
  /** How many corners have a tyre change selected, `0..4`. */
  tyreCornersSelected: number;
  /**
   * The sim's **own total stop length** in seconds for whatever the pit menu
   * currently has selected (`pitStopLength.timeInSeconds`), or
   * {@link UNKNOWN_VALUE}.
   *
   * Read, never derived. Verified equal to `FixAllDamage + TwoTireChange` to
   * eleven decimal places on a live stop — which is also what settled that the
   * sim **adds** repair and tyre time rather than overlapping them.
   *
   * The real stop runs a few seconds longer: `FixRandomDelay` (≤5 s) and
   * `RandomTireDelay` (≤1 s) are drawn when it happens and are not in this
   * figure.
   */
  stopLengthSeconds: number;
  /**
   * The largest **unpublished** delay the sim can add to this stop, in seconds —
   * `FixRandomDelay` plus `RandomTireDelay`, counted only for the work actually
   * booked in. {@link UNKNOWN_VALUE} when the sim publishes neither.
   *
   * {@link stopLengthSeconds} is a floor, not a prediction: the draw happens
   * when the stop does and appears nowhere beforehand. Measured — a stop with a
   * published total of 184.5 s finished at 187.7 s, a 3.2 s residual against a
   * 6 s cap. This is what lets the widget quote a range instead of a number that
   * is always a few seconds optimistic.
   */
  randomDelayMaxSeconds: number;
}

/* -------------------------------------------------------------------------- */
/*  Pit stop                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Where a car is in a pit stop, normalized across providers.
 *
 * These are ISI's own `mPitState` stages, which LMU inherits and publishes as
 * strings on `/rest/watch/standings`. The one that matters is `stopped`: it is
 * the only stage where the crew is on the car, and therefore the only stage
 * during which a "how long until I'm released" countdown means anything.
 *
 *   `none`      not pitting.
 *   `request`   a stop has been requested — the car may still be out on track.
 *   `entering`  in the pit lane, heading for the box.
 *   `stopped`   stationary in the box; **work is happening**.
 *   `exiting`   released, leaving the lane.
 */
export type PitPhase = 'none' | 'request' | 'entering' | 'stopped' | 'exiting';

/**
 * The player's live pit stop: which stage it is at, and — once the crew starts
 * — how long they have been working against how long the stop was booked for.
 *
 * ## Why the clock is measured, not predicted
 * {@link DamageState.stopLengthSeconds} is the sim's own total for the selected
 * work, and it is a **floor**: LMU draws `FixRandomDelay` (≤5 s) and
 * `RandomTireDelay` (≤1 s) when the stop actually happens, and publishes only
 * the caps. So a countdown cannot be a prediction of the release. What it can be
 * — and what this is — is the booked time counting down against a real elapsed
 * clock, with the sim's own remaining slack named once the booked time is up.
 *
 * The planned figure is captured at the instant work begins and then held. The
 * pit menu keeps answering during the stop and its selections change as the crew
 * works through them; re-reading it mid-stop would make the countdown's target
 * move under it.
 */
export interface PitState {
  /** Which stage of a stop the car is at. */
  phase: PitPhase;
  /**
   * `true` while the car is stationary in its box with work underway — i.e.
   * {@link phase} is `stopped`. The countdown fields below are only populated
   * while this holds.
   */
  working: boolean;
  /**
   * Seconds since work began, or {@link UNKNOWN_VALUE} when not working.
   * Measured from a real clock, so it keeps counting past {@link plannedSec}.
   */
  elapsedSec: number;
  /**
   * The stop length that was booked when work began, seconds — the sim's
   * published total for the work selected at that moment. {@link UNKNOWN_VALUE}
   * when the repair screen was not answering, in which case there is an elapsed
   * clock but nothing to count down to.
   */
  plannedSec: number;
  /**
   * The unpublished delay the sim can still add on top of {@link plannedSec},
   * seconds — captured with it, and the reason a stop can run past zero without
   * anything being wrong. {@link UNKNOWN_VALUE} when the sim published no caps.
   */
  slackSec: number;
}

/**
 * State specific to the **player's** car (the spectated/driven entry).
 * Standings for the whole field live in {@link TelemetryFrame.standings}.
 */
export interface PlayerState {
  /** Stable per-session slot/entry id linking to a {@link StandingEntry}. */
  slotId: number;
  /** Current race position (1-based). */
  position: number;
  /** Driver input channels. */
  pedals: PedalInputs;
  /** Current gear: `-1` reverse, `0` neutral, `1..n` forward. */
  gear: number;
  /** Ground speed in km/h. */
  speedKph: number;
  /** Engine speed in RPM. */
  rpm: number;
  /** Rev-limiter / max usable RPM (for a shift-light bar). */
  maxRpm: number;
  /** Lap timing readouts. */
  lap: LapTiming;
  /** Four-corner tyre state. */
  tyres: TyreSet;
  /**
   * Four-corner vertical load and suspension state. Omitted when spectating
   * (no shared-memory physics for a car not driven on this PC) or when the
   * sim's wheel block fails its plausibility guards. See {@link ChassisState}.
   */
  chassis?: ChassisState;
  /**
   * Pacelogic-style dual lap deltas for the **driven** car — Delta T (time,
   * at-position) and Delta V (progress, at-time), each vs the session-best,
   * all-time-best and last laps. Omitted when spectating (no shared-memory
   * physics for a car not driven on this PC). See {@link PaceDeltas}.
   */
  paceDeltas?: PaceDeltas;
  /**
   * G-force / rotation / attitude channels. Omitted when spectating or when
   * shared memory is unavailable — the motion block is only populated for the
   * car driven on this PC, exactly like {@link pedals}.
   */
  motion?: MotionState;
  /**
   * Damage and its repair cost, from LMU's repair screen over REST. Omitted —
   * absent, not zeroed — outside a session (the endpoint 404s), when
   * spectating, or on any provider without that endpoint (rF2). A zeroed block
   * would be indistinguishable from a pristine car. See {@link DamageState}.
   */
  damage?: DamageState;
  /**
   * The player's live pit stop — which stage it is at, and the crew's clock once
   * they are working. Omitted when the provider cannot see a pit stage at all,
   * so a widget can tell "not pitting" (`phase: 'none'`) from "this provider
   * does not report pitting" (field absent). See {@link PitState}.
   */
  pit?: PitState;
  /**
   * Track-limit excursions and the sim's own penalty count. Omitted — absent,
   * not zeroed — when neither the lateral-position channels nor the penalty
   * count is readable (spectating, no shared memory, out of a session), so a
   * clean sheet is never confused with no data. See {@link TrackLimitsState}.
   */
  trackLimits?: TrackLimitsState;
}

/* -------------------------------------------------------------------------- */
/*  Track limits                                                               */
/* -------------------------------------------------------------------------- */

/**
 * How the player is doing against the white lines: whether they are off the
 * road right now, how many excursions they have had this session, and how many
 * penalties the sim has actually issued.
 *
 * ## Two numbers with two different authorities, deliberately kept apart
 * {@link penalties} is the sim's own `mNumPenalties` — the stewards' verdict,
 * reported untouched. {@link warnings} is **ours**, derived by
 * `telemetry/trackLimits.ts` from the car's lateral position against the track
 * edge, because neither the shared memory nor the REST API publishes LMU's
 * internal warning tally. They can disagree, and the widget presents them as
 * what they are rather than blending them into one authoritative-looking count.
 * See the module note in `trackLimits.ts` for why that is still the more useful
 * number to a driver mid-stint.
 */
export interface TrackLimitsState {
  /**
   * `true` while the car is currently past the edge of the track — i.e. an
   * excursion is in progress and has lasted long enough to be counted. This is
   * the live "you are off" state the widget lights and the audio cue fires on.
   */
  offTrack: boolean;
  /**
   * `true` while the car is off the road **and the verdict is still open** —
   * the window in which lifting off gives the time back and cancels the points.
   *
   * This is the only part of the sequence the driver can still act on, which is
   * why it is what the audio cue and the widget's alarm key off. Announcing the
   * points *after* they land tells a driver something they can no longer do
   * anything about. See `AT_RISK_WINDOW_MS` in `telemetry/trackLimits.ts`.
   */
  atRisk: boolean;
  /**
   * `true` when, during the current at-risk window, the driver has already
   * lifted — i.e. as things stand this one will not score. Lets the widget flip
   * from "lift!" to "saved" while the car is still off the road, and lets the
   * cue know not to keep nagging. `false` whenever {@link atRisk} is `false`.
   */
  liftedInTime: boolean;
  /**
   * How far the car's centre is beyond the track edge, metres — negative while
   * inside it, so the widget can show a car running out of road *before* it runs
   * out.
   *
   * **Omitted, not sentinelled**, when the lateral channels are unavailable.
   * This is the one field here that is legitimately negative, so the frame's
   * usual {@link UNKNOWN_VALUE} would collide with a real reading: a car with
   * exactly one metre of road left would report `-1` and be read as "no data".
   * Absence has no such ambiguity. (Same trap as `LapTiming.delta`, noted in the
   * architecture doc's future work — this field simply avoids it rather than
   * adding a third instance of it.)
   */
  beyondEdgeM?: number;
  /**
   * **Points** accumulated this session — the unit LMU actually judges track
   * limits in.
   *
   * The sim scores every infringement rather than counting strikes: a wheel a
   * metre wide and a lap through the run-off are not the same offence, and it
   * weighs how far off you went, whether you were on the throttle, and whether
   * you were at the speed expected for that part of the track. This mirrors that
   * shape with the magnitude we can actually measure (see
   * `POINT_STEP_M`), so the number moves the way the sim's does even though it
   * is not the sim's own tally — the caveat at the top of this block applies to
   * it exactly as it did to the old strike count.
   */
  points: number;
  /**
   * Points that earn the penalty in this session. Configurable, because LMU
   * makes it a per-session setting that leagues publish on the event's
   * registration page; see `DEFAULT_POINTS_LIMIT`.
   */
  pointsLimit: number;
  /**
   * What the most recent scored infringement was worth, so the widget can say
   * "that one cost you 2". {@link UNKNOWN_VALUE} before anything has scored.
   *
   * Worth showing on its own because LMU issues a drive-through for any *single*
   * infringement worth 3 — a fact about one cut, not about the running total.
   */
  lastInfringementPoints: number;
  /** How many infringements have scored this session. */
  warnings: number;
  /**
   * How many excursions the driver **gave back** by lifting inside the at-risk
   * window, and which therefore cost nothing. The only genuinely encouraging
   * number on the widget, and the one that tells a driver the lift is working.
   */
  negated: number;
  /**
   * The sim's outstanding-penalty count for this car. {@link UNKNOWN_VALUE}
   * when the channel is unavailable, which is different from zero.
   */
  penalties: number;
  /**
   * Milliseconds since the most recent warning was counted, so a widget can
   * flash on the event itself rather than on the count's value.
   * {@link UNKNOWN_VALUE} when there has not been one.
   */
  msSinceWarning: number;
  /**
   * Milliseconds since the driver last saved one by lifting.
   * {@link UNKNOWN_VALUE} when they have not.
   */
  msSinceNegated: number;
  /**
   * Milliseconds since {@link penalties} last increased.
   * {@link UNKNOWN_VALUE} when it has not moved this session.
   */
  msSincePenalty: number;
  /**
   * Milliseconds since {@link penalties} last **decreased** — the sim confirming
   * a penalty has been discharged. {@link UNKNOWN_VALUE} until one has been.
   *
   * This is the only confirmation there is that a penalty was served correctly:
   * nothing in the feed says "that drive-through counted". Without it a driver
   * leaves the pit lane not knowing whether it took, which is exactly when they
   * go round again to be safe and lose the time twice.
   */
  msSinceServed: number;
  /**
   * What kind of penalty is outstanding, in LMU's own words — `"STOP/GO"`,
   * `"DRIVE THRU"` — taken from the row the sim puts in the pit menu for it.
   *
   * **Omitted whenever we cannot name it**, which is deliberate and load-bearing.
   * The count is a fact; the type is read from a menu row whose naming we have
   * only observed for one kind of penalty, so it is reported only when the sim's
   * own menu is affirmatively showing one. Guessing "STOP/GO" at a driver
   * serving a drive-through would send them into their box and turn a 20-second
   * penalty into a lap — strictly worse than the "1 PENALTY" they get today.
   */
  penaltyType?: string;
  /**
   * The penalty row's value exactly as the pit menu renders it, e.g.
   * `"Yes(0Laps)"`. Passed through verbatim rather than parsed: it is the sim's
   * wording, and the meaning of the parenthesised part is not something we have
   * established. Omitted alongside {@link penaltyType}.
   */
  penaltyDetail?: string;
}

/* -------------------------------------------------------------------------- */
/*  Standings & relative                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One row in the **full-field standings** table (top-left widget).
 * Gaps are cumulative to the leader; for lapped cars use {@link lapsBehind}.
 */
export interface StandingEntry {
  /** Stable per-session slot/entry id. */
  slotId: number;
  /** Race position, 1-based. */
  position: number;
  /**
   * Grid / qualifying position, 1-based, when known. Combined with
   * {@link position} this yields positions gained (grid − current, positive) or
   * lost (negative) in the race. Omitted when the sim doesn't expose a grid.
   */
  gridPosition?: number;
  /** Driver display name. */
  driverName: string;
  /** Car number as shown on the car, when available. */
  carNumber?: string;
  /**
   * Car class label, normalized to a canonical spelling (`"HYPERCAR"`, `"LMP2"`,
   * `"LMP3"`, `"GT3"`, …) by `telemetry/carClass`. Unrecognised classes are
   * passed through upper-cased. Omitted when the sim doesn't expose one.
   */
  carClass?: string;
  /**
   * Position **within {@link carClass}**, 1-based — what a multiclass field
   * actually races for. Omitted when the class is unknown.
   */
  classPosition?: number;
  /**
   * Gap in seconds to the leader **of this car's class**; `0` for a class
   * leader. {@link UNKNOWN_VALUE} when it can't be derived (either car lapped,
   * or no gap published). Omitted when the class is unknown.
   */
  gapToClassLeaderSec?: number;
  /**
   * Whole laps behind the **class** leader (`0` when on the class leader's lap).
   * Omitted when the class is unknown.
   */
  classLapsBehind?: number;
  /**
   * Remaining **virtual energy** as a fraction, `0`..`1`, when the sim exposes
   * it (LMU's per-car energy budget — what its native overlay shows to the
   * cars ahead). Omitted when unknown.
   */
  virtualEnergy?: number;
  /** Gap to the leader in seconds; {@link UNKNOWN_VALUE} if lapped/unknown. */
  gapToLeaderSec: number;
  /** Gap to the car directly ahead in seconds; {@link UNKNOWN_VALUE} if unknown. */
  gapToAheadSec: number;
  /** Whole laps behind the leader (`0` on lead lap). */
  lapsBehind: number;
  /** Best lap this session in seconds; {@link UNKNOWN_VALUE} if none. */
  bestLapSec: number;
  /** Last lap in seconds; {@link UNKNOWN_VALUE} if none. */
  lastLapSec: number;
  /** Laps completed. */
  lapsCompleted: number;
  /** Whether the car is currently in the pit lane / stall. */
  inPit: boolean;
  /** Completed pit stops, when tracked. */
  pitStops?: number;
  /** Fitted tyre compound, when known. */
  tyreCompound?: string;
  /** `true` for the player's own row (for highlight). */
  isPlayer: boolean;
}

/**
 * One row in the **relative** widget (top-right): the cars physically nearest
 * to the player on track, ordered by on-track proximity, with a signed time
 * gap. This is distinct from {@link StandingEntry} which is ordered by race
 * position.
 */
export interface RelativeEntry {
  /** Stable per-session slot/entry id. */
  slotId: number;
  /** Race position, 1-based. */
  position: number;
  /** Driver display name. */
  driverName: string;
  /** Car number, when available. */
  carNumber?: string;
  /** Car class label, when available. */
  carClass?: string;
  /**
   * Signed on-track time gap to the player in seconds.
   * Positive = ahead of the player, negative = behind. `0` for the player row.
   */
  relativeGapSec: number;
  /** Whole laps difference vs the player (negative = lapped by player). */
  lapsDifference: number;
  /**
   * `true` when this car belongs to a genuinely **faster category** than the
   * player's (e.g. a Hypercar behind a GT3). Only set when both classes are
   * recognised, so an unknown mod class never triggers a false alert.
   * See `telemetry/carClass`.
   */
  isFasterClass?: boolean;
  /**
   * `true` when the player should **yield** to this car: it is behind on the
   * road but ahead on the race — either a lap up, or in a faster class and
   * closing. This is the blue-flag condition the relative widget alerts on.
   */
  yieldTo?: boolean;
  /**
   * `true` when this car is a **backmarker the player is arriving on**: ahead on
   * the road, behind on the race (a lap down or a slower class), and being
   * caught. The mirror of {@link yieldTo} — traffic the player has to get past,
   * rather than traffic the player must let past.
   */
  trafficAhead?: boolean;
  /**
   * Rate the gap is closing, in seconds of gap per second, when it can be
   * measured (positive = closing on the player, negative = pulling away).
   * {@link UNKNOWN_VALUE} until two samples of this car exist.
   */
  closingRateSec?: number;
  /** Whether the car is in the pit lane. */
  inPit: boolean;
  /** `true` for the player's own row. */
  isPlayer: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Radar                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One nearby car as the **radar** widget sees it: a car-relative position on the
 * player's own ground plane, computed from every car's world position and the
 * player's orientation by `telemetry/radar.ts` (which owns the axis convention —
 * nothing downstream reasons about the sim's axes).
 *
 * This is distinct from {@link RelativeEntry}: the relative widget orders cars by
 * on-track *time* gap (1-D, how far round the lap), while a blip is a true 2-D
 * offset — it is the only place lateral (left/right) separation exists, which is
 * what a spatial-awareness radar needs and a lap-distance gap cannot provide.
 */
export interface RadarBlip {
  /** Stable per-session slot/entry id. */
  slotId: number;
  /**
   * Lateral offset in **metres**: negative = to the player's LEFT, positive =
   * to the player's RIGHT.
   */
  lateralM: number;
  /**
   * Longitudinal offset in **metres**: positive = AHEAD of the player, negative
   * = BEHIND.
   */
  longitudinalM: number;
  /** Planar centre-to-centre distance in metres (always ≥ 0). */
  distanceM: number;
  /**
   * `true` when the car overlaps the player longitudinally within a car length
   * — i.e. it is drawing alongside, the condition the widget turns into a
   * left/right proximity warning. Read the side from the sign of {@link lateralM}.
   */
  alongside: boolean;
  /** Car class label, when known (drives the blip colour). */
  carClass?: string;
  /** Car number, when known. */
  carNumber?: string;
  /**
   * `true` when this car belongs to a genuinely faster category than the
   * player's — a Hypercar bearing down on a GT3. Only set when both classes are
   * recognised, so an unknown mod class never triggers a false alert. Mirrors
   * {@link RelativeEntry.isFasterClass}.
   */
  isFasterClass?: boolean;
  /**
   * `true` when this car is a genuinely SLOWER category than the player's — a
   * backmarker the player is catching. The mirror of {@link isFasterClass}, and
   * likewise only set when both classes are recognised. The radar draws these as
   * a distinct "ghost" marker so traffic to be lapped reads at a glance.
   */
  slowerClass?: boolean;
  /**
   * How many laps this car is BEHIND the player (player laps − car laps), when
   * ≥ 1 — i.e. a car the player has put a lap on, whatever its class. The radar
   * ghosts these too, so a same-class car a lap down reads as lappable traffic.
   * Omitted when the car is on the player's lap (or ahead).
   */
  lapsDown?: number;
}

/* -------------------------------------------------------------------------- */
/*  Weather                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A single point in the weather **forecast** timeline shown by the weather
 * widget. Slot `minutesAhead === 0` represents current conditions.
 */
export interface WeatherForecastSlot {
  /** Minutes from now this slot describes (`0` = now). */
  minutesAhead: number;
  /**
   * Short label for the slot when it is keyed to session progress rather than a
   * minute offset (e.g. `"START"`, `"25%"`, `"50%"`, `"75%"`, `"END"`). LMU's
   * forecast is published per session phase, not on a wall-clock, so the widget
   * prefers this label over {@link minutesAhead} when present.
   */
  label?: string;
  /** Probability of rain, `0`..`1`. */
  rainChance: number;
  /** Expected precipitation intensity, `0` (dry) .. `1` (heavy). */
  rainIntensity: number;
  /** Expected track temperature in °C. */
  trackTempC: number;
  /** Expected air/ambient temperature in °C, when the forecast gives it. */
  airTempC?: number;
  /** Expected relative humidity as a percentage `0`..`100`, when available. */
  humidityPct?: number;
  /** Expected wind speed in km/h, when available. */
  windKph?: number;
  /** Coarse sky descriptor. */
  sky: SkyState;
}

/**
 * Current weather plus a short forecast. Feeds the weather-forecast widget.
 */
export interface WeatherState {
  /** Current track surface temperature in °C. */
  trackTempC: number;
  /** Current ambient/air temperature in °C. */
  ambientTempC: number;
  /** Current precipitation intensity, `0` (dry) .. `1` (heavy). */
  rainIntensity: number;
  /** Current track wetness, `0` (dry) .. `1` (flooded). */
  trackWetness: number;
  /**
   * Forecast timeline (typically 5–6 slots, e.g. now/+5/+15/+30/+60 min).
   * Always includes a `minutesAhead === 0` "now" slot as the first element.
   */
  forecast: WeatherForecastSlot[];
}

/* -------------------------------------------------------------------------- */
/*  Fuel                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Fuel state and strategy computed by the fuel calculator. Feeds the
 * fuel-calculator widget. All quantities are in **litres** unless the field
 * name says otherwise.
 */
export interface FuelState {
  /** Current fuel in the tank, litres. */
  levelLiters: number;
  /** Tank capacity, litres; {@link UNKNOWN_VALUE} if unknown. */
  capacityLiters: number;
  /** Rolling-average consumption per lap, litres; {@link UNKNOWN_VALUE} until enough laps. */
  perLapAvgLiters: number;
  /** Estimated laps remaining on current fuel; {@link UNKNOWN_VALUE} if unknown. */
  lapsRemaining: number;
  /** Laps still required to reach the finish; {@link UNKNOWN_VALUE} if unknown. */
  lapsToFinish: number;
  /** Litres needed to reach the finish; {@link UNKNOWN_VALUE} if unknown. */
  fuelToFinishLiters: number;
  /**
   * Fuel margin at the finish, litres: positive = surplus, negative = short.
   * {@link UNKNOWN_VALUE} if it cannot be estimated yet.
   */
  fuelDeltaLiters: number;
  /** Litres to add at the next stop to reach the finish (`0` if none needed). */
  refuelToFinishLiters: number;
  /** Earliest lap the pit window opens (enough fuel to finish); optional. */
  pitWindowOpenLap?: number;
  /**
   * **Come in at the end of this lap or you will not get back.** True when, from
   * where the car is on the road right now, there is not enough left to finish
   * this lap and complete another one — *even driving the rest of it as
   * economically as anyone realistically can*. It is not "you are getting low":
   * it is the point where saving has stopped being an option and the only
   * remaining choice is which lap you come in on.
   *
   * Deliberately a projection to the start/finish line rather than a level
   * threshold, because the question a driver needs answered is not "how much is
   * left" but "can I take the green flag again". Absent until a lap of
   * consumption has been observed, and never raised on the final lap of a race —
   * there is nothing to come back for.
   *
   * @see FuelState.pitThisLapReason for which budget ran out.
   */
  pitThisLap?: boolean;
  /**
   * Which budget forces {@link pitThisLap}. LMU cars run both a fuel tank and a
   * virtual-energy allowance and either can be the binding one, so the alarm
   * names it — "PIT THIS LAP FOR ENERGY" sends the driver to a different pit
   * menu than a fuel call does.
   */
  pitThisLapReason?: 'fuel' | 'energy';
  /**
   * Player car's remaining **virtual energy** as a percentage `0`..`100` (LMU's
   * per-car energy budget). Omitted when the car/class doesn't run one.
   */
  virtualEnergyPct?: number;
  /** Average virtual energy used per lap, percentage points; omitted until known. */
  virtualEnergyPerLapPct?: number;
  /** Estimated laps remaining on the current virtual energy; omitted until known. */
  virtualEnergyLapsRemaining?: number;
  /**
   * Virtual-energy margin at the finish in percentage points: positive =
   * surplus, negative = short. Omitted until it can be estimated.
   */
  virtualEnergyDeltaPct?: number;
  /**
   * How many cars **ahead on the road, in the player's own class**, are
   * projected to run out of virtual energy — and therefore pit — **before the
   * player does**. Each one is a position that comes back on strategy alone.
   * Omitted when no comparable car ahead is running an energy budget.
   */
  veCarsAheadPittingFirst?: number;
  /**
   * How many cars ahead were comparable at all (same class, running an energy
   * budget). Lets the widget read "2 of 5" rather than implying the count was
   * taken over the whole field. Omitted alongside
   * {@link veCarsAheadPittingFirst}.
   */
  veCarsAheadCompared?: number;
  /**
   * Laps of energy the player has in hand over the **nearest** car ahead that
   * must pit first — i.e. how much earlier that car is forced in. Omitted when
   * there is no such car.
   */
  veLapsInHandVsNext?: number;
}

/* -------------------------------------------------------------------------- */
/*  MFD control (in-game Multi-Function Display)                               */
/* -------------------------------------------------------------------------- */

/**
 * One row of the in-game **pit MFD**, mirrored from LMU's
 * `GET /rest/garage/PitMenu/receivePitMenu`. Each row is a labelled setting the
 * driver cycles in the cockpit (fuel, tyres, wing, repairs…); `currentSetting`
 * indexes into the row's option list, and `settingCount` is that list's length.
 *
 * This block is **read/write**: the overlay renders it, and the MFD widget POSTs
 * a changed `currentSetting` back through the server (`/api/mfd/pit` →
 * `POST /rest/garage/PitMenu/loadPitMenu`). See `telemetry/mfdControl.ts`.
 */
export interface MfdPitRow {
  /**
   * The sim's stable identifier for the row (`"PMC Value"` from the API). Used
   * as the write key so a row is targeted by identity, not by its display
   * position, which shifts as rows appear/disappear (e.g. per-corner tyres).
   */
  pmcValue: number;
  /** Display label exactly as the sim gives it, e.g. `"FUEL RATIO:"`. */
  name: string;
  /** Selected option index, `0..settingCount-1`. */
  currentSetting: number;
  /** Number of options this row can cycle through. */
  settingCount: number;
  /** The default option index (what a fresh menu resets to). */
  defaultSetting: number;
  /** Rendered text of the selected option, e.g. `"58% 19 laps"`. */
  currentText: string;
}

/**
 * One live **driving aid / setup value**, mirrored from a `VM_*` key of LMU's
 * `GET /rest/garage/getPlayerGarageData`. Read/write like {@link MfdPitRow}: the
 * widget POSTs a new `value` through `/api/mfd/aid` →
 * `POST /rest/garage/<key> {value}`. `value` is an integer step index the sim
 * clamps to `[minValue, maxValue]`; `text` is the sim's own rendering of it.
 */
export interface MfdAid {
  /** The `VM_*` key, e.g. `"VM_BRAKE_BALANCE"` — the write target. */
  key: string;
  /** Short human label for the widget, e.g. `"Brake Bias"`. */
  label: string;
  /** Current integer step value. */
  value: number;
  /** Lowest legal value. */
  minValue: number;
  /** Highest legal value. */
  maxValue: number;
  /** The sim's rendered value, e.g. `"49.0:51.0"` or `"9 (Understeer)"`. */
  text: string;
}

/**
 * The controllable state of the in-game MFD for the player's car: the pit menu
 * and a curated set of live driving aids. Present only on the `lmu` provider and
 * only while the garage/pit endpoints answer (in a session); omitted otherwise,
 * exactly like {@link DamageState}, so the widget can tell "no data" from a real
 * empty menu rather than acting on a stale one.
 */
/**
 * The **one** tyre control: which compound goes on the car at the next stop.
 *
 * ## Why this is derived rather than a row
 * LMU's pit menu carries the tyre decision as four independent per-corner rows
 * (`FL TIRE:` … `RR TIRE:`), each cycling the same list — `No Change`, then
 * whatever compounds this car has for this event (`New Medium`, `New Wet`, and
 * hards/softs where the class runs them). Nobody changes one corner. Driving it
 * as four rows means four times the scrolling to express a decision that is
 * always "put the wets on", and it is why the widget's tyre section read as a
 * list of indices rather than as a choice between compounds.
 *
 * So this collapses the four into one control whose options are the sim's own
 * compound names, and a write sets all four corners together. The per-corner
 * rows remain in {@link MfdState.pit} untouched for anyone who genuinely wants
 * one corner — nothing is hidden, this is an additional, better-shaped handle on
 * the same underlying rows.
 *
 * Omitted from {@link MfdState} when the menu has no per-corner tyre rows at
 * all (out of a session, or a car/series without them).
 */
export interface MfdTyreControl {
  /**
   * The compound options exactly as the sim names them, in its own order —
   * `["No Change", "New Medium", "New Wet"]`. Index 0 is always the no-change
   * option. Taken from the sim, so a class running hards or softs gets those
   * without this module knowing anything about compounds.
   */
  options: string[];
  /**
   * Index into {@link options} currently selected on all four corners, or
   * {@link UNKNOWN_VALUE} when the corners disagree (see {@link mixed}).
   */
  current: number;
  /**
   * `true` when the four corners are NOT all on the same option — someone has
   * set a per-corner strategy by hand, or the sim has. The widget says "MIXED"
   * rather than picking one corner's answer and quietly misreporting the other
   * three; the next write from this control resolves it by setting all four.
   */
  mixed: boolean;
  /**
   * The rendered text of the current selection, e.g. `"New Medium"`, or
   * `"Mixed"` when {@link mixed}. Saves every consumer re-deriving it.
   */
  currentText: string;
}

export interface MfdState {
  /** The full pit MFD, in the sim's row order. */
  pit: MfdPitRow[];
  /** Curated live aids (brake bias, ABS/TC map, engine maps, regen…). */
  aids: MfdAid[];
  /**
   * The collapsed all-four-corners tyre compound control. Omitted when the menu
   * carries no per-corner tyre rows. See {@link MfdTyreControl}.
   */
  tyres?: MfdTyreControl;
}

/* -------------------------------------------------------------------------- */
/*  Top-level frame                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A complete, normalized telemetry snapshot broadcast to the overlays.
 * This is the object serialized as JSON over the WebSocket at the configured
 * update rate.
 */
export interface TelemetryFrame {
  /** Wire-format version; see {@link TELEMETRY_SCHEMA_VERSION}. */
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  /** Producer identity for this frame. */
  source: TelemetrySource;
  /** Producer wall-clock time (epoch ms) when the frame was generated. */
  timestamp: number;
  /**
   * `true` when a real sim is connected and feeding data; `false` when the
   * frame is simulated placeholder data. Lets overlays show a "DEMO" badge.
   */
  connected: boolean;
  /** Session-wide state. */
  session: SessionState;
  /** The player's car state. */
  player: PlayerState;
  /** Full field, ordered by race position. */
  standings: StandingEntry[];
  /** Cars nearest the player on track, ordered by proximity. */
  relative: RelativeEntry[];
  /**
   * Car-relative positions of nearby cars for the spatial radar, nearest first.
   * **Optional and omitted** — not an empty array — when the driven car's world
   * position/orientation isn't available (spectating, or no shared-memory
   * physics for a car not driven on this PC), exactly like {@link PlayerState.motion}.
   * An empty array means "genuinely nobody within range", which is real
   * information the widget renders differently from "no data". See {@link RadarBlip}.
   */
  radar?: RadarBlip[];
  /** Current weather plus forecast. */
  weather: WeatherState;
  /** Fuel state and strategy for the player's car. */
  fuel: FuelState;
  /**
   * Controllable in-game MFD state (pit menu + live driving aids) for the
   * player's car. **Optional and omitted** — like {@link DamageState} — when the
   * provider isn't `lmu` or the garage/pit endpoints aren't answering (out of a
   * session, in menus), so the widget never drives the MFD from stale data.
   */
  mfd?: MfdState;
}

/**
 * Convenience type alias for a frame with any schema version, used at the
 * WebSocket boundary where a consumer may need to inspect the version before
 * trusting the rest of the shape.
 */
export type AnyTelemetryFrame = Omit<TelemetryFrame, 'schemaVersion'> & {
  schemaVersion: number;
};
