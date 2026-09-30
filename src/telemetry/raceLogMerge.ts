/**
 * @file src/telemetry/raceLogMerge.ts
 * @module telemetry/raceLogMerge
 *
 * Joins the **live** race log (`raceLogRecorder.ts`) to the one built from the
 * results XML, or stands in for it when the game crashed and wrote none. Pure:
 * no IO, testable against hand-built logs. Phase 2 of `docs/RACE-LOG-PLAN.md`.
 *
 * ## Who wins
 * The XML is authoritative for everything it has: laps, positions, limits,
 * penalties, pit stops, swaps, the start, the finish, and contacts (it names
 * both cars and the strength). The live log adds what the XML never carries:
 * flags, and our damage graded on the HUD's scale. A live contact survives only
 * when no XML contact with the same other car lies within
 * {@link CONTACT_MATCH_S}: the live list polls every 2 s and names no strength,
 * so where both saw it the XML's row is the better one.
 *
 * Damage is the other way round. The XML's only damage line is "New
 * suspension damage" (or engine), with no corner and no grade; the live line
 * for the same hit names both. So an XML damage line is dropped when a live one
 * naming the same part lies within {@link DAMAGE_MATCH_S}, and kept when none
 * does (a hit the 3 s damage poll missed, or no live log at all).
 *
 * ## Pairing a live race with its XML
 * Both stamp events in session `et`, but `et` restarts at every session, so it
 * cannot tell two Long Beach races apart; wall time must. The live header knows
 * the wall time at `et` 0 (`sessionStartMs`). The XML's file name is the local
 * time it was written, ~80 s after the chequered flag, and its last event is
 * the flag's `et`. So the XML should have been written at
 * `sessionStartMs + lastEt + ~80 s`, and a pair is accepted within
 * {@link PAIR_WINDOW_MS} of that, when the tracks agree or the green flags fall
 * at the same `et`. The window is wide because pausing an offline race stops
 * `et` and not the wall clock.
 */

import type { RaceLog, RaceLogEvent } from './raceLogTypes';
import type { LiveEvent, LiveRace } from './raceLogRecorder';
import { normName } from './raceLogRecorder';

/** A live contact and an XML contact with the same car this close are one contact, s. */
export const CONTACT_MATCH_S = 1.5;

/**
 * An XML damage line and a live one this close are one hit, s. The live one
 * polls the repair screen every 3 s, so it can trail the XML's by that much.
 */
export const DAMAGE_MATCH_S = 5;

/** How far the XML's write time may sit from where the live clock puts it, ms. */
export const PAIR_WINDOW_MS = 10 * 60_000;

/** The results file is written this long after the flag (measured ~80 s), ms. */
const XML_WRITE_LAG_MS = 80_000;

/** Green flags this close in `et` are the same start, s. */
const SAME_GREEN_S = 3;

/** The live kinds the XML cannot give. Everything else, the XML's word wins. */
const LIVE_ONLY = new Set<RaceLogEvent['kind']>(['flag', 'damage']);

/**
 * The race log with the live log folded in, or — `xml` null, the game never
 * wrote results — a `provisional` log from the live file alone.
 */
export function mergeLive(xml: RaceLog | null, live: LiveRace): RaceLog {
  if (!xml) return provisionalLog(live);

  const toEt = etMapper(live, xml.greenEt);
  const xmlContacts = xml.events.filter((e) => e.kind === 'contact');
  const added: RaceLogEvent[] = [];
  for (const e of live.events) {
    const et = toEt(e);
    if (LIVE_ONLY.has(e.kind)) {
      added.push(fromLive(e, et, xml.greenEt));
    } else if (e.kind === 'contact') {
      const seen = xmlContacts.some((x) => sameOther(x, e) && Math.abs(x.et - et) <= CONTACT_MATCH_S);
      if (!seen) added.push(fromLive(e, et, xml.greenEt));
    }
  }
  if (added.length === 0) return xml;
  const liveDamage = added.filter((e) => e.kind === 'damage');
  const kept = liveDamage.length ? xml.events.filter((x) => !coveredDamage(x, liveDamage)) : xml.events;
  // Stable by et: the XML's own order breaks ties, then live lines after it.
  const events = [...kept, ...added]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.et - b.e.et || a.i - b.i)
    .map((x) => x.e);
  return { ...xml, events };
}

/**
 * The live race that belongs to this XML, or `null`. See the module header for
 * the rule; the closest acceptable candidate wins.
 */
export function matchLiveRace(xml: RaceLog, races: readonly LiveRace[]): LiveRace | null {
  const written = writtenAt(xml.id);
  const lastEt = xml.events.reduce((m, e) => Math.max(m, e.et), xml.greenEt);
  let best: { race: LiveRace; off: number } | null = null;
  for (const race of races) {
    const trackOk = sameTrack(xml.track, race.header.track);
    const greenOk = race.greenEt !== null && Math.abs(race.greenEt - xml.greenEt) <= SAME_GREEN_S;
    if (!trackOk && !greenOk) continue;
    let off: number;
    if (written !== null) {
      off = Math.abs(written - (race.header.sessionStartMs + lastEt * 1000 + XML_WRITE_LAG_MS));
    } else {
      // No parsable file name: the XML's event start must precede the race we saw.
      const started = xml.startedAt * 1000;
      if (!trackOk || started > race.header.firstAt + 60_000) continue;
      off = race.header.firstAt - started;
    }
    if (off > PAIR_WINDOW_MS) continue;
    if (!best || off < best.off) best = { race, off };
  }
  return best ? best.race : null;
}

