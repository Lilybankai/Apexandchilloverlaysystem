/**
 * @file src/telemetry/lmuTraceLimits.ts
 * @module telemetry/lmuTraceLimits
 *
 * Reads LMU's **own track-limits ruling** — the points it charges, incident by
 * incident — by tailing the game's trace log.
 *
 * ## Why a log file, of all things
 * Everything else was checked first, live, in a race session:
 *
 * - **Shared memory carries nothing.** `Extended`, `PitInfo` and `Rules` are all
 *   mapped and contain *zero printable strings*: LMU maps rF2's `mLSI*` message
 *   fields and the track-rules participant messages and never writes to them.
 * - **REST carries the threshold and nothing else.** Every candidate message,
 *   incident and race-control endpoint 404s, and the player's standings row has
 *   `penalties` — the count of penalties already landed — with no running total,
 *   no warning count and no per-incident value. What it does publish is
 *   `SESSSET_cuts_allowed` (see `LmuRestProvider.refreshRules`), the session's
 *   allowance, which is points rather than cuts.
 * - **The results XML is not live.** `UserData/Log/Results/*.xml` carries exactly
 *   the right data — per-incident `WarningPoints`, a running `CurrentPoints` — but
 *   is written in a single burst when the session *ends* (`birth == mtime`, and an
 *   in-progress session's incidents are absent from it entirely).
 *
 * The trace log is the one live source. `score.cpp` writes a verdict line and a
 * scoring breakdown for every excursion, as it happens:
 *
 * ```
 * 18135.60s score.cpp 4205: Track Limits: Off Track WP: 633 … LapDistance: 2938.04
 * 18137.68s score.cpp 4822: Track Limits: Back On Track; Lap: 1 LapDist: 3029.19
 * 18137.68s score.cpp  626: Track Limits: WarnPts: 1.00 Pts: 0.84 … MaxOffTrack: 12.91
 * 18141.85s score.cpp 4083: Track Limits: Warning; Lap: 1 LapDist: 3183.09
 * ```
 *
 * `WarnPts` is the charge for that incident. It was confirmed against the driver's
 * own in-game HUD readings — a deep hairpin cut read 1.00 on the HUD and 1.00 here,
 * a shallow one read 0.25 — and the events line up with our own geometry to the
 * metre (`LapDistance: 2938.04` against an excursion measured at 2939 m).
 *
 * ## What this reveals about the scoring, and what it costs the old guess
 * The breakdown names its own inputs: `TimeSkipped`, `TimeRatio`, `OffTime`,
 * `DistPts`, `PtsScaling`. **The charge is driven by time gained, not by how far off
 * the road the car went** — which is why a 0.93 m excursion at 183 kph scored
 * nothing while a 9.92 m cut that gained time scored 1.00. Any model of this built
 * on depth alone is measuring a correlate, not the cause.
 *
 * ## Deliberate limits of this reader
 * - **The lines carry no driver name.** They are taken to be the player's, on two
 *   grounds: the scoring-line count is far *lower* than the player's own excursion
 *   count from geometry (so it cannot be the whole field), and three consecutive
 *   `Off Track` lap distances matched three consecutive player excursions exactly.
 *   Pass-monitoring lines (`score.cpp 547`) *do* name other drivers and are ignored.
 * - **No running total is logged.** It is accumulated here from `WarnPts` and reset
 *   on a track-limits penalty, mirroring what the XML does to `CurrentPoints`. That
 *   makes the total a derivation, and it is the one number here that can drift; the
 *   session-end XML is the check on it.
 * - **Lap invalidation is not in the trace.** The XML reports it (`Invalid Lap Cut
 *   Track`); the trace has no equivalent line, so nothing here claims it.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The sim's verdict on one excursion, in its own words. */
export type TraceVerdict =
  | 'off-track'
  | 'off-track-again'
  | 'back-on-track'
  | 'no-track-cut'
  | 'warning'
  | 'valid-pit-entry';

/** One parsed `Track Limits:` line. */
export interface TraceLine {
  /** Game clock, seconds since the trace opened. Not session elapsed time. */
  atGameSec: number;
  /** `score.cpp` line number — the most reliable discriminator of line kind. */
  source: number;
  verdict: TraceVerdict | null;
  lap: number | null;
  lapDistM: number | null;
  /** Charge for this incident, points. Only on the breakdown line. */
  warnPts: number | null;
  /** Raw pre-quantisation score. Negative means time was lost, not gained. */
  rawPts: number | null;
  timeSkippedSec: number | null;
  maxOffTrackM: number | null;
}

