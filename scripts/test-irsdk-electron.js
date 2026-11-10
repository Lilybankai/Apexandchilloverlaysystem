#!/usr/bin/env node
/**
 * The iRacing shared-memory reader, run INSIDE ELECTRON's main process.
 *
 * Why this exists: 1.3.16-beta.3 shipped a reader that wrapped iRacing's
 * mapping with `koffi.view` (an external ArrayBuffer). Plain Node allows that;
 * Electron's V8 memory cage does not, and it is a FATAL napi error — the app
 * exited silently the moment a driver chose iRacing. Every other test runs
 * under plain Node, so none of them could see it. This one builds a fake
 * iRacing mapping (under a private name, so a running sim is never touched),
 * then opens it with the real `LiveIrsdkSource` and polls the real
 * `IRacingProvider` against it, in Electron.
 *
 * Run: `npm run test:irsdk-electron` (needs `npm run build` first). Windows only;
 * elsewhere it reports a skip. Invoked with plain node it re-launches itself
 * under Electron and relays the result, because electron.exe is a GUI-subsystem
 * binary on Windows and its own stdout never reaches the terminal.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const LOG = path.join(os.tmpdir(), `apex-irsdk-electron-${process.pid}.log`);

if (!process.versions.electron) {
  if (process.platform !== 'win32') {
    console.log('test-irsdk-electron: skipped (Windows only)');
    process.exit(0);
  }
  const { spawnSync } = require('child_process');
  const electron = require('electron'); // path to electron.exe when required from node
  const log = path.join(os.tmpdir(), `apex-irsdk-electron-run-${Date.now()}.log`);
  // ELECTRON_RUN_AS_NODE must be ABSENT, not empty: any value makes electron.exe
  // a plain node, where `require('electron')` is a path and there is no app.
  const env = { ...process.env, APEX_IRSDK_TEST_LOG: log };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electron, [__filename], { env, timeout: 60000 });
  const out = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  process.stdout.write(out || '(no output: electron did not run the test)\n');
  try {
    fs.unlinkSync(log);
  } catch {
    /* ignore */
  }
  const ok = r.status === 0 && /\b0 failed\b/.test(out);
  if (!ok && r.signal) console.log(`electron killed by ${r.signal}`);
  if (!ok && r.status !== 0) console.log(`electron exit code ${r.status} (a fatal native error exits non-zero with no log line)`);
  process.exit(ok ? 0 : 1);
}

/* ------------------------------ inside Electron ---------------------------- */
const { app, BrowserWindow } = require('electron');
const logFile = process.env.APEX_IRSDK_TEST_LOG || LOG;
const log = (m) => fs.appendFileSync(logFile, m + '\n');
setTimeout(() => {
  log('TIMEOUT');
  app.exit(3);
}, 45000);

