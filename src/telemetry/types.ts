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
  /**
   * The start-light gantry, when the sim publishes one. `total` is how many red
   * lamps the gantry has; `frame` is how many are currently lit — `0` dark,
   * `1..total` the red countdown, and **greater than `total`** means
   * lights-out/green (LMU jumps straight from 0 to `total + 1` on a rolling
   * start; the intermediate frames are expected only on a standing start).
   * Probed live 2026-08-04 — see docs/race-control-signals.md. Omitted when
   * the source has no gantry channel.
   */
  startLights?: { frame: number; total: number };
  /**
   * Per-sector flag state `[S1, S2, S3]` — the sim's own marshalling, not an
   * inference. LMU publishes `"YELLOW"` per sector with a car stopped on track
   * and clears it when the hazard moves; anything it does not mark yellow reads
   * `'none'` here. Omitted when the source has no sector channel.
   */
  sectorFlags?: [FlagState, FlagState, FlagState];
  /**
   * Where the LOCAL driver's eyes are, not where the session is: `false` while
   * they are looking at any of the sim's own screens — the ESC/monitor menu,
   * the garage and setup pages — and `true` while they are at the wheel.
   *
   * Deliberately separate from {@link phase}: the session stays `green` and
   * every car keeps racing while one driver sits in their garage menus, so no
   * session-lifecycle field can carry this. It exists so the in-game layer can
   * show itself only when there is a windscreen to draw over (auto show/hide).
   * Omitted when the source cannot tell — absent means "assume at the wheel",
   * so nothing ever hides on a missing field.
   */
  onTrack?: boolean;
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
  /**
   * Seconds into the current lap on the delta engine's own clock — a real
   * elapsed time, measured from the interpolated start/finish crossing.
   *
   * Published because REST `timeIntoLap`, the obvious source for a "current lap"
   * readout, is a **position-derived estimate**: it reports the same value at a
   * given distance whatever the lap is actually taking, so a lap slower than the
   * pace it assumes reads seconds short. This is the clock the delta itself runs
   * on, so the two can never disagree.
   *
   * {@link UNKNOWN_VALUE} until a line crossing has been observed — before that
   * the engine's lap started wherever the car happened to be when the overlay
   * attached, and reporting that as a lap time would read far too low.
   */
  lapTimeSec: number;
  /** Adopted session-best lap time (s), or {@link UNKNOWN_VALUE}. */
  refSessionSec: number;
  /** Adopted all-time-best lap time (s), or {@link UNKNOWN_VALUE}. */
  refAllTimeSec: number;
  /** Last completed lap time (s), or {@link UNKNOWN_VALUE}. */
  lastLapSec: number;
}

/**
 * How the driver's pace compares to the reference for their class at this track.
 *
 * The numbers come from **Ohne Speed's LMU laptimes spreadsheet** (times by
 * beAlien, Go and Hymo), shipped as `overlay/js/data/reference-times.json`. The
 * band labels are theirs too. `credit` rides on the block rather than being
 * looked up separately so that no surface can render a score without also having
 * the attribution to hand.
 *
 * Present whenever the track+class could be identified in that table — which is
 * NOT always: LMU never names the track LAYOUT, and Monza's two are ~10 s apart.
 * When it could not, {@link ok} is `false` and {@link detail} says why, so the
 * widget explains itself instead of showing a wrong number. See
 * `telemetry/referencePace.ts`.
 */