/**
 * The race from the live log alone. Everything the XML would have said is the
 * recorder's own reading of it; `provisional` tells the UI to say so.
 */
export function provisionalLog(live: LiveRace): RaceLog {
  const h = live.header;
  const greenEt = live.greenEt ?? h.firstEt ?? 0;
  const toEt = etMapper(live, greenEt);
  const events = live.events.map((e) => fromLive(e, toEt(e), greenEt));
  const start = live.events.find((e) => e.kind === 'start');
  const finish = live.events.find((e) => e.kind === 'finish');
  const drivers: string[] = h.driver ? [h.driver] : [];
  for (const e of live.events) {
    const m = e.kind === 'driver' ? /^Driver change: (.+) takes over/.exec(e.text) : null;
    if (m && m[1] && !drivers.includes(m[1])) drivers.push(m[1]);
  }
  const laps = live.events.reduce((n, e) => (e.kind === 'lap' ? Math.max(n, lapNumber(e.text)) : n), 0);
  return {
    id: `live-${Math.round(h.sessionStartMs / 1000)}`,
    track: h.track,
    startedAt: Math.round(h.sessionStartMs / 1000),
    slot: h.slot ?? -1,
    carNumber: h.carNumber ?? '',
    carClass: h.carClass ?? '',
    vehicle: '',
    drivers,
    greenEt,
    gridPosition: start?.detail?.position ?? null,
    gridClassPosition: start?.detail?.classPosition ?? null,
    finishPosition: finish?.detail?.position ?? null,
    finishClassPosition: finish?.detail?.classPosition ?? null,
    // No finish line: the recording just stops, which is what a crash looks like.
    finishStatus: finish?.detail?.status ?? 'Unknown',
    laps,
    multiclass: h.multiclass,
    matchedBy: 'live',
    provisional: true,
    events,
  };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function fromLive(e: LiveEvent, et: number, greenEt: number): RaceLogEvent {
  return {
    et,
    raceS: Math.round((et - greenEt) * 10) / 10,
    lap: e.lap,
    kind: e.kind,
    text: e.text,
    source: 'live',
    ...(e.detail ? { detail: e.detail } : {}),
  };
}

/**
 * A live event's `et`: its own, or — on a source with no session clock — its
 * wall time placed against the green flag, which both logs have.
 */
function etMapper(live: LiveRace, greenEt: number): (e: LiveEvent) => number {
  const anchorAt = live.greenAt ?? live.header.firstAt;
  const anchorEt = live.greenAt !== null ? greenEt : (live.header.firstEt ?? greenEt);
  return (e) => (e.et !== null ? e.et : Math.round((anchorEt + (e.at - anchorAt) / 1000) * 10) / 10);
}

/**
 * An XML damage line a live one already tells better: the same part (suspension
 * or engine), within {@link DAMAGE_MATCH_S}. Anything else in the XML stands.
 */
function coveredDamage(x: RaceLogEvent, live: readonly RaceLogEvent[]): boolean {
  if (x.kind !== 'damage') return false;
  const part = /\b(suspension|engine)\b/i.exec(x.text)?.[1]?.toLowerCase();
  if (!part) return false;
  return live.some((l) => {
    if (Math.abs(l.et - x.et) > DAMAGE_MATCH_S) return false;
    const zones = l.detail?.zones ?? [];
    return zones.some((z) => z.toLowerCase().includes(part)) || l.text.toLowerCase().includes(part);
  });
}

/** Same other party: the other car by name, number or slot, or the same scenery. */
function sameOther(x: RaceLogEvent, live: LiveEvent): boolean {
  const a = x.detail ?? {};
  const b = live.detail ?? {};
  if (a.scenery || b.scenery) return !!a.scenery && !!b.scenery;
  if (a.otherSlot !== undefined && b.otherSlot !== undefined) return a.otherSlot === b.otherSlot;
  if (a.otherName && b.otherName && normName(a.otherName) === normName(b.otherName)) return true;
  return !!a.otherNumber && a.otherNumber === b.otherNumber;
}

/**
 * The XML's file name is its local write time: `2026_09_24_21_38_11-49R1.xml`.
 * Local, because the game names it on this machine's clock.
 */
export function writtenAt(id: string): number | null {
  const m = /(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})/.exec(id);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const t = new Date(y, mo - 1, d, h, mi, s).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * REST's track name and the XML's are not always spelt alike, so: equal once
 * reduced to letters and digits, or one contains the other.
 */
export function sameTrack(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const y = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function lapNumber(text: string): number {
  const m = /^Lap (\d+)/.exec(text);
  return m && m[1] ? Number(m[1]) : 0;
}
