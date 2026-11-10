/**
 * The iRacing pit wall (plain node, after a build): `npm run test:iracing-pitwall`.
 *
 *  1. driver flags, bit by bit, on values measured in the 2026-11-10 captures
 *     (local yellow is not a caution; black / meatball / DQ; spectated cars);
 *  2. repair + pit-service tracking over a scripted timeline that replays the
 *     measured ir-cap4 crash → tow → 40.3 s stop (EngineWarnings 0x100 → 0x180,
 *     meatball, tow 127.5 s, PitSvFlags 0x6F → 0x2F (FR on the start tick) →
 *     0x2E → 0x0E → 0x0C → 0x08 → 0x00, menu reset on pit exit);
 *  3. pit-command encoding (irsdk broadcast msg 9) and its range checks;
 *  4. intent planning against the read-back menu;
 *  5. the gate: nothing reaches the transport unless the setting is on AND the
 *     frame is a live iRacing car; rate limit; a FAKE transport throughout —
 *     this test never sends a window message;
 *  6. the provider over the committed anonymised fixture (scripts/fixtures/
 *     iracing-cap1): every frame carries flags; repair/pit-service blocks are
 *     present exactly when their vars are, and never while spectating.
 */
const path = require('path');
const dist = (m) => require(path.join(__dirname, '..', 'dist', m));
const { readDriverFlags, IrPitTracker } = dist('telemetry/iracing/irPit.js');
const B = dist('telemetry/iracing/irsdkBroadcast.js');
const C = dist('server/irPitControl.js');
const { CaptureSource } = dist('telemetry/iracing/captureSource.js');
const { IRacingProvider } = dist('telemetry/iracing/iracingProvider.js');

