/**
 * @file src/telemetry/iracing/positionIntegrator.ts
 * @module telemetry/iracing/positionIntegrator
 *
 * Gives the track-map learner a **world position for the player's car** on a sim
 * that publishes none.
 *
 * ## Why this exists
 * {@link TrackMapBuilder} learns a circuit by binning the driven car's world
 * position against its lap distance (see `telemetry/trackMap.ts`). LMU hands it
 * that position straight out of shared memory. iRacing's live telemetry has no
 * X/Y/Z for any car, the player included — `Lat`/`Lon`/`Alt` exist only in the
 * `.ibt` disk files. What it does publish at 60 Hz is the car's own velocity in
 * its BODY frame (`VelocityX` forward, `VelocityY` left, m/s) and its heading
 * (`Yaw`). Rotate one by the other and integrate, and the car's path falls out.
 *
 * ## Why the raw integral is never handed to the builder
 * Dead reckoning drifts: a lap of it ends a few metres from where it started.
 * The builder keeps the FIRST reading per bin and then asks whether the finished
 * loop is a loop at all (its `MAX_STEP_FACTOR` check, ~18 m between neighbours).
 * Fed live, a drifted lap would lock the drift in and then put the whole closure
 * error into the one step across the start/finish line — refused, or worse,
 * accepted with a kink at the most-looked-at point on the map.
 *
 * So the integrator records ONE whole lap, line to line, closes it here —
 * subtracting the closure error linearly over the lap, `p(f) −= err · f` — and
 * resamples the closed loop into a reference table uniform in lap fraction. From
 * then on {@link IracingPositionIntegrator.step} answers with the point on that
 * closed reference at the car's current `LapDistPct`, so every position the
 * builder ever sees lies on one closed outline. {@link outline} hands the whole
 * table over at once, so the provider can fill the builder the moment the lap
 * closes instead of waiting another lap.
 *
 * ## Axes — the part that must not be got wrong
 * The builder wants LMU's world axes: X/Z the ground plane, Y up. LMU's world is
 * left-handed (see `telemetry/radar.ts`: right = up × forward), which works out
 * as: seen from above with +X to the right and +Z UP the page, a right-hand turn
 * goes CLOCKWISE. The track-map widget draws exactly that view (`viewV` negates
 * Z because canvas Y runs down) — the repo's "mirrored map" bug was a painter
 * that forgot the negation, not a wrong world.
 *
 * iRacing's `Yaw` is a maths angle, counter-clockwise positive (a left turn
 * increases it; `YawNorth = (TrackNorthOffset − Yaw) mod 2π`). Integrating in a
 * plain maths plane — `X += vx·cosψ − vy·sinψ`, `Y += vx·sinψ + vy·cosψ` — puts a
 * left turn counter-clockwise with +Y up the page, i.e. a right turn clockwise.
 * So the mapping onto LMU axes is the identity on the plane: **x = X, z = Y**,
 * y = 0 (the outline is flat; iRacing gives no altitude live). No sign flips.
 * Pass `yaw = π/2 − YawNorth` instead of `Yaw` and the same outline comes out
 * north-up (+Z = north, +X = east) — a pure rotation, same handedness.
 *
 * Pure: no IO, no clocks. Called once per telemetry tick (60 Hz); the only
 * steady-state allocation is the small position object it returns.
 */

/** One tick of the player's own motion. */
export interface IracingIntegratorInput {
  /** `VelocityX`: body-frame forward speed, m/s. */
  velX: number;
  /** `VelocityY`: body-frame lateral speed, m/s, + = to the LEFT. */
  velY: number;
  /**
   * Heading, radians, counter-clockwise positive: iRacing `Yaw`
   * (or `π/2 − YawNorth` for a north-up outline).
   */
  yaw: number;
  /** Seconds since the previous tick (Δ`SessionTime`). */
  dtS: number;
  /** `LapDistPct`, 0..1 from the start/finish line. */
  lapDistPct: number;
  /**
   * `true` while the car is genuinely driving the circuit: `IsOnTrack &&
   * !OnPitRoad && !IsReplayPlaying && PlayerCarTowTime === 0`. Anything else
   * (garage, pit stall, pit lane, replay, tow) abandons the lap being recorded
   * and makes {@link IracingPositionIntegrator.step} return `null`.
   */
  onTrack: boolean;
  /**
   * Optional: `false` marks the lap in progress as unfit to become the
   * reference outline (e.g. `PlayerTrackSurface === 0`, off in the grass) while
   * still integrating through it. Defaults to `true`.
   */
  clean?: boolean;
  /**
   * Optional: the lap length in metres (`WeekendInfo.TrackLength` × 1000). When
   * given, a recorded lap whose driven length is not within
   * {@link LENGTH_TOLERANCE} of it is refused as a reference.
   */
  trackLengthM?: number;
}

