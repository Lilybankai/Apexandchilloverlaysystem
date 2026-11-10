/**
 * @file src/telemetry/iracing/irsdkBroadcast.ts
 * @module telemetry/iracing/irsdkBroadcast
 *
 * iRacing's command channel: the SDK broadcast window message.
 *
 * Mechanism (irsdk_defines.h / irsdk_utils.cpp):
 *
 *   msgId = RegisterWindowMessageW(L"IRSDK_BROADCASTMSG")
 *   SendNotifyMessageW(HWND_BROADCAST, msgId, MAKELONG(cmd, var1), lParam)
 *
 * with `lParam` = `var2` (int32) for the int forms — the pit command is one:
 * `MAKELONG(irsdk_BroadcastPitCommand = 9, pitCmd)`, `lParam` = the parameter
 * (litres for fuel, kPa for a tyre's pressure, 0 = keep).
 *
 * Fire-and-forget: there is no acknowledgement, so whatever sends through this
 * module must read the effect back from telemetry (`PitSvFlags`, `dp*`,
 * `PitSvFuel` — see irPit.ts). Non-blocking and focus-free: it reaches iRacing
 * whichever window is in front.
 *
 * Split in two on purpose:
 * - the ENCODING is pure and unit-tested (scripts/test-iracing-pitwall.js);
 * - the TRANSPORT is a thin koffi binding over user32, loaded lazily, and its
 *   target window is injectable so the Electron test sends to its OWN hidden
 *   window and never to HWND_BROADCAST (scripts/test-irsdk-electron.js).
 *
 * Nothing here decides WHETHER to send: the "iRacing pit commands (beta)"
 * setting is enforced in server/irPitControl.ts.
 */

/** `irsdk_BroadcastMsg`. */
export const IR_BROADCAST = {
  CamSwitchPos: 0,
  CamSwitchNum: 1,
  CamSetState: 2,
  ReplaySetPlaySpeed: 3,
  ReplaySetPlayPosition: 4,
  ReplaySearch: 5,
  ReplaySetState: 6,
  ReloadTextures: 7,
  ChatCommand: 8,
  PitCommand: 9,
  TelemCommand: 10,
  FFBCommand: 11,
  ReplaySearchSessionTime: 12,
  VideoCapture: 13,
} as const;

/** `irsdk_PitCommandMode`. */
export const IR_PIT = {
  /** Clear all pit checkboxes. */
  Clear: 0,
  /** Windshield tear-off. */
  WS: 1,
  /** Add fuel; param = litres (0 = keep the current amount). */
  Fuel: 2,
  /** Change that tyre; param = cold pressure in kPa (0 = keep). */
  LF: 3,
  RF: 4,
  LR: 5,
  RR: 6,
  /** Untick all tyre changes. */
  ClearTires: 7,
  /** Request a fast repair. */
  FR: 8,
  ClearWS: 9,
  ClearFR: 10,
  ClearFuel: 11,
  /** Tyre compound; param = `DriverTires[].TireIndex`. */
  TC: 12,
} as const;

export type IrPitCmd = (typeof IR_PIT)[keyof typeof IR_PIT];

/** `HWND_BROADCAST`. */
export const HWND_BROADCAST = 0xffff;

/** The registered message name. */
export const BROADCAST_MSG_NAME = 'IRSDK_BROADCASTMSG';

/** Win32 `MAKELONG(lo, hi)` as an unsigned 32-bit value. */
export function makeLong(lo: number, hi: number): number {
  return ((lo & 0xffff) | ((hi & 0xffff) << 16)) >>> 0;
}

/** One encoded message. */
export interface EncodedBroadcast {
  wParam: number;
  lParam: number;
}

/** `irsdk_broadcastMsg(msg, var1, int var2)`. */
export function encodeBroadcast(msg: number, var1: number, var2 = 0): EncodedBroadcast {
  return { wParam: makeLong(msg, var1), lParam: var2 | 0 };
}

/** Largest parameter each pit command accepts (a sanity bound, not the sim's). */
const PIT_PARAM_MAX: Record<number, number> = {
  [IR_PIT.Fuel]: 1000, // litres
  [IR_PIT.LF]: 1000, // kPa
  [IR_PIT.RF]: 1000,
  [IR_PIT.LR]: 1000,
  [IR_PIT.RR]: 1000,
  [IR_PIT.TC]: 15,
};

