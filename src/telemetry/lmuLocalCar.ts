/**
 * @file src/telemetry/lmuLocalCar.ts
 * @module telemetry/lmuLocalCar
 *
 * Reads **just the locally-driven car's physics** (pedal inputs, gear, RPM,
 * speed and fuel) from the rF2/LMU shared-memory Telemetry buffer.
 *
 * The {@link LmuRestProvider} gets the whole field (standings, gaps, weather)
 * from Le Mans Ultimate's REST API, but the REST API does not expose driver
 * inputs or fuel *in litres*. Those physics channels ARE published in shared
 * memory — but reliably only for the car being driven on this PC (a spectated
 * remote car's record is not populated). So this reader is the "your own car"
 * half of the hybrid: it finds the driven car and returns its inputs + fuel,
 * which the provider merges into the frame's player + fuel state.
 *
 * ## What it deliberately does NOT read
 * Tyre temperatures. LMU has restructured its per-wheel layout away from the
 * documented rF2 `rF2Wheel` struct (the stock double-precision `mTemperature`
 * offsets read as zero / absolute-zero on current builds), so there is no
 * reliable offset to read them from without LMU's private struct definition.
 * Tyre temps are left to the (unavailable) REST path rather than shown wrong.
 *
 * All offsets below are the rF2 `rF2VehicleTelemetry` offsets that were verified
 * live against Le Mans Ultimate (throttle, brake, gear, RPM, fuel and capacity
 * all read correct values). Everything degrades to `null` when koffi/Win32 is
 * unavailable, the platform is not Windows, or the sim/plugin is not running.
 *
 * ## Tyre temperatures — found after all
 * The earlier "LMU publishes no tyre temps" conclusion was wrong on two counts:
 * the record stride was mis-set (see {@link VT.stride}), and any check made in
 * the garage reads absolute zero because LMU reports 0 K for a car not running
 * on track. With the correct 1888 stride, the per-wheel `mTemperature[3]`
 * (inner/centre/outer, in KELVIN) is right where the rF2 struct says it is. The
 * offset below was pinned live against a SimHub reference: all twelve bands
 * matched to 0.01 °C while driving, and both read 0 K in the pits. SimHub is
 * only the calibration oracle — nothing here depends on it at runtime.
 */

import { UNKNOWN_VALUE } from './types';
import type { ChassisState, MotionState } from './types';
import { decodeMotion } from './motion';
import type { Vec3 } from './motion';
import { ChassisTracker } from './chassis';
import type { RawCorner, RawCornerSet } from './chassis';

