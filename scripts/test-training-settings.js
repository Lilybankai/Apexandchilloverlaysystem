/**
 * scripts/test-training-settings.js — Ghost HUD moves out of the race maps.
 * -----------------------------------------------------------------------------
 * Ghost HUD's switch and placement used to live in `ingameOverlays` /
 * `ingameLayout` beside the race widgets. electron/trainingSettings.js moves
 * them to `trainingOverlays` / `trainingLayout`, once. Pinned here:
 *
 *   - a driver's choice (on, and where they dragged it) survives the move;
 *   - the race maps lose the training entries and keep everything else as-is;
 *   - it happens once: a config that already has `trainingOverlays` is left
 *     exactly alone, so a later choice is never overwritten from the race map;
 *   - the input is never mutated (main re-reads config.json on every call);
 *   - junk in, no throw.
 *
 * Run: node scripts/test-training-settings.js
 */

'use strict';

const { migrateTrainingSettings } = require('../electron/trainingSettings');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
}
const json = (v) => JSON.stringify(v);

const IDS = ['ghosthud'];

console.log('\ntraining settings: the one-time move');
{
  const stored = {
    httpPort: 17080,
    ingameOverlays: { standings: true, ghosthud: true, mfd: false },
    ingameLayout: {
      standings: { x: 24, y: 24, scale: 1, w: 560 },
      ghosthud: { x: 700, y: 480, scale: 1.2, w: 720 },
    },
  };
  const before = json(stored);
  const out = migrateTrainingSettings(stored, IDS);
  check('the switch moves across', out.trainingOverlays.ghosthud === true, json(out.trainingOverlays));
  check(
    'the placement moves across untouched',
    json(out.trainingLayout.ghosthud) === json({ x: 700, y: 480, scale: 1.2, w: 720 }),
    json(out.trainingLayout),
  );
  check('the race switch map loses it', !('ghosthud' in out.ingameOverlays));
  check('the race layout loses it', !('ghosthud' in out.ingameLayout));
  check(
    'every race widget is exactly as it was',
    json(out.ingameOverlays) === json({ standings: true, mfd: false }) &&
      json(out.ingameLayout) === json({ standings: { x: 24, y: 24, scale: 1, w: 560 } }),
  );
  check('unrelated settings ride through', out.httpPort === 17080);
  check('the stored object is not mutated', json(stored) === before);
}

{
  // The common case: never touched Ghost HUD. saveSettings writes every
  // default, so the race map carries an explicit `false`.
  const out = migrateTrainingSettings({ ingameOverlays: { ghosthud: false, delta: true } }, IDS);
  check('an off switch moves as off', out.trainingOverlays.ghosthud === false);
  check('no layout → an empty training layout', json(out.trainingLayout) === '{}');
}

{
  // Fresh install: nothing stored at all.
  const out = migrateTrainingSettings({}, IDS);
  check(
    'a fresh config gets empty training maps (defaults fill them later)',
    json(out.trainingOverlays) === '{}' && json(out.trainingLayout) === '{}',
  );
  check('and grows no race maps it did not have', !('ingameOverlays' in out) && !('ingameLayout' in out));
}

console.log('\ntraining settings: only once');
{
  const migrated = {
    ingameOverlays: { ghosthud: true }, // an older build wrote this back
    ingameLayout: { ghosthud: { x: 1, y: 1, scale: 1 } },
    trainingOverlays: { ghosthud: false },
    trainingLayout: { ghosthud: { x: 500, y: 400, scale: 1 } },
  };
  const out = migrateTrainingSettings(migrated, IDS);
  check('a migrated config is returned as-is', out === migrated);
  check('the training choice is never overwritten from the race map', out.trainingOverlays.ghosthud === false);

  const first = migrateTrainingSettings({ ingameOverlays: { ghosthud: true } }, IDS);
  const again = migrateTrainingSettings(first, IDS);
  check('running it on its own output changes nothing', json(again) === json(first));
}

{
  // A training layout entry already present (hand-edited, or half a migration)
  // wins over the race one.
  const out = migrateTrainingSettings(
    {
      ingameLayout: { ghosthud: { x: 1, y: 1, scale: 1 } },
      trainingLayout: { ghosthud: { x: 9, y: 9, scale: 1 } },
    },
    IDS,
  );
  check('an existing training placement is kept', out.trainingLayout.ghosthud.x === 9);
  check('the race copy is still removed', !('ghosthud' in out.ingameLayout));
}

console.log('\ntraining settings: junk');
{
  let threw = false;
  try {
    migrateTrainingSettings(null, IDS);
    migrateTrainingSettings(42, IDS);
    migrateTrainingSettings({ ingameOverlays: 'nope', ingameLayout: [1, 2] }, IDS);
    migrateTrainingSettings({ ingameOverlays: { ghosthud: 'yes' } }, IDS);
  } catch (e) {
    threw = true;
  }
  check('junk never throws', !threw);
  const out = migrateTrainingSettings({ ingameOverlays: { ghosthud: 'yes' } }, IDS);
  check('a non-boolean switch is not carried across', !('ghosthud' in out.trainingOverlays));
  check('null passes through', migrateTrainingSettings(null, IDS) === null);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