const UNKNOWN = -1;
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (!ok && detail !== undefined ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

/** An IrsdkFrame over a plain object. */
function frame(o) {
  return {
    tick: 0,
    has: (n) => o[n] !== undefined,
    count: (n) => (o[n] === undefined ? 0 : Array.isArray(o[n]) ? o[n].length : 1),
    num: (n, i = 0) => {
      let v = o[n];
      if (Array.isArray(v)) v = v[i];
      if (typeof v === 'boolean') return v ? 1 : 0;
      return typeof v === 'number' ? v : NaN;
    },
    bool(n, i) {
      const v = this.num(n, i);
      return Number.isFinite(v) && v !== 0;
    },
  };
}

/* -------------------------------------------------------------------------- */
console.log('\n1) driver flags');
{
  const on = (f) => Object.keys(f).filter((k) => f[k]).sort().join(',');
  check('race running 0x10040004 = green only', on(readDriverFlags(0x10040004)) === 'green', on(readDriverFlags(0x10040004)));
  check('practice black 0x10050000', on(readDriverFlags(0x10050000)) === 'black');
  check('meatball 0x10140000 (11 s after the crash)', on(readDriverFlags(0x10140000)) === 'meatball');
  check('DQ at the incident limit 0x10060000', on(readDriverFlags(0x10060000)) === 'disqualified');
  check('furled 0xC0000', on(readDriverFlags(0x000c0000)) === 'furled');
  const yw = readDriverFlags(0x10040100);
  check('yellowWaving 0x100 is a LOCAL yellow, not a caution', yw.localYellow && !yw.caution);
  check('caution 0x4000 / cautionWaving 0x8000 are full-course', readDriverFlags(0x4000).caution && readDriverFlags(0x8000).caution && !readDriverFlags(0x4000).localYellow);
  check('white + blue 0x10040022', on(readDriverFlags(0x10040022)) === 'blue,white');
  check('debris 0x40', readDriverFlags(0x40).debris);
  // Spectating: driver bits from the car's own CarIdxSessionFlags, never the
  // player's blue / local yellow.
  const spec = readDriverFlags(0x10040120 | 0x4000, 0x140000);
  check('spectated car: its meatball, the global caution, not our blue/yellow', spec.meatball && spec.caution && !spec.blue && !spec.localYellow, on(spec));
  check('spectated car: our black flag is not its black flag', !readDriverFlags(0x10050000, 0x40000).black);
}

/* -------------------------------------------------------------------------- */
console.log('\n2) repair + pit service over the cap4 crash / tow / stop timeline');
{
  const t = new IrPitTracker();
  const base = {
    EngineWarnings: 0, PitSvFlags: 0x6f, PitstopActive: false, PlayerCarPitSvStatus: 0, FastRepairAvailable: 1,
    FastRepairUsed: 0, PlayerFastRepairsUsed: 0, PitRepairLeft: 0, PitOptRepairLeft: 0, PlayerCarTowTime: 0,
    PitSvFuel: 0, PitSvLFP: 199.948, PitSvRFP: 199.948, PitSvLRP: 199.948, PitSvRRP: 199.948,
    dpFuelAutoFillEnabled: 1, dpFuelAutoFillActive: 1, LatAccel: 0, LongAccel: 0, VertAccel: 9.81,
  };
  let st = { ...base };
  let now = 1e9;
  const step = (sessionTime, patch, sessionFlags = 0x10040000, onPitRoad = false) => {
    st = { ...st, ...patch, SessionTime: sessionTime };
    now = 1e9 + sessionTime * 1000;
    const f = frame(st);
    t.noteAccel(f, now);
    return { r: t.repair(f, sessionFlags, now), s: t.service(f, onPitRoad, ['Hard']) };
  };
  const states = (s) => s.items.map((i) => (i.id === 'fastRepair' ? 'FR' : i.label) + ':' + i.state[0]).join(' ');

  let x = step(240, {});
  check('clean car: no repair, FR 1 left, booked', x.r.required === 'none' && x.r.fastRepairsLeft === 1 && x.r.fastRepairQueued === true);
  check('menu: tyres + tear-off + FR booked, autofuel, no fuel', states(x.s) === 'LF:r RF:r LR:r RR:r FUEL:o TEAR-OFF:r FR:r' && x.s.autoFuel && x.s.fuelAddL === UNKNOWN, states(x.s));
  check('pressures read back in kPa', x.s.pressuresKpa.every((p) => p === 199.9), x.s.pressuresKpa.join());
  check('PitRepairLeft 0 is "not published", never "0 s"', x.r.repairSec === UNKNOWN && x.r.optionalRepairSec === UNKNOWN);
  x = step(248.8, { EngineWarnings: 0x100, LatAccel: -77.9, LongAccel: 60 });
  check('impact tick: optional repair', x.r.required === 'optional');
  check('impact g recorded (10.8 g measured)', x.r.lastImpactG > 9 && x.r.lastImpactG < 11, x.r.lastImpactG);
  x = step(248.9, { EngineWarnings: 0x180, LatAccel: 0, LongAccel: 0 });
  check('0.1 s later: mandatory', x.r.required === 'mandatory' && !x.r.meatball);
  x = step(259.6, {}, 0x10140000);
  check('meatball shown', x.r.meatball === true && x.r.required === 'mandatory');
  x = step(270.1, { EngineWarnings: 0x18c, PlayerCarTowTime: 127.5 }, 0x10140000, true);
  check('tow countdown', x.r.towSec === 127.5);
  check('towing is not a stop', x.s.active === false && x.s.elapsedSec === UNKNOWN);
  x = step(397.7, { PlayerCarTowTime: 0.05 }, 0x10140000, true);
  x = step(397.8, { EngineWarnings: 0, PitstopActive: true, PitSvFlags: 0x2f, PlayerCarTowTime: 0 }, 0x10140000, true);
  check('stop starts: FR consumed on the SAME tick still counts as booked → done', states(x.s) === 'LF:r RF:r LR:r RR:r FUEL:o TEAR-OFF:r FR:d', states(x.s));
  check('stop clock starts at 0', x.s.active && x.s.elapsedSec === 0);
  x = step(398.7, { PitSvFlags: 0x2e, PlayerCarPitSvStatus: 1, FastRepairAvailable: 0, PlayerFastRepairsUsed: 1 }, 0x10040000, true);
  check('LF done, status inProgress, FR used', states(x.s).startsWith('LF:d RF:r') && x.s.status === 'inProgress' && x.r.fastRepairsLeft === 0 && x.r.fastRepairsUsed === 1);
  check('repair cleared once the crew started', x.r.required === 'none' && !x.r.meatball);
  step(399.9, { PitSvFlags: 0x0e }, 0x10040000, true);
  step(400.2, { PitSvFlags: 0x0c }, 0x10040000, true);
  x = step(418.5, { PitSvFlags: 0x08 }, 0x10040000, true);
  check('LR done, RR still to do', states(x.s) === 'LF:d RF:d LR:d RR:r FUEL:o TEAR-OFF:d FR:d', states(x.s));
  check('stop clock 20.7 s', x.s.elapsedSec === 20.7, x.s.elapsedSec);
  step(420.0, { PitSvFlags: 0x00 }, 0x10040000, true);
  x = step(438.1, { PitstopActive: false, PlayerCarPitSvStatus: 2 }, 0x10040000, true);
  check('stop over: 40.3 s, everything done, complete', x.s.lastStopSec === 40.3 && x.s.status === 'complete' && states(x.s) === 'LF:d RF:d LR:d RR:d FUEL:o TEAR-OFF:d FR:d', `${x.s.lastStopSec} ${states(x.s)}`);
  x = step(447.6, { PitSvFlags: 0x6f, PlayerCarPitSvStatus: 0 }, 0x10040000, false);
  check('pit exit: back to the (auto-reset) menu, last stop kept', states(x.s) === 'LF:r RF:r LR:r RR:r FUEL:o TEAR-OFF:r FR:r' && x.s.lastStopSec === 40.3, states(x.s));
  const unl = frame({ ...base, FastRepairAvailable: 255 });
  const r255 = new IrPitTracker().repair(unl, 0, 0);
  check('255 fast repairs = unlimited, not a count', r255.fastRepairsUnlimited === true && r255.fastRepairsLeft === UNKNOWN);
  check('no EngineWarnings var: no repair block', new IrPitTracker().repair(frame({}), 0, 0) === undefined);
  check('no PitSvFlags var: no service block', new IrPitTracker().service(frame({}), false) === undefined);
  const ws = new IrPitTracker().service(frame({ ...base, PitSvFlags: 0x10, PitSvFuel: 44.987, PlayerCarPitSvStatus: 102 }), false);
  check('fuel ticked: litres read back; status 102 = too far forward', ws.fuelAddL === 45 && ws.status === 'tooFarForward', `${ws.fuelAddL} ${ws.status}`);
}

/* -------------------------------------------------------------------------- */
console.log('\n3) pit-command encoding (irsdk broadcast msg 9)');
{
  check('MAKELONG(9, 2) = 0x00020009', B.makeLong(9, 2) === 0x00020009);
  check('MAKELONG keeps 16 bits each, unsigned', B.makeLong(-1, 1) === 0x0001ffff && B.makeLong(0, 0xffff) === 0xffff0000);
  const f = B.encodePitCommand(B.IR_PIT.Fuel, 37);
  check('fuel 37 L → wParam 0x00020009, lParam 37', f.wParam === 0x00020009 && f.lParam === 37);
  const lf = B.encodePitCommand(B.IR_PIT.LF, 172.4);
  check('LF at 172 kPa → wParam 0x00030009, lParam 172', lf.wParam === 0x00030009 && lf.lParam === 172);
  check('clear → MAKELONG(9, 0), 0', B.encodePitCommand(B.IR_PIT.Clear).wParam === 9 && B.encodePitCommand(B.IR_PIT.Clear).lParam === 0);
  const ids = { Clear: 0, WS: 1, Fuel: 2, LF: 3, RF: 4, LR: 5, RR: 6, ClearTires: 7, FR: 8, ClearWS: 9, ClearFR: 10, ClearFuel: 11, TC: 12 };
  check('irsdk_PitCommandMode ids', Object.keys(ids).every((k) => B.IR_PIT[k] === ids[k]));
  check('irsdk_BroadcastPitCommand = 9, HWND_BROADCAST = 0xFFFF', B.IR_BROADCAST.PitCommand === 9 && B.HWND_BROADCAST === 0xffff);
  check('unknown command refused', throws(() => B.encodePitCommand(13)) && throws(() => B.encodePitCommand(-1)) && throws(() => B.encodePitCommand(2.5)));
  check('out-of-range parameters refused', throws(() => B.encodePitCommand(B.IR_PIT.Fuel, -1)) && throws(() => B.encodePitCommand(B.IR_PIT.LF, 5000)) && throws(() => B.encodePitCommand(B.IR_PIT.FR, 1)) && throws(() => B.encodePitCommand(B.IR_PIT.Fuel, NaN)));
  const sent = [];
  const fake = { register: () => 0xc123, send: (h, m, w, l) => (sent.push({ h, m, w, l }), true) };
  const b = new B.IrsdkBroadcaster({ transport: fake });
  const r = b.pit(B.IR_PIT.RR, 0);
  check('broadcaster: default target is HWND_BROADCAST, registered id used', sent.length === 1 && sent[0].h === 0xffff && sent[0].m === 0xc123 && sent[0].w === 0x00060009 && r.ok);
  check('broadcaster: a malformed command throws before anything is sent', throws(() => b.pit(99)) && sent.length === 1);
  check('no transport: unavailable, nothing sent', new B.IrsdkBroadcaster({ transport: null }).available === false && new B.IrsdkBroadcaster({ transport: null }).pit(0).ok === false);
}

/* -------------------------------------------------------------------------- */
console.log('\n4) intent planning against the read-back menu');
{
  const P = B.IR_PIT;
  const svc = (on, extra = {}) => ({
    items: ['lf', 'rf', 'lr', 'rr', 'fuel', 'tearoff', 'fastRepair'].map((id) => ({ id, label: id, state: on.includes(id) ? 'requested' : 'off' })),
    fuelAddL: on.includes('fuel') ? 20 : UNKNOWN,
    autoFuel: false,
    pressuresKpa: [180, 181, 175, 176],
    status: 'none',
    active: false,
    elapsedSec: UNKNOWN,
    lastStopSec: UNKNOWN,
    ...extra,
  });
  const plan = (i, s, more = {}) => C.planPitIntent(i, { service: s, ...more }).map((x) => x.cmd + ':' + x.param).join(' ');
  check('clear', plan({ kind: 'clear' }, svc([])) === `${P.Clear}:0`);
  check('fuel 30', plan({ kind: 'fuel', litres: 30 }, svc([])) === `${P.Fuel}:30`);
  check('fuel +1 on 20 booked → 21', plan({ kind: 'fuelDelta', litres: 1 }, svc(['fuel'])) === `${P.Fuel}:21`);
  check('fuel −1 with none booked → clear fuel', plan({ kind: 'fuelDelta', litres: -1 }, svc([])) === `${P.ClearFuel}:0`);
  check('fuel to finish rounds up', plan({ kind: 'fuelToFinish' }, svc([]), { refuelToFinishL: 12.2 }) === `${P.Fuel}:13`);
  check('fuel to finish unknown → refused', throws(() => C.planPitIntent({ kind: 'fuelToFinish' }, { service: svc([]) })));
  check('all tyres = clear tyres + four ticks', plan({ kind: 'tyres', set: 'all' }, svc([])) === `${P.ClearTires}:0 ${P.LF}:0 ${P.RF}:0 ${P.LR}:0 ${P.RR}:0`);
  check('no tyres = clear tyres', plan({ kind: 'tyres', set: 'none' }, svc(['lf'])) === `${P.ClearTires}:0`);
  check('untick LF with all four on = clear + re-tick RF LR RR', plan({ kind: 'tyre', corner: 'lf' }, svc(['lf', 'rf', 'lr', 'rr'])) === `${P.ClearTires}:0 ${P.RF}:0 ${P.LR}:0 ${P.RR}:0`);
  check('tick RR alone', plan({ kind: 'tyre', corner: 'rr' }, svc([])) === `${P.RR}:0`);
  check('already in that state = nothing sent', plan({ kind: 'tyre', corner: 'rr', on: true }, svc(['rr'])) === '');
  check('LR pressure +7 kPa from read-back 175', plan({ kind: 'pressure', corner: 'lr', deltaKpa: 7 }, svc([])) === `${P.LR}:182`);
  check('pressure unknown → refused', throws(() => C.planPitIntent({ kind: 'pressure', corner: 'lf', deltaKpa: 7 }, { service: svc([], { pressuresKpa: [UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN] }) })));
  check('fast repair toggles', plan({ kind: 'fastRepair' }, svc([])) === `${P.FR}:0` && plan({ kind: 'fastRepair' }, svc(['fastRepair'])) === `${P.ClearFR}:0`);
  check('tear-off toggles', plan({ kind: 'tearoff' }, svc([])) === `${P.WS}:0` && plan({ kind: 'tearoff' }, svc(['tearoff'])) === `${P.ClearWS}:0`);
  check('unknown intent refused', throws(() => C.planPitIntent({ kind: 'launch' }, { service: svc([]) })));
}

/* -------------------------------------------------------------------------- */
console.log('\n5) the gate (fake transport; nothing leaves this process)');
{
  const sent = [];
  C.setIrPitBroadcaster(new B.IrsdkBroadcaster({ transport: { register: () => 0xc001, send: (h, m, w, l) => (sent.push(w), true) } }));
  const svc = {
    items: [{ id: 'fuel', label: 'FUEL', state: 'off' }],
    fuelAddL: UNKNOWN, autoFuel: false, pressuresKpa: [UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN], status: 'none',
    active: false, elapsedSec: UNKNOWN, lastStopSec: UNKNOWN,
  };
  const fr = (source, withSvc) => ({ source, connected: true, player: withSvc ? { pitService: { ...svc } } : {}, fuel: { refuelToFinishLiters: UNKNOWN } });
  check('default is OFF', C.iracingPitCommandsEnabled() === false);
  C.stampIrPit(fr('iracing', true));
  let r = C.runPitIntent({ kind: 'clear' }, 1000);
  check('OFF: refused with the reason, nothing sent', !r.ok && /off/.test(r.error) && sent.length === 0, r.error);
  C.setIracingPitCommands(true);
  C.stampIrPit(fr('lmu', true));
  r = C.runPitIntent({ kind: 'clear' }, 1000);
  check('ON but not an iRacing frame: refused', !r.ok && sent.length === 0);
  C.stampIrPit(fr('iracing', false));
  r = C.runPitIntent({ kind: 'clear' }, 1000);
  check('ON, iRacing, but not in the car: refused', !r.ok && sent.length === 0);
  const f = fr('iracing', true);
  C.stampIrPit(f);
  check('stamp tells the panel commands are live', f.player.pitService.commandsEnabled === true);
  r = C.runPitIntent({ kind: 'fuel', litres: 10 }, 1000);
  check('ON + in the car: sent, encoded', r.ok && sent.length === 1 && sent[0] === 0x00020009, JSON.stringify(r));
  let refused = false;
  for (let i = 0; i < 20 && !refused; i++) refused = !C.runPitIntent({ kind: 'clear' }, 1001).ok;
  check('rate-limited: a held button cannot flood the sim', refused && sent.length <= 12, sent.length);
  check('a second later it works again', C.runPitIntent({ kind: 'clear' }, 2500).ok);
  C.setIracingPitCommands(false);
  const g = fr('iracing', true);
  C.stampIrPit(g);
  check('switched OFF again: stamp says read-only', g.player.pitService.commandsEnabled === false && !C.runPitIntent({ kind: 'clear' }, 5000).ok);
  C.setIrPitBroadcaster(null);
}

/* -------------------------------------------------------------------------- */
console.log('\n6) the provider over the committed fixture (iracing-cap1)');
{
  const src = new CaptureSource(path.join(__dirname, 'fixtures', 'iracing-cap1'));
  const p = new IRacingProvider({ verbose: false }, { source: src, lapSink: null });
  p.start();
  let n = 0;
  let noFlags = 0;
  let badBlack = 0;
  let repairOnTrack = 0;
  let svcSeen = 0;
  let specLeak = 0;
  let black = 0;
  let t = 1e12;
  while (!src.done()) {
    t += 100;
    const fr = p.poll(t, 100);
    if (fr.source !== 'iracing' || !fr.connected) continue;
    n++;
    const pl = fr.player;
    if (!pl.flags) noFlags++;
    if (pl.flags && pl.flags.black) black++;
    const own = fr.standings.find((s) => s.isPlayer);
    if (own && !own.isOwn && (pl.repair || pl.pitService)) specLeak++;
    if (pl.repair) repairOnTrack++;
    if (pl.pitService) svcSeen++;
    if (pl.flags && pl.flags.black && !(pl.trackLimits && pl.trackLimits.penalties === 1) && own && own.isOwn) badBlack++;
  }
  p.stop();
  check(`frames replayed (${n})`, n > 1000, n);
  check('every live frame carries player.flags', noFlags === 0, noFlags);
  check('black flag seen in the fixture and agrees with the incidents panel', black > 0 && badBlack === 0, `${black} / ${badBlack}`);
  check('repair block from EngineWarnings while driving', repairOnTrack > 0, repairOnTrack);
  check('no pit-service block when the fixture has no PitSvFlags', svcSeen === 0, svcSeen);
  check('never a repair / service block for a spectated car', specLeak === 0, specLeak);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