/* Verified rF2VehicleTelemetry field offsets (bytes), x64, #pragma pack(4). */
const VT = {
  base: 16, // records start after header(12) + mNumVehicles(4)
  // Per-vehicle record size. LMU's rF2VehicleTelemetry is 1888 bytes, NOT the
  // 2880 an old rF2 header would suggest. This was the root cause of the
  // "reads another car's inputs" saga: at stride 2880 only record 0 landed on a
  // real record boundary and every other car decoded as garbage, so the mID
  // match below could never find the player unless they happened to sit at
  // index 0. Derived + verified live: vehicle-name strings recur exactly every
  // 1888 bytes across all 30 records, and each record's `mID` then matches its
  // REST `slotID` (e.g. player slot 31 == record mID 31).
  stride: 1888,
  mID: 0,
  // double mElapsedTime — the sim's running clock (seconds). Layout is pinned by
  // the verified neighbours: mID(0..4) + mDeltaTime(4..12) + mElapsedTime(12..20)
  // + mLapNumber(20..24) + mLapStartET(24..32) + mVehicleName(32..96).
  mElapsedTime: 12,
  mLapNumber: 20, // long: mID(0)+mDeltaTime(4..12)+mElapsedTime(12..20)
  // double mLapStartET — mElapsedTime at the moment this lap started. So
  // (mElapsedTime − mLapStartET) is the EXACT time into the current lap, at
  // physics rate, and lapStartET(new) − lapStartET(old) is the exact completed
  // lap time. This is the real lap clock the REST `timeIntoLap` only
  // approximates (that one pauses while the car is stationary).
  mLapStartET: 24,
  // char mVehicleName[64]: livery + racing number, e.g. "Iron Lynx 2026 #79:W"
  // (kept for logging/diagnostics; the player is matched by mID, since car
  // numbers can repeat across classes — e.g. two #21s in one field).
  mVehicleName: 32,
  // rF2Vec3 mPos — the car's WORLD position (metres). Pinned by the same
  // evidence as mLocalVel: mVehicleName[32..96] + mTrackName[96..160] put mPos at
  // 160, and the verified mLocalVel at 184 (three doubles later) leaves no other
  // possibility. This is the only spatial channel a radar can use — the REST
  // feed's lapDistance is 1-D and cannot say left-of / right-of.
  mPos: 160,
  mLocalVelZ: 200, // rF2Vec3 mLocalVel.z (forward component)
  // The motion block. These are NOT scanned-for offsets — they are bracketed on
  // both sides by offsets already verified live, which is stronger evidence
  // than a scan could give. mLocalVel.z=200 fixes mLocalVel at 184, and the ISI
  // struct order from there is fixed:
  //   mLocalVel(184) mLocalAccel(208) mOri[3](232) mLocalRot(304)
  //   mLocalRotAccel(328) -> mGear(352)
  // and mGear=352 is verified. The block lands exactly in the gap, with no
  // slack: three rF2Vec3 (24 B each) plus the 3x24 B matrix fill 184..352
  // precisely. A wrong offset here would have to be wrong by a whole multiple
  // of 24 AND still leave mGear where it demonstrably is.
  mLocalVel: 184, // rF2Vec3, m/s
  mLocalAccel: 208, // rF2Vec3, m/s^2
  mOri: 232, // rF2Vec3[3] — rows of the local->world matrix
  mLocalRot: 304, // rF2Vec3, rad/s
  mGear: 352,
  mEngineRPM: 356,
  mUnfilteredThrottle: 388,
  mUnfilteredBrake: 396,
  mUnfilteredSteering: 404,
  mUnfilteredClutch: 412,
  // Filtered inputs = what actually reaches the car AFTER driver aids. The
  // gap between unfiltered and filtered is live TC (throttle) / ABS (brake)
  // intervention. They sit directly after the unfiltered block in the struct.
  mFilteredThrottle: 420,
  mFilteredBrake: 428,
  mFuel: 524,
  mEngineMaxRPM: 532,
  // uint8 pit-speed-limiter state, 0 = off / 1 = on. NOT the documented rF2
  // offset — pinned live 2026-08-04 by diffing 5 Hz snapshots of this record
  // against the driver toggling the limiter on the formation lap (six flips in
  // exact sync, off again one second after the green, on again through a pit
  // stop). See docs/race-control-signals.md.
  mSpeedLimiter: 604,
  mFuelCapacity: 608,
  // Live rear brake bias (fraction, 0..1 = share of braking on the rear) — the
  // value the driver adjusts on the fly, and the one thing the REST garage API
  // only ever reports at its frozen SETUP value. This is the ISI-standard offset,
  // verified live on LMU v1.3000 FOR THE PLAYER'S OWN RECORD: it tracked an
  // on-track front sweep (0.478 → 0.43). (A value at 696 moves in the pits but
  // reads 0 on track and is not this. It is not the battery charge either —
  // that is at 704; 696 stays a hard 0.000 on a Hypercar at every speed.) Like
  // every offset here it is version-sensitive and may shift on an LMU update.
  mRearBrakeBias: 664,
  /* ------------------------ Electric boost block -------------------------
   * ISI's hybrid/ERS block, which LMU's Hypercars populate and everything else
   * leaves at zero:
   *
   *   704 double mBatteryChargeFraction      (0..1 state of charge)
   *   712 double mElectricBoostMotorTorque   (Nm, signed: +deploy / −harvest)
   *   720 double mElectricBoostMotorRPM
   *   728 double mElectricBoostMotorTemperature
   *   736 double mElectricBoostWaterTemperature
   *   744 unsigned char mElectricBoostMotorState
   *
   * ## These were VERIFIED MOVING, and the layout guess was wrong
   * They were first placed at 696/704 by counting the ISI struct forward from
   * the verified `mRearBrakeBias` at 664. That reasoning was clean and it was
   * WRONG BY ONE DOUBLE — LMU has eight bytes there that the stock layout does
   * not, and 696 reads a hard 0.000 on a Hypercar at any speed. Had the guards
   * below not existed, the overlay would have shipped a battery gauge pinned at
   * empty on the only class that has one.
   *
   * What settles it is a lap, not an argument. On a GR010 accelerating and
   * braking, all five doubles behave as their names claim and nothing else in
   * the record does:
   *
   *   704  0.992 → 0.997, rising WHILE THE BRAKE IS APPLIED — a pack charging
   *        on regen, and always inside [0,1]
   *   712  −1 Nm coasting, −177 Nm on the brakes: signed, negative on harvest
   *   720  tracks road speed (≈52 × km/h) — a motor geared to the wheels
   *   728  37.5 °C, 736  35.5 °C — two plausible, slowly-drifting temperatures
   *   744  1 while idling, 3 the moment regen engages
   *
   * Five independent channels agreeing at once, each in its own units, is what
   * makes this read rather than derived. `scripts/probe-lmu-hybrid.js` reproduces
   * it, and should be re-run after an LMU update like every offset in this file.
   *
   * Both published channels stay guarded on read: a charge outside `[0,1]` or a
   * torque past any plausible motor is discarded rather than published, so a
   * future shift degrades to "no hybrid" instead of a wrong gauge — which is
   * exactly the failure mode that caught the original mistake.
   */
  mBatteryChargeFraction: 704,
  mElectricBoostMotorTorque: 712,
  /* ----------------------- LMU's driving-aid block -----------------------
   * TC, its two sub-settings, ABS and the motor map, live, for the player's
   * own car — each a single BYTE, paired with the maximum the car allows.
   *
   * These were declared unreadable here for two releases ("no live value
   * anywhere, verified twice"), and the note was wrong in a way worth
   * recording, because both traps are easy to fall into again:
   *
   *   - they are BYTES in what stock rF2 leaves as reserved expansion space,
   *     so a scan looking for doubles or ints steps straight over them;
   *   - AI cars publish ZEROS here. Probe any record but the driver's own and
   *     the block reads empty, which looks exactly like "not supported".
   *
   * Cross-checked against SimHub's own LMU struct
   * (`RfactorReader.LMU.TelemInfoV01`), which declares `mRearBrakeBias` at
   * 664 — the offset directly above, already verified live on track. Two
   * independent descriptions agreeing on that anchor is what makes the rest of
   * the block trustworthy rather than scanned-for. Verified live besides: on
   * the player's record TC read 7/11, ABS 9/9, motor map 1/1, matching both
   * the game and the values the overlay had been counting.
   */
  mABSActive: 746,
  mTCActive: 747,
  mTC: 750,
  mTCMax: 751,
  mTCSlip: 752,
  mTCSlipMax: 753,
  mTCCut: 754,
  mTCCutMax: 755,
  mABS: 756,
  mABSMax: 757,
  mMotorMap: 758,
  mMotorMapMax: 759,
  /* --------------- The Hypercar aids, continuing the same run ---------------
   * Three more value/max byte pairs immediately after the motor map, found by
   * correlating this record against `getPlayerGarageData` on a Toyota GR010 with
   * the aids set to distinct values. All three matched on BOTH bytes at once:
   *
   *   760/761  brake migration  raw 2/5   REST value 2, maxValue 6
   *   762/763  front ARB        raw 6/15  REST value 6, maxValue 16
   *   764/765  rear ARB         raw 1/15  REST value 1, maxValue 16
   *
   * The `maxValue = raw max + 1` relation is not an assumption fitted to these
   * three — it holds across every pair already verified in this block (TC 7/11
   * vs REST max 12, slip, power cut, ABS 0/0 vs max 1, motor map 7/10 vs max
   * 11). Eight independent pairs agreeing on both halves is what makes these
   * offsets read rather than guessed.
   *
   * REGEN LEVEL IS DELIBERATELY ABSENT. The car publishes one over REST
   * (`VM_REGEN_LEVEL`, value 10 of max 11) and it is NOT in this buffer: a scan
   * of all 1888 bytes found no adjacent `10,10` pair anywhere, and everything
   * past 766 is zeros, then floats, then the car-model string. Byte 759 holds a
   * 10 and would fit regen numerically — but it is the motor map's MAX, which
   * is what keeps the strict value/max pairing intact across the whole run and
   * matches the "motor map 1/1" reading verified live earlier. So regen comes
   * from the garage endpoint instead; see `mfdControl.projectAids`.
   */
  mBrakeMigration: 760,
  mBrakeMigrationMax: 761,
  mFrontARB: 762,
  mFrontARBMax: 763,
  mRearARB: 764,
  mRearARBMax: 765,
  // mWheels[4] (FL, FR, RL, RR). Each LMU rF2Wheel record is 260 bytes; its
  // mTemperature[3] band array (inner/centre/outer, in KELVIN) sits at the
  // wheel base +0/+8/+16. Verified live vs SimHub — all 12 bands matched to
  // 0.01 °C driving; both read 0 K in the garage (→ reported as unknown).
  mWheelTempBase: 976,
  mWheelStride: 260,
  /**
   * Start of `mWheels[0]` — i.e. `mWheelTempBase − 128`, since `mTemperature[3]`
   * sits at +128 inside every ISI `rF2Wheel`.
   *
   * This is not a guess and was not scanned for. Two independently verified
   * offsets pin it from opposite ends of the struct: the surface temp triplet at
   * 976 (matched to 0.01 °C against SimHub on all twelve bands) and the
   * brake-disc temp at 872, which is wheel-start +24. Both are satisfied only
   * by a wheel base of 848 — the same base rF2 uses, which is the expected
   * result since LMU inherits the struct and only shortens the record (260-byte
   * stride vs rF2's 344).
   */
  mWheelBase: 848,
  // Offsets INSIDE each wheel record, from the standard ISI TelemWheelV01
  // layout. The four verified anchors in this same struct — brake temp +24,
  // pressure +120, temperature +128, wear +152 — fix the field order, so these
  // fall out of it rather than being probed independently.
  mSuspensionDeflection: 0, // double, metres, positive = compressed
  mRideHeight: 8, // double, metres
  mSuspForce: 16, // double, Newtons (pushrod load)
  mTireLoad: 104, // double, Newtons — vertical load through the contact patch
  mGripFract: 112, // double, 0..1 fraction of the patch still gripping
  // mTireInnerLayerTemperature[3] — the tyre *inner-liner* temps, three doubles
  // per wheel at +84/+92/+100 from the surface base (wheel-start +212 in the
  // rF2Wheel struct; the brake-disc temp at wheel-start +24, i.e. −104 here,
  // pins the struct start). Their mean is the channel LMU's in-game tyre HUD
  // shows — verified against the game's own MFD, matching within a few tenths
  // across all four corners (the carcass core at +76 reads ~0.8 °C higher).
  mWheelInnerRel: 84,
  /**
   * `mTireCarcassTemperature` — the carcass **core**, a single double per wheel
   * (not a band triplet), at wheel-start +204 i.e. +76 from the surface base.
   * Confirmed live alongside the two triplets: cold-soaked it sits within a
   * tenth of the liner mean, and it moves with them once running.
   */
  mWheelCoreRel: 76,
  /**
   * `mBrakeTemp` — the brake **disc** temperature, one double per wheel in
   * Kelvin, at wheel-start +24. This is one of the four verified anchors that
   * pin the wheel struct (see {@link VT.mWheelBase}); it was read for
   * validation long before it was published. Relative to the wheel START, not
   * the surface-temp base.
   */
  mWheelBrakeRel: 24,
  /**
   * `mPressure` — tyre pressure, one double per wheel in **kPa**, at
   * wheel-start +120. Another of the four anchors that pin the wheel struct
   * (brake +24, pressure +120, temperature +128, wear +152); like the brake
   * disc it was used for validation before being published. Reads 0 in the
   * garage (like the temps' 0 K), so implausible values become unknown.
   */
  mWheelPressureRel: 120,
} as const;

