/**
 * electron/radio-fx.js — makes a clean TTS clip sound like the pit wall.
 * -----------------------------------------------------------------------------
 * Piper's output is studio-clean, which is exactly wrong for immersion: a race
 * engineer arrives through a band-limited, compressed comms channel with hiss
 * under the voice and a squelch burst when the channel keys on and off. This
 * module is that channel, as a small offline DSP chain over a 16-bit PCM WAV:
 *
 *   1. squelch bursts — a short noise splash prepended (key-up) and appended
 *      (key-off), BEFORE filtering so they get the same radio band as the voice
 *   2. hiss bed — constant low-level noise for the whole transmission (a real
 *      channel hisses while keyed, and goes dead silent when it isn't)
 *   3. band-pass — 4th-order Butterworth 300 Hz–3.1 kHz, the classic voice-comms
 *      bandwidth; this alone does most of the "radio" reading
 *   4. saturation — tanh soft-clip, the flattened dynamics of a driven channel
 *   5. normalize — peak to a consistent loudness so answers sit level in the mix
 *
 * Pure Node, no dependencies: Piper writes mono 16-bit WAVs and a RIFF parser
 * for that is thirty lines. Runs in a few ms per clip, so it sits inline
 * between Piper and the player without adding felt latency.
 *
 * CLI for A/B tuning:   node electron/radio-fx.js in.wav [out.wav]
 */

'use strict';

const fs = require('node:fs');

/* ---- tuning ---------------------------------------------------------------- */

const HP_HZ = 300; // high-pass corner — kills the warmth a radio never carries
const LP_HZ = 3100; // low-pass corner — kills the airy top end
const DRIVE = 3.2; // saturation drive; higher = crunchier
const HISS = 0.012; // hiss bed amplitude (0..1)
const PEAK = 0.89; // normalize target
const KEY_UP_MS = 28; // squelch burst opening the channel
const KEY_OFF_MS = 42; // squelch burst closing it (slightly longer reads "tsch")
const PAD_MS = 50; // silence before/after so the player never clips a burst

/* ---- WAV I/O (16-bit PCM, as Piper writes) --------------------------------- */

function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file}: not a RIFF/WAVE file`);
  }
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { off: off + 8, size };
    else if (id === 'data') data = { off: off + 8, size };
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${file}: missing fmt/data chunk`);
  const format = buf.readUInt16LE(fmt.off);
  const channels = buf.readUInt16LE(fmt.off + 2);
  const sampleRate = buf.readUInt32LE(fmt.off + 4);
  const bits = buf.readUInt16LE(fmt.off + 14);
  if (format !== 1 || bits !== 16) throw new Error(`${file}: expected 16-bit PCM`);
  const n = Math.floor(data.size / 2 / channels);
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // Fold to mono on the way in; Piper is mono anyway.
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += buf.readInt16LE(data.off + (i * channels + c) * 2);
    samples[i] = acc / channels / 32768;
  }
  return { sampleRate, samples };
}

function writeWav(file, sampleRate, samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

/* ---- DSP -------------------------------------------------------------------- */

/** RBJ-cookbook biquad, applied in place. type: 'hp' | 'lp'. */
function biquad(samples, fs_, f0, type) {
  const w0 = (2 * Math.PI * f0) / fs_;
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2); // Q = 1/sqrt(2), Butterworth
  const cosw = Math.cos(w0);
  let b0, b1, b2;
  if (type === 'hp') {
    b0 = (1 + cosw) / 2;
    b1 = -(1 + cosw);
    b2 = (1 + cosw) / 2;
  } else {
    b0 = (1 - cosw) / 2;
    b1 = 1 - cosw;
    b2 = (1 - cosw) / 2;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    samples[i] = y0;
  }
}

/** Deterministic-ish noise; Math.random is fine for hiss. */
function noiseBurst(len, startAmp) {
  const out = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    const decay = Math.exp((-4 * i) / len); // fast exponential fade
    out[i] = (Math.random() * 2 - 1) * startAmp * decay;
  }
  return out;
}

/**
 * The whole channel. Takes mono float samples, returns new mono float samples.
 * Exposed for tests; `radioify` below is the file-in/file-out wrapper.
 * `gain` (0..1, default 1) scales the finished clip AFTER normalization — the
 * engineer's volume slider. It lives here, in the samples, because the player
 * sidecar (System.Media.SoundPlayer) has no volume control of its own.
 */
function processSamples(samples, sampleRate, gain = 1) {
  const ms = (v) => Math.round((sampleRate * v) / 1000);
  const pad = ms(PAD_MS);
  const keyUp = noiseBurst(ms(KEY_UP_MS), 0.32);
  const keyOff = noiseBurst(ms(KEY_OFF_MS), 0.36);

  // Assemble: pad · key-up · voice · key-off · pad, with the hiss bed under
  // everything between the pads (the channel hisses while keyed, not before).
  const total = pad + keyUp.length + samples.length + keyOff.length + pad;
  const out = new Float64Array(total);
  out.set(keyUp, pad);
  out.set(samples, pad + keyUp.length);
  out.set(keyOff, pad + keyUp.length + samples.length);
  for (let i = pad; i < total - pad; i++) out[i] += (Math.random() * 2 - 1) * HISS;

  // Band-limit, twice for a 4th-order slope — the sound of a comms channel.
  biquad(out, sampleRate, HP_HZ, 'hp');
  biquad(out, sampleRate, HP_HZ, 'hp');
  biquad(out, sampleRate, LP_HZ, 'lp');
  biquad(out, sampleRate, LP_HZ, 'lp');

  // Drive it: tanh soft-clip squashes the peaks like a hot channel.
  for (let i = 0; i < total; i++) out[i] = Math.tanh(out[i] * DRIVE);

  // Normalize to a consistent level, then apply the volume gain on top.
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) {
    const g = (PEAK / peak) * Math.max(0, Math.min(1, gain));
    for (let i = 0; i < total; i++) out[i] *= g;
  }
  return out;
}

/** File in, file out. Returns outPath for pipeline convenience. */
function radioify(inPath, outPath, gain = 1) {
  const { sampleRate, samples } = readWav(inPath);
  writeWav(outPath, sampleRate, processSamples(samples, sampleRate, gain));
  return outPath;
}

module.exports = { radioify, processSamples, readWav, writeWav };

/* ---- CLI: node electron/radio-fx.js in.wav [out.wav] ------------------------- */

if (require.main === module) {
  const inPath = process.argv[2];
  const outPath = process.argv[3] || inPath.replace(/\.wav$/i, '') + '.radio.wav';
  if (!inPath) {
    console.error('usage: node electron/radio-fx.js in.wav [out.wav]');
    process.exit(2);
  }
  radioify(inPath, outPath);
  console.log(outPath);
}
