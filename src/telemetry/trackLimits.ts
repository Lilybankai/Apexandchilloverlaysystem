/**
 * @file src/telemetry/trackLimits.ts
 * @module telemetry/trackLimits
 *
 * Turns the sim's two lateral-position channels into a **track-limits** state:
 * are you off the road right now, how many excursions have you had this session,
 * and how many penalties has the sim actually handed you for them.
 *
 * ## Where the judgement comes from — and where it does NOT
 * rF2/LMU publish, per car, in the Scoring buffer:
 *
 *   `mPathLateral`  how far the car is from the track's centre path, metres.
 *   `mTrackEdge`    how far the **track** extends in that same direction, metres.
 *
 * Both carry the same sign (verified live across a 37-car Fuji field: every row
 * had matching signs, and the one car sitting in its garage stall read 17.96
 * against an 11.78 edge). So `|pathLateral| > |trackEdge|` is the sim's own
 * statement that the car's centre has passed the edge of the drivable surface.
 *
 * What neither channel is, is **LMU's own track-limits ruling**. The sim judges
 * limits internally against the white line and hands out its warnings through
 * the in-game HUD; nothing in shared memory or the REST API publishes that
 * count. It publishes the *consequence* — `mNumPenalties` — only once a penalty
 * has actually landed. So this module does the honest version of the job:
 *
 *   - {@link TrackLimitsState.penalties} is the sim's own number, reported as-is.
 *     When it moves, that is not our opinion, it is the stewards.
 *   - {@link TrackLimitsState.warnings} is **our** count of excursions, derived
 *     here from the geometry above. It will not always agree with the sim's
 *     internal tally — a track whose white line sits inboard of the AIW edge
 *     will be stricter than we are — and the widget says so rather than
 *     pretending to be the steward.
 *
 * That is still the number a driver wants mid-stint: "how many times have I run
 * wide" is the question, and being told it the moment it happens is worth more
 * than a count that is exactly right and arrives at the end of the lap.
 *
 * ## Why a class rather than a function
 * An excursion is an EDGE, not a level. Off-track is true for as long as the car
 * is out there — a second and a half through the gravel at Ascari is one
 * mistake, not forty-five frames of mistake — so counting needs hysteresis and
 * therefore memory. Everything stateful lives here so both live providers share
 * one implementation and it can be tested headless (`scripts/test-tracklimits.js`).
 */

import { UNKNOWN_VALUE } from './types';
import type { TrackLimitsState } from './types';

/**
 * How many **points** it takes to earn the penalty, by default.
 *
 * LMU's track limits are a points system, not a strike count: every infringement
 * scores points, and a drive-through is issued once the running total passes a
 * threshold the *session* configures — leagues publish theirs on the event's
 * registration page. There is therefore no universally correct number to hard-code
 * here, which is why this is only the default and the real one is an operator
 * setting (see {@link TrackLimitsInput.pointsLimit}).
 *
 * Ten is a middling league figure and, more usefully, is well clear of the one
 * threshold LMU *does* document — a single infringement worth 3 points is an
 * instant drive-through on its own (see {@link INSTANT_PENALTY_POINTS}) — so the
 * two rules stay visibly separate on the widget instead of collapsing into each
 * other at the default.
 */
export const DEFAULT_POINTS_LIMIT = 10;

/**
 * Points from a **single** infringement that LMU turns into an immediate
 * drive-through regardless of the running total. This is the one hard number the
 * sim's own documentation gives, so it is a constant rather than a setting.
 */
export const INSTANT_PENALTY_POINTS = 3;

/**
 * The most points one infringement can score here.
 *
 * Capped at {@link INSTANT_PENALTY_POINTS} because that is where the scale stops
 * meaning anything: past it the sim issues the penalty outright, so a "4-point"
 * cut would be a distinction with no consequence attached to it.
 */
export const MAX_INFRINGEMENT_POINTS = INSTANT_PENALTY_POINTS;

/**
 * Half the width of a car, metres.
 *
 * `mPathLateral` measures the car's CENTRE, so this is what turns that channel
 * into a statement about wheels. Roughly 1 m covers the whole LMU field (a 2.0 m
 * Hypercar, a 2.05 m GT3) — the gap between the widest and narrowest car is
 * 25 mm a side, well below the precision of anything else here, so it is a
 * constant rather than a per-class lookup.
 */
export const HALF_CAR_WIDTH_M = 1.0;