/** Kelvin → Celsius. LMU stores tyre temps in Kelvin. */
const KELVIN = 273.15;
/**
 * Plausible tyre-surface range in °C. Anything outside is not a tyre reading:
 * ≈ −273 is a car not on track (0 K), and hundreds of °C is a brake disc the
 * read may have slid onto. Bands outside this window are discarded per corner.
 */
const TYRE_MIN_C = -20;
const TYRE_MAX_C = 200;

// NB: the header's mNumVehicles (offset 12) undercounts LMU's telemetry buffer,
// so the record scan is bounded by how many records fit the region, not by it.
const MMF_TELEMETRY = '$rFactor2SMMP_Telemetry$';
/**
 * The Scoring buffer, mapped ONLY for its header. Two bytes matter here, both
 * verified live 2026-08-07 (Daytona, byte-diff probe against deliberate screen
 * changes — see the session-ontrack-signal memory):
 *
 *   - byte 120: ScoringInfo's mGamePhase (matched REST's numeric phase all
 *     session) — read purely as a sanity check that the header is laid out
 *     the way we think.
 *   - byte 127: mInRealtime — `1` with the driver in the world, `0` on the
 *     sim's garage/pit-strategy/setup pages. This is the ONE channel that
 *     catches those pages: REST's numeric gamePhase stays 5 (green) on all
 *     of them and only reports 9 for the ESC/monitor screen.
 *
 * (Layout: 12-byte MMF version header + ScoringInfo, whose mPlayerName sits at
 * 128 — "Carl Jones" read back there during the probe, pinning the offsets.)
 */
const MMF_SCORING = '$rFactor2SMMP_Scoring$';
const SCORING_GAME_PHASE_OFFSET = 120;
/**
 * `mSectorFlag[3]` — absolute bytes 122..124 (12-byte MMF header + SI offset
 * 110), bracketed by mGamePhase@120 and mInRealtime@127 and pinned by
 * mPlayerName@128. Decoded live 2026-08-26 (Daytona practice, 22-car field,
 * two separate incidents): value **1 = local yellow in that sector, 11 =
 * clear**, index 0..2 = S1..S3 — each yellow correlated with a car stopped on
 * track whose REST `sector` string named the same sector. This is the ONLY
 * per-sector source: REST's `sectorFlag` array published one value copied into
 * all three slots both times, and missed the second (S3) yellow entirely.
 * Values 2 and 3 have been seen once under a red flag (2026-08-22, undecoded);
 * consumers must treat anything other than 1/11 as "no opinion".
 */
const SCORING_SECTOR_FLAGS_OFFSET = 122;
const SCORING_IN_REALTIME_OFFSET = 127;
const FILE_MAP_READ = 0x0004;
const TORN_READ_RETRIES = 4;
/** Worst-case bytes we might need (clamped to the real region on open). */
const MAX_BYTES = VT.base + 128 * VT.stride;

/**
 * One corner's three across-the-tread temperatures in °C, **oriented to the
 * car**: `[inner, centre, outer]`, where `inner` is the shoulder toward the
 * car's centreline.
 *
 * The sim does not publish them that way. Its `mTemperature[3]` runs in a fixed
 * car-space direction — LMU's own REST tyre screen names the three
 * `leftTemperature` / `centerTemperature` / `rightTemperature` — so index 0 is
 * the OUTER shoulder on the left of the car and the INNER shoulder on the
 * right. Reading it as inner→outer everywhere mirrors both right-hand tyres,
 * which is exactly the kind of error that looks plausible on screen: the
 * numbers are all real, they are just attributed to the wrong shoulder, and a
 * camber or pressure call read off them would be backwards on one side of the
 * car. {@link readWheelBands} does the flip once, here, so nothing downstream
 * has to know the sim's convention.
 */
export type TyreBands = [number, number, number];
/** Bands for `[FL, FR, RL, RR]`; `null` for a corner with no usable reading. */
export type TyreBandSet = [
  TyreBands | null,
  TyreBands | null,
  TyreBands | null,
  TyreBands | null,
];

