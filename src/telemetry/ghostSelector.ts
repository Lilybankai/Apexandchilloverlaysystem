/**
 * ghostSelector.ts — which lap Ghost HUD is chasing, kept right without ever
 * blocking the frame loop.
 * -----------------------------------------------------------------------------
 * The provider calls {@link GhostSelector.sync} every frame with the combo
 * being driven. Almost always that is a string compare and nothing else. When
 * the answer has to change, the work — refreshing the lap index, reading a
 * trace — runs as a promise beside the loop, and the ghost it produces is
 * adopted on a later frame.
 *
 * The first version did this inline and got three things wrong, each of which
 * is a rule here now:
 *
 *   1. **It read the disk synchronously in the frame loop.** Loads are
 *      asynchronous ({@link loadBestGhost}) and only ever run while the ghost
 *      is WANTED. With nothing showing it, `sync` returns before touching
 *      anything — no index, no stat, no read.
 *   2. **A miss was permanent.** The key was recorded before the load, so a
 *      `null` (no lap yet, a torn file) stuck until the circuit, class or
 *      surface changed. A miss is now retried {@link MAX_RETRIES} times on a
 *      doubling delay, and the count resets on anything that could change the
 *      answer.
 *   3. **A new best was never adopted.** {@link noteLap} is told about every
 *      lap the moment it is written, and a clean one in this combo that could
 *      beat the ghost re-arms the selection.
 *
 * Loads can overlap a change of combo — the surface turns damp while the dry
 * lap is still being read. Each load carries the generation it was started
 * under, and a result from an older generation is dropped, so a slow read can
 * never put the wrong lap back.
 */

import type { GhostLap } from './ghostLap';
import { GhostIndex, loadBestGhost, type GhostDirs, type GhostQuery } from './ghostStore';
import type { LapRecord, TrackCondition } from './lapLog';

/** First retry delay after a load finds nothing; doubles each time. */
export const RETRY_BASE_MS = 2_000;
/**
 * Retries before giving up until something changes. Five doublings cover the
 * first minute — long enough for a file the antivirus had locked, or a lap
 * index still being written. After that a miss means there is genuinely no
 * lap, and the thing that changes it is a new lap, which {@link noteLap}
 * catches directly; polling the disk forever would add nothing.
 */
export const MAX_RETRIES = 5;

/** The combo being driven — what a ghost is chosen for. */
export interface GhostCombo {
  sim: string;
  trackKey: string;
  /** Normalised class (`normalizeClass`), as lap records store it. */
  carClass: string;
  condition: TrackCondition;
}

export interface GhostSelectorOptions {
  /** Where the lap database and traces live; the real folders by default. */
  dirs?: GhostDirs;
  /** Called whenever the selected lap changes, including to `null`. */
  publish?: (lap: GhostLap | null) => void;
  /** Wall clock, for the retry delay. A seam for the tests. */
  now?: () => number;
}

export class GhostSelector {
  private readonly dirs: GhostDirs;
  private readonly publish: (lap: GhostLap | null) => void;
  private readonly now: () => number;
  /** Built on first use, so a session that never wants a ghost never reads a lap. */
  private index: GhostIndex | null = null;

  private wanted = false;
  private combo: GhostCombo | null = null;
  private key = '';
  private current: GhostLap | null = null;

  /** Bumped whenever an in-flight load's answer stops being wanted. */
  private generation = 0;
  /** Generation of the load in flight, or 0 when none is. */
  private loadingGen = 0;
  /** A clean lap was just set in this combo: look again. */
  private rearm = false;
  private retries = 0;
  private retryAt = 0;
  private inflight: Promise<void> = Promise.resolve();

  public constructor(opts: GhostSelectorOptions = {}) {
    this.dirs = opts.dirs ?? {};
    this.publish = opts.publish ?? (() => undefined);
    this.now = opts.now ?? Date.now;
  }

  /** The lap being chased, or `null`. */
  public get lap(): GhostLap | null {
    return this.current;
  }

  /**
   * Whether anything is showing the ghost. Off drops the selection and
   * abandons any load in flight; on lets the next {@link sync} choose again.
   */
  public setWanted(on: boolean): void {
    if (on === this.wanted) return;
    this.wanted = on;
    if (!on) this.reset();
  }

  /**
   * Keep the selection pointed at `combo`. Call every frame; it does no I/O
   * itself and starts a load only when one is due. `null` means nothing can be
   * chased (no class, no track length) and clears the selection.
   */
  public sync(combo: GhostCombo | null, nowMs: number): void {
    if (!this.wanted) return;
    if (!combo) {
      if (this.key) this.reset();
      return;
    }
    const key = `${combo.sim}|${combo.trackKey}|${combo.carClass}|${combo.condition}`;
    if (key !== this.key) {
      // A lap for another circuit, class or surface is the wrong thing to
      // show even for the few milliseconds the new one takes to read.
      this.reset();
      this.key = key;
      this.combo = combo;
      this.start();
      return;
    }
    if (this.loadingGen !== 0) return;
    const retryDue =
      !this.current && this.retries > 0 && this.retries <= MAX_RETRIES && nowMs >= this.retryAt;
    if (this.rearm || retryDue) this.start();
  }

  /**
   * A lap was just written to the lap database. If it is a clean lap in the
   * combo being chased and could be quicker than the ghost, look again.
   *
   * Cheap and synchronous — it only sets a flag; the next {@link sync} does the
   * work, off the loop.
   */
  public noteLap(rec: LapRecord): void {
    const c = this.combo;
    if (!this.wanted || !c || !rec || !rec.id || !rec.clean) return;
    if (rec.sim !== c.sim || rec.trackKey !== c.trackKey || rec.carClass !== c.carClass) return;
    if ((rec.condition || 'dry') !== c.condition) return;
    const beats =
      !this.current || (rec.lapMs > 0 && rec.lapMs < Math.round(this.current.lapSec * 1000));
    if (!beats) return;
    this.rearm = true;
    this.retries = 0;
  }

  /** Resolves once the load in flight (if any) has settled. For the tests. */
  public settled(): Promise<void> {
    return this.inflight;
  }

  private reset(): void {
    this.generation += 1;
    this.loadingGen = 0;
    this.key = '';
    this.combo = null;
    this.rearm = false;
    this.retries = 0;
    this.retryAt = 0;
    if (this.current) {
      this.current = null;
      this.publish(null);
    }
  }

  private start(): void {
    const combo = this.combo;
    if (!combo) return;
    const gen = ++this.generation;
    this.loadingGen = gen;
    this.rearm = false;
    const q: GhostQuery = { ...combo };
    const index = (this.index ??= new GhostIndex(this.dirs.laps));
    this.inflight = loadBestGhost(index, q, this.dirs, this.current)
      .catch(() => null)
      .then((lap) => this.finish(gen, lap));
  }

  private finish(gen: number, lap: GhostLap | null): void {
    // Superseded: the combo changed, or the ghost stopped being wanted, while
    // this was reading. Whatever it found belongs to a question nobody is
    // asking any more.
    if (gen !== this.generation) return;
    this.loadingGen = 0;
    if (lap) {
      this.retries = 0;
      if (lap !== this.current) {
        this.current = lap;
        // The widget fetches the line over HTTP, keyed on the lap id it sees
        // on the frame — so this is published in the same breath as the
        // selection changes, or the two disagree for a poll.
        this.publish(lap);
      }
      return;
    }
    // A miss with a ghost already loaded (a re-check after a new lap whose
    // trace would not read) keeps the ghost; only an empty selection retries.
    if (this.current) return;
    this.retries += 1;
    this.retryAt = this.now() + RETRY_BASE_MS * 2 ** (this.retries - 1);
  }
}