/** A penalty the sim issued, named. */
export interface TracePenalty {
  atGameSec: number;
  /** The sim's own wording — the REASON, e.g. `"Track Limits"`, `"Pitlane Misbehaviour"`. */
  name: string;
  /**
   * What has to be DONE about it, when the trace said. Established live
   * (2026-08-20, a public multiplayer race) from three corroborating sources:
   *
   * - the penalty line's own numeric fields — `et=X A B …` where `A=1` was the
   *   drive-through and `A=0, B=10` the 10-second stop/go;
   * - `score.cpp 3973: Track Limits Drive Through Penalty`, an explicit kind
   *   line written in the same flush;
   * - the steward's result-stream message ("… received Stop/Go penalty, 10s,
   *   0laps for Exiting Pits Under Red"), which reaches the trace only while
   *   the results file is closed (early session) but names everything when it
   *   does.
   *
   * When a wordy source (steward message, kind line) lands within a beat of
   * the penalty line it wins over the numeric decode — words are harder to
   * misread than a positional field. Omitted when nothing said: an unnamed
   * kind stays unnamed, for the same reason `buildPenaltyType` refuses to
   * guess (serving the wrong kind costs a lap).
   */
  kind?: 'drive-through' | 'stop-go';
  /** The stop/go's hold time in seconds, when one was given (`10` = "10s"). */
  seconds?: number;
  /**
   * WHOSE penalty, when the steward's message named the driver. Load-bearing
   * for attribution: penalty lines fire for OTHER cars too in multiplayer
   * (proven live — another driver's pit-exit stop/go wrote a `Local penalty`
   * line to this PC's trace), so an unnamed line is only *probably* ours.
   */
  driver?: string;
}

/**
 * Penalties that discharge accumulated track-limit points.
 *
 * A pit-lane speeding penalty is a penalty but not a *track-limits* one, and must
 * not zero the count of cuts — which is why this matches on the wording rather
 * than on "a penalty appeared".
 *
 * `"Track Limits"` is the wording the sim actually uses when the accumulated points
 * earn their penalty — observed twice in one evening's driving, at the two moments
 * the driver was given a drive-through:
 *
 * ```
 * score.cpp 1365: Local penalty et=16382.48 0 10 0 0 "Track Limits"
 * ```
 *
 * The explicit drive-through and stop/go spellings are kept alongside it because
 * both appear in the same field elsewhere in the log, and a discharge that is not
 * recognised leaves a driver watching a total that never comes down.
 */
const TRACK_LIMIT_PENALTY = /track\s*limits|drive\s*-?\s*thr(u|ough)|stop\s*\/?\s*go/i;

/**
 * `18137.68s score.cpp 4822: Track Limits: …`
 *
 * ## The leading `\s*` is load-bearing
 * The game right-aligns the timestamp into a fixed-width column, so the same line
 * arrives padded or unpadded depending only on how long the game has been running:
 *
 * ```
 * " 114.51s score.cpp   626: …"   <- fresh launch, 3-digit seconds, PADDED
 * "16313.48s score.cpp   626: …"  <- five hours in, 5 digits, no padding
 * ```
 *
 * Anchored strictly at `^`, this reader worked only after the game had been up for
 * about 2.7 hours — the point at which the seconds field fills the column. Every
 * fixture in the test suite had been copied from one such long-running session,
 * which is precisely why they all passed while a fresh session recorded nothing.
 */
const TL_LINE = /^\s*([\d.]+)s\s+score\.cpp\s+(\d+):\s+Track Limits:\s+(.*)$/;

/**
 * The penalty lines, both spellings:
 *
 * ```
 * 18137.68s score.cpp 1365: Local penalty et=4807.4 0 10 0 0 "Speeding In Pitlane"
 *  6696.17s score.cpp 1224: Network penalty et=3438.9 "Track Limits" 1 0 0 0
 * ```
 *
 * `Local` puts the numbers before the name, `Network` after; in a multiplayer
 * race the server's penalty for this car arrives as BOTH lines in the same
 * flush (same `et`, same name), so the accumulator dedupes the pair. The four
 * numeric fields are the kind: first field `1` = drive-through, `0` with a
 * positive second field = stop/go of that many seconds — decoded from a live
 * drive-through (`1 0 0 0`, corroborated by the explicit kind line) and a live
 * "Stop/Go penalty, 10s" (`0 10 0 0`, corroborated by the steward's message).
 */
const PENALTY_LINE =
  /^\s*([\d.]+)s\s+score\.cpp\s+\d+:\s+Local penalty\s+et=[\d.]+\s+([-\d\s.]*?)"([^"]+)"/;
const NETWORK_PENALTY_LINE =
  /^\s*([\d.]+)s\s+score\.cpp\s+\d+:\s+Network penalty\s+et=[\d.]+\s+"([^"]+)"\s+([-\d\s.]*)$/;

/**
 * `6696.17s score.cpp 3973: Track Limits Drive Through Penalty` — the sim
 * naming, in words, the kind of track-limits penalty it is issuing in this
 * same flush. Only the drive-through wording has been observed; the stop/go
 * alternative is carried on the same pattern so it is recognised the day it
 * appears rather than ignored.
 */
const KIND_LINE =
  /^\s*([\d.]+)s\s+score\.cpp\s+\d+:\s+Track Limits\s+(Drive\s*-?\s*Thr(?:u|ough)|Stop\s*\/?\s*Go)\s+Penalty\s*$/i;

/**
 * The steward's result-stream message, which lands in the trace only while the
 * results file is closed (early in a session) and names EVERYTHING when it does:
 *
 * ```
 * steward.cpp 7095: Not logging result stream message, because the file is not
 *   open. Msg: Michael wood1987 received Stop/Go penalty, 10s, 0laps for
 *   Exiting Pits Under Red. Result: penalties=1, 1st=Stop/Go,10s
 * ```
 *
 * The driver's name is the part nothing else carries — it is what lets a
 * penalty be pinned to a car instead of assumed to be ours.
 */
