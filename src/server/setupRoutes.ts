/**
 * @file src/server/setupRoutes.ts
 * @module server/setupRoutes
 *
 * HTTP face of the setup editor — a thin translation onto
 * {@link module:telemetry/setupControl}. The control panel itself talks to the
 * controller over Electron IPC (its CSP allows no fetch), so these routes
 * exist for two other consumers: `curl` during live verification, and any
 * future OBS-side engineer page. Same controller both ways, so the two faces
 * cannot drift.
 *
 *   GET  /api/setup/state   the full projected setup + car identity
 *   POST /api/setup/value   { key, value }              one validated write
 *   POST /api/setup/batch   { writes: [{key, value}] }  a macro apply
 *
 * No polling happens here — a request costs one read-through of LMU's API and
 * nothing runs between requests, which is what keeps the editor free when its
 * tab is closed.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SetupController, SetupWrite } from '../telemetry/setupControl';

/** URL prefix all setup routes live under. */
export const SETUP_API_PREFIX = '/api/setup/';

/**
 * Largest body we will read. A full macro apply is ~170 `{key, value}` pairs
 * at ~40 bytes each — comfortably inside 16 KB, which is still small enough
 * that nobody can park a payload on us.
 */
const MAX_BODY_BYTES = 16 * 1024;

export interface SetupRouteDeps {
  controller: SetupController;
}

/**
 * Handles an `/api/setup/*` request. Returns `true` if it owned the request
 * (so the caller must not fall through to the static server).
 */
export function handleSetupCommand(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SetupRouteDeps,
): boolean {
  const { controller } = deps;
  const url = (req.url ?? '').split('?')[0] ?? '';
  if (!url.startsWith(SETUP_API_PREFIX)) return false;
  const action = url.slice(SETUP_API_PREFIX.length);

  if (req.method === 'GET' && action === 'state') {
    controller
      .getState()
      .then((state) => sendJson(res, 200, { ok: true, ...state }))
      .catch((err: Error) => sendJson(res, 502, { ok: false, error: err.message }));
    return true;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return true;
  }

  readJsonBody(req)
    .then(async (body) => {
      if (action === 'value') {
        const b = body as { key?: string; value?: number };
        if (!b.key || typeof b.value !== 'number') {
          sendJson(res, 400, { ok: false, error: 'value command needs { key, value }' });
          return;
        }
        const result = await controller.setValue(b.key, b.value);
        sendJson(res, result.ok ? 200 : 502, result);
        return;
      }
      if (action === 'batch') {
        const b = body as { writes?: SetupWrite[] };
        if (!Array.isArray(b.writes) || b.writes.length === 0) {
          sendJson(res, 400, { ok: false, error: 'batch command needs { writes: [...] }' });
          return;
        }
        const result = await controller.setBatch(b.writes);
        sendJson(res, result.ok ? 200 : 502, result);
        return;
      }
      sendJson(res, 404, { ok: false, error: `unknown setup action: ${action}` });
    })
    .catch((err: Error) => {
      sendJson(res, 400, { ok: false, error: err.message });
    });

  return true;
}

/** Reads and JSON-parses a request body, rejecting oversized ones. */
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
