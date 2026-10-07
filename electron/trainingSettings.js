/**
 * electron/trainingSettings.js — moving a widget from the race layer to training.
 * -----------------------------------------------------------------------------
 * Ghost HUD shipped as an ordinary in-game widget: its on/off switch lived in
 * `ingameOverlays` and its placement in `ingameLayout`, next to the race
 * widgets. It now belongs to the training layer, which keeps its own
 * `trainingOverlays` and `trainingLayout`.
 *
 * A driver who had switched it on and dragged it somewhere should find it on
 * and where they left it. So, once, the training widgets' entries are copied
 * out of the race maps and removed from them. "Once" is marked by
 * `trainingOverlays` existing in the stored config: every save after the first
 * load writes it, and a config that has it has been migrated.
 *
 * Pure, and it never mutates its input: config.json is read on every settings
 * call, and until the first save this runs again on each read with the same
 * result. scripts/test-training-settings.js pins it.
 */

'use strict';

/** A plain key/value object — not null, not an array. */
function isMap(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {object} stored  config.json as parsed (may be anything)
 * @param {string[]} ids   the training catalog's widget ids
 * @returns {object} the stored config with training entries moved across
 */
function migrateTrainingSettings(stored, ids) {
  if (!isMap(stored)) return stored;
  if (isMap(stored.trainingOverlays)) return stored;

  const raceOn = isMap(stored.ingameOverlays) ? stored.ingameOverlays : null;
  const raceLayout = isMap(stored.ingameLayout) ? stored.ingameLayout : null;

  const trainingOverlays = {};
  const trainingLayout = isMap(stored.trainingLayout) ? { ...stored.trainingLayout } : {};
  const ingameOverlays = raceOn ? { ...raceOn } : raceOn;
  const ingameLayout = raceLayout ? { ...raceLayout } : raceLayout;

  for (const id of ids) {
    if (raceOn && typeof raceOn[id] === 'boolean') trainingOverlays[id] = raceOn[id];
    if (raceLayout && raceLayout[id] && !(id in trainingLayout)) trainingLayout[id] = raceLayout[id];
    if (ingameOverlays) delete ingameOverlays[id];
    if (ingameLayout) delete ingameLayout[id];
  }

  const out = { ...stored, trainingOverlays, trainingLayout };
  if (ingameOverlays) out.ingameOverlays = ingameOverlays;
  if (ingameLayout) out.ingameLayout = ingameLayout;
  return out;
}

module.exports = { migrateTrainingSettings };