const STEWARD_MSG =
  /steward\.cpp\s+\d+:.*\bMsg:\s+(.+?)\s+received\s+(Stop\s*\/?\s*Go|Drive\s*-?\s*Thr(?:u|ough))\s+penalty,\s*(\d+)s,\s*(\d+)\s*laps?\s+for\s+(.+?)\.\s*Result:/i;

/** How close (game seconds) a wordy line must be to a penalty line to describe it. */
const KIND_PAIR_WINDOW_SEC = 2;

/** Normalise a matched kind wording to the enum. */
function kindOf(word: string): 'drive-through' | 'stop-go' {
  return /drive/i.test(word) ? 'drive-through' : 'stop-go';
}

/**
 * Decode the penalty line's numeric fields into a kind, or nothing when the
 * shape is not one of the two observed ones. Conservative on purpose — an
 * unrecognised pattern yields no claim, same rule as the pit-menu rows.
 */
function kindFromFields(raw: string): { kind: 'drive-through' | 'stop-go'; seconds?: number } | null {
  const nums = raw
    .trim()
    .split(/\s+/)
    .map((s) => Number.parseFloat(s))
    .filter((n) => Number.isFinite(n));
  if (nums.length < 2) return null;
  const [a, b] = nums as [number, number];
  if (a === 1 && b === 0) return { kind: 'drive-through' };
  if (a === 0 && b > 0) return { kind: 'stop-go', seconds: b };
  return null;
}

/**
 * `132.59s steward.cpp 9371: SessionName="Practice"` — a session beginning.
 *
 * The accumulated total is per session: the sim starts each one at zero, and a race
 * restart is a new session. Without this the reader carries practice's cuts into
 * qualifying and shows a driver 39 points against an allowance of 5 — which is
 * exactly what replaying an evening's trace did before it was added.
 */
const SESSION_LINE = /^\s*([\d.]+)s\s+steward\.cpp\s+\d+:\s+SessionName="([^"]+)"/;

/** Verdict wording → our enum. Order matters: `Off Track Again` before `Off Track`. */
const VERDICTS: ReadonlyArray<readonly [RegExp, TraceVerdict]> = [
  [/^Off Track Again/i, 'off-track-again'],
  [/^Off Track WP/i, 'off-track'],
  [/^Back On Track/i, 'back-on-track'],
  [/^No Track Cut/i, 'no-track-cut'],
  [/^Warning/i, 'warning'],
  [/^Valid Pit Entry/i, 'valid-pit-entry'],
];

/**
 * Pull `name: -12.34` out of a breakdown line, or `null` when absent.
 *
 * The lookbehind is load-bearing: the breakdown line carries `WarnPts`, `DistPts`,
 * `WallPts` and a bare `Pts`, so a plain search for `Pts` matches the tail of
 * `WarnPts` and silently returns the charge where the raw score was asked for.
 */
function num(body: string, name: string): number | null {
  const m = new RegExp(`(?<![A-Za-z])${name}:?\\s*(-?[\\d.]+)`).exec(body);
  const raw = m?.[1];
  if (raw === undefined) return null;
  const v = Number.parseFloat(raw);
  return Number.isFinite(v) ? v : null;
}

/**
 * Parse one line of trace output.
 *
 * Returns `null` for the overwhelming majority of lines, which are nothing to do
 * with track limits — a trace file runs to several MB a session and this is called
 * on every line of it, so the cheap prefix test comes first.
 */
export function parseTraceLine(line: string): TraceLine | null {
  // The log is CRLF, and in JavaScript `\r` is a line terminator — which `.` does
  // NOT match. Left in place, the trailing carriage return defeats the `$` anchor
  // and every genuine line parses as `null`. Found by replaying a real file.
  const m = TL_LINE.exec(line.trimEnd());
  if (!m) return null;
  const [, secRaw, srcRaw, body] = m;
  if (secRaw === undefined || srcRaw === undefined || body === undefined) return null;
  const atGameSec = Number.parseFloat(secRaw);
  const source = Number.parseInt(srcRaw, 10);
  if (!Number.isFinite(atGameSec)) return null;

  // Pass-monitoring lines name OTHER drivers ("Ignored passed on <name> due to in
  // speed too low") and are not about our car at all.
  if (/^(Ignored passed|Removed Pass)/i.test(body)) return null;

  let verdict: TraceVerdict | null = null;
  for (const [re, v] of VERDICTS) {
    if (re.test(body)) {
      verdict = v;
      break;
    }
  }

  return {
    atGameSec,
    source,
    verdict,
    lap: num(body, 'Lap'),
    // `Back On Track` says `LapDist`, `Off Track` says `LapDistance`. Try the
    // longer name first: `LapDist` would match the prefix of both and take the
    // wrong number is a real risk only in the other order, but be explicit.
    lapDistM: num(body, 'LapDistance') ?? num(body, 'LapDist'),
    warnPts: num(body, 'WarnPts'),
    rawPts: num(body, 'Pts'),
    timeSkippedSec: num(body, 'TimeSkipped'),
    maxOffTrackM: num(body, 'MaxOffTrack'),
  };
}

