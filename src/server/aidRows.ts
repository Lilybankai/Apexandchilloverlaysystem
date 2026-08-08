/**
 * @file src/server/aidRows.ts
 * @module server/aidRows
 *
 * Driving aids as things the driver can **step**: press LMU's own key for the
 * direction, in the one place that knows how.
 *
 * Writing is all this does. The aids are READ live off the car's telemetry
 * record (see {@link module:telemetry/mfdControl} `projectAids`), so a press
 * needs no bookkeeping to be believed — the next frame carries what the game
 * actually did with it. That replaced a tracker which counted presses because
 * the values were thought to be unreadable, and which could drift from the game
 * with no way for the driver to tell.
 *
 * ## Why it is a module and not two copies
 * Two callers need exactly this: `/api/mfd/aidkey` (the widget's ± buttons) and
 * the MFD cursor (the four bindable controls, which walk the aid rows as well as
 * the pit ones). A wheel button and a click on the widget are meant to be the
 * same act, down to the failure messages.
 *
 * ## Two tests an aid must pass to be a row
 * **Bound**, because a key LMU has not bound does nothing however perfectly we
 * send it — the same test the widget uses to decide whether to draw ± at all.
 * And **offered by the car**, because the widget draws its rows off the frame,
 * where a control this car does not have is already gone. Answering the second
 * question with the first is what put a stop on an invisible row: see
 * {@link noteLiveAids}.
 */

import type { KeySender } from './keySender';
import {
  boundAids,
  findAid,
  readLmuKeybinds,
  type AidBind,
  type LmuKeybinds,
} from './lmuKeybinds';
import type { AidRow } from './pitCursor';

/** Direction an aid is stepped in, in LMU's own terms. */
export type AidDir = 'inc' | 'dec';

/** What a step attempt reports, including the HTTP status the route should use. */
export interface AidStepResult {
  ok: boolean;
  /** Status for the HTTP route: 200, or the code that names the reason. */
  status: number;
  error?: string;
  /** The aid's stable id, echoed so a caller can confirm what it hit. */
  aid?: string;
  /** How many presses actually reached the game. */
  sent: number;
  /** Foreground window at the moment of the press, for diagnostics. */
  foreground?: string;
  scancode?: number;
  extended?: boolean;
}

/**
 * Presses the key LMU has bound for `aid`'s `dir`, `repeat` times.
 *
 * The keys come from **LMU's own `keyboard.json`**, resolved fresh on every call
 * (see {@link module:server/lmuKeybinds}) rather than from a keymap we invent:
 * the driver may rebind at any time, and LMU rewrites that file when it exits.
 *
 * The aid may be named by its stable id (`tc`), by the `VM_*` key the telemetry
 * frame carries, or by any alias, so a caller can pass straight through whatever
 * it happens to be holding.
 *
 * `requireSim` (default true) refuses to send unless LMU is frontmost —
 * `SendInput` goes to the foreground window, so an unguarded press would land in
 * whatever the operator just clicked.
 */
export async function stepAid(
  aidName: string,
  dir: AidDir,
  keys: KeySender | null,
  opts: { requireSim?: boolean; repeat?: number } = {},
): Promise<AidStepResult> {
  if (!keys) {
    return { ok: false, status: 503, error: 'key sender unavailable', sent: 0 };
  }
  const binds = readLmuKeybinds();
  if (!binds.path) {
    return { ok: false, status: 503, error: 'LMU keyboard config not found', sent: 0 };
  }
  const aid = findAid(binds, aidName);
  if (!aid) {
    return { ok: false, status: 404, error: `unknown aid: ${aidName}`, sent: 0 };
  }
  const bound = dir === 'inc' ? aid.inc : aid.dec;
  if (!bound) {
    // Bound in LMU is the precondition; say so plainly rather than failing mute.
    const fn = dir === 'inc' ? aid.incFunction : aid.decFunction;
    return {
      ok: false,
      status: 409,
      error: `"${fn}" is not bound to a key in LMU`,
      aid: aid.id,
      sent: 0,
    };
  }
  if (!binds.keyboardSchemeActive) {
    return {
      ok: false,
      status: 409,
      error: 'LMU has its keyboard scheme disabled — the key would be ignored',
      aid: aid.id,
      sent: 0,
    };
  }

  const repeat = Math.min(20, Math.max(1, Math.round(Number(opts.repeat) || 1)));
  const result = await keys.pressScanTimes(bound, repeat, { requireSim: opts.requireSim ?? true });

  return {
    ok: result.ok,
    status: result.ok ? 200 : 409,
    ...(result.error ? { error: result.error } : {}),
    aid: aid.id,
    sent: result.sent,
    foreground: result.foreground,
    scancode: bound.scancode,
    extended: bound.extended,
  };
}

