/**
 * scripts/test-gamepad-rescan.js — the reader recovering its own device list.
 * -----------------------------------------------------------------------------
 * DirectInput enumeration happens once per open, and for a long time nothing
 * ever redid it except the Scan button on the bindings page. That made two very
 * ordinary situations look like the overlay was broken:
 *
 *   - the app launched before the wheel's driver was ready, so the reader came
 *     up with an EMPTY device list and polled it, at 125 Hz, forever;
 *   - the base was power-cycled mid-session, leaving device handles that no
 *     amount of re-Acquire will ever bring back.
 *
 * Both present identically to a driver: every wheel binding silently does
 * nothing — including the four MFD controls, which is the report that started
 * this — with no error anywhere, and the only cure was a button in a settings
 * page nobody would think to press. So the poll loop now re-enumerates itself.
 *
 * The reader is a COM/koffi object, so these tests drive `_poll` directly
 * against a stubbed `_vcall` rather than opening anything real; that keeps the
 * counting and back-off logic — the part that was actually wrong — testable off
 * a Windows box with a wheel plugged in.
 *
 * Run: node scripts/test-gamepad-rescan.js
 */

'use strict';

const { GamepadReader, describeButton } = require('../electron/gamepad');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  }
}

const STATE_SIZE = 8 * 4 + 4 * 4 + 128;

/**
 * A reader with the COM layer replaced. `readable` decides what GetDeviceState
 * (vtable slot 9) reports, which is the only device call `_poll` makes besides
 * the re-Acquire it does on failure.
 */
function stubReader({ devices = 1, readable = true } = {}) {
  const g = new GamepadReader();
  g.di = 'stub-di'; // non-null, so rescan() re-enumerates instead of opening
  g.rescans = 0;
  g.readable = readable;
  g.P = { Release: null, Acquire: null, GetDeviceState: null };
  g._vcall = (iface, slot) => (slot === 9 && !g.readable ? 1 : 0);
  const makeDevices = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: `wheel ${i + 1}`,
      product: `wheel ${i + 1}`,
      caps: { axes: 0, povs: 0, buttons: 4 },
      dev: `dev-${i}`,
      state: Buffer.alloc(STATE_SIZE),
      prev: Buffer.alloc(STATE_SIZE),
      pov: [-1, -1, -1, -1],
      misses: 0,
    }));
  g.devices = makeDevices(devices);
  // Stands in for the DirectInput enumeration: counts the calls and reports
  // whatever the test has said is attached this time round.
  g.attached = devices;
  g._enumerate = () => {
    g.rescans++;
    g.pollsSinceScan = 0;
    g.devices = makeDevices(g.attached);
  };
  return g;
}

/** Poll `n` times, as the 8 ms interval would. */
const spin = (g, n) => {
  for (let i = 0; i < n; i++) g._poll();
};

console.log('\nempty device list — the app started before the wheel driver');
{
  const g = stubReader({ devices: 0 });
  spin(g, 100);
  check('does not re-enumerate on every poll', g.rescans === 0, `${g.rescans} scans`);
  spin(g, 200);
  check('re-enumerates once the retry gap is up', g.rescans === 1, `${g.rescans} scans`);

  // Still nothing attached: the gap has to grow, or a rig with no wheel at all
  // re-enumerates every two seconds for the rest of the session.
  const beforeBackoff = g.rescans;
  spin(g, 260);
  check('backs off rather than retrying at the same rate', g.rescans === beforeBackoff);
  spin(g, 260);
  check('does retry again on the longer gap', g.rescans === beforeBackoff + 1);
}

console.log('\nthe wheel turns up late');
{
  const g = stubReader({ devices: 0 });
  g.attached = 1; // plugged in while the reader was polling an empty list
  spin(g, 300);
  check('picks the device up without the Scan button', g.devices.length === 1);

  // And having found one, the next loss should be retried promptly rather than
  // inheriting the long gap the empty spell backed off to.
  check('resets the retry gap after a successful scan', g.rescanAfter === 250, `${g.rescanAfter}`);
}

console.log('\ndevice stops answering — base power-cycled mid-session');
{
  const g = stubReader({ devices: 1, readable: false });
  spin(g, 100);
  check('a brief unreadable spell is not treated as a loss', g.rescans === 0);
  check('it keeps trying to re-acquire', g.devices[0].misses === 100, `${g.devices[0].misses}`);

  spin(g, 200);
  check('a sustained one re-enumerates', g.rescans === 1, `${g.rescans} scans`);

  // A recovered device must clear its miss count, or the next single failed
  // read would tip it straight back over the threshold.
  g.readable = true;
  spin(g, 1);
  check('a readable poll clears the miss count', g.devices[0].misses === 0);
}

console.log('\nhealthy reader');
{
  const g = stubReader({ devices: 2 });
  spin(g, 5000);
  check('never re-enumerates while every device reads', g.rescans === 0, `${g.rescans} scans`);
}

console.log('\nbutton edges still report through the stub');
{
  const g = stubReader({ devices: 1 });
  const seen = [];
  g.onButton = (device, button, down) => seen.push(`${device}:${button}:${down}`);
  g._poll();
  g.devices[0].state[8 * 4 + 4 * 4 + 2] = 0x80; // third button down
  g._poll();
  check('press edge fires once', seen.join(',') === 'wheel 1:3:true', seen.join(',') || 'none');
  g._poll();
  check('a held button does not repeat', seen.length === 1, `${seen.length} events`);
}

console.log('\nhat labels');
{
  check('hat direction reads as a hat', describeButton(201) === 'hat 1 up', describeButton(201));
  check('a plain button still reads as one', describeButton(7) === 'btn 7', describeButton(7));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
