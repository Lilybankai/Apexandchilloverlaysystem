/**
 * @file src/server/mfdRoutes.ts
 * @module server/mfdRoutes
 *
 * The tiny control-plane HTTP surface for the MFD widget. Everything else the
 * server does is read-only (static assets + a telemetry WebSocket); these routes
 * are the ONLY way the overlay can change the game, and they exist because a
 * browser cannot POST to LMU's API cross-origin nor send it keystrokes — so the
 * overlay posts an *intent* here and the server performs it.
 *
 *   GET  /api/mfd/state    fresh MFD snapshot (pit menu + aid values)
 *   GET  /api/mfd/state?section=pit   just the pit menu — the fast confirm read
 *   POST /api/mfd/pit      { pmcValue?, name?, setting?, delta? }   → LMU REST
 *   POST /api/mfd/aid      { key, value?, delta? }                  → LMU REST (setup)
 *   GET  /api/mfd/keymap   the aid→keyboard-key map + injector status
 *   POST /api/mfd/aidkey   { aid, dir, requireSim?, delayMs? }      → keystroke into LMU
 *   GET  /api/mfd/cursor   which pit row the bindable ± is aimed at
 *   POST /api/mfd/cursor   { move? } | { name? } | { index? } | { value? }
 *
 * `pit`/`aid` go over LMU's REST API. `aidkey` injects a real keystroke for the
 * LIVE aids LMU does not expose to REST — see {@link module:server/keySender}
 * for the focus rule that governs when a key actually reaches the game. Bind
 * stays on localhost, so this is not a network-exposed control channel.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { projectPitMenu, type MfdController } from '../telemetry/mfdControl';
import type { KeySender } from './keySender';
import { findAid, readLmuKeybinds } from './lmuKeybinds';
import { bump as bumpShadow, getShadowAids, isTracked, resync } from './aidShadow';
import { getCursor, moveCursorLive, selectRow, stepSelected } from './pitCursor';

/** URL prefix all MFD control routes live under. */
export const MFD_API_PREFIX = '/api/mfd/';

/** Largest command body we will read — these are a handful of small fields. */
const MAX_BODY_BYTES = 4096;

/** Dependencies the MFD routes act through. */
export interface MfdRouteDeps {
  controller: MfdController;
  keys: KeySender;
}

/**
 * Handles an `/api/mfd/*` request. Returns `true` if it owned the request (so
 * the caller should not fall through to the static server), `false` otherwise.
 */
export function handleMfdCommand(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MfdRouteDeps,
): boolean {
  const { controller, keys } = deps;
  const url = (req.url ?? '').split('?')[0] ?? '';
  if (!url.startsWith(MFD_API_PREFIX)) return false;
  const action = url.slice(MFD_API_PREFIX.length);

  // Fresh read-through, so the widget can confirm a change without waiting for
  // the next telemetry frame.
  //
  // `?section=pit` reads ONLY the pit menu. That is the one the widget asks for
  // after a change, and the distinction is worth a query param: the full read
  // also pulls `getPlayerGarageData`, a 100+ key payload for values that cannot
  // move mid-session, and waiting on it doubled the time to confirm a pit change
  // the driver is sitting there watching for.
  if (req.method === 'GET' && action === 'state') {
    const pitOnly = /[?&]section=pit(&|$)/.test(req.url ?? '');
    if (pitOnly) {
      controller
        .getPitRows()
        .then((rows) => sendJson(res, 200, { ok: true, pit: projectPitMenu(rows) }))
        .catch((err: Error) => sendJson(res, 502, { ok: false, error: err.message }));
      return true;
    }
    controller
      .getState()
      .then((state) => sendJson(res, 200, { ok: true, mfd: state }))
      .catch((err: Error) => sendJson(res, 502, { ok: false, error: err.message }));
    return true;
  }

  // What the overlay can actually drive: LMU's OWN aid binds (read live from its
  // keyboard.json), plus injector status. The widget uses this to show ± only on
  // aids that are really bound, and to explain itself when the sim isn't focused.
  if (req.method === 'GET' && action === 'keymap') {
    const binds = readLmuKeybinds();
    sendJson(res, 200, {
      ok: true,
      available: keys.available,
      simForeground: keys.isSimForeground(),
      foreground: keys.foregroundTitle(),
      configPath: binds.path,
      shadowAids: getShadowAids(),
      keyboardSchemeActive: binds.keyboardSchemeActive,
      aids: binds.aids.map((a) => ({
        id: a.id,
        vmKey: a.vmKey,
        // Every name this aid answers to, so the widget can match a row whatever
        // key its frame happens to carry (brake bias arrives as BRAKE_BIAS).
        keys: [a.id, a.vmKey, ...a.aliases].filter(Boolean),
        label: a.label,
        // A direction with no key is not offerable — surfaced so the widget can
        // grey it out rather than fail on click.
        canInc: a.inc !== null,
        canDec: a.dec !== null,
        incFunction: a.incFunction,
        decFunction: a.decFunction,
      })),
    });
    return true;
  }

  // Where the bindable pit controls are pointing. Deliberately answered from
  // memory rather than by re-reading the menu: the widget polls this to draw its
  // highlight, and it already has the rows from the telemetry frame — asking LMU
  // again several times a second to learn something we ourselves decided would
  // be pure noise on the sim's API.
  if (req.method === 'GET' && action === 'cursor') {
    sendJson(res, 200, { ok: true, ...getCursor() });
    return true;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return true;
  }

  readJsonBody(req)
    .then(async (body) => {
      if (action === 'pit') {
        const b = body as { pmcValue?: number; name?: string; setting?: number; delta?: number };
        if (b.pmcValue == null && !b.name) {
          sendJson(res, 400, { ok: false, error: 'pit command needs pmcValue or name' });
          return;
        }
        const result = await controller.setPitRow(
          { pmcValue: b.pmcValue, name: b.name },
          { setting: b.setting, delta: b.delta },
        );
        sendJson(res, result.ok ? 200 : 502, result);
        return;
      }
      if (action === 'aid') {
        const b = body as { key?: string; value?: number; delta?: number };
        if (!b.key) {
          sendJson(res, 400, { ok: false, error: 'aid command needs key' });
          return;
        }
        const result = await controller.setAid(b.key, { value: b.value, delta: b.delta });
        sendJson(res, result.ok ? 200 : 502, result);
        return;
      }
      if (action === 'aidresync') {
        // Re-seed the estimated aids from LMU's setup values. The driver's escape
        // hatch when a change happened on a route we cannot see.
        const garage = await controller.getGarageData().catch(() => null);
        resync(garage);
        sendJson(res, 200, { ok: true, shadowAids: getShadowAids() });
        return;
      }
      if (action === 'cursor') {
        // One route for all four bindable controls, because they are one control
        // surface: `move` walks the rows, `value` changes the row it stopped on.
        const b = body as { move?: number; value?: number; name?: string; index?: number };
        if (b.value != null) {
          const result = await stepSelected(b.value, controller);
          sendJson(res, result.ok ? 200 : 502, result);
          return;
        }
        if (b.move != null) {
          const result = await moveCursorLive(b.move, controller);
          sendJson(res, result.ok ? 200 : 502, result);
          return;
        }
        if (b.name != null || b.index != null) {
          const rows = await controller.getPitRows();
          if (!Array.isArray(rows) || rows.length === 0) {
            sendJson(res, 502, { ok: false, ...getCursor(), error: 'pit menu unavailable' });
            return;
          }
          sendJson(res, 200, { ok: true, ...selectRow({ name: b.name, index: b.index }, rows) });
          return;
        }
        sendJson(res, 400, { ok: false, error: 'cursor needs move, value, name or index' });
        return;
      }
      if (action === 'aidkey') {
        await handleAidKey(res, body, keys);
        return;
      }
      sendJson(res, 404, { ok: false, error: `unknown MFD action: ${action}` });
    })
    .catch((err: Error) => {
      sendJson(res, 400, { ok: false, error: err.message });
    });

  return true;
}

