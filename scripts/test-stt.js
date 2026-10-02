/**
 * scripts/test-stt.js — the engineer's ears, fast enough to use mid-corner.
 * -----------------------------------------------------------------------------
 * 2026-10-02: engineer_calls.stt_ms went from a ~1.1 s weekly median to
 * 3.2–3.5 s (5.9 s worst) — every driver whose machine had silently fetched
 * "better ears" (small.en) was paying a per-question model load, a 30-second
 * encoder pass and a beam-5 decode for a two-second clip. This suite pins the
 * decisions that fixed it, without needing whisper on the machine:
 *
 *   1. decode tuning — threads from the CPU, audio_ctx from the clip length
 *      (coarse, never tight: tight loops whisper), greedy, fallback kept;
 *   2. the speed guard — small.en only while it is fast HERE;
 *   3. the resident server — used when it holds the right model, swapped
 *      when the model changes, abandoned for the CLI the moment it stumbles,
 *      never started on a low-RAM machine or an install without the binary;
 *   4. WhisperServer itself, against a stand-in HTTP server.
 */

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const stt = require('../electron/engineerStt');
const radioFx = require('../electron/radio-fx');
const { WhisperServer, multipart } = require('../electron/whisperServer');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-stt-test-'));
function bigEnough(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, bytes);
  fs.closeSync(fd);
}