/**
 * How far past the sim's track edge the car's centre must be before an excursion
 * counts, metres — the **default**, overridable per-install through
 * {@link TrackLimitsInput.marginM}.
 *
 * ## Why this is not simply half a car's width
 * It was, and it was far too sensitive on track. The arithmetic was sound — a
 * centre one half-width past the edge does put all four wheels past it — but it
 * was the wrong edge. `mTrackEdge` marks the AIW's **drivable-surface**
 * boundary, which on most circuits runs at or inside the white line, so the kerb
 * is already "past the edge". At a 1 m margin, riding a kerb the way every
 * driver rides a kerb counted as running wide.
 *
 * A racing kerb is about 1.2–1.5 m of it, so putting the threshold a kerb's
 * width further out means the car has to be clear of the kerb entirely before
 * anything counts — which is the point a driver would themselves say they ran
 * out of road. Read as wheels, at the 2.4 m default:
 *
 * - centre at `edge + 1.4` — the outer two wheels are off the road, inner two on
 * - centre at `edge + 2.4` — **all four wheels beyond the kerb**, this threshold
 *
 * The residual error is that kerb width varies by circuit and the AIW boundary
 * is not in the same place at every track. That is exactly why this is tunable
 * rather than constant: somewhere with unusually wide kerbs turns it up, and a
 * league wanting the strict all-four-wheels-past-the-white-line reading turns it
 * down to 1.0 and gets the original behaviour back.
 */
export const DEFAULT_OFF_TRACK_MARGIN_M = 2.4;

/**
 * Bounds for a caller-supplied margin. Below half a car's width the threshold
 * would trip with wheels still unambiguously on the road; past 5 m it would miss
 * genuine excursions at all but the widest run-offs.
 */
export const MARGIN_MIN_M = 0.5;
export const MARGIN_MAX_M = 5;

/**
 * The operator's chosen margin, or `null` to use the default.
 *
 * Module-level and mutable for the same reason the server's `appearance` state
 * is: the desktop app runs the telemetry server **in-process**, so it can retune
 * this while a session is live. Baking it into the provider's constructor would
 * mean restarting the server — and dropping every connected overlay — each time
 * the driver nudged the slider, which is exactly the wrong cost for a control
 * whose whole purpose is "that felt too eager, try again".
 *
 * Providers deliberately do NOT pass `marginM` on the input; they leave it unset
 * and let this be the source of truth, so there is one writer
 * ({@link setTrackLimitsMargin}) rather than a value copied into two trackers
 * that could then disagree. The input field remains for tests, which want to
 * pin a threshold without touching global state.
 */
let runtimeMarginM: number | null = null;

/**
 * Sets the live off-track margin in metres, or clears it back to the default
 * with `null`. Clamped here so no caller can put an unusable threshold in.
 * Returns the value actually in force.
 */
export function setTrackLimitsMargin(marginM: number | null): number {
  if (marginM === null || !Number.isFinite(marginM)) {
    runtimeMarginM = null;
  } else {
    runtimeMarginM = Math.min(MARGIN_MAX_M, Math.max(MARGIN_MIN_M, marginM));
  }
  return trackLimitsMargin();
}

/** The off-track margin currently in force, metres. */
export function trackLimitsMargin(): number {
  return runtimeMarginM ?? DEFAULT_OFF_TRACK_MARGIN_M;
}

/**
 * How far back INSIDE the threshold the car must come before the next excursion
 * can be counted, metres — so the on/off decision has a half-metre of hysteresis
 * around it.
 *
 * Without it a car balanced on the limit through a long fast corner ticks the
 * counter every time the channel dithers across the threshold, and one wide
 * entry at Fuji's 100R reads as five. The band is deliberately small: run wide,
 * gather it up on the kerb and run wide again IS two excursions, and a driver
 * would count it as two.
 */
export const RECOVERY_MARGIN_M = 0.5;

/**
 * Minimum time an excursion must last before it counts, milliseconds.
 *
 * A single sample past the line is as likely to be the position channel
 * catching a kerb strike as it is a genuine run-off. A tenth of a second at
 * racing speed is several metres of car genuinely out there, which is what the
 * rule is about, and it is far below the point a driver would stop calling it a
 * mistake.
 */
export const MIN_EXCURSION_MS = 100;

/**
 * Speed (km/h) below which excursions are not counted.
 *
 * Two cases this excludes, both of which would otherwise spam the counter: the
 * pit lane and garage stalls (which are laterally miles off the track path —
 * that stationary car at Fuji read 17.96 m against an 11.78 m edge), and a car
 * that has already crashed and is being recovered across the grass. Neither is a
 * track-limits infraction, and the second is a driver who has quite enough to
 * think about.
 */
