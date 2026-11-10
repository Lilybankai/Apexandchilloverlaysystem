/**
 * The race engineer on iRacing, checked against REAL captures (plain node, run
 * with `npm run test:iracing-engineer` after a build).
 *
 * Every fixture is replayed through the iRacing provider and the engineer's
 * trigger engine exactly as the app runs them, and the calls it would have
 * made are checked for the moments that matter:
 *
 *  1. scripts/fixtures/iracing-cap1 — a lone qualify of 2 timed laps: the out
 *     lap call, the first timed lap's summary with ITS time (not the previous
 *     lap's) riding with "last lap of qualifying", and "that's your run" with
 *     the second lap's time; then the race start from the grid slot.
 *  2. scripts/fixtures/iracing-cap4-race — a 12-minute race: the start, the
 *     crash (settled incident steps, the meatball, the tow), the white flag,
 *     a late 4x and the chequer with the result against the grid.
 *  3. scripts/fixtures/iracing-cap2-dq — incidents to the 17x limit: one call
 *     per contact, the last-warning at 16, the DQ, and nothing after it.
 *  4. Scripted (no capture has one): a full-course caution — the caution call
 *     with the pits state, no position calls under it, pits open, one to
 *     green, the restart; and the race-control block's flag decoding.
 *  5. Phrase-list answers on iRacing frames (incidents, lap-limited laps left).
 *
 * Fixtures are cut by scripts/make-iracing-fixture.js (names anonymised).
 * `--log` prints every call with its time, for tuning.
 */
const path = require('path');
const dist = (m) => require(path.join(__dirname, '..', 'dist', 'telemetry', m));
const { CaptureSource } = dist('iracing/captureSource.js');
const { IRacingProvider } = dist('iracing/iracingProvider.js');
const { IrRaceControlReader } = dist('iracing/irRaceControl.js');
const { EngineerTriggers } = dist('triggers.js');
const { phraseForCue } = dist('engineerPhrases.js');
const { EngineerCommands } = dist('engineerCommands.js');

const LOG = process.argv.includes('--log');
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const fx = (name) => path.join(__dirname, 'fixtures', name);

/** Replay a capture; every cue with its time (s from the first frame), lead facts and words. */
function replay(dir, onFrame) {
  const src = new CaptureSource(dir);
  const p = new IRacingProvider({ verbose: false }, { source: src, lapSink: () => {} });
  p.start();
  const trig = new EngineerTriggers();
  const calls = [];
  let t0 = null;
  let lastNow = 0;
  while (!src.done()) {
    const t = src.peekTime();
    const now = Number.isFinite(t) ? t : lastNow + 100;
    lastNow = now;
    let fr;
    try {
      fr = p.poll(now, 100);
    } catch {
      continue;
    }
    if (t0 === null) t0 = now;
    if (!fr.connected) continue;
    if (onFrame) onFrame(fr, (now - t0) / 1000);
    const cue = trig.update(fr, now);
    if (!cue) continue;
    const call = {
      t: Math.round((now - t0) / 100) / 10,
      session: fr.session.type,
      kind: cue.kind,
      kinds: cue.triggers.map((x) => x.kind),
      facts: Object.assign({}, ...cue.triggers.slice().reverse().map((x) => x.facts)),
      byKind: Object.fromEntries(cue.triggers.map((x) => [x.kind, x.facts])),
      text: phraseForCue(cue, fr, 0) || '',
      position: cue.context.position,
    };
    calls.push(call);
    if (LOG) console.log(`        ${String(call.t).padStart(7)} [${call.session}] ${call.kinds.join('+')}: ${call.text}`);
  }
  return calls;
}

const has = (calls, kind, pred = () => true) => calls.filter((c) => c.kinds.includes(kind) && pred(c));

