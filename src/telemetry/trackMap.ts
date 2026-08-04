/**
 * @file src/telemetry/trackMap.ts
 * @module telemetry/trackMap
 *
 * Learns the **shape of the circuit** from the car that is driving it, and keeps
 * it on disk so every later session at that track draws instantly.
 *
 * ## Why the shape is learned rather than shipped
 * The obvious source is the game's own track data, and it is unreachable: LMU
 * packs each location into an encrypted `.mas` archive (magic `m1!`, filenames
 * obfuscated) — nothing readable, and not something to be prising open. The REST
 * API publishes a lap LENGTH and nothing about the road's shape; shared memory
 * publishes positions, not geometry. Every source of a *drawn* circuit is closed.
 *
 * What is open is the position of the car itself, thirty times a second, with a
 * lap distance beside it. Drive one lap and the road has told you where it goes —
 * and the path that comes out is in the SAME world axes as the live car
 * positions, which is the property that matters most: the dots need no fitting,
 * no scaling and no per-track calibration to land on the ribbon, because they are
 * measured in the same frame as it. A shipped map would have to be registered
 * against the sim's coordinates for all 17 tracks, and would cover exactly the
 * 17 tracks it shipped with — no mods, no new season, no rF2.
 *
 * The cost is one lap: the first time at a circuit the widget draws a progress
 * read instead of a map. After that the file in `~/.apex-overlay/tracks` makes it
 * instant, for that track, forever.
 *
 * ## "Forever" is why a wrong map has to repair itself
 * That cache is the reason a bad map is a different class of bug from a bad
 * frame. Publishing a shape SAVES it, and a saved shape is preferred over
 * learning a new one at every session after — so a circuit that comes out wrong
 * once is drawn wrong until somebody works out that there is a file, where it
 * lives, and that deleting it is the fix. Nobody works that out. They report
 * that the map is missing half the track.
 *
 * So there are three checks, and they are in the order of how much they know.
 * {@link TrackMapBuilder.commit} asks whether a shape is a circuit at all
 * (see {@link MAX_STEP_FACTOR}) and refuses to publish one that is a fragment
 * with a chord across it. {@link loadTrackMap} asks the same of every file it
 * reads, so a shape saved before that check existed is dropped rather than
 * drawn. And {@link TrackMapBuilder.audit} asks the only question the other two
 * cannot — whether this well-formed circuit is the one being DRIVEN — by
 * marking the map against the car every frame, and throwing it away, file and
 * all, when the two have disagreed for a couple of hundred metres of road. All
 * three land in the same place: a progress read, and a correct map a lap later.
 *
 * ## What is learned is the LINE, not the centre line
 * The samples are wherever the car actually was, so the stored path is a driven
 * line — up to a track width away from the true centre through a corner. That is
 * deliberate. The sim does publish a lateral offset from its own centre path
 * (`mPathLateral`, see `telemetry/lmuScoring.ts`) and subtracting it would give
 * the true centre, but only if the SIGN convention is right, and a flipped sign
 * would bend every corner the wrong way by two car widths — a plausible-looking
 * map that is wrong. Against that: a whole circuit drawn in a widget runs at
 * roughly 3–5 metres per pixel, where the entire error is well under one pixel.
 * The honest simple thing wins; the ribbon is drawn wide enough (see
 * {@link TrackMapPath.halfWidthM}) that a car on the opposite line still sits on
 * the road.
 *
 * ## Everything here is pure except the last two functions
 * The learning is a fold over samples with no IO, so a whole stint can be
 * scripted headlessly (`scripts/test-trackmap.js`) — the same split
 * `telemetry/lapLog.ts` draws between detection and storage.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Vec3 } from './motion';

/* -------------------------------------------------------------------------- */
/*  Shape                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A learned circuit: one point per bin of lap distance, index `0` on the
 * start/finish line, running in the direction of travel.
 *
 * Points are `[x, z, y]` in the sim's world axes and metres — X/Z on the ground
 * plane, Y up — rounded to 10 cm, which is a tenth of the width of the thinnest
 * line the widget can draw and halves the file.
 */
