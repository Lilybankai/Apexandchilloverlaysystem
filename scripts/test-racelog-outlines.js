/**
 * scripts/test-racelog-outlines.js — which bundled circuit a race was on.
 *
 * electron/racelog-outlines.js matches a results file's `<TrackCourse>` and
 * `<TrackLength>` to `data/trackmaps/`. The names do not always agree, so the
 * cases here are the ones that differ on Carl's PC (2026-10-19 census of
 * 1 043 results files), plus the layouts that share a venue and a length.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const outlines = require('../electron/racelog-outlines.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail !== undefined ? `  (${detail})` : ''}`);
}

const index = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'trackmaps', 'index.json'), 'utf8'));
const maps = index.maps;
const m = (track, len) => outlines.matchKey(maps, track, len);

check('exact name and length', m('Algarve International Circuit', 4635.3) === 'algarve-international-circuit-4640');
check('a results name the bundle words differently (ELMS vs WEC)',
  m('Silverstone Grand Prix Circuit - ELMS', 5869.2) === 'silverstone-grand-prix-circuit-wec-5870');
check('accents in the results name (the bundle dropped them)',
  m('Autódromo José Carlos Pace', 4273.2) === 'aut-dromo-jos-carlos-pace-aut-4270');
check('Le Mans, not the Mulsanne layout 0.5% shorter', m('Circuit de la Sarthe', 13624) === 'circuit-de-la-sarthe-13620');
check('and the Mulsanne layout when that is the race',
  m('Circuit de la Sarthe Mulsanne', 13560.9) === 'circuit-de-la-sarthe-mulsanne-13560');
check('Monza, not Curva Grande', m('Autodromo Nazionale Monza', 5780.6) === 'autodromo-nazionale-monza-5780');
check('Curva Grande, not Monza', m('Monza Curva Grande Circuit', 5745.1) === 'monza-curva-grande-circuit-5750');
check('Spa and Spa Endurance share a length; the name decides',
  m('Circuit de Spa-Francorchamps Endurance', 6981.6) === 'circuit-de-spa-francorchamps-endurance-6980'
  && m('Circuit de Spa-Francorchamps', 6981.6) === 'circuit-de-spa-francorchamps-6980');
check('Paul Ricard 1A-V2, not 1A 1% shorter', m('Paul Ricard - 1A-V2', 5758.3) === 'paul-ricard-1a-v2-5760');
check('no length (a provisional race): the name alone', m('Fuji Speedway', 0) === 'fuji-speedway-4540');
check('an unknown circuit draws nothing', m('Nürburgring Nordschleife', 20832) === null);
check('a known name at the wrong length draws nothing', m('Fuji Speedway', 9000) === null);
check('no track, no match', m('', 4635.3) === null && outlines.matchKey(null, 'Fuji Speedway', 4535.8) === null);

const dec = outlines.decorateList([
  { id: 'a', track: 'Fuji Speedway', trackLength: 4535.8 },
  { id: 'b', track: 'Fuji Speedway', trackLength: 4535.8 },
  { id: 'c', track: 'Nowhere Raceway', trackLength: 1000 },
]);
check('the list names each race’s circuit',
  dec.races[0].mapKey === 'fuji-speedway-4540' && dec.races[1].mapKey === 'fuji-speedway-4540');
check('one outline per circuit, however many races', Object.keys(dec.outlines).length === 1);
const o = dec.outlines['fuji-speedway-4540'];
check('the outline is a closed path in the 100 box',
  !!o && /^M[\d.]+ [\d.]+L/.test(o.d) && o.d.endsWith('Z') && o.view === 100);
check('a race with no circuit carries no key', !('mapKey' in dec.races[2]));
check('a log gets its outline', !!outlines.decorateLog({ track: 'Fuji Speedway', trackLength: 4535.8 }).outline);
check('a log with no circuit is left as it was',
  !('outline' in outlines.decorateLog({ track: 'Nowhere', trackLength: 1 })));

console.log(`\ntest-racelog-outlines: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
