/**
 * scripts/email-assets.js — the pictures in the lifecycle emails.
 * -----------------------------------------------------------------------------
 *   node scripts/email-assets.js          # generate what can be generated
 *   node scripts/email-assets.js --check  # report only, change nothing
 *
 * web/src/email/manifest.json lists every image the templates ask for and where
 * each one comes from:
 *
 *   "svg"      rasterised from the app's own logo with sharp. Always regenerated.
 *   "harness"  captured from the stubbed-bridge screenshot harness
 *              (scripts/make-shot-harness.js) in headless Edge or Chrome, so
 *              the shot is the real control panel with real fixture data.
 *   "manual"   a picture only a running sim can produce — the overlay layer over
 *              LMU, the engineer mid-conversation, the pit wall on a tablet.
 *              Drop the file in at the name the manifest gives it and this
 *              script resizes and re-encodes it like any other.
 *
 * The "manual" entries are not an oversight. The harness stubs the bridge for
 * the tabs that have fixtures — the Dashboard and Review — and the rest of the
 * panel would screenshot as an empty state. A misleading picture of the product
 * is worse than no picture, and the templates are written to read correctly
 * with every image blocked, which is how most people will see them anyway.
 *
 * Everything lands in web/src/email/, which scripts/build-web.js copies to
 * web/dist/email/ and GitHub Pages serves at <site>/email/<name>.png. That URL
 * is permanent by obligation: a mail sent today still asks for it next year, so
 * files are added and replaced here, never renamed.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'web', 'src', 'email');
const MANIFEST = path.join(DIR, 'manifest.json');
const PANEL = path.join(ROOT, 'electron', 'control-panel');
const PORT = 17556; // one past the harness's documented port, so both can run

const CHECK_ONLY = process.argv.includes('--check');

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const WIDTH = manifest.width || 1056;

let made = 0;
let kept = 0;
const missing = [];

main().catch((e) => {
  console.error(`\nemail-assets failed: ${e.message}\n`);
  process.exit(1);
});

async function main() {
  const sharp = requireSharp();
  const entries = Object.entries(manifest.shots);

  // The harness shots first, so the browser is launched at most once.
  const harnessShots = entries.filter(([, v]) => v.source === 'harness');
  let captured = new Map();
  if (harnessShots.length && !CHECK_ONLY) {
    captured = await captureHarness(harnessShots);
  }

  for (const [name, spec] of entries) {
    const out = path.join(DIR, name);

    if (CHECK_ONLY) {
      if (fs.existsSync(out)) kept++;
      else missing.push([name, spec]);
      continue;
    }

    if (spec.source === 'svg') {
      const svg = path.join(ROOT, spec.from);
      if (!fs.existsSync(svg)) {
        missing.push([name, spec]);
        continue;
      }
      // Rendered at 3× and scaled down: an email is read on a phone at 3×
      // device pixels, and a logo that was rasterised at its display height
      // looks soft on every modern screen.
      const png = await sharp(fs.readFileSync(svg), { density: 600 })
        .resize({ height: (spec.height || 52) * 3, fit: 'inside' })
        .png({ compressionLevel: 9 })
        .toBuffer();
      fs.writeFileSync(out, png);
      console.log(`  made  ${name}  (${kb(png.length)})`);
      made++;
      continue;
    }

    const source = spec.source === 'harness' ? captured.get(name) : existingManual(out);
    if (!source) {
      missing.push([name, spec]);
      continue;
    }

    const png = await sharp(source)
      .resize({ width: WIDTH, withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
    fs.writeFileSync(out, png);
    console.log(`  made  ${name}  (${kb(png.length)})`);
    made++;
  }

  report();
}

/**
 * A manual image is whatever is already sitting at that filename. Reading it
 * back and re-encoding it is the point: it normalises the width and strips the
 * camera/phone metadata that a dropped-in screenshot can carry.
 */
function existingManual(out) {
  return fs.existsSync(out) ? fs.readFileSync(out) : null;
}

/* --------------------------------------------------------------- harness */

async function captureHarness(shots) {
  const browser = findBrowser();
  if (!browser) {
    console.log('  note  no Edge or Chrome found — harness shots skipped');
    return new Map();
  }

  // Regenerate the harness so the shot is of the CURRENT index.html. A stale
  // harness screenshotting last month's panel is the failure this guards.
  const gen = spawnSync(process.execPath, [path.join(__dirname, 'make-shot-harness.js')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (gen.status !== 0) {
    console.log(`  note  could not build the shot harness — skipping harness shots`);
    return new Map();
  }

  const server = await serve(PANEL, PORT);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-email-'));
  const out = new Map();

  try {
    for (const [name, spec] of shots) {
      const file = path.join(tmp, name);
      // A throwaway profile per shot. Pointed at the real one, headless Edge
      // tries to talk to the installed native-messaging hosts and hangs until
      // the timeout without ever writing a file.
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-prof-'));
      const url = `http://127.0.0.1:${PORT}/${spec.url}`;
      const args = [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        `--user-data-dir=${profile}`,
        `--window-size=${WIDTH},${Math.round((WIDTH * 10) / 16)}`,
        // The panel paints asynchronously; without this the shot can catch a
        // half-drawn tab.
        '--virtual-time-budget=4000',
        `--screenshot=${file}`,
        url,
      ];
      let why = '';
      try {
        execFileSync(browser, args, { stdio: 'ignore', timeout: 30000 });
      } catch (e) {
        why = e && e.code === 'ETIMEDOUT' ? 'the browser never exited' : String(e.message || e);
      }
      if (fs.existsSync(file) && fs.statSync(file).size > 0) {
        out.set(name, fs.readFileSync(file));
      } else {
        // Headless screenshotting is blocked outright on some managed Windows
        // installs — every mode times out and writes nothing. That is an
        // environment problem, not a broken manifest, so say so and let the
        // shot fall through to the "supply it by hand" list.
        console.log(`  note  ${name}: headless capture produced nothing${why ? ` (${why})` : ''}`);
        console.log(`        capture it by hand instead — see docs/EMAIL-LIFECYCLE.md`);
      }
      fs.rmSync(profile, { recursive: true, force: true });
    }
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

function findBrowser() {
  const candidates = [
    process.env.APEX_SHOT_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((c) => {
    try {
      return fs.existsSync(c);
    } catch {
      return false;
    }
  });
}

function serve(dir, port) {
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
  };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.join(dir, rel || 'index.html');
    // The harness is served from one directory and must not be able to read
    // its way out of it.
    if (!file.startsWith(dir)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/* ---------------------------------------------------------------- output */

function report() {
  console.log('');
  if (made) console.log(`${made} image${made === 1 ? '' : 's'} written to web/src/email/`);
  if (CHECK_ONLY && kept) console.log(`${kept} already present`);

  if (missing.length) {
    console.log(`\n${missing.length} still to supply — the emails send without them, with alt text:\n`);
    for (const [name, spec] of missing) {
      console.log(`  ${name}`);
      console.log(`    ${spec.wanted || spec.alt}`);
      console.log(`    save it as web/src/email/${name} (${WIDTH}px wide or more), then re-run this\n`);
    }
  } else {
    console.log('every image in the manifest is present');
  }
  console.log('publish them with: node scripts/build-web.js  (or push — the Pages workflow runs it)\n');
}

function requireSharp() {
  try {
    return require('sharp');
  } catch {
    throw new Error("sharp is not installed — run `npm i` (it is already a dev dependency)");
  }
}

const kb = (n) => `${Math.round(n / 102.4) / 10} kB`;
