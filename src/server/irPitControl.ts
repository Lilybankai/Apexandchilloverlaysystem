/**
 * @file src/server/irPitControl.ts
 * @module server/irPitControl
 *
 * iRacing pit commands from the overlay: the iRacing pit panel's buttons
 * (`POST /api/irpit/command`) and the bindable "iRacing pit" actions
 * (electron/actions.js) both land here, so there is ONE gate and one sender.
 *
 * ## The gate
 * Nothing is ever sent unless the "iRacing pit commands (beta)" setting is on
 * ({@link setIracingPitCommands}, default OFF — the app pushes it at server
 * start and on every change) AND the latest frame is a live iRacing frame with
 * the driver in the car (it carries `player.pitService`). This is a driver's
 * pit stop: a stray command in a race costs a real stop.
 *
 * ## Closed loop
 * The broadcast has no acknowledgement. Every intent is planned against the
 * pit menu as the sim last published it (`player.pitService`, read back from
 * `PitSvFlags` / `PitSvFuel` / `PitSv*P`), and the panel confirms by watching
 * the next frames change — the same read-back pattern as LMU's MFD.
 *
 * iRacing's pit command set is additive (tick this tyre, add this fuel) plus
 * coarse clears (all tyres, fuel, FR, tear-off, everything). Unticking ONE tyre
 * therefore means clearing the tyres and re-ticking the others — {@link planPitIntent}.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PitServiceState, TelemetryFrame } from '../telemetry/types';
import { IR_PIT, IrsdkBroadcaster, type SentBroadcast } from '../telemetry/iracing/irsdkBroadcast';

export const IRPIT_API_PREFIX = '/api/irpit/';
const MAX_BODY_BYTES = 2048;
/** At most this many messages per second — a held button cannot flood the sim. */
const MAX_PER_SEC = 12;

export type Corner = 'lf' | 'rf' | 'lr' | 'rr';
const CORNERS: Corner[] = ['lf', 'rf', 'lr', 'rr'];
const CORNER_CMD: Record<Corner, number> = { lf: IR_PIT.LF, rf: IR_PIT.RF, lr: IR_PIT.LR, rr: IR_PIT.RR };
const TYRE_SETS: Record<string, Corner[]> = {
  all: CORNERS,
  none: [],
  front: ['lf', 'rf'],
  rear: ['lr', 'rr'],
  left: ['lf', 'lr'],
  right: ['rf', 'rr'],
};

/** What the driver asked for. */
export type PitIntent =
  | { kind: 'clear' }
  | { kind: 'fuel'; litres: number }
  | { kind: 'fuelDelta'; litres: number }
  | { kind: 'fuelToggle' }
  | { kind: 'fuelToFinish' }
  | { kind: 'tyres'; set: 'all' | 'none' | 'front' | 'rear' | 'left' | 'right' }
  | { kind: 'tyre'; corner: Corner; on?: boolean }
  | { kind: 'pressure'; corner: Corner | 'all'; deltaKpa: number }
  | { kind: 'fastRepair'; on?: boolean }
  | { kind: 'tearoff'; on?: boolean };

/** One planned message. */
export interface PitStep {
  cmd: number;
  param: number;
}

/** What the plan needs from the frame. */
export interface PlanContext {
  service: PitServiceState;
  /** `fuel.refuelToFinishLiters`, when known. */
  refuelToFinishL?: number;
}

const isOn = (s: PitServiceState, id: string): boolean => s.items.some((i) => i.id === id && i.state === 'requested');
const known = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Turns an intent into pit commands against the menu as last read. Pure;
 * returns `[]` when there is nothing to do and throws on an impossible intent.
 */
export function planPitIntent(intent: PitIntent, ctx: PlanContext): PitStep[] {
  const s = ctx.service;
  const fuelNow = isOn(s, 'fuel') && known(s.fuelAddL) ? s.fuelAddL : 0;
  const setFuel = (l: number): PitStep[] =>
    l > 0 ? [{ cmd: IR_PIT.Fuel, param: Math.min(999, Math.round(l)) }] : [{ cmd: IR_PIT.ClearFuel, param: 0 }];
  switch (intent.kind) {
    case 'clear':
      return [{ cmd: IR_PIT.Clear, param: 0 }];
    case 'fuel':
      return setFuel(intent.litres);
    case 'fuelDelta':
      return setFuel(Math.max(0, fuelNow + intent.litres));
    case 'fuelToggle':
      return isOn(s, 'fuel') ? [{ cmd: IR_PIT.ClearFuel, param: 0 }] : [{ cmd: IR_PIT.Fuel, param: 0 }];
    case 'fuelToFinish': {
      const need = ctx.refuelToFinishL;
      if (!known(need)) throw new Error('fuel to finish is not known yet');
      return setFuel(Math.ceil(need));
    }
    case 'tyres': {
      const want = TYRE_SETS[intent.set];
      if (!want) throw new Error(`unknown tyre set ${intent.set}`);
      return [{ cmd: IR_PIT.ClearTires, param: 0 }, ...want.map((c) => ({ cmd: CORNER_CMD[c], param: 0 }))];
    }
    case 'tyre': {
      if (!CORNERS.includes(intent.corner)) throw new Error(`unknown corner ${intent.corner}`);
      const now = isOn(s, intent.corner);
      const on = intent.on ?? !now;
      if (on === now) return [];
      if (on) return [{ cmd: CORNER_CMD[intent.corner], param: 0 }];
      // There is no "untick one tyre": clear them all, re-tick the rest.
      const keep = CORNERS.filter((c) => c !== intent.corner && isOn(s, c));
      return [{ cmd: IR_PIT.ClearTires, param: 0 }, ...keep.map((c) => ({ cmd: CORNER_CMD[c], param: 0 }))];
    }
    case 'pressure': {
      const corners = intent.corner === 'all' ? CORNERS : [intent.corner];
      const out: PitStep[] = [];
      for (const c of corners) {
        const i = CORNERS.indexOf(c);
        if (i < 0) throw new Error(`unknown corner ${c}`);
        const cur = s.pressuresKpa[i];
        if (!known(cur) || cur <= 0) throw new Error(`${c.toUpperCase()} pressure is not published`);
        // A pressure is sent WITH a tyre change — that is how iRacing takes it.
        out.push({ cmd: CORNER_CMD[c], param: Math.max(1, Math.round(cur + intent.deltaKpa)) });
      }
      return out;
    }
    case 'fastRepair': {
      const now = isOn(s, 'fastRepair');
      const on = intent.on ?? !now;
      return on === now ? [] : [{ cmd: on ? IR_PIT.FR : IR_PIT.ClearFR, param: 0 }];
    }
    case 'tearoff': {
      const now = isOn(s, 'tearoff');
      const on = intent.on ?? !now;
      return on === now ? [] : [{ cmd: on ? IR_PIT.WS : IR_PIT.ClearWS, param: 0 }];
    }
    default:
      throw new Error('unknown pit intent');
  }
}