/** Parse a `SessionName="…"` line, or `null` when the line is not one. */
export function parseTraceSession(line: string): { atGameSec: number; session: string } | null {
  const m = SESSION_LINE.exec(line.trimEnd());
  if (!m) return null;
  const [, secRaw, session] = m;
  if (secRaw === undefined || session === undefined) return null;
  const atGameSec = Number.parseFloat(secRaw);
  if (!Number.isFinite(atGameSec)) return null;
  return { atGameSec, session };
}

/** Parse a `Local penalty` / `Network penalty` line, or `null` when neither. */
export function parseTracePenalty(line: string): TracePenalty | null {
  const text = line.trimEnd();
  let secRaw: string | undefined;
  let name: string | undefined;
  let fields: string | undefined;
  const local = PENALTY_LINE.exec(text);
  if (local) {
    [, secRaw, fields, name] = local;
  } else {
    const net = NETWORK_PENALTY_LINE.exec(text);
    if (!net) return null;
    [, secRaw, name, fields] = net;
  }
  if (secRaw === undefined || name === undefined) return null;
  const atGameSec = Number.parseFloat(secRaw);
  if (!Number.isFinite(atGameSec)) return null;
  const decoded = fields ? kindFromFields(fields) : null;
  // A name that states the kind outright ("Drive Through Penalty", "Stop/Go
  // Penalty") outranks the numeric decode — words over positional fields,
  // same rule as everywhere else in this file. The seconds only survive when
  // the two sources agree on what kind of penalty they describe.
  const nameKind = /drive\s*-?\s*thr(?:u|ough)/i.test(name)
    ? ('drive-through' as const)
    : /stop\s*[/-]?\s*go/i.test(name)
      ? ('stop-go' as const)
      : null;
  const kind = nameKind ?? decoded?.kind;
  const seconds =
    kind === 'stop-go' && decoded?.kind === 'stop-go' ? decoded.seconds : undefined;
  return {
    atGameSec,
    name,
    ...(kind ? { kind } : {}),
    ...(seconds !== undefined ? { seconds } : {}),
  };
}

/**
 * Parse the explicit track-limits kind line, or `null`. Exported for the test
 * harness, like every parser here.
 */
export function parseTraceKindLine(
  line: string,
): { atGameSec: number; kind: 'drive-through' | 'stop-go' } | null {
  const m = KIND_LINE.exec(line.trimEnd());
  if (!m) return null;
  const [, secRaw, word] = m;
  if (secRaw === undefined || word === undefined) return null;
  const atGameSec = Number.parseFloat(secRaw);
  if (!Number.isFinite(atGameSec)) return null;
  return { atGameSec, kind: kindOf(word) };
}

/** Parse the steward's result-stream penalty message, or `null`. */
export function parseTraceSteward(line: string): {
  atGameSec: number;
  driver: string;
  kind: 'drive-through' | 'stop-go';
  seconds: number;
  laps: number;
  reason: string;
} | null {
  const text = line.trimEnd();
  const m = STEWARD_MSG.exec(text);
  if (!m) return null;
  const at = /^\s*([\d.]+)s\s/.exec(text);
  const [, driver, word, secondsRaw, lapsRaw, reason] = m;
  if (!at?.[1] || !driver || !word || !reason) return null;
  const atGameSec = Number.parseFloat(at[1]);
  if (!Number.isFinite(atGameSec)) return null;
  return {
    atGameSec,
    driver: driver.trim(),
    kind: kindOf(word),
    seconds: Number.parseInt(secondsRaw ?? '0', 10) || 0,
    laps: Number.parseInt(lapsRaw ?? '0', 10) || 0,
    reason: reason.trim(),
  };
}

/** A scored incident: a charge, with the context it was charged in. */
export interface TraceIncident {
  atGameSec: number;
  /** Points charged for this incident. Always > 0 — a zero charge is not an incident. */
  warnPts: number;
  rawPts: number | null;
  timeSkippedSec: number | null;
  maxOffTrackM: number | null;
  lap: number | null;
  lapDistM: number | null;
  /** The verdict line that preceded the breakdown, when there was one. */
  verdict: TraceVerdict | null;
}

/**
 * How many recent charges are kept for the widget's strip.
 *
 * Five is what fits on one line of a narrow panel at a glance, and a stint's
 * worth of history is not the point: the strip exists to show the *shape* of what
 * is costing the driver — three 0.25s in a row is a kerb they keep clipping, one
 * 1.0 is a single mistake — which the last few charges say as well as all of them.
 */
export const CHARGE_HISTORY = 5;

/**
 * How many charged LAP NUMBERS to remember.
 *
 * Only ever read to judge the lap that has just finished, so this needs to
 * outlive the trace's ~25 s lateness and nothing more. 64 is a couple of hours
 * of laps at any circuit LMU runs — long enough that the question can never
 * outrun the answer, small enough to stay a fixed cost in a 24-hour race.
 */
export const CHARGED_LAP_HISTORY = 64;

