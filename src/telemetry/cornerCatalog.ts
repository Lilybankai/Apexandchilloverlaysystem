/**
 * cornerCatalog.ts — stable corners per layout.
 *
 * STUB (2026-10-29): signatures only; claude/coach-catalog fills them in.
 * Until then every lap is cut by its reference, as before.
 */

import { findCorners, type CornerTrace } from './corners';
import type { CornerCatalog } from './coachContract';

/** The catalogue for a map key, or null when the layout has none. */
export function loadCornerCatalog(mapKey: string, dir?: string): CornerCatalog | null {
  void mapKey;
  void dir;
  return null;
}

export interface CornerSpan {
  id: string;
  entryD: number;
  apexD: number;
  exitD: number;
}

/** The corners to measure a lap by: the catalogue's when there is one, else the reference's own. */
export function cornersForLap(opts: {
  mapKey: string | null;
  trackLengthM: number;
  ref: CornerTrace;
  dir?: string;
}): { corners: CornerSpan[]; source: 'catalog' | 'reference'; catalog: CornerCatalog | null } {
  const found = findCorners(opts.ref, opts.trackLengthM);
  return {
    corners: found.map((c, i) => ({ id: `C${i + 1}`, entryD: c.entryD, apexD: c.apexD, exitD: c.exitD })),
    source: 'reference',
    catalog: null,
  };
}
