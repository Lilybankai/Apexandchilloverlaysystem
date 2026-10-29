/**
 * cornerCatalogSnap.ts — a lap's corners, numbered by the layout's catalogue.
 * -----------------------------------------------------------------------------
 * `corners.ts findCorners()` cuts one lap into corners, and a single lap is not
 * a stable thing to number from: a corner that sits on a threshold (the
 * Daytona banking, the Le Mans kink at ~630 m, a double apex read as one bend
 * or two) comes and goes with the line taken, and every C-number after it
 * shifts. The catalogue (`data/corners/<mapKey>.json`, built offline by
 * `scripts/build-corner-catalog.js` from every clean dry lap of the layout)
 * holds the corners most laps agree on, with ids that do not move.
 *
 * This module snaps one lap onto it:
 *
 *   - the lap's own corners are paired with catalogue corners by nearest apex,
 *     within {@link SNAP_M}, one to one. A paired corner keeps the LAP's own
 *     entry / apex / exit — they are where this reference actually braked and
 *     turned — under the catalogue's id;
 *   - a catalogue corner the lap did not find (taken flat this time, merged
 *     into its neighbour) still gets a span: the catalogue's own;
 *   - a corner the lap found that the catalogue does not have (the kink that
 *     most laps do not read as a corner, a spin) is dropped.
 *
 * So the result is always exactly the catalogue's corners, in its order, and
 * `corners[k].id === 'C' + (k + 1)` — which is what lets every surface that
 * numbers by position (the overlay's Corner Analysis card, the Practice
 * panel) agree with every surface that reads the id.
 *
 * Neighbours never overlap afterwards (the time split across corners has to
 * add up): where a lap's own span runs into a catalogue span, the boundary is
 * put at the next corner's entry, or half way between the apexes if that
 * entry is before this apex.
 *
 * Without a catalogue (a layout with too few laps to vote), the lap's own
 * corners are numbered C1..Cn — the behaviour before the catalogue existed.
 *
 * Pure: no fs. `cornerCatalog.ts` loads the files.
 */

import { brakePoints } from './brakePoints';
import { BRAKE_SEARCH_M, findCorners, type Corner, type CornerTrace } from './corners';
import type { CornerCatalog } from './coachContract';

/** How far a lap's apex may sit from a catalogue apex and still be that corner, metres. */
export const SNAP_M = 40;

/** A corner of one lap, under its catalogue id (or C(index+1) without a catalogue). */
export interface IdCorner extends Corner {
  id: string;
}

/**
 * For each catalogue corner, the index of the found corner it pairs with, or
 * `null`. Pairs are made closest first, one to one, within {@link SNAP_M}.
 */
export function snapToCatalog(
  found: readonly { apexD: number }[],
  catalog: Pick<CornerCatalog, 'corners'>,
  lengthM: number,
): (number | null)[] {
  const L = lengthM > 0 ? lengthM : 1;
  const pairs: { c: number; f: number; m: number }[] = [];
  catalog.corners.forEach((cc, c) => {
    found.forEach((fc, f) => {
      const m = Math.abs(fc.apexD - cc.apexD) * L;
      if (m <= SNAP_M) pairs.push({ c, f, m });
    });
  });
  pairs.sort((a, b) => a.m - b.m || a.c - b.c);
  const out: (number | null)[] = catalog.corners.map(() => null);
  const taken = new Set<number>();
  for (const p of pairs) {
    if (out[p.c] !== null || taken.has(p.f)) continue;
    out[p.c] = p.f;
    taken.add(p.f);
  }
  return out;
}

/**
 * The corners to measure a lap by — see the file header. `found` may be
 * passed when the caller has already cut the lap, to save cutting it twice.
 */