/** Physics for the locally-driven car. All values already normalized. */
export interface LocalCarPhysics {
  throttle: number; // 0..1
  brake: number; // 0..1
  clutch: number; // 0..1
  steer: number; // -1..1
  /** Live traction-control intervention (unfiltered − filtered throttle), 0..1. */
  tc: number;
  /** Live ABS intervention (unfiltered − filtered brake), 0..1. */
  abs: number;
  gear: number; // -1 reverse, 0 neutral, 1..n
  rpm: number;
  maxRpm: number;
  speedKph: number;
  /**
   * The same forward speed in m/s, unrounded. `speedKph` is rounded to whole
   * km/h for display, and that 0.28 m/s of quantisation is a bias rather than
   * noise — held for as long as the car holds a speed — so anything that
   * *integrates* speed (the delta engine's road-position observer) has to read
   * it from here instead.
   */
  speedMps: number;
  /**
   * Live rear brake-bias fraction `0..1` (share of braking on the rear) — the
   * value the driver shifts on the fly. `UNKNOWN_VALUE` when it reads outside a
   * plausible range. Read from shared memory because the REST garage API only
   * reports the frozen setup value; see `VT.mRearBrakeBias`.
   */
  rearBrakeBias: number;
  fuelLiters: number;
  capacityLiters: number;
  /**
   * Pit-speed-limiter state: `true` on, `false` off, `null` when the byte reads
   * outside 0/1 (unknown layout on this build — report nothing rather than a
   * wrong prompt; the race-control widget's limiter callouts stay silent).
   */
  limiterOn: boolean | null;
  /**
   * Hybrid state of charge, `0`..`1`, or `UNKNOWN_VALUE` when the channel reads
   * outside that range — which is what a torn read or a shifted offset looks
   * like. A car with no hybrid reads a legitimate, constant `0`; separating that
   * from a Hypercar sitting flat is not this function's job (it is stateless) and
   * is done by the per-car latch in the provider.
   */
  batteryCharge: number;
  /**
   * Electric motor torque in Nm, signed (+ deploying / − harvesting), or
   * `UNKNOWN_VALUE` when implausible. See {@link VT.mBatteryChargeFraction}.
   */
  motorTorqueNm: number;
  /**
   * Per-corner tyre **surface** temperature in °C `[FL, FR, RL, RR]`, each the
   * mean of the inner/centre/outer bands. `UNKNOWN_VALUE` (-1) when the car
   * isn't running on track (LMU reports 0 K in the garage) or a band reads
   * implausibly.
   */
  tyreTempsC: [number, number, number, number];
  /**
   * Per-corner tyre **inner-liner** temperature in °C `[FL, FR, RL, RR]` — the
   * mean of the three inner-layer bands, which is the channel LMU's in-game HUD
   * shows. `UNKNOWN_VALUE` when unavailable.
   */
  tyreHudTempsC: [number, number, number, number];
  /**
   * Per-corner **surface** temperature bands in °C, `[FL, FR, RL, RR]`, each
   * `[inner, centre, outer]` oriented relative to the CAR — see
   * {@link TyreBands} for why the sim's own order cannot be used directly.
   * `null` when this corner has no usable reading.
   */
  tyreSurfaceBandsC: TyreBandSet;
  /**
   * Per-corner **inner-liner** temperature bands in °C, same shape and the same
   * inner/centre/outer orientation as {@link tyreSurfaceBandsC}.
   */
  tyreLinerBandsC: TyreBandSet;
  /**
   * Per-corner carcass **core** temperature in °C `[FL, FR, RL, RR]`, a single
   * value per corner (not banded). `UNKNOWN_VALUE` when unavailable.
   */
  tyreCoreC: [number, number, number, number];
  /**
   * Per-corner brake **disc** temperature in °C `[FL, FR, RL, RR]`.
   * `UNKNOWN_VALUE` when unavailable (garage reads 0 K, like the tyres).
   */
  tyreBrakeC: [number, number, number, number];
  /**
   * Per-corner tyre pressure in **kPa** `[FL, FR, RL, RR]`. `UNKNOWN_VALUE`
   * when unavailable (the garage publishes 0, exactly like the temps' 0 K).
   */
  tyrePressureKpa: [number, number, number, number];
  /** Current lap number for this car (for fuel lap-boundary detection). */
  lapNumber: number;
  /**
   * Exact seconds into the current lap (`mElapsedTime − mLapStartET`), at
   * physics rate. `UNKNOWN_VALUE` when the clock reads implausibly (no lap
   * running yet / between sessions).
   */
  lapTimeSec: number;
  /**
   * The sim clock (`mElapsedTime`, seconds) at which the current lap started.
   * Two successive values differ by the exact completed-lap time. May be `0`
   * before the first lap.
   */
  lapStartET: number;
  /**
   * Raw sim session clock `mElapsedTime` (seconds) — a monotonic real-time clock
   * (ticks 1:1 with wall time, pauses when the game pauses). Reliable even though
   * `mLapStartET` is not, so it's used as the delta engine's time axis (REST
   * `timeIntoLap` is a position-derived estimate, useless for a live delta).
   * `UNKNOWN_VALUE` when it reads implausibly.
   */
  elapsedSec: number;
  /** Racing number parsed from the record's vehicle name (e.g. "79"), or "". */
  carNumber: string;
  /**
   * G-force / rotation / attitude, normalised out of ISI's axis convention.
   * `null` when the motion block fails its plausibility guards.
   */
  motion: MotionState | null;
  /**
   * The four wheels' load/suspension block exactly as shared memory holds it
   * (metres and Newtons, no thresholds applied), in sim order FL, FR, RL, RR.
   * `null` when a corner fails its plausibility guard.
   *
   * Raw rather than decoded because turning it into {@link ChassisState}
   * requires the cross-frame reference average owned by {@link ChassisTracker},
   * and {@link parseRecord} is deliberately stateless.
   */
  rawCorners: RawCornerSet | null;
  /**
   * Four-corner load and suspension state, thresholds applied. `null` when
   * {@link rawCorners} is null or the tracker rejects the block. Populated by
   * {@link LmuLocalCarReader}, which owns the tracker.
   */
  chassis: ChassisState | null;
  /**
   * The driver's aid SETTINGS as the car currently holds them. `null` when the
   * block reads empty, which is what a car that is not the player's own looks
   * like — see {@link VT.mTC}.
   *
   * Not to be confused with {@link tc} / {@link abs} above: those are how hard
   * the systems are intervening this instant, which is a different question from
   * which map the driver has selected.
   */
  aidSettings: AidSettings | null;
}

/** One aid: where it is set, and the highest setting this car offers. */
export interface AidStep {
  value: number;
  max: number;
}

/**
 * The aid maps the driver can select, read live from the car.
 *
 * `tcSlip` and `tcCut` are LMU's two traction-control sub-settings — the slip
 * angle it starts working at, and how much power it cuts when it does — which
 * are separate controls from the TC map itself and are shown as separate rows.
 */
export interface AidSettings {
  tc: AidStep;
  tcSlip: AidStep;
  tcCut: AidStep;
  abs: AidStep;
  motorMap: AidStep;
  /**
   * How much brake bias migrates forward as the car slows, in the sim's own
   * steps. A Hypercar control; `max` is 0 on cars that do not offer it, which is
   * how the MFD knows not to show a row.
   */
  brakeMigration: AidStep;
  /** Front anti-roll bar position. Adjustable from the cockpit on a Hypercar. */
  frontARB: AidStep;
  /** Rear anti-roll bar position. */
  rearARB: AidStep;
  /** True while the system is actually intervening, as of this frame. */
  tcActive: boolean;
  absActive: boolean;
}

/**
 * A snapshot of **every car's world position** plus the driven car's
 * orientation — the raw spatial state the radar's geometry ({@link
 * module:telemetry/radar}) turns into car-relative blips. Read from the same
 * Telemetry buffer as {@link LocalCarPhysics}, in one consistent pass.
 */
export interface RadarField {
  /** The driven car's world position (`mPos`), metres. */
  playerPos: Vec3;
  /** The driven car's orientation matrix (`mOri[3]`, rows of local→world). */
  ori: [Vec3, Vec3, Vec3];
  /** Every OTHER car's world position, keyed by slot id (player excluded). */
  cars: Array<{ slotId: number; pos: Vec3 }>;
}

/** Minimal koffi-bound Win32 surface (see {@link loadWin32}). */
interface Win32 {
  OpenFileMappingW: (access: number, inherit: boolean, name: string) => unknown;
  MapViewOfFile: (h: unknown, a: number, hi: number, lo: number, bytes: number) => unknown;
  UnmapViewOfFile: (addr: unknown) => boolean;
  CloseHandle: (h: unknown) => boolean;
  /** Decode `len` bytes at `addr + offset` into a Buffer (no full-region copy). */
  readBytes: (addr: unknown, offset: number, len: number) => Buffer;
  /** Decode a single little-endian uint32 at `addr + offset`. */
  readU32: (addr: unknown, offset: number) => number;
  /** Decode a single little-endian int32 at `addr + offset`. */
  readI32: (addr: unknown, offset: number) => number;
  /** Decode a single double at `addr + offset`. */
  readF64: (addr: unknown, offset: number) => number;
  regionSize: (addr: unknown) => number;
}

