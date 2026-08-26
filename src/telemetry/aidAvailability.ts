/**
 * @file src/telemetry/aidAvailability.ts
 * @module telemetry/aidAvailability
 *
 * Which in-cockpit MFD controls each car **class** actually has — the veto that
 * keeps a row off the widget when the car's own data stream claims otherwise.
 *
 * ## Why the live data is not enough
 * The aids are read as value/max byte pairs off the player's telemetry record,
 * and a `max` of 0 was taken as the whole availability story: "a GT3 simply
 * gets no such rows". That claim shipped and it was wrong, because LMU
 * populates some of those bytes from the car's **garage setup** whether or not
 * the cockpit has a control for them. Reported from a live GT3: both anti-roll
 * bar rows on the MFD, with ± that step a key the car ignores — a GT3's ARBs
 * are set on the setup screen and are not an in-car adjustment.
 *
 * The garage endpoint cannot arbitrate either, in either direction. The GT3
 * capture in `scripts/fixtures/garage-gt3.json` reports `VM_FRONT_ANTISWAY`
 * as `available` with 16 steps (true — as a SETUP item) on a car with no
 * cockpit ARB control, and `VM_ANTILOCKBRAKESYSTEMMAP` as a one-option "N/A"
 * on a car whose live ABS bytes read 9/9 in the same period. So availability
 * needs a third source: what the class's cars actually have on the wheel.
 *
 * ## The matrix, and where each cell comes from
 * LMU's classes split into two families for cockpit controls:
 *
 * - **Prototypes** (Hypercar, LMP2, LMP3): brake bias, TC map, TC power cut,
 *   motor map; no ABS (the cars do not run it — the live bytes get this right,
 *   verified by the phantom-ABS cursor bug reported from a live LMP2). Brake
 *   migration, the ARBs and regen are Hypercar controls: an LMP2 publishes
 *   ARB bytes exactly the way a GT3 does (caught live on an Oreca,
 *   2026-08-26 — bytes 762..765 carrying the garage's "D18 S-S"/"Detached"
 *   setup as 1/15 and 0/15) and has no cockpit lever behind them. The
 *   **TC slip** sub-map is not an LMP2 adjustment either (driver report,
 *   2026-08-26 — the row was shown and stepped nothing).
 * - **GT cars** (GT3, GT4, GTE): brake bias, TC map with both sub-maps, ABS,
 *   motor map; no brake migration, no ARBs, no regen (driver report,
 *   2026-08-26: ARB rows shown on a GT3 that has no such adjustment).
 *
 * The table below is a **veto list, not an allow list**, on purpose. For every
 * cell the live bytes already answer correctly, no entry is needed — and an
 * unknown class (a mod car, a future category) vetoes nothing, so it degrades
 * to today's behaviour rather than to an empty MFD. Only the cells where the
 * live data is PROVEN to lie are named, each with its provenance above.
 */

import { normalizeClass } from './carClass';

/**
 * The prototype trio + regen: cockpit controls no GT car has. On the GT
 * classes the ARB bytes mirror the garage setup (the proven lie this module
 * exists for); migration and regen are belt-and-braces — their sources already
 * report them absent on a GT car, but they fail the same way ARBs did if LMU
 * ever mirrors them too.
 */
const NOT_ON_GT: readonly string[] = ['brakeMigration', 'frontARB', 'rearARB', 'regen'];

/**
 * Aids each canonical class does NOT have in the cockpit, however the data
 * stream answers. Keys are {@link module:telemetry/carClass} canonical labels;
 * values are aid keys as `projectAids` emits them.
 *
 * The LMP2 cells carry the slip veto (driver report) and the ARB veto (caught
 * live on an Oreca publishing its garage ARB setup as aid bytes, exactly the
 * GT3 lie). Migration and regen are left to the live/REST guards on the P2s —
 * both read absent on the live Oreca (bytes 760/761 zero, REST regen a
 * one-option "0%") — and LMP3 carries no veto at all: its hardware is not the
 * Oreca's, the bytes have not been caught lying there, and vetoing a control
 * a car does have is the worse failure. If a live LMP3 shows a row that steps
 * nothing, add the cell here with that report as provenance.
 */
const CLASS_VETO: Readonly<Record<string, ReadonlySet<string>>> = {
  GT3: new Set(NOT_ON_GT),
  GT4: new Set(NOT_ON_GT),
  GTE: new Set(NOT_ON_GT),
  LMP2: new Set(['tcSlip', 'frontARB', 'rearARB']),
  LMP2_ELMS: new Set(['tcSlip', 'frontARB', 'rearARB']),
};

const NO_VETO: ReadonlySet<string> = new Set();

/**
 * The aid keys this class's cars cannot adjust from the cockpit.
 *
 * Takes the class as the frame carries it — raw or already canonical — and
 * normalises before the lookup, so callers can pass whatever spelling they
 * hold. An unknown, missing or mod class vetoes nothing: an unknown car is not
 * a car with no controls, which is the same judgement `selectAidRows` makes
 * when there is no live frame at all.
 */
export function aidsVetoedForClass(carClass: string | undefined | null): ReadonlySet<string> {
  const cls = normalizeClass(carClass);
  if (!cls) return NO_VETO;
  return CLASS_VETO[cls] ?? NO_VETO;
}
