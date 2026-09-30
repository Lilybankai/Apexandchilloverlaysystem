/**
 * @file src/server/lmuReplay.ts
 * @module server/lmuReplay
 *
 * The race log's ▶ button: load the game's own replay of a race and drop the
 * camera on our car a few seconds before an incident. Phase 4 of
 * `docs/RACE-LOG-PLAN.md`; the call sequence is table C there, driven end to
 * end against the running game on 2026-09-30 and not improvised on here.
 *
 * ## Pairing a results file to a replay
 * The game names neither side after the other, so the pair is inferred. Read
 * against 40 real R1 files and the 281-entry replay list on this machine:
 *   - a replay's `timestamp` is the XML's **top-level** `<DateTime>` (the event
 *     start) plus 2–15 s. The `<Race><DateTime>` inside is up to half an hour
 *     later (practice and qualifying come first) and is the wrong one;
 *   - `replayName` is `<TrackCourse> <session> <n>`, e.g. `Circuit de la Sarthe
 *     R1 27`. `sceneDesc` is not in the XML at all, so the name is the track
 *     key, and matching the whole prefix keeps `Circuit de la Sarthe Mulsanne`
 *     and the `WU` warm-ups (also tagged `session: 'RACE'`) apart;
 *   - the `.Vcr` stops being written when the XML is: 0–85 s apart on every
 *     pair but one mid-race join (293 s). That breaks the tie when a restart
 *     reuses the event's timestamp (Spa, 2026-08-16: `R1 38` and `R1 39` share
 *     one), and it is the only thing that finds the second race of such an
 *     event, whose own `<DateTime>` is 3½ h after the replay's.
 * The game keeps five replays per track and session type, so "no pair" is
 * normal and is reported as `unavailable`, never as an error.
 *
 * ## The guards
 * Loading a replay replaces whatever the game is doing. So it happens only
 * from the main menu, or from a replay (ours or not), and **never** from a
 * live session: that answers `blocked` and the driver leaves by hand. The game
 * cannot say which replay is loaded (`isactive` is true or false), so this
 * module remembers what it loaded and forgets it the moment the game leaves
 * replay playback.
 *
 * One look at the game per click is not enough: a load takes up to a minute
 * and the driver keeps using the PC meanwhile. So the state is read again
 * right before every call that changes what the game shows — the exit to the
 * menu, the play, each retry of a jump — and an answer that is no longer a
 * replay (or the menu, for the play) stops the sequence there.
 *
 * ## Where it runs
 * In the Electron main process, beside the Review IPC that calls it, built
 * lazily like the setup controller. The overlay server runs in the same
 * process anyway, but it is started and stopped with settings, and the Review
 * tab must work whether or not it is up. No Electron import: the test drives
 * it against a fake LMU over plain `http`.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { findLmuLogDir } from '../telemetry/lmuTraceLimits';
import type { ReplayPhase, ReplayStatus } from '../telemetry/raceLogTypes';

/* -------------------------------------------------------------------------- */
/*  What the game says                                                        */
/* -------------------------------------------------------------------------- */

/** One row of `GET /rest/watch/replays`, narrowed to what pairing reads. */
export interface ReplayListEntry {
  /** A LIST POSITION, not an identity: it shifts as replays come and go. */
  id: number;
  replayName: string;
  replayDirectory?: string;
  size?: number;
  /** Unix seconds; the event start the replay was recorded under. */
  timestamp: number;
  metadata?: { session?: string; sceneDesc?: string; eventTitle?: string; eventType?: string };
}

/** `GET /navigation/state`, narrowed. */
interface NavState {
  loadingStatus?: { loading?: boolean; percentage?: number };
  state?: { navigationState?: string; gameState?: string; settingMode?: string };
}

