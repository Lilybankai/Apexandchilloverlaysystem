/**
 * scripts/build-web.js — assemble the web pit wall (aio.apexandchillracing.co.uk).
 * -----------------------------------------------------------------------------
 * The web app is the desktop's Team tab and account screens, served over
 * https. "Looks the same" is not a goal here, it is a build rule: every file
 * that paints the board is COPIED from electron/control-panel/ untouched, so
 * the two cannot drift. The only web-specific sources live in web/src/ — the
 * browser bridge (window.apex), the page frame, and a few frame-only CSS
 * rules — and this script glues them together into web/dist/:
 *
 *   node scripts/build-web.js            # → web/dist/
 *   node scripts/build-web.js --serve    # …and serve it on http://127.0.0.1:8790
 *
 * Two pages come out:
 *   index.html — the account screens: auth.html with the web CSP, a viewport
 *                tag and the bridge script; auth.js runs against the bridge.
 *   board.html — web/src/board.html with the <section data-view="team"> block
 *                lifted out of index.html verbatim.
 *
 * Plain Node, no dependencies, so the GitHub Pages workflow runs it without an
 * `npm install`. web/dist is gitignored — the workflow rebuilds it on deploy.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PANEL = path.join(ROOT, 'electron', 'control-panel');
const SRC = path.join(ROOT, 'web', 'src');
const DEV = path.join(ROOT, 'web', 'dev');
const OUT = path.join(ROOT, 'web', 'dist');

/** Desktop files copied verbatim. Order is irrelevant here (the pages set it). */
const PANEL_FILES = [
  // Stylesheets, exactly the desktop's.
  'control-panel.css',
  'hub.css',
  'setup-editor.css', // .su-guide — the "How it works" dialog frame
  'fuel-panel.css',   // .fuel-* tiles the board reuses
  'team-panel.css',
  'auth.css',
  // The board and the account screens.
  'icons.js',
  'team-fuel.js',
  'team-charts.js',
  'team-dashboard.js',
  'team-panel.js',
  'team-guide.js',
  'auth.js',
  // Legal documents, opened from the register screen.
  'legal.html',
];

const ASSETS = ['mark.svg', 'logo.svg', 'icon.png'];

/** Web-only sources, copied as they are. */
const WEB_FILES = ['web-bridge.js', 'web-shell.js', 'web.css', 'manifest.webmanifest', 'CNAME'];

const WEB_CSP =
  "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
  "img-src 'self' data:; connect-src 'self' https://svtyxuhbsbbodsecbnsc.supabase.co; " +
  "manifest-src 'self'; base-uri 'self'; form-action 'self';";

/** Sources are CRLF on this repo's Windows checkouts; anchors below are LF. */
function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function write(rel, text) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function copy(from, rel) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(from, file);
}

/** Replace exactly one occurrence, or refuse — a drifted anchor must not ship half a page. */
function replaceOnce(text, from, to, what) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`build-web: expected exactly one "${what}" in the source, found ${n}`);
  return text.replace(from, to);
}

/* -------------------------------------------------------------------------- */
/*  index.html — the account screens                                          */
/* -------------------------------------------------------------------------- */

function buildAuthPage() {
  let html = read(path.join(PANEL, 'auth.html'));
  html = replaceOnce(
    html,
    /<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/.exec(html)[0],
    `<meta http-equiv="Content-Security-Policy" content="${WEB_CSP}" />\n` +
      '  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />\n' +
      '  <meta name="theme-color" content="#060a12" />\n' +
      '  <link rel="manifest" href="manifest.webmanifest" />\n' +
      '  <link rel="icon" href="assets/icon.png" />',
    'CSP meta',
  );
  html = replaceOnce(html, '<title>Apex AIO System — Account</title>', '<title>Apex Pit Wall — Sign in</title>', 'title');
  html = replaceOnce(
    html,
    '<script src="icons.js"></script>',
    '<script src="icons.js"></script>\n<script src="web-bridge.js"></script>',
    'icons.js include',
  );
  // The desktop opens Stripe in the system browser and waits; here the page
  // IS the browser and navigates to Checkout, so say so.
  html = replaceOnce(
    html,
    `        Checkout opens in your browser — your card is handled by Stripe, never
        by the app.`,
    `        You will be taken to Stripe's checkout page — your card is handled by
        Stripe, never by this site.`,
    'checkout note',
  );
  // The web app has no "continue offline": a browser with no account has
  // nothing to show. The strip below the form stays as it is otherwise.
  write('index.html', html);
}

