/**
 * @file src/telemetry/iracing/radar.ts
 * @module telemetry/iracing/radar
 *
 * The radar for a sim that publishes no world positions.
 *
 * ## What iRacing gives, and what it does not
 * The shared radar (`telemetry/radar.ts`) projects every car's world position
 * onto the player's own axes. iRacing has no world position for any car. It
 * has two things instead:
 *
 *   - `CarIdxLapDistPct[]` — how far round the lap every car is. The difference
 *     to the player's, times the lap length, is how far AHEAD or BEHIND a car is
 *     along the road. That is the longitudinal axis, and it is good.
 *   - `CarLeftRight` — the player-only spotter signal: which side(s) a car is
 *     overlapping on, and whether there are two. It says nothing about WHICH car.
 *
 * So the lateral axis is reconstructed: the spotter's side(s) are given to the
 * nearest car(s) within about a car length, placed one lane over (or two, for
 * "two cars left/right"), and every other car sits on the player's line. A car
 * already given a side last frame keeps it (pass the previous frame's blips as
 * `previous`) so a three-wide pack does not shuffle sides tick to tick.
 *
 * ## The spotter is authoritative about overlap
 * The widget lights a side warning for any blip within {@link ALONGSIDE_LON_M}
 * of level, on the side of its `lateralM` sign — and `lateralM = 0` counts as
 * the RIGHT. Lap-fraction jitter regularly puts a car nose-to-tail behind you a
 * few metres "inside" that window; drawn as-is it would fire a phantom right
 * warning while the spotter says clear. So a car the spotter did not place
 * alongside is held just outside the window, on its own side of the player.
 *
 * ## Units and conventions — identical to `buildRadar`
 * `lateralM` negative = LEFT, positive = RIGHT; `longitudinalM` positive =
 * AHEAD; metres rounded to 1 cm; within {@link RADAR_MAX_RANGE_M}; sorted
 * nearest-first. `null` (the frame's `radar` omitted) when the player is not in
 * the car (`CarLeftRight` Off or unknown) or the inputs are unusable; `[]` means
 * genuinely nobody in range.
 *
 * Pure, allocation per call only.
 */

import { ALONGSIDE_LON_M, RADAR_MAX_RANGE_M } from '../radar';
import type { RadarBlip } from '../types';

/** `irsdk_CarLeftRight`, the `CarLeftRight` telemetry var. */
export const IR_CAR_LEFT_RIGHT = {
  /** Not in the car (garage, spectating). */
  Off: 0,
  /** Nobody alongside. */
  Clear: 1,
  CarLeft: 2,
  CarRight: 3,
  /** One car each side — the player is the middle of three wide. */
  CarLeftRight: 4,
  TwoCarsLeft: 5,
  TwoCarsRight: 6,
} as const;

/**
 * Centre-to-centre lateral spacing of two cars racing side by side, metres:
 * a ~2 m car plus a ~1 m gap. The second car on one side sits at twice this.
 */
export const IR_SIDE_LANE_M = 3;

/**
 * How far either side of level a car may be, by lap fraction, and still be the
 * one the spotter means. A car length plus margin, widened at speed because
 * remote cars' lap fractions arrive over the network a little late
 * ({@link PCT_LATENCY_S} worth of travel).
 */
const SIDE_SEARCH_BASE_M = ALONGSIDE_LON_M;
const PCT_LATENCY_S = 0.1;
const SIDE_SEARCH_MAX_EXTRA_M = 6;

/** Where a car the spotter says is NOT alongside is held: just outside the window. */
const CLEAR_HOLD_M = ALONGSIDE_LON_M + 0.5;

/** One other car, as iRacing describes it. */
export interface IracingRadarCar {
  /** `CarIdx` — the slot id joined across standings/relative/trackMap. */
  slotId: number;
  /** `CarIdxLapDistPct[idx]`; negative = not in the world (skipped). */
  pct: number;
  /** `CarIdxOnPitRoad[idx]` — pit-lane cars share lap fractions with the track. */
  onPitRoad: boolean;
  carClass?: string;
  carNumber?: string;
  isFasterClass?: boolean;
  slowerClass?: boolean;
  lapsDown?: number;
}