export interface PaceScoreState {
  /** Whether a reference was found. Everything below is meaningful only if so. */
  ok: boolean;
  /** Why not, in a sentence a driver can act on. Present when `ok` is false. */
  detail?: string;
  /** Machine-readable form of the same. */
  reason?: string;
  /** Best clean lap this session as a percentage of the reference, 1 dp. */
  percent?: number;
  /** The band that percentage falls in — `"Competitive"`, `"Midpack"`, … */
  bandLabel?: string;
  /** Band id, for styling. */
  bandId?: string;
  /** Seconds off the reference; negative when faster. */
  deltaSec?: number;
  /** The reference lap itself, seconds — what 100% means here. */
  refSec?: number;
  /** The sheet's alien hotlap benchmark for the same row, seconds. */
  hotlapSec?: number;
  /** The lap of yours being scored, seconds. `UNKNOWN_VALUE` before the first. */
  lapSec: number;
  /** Resolved layout and class, so the overlay can show what it compared to. */
  layoutName?: string;
  circuitName?: string;
  sheetClass?: string;
  /**
   * How the layout was identified — `'only'`, `'sim-name'`, `'config'`,
   * `'length'`. `'only'` means the circuit has a single layout in the table, so
   * naming it in the UI adds nothing.
   */
  via?: string;
  /** `true` when part of the match was assumed; the UI must hedge. */
  assumed?: boolean;
  /** Attribution for the reference data. Always present when the table loaded. */
  credit?: {
    author: string;
    title: string;
    sheetUrl: string;
  };
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
  /**
   * Carcass **core** temperature in °C, when available — a single value per
   * corner, distinct from {@link tempC} (the inner-liner mean). The two track
   * each other within about a degree; the core is the slower of the two.
   */
  coreC?: number;
  /**
   * Across-the-tread temperatures, in °C, for the **inner liner** — the layer
   * {@link tempC} averages.
   *
   * ## Orientation is inner/outer *relative to the car*, not the sim's array
   * The sim publishes three bands per wheel in its own left→right order (its
   * REST screen names them `leftTemperature`/`centerTemperature`/
   * `rightTemperature`). That order is a fixed direction in car space, so the
   * same array index is the OUTER shoulder on the left of the car and the INNER
   * shoulder on the right. Providers flip it per side so that here `innerC` is
   * always the shoulder toward the car's centreline and `outerC` always the one
   * toward the outside — which is what camber and pressure actually mean to a
   * driver, and what makes the four corners comparable to each other.
   */
  innerC?: number;
  /** Centre-of-tread inner-liner temperature in °C, when available. */
  middleC?: number;
  /** Outer-shoulder inner-liner temperature in °C. See {@link innerC}. */
  outerC?: number;
  /** Inner-shoulder **surface** (tread) temperature in °C. See {@link innerC}. */
  surfaceInnerC?: number;
  /** Centre-of-tread **surface** temperature in °C, when available. */
  surfaceMiddleC?: number;
  /** Outer-shoulder **surface** temperature in °C. See {@link innerC}. */
  surfaceOuterC?: number;
  /**
   * The sim's own optimal operating temperature in °C for the compound fitted
   * to this corner, when it publishes one.
   *
   * This is **read from the sim, never assumed** — LMU carries it per compound
   * per car/event, so it moves with the machinery rather than being a constant
   * baked into the overlay. Absent when the sim does not publish it, in which
   * case nothing downstream may claim a tyre is in or out of its window.
   */
  optimalTempC?: number;
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
  /**
   * Live signed along-track distance to the pit-entry commit point, metres —
   * counts down as the car approaches and goes **negative** once past it
   * (verified live: LMU's `GetGameState.PitEntryDist` ticks every frame).
   * This is what a "pit entry ahead — limiter" marker keys off. Omitted when
   * the source does not publish it.
   */
  entryDistM?: number;
  /**
   * Whether the pit-speed limiter is engaged on the DRIVEN car, from shared
   * memory (see `lmuLocalCar.ts` `mSpeedLimiter`). Omitted when unknown —
   * spectating, plain rF2, or the byte reading implausibly — and the limiter
   * prompts must stay silent rather than guess.
   */
  limiterOn?: boolean;
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
   * Where this driver's best clean lap sits against the reference pace for their
   * class at this track — the Alien → Offline ladder from Ohne Speed's
   * spreadsheet. Omitted when spectating; present-but-`ok: false` when the
   * reference could not be identified, which the widget renders as an
   * explanation rather than a number. See {@link PaceScoreState}.
   */
  paceScore?: PaceScoreState;
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
   * Hybrid/ERS battery state of charge and which way it is flowing. Omitted for
   * any car that has never published a charge — see {@link HybridState}, which
   * explains why an absent block and a zeroed one had to be different things.
   */
  hybrid?: HybridState;
  /**
   * The stewards' track-limit points and the sim's own penalty count. Omitted —
   * absent, not zeroed — when the player has no scoring record at all
   * (spectating, no shared memory, out of a session), so a clean sheet is never
   * confused with no data. See {@link TrackLimitsState}.
   */
  trackLimits?: TrackLimitsState;
}