/**
 * Encodes a pit command, refusing anything outside the documented set — a
 * malformed message is not sent at all rather than sent and hoped about.
 */
export function encodePitCommand(cmd: number, param = 0): EncodedBroadcast {
  if (!Number.isInteger(cmd) || cmd < IR_PIT.Clear || cmd > IR_PIT.TC) {
    throw new RangeError(`not an irsdk pit command: ${cmd}`);
  }
  const max = PIT_PARAM_MAX[cmd] ?? 0;
  if (!Number.isFinite(param) || param < 0 || param > max) {
    throw new RangeError(`pit command ${cmd}: parameter ${param} out of range 0..${max}`);
  }
  return encodeBroadcast(IR_BROADCAST.PitCommand, cmd, Math.round(param));
}

/** How a message leaves the process. Injectable for tests. */
export interface BroadcastTransport {
  /** `RegisterWindowMessageW("IRSDK_BROADCASTMSG")`; 0 on failure. */
  register(): number;
  /** `SendNotifyMessageW(hwnd, msgId, wParam, lParam)`. */
  send(hwnd: number, msgId: number, wParam: number, lParam: number): boolean;
}

/**
 * The real transport: user32 via koffi. `null` off Windows or without koffi.
 * Binding the functions sends nothing; only {@link BroadcastTransport.send} does.
 */
export function createKoffiTransport(): BroadcastTransport | null {
  if (process.platform !== 'win32') return null;
  // Typed as `any`: koffi is an optional dependency.
  let koffi: any;
  try {
    koffi = require('koffi');
  } catch {
    return null;
  }
  try {
    const user32 = koffi.load('user32.dll');
    const RegisterWindowMessageW = user32.func('uint32 __stdcall RegisterWindowMessageW(str16 lpString)');
    const SendNotifyMessageW = user32.func(
      'bool __stdcall SendNotifyMessageW(intptr_t hWnd, uint32 Msg, uintptr_t wParam, intptr_t lParam)',
    );
    return {
      register: () => Number(RegisterWindowMessageW(BROADCAST_MSG_NAME)) >>> 0,
      send: (hwnd, msgId, wParam, lParam) => !!SendNotifyMessageW(hwnd, msgId, wParam, lParam),
    };
  } catch {
    return null;
  }
}

/** A sent (or refused) message, for the read-back log and the tests. */
export interface SentBroadcast extends EncodedBroadcast {
  cmd: number;
  param: number;
  ok: boolean;
}

/** Sends pit commands. Holds the registered message id. */
export class IrsdkBroadcaster {
  private msgId = 0;
  private readonly transport: BroadcastTransport | null;
  private readonly target: number;

  /**
   * @param opts.transport defaults to {@link createKoffiTransport} (lazily).
   * @param opts.target    window to send to; defaults to HWND_BROADCAST. Tests
   *                       pass their own window so iRacing is never addressed.
   */
  public constructor(opts: { transport?: BroadcastTransport | null; target?: number } = {}) {
    this.transport = opts.transport === undefined ? createKoffiTransport() : opts.transport;
    this.target = opts.target ?? HWND_BROADCAST;
  }

  /** Whether a transport exists (Windows + koffi). */
  public get available(): boolean {
    return this.transport !== null;
  }

  /** The registered message id (registering on first use); 0 when unavailable. */
  public messageId(): number {
    if (!this.msgId && this.transport) {
      try {
        this.msgId = this.transport.register();
      } catch {
        this.msgId = 0;
      }
    }
    return this.msgId;
  }

  /** Sends one pit command. Throws on a malformed command (nothing is sent). */
  public pit(cmd: number, param = 0): SentBroadcast {
    const enc = encodePitCommand(cmd, param);
    const id = this.messageId();
    let ok = false;
    if (id && this.transport) {
      try {
        ok = this.transport.send(this.target, id, enc.wParam, enc.lParam);
      } catch {
        ok = false;
      }
    }
    return { cmd, param: Math.round(param), ...enc, ok };
  }
}
