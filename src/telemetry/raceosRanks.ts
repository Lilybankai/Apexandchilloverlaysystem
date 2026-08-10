/**
 * @file src/telemetry/raceosRanks.ts
 * @module telemetry/raceosRanks
 *
 * DR/SR rank badges for the humans in an online session, from the game's own
 * online service (raceos.gg — the racecontrol backend LMU's lobby talks to).
 *
 * ## Why this exists
 * Every LMU driver carries a Driver Rating and a Safety Rating rank badge
 * (Bronze→Platinum, tiered) — the shields the game shows beside every name in
 * its lobby. Those ranks are NOT in the local REST API anywhere (the full
 * swagger was enumerated live, 2026-08-10): they only exist behind the online
 * service, which the game reaches by swapping a Steam session ticket for an
 * access token. This module performs that exact exchange — the same two calls,
 * the same headers, nothing the game itself does not do — and then uses the
 * lobby's own bulk lookup (`POST api/v1/players` by username) to resolve the
 * session's drivers.
 *
 * ## What it deliberately does not do
 * - **No numbers.** The service redacts Elo/rating figures for anyone but the
 *   authenticated player (verified live: every other driver reads 0), so rank
 *   + tier is the whole truth available — and conveniently is exactly what the
 *   game shows.
 * - **No AI names.** Callers feed it the connected-player names from
 *   `/rest/multiplayer/teams`, never standings names: an AI roster name
 *   ("Rafael Santos") could collide with an unrelated real account and pin a
 *   stranger's badge on a bot.
 * - **No token on disk, no token in logs.** The access token lives in one
 *   private field and is only ever sent back to raceos.gg.
 *
 * ## Robustness
 * This is an UNDOCUMENTED private service: any patch may break it. Every
 * failure path degrades to "no badges" — the maps empty, the widgets hide the
 * element, the rest of the frame is untouched. Failures back off (a minute
 * between auth attempts) so a broken endpoint costs a request a minute, not a
 * request per refresh.
 */

import { get as httpGet } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** One rank badge: which shield, which tier notch. */
export interface RankBadge {
  /** `"Bronze" | "Silver" | "Gold" | "Platinum"` — validated before storage. */
  rank: string;
  /** Tier within the rank, 0..3 (the artwork set has exactly these). */
  tier: number;
}

/** Both badges for one driver, either possibly absent. */
export interface DriverRanks {
  driver?: RankBadge;
  safety?: RankBadge;
}

/** The service host the game's own UI is built against. */
const RACEOS_HOST = 'raceos.gg';
/** How often queued (not-yet-resolved) names are flushed to the service. */
const FLUSH_INTERVAL_MS = 30_000;
/** Minimum time between authentication attempts after a failure. */
const AUTH_RETRY_MS = 60_000;
/**
 * How long an access token is trusted before re-authenticating. The game's own
 * client refreshes its ticket on a 25-minute clock; staying inside that means
 * a 401 mid-batch is the exception path, not the routine.
 */
const TOKEN_TTL_MS = 20 * 60_000;
/** Per-request timeout (ms) — a cloud service, so slower than localhost. */
const HTTP_TIMEOUT_MS = 8_000;
/** Ranks the artwork set can draw; anything else is not stored. */
const KNOWN_RANKS = new Set(['Bronze', 'Silver', 'Gold', 'Platinum']);

/** The slice of a raceos player object this module consumes. */
interface RaceosPlayer {
  name?: string;
  username?: string;
  driverRank?: { rank?: unknown; tier?: unknown };
  safetyRank?: { rank?: unknown; tier?: unknown };
}