function loadWin32(): Win32 | null {
  if (process.platform !== 'win32') return null;
  let koffi: any;
  try {
    koffi = require('koffi'); // optional dependency
  } catch {
    return null;
  }
  try {
    const k32 = koffi.load('kernel32.dll');
    const OpenFileMappingW = k32.func('void* __stdcall OpenFileMappingW(uint32, bool, str16)');
    const MapViewOfFile = k32.func(
      'void* __stdcall MapViewOfFile(void*, uint32, uint32, uint32, size_t)',
    );
    const UnmapViewOfFile = k32.func('bool __stdcall UnmapViewOfFile(void*)');
    const CloseHandle = k32.func('bool __stdcall CloseHandle(void*)');
    const VirtualQuery = k32.func('size_t __stdcall VirtualQuery(void*, void*, size_t)');
    // Offset decodes read just the bytes asked for — the previous whole-region
    // copy (~368 KB through a JS number[] up to 8×/poll at 30 Hz) blocked the
    // event loop long enough to lag the pedal feed by whole seconds.
    const readBytes = (addr: unknown, offset: number, len: number): Buffer =>
      Buffer.from(koffi.decode(addr, offset, koffi.array('uint8', len)) as number[]);
    const readU32 = (addr: unknown, offset: number): number =>
      koffi.decode(addr, offset, 'uint32') as number;
    const readI32 = (addr: unknown, offset: number): number =>
      koffi.decode(addr, offset, 'int32') as number;
    const readF64 = (addr: unknown, offset: number): number =>
      koffi.decode(addr, offset, 'double') as number;
    const regionSize = (addr: unknown): number => {
      try {
        const mbi = Buffer.alloc(48);
        if (VirtualQuery(addr, mbi, 48) === 0) return 0;
        return Number(mbi.readBigUInt64LE(24)); // RegionSize @ offset 24 (x64)
      } catch {
        return 0;
      }
    };
    return {
      OpenFileMappingW,
      MapViewOfFile,
      UnmapViewOfFile,
      CloseHandle,
      readBytes,
      readU32,
      readI32,
      readF64,
      regionSize,
    };
  } catch {
    return null;
  }
}

/**
 * Opens the shared-memory Telemetry buffer and reads the driven car's physics.
 * Safe to construct and use on any platform: when shared memory is unavailable,
 * {@link read} simply returns `null`.
 */
export class LmuLocalCarReader {
  private readonly win32: Win32 | null;
  private handle: unknown = null;
  private view: unknown = null;
  private size = 0;
  /** Scoring-header mapping (see MMF_SCORING) — only bytes 120/127 are read. */
  private scoringHandle: unknown = null;
  private scoringView: unknown = null;
  /** Record index of the driven car found last poll — probed first next poll. */
  private cachedIdx = -1;
  /**
   * Cross-frame state for the four-corner load channels. Lives here rather than
   * in {@link parseRecord} because it learns a per-corner reference over ~25 s
   * and so must survive between reads.
   */
  private readonly chassis = new ChassisTracker();

  public constructor() {
    this.win32 = loadWin32();
  }

  /** Whether a shared-memory reader is even possible on this host. */
  public get available(): boolean {
    return this.win32 !== null;
  }

  public start(): void {
    this.open();
  }

  public stop(): void {
    const w = this.win32;
    if (w && this.view) {
      try {
        w.UnmapViewOfFile(this.view);
        if (this.handle) w.CloseHandle(this.handle);
      } catch {
        /* best-effort */
      }
    }
    this.view = null;
    this.handle = null;
    this.size = 0;
    this.cachedIdx = -1;
    this.stopScoring();
  }

  private stopScoring(): void {
    const w = this.win32;
    if (w && this.scoringView) {
      try {
        w.UnmapViewOfFile(this.scoringView);
        if (this.scoringHandle) w.CloseHandle(this.scoringHandle);
      } catch {
        /* best-effort */
      }
    }
    this.scoringView = null;
    this.scoringHandle = null;
  }

  private openScoring(): void {
    const w = this.win32;
    if (w === null || this.scoringView) return;
    try {
      const handle = w.OpenFileMappingW(FILE_MAP_READ, false, MMF_SCORING);
      if (!handle) return;
      const view = w.MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
      if (!view) {
        w.CloseHandle(handle);
        return;
      }
      this.scoringHandle = handle;
      this.scoringView = view;
    } catch {
      this.scoringView = null;
      this.scoringHandle = null;
    }
  }

  /**
   * Whether the driver is IN THE WORLD — at the wheel, on track or in the
   * stall — as opposed to on the sim's garage / pit-strategy / setup pages.
   * `null` when the answer isn't trustworthy (no shared memory, sim closed,
   * or the header doesn't look like the ScoringInfo we probed), and callers
   * must treat `null` as "don't hide anything".
   *
   * Single-byte reads, so torn reads aren't a concern; the phase byte is a
   * cheap layout check, not data. A frozen mapping after the sim closes is
   * harmless here: the REST feed dies with the sim and its staleness fallback
   * outranks this flag.
   */
  public inRealtime(): boolean | null {
    const w = this.win32;
    if (w === null) return null;
    if (!this.scoringView) {
      this.openScoring();
      if (!this.scoringView) return null;
    }
    try {
      const phase = w.readBytes(this.scoringView, SCORING_GAME_PHASE_OFFSET, 1)[0];
      if (phase === undefined || phase > 10) return null; // not the layout we verified
      const flag = w.readBytes(this.scoringView, SCORING_IN_REALTIME_OFFSET, 1)[0];
      if (flag !== 0 && flag !== 1) return null;
      return flag === 1;
    } catch {
      // Mapping may have gone away (sim closed); drop it so we re-open later.
      this.stopScoring();
      return null;
    }
  }

  /**
   * The three per-sector marshalling bytes from the Scoring header — see
   * {@link SCORING_SECTOR_FLAGS_OFFSET} for the decode evidence. Raw bytes,
   * deliberately: the enum is only partially decoded (1 = yellow, 11 = clear)
   * and the mapping-to-FlagState policy belongs to the provider, which also
   * holds the REST value to fall back on for anything unrecognised.
   *
   * `null` when shared memory is unavailable or the header fails the same
   * layout check {@link inRealtime} applies.
   */
  public sectorFlagBytes(): [number, number, number] | null {
    const w = this.win32;
    if (w === null) return null;
    if (!this.scoringView) {
      this.openScoring();
      if (!this.scoringView) return null;
    }
    try {
      const phase = w.readBytes(this.scoringView, SCORING_GAME_PHASE_OFFSET, 1)[0];
      if (phase === undefined || phase > 10) return null; // not the layout we verified
      const b = w.readBytes(this.scoringView, SCORING_SECTOR_FLAGS_OFFSET, 3);
      if (!b || b.length < 3) return null;
      return [b[0]!, b[1]!, b[2]!];
    } catch {
      // Mapping may have gone away (sim closed); drop it so we re-open later.
      this.stopScoring();
      return null;
    }
  }

