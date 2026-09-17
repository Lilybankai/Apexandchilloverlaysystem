/**
 * @file src/telemetry/raceosResults.ts
 * @module telemetry/raceosResults
 *
 * Official race results from the game's own online service, projected down to
 * the handful of fields a Discord embed needs.
 *
 * ## Why this exists
 * The companion-app plan was written around "no race results record exists
 * anywhere". It does: RaceOS (raceos.gg) has the full classification of every
 * official daily, weekly, special and championship event — grid, finish, class
 * position, best lap, laps and status for EVERY driver in the field, including
 * the twenty who have never heard of this app — and it is retroactive. That is
 * a far better thing to post in a league's Discord than one member's own row,
 * and it is authoritative in a way a self-reported lap can never be.
 *
 * ## The three constraints that shape this file
 *
 * 1. **It needs the game running.** The token is bought with a Steam session
 *    ticket from LMU's own loopback endpoint, exactly as
 *    {@link module:telemetry/raceosRanks} does it. No browser and no server can
 *    perform that exchange, so the desktop harvests and the cloud receives.
 *
 * 2. **The payload is enormous.** 2.3 MB for ten events, because every event
 *    embeds the entire field, every team's members, every livery URL and every
 *    per-driver rating adjustment with its reason text. Nothing may store or
 *    forward it: {@link projectResults} runs on the raw response and everything
 *    downstream sees only its output, which is a few hundred bytes an event.
 *
 * 3. **This ends in a public message.** Whatever survives the projection can be
 *    read by a stranger in someone's Discord. So the projection is a WHITELIST
 *    — named fields copied out, never "everything except" — and `api/v1/player`
 *    (which hands back the account email and a live verification code beside
 *    the racing data) is not called from here at all. Names, positions and lap
 *    times are what the game shows everyone; ratings are not, and are dropped
 *    even where the service leaks them.
 *
 * ## Robustness
 * Undocumented private service; any patch may break it. Every failure degrades
 * to "no results this time" — the harvester logs and tries again later, and
 * nothing else in the app notices.
 *
 * The field paths in {@link ROW_PATHS} were written from the shape
 * `scripts/probe-raceos-results.js` PRINTED rather than from a saved sample,
 * which is why each is a list of candidates. They were checked against ten real
 * events on 2026-09-17 and two were wrong:
 *
 *   - the rows are at `race.races[0].results`, not `race.results` — a session
 *     holds an array of heats — so every live event was silently skipped and
 *     nothing was ever harvested;
 *   - `car` resolved to nothing, because the service calls it `carType`.
 *
 * Every other path resolved first or second try. `scripts/test-results.js` now
 * holds a fixture in the real nesting so neither can regress quietly.
 */

import { get as httpGet } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** One driver's line in a classification, after projection. */
export interface ResultRow {
  /** Overall finishing position. */
  pos: number;
  /** Position within class, when the event ran more than one. */
  classPos: number | null;
  /** Where they started. */
  gridPos: number | null;
  /** Driver name as the service spells it — the only identity we keep. */
  name: string;
  car: string;
  carClass: string;
  laps: number | null;
  bestLapMs: number | null;
  /** Total race time in ms, when the service gives one. */
  totalMs: number | null;
  /** 'Finished' | 'DNF' | 'DSQ' | … — whatever the service said, trimmed. */
  status: string;
}

/** One event, projected. This is the shape the cloud stores and nothing wider. */
export interface HarvestedEvent {
  /** Stable id for this event, prefixed by source: the dedupe key everywhere. */
  eventKey: string;
  /** 'daily' | 'specialevent' | 'championship' | ''. */
  eventType: string;
  name: string;
  track: string;
  /** ISO 8601, or null when the service did not say. */
  startedAt: string | null;
  classification: ResultRow[];
  /** Our own driver's name in `classification`, when it could be identified. */
  mine: string | null;
}

const RACEOS_HOST = 'raceos.gg';
const HTTP_TIMEOUT_MS = 15_000;
/** A token is good for far longer; re-auth well inside it. */
const TOKEN_TTL_MS = 30 * 60 * 1000;
/** Don't hammer a broken exchange. */
const AUTH_RETRY_MS = 60_000;
/**
 * Events per fetch. Each one is ~230 KB of the 2.3 MB the probe measured for
 * ten, so this is a real download, not a list query — three covers a driver who
 * ran a triple-header while the app was closed and still costs under a megabyte.
 */
const DEFAULT_TAKE = 3;
/** A field this size is not an LMU race; the cloud refuses over 120 as well. */
const MAX_FIELD = 120;

/* -------------------------------------------------------------------------- */
/*  Projection — the only part that knows what the service's JSON looks like  */
/* -------------------------------------------------------------------------- */