export interface TrackMapPath {
  /** Slug identifying track + layout + length; see {@link trackKey}. */
  key: string;
  /** The sim's name for the track, for display. */
  name: string;
  /** Layout/scene name when the sim distinguishes one. */
  config?: string;
  /** Lap length in metres, as the sim publishes it. */
  lengthM: number;
  /**
   * Half the road's width in metres — how far the ribbon is drawn either side of
   * the path. Measured from the sim's own `mTrackEdge` where that is published
   * (the median over the learning lap, so a lap through a run-off cannot widen
   * the circuit), and {@link DEFAULT_HALF_WIDTH_M} where it is not.
   */
  halfWidthM: number;
  /** Spacing between consecutive points along the lap, metres. */
  binM: number;
  /** `[x, z, y]` triples, one per bin. */
  points: number[][];
  /** When this shape was learned (ISO 8601). */
  builtAt: string;
  /**
   * Bumped every time a shape is published, so a widget can tell "the same map
   * as last frame" from "a new track, refetch" with one integer compare.
   */
  revision: number;
}

/** One frame of evidence about where the road goes. */
export interface TrackMapSample {
  /** The sim's track name (venue). */
  trackName: string;
  /** Layout/scene name when known — part of the identity, since venues repeat. */
  trackConfig?: string;
  /** Lap length in metres. Samples are ignored until this is plausible. */
  lengthM: number;
  /** How far round the lap the driven car is, metres. */
  lapDistM: number;
  /** The driven car's world position, or `null` when the sim isn't publishing it. */
  pos: Vec3 | null;
  /** `true` when the car is in the pit lane or its garage stall. */
  inPit: boolean;
  /**
   * How far the track surface extends beside the car (`|mTrackEdge|`), metres,
   * when the sim publishes it. Feeds {@link TrackMapPath.halfWidthM}.
   */
  edgeM?: number | null;
}

/** What the provider puts on the wire each frame; see `TrackMapState` in types.ts. */
export interface TrackMapStatus {
  key: string;
  revision: number;
  ready: boolean;
  progress: number;
  /** `true` while relearning a circuit whose map was condemned this session. */
  relearning: boolean;
  /** The shape itself, when one is loaded — for callers that serve it. */
  path: TrackMapPath | null;
}

/* -------------------------------------------------------------------------- */
/*  Tuning                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Target spacing between stored points, metres. Six is under the length of a
 * Hypercar: fine enough that a hairpin is a curve rather than a corner, coarse
 * enough that Le Mans (13.6 km) stays inside {@link MAX_BINS}.
 */
const TARGET_BIN_M = 6;
/** Fewest points a circuit is stored with — a kart track is still a shape. */
const MIN_BINS = 200;
/**
 * Most points a circuit is stored with. Le Mans lands here (13.6 km / 2000 =
 * 6.8 m per point) and the file stays around 40 KB, which is fetched once.
 */
const MAX_BINS = 2000;

/** Lap lengths outside this range are a torn read, not a circuit. */
const MIN_LENGTH_M = 500;
const MAX_LENGTH_M = 30000;

/**
 * Half-width used when the sim publishes no track edge (plain rF2 without the
 * scoring read, or a torn one). Six metres is a conservative modern circuit —
 * wide enough that cars racing side by side both sit on the ribbon, narrow
 * enough that the road still reads as a road.
 */
export const DEFAULT_HALF_WIDTH_M = 6;
/** Edge readings outside this are run-off or garbage, not the road. */
const MIN_EDGE_M = 2.5;
const MAX_EDGE_M = 18;

/**
 * How far apart two consecutive samples may be, in metres of world distance,
 * and still have the road between them filled in by a straight line.
 *
 * The frame rate is the operator's to choose (1..120 Hz), so at a slow poll rate
 * on a fast straight the samples genuinely arrive tens of metres apart, and
 * refusing to interpolate would mean the map never completes. 40 m is about half
 * a second at racing speed: a straight-line fill across that is invisible, and a
 * gap wider than it (a teleport to the garage, a rewind, a session change) must
 * NOT be joined — that is exactly the artefact this bound exists to stop.
 */
const MAX_FILL_M = 40;

/**
 * Fraction of the lap that must be filled before a shape is published. Not 1.0:
 * a single stubborn bin — the car parked exactly on it, a dropped frame at the
 * line — would otherwise hold the whole map back for a session. The holes that
 * remain are interpolated at commit, and {@link MAX_HOLE_BINS} bounds how big
 * one is allowed to be.
 *
 * It was 0.97, which published a map the moment the car was ~3% short of the
 * line and drew that last 90 m as a straight chord — 2.4 m off the road at the
 * most-looked-at point on the map, and saved to disk that way. A lap that fills
 * every bin between its samples reaches 1.0 anyway; the slack here is for
 * dropouts, not for a tail the car has not driven yet.
 */