  private open(): void {
    const w = this.win32;
    if (w === null || this.view) return;
    try {
      const handle = w.OpenFileMappingW(FILE_MAP_READ, false, MMF_TELEMETRY);
      if (!handle) return;
      const view = w.MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0); // whole region
      if (!view) {
        w.CloseHandle(handle);
        return;
      }
      const region = w.regionSize(view);
      this.handle = handle;
      this.view = view;
      this.size = region > 0 ? Math.min(region, MAX_BYTES) : MAX_BYTES;
    } catch {
      this.view = null;
      this.handle = null;
    }
  }

  /**
   * Returns the driven car's physics, or `null` when unavailable (no koffi, sim
   * closed, the player's car isn't in the buffer, or a torn read). Never throws.
   *
   * `expectedSlotId` — the player's slot id from the REST standings, which
   * equals the telemetry record's `mID` (verified live: REST slot 31 == record
   * mID 31). LMU publishes a record for EVERY car in the field, so matching the
   * id is the reliable way to pick the driver's own car — and it's necessary,
   * because a car NUMBER can repeat across classes (two #21s in one field). When
   * no id is given (rf2 path / diagnostics) we fall back to the first record
   * with a live, running engine.
   *
   * Cost per call is a handful of scalar decodes plus one record copy — never a
   * copy of the whole region. Consistency comes from checking the writer's
   * version counters before and after the record copy and retrying on mismatch.
   */
  public read(expectedSlotId?: number): LocalCarPhysics | null {
    const w = this.win32;
    if (w === null) return null;
    if (!this.view) {
      this.open();
      if (!this.view) return null;
    }
    try {
      for (let attempt = 0; attempt < TORN_READ_RETRIES; attempt++) {
        const v1 = w.readU32(this.view, 0);
        if (v1 !== w.readU32(this.view, 4)) continue; // writer mid-update

        const idx = this.findDrivenCar(w, expectedSlotId);
        if (idx < 0) return null; // player's car not in the buffer this frame

        const offset = VT.base + idx * VT.stride;
        if (offset + VT.stride > this.size) return null;
        const rec = w.readBytes(this.view, offset, VT.stride);

        // Reject the copy if the writer touched the buffer while we read it.
        if (w.readU32(this.view, 0) !== v1 || w.readU32(this.view, 4) !== v1) continue;

        const car = parseRecord(rec);
        if (car === null) {
          this.cachedIdx = -1; // record went stale (parked / engine off)
          continue;
        }
        // Identity guard on the COPIED bytes: with a slot id known, the record's
        // mID must match it. Guards against a torn read that slid us onto an
        // adjacent car's record between the probe and the copy.
        const wantId = typeof expectedSlotId === 'number' && expectedSlotId >= 0;
        if (wantId && rec.readInt32LE(VT.mID) !== expectedSlotId) {
          this.cachedIdx = -1;
          continue;
        }
        this.cachedIdx = idx;
        // Decode the wheel block only once the record has passed every torn-read
        // and identity guard above. The tracker carries a learned reference
        // across frames, so feeding it a record that later turns out to be the
        // wrong car would poison that reference for the next 25 seconds.
        if (car.rawCorners) {
          car.chassis = this.chassis.update(car.rawCorners, car.elapsedSec);
        }
        return car;
      }
      return null;
    } catch {
      // Mapping may have gone away (sim closed); drop it so we re-open later.
      this.stop();
      return null;
    }
  }

  /**
   * Reads **every car's world position** plus the driven car's orientation for
   * the radar. Returns `null` when unavailable (no koffi, sim closed, the
   * player's car isn't in the buffer, or the read is torn) — the same "no data,
   * don't draw" contract as {@link read}.
   *
   * `playerSlotId` — the player's slot id (REST `slotID` == record `mID`),
   * required so the returned field can exclude the player and pick the right
   * orientation.
   *
   * ## Why there is no whole-sweep consistency gate
   * The instinct is to version-check the buffer before and after reading every
   * car and discard the lot on a mismatch — but LMU's physics writer updates at
   * hundreds of Hz, so across the dozens of reads a full field needs the writer
   * ALWAYS lands mid-sweep. That gate failed on essentially every frame and the
   * radar showed nothing. It is also unnecessary here: `mID` and `mPos` for a car
   * are read from that car's own fixed record offset, so there is no identity
   * confusion (the failure the {@link read} gate guards against), and the worst a
   * mid-read write can do is make one car's position a single physics tick stale
   * — a few centimetres, invisible on a radar. So each car is read directly off
   * the live mapping with no global gate; the reads are small and fast.
   */
  public readField(playerSlotId: number): RadarField | null {
    const w = this.win32;
    if (w === null || playerSlotId < 0) return null;
    if (!this.view) {
      this.open();
      if (!this.view) return null;
    }
    try {
      // Scan every populated record, exactly like findDrivenCar: a car's RECORD
      // INDEX in the buffer is not its slot id, so the player (or a nearby car)
      // can sit at any index. Bounding the scan to the field size — an earlier
      // bug — missed the player whenever its record sat past that many slots, and
      // the whole radar came back empty.
      const maxFit = Math.floor((this.size - VT.base) / VT.stride);
      const n = clampInt(maxFit, 0, 128);

      const cars: Array<{ slotId: number; pos: Vec3 }> = [];
      let playerPos: Vec3 | null = null;
      let ori: [Vec3, Vec3, Vec3] | null = null;

      for (let i = 0; i < n; i++) {
        const off = VT.base + i * VT.stride;
        if (off + VT.stride > this.size) break;
        const id = w.readI32(this.view, off + VT.mID);
        if (id < 0) continue;
        // mID and mPos are 24 contiguous bytes from the same record, so one small
        // copy per car keeps each position self-consistent (no global gate — see
        // the method note on why that gate can't work at LMU's write rate).
        const posBytes = w.readBytes(this.view, off + VT.mPos, 24);
        const pos: Vec3 = {
          x: posBytes.readDoubleLE(0),
          y: posBytes.readDoubleLE(8),
          z: posBytes.readDoubleLE(16),
        };
        // A record still at the world origin is uninitialised / not spawned. For
        // an empty slot mID can also read 0, which would otherwise be mistaken for
        // the real player when playerSlotId is 0 — so skip origin records for BOTH
        // the player match and the other-cars list.
        const atOrigin = pos.x === 0 && pos.y === 0 && pos.z === 0;
        if (atOrigin) continue;
        if (id === playerSlotId) {
          if (playerPos !== null) continue; // already found the driven car
          playerPos = pos;
          const oriBytes = w.readBytes(this.view, off + VT.mOri, 72);
          const vec = (b: number): Vec3 => ({
            x: oriBytes.readDoubleLE(b),
            y: oriBytes.readDoubleLE(b + 8),
            z: oriBytes.readDoubleLE(b + 16),
          });
          ori = [vec(0), vec(24), vec(48)];
        } else {
          cars.push({ slotId: id, pos });
        }
      }

      if (playerPos === null || ori === null) return null; // player not in buffer
      return { playerPos, ori, cars };
    } catch {
      this.stop();
      return null;
    }
  }

  /**
   * Finds the record index of the player's car by matching its `mID` to the
   * REST slot id. LMU publishes a record for every car in the field (all 30 at
   * once, each with live physics), so an exact id match uniquely picks the
   * driver's own car. Returns `-1` when the id isn't present (player's car not
   * in the buffer → caller shows nothing rather than another car's inputs).
   *
   * With no id (rf2 path / diagnostics) it falls back to the first record with a
   * running engine. The last matched index is checked first so steady-state
   * polls cost a couple of scalar decodes, not a full scan.
   */
  private findDrivenCar(w: Win32, expectedSlotId?: number): number {
    const wantId = typeof expectedSlotId === 'number' && expectedSlotId >= 0;
    // The header's mNumVehicles undercounts LMU's telemetry buffer (it lists ~24
    // while 30 records are populated), so bound the scan by how many records
    // physically fit rather than trusting it.
    const maxFit = Math.floor((this.size - VT.base) / VT.stride);
    const n = clampInt(maxFit, 0, 128);

    // Fast path: re-check the record we used last poll.
    if (this.cachedIdx >= 0 && this.cachedIdx < n) {
      if (
        wantId
          ? this.slotIdAt(w, this.cachedIdx) === expectedSlotId
          : this.probe(w, this.cachedIdx)
      ) {
        return this.cachedIdx;
      }
    }

    let plausible = -1;
    for (let i = 0; i < n; i++) {
      if (wantId) {
        if (this.slotIdAt(w, i) === expectedSlotId) return i;
      } else if (plausible < 0 && this.probe(w, i)) {
        plausible = i;
      }
    }
    return wantId ? -1 : plausible;
  }

  /** The `mID` (slot id) of record `i`. */
  private slotIdAt(w: Win32, i: number): number {
    return w.readI32(this.view, VT.base + i * VT.stride + VT.mID);
  }

  /** Whether record `i` looks like a locally-driven car (live pedal + engine). */
  private probe(w: Win32, i: number): boolean {
    const o = VT.base + i * VT.stride;
    const throttle = w.readF64(this.view, o + VT.mUnfilteredThrottle);
    if (throttle < -0.05 || throttle > 1.05) return false;
    const rpm = w.readF64(this.view, o + VT.mEngineRPM);
    return rpm >= 200 && rpm <= 20000;
  }
}