/** First defined, non-empty value at any of these dotted paths. */
function pick(obj: unknown, ...paths: string[]): unknown {
  for (const p of paths) {
    let v: unknown = obj;
    for (const k of p.split('.')) {
      v = v == null ? undefined : (v as Record<string, unknown>)[k];
    }
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function str(v: unknown, max = 80): string {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Lap and race times arrive as either milliseconds, seconds, or "1:59.123".
 * All three appear across LMU's surfaces, so all three are accepted and
 * normalised to whole milliseconds here rather than three layers further on.
 */
export function toMs(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    // A lap is never 600000 raw units unless those units are already ms, and
    // never 600 seconds; the split is unambiguous in the range that matters.
    return v > 10_000 ? Math.round(v) : Math.round(v * 1000);
  }
  const s = String(v).trim();
  const clock = s.match(/^(?:(\d+):)?(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (clock) {
    const mins = Number(clock[1] ?? 0);
    const secs = Number(clock[2]);
    const frac = Number((clock[3] ?? '0').padEnd(3, '0'));
    const ms = mins * 60_000 + secs * 1000 + frac;
    return ms > 0 ? ms : null;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? toMs(n) : null;
}

/**
 * Where each field has been seen, most likely first. Lists rather than single
 * names because this service is undocumented and its casing is inconsistent
 * even within one payload (`Laps` beside `bestLapTime`).
 */
const ROW_PATHS = {
  pos: ['position', 'Position', 'finishPosition', 'pos'],
  classPos: ['classPosition', 'ClassPosition', 'classPos'],
  gridPos: ['gridPos', 'GridPos', 'gridPosition', 'startPosition'],
  name: ['driverName', 'name', 'DriverName', 'fullName', 'username', 'player.name'],
  // `carType` is the model ("BMW M Hybrid V8"); `vehName` is the entry's own
  // livery name and `category` the full tree, so type first.
  car: ['carType', 'vehName', 'carName', 'car', 'vehicle', 'carModel'],
  carClass: ['carClass', 'class', 'category', 'carCategory'],
  laps: ['Laps', 'laps', 'lapsCompleted', 'LapsCompleted'],
  bestLap: ['bestLapTime', 'BestLapTime', 'bestLap', 'fastestLap'],
  total: ['finishTime', 'FinishTime', 'totalTime', 'raceTime'],
  status: ['finishStatus', 'FinishStatus', 'status', 'state'],
} as const;

/** The race session inside an event, whatever the service calls it. */
function raceRowsOf(event: Record<string, unknown>): Record<string, unknown>[] {
  const candidates = [
    // A session is `{ sessionNo, races: [ { results: [...] } ] }` — the rows are
    // one level deeper than they look, because a session can hold more than one
    // heat. Checked against ten real events on 2026-09-17: `race.results` is
    // always undefined and `race.races[0].results` always has the field.
    'race.races.0.results',
    'race.races.0.entries',
    'race.results',
    'race.entries',
    'race.drivers',
    'sessions.race.results',
    'sessions.race.entries',
    'results.race',
    'classification',
    'results',
    'entries',
  ];
  for (const path of candidates) {
    const v = pick(event, path);
    if (Array.isArray(v) && v.length) return v as Record<string, unknown>[];
  }
  // Some shapes put the sessions in an array tagged by type rather than in a
  // named key. Take the one that calls itself the race.
  const sessions = pick(event, 'sessions');
  if (Array.isArray(sessions)) {
    const race = sessions.find(
      (s) => /race/i.test(String(pick(s, 'type', 'name', 'sessionType') ?? '')),
    );
    const rows = pick(race, 'results', 'entries', 'drivers', 'classification');
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

function projectRow(raw: Record<string, unknown>): ResultRow | null {
  const pos = num(pick(raw, ...ROW_PATHS.pos));
  const name = str(pick(raw, ...ROW_PATHS.name));
  // A row with neither a position nor a name is not a classification line —
  // most likely a summary object that happened to be in the same array.
  if (pos === null || !name) return null;
  return {
    pos,
    classPos: num(pick(raw, ...ROW_PATHS.classPos)),
    gridPos: num(pick(raw, ...ROW_PATHS.gridPos)),
    name,
    car: str(pick(raw, ...ROW_PATHS.car), 60),
    carClass: str(pick(raw, ...ROW_PATHS.carClass), 30),
    laps: num(pick(raw, ...ROW_PATHS.laps)),
    bestLapMs: toMs(pick(raw, ...ROW_PATHS.bestLap)),
    totalMs: toMs(pick(raw, ...ROW_PATHS.total)),
    status: str(pick(raw, ...ROW_PATHS.status), 24),
  };
}

/**
 * Raw `api/v1/results` response → the events worth uploading.
 *
 * `myNames` is what the app knows this driver is called locally (LMU's own
 * player name). It is used ONLY to tag which row in the classification is ours,
 * which is what lets a league's channel say "and yours finished 4th". An event
 * whose owner cannot be identified is still returned — the podium is worth
 * posting either way, and a later upload by someone else can fill the gap.
 *
 * Exported and pure so scripts/test-results.js can hold it to a fixture.
 */
export function projectResults(raw: unknown, myNames: string[] = []): HarvestedEvent[] {
  const list = Array.isArray(raw)
    ? raw
    : (pick(raw, 'results', 'items', 'data', 'events') as unknown[]) || [];
  if (!Array.isArray(list)) return [];

  const mineKeys = new Set(myNames.map((n) => str(n).toLowerCase()).filter(Boolean));
  const out: HarvestedEvent[] = [];

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const event = entry as Record<string, unknown>;

    const id = pick(event, 'id', 'eventId', 'sessionId', 'raceId', 'event.id');
    const name = str(pick(event, 'eventName', 'title', 'name', 'event.name'), 120);
    const track = str(pick(event, 'trackName', 'track', 'scene', 'circuit', 'event.track'), 120);
    // Without an id there is no dedupe key, and without a dedupe key twelve
    // members' uploads become twelve messages. Skip rather than invent one.
    if (id === undefined) continue;

    const rows = raceRowsOf(event)
      .map(projectRow)
      .filter((r): r is ResultRow => r !== null)
      .sort((a, b) => a.pos - b.pos)
      .slice(0, MAX_FIELD);
    if (!rows.length) continue;

    const started = pick(event, 'startTime', 'starts', 'startedAt', 'date', 'event.starts');
    const startedMs = started === undefined ? NaN : Date.parse(String(started));

    out.push({
      eventKey: `raceos:${str(id, 120)}`,
      eventType: str(pick(event, 'eventType', 'type', 'category'), 40),
      name,
      track,
      startedAt: Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : null,
      classification: rows,
      mine: rows.find((r) => mineKeys.has(r.name.toLowerCase()))?.name ?? null,
    });
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/*  Transport                                                                 */
/* -------------------------------------------------------------------------- */

export interface RaceosResultsOptions {
  /** LMU's loopback API port — the same one the rest of the app talks to. */
  lmuApiPort?: number;
  verbose?: boolean;
}

/**
 * Fetches and projects. Holds one token in memory, never on disk and never in a
 * log, exactly as the ranks client does.
 */
export class RaceosResultsClient {
  private token: string | null = null;
  private tokenAt = 0;
  private lastAuthFailAt = 0;
  private readonly lmuApiPort: number;
  private readonly verbose: boolean;

  constructor(opts: RaceosResultsOptions = {}) {
    this.lmuApiPort = opts.lmuApiPort ?? 6397;
    this.verbose = !!opts.verbose;
  }

  /** Recent official events with their classifications, or [] on any failure. */
  async fetchRecent(myNames: string[] = [], take = DEFAULT_TAKE): Promise<HarvestedEvent[]> {
    if (!(await this.ensureToken())) return [];
    try {
      const q = `eventType=&page=1&take=${Math.max(1, Math.min(take, 10))}`;
      const raw = await this.getJson<unknown>(`/api/v1/results?${q}`);
      return projectResults(raw, myNames);
    } catch (err) {
      // A 401 means the token aged out mid-flight; drop it so the next attempt
      // buys a new one rather than repeating the same rejected call.
      if ((err as Error).message === '401') this.token = null;
      if (this.verbose) console.error('[raceos] results fetch failed:', (err as Error).message);
      return [];
    }
  }

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

  private getJson<T>(path: string): Promise<T> {
    return this.send<T>('GET', path, null);
  }

  private postJson<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>('POST', path, body);
  }

  /** One HTTPS call; JSON in, JSON out, token never logged. */
  private send<T>(method: string, path: string, body: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body === null ? null : Buffer.from(JSON.stringify(body));
      const req = httpsRequest(
        {
          host: RACEOS_HOST,
          path,
          method,
          timeout: HTTP_TIMEOUT_MS,
          headers: {
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
            ...(this.token ? { 'Game-Authorization': `Bearer ${this.token}` } : {}),
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
              reject(new Error(`${path.split('?')[0]} HTTP ${res.statusCode}`));
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
      req.on('timeout', () => req.destroy(new Error(`${path.split('?')[0]} timeout`)));
      if (payload) req.write(payload);
      req.end();
    });
  }
}
