/**
 * scripts/probe-setup-ladders.js — walk every rung of every setup ladder.
 * -----------------------------------------------------------------------------
 * The garage API speaks in step indices; only the sim's label for each step
 * ("52.3:47.7", "FF6-60 deg", "-0.35 deg") says what an index MEANS. The
 * corner-balance macros need to know which way each index runs, and
 * electron/control-panel/setup-directions.js holds that — sourced from the
 * census of saved setups (scripts/census-svm-ladders.js), which only ever sees
 * the rungs somebody happened to save. This script sees all of them: it steps
 * each adjustable key across its whole range in the live garage, records the
 * label at every index, and puts the car back exactly as it found it.
 *
 * Output: scripts/fixtures/ladders-<class>.json. scripts/test-setup.js reads
 * every such file, checks the direction table against it, and FAILS naming
 * any family that runs the other way — that is the cue to flip the entry.
 *
 * SAFETY — this writes to the car, so it is careful about it:
 *   - It refuses unless LMU answers AND the player's car is in its garage
 *     stall (standings `inGarageStall`). Out on track it does nothing.
 *   - Writes go through the same single-key path the setup editor uses
 *     (`POST /rest/garage/<KEY>` with `{ value }`, see setupControl.ts
 *     setValue). It never posts the pit menu or a whole setup — whole-menu
 *     POSTs are what flickered Replace Brakes on by themselves in October.
 *   - One write at a time, paced (`--pace`, default 150 ms), each followed by
 *     a read-back.
 *   - Every key is put back the moment its walk finishes, and a final pass
 *     re-reads the whole garage and re-posts anything that still differs from
 *     the snapshot taken at the start. That pass runs in `finally`: on
 *     Ctrl+C, on a failed write, on any error.
 *   - Two failed writes in a row abort the walk (and still restore).
 *   - Fuel, virtual energy and the pit-stop plan are skipped unless named in
 *     `--keys`. With the setup symmetric only the left corners are walked
 *     (the right ones mirror); `--all-corners` walks all four.
 *
 * Run it (LMU running, player in the garage, ideally on a setup you have
 * saved so nothing is lost even if the PC dies mid-walk):
 *
 *   npm run build
 *   node scripts/probe-garage-keys.js --save hypercar-lmh     (Ferrari/Peugeot/Toyota…)
 *   node scripts/probe-setup-ladders.js --class hypercar-lmh
 *   node scripts/probe-garage-keys.js --save hypercar-lmdh    (Porsche 963/Cadillac/BMW…)
 *   node scripts/probe-setup-ladders.js --class hypercar-lmdh
 *   node scripts/probe-garage-keys.js --save lmp2             (Oreca 07)
 *   node scripts/probe-setup-ladders.js --class lmp2
 *   node scripts/probe-garage-keys.js --save lmp3
 *   node scripts/probe-setup-ladders.js --class lmp3
 *   node scripts/probe-garage-keys.js --save gt3
 *   node scripts/probe-setup-ladders.js --class gt3
 *   npm run test:setup                                         (checks the table against them)
 *
 * Options:
 *   --class <name>   required; names the output file (ladders-<name>.json)
 *   --keys a,b,c*    only these keys; a trailing * is a prefix (WM_CAMBER*)
 *   --dry-run        read the garage, print the plan, write nothing
 *   --pace <ms>      gap after each write (default 150)
 *   --all-corners    walk FR/RR too, even with the setup symmetric
 *   --out <dir>      where to write (default scripts/fixtures)
 *
 * A walk of a whole car is ~1,500 writes — about five minutes at the default
 * pace. A first run with `--keys VM_BRAKE_BALANCE` is a good way to watch it
 * work before letting it loose.
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const LMU_PORT = Number(process.env.APEX_LMU_PORT || 6397);
/** The same key shape setupState.ts accepts — nothing else is ever posted. */
const GARAGE_WRITE_KEY = /^(VM_[A-Z0-9_]+|WM_[A-Z0-9_]+-W_(FL|FR|RL|RR))$/;
/** Not setup balance, and stepping them would empty the tank in the garage UI. */
const SKIP_BY_DEFAULT = /^VM_(FUEL_LEVEL|VIRTUAL_ENERGY|NUM_PITSTOPS|PITSTOP_\d+)$/;