/** What pairing needs from a results file. See {@link readRaceInfo}. */
export interface ReplayRaceInfo {
  /** The results file's basename, the race log's id. */
  raceId: string;
  /** `<TrackCourse>`, the replay name's prefix. */
  course: string;
  /** From the file name: `R1`, `Q1`, `P1`. */
  session: string;
  /** The top-level `<DateTime>`: the event start, unix seconds. */
  startedAt: number;
  /** When the game wrote the file; null when unknown. */
  xmlMtimeMs: number | null;
}

/** The replay a race paired with. */
export interface ReplayMatch {
  replayName: string;
  /** Valid only for the list it came from. Re-pair before playing. */
  id: number;
  sizeBytes: number | null;
  timestamp: number;
}

export type ReplayUnavailableReason = 'no-results' | 'no-replay' | 'game-offline';

export type FindReplayResult =
  | { ok: true; replay: ReplayMatch }
  | { ok: false; reason: ReplayUnavailableReason; message: string };

/* -------------------------------------------------------------------------- */
/*  Pairing (pure)                                                            */
/* -------------------------------------------------------------------------- */

/** How far a replay's timestamp may sit from the event start. Seen: 2–15 s. */
export const TIMESTAMP_WINDOW_S = 120;
/** How far the `.Vcr` mtime may sit from the XML's, when that alone pairs. */
export const MTIME_WINDOW_S = 120;