/** What the reader currently knows. */
export interface TraceLimitsState {
  /** Points accumulated since the last discharge. A derivation, not a reading. */
  points: number;
  /**
   * What each of the last {@link CHARGE_HISTORY} cuts was charged, **newest
   * first**. Cleared with {@link points} — a discharged penalty starts the whole
   * account again, and leaving the old amounts up would have the strip contradict
   * a total that had gone back to zero.
   */
  charges: number[];
  /**
   * Charges counted since the reader started, monotonic **within a session**.
   *
   * Exists so a caller can detect "a charge just landed" by comparing a single
   * integer, rather than diffing {@link points} — which is a float, moves in
   * quarters, and goes *down* on a discharge. A caller seeing this decrease is
   * looking at a session reset, not at a charge.
   */
  chargeSeq: number;
  /** The most recent charge, or `null` if nothing has been charged yet. */
  lastIncident: TraceIncident | null;
  /** The most recent named penalty, whatever kind. */
  lastPenalty: TracePenalty | null;
  /** Incidents seen since the last reset — the count the sim actually charged for. */
  charged: number;
  /**
   * The sim's own LAP NUMBER for each lap it has charged something to, newest
   * first, capped at {@link CHARGED_LAP_HISTORY}.
   *
   * This is what lets a lap be judged on its own cuts rather than on when the
   * news of them arrived. The trace reaches us up to ~25 s late, so a cut taken
   * at the end of a lap routinely lands while the NEXT one is being driven; a
   * caller watching {@link charged} move can only blame whichever lap was in
   * progress at the time, which is the wrong one twice over — the guilty lap
   * goes free and a clean one is voided. Every charge carries `Lap:` in the
   * trace, so the answer was always there to be read.
   *
   * A lap appears once however many times it was charged: callers ask whether a
   * lap was charged at all, never how often.
   */
  chargedLaps: number[];
  /**
   * How many excursions the sim has **ruled on** this session, charged or not.
   *
   * Distinct from {@link charged} because "ruled and charged nothing" is a verdict
   * too — and it is the one that tells us there is no longer anything outstanding.
   * A caller comparing this against its own excursion count can tell whether a cut
   * is still awaiting judgement, which matters because the sim's writes reach us up
   * to ~25 s late (a 4 KB log buffer; see the flush notes in
   * `docs/TRACK-LIMITS-POINTS.md`).
   */
  settled: number;
  /** The session these points belong to, in the sim's words (`"Race"`, `"Practice"`). */
  session: string | null;
}

/**
 * Accumulates parsed lines into a points total.
 *
 * Split from the file reading so it can be driven from fixture lines in
 * `scripts/test-tracelimits.js` without a sim, a trace file or a filesystem.
 */
export class TraceLimitsAccumulator {
  private points = 0;
  private charges: number[] = [];
  private chargedLaps: number[] = [];
  private chargeSeq = 0;
  private charged = 0;
  private settled = 0;
  private lastIncident: TraceIncident | null = null;
  private lastPenalty: TracePenalty | null = null;
  private session: string | null = null;
  /** The verdict line awaiting its breakdown — they arrive as a pair. */
  private pending: TraceLine | null = null;
  /** An explicit kind line awaiting the penalty line it describes. */
  private pendingKind: { atGameSec: number; kind: 'drive-through' | 'stop-go' } | null = null;

  /**
   * Whose penalty is this? `null` (the default) trusts every line, which is the
   * original single-player behaviour and what a fixture replay wants. A live
   * provider installs a predicate, because **penalty lines fire for other cars
   * too in multiplayer** — proven live 2026-08-20, when another driver's
   * pit-exit stop/go wrote a `Local penalty` line to this PC's trace. Without
   * the check, any rival's track-limits penalty zeroed OUR accumulated points,
   * which is exactly the "widget resets itself mid-race" bug drivers reported.
   *
   * Returning `false` drops the line entirely: no `lastPenalty`, no discharge.
   */
  public penaltyAttribution: ((pen: TracePenalty) => boolean) | null = null;