export const MIN_SPEED_KPH = 40;

/**
 * How long the driver has, after putting the car off the road, to give the time
 * back before the infringement is scored — milliseconds.
 *
 * This is the sim's own mechanic, not an invention. LMU raises a Race Control
 * notification the moment you are **at risk**, and its own documentation is
 * explicit that you then "have a brief opportunity to slow down whilst the
 * violation is calculated to avoid a penalty". Its scoring weighs whether you
 * were accelerating and whether you were at the speed expected for that part of
 * the track: run slower than expected and the points come down, faster and they
 * go up.
 *
 * So an excursion here is not scored the instant it happens. It opens a window,
 * and what the driver does inside that window decides whether it costs anything —
 * which is the whole reason the audio cue fires at the START of the window rather
 * than at the end. A cue that announces a point already taken tells the driver
 * something they can no longer do anything about.
 *
 * 1.2 s is long enough to react to the cue and lift, short enough that the
 * verdict still arrives while the driver remembers the corner.
 */
export const AT_RISK_WINDOW_MS = 1200;

/**
 * Throttle (0..1) at or below which the driver counts as having lifted.
 *
 * Not zero: giving the time back is a lift, not a brake test, and a driver
 * feathering the throttle to scrub speed on the exit kerb is doing exactly what
 * the rule asks of them. A quarter throttle at racing speed is a car that is
 * slowing down.
 */
export const LIFT_THROTTLE = 0.25;

/**
 * How far past the threshold an excursion has to reach to score each extra
 * point, metres.
 *
 * The sim scores partly on how much of an advantage the cut represents, which we
 * cannot measure directly — but how far off the road the car actually got is a
 * fair proxy for it and is the one thing the lateral channels do tell us. Two
 * strides of ~1.5 m take a single infringement from 1 point to the 3 that LMU
 * turns into an instant drive-through, which puts "put a wheel a metre wide" and
 * "drove across the run-off" on visibly different sides of the scale.
 */
export const POINT_STEP_M = 1.5;

/** One poll's worth of input — everything the decision needs, already in SI. */
export interface TrackLimitsInput {
  /**
   * Lateral offset of the car's centre from the track path, metres, signed.
   *
   * `null` when the channel is unavailable, which disables detection rather
   * than guessing. `null` and not the frame's usual {@link UNKNOWN_VALUE} for
   * the same reason `TrackLimitsState.beyondEdgeM` is optional: this value is
   * legitimately negative, so a car one metre left of the racing line would read
   * exactly the sentinel and be discarded as missing data.
   */
  pathLateralM: number | null;
  /**
   * How far the track surface extends in the same direction, metres, carrying
   * the same sign as {@link pathLateralM}. `null` when unknown.
   */
  trackEdgeM: number | null;
  /** Car speed, km/h. {@link UNKNOWN_VALUE} when unknown. */
  speedKph: number;
  /**
   * Throttle position `0`..`1`, or `null` when the channel is unavailable
   * (spectating, no shared memory).
   *
   * This is what makes lifting-to-negate possible. With no throttle channel the
   * tracker cannot tell a driver giving the time back from one flooring it, so
   * it scores every excursion rather than guessing — the safe way round, since
   * the alternative is quietly forgiving infringements that did cost the driver
   * points in the sim.
   */
  throttle: number | null;
  /** `true` when the car is in the pit lane or its garage stall. */
  inPit: boolean;
  /**
   * The sim's own outstanding-penalty count for this car (`mNumPenalties`).
   * {@link UNKNOWN_VALUE} when the channel is unavailable.
   */
  penalties: number;
  /**
   * An identity for the current session — anything that changes when the
   * session does (track + session type is what the providers pass). A change
   * resets the counter, because warnings do not carry from qualifying into the
   * race any more than they carry between two evenings' racing.
   */
  sessionKey: string;
  /** Wall-clock now, milliseconds. Passed in so the tracker is testable. */
  nowMs: number;
  /**
   * How far past the track edge the car's centre must be before it counts,
   * metres. Omitted uses {@link DEFAULT_OFF_TRACK_MARGIN_M}; anything supplied
   * is clamped to `[MARGIN_MIN_M, MARGIN_MAX_M]`.
   *
   * On the per-poll input rather than in the constructor so the operator's
   * slider retunes a **running** session — a driver who finds it too eager does
   * not want to restart the server to say so, and the count so far stays valid
   * because nothing about it depended on the old threshold except the decision
   * that has already been made.
   */
  marginM?: number;
  /**
   * Points that earn the penalty in THIS session, overriding
   * {@link DEFAULT_POINTS_LIMIT}. Leagues publish their own number; a value at
   * or below zero is ignored rather than making every excursion instantly fatal.
   */
  pointsLimit?: number;
}