const READY_COVERAGE = 0.995;
/**
 * The longest run of consecutive missing bins that may be bridged by a straight
 * line. Four bins is ~24 m: the sagitta of a 24 m chord is under a metre on
 * anything faster than a hairpin, which is invisible at map scale. Wider than
 * this and the bridge starts cutting the corner it is meant to describe, so the
 * shape is withheld and the next lap gets another go at it.
 */
const MAX_HOLE_BINS = 4;

/**
 * How far a point may sit from where its neighbours say it should be, as a
 * multiple of the bin spacing, before it is discarded as an outlier.
 *
 * Consecutive bins are one bin-length apart along the road BY CONSTRUCTION, so a
 * point three times that from its neighbour is not a corner — it is a car that
 * was teleported to the garage, or a rewind, dropped into a bin it never drove
 * through. Discarding it and interpolating is strictly better than drawing it.
 */
const OUTLIER_FACTOR = 3;

/**
 * The longest step between two neighbouring points a finished circuit may
 * contain, as a multiple of the bin spacing.
 *
 * Same construction as {@link OUTLIER_FACTOR} and a different job: that one
 * throws away a single bad point among good ones, this one asks whether the
 * finished loop is a loop at all. The failure it exists for is a shape that is
 * a FRAGMENT of the circuit with a straight chord closing it — which draws as a
 * map with a section missing and a line ruled across it, and puts every car in
 * the missing part off the edge of the widget. See {@link TrackMapBuilder.commit}.
 *
 * Three bin-lengths is loose enough for the driven line to be longer through a
 * corner than the centre path the lap distance is measured along, and far under
 * the shortest chord that can skip any real part of a circuit.
 */
const MAX_STEP_FACTOR = 3;

/** Beyond this share of outliers the lap is not a lap; relearn instead. */
const MAX_OUTLIER_SHARE = 0.08;

/**
 * How far the driven car may be from the place the published map puts its lap
 * distance, before that stretch of road counts as one the map has wrong.
 *
 * The two disagree a little all the time and none of it is a fault: the stored
 * path is a driven line rather than the centre (see the module note), a bin is
 * {@link TARGET_BIN_M} of road, and a car in the gravel is genuinely off the
 * road it is being compared to. 75 m is well clear of all three together, and
 * far under the hundreds of metres that a map with a section missing is out by.
 */
const MISMATCH_M = 75;
/**
 * How much lap distance the disagreement has to cover, continuously, before the
 * map is thrown away and learned again.
 *
 * Measured in road rather than in frames or seconds, because the poll rate is
 * the operator's to choose (1..120 Hz) and a frame count means something
 * different at each end of that. It also disposes of the stationary cases for
 * free: a car parked in a barrier or sat in its garage covers no lap distance,
 * so it can disagree with the map for as long as it likes without condemning it.
 * 200 m is a corner and its exit — long enough that no single incident spans it,
 * short enough to be caught within the sector it happens in.
 */
const MISMATCH_RUN_M = 200;
/**
 * A jump in lap distance larger than this breaks the run rather than extending
 * it, so a lap crossing the line (or a teleport) cannot bank a whole lap of
 * disagreement in one step.
 */
const MISMATCH_MAX_STEP_M = 100;

/** Cap on stored edge readings — a median needs a sample, not a session. */
const MAX_EDGE_SAMPLES = 4000;

/* -------------------------------------------------------------------------- */
/*  Identity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A stable slug for "this track, this layout, this length".
 *
 * The length is part of the identity on purpose. LMU's REST feed names the
 * VENUE ("Autodromo Nazionale Monza") and never says which layout is loaded —
 * the same trap `telemetry/referencePace.ts` documents — so the name alone would
 * have the Le Mans 24h circuit redraw itself over the Bugatti layout's file.
 * Rounded to 10 m so a re-measured lap length doesn't orphan the file.
 */
export function trackKey(name: string, config: string | undefined, lengthM: number): string {
  const slug = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const base = slug(name) || 'unknown';
  const layout = config && slug(config) !== base ? `-${slug(config)}` : '';
  const len = Math.round(lengthM / 10) * 10;
  return `${base}${layout}-${len}`;
}

/* -------------------------------------------------------------------------- */
/*  Learning                                                                   */
/* -------------------------------------------------------------------------- */

function finite(v: number): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A world position that could not plausibly be a car on a circuit. */
function posBad(p: Vec3): boolean {
  if (!finite(p.x) || !finite(p.y) || !finite(p.z)) return true;
  if (Math.abs(p.x) > 1e5 || Math.abs(p.z) > 1e5) return true;
  // Every provider treats the exact origin as an unspawned record.
  return p.x === 0 && p.y === 0 && p.z === 0;
}