const dist = (p) => require(path.join(__dirname, '..', 'dist', 'telemetry', p));
let passed = 0;
let failed = 0;
const check = (name, cond, detail) => {
  if (cond) passed++;
  else failed++;
  log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : `   [${detail}]`}`);
};

app.whenReady().then(async () => {
  try {
    run();
  } catch (e) {
    failed++;
    log(`  FAIL  threw: ${e && e.stack}`);
  }
  try {
    await runBroadcast();
  } catch (e) {
    failed++;
    log(`  FAIL  broadcast threw: ${e && e.stack}`);
  }
  log(`${passed} passed, ${failed} failed`);
  app.exit(failed ? 1 : 0);
});

function run() {
  log(`test-irsdk-electron (electron ${process.versions.electron})`);
  const koffi = require('koffi');
  const k32 = koffi.load('kernel32.dll');
  const CreateFileMappingW = k32.func(
    'void* __stdcall CreateFileMappingW(intptr_t, void*, uint32, uint32, uint32, str16)',
  );
  const MapViewOfFile = k32.func('void* __stdcall MapViewOfFile(void*, uint32, uint32, uint32, size_t)');
  const UnmapViewOfFile = k32.func('bool __stdcall UnmapViewOfFile(void*)');
  const CloseHandle = k32.func('bool __stdcall CloseHandle(void*)');
  const write = k32.func('void __stdcall RtlMoveMemory(uintptr_t dst, void *src, size_t len)');

  /* ---- a minimal but well-formed irsdk image ---- */
  const SIZE = 256 * 1024;
  const VARHDR = 144;
  const vars = [
    // name, type (2 int, 1 bool, 4 float, 5 double), offset, count
    ['SessionTime', 5, 0, 1],
    ['Speed', 4, 8, 1],
    ['Gear', 2, 12, 1],
    ['PlayerCarIdx', 2, 16, 1],
    ['IsOnTrack', 1, 20, 1],
    ['CarIdxLapDistPct', 4, 21, 64], // deliberately UNALIGNED, as iRacing packs them
    ['SessionNum', 2, 277, 1],
    ['SessionState', 2, 281, 1],
  ];
  const BUF_LEN = 288;
  const yaml =
    'WeekendInfo:\n TrackName: testtrack\n TrackID: 1\n TrackLength: 3.00 km\n TrackDisplayName: Test Track\n TrackConfigName: \n SubSessionID: 1\n' +
    'SessionInfo:\n Sessions:\n - SessionNum: 0\n   SessionType: Practice\n   SessionLaps: unlimited\n   SessionTime: 3600.0000 sec\n' +
    'DriverInfo:\n DriverCarIdx: 0\n DriverCarFuelMaxLtr: 50.000\n Drivers:\n' +
    ' - CarIdx: 0\n   UserName: Test Driver\n   CarNumber: "7"\n   CarScreenName: Test Car\n   CarClassID: 1\n   CarClassShortName: GT3\n   IRating: 1500\n   LicString: A 3.00\n   LicColor: 0x0153db\n   IsSpectator: 0\n   CarIsPaceCar: 0\n' +
    ' - CarIdx: 3\n   UserName: Other Driver\n   CarNumber: "9"\n   CarScreenName: Test Car\n   CarClassID: 1\n   CarClassShortName: GT3\n   IRating: 2100\n   LicString: B 2.50\n   LicColor: 0x00c702\n   IsSpectator: 0\n   CarIsPaceCar: 0\n';
  const yamlBuf = Buffer.from(yaml, 'latin1');
  const VARHDR_OFF = 144;
  const SI_OFF = VARHDR_OFF + vars.length * VARHDR;
  const BUF_OFF = 64 * 1024;

  const img = Buffer.alloc(BUF_OFF + BUF_LEN);
  img.writeInt32LE(2, 0); // ver
  img.writeInt32LE(1, 4); // status: connected
  img.writeInt32LE(60, 8);
  img.writeInt32LE(1, 12); // sessionInfoUpdate
  img.writeInt32LE(yamlBuf.length + 1, 16);
  img.writeInt32LE(SI_OFF, 20);
  img.writeInt32LE(vars.length, 24);
  img.writeInt32LE(VARHDR_OFF, 28);
  img.writeInt32LE(1, 32); // numBuf
  img.writeInt32LE(BUF_LEN, 36);
  img.writeInt32LE(100, 48); // varBuf[0].tickCount
  img.writeInt32LE(BUF_OFF, 52); // varBuf[0].bufOffset
  vars.forEach(([name, type, off, count], i) => {
    const o = VARHDR_OFF + i * VARHDR;
    img.writeInt32LE(type, o);
    img.writeInt32LE(off, o + 4);
    img.writeInt32LE(count, o + 8);
    img.write(name, o + 16, 'latin1');
  });
  yamlBuf.copy(img, SI_OFF);
  const row = BUF_OFF;
  img.writeDoubleLE(123.5, row + 0);
  img.writeFloatLE(42.5, row + 8);
  img.writeInt32LE(4, row + 12);
  img.writeInt32LE(0, row + 16);
  img[row + 20] = 1;
  for (let i = 0; i < 64; i++) img.writeFloatLE(-1, row + 21 + i * 4);
  img.writeFloatLE(0.5, row + 21 + 0 * 4);
  img.writeFloatLE(0.25, row + 21 + 3 * 4);
  img.writeInt32LE(0, row + 277);
  img.writeInt32LE(4, row + 281);

  const name = `Local\\ApexIrsdkTest-${process.pid}`;
  const h = CreateFileMappingW(-1, null, 4 /* PAGE_READWRITE */, 0, SIZE, name);
  check('created a private test mapping', !!h, 'CreateFileMappingW failed');
  const view = MapViewOfFile(h, 0xf001f, 0, 0, SIZE);
  check('mapped it for writing', !!view, 'MapViewOfFile failed');
  write(koffi.address(view), img, img.length);

  /* ---- the real reader ---- */
  const { LiveIrsdkSource } = dist('iracing/irsdk.js');
  const src = new LiveIrsdkSource(name);
  check('LiveIrsdkSource.open() inside Electron', src.open() === true, 'open() returned false');
  check('connected bit read', src.connected() === true, 'not connected');
  const f = src.read();
  check('read() returned a row', !!f, 'null row');
  if (f) {
    check('double var (SessionTime)', f.num('SessionTime') === 123.5, f.num('SessionTime'));
    check('float var (Speed)', Math.abs(f.num('Speed') - 42.5) < 1e-6, f.num('Speed'));
    check('int var (Gear)', f.num('Gear') === 4, f.num('Gear'));
    check('bool var (IsOnTrack)', f.bool('IsOnTrack') === true, f.bool('IsOnTrack'));
    check('unaligned float array element', Math.abs(f.num('CarIdxLapDistPct', 3) - 0.25) < 1e-6, f.num('CarIdxLapDistPct', 3));
  }
  const si = src.readSessionInfo();
  check('session info read', !!si && si.toString('latin1').includes('Test Driver'), si && si.length);

  // A sim that changes the row must be seen on the next read (copies, not a stale snapshot).
  const speed2 = Buffer.alloc(4);
  speed2.writeFloatLE(77.25, 0);
  write(koffi.address(view) + BigInt(row + 8), speed2, 4);
  const tick = Buffer.alloc(4);
  tick.writeInt32LE(101, 0);
  write(koffi.address(view) + 48n, tick, 4);
  const f2 = src.read();
  check('a new tick is read fresh', !!f2 && Math.abs(f2.num('Speed') - 77.25) < 1e-6, f2 && f2.num('Speed'));
  src.close();

  /* ---- the real provider, polled the way the server polls it ---- */
  const { IRacingProvider } = dist('iracing/iracingProvider.js');
  const p = new IRacingProvider({ verbose: false }, { source: new LiveIrsdkSource(name), lapSink: () => {} });
  p.start();
  let fr = null;
  for (let i = 0; i < 5; i++) fr = p.poll(Date.now() + i * 33, 33);
  check('provider polled inside Electron', !!fr, 'no frame');
  check('frame is iRacing and connected', !!fr && fr.source === 'iracing' && fr.connected === true, fr && `${fr.source}/${fr.connected}`);
  check('standings built from the mapping', !!fr && fr.standings.length === 2, fr && fr.standings.length);
  const me = fr && fr.standings.find((s) => s.isPlayer);
  check('player row carries iRating + licence', !!me && me.iRating === 1500 && me.license && me.license.text === 'A 3.00', me && JSON.stringify({ ir: me.iRating, lic: me.license }));
  p.stop();

  UnmapViewOfFile(view);
  CloseHandle(h);
}

/**
 * The pit-command sender (irsdkBroadcast.ts), inside Electron, WITHOUT ever
 * addressing iRacing: the koffi user32 binding loads, RegisterWindowMessageW
 * returns the IRSDK_BROADCASTMSG id, and one encoded pit command is sent to
 * THIS test's own hidden window (never HWND_BROADCAST), where Electron's
 * hookWindowMessage proves the wParam/lParam arrive exactly as encoded.
 */
async function runBroadcast() {
  log('broadcast (own window only, never HWND_BROADCAST)');
  const b = dist('iracing/irsdkBroadcast.js');
  const real = b.createKoffiTransport();
  check('koffi user32 transport loads in Electron', !!real, 'createKoffiTransport() returned null');
  if (!real) return;
  const id = real.register();
  check('RegisterWindowMessageW("IRSDK_BROADCASTMSG") returns an id', id >= 0xc000 && id <= 0xffff, id);
  check('the id is stable (same name, same id)', real.register() === id, 'changed');

  const win = new BrowserWindow({ show: false, width: 100, height: 100 });
  const hwnd = Number(win.getNativeWindowHandle().readBigUInt64LE(0));
  check('own window handle', hwnd > 0 && hwnd !== b.HWND_BROADCAST, hwnd);
  const got = [];
  win.hookWindowMessage(id, (wParam, lParam) => {
    got.push({ w: wParam.readUInt32LE(0), l: lParam.readInt32LE(0) });
  });
  const targets = [];
  const guarded = {
    register: () => real.register(),
    send: (h, m, w, l) => {
      targets.push(h);
      if (h !== hwnd) return false; // belt and braces: only our own window
      return real.send(h, m, w, l);
    },
  };
  const tx = new b.IrsdkBroadcaster({ transport: guarded, target: hwnd });
  const sent = tx.pit(b.IR_PIT.Fuel, 37);
  for (let i = 0; i < 20 && !got.length; i++) await new Promise((r) => setTimeout(r, 25));
  check('SendNotifyMessageW reported success', sent.ok === true, JSON.stringify(sent));
  check('every send went to our own window', targets.length === 1 && targets[0] === hwnd, JSON.stringify(targets));
  const want = b.encodePitCommand(b.IR_PIT.Fuel, 37);
  check(
    'the window received MAKELONG(9, Fuel) / 37',
    got.length === 1 && got[0].w === want.wParam && got[0].l === want.lParam && got[0].w === ((2 << 16) | 9),
    JSON.stringify(got),
  );
  win.unhookWindowMessage(id);
  win.destroy();
}