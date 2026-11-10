/**
 * @file src/telemetry/iracing/sessionInfo.ts
 * @module telemetry/iracing/sessionInfo
 *
 * The iRacing session-info YAML: decode, repair, parse, and reduce to the few
 * tables the provider needs.
 *
 * ## Why repair before parsing
 * iRacing writes names UNQUOTED (`UserName: Kindt, M`, `TeamName: …`), so any
 * name containing `: `, ` #`, a leading `*`/`&`/`!`/`'`, or one that looks like
 * `yes`, `null` or `0x10` either throws or changes type. Every established
 * reader works around it (pyirsdk force-quotes the name keys, node-irsdk quotes
 * TeamName). Here every free-text key we read is re-quoted with single quotes
 * before parsing, and the JSON schema is used so `Date: 2027-04-01` stays a
 * string and nothing is coerced by YAML 1.1 rules.
 *
 * ## Cost, measured (2026-11-10, the 134 revisions of capture ir-cap1)
 * The YAML is ~30–66 KB and is rewritten ~11×/min in a busy practice. Repair +
 * `js-yaml` JSON-schema parse of the whole document measured avg 1.7 ms,
 * max 3.2 ms warm (8.7 ms for the very first, cold-JIT parse). The server runs
 * on Electron's MAIN thread, so this module additionally (a) drops the big
 * sections we never read (CameraInfo, RadioInfo, CarSetup) before parsing, and
 * (b) {@link SessionInfoCache} debounces to at most one parse per second. With
 * a warm parse well under the ~8 ms budget a worker thread was not warranted
 * (the one-off cold cost is paid at start-up by {@link warmSessionInfoParser}) —
 * `scripts/test-iracing.js` re-measures this on every run and fails if the warm
 * maximum crosses 8 ms, which is the signal to move it off-thread.
 *
 * `js-yaml` is not a direct dependency of this package; it is a production
 * dependency of `electron-updater`, so it ships in the app. It is loaded lazily
 * and typed locally for that reason.
 */

import type { IrsdkSource } from './irsdk';

/* -------------------------------------------------------------------------- */
/*  Parsed shapes                                                             */
/* -------------------------------------------------------------------------- */

/** One `DriverInfo.Drivers[]` entry, reduced. */
export interface IrDriver {
  carIdx: number;
  userName: string;
  userId: number;
  teamName: string;
  /** Kept as a string: `"001"` and `"1"` are different numbers. */
  carNumber: string;
  carId: number;
  carScreenName: string;
  /** `CarPath` (`mx5 mx52016`) — the key of the car's folders and fueldata.ini. */
  carPath?: string;
  carClassId: number;
  /** `CarClassShortName` verbatim, e.g. `"GT3 Class"`, `"GTP"`, `"BMW M2 G87"`. */
  carClassShortName: string;
  /** `CarClassColor` as 0xRRGGBB, when present. */
  carClassColor?: number;
  /** `CarClassRelSpeed` — higher is a faster class. 0 when unknown. */
  carClassRelSpeed: number;
  /** `CarClassEstLapTime`, seconds; 0 when unknown. */
  carClassEstLapTime: number;
  /** `IRating`; 0 when hidden / AI. */
  iRating: number;
  /** `LicString`, e.g. `"B 1.41"`; `''` when absent. */
  licString: string;
  /** `LicColor` as `#rrggbb`, when present. */
  licColor?: string;
  isSpectator: boolean;
  isPaceCar: boolean;
  isAI: boolean;
}

/** One `ResultsPositions[]` entry, reduced. Positions 1-based (the YAML's
 *  ClassPosition is 0-based and is converted here). */
export interface IrResult {
  carIdx: number;
  position: number;
  classPosition: number;
  lapsComplete: number;
  fastestTime: number;
  lastTime: number;
  reasonOutId: number;
  reasonOutStr: string;
}

/** One `SessionInfo.Sessions[]` entry, reduced. */
export interface IrSession {
  num: number;
  /** `SessionType` verbatim (`Practice`, `Lone Qualify`, `Race`, …). */
  type: string;
  name: string;
  /** Lap count, `0` when unlimited. */
  laps: number;
  /** Scheduled length in seconds, `-1` when unlimited. */
  timeSec: number;
  results: IrResult[];
}