/** Everything {@link buildIracingRadar} needs for one frame. */
export interface IracingRadarInput {
  /** `CarLeftRight` (see {@link IR_CAR_LEFT_RIGHT}). */
  carLeftRight: number;
  /** `PlayerCarIdx` — excluded from the blips. */
  playerSlotId: number;
  /** `LapDistPct` of the player. */
  playerPct: number;
  /** Lap length, metres (`WeekendInfo.TrackLength` × 1000). */
  trackLengthM: number;
  /** `Speed`, m/s — widens the side search for network lag. Optional. */
  playerSpeedMs?: number;
  /** The field. May include the player and pit cars; both are filtered. */
  cars: readonly IracingRadarCar[];
  /** Last frame's output, to keep side assignments stable. Optional. */
  previous?: readonly RadarBlip[] | null;
  /** Range cap, metres; defaults to {@link RADAR_MAX_RANGE_M}. */
  maxRangeM?: number;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** How many cars the spotter puts on each side. */
function sideNeeds(clr: number): [left: number, right: number] {
  switch (clr) {
    case IR_CAR_LEFT_RIGHT.CarLeft:
      return [1, 0];
    case IR_CAR_LEFT_RIGHT.CarRight:
      return [0, 1];
    case IR_CAR_LEFT_RIGHT.CarLeftRight:
      return [1, 1];
    case IR_CAR_LEFT_RIGHT.TwoCarsLeft:
      return [2, 0];
    case IR_CAR_LEFT_RIGHT.TwoCarsRight:
      return [0, 2];
    default:
      return [0, 0];
  }
}

interface Work {
  car: IracingRadarCar;
  lon: number;
  /** −1 left, +1 right, 0 on the player's line. */
  side: number;
  /** 1 = first lane over, 2 = second. */
  lane: number;
}

/**
 * Builds the radar blips for one iRacing frame. See the module note for the
 * reconstruction and its limits; `null` means "no radar data" (omit the block).
 */
export function buildIracingRadar(input: IracingRadarInput): RadarBlip[] | null {
  const clr = input.carLeftRight;
  if (!finite(clr) || clr < IR_CAR_LEFT_RIGHT.Clear || clr > IR_CAR_LEFT_RIGHT.TwoCarsRight) {
    return null;
  }
  const L = input.trackLengthM;
  const pp = input.playerPct;
  if (!finite(L) || L <= 0 || !finite(pp) || pp < 0 || pp > 1) return null;
  const maxRange = input.maxRangeM ?? RADAR_MAX_RANGE_M;

  // 1. Longitudinal offset of every candidate, wrapped to ±half a lap so a car
  //    just across the line reads a few metres ahead, not a lap behind.
  const work: Work[] = [];
  for (const car of input.cars) {
    if (car.slotId === input.playerSlotId || car.onPitRoad) continue;
    if (!finite(car.pct) || car.pct < 0 || car.pct > 1) continue;
    let d = car.pct - pp;
    if (d >= 0.5) d -= 1;
    else if (d < -0.5) d += 1;
    const lon = d * L;
    if (Math.abs(lon) > maxRange) continue;
    work.push({ car, lon, side: 0, lane: 0 });
  }

  // 2. Hand the spotter's sides to the nearest cars within about a car length.
  let [needL, needR] = sideNeeds(clr);
  if (needL + needR > 0) {
    const speed = finite(input.playerSpeedMs) ? Math.abs(input.playerSpeedMs) : 0;
    const searchM =
      SIDE_SEARCH_BASE_M + Math.min(SIDE_SEARCH_MAX_EXTRA_M, speed * PCT_LATENCY_S);
    const near = work
      .filter((w) => Math.abs(w.lon) <= searchM)
      .sort((a, b) => Math.abs(a.lon) - Math.abs(b.lon));

    // Sticky: a car that held a side last frame keeps it while that side is
    // still occupied.
    const prevSide = new Map<number, number>();
    if (input.previous) {
      for (const b of input.previous) {
        if (b.alongside && b.lateralM !== 0) prevSide.set(b.slotId, b.lateralM < 0 ? -1 : 1);
      }
    }
    if (prevSide.size > 0) {
      for (const w of near) {
        const s = prevSide.get(w.car.slotId);
        if (s === -1 && needL > 0) {
          w.side = -1;
          needL--;
        } else if (s === 1 && needR > 0) {
          w.side = 1;
          needR--;
        }
      }
    }
    // Then nearest-first into whatever is still to be filled.
    for (const w of near) {
      if (w.side !== 0) continue;
      if (needL > 0) {
        w.side = -1;
        needL--;
      } else if (needR > 0) {
        w.side = 1;
        needR--;
      } else break;
    }
    // Lanes: on a side with two cars, the nearer one is the inner lane.
    let laneL = 0;
    let laneR = 0;
    for (const w of near) {
      if (w.side === -1) w.lane = ++laneL;
      else if (w.side === 1) w.lane = ++laneR;
    }
  }

  // 3. Blips.
  const blips: RadarBlip[] = [];
  for (const w of work) {
    let lon = w.lon;
    let lat = 0;
    let alongside = false;
    if (w.side !== 0) {
      lat = w.side * IR_SIDE_LANE_M * w.lane;
      // The spotter says overlapping: keep it inside the alongside window.
      lon = Math.max(-ALONGSIDE_LON_M, Math.min(ALONGSIDE_LON_M, lon));
      alongside = true;
    } else if (Math.abs(lon) <= ALONGSIDE_LON_M) {
      // Not alongside by the spotter's word: hold it nose-to-tail, its own side.
      lon = lon < 0 ? -CLEAR_HOLD_M : CLEAR_HOLD_M;
    }
    const distanceM = Math.hypot(lat, lon);
    const blip: RadarBlip = {
      slotId: w.car.slotId,
      lateralM: round2(lat),
      longitudinalM: round2(lon),
      distanceM: round2(distanceM),
      alongside,
    };
    const c = w.car;
    if (c.carClass) blip.carClass = c.carClass;
    if (c.carNumber) blip.carNumber = c.carNumber;
    if (c.isFasterClass) blip.isFasterClass = true;
    if (c.slowerClass) blip.slowerClass = true;
    if (typeof c.lapsDown === 'number' && c.lapsDown >= 1) blip.lapsDown = c.lapsDown;
    blips.push(blip);
  }
  blips.sort((a, b) => a.distanceM - b.distanceM);
  return blips;
}