(async () => {
  /* ---- 1. decode tuning ------------------------------------------------- */
  console.log('\n[decode tuning]');
  check('8-core/16-thread → 7 threads (a core left for the sim)', stt.sttThreads(16) === 7);
  check('6-core/12-thread → 5', stt.sttThreads(12) === 5);
  check('4-core/8-thread → 4 (the old fixed value is the floor)', stt.sttThreads(8) === 4);
  check('16-core/32-thread → capped at 8', stt.sttThreads(32) === 8);
  check('a 2-thread box is not oversubscribed', stt.sttThreads(2) === 2);
  check('garbage → still a sane count', stt.sttThreads(NaN) >= 1);

  check('a 1.2 s padded clip → 512 frames (10 s), not tight', stt.audioCtxFor(1200) === 512);
  check('the full 6 s listen window → 512', stt.audioCtxFor(6000) === 512);
  check('9 s → 768', stt.audioCtxFor(9000) === 768);
  check('20 s → full context', stt.audioCtxFor(20000) === 0);
  check('unknown length → full context', stt.audioCtxFor(0) === 0 && stt.audioCtxFor(undefined) === 0);

  // The WAV trimForWhisper actually writes, measured back from its header.
  const raw = path.join(tmp, 'raw.wav');
  const rate = 22050;
  const sig = new Float64Array(rate * 2);
  for (let i = Math.round(rate * 0.5); i < rate * 1.5; i++) sig[i] = 0.3 * Math.sin(i / 5);
  radioFx.writeWav(raw, rate, sig);
  const clip = stt.trimForWhisper(radioFx, raw, path.join(tmp, 'clip.wav'));
  const dur = stt.wavDurationMs(clip.path);
  check('wavDurationMs reads the trimmed clip (1 s of speech + pads)', dur > 1100 && dur < 1400, Math.round(dur));
  const shortRaw = path.join(tmp, 'short.wav');
  const shortSig = new Float64Array(rate);
  for (let i = 1000; i < 1000 + rate * 0.3; i++) shortSig[i] = 0.3 * Math.sin(i / 5);
  radioFx.writeWav(shortRaw, rate, shortSig);
  const shortClip = stt.trimForWhisper(radioFx, shortRaw, path.join(tmp, 'short16.wav'));
  check('a one-word clip is padded to 1.2 s and measured so', Math.abs(stt.wavDurationMs(shortClip.path) - 1200) < 2);
  check('a missing file → 0 (full context, not a crash)', stt.wavDurationMs(path.join(tmp, 'nope.wav')) === 0);

  const args = stt.cliArgs({ model: 'm.bin', wav: 'a.wav', prefix: 'a', threads: 7, audioCtx: 512 });
  const flag = (f) => args[args.indexOf(f) + 1];
  check('CLI: greedy (-bs 1 -bo 1), not the beam-5 default', flag('-bs') === '1' && flag('-bo') === '1');
  check('CLI: threads passed through', flag('-t') === '7');
  check('CLI: audio_ctx passed through', flag('-ac') === '512');
  check('CLI: the racing prompt still rides along', flag('--prompt') === stt.RACING_PROMPT && stt.RACING_PROMPT.includes('tyre temps'));
  check('CLI: JSON out, no timestamps, CPU only, non-speech suppressed', ['-oj', '-nt', '-ng', '-sns'].every((f) => args.includes(f)));
  check('CLI: temperature fallback kept (no -nf) — it rescues loops', !args.includes('-nf'));
  check('CLI: no -ac at all when the length is unknown', !stt.cliArgs({ model: 'm', wav: 'a', prefix: 'a', threads: 4, audioCtx: 0 }).includes('-ac'));

  /* ---- 2. the speed guard ----------------------------------------------- */
  console.log('\n[speed guard]');
  const SMALL = path.join('x', 'ggml-small.en.bin');
  const BASE = path.join('x', 'ggml-base.en.bin');
  let g = new stt.SpeedGuard({ budgetMs: 1000 });
  g.record(BASE, 5000);
  g.record(BASE, 5000);
  check('base.en is never demoted (nothing cheaper to fall to)', g.allowsSmall());
  g.record(SMALL, 2500);
  check('one slow small.en question is not enough (cold cache, an update spike)', g.allowsSmall());
  g.record(SMALL, 600);
  g.record(SMALL, 2600);
  check('two of the last three over budget → demoted', !g.allowsSmall() && /2 of the last 3/.test(g.reason), g.reason);
  g = new stt.SpeedGuard({ budgetMs: 1000 });
  for (const ms of [1200, 700, 800, 1300, 600, 650]) g.record(SMALL, ms);
  check('slow asks that age out of the window do not add up', g.allowsSmall());
  g = new stt.SpeedGuard({ budgetMs: 1000 });
  g.record(SMALL, 900, { probe: true });
  check('a warm-up inside budget keeps small.en', g.allowsSmall());
  g.record(SMALL, 1400, { probe: true });
  check('a warm-up over budget demotes at once', !g.allowsSmall() && /warm-up/.test(g.reason));
  check('the default budget is the ~1.3 s the field target allows', stt.SMALL_BUDGET_MS === 1300);

  // pickModel over a real install layout: bundled base + downloaded small.
  const bundled = path.join(tmp, 'resources', 'whisper');
  const user = path.join(tmp, 'user', 'whisper');
  const cli = path.join(bundled, 'bin', 'Release', 'whisper-cli.exe');
  bigEnough(cli, 10);
  bigEnough(path.join(bundled, 'ggml-base.en.bin'), 1_100_000);
  bigEnough(path.join(user, 'ggml-small.en.bin'), 100_000_001);
  const dirs = [bundled, user];
  check('small.en preferred while it is fast', stt.pickModel(dirs, new stt.SpeedGuard()) === path.join(user, 'ggml-small.en.bin'));
  const slow = new stt.SpeedGuard();
  slow.demote('test');
  check('demoted → base.en', stt.pickModel(dirs, slow) === path.join(bundled, 'ggml-base.en.bin'));
  check('findModel itself is unchanged (better-ears status still reads "installed")', stt.findModel(dirs) === path.join(user, 'ggml-small.en.bin'));
  const onlySmall = path.join(tmp, 'only-small');
  bigEnough(path.join(onlySmall, 'ggml-small.en.bin'), 100_000_001);
  check('small.en alone stays small.en even when slow — slow beats deaf', stt.pickModel([onlySmall], slow) === path.join(onlySmall, 'ggml-small.en.bin'));

  /* ---- 3. the resident engine ------------------------------------------- */
  console.log('\n[resident engine]');
  const engine = stt._engine;
  const reset = () => {
    stt.shutdown();
    engine.guard = new stt.SpeedGuard();
    engine.failedAt = 0;
    engine.wanted = false;
    engine.server = null;
  };
  let clock = 0;
  engine.now = () => clock;
  engine.totalmem = () => 32 * 1024 ** 3;
  const cliCalls = [];
  engine.execFile = (file, argv, opts, cb) => {
    cliCalls.push(argv);
    const prefix = argv[argv.indexOf('-of') + 1];
    clock += 800;
    fs.writeFileSync(`${prefix}.json`, JSON.stringify({ transcription: [{ text: ' gap to P10. ' }] }));
    setImmediate(() => cb(null, '', ''));
  };
  const made = [];
  // Stand-in servers: the policy is under test here, the process in part 4.
  let serverAnswerMs = 400;
  let serverFails = false;
  engine.makeServer = (opts) => {
    const s = {
      ...opts,
      ready: false,
      dead: false,
      asked: [],
      async start() {
        this.ready = true;
      },
      async transcribe(wav, o) {
        this.asked.push(o);
        if (serverFails && !/probe/.test(wav)) throw new Error('ECONNRESET');
        clock += serverAnswerMs;
        return { text: 'how are my tyres?' };
      },
      stop() {
        this.dead = true;
        this.ready = false;
      },
    };
    made.push(s);
    return s;
  };

  const wav = clip.path;

  // An install without whisper-server.exe (pre-1.9 zips): the CLI, tuned.
  reset();
  await stt.warm(dirs);
  check('no whisper-server.exe → no server', made.length === 0 && engine.server === null);
  let r = await stt.transcribeAsync(dirs, wav);
  check('… and the question goes to the CLI', r.via === 'cli' && r.text === 'gap to P10.');
  const last = cliCalls[cliCalls.length - 1];
  check('… with the tuned flags', last[last.indexOf('-bs') + 1] === '1' && last[last.indexOf('-ac') + 1] === '512');
  check('… on small.en', path.basename(r.model) === 'ggml-small.en.bin');

  // Now the server binary is there.
  bigEnough(path.join(path.dirname(cli), 'whisper-server.exe'), 10);
  reset();
  engine.totalmem = () => 8 * 1024 ** 3;
  await stt.warm(dirs);
  check('an 8 GB machine keeps the CLI (0.6 GB resident is not free there)', made.length === 0);
  engine.totalmem = () => 32 * 1024 ** 3;
  process.env.APEX_WHISPER_RESIDENT = '0';
  await stt.warm(dirs);
  check('APEX_WHISPER_RESIDENT=0 is a field kill-switch', made.length === 0);
  delete process.env.APEX_WHISPER_RESIDENT;

  reset();
  await stt.warm(dirs);
  check('warm() starts a server holding small.en', made.length === 1 && path.basename(made[0].model) === 'ggml-small.en.bin' && made[0].ready);
  check('… with the machine-sized thread count', made[0].threads === stt.sttThreads());
  check('… and probes it once (the warm-up)', made[0].asked.length === 1);
  const before = cliCalls.length;
  r = await stt.transcribeAsync(dirs, wav);
  check('a question goes to the resident server', r.via === 'server' && r.text === 'how are my tyres?' && cliCalls.length === before);
  check('… with the racing prompt and the clip-sized audio_ctx', made[0].asked[1].prompt === stt.RACING_PROMPT && made[0].asked[1].audioCtx === 512);
  check('… and reports what stt_ms will log', r.ms === 400);
  await stt.warm(dirs);
  check('a second warm() (stop-then-start) reuses it, no reload', made.length === 1);
  stt.release();
  await stt.warm(dirs);
  check('release() then warm() inside the grace period reuses it too', made.length === 1 && !made[0].dead);

  // A server that stumbles: the CLI answers THIS question, and the server is
  // left alone for a while rather than respawned into the same failure.
  serverFails = true;
  r = await stt.transcribeAsync(dirs, wav);
  check('a server failure falls back to the CLI for the same question', r.via === 'cli' && r.text === 'gap to P10.');
  check('… the broken server is stopped', made[0].dead && engine.server === null);
  check('… and not respawned straight away', made.length === 1);
  serverFails = false;
  clock += 6 * 60 * 1000;
  r = await stt.transcribeAsync(dirs, wav);
  await new Promise((res) => setImmediate(res));
  check('after the back-off a question re-arms the server for the next one', made.length === 2 && made[1].ready);

  // small.en too slow on this machine: two slow questions → base.en, and the
  // server swaps model for the NEXT question.
  reset();
  made.length = 0;
  await stt.warm(dirs);
  serverAnswerMs = 2500;
  await stt.transcribeAsync(dirs, wav);
  check('one slow answer: still small.en', engine.guard.allowsSmall());
  r = await stt.transcribeAsync(dirs, wav);
  await new Promise((res) => setImmediate(res));
  check('two slow answers: small.en demoted', !engine.guard.allowsSmall() && stt.sttState().smallDemoted);
  check('… the server is swapped to base.en', made.length === 2 && made[0].dead && path.basename(made[1].model) === 'ggml-base.en.bin');
  serverAnswerMs = 200;
  r = await stt.transcribeAsync(dirs, wav);
  check('… and the next question runs there', r.via === 'server' && path.basename(r.model) === 'ggml-base.en.bin');

  // A warm-up that is already over budget swaps before anyone asks.
  reset();
  made.length = 0;
  serverAnswerMs = 3000;
  await stt.warm(dirs);
  check('a slow warm-up probe demotes at once', !engine.guard.allowsSmall());
  check('… and warm() lands on a base.en server', made.length === 2 && path.basename(engine.server.model) === 'ggml-base.en.bin');
  serverAnswerMs = 400;

  stt.release(0);
  check('release(0) stops the server', engine.server === null && made.every((s) => s.dead));
  reset();

  /* ---- 4. WhisperServer, the process ------------------------------------ */
  console.log('\n[WhisperServer]');
  const { body, contentType } = multipart({ prompt: 'gap ahead', audio_ctx: '512' }, 'file', 'clip.wav', Buffer.from('RIFFxxxx'));
  const bodyText = body.toString('latin1');
  check('multipart carries every field and the file', /name="prompt"\r\n\r\ngap ahead\r\n/.test(bodyText) && /name="audio_ctx"\r\n\r\n512/.test(bodyText) && bodyText.includes('filename="clip.wav"') && bodyText.includes('RIFFxxxx'));
  check('… under the boundary it declares', bodyText.includes(contentType.split('boundary=')[1]));

  // A stand-in whisper-server: the fake spawn reads --port and listens there.
  let received = null;
  let fakeHttp = null;
  let fakeChild = null;
  const spawnFn = (exe, argv) => {
    const port = Number(argv[argv.indexOf('--port') + 1]);
    fakeChild = new EventEmitter();
    fakeChild.pid = 4242;
    fakeChild.args = argv;
    fakeChild.kill = () => {
      fakeHttp.close();
      setImmediate(() => fakeChild.emit('exit', 0));
    };
    fakeHttp = http.createServer((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(404);
        res.end();
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received = { url: req.url, type: req.headers['content-type'], body: Buffer.concat(chunks).toString('latin1') };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: ' What are my  tyre temps? \n' }));
      });
    });
    // Late, like a model load: start() must poll until it answers.
    setTimeout(() => fakeHttp.listen(port, '127.0.0.1'), 150);
    return fakeChild;
  };
  const ws = new WhisperServer({ exe: path.join(tmp, 'whisper-server.exe'), model: 'm.bin', threads: 7, spawnFn });
  await ws.start();
  check('start() waits for the socket (a 404 still means loaded)', ws.ready && !ws.dead);
  check('spawned loopback-only, greedy, with the threads asked for', fakeChild.args.includes('127.0.0.1') && fakeChild.args[fakeChild.args.indexOf('-bs') + 1] === '1' && fakeChild.args[fakeChild.args.indexOf('-t') + 1] === '7');
  const out = await ws.transcribe(clip.path, { prompt: stt.RACING_PROMPT, audioCtx: 512, timeoutMs: 3000 });
  check('transcribe() posts to /inference', received && received.url === '/inference' && /multipart\/form-data/.test(received.type));
  check('… with the prompt, audio_ctx and json format', received.body.includes('tyre temps') && /name="audio_ctx"\r\n\r\n512/.test(received.body) && /name="response_format"\r\n\r\njson/.test(received.body));
  check('… and returns the text, whitespace-folded', out.text === 'What are my tyre temps?', out.text);
  ws.stop();
  await new Promise((res) => setTimeout(res, 20));
  check('stop() kills the process and marks it dead', ws.dead && !ws.ready);
  let threw = false;
  try {
    await ws.transcribe(clip.path, {});
  } catch {
    threw = true;
  }
  check('a dead server refuses work (so the caller takes the CLI)', threw);

  // A child that exits during start-up rejects instead of hanging.
  const dying = new WhisperServer({
    exe: 'x.exe',
    model: 'm',
    spawnFn: () => {
      const c = new EventEmitter();
      c.kill = () => {};
      setTimeout(() => c.emit('exit', 1), 50);
      return c;
    },
  });
  let startErr = null;
  try {
    await dying.start();
  } catch (err) {
    startErr = err;
  }
  check('a server that dies while loading rejects start()', startErr && /exited/.test(startErr.message));

  /* ---- 5. wiring --------------------------------------------------------- */
  console.log('\n[wiring]');
  const engSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'engineer.js'), 'utf8');
  check('EngineerService.start() warms the model', /stt\.warm\(this\.sttRoots\(\)\)/.test(engSrc));
  check('EngineerService.stop() releases it', /stt\.release\(\)/.test(engSrc));
  check('questions still go through stt.transcribeAsync', /stt\.transcribeAsync\(whisperAt, clip\.path\)/.test(engSrc));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