/* -------------------------------------------------------------------------- */
/*  board.html — the Team view                                                */
/* -------------------------------------------------------------------------- */

function extractTeamView() {
  const html = read(path.join(PANEL, 'index.html'));
  const startTag = '<section class="view" data-view="team">';
  const nextTag = '<section class="view" data-view="fuel">';
  const start = html.indexOf(startTag);
  const next = html.indexOf(nextTag);
  if (start < 0 || next < 0 || next < start) {
    throw new Error('build-web: could not find the Team view in electron/control-panel/index.html');
  }
  let block = html.slice(start, next);
  const end = block.lastIndexOf('</section>');
  if (end < 0) throw new Error('build-web: Team view has no closing </section>');
  block = block.slice(0, end + '</section>'.length);

  // The only view on the page is active.
  block = replaceOnce(block, startTag, '<section class="view" data-view="team" data-active="true">', 'view tag');

  // The one sentence that is desktop-specific: the board fills from THIS
  // machine's overlay server there, and from the driver's own desktop here.
  block = replaceOnce(
    block,
    'Waiting for telemetry. Start the overlay server on the Dashboard and join a session in Le Mans Ultimate — the pit wall lights up as soon as frames flow.',
    'Waiting for telemetry. Open Apex on your racing PC, sign in with this account and join a session in Le Mans Ultimate — the pit wall lights up as soon as your car is relayed. (Settings ▸ Application ▸ Web pit wall must be on.)',
    'empty-state copy',
  );
  return block;
}

function buildBoardPage() {
  let html = read(path.join(SRC, 'board.html'));
  html = replaceOnce(html, '<!--TEAM_VIEW-->', extractTeamView(), 'TEAM_VIEW marker');
  write('board.html', html);
}

/* -------------------------------------------------------------------------- */
/*  Build                                                                     */
/* -------------------------------------------------------------------------- */

function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  for (const f of PANEL_FILES) copy(path.join(PANEL, f), f);
  for (const f of ASSETS) copy(path.join(PANEL, 'assets', f), path.join('assets', f));
  for (const f of WEB_FILES) copy(path.join(SRC, f), f);

  buildAuthPage();
  buildBoardPage();

  // The dev folder: the demo fixture (scripts/make-web-demo.js) and the size
  // sweep page. Harmless to ship — nothing links to it.
  if (fs.existsSync(DEV)) {
    for (const f of fs.readdirSync(DEV)) copy(path.join(DEV, f), path.join('dev', f));
  }

  // GitHub Pages: no Jekyll pass (it would drop files it thinks are private),
  // and a build stamp support can read off a tester's screen.
  write('.nojekyll', '');
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  write('version.json', JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString() }, null, 2));

  const count = fs.readdirSync(OUT).length;
  console.log(`build-web: wrote ${count} entries to ${path.relative(ROOT, OUT)}`);
}

/* -------------------------------------------------------------------------- */
/*  --serve: a static server for local checks                                 */
/* -------------------------------------------------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serve(port) {
  http
    .createServer((req, res) => {
      const rel = decodeURIComponent((req.url || '/').split('?')[0]);
      const file = path.join(OUT, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(OUT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
    })
    .listen(port, '127.0.0.1', () => {
      console.log(`build-web: serving web/dist on http://127.0.0.1:${port}/  (board: /board.html?demo=1)`);
    });
}

build();
if (process.argv.includes('--serve')) {
  const idx = process.argv.indexOf('--port');
  serve(idx > 0 ? Number(process.argv[idx + 1]) : 8790);
}
