/**
 * @file src/server/pitCursor.ts
 * @module server/pitCursor
 *
 * The selected MFD row — the "where am I" for the four bindable controls (row
 * up, row down, value +, value −).
 *
 * ## Why this exists at all
 * Every other write in the app names its row outright (`FUEL RATIO:`), which is
 * fine for a dedicated button but does not scale: the MFD has ~25 adjustable
 * lines and nobody is binding twenty-five pairs of wheel buttons. The driver
 * wants what the in-game MFD gives them — scroll to FL TIRE, press +, get a new
 * medium — from two pairs of buttons, without the in-game MFD being on screen.
 * That needs one piece of state: which row the ± is currently aimed at.
 *
 * It lives here, in a module of its own, because THREE callers share it and none
 * of them owns the others: the Electron action registry (a wheel button or
 * global hotkey), the `/api/mfd/cursor` routes (the overlay widget showing the
 * highlight), and the widget's own clicks. The telemetry server runs in-process
 * inside Electron main, so a plain module-level value genuinely is shared state
 * between all three — no IPC, no round trip through the sim.
 *
 * ## One list, three sources, in the order the widget draws them
 * The cursor walks EVERY adjustable row the MFD shows, in exactly the order the
 * widget lays them out:
 *
 *   race →  the overlay's own rows (SERVE, PIT REQUEST)      RACE CONTROL
 *   pit  →  the sim's pit menu, verbatim                     PIT STRATEGY
 *   aid  →  the driving aids LMU has bound to a key          DRIVING AIDS
 *
 * A control that cannot be reached by ▲ ▼ is a control a driver cannot use, so
 * "adjustable but not walked" is a bug, not a design choice — the one deliberate
 * exception is the PENALTIES readout, which is a reading and has nothing to set.
 * Keeping this order identical to the widget's is not cosmetic either: a cursor
 * that jumps from the bottom of one group to the middle of another reads as the
 * highlight teleporting, which is how the previous split list felt.
 *
 * ## The cursor is anchored by KEY, not by index
 * The list is not a fixed shape: sim rows come and go with the car, the session
 * and the damage state (DAMAGE and DRIVER are not always there), and the aid
 * rows depend on what the driver has bound. An index alone silently slides onto
 * a different row when that happens — the driver scrolls to FL TIRE, the menu
 * changes shape, and the next + lands on a brake duct.
 *
 * So each row carries a section-scoped {@link MfdRow.key} (`pit:FL TIRE:`), that
 * key is the anchor, and the index is only the fallback for when the key is gone
 * (see {@link resolveIndex}). Scoping the key by section matters as much as the
 * name in it: the overlay's rows and the sim's are named in the same style, and
 * an unscoped name lets a lookup for one land on the other — which is precisely
 * how the highlight ended up on PIT REQUEST and a pit row at the same time.
 */

import { isAllFourTyreRow, projectTyreControl, type MfdController } from '../telemetry/mfdControl';

/** A pit row as LMU's `receivePitMenu` returns it. */
export interface PitMenuRow {
  name?: string;
  currentSetting?: number;
  settings?: Array<{ text?: string }>;
  /** The sim's own stable row id — how a write targets a row unambiguously. */
  'PMC Value'?: number;
}

/** Which part of the MFD a walked row belongs to. */
export type MfdSection = 'race' | 'pit' | 'aid';

/**
 * One row in the list the cursor walks, whatever it is underneath.
 *
 * The three sources have nothing in common mechanically — a pit row is a REST
 * write, an aid is a keystroke, SERVE is a small state machine — so they are
 * normalised to this before the cursor sees any of them. That is what lets
 * {@link moveCursor} and {@link stepSelected} stay ignorant of which is which,
 * and it is why adding a row to the widget can no longer forget to make it
 * reachable.
 */