/**
 * Accumulates a circuit from the driven car's positions.
 *
 * One instance per provider, living as long as the provider does: it holds the
 * bins for the track currently loaded, the cached shape once one exists, and
 * nothing else. Feed it {@link update} once per poll and it answers with what
 * the frame should say.
 */
export class TrackMapBuilder {
  /** Current track identity; `""` before a track is known. */
  private key = '';
  private name = '';
  private config: string | undefined;
  private lengthM = 0;
  private binM = TARGET_BIN_M;
  /** One slot per bin, `null` until a car has been seen in it. */
  private bins: Array<Vec3 | null> = [];
  private filled = 0;
  private edges: number[] = [];
  /** The shape being published, or `null` while still learning. */
  private pathState: TrackMapPath | null = null;
  /** Last accepted sample, for the straight-line fill between frames. */
  private prev: { bin: number; pos: Vec3 } | null = null;
  /** Bumped on every publish — the widget's refetch trigger. */
  private revision = 0;
  /** Set once a key has been looked for on disk, so a miss is not retried. */
  private diskChecked = false;
  /** Filled-bin count at the last commit attempt; see {@link update}. */
  private triedAt = -1;
  /**
   * How much lap distance the car has covered continuously while disagreeing
   * with the published map, and where it last did so. See {@link audit}.
   */
  private mismatchM = 0;
  private mismatchAt: number | null = null;
  /**
   * Set when a map for THIS track has been condemned, so the progress read can
   * say it is rebuilding rather than learning. Cleared by {@link reset}, because
   * a different circuit's map was never the one in question.
   */
  private condemned = false;

  /** Where learned shapes are cached. Injectable so tests never touch `$HOME`. */
  public constructor(private readonly dir: string = trackMapDir()) {}

  /**
   * Folds one frame in and reports the state of the map. Never throws: a
   * provider calls this inside its poll, and a circuit that cannot be learned is
   * a widget that shows a progress bar, not a telemetry loop that dies.
   */
  public update(s: TrackMapSample): TrackMapStatus {
    if (!finite(s.lengthM) || s.lengthM < MIN_LENGTH_M || s.lengthM > MAX_LENGTH_M) {
      return this.status();
    }
    const key = trackKey(s.trackName, s.trackConfig, s.lengthM);
    if (key !== this.key) this.reset(key, s);
    if (!this.pathState && !this.diskChecked) {
      this.diskChecked = true;
      const cached = loadTrackMap(this.key, this.dir);
      if (cached && cached.points.length >= MIN_BINS) this.publish(cached);
    }
    if (this.pathState) {
      // Shape known — stop sampling, but keep MARKING it against the car that is
      // driving it (see {@link audit}), and make sure it is still the shape being
      // SERVED: when the live provider drops to the simulator and back (LMU
      // closed for a moment, a session change), the demo publishes its own
      // circuit over ours, and nothing would ever put the real one back. The
      // frame would then name this track while `/trackmap.json` handed out the
      // demo oval, which reads as a widget drawing the wrong circuit.
      if (this.audit(s)) return this.status(); // condemned; back to learning
      if (getPublishedTrackMap() !== this.pathState) setPublishedTrackMap(this.pathState);
      return this.status();
    }

    this.sample(s);
    // Retried only when new road has been seen since the last refusal: a commit
    // is an O(bins) pass, and a map held back by one long hole would otherwise
    // run it thirty times a second for the rest of the session.
    if (this.filled !== this.triedAt && this.filled / this.bins.length >= READY_COVERAGE) {
      this.triedAt = this.filled;
      this.commit();
    }
    return this.status();
  }

  /** The shape currently published, if any. */
  public get path(): TrackMapPath | null {
    return this.pathState;
  }

  /** Start over on a new circuit. */
  private reset(key: string, s: TrackMapSample): void {
    this.key = key;
    this.name = s.trackName;
    this.config = s.trackConfig;
    this.lengthM = s.lengthM;
    const bins = clampInt(Math.round(s.lengthM / TARGET_BIN_M), MIN_BINS, MAX_BINS);
    this.binM = s.lengthM / bins;
    this.bins = new Array(bins).fill(null);
    this.filled = 0;
    this.edges = [];
    this.pathState = null;
    this.prev = null;
    this.diskChecked = false;
    this.triedAt = -1;
    this.mismatchM = 0;
    this.mismatchAt = null;
    this.condemned = false;
  }