/** Maps one raw `rF2VehicleTelemetry` record to {@link LocalCarPhysics}. */
function parseRecord(rec: Buffer): LocalCarPhysics | null {
  const throttle = rec.readDoubleLE(VT.mUnfilteredThrottle);
  const rpm = rec.readDoubleLE(VT.mEngineRPM);
  // Re-validate on the copied bytes: the probe read the live buffer, which may
  // have changed between the probe and the copy.
  if (throttle < -0.05 || throttle > 1.05 || rpm < 200 || rpm > 20000) return null;

  const fwdVel = rec.readDoubleLE(VT.mLocalVelZ);
  const brake = clamp01(rec.readDoubleLE(VT.mUnfilteredBrake));

  // TC/ABS intervention = driver input minus what the aids let through. A
  // filtered channel stuck at exactly 0 while the pedal is pressed means the
  // sim isn't populating it — report no intervention rather than a full cut.
  const fltThrottle = rec.readDoubleLE(VT.mFilteredThrottle);
  const fltBrake = rec.readDoubleLE(VT.mFilteredBrake);
  const tc =
    fltThrottle > 0 && fltThrottle <= 1.05 ? clamp01(clamp01(throttle) - fltThrottle) : 0;
  const abs = fltBrake > 0 && fltBrake <= 1.05 ? clamp01(brake - fltBrake) : 0;

  // Per-corner tyre temp = mean of the three (Kelvin) bands, converted to °C —
  // but only over bands that fall in a plausible *tyre* range. This rejects:
  //   • a car not running on track (LMU reports 0 K ≈ −273 °C for every band);
  //   • a torn/misaligned read that slid onto a brake-disc channel (300-800 °C
  //     while driving — the record packs those just 104 bytes before each tyre
  //     block) or other garbage.
  // Averaging only the surviving bands means one bad band can't drag the corner
  // to a wrong number; fewer than two good bands → unknown (widget shows tread).
  // A single Kelvin double → °C, or NaN if outside the plausible tyre range.
  const tyreC = (absOffset: number): number => {
    const c = rec.readDoubleLE(absOffset) - KELVIN;
    return c >= TYRE_MIN_C && c <= TYRE_MAX_C ? c : NaN;
  };
  // Mean of a wheel's three temperature bands at a given relative offset, over
  // only the bands that pass the tyre-range guard. Used for both the surface
  // (rel 0) and inner-liner (rel +84) triplets.
  const bandMeanC = (wheel: number, rel: number): number => {
    const b = VT.mWheelTempBase + wheel * VT.mWheelStride + rel;
    const bands = [tyreC(b), tyreC(b + 8), tyreC(b + 16)].filter((c) => !Number.isNaN(c));
    if (bands.length < 2) return UNKNOWN_VALUE;
    return round1(bands.reduce((s, c) => s + c, 0) / bands.length);
  };
  const tyreTempsC: [number, number, number, number] = [
    bandMeanC(0, 0),
    bandMeanC(1, 0),
    bandMeanC(2, 0),
    bandMeanC(3, 0),
  ];
  const tyreHudTempsC: [number, number, number, number] = [
    bandMeanC(0, VT.mWheelInnerRel),
    bandMeanC(1, VT.mWheelInnerRel),
    bandMeanC(2, VT.mWheelInnerRel),
    bandMeanC(3, VT.mWheelInnerRel),
  ];

  /**
   * The same triplet the means are taken over, kept band-by-band and turned the
   * right way round for the car — see {@link TyreBands}. All three bands must be
   * plausible: unlike the mean, a spread is only meaningful if every band in it
   * is real, and a triplet missing a shoulder would render as a gradient that
   * simply is not there.
   *
   * Wheels 1 and 3 (FR, RR) are the right-hand side, where the sim's array runs
   * inner→outer already; the left-hand pair is reversed.
   */
  const readWheelBands = (wheel: number, rel: number): TyreBands | null => {
    const b = VT.mWheelTempBase + wheel * VT.mWheelStride + rel;
    const first = tyreC(b);
    const centre = tyreC(b + 8);
    const last = tyreC(b + 16);
    if (Number.isNaN(first) || Number.isNaN(centre) || Number.isNaN(last)) return null;
    const isRightSide = wheel === 1 || wheel === 3;
    const inner = isRightSide ? first : last;
    const outer = isRightSide ? last : first;
    return [round1(inner), round1(centre), round1(outer)];
  };
  const bandSet = (rel: number): TyreBandSet => [
    readWheelBands(0, rel),
    readWheelBands(1, rel),
    readWheelBands(2, rel),
    readWheelBands(3, rel),
  ];
  const tyreSurfaceBandsC = bandSet(0);
  const tyreLinerBandsC = bandSet(VT.mWheelInnerRel);

  // Carcass core — one double per wheel, so the same plausibility guard applies
  // but there is no averaging to do.
  const coreC = (wheel: number): number => {
    const c = tyreC(VT.mWheelTempBase + wheel * VT.mWheelStride + VT.mWheelCoreRel);
    return Number.isNaN(c) ? UNKNOWN_VALUE : round1(c);
  };
  const tyreCoreC: [number, number, number, number] = [coreC(0), coreC(1), coreC(2), coreC(3)];

  // Brake discs — same Kelvin encoding, but their own plausibility window: a
  // working disc runs hundreds of °C, which the TYRE guard rightly rejects.
  // 0 K in the garage → unknown, exactly like the tyres.
  const brakeC = (wheel: number): number => {
    const c =
      rec.readDoubleLE(VT.mWheelBase + wheel * VT.mWheelStride + VT.mWheelBrakeRel) - KELVIN;
    return c >= -20 && c <= 1500 ? round1(c) : UNKNOWN_VALUE;
  };
  const tyreBrakeC: [number, number, number, number] = [
    brakeC(0),
    brakeC(1),
    brakeC(2),
    brakeC(3),
  ];

  // Tyre pressures — already kPa in the buffer, no unit conversion. The window
  // accepts anything from a badly flat tyre to well over race pressure; the
  // garage's 0 falls outside it and reads as unknown, like the temps.
  const pressureKpa = (wheel: number): number => {
    const p = rec.readDoubleLE(VT.mWheelBase + wheel * VT.mWheelStride + VT.mWheelPressureRel);
    return p >= 30 && p <= 500 ? round1(p) : UNKNOWN_VALUE;
  };
  const tyrePressureKpa: [number, number, number, number] = [
    pressureKpa(0),
    pressureKpa(1),
    pressureKpa(2),
    pressureKpa(3),
  ];

  // Exact lap clock: elapsed − lapStart. Guard against pre-session junk (both
  // zero, negative spans, absurd values) — report unknown rather than wrong.
  const elapsed = rec.readDoubleLE(VT.mElapsedTime);
  const lapStart = rec.readDoubleLE(VT.mLapStartET);
  const lapTime = elapsed - lapStart;
  const lapTimeSec =
    Number.isFinite(lapTime) && lapTime >= 0 && lapTime < 7200 && elapsed > 0
      ? lapTime
      : UNKNOWN_VALUE;

  // Motion block. Read as raw vectors and handed to decodeMotion(), which owns
  // every sign decision — nothing here should reason about ISI's axes.
  const vec = (off: number): Vec3 => ({
    x: rec.readDoubleLE(off),
    y: rec.readDoubleLE(off + 8),
    z: rec.readDoubleLE(off + 16),
  });
  const motion = decodeMotion({
    accel: vec(VT.mLocalAccel),
    rot: vec(VT.mLocalRot),
    vel: vec(VT.mLocalVel),
    ori: [vec(VT.mOri), vec(VT.mOri + 24), vec(VT.mOri + 48)],
  });

  // Wheel load/suspension block. Read raw, in the sim's own units — every
  // threshold and unit conversion belongs to telemetry/chassis.ts, for the same
  // reason the motion block hands its axes to decodeMotion() untouched.
  const readCorner = (wheel: number): RawCorner => {
    const b = VT.mWheelBase + wheel * VT.mWheelStride;
    return {
      loadN: rec.readDoubleLE(b + VT.mTireLoad),
      deflectionM: rec.readDoubleLE(b + VT.mSuspensionDeflection),
      rideHeightM: rec.readDoubleLE(b + VT.mRideHeight),
      suspForceN: rec.readDoubleLE(b + VT.mSuspForce),
      gripFract: rec.readDoubleLE(b + VT.mGripFract),
    };
  };
  // The record must actually be long enough to hold the last wheel; a short or
  // torn buffer would otherwise throw out of readDoubleLE.
  const wheelsFit = VT.mWheelBase + 4 * VT.mWheelStride <= rec.length;
  const rawCorners: RawCornerSet | null = wheelsFit
    ? [readCorner(0), readCorner(1), readCorner(2), readCorner(3)]
    : null;

  return {
    throttle: clamp01(throttle),
    brake,
    clutch: clamp01(rec.readDoubleLE(VT.mUnfilteredClutch)),
    steer: clamp(rec.readDoubleLE(VT.mUnfilteredSteering), -1, 1),
    tc,
    abs,
    gear: rec.readInt32LE(VT.mGear),
    rpm: Math.round(rpm),
    maxRpm: Math.round(rec.readDoubleLE(VT.mEngineMaxRPM)) || 8000,
    speedKph: Math.round(Math.abs(fwdVel) * 3.6),
    speedMps: Number.isFinite(fwdVel) ? Math.abs(fwdVel) : 0,
    rearBrakeBias: plausibleFraction(rec.readDoubleLE(VT.mRearBrakeBias)),
    fuelLiters: round1(rec.readDoubleLE(VT.mFuel)),
    capacityLiters: round1(rec.readDoubleLE(VT.mFuelCapacity)),
    limiterOn: rec[VT.mSpeedLimiter] === 1 ? true : rec[VT.mSpeedLimiter] === 0 ? false : null,
    batteryCharge: plausibleCharge(rec.readDoubleLE(VT.mBatteryChargeFraction)),
    motorTorqueNm: plausibleTorque(rec.readDoubleLE(VT.mElectricBoostMotorTorque)),
    tyreTempsC,
    tyreHudTempsC,
    tyreSurfaceBandsC,
    tyreLinerBandsC,
    tyreCoreC,
    tyreBrakeC,
    tyrePressureKpa,
    lapNumber: Math.max(0, rec.readInt32LE(VT.mLapNumber)),
    lapTimeSec,
    lapStartET: Number.isFinite(lapStart) && lapStart >= 0 ? lapStart : 0,
    elapsedSec: Number.isFinite(elapsed) && elapsed > 0 ? elapsed : UNKNOWN_VALUE,
    carNumber: carNumberFromName(bufToAscii(rec.subarray(VT.mVehicleName, VT.mVehicleName + 48))),
    motion,
    rawCorners,
    // Filled in by LmuLocalCarReader, which owns the cross-frame tracker.
    chassis: null,
    aidSettings: parseAidSettings(rec),
  };
}