/* -------------------------------------------------------------------------- */
console.log('\n1) Lone qualify, 2 timed laps (iracing-cap1)');
{
  const calls = replay(fx('iracing-cap1'));
  const q = calls.filter((c) => c.session === 'qualifying');
  const out = has(q, 'qualiTimeLeft', (c) => c.byKind.qualiTimeLeft.verdict === 'outLap');
  check('out lap called once leaving the pits', out.length === 1 && /out lap/i.test(out[0].text), out.map((c) => `${c.t}s ${c.text}`).join(' | '));
  const lap1 = has(q, 'qualiLap', (c) => c.byKind.qualiTimeLeft && c.byKind.qualiTimeLeft.verdict === 'lastLapLimit');
  check('first timed lap summarised WITH "last lap of qualifying"', lap1.length === 1, lap1.map((c) => `${c.t}s ${c.text}`).join(' | ') || 'none');
  check('…with its own time (95.156), not a stale one', lap1[0] && Math.abs(lap1[0].byKind.qualiLap.lapSec - 95.156) < 0.01, lap1[0] && lap1[0].byKind.qualiLap.lapSec);
  check('…said as the last lap', lap1[0] && /last lap/i.test(lap1[0].text), lap1[0] && lap1[0].text);
  const done = has(q, 'qualiGrid');
  check('run over at the lap limit: one grid call ("that\'s your run")', done.length === 1 && done[0].byKind.qualiGrid.lapLimited === true && /your (run|lap)/i.test(done[0].text), done.map((c) => `${c.t}s ${c.text}`).join(' | '));
  check('…riding with the second lap (93.908, a PB)', done[0] && done[0].byKind.qualiLap && Math.abs(done[0].byKind.qualiLap.lapSec - 93.908) < 0.01, done[0] && JSON.stringify(done[0].byKind.qualiLap));
  check('…within 6 s of the line (no wait for the session to close)', done[0] && done[0].t - lap1[0].t > 60 && done[0].t < 946, done[0] && done[0].t);
  const start = has(calls, 'raceStart');
  check('race start from the grid slot (P2)', start.length === 1 && start[0].facts.startPosition === 2 && /P2/.test(start[0].text), start.map((c) => c.text).join(' | '));
  const bogusBlue = has(calls, 'yieldTo', (c) => start[0] && Math.abs(c.t - start[0].t) < 15);
  check('no "car a lap up" blue flag at the green', bogusBlue.length === 0, bogusBlue.map((c) => c.text).join(' | ') || 'none');
  check("LMU's track-limits call never fires on iRacing", has(calls, 'trackLimits').length === 0);
}

/* -------------------------------------------------------------------------- */
console.log('\n2) A race with a crash and a finish (iracing-cap4-race)');
{
  const calls = replay(fx('iracing-cap4-race'));
  const start = has(calls, 'raceStart')[0];
  check('race start called, grid slot P9', start && start.facts.startPosition === 9, start && start.text);
  const inc = has(calls, 'irIncident');
  check('the crash: one settled +2, then the +1 off track — not three calls', inc.length >= 2 && inc[0].byKind.irIncident.added === 2 && inc[1].byKind.irIncident.added === 1 && inc[1].byKind.irIncident.type === 'offTrack', inc.map((c) => `${c.t}s ${c.text}`).join(' | '));
  check('…said against the limit ("of 17")', inc[0] && /of 17/.test(inc[0].text), inc[0] && inc[0].text);
  const meat = has(calls, 'irRepair', (c) => c.byKind.irRepair.what === 'meatball');
  check('meatball called (box for repairs)', meat.length === 1 && /meatball/i.test(meat[0].text), meat.map((c) => `${c.t}s ${c.text}`).join(' | '));
  const tow = has(calls, 'irRepair', (c) => c.byKind.irRepair.what === 'tow');
  check('tow to the pits called with its length', tow.length === 1 && /two minutes/.test(tow[0].text), tow.map((c) => `${c.t}s ${c.text}`).join(' | '));
  check('meatball within 15 s of the first incident call', meat[0] && inc[0] && meat[0].t - inc[0].t < 15 && meat[0].t >= inc[0].t);
  const white = has(calls, 'finalLap');
  check('white flag = last lap, said as a white flag', white.length === 1 && /white flag/i.test(white[0].text), white.map((c) => `${c.t}s ${c.text}`).join(' | '));
  const late = has(calls, 'irIncident', (c) => c.byKind.irIncident.type === 'contact');
  check('late contact: "Plus four, contact — 7 of 17"', late.length === 1 && /Plus four, contact/.test(late[0].text) && /7 of 17/.test(late[0].text), late.map((c) => c.text).join(' | '));
  const flag = has(calls, 'checkered');
  check('chequered flag once, after the white flag', flag.length === 1 && white[0] && flag[0].t > white[0].t + 60, flag.map((c) => `${c.t}s ${c.text}`).join(' | '));
  check('…with the result P9 against the grid', flag[0] && flag[0].facts.position === 9 && flag[0].facts.startPosition === 9 && /P9/.test(flag[0].text), flag[0] && flag[0].text);
  check('no penalty or LMU limits calls in a clean race', has(calls, 'penalty').length === 0 && has(calls, 'trackLimits').length === 0);
  const blue = has(calls, 'yieldTo');
  check('blue flags never say "0.0 seconds"', blue.every((c) => !/0\.0 seconds/.test(c.text)), blue.map((c) => c.text).join(' | '));
}