  /** Feed one raw line. Unrecognised lines are ignored. */
  public push(line: string): void {
    const ses = parseTraceSession(line);
    if (ses) {
      // A new session — including a race restart — starts the sim's count again.
      this.reset();
      this.session = ses.session;
      return;
    }

    // The wordy sources arrive in the same flush as the penalty line they
    // describe: the kind line BEFORE it (held until it lands), the steward
    // message AFTER it (applied retroactively).
    const kindLine = parseTraceKindLine(line);
    if (kindLine) {
      this.pendingKind = kindLine;
      return;
    }
    const steward = parseTraceSteward(line);
    if (steward) {
      const lp = this.lastPenalty;
      if (lp && Math.abs(lp.atGameSec - steward.atGameSec) <= KIND_PAIR_WINDOW_SEC) {
        lp.kind = steward.kind;
        if (steward.seconds > 0) lp.seconds = steward.seconds;
        lp.driver = steward.driver;
        // Now that the message has named the driver, re-ask whose it was. A
        // "no" drops the record — it was a rival's penalty, and naming it on
        // our widget would tell the driver to serve something they don't owe.
        if (this.penaltyAttribution && !this.penaltyAttribution(lp)) {
          this.lastPenalty = null;
        }
      }
      return;
    }

    const pen = parseTracePenalty(line);
    if (pen) {
      const pk = this.pendingKind;
      if (pk && Math.abs(pk.atGameSec - pen.atGameSec) <= KIND_PAIR_WINDOW_SEC) {
        // The explicit wording outranks the numeric decode — words are harder
        // to misread than a positional field.
        pen.kind = pk.kind;
        this.pendingKind = null;
      }
      if (this.penaltyAttribution && !this.penaltyAttribution(pen)) return;
      // A multiplayer penalty for this car arrives as a Network + Local pair
      // with the same timestamp and name. The second of the pair only tops up
      // detail the first was missing; it is not a second penalty.
      const lp = this.lastPenalty;
      if (lp && lp.atGameSec === pen.atGameSec && lp.name === pen.name) {
        if (pen.kind && !lp.kind) {
          lp.kind = pen.kind;
          if (pen.seconds !== undefined) lp.seconds = pen.seconds;
        }
        return;
      }
      this.lastPenalty = pen;
      // Mirrors the XML, where `CurrentPoints` returns to 0 on the drive-through
      // that the accumulated points earned.
      if (TRACK_LIMIT_PENALTY.test(pen.name)) {
        this.points = 0;
        this.charged = 0;
        this.charges = [];
        // `chargedLaps` deliberately SURVIVES a discharge. Serving the
        // drive-through settles the account, not the history: a lap that was
        // cut was still cut, and clearing this would quietly hand a driver a
        // clean leaderboard time for the very lap that earned the penalty.
        // It is cleared only by a session reset (below), where the sim's lap
        // numbering starts again at 1 and stale entries would collide.
      }
      return;
    }

    const parsed = parseTraceLine(line);
    if (!parsed) return;

    // The breakdown line carries the charge; the verdict line before it carries
    // the lap and distance. Pair them rather than reporting half of each.
    if (parsed.warnPts === null) {
      if (parsed.verdict) this.pending = parsed;
      // A settled verdict — charged or not — means the sim has finished with that
      // excursion, so nothing is outstanding on its account any more.
      if (parsed.verdict === 'warning' || parsed.verdict === 'no-track-cut') {
        this.settled += 1;
      }
      return;
    }

    const pending = this.pending;
    this.pending = null;
    if (parsed.warnPts <= 0) return; // evaluated, charged nothing

    // ONLY a `Warning` verdict is a charge.
    //
    // Every excursion is evaluated twice: once the moment the car rejoins
    // (`Back On Track`), and again when the stewarding settles it (`Warning` or
    // `No Track Cut`). Both evaluations emit a breakdown line, and the first one is
    // provisional — it can read 3.75 where the settled verdict charges 0.25.
    //
    // Established against the session-end XML, which publishes both the charge and
    // the running total. For one race the XML lists 13 charges summing to exactly
    // 5.00 and the drive-through that followed; every one of them corresponds to a
    // `Warning` line in the trace, matching to the sampling interval
    // (XML `et=382.4` ↔ trace `16313.45s`, both 0.50), and NONE of the provisional
    // `Back On Track` figures appear in it at all. Counting those instead put the
    // total at 22 points against an allowance of 5.
    if (pending?.verdict !== 'warning') return;

    this.points = round2(this.points + parsed.warnPts);
    this.charged += 1;
    this.chargeSeq += 1;
    this.charges = [parsed.warnPts, ...this.charges].slice(0, CHARGE_HISTORY);
    // The verdict line carries the lap; the breakdown that pairs with it does
    // not always, hence the same fallback the incident below uses.
    const chargedLap = parsed.lap ?? pending?.lap ?? null;
    if (chargedLap !== null && !this.chargedLaps.includes(chargedLap)) {
      this.chargedLaps = [chargedLap, ...this.chargedLaps].slice(0, CHARGED_LAP_HISTORY);
    }
    this.lastIncident = {
      atGameSec: parsed.atGameSec,
      warnPts: parsed.warnPts,
      rawPts: parsed.rawPts,
      timeSkippedSec: parsed.timeSkippedSec,
      maxOffTrackM: parsed.maxOffTrackM,
      lap: parsed.lap ?? pending?.lap ?? null,
      lapDistM: parsed.lapDistM ?? pending?.lapDistM ?? null,
      verdict: pending?.verdict ?? null,
    };
  }

  public state(): TraceLimitsState {
    return {
      points: this.points,
      // Copied, not handed out: the caller puts this straight on a broadcast
      // frame, and the array here goes on being mutated by every later charge.
      charges: [...this.charges],
      chargeSeq: this.chargeSeq,
      lastIncident: this.lastIncident,
      lastPenalty: this.lastPenalty,
      charged: this.charged,
      chargedLaps: [...this.chargedLaps], // copied for the same reason as `charges`

      settled: this.settled,
      session: this.session,
    };
  }

  /**
   * New session, or a restart — the sim's total starts again and so does ours.
   *
   * The session NAME survives: it is set by the line that triggers the reset, and a
   * caller-driven reset has not learned a new one.
   */
  public reset(): void {
    this.points = 0;
    this.charges = [];
    this.chargedLaps = [];
    this.chargeSeq = 0;
    this.charged = 0;
    this.settled = 0;
    this.lastIncident = null;
    this.lastPenalty = null;
    this.pending = null;
    this.pendingKind = null;
  }
}

