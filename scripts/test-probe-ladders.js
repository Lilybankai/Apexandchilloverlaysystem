/**
 * scripts/test-probe-ladders.js — the ladder probe, against a fake LMU.
 * -----------------------------------------------------------------------------
 * probe-setup-ladders.js writes to a real car, so the parts that keep it safe
 * are exactly the parts that must not be trusted to a first live run. This
 * stands up a stub of LMU's REST API (the garage, the single-key write, the
 * standings row that says whether the car is in its stall), seeded from
 * scripts/fixtures/garage-gt3.json, and runs the real script against it:
 *
 *   1. --dry-run plans and posts nothing
 *   2. out of the garage stall it refuses and posts nothing
 *   3. a real walk records every rung's label and leaves the car as it was
 *   4. writes that fail mid-walk abort it — and the car is still restored
 *
 * Run: node scripts/test-probe-ladders.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const dirs = require('../electron/control-panel/setup-directions.js');

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   [${detail}]` : ''}`);
  if (!ok) failures += 1;
}

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'garage-gt3.json'), 'utf8'));

/** A label per step that a parser can read, so the output can be direction-checked. */
function labelFor(key, value) {
  if (key === 'VM_BRAKE_BALANCE') {
    const rear = 45 + value * 0.5;
    return `${(100 - rear).toFixed(1)}:${rear.toFixed(1)}`;
  }
  if (key.startsWith('WM_CAMBER')) return `${(-3 + value * 0.1).toFixed(1)} deg`;
  return String(value);
}

/**
 * The fake sim. `failOn(key, value)` makes chosen writes answer HTTP 500.
 * Symmetric setups mirror left-corner writes onto the right, as LMU does.
 */
function startStub({ inGarage = true, failOn = null } = {}) {
  const state = JSON.parse(JSON.stringify(FIXTURE));
  for (const [k, v] of Object.entries(state)) {
    if (v && typeof v.value === 'number') v.stringValue = labelFor(k, v.value);
  }
  const posts = [];
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/rest/garage/getPlayerGarageData') return send(200, state);
    if (req.method === 'GET' && req.url === '/rest/watch/standings') {
      return send(200, [{ player: true, inGarageStall: inGarage }, { player: false }]);
    }
    if (req.method === 'GET' && req.url === '/rest/garage/summary') {
      return send(200, { car: { fullPathTree: 'ELMS 2025, LMP2, Oreca 07' } });
    }
    const m = /^\/rest\/garage\/([A-Z0-9_]+(?:-W_(?:FL|FR|RL|RR))?)$/.exec(req.url);
    if (req.method === 'POST' && m) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const key = m[1];
        const { value } = JSON.parse(body || '{}');
        posts.push({ key, value });
        if (failOn && failOn(key, value)) return send(500);
        const v = state[key];
        if (!v) return send(404);
        const max = Math.max(v.minValue || 0, v.maxValue - 1);
        v.value = Math.min(max, Math.max(v.minValue || 0, value));
        v.stringValue = labelFor(key, v.value);
        if (state.symmetric && /-W_(FL|RL)$/.test(key)) {
          const twin = key.replace(/-W_FL$/, '-W_FR').replace(/-W_RL$/, '-W_RR');
          if (state[twin]) {
            state[twin].value = v.value;
            state[twin].stringValue = v.stringValue;
          }
        }
        return send(200, {});
      });
      return undefined;
    }
    return send(404);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, posts, state }));
  });
}

function runProbe(port, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'probe-setup-ladders.js'), ...args], {
      env: { ...process.env, APEX_LMU_PORT: String(port) },
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** Settings that no longer hold the value the fixture started with. */
function moved(state) {
  return Object.entries(FIXTURE)
    .filter(([, v]) => v && typeof v.value === 'number')
    .filter(([k, v]) => state[k].value !== v.value)
    .map(([k]) => k);
}

(async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-ladders-'));
  const file = path.join(outDir, 'ladders-test.json');
  const KEYS = ['--keys', 'VM_BRAKE_BALANCE,WM_CAMBER*', '--pace', '0', '--out', outDir];

  console.log('\n1. --dry-run');
  {
    const stub = await startStub();
    const r = await runProbe(stub.port, ['--class', 'test', ...KEYS, '--dry-run']);
    check('exits cleanly', r.code === 0, `exit ${r.code}`);
    check('posts nothing', stub.posts.length === 0, `${stub.posts.length} posts`);
    check('prints the plan', /VM_BRAKE_BALANCE\s+0\.\.27/.test(r.out) && /Dry run/.test(r.out));
    check(
      'skips the mirrored right corners on a symmetric setup',
      !/WM_CAMBER-W_FR/.test(r.out) && /WM_CAMBER-W_FL/.test(r.out),
    );
    check('writes no file', !fs.existsSync(file));
    stub.server.close();
  }

  console.log('\n2. out of the garage stall');
  {
    const stub = await startStub({ inGarage: false });
    const r = await runProbe(stub.port, ['--class', 'test', ...KEYS]);
    check('refuses with a non-zero exit', r.code !== 0 && /Refusing/.test(r.out), `exit ${r.code}`);
    check('posts nothing', stub.posts.length === 0, `${stub.posts.length} posts`);
    stub.server.close();
  }

  console.log('\n3. a full walk');
  {
    const stub = await startStub();
    const r = await runProbe(stub.port, ['--class', 'test', ...KEYS]);
    check('exits cleanly', r.code === 0, `exit ${r.code}`);
    const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    const bb = doc && doc.keys.VM_BRAKE_BALANCE;
    check('writes ladders-<class>.json', !!doc && doc.class === 'test' && doc.car === 'Oreca 07');
    check(
      'records a label for every rung',
      !!bb && bb.labels.length === 28 && bb.labels.every((l) => typeof l === 'string'),
    );
    check('walks the left corners only', !!doc && !!doc.keys['WM_CAMBER-W_FL'] && !doc.keys['WM_CAMBER-W_FR']);
    check('only ever posts single garage keys', stub.posts.every((p) => /^(VM_|WM_)/.test(p.key)));
    const left = moved(stub.state);
    check('leaves every setting as it found it', left.length === 0, left.join(', ') || 'restored');
    const report = dirs.applyLadders([doc]);
    dirs.clearLadders();
    check(
      'the output drops straight into the direction check',
      report.some((x) => x.key === 'VM_BRAKE_BALANCE' && x.verdict === 'agree') &&
        report.some((x) => x.key === 'WM_CAMBER-W_FL' && x.verdict === 'agree'),
    );
    stub.server.close();
  }

  console.log('\n4. writes fail mid-walk');
  {
    fs.rmSync(file, { force: true });
    // Two consecutive failed writes (rungs 5 and 6) trip the abort.
    const stub = await startStub({
      failOn: (key, value) => key === 'VM_BRAKE_BALANCE' && (value === 5 || value === 6),
    });
    const r = await runProbe(stub.port, ['--class', 'test', ...KEYS]);
    check('stops early with a non-zero exit', r.code !== 0 && /Stopped early/.test(r.out), `exit ${r.code}`);
    const left = moved(stub.state);
    check('…and still puts the car back', left.length === 0, left.join(', ') || 'restored');
    check('…and never reaches the keys after the failure', !stub.posts.some((p) => p.key.startsWith('WM_CAMBER')));
    const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    check('…and marks what it did write as partial', !!doc && typeof doc.partial === 'string');
    stub.server.close();
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nAll probe checks passed.' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
