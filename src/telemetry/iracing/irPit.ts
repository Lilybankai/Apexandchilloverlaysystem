/**
 * @file src/telemetry/iracing/irPit.ts
 * @module telemetry/iracing/irPit
 *
 * The iRacing pit wall's READ side: repair flags, the booked pit service and its
 * live progress through a stop, and the flags shown to one car bit by bit.
 *
 * Everything here is the sim's own published state; nothing is a guess at
 * damage iRacing does not publish (it has no per-component damage). The
 * sequences the logic is built on were measured in a real 12-minute race
 * (capture ir-cap4, 2026-11-10):
 *
 * - **Crash.** `EngineWarnings` 0x000 → 0x100 (optional repair) on the 10.8 g
 *   impact tick, → 0x180 (+ mandatory) 0.1 s later. `SessionFlags` gained
 *   0x100000 (`irsdk_repair`, the meatball) 11 s after. Tow: `PlayerCarTowTime`
 *   127.5 s, counting down with the car already placed in its stall.
 * - **Stop.** `PitstopActive` rose the frame the tow ended; the fast-repair bit
 *   of `PitSvFlags` (0x40) cleared on that SAME frame (0x6F → 0x2F), so the
 *   request is taken from the frame before the stop started. Then LF (0x2E),
 *   tear-off (0x0E), RF (0x0C), LR (0x08), RR (0x00); `PitstopActive` fell
 *   40.3 s after it rose. `PlayerCarPitSvStatus` 0 → 1 → 2 → 0 at pit exit;
 *   the flags reset to the menu (0x6F) on leaving pit road (app.ini
 *   autoResetPitBox).
 * - `PitRepairLeft` / `PitOptRepairLeft` read 0 in EVERY frame, mid-repair
 *   included, so 0 is "not published", never "0 s".
 * - `FastRepairAvailable` 1 → 0 as the stop began; 255 means unlimited.
 */

import type { IrsdkFrame } from './irsdk';
import {
  UNKNOWN_VALUE,
  type DriverFlagState,
  type PitServiceItem,
  type PitServiceState,
  type RepairState,
} from '../types';

/** `irsdk_PitSvFlags`. */
export const PIT_SV = {
  lf: 0x01,
  rf: 0x02,
  lr: 0x04,
  rr: 0x08,
  fuel: 0x10,
  tearoff: 0x20,
  fastRepair: 0x40,
} as const;

/** `irsdk_EngineWarnings` repair bits. */
export const ENGINE_MAND_REPAIR = 0x80;
export const ENGINE_OPT_REPAIR = 0x100;

/** `irsdk_Flags` bits read here. */
export const IR_FLAG = {
  checkered: 0x1,
  white: 0x2,
  green: 0x4,
  yellow: 0x8,
  red: 0x10,
  blue: 0x20,
  debris: 0x40,
  yellowWaving: 0x100,
  caution: 0x4000,
  cautionWaving: 0x8000,
  black: 0x10000,
  disqualify: 0x20000,
  servicible: 0x40000,
  furled: 0x80000,
  repair: 0x100000,
} as const;

/** The driver-specific bits (the ones `CarIdxSessionFlags` carries). */
const DRIVER_BITS = IR_FLAG.black | IR_FLAG.disqualify | IR_FLAG.furled | IR_FLAG.repair;

/** Above this the g is an impact, not cornering (a GT car corners at ~2 g). */
export const IMPACT_G = 4;
const G = 9.80665;

const SERVICE: Array<{ id: PitServiceItem['id']; bit: number; label: string }> = [
  { id: 'lf', bit: PIT_SV.lf, label: 'LF' },
  { id: 'rf', bit: PIT_SV.rf, label: 'RF' },
  { id: 'lr', bit: PIT_SV.lr, label: 'LR' },
  { id: 'rr', bit: PIT_SV.rr, label: 'RR' },
  { id: 'fuel', bit: PIT_SV.fuel, label: 'FUEL' },
  { id: 'tearoff', bit: PIT_SV.tearoff, label: 'TEAR-OFF' },
  { id: 'fastRepair', bit: PIT_SV.fastRepair, label: 'FAST REPAIR' },
];

const STATUS: Record<number, PitServiceState['status']> = {
  0: 'none',
  1: 'inProgress',
  2: 'complete',
  100: 'tooFarLeft',
  101: 'tooFarRight',
  102: 'tooFarForward',
  103: 'tooFarBack',
  104: 'badAngle',
  105: 'cantFixThat',
};