/* -------------------------------------------------------------------------- */
console.log('\n3) Incidents to the 17x limit (iracing-cap2-dq)');
{
  const calls = replay(fx('iracing-cap2-dq'));
  const inc = has(calls, 'irIncident');
  const totals = inc.map((c) => c.byKind.irIncident.points);
  check('one call per incident step: 4, 8, 12, 16', JSON.stringify(totals) === '[4,8,12,16]', JSON.stringify(totals));
  const at16 = inc.find((c) => c.byKind.irIncident.points === 16);
  check('16 of 17 carries the last warning', at16 && at16.byKind.irIncident.warn === 'last' && /(one more|limit next time)/i.test(at16.text), at16 && at16.text);
  const at12 = inc.find((c) => c.byKind.irIncident.points === 12);
  check('12 of 17 (5 left) carries no warning', at12 && at12.byKind.irIncident.warn === undefined, at12 && at12.text);
  const dq = has(calls, 'penalty', (c) => c.byKind.penalty.flag === 'dq');
  check('the DQ is called, at 17 incidents', dq.length === 1 && /DQ/.test(dq[0].text) && /17/.test(dq[0].text), dq.map((c) => `${c.t}s ${c.text}`).join(' | '));
  check('nothing about incidents after the DQ', dq[0] && inc.every((c) => c.t < dq[0].t));
}

/* -------------------------------------------------------------------------- */
console.log('\n4) Caution (scripted) and the race-control block');
{
  // Flag decoding, raw SessionFlags → the block.
  const fake = (o) => ({ tick: 1, has: (n) => n in o, count: () => 1, num: (n) => (n in o ? +o[n] : NaN), bool: (n) => !!o[n] });
  const r = new IrRaceControlReader();
  const base = { IsOnTrack: 1, LapCompleted: 3, LapLastLapTime: 90, PitsOpen: 0, PlayerCarTowTime: 0 };
  const b1 = r.read(fake(base), 0x4000 | 0x200, 0, 17, true, 1000);
  check('caution + one-to-green decoded, pits closed', b1.caution && b1.oneLapToGreen && !b1.localYellow && b1.pitsOpen === false);
  const b2 = r.read(fake(base), 0x100, 0, 17, true, 1100);
  check('a waving yellow without caution is a local yellow', b2.localYellow && !b2.caution);
  const b3 = r.read(fake(base), 0x10000 | 0x100000 | 0x80000 | 0x2, 0, 17, true, 1200);
  check('black, meatball, furled and white decoded', b3.black && b3.meatball && b3.furled && b3.white && !b3.disqualified);
  const q = new IrRaceControlReader();
  const qb = q.read(fake({ ...base, LapCompleted: -1 }), 0, 2, 17, false, 0);
  check('out lap (-1) said apart from unknown', qb.outLap === true && qb.lapsCompleted === 0 && !qb.sessionDone);
  q.read(fake({ ...base, LapCompleted: 0, LapLastLapTime: 0 }), 0, 2, 17, false, 100);
  q.read(fake({ ...base, LapCompleted: 1, LapLastLapTime: 0 }), 0, 2, 17, false, 200);
  const held = q.read(fake({ ...base, LapCompleted: 1, LapLastLapTime: 0 }), 0, 2, 17, false, 1500);
  const landed = q.read(fake({ ...base, LapCompleted: 1, LapLastLapTime: 95.1 }), 0, 2, 17, false, 1700);
  check('a lap is counted only once its time lands', held.lapsCompleted === 0 && landed.lapsCompleted === 1, `${held.lapsCompleted} → ${landed.lapsCompleted}`);
  q.read(fake({ ...base, LapCompleted: 2, LapLastLapTime: 95.1 }), 0, 2, 17, false, 2000);
  const done = q.read(fake({ ...base, LapCompleted: 2, LapLastLapTime: 95.1 }), 0, 2, 17, false, 5100);
  check('…or after 3 s without one; the limit reached = run done', done.lapsCompleted === 2 && done.sessionDone === true);

  // A real race frame as the template, scripted through a caution.
  let template = null;
  replay(fx('iracing-cap4-race'), (fr, t) => {
    if (!template && fr.session.type === 'race' && fr.session.phase === 'green' && t > 160 && fr.iracing) template = fr;
  });
  check('found a green race frame to script from', !!template);
  if (template) {
    const trig = new EngineerTriggers();
    const T0 = template.timestamp;
    const said = [];
    const frameAt = (sec, o = {}) => {
      const f = JSON.parse(JSON.stringify(template));
      f.timestamp = T0 + sec * 1000;
      f.session.phase = o.caution ? 'fullCourseYellow' : 'green';
      f.session.flag = o.caution ? 'yellow' : 'none';
      f.session.currentLap = 4;
      f.iracing = { ...f.iracing, caution: !!o.caution, oneLapToGreen: !!o.oneToGreen, pitsOpen: o.pitsOpen !== false, localYellow: false, white: false, checkered: false };
      if (o.position !== undefined) {
        const me = f.standings.find((e) => e.isPlayer);
        const other = f.standings.find((e) => e.position === o.position);
        if (me && other && me !== other) {
          other.position = me.position;
          me.position = o.position;
          f.player.position = o.position;
        }
      }
      return f;
    };
    const run = (sec, o) => {
      const cue = trig.update(frameAt(sec, o), T0 + sec * 1000);
      if (cue) said.push({ t: sec, kinds: cue.triggers.map((x) => x.kind), text: phraseForCue(cue, null, 0), facts: cue.triggers[0].facts });
    };
    let s = 0;
    for (; s < 5; s += 0.2) run(s, {});
    for (; s < 25; s += 0.2) run(s, { caution: true, pitsOpen: false });
    for (; s < 45; s += 0.2) run(s, { caution: true, pitsOpen: false, position: 2 }); // the order shuffles under caution
    for (; s < 70; s += 0.2) run(s, { caution: true, pitsOpen: true, position: 2 });
    for (; s < 95; s += 0.2) run(s, { caution: true, pitsOpen: true, oneToGreen: true, position: 2 });
    for (; s < 110; s += 0.2) run(s, { position: 2 });
    if (LOG) for (const c of said) console.log(`        ${c.t.toFixed(1)} ${c.kinds.join('+')}: ${c.text}`);
    const cau = said.find((c) => c.kinds[0] === 'fullCourseYellow');
    check('caution called with the pace car and the pits closed', cau && /pace car/i.test(cau.text) && /Pits are closed/.test(cau.text), cau && cau.text);
    check('no position call under the caution', !said.some((c) => c.kinds.includes('positionChange') && c.t < 95), said.filter((c) => c.kinds.includes('positionChange')).map((c) => c.t).join(',') || 'none');
    const open = said.find((c) => c.kinds[0] === 'irCaution' && c.facts.what === 'pitsOpen');
    check('pits open called', open && /open/i.test(open.text), open && open.text);
    const otg = said.find((c) => c.kinds[0] === 'irCaution' && c.facts.what === 'oneToGreen');
    check('one to green called', otg && /one to green/i.test(otg.text), otg && otg.text);
    const re = said.find((c) => c.kinds[0] === 'restart');
    check('the restart is called', re && /green/i.test(re.text) && re.t >= 95, re && `${re.t}s ${re.text}`);
  }
}

