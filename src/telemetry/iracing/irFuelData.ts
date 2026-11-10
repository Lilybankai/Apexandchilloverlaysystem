/**
 * @file src/telemetry/iracing/irFuelData.ts
 * @module telemetry/iracing/irFuelData
 *
 * iRacing's own fuel history: `Documents\iRacing\fueldata.ini`, which the sim
 * keeps per car and track across sessions —
 *
 *   [mx5\mx52016]
 *   winton\national=8,0.52,0.50,0.46,0.50,0.51,0.51,0.50,0.47,-1.00,-1.00	;
 *
 * `<laps recorded>, up to ten per-lap values (-1 = empty)`, in **kg per lap**
 * (checked 2026-11-10: M2 1.41 L/lap × 0.75 kg/L = 1.06, the file's mean). The
 * section is the car's `CarPath` with the space as a backslash; the key is the
 * track's internal `TrackName` likewise.
 *
 * It gives the fuel numbers a per-lap burn BEFORE the first lap of a session
 * has been timed — a prior, labelled as such, never mixed into the live
 * average the calculator measures.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** `mx5 mx52016` / `winton national` → the file's `mx5\mx52016` / `winton\national`. */
export const fuelDataKey = (s: string): string => s.trim().toLowerCase().replace(/[\s/]+/g, '\\');

/** Per-lap kg values by `car` → `track`. */
export function parseFuelData(text: string): Map<string, Map<string, number[]>> {
  const out = new Map<string, Map<string, number[]>>();
  let section: Map<string, number[]> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      const key = fuelDataKey(sec[1] as string);
      section = out.get(key) ?? new Map();
      out.set(key, section);
      continue;
    }
    const eq = line.indexOf('=');
    if (!section || eq < 0) continue;
    const vals = line
      .slice(eq + 1)
      .split(',')
      .map((v) => Number(v.trim()));
    // First number is the count of laps recorded; the rest are per-lap kg.
    const laps = vals.slice(1).filter((v) => Number.isFinite(v) && v > 0);
    if (laps.length) section.set(fuelDataKey(line.slice(0, eq)), laps);
  }
  return out;
}

/** The history for one car at one track, or `null`. */
export function fuelHistory(
  data: Map<string, Map<string, number[]>>,
  carPath: string,
  trackName: string,
  kgPerLitre: number,
): { perLapLiters: number; laps: number } | null {
  const laps = data.get(fuelDataKey(carPath))?.get(fuelDataKey(trackName));
  if (!laps || !laps.length || !(kgPerLitre > 0)) return null;
  const kg = laps.reduce((a, b) => a + b, 0) / laps.length;
  return { perLapLiters: Math.round((kg / kgPerLitre) * 1000) / 1000, laps: laps.length };
}

/** Where the file usually is (Documents, or OneDrive's redirected Documents). */
export function fuelDataCandidates(home = os.homedir()): string[] {
  return [
    path.join(home, 'Documents', 'iRacing', 'fueldata.ini'),
    path.join(home, 'OneDrive', 'Documents', 'iRacing', 'fueldata.ini'),
  ];
}

/**
 * Reads the file at most once per car/track change (a new session), so it
 * never costs the poll loop more than one small read per session.
 */
export class IrFuelHistory {
  private key = '';
  private result: { perLapLiters: number; laps: number } | null = null;

  public constructor(private readonly files: string[] = fuelDataCandidates()) {}

  public lookup(carPath: string, trackName: string, kgPerLitre: number): { perLapLiters: number; laps: number } | null {
    const key = `${carPath}|${trackName}|${kgPerLitre}`;
    if (key === this.key) return this.result;
    this.key = key;
    this.result = null;
    if (!carPath || !trackName) return null;
    for (const f of this.files) {
      try {
        const text = fs.readFileSync(f, 'latin1');
        this.result = fuelHistory(parseFuelData(text), carPath, trackName, kgPerLitre);
        if (this.result) break;
      } catch {
        /* not there — try the next */
      }
    }
    return this.result;
  }
}