/* -------------------------------------------------------------------------- */
/*  Which aids the CAR has                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The aid keys the current car actually publishes, newest frame wins.
 *
 * Being BOUND and being AVAILABLE are two different questions, and answering
 * the second with the first put a phantom row in the cursor. The widget draws
 * the aids off the frame, where a control the car does not offer has already
 * been dropped (`projectAids` skips `max <= 0`); the cursor built its list from
 * the driver's key binds instead. On a Hypercar, LMP2 or LMP3 — none of which
 * run ABS — a driver with ABS bound got a ▼ stop on a row that was not on
 * screen: the highlight vanished between TC Power Cut and Motor Map, and ± there
 * pressed a key the car ignored.
 *
 * So the frame feeds the availability in, exactly as it feeds the pit phase into
 * `raceControlRows` — one live source, noted every frame, rather than a second
 * list to keep in step.
 */
let liveAidKeys: string[] = [];
let liveAidsAtMs = 0;

/** How long the last frame's list stays authoritative once frames stop. */
const LIVE_AIDS_FRESH_MS = 5000;

/**
 * Feed the aid rows the frame is carrying, from the telemetry loop.
 *
 * Order matters as much as membership: this list IS the widget's row order, so
 * taking it wholesale is what keeps ▲▼ walking the rows a driver can see, in the
 * order they see them. It used to be kept in step by hand — two arrays in two
 * modules that a comment asked future readers not to diverge.
 */
export function noteLiveAids(aids: ReadonlyArray<{ key: string }> | null | undefined): void {
  if (!Array.isArray(aids)) return;
  liveAidKeys = aids.map((a) => a.key).filter((k): k is string => typeof k === 'string' && !!k);
  liveAidsAtMs = Date.now();
}

/*
 * There is deliberately no reset. A car swap needs none — the next frame
 * overwrites the list wholesale — and the freshness window above covers the
 * only other case, which is frames stopping altogether.
 */

/**
 * The aid rows for the MFD cursor to walk, in the SAME order the widget draws
 * them — because they now come from the same place the widget's do.
 *
 * Two filters, and both are needed. The car must OFFER the aid (the live list
 * above), or the cursor stops on a row nobody can see; and LMU must have a key
 * BOUND to it, or ± there could never do anything however real the row is.
 *
 * With no live frame behind it — spectating, provider down, the game not up yet
 * — this falls back to every bound aid. That is the old behaviour, and it is the
 * right fallback: an unknown car is not a car with no controls, and an empty
 * cursor list would be a worse lie than an over-long one.
 *
 * The rows carry no value. They do not need to: the aids are read live from the
 * car on every telemetry frame, so the widget already has the number and the
 * press it just made shows up there within a frame. This module's job is the
 * press, not the reading — which is the whole shape of the change that removed
 * the estimate tracker.
 */
export function buildAidRows(keys: KeySender | null): AidRow[] {
  const binds = readLmuKeybinds();
  const fresh = liveAidKeys.length > 0 && Date.now() - liveAidsAtMs < LIVE_AIDS_FRESH_MS;
  return selectAidRows(binds, fresh ? liveAidKeys : null).map((aid: AidBind) => ({
    id: aid.id,
    label: aid.label,
    text: null,
    step: async (dir: number) => {
      const res = await stepAid(aid.id, dir < 0 ? 'dec' : 'inc', keys);
      return { ok: res.ok, ...(res.error ? { error: res.error } : {}) };
    },
  }));
}

/**
 * Which aids the cursor should stop on: bound AND offered by the car, in the
 * car's own order.
 *
 * Split out from {@link buildAidRows} so the rule can be tested without an LMU
 * install behind it — the wiring needs a real profile and a real key sender,
 * the rule needs neither, and the rule is the part that was wrong.
 *
 * @param binds     LMU's resolved bind set.
 * @param liveKeys  Aid keys the current frame carries, or null when there is no
 *                  live car to ask — in which case every bound aid is offered.
 */
export function selectAidRows(binds: LmuKeybinds, liveKeys: readonly string[] | null): AidBind[] {
  if (!liveKeys || liveKeys.length === 0) return boundAids(binds);

  const out: AidBind[] = [];
  const seen = new Set<string>();
  for (const key of liveKeys) {
    // The frame's key is not always the bind's id — brake bias arrives as
    // `BRAKE_BIAS` because it is read from shared memory, not REST — so this
    // goes through the same alias resolution the widget and the route use.
    const aid = findAid(binds, key);
    if (!aid || (!aid.inc && !aid.dec) || seen.has(aid.id)) continue;
    seen.add(aid.id);
    out.push(aid);
  }
  return out;
}
