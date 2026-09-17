/**
 * scripts/email-preview.js — read the eleven emails before anyone else does.
 * -----------------------------------------------------------------------------
 *   node scripts/email-preview.js            # → .email-preview/index.html
 *   node scripts/email-preview.js --serve    # …and serve it on :8791
 *
 * Renders every step with the REAL template module (scripts/load-emails.js), so
 * what you read here is byte-for-byte what the dispatcher sends. Both variants
 * of the last trial mail and both variants of day 1 are rendered, because those
 * branch at send time and the branch nobody looks at is the one that breaks.
 *
 * This is not a substitute for sending yourself one of each — an inbox is the
 * only place to find out what Outlook does to a table, or how the subject reads
 * next to twenty others. `email-dispatch?to=you@example.com&step=day0` does
 * that, and docs/EMAIL-LIFECYCLE.md step 5 is the checklist. What this gives
 * you is the fast loop while the words are still being written.
 *
 * Output is gitignored: it is a rendering of committed source, not a source.
 */

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { loadEmails } = require('./load-emails');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.email-preview');
const SERVE = process.argv.includes('--serve');
const PORT = 8791;

// The environment the deployed function has. Without SUPABASE_URL the module
// refuses to render at all, which is deliberate — see render() in emails.ts.
process.env.SUPABASE_URL ||= 'https://example.supabase.co';

const WHO = {
  first_name: 'Carl',
  unsubscribe_token: '11111111-2222-3333-4444-555555555555',
  variant: 'convert',
  opened_app: true,
  days_left: 1,
};

/** The extra renders that only happen down one branch at send time. */
const VARIANTS = [
  ['trial', 'day1', { ...WHO, opened_app: false }, 'day1-never-opened', 'day 1 — never opened the app'],
  ['trial', 'day7', { ...WHO, variant: 'thanks' }, 'day7-converted', 'day 7 — already subscribed'],
  ['trial', 'day7', { ...WHO, days_left: 0 }, 'day7-last-day', 'day 7 — final day'],
];

main().catch((e) => {
  console.error(`\nemail-preview failed: ${e.message}\n`);
  process.exit(1);
});

async function main() {
  const mod = await loadEmails();
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const cards = [];

  for (const key of mod.STEP_KEYS) {
    const [campaign, step] = key.split('/');
    const mail = mod.render(campaign, step, WHO);
    cards.push(write(`${campaign}-${step}`, key, mail));
  }
  for (const [campaign, step, who, slug, label] of VARIANTS) {
    cards.push(write(slug, label, mod.render(campaign, step, who)));
  }

  /*
   * The transactional mail (migration 0029) renders here too. It is sent far
   * less often than any lifecycle step and is therefore the one whose wording
   * nobody ever sees again after the day it was written — which is exactly why
   * it needs to be in the grid with the rest.
   */
  for (const key of mod.TRANSACTIONAL_KEYS ?? []) {
    const mail = mod.renderTransactional(
      key,
      {
        first_name: WHO.first_name,
        code: 'CRAIG',
        url: 'https://apexandchillracing.co.uk/r/CRAIG',
        overlay_url: 'https://apexandchillracing.co.uk/r/CRAIG/overlay',
        percent_off: 10,
      },
      WHO,
    );
    cards.push(write(key.replace('/', '-'), `${key} (transactional)`, mail));
  }

  fs.writeFileSync(path.join(OUT, 'index.html'), index(cards));
  console.log(`\n${cards.length} emails rendered to ${path.relative(ROOT, OUT)}/index.html`);
  console.log(`assets are loaded from ${mod.ASSET_BASE}`);
  console.log('images will be missing until they are generated and published (npm run email:assets)\n');

  if (SERVE) serve();
}

function write(slug, label, mail) {
  fs.writeFileSync(path.join(OUT, `${slug}.html`), mail.html);
  fs.writeFileSync(path.join(OUT, `${slug}.txt`), mail.text);
  return { slug, label, subject: mail.subject, bytes: mail.html.length, text: mail.text };
}

function index(cards) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lifecycle email preview</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; background:#060a12; color:#f4f6fb;
         font:14px/1.5 "Segoe UI",system-ui,sans-serif }
  header { padding:26px 24px 10px; border-bottom:1px solid #1d2536 }
  h1 { margin:0 0 6px; font-size:20px }
  p  { margin:0; color:#9aa4b8 }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr));
          gap:18px; padding:22px 24px 40px }
  .card { border:1px solid #1d2536; border-radius:12px; overflow:hidden; background:#0c111c }
  .head { padding:12px 14px; border-bottom:1px solid #1d2536 }
  .step { font:700 11px/1 "Segoe UI"; letter-spacing:1.3px; text-transform:uppercase; color:#26bbf4 }
  .subj { margin-top:7px; font-weight:600 }
  .meta { margin-top:5px; font-size:12px; color:#66708a }
  iframe { width:100%; height:520px; border:0; background:#060a12; display:block }
  a { color:#309be1 }
</style></head><body>
<header>
  <h1>Lifecycle email preview</h1>
  <p>${cards.length} rendered from supabase/functions/_shared/emails.ts &middot;
     images load from the published asset host, so empty boxes here are expected until
     <code>npm run email:assets</code> has run and the site has deployed.</p>
</header>
<div class="grid">
${cards
  .map(
    (c) => `  <div class="card">
    <div class="head">
      <div class="step">${esc(c.label)}</div>
      <div class="subj">${esc(c.subject)}</div>
      <div class="meta">${Math.round(c.bytes / 1024)} kB &middot;
        <a href="${c.slug}.html" target="_blank">open</a> &middot;
        <a href="${c.slug}.txt" target="_blank">plain text</a></div>
    </div>
    <iframe src="${c.slug}.html" title="${esc(c.subject)}" loading="lazy"></iframe>
  </div>`,
  )
  .join('\n')}
</div></body></html>`;
}

function serve() {
  const types = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
  http
    .createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(OUT, rel);
      if (!file.startsWith(OUT)) return res.writeHead(403).end();
      fs.readFile(file, (err, data) => {
        if (err) return res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    })
    .listen(PORT, '127.0.0.1', () => console.log(`serving http://127.0.0.1:${PORT}\n`));
}
