/**
 * electron/gamepadWorker.js — DirectInput on its own thread.
 * -----------------------------------------------------------------------------
 * Hosts one {@link DirectInputReader} for the main thread's GamepadReader
 * proxy (see gamepad.js, "Why all of this runs on a worker thread"). Every
 * DirectInput call — the 8 ms poll, enumeration, the presence check and the
 * slow-device probe — happens here, so a USB device that takes 10 s to answer
 * costs this thread 10 s and the overlays nothing.
 *
 * Protocol (main → worker): `{cmd:'open', verbose}`, `{cmd:'setActive', active}`,
 * `{cmd:'rescan', id}`, `{cmd:'close'}`.
 * Worker → main: `{ev:'ready', snapshot}`, `{ev:'state', snapshot}`,
 * `{ev:'rescanned', id, snapshot}`, `{ev:'button', device, button, down}`.
 */

'use strict';

const { parentPort } = require('node:worker_threads');
const { DirectInputReader } = require('./gamepad');

if (!parentPort) throw new Error('gamepadWorker must run as a worker thread');

const post = (msg) => {
  try {
    parentPort.postMessage(msg);
  } catch {
    /* main gone */
  }
};

let reader = null;

function getReader(verbose) {
  if (!reader) {
    reader = new DirectInputReader({
      verbose: !!verbose,
      onButton: (device, button, down) => post({ ev: 'button', device, button, down }),
      onDevicesChanged: () => post({ ev: 'state', snapshot: reader.snapshot() }),
    });
  }
  return reader;
}

parentPort.on('message', (m) => {
  if (!m || typeof m.cmd !== 'string') return;
  try {
    switch (m.cmd) {
      case 'open': {
        const r = getReader(m.verbose);
        r.open();
        post({ ev: 'ready', snapshot: r.snapshot() });
        break;
      }
      case 'setActive': {
        const r = getReader();
        r.setActive(!!m.active);
        post({ ev: 'state', snapshot: r.snapshot() });
        break;
      }
      case 'rescan': {
        const r = getReader();
        r.rescan();
        post({ ev: 'rescanned', id: m.id, snapshot: r.snapshot() });
        break;
      }
      case 'close':
        if (reader) reader.close();
        reader = null;
        parentPort.close();
        break;
      default:
        break;
    }
  } catch (err) {
    // A DirectInput fault must reach the main thread as a status, not as an
    // uncaught exception that takes the worker (and every binding) with it.
    post({
      ev: 'state',
      snapshot: {
        available: false,
        failed: err && err.message ? err.message : String(err),
        devices: reader ? reader.list() : [],
        problems: [],
        slow: null,
        lastEnumMs: 0,
      },
    });
  }
});