/** One spelling of a driver name for cache keys — mirrors the provider's. */
function keyOf(name: string): string {
  return name.replace(/#\d+\s*$/, '').trim().toLowerCase();
}

/** Validates a badge out of untrusted JSON; `undefined` unless fully sane. */
function asBadge(v: { rank?: unknown; tier?: unknown } | undefined): RankBadge | undefined {
  if (!v || typeof v.rank !== 'string' || !KNOWN_RANKS.has(v.rank)) return undefined;
  const tier = typeof v.tier === 'number' && Number.isInteger(v.tier) ? v.tier : NaN;
  if (!(tier >= 0 && tier <= 3)) return undefined;
  return { rank: v.rank, tier };
}

/**
 * Resolves and caches rank badges for a rolling set of driver names.
 *
 * Feed it names with {@link noteNames}; read them back (synchronously, from
 * cache) with {@link get}. All network work happens on a lazy timer.
 */
export class RaceosRanksClient {
  /** Resolved (or negatively resolved — `null`) badges by normalized name. */
  private readonly cache = new Map<string, DriverRanks | null>();
  /** Names queued for the next flush, keyed by normalized name → display form. */
  private readonly pending = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private token: string | null = null;
  private tokenAt = 0;
  private lastAuthFailAt = 0;
  private flushing = false;
  private announced = false;

  public constructor(
    private readonly lmuApiPort: number,
    private readonly verbose?: boolean,
  ) {}

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.token = null;
  }

  /**
   * Queues any names not already resolved. Callers pass CONNECTED-PLAYER names
   * (the `/rest/multiplayer/teams` keys), not standings names — see the module
   * note on AI collisions.
   */
  public noteNames(names: Iterable<string>): void {
    for (const raw of names) {
      const display = raw.replace(/#\d+\s*$/, '').trim();
      if (!display) continue;
      const key = display.toLowerCase();
      if (this.cache.has(key) || this.pending.has(key)) continue;
      this.pending.set(key, display);
    }
  }

  /** The badges for a driver name, if resolved. Pure cache read. */
  public get(name: string): DriverRanks | undefined {
    const hit = this.cache.get(keyOf(name));
    return hit ?? undefined;
  }

  /** Drops everything resolved — the next noteNames starts a fresh fetch. */
  public reset(): void {
    this.cache.clear();
    this.pending.clear();
  }

  /* ------------------------------ internals ------------------------------ */

  private async flush(): Promise<void> {
    if (this.flushing || this.pending.size === 0) return;
    this.flushing = true;
    try {
      const ok = await this.ensureToken();
      if (!ok) return;
      const batch = [...this.pending.values()];
      const players = await this.fetchPlayers(batch).catch(async (err: Error) => {
        // One retry after a fresh auth: the token outliving its server-side
        // session is the only expected 401.
        if (err.message !== '401') throw err;
        this.token = null;
        if (!(await this.ensureToken())) return null;
        return this.fetchPlayers(batch);
      });
      if (!players) return;
      // Everything asked for is now settled: found names get their badges,
      // missing ones a negative entry, so neither is ever re-queried this run.
      for (const key of this.pending.keys()) this.cache.set(key, this.cache.get(key) ?? null);
      this.pending.clear();
      let resolved = 0;
      for (const p of players) {
        const name = typeof p.name === 'string' && p.name ? p.name : p.username;
        if (typeof name !== 'string' || !name) continue;
        const ranks: DriverRanks = {
          driver: asBadge(p.driverRank),
          safety: asBadge(p.safetyRank),
        };
        if (!ranks.driver && !ranks.safety) continue;
        this.cache.set(keyOf(name), ranks);
        resolved += 1;
      }
      if (!this.announced && resolved > 0) {
        this.announced = true;
        console.log(`[raceos] rank badges live — ${resolved} drivers resolved`);
      }
    } catch (err) {
      if (this.verbose) console.error('[raceos] rank fetch failed:', (err as Error).message);
    } finally {
      this.flushing = false;
    }
  }

  /** True when a usable access token is in hand (fetching one if needed). */
  private async ensureToken(): Promise<boolean> {
    if (this.token && Date.now() - this.tokenAt < TOKEN_TTL_MS) return true;
    if (Date.now() - this.lastAuthFailAt < AUTH_RETRY_MS) return false;
    try {
      const ticket = await this.gameTicket();
      const auth = await this.postJson<{ accessToken?: string }>('/authenticate', {
        token: ticket,
        game: 'lmu',
        platform: 'steam',
      });
      if (!auth || typeof auth.accessToken !== 'string' || !auth.accessToken) {
        throw new Error('no access token in response');
      }
      this.token = auth.accessToken;
      this.tokenAt = Date.now();
      return true;
    } catch (err) {
      this.lastAuthFailAt = Date.now();
      this.token = null;
      if (this.verbose) console.error('[raceos] auth failed:', (err as Error).message);
      return false;
    }
  }

  /** The Steam session ticket, from the game's own local endpoint. */
  private gameTicket(): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = httpGet(
        {
          host: '127.0.0.1',
          port: this.lmuApiPort,
          path: '/rest/profile/getAuthSessionTicket',
          timeout: 3000,
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`ticket HTTP ${res.statusCode}`));
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                authSessionTicket?: string;
              };
              if (typeof body.authSessionTicket === 'string' && body.authSessionTicket) {
                resolve(body.authSessionTicket);
              } else reject(new Error('no ticket in response'));
            } catch (e) {
              reject(e as Error);
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('ticket timeout')));
    });
  }

  /** The lobby's own bulk lookup. Throws `Error('401')` on an expired token. */
  private fetchPlayers(usernames: string[]): Promise<RaceosPlayer[]> {
    return this.postJson<RaceosPlayer[]>('/api/v1/players', { usernames }, this.token).then(
      (v) => (Array.isArray(v) ? v : []),
    );
  }

  /** One HTTPS POST to the service; JSON in, JSON out, token never logged. */
  private postJson<T>(path: string, body: unknown, bearer?: string | null): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body));
      const req = httpsRequest(
        {
          host: RACEOS_HOST,
          path,
          method: 'POST',
          timeout: HTTP_TIMEOUT_MS,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': payload.length,
            ...(bearer ? { 'Game-Authorization': `Bearer ${bearer}` } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            if (res.statusCode === 401) {
              reject(new Error('401'));
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error(`${path} HTTP ${res.statusCode}`));
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
            } catch (e) {
              reject(e as Error);
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`${path} timeout`)));
      req.end(payload);
    });
  }
}