  /**
   * Marks the published map against the car driving the circuit, and throws the
   * map away when it is provably describing somewhere else. Returns `true` when
   * it did, meaning the caller is back to learning.
   *
   * ## Why a published map is checked at all
   * The guards in {@link commit} decide whether a shape is a plausible CIRCUIT.
   * They cannot decide whether it is THIS circuit — a fragment closed by a chord
   * is a perfectly well-formed loop, so is the shape of a layout the venue no
   * longer runs, and so is one saved by a build whose bug nobody has found yet.
   * A map is also written to disk the moment it is published and preferred over
   * learning a new one ever after, so anything wrong that gets past commit is
   * wrong at that track forever. That is too long a sentence for a cache.
   *
   * The car itself settles it. It is driving the actual road, and it says which
   * lap distance it is at, so the map's answer for that lap distance can be
   * compared to where the car really is — an O(1) lookup per frame, no search.
   * Where the map is right the two agree within a road's width; where a section
   * is missing they are hundreds of metres apart, for the whole of that section.
   *
   * The condemning threshold is deliberately a length of road rather than a
   * count of frames or seconds ({@link MISMATCH_RUN_M}), so the one thing this
   * must never do — throw away a good map because a car had an accident on it —
   * is ruled out by the measure itself rather than by tuning.
   */
  private audit(s: TrackMapSample): boolean {
    const p = this.pathState;
    const n = p ? p.points.length : 0;
    if (!p || n < MIN_BINS || !(p.lengthM > 0)) return false;
    // Nothing to compare: no physics (spectating), or a car in the pit lane,
    // which is a road the map has never claimed to describe.
    if (s.inPit || !s.pos || posBad(s.pos)) {
      this.mismatchAt = null;
      return false;
    }
    if (!finite(s.lapDistM) || s.lapDistM < 0 || s.lapDistM > p.lengthM) {
      this.mismatchAt = null;
      return false;
    }

    // The map's own bin count, not this session's: a re-measured lap length can
    // put the two a bin apart, and the point being read is the map's.
    const idx = clampInt(Math.floor((s.lapDistM / p.lengthM) * n), 0, n - 1);
    const at = p.points[idx] as number[];
    const off = Math.hypot(s.pos.x - (at[0] as number), s.pos.z - (at[1] as number));
    if (off <= MISMATCH_M) {
      this.mismatchM = 0;
      this.mismatchAt = s.lapDistM;
      return false;
    }

    // Disagreeing. Add the road covered since the last disagreeing sample —
    // forward round the lap, and only when it is a step a car could have taken.
    if (this.mismatchAt !== null) {
      const step = (((s.lapDistM - this.mismatchAt) % p.lengthM) + p.lengthM) % p.lengthM;
      // A step of ZERO adds nothing and breaks nothing, which is the whole point
      // of measuring in road: the position feed and the lap-distance feed run at
      // different rates (shared memory every frame, REST about every 150 ms), so
      // at any decent poll rate most frames repeat the distance the last one
      // reported. Treating that as a break in the run — it was — means the run
      // never reaches anything and the check quietly never fires.
      if (step <= MISMATCH_MAX_STEP_M) this.mismatchM += step;
      else this.mismatchM = 0;
    } else {
      this.mismatchM = 0;
    }
    this.mismatchAt = s.lapDistM;
    if (this.mismatchM < MISMATCH_RUN_M) return false;

    this.discard();
    return true;
  }

  /**
   * Throw away a map that has been shown to be wrong — from memory, from the
   * served slot, and from disk — and start learning the circuit again.
   *
   * The file goes too, and that is the point of the whole exercise: leaving it
   * there means the next session loads it before a lap has been driven and draws
   * the same wrong circuit, and the driver is back to being told to delete a
   * file they have no reason to know exists.
   */
  private discard(): void {
    deleteTrackMap(this.key, this.dir);
    this.condemned = true;
    this.pathState = null;
    setPublishedTrackMap(null);
    this.bins = new Array(this.bins.length).fill(null);
    this.filled = 0;
    this.edges = [];
    this.prev = null;
    this.triedAt = -1;
    this.mismatchM = 0;
    this.mismatchAt = null;
    // The file is gone; there is nothing on disk left to look for.
    this.diskChecked = true;
  }