/** A position in LMU world axes (metres): X/Z ground plane, Y up. */
export interface IracingWorldPos {
  x: number;
  y: number;
  z: number;
}

/** One point of the closed reference outline. */
export interface IracingOutlinePoint extends IracingWorldPos {
  /** Lap fraction 0..1 this point sits at. */
  lapDistPct: number;
}

/**
 * Longest tick gap integrated across, seconds. At 60 Hz a tick is 17 ms; a gap
 * past a quarter-second is a pause, a sim hitch or a session jump, and the
 * straight line across it is not where the car went.
 */
const MAX_DT_S = 0.25;
/** A lap fraction that ticks backwards by more than this is a spin or a reset. */
const MAX_BACKWARD_PCT = 0.01;
/** A forward jump this big in one tick is a teleport (tow, reset), not driving. */
const MAX_FORWARD_PCT = 0.05;
/** A line crossing: the fraction falls from the top of the lap to the bottom. */
const WRAP_HIGH = 0.9;
const WRAP_LOW = 0.1;
/** Accepted driven-length / published-length ratio (driven line vs centre line). */
export const LENGTH_TOLERANCE = 0.1;
/**
 * Largest loop-closure error accepted, as a share of the lap's driven length.
 * Sim-true velocity and heading close a lap to well under 1%; 5% means the
 * inputs were wrong (a sign, a unit), and closing it would hide that.
 */
export const MAX_CLOSURE_SHARE = 0.05;
/** Reference resolution: about one point per {@link REF_SPACING_M} of road. */
const REF_SPACING_M = 2;
const MIN_REF_POINTS = 256;
const MAX_REF_POINTS = 8192;
/** Initial capacity of the lap buffer (≈ 2.3 min at 60 Hz); doubles as needed. */
const INITIAL_CAPACITY = 8192;

