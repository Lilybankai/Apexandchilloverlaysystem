/**
 * tools/probe-lap-prediction.js — does LMU publish its own predicted lap count?
 * -----------------------------------------------------------------------------
 * The standings strip has to answer "how many more laps will THIS car run".
 * We can derive it (time left ÷ the car's pace), but if LMU already publishes a
 * prediction of its own, its number is the one to show: the in-game HUD shows a
 * predicted lap count, and an overlay disagreeing with the screen behind it is
 * worse than one that is merely approximate.
 *
 * The provider only TYPES the fields it consumes, so the type definitions in
 * lmuRestProvider.ts cannot answer this — the payload may well carry more. This
 * dumps the raw keys of both watch endpoints and prints anything whose name
 * mentions laps, so a field we have never read shows itself.
 *
 * Runs in ANY session type, practice included. Nothing here writes to the sim.
 *
 *   node tools/probe-lap-prediction.js
 */
'use strict';

const PORT = Number(process.env.LMU_PORT || 6397);
const BASE = `http://localhost:${PORT}`;

/** GET one endpoint as JSON, or null with the reason printed. */
async function get(path) {
  try {
    const res = await fetch(BASE + path, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      console.log(`  ${path} -> HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.log(`  ${path} -> ${e.message}`);
    return null;
  }
}

/** Every key path in an object, one level into arrays. */
function keyPaths(node, prefix = '', out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    if (node.length) keyPaths(node[0], prefix + '[0]', out);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.push([p, v]);
    if (v && typeof v === 'object') keyPaths(v, p, out);
  }
  return out;
}

/** Fields whose NAME suggests a lap count, a distance or a prediction. */
const INTERESTING = /lap|distance|remain|estimat|predict|maximum|total|finish|time/i;

(async () => {
  console.log(`\nProbing LMU REST at ${BASE}\n`);

  const si = await get('/rest/watch/sessionInfo');
  const standings = await get('/rest/watch/standings');

  if (!si && !standings) {
    console.log('\nNo response. Is LMU running, and are you in a session?');
    console.log('If the app talks to LMU on another port, set LMU_PORT.');
    process.exit(1);
  }

  if (si) {
    console.log('--- /rest/watch/sessionInfo : lap / time / distance fields ---');
    for (const [p, v] of keyPaths(si)) {
      if (typeof v === 'object' && v !== null) continue;
      if (INTERESTING.test(p)) console.log(`  ${p} = ${JSON.stringify(v)}`);
    }
    console.log('\n--- sessionInfo : EVERY top-level key (so a field we have never');
    console.log('    read cannot hide behind a name the filter did not guess) ---');
    console.log('  ' + Object.keys(si).join('\n  '));
  }

  if (Array.isArray(standings) && standings.length) {
    // The focused/player car if there is one, else the leader — either way one
    // real car, printed in full.
    const car =
      standings.find((c) => c.player || c.focus || c.hasFocus) ??
      standings.find((c) => c.position === 1) ??
      standings[0];
    console.log(`\n--- /rest/watch/standings : one car (${car.driverName ?? '?'},`);
    console.log(`    ${car.carClass ?? 'no class'}, P${car.position ?? '?'}) ---`);
    for (const [p, v] of keyPaths(car)) {
      if (typeof v === 'object' && v !== null) continue;
      if (INTERESTING.test(p)) console.log(`  ${p} = ${JSON.stringify(v)}`);
    }
    console.log('\n--- standings row : EVERY key ---');
    console.log('  ' + Object.keys(car).join('\n  '));

    // What the classes are and who leads each. In practice this is just who has
    // done most laps, which is all the strip needs to identify a class leader.
    const byClass = new Map();
    for (const c of standings) {
      const k = c.carClass || '(none)';
      const prev = byClass.get(k);
      if (!prev || (c.lapsCompleted | 0) > (prev.lapsCompleted | 0)) byClass.set(k, c);
    }
    console.log('\n--- classes on track, and the most laps run in each ---');
    for (const [k, c] of byClass) {
      console.log(
        `  ${k.padEnd(12)} laps=${c.lapsCompleted} best=${c.bestLapTime} est=${c.estimatedLapTime}`,
      );
    }
  } else {
    console.log('\nNo standings rows — the field has not loaded yet.');
  }

  console.log('\nDone. Paste the whole output back.\n');
})();