/** The reduced session info the provider works from. */
export interface IrSessionInfo {
  trackId: number;
  /** `TrackName`, the internal name (`"winton national"`). */
  trackInternalName: string;
  /** `TrackDisplayName`. */
  trackDisplayName: string;
  /** `TrackConfigName`, `''` when the track has none. */
  trackConfig: string;
  /** `TrackLength` in metres, 0 when unparseable. */
  trackLengthM: number;
  numCarClasses: number;
  official: boolean;
  eventType: string;
  teamRacing: boolean;
  subSessionId: number;
  driverCarIdx: number;
  paceCarIdx: number;
  driverCarFuelMaxLtr: number;
  /** `DriverCarFuelKgPerLtr` (fuel density); 0 when unpublished. */
  driverCarFuelKgPerLtr?: number;
  driverCarMaxFuelPct: number;
  driverCarRedLine: number;
  driverCarEstLapTime: number;
  /** `DriverTires[]` compound names by tyre index. */
  tires: string[];
  drivers: IrDriver[];
  sessions: IrSession[];
  currentSessionNum: number;
  /** `SplitTimeInfo.Sectors[].SectorStartPct`. */
  sectorStartPcts: number[];
  /**
   * `WeekendInfo.WeekendOptions.IncidentLimit` — the incident count that
   * disqualifies (17 in the 2026-11-10 official races). `0` when the session
   * has none (`unlimited`, practice, or absent).
   */
  incidentLimit: number;
}

/* -------------------------------------------------------------------------- */
/*  Decode + repair                                                           */
/* -------------------------------------------------------------------------- */

let decoder: { decode(b: Uint8Array): string } | null | undefined;

/**
 * Decode the raw YAML bytes. The YAML says `ISO_8859_1`, but the bytes are
 * Windows-1252 in practice (pyirsdk decodes cp1252). The five bytes cp1252
 * leaves undefined become spaces, and control characters other than tab/CR/LF
 * are stripped, as pyirsdk does.
 */
export function decodeSessionInfo(bytes: Uint8Array): string {
  if (decoder === undefined) {
    try {
      decoder = new TextDecoder('windows-1252');
    } catch {
      decoder = null;
    }
  }
  const text = decoder ? decoder.decode(bytes) : Buffer.from(bytes).toString('latin1');
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0081\u008d\u008f\u0090\u009d]/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** Free-text keys whose values are re-quoted before parsing. */
const TEXT_KEYS = [
  'UserName',
  'TeamName',
  'AbbrevName',
  'Initials',
  'DriverSetupName',
  'CarScreenName',
  'CarScreenNameShort',
  'CarClassShortName',
  'CarCfgName',
  'ClubName',
  'DivisionName',
  'FlairName',
  'TrackName',
  'TrackDisplayName',
  'TrackDisplayShortName',
  'TrackConfigName',
  'TrackCity',
  'TrackState',
  'TrackCountry',
  'SessionName',
  'SessionSubType',
  'ReasonOutStr',
  'LicString',
  'SeriesName',
  'SeasonName',
];
const TEXT_RE = new RegExp(`^(\\s*(?:- )?(?:${TEXT_KEYS.join('|')})): (.*)$`, 'gm');

/** Top-level sections the provider never reads — dropped before parsing. */
const DROP_SECTIONS = new Set(['CameraInfo', 'RadioInfo', 'CarSetup']);

/** Re-quote the free-text keys and drop unused sections. */
export function repairSessionYaml(text: string): string {
  // Split on top-level keys (column 0) and keep the sections we use.
  const lines = text.split('\n');
  const kept: string[] = [];
  let dropping = false;
  for (const line of lines) {
    if (/^[A-Za-z]\w*:/.test(line)) {
      const name = line.slice(0, line.indexOf(':'));
      dropping = DROP_SECTIONS.has(name);
    }
    if (!dropping) kept.push(line);
  }
  return kept.join('\n').replace(TEXT_RE, (m, k: string, v: string) => {
    const t = v.replace(/\r$/, '');
    if (t.startsWith("'") || t.startsWith('"')) return m;
    return `${k}: '${t.replace(/'/g, "''")}'`;
  });
}

/* -------------------------------------------------------------------------- */
/*  Parse + reduce                                                            */
/* -------------------------------------------------------------------------- */