/* ---- arguments ------------------------------------------------------------- */

function parseArgs(argv) {
  const opts = { cls: '', keys: null, dryRun: false, pace: 150, allCorners: false, out: path.join(__dirname, 'fixtures') };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--class') opts.cls = String(argv[++i] || '');
    else if (a === '--keys') opts.keys = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--pace') opts.pace = Math.max(0, Number(argv[++i]) || 0);
    else if (a === '--all-corners') opts.allCorners = true;
    else if (a === '--out') opts.out = path.resolve(String(argv[++i] || ''));
    else throw new Error(`unknown option ${a}`);
  }
  if (!/^[a-z0-9-]+$/i.test(opts.cls)) throw new Error('--class <name> is required (letters, digits, dashes), e.g. --class gt3');
  opts.cls = opts.cls.toLowerCase();
  return opts;
}

/* ---- REST ------------------------------------------------------------------ */

function request(method, p, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port: LMU_PORT,
        path: p,
        method,
        timeout: 2500,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          const status = res.statusCode || 0;
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ ok: status >= 200 && status < 300, status, json });
        });
      },
    );
    req.on('error', () => resolve({ ok: false, status: 0, json: null }));
    req.on('timeout', () => req.destroy());
    if (payload) req.write(payload);
    req.end();
  });
}

const getJson = async (p) => (await request('GET', p)).json;
const garage = () => getJson('/rest/garage/getPlayerGarageData');

