/**
 * @file src/server/pitCursor.ts
 * @module server/pitCursor
 *
 * The selected row of the pit menu — the "where am I" for the four bindable pit
 * controls (row up, row down, value +, value −).
 *
 * ## Why this exists at all
 * Every other pit write in the app names its row outright (`FUEL RATIO:`), which
 * is fine for a dedicated button but does not scale: the menu has ~20 rows and
 * nobody is binding twenty pairs of wheel buttons. The driver wants what the
 * in-game MFD gives them — scroll to FL TIRE, press +, get a new medium — from
 * two pairs of buttons, without the in-game MFD being on screen. That needs one
 * piece of state: which row the ± is currently aimed at.
 *
 * It lives here, in a module of its own, because THREE callers share it and none
 * of them owns the others: the Electron action registry (a wheel button or
 * global hotkey), the `/api/mfd/cursor` routes (the overlay widget showing the
 * highlight), and the widget's own clicks. The telemetry server runs in-process
 * inside Electron main, so a plain module-level value genuinely is shared state
 * between all three — no IPC, no round trip through the sim.
 *
 * ## The cursor is anchored by NAME, not by index
 * The pit menu is not a fixed list: rows come and go with the car, the session
 * and the damage state (DAMAGE and DRIVER are not always there). An index alone
 * silently slides onto a different row when that happens — the driver scrolls to
 * FL TIRE, the menu changes shape, and the next + lands on a brake duct. So the
 * name is the anchor and the index is only the fallback for when the name is
 * gone (see {@link resolveIndex}).
 */

import type { MfdController } from '../telemetry/mfdControl';

/** A row as far as the cursor cares — a name, and its value text if it has one. */
export interface CursorRow {
  name?: string;
  currentSetting?: number;
  settings?: Array<{ text?: string }>;
}

/** Where the cursor is, as reported to the overlay. */
export interface PitCursorState {
  /** Index into the CURRENT menu, or -1 when there is no menu to point into. */
  index: number;
  /** The row's name — the durable half of the cursor. */
  name: string | null;
  /**
   * The row's value text as of the last cursor operation.
   *
   * Carried so the overlay can show a change in the same beat as the button
   * press: it polls this endpoint anyway to move its highlight, and having the
   * new value ride along means it does not have to go and ask the sim what it
   * just told the sim to do.
   */
  text: string | null;
  /** `Date.now()` of the last move, so the widget can flash a fresh change. */
  updatedAt: number;
}

let index = 0;
let name: string | null = null;
let text: string | null = null;
let updatedAt = 0;

/**
 * The index the cursor currently points at within `rows`, re-locked onto the
 * remembered name when the menu has changed shape underneath it. Returns -1 for
 * an empty menu; otherwise always a valid index.
 */
export function resolveIndex(rows: CursorRow[]): number {
  if (!Array.isArray(rows) || rows.length === 0) return -1;
  if (name) {
    const found = rows.findIndex((r) => r.name === name);
    if (found >= 0) return found;
  }
  return Math.min(rows.length - 1, Math.max(0, index));
}

/** The cursor as it stands, without consulting a menu. */
export function getCursor(): PitCursorState {
  return { index, name, text, updatedAt };
}

/** A row's currently-selected option text, when the row carries its options. */
function rowText(row: CursorRow | undefined): string | null {
  if (!row || !Array.isArray(row.settings)) return null;
  const cur = typeof row.currentSetting === 'number' ? row.currentSetting : 0;
  return row.settings[cur]?.text ?? null;
}

/** Points the cursor at `i` in `rows` and remembers that row's name and value. */
function land(rows: CursorRow[], i: number): PitCursorState {
  index = i;
  name = rows[i]?.name ?? null;
  text = rowText(rows[i]);
  updatedAt = Date.now();
  return getCursor();
}

/**
 * Moves the cursor `delta` rows (−1 = up), wrapping at both ends.
 *
 * Wrapping rather than stopping because the driver is not looking at the widget
 * while they press it — they are holding a corner, and a button that silently
 * does nothing at the end of the list feels like a dropped input. Coming back
 * round to the top is unambiguous either way.
 */
export function moveCursor(delta: number, rows: CursorRow[]): PitCursorState {
  const at = resolveIndex(rows);
  if (at < 0) return getCursor();
  const step = delta < 0 ? -1 : 1;
  return land(rows, (at + step + rows.length) % rows.length);
}

/** Points the cursor at an explicit row — by name (preferred) or by index. */
export function selectRow(
  target: { name?: string; index?: number },
  rows: CursorRow[],
): PitCursorState {
  if (!Array.isArray(rows) || rows.length === 0) return getCursor();
  if (target.name) {
    const found = rows.findIndex((r) => r.name === target.name);
    if (found >= 0) return land(rows, found);
  }
  if (typeof target.index === 'number' && Number.isFinite(target.index)) {
    return land(rows, Math.min(rows.length - 1, Math.max(0, Math.round(target.index))));
  }
  return getCursor();
}

/* ----------------------------- live operations ---------------------------- */
/* The two things the bindable controls actually do. They live here rather than
 * in either caller because the HTTP route and the Electron action registry must
 * behave identically — a wheel button and a click on the widget are meant to be
 * the same act, and the surest way to keep them so is one implementation.      */

/** What a live cursor operation reports back. */
export interface PitCursorResult extends PitCursorState {
  ok: boolean;
  error?: string;
}

/** Moves the cursor by `delta` rows against the sim's CURRENT menu. */
export async function moveCursorLive(
  delta: number,
  controller: MfdController,
): Promise<PitCursorResult> {
  const rows = await controller.getPitRows();
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ...getCursor(), ok: false, error: 'pit menu unavailable (not in a session?)' };
  }
  moveCursor(delta, rows);
  return { ...getCursor(), ok: true };
}

/**
 * Steps the SELECTED row's value by `delta`.
 *
 * Targets the row by `PMC Value` — the sim's own stable id — having resolved it
 * from the cursor's name, so the write cannot land on a neighbouring row even if
 * the menu re-ordered between the cursor moving and the ± being pressed.
 */
export async function stepSelected(
  delta: number,
  controller: MfdController,
): Promise<PitCursorResult> {
  const rows = await controller.getPitRows();
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ...getCursor(), ok: false, error: 'pit menu unavailable (not in a session?)' };
  }
  const at = resolveIndex(rows);
  const row = rows[at];
  if (!row) return { ...getCursor(), ok: false, error: 'no pit row selected' };
  // Re-anchor first: if the remembered name has gone, the cursor is now sitting
  // on whatever the index landed on, and the driver should be told which row it
  // actually changed rather than the one they last aimed at.
  land(rows, at);
  const res = await controller.setPitRow(
    { pmcValue: row['PMC Value'], name: row.name },
    { delta: delta < 0 ? -1 : 1 },
  );
  if (!res.ok) return { ...getCursor(), ok: false, error: res.error ?? `HTTP ${res.status}` };
  // Record what it now reads, so the overlay's next cursor poll carries the new
  // value rather than the one it had before the press.
  const settings = Array.isArray(row.settings) ? row.settings : [];
  text = settings[res.applied ?? 0]?.text ?? null;
  updatedAt = Date.now();
  return { ...getCursor(), ok: true };
}
