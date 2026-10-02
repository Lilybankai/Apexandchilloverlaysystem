/**
 * electron/whisperServer.js — a resident whisper.cpp server for the engineer.
 * -----------------------------------------------------------------------------
 * The one-shot whisper-cli reloads the model for every question: ~0.35 s for
 * small.en on a warm disk cache, and far worse when the sim has pushed the
 * 466 MB file out of RAM. whisper-server (shipped in the same v1.9.1 zip as
 * the CLI, so every install already has it) loads it once and answers over
 * loopback HTTP: small.en questions measured 0.49 s here against 0.80 s for
 * the tuned CLI and 2.45 s for the old flags.
 *
 * Loopback only (127.0.0.1 never raises the Windows Firewall prompt), a port
 * the OS picked a moment earlier, stdio ignored (an undrained pipe can stall
 * a chatty child). engineerStt.js owns the policy — when to run one, which
 * model, falling back to the CLI — this file is just the process.
 *
 * A crashed app does not strand the model in RAM: libuv puts every child it
 * spawns on Windows into a kill-on-close job object, so the OS ends the server
 * with its parent (verified: SIGKILL the parent, the server goes with it). A
 * clean quit kills it explicitly via the exit hook below.
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const READY_TIMEOUT_MS = 20000;

const live = new Set();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    for (const s of live) s.stop();
  });
}

/** A loopback port nobody is using right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** A multipart/form-data body: the WAV plus plain string fields. */
function multipart(fields, fileField, fileName, fileBuf) {
  const boundary = `----apexwhisper${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\n` +
        'Content-Type: audio/wav\r\n\r\n',
      'utf8',
    ),
  );
  parts.push(fileBuf);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function httpRequest({ port, method, pathName, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: pathName, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer in ${timeoutMs} ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

class WhisperServer {
  /**
   * @param {object} o
   * @param {string} o.exe      whisper-server.exe
   * @param {string} o.model    the ggml model it holds for its whole life
   * @param {number} o.threads
   * @param {Function} [o.spawnFn]     child_process.spawn (a seam for tests)
   */
  constructor({ exe, model, threads = 4, spawnFn = spawn }) {
    this.exe = exe;
    this.model = model;
    this.threads = threads;
    this.spawnFn = spawnFn;
    this.child = null;
    this.port = 0;
    this.ready = false;
    this.dead = false;
    this.busy = Promise.resolve();
  }

  args() {
    return [
      '-m', this.model,
      '-t', String(this.threads),
      '-bs', '1',
      '-bo', '1',
      '-l', 'en',
      '-nt',
      '-ng',
      '-sns',
      '--host', '127.0.0.1',
      '--port', String(this.port),
    ];
  }

  async start() {
    this.port = await freePort();
    if (this.dead) throw new Error('stopped before it started');
    const child = this.spawnFn(this.exe, this.args(), {
      cwd: path.dirname(this.exe),
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, PATH: `${path.dirname(this.exe)}${path.delimiter}${process.env.PATH || ''}` },
    });
    this.child = child;
    live.add(this);
    hookExit();
    let exited = false;
    child.on('error', () => {
      exited = true;
      this.markDead();
    });
    child.on('exit', () => {
      exited = true;
      this.markDead();
    });
    // The model loads BEFORE the socket opens, so the first HTTP answer of any
    // kind (the root page, or a 404 without one) means it is ready to work.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (exited || this.dead) throw new Error('whisper-server exited during start-up');
      try {
        await httpRequest({ port: this.port, method: 'GET', pathName: '/', timeoutMs: 1000 });
        break;
      } catch {
        if (Date.now() > deadline) {
          this.stop();
          throw new Error(`whisper-server not listening after ${READY_TIMEOUT_MS} ms`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    this.ready = true;
    return this;
  }

  /**
   * Transcribe one 16 kHz WAV. Serialised: the server runs one inference at a
   * time anyway, and a queue here keeps a timeout honest about OUR request.
   */
  transcribe(wavPath, { prompt = '', audioCtx = 0, timeoutMs = 6000 } = {}) {
    const run = async () => {
      if (!this.ready || this.dead) throw new Error('whisper-server not running');
      const fields = { response_format: 'json', temperature: '0', language: 'en' };
      if (prompt) fields.prompt = prompt;
      if (audioCtx > 0) fields.audio_ctx = String(audioCtx);
      const { body, contentType } = multipart(fields, 'file', 'clip.wav', fs.readFileSync(wavPath));
      const res = await httpRequest({
        port: this.port,
        method: 'POST',
        pathName: '/inference',
        headers: { 'Content-Type': contentType, 'Content-Length': body.length },
        body,
        timeoutMs,
      });
      if (res.status !== 200) throw new Error(`whisper-server HTTP ${res.status}`);
      let j;
      try {
        j = JSON.parse(res.body);
      } catch {
        throw new Error('whisper-server sent something that is not JSON');
      }
      if (j && j.error) throw new Error(`whisper-server: ${j.error}`);
      const text = String((j && j.text) || '')
        .replace(/\s+/g, ' ')
        .trim();
      return { text };
    };
    const result = this.busy.then(run, run);
    this.busy = result.catch(() => {});
    return result;
  }

  markDead() {
    this.ready = false;
    this.dead = true;
    live.delete(this);
  }

  stop() {
    const child = this.child;
    this.markDead();
    this.child = null;
    if (child) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

module.exports = { WhisperServer, multipart, freePort };