  /** Drop one frame's position into its bin, filling the road behind it. */
  private sample(s: TrackMapSample): void {
    if (finite(s.edgeM ?? NaN)) {
      const e = Math.abs(s.edgeM as number);
      if (e >= MIN_EDGE_M && e <= MAX_EDGE_M && this.edges.length < MAX_EDGE_SAMPLES) {
        this.edges.push(e);
      }
    }
    // The pit lane runs alongside the track at the same lap distances, so a
    // sample taken in it would drag that stretch of the map sideways into the
    // pits. Nothing about a lap in the pit lane describes the road.
    if (s.inPit || !s.pos || posBad(s.pos)) {
      this.prev = null; // and the road back to it is not a road either
      return;
    }
    if (!finite(s.lapDistM) || s.lapDistM < 0 || s.lapDistM > this.lengthM) {
      this.prev = null;
      return;
    }
    const n = this.bins.length;
    const bin = clampInt(Math.floor(s.lapDistM / this.binM), 0, n - 1);
    const pos = { x: s.pos.x, y: s.pos.y, z: s.pos.z };

    const prev = this.prev;
    this.put(bin, pos);
    if (prev) {
      // Bins between the last sample and this one, going FORWARD round the lap
      // (the direction of travel), wrapping across the start/finish line.
      const steps = (bin - prev.bin + n) % n;
      const span = Math.hypot(pos.x - prev.pos.x, pos.z - prev.pos.z);
      // The same bound stated twice, in the two units the two sources speak, and
      // BOTH are needed: `span` is how far the car moved in the world, `steps`
      // is how far the SIM says it moved round the lap. Filling the road between
      // them is only honest when the two agree about how much road that is.
      //
      // The bin bound is the one that matters. `steps` is taken forward round
      // the lap, so a lap distance that ticks BACKWARDS — a spin, a car rolling
      // back out of the gravel, a scoring read that arrives out of order — comes
      // out as very nearly a whole lap of steps while the car has moved a metre
      // and `span` is tiny. The metre bound waves that through, and every bin
      // still empty anywhere on the circuit is filled with the one spot the car
      // was standing on. Coverage hits 1.0 on the spot, and what gets published
      // AND SAVED is the fragment driven so far with a straight chord closing
      // it — the map with half of Daytona missing, and the field driving off the
      // edge of the widget through the part that was never learned.
      const maxSteps = Math.max(1, Math.ceil(MAX_FILL_M / this.binM));
      if (steps > 1 && steps <= maxSteps && span <= MAX_FILL_M) {
        for (let k = 1; k < steps; k++) {
          const t = k / steps;
          this.put((prev.bin + k) % n, {
            x: prev.pos.x + (pos.x - prev.pos.x) * t,
            y: prev.pos.y + (pos.y - prev.pos.y) * t,
            z: prev.pos.z + (pos.z - prev.pos.z) * t,
          });
        }
      }
    }
    this.prev = { bin, pos };
  }

  /** First reading for a bin wins; later laps do not shuffle the shape about. */
  private put(bin: number, pos: Vec3): void {
    if (this.bins[bin]) return;
    this.bins[bin] = pos;
    this.filled++;
  }

  /**
   * Turns the bins into a shape and publishes it — discarding outliers, bridging
   * the holes that are small enough to bridge, and smoothing the result.
   *
   * Refuses (and keeps learning) when the evidence does not describe one
   * continuous circuit, which is the case that matters: a half-learned map with a
   * corner cut across it looks like a bug in the widget, and it would be saved to
   * disk and shown forever.
   */
  private commit(): void {
    const n = this.bins.length;
    const pts = this.bins.slice();

    // 1. Outliers — a point nowhere near where its filled neighbours put it.
    let outliers = 0;
    const limit = this.binM * OUTLIER_FACTOR;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (!p) continue;
      const prev = nearestFilled(pts, i, -1);
      const next = nearestFilled(pts, i, +1);
      const bad = (o: { idx: number; pos: Vec3 } | null): boolean => {
        if (!o) return false;
        const gap = Math.min((i - o.idx + n) % n, (o.idx - i + n) % n);
        return Math.hypot(p.x - o.pos.x, p.z - o.pos.z) > limit * gap;
      };
      // Both neighbours have to disown it: one alone is how a genuine corner
      // looks from the outside of it.
      if (prev && next && bad(prev) && bad(next)) {
        pts[i] = null;
        outliers++;
      }
    }
    if (outliers / n > MAX_OUTLIER_SHARE) {
      this.relearn();
      return;
    }