/* ------------------------------ module state ------------------------------ */

let enabled = false;
let lastFrame: TelemetryFrame | null = null;
let broadcaster: IrsdkBroadcaster | null = null;
const sentAt: number[] = [];
let lastSent: SentBroadcast[] = [];

/** The "iRacing pit commands (beta)" setting. Default OFF. */
export function setIracingPitCommands(on: boolean): void {
  enabled = on === true;
}

export function iracingPitCommandsEnabled(): boolean {
  return enabled;
}

/** For tests: replace the sender (e.g. with a recording fake transport). */
export function setIrPitBroadcaster(b: IrsdkBroadcaster | null): void {
  broadcaster = b;
}

function sender(): IrsdkBroadcaster {
  if (!broadcaster) broadcaster = new IrsdkBroadcaster();
  return broadcaster;
}

/**
 * Called by the server loop with every frame before broadcast: remembers it
 * for planning, and stamps `pitService.commandsEnabled` so the panel knows
 * whether its buttons are live.
 */
export function stampIrPit(frame: TelemetryFrame): void {
  lastFrame = frame;
  const svc = frame.source === 'iracing' ? frame.player.pitService : undefined;
  if (svc) svc.commandsEnabled = enabled;
}

/** Result of {@link runPitIntent}. */
export interface PitRunResult {
  ok: boolean;
  error?: string;
  sent?: SentBroadcast[];
}

/** Gate, plan, send. Never throws. */
export function runPitIntent(intent: PitIntent, nowMs = Date.now()): PitRunResult {
  if (!enabled) return { ok: false, error: 'iRacing pit commands are off (Settings → iRacing pit commands, beta)' };
  const f = lastFrame;
  const svc = f && f.source === 'iracing' && f.connected ? f.player.pitService : undefined;
  if (!f || !svc) return { ok: false, error: 'not in an iRacing car' };
  let steps: PitStep[];
  try {
    steps = planPitIntent(intent, {
      service: svc,
      ...(f.fuel && f.fuel.refuelToFinishLiters >= 0 ? { refuelToFinishL: f.fuel.refuelToFinishLiters } : {}),
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  if (!steps.length) return { ok: true, sent: [] };
  while (sentAt.length && nowMs - (sentAt[0] as number) > 1000) sentAt.shift();
  if (sentAt.length + steps.length > MAX_PER_SEC) return { ok: false, error: 'too many pit commands — slow down' };
  const b = sender();
  if (!b.available) return { ok: false, error: 'pit commands need Windows (koffi unavailable)' };
  const sent: SentBroadcast[] = [];
  for (const st of steps) {
    sentAt.push(nowMs);
    sent.push(b.pit(st.cmd, st.param));
  }
  lastSent = sent;
  const ok = sent.every((x) => x.ok);
  return ok ? { ok, sent } : { ok, sent, error: 'Windows refused the message' };
}

/** For diagnostics: the last batch sent. */
export function lastIrPitSent(): SentBroadcast[] {
  return lastSent.slice();
}

/* ---------------------------------- HTTP ---------------------------------- */

/**
 *   GET  /api/irpit/status   { ok, enabled, inCar }
 *   POST /api/irpit/command  { intent: PitIntent }  → PitRunResult
 */
export function handleIrPitCommand(req: IncomingMessage, res: ServerResponse): boolean {
  const url = (req.url ?? '').split('?')[0] ?? '';
  if (!url.startsWith(IRPIT_API_PREFIX)) return false;
  const action = url.slice(IRPIT_API_PREFIX.length);
  if (req.method === 'GET' && action === 'status') {
    const f = lastFrame;
    sendJson(res, 200, {
      ok: true,
      enabled,
      inCar: !!(f && f.source === 'iracing' && f.connected && f.player.pitService),
    });
    return true;
  }
  if (req.method === 'POST' && action === 'command') {
    readBody(req)
      .then((body) => {
        const intent = body && typeof body === 'object' ? (body as { intent?: unknown }).intent : undefined;
        if (!intent || typeof intent !== 'object' || typeof (intent as { kind?: unknown }).kind !== 'string') {
          sendJson(res, 400, { ok: false, error: 'missing intent' });
          return;
        }
        const r = runPitIntent(intent as PitIntent);
        sendJson(res, r.ok ? 200 : 409, r);
      })
      .catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }));
    return true;
  }
  sendJson(res, 404, { ok: false, error: 'unknown irpit route' });
  return true;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        rejectBody(new Error('bad JSON'));
      }
    });
    req.on('error', rejectBody);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
