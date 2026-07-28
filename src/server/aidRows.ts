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
 * ## Only bound aids are offered
 * A key LMU has not bound does nothing however perfectly we send it, so
 * {@link buildAidRows} lists only the aids with at least one direction bound —
 * the same test the widget uses to decide whether to draw ± at all. An aid the
 * driver cannot change is not a row the cursor should stop on.
 */

import type { KeySender } from './keySender';
import { boundAids, findAid, readLmuKeybinds, type AidBind } from './lmuKeybinds';
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

/**
 * The aid rows for the MFD cursor to walk, in the SAME order the widget draws
 * them. That order is the widget's, not a preference: the cursor list and the
 * on-screen list have to agree or ▼ appears to skip rows.
 *
 * The rows carry no value. They do not need to: the aids are read live from the
 * car on every telemetry frame, so the widget already has the number and the
 * press it just made shows up there within a frame. This module's job is the
 * press, not the reading — which is the whole shape of the change that removed
 * the estimate tracker.
 */
export function buildAidRows(keys: KeySender | null): AidRow[] {
  const binds = readLmuKeybinds();
  return boundAids(binds).map((aid: AidBind) => ({
    id: aid.id,
    label: aid.label,
    text: null,
    step: async (dir: number) => {
      const res = await stepAid(aid.id, dir < 0 ? 'dec' : 'inc', keys);
      return { ok: res.ok, ...(res.error ? { error: res.error } : {}) };
    },
  }));
}