function finite(v: number): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Signed smallest difference a − b of two angles, in (−π, π]. */
function angleDiff(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * Dead-reckons the player's position and, once one clean lap has closed, serves
 * positions on that closed outline. One instance per provider; {@link reset} on
 * a session or track change.
 */
export class IracingPositionIntegrator {
  // Integration state (maths plane: X right, Y up).
  private x = 0;
  private y = 0;
  private hasPrev = false;
  private prevPct = 0;
  private prevYaw = 0;
  private prevVx = 0;
  private prevVy = 0;

  // The lap being recorded. `lapPos` is the fraction unwrapped relative to the
  // lap's start line (so it runs from just below 0 to just above 1).
  private recording = false;
  private dirty = false;
  private count = 0;
  private bufPos = new Float64Array(INITIAL_CAPACITY);
  private bufX = new Float64Array(INITIAL_CAPACITY);
  private bufY = new Float64Array(INITIAL_CAPACITY);

  // The closed reference (LMU axes x/z), uniform in lap fraction, N points.
  private refX: Float64Array | null = null;
  private refZ: Float64Array | null = null;
  private rev = 0;
  private lastRefusal = '';
  /** Published lap length to validate a recorded lap against (0 = unknown). */
  private lengthM = 0;

  /** Forget everything: new session, new track, new car. */
  public reset(): void {
    this.x = 0;
    this.y = 0;
    this.hasPrev = false;
    this.recording = false;
    this.dirty = false;
    this.count = 0;
    this.refX = null;
    this.refZ = null;
    this.rev = 0;
    this.lastRefusal = '';
    this.lengthM = 0;
  }

  /** `true` once a closed reference outline exists. */
  public get ready(): boolean {
    return this.refX !== null;
  }

  /** Bumped each time a reference outline is built (0 = none yet). */
  public get revision(): number {
    return this.rev;
  }

  /** Why the last recorded lap was refused as a reference ("" = none refused). */
  public get refusal(): string {
    return this.lastRefusal;
  }

  /**
   * How far round the lap being recorded the car is, 0..1 — for a progress
   * read before the reference exists. `1` once ready.
   */
  public get recordingProgress(): number {
    if (this.refX) return 1;
    if (!this.recording || this.count === 0) return 0;
    return Math.max(0, Math.min(1, this.bufPos[this.count - 1] as number));
  }

  /**
   * Folds one tick in. Returns the car's position ON the closed reference
   * outline (LMU axes), or `null` when not on track or before the first clean
   * lap has closed.
   */
  public step(s: IracingIntegratorInput): IracingWorldPos | null {
    const pct = s.lapDistPct;
    if (
      !s.onTrack ||
      !finite(pct) ||
      pct < 0 ||
      pct > 1 ||
      !finite(s.velX) ||
      !finite(s.velY) ||
      !finite(s.yaw)
    ) {
      this.abandon();
      this.hasPrev = false;
      return null;
    }
    if (s.clean === false) this.dirty = true;
    if (s.trackLengthM !== undefined) {
      this.lengthM = finite(s.trackLengthM) && s.trackLengthM > 0 ? s.trackLengthM : 0;
    }

    if (!this.hasPrev || !finite(s.dtS) || s.dtS <= 0 || s.dtS > MAX_DT_S) {
      // Nothing to integrate from (first tick, or a gap no straight line spans).
      if (this.hasPrev) this.abandon();
      this.remember(s);
      return this.lookup(pct);
    }

    // Lap-fraction continuity. A crossing of the line forward is the only
    // allowed decrease; anything else backwards is a spin or a reset.
    let dPct = pct - this.prevPct;
    const crossed = this.prevPct >= WRAP_HIGH && pct <= WRAP_LOW;
    if (crossed) dPct += 1;
    if (dPct < -MAX_BACKWARD_PCT || dPct > MAX_FORWARD_PCT) {
      this.abandon();
      this.remember(s);
      return this.lookup(pct);
    }

    // Midpoint integration: average heading and velocity across the tick.
    const dt = s.dtS;
    const psi = this.prevYaw + angleDiff(s.yaw, this.prevYaw) / 2;
    const vx = (this.prevVx + s.velX) / 2;
    const vy = (this.prevVy + s.velY) / 2;
    const c = Math.cos(psi);
    const sn = Math.sin(psi);
    const px = this.x;
    const py = this.y;
    this.x += (vx * c - vy * sn) * dt;
    this.y += (vx * sn + vy * c) * dt;

    if (!this.refX) {
      if (this.recording) {
        this.push(crossed ? pct + 1 : pct, this.x, this.y);
        if (crossed) this.closeLap();
      }
      if (crossed && !this.refX) {
        // Start (or restart) a lap at this crossing: the tick before it, at a
        // negative fraction, and this one — so both ends can be interpolated
        // to exactly the line.
        this.recording = true;
        this.dirty = s.clean === false;
        this.count = 0;
        this.push(this.prevPct - 1, px, py);
        this.push(pct, this.x, this.y);
      }
    }

    this.remember(s);
    return this.lookup(pct);
  }

  /**
   * The whole closed reference outline, index 0 on the start/finish line and
   * uniform in lap fraction — for filling a {@link TrackMapBuilder} in one go
   * (call `update` once per point with `lapDistM = lapDistPct × lengthM`).
   * `null` before the first clean lap has closed. Allocates; call it once per
   * {@link revision} change, not per tick.
   */
  public outline(): IracingOutlinePoint[] | null {
    const rx = this.refX;
    const rz = this.refZ;
    if (!rx || !rz) return null;
    const n = rx.length;
    const out: IracingOutlinePoint[] = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = { lapDistPct: i / n, x: rx[i] as number, y: 0, z: rz[i] as number };
    }
    return out;
  }

  /* ------------------------------------------------------------------------ */

  private remember(s: IracingIntegratorInput): void {
    this.hasPrev = true;
    this.prevPct = s.lapDistPct;
    this.prevYaw = s.yaw;
    this.prevVx = s.velX;
    this.prevVy = s.velY;
  }

  /** Drop the lap in progress; the next line crossing starts a fresh one. */
  private abandon(): void {
    this.recording = false;
    this.count = 0;
  }

  private push(pos: number, x: number, y: number): void {
    if (this.count >= this.bufPos.length) {
      const cap = this.bufPos.length * 2;
      const grow = (a: Float64Array): Float64Array<ArrayBuffer> => {
        const b = new Float64Array(cap);
        b.set(a);
        return b;
      };
      this.bufPos = grow(this.bufPos);
      this.bufX = grow(this.bufX);
      this.bufY = grow(this.bufY);
    }
    this.bufPos[this.count] = pos;
    this.bufX[this.count] = x;
    this.bufY[this.count] = y;
    this.count++;
  }

  /**
   * Interpolate the recorded lap at unwrapped fraction `f`, starting the search
   * at index `from`. Writes into `out` and returns the index it stopped at, so a
   * monotonic sweep is O(n) overall.
   */
  private interp(f: number, from: number, out: { x: number; y: number }): number {
    const n = this.count;
    let i = Math.max(0, from);
    while (i < n - 2 && (this.bufPos[i + 1] as number) < f) i++;
    const p0 = this.bufPos[i] as number;
    const p1 = this.bufPos[i + 1] as number;
    const t = p1 > p0 ? Math.max(0, Math.min(1, (f - p0) / (p1 - p0))) : 0;
    out.x = (this.bufX[i] as number) + ((this.bufX[i + 1] as number) - (this.bufX[i] as number)) * t;
    out.y = (this.bufY[i] as number) + ((this.bufY[i + 1] as number) - (this.bufY[i] as number)) * t;
    return i;
  }

  /** The lap has crossed the line again: close it into a reference, or refuse it. */
  private closeLap(): void {
    const n = this.count;
    this.recording = false;
    if (this.dirty) {
      this.lastRefusal = 'lap not clean';
      return;
    }
    if (n < 16) {
      this.lastRefusal = 'too few samples';
      return;
    }
    const tmp = { x: 0, y: 0 };
    this.interp(0, 0, tmp);
    const sx = tmp.x;
    const sy = tmp.y;
    this.interp(1, 0, tmp);
    const ex = tmp.x;
    const ey = tmp.y;

    // Driven length between the two line crossings.
    let len = 0;
    for (let i = 1; i < n; i++) {
      const a = this.bufPos[i - 1] as number;
      const b = this.bufPos[i] as number;
      if (b <= 0 || a >= 1) continue;
      len += Math.hypot(
        (this.bufX[i] as number) - (this.bufX[i - 1] as number),
        (this.bufY[i] as number) - (this.bufY[i - 1] as number),
      );
    }
    const ex0 = ex - sx;
    const ey0 = ey - sy;
    const closure = Math.hypot(ex0, ey0);
    if (!(len > 0)) {
      this.lastRefusal = 'zero length';
      return;
    }
    if (closure > len * MAX_CLOSURE_SHARE) {
      this.lastRefusal = `closure ${closure.toFixed(1)} m of ${len.toFixed(0)} m`;
      return;
    }
    if (this.lengthM > 0 && Math.abs(len / this.lengthM - 1) > LENGTH_TOLERANCE) {
      this.lastRefusal = `length ${len.toFixed(0)} m vs ${this.lengthM.toFixed(0)} m`;
      return;
    }

    // Resample uniform in lap fraction, distributing the closure error
    // linearly over the lap, then centre on the centroid.
    const pts = Math.max(
      MIN_REF_POINTS,
      Math.min(MAX_REF_POINTS, Math.round(len / REF_SPACING_M)),
    );
    const rx = new Float64Array(pts);
    const rz = new Float64Array(pts);
    let cx = 0;
    let cz = 0;
    let idx = 0;
    for (let k = 0; k < pts; k++) {
      const f = k / pts;
      idx = this.interp(f, idx, tmp);
      const x = tmp.x - sx - ex0 * f;
      const z = tmp.y - sy - ey0 * f;
      rx[k] = x;
      rz[k] = z;
      cx += x;
      cz += z;
    }
    cx /= pts;
    cz /= pts;
    for (let k = 0; k < pts; k++) {
      rx[k] = (rx[k] as number) - cx;
      rz[k] = (rz[k] as number) - cz;
    }
    this.refX = rx;
    this.refZ = rz;
    this.rev++;
    this.lastRefusal = '';
    this.count = 0;
  }

  /** Position on the reference at lap fraction `pct`, or `null` before one exists. */
  private lookup(pct: number): IracingWorldPos | null {
    const rx = this.refX;
    const rz = this.refZ;
    if (!rx || !rz) return null;
    const n = rx.length;
    const f = (pct >= 1 ? 0 : pct) * n;
    const i = Math.min(n - 1, Math.floor(f));
    const t = f - i;
    const j = i + 1 === n ? 0 : i + 1;
    const x0 = rx[i] as number;
    const z0 = rz[i] as number;
    return { x: x0 + ((rx[j] as number) - x0) * t, y: 0, z: z0 + ((rz[j] as number) - z0) * t };
  }
}