/**
 * Counts track-limit excursions for one car across a session.
 *
 * Feed it every poll; it returns the state to put on the frame. Cheap by
 * construction — a handful of comparisons and no allocation beyond the returned
 * object — because it runs at the full broadcast rate.
 */
export class TrackLimitsTracker {
  /** Session this counter belongs to; a change wipes it. */
  private sessionKey = '';
  /** Infringements that actually scored this session. */
  private warnings = 0;
  /** Points accumulated this session. */
  private points = 0;
  /** Infringements the driver gave back by lifting inside the window. */
  private negated = 0;
  /** Points the last scored infringement was worth, for the widget's callout. */
  private lastPoints = 0;
  /** Whether the car is currently outside the edge (with hysteresis applied). */
  private off = false;
  /** When the current excursion began, or 0 when on track. */
  private offSince = 0;
  /** Whether the current excursion has already been resolved (scored or not). */
  private counted = false;
  /** Whether the driver has lifted at any point during the current window. */
  private liftedDuringRisk = false;
  /** Deepest the car got beyond the threshold this excursion, metres. */
  private worstBeyondM = 0;
  /** `nowMs` of the most recent scored infringement, for the widget's flash. */
  private lastWarningAt = 0;
  /** `nowMs` of the most recent NEGATED one — the "well saved" feedback. */
  private lastNegatedAt = 0;
  /** `nowMs` at which {@link penalties} last increased. */
  private lastPenaltyAt = 0;
  /** Last penalty count seen, to detect the increment. */
  private penalties: number = UNKNOWN_VALUE;

  /** Forget everything — a new session, or the car leaving the feed. */
  public reset(): void {
    this.warnings = 0;
    this.points = 0;
    this.negated = 0;
    this.lastPoints = 0;
    this.off = false;
    this.offSince = 0;
    this.counted = false;
    this.liftedDuringRisk = false;
    this.worstBeyondM = 0;
    this.lastWarningAt = 0;
    this.lastNegatedAt = 0;
    this.lastPenaltyAt = 0;
    this.penalties = UNKNOWN_VALUE;
  }

  /**
   * What one infringement is worth, given how far off the road it got.
   *
   * Mirrors the shape of the sim's own scoring — worse cut, more points — using
   * the only magnitude the lateral channels give us. Capped at
   * {@link MAX_INFRINGEMENT_POINTS}: past that the sim issues the penalty
   * outright, so a higher number would describe a distinction with no
   * consequence behind it.
   */
  private static score(worstBeyondM: number, marginM: number): number {
    const past = Math.max(0, worstBeyondM - marginM);
    return Math.min(MAX_INFRINGEMENT_POINTS, 1 + Math.floor(past / POINT_STEP_M));
  }