export interface MfdRow {
  /** Stable, section-scoped identity: `race:SERVE:`, `pit:FL TIRE:`, `aid:tc`. */
  key: string;
  /** The row's name, in the sim's own style. */
  name: string;
  section: MfdSection;
  /** Its current value as text, when the source knows it. */
  text: string | null;
  /** Change it by one step. `dir` is ±1. */
  step: (dir: number) => Promise<{ ok: boolean; text?: string | null; error?: string }>;
}

/* ------------------------- the overlay's own rows ------------------------- */

/**
 * A row the OVERLAY owns rather than the sim: serving a penalty, requesting the
 * stop. Declared through {@link setRaceControlRows} rather than imported,
 * because applying one needs the MFD controller and the key sender, and this
 * module must not depend on either — it is walked by the Electron action
 * registry, by the HTTP routes and by the widget, and a dependency here would be
 * a cycle.
 */
export interface VirtualRow {
  /** Row name, in the sim's own style so the widget can key off it uniformly. */
  name: string;
  /** The options this row cycles, as display text. */
  options: string[];
  /** Which option is selected right now. */
  current: number;
  /**
   * Apply a new selection. Returns the option index actually in force
   * afterwards, which is not always the one asked for — a row whose action
   * failed stays where it was rather than lying about it.
   */
  apply: (next: number) => Promise<{ ok: boolean; applied: number; error?: string }>;
}

/** A driving aid as the cursor walks it: a label, a value, and ± by keystroke. */
export interface AidRow {
  /** The aid's stable id (`tc`), which the widget resolves its rows to as well. */
  id: string;
  label: string;
  /** Current value text, when there is one to show — aids are often estimates. */
  text: string | null;
  step: (dir: number) => Promise<{ ok: boolean; text?: string | null; error?: string }>;
}

let raceProvider: (() => VirtualRow[]) | null = null;
let aidProvider: (() => AidRow[]) | null = null;

/**
 * Register the overlay-owned race-control rows. Called once at server start;
 * passing `null` removes them, which is what a build without the MFD control
 * plane does.
 */
export function setRaceControlRows(provider: (() => VirtualRow[]) | null): void {
  raceProvider = provider;
}

/** Register the driving-aid rows. Same contract as {@link setRaceControlRows}. */
export function setAidRows(provider: (() => AidRow[]) | null): void {
  aidProvider = provider;
}

