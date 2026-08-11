/**
 * @file src/telemetry/raceosLiveries.ts
 * @module telemetry/raceosLiveries
 *
 * The player's CUSTOM liveries, from LMU's online service. The game keeps no
 * rendered image of a custom paint anywhere on disk or on its local webserver —
 * the exact previews its event and livery screens show live on raceos.gg, and
 * this client fetches them the same way the game UI does (recipe read from its
 * bundle: `RaceOS.fetch` / `getDriverLiveries` / `getCustomImageUrl`):
 *
 *   1. GET  http://127.0.0.1:<port>/rest/profile/getAuthSessionTicket
 *      — the game hands out a Steam session ticket; needs the sim running AND
 *        logged in, which is exactly when a custom livery can be in a garage.
 *   2. POST https://raceos.gg/authenticate  { token, game, platform }
 *      — trades the ticket for a bearer token (~25 min).
 *   3. GET  https://raceos.gg/api/v1/team/livery/player
 *      — every custom livery the player can run, each with public S3 URLs for
 *        the same 3/4 studio render the stock artwork uses.
 *
 * The auth header is `Game-Authorization`, not `Authorization` — plain
 * `Authorization: Bearer` is silently ignored and reads come back 401.
 *
 * Failure is always a quiet null, never a throw: no internet, sim closed, or
 * not signed in all mean "no custom render", and the caller falls back to the
 * local stock artwork.
 */

import http from 'node:http';
import https from 'node:https';

interface LiveryFile {
  type?: string;
  name?: string;
  uri?: string;
}

interface DriverLivery {
  id?: string;
  /** The .VEH base name this paint belongs to, e.g. "397_26_BMW". */
  vehicleId?: string;
  teamName?: string;
  files?: LiveryFile[];
}

/** Refresh the bearer token this long before the service says it expires. */
const TOKEN_MARGIN_MS = 60_000;
/** How long one liveries list answers for. The card asks once per car change. */
const LIST_TTL_MS = 60_000;
/** After a failed auth, don't hammer an offline service on every car change. */
const AUTH_BACKOFF_MS = 60_000;

export class RaceosLiveryClient {
  private readonly port: number;
  private token: { value: string; expiresAt: number } | null = null;
  private authFailedAt = 0;
  private list: { at: number; liveries: DriverLivery[] } | null = null;

  public constructor(lmuApiPort = 6397) {
    this.port = lmuApiPort;
  }

  /**
   * The 3/4 front-angle render of the custom livery for this .VEH id, or null
   * when the id is a stock car (the common case) or the service is out of
   * reach. When several of the player's paints share the car — one per team
   * lineup — the newest wins: the ids lead with a hex creation timestamp, and
   * the game offers no local statement of which paint is selected.
   */
  public async frontAngle(vehId: string): Promise<{ uri: string; webp: Buffer } | null> {
    const matches = (await this.liveries()).filter((l) => l.vehicleId === vehId);
    matches.sort(
      (a, b) => parseInt((b.id ?? '').slice(0, 8), 16) - parseInt((a.id ?? '').slice(0, 8), 16),
    );
    for (const livery of matches) {
      const file = (livery.files ?? []).find(
        (f) => f.type === 'image-front-angle' && (f.name ?? '').startsWith('FrontLarge'),
      );
      if (!file?.uri) continue;
      const webp = await httpsBytes(file.uri);
      if (webp) return { uri: file.uri, webp };
    }
    return null;
  }

  /** The player's custom liveries, cached briefly; [] on any failure. */
  private async liveries(): Promise<DriverLivery[]> {
    if (this.list && Date.now() - this.list.at < LIST_TTL_MS) return this.list.liveries;
    const fresh = await this.fetchLiveries(true);
    if (fresh) this.list = { at: Date.now(), liveries: fresh };
    // A stale list over an empty one: the service being briefly unreachable
    // shouldn't blank a card that showed the right paint a minute ago.
    return this.list?.liveries ?? [];
  }

  /** One list read, retrying once through a fresh token on a 401. */
  private async fetchLiveries(retryOn401: boolean): Promise<DriverLivery[] | null> {
    const token = await this.accessToken();
    if (!token) return null;
    const res = await httpsJson('raceos.gg', '/api/v1/team/livery/player', {
      'Game-Authorization': `Bearer ${token}`,
    });
    if (res.status === 401 && retryOn401) {
      this.token = null;
      return this.fetchLiveries(false);
    }
    return Array.isArray(res.json) ? (res.json as DriverLivery[]) : null;
  }

  /** A live bearer token, minted through the sim's own auth ticket. */
  private async accessToken(): Promise<string | null> {
    if (this.token && Date.now() < this.token.expiresAt - TOKEN_MARGIN_MS) {
      return this.token.value;
    }
    if (Date.now() - this.authFailedAt < AUTH_BACKOFF_MS) return null;

    const ticket = await this.localTicket();
    const auth = ticket
      ? await httpsJson(
          'raceos.gg',
          '/authenticate',
          { 'Content-Type': 'application/json' },
          JSON.stringify({ token: ticket, game: 'lmu', platform: 'steam' }),
        )
      : null;
    const body = auth?.json as { accessToken?: string; expiresAt?: string } | null;
    if (!body?.accessToken) {
      this.authFailedAt = Date.now();
      return null;
    }
    const expiresAt = Date.parse(body.expiresAt ?? '');
    this.token = {
      value: body.accessToken,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 20 * 60_000,
    };
    return this.token.value;
  }

  private localTicket(): Promise<string | null> {
    return new Promise((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port: this.port, path: '/rest/profile/getAuthSessionTicket', timeout: 2000 },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            resolve(null);
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              resolve((JSON.parse(body) as { authSessionTicket?: string }).authSessionTicket ?? null);
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => req.destroy());
    });
  }
}

function httpsJson(
  host: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(body, 'utf8');
    const req = https.request(
      {
        host,
        path,
        method: payload ? 'POST' : 'GET',
        timeout: 8000,
        headers: payload ? { ...headers, 'Content-Length': payload.length } : headers,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: null });
          }
        });
      },
    );
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => req.destroy());
    if (payload) req.write(payload);
    req.end();
  });
}

/** A binary GET of a full https URL (the S3-hosted render). */
function httpsBytes(url: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve(null);
      return;
    }
    if (parsed.protocol !== 'https:') {
      resolve(null);
      return;
    }
    const req = https.get(parsed, { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
  });
}