  /**
   * Advance the counter by one poll and return the current state.
   *
   * Returns `null` when neither channel is available, so the provider omits the
   * block entirely rather than publishing a confident zero — the same rule the
   * motion and chassis blocks follow. A missing lateral channel with a live
   * penalty count still produces a state: the sim's own verdict is worth showing
   * on its own.
   */
  public update(input: TrackLimitsInput): TrackLimitsState | null {
    if (input.sessionKey !== this.sessionKey) {
      this.sessionKey = input.sessionKey;
      this.reset();
    }

    /* --- the sim's own penalties, straight through --------------------- */
    const penalties = input.penalties;
    if (penalties !== UNKNOWN_VALUE) {
      if (this.penalties !== UNKNOWN_VALUE && penalties > this.penalties) {
        this.lastPenaltyAt = input.nowMs;
      }
      this.penalties = penalties;
    }

    /* --- our own excursion detection ----------------------------------- */
    const lateral = input.pathLateralM;
    const edge = input.trackEdgeM;
    const haveLateral =
      lateral !== null &&
      edge !== null &&
      Number.isFinite(lateral) &&
      Number.isFinite(edge) &&
      // A zero edge is the channel saying "no AIW here", not a zero-width track.
      Math.abs(edge) > 0.5;

    if (!haveLateral && this.penalties === UNKNOWN_VALUE) return null;

    // How far past the edge the car's centre is, metres. Negative = inside.
    // Both channels carry the same sign, so the comparison is on magnitudes.
    // `null` rather than a sentinel: this value is legitimately negative, so
    // -1 would be a real reading — see TrackLimitsState.beyondEdgeM.
    const beyondM = haveLateral ? Math.abs(lateral) - Math.abs(edge) : null;

    // Excursions are not judged at all in the pit lane or at walking pace —
    // see MIN_SPEED_KPH for the two cases that rules out.
    const eligible =
      haveLateral &&
      !input.inPit &&
      input.speedKph !== UNKNOWN_VALUE &&
      input.speedKph >= MIN_SPEED_KPH;

    // The threshold in force, read every poll so the control panel's slider
    // takes effect mid-session rather than at the next restart. An explicit
    // input wins (tests pin one); otherwise the operator's live value.
    const margin =
      typeof input.marginM === 'number' && Number.isFinite(input.marginM)
        ? Math.min(MARGIN_MAX_M, Math.max(MARGIN_MIN_M, input.marginM))
        : trackLimitsMargin();

    const pointsLimit =
      typeof input.pointsLimit === 'number' && input.pointsLimit > 0
        ? Math.round(input.pointsLimit)
        : DEFAULT_POINTS_LIMIT;

    if (!eligible) {
      // Leaving the eligible window ends any excursion in progress without
      // scoring it — a car that ran wide and then pitted has not earned points
      // for the pit lane's own geometry.
      this.endExcursion();
    } else if (beyondM === null) {
      // Unreachable while `eligible` (which requires the channels), but it is
      // what makes the comparisons below provably non-null rather than asserted.
      this.endExcursion();
    } else if (this.off) {
      // Out on the road. Two things are being watched at once: how deep it got
      // (which sets the score) and whether the driver lifted (which cancels it).
      if (beyondM > this.worstBeyondM) this.worstBeyondM = beyondM;
      if (input.throttle !== null && input.throttle <= LIFT_THROTTLE) {
        this.liftedDuringRisk = true;
      }

      const elapsed = input.nowMs - this.offSince;
      if (!this.counted && elapsed >= Math.max(MIN_EXCURSION_MS, AT_RISK_WINDOW_MS)) {
        // The window has run: score it, or credit the driver for giving it back.
        this.counted = true;
        if (this.liftedDuringRisk) {
          this.negated += 1;
          this.lastNegatedAt = input.nowMs;
        } else {
          const scored = TrackLimitsTracker.score(this.worstBeyondM, margin);
          this.warnings += 1;
          this.points += scored;
          this.lastPoints = scored;
          this.lastWarningAt = input.nowMs;
        }
      }

      // Back inside the recovery band ends it — but only AFTER the resolution
      // above, so a driver who lifts and gathers it up inside the window still
      // gets the credit rather than the excursion simply vanishing unjudged.
      if (beyondM < margin - RECOVERY_MARGIN_M && this.counted) this.endExcursion();
    } else if (beyondM >= margin) {
      // All four wheels have just passed the threshold. The window opens here —
      // this is the instant the driver is AT RISK and can still give it back.
      this.off = true;
      this.offSince = input.nowMs;
      this.counted = false;
      this.liftedDuringRisk =
        input.throttle !== null && input.throttle <= LIFT_THROTTLE;
      this.worstBeyondM = beyondM;
    }

    // At risk = out on the road with the verdict still open. This is what the
    // audio cue and the widget's alarm key off, because it is the only part of
    // the sequence the driver can still do something about.
    const atRisk = this.off && !this.counted;

    return {
      offTrack: this.off,
      atRisk,
      liftedInTime: atRisk ? this.liftedDuringRisk : false,
      ...(beyondM === null ? {} : { beyondEdgeM: round2(beyondM) }),
      points: this.points,
      pointsLimit,
      lastInfringementPoints: this.lastPoints || UNKNOWN_VALUE,
      warnings: this.warnings,
      negated: this.negated,
      penalties: this.penalties,
      msSinceWarning: this.lastWarningAt ? input.nowMs - this.lastWarningAt : UNKNOWN_VALUE,
      msSinceNegated: this.lastNegatedAt ? input.nowMs - this.lastNegatedAt : UNKNOWN_VALUE,
      msSincePenalty: this.lastPenaltyAt ? input.nowMs - this.lastPenaltyAt : UNKNOWN_VALUE,
    };
  }

  /** Close the current excursion without judging it. */
  private endExcursion(): void {
    this.off = false;
    this.offSince = 0;
    this.counted = false;
    this.liftedDuringRisk = false;
    this.worstBeyondM = 0;
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