/* -------------------------------------------------------------------------- */
console.log('\n5) Phrase-list answers on iRacing frames');
{
  let raceFrame = null;
  let outLapFrame = null;
  let lastLapFrame = null;
  replay(fx('iracing-cap1'), (fr) => {
    if (fr.session.type === 'qualifying' && fr.iracing && fr.iracing.outLap && !outLapFrame) outLapFrame = fr;
    if (fr.session.type === 'qualifying' && fr.iracing && !fr.iracing.outLap && fr.iracing.lapsCompleted === 1 && !lastLapFrame) lastLapFrame = fr;
  });
  replay(fx('iracing-cap2-dq'), (fr) => {
    if (fr.iracing && fr.player.trackLimits && fr.player.trackLimits.points === 12 && !raceFrame) raceFrame = fr;
  });
  const ask = (fr, intent) => {
    const c = new EngineerCommands();
    c.update(fr);
    return c.answer(intent);
  };
  if (raceFrame) {
    const a = ask(raceFrame, 'trackLimits');
    check('"track limits" answers incidents against the limit', a.ok && /12 of 17/.test(a.text), a.text);
    const e = ask(raceFrame, 'energy');
    check('an LMU-only question says so, plainly', !e.ok && /Le Mans Ultimate only/.test(e.text), e.text);
  } else check('found a 12x frame', false);
  if (outLapFrame) {
    const a = ask(outLapFrame, 'lapsLeft');
    check('laps left on the out lap: "out lap, then two timed laps"', /Out lap, then two timed laps/.test(a.text), a.text);
  } else check('found an out-lap frame', false);
  if (lastLapFrame) {
    const a = ask(lastLapFrame, 'lapsLeft');
    check('laps left on the second timed lap: the last one', /last timed lap/.test(a.text), a.text);
  } else check('found a last-lap frame', false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