/** The editor's single-key write, and only that. */
async function postKey(key, value) {
  if (!GARAGE_WRITE_KEY.test(key)) return false;
  const res = await request('POST', `/rest/garage/${key}`, { value });
  return res.ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isSetting(v) {
  return v && typeof v === 'object' && typeof v.value === 'number' && typeof v.maxValue === 'number';
}

/** Same projection as setupState.ts: maxValue is an option COUNT. */
function bounds(v) {
  const min = typeof v.minValue === 'number' ? v.minValue : 0;
  return { min, max: Math.max(min, v.maxValue - 1) };
}

function wanted(key, opts) {
  if (opts.keys) {
    return opts.keys.some((k) => (k.endsWith('*') ? key.startsWith(k.slice(0, -1)) : key === k));
  }
  return !SKIP_BY_DEFAULT.test(key);
}

/* ---- the walk ------------------------------------------------------------ */

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const data = await garage();
  if (!data || typeof data !== 'object') {
    console.error(`No garage data from 127.0.0.1:${LMU_PORT} — is LMU running, with a car loaded?`);
    process.exit(1);
  }
  const standings = await getJson('/rest/watch/standings');
  const me = Array.isArray(standings) ? standings.find((r) => r && r.player === true) : null;
  const inGarage = !!me && me.inGarageStall === true;
  const summary = (await getJson('/rest/garage/summary')) || {};
  const tree = (summary.car && summary.car.fullPathTree) || '';
  const car = tree.includes(',') ? tree.split(',').pop().trim() : tree.trim();

  const symmetric = data.symmetric === true;
  const plan = [];
  for (const [key, v] of Object.entries(data)) {
    if (!isSetting(v) || !GARAGE_WRITE_KEY.test(key)) continue;
    if (v.available === false || v.isFreeSetting === false) continue;
    const { min, max } = bounds(v);
    if (min >= max) continue;
    if (!wanted(key, opts)) continue;
    if (symmetric && !opts.allCorners && /-W_(FR|RR)$/.test(key)) continue;
    plan.push({ key, min, max, original: v.value });
  }
  const writes = plan.reduce((n, p) => n + (p.max - p.min + 1) + 1, 0);

  console.log(`Car: ${car || '(unknown)'} · class tag: ${opts.cls} · symmetric: ${symmetric}`);
  console.log(`In the garage stall: ${inGarage ? 'yes' : 'NO'}`);
  console.log(`${plan.length} keys to walk, ~${writes} writes, ~${Math.ceil((writes * (opts.pace + 30)) / 1000)} s`);

  if (opts.dryRun) {
    for (const p of plan) console.log(`  ${p.key.padEnd(34)} ${p.min}..${p.max}  (now ${p.original})`);
    console.log('\nDry run — nothing written.');
    return;
  }
  if (!inGarage) {
    console.error('\nRefusing: the player car is not in its garage stall. Enter the garage (car setup screen) and run again.');
    process.exit(2);
  }
  if (plan.length === 0) {
    console.error('\nNothing to walk — no adjustable keys match.');
    process.exit(1);
  }

  // The snapshot every restore goes back to: the whole garage, not just the
  // planned keys, because a symmetric write moves the mirrored corner too.
  const snapshot = new Map();
  for (const [key, v] of Object.entries(data)) if (isSetting(v) && GARAGE_WRITE_KEY.test(key)) snapshot.set(key, v.value);

  let aborted = '';
  const onSigint = () => {
    if (!aborted) {
      aborted = 'interrupted (Ctrl+C)';
      console.error('\nInterrupted — finishing the current write, then restoring the car. Please wait.');
    } else {
      console.error('Still restoring — the car is being put back, one moment.');
    }
  };
  process.on('SIGINT', onSigint);

  const out = {
    version: 1,
    class: opts.cls,
    car,
    capturedAt: new Date().toISOString(),
    symmetric,
    keys: {},
  };
  let failedInARow = 0;

  try {
    for (const p of plan) {
      if (aborted) break;
      const labels = [];
      const refused = [];
      for (let i = p.min; i <= p.max; i += 1) {
        if (aborted) break;
        const ok = await postKey(p.key, i);
        await sleep(opts.pace);
        if (!ok) {
          failedInARow += 1;
          if (failedInARow >= 2) {
            aborted = `two writes failed in a row (last: ${p.key} = ${i})`;
            break;
          }
          labels.push(null);
          refused.push(i);
          continue;
        }
        failedInARow = 0;
        const now = await garage();
        const v = now && now[p.key];
        if (!v || v.value !== i) refused.push(i);
        labels.push(v && typeof v.stringValue === 'string' ? v.stringValue : null);
      }
      // Put this key back before touching the next.
      await postKey(p.key, p.original);
      await sleep(opts.pace);
      out.keys[p.key] = { min: p.min, max: p.max, original: p.original, labels, ...(refused.length ? { refused } : {}) };
      process.stdout.write(`  ${p.key.padEnd(34)} ${labels.length} rungs${refused.length ? `, ${refused.length} refused` : ''}\n`);
    }
  } catch (err) {
    aborted = `error: ${err && err.message ? err.message : err}`;
  } finally {
    const left = await restore(snapshot, opts.pace);
    process.removeListener('SIGINT', onSigint);
    if (left.length) {
      console.error(`\n!! Could not restore ${left.length} setting(s): ${left.join(', ')}`);
      console.error('   Reload your saved setup in the garage before driving.');
      process.exitCode = 3;
    } else {
      console.log('\nCar restored to the setup it started on.');
    }
  }

  const done = Object.keys(out.keys).length;
  if (done > 0) {
    if (aborted) out.partial = aborted;
    fs.mkdirSync(opts.out, { recursive: true });
    const file = path.join(opts.out, `ladders-${opts.cls}.json`);
    fs.writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
    console.log(`Ladders written: ${file} (${done} keys${aborted ? ', PARTIAL' : ''})`);
  }
  if (aborted) {
    console.error(`Stopped early: ${aborted}`);
    if (!process.exitCode) process.exitCode = 4;
  }
}

/**
 * Re-reads the garage and re-posts every setting that differs from the
 * snapshot, up to three passes. Returns the keys still wrong.
 */
async function restore(snapshot, pace) {
  let wrong = [];
  for (let pass = 0; pass < 3; pass += 1) {
    const now = await garage();
    if (!now) return [...snapshot.keys()].slice(0, 5).concat(['(garage unreadable)']);
    wrong = [...snapshot].filter(([k, v]) => isSetting(now[k]) && now[k].value !== v).map(([k]) => k);
    if (wrong.length === 0) return [];
    for (const k of wrong) {
      await postKey(k, snapshot.get(k));
      await sleep(pace);
    }
  }
  const now = await garage();
  return now ? [...snapshot].filter(([k, v]) => isSetting(now[k]) && now[k].value !== v).map(([k]) => k) : wrong;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