/* -------------------------------------------------------------------------- */
/*  Track limits                                                               */
/* -------------------------------------------------------------------------- */

/**
 * How the player is doing against the white lines: how many points the stewards
 * have charged them this session, what each cut cost, and how many penalties the
 * sim has actually issued.
 *
 * ## Every number here is the sim's own
 * There was once a second set of figures derived from the car's lateral position
 * against the track edge, because nothing published LMU's internal tally. There
 * is now: `telemetry/lmuTraceLimits.ts` reads the stewards' own charges out of
 * the game's trace log, validated against the session-end results XML. So the
 * geometry reconstruction — and the widget's two-authorities presentation that
 * went with it — has been retired, and this block carries one set of numbers with
 * one authority behind them.
 *
 * The one thing that costs is latency: the sim flushes its log a block at a time,
 * so a charge can reach us anywhere from a tenth of a second to ~25 s after the
 * cut. See `docs/TRACK-LIMITS-POINTS.md`.
 */
export interface TrackLimitsState {
  /**
   * **Points** charged this session — the unit LMU actually judges track limits
   * in, read from the sim's own stewarding rather than inferred.
   *
   * The sim scores every infringement rather than counting strikes: a wheel a
   * metre wide and a lap through the run-off are not the same offence, and it
   * weighs how much time the cut gained. Charges are quarter-point multiples.
   *
   * {@link UNKNOWN_VALUE} when there is no source for it — plain rF2, or an LMU
   * install whose log directory could not be found. That is different from zero,
   * which says the stewards have you at nothing, and the widget shows the two
   * differently.
   */
  points: number;
  /**
   * Points that earn the penalty in this session. Configurable, because LMU
   * makes it a per-session setting that leagues publish on the event's
   * registration page; see `DEFAULT_POINTS_LIMIT`.
   */
  pointsLimit: number;
  /**
   * What the sim charged for each of the most recent cuts, **newest first**,
   * capped at a handful.
   *
   * The individual amounts are what a driver can act on: three 0.25s is a driver
   * clipping the same kerb every lap, one 1.0 is a single mistake, and the
   * running total alone cannot tell those apart. Empty when nothing has been
   * charged this session — including when there is no source at all, so pair it
   * with {@link points} before drawing a clean sheet.
   */
  charges: number[];
  /** How many cuts the sim has charged for since its last reset. */
  charged: number;
  /**
   * The sim's own lap numbers for the laps it charged, newest first.
   *
   * Carried so the lap database can void the lap that actually cut rather than
   * the one being driven when the news arrived — the trace runs up to ~25 s
   * behind. Empty when no trace is readable. Not for display.
   */
  chargedLaps?: number[];
  /**
   * Milliseconds since the total last went **up**, so a widget can flash on the
   * charge itself rather than on the value of the number.
   * {@link UNKNOWN_VALUE} when nothing has been charged this session.
   *
   * This is the only event on the block a driver has not already seen for
   * themselves — they know they ran wide; what they do not know is what it cost.
   */
  msSinceCharge: number;
  /**
   * The sim's outstanding-penalty count for this car. {@link UNKNOWN_VALUE}
   * when the channel is unavailable, which is different from zero.
   */
  penalties: number;
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
   * What kind of penalty is outstanding, in the sim's own words —
   * `"STOP/GO"`, `"DRIVE THROUGH"`, `"STOP/GO 10S"`, or `"DISQUALIFIED"`.
   *
   * Two sources, both LMU's own: the row the sim inserts in the pit menu for
   * the penalty it wants served, and (when that row is absent or unrecognised)
   * the penalty's naming in the game's trace log, attributed to this car
   * before it is trusted. A disqualification (standings `finishStatus`)
   * overrides both — there is nothing left to serve.
   *
   * **Omitted whenever we cannot name it**, which is deliberate and load-bearing.
   * The count is a fact; the type is only ever reported in the sim's own words,
   * never inferred. Guessing "STOP/GO" at a driver serving a drive-through
   * would send them into their box and turn a 20-second penalty into a lap —
   * strictly worse than a bare "1 PENALTY".
   */
  penaltyType?: string;
  /**
   * The actionable second half of {@link penaltyType}: the serve deadline when
   * the pit menu carried one (`"SERVE IN 3 LAPS"`, `"SERVE NOW"`), or the
   * penalty's REASON in the sim's words (`"TRACK LIMITS"`) when the type came
   * from the trace. Omitted alongside {@link penaltyType}.
   */
  penaltyDetail?: string;
  /**
   * The stewards have excluded this car (`finishStatus` = DSQ). Carried
   * separately from the count because LMU leaves {@link penalties} standing
   * after the verdict, and the widget must show the verdict even at a count
   * of zero.
   */
  disqualified?: boolean;
  /**
   * Whether {@link pointsLimit} is a threshold the sim will actually act on in THIS
   * session.
   *
   * `/rest/sessions` reports `cuts_allowed` for every session type, but only a race
   * spends it on a drive-through: in practice and qualifying LMU invalidates the lap
   * instead and lets the total run — observed at 9.5 against an allowance of 5, with
   * the game's own HUD showing the limit as infinity, and corroborated by the 727
   * `Invalid Lap Cut Track` rulings in one evening's results files.
   *
   * So the countdown is shown only where it is real. Telling a driver in practice
   * they are 0.25 from a drive-through that cannot come is a lie about the one
   * number on this widget they will change their driving for.
   */
  pointsLimitEnforced?: boolean;
  /**
   * The sim's own live verdict on whether the lap being driven still counts
   * for TIME — LMU's `countLapFlag`, which drops from `COUNT_LAP_AND_TIME` to
   * `COUNT_LAP_ONLY` the instant a cut voids the lap and **restores** if the
   * sim decides no advantage was gained (observed flipping both ways inside a
   * single five-second excursion). `false` = this lap's time is currently
   * void; `true` = it counts. Omitted when the channel reads `COUNT_NEITHER`
   * (out-lap / garage — validity is not a live question) or is unavailable.
   *
   * This is the signal the old geometry-based "LIFT" callout wanted to be: it
   * is the stewards' own state, so showing it cannot disagree with them.
   */
  lapValid?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Hybrid system                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The **hybrid/ERS** state of the player's car — the battery a Hypercar deploys
 * and harvests, as distinct from the two budgets in {@link FuelState}.
 *
 * ## Why this is not virtual energy
 * They are easy to conflate and a driver must not. {@link
 * FuelState.virtualEnergyPct} is a **stint** budget: a per-car allowance for the
 * whole run that only goes down, and running it out sends you to the pits. This
 * is a **lap** budget: a physical state of charge that empties down a straight
 * and refills under braking, and running it out costs you the deployment out of
 * the next corner. A widget that showed one where the other was meant would have
 * the driver lifting to save something that recharges itself.
 *
 * ## Present only when the car actually has one
 * Omitted — absent, not zeroed — for any car that has never published a charge.
 * A GT3 has no battery, and its record reads a constant `0`, which is
 * indistinguishable from a Hypercar sitting flat. So the provider latches this
 * block on the first non-zero charge it sees and never fabricates one; a car
 * without a hybrid simply has no `hybrid` field and the widget draws no gauge
 * rather than a permanent, alarming empty one.
 */
export interface HybridState {
  /** State of charge, `0` (flat) .. `1` (full). */
  chargeFraction: number;
  /**
   * Electric motor torque in Nm, **signed**: positive = deploying (the motor is
   * driving the car), negative = harvesting (it is being driven, recharging the
   * battery). {@link UNKNOWN_VALUE} when the channel reads implausibly.
   *
   * The sign is the whole value of the channel — a charge percentage says how
   * much is in the battery, and only this says which way it is currently going.
   */
  motorTorqueNm: number;
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
  /**
   * Average of this car's last few laps (up to 5), seconds — the pace it is
   * actually running, as opposed to the one-off {@link bestLapSec}. Collected
   * live from lap edges by `telemetry/paceAverage`; laps through the pit lane
   * are left out. Omitted until the car has completed a clean lap under our
   * watch, so a widget can tell "no pace yet" from a slow one.
   */
  avg5Sec?: number;
  /** Laps completed. */
  lapsCompleted: number;
  /** Whether the car is currently in the pit lane / stall. */
  inPit: boolean;
  /** Completed pit stops, when tracked. */
  pitStops?: number;
  /** Fitted tyre compound, when known. */
  tyreCompound?: string;
  /**
   * Car manufacturer ("Ferrari", "Porsche", "Mercedes-AMG", …) as LMU's own car
   * list spells it. Drives the brand badge in the standings tower — the overlay
   * server proxies the game's badge artwork at `/carbadges/<manufacturer>.svg`.
   * Omitted when the sim doesn't publish a car list (rF2, demo).
   */
  manufacturer?: string;
  /**
   * The driver's profile badge, as LMU's own session UI shows beside names in
   * multiplayer — a safety-reputation tier (`"sr-rookie"`, `"sr-warning"`,
   * `"sr-clean"`, `"sr-saint"`, …) or a special grant (`"s397"`,
   * `"irl-driver"`, …). Sourced from `/rest/multiplayer/teams`, which is the
   * ONLY rating-adjacent fact the game publishes locally (DR/SR numbers live
   * behind its authenticated cloud service). The artwork ships with the overlay
   * at `/driverbadges/<badge>.svg`. Omitted for `"none"`, offline sessions and
   * sims without the endpoint — so nothing renders unless the game itself would
   * show a badge.
   */
  driverBadge?: string;
  /**
   * The driver's **Driver Rating** rank badge (Bronze→Platinum + tier 0..3) —
   * the shield LMU's lobby shows beside every driver. From the game's online
   * service via `telemetry/raceosRanks`; only ever set for connected human
   * players in an online session, and omitted entirely when the service is
   * unreachable (the widgets then render exactly the pre-badge row). Artwork
   * ships with the overlay at `/rankbadges/dr/<Rank><tier>.svg`.
   */
  driverRank?: { rank: string; tier: number };
  /** The **Safety Rating** rank badge — as {@link driverRank}, `sr` artwork. */
  safetyRank?: { rank: string; tier: number };
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
   * Car manufacturer, as on {@link StandingEntry.manufacturer} — drives the
   * brand badge, served at `/carbadges/<manufacturer>.svg`.
   */
  manufacturer?: string;
  /**
   * The driver's profile badge, as on {@link StandingEntry.driverBadge} —
   * drives the badge beside the name, served at `/driverbadges/<badge>.svg`.
   */
  driverBadge?: string;
  /** Driver Rating rank badge, as on {@link StandingEntry.driverRank}. */
  driverRank?: { rank: string; tier: number };
  /** Safety Rating rank badge, as on {@link StandingEntry.safetyRank}. */
  safetyRank?: { rank: string; tier: number };
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
/*  Track map                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One car as the **track map** places it: a world position on the same ground
 * plane as the learned centre path, plus how far round the lap it is.
 *
 * Two placements, deliberately, because they fail in different situations and
 * the widget prefers whichever it has. {@link x}/{@link z} is the truth — the
 * car's actual position, so it sits on its real line through a corner and in the
 * pit lane rather than on the racing line — but it comes from shared memory,
 * which is empty when the sim isn't publishing physics. {@link lapFraction}
 * comes from the REST/scoring feed, is 1-D (it can only put the car ON the path)
 * and survives everywhere, so it is the fallback that keeps the map populated
 * while spectating.
 */
export interface TrackMapCar {
  /** Stable per-session slot/entry id — join to {@link StandingEntry} for identity. */
  slotId: number;
  /** World X in metres, in the sim's axes. Omitted when not published. */
  x?: number;
  /** World Y (up) in metres — the dot's elevation. Omitted when not published. */
  y?: number;
  /** World Z in metres, in the sim's axes. Omitted when not published. */
  z?: number;
  /**
   * Progress round the lap, `0`..`1` from the start/finish line. Omitted when
   * the sim hasn't published a lap distance for this car.
   */
  lapFraction?: number;
  /** `true` when the sim has this car in the pit lane or its garage stall. */
  inPit: boolean;
  /** `true` for the player's own car. */
  isPlayer: boolean;
}

/**
 * The **track map** block: which circuit shape the widget should be drawing, how
 * far along learning it is, and where every car is on it.
 *
 * ## The shape itself is NOT on this block, on purpose
 * A centre path is ~1500 points that change when the track changes — a handful
 * of times a session — and putting it in the frame would repeat 40 KB thirty
 * times a second for no reason. So the geometry is served over HTTP at
 * `/trackmap.json` (the same channel `/appearance.json` and the sponsor manifest
 * use) and this block carries only the {@link revision} the widget compares
 * against what it has fetched. See `telemetry/trackMap.ts`.
 */
export interface TrackMapState {
  /** Slug identifying the loaded track + layout + length; `""` when unknown. */
  key: string;
  /**
   * Bumped whenever the served path changes. The widget refetches
   * `/trackmap.json` when this differs from the revision it drew, and otherwise
   * never touches the network.
   */
  revision: number;
  /** `true` once a full lap of geometry exists and `/trackmap.json` will serve it. */
  ready: boolean;
  /**
   * How much of the lap has been learned so far, `0`..`1`. Only meaningful while
   * {@link ready} is `false` — the widget shows it as a "learning the track"
   * progress read rather than an empty panel.
   */
  progress: number;
  /**
   * `true` when this progress is a REBUILD: a map that had been learned was
   * found not to describe the circuit being driven and was thrown away
   * (`telemetry/trackMap.ts`).
   *
   * Only the wording changes, and it is worth the field. A map that was on
   * screen last lap and is a progress bar this lap looks like something broken
   * unless the panel says what happened — and what happened is the overlay
   * fixing itself, which is the opposite of broken.
   */
  relearning?: boolean;
  /** Every car on track, the player included. */
  cars: TrackMapCar[];
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
   * The state of the racing surface in words — `DRY`, `DAMP`, `WET`,
   * `VERY WET`, `SATURATED` — plus, when the track is not uniform, whether it is
   * drying or getting wetter.
   *
   * A percentage answers "how wet" and not "what does that mean for me", which
   * is the question a driver glancing at it is actually asking: the tyre
   * decision changes at DAMP→WET, not at 41%.
   */
  trackCondition?: string;
  /**
   * Which way the surface is going — `drying`, `wetting`, or `steady`. Derived
   * from the trend in wetness over the last few minutes, so it survives the
   * feed's own jitter.
   */
  trackTrend?: 'drying' | 'wetting' | 'steady';
  /**
   * How uneven the surface is: the spread between the driest and wettest part of
   * the circuit, `0..1`. High while a dry line is forming (or being washed away)
   * and near zero once the whole lap is the same. Omitted when the feed does not
   * publish both ends.
   */
  trackSpread?: number;
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
  /**
   * Where every car is on the circuit, for the 2.5-D track map. **Optional and
   * omitted** — not an empty block — when no track is loaded or the provider
   * cannot place a single car, so the widget can tell "between sessions" from
   * "everyone is on the grid". The circuit's SHAPE is not here; it is fetched
   * from `/trackmap.json` when {@link TrackMapState.revision} changes. See
   * {@link TrackMapState}.
   */
  trackMap?: TrackMapState;
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
