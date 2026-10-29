/**
 * scripts/test-coachvalidate.js — the coach's reply check
 * (supabase/functions/coach/validate.ts).
 * -----------------------------------------------------------------------------
 * validate.ts is plain TypeScript with no Deno APIs. It is transpiled here with
 * the repo's own TypeScript and run under Node (as test-engineer-guard.js does
 * for engineer/guard.ts), so the file checked is the file the function bundles.
 *
 *   1. parseReply: fences and chatter around the JSON
 *   2. a good reply passes, trimmed
 *   3. shape: 1–3 takeaways, strings, lengths
 *   4. ids: unknown facts, unknown corners (cited or named in the text)
 *   5. numbers: digits only from cited facts' text; number words refused;
 *      corner ids and known sectors are not numbers
 *   6. directions against facts' signs: braking, apex speed, throttle —
 *      advice and description both read the right way round
 *   7. setup, aids and rules refused
 *   8. the words around the model: the user turn holds every fact; the
 *      correction lists the reasons
 *   9. a template report from coachReport.ts, cited back, passes
 *
 * Run: npm run build && node scripts/test-coachvalidate.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function loadValidate() {
  const file = path.join(__dirname, '..', 'supabase', 'functions', 'coach', 'validate.ts');
  const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
    fileName: file,
  });
  const m = new Module(file);
  m._compile(out.outputText, file);
  return m.exports;
}

const V = loadValidate();

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const show = (v) => JSON.stringify(v);

const FACTS = [
  { id: 'C13.loss', cornerId: 'C13', kind: 'cornerLoss', value: 0.22, unit: 's', text: 'C13 costs 0.22 s a lap on average.' },
  { id: 'C13.brakeDeltaM', cornerId: 'C13', kind: 'brakeDeltaM', value: -5, unit: 'm', text: 'C13: you brake 5 m earlier than the target.' },
  { id: 'C13.minKphDelta', cornerId: 'C13', kind: 'minKphDelta', value: -4, unit: 'kph', text: 'C13: 4 km/h slower at the apex than the target.' },
  { id: 'C5.loss', cornerId: 'C5', kind: 'cornerLoss', value: 0.22, unit: 's', text: 'C5 costs 0.22 s a lap on average.' },
  { id: 'C5.brakeDeltaM', cornerId: 'C5', kind: 'brakeDeltaM', value: 7, unit: 'm', text: 'C5: you brake 7 m later than the target.' },
  { id: 'C5.minKphDelta', cornerId: 'C5', kind: 'minKphDelta', value: 3, unit: 'kph', text: 'C5: 3 km/h faster at the apex than the target.' },
  { id: 'C5.pickupDeltaM', cornerId: 'C5', kind: 'pickupDeltaM', value: -8, unit: 'm', text: 'C5: back on the throttle 8 m earlier than the target.' },
  { id: 'C12.loss', cornerId: 'C12', kind: 'cornerLoss', value: 0.21, unit: 's', text: 'C12 costs 0.21 s a lap on average.' },
  { id: 'C12.pickupDeltaM', cornerId: 'C12', kind: 'pickupDeltaM', value: 12, unit: 'm', text: 'C12: back on the throttle 12 m later than the target.' },
  { id: 'S3.loss', kind: 'sectorLoss', value: 0.32, unit: 's', text: 'Sector 3 is 0.32 s off your theoretical.' },
  { id: 'session.aimFor', kind: 'aimFor', value: 217.8, unit: 's', text: 'Aim for 3:37.8.' },
  { id: 'seq.C4-C5.loss', cornerId: 'C4', kind: 'sequenceLoss', value: 0.12, unit: 's', text: 'C4 and C5 trade time between them: drive them as one, 0.12 s lost over the whole sequence.' },
];

const GOOD = {
  headline: 'Braking into C13 is where your lap goes.',
  takeaways: [
    { title: 'Braking too early into C13', body: 'You brake early into C13 and arrive slow at the apex — brake later and carry more speed to the apex.', factIds: ['C13.loss', 'C13.brakeDeltaM', 'C13.minKphDelta'], cornerIds: ['C13'] },
    { title: 'Biggest gains in the final sector', body: 'Sector 3 is where the potential is; C12 is the main opportunity — get on the throttle sooner out of it.', factIds: ['S3.loss', 'C12.loss', 'C12.pickupDeltaM'], cornerIds: ['C12'] },
    { title: 'A target for the next run', body: 'Fix those corners and the aim is realistic.', factIds: ['session.aimFor'], cornerIds: [] },
  ],
  sequences: [{ cornerIds: ['C4', 'C5'], narrative: 'Treat C4 and C5 as one piece of road.', factIds: ['seq.C4-C5.loss'] }],
};
const clone = (v) => JSON.parse(JSON.stringify(v));
const verdict = (reply) => V.validateCoachReply(reply, FACTS);
const rejects = (name, mutate, want) => {
  const r = clone(GOOD);
  mutate(r);
  const v = verdict(r);
  const hit = !v.ok && (!want || v.reasons.some((x) => want.test(x)));
  check(name, hit, v.ok ? 'accepted' : v.reasons.join(' | '));
};
const accepts = (name, mutate) => {
  const r = clone(GOOD);
  mutate(r);
  const v = verdict(r);
  check(name, v.ok, v.ok ? undefined : v.reasons.join(' | '));
};

console.log('\n1) parseReply');
check('plain JSON', show(V.parseReply('{"a":1}')) === '{"a":1}');
check('fenced JSON', show(V.parseReply('```json\n{"a":1}\n```')) === '{"a":1}');
check('chatter around it', show(V.parseReply('Here you go: {"a":1} hope that helps')) === '{"a":1}');
check('garbage → null', V.parseReply('no json here') === null && V.parseReply('{bad') === null);

console.log('\n2) a good reply');
{
  const v = verdict(clone(GOOD));
  check('passes', v.ok, v.ok ? undefined : v.reasons.join(' | '));
  check('result keeps 3 takeaways and the sequence', v.ok && v.result.takeaways.length === 3 && v.result.sequences.length === 1);
}
accepts('sequences may be omitted', (r) => delete r.sequences);
accepts('lower-case corner ids are normalised', (r) => (r.takeaways[0].cornerIds = ['c13']));

console.log('\n3) shape');
check('not an object', !verdict('text').ok && !verdict(null).ok);
rejects('no takeaways', (r) => (r.takeaways = []), /1 to 3/);
rejects('four takeaways', (r) => r.takeaways.push(clone(r.takeaways[2])), /1 to 3/);
rejects('headline missing', (r) => (r.headline = ''), /headline missing/);
rejects('body too long', (r) => (r.takeaways[2].body = 'word '.repeat(80)), /body too long/);
rejects('factIds not a list', (r) => (r.takeaways[0].factIds = 'C13.loss'), /lists of strings/);
rejects('takeaway cites nothing', (r) => (r.takeaways[2].factIds = []), /cites no fact/);

console.log('\n4) ids');
rejects('unknown fact id', (r) => r.takeaways[0].factIds.push('C99.loss'), /unknown fact C99.loss/);
rejects('unknown corner in cornerIds', (r) => r.takeaways[0].cornerIds.push('C21'), /unknown corner C21/);
rejects('unknown corner named in the text', (r) => (r.takeaways[2].body = 'Look at C7 as well.'), /names C7/);

console.log('\n5) numbers');
rejects('a typed number no fact holds', (r) => (r.takeaways[0].body = 'Brake 10 m later into C13.'), /number 10/);
accepts('a number the cited fact holds', (r) => (r.takeaways[0].body = 'You brake 5 m early into C13: brake later.'));
rejects('a number from an UNcited fact', (r) => (r.takeaways[2].body = 'C12 costs 0.21 s.'), /number 0.21/);
accepts('the lap-clock aim from its cited fact', (r) => (r.takeaways[2].body = 'Aim for 3:37.8 next run.'));
rejects('a different lap clock', (r) => (r.takeaways[2].body = 'Aim for 3:37.5 next run.'), /3:37.5/);
rejects('number words', (r) => (r.takeaways[0].body = 'Brake five metres later into C13.'), /in words/);
accepts('"one" as a pronoun is not a number', (r) => (r.sequences[0].narrative = 'Treat C4 and C5 as one.'));
accepts('corner ids are not numbers', (r) => (r.takeaways[0].title = 'C13 first'));
accepts('a known sector is not a number', (r) => (r.takeaways[1].title = 'Sector 3 holds the gains'));
rejects('an unknown sector is', (r) => (r.takeaways[1].title = 'Sector 2 holds the gains'), /number 2/);
rejects('headline figures must come from a cited fact', (r) => (r.headline = 'You can find 0.9 s.'), /number 0.9/);
accepts('headline may use a figure cited below it', (r) => (r.headline = 'C13 costs 0.22 s a lap.'));

console.log('\n6) directions against the facts');
rejects('"brake later" where you already brake later (C5)', (r) => (r.takeaways[0] = { title: 'C5 entry', body: 'Brake later into C5.', factIds: ['C5.loss'], cornerIds: ['C5'] }), /contradicts C5.brakeDeltaM/);
accepts('"brake earlier" where you brake later (C5)', (r) => (r.takeaways[0] = { title: 'C5 entry', body: 'Brake a little earlier into C5.', factIds: ['C5.loss', 'C5.brakeDeltaM'], cornerIds: ['C5'] }));
rejects('"brake earlier" where you already brake early (C13)', (r) => (r.takeaways[0].body = 'Try braking earlier into C13.'), /contradicts C13.brakeDeltaM/);
rejects('description "you brake later" where you brake early (C13)', (r) => (r.takeaways[0].body = "You're braking later than the target into C13."), /contradicts/);
accepts('description "braking too early" where you brake early (C13)', (r) => (r.takeaways[0].body = 'You are braking too early into C13.'));
accepts('"losing time by braking early" (C13)', (r) => (r.takeaways[0].body = "You're losing time by braking early in C13."));
rejects('"carry more speed to the apex" where you are already faster (C5)', (r) => (r.takeaways[0] = { title: 'C5', body: 'Carry more speed to the apex of C5.', factIds: ['C5.loss'], cornerIds: ['C5'] }), /contradicts C5.minKphDelta/);
accepts('"more speed onto the straight" is not about the apex', (r) => (r.takeaways[0] = { title: 'C5', body: 'Take more speed onto the straight after C5.', factIds: ['C5.loss'], cornerIds: ['C5'] }));
rejects('"throttle sooner" where you already pick up earlier (C5)', (r) => (r.takeaways[0] = { title: 'C5 exit', body: 'Get on the throttle sooner out of C5.', factIds: ['C5.loss'], cornerIds: ['C5'] }), /contradicts C5.pickupDeltaM/);
accepts('"throttle sooner" where you pick up late (C12)', (r) => (r.takeaways[1].body = 'Get on the throttle sooner out of C12.'));
rejects('a clause names its own corner: "brake later into C13, and later into C5" — C5 contradicts', (r) => (r.takeaways[0] = { title: 'Entries', body: 'Brake later into C13, and brake later into C5 too.', factIds: ['C13.loss', 'C5.loss'], cornerIds: ['C13', 'C5'] }), /C5.brakeDeltaM/);
accepts('...while each corner gets its own advice', (r) => (r.takeaways[0] = { title: 'Entries', body: 'Brake later into C13, but brake earlier into C5.', factIds: ['C13.loss', 'C5.loss'], cornerIds: ['C13', 'C5'] }));
accepts('no corner named: the item\'s corners take the advice', (r) => (r.takeaways[0].body = 'Brake later and carry more speed to the apex.'));
rejects('...and are held to it', (r) => (r.takeaways[0] = { title: 'Entry', body: 'Brake later and carry more speed to the apex.', factIds: ['C5.loss'], cornerIds: ['C5'] }), /contradicts/);

console.log('\n7) setup, aids, rules');
rejects('setup', (r) => (r.takeaways[0].body = 'A softer setup would help C13.'), /setup/);
rejects('brake bias', (r) => (r.takeaways[0].body = 'Move the brake bias for C13.'), /brake bias/);
rejects('tyre pressures', (r) => (r.takeaways[0].body = 'Check tyre pressures before C13.'), /pressures/);
rejects('track limits', (r) => (r.takeaways[1].body = 'Mind the track limits out of C12.'), /track limits/);
rejects('penalties', (r) => (r.headline = 'Avoid a penalty in C13.'), /penalty/);
rejects('traction control', (r) => (r.takeaways[1].body = 'Turn the TC down out of C12.'), /TC/i);
accepts('"kerb" is driving, not rules', (r) => (r.takeaways[1].body = 'Use more kerb on the exit of C12.'));

console.log('\n8) the words around the model');
{
  const u = V.userContent({ kind: 'session', context: { track: 'Le Mans', car: 'Oreca', carClass: 'LMP2', targetLabel: 'Session best' }, facts: FACTS });
  check('user turn lists every fact as "id | text"', FACTS.every((f) => u.includes(`${f.id} | ${f.text}`)));
  check('user turn has the context', /TRACK: Le Mans/.test(u) && /LMP2/.test(u));
  const c = V.correction(['takeaway 1 types the number 10, which no cited fact says']);
  check('correction lists the reasons', /number 10/.test(c) && /No numbers/.test(c));
  check('system prompt forbids numbers, setup and contradiction', /NEVER write a number/.test(V.COACH_SYSTEM) && /setup/.test(V.COACH_SYSTEM) && /contradict/.test(V.COACH_SYSTEM));
  check('schema requires the three keys', show(V.COACH_JSON_SCHEMA.schema.required) === show(['headline', 'takeaways', 'sequences']));
}

console.log('\n9) a template report, cited back');
{
  let R = null;
  try {
    R = require('../dist/telemetry/coachReport');
  } catch {
    R = null;
  }
  if (!R) {
    check('dist/telemetry/coachReport.js built', false, 'run npm run build');
  } else {
    const facts = [
      { id: 'C2.loss', cornerId: 'C2', kind: 'cornerLoss', value: 0.2, unit: 's', text: 'C2 costs 0.20 s a lap on average.' },
      { id: 'C2.brakeDeltaM', cornerId: 'C2', kind: 'brakeDeltaM', value: -8, unit: 'm', text: 'C2: you brake 8 m earlier than the target.' },
    ];
    const v = V.validateCoachReply(
      { headline: 'C2 is the corner.', takeaways: [{ title: 'Later into C2', body: 'Brake later into C2.', factIds: ['C2.loss', 'C2.brakeDeltaM'], cornerIds: ['C2'] }], sequences: [] },
      facts,
    );
    check('advice in the template\'s direction passes', v.ok, v.ok ? undefined : v.reasons.join(' | '));
    check('coachReport version is a number (cache key)', typeof R.COACH_REPORT_VERSION === 'number');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