interface JsYaml {
  load(src: string, opts?: { schema?: unknown }): unknown;
  JSON_SCHEMA: unknown;
}
let yamlLib: JsYaml | null | undefined;
function yaml(): JsYaml | null {
  if (yamlLib === undefined) {
    try {
      yamlLib = require('js-yaml') as JsYaml;
    } catch {
      yamlLib = null;
    }
  }
  return yamlLib;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** A number from a YAML scalar that may carry units (`"2.9455 km"`). */
function num(v: unknown, fallback = 0): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16);
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : fallback;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return fallback;
}
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v)).trim();

/** `0xRRGGBB` (string or already-parsed int) → number, or undefined. */
function hexColor(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v & 0xffffff;
  if (typeof v === 'string' && /^\s*0x[0-9a-f]+\s*$/i.test(v)) return parseInt(v.trim(), 16) & 0xffffff;
  return undefined;
}
const cssHex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

/**
 * Parse decoded session-info text into {@link IrSessionInfo}, or `null` when it
 * is not usable (parse error, no DriverInfo).
 */
export function parseSessionInfo(text: string): IrSessionInfo | null {
  const lib = yaml();
  if (!lib) return null;
  let doc: Obj;
  try {
    doc = obj(lib.load(repairSessionYaml(text), { schema: lib.JSON_SCHEMA }));
  } catch {
    return null;
  }
  const wi = obj(doc.WeekendInfo);
  const di = obj(doc.DriverInfo);
  const si = obj(doc.SessionInfo);
  if (!doc.DriverInfo) return null;

  const drivers: IrDriver[] = arr(di.Drivers).map((raw) => {
    const d = obj(raw);
    const color = hexColor(d.CarClassColor);
    const lic = hexColor(d.LicColor);
    return {
      carIdx: num(d.CarIdx, -1),
      userName: str(d.UserName),
      userId: num(d.UserID),
      teamName: str(d.TeamName),
      carNumber: str(d.CarNumber),
      carId: num(d.CarID),
      carScreenName: str(d.CarScreenName),
      ...(str(d.CarPath) ? { carPath: str(d.CarPath) } : {}),
      carClassId: num(d.CarClassID),
      carClassShortName: str(d.CarClassShortName),
      ...(color !== undefined ? { carClassColor: color } : {}),
      carClassRelSpeed: num(d.CarClassRelSpeed),
      carClassEstLapTime: num(d.CarClassEstLapTime),
      iRating: num(d.IRating),
      licString: str(d.LicString),
      ...(lic !== undefined ? { licColor: cssHex(lic) } : {}),
      isSpectator: num(d.IsSpectator) === 1,
      isPaceCar: num(d.CarIsPaceCar) === 1,
      isAI: num(d.CarIsAI) === 1,
    };
  });

  const sessions: IrSession[] = arr(si.Sessions).map((raw) => {
    const s = obj(raw);
    const lapsRaw = str(s.SessionLaps).toLowerCase();
    const timeRaw = str(s.SessionTime).toLowerCase();
    return {
      num: num(s.SessionNum, -1),
      type: str(s.SessionType),
      name: str(s.SessionName),
      laps: lapsRaw === 'unlimited' ? 0 : Math.max(0, Math.round(num(s.SessionLaps))),
      timeSec: timeRaw === 'unlimited' || timeRaw === '' ? -1 : num(s.SessionTime, -1),
      results: arr(s.ResultsPositions).map((rr) => {
        const r = obj(rr);
        return {
          carIdx: num(r.CarIdx, -1),
          position: num(r.Position),
          // The YAML's ClassPosition is 0-based; telemetry's is 1-based.
          classPosition: num(r.ClassPosition, -1) + 1,
          lapsComplete: num(r.LapsComplete),
          fastestTime: num(r.FastestTime, -1),
          lastTime: num(r.LastTime, -1),
          reasonOutId: num(r.ReasonOutId),
          reasonOutStr: str(r.ReasonOutStr),
        };
      }),
    };
  });

  const sectors = arr(obj(doc.SplitTimeInfo).Sectors)
    .map((s) => num(obj(s).SectorStartPct, NaN))
    .filter((n) => Number.isFinite(n));
  const tires = arr(di.DriverTires).map((t) => str(obj(t).TireCompoundType));

  return {
    trackId: num(wi.TrackID),
    trackInternalName: str(wi.TrackName),
    trackDisplayName: str(wi.TrackDisplayName) || str(wi.TrackName),
    trackConfig: str(wi.TrackConfigName),
    trackLengthM: Math.round(num(wi.TrackLength) * 1000),
    incidentLimit: Math.max(0, Math.round(num(obj(wi.WeekendOptions).IncidentLimit))),
    numCarClasses: num(wi.NumCarClasses, 1),
    official: num(wi.Official) === 1,
    eventType: str(wi.EventType),
    teamRacing: num(wi.TeamRacing) === 1,
    subSessionId: num(wi.SubSessionID),
    driverCarIdx: num(di.DriverCarIdx, -1),
    paceCarIdx: num(di.PaceCarIdx, -1),
    driverCarFuelMaxLtr: num(di.DriverCarFuelMaxLtr),
    driverCarFuelKgPerLtr: num(di.DriverCarFuelKgPerLtr),
    driverCarMaxFuelPct: num(di.DriverCarMaxFuelPct, 1),
    driverCarRedLine: num(di.DriverCarRedLine),
    driverCarEstLapTime: num(di.DriverCarEstLapTime),
    tires,
    drivers,
    sessions,
    currentSessionNum: num(si.CurrentSessionNum, 0),
    sectorStartPcts: sectors,
  };
}