/** Float addition leaves 0.7500000000000001; the charges are quarter-points. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/*  Finding the log directory                                                 */
/* -------------------------------------------------------------------------- */

/** Where LMU keeps its logs, relative to a Steam library root. */
const LMU_LOG_SUFFIX = path.join('steamapps', 'common', 'Le Mans Ultimate', 'UserData', 'Log');

/** Steam's own record of where its libraries are. */
const LIBRARY_FOLDERS = path.join(
  'C:',
  'Program Files (x86)',
  'Steam',
  'steamapps',
  'libraryfolders.vdf',
);

/**
 * Locate LMU's log directory.
 *
 * `APEX_LMU_LOG_DIR` wins outright, for a non-Steam install, a relocated one, or a
 * copied-off trace being replayed. Otherwise Steam's `libraryfolders.vdf` is read
 * for every library root and the first one holding the game wins — the game is
 * frequently not on the same drive as Steam itself.
 *
 * Returns `null` when nothing is found, which is not an error: the caller degrades
 * to its own excursion counting.
 */
export function findLmuLogDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.APEX_LMU_LOG_DIR;
  if (override) return dirOrNull(override);

  const roots: string[] = [path.join('C:', 'Program Files (x86)', 'Steam')];
  try {
    const vdf = fs.readFileSync(LIBRARY_FOLDERS, 'utf8');
    for (const m of vdf.matchAll(/"path"\s*"([^"]+)"/g)) {
      const p = m[1];
      if (p) roots.push(p.replace(/\\\\/g, '\\'));
    }
  } catch {
    /* no Steam, or no read access — the default root may still be right */
  }

  for (const root of roots) {
    const dir = dirOrNull(path.join(root, LMU_LOG_SUFFIX));
    if (dir) return dir;
  }
  return null;
}