    // 2. Holes — bridge the short ones, refuse on a long one.
    for (let i = 0; i < n; i++) {
      if (pts[i]) continue;
      const start = nearestFilled(pts, i, -1);
      const end = nearestFilled(pts, i, +1);
      if (!start || !end) return; // nothing to bridge between — keep learning
      const run = (end.idx - start.idx + n) % n;
      if (run - 1 > MAX_HOLE_BINS) return; // too much circuit to invent
      for (let k = 1; k < run; k++) {
        const t = k / run;
        pts[(start.idx + k) % n] = {
          x: start.pos.x + (end.pos.x - start.pos.x) * t,
          y: start.pos.y + (end.pos.y - start.pos.y) * t,
          z: start.pos.z + (end.pos.z - start.pos.z) * t,
        };
      }
      i = start.idx + run - 1; // the run is filled; carry on past it
    }
    const full = pts as Vec3[];
    if (full.some((p) => !p)) return;

    // 3. One continuous circuit, or nothing.
    //
    // Every bin being filled says the map is COMPLETE; it does not say it is a
    // circuit. A run of bins can be full of positions that describe somewhere
    // else entirely — the fill in `sample()` has one bound per source and a
    // frame can still lie in a way neither catches — and the result is a shape
    // that closes with a straight line hundreds of metres long. Nothing above
    // sees it: the outlier pass needs BOTH neighbours to disown a point, and
    // inside a run of bad bins each one agrees with the next.
    //
    // That shape is worth failing loudly over rather than shading in. It is not
    // a rough map, it is a DIFFERENT circuit: the part it skipped isn't in the
    // fit, so every car that drives through it leaves the widget entirely — and
    // being published means being saved, so the track is drawn that way for
    // good. Throwing the lap away costs one more lap of a progress read.
    const jump = this.binM * MAX_STEP_FACTOR;
    if (largestGap(n, (i) => full[i] as Vec3) > jump) {
      this.relearn();
      return;
    }

    // 4. Smooth. The samples carry a few centimetres of physics jitter, which at
    // map scale is invisible on a straight and shows as a fuzzy edge on the
    // ribbon's wall, where the eye follows a silhouette.
    const smooth = smoothClosed(full, 2);
    const halfWidthM = this.edges.length >= 50 ? median(this.edges) : DEFAULT_HALF_WIDTH_M;

