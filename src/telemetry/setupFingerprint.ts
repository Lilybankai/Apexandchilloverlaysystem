/**
 * @file src/telemetry/setupFingerprint.ts
 * @module telemetry/setupFingerprint
 *
 * The setup fingerprint: one short hash that says "this tune", so a recorded
 * lap can be attributed to the setup it was actually driven on.
 *
 * Probed live (2026-08-11, Spa): `GET /rest/garage/getPlayerGarageData` keeps
 * answering through pit box, flying laps and the ESC monitor, and its values
 * stay FROZEN at the garage setup — on-track cockpit clicks to brake bias and
 * engine mixture never appear, and fuel reads the setup's litres while the
 * real tank burns down. So the fingerprint can be computed from that endpoint
 * at any point in a stint without racing the driver's thumb wheels.
 *
 * Some keys are excluded from the hash anyway — not because they drift on
 * track (they don't), but because drivers legitimately change them in the
 * GARAGE between stints without meaning "a different setup": fuel and virtual
 * energy for stint length, mixture and brake bias as session-start defaults
 * they immediately adjust from the wheel. A Spa race tune with 30 L is the
 * same tune with 90 L.
 */

import { createHash } from 'node:crypto';

/** Garage-editable per-stint keys that do not define the tune's identity. */
const EXCLUDED_KEYS = new Set([
  'VM_FUEL_LEVEL',
  'VM_VIRTUAL_ENERGY',
  'VM_ENGINE_MIXTURE',
  'VM_BRAKE_BALANCE',
]);

/**
 * Stable fingerprint of a tune in REST key space (VM_/WM_ key → step index) —
 * the same `values` map SetupLibraryEntry carries and getPlayerGarageData
 * projects to. Key order never matters; excluded keys never matter.
 * Returns '' for an empty/absent map (never a hash of nothing).
 */
export function fingerprintValues(values: Record<string, number> | null | undefined): string {
  if (!values) return '';
  const parts: string[] = [];
  for (const key of Object.keys(values).sort()) {
    if (EXCLUDED_KEYS.has(key)) continue;
    const v = values[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    parts.push(`${key}=${Math.round(v)}`);
  }
  if (parts.length === 0) return '';
  // 16 hex chars ≈ 64 bits: collisions are not a realistic concern across a
  // league's setup catalogue, and the short form reads well in logs.
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Fingerprint straight from the raw `getPlayerGarageData` payload. A setting
 * row is `{ value: number, maxValue: number, ... }` (the same shape
 * setupState's projectSetting keys on); anything else is skipped rather than
 * thrown on — the endpoint's shape is the sim's to change.
 */
export function fingerprintGarageData(garage: Record<string, unknown> | null | undefined): string {
  if (!garage) return '';
  const values: Record<string, number> = {};
  for (const [key, row] of Object.entries(garage)) {
    if (!/^(VM_|WM_)/.test(key)) continue;
    const r = row as { value?: unknown; maxValue?: unknown } | null;
    if (r && typeof r.value === 'number' && typeof r.maxValue === 'number') {
      values[key] = r.value;
    }
  }
  return fingerprintValues(values);
}