function dirOrNull(dir: string): string | null {
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Newest `trace_*.txt` in a directory, or `null` when there is none.
 *
 * By modification time rather than by the timestamp in the name: the name records
 * when the game *launched*, and a trace being actively written is the newest by
 * mtime — which, unlike the results XML, does advance as the game writes.
 */
export function newestTrace(dir: string): string | null {
  try {
    let best: { file: string; at: number } | null = null;
    for (const name of fs.readdirSync(dir)) {
      // `trace_<launch time>.txt` only. The game also keeps a plain `trace.txt`,
      // which is an EXIT-TIME COPY of the session that just finished — byte-identical
      // to the dated file, with the same mtime. That tie can win this comparison, and
      // then the reader is tailing a static copy of a session that has ended.
      if (!/^trace_.*\.txt$/i.test(name)) continue;
      const file = path.join(dir, name);
      const at = fs.statSync(file).mtimeMs;
      if (!best || at > best.at) best = { file, at };
    }
    return best ? best.file : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Tailing                                                                   */
/* -------------------------------------------------------------------------- */

/** How often to re-check which trace file is newest (ms). */
const RESCAN_INTERVAL_MS = 30_000;

/** Cap on bytes consumed per poll, so a huge catch-up cannot stall the frame. */
const MAX_READ_BYTES = 1 << 20;

/**
 * Cap on the one-off backfill read at startup — see {@link LmuTraceLimitsReader.backfill}.
 *
 * Generous, because it is read once and being short of the session's start is the
 * one failure that matters here. A five-hour trace ran to 5 MB.
 */
const MAX_BACKFILL_BYTES = 64 << 20;

/**
 * Tails the live trace file and accumulates the sim's track-limit charges.
 *
 * Best-effort throughout, in the manner of the other readers here: every failure
 * path leaves the state untouched and the caller falls back to its own counting,
 * because a track-limits readout is not worth taking the overlay down for.
 */
export class LmuTraceLimitsReader {
  private readonly accumulator = new TraceLimitsAccumulator();
  private dir: string | null = null;
  private file: string | null = null;
  private offset = 0;
  /** Trailing bytes of an unterminated line, held for the next read. */
  private carry = '';
  private lastScanAt = 0;
  private started = false;
  /** Whether the lines being pushed are a backfill replay, for the predicate. */
  private replaying = false;

  public constructor(private readonly verbose = false) {}

  /**
   * Install the "whose penalty is this?" check — see
   * {@link TraceLimitsAccumulator.penaltyAttribution}. The predicate's second
   * argument is `true` while the reader is REPLAYING history (the startup /
   * rotation backfill), where a caller's "did our own count just move" test has
   * no live counter behind it and unnamed penalties should be trusted the way
   * they always were.
   */
  public setPenaltyAttribution(fn: (pen: TracePenalty, replay: boolean) => boolean): void {
    this.accumulator.penaltyAttribution = (pen) => fn(pen, this.replaying);
  }

  public start(): void {
    this.dir = findLmuLogDir();
    this.started = true;
    if (!this.dir) {
      if (this.verbose) console.log('[trace] LMU log directory not found — track limits stay local.');
      return;
    }
    // Start at the END of the current file: the history in it belongs to earlier
    // sessions, and replaying it would credit the driver with old cuts.
    this.rescan(Date.now());
    if (this.verbose) console.log(`[trace] watching ${this.file ?? 'nothing yet'}`);
  }

  public stop(): void {
    this.started = false;
    this.file = null;
    this.offset = 0;
    this.carry = '';
    this.accumulator.reset();
  }

  /** New session or restart: the sim's own total goes back to zero, so ours does. */
  public reset(): void {
    this.accumulator.reset();
  }

  public state(): TraceLimitsState | null {
    if (!this.started || !this.dir) return null;
    return this.accumulator.state();
  }

  /**
   * Consume whatever the game has appended since the last call.
   *
   * Cheap by construction: a `stat` and a read of only the new bytes. The file
   * reaches several MB over a session and is never re-read.
   */
  public poll(nowMs: number = Date.now()): void {
    if (!this.started || !this.dir) return;
    if (nowMs - this.lastScanAt > RESCAN_INTERVAL_MS) this.rescan(nowMs);
    if (!this.file) return;

    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      this.file = null; // rotated away or deleted mid-session
      return;
    }

    // Truncated or replaced under us: start again from the top rather than
    // reading from an offset that now points into the middle of a line.
    if (size < this.offset) {
      this.offset = 0;
      this.carry = '';
    }
    if (size === this.offset) return;

    const prevOffset = this.offset;
    const from = Math.max(prevOffset, size - MAX_READ_BYTES);
    const length = size - from;
    let text: string;
    let fd: number | null = null;
    try {
      fd = fs.openSync(this.file, 'r');
      const buf = Buffer.alloc(length);
      const read = fs.readSync(fd, buf, 0, length, from);
      text = buf.subarray(0, read).toString('latin1');
    } catch {
      return; // held exclusively for a moment; try again next poll
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
    this.offset = size;

    // A read almost always lands mid-line. Everything up to the last newline is
    // complete; the remainder is held and prepended next time.
    //
    // Only when the read began exactly where the last one ended, though: if
    // MAX_READ_BYTES forced a skip forward, the held fragment is the tail of a
    // line we have now jumped past and joining it to the new text would fabricate
    // a line that was never written.
    const contiguous = from === prevOffset;
    if (!contiguous) this.carry = '';
    const combined = contiguous ? this.carry + text : text;
    const lastBreak = combined.lastIndexOf('\n');
    if (lastBreak === -1) {
      this.carry = combined;
      return;
    }
    this.carry = combined.slice(lastBreak + 1);
    for (const line of combined.slice(0, lastBreak).split('\n')) {
      if (line) this.accumulator.push(line.trimEnd());
    }
  }

  /** Re-pick the newest trace file; on a change, recover that session's total. */
  private rescan(nowMs: number): void {
    this.lastScanAt = nowMs;
    if (!this.dir) return;
    const newest = newestTrace(this.dir);
    if (!newest || newest === this.file) return;
    this.file = newest;
    this.carry = '';
    try {
      this.offset = fs.statSync(newest).size;
    } catch {
      this.offset = 0;
    }
    // Recover the total for the session already in progress. Starting cold at the
    // end of the file is right for OLD sessions and wrong for the current one:
    // restart the overlay four cuts into a race and the driver is shown 0 while the
    // stewards have them at 4.75, which is the one number on this widget that must
    // never flatter them.
    //
    // This applies to a rotation as much as to startup. A new trace file means the
    // game restarted, so nothing from the old one applies — but the driver may
    // already be several cuts into the new session by the time the rescan notices,
    // and seeking to the end would silently forgive every one of them. Backfill
    // resets first (the marker line does it), so the old total cannot leak through.
    this.backfill(newest);
  }

  /**
   * Replay the trace from the CURRENT session's start, so a mid-session restart of
   * the overlay recovers the running total instead of beginning at zero.
   *
   * Anchored on the sim's own `SessionName` marker, and only on the **last** one in
   * the file. Replaying further back would credit the driver with cuts from
   * practice, or from a race they have already restarted out of; if no marker is
   * found in the window, nothing is replayed and the total starts at zero, because
   * lines that cannot be attributed to this session are worse than no lines.
   */
  private backfill(file: string): void {
    // Unconditionally, before anything is read: on a rotation the accumulator still
    // holds the previous game's total, and if this file turns out to have no session
    // marker (or cannot be read at all) nothing below would clear it.
    this.accumulator.reset();

    let text: string;
    try {
      const size = fs.statSync(file).size;
      const from = Math.max(0, size - MAX_BACKFILL_BYTES);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(size - from);
        const read = fs.readSync(fd, buf, 0, size - from, from);
        text = buf.subarray(0, read).toString('latin1');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return; // unreadable: start at zero, as before
    }

    const marker = text.lastIndexOf('SessionName="');
    if (marker === -1) return;
    // Back up to the start of that line so the marker itself is parsed, and with it
    // the session's name.
    const lineStart = text.lastIndexOf('\n', marker) + 1;
    this.replaying = true;
    try {
      for (const line of text.slice(lineStart).split('\n')) {
        if (line) this.accumulator.push(line.trimEnd());
      }
    } finally {
      this.replaying = false;
    }
    if (this.verbose) {
      const s = this.accumulator.state();
      console.log(
        `[trace] recovered ${s.points} point(s) from ${s.charged} cut(s) in the current ` +
          `${s.session ?? 'session'}`,
      );
    }
  }
}