const fin = (v: number): boolean => typeof v === 'number' && Number.isFinite(v);
const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * The flags shown to one car.
 *
 * `sessionFlags` is the PLAYER's view (`SessionFlags`): global bits plus the
 * player's own blue/local yellow/black. For a spectated car pass its
 * `CarIdxSessionFlags` as `carFlags`: the driver bits come from there, the
 * global ones (caution, white, chequered, green) from the session, and the
 * player-local ones (blue, local yellow, debris) are dropped — they describe
 * where the PLAYER is, not the car on screen.
 */
export function readDriverFlags(sessionFlags: number, carFlags?: number): DriverFlagState {
  const s = sessionFlags >>> 0;
  const own = carFlags === undefined;
  const d = own ? s : (carFlags >>> 0) & DRIVER_BITS;
  return {
    checkered: (s & IR_FLAG.checkered) !== 0,
    white: (s & IR_FLAG.white) !== 0,
    green: (s & IR_FLAG.green) !== 0,
    localYellow: own && (s & (IR_FLAG.yellow | IR_FLAG.yellowWaving)) !== 0,
    caution: (s & (IR_FLAG.caution | IR_FLAG.cautionWaving)) !== 0,
    blue: own && (s & IR_FLAG.blue) !== 0,
    debris: own && (s & IR_FLAG.debris) !== 0,
    black: (d & IR_FLAG.black) !== 0,
    furled: (d & IR_FLAG.furled) !== 0,
    meatball: (d & IR_FLAG.repair) !== 0,
    disqualified: (d & IR_FLAG.disqualify) !== 0,
  };
}

/** Per-session tracker for the stop and the last impact. */
export class IrPitTracker {
  /** `PitSvFlags` of the previous frame: the request a stop starts from. */
  private prevFlags = -1;
  /** Bits booked when the current/last stop began; -1 outside a stop's span. */
  private stopMask = -1;
  private active = false;
  private stopStartS = NaN;
  private lastStopSec: number = UNKNOWN_VALUE;
  /** A stop finished and the car has not yet left pit road. */
  private holdDone = false;
  private impactG = 0;
  private impactAtMs = 0;
  private eventPeak = 0;

  public reset(): void {
    this.prevFlags = -1;
    this.stopMask = -1;
    this.active = false;
    this.stopStartS = NaN;
    this.lastStopSec = UNKNOWN_VALUE;
    this.holdDone = false;
    this.impactG = 0;
    this.impactAtMs = 0;
    this.eventPeak = 0;
  }

  /** Impact detection: call every frame the player is driving. */
  public noteAccel(f: IrsdkFrame, nowMs: number): void {
    const lat = f.num('LatAccel');
    const lon = f.num('LongAccel');
    const vert = f.num('VertAccel');
    if (!fin(lat) || !fin(lon) || !fin(vert)) return;
    const g = Math.hypot(lat, lon, vert - G) / G;
    if (g > IMPACT_G) {
      // One hit is one event, however many ticks it spans: the peak inside
      // the event is the figure, timed from its start.
      if (this.eventPeak === 0) this.impactAtMs = nowMs;
      if (g > this.eventPeak) {
        this.eventPeak = g;
        this.impactG = round1(g);
      }
    } else if (g < IMPACT_G / 2) {
      this.eventPeak = 0;
    }
  }