/**
 * Load `js-yaml` and JIT the parse path once, off the frame loop.
 *
 * The first parse measured ~28 ms against ~1.3 ms for every later one: almost
 * all of it is loading the module and compiling the parser. Called from the
 * provider's `start()` so that cost lands at server start-up rather than in a
 * live poll the moment iRacing connects.
 */
export function warmSessionInfoParser(): void {
  try {
    parseSessionInfo(
      "---\nWeekendInfo:\n TrackName: x\n TrackLength: 1.0 km\nDriverInfo:\n DriverCarIdx: 0\n Drivers:\n - CarIdx: 0\n   UserName: A, B\n   CarClassColor: 0xffffff\n...\n",
    );
  } catch {
    /* warming is best-effort */
  }
}

/* -------------------------------------------------------------------------- */
/*  Cache                                                                     */
/* -------------------------------------------------------------------------- */

/** At most one parse per this many ms (see the module note). */
export const SESSION_INFO_MIN_INTERVAL_MS = 1000;

/**
 * Holds the latest good {@link IrSessionInfo}, re-parsing only when the sim's
 * `sessionInfoUpdate` counter moves and at most once per
 * {@link SESSION_INFO_MIN_INTERVAL_MS}. A failed parse keeps the last good one.
 */
export class SessionInfoCache {
  private info: IrSessionInfo | null = null;
  private parsedRev = -2;
  private lastParseAt = -Infinity;
  /** Duration of the most recent parse, ms — for diagnostics and the test. */
  public lastParseMs = 0;
  /** Longest parse seen, ms. */
  public maxParseMs = 0;
  /** Parses performed. */
  public parses = 0;

  public current(): IrSessionInfo | null {
    return this.info;
  }

  /** Forget everything (a disconnect). */
  public reset(): void {
    this.info = null;
    this.parsedRev = -2;
    this.lastParseAt = -Infinity;
  }

  /** Re-parse if the revision moved and the debounce allows. Never throws. */
  public update(source: IrsdkSource, nowMs: number): IrSessionInfo | null {
    try {
      const rev = source.sessionInfoUpdate();
      if (rev < 0 || rev === this.parsedRev) return this.info;
      // The first parse is immediate; later ones wait out the debounce.
      if (this.info !== null && nowMs - this.lastParseAt < SESSION_INFO_MIN_INTERVAL_MS) {
        return this.info;
      }
      const bytes = source.readSessionInfo();
      // Torn-read guard: the counter must not have moved while we copied.
      if (!bytes || source.sessionInfoUpdate() !== rev) return this.info;
      const t0 = process.hrtime.bigint();
      const parsed = parseSessionInfo(decodeSessionInfo(bytes));
      this.lastParseMs = Number(process.hrtime.bigint() - t0) / 1e6;
      if (this.lastParseMs > this.maxParseMs) this.maxParseMs = this.lastParseMs;
      this.parses++;
      this.lastParseAt = nowMs;
      this.parsedRev = rev;
      if (parsed) this.info = parsed;
    } catch {
      /* keep the last good parse */
    }
    return this.info;
  }
}