/** Case, spacing and Unicode form, so `Autódromo` matches however it was written. */
function norm(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Escape a string for use inside a RegExp. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Is this replay the right track and session for the race? */
export function replayNameMatches(replayName: string, course: string, session: string): boolean {
  if (!course || !session) return false;
  const re = new RegExp(`^${reEscape(norm(course))} ${reEscape(norm(session))} \\d+$`);
  return re.test(norm(replayName));
}

/**
 * The replay recorded for a race, or null.
 *
 * A candidate names the same course and session, and either starts within
 * {@link TIMESTAMP_WINDOW_S} of the event or finished writing within
 * {@link MTIME_WINDOW_S} of the results file (the restart case, see the
 * header). Of those, the lowest cost wins: seconds off on the timestamp plus
 * seconds off on the mtime, so the nearest timestamp decides and the mtime
 * breaks a tie.
 *
 * @param vcrMtimeMs - The `.Vcr` file's mtime for an entry, or null.
 */
export function pairReplay(
  race: ReplayRaceInfo,
  list: readonly ReplayListEntry[],
  vcrMtimeMs: (entry: ReplayListEntry) => number | null = () => null,
): ReplayListEntry | null {
  let best: ReplayListEntry | null = null;
  let bestCost = Infinity;
  for (const r of list) {
    if (!r || typeof r.replayName !== 'string' || !Number.isFinite(r.timestamp)) continue;
    if (r.metadata && r.metadata.session && r.metadata.session !== 'RACE' && /^R\d/.test(race.session)) {
      continue;
    }
    if (!replayNameMatches(r.replayName, race.course, race.session)) continue;
    const dTs = Math.abs(r.timestamp - race.startedAt);
    const vm = race.xmlMtimeMs != null ? vcrMtimeMs(r) : null;
    const dM = vm != null && race.xmlMtimeMs != null ? Math.abs(vm - race.xmlMtimeMs) / 1000 : null;
    const tsOk = dTs <= TIMESTAMP_WINDOW_S;
    // The mtime alone may pair only a replay that started no later than the
    // event did: a restart reuses an OLDER timestamp, never a newer one.
    const mtOk = dM != null && dM <= MTIME_WINDOW_S && r.timestamp <= race.startedAt + TIMESTAMP_WINDOW_S;
    if (!tsOk && !mtOk) continue;
    const cost = (tsOk ? dTs : 1000) + (dM == null ? 500 : Math.min(dM, 1000));
    if (cost < bestCost) {
      best = r;
      bestCost = cost;
    }
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/*  The results file                                                          */
/* -------------------------------------------------------------------------- */

/** A results basename, and nothing that could walk out of the folder. */
const RESULTS_NAME = /^[\w-]+\.xml$/i;

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * The pairing fields out of a results file's header. Reads the first 16 KB
 * only: everything needed sits above `<Race>`, and a 4 h race's file is 3 MB.
 * Null for a file that is missing, unreadable or not a results file.
 */
export function readRaceInfo(file: string): ReplayRaceInfo | null {
  const raceId = path.basename(file);
  const session = /([A-Z]+\d*)\.xml$/i.exec(raceId)?.[1]?.toUpperCase() ?? '';
  let head: string;
  let mtimeMs: number | null = null;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(16 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString('utf8', 0, n);
      mtimeMs = fs.fstatSync(fd).mtimeMs;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  // Above the first session block only: each session repeats a <DateTime>.
  const top = head.split(/<(?:Race|Qualify|Practice\d*|Warmup)>/)[0] ?? '';
  const dt = /<DateTime>(\d+)<\/DateTime>/.exec(top)?.[1];
  const course = /<TrackCourse>([^<]*)<\/TrackCourse>/.exec(top)?.[1];
  if (!dt || !course || !session) return null;
  return { raceId, course: decodeXml(course).trim(), session, startedAt: Number(dt), xmlMtimeMs: mtimeMs };
}

/**
 * Where a race's results file lives. `APEX_LMU_ROOT` (the Game folder picker)
 * first, then the Steam libraries. Null for a name that is not a results file.
 */
export function resultsPathFor(raceId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof raceId !== 'string' || !RESULTS_NAME.test(raceId)) return null;
  const root = typeof env.APEX_LMU_ROOT === 'string' ? env.APEX_LMU_ROOT.trim().replace(/[\\/]+$/, '') : '';
  const dirs: string[] = [];
  if (root) dirs.push(path.join(root, 'UserData', 'Log', 'Results'));
  const logDir = findLmuLogDir(env);
  if (logDir) dirs.push(path.join(logDir, 'Results'));
  for (const dir of dirs) {
    const file = path.join(dir, raceId);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  The controller                                                            */
/* -------------------------------------------------------------------------- */

export interface LmuReplayOptions {
  /** LMU REST port (default 6397). Ignored when `baseUrl` is given. */
  port?: number;
  /** e.g. `http://127.0.0.1:6397`. For tests. */
  baseUrl?: string;
  /** Wall clock, ms. Injectable so the load timeout can be tested. */
  now?: () => number;
  /** Waits between polls. Injectable with `now`. */
  sleep?: (ms: number) => Promise<void>;
  /** raceId → pairing fields. Default: the results file on disk. */
  resolveRace?: (raceId: string) => ReplayRaceInfo | null;
  /** A `.Vcr` file's mtime, or null. Default: `fs.statSync`. */
  vcrMtimeMs?: (entry: ReplayListEntry) => number | null;
  /** How often to check the user is still in our replay; 0 = never (tests). */
  watchMs?: number;
  /** Per-request timeout, ms. */
  httpTimeoutMs?: number;
}

/** A jump target. */
export interface ReplayJump {
  raceId: string;
  /** The car's slot, from the XML's `Name(n)`. Never its name: see types. */
  slot: number;
  /** Session `et` of the incident. */
  et: number;
  /** Seconds of run-up before it. */
  leadS?: number;
}

/** Polling cadence while a replay loads (the verified prototype's). */
const POLL_MS = 500;
/** A replay list older than this is fetched again for `available`. */
const LIST_TTL_MS = 10_000;
/** How long the game gets to leave another replay for the menu. */
const EXIT_TIMEOUT_MS = 30_000;
/** How long the game gets to show it has STARTED loading. */
const START_TIMEOUT_MS = 15_000;
/** How long a replay of ours that is on screen gets to reach DYN. */
const SETTLE_TIMEOUT_MS = 10_000;
/** Focus / seek / play attempts: the calls 400 for a moment around DYN. */
const JUMP_ATTEMPTS = 6;
/**
 * How long the game may go unanswered mid-load before it is taken as closed.
 * A load never makes `/navigation/state` fail (it answered every poll of the
 * 2026-09-30 runs, 3.5 GB included), so a few seconds of silence is the game
 * gone, not the game busy — and without this the button said "Loading…" for
 * the whole three-minute budget.
 */
const GONE_MS = 5_000;

/**
 * Load-time budget for a replay of this size. Measured: 25 s for 642 MB and
 * 38 s for 2.6 GB. Three minutes is the floor, and a 4 GB file gets four.
 */
export function loadTimeoutMs(sizeBytes: number | null): number {
  const gb = sizeBytes && sizeBytes > 0 ? sizeBytes / 1e9 : 0;
  return Math.max(180_000, 60_000 + gb * 45_000);
}

const atMainMenu = (n: NavState): boolean =>
  n.state?.navigationState === 'NAV_MAIN_MENU' && n.state?.gameState === 'GSTATE_SETUP';

const inReplayMode = (n: NavState): boolean => n.state?.settingMode === 'SETTING_REPLAY_PLAYBACK';

/** A replay is loaded and on screen: the one state a jump works in. */
const replayReady = (n: NavState): boolean =>
  inReplayMode(n) && n.state?.gameState === 'GSTATE_DYN' && !n.loadingStatus?.loading;

/** Still inside a replay (loading or playing) rather than back in the menu. */
const replayShowing = (n: NavState): boolean =>
  inReplayMode(n) && n.state?.navigationState !== 'NAV_MAIN_MENU' && n.state?.gameState !== 'GSTATE_SETUP';

const MSG = {
  offline: "Le Mans Ultimate isn't running, so its replays can't be opened.",
  blocked: 'Leave your session to watch the replay.',
  noReplay: "This race's replay has been replaced by the game.",
  noResults: "This race's results file is gone, so its replay can't be found.",
  loading: 'Loading replay… (big replays take ~40 s)',
  closing: 'Closing the other replay…',
  noExit: "The other replay wouldn't close.",
  refused: 'The game refused to load the replay.',
  timeout: 'The replay took too long to load.',
  noStart: "The game didn't start loading the replay.",
  left: 'You left the replay.',
  seek: "The replay loaded but wouldn't jump there.",
  busy: 'Another replay is loading.',
  closed: 'The game closed while the replay was loading.',
};

/** Thrown out of every await once {@link LmuReplayController.dispose} ran. */
class Disposed extends Error {
  constructor() {
    super('replay controller disposed');
  }
}

/** What {@link LmuReplayController.openAt} answers: the status, plus why a click was turned away. */
export interface ReplayOpenAnswer extends ReplayStatus {
  /**
   * Another race's replay is loading, so this click did nothing. The status
   * beside it is THAT race's, which is why the flag is needed at all: the
   * Review tab only draws a status for the race on screen.
   */
  busy?: boolean;
}

/** How a jump attempt ended. */
type JumpOutcome = 'ok' | 'refused' | 'gone';

export class LmuReplayController {
  private readonly base: URL;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly resolveRace: (raceId: string) => ReplayRaceInfo | null;
  private readonly vcrMtime: (entry: ReplayListEntry) => number | null;
  private readonly watchMs: number;
  private readonly httpTimeoutMs: number;

  private st: ReplayStatus = { phase: 'idle', raceId: null, progress: null, message: null };
  /** The race whose replay WE loaded and the game is still showing. */
  private loadedRaceId: string | null = null;
  /** The latest click not yet acted on; a newer click replaces it. */
  private pending: ReplayJump | null = null;
  /** The operation in flight (load or jump), and the race it is for. */
  private op: Promise<void> | null = null;
  private opRaceId: string | null = null;
  private listCache: { at: number; list: ReplayListEntry[] } | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by {@link dispose}: every request refuses and every loop stops. */
  private disposed = false;
  private readonly listeners = new Set<(s: ReplayStatus) => void>();

  constructor(opts: LmuReplayOptions = {}) {
    this.base = new URL(opts.baseUrl ?? `http://127.0.0.1:${opts.port ?? 6397}`);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.resolveRace =
      opts.resolveRace ??
      ((raceId) => {
        const file = resultsPathFor(raceId);
        return file ? readRaceInfo(file) : null;
      });
    this.vcrMtime =
      opts.vcrMtimeMs ??
      ((e) => {
        if (!e.replayDirectory) return null;
        try {
          return fs.statSync(path.join(e.replayDirectory, `${e.replayName}.Vcr`)).mtimeMs;
        } catch {
          return null;
        }
      });
    this.watchMs = opts.watchMs ?? 2000;
    this.httpTimeoutMs = opts.httpTimeoutMs ?? 4000;
  }

  /** The current state, for the button and its status line. */
  status(): ReplayStatus {
    return { ...this.st };
  }

  /** Subscribe to status changes. Returns an unsubscribe function. */
  onStatus(cb: (s: ReplayStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Resolves when the load or jump in flight (if any) has finished. */
  async settled(): Promise<ReplayStatus> {
    while (this.op) await this.op;
    return this.status();
  }

  /**
   * Retire the controller (main builds a new one when the port changes). The
   * load or jump in flight stops at its next await without another request
   * going out, no timer is armed again, and later calls do nothing.
   */
  dispose(): void {
    this.disposed = true;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    this.pending = null;
    this.listeners.clear();
  }

  /**
   * The replay this race paired with, or why there is none. Uses a list at
   * most {@link LIST_TTL_MS} old, so a log of forty contacts asks once.
   */
  async findReplayFor(race: string | ReplayRaceInfo): Promise<FindReplayResult> {
    const info = typeof race === 'string' ? this.resolveRace(race) : race;
    if (!info) return { ok: false, reason: 'no-results', message: MSG.noResults };
    const list = await this.replayList(false);
    if (!list) return { ok: false, reason: 'game-offline', message: MSG.offline };
    const hit = pairReplay(info, list, this.vcrMtime);
    if (!hit) return { ok: false, reason: 'no-replay', message: MSG.noReplay };
    return {
      ok: true,
      replay: {
        replayName: hit.replayName,
        id: hit.id,
        sizeBytes: typeof hit.size === 'number' ? hit.size : null,
        timestamp: hit.timestamp,
      },
    };
  }

  /**
   * Show `slot` at `et − leadS` in this race's replay, loading it first if it
   * is not the one on screen. Resolves as soon as the request is either done
   * (a jump in a loaded replay, a refusal) or under way (a load); the rest
   * arrives through {@link onStatus}.
   *
   * A click while that race is still loading replaces the jump target and
   * does not load again: the replay lands on the LAST incident clicked.
   */
  async openAt(req: ReplayJump): Promise<ReplayOpenAnswer> {
    const jump = sanitiseJump(req);
    if (!jump) return { ...this.status(), message: 'Nothing to jump to.' };
    if (this.disposed) return this.status();

    if (this.op) {
      if (this.opRaceId === jump.raceId) {
        this.pending = jump;
        return this.status();
      }
      return { ...this.status(), message: MSG.busy, busy: true };
    }

    this.pending = jump;
    this.opRaceId = jump.raceId;
    let accept!: () => void;
    const accepted = new Promise<void>((r) => (accept = r));
    this.op = this.run(jump.raceId, accept)
      .catch((err) => {
        if (err instanceof Disposed) return;
        this.set({ phase: 'error', raceId: jump.raceId, progress: null, message: String(err?.message ?? err) });
      })
      .finally(() => {
        this.op = null;
        this.opRaceId = null;
        // A click that landed after the last jump went out: take it now. On
        // any other outcome the click has had its answer, so drop it.
        const late = this.st.phase === 'ready' && this.pending?.raceId === jump.raceId ? this.pending : null;
        this.pending = null;
        accept();
        if (this.disposed) return;
        if (late) void this.openAt(late);
        else this.armWatch();
      });
    await accepted;
    return this.status();
  }

  /**
   * Ask the game whether our replay is still on screen, and drop to idle if
   * the user has left it. The watcher calls this; so can the IPC.
   */
  async refresh(): Promise<ReplayStatus> {
    if (this.disposed || this.op || (this.st.phase !== 'ready' && !this.loadedRaceId)) return this.status();
    let nav: NavState | null;
    try {
      nav = await this.nav();
    } catch {
      return this.status(); // disposed while we asked
    }
    if (this.op) return this.status(); // a click arrived while we asked
    if (!nav || !replayShowing(nav)) {
      this.loadedRaceId = null;
      if (this.st.phase === 'ready') {
        this.set({ phase: 'idle', raceId: null, progress: null, message: nav ? MSG.left : MSG.offline });
      }
    }
    return this.status();
  }

  /* ------------------------------ the sequence ------------------------------ */

  private async run(raceId: string, accept: () => void): Promise<void> {
    const nav = await this.nav();
    if (!nav) {
      this.loadedRaceId = null;
      this.set({ phase: 'error', raceId, progress: null, message: MSG.offline });
      return;
    }

    // Our replay, still on screen: a jump is just focus + seek. Give a
    // replay caught mid-restart a moment to settle rather than reloading it.
    if (this.loadedRaceId === raceId && replayShowing(nav)) {
      if (replayReady(nav) || (await this.waitFor(replayReady, SETTLE_TIMEOUT_MS))) {
        await this.jumpLoop(raceId);
        return;
      }
    }
    if (!replayShowing(nav)) this.loadedRaceId = null;

    if (!atMainMenu(nav) && !inReplayMode(nav)) {
      // A live session. Never pull the driver out of it.
      this.set({ phase: 'blocked', raceId, progress: null, message: MSG.blocked });
      return;
    }

    // Pair BEFORE touching the game: an unavailable replay must not close
    // the one the user is watching.
    const race = this.resolveRace(raceId);
    if (!race) {
      this.set({ phase: 'unavailable', raceId, progress: null, message: MSG.noResults });
      return;
    }
    let list = await this.replayList(true);
    let hit = list ? pairReplay(race, list, this.vcrMtime) : null;
    if (!list || !hit) {
      this.set(
        list
          ? { phase: 'unavailable', raceId, progress: null, message: MSG.noReplay }
          : { phase: 'error', raceId, progress: null, message: MSG.offline },
      );
      return;
    }

    this.set({ phase: 'loading', raceId, progress: null, message: MSG.loading });
    accept();

    // The list fetch took a moment, and the look above is older still: read
    // the game again before changing what it shows.
    const now = await this.nav();
    if (!now) {
      this.set({ phase: 'error', raceId, progress: null, message: MSG.offline });
      return;
    }
    if (!atMainMenu(now)) {
      // Some other replay: ours for another race, or one the user opened.
      // Only a replay: a live session that started meanwhile is left alone.
      if (!inReplayMode(now)) {
        this.set({ phase: 'blocked', raceId, progress: null, message: MSG.blocked });
        return;
      }
      this.loadedRaceId = null;
      this.set({ phase: 'loading', raceId, progress: null, message: MSG.closing });
      await this.send('POST', '/navigation/action/NAV_TO_MAIN_MENU');
      if (!(await this.waitFor(atMainMenu, EXIT_TIMEOUT_MS))) {
        this.set({ phase: 'error', raceId, progress: null, message: MSG.noExit });
        return;
      }
      this.set({ phase: 'loading', raceId, progress: null, message: MSG.loading });
      // `id` is a list position, so pair again on a list fetched just now.
      list = await this.replayList(true);
      hit = list ? pairReplay(race, list, this.vcrMtime) : null;
      if (!list || !hit) {
        this.set({ phase: 'unavailable', raceId, progress: null, message: list ? MSG.noReplay : MSG.offline });
        return;
      }
    }

    // Play replaces whatever is on screen, so it goes out only from the menu,
    // read a moment ago rather than before the list fetch.
    const last = await this.nav();
    if (!last || !atMainMenu(last)) {
      this.set(
        last
          ? { phase: 'blocked', raceId, progress: null, message: MSG.blocked }
          : { phase: 'error', raceId, progress: null, message: MSG.offline },
      );
      return;
    }
    const play = await this.send('GET', `/rest/watch/play/${hit.id}`);
    if (!play || play.status !== 200 || parseJson(play.body) !== 7) {
      this.set({ phase: 'error', raceId, progress: null, message: MSG.refused });
      return;
    }

    const loaded = await this.waitForLoad(raceId, hit.size ?? null);
    if (!loaded) return;

    this.loadedRaceId = raceId;
    this.set({ phase: 'ready', raceId, progress: 1, message: null });
    await this.jumpLoop(raceId);
  }

  /**
   * Poll until the replay is on screen. The loading bar finishing is ~6 s too
   * early (calls still 400), so the test is DYN, not `loading === false`.
   */
  private async waitForLoad(raceId: string, sizeBytes: number | null): Promise<boolean> {
    const started = this.now();
    const deadline = started + loadTimeoutMs(sizeBytes);
    let sawReplay = false;
    /** When the game stopped answering; null while it answers. */
    let silentSince: number | null = null;
    while (this.now() < deadline) {
      const n = await this.nav();
      if (!n) {
        silentSince ??= this.now();
        if (this.now() - silentSince >= GONE_MS) {
          this.loadedRaceId = null;
          this.set({ phase: 'error', raceId, progress: null, message: MSG.closed });
          return false;
        }
      } else {
        silentSince = null;
        if (replayReady(n)) return true;
        if (inReplayMode(n) && !atMainMenu(n)) sawReplay = true;
        else if (sawReplay) {
          // Back at the menu mid-load: the user cancelled, or the load failed.
          this.set({ phase: 'idle', raceId: null, progress: null, message: MSG.left });
          return false;
        } else if (this.now() - started > START_TIMEOUT_MS) {
          this.set({ phase: 'error', raceId, progress: null, message: MSG.noStart });
          return false;
        }
        const pct = n.loadingStatus?.percentage;
        const progress = typeof pct === 'number' && pct >= 0 ? Math.min(1, pct) : this.st.progress;
        this.set({ phase: 'loading', raceId, progress, message: MSG.loading });
      }
      await this.pause(POLL_MS);
    }
    this.set({ phase: 'error', raceId, progress: null, message: MSG.timeout });
    return false;
  }

  /** Jump to the latest target, then any that arrived meanwhile. */
  private async jumpLoop(raceId: string): Promise<void> {
    while (this.pending && this.pending.raceId === raceId) {
      const t = this.pending;
      this.pending = null;
      const outcome = await this.jumpOnce(t);
      if (outcome === 'gone') {
        // Our replay is off the screen: whatever is there now is not ours to
        // focus or seek. Forget the load, as the watcher would.
        this.loadedRaceId = null;
        this.pending = null;
        this.set({ phase: 'idle', raceId: null, progress: null, message: MSG.left });
        return;
      }
      if (outcome === 'refused') {
        this.set({ phase: 'error', raceId, progress: null, message: MSG.seek });
        return;
      }
      this.set({ phase: 'ready', raceId, progress: 1, message: null });
    }
  }

  /**
   * Focus by slot, seek, play: table C, in that order. The first attempt
   * follows a look that found our replay on screen; every retry looks again
   * first, because three seconds of 400s is long enough for the driver to
   * have left it, and a focus sent into a live session moves their camera.
   */
  private async jumpOnce(t: ReplayJump): Promise<JumpOutcome> {
    const at = Math.max(0, t.et - (t.leadS ?? 5));
    const seek = Number(at.toFixed(3));
    for (let i = 0; i < JUMP_ATTEMPTS; i++) {
      if (i > 0) {
        const n = await this.nav();
        if (!n || !replayShowing(n)) return 'gone';
      }
      const f = await this.send('PUT', `/rest/watch/focus/${t.slot}`);
      const s = f && f.status === 200 ? await this.send('PUT', `/rest/watch/replayTime/${seek}`) : null;
      const p = s && s.status === 200 ? await this.send('PUT', '/rest/watch/replayCommand/VCRCOMMAND_PLAY') : null;
      if (p && p.status === 200) return 'ok';
      await this.pause(POLL_MS);
    }
    return 'refused';
  }

  private async waitFor(test: (n: NavState) => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      const n = await this.nav();
      if (n && test(n)) return true;
      await this.pause(POLL_MS);
    }
    return false;
  }

  /** The injected sleep, then a stop if the controller was disposed meanwhile. */
  private async pause(ms: number): Promise<void> {
    await this.sleep(ms);
    if (this.disposed) throw new Disposed();
  }

  /* ------------------------------ plumbing ------------------------------ */

  private set(next: ReplayStatus): void {
    if (this.disposed) return;
    const prev = this.st;
    this.st = next;
    const moved =
      prev.phase !== next.phase ||
      prev.raceId !== next.raceId ||
      prev.message !== next.message ||
      (prev.progress == null) !== (next.progress == null) ||
      Math.abs((prev.progress ?? 0) - (next.progress ?? 0)) >= 0.01;
    if (!moved) return;
    for (const cb of this.listeners) {
      try {
        cb(this.status());
      } catch {
        /* a listener must not break the sequence */
      }
    }
  }

  /** Keep checking the user is still in our replay; stops once they are not. */
  private armWatch(): void {
    if (this.disposed || !this.watchMs || this.watchTimer || this.st.phase !== 'ready') return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.refresh().finally(() => this.armWatch());
    }, this.watchMs);
    this.watchTimer.unref?.();
  }

  private async nav(): Promise<NavState | null> {
    const r = await this.send('GET', '/navigation/state');
    if (!r || r.status !== 200) return null;
    const n = parseJson(r.body);
    return n && typeof n === 'object' ? (n as NavState) : null;
  }

  private async replayList(fresh: boolean): Promise<ReplayListEntry[] | null> {
    if (!fresh && this.listCache && this.now() - this.listCache.at < LIST_TTL_MS) return this.listCache.list;
    const r = await this.send('GET', '/rest/watch/replays');
    const list = r && r.status === 200 ? parseJson(r.body) : null;
    if (!Array.isArray(list)) return null;
    this.listCache = { at: this.now(), list: list as ReplayListEntry[] };
    return this.listCache.list;
  }

  /**
   * One request. PUT and POST carry an explicit `Content-Length: 0`: without
   * it the game answers 400 with an empty body (found live, table C).
   * Null on a network failure. Rejects with {@link Disposed} once the
   * controller is disposed, before sending and on an answer that lands
   * after, so no step of a sequence acts for a controller main let go of.
   */
  private send(method: 'GET' | 'PUT' | 'POST', p: string): Promise<{ status: number; body: string } | null> {
    if (this.disposed) return Promise.reject(new Disposed());
    return new Promise<{ status: number; body: string } | null>((resolve) => {
      const req = http.request(
        {
          host: this.base.hostname,
          port: this.base.port || 80,
          path: p,
          method,
          timeout: this.httpTimeoutMs,
          headers: method === 'GET' ? {} : { 'Content-Length': 0 },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          res.on('error', () => resolve(null));
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    }).then((r) => {
      if (this.disposed) throw new Disposed();
      return r;
    });
  }
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function sanitiseJump(req: ReplayJump | null | undefined): ReplayJump | null {
  if (!req || typeof req.raceId !== 'string' || !RESULTS_NAME.test(req.raceId)) return null;
  const slot = Number(req.slot);
  const et = Number(req.et);
  if (!Number.isInteger(slot) || slot < 0 || !Number.isFinite(et) || et < 0) return null;
  const lead = Number(req.leadS ?? 5);
  return { raceId: req.raceId, slot, et, leadS: Number.isFinite(lead) && lead >= 0 ? lead : 5 };
}

/** Re-exported for the IPC's typings. */
export type { ReplayPhase, ReplayStatus };