export function catalogCorners(
  tr: CornerTrace | null | undefined,
  lengthM: number,
  catalog: CornerCatalog | null | undefined,
  found?: Corner[],
): IdCorner[] {
  const own = found ?? findCorners(tr, lengthM);
  if (!catalog || !Array.isArray(catalog.corners) || catalog.corners.length === 0) {
    return own.map((c, i) => ({ ...c, id: `C${i + 1}` }));
  }
  // No speed channel, no corners — as `findCorners`, so a lap the reference
  // could not be cut from is not given spans it cannot be scored over.
  if (!tr || !Array.isArray(tr.d) || tr.d.length < 2 || !Array.isArray(tr.speedKph) || !(lengthM > 0)) return [];

  const pairing = snapToCatalog(own, catalog, lengthM);
  const spans = catalog.corners.map((cc, k) => {
    const f = pairing[k];
    const src = f === null || f === undefined ? null : own[f]!;
    return {
      id: cc.id,
      entryD: src ? src.entryD : cc.entryD,
      apexD: src ? src.apexD : cc.apexD,
      exitD: src ? src.exitD : cc.exitD,
      src,
    };
  });
  // Lap order by apex: a paired apex can sit a few metres either side of the
  // catalogue's, never past a neighbour (they are further apart than SNAP_M).
  spans.sort((a, b) => a.apexD - b.apexD);
  for (let k = 0; k + 1 < spans.length; k += 1) {
    const a = spans[k]!;
    const b = spans[k + 1]!;
    if (a.exitD > b.entryD) {
      const cut = b.entryD > a.apexD ? b.entryD : (a.apexD + b.apexD) / 2;
      a.exitD = cut;
      b.entryD = Math.max(b.entryD, cut);
    }
  }

  const brakes = brakePoints(tr, lengthM);
  return spans.map((s) => {
    if (s.src && s.src.entryD === s.entryD && s.src.exitD === s.exitD) return { ...s.src, id: s.id };
    return spanCorner(tr, lengthM, s, brakes, s.src);
  });
}

/* -------------------------------- internals ------------------------------- */

/** A full `Corner` for a span the lap did not cut itself (or whose ends were moved). */
function spanCorner(
  tr: CornerTrace,
  L: number,
  s: { id: string; entryD: number; apexD: number; exitD: number },
  brakes: { d: number }[],
  src: Corner | null,
): IdCorner {
  const d = tr.d;
  const n = d.length;
  const at = (x: number): number => {
    // First sample at or past `x`, clamped into the trace.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (d[mid]! >= x) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  const entryI = at(s.entryD);
  const exitI = Math.max(entryI, at(s.exitD));
  const ai = at(s.apexD);
  const apexI = ai > 0 && Math.abs(d[ai - 1]! - s.apexD) < Math.abs(d[ai]! - s.apexD) ? ai - 1 : ai;

  if (src) {
    // The lap's own corner with an end moved off its neighbour: keep its apex.
    return { ...src, id: s.id, entryD: s.entryD, exitD: s.exitD, entryI, exitI };
  }

  const v = tr.speedKph;
  let minKph = Infinity;
  for (let i = entryI; i <= exitI && i < v.length; i += 1) if (v[i]! < minKph) minKph = v[i]!;
  if (!Number.isFinite(minKph)) minKph = v[Math.min(apexI, v.length - 1)] ?? 0;

  const lined =
    Array.isArray(tr.x) && Array.isArray(tr.z) && tr.x.length >= n && tr.z.length >= n;
  const lerp = (col: readonly number[]): number => {
    const i = at(s.apexD);
    if (i === 0 || d[i]! === d[i - 1]!) return col[i]!;
    const f = (s.apexD - d[i - 1]!) / (d[i]! - d[i - 1]!);
    return col[i - 1]! + (col[i]! - col[i - 1]!) * Math.max(0, Math.min(1, f));
  };

  const from = s.entryD - BRAKE_SEARCH_M / L;
  const bp = brakes.find((b) => b.d >= from && b.d <= s.apexD);

  return {
    id: s.id,
    entryD: s.entryD,
    apexD: s.apexD,
    exitD: s.exitD,
    apexX: lined ? round2(lerp(tr.x!)) : null,
    apexZ: lined ? round2(lerp(tr.z!)) : null,
    minKph: Math.round(minKph * 10) / 10,
    brakeD: bp ? bp.d : null,
    turnDeg: null,
    entryI,
    apexI,
    exitI,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