/**
 * Reads the aid block, or `null` when it is empty.
 *
 * "Empty" is every MAX reading zero. A car with traction control offers at
 * least one step of it, so an all-zero block is not a car with everything
 * turned off — it is a record that does not carry these values at all, which is
 * what every car except the player's own looks like. Returning null rather than
 * a row of zeros is the difference between the widget saying nothing and the
 * widget confidently reporting TC 0 on a car running TC 7.
 */
function parseAidSettings(rec: Buffer): AidSettings | null {
  const step = (at: number): AidStep => ({ value: rec[at] ?? 0, max: rec[at + 1] ?? 0 });
  const tc = step(VT.mTC);
  const tcSlip = step(VT.mTCSlip);
  const tcCut = step(VT.mTCCut);
  const abs = step(VT.mABS);
  const motorMap = step(VT.mMotorMap);
  const brakeMigration = step(VT.mBrakeMigration);
  const frontARB = step(VT.mFrontARB);
  const rearARB = step(VT.mRearARB);
  // The Hypercar trio is NOT part of the emptiness test. A GT3 offers none of
  // them, so requiring one would reject a perfectly good GT3 aid block; and a
  // record where only they are populated is not something the sim produces.
  if (!tc.max && !tcSlip.max && !tcCut.max && !abs.max && !motorMap.max) return null;
  return {
    tc,
    tcSlip,
    tcCut,
    abs,
    motorMap,
    brakeMigration,
    frontARB,
    rearARB,
    tcActive: (rec[VT.mTCActive] ?? 0) !== 0,
    absActive: (rec[VT.mABSActive] ?? 0) !== 0,
  };
}

/** Decodes a NUL-terminated ASCII run from a byte buffer. */
function bufToAscii(buf: Buffer): string {
  let s = '';
  for (const c of buf) {
    if (c === 0) break;
    if (c >= 32 && c < 127) s += String.fromCharCode(c);
  }
  return s;
}

/**
 * Extracts the racing number from a vehicle name like `"Iron Lynx 2026 #79:W"`
 * → `"79"`. Returns "" when there's no `#NN` token. Uses the last `#` so team
 * names containing a `#` don't confuse it.
 */
function carNumberFromName(name: string): string {
  const hash = name.lastIndexOf('#');
  if (hash < 0) return '';
  let s = '';
  for (let i = hash + 1; i < name.length; i++) {
    const ch = name.charCodeAt(i);
    if (ch >= 48 && ch <= 57) s += name[i];
    else break;
  }
  return stripLeadingZeros(s);
}

/** "091" → "91"; keeps a lone "0"; "" → "". */
function stripLeadingZeros(digits: string): string {
  return digits.replace(/^0+(?=\d)/, '');
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
/** A fraction that must genuinely sit in `(0,1)`, else the unknown sentinel — so
 *  a torn read or a wrong offset can't publish a nonsense brake bias. */
function plausibleFraction(v: number): number {
  return Number.isFinite(v) && v > 0 && v < 1 ? Math.round(v * 1000) / 1000 : UNKNOWN_VALUE;
}
/**
 * A state of charge. Unlike a brake bias this may legitimately sit at either
 * end — a battery really can be flat or brim-full — so the range is INCLUSIVE.
 * Anything outside it is a bad read, not an empty battery.
 */
function plausibleCharge(v: number): number {
  return Number.isFinite(v) && v >= 0 && v <= 1 ? Math.round(v * 1000) / 1000 : UNKNOWN_VALUE;
}
/**
 * Electric motor torque, Nm. Signed on purpose — the sign is the deploy/harvest
 * distinction. The bound is deliberately generous (no racing MGU is near it)
 * because its job is to reject a wrong offset's garbage, not to second-guess a
 * car's spec.
 */
const MAX_MOTOR_TORQUE_NM = 5000;
function plausibleTorque(v: number): number {
  return Number.isFinite(v) && Math.abs(v) <= MAX_MOTOR_TORQUE_NM
    ? Math.round(v * 10) / 10
    : UNKNOWN_VALUE;
}
function clampInt(v: number, min: number, max: number): number {
  return Math.round(clamp(v, min, max));
}
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