  /**
   * The repair block, or `undefined` when the sim does not publish the repair
   * bits at all.
   */
  public repair(f: IrsdkFrame, sessionFlags: number, nowMs: number): RepairState | undefined {
    if (!f.has('EngineWarnings')) return undefined;
    const w = f.num('EngineWarnings') >>> 0;
    const meatball = ((sessionFlags >>> 0) & IR_FLAG.repair) !== 0;
    const required: RepairState['required'] =
      w & ENGINE_MAND_REPAIR || meatball ? 'mandatory' : w & ENGINE_OPT_REPAIR ? 'optional' : 'none';
    const rep = f.num('PitRepairLeft');
    const opt = f.num('PitOptRepairLeft');
    const avail = f.num('FastRepairAvailable');
    const used = fin(f.num('PlayerFastRepairsUsed')) ? f.num('PlayerFastRepairsUsed') : f.num('FastRepairUsed');
    const tow = f.num('PlayerCarTowTime');
    const flags = f.num('PitSvFlags');
    const dpFr = f.num('dpFastRepair');
    return {
      required,
      meatball,
      repairSec: fin(rep) && rep > 0 ? round1(rep) : UNKNOWN_VALUE,
      optionalRepairSec: fin(opt) && opt > 0 ? round1(opt) : UNKNOWN_VALUE,
      fastRepairsLeft: fin(avail) && avail >= 0 ? (avail >= 255 ? UNKNOWN_VALUE : avail) : UNKNOWN_VALUE,
      ...(fin(avail) && avail >= 255 ? { fastRepairsUnlimited: true } : {}),
      fastRepairsUsed: fin(used) && used >= 0 ? used : UNKNOWN_VALUE,
      fastRepairQueued: fin(flags) ? ((flags >>> 0) & PIT_SV.fastRepair) !== 0 : fin(dpFr) && dpFr !== 0,
      towSec: fin(tow) && tow > 0 ? round1(tow) : 0,
      ...(this.impactG > 0 ? { lastImpactG: this.impactG, msSinceImpact: Math.max(0, nowMs - this.impactAtMs) } : {}),
    };
  }

  /**
   * The pit service and its progress, or `undefined` without `PitSvFlags`.
   * Call EVERY frame the player is in the car, so the pre-stop request is seen.
   */
  public service(
    f: IrsdkFrame,
    onPitRoad: boolean,
    tires: readonly string[] = [],
  ): PitServiceState | undefined {
    if (!f.has('PitSvFlags')) return undefined;
    const flags = f.num('PitSvFlags') >>> 0;
    const active = f.bool('PitstopActive');
    const t = f.num('SessionTime');

    if (active && !this.active) {
      // The stop starts. Some items (fast repair) are consumed on this very
      // frame, so the request is what was booked the frame before, too.
      this.stopMask = (this.prevFlags >= 0 ? this.prevFlags : 0) | flags;
      this.stopStartS = t;
      this.holdDone = false;
    } else if (!active && this.active) {
      if (fin(this.stopStartS) && fin(t) && t >= this.stopStartS) this.lastStopSec = round1(t - this.stopStartS);
      this.holdDone = true;
    }
    this.active = active;
    // Leaving pit road ends the "what the crew just did" view: the menu (reset
    // by iRacing on exit) is the plan again.
    if (!active && !onPitRoad) {
      this.holdDone = false;
      this.stopMask = -1;
    }
    this.prevFlags = flags;

    const inStop = (active || this.holdDone) && this.stopMask >= 0;
    const items: PitServiceItem[] = SERVICE.map((s) => {
      let state: PitServiceItem['state'];
      if (inStop) {
        state = (this.stopMask & s.bit) === 0 ? 'off' : (flags & s.bit) !== 0 && active ? 'requested' : 'done';
      } else {
        state = (flags & s.bit) !== 0 ? 'requested' : 'off';
      }
      return { id: s.id, label: s.label, state };
    });

    const fuel = f.num('PitSvFuel');
    const press = (n: string): number => {
      const v = f.num(n);
      return fin(v) && v > 0 ? round1(v) : UNKNOWN_VALUE;
    };
    const statusRaw = f.num('PlayerCarPitSvStatus');
    const compoundIdx = f.num('PitSvTireCompound');
    const compound = fin(compoundIdx) && compoundIdx >= 0 ? tires[compoundIdx] : undefined;
    return {
      items,
      fuelAddL: flags & PIT_SV.fuel && fin(fuel) && fuel >= 0 ? round1(fuel) : UNKNOWN_VALUE,
      autoFuel: f.bool('dpFuelAutoFillEnabled') && f.bool('dpFuelAutoFillActive'),
      pressuresKpa: [press('PitSvLFP'), press('PitSvRFP'), press('PitSvLRP'), press('PitSvRRP')],
      ...(compound ? { compound } : {}),
      status: fin(statusRaw) ? (STATUS[statusRaw] ?? 'unknown') : 'unknown',
      active,
      elapsedSec: active && fin(t) && fin(this.stopStartS) ? round1(Math.max(0, t - this.stopStartS)) : UNKNOWN_VALUE,
      lastStopSec: this.lastStopSec,
    };
  }
}