    this.publish({
      key: this.key,
      name: this.name,
      ...(this.config ? { config: this.config } : {}),
      lengthM: Math.round(this.lengthM * 10) / 10,
      halfWidthM: Math.round(halfWidthM * 10) / 10,
      binM: Math.round(this.binM * 100) / 100,
      points: smooth.map((p) => [round1(p.x), round1(p.z), round1(p.y)]),
      builtAt: new Date().toISOString(),
      revision: 0, // set by publish()
    });
    saveTrackMap(this.pathState as TrackMapPath, this.dir);
  }

  /** Throw the evidence away and start the lap again (see {@link commit}). */
  private relearn(): void {
    this.bins = new Array(this.bins.length).fill(null);
    this.filled = 0;
    this.prev = null;
    this.triedAt = -1;
  }

  private publish(p: TrackMapPath): void {
    this.revision++;
    this.pathState = { ...p, revision: this.revision };
    setPublishedTrackMap(this.pathState);
  }

  private status(): TrackMapStatus {
    return {
      key: this.key,
      revision: this.revision,
      ready: this.pathState !== null,
      progress: this.bins.length ? Math.min(1, this.filled / this.bins.length) : 0,
      relearning: this.condemned && this.pathState === null,
      path: this.pathState,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Geometry helpers (pure)                                                    */
/* -------------------------------------------------------------------------- */

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** The nearest filled bin from `i` in `dir`, wrapping; `null` if there is none. */
function nearestFilled(
  pts: Array<Vec3 | null>,
  i: number,
  dir: 1 | -1,
): { idx: number; pos: Vec3 } | null {
  const n = pts.length;
  for (let k = 1; k < n; k++) {
    const idx = (((i + dir * k) % n) + n) % n;
    const p = pts[idx];
    if (p) return { idx, pos: p };
  }
  return null;
}

/**
 * The longest straight-line jump between two points that are NEIGHBOURS round
 * the lap — including the pair either side of the start/finish line, which is
 * the one a broken shape usually hides in.
 *
 * Takes an accessor rather than an array so the same measure serves the builder
 * (`Vec3` bins) and the loader (`[x, z, y]` triples off disk): they are the two
 * places a shape can enter the widget, and they must agree on what disqualifies
 * one.
 */
function largestGap(n: number, at: (i: number) => { x: number; z: number }): number {
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const a = at(i);
    const b = at((i + 1) % n);
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    if (d > worst) worst = d;
  }
  return worst;
}

/** Median of a numeric sample (mutates nothing). */
function median(values: number[]): number {
  const v = values.slice().sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? (v[mid] as number) : (((v[mid - 1] as number) + (v[mid] as number)) / 2);
}

/**
 * Moving average over a CLOSED path — the window wraps across the start/finish
 * line, so the one join in the loop is smoothed like every other point rather
 * than left as a kink on the most-looked-at part of the map.
 */
export function smoothClosed(points: Vec3[], radius: number): Vec3[] {
  const n = points.length;
  if (n === 0 || radius < 1) return points.slice();
  const out: Vec3[] = new Array(n);
  const width = radius * 2 + 1;
  for (let i = 0; i < n; i++) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = -radius; k <= radius; k++) {
      const p = points[(i + k + n) % n] as Vec3;
      x += p.x;
      y += p.y;
      z += p.z;
    }
    out[i] = { x: x / width, y: y / width, z: z / width };
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  The published shape                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The shape the HTTP layer serves at `/trackmap.json`.
 *
 * Module-level and mutable for the same reason the server's appearance state is:
 * the provider learns the circuit inside its poll loop, and the HTTP route has no
 * reference to the provider. One track is loaded at a time, so one slot is the
 * whole of the state.
 */
let published: TrackMapPath | null = null;

/** Publish a shape for `/trackmap.json`. Called by {@link TrackMapBuilder}. */
export function setPublishedTrackMap(p: TrackMapPath | null): void {
  published = p;
}

/** The shape currently being served, or `null` when none is learned yet. */
export function getPublishedTrackMap(): TrackMapPath | null {
  return published;
}

/* -------------------------------------------------------------------------- */
/*  Storage                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Directory holding the learned circuits, one JSON file per track.
 *
 * Beside the lap database (`~/.apex-overlay/laps`) rather than in Electron's
 * `userData`, for the same reason: the server writes these and the server runs
 * with or without Electron.
 */
export function trackMapDir(): string {
  return path.join(os.homedir(), '.apex-overlay', 'tracks');
}

/** Read a learned circuit, or `null` when there isn't one (or it is unreadable). */
export function loadTrackMap(key: string, dir = trackMapDir()): TrackMapPath | null {
  try {
    const raw = fs.readFileSync(path.join(dir, `${safeName(key)}.json`), 'utf8');
    const p = JSON.parse(raw) as TrackMapPath;
    if (!p || !Array.isArray(p.points) || p.points.length < MIN_BINS) return null;
    if (!finite(p.lengthM) || !finite(p.halfWidthM)) return null;
    // A file written by a future build, or hand-edited, must not reach the
    // widget as a half-valid shape.
    if (!p.points.every((t) => Array.isArray(t) && t.length >= 2 && t.every(finite))) return null;
    // …and neither must one written by a PAST build. Before the check in
    // `commit()` existed, the learner could publish a fragment of a circuit
    // closed by a straight chord, and publishing means saving: everyone who hit
    // it has that map on disk, and it is loaded here in preference to learning a
    // new one, so without this it would be drawn at that track forever. Failing
    // it back to `null` is what makes the fix reach them — the next lap they
    // drive replaces it.
    const binM = finite(p.binM) && p.binM > 0 ? p.binM : p.lengthM / p.points.length;
    const gap = largestGap(p.points.length, (i) => {
      const t = p.points[i] as number[];
      return { x: t[0] as number, z: t[1] as number };
    });
    if (gap > binM * MAX_STEP_FACTOR) return null;
    return p;
  } catch {
    return null;
  }
}

/** Write a learned circuit. Best-effort: never throws at the caller. */
export function saveTrackMap(p: TrackMapPath, dir = trackMapDir()): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${safeName(p.key)}.json`), JSON.stringify(p), 'utf8');
  } catch {
    /* a map that cannot be cached is relearned next session, not a failure */
  }
}

/**
 * Forget a learned circuit. Best-effort, and a missing file is a success: the
 * caller's intent is "there must not be one of these", not "delete this".
 */
export function deleteTrackMap(key: string, dir = trackMapDir()): void {
  try {
    fs.rmSync(path.join(dir, `${safeName(key)}.json`), { force: true });
  } catch {
    /* a cache that cannot be cleared is one more session of a progress read */
  }
}

/** Keys are already slugs; this is the belt-and-braces against a path escape. */
function safeName(key: string): string {
  return key.replace(/[^a-z0-9._-]/gi, '_').slice(0, 120) || 'unknown';
}
