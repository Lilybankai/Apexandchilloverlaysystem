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
 *   GET  /api/mfd/cursor   which MFD row the bindable ± is aimed at
 *   POST /api/mfd/cursor   { move? } | { key? } | { name? } | { index? } | { value? }
 *
 * `pit`/`aid` go over LMU's REST API. `aidkey` injects a real keystroke for the
 * LIVE aids LMU does not expose to REST — see {@link module:server/keySender}
 * for the focus rule that governs when a key actually reaches the game. Bind
 * stays on localhost, so this is not a network-exposed control channel.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { projectPitMenu, type MfdController } from '../telemetry/mfdControl';
import type { KeySender } from './keySender';
import { readLmuKeybinds } from './lmuKeybinds';
import { getShadowAids, resync } from './aidShadow';
import { stepAid } from './aidRows';
import { getCursor, getRaceControlRows, moveCursorLive, selectRowLive, stepSelected } from './pitCursor';

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
        // The stable id is what the cursor keys an aid row by (`aid:tc`), so the
        // widget needs it to know which of its own rows the cursor is on —
        // whatever alias its frame happens to label that row with.
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
    // The overlay-owned rows ride along: the widget draws them FROM this rather
    // than from a copy of its own, so their order and values cannot disagree
    // with the list the cursor walks. Answered from memory like the cursor
    // itself, so the poll stays nearly free.
    sendJson(res, 200, {
      ok: true,
      ...getCursor(),
      race: getRaceControlRows().map((v) => ({ name: v.name, text: v.options[v.current] ?? null })),
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
      if (action === 'tyres') {
        // The collapsed all-four-corners compound control. `setting` picks an
        // option outright (what the widget's list sends); `delta` steps it (what
        // a bound wheel button sends).
        const b = body as { setting?: number; delta?: number };
        if (b.setting == null && b.delta == null) {
          sendJson(res, 400, { ok: false, error: 'tyres command needs setting or delta' });
          return;
        }
        const result = await controller.setTyreCompound({ setting: b.setting, delta: b.delta });
        sendJson(res, result.ok ? 200 : 502, result);
        return;
      }
      if (action === 'clearservice') {
        // Strip the next stop back to no service — the pit-menu half of serving
        // a stop-and-go. The other half (actually requesting the stop) is a key
        // press, because LMU exposes no REST route for it; see `pitrequest`.
        const result = await controller.clearPitService();
        sendJson(res, result.ok ? 200 : 502, result);
        return;
      }
      if (action === 'pitrequest') {
        await handlePitRequest(res, keys);
        return;
      }
      if (action === 'servestopgo') {
        // The two halves as one button, in the order they must happen: clearing
        // the menu AFTER requesting would leave a stop already booked with
        // service on it, which is the exact mistake this exists to prevent.
        const cleared = await controller.clearPitService();
        if (!cleared.ok) {
          sendJson(res, 502, cleared);
          return;
        }
        await handlePitRequest(res, keys, cleared.cleared);
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
        const b = body as {
          move?: number;
          value?: number;
          key?: string;
          name?: string;
          index?: number;
        };
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
        if (b.key != null || b.name != null || b.index != null) {
          // `key` is what the widget sends — section-scoped, so aiming at its own
          // SERVE row can never resolve to a sim row of the same name.
          const result = await selectRowLive(
            { key: b.key, name: b.name, index: b.index },
            controller,
          );
          sendJson(res, result.ok ? 200 : 502, result);
          return;
        }
        sendJson(res, 400, { ok: false, error: 'cursor needs move, value, key, name or index' });
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
 * Presses LMU's own **Pit Request** key.
 *
 * This one genuinely cannot go over REST. LMU's API has no pit-request route —
 * the whole 176-endpoint surface was checked — and the nearest thing
 * (`/rest/sessions/ai/forcePlayerVehAiPit`) tells the AI driving your car to
 * pit, which is a different action with a different meaning and would be wrong
 * to quietly substitute. So the request is a keystroke, with the same
 * preconditions the aid keys have: bound in LMU, keyboard scheme on, sim
 * focused.
 *
 * When it is unbound the failure is reported in the terms the driver can act
 * on — bind "Pit Request" to a key in LMU's controls — rather than as a generic
 * error, because that is by far the most likely reason this route ever fails:
 * most drivers have it on a wheel button, which we cannot press.
 */
async function handlePitRequest(
  res: ServerResponse,
  keys: KeySender,
  cleared?: string[],
): Promise<void> {
  const binds = readLmuKeybinds();
  if (!binds.path) {
    sendJson(res, 503, { ok: false, error: 'LMU keyboard config not found', cleared });
    return;
  }
  const key = binds.pit.pitRequest;
  if (!key) {
    // When this follows a successful clear, say so: the menu IS stripped, which
    // is most of the value, and a flat failure would have the driver do it twice.
    sendJson(res, 409, {
      ok: false,
      error: cleared
        ? 'Service cleared, but "Pit Request" is not bound to a KEY in LMU — request the stop ' +
          'yourself. Bind it under Controls → Keyboard to do both from here.'
        : '"Pit Request" is not bound to a KEY in LMU. Bind it under Controls → ' +
          'Keyboard (a wheel-button binding cannot be pressed from here).',
      unbound: true,
      cleared,
    });
    return;
  }
  if (!binds.keyboardSchemeActive) {
    sendJson(res, 409, {
      ok: false,
      error: 'LMU has its keyboard scheme disabled — the key would be ignored',
      cleared,
    });
    return;
  }
  const result = await keys.pressScan(key);
  sendJson(res, result.ok ? 200 : 502, { ...result, cleared });
}

async function handleAidKey(res: ServerResponse, body: unknown, keys: KeySender): Promise<void> {
  const b = body as { aid?: string; dir?: string; requireSim?: boolean; repeat?: number };
  if (!b.aid || (b.dir !== 'inc' && b.dir !== 'dec')) {
    sendJson(res, 400, { ok: false, error: "aidkey needs { aid, dir: 'inc'|'dec' }" });
    return;
  }
  // One implementation, shared with the cursor's aid rows (server/aidRows): the
  // widget's ± and a bound wheel button are meant to be the same act, down to
  // the shadow bookkeeping, and the surest way to keep them so is one function.
  const result = await stepAid(b.aid, b.dir, keys, {
    requireSim: b.requireSim ?? true,
    repeat: b.repeat,
  });
  const { status, ...rest } = result;
  sendJson(res, status, { ...rest, dir: b.dir });
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
