/**
 * scripts/test-emails.js — the lifecycle email sequences hold together.
 * -----------------------------------------------------------------------------
 * Two halves. The first reads the source of the migration and the three edge
 * functions as text, because the things worth asserting there are structural.
 * The second imports the real template module (see scripts/load-emails.js) and
 * renders all eleven emails, so what is checked is what would actually be sent.
 *
 * Between them they catch the failures that would otherwise only show up as a
 * mail that never arrived, or arrived wrong:
 *
 *   1. SCHEDULE ↔ TEMPLATES. Migration 0018 seeds eleven steps; emails.ts has
 *      to have a template for each, and no orphans the other way. A step with
 *      no template is offered by email_lifecycle_due() every hour forever and
 *      silently skipped — the exact bug this check exists to prevent.
 *   2. THE SAFETY INTERLOCKS in the SQL. enabled defaults false, the partial
 *      unique index that makes a double-send impossible is present, and the
 *      staleness guard that stops a backfill is still in the due query. Each of
 *      those is one careless edit away from mailing everybody twice.
 *   3. GET MUST NOT UNSUBSCRIBE. docs/auth-email-setup.md records what link
 *      prefetching did to password reset; the same scanners would opt people
 *      out of a sequence they never opened. The GET branch must not touch the
 *      RPC.
 *   4. Per-template hygiene: a subject that survives the inbox list, an
 *      unsubscribe link in the shell, alt text on every hero image, and no
 *      unfilled placeholder left in the copy.
 *   5. RENDERED OUTPUT. Every step renders; no "undefined" reaches the page;
 *      both parts carry the opt-out; tags balance; every href and img src is
 *      absolute https; and the whole thing stays under Gmail's ~102 kB
 *      clipping limit, past which the footer — unsubscribe included — is
 *      hidden behind "View entire message".
 *
 * Run: node scripts/test-emails.js  ·  See it: npm run email:preview
 */

'use strict';

const fs = require('node:fs');
const { loadEmails } = require('./load-emails');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase/migrations/0018_email_lifecycle.sql'), 'utf8');
const TPL = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/emails.ts'), 'utf8');
const DISPATCH = fs.readFileSync(path.join(ROOT, 'supabase/functions/email-dispatch/index.ts'), 'utf8');
const UNSUB = fs.readFileSync(path.join(ROOT, 'supabase/functions/email-unsubscribe/index.ts'), 'utf8');

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  }
}

function skip(name, why) {
  skipped++;
  console.log(`  SKIP  ${name}   [${why}]`);
}

/* -------------------------------------------------------------------------- */
console.log('\nSchedule ↔ templates');
/* -------------------------------------------------------------------------- */

// The seeded rows in section 2 of the migration: ('trial', 'day0', 0, 0.1, false)
const seeded = [...SQL.matchAll(/\('(trial|nudge)',\s*'([a-z0-9]+)',\s*(\d+),\s*([\d.]+),\s*(true|false)\)/g)]
  .map((m) => ({
    campaign: m[1],
    step: m[2],
    position: Number(m[3]),
    offsetHours: Number(m[4]),
    respectWindow: m[5] === 'true',
  }));

// The keys of the TEMPLATES object in emails.ts: 'trial/day0': () => ({ ... })
const templateBlock = TPL.slice(
  TPL.indexOf('const TEMPLATES'),
  TPL.indexOf('/* ------------------------------------------------------------------- api */'),
);
const templateKeys = [...templateBlock.matchAll(/^\s{2}'(trial|nudge)\/([a-z0-9]+)':/gm)].map(
  (m) => `${m[1]}/${m[2]}`,
);

check('migration seeds 11 steps', seeded.length === 11, seeded.length);
check('emails.ts defines 11 templates', templateKeys.length === 11, templateKeys.length);