/** A provider's rows right now, or an empty list when it is absent or throws. */
function safely<T>(provider: (() => T[]) | null): T[] {
  if (!provider) return [];
  try {
    const rows = provider();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/**
 * The overlay-owned rows right now.
 *
 * Exported because the widget draws them from this rather than from a copy of
 * its own: the wheel buttons change them too, and a local copy would drift the
 * moment a driver used the buttons instead of the mouse.
 */
export function getRaceControlRows(): VirtualRow[] {
  return safely(raceProvider);
}

/** The driving-aid rows right now. */
export function getAidRows(): AidRow[] {
  return safely(aidProvider);
}

/* ------------------------------ list assembly ----------------------------- */

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function raceRow(v: VirtualRow): MfdRow {
  return {
    key: `race:${v.name}`,
    name: v.name,
    section: 'race',
    text: v.options[v.current] ?? null,
    step: async (dir) => {
      // Clamped, not wrapped. These rows have consequences at their ends —
      // SERVE's non-OFF options strip the whole stop back to no service — and
      // wrapping from the last option round to the first would let one extra
      // press on a blind control do something the driver was not reaching for.
      const next = clamp(v.current + (dir < 0 ? -1 : 1), 0, v.options.length - 1);
      const res = await v.apply(next);
      return { ok: res.ok, text: v.options[res.applied] ?? null, error: res.error };
    },
  };
}

function pitRow(r: PitMenuRow, controller: MfdController | null, text: string | null): MfdRow {
  const name = r.name ?? '';
  return {
    key: `pit:${name}`,
    name,
    section: 'pit',
    text,
    step: async (dir) => {
      if (!controller) return { ok: false, error: 'pit control unavailable' };
      // Targeted by `PMC Value` — the sim's own stable id — so the write cannot
      // land on a neighbouring row even if the menu re-ordered between the
      // cursor moving and the ± being pressed.
      const res = await controller.setPitRow(
        { pmcValue: r['PMC Value'], name },
        { delta: dir < 0 ? -1 : 1 },
      );
      if (!res.ok) return { ok: false, error: res.error ?? `HTTP ${res.status}` };
      // The controller reports the text, rather than this reading it back out of
      // the row's own settings: on a tyre row the applied index is into the
      // compounds that are actually selectable, which is not that list.
      return { ok: true, text: res.appliedText ?? null };
    },
  };
}

/** A pit row's value as the widget shows it. */
function pitRowText(r: PitMenuRow, tyres: ReturnType<typeof projectTyreControl>): string | null {
  // The all-four TIRES: row reads from the corners, not from itself — its own
  // setting says `Mixed Tyres` even when all four corners agree. Same reasoning
  // as projectPitMenu, and the two must not disagree.
  if (tyres && isAllFourTyreRow(r.name)) return tyres.currentText;
  const settings = Array.isArray(r.settings) ? r.settings : [];
  const cur = typeof r.currentSetting === 'number' ? r.currentSetting : 0;
  return settings[cur]?.text?.trim() ?? null;
}

function aidRow(a: AidRow): MfdRow {
  return {
    key: `aid:${a.id}`,
    name: a.label,
    section: 'aid',
    text: a.text,
    step: (dir) => a.step(dir < 0 ? -1 : 1),
  };
}

/**
 * Assembles the walked list from the sim's pit rows plus both providers.
 *
 * Built fresh on every call rather than cached, because every value in it has to
 * be as of *this* moment — the cursor asks for the rows and then immediately
 * reads or writes the selected one.
 */
export function composeRows(
  simRows: PitMenuRow[] | null | undefined,
  controller: MfdController | null,
): MfdRow[] {
  const rows: MfdRow[] = getRaceControlRows().map(raceRow);
  if (Array.isArray(simRows)) {
    const tyres = projectTyreControl(simRows);
    for (const r of simRows) {
      if (r && typeof r.name === 'string' && r.name) {
        rows.push(pitRow(r, controller, pitRowText(r, tyres)));
      }
    }
  }
  for (const a of getAidRows()) rows.push(aidRow(a));
  return rows;
}

/** {@link composeRows} against the sim's CURRENT menu. */
export async function buildRows(controller: MfdController): Promise<MfdRow[]> {
  const simRows = await controller.getPitRows().catch(() => null);
  return composeRows(simRows, controller);
}

/* ------------------------------- the cursor ------------------------------- */

/** Where the cursor is, as reported to the overlay. */
export interface PitCursorState {
  /** Index into the CURRENT list, or -1 when there is nothing to point into. */
  index: number;
  /**
   * The row's section-scoped key — the durable half of the cursor, and what the
   * widget matches its own rows against so it can never highlight two.
   */
  key: string | null;
  /** The row's name, for display and for logging. */
  name: string | null;
  /** Which group the selected row is in. */
  section: MfdSection | null;
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
let key: string | null = null;
let name: string | null = null;
let section: MfdSection | null = null;
let text: string | null = null;
let updatedAt = 0;

/**
 * The index the cursor currently points at within `rows`, re-locked onto the
 * remembered row when the list has changed shape underneath it. Returns -1 for
 * an empty list; otherwise always a valid index.
 *
 * The name is tried after the key purely to survive a row being renamed between
 * sections (a sim row the overlay later takes over, say) — it is a courtesy, and
 * it is scoped to the same section so it can never cross-match.
 */
export function resolveIndex(rows: MfdRow[]): number {
  if (!Array.isArray(rows) || rows.length === 0) return -1;
  if (key) {
    const found = rows.findIndex((r) => r.key === key);
    if (found >= 0) return found;
  }
  if (name && section) {
    const found = rows.findIndex((r) => r.section === section && r.name === name);
    if (found >= 0) return found;
  }
  return clamp(index, 0, rows.length - 1);
}

/** The cursor as it stands, without consulting a list. */
export function getCursor(): PitCursorState {
  return { index, key, name, section, text, updatedAt };
}

/** Points the cursor at `i` in `rows` and remembers that row's identity + value. */
function land(rows: MfdRow[], i: number): PitCursorState {
  const row = rows[i];
  index = i;
  key = row?.key ?? null;
  name = row?.name ?? null;
  section = row?.section ?? null;
  text = row?.text ?? null;
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
export function moveCursor(delta: number, rows: MfdRow[]): PitCursorState {
  const at = resolveIndex(rows);
  if (at < 0) return getCursor();
  const step = delta < 0 ? -1 : 1;
  return land(rows, (at + step + rows.length) % rows.length);
}

/** Points the cursor at an explicit row — by key, by name, or by index. */
export function selectRow(
  target: { key?: string; name?: string; index?: number },
  rows: MfdRow[],
): PitCursorState {
  if (!Array.isArray(rows) || rows.length === 0) return getCursor();
  if (target.key) {
    const found = rows.findIndex((r) => r.key === target.key);
    if (found >= 0) return land(rows, found);
  }
  if (target.name) {
    const found = rows.findIndex((r) => r.name === target.name);
    if (found >= 0) return land(rows, found);
  }
  if (typeof target.index === 'number' && Number.isFinite(target.index)) {
    return land(rows, clamp(Math.round(target.index), 0, rows.length - 1));
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

/** The message shown when there is nothing to walk at all. */
const NO_ROWS = 'MFD unavailable (not in a session?)';

/** Moves the cursor by `delta` rows against the CURRENT list. */
export async function moveCursorLive(
  delta: number,
  controller: MfdController,
): Promise<PitCursorResult> {
  const rows = await buildRows(controller);
  if (rows.length === 0) return { ...getCursor(), ok: false, error: NO_ROWS };
  moveCursor(delta, rows);
  return { ...getCursor(), ok: true };
}

/** Points the cursor at a named row against the CURRENT list. */
export async function selectRowLive(
  target: { key?: string; name?: string; index?: number },
  controller: MfdController,
): Promise<PitCursorResult> {
  const rows = await buildRows(controller);
  if (rows.length === 0) return { ...getCursor(), ok: false, error: NO_ROWS };
  selectRow(target, rows);
  return { ...getCursor(), ok: true };
}

/**
 * Steps the SELECTED row's value by `delta`, whatever kind of row it is.
 *
 * Re-anchors before writing: if the remembered row has gone, the cursor is now
 * sitting on whatever the index landed on, and the driver should be told which
 * row it actually changed rather than the one they last aimed at.
 */
export async function stepSelected(
  delta: number,
  controller: MfdController,
): Promise<PitCursorResult> {
  const rows = await buildRows(controller);
  if (rows.length === 0) return { ...getCursor(), ok: false, error: NO_ROWS };
  const at = resolveIndex(rows);
  const row = rows[at];
  if (!row) return { ...getCursor(), ok: false, error: 'no MFD row selected' };

  // The row the driver aimed at is GONE — the menu changed shape, or the sim
  // left the session and took the whole pit list with it. Re-anchor, but do NOT
  // act: {@link resolveIndex} falls back to an index, and an index into a list
  // that just lost twenty rows points at something arbitrary. It pointed at
  // SERVE, which clears the entire pit stop. A press that lands on a row the
  // driver did not choose is worse than a press that does nothing and says so.
  if (key && row.key !== key) {
    land(rows, at);
    return {
      ...getCursor(),
      ok: false,
      error: `that row is no longer in the menu — now on ${row.name}`,
    };
  }
  land(rows, at);

  const res = await row.step(delta);
  if (!res.ok) return { ...getCursor(), ok: false, error: res.error ?? 'row action failed' };
  // Record what it now reads, so the overlay's next cursor poll carries the new
  // value rather than the one it had before the press.
  if (res.text !== undefined) text = res.text;
  updatedAt = Date.now();
  return { ...getCursor(), ok: true };
}
