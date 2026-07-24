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
 *   POST /api/mfd/pit      { pmcValue?, name?, setting?, delta? }   → LMU REST
 *   POST /api/mfd/aid      { key, value?, delta? }                  → LMU REST (setup)
 *   GET  /api/mfd/keymap   the aid→keyboard-key map + injector status
 *   POST /api/mfd/aidkey   { aid, dir, requireSim?, delayMs? }      → keystroke into LMU
 *
 * `pit`/`aid` go over LMU's REST API. `aidkey` injects a real keystroke for the
 * LIVE aids LMU does not expose to REST — see {@link module:server/keySender}
 * for the focus rule that governs when a key actually reaches the game. Bind
 * stays on localhost, so this is not a network-exposed control channel.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MfdController } from '../telemetry/mfdControl';
import type { KeySender } from './keySender';
import type { AidKeyBinding } from './aidKeymap';

/** URL prefix all MFD control routes live under. */
export const MFD_API_PREFIX = '/api/mfd/';

/** Largest command body we will read — these are a handful of small fields. */
const MAX_BODY_BYTES = 4096;
/** Cap on the bind-helper fire delay, so a stray value can't hang a request. */
const MAX_KEY_DELAY_MS = 15_000;

/** Dependencies the MFD routes act through. */
export interface MfdRouteDeps {
  controller: MfdController;
  keys: KeySender;
  /** Aid→key map, indexed by aid (VM_) key. */
  keymap: Map<string, AidKeyBinding>;
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
  const { controller, keys, keymap } = deps;
  const url = (req.url ?? '').split('?')[0] ?? '';
  if (!url.startsWith(MFD_API_PREFIX)) return false;
  const action = url.slice(MFD_API_PREFIX.length);

  // Fresh read-through, so the widget can confirm a change without waiting for
  // the next telemetry frame.
  if (req.method === 'GET' && action === 'state') {
    controller
      .getState()
      .then((state) => sendJson(res, 200, { ok: true, mfd: state }))
      .catch((err: Error) => sendJson(res, 502, { ok: false, error: err.message }));
    return true;
  }

  // The aid→key map + injector status, so the widget can label each aid with the
  // key to bind in LMU and warn when the sim isn't focused / injection is off.
  if (req.method === 'GET' && action === 'keymap') {
    sendJson(res, 200, {
      ok: true,
      available: keys.available,
      simForeground: keys.isSimForeground(),
      foreground: keys.foregroundTitle(),
      bindings: [...keymap.values()],
    });
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
      if (action === 'aidkey') {
        handleAidKey(res, body, keys, keymap);
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
 * Fires the keystroke bound to an aid direction. `requireSim` (default true)
 * refuses to send unless LMU is the foreground window, so a click that stole
 * focus can't leak a key into the browser. `delayMs` defers the press — the
 * LMU-binding flow: request it, then focus LMU's control-bind dialog before it
 * fires (with `requireSim:false`, since the dialog is captured differently).
 */
function handleAidKey(
  res: ServerResponse,
  body: unknown,
  keys: KeySender,
  keymap: Map<string, AidKeyBinding>,
): void {
  const b = body as { aid?: string; dir?: string; requireSim?: boolean; delayMs?: number };
  if (!b.aid || (b.dir !== 'inc' && b.dir !== 'dec')) {
    sendJson(res, 400, { ok: false, error: "aidkey needs { aid, dir: 'inc'|'dec' }" });
    return;
  }
  const binding = keymap.get(b.aid);
  if (!binding) {
    sendJson(res, 404, { ok: false, error: `no key mapping for aid ${b.aid}` });
    return;
  }
  const keyName = b.dir === 'inc' ? binding.inc : binding.dec;
  const requireSim = b.requireSim ?? true;
  const fire = (): void => {
    const r = keys.press(keyName, { requireSim });
    sendJson(res, r.ok ? 200 : 409, { ...r, aid: b.aid, dir: b.dir, key: keyName });
  };
  const delay = Math.min(MAX_KEY_DELAY_MS, Math.max(0, Number(b.delayMs) || 0));
  if (delay > 0) setTimeout(fire, delay);
  else fire();
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
