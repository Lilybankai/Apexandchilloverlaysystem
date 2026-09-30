/**
 * @file src/telemetry/raceLogTypes.ts
 * @module telemetry/raceLogTypes
 *
 * The shapes the **race log** is made of, shared by everything that builds,
 * stores, serves and draws it. See `docs/RACE-LOG-PLAN.md`.
 *
 * ## The clock
 * Every event carries `et`: LMU's **session-elapsed seconds**. It is the one
 * clock the three sources agree on, and that was checked live on 2026-09-30.
 * The results XML stamps its stream in it, `getIncidentsList` reports in it,
 * and a loaded replay seeks in it (`replayStartET` read 0 on two replays). So
 * an event built from any source can drive the replay jump with no conversion.
 * `raceS` is `et` minus the green flag, and it is what a driver reads.
 *
 * ## Whose car
 * A log follows **one car**, identified by its **slot**: the number in the
 * XML's `Name(n)`, which the replay's standings use too. It is a car and not a
 * person. After a swap the standings name the driver in the seat, so a slot
 * is the only key that survives a team event.
 */

/** What an event is about. Drives the filter chips and the type column. */
export type RaceLogKind =
  | 'start' //    green flag, the grid slot
  | 'flag' //     yellows, FCY, red, restart, final lap (live recorder only)
  | 'lap' //      a completed lap and its verdict
  | 'position' // places gained or lost at the line
  | 'contact' //  touched another car or the scenery
  | 'damage' //   the car got worse
  | 'limits' //   a track-limits verdict
  | 'penalty' //  given, served, or converted at the flag
  | 'pit' //      in or out of the pit lane
  | 'driver' //   a driver swap on our car
  | 'finish'; //  chequered flag, or retirement

/** The HUD's own damage scale: `damageColourNone/Minor/Major/Critical` in the exe. */
export type DamageGrade = 'none' | 'minor' | 'major' | 'critical';

/** LMU's own contact wording, from the steward categories in the exe. */
export type ContactSeverity = 'light' | 'heavy';

/** Where an event came from. The XML wins wherever both have one. */
export type RaceLogSource = 'xml' | 'live';

export interface RaceLogEvent {
  /** Session-elapsed seconds. See the module header. */
  et: number;
  /** Seconds since the green flag; negative before it. */
  raceS: number;
  /** The lap being driven when it happened, 1-based. 0 before the start. */
  lap: number;
  kind: RaceLogKind;
  /** The finished sentence, e.g. `Contact with Peter Dempsey (#23)`. */
  text: string;
  source: RaceLogSource;
  /** Present on the kinds that carry it; absent otherwise. */
  detail?: RaceLogDetail;
}

/**
 * The structured half of an event, for the UI to style and for tests to
 * assert on without parsing `text`. Only the fields a kind uses are set.
 */
export interface RaceLogDetail {
  // position / start / finish
  position?: number;
  classPosition?: number;
  /** Places gained (+) or lost (−) since the previous line crossing. */
  gained?: number;
  classGained?: number;
  // lap
  lapMs?: number;
  /** The lap time was not counted: `--.----` or a track-limits invalidation. */
  invalid?: boolean;
  personalBest?: boolean;
  /** The fastest lap in our class so far. */
  classBest?: boolean;
  pitIn?: boolean;
  /**
   * Track-limits excursions on this lap that LMU judged "No Further Action".
   * Folded into the lap rather than logged one by one: a four-hour race has
   * ~140 of them.
   */
  excursions?: number;
  // contact
  /** The other car's slot; absent for scenery. */
  otherSlot?: number;
  otherName?: string;
  otherNumber?: string;
  /** `Immovable`, `Sign`, `Cone`, `Post`… when it was not a car. */
  scenery?: string;
  severity?: ContactSeverity;
  // damage
  grade?: DamageGrade;
  /** Human zone names: `front-left suspension`, `bodywork`, `engine`. */
  zones?: string[];
  // limits / penalty
  warningPoints?: number;
  pointsLimit?: number;
  verdict?: string;
  penaltyKind?: string;
  reason?: string;
  // finish
  status?: string;
}

/** One race's log, ready to draw. */
export interface RaceLog {
  /** The results file's basename, e.g. `2026_09_24_21_38_11-49R1.xml`. */
  id: string;
  track: string;
  /** Unix seconds: the XML's `<DateTime>`, the event start. */
  startedAt: number;
  /**
   * Our car. `null` when nothing identified it: `events` is then empty and
   * {@link RaceLog.cars} lists the field for "Which car was yours?".
   */
  slot: number | null;
  carNumber: string;
  carClass: string;
  vehicle: string;
  /** Every name that drove the car, in stint order. */
  drivers: string[];
  /** `et` of the green flag. */
  greenEt: number;
  gridPosition: number | null;
  gridClassPosition: number | null;
  finishPosition: number | null;
  finishClassPosition: number | null;
  finishStatus: string;
  laps: number;
  /** More than one class on track: say both positions. */
  multiclass: boolean;
  /**
   * How our car was picked out of the file. `'live'`: there is no file; the
   * live recorder followed our car itself (a `provisional` log).
   */
  matchedBy: 'laplog' | 'name' | 'picked' | 'live' | null;
  /** Built from the live log alone: the game never wrote results. */
  provisional: boolean;
  events: RaceLogEvent[];
  /** Every car in the file, for the car picker. */
  cars?: RaceLogCar[];
}

/** One car in a results file, as the car picker lists it. */
export interface RaceLogCar {
  slot: number;
  carNumber: string;
  carClass: string;
  vehicle: string;
  /** Every name that drove it, in stint order. */
  drivers: string[];
  finishPosition: number | null;
  finishClassPosition: number | null;
}

/** One row of the race list. */
export interface RaceLogSummary {
  id: string;
  track: string;
  startedAt: number;
  carClass: string | null;
  finishPosition: number | null;
  finishClassPosition: number | null;
  contacts: number;
  penalties: number;
  /** null until our car has been found in the file. */
  slot: number | null;
  provisional: boolean;
}

/** What the replay jump is doing, for the button and its status line. */
export type ReplayPhase =
  | 'idle'
  | 'unavailable' //  no replay pairs with this race (the game kept 5 and moved on)
  | 'blocked' //      a live session is running: never pull the driver out
  | 'loading' //      waiting for GSTATE_DYN
  | 'ready' //        loaded; a jump is focus + seek
  | 'error';

export interface ReplayStatus {
  phase: ReplayPhase;
  /** The race whose replay is loaded or loading. */
  raceId: string | null;
  /** 0..1 while loading, from `loadingStatus.percentage`. */
  progress: number | null;
  message: string | null;
}