/**
 * Fires the keystroke that steps a driving aid.
 *
 * The keys come from **LMU's own `keyboard.json`**, resolved fresh on every
 * request (see {@link module:server/lmuKeybinds}) rather than from a keymap we
 * invent. That matters for two reasons: a key the game has not bound does
 * nothing however perfectly we send it, and the driver may rebind at any time.
 *
 * The aid may be named either by its stable id (`tc`) or by the `VM_*` key the
 * telemetry frame carries (`VM_TRACTIONCONTROLMAP`), so the widget can pass
 * straight through whatever it is rendering.
 *
 * `requireSim` (default true) refuses to send unless LMU is frontmost —
 * `SendInput` goes to the foreground window, so an unguarded press would land
 * in whatever the operator just clicked.
 */
async function handleAidKey(res: ServerResponse, body: unknown, keys: KeySender): Promise<void> {
  const b = body as { aid?: string; dir?: string; requireSim?: boolean; repeat?: number };
  if (!b.aid || (b.dir !== 'inc' && b.dir !== 'dec')) {
    sendJson(res, 400, { ok: false, error: "aidkey needs { aid, dir: 'inc'|'dec' }" });
    return;
  }

  const binds = readLmuKeybinds();
  if (!binds.path) {
    sendJson(res, 503, { ok: false, error: 'LMU keyboard config not found' });
    return;
  }
  const aid = findAid(binds, b.aid);
  if (!aid) {
    sendJson(res, 404, { ok: false, error: `unknown aid: ${b.aid}` });
    return;
  }
  const key = b.dir === 'inc' ? aid.inc : aid.dec;
  if (!key) {
    // Bound in LMU is the precondition; say so plainly rather than failing mute.
    sendJson(res, 409, {
      ok: false,
      error: `"${b.dir === 'inc' ? aid.incFunction : aid.decFunction}" is not bound to a key in LMU`,
      aid: aid.id,
    });
    return;
  }
  if (!binds.keyboardSchemeActive) {
    sendJson(res, 409, {
      ok: false,
      error: 'LMU has its keyboard scheme disabled — the key would be ignored',
    });
    return;
  }

  const repeat = Math.min(20, Math.max(1, Math.round(Number(b.repeat) || 1)));
  const result = await keys.pressScanTimes(key, repeat, { requireSim: b.requireSim ?? true });

  // Keep the shadow in step for the aids LMU will not let us read back. Only
  // count presses that were actually SENT: a refused press (sim not focused)
  // changed nothing in the game, so counting it would desync the display.
  let shadowValue = null;
  if (isTracked(aid.id) && result.sent > 0) {
    for (let i = 0; i < result.sent; i++) {
      shadowValue = bumpShadow(aid.id, b.dir === 'inc' ? 1 : -1, 'overlay');
    }
  }

  sendJson(res, result.ok ? 200 : 409, {
    ...result,
    aid: aid.id,
    dir: b.dir,
    scancode: key.scancode,
    extended: key.extended,
    shadowValue,
  });
}

/** Reads and JSON-parses a small request body, rejecting oversized ones. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}