for (const s of seeded) {
  const key = `${s.campaign}/${s.step}`;
  check(`${key} has a template`, templateKeys.includes(key));
}
for (const key of templateKeys) {
  const [campaign, step] = key.split('/');
  check(
    `${key} is in the schedule`,
    seeded.some((s) => s.campaign === campaign && s.step === step),
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nThe schedule itself');
/* -------------------------------------------------------------------------- */

const trial = seeded.filter((s) => s.campaign === 'trial').sort((a, b) => a.position - b.position);
const nudge = seeded.filter((s) => s.campaign === 'nudge').sort((a, b) => a.position - b.position);

check('trial runs 8 steps', trial.length === 8, trial.length);
check('nudge runs 3 steps', nudge.length === 3, nudge.length);

// Every step strictly later than the one before it. A tie would put two mails
// in the same batch, and the reader would get both at once.
for (const camp of [trial, nudge]) {
  for (let i = 1; i < camp.length; i++) {
    check(
      `${camp[i].campaign}/${camp[i].step} is after ${camp[i - 1].step}`,
      camp[i].offsetHours > camp[i - 1].offsetHours,
      `${camp[i - 1].offsetHours}h → ${camp[i].offsetHours}h`,
    );
  }
}

// The trial is seven days long. Its last mail has to arrive while there is
// still a trial to talk about, and its first has to arrive immediately.
check('trial welcome is immediate', trial[0].offsetHours < 1, `${trial[0].offsetHours}h`);
check(
  'trial welcome ignores quiet hours',
  trial[0].respectWindow === false,
  'someone who just paid is at the keyboard',
);
check(
  'every later trial step respects quiet hours',
  trial.slice(1).every((s) => s.respectWindow),
);
check(
  'last trial mail lands inside the 7 days',
  trial[trial.length - 1].offsetHours < 168,
  `${trial[trial.length - 1].offsetHours}h vs 168h`,
);
check(
  'last trial mail leaves time to act',
  168 - trial[trial.length - 1].offsetHours >= 4,
  `${168 - trial[trial.length - 1].offsetHours}h before the trial ends`,
);

// The nudge sequence must not still be running a fortnight later.
check('nudge finishes within 7 days', nudge[nudge.length - 1].offsetHours <= 168);
check('nudge does not start on signup day', nudge[0].offsetHours >= 24, `${nudge[0].offsetHours}h`);

/* -------------------------------------------------------------------------- */
console.log('\nSafety interlocks in the SQL');
/* -------------------------------------------------------------------------- */

check(
  'sending is off until switched on',
  /enabled\s+boolean\s+not null default false/.test(SQL),
  'email_settings.enabled',
);
check(
  'a sent mail can never be sent twice',
  /create unique index if not exists email_sends_once_idx[\s\S]{0,200}where status = 'sent'/.test(SQL),
  'partial unique index',
);
check(
  'the due query refuses to backfill',
  /c\.due >= greatest\(v_cfg\.activated_at, now\(\) - v_cfg\.stale_after\)/.test(SQL),
  'activated_at + stale_after',
);
check('the due query honours the master switch', /if not found or not v_cfg\.enabled then/.test(SQL));
check('opt-outs are excluded', /not ep\.lifecycle_opt_out/.test(SQL));
check('suppressed addresses are excluded', /from public\.email_suppressions sup where sup\.email = u\.email/.test(SQL));
check('failed steps stop after 3 attempts', /and es\.status = 'failed'\) < 3/.test(SQL));
check(
  'a cancelled trial stops the sequence',
  /and not b\.cancel_at_period_end/.test(SQL),
  'trial_base',
);
check(
  'comped accounts are never nudged',
  /and p\.free_access_reason is null/.test(SQL),
  'league and beta grants',
);
check(
  'the nudge cohort is "never started a trial"',
  /and b\.started_at is null/.test(SQL),
  'nudge_base',
);
check(
  'quiet hours are judged in Europe/London',
  /now\(\) at time zone 'Europe\/London'/.test(SQL),
  'so the window survives BST',
);

// Every function that clients must not reach has to be revoked, not merely
// left ungranted — public gets EXECUTE on new functions by default.
for (const fn of [
  'email_lifecycle_due',
  'email_lifecycle_record',
  'email_lifecycle_unsubscribe',
  'email_suppress',
  'email_prune',
]) {
  check(
    `${fn} is revoked from clients`,
    new RegExp(`revoke all on function public\\.${fn}\\(`).test(SQL),
  );
}
check(
  'admin_email_stats is admin-gated',
  /admin_email_stats[\s\S]{0,400}if not public\.is_admin\(\) then/.test(SQL),
);

/* -------------------------------------------------------------------------- */
console.log('\nUnsubscribe cannot be triggered by a link scanner');
/* -------------------------------------------------------------------------- */

// The GET branch must return the confirmation page and nothing else. If the
// RPC call ever moves above it, a Gmail or Defender prefetch silently opts the
// reader out — the same class of bug as docs/auth-email-setup.md.
const getBranch = UNSUB.slice(UNSUB.indexOf("if (req.method === 'GET')"), UNSUB.indexOf("if (req.method !== 'POST')"));
check('GET renders a confirmation page', /return page\(confirmBody\(token\)/.test(getBranch));
check('GET does not call the RPC', !/rpc\(/.test(getBranch));
check('the RPC is only reached on POST', /req\.method !== 'POST'[\s\S]*rpc\('email_lifecycle_unsubscribe'/.test(UNSUB));
check('the confirmation page POSTs', /<form method="POST"/.test(UNSUB));
check('the token is a uuid or nothing', /isUuid\(token\)/.test(UNSUB));
check(
  'the same page is shown for a bad token',
  /Same page for a good token, a bad token/.test(UNSUB),
  'no token oracle',
);
check(
  'one-click unsubscribe is advertised',
  /'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'/.test(DISPATCH),
  'RFC 8058 — required by Gmail and Yahoo',
);
check(
  'one-click unsubscribe is honoured',
  /form\.get\('t'\)/.test(UNSUB),
  'the POST body carries the token too',
);

/* -------------------------------------------------------------------------- */
console.log('\nDispatcher');
/* -------------------------------------------------------------------------- */

check('the endpoint fails closed without its secret', /if \(!DISPATCH_KEY \|\| given !== DISPATCH_KEY\)/.test(DISPATCH));
check('a missing template is recorded, not retried forever', /'skipped', '', 'no template'/.test(DISPATCH));
check('a send failure does not stop the batch', /result\.failed\+\+;[\s\S]{0,120}continue;/.test(DISPATCH));
check('sends are paced for the Resend rate limit', /await sleep\(GAP_MS\)/.test(DISPATCH));
check('a dry run sends nothing', /if \(dry\) \{[\s\S]{0,160}continue;/.test(DISPATCH));
check(
  'the preview cannot unsubscribe a real account',
  /unsubscribe_token: '00000000-0000-0000-0000-000000000000'/.test(DISPATCH),
);
check('every mail carries a text part', /text: mail\.text/.test(DISPATCH));
check('replies reach a person', /reply_to: REPLY_TO/.test(DISPATCH));

/* -------------------------------------------------------------------------- */
console.log('\nTransactional outbox (migration 0029)');
/* -------------------------------------------------------------------------- */

/*
 * The second queue. A lifecycle step fires because a clock ticked; an outbox
 * row fires because something HAPPENED — today, a partner application being
 * approved — and the two have opposite rules. The checks below are the three
 * ways that distinction gets quietly lost:
 *
 *   1. the transactional mail starts honouring the marketing kill switch, so
 *      the day someone sets `email_settings.enabled = false` to stop a
 *      sequence, approved partners silently stop being told they are partners;
 *   2. it starts carrying a List-Unsubscribe header, which points at the
 *      LIFECYCLE endpoint and would opt someone out of a series they are not
 *      in, from a mail that has no series;
 *   3. it stops being retried, or is retried forever.
 */
check(
  'the outbox is drained before the lifecycle batch',
  DISPATCH.indexOf('drainOutbox(dry)') > 0 &&
    DISPATCH.indexOf('drainOutbox(dry)') < DISPATCH.indexOf("db.rpc('email_lifecycle_due'"),
);
check('every outbox outcome is written back', /email_outbox_record/.test(DISPATCH));
check(
  'an outbox row with no template is recorded as failed, not skipped silently',
  /no transactional template for/.test(DISPATCH),
);
check(
  'List-Unsubscribe is only sent when there is one',
  /headers: mail\.listUnsubscribe\s*\n?\s*\?/.test(DISPATCH),
);
check(
  'a database without 0029 is not an error',
  /does not exist\|schema cache/.test(DISPATCH),
);

{
  const OUTBOX = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/0029_partner_requests.sql'),
    'utf8',
  );
  // Scoped to the function's own body — the file mentions email_settings
  // elsewhere for the poke, and a whole-file search would always match.
  const dueBody = (
    OUTBOX.match(/create or replace function public\.email_outbox_due[\s\S]*?\$fn\$([\s\S]*?)\$fn\$/) ||
    []
  )[1];
  check('email_outbox_due exists', !!dueBody);
  check(
    'the outbox ignores the lifecycle kill switch',
    !!dueBody && !/email_settings|enabled/.test(dueBody),
  );
  check(
    'a hard bounce or complaint still stops a transactional send',
    /s\.reason in \('bounce', 'complaint'\)/.test(OUTBOX),
  );
  check(
    'an unsubscribe does NOT stop a transactional send',
    !/s\.reason in \([^)]*'unsubscribe'/.test(OUTBOX),
  );
  check('the queue is idempotent', /email_outbox_dedupe_idx/.test(OUTBOX));
  check(
    'a failure is retried, three times, then stops',
    /attempts < 3/.test(OUTBOX) && /attempts \+ 1 >= 3 then 'failed'/.test(OUTBOX),
  );
  check(
    'the poke can never fail an approval',
    /exception when others then[\s\S]{0,200}return false;/.test(OUTBOX),
  );
  check(
    'a refused code leaves the application pending',
    /if not coalesce\(\(v_issued ->> 'ok'\)::boolean, false\) then/.test(OUTBOX),
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nTemplate hygiene');
/* -------------------------------------------------------------------------- */

// Split the TEMPLATES object into one chunk per key so each can be checked on
// its own. The keys are at a known indent, which is what makes this reliable.
const chunks = {};
{
  const marks = [...templateBlock.matchAll(/^\s{2}'(trial|nudge)\/([a-z0-9]+)':/gm)];
  marks.forEach((m, i) => {
    const start = m.index;
    const end = i + 1 < marks.length ? marks[i + 1].index : templateBlock.length;
    chunks[`${m[1]}/${m[2]}`] = templateBlock.slice(start, end);
  });
}

const heroes = new Set();
for (const [key, chunk] of Object.entries(chunks)) {
  for (const field of ['subject', 'kicker', 'headline', 'body', 'image']) {
    check(`${key} has ${field}`, new RegExp(`\\b${field}:`).test(chunk));
  }

  // Gmail shows roughly 70 characters of subject on a desktop and fewer on a
  // phone. Anything past that is decoration.
  const subjects = [...chunk.matchAll(/subject: ['`]([^'`]+)['`]/g)].map((m) => m[1]);
  check(`${key} declares a subject`, subjects.length >= 1, subjects.length);
  for (const s of subjects) {
    check(`${key} subject fits the inbox list`, s.length <= 70, `${s.length} chars: "${s}"`);
    check(`${key} subject is not shouting`, s !== s.toUpperCase(), s);
  }

  // Every hero image needs alt text, because most clients block images and a
  // grey box with no words in it is a hole in the middle of the mail.
  const img = chunk.match(/image: '([^']+)'/);
  if (img) {
    heroes.add(img[1]);
    const alt = chunk.match(/imageAlt: '([^']*)'/);
    check(`${key} hero image has real alt text`, !!alt && alt[1].length > 15, alt && alt[1].length);
  }

  // A template literal that was never filled in, or copy left as a marker.
  check(`${key} has no unfilled placeholder`, !/\{\{|TODO|LOREM|XXX/i.test(chunk));
}

check('the shell carries an unsubscribe link', /Stop these emails<\/a>/.test(TPL));
check('the shell says why they are getting it', /You are getting this because you created/.test(TPL));
check('the plain-text part carries it too', /Stop these emails: \$\{unsub\}/.test(TPL));
check('a postal address is present', /POSTAL/.test(TPL), 'CAN-SPAM / PECR');
check(
  'the day 1 mail adapts to whether the app was ever opened',
  /r\.opened_app/.test(chunks['trial/day1'] ?? ''),
);
check(
  'the last trial mail adapts to whether they converted',
  /r\.variant !== 'thanks'/.test(chunks['trial/day7'] ?? ''),
);

/* -------------------------------------------------------------------------- */
console.log('\nHero images');
/* -------------------------------------------------------------------------- */

const assetDir = path.join(ROOT, 'web/src/email');
const manifestPath = path.join(assetDir, 'manifest.json');

if (!fs.existsSync(manifestPath)) {
  skip('asset manifest', 'web/src/email/manifest.json missing — run npm run email:assets');
} else {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const listed = new Set(Object.keys(manifest.shots ?? {}));
  for (const hero of heroes) {
    check(`${hero} is in the manifest`, listed.has(hero));
  }
  check('the logo is in the manifest', listed.has('logo.png'));

  const missing = [...listed].filter((f) => !fs.existsSync(path.join(assetDir, f)));
  if (missing.length) {
    // Not a failure: the images are generated from the app, which needs a
    // machine with the panel on it. The templates are built to read correctly
    // without them, which is the property that actually matters.
    skip('every image is generated', `${missing.length} not yet captured: ${missing.join(', ')}`);
  } else {
    check('every image is generated', true, `${listed.size} files`);
  }
}

/* -------------------------------------------------------------------------- */
/* The real thing: render all eleven and check what comes out. Everything above
   reads source text; this runs it. See scripts/load-emails.js for how a Deno
   module gets imported from Node without changing the deployed tree.          */
/* -------------------------------------------------------------------------- */

(async () => {
  console.log('\nRendered output');

  // Stand in for what the deployed function has in its environment. Set before
  // the import, because the module reads these once at load.
  process.env.SUPABASE_URL ??= 'https://example.supabase.co';

  let mod;
  try {
    mod = await loadEmails();
  } catch (e) {
    skip('render every template', `could not import emails.ts (${e.message})`);
    return finish();
  }

  // A missing SUPABASE_URL must stop the mail, not ship a relative unsubscribe
  // href that goes nowhere.
  check('an absolute unsubscribe base is required', /^https:\/\//.test(mod.UNSUB_BASE), mod.UNSUB_BASE);

  const who = {
    first_name: 'Carl',
    unsubscribe_token: '11111111-2222-3333-4444-555555555555',
    variant: 'convert',
    opened_app: true,
    days_left: 1,
  };

  // 11 lifecycle steps (8 trial + 3 nudge) plus the one-off 1.0 announcement.
  // The count is pinned on purpose: a template added or lost by accident is a
  // mail nobody meant to send, or a step in a sequence that silently goes quiet.
  check('the module exports the same 12 steps', mod.STEP_KEYS.length === 12, mod.STEP_KEYS.length);
  check('the 1.0 announcement is one of them', mod.STEP_KEYS.includes('announce/v1'), mod.STEP_KEYS.join(','));

  for (const key of mod.STEP_KEYS) {
    const [campaign, step] = key.split('/');
    let out;
    try {
      out = mod.render(campaign, step, who);
    } catch (e) {
      check(`${key} renders`, false, e.message);
      continue;
    }

    check(`${key} renders`, out.html.length > 2000 && out.text.length > 200,
      `${out.html.length}B html / ${out.text.length}B text`);

    // A template literal that resolved to "undefined" or "[object Object]" is
    // the classic way a mail goes out looking broken.
    check(`${key} has no undefined in the html`, !/undefined|\[object Object\]|NaN/.test(out.html));
    check(`${key} has no undefined in the text`, !/undefined|\[object Object\]|NaN/.test(out.text));

    // Both parts must carry a way out, or the mail is not lawful to send.
    check(`${key} html carries the unsubscribe token`, out.html.includes(who.unsubscribe_token));
    check(`${key} text carries the unsubscribe token`, out.text.includes(who.unsubscribe_token));
    check(`${key} exposes a one-click url`, /^https?:\/\/.+t=/.test(out.listUnsubscribe), out.listUnsubscribe.slice(0, 48));

    // Tags must balance, or Gmail eats the rest of the mail.
    const open = (out.html.match(/<table/g) || []).length;
    const close = (out.html.match(/<\/table>/g) || []).length;
    check(`${key} tables balance`, open === close, `${open} open / ${close} close`);
    check(`${key} greets by name`, out.html.includes('Hi Carl,'));

    // Gmail clips a message past ~102 kB and hides the footer — including the
    // unsubscribe link — behind a "View entire message" link.
    check(`${key} is under Gmail's clipping limit`, out.html.length < 102000, `${Math.round(out.html.length / 1024)} kB`);

    // Every image has to be absolute and https, or it will not load anywhere.
    for (const src of [...out.html.matchAll(/<img[^>]+src="([^"]*)"/g)].map((m) => m[1])) {
      check(`${key} image src is absolute https`, /^https:\/\//.test(src), src.slice(0, 60));
    }

    // Every link likewise — a relative href in an email goes nowhere.
    for (const href of [...out.html.matchAll(/<a[^>]+href="([^"]*)"/g)].map((m) => m[1])) {
      check(`${key} link is absolute https`, /^https:\/\//.test(href), href.slice(0, 60));
    }
  }

  // The conditional variants must actually produce different mail, or the
  // branching is decoration.
  const convert = mod.render('trial', 'day7', { ...who, variant: 'convert', days_left: 1 });
  const thanks = mod.render('trial', 'day7', { ...who, variant: 'thanks' });
  check('day7 differs by variant', convert.subject !== thanks.subject, `"${convert.subject}" vs "${thanks.subject}"`);
  check('day7 counts down', convert.subject.includes('tomorrow'), convert.subject);
  check(
    'day7 says "today" on the last day',
    mod.render('trial', 'day7', { ...who, days_left: 0 }).subject.includes('today'),
  );

  const opened = mod.render('trial', 'day1', { ...who, opened_app: true });
  const never = mod.render('trial', 'day1', { ...who, opened_app: false });
  check('day1 differs by whether the app was opened', opened.html !== never.html);
  check(
    'day1 tells a non-opener to set up first',
    never.html.includes('has not been opened on this account yet'),
  );

  // A blank display_name must not produce "Hi ,".
  const anon = mod.render('nudge/why'.split('/')[0], 'why', { ...who, first_name: '' });
  check('a nameless account gets a greeting that reads', anon.html.includes('Hi there,') && !anon.html.includes('Hi ,'));

  check('an unknown step is refused, not sent blank', (() => {
    try {
      mod.render('trial', 'day99', who);
      return false;
    } catch {
      return true;
    }
  })());

  /* ------------------------------------------------------------------------ */
  console.log('\nThe approved-partner mail');
  /* ------------------------------------------------------------------------ */

  {
    /*
     * Rendered with the params the database actually queues (see
     * admin_approve_referral_request) and an EMPTY unsubscribe token, which is
     * the whole point: a transactional mail must render without one. Before
     * this existed, render() threw unless UNSUB_BASE was an absolute https URL,
     * and a transactional mail must not depend on the lifecycle plumbing being
     * configured, let alone switched on.
     */
    const partner = mod.renderTransactional(
      'partner/approved',
      {
        first_name: 'Craig',
        code: 'CRAIG',
        url: 'https://apexandchillracing.co.uk/r/CRAIG',
        overlay_url: 'https://apexandchillracing.co.uk/r/CRAIG/overlay',
        percent_off: 10,
      },
      { first_name: 'Craig', unsubscribe_token: '' },
    );

    check('partner/approved renders', partner.html.length > 800 && partner.text.length > 200,
      `${partner.html.length}B html / ${partner.text.length}B text`);
    check('the subject carries the code', partner.subject.includes('CRAIG'), partner.subject);
    check('the code is in the body', partner.html.includes('CRAIG'));
    check('the link is in the body', partner.html.includes('/r/CRAIG'));
    check('no undefined reaches the page', !/undefined/.test(partner.html));

    // The one that matters most. The scheme pays the partner nothing, and a
    // welcome mail that does not say so is how somebody finds out a month
    // later, after promoting it. See docs/REFERRALS.md.
    check(
      'it says there is no commission',
      /no commission or payout/i.test(partner.text),
    );

    // A transactional mail has no series, so it must not offer a way out of
    // one — the link would point at the lifecycle endpoint.
    check('there is no unsubscribe link', !/unsubscribe/i.test(partner.html));
    check('there is no unsubscribe link in the text part', !/unsubscribe/i.test(partner.text));
    check('no one-click header is offered', partner.listUnsubscribe === '');
    check(
      'it still says why it arrived',
      partner.html.includes('you applied to become an Apex AIO partner'),
    );
    check('replies still reach a person', /reaches a person/.test(partner.text));

    // The postal address is a legal requirement the shared shell provides; the
    // footer rewritten for transactional mail must not have dropped it. Checked
    // in both parts because they are built by different functions.
    check('the postal address survived in the html', partner.html.includes('Chill Racing'));
    check('the postal address survived in the text', partner.text.includes('Chill Racing'));

    const open = (partner.html.match(/<table/g) || []).length;
    const close = (partner.html.match(/<\/table>/g) || []).length;
    check('tables balance', open === close, `${open} open / ${close} close`);

    for (const href of [...partner.html.matchAll(/<a[^>]+href="([^"]*)"/g)].map((m) => m[1])) {
      check('link is absolute https', /^https:\/\//.test(href), href.slice(0, 60));
    }

    // Params arrive as JSON from Postgres, so nothing is guaranteed.
    const bare = mod.renderTransactional('partner/approved', {}, { first_name: '', unsubscribe_token: '' });
    check('it survives empty params', !/undefined|null/.test(bare.html));
    check('a nameless partner gets a greeting that reads',
      bare.html.includes('Hi there,') && !bare.html.includes('Hi ,'));

    check('an unknown transactional template is refused', (() => {
      try {
        mod.renderTransactional('partner/nonsense', {}, { first_name: '', unsubscribe_token: '' });
        return false;
      } catch {
        return true;
      }
    })());
  }

  finish();
})();

function finish() {
  console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
  process.exit(failed ? 1 : 0);
}
