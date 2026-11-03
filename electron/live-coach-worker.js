/**
 * electron/live-coach-worker.js — the live practice coach's lap measuring,
 * off the main thread.
 * -----------------------------------------------------------------------------
 * Finding a just-driven lap in the lap log and splitting it corner by corner
 * against its target is ~150 ms of synchronous reading and arithmetic
 * (electron/live-coach-measure.js). Main composites every overlay on its own
 * thread, so it posts each attempt here instead and waits for the answer.
 *
 * Protocol: `{ id, op: 'attempt' | 'verify', req }` in, `{ id, ok, result | error }` out — see
 * `createWorkerClient` in live-coach-measure.js.
 */

'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { createMeasurer } = require('./live-coach-measure');

let measurer = null;

parentPort.on('message', (msg) => {
  const id = msg && msg.id;
  try {
    if (!measurer) measurer = createMeasurer((workerData && workerData.io) || {});
    const op = msg && msg.op === 'verify' ? 'verify' : 'attempt';
    parentPort.postMessage({ id, ok: true, result: measurer[op](msg.req || {}) });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
});
