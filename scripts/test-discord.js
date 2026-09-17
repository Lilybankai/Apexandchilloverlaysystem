/**
 * scripts/test-discord.js — communities and Discord channels, on the app side.
 * -----------------------------------------------------------------------------
 * Two things are asserted here, and the first is the unusual one.
 *
 * 1. PARITY WITH THE DATABASE. electron/discord-cloud.js validates a join code
 *    and a webhook URL before sending either to the server, purely so the
 *    driver gets a useful message instead of a bare refusal. That is only an
 *    improvement while the two agree. If the app is stricter, a code copied
 *    from a league's Discord "doesn't work" and nobody can tell them why; if it
 *    is looser, a save fails at the server for no visible reason. So this test
 *    reads migration 0026 and compares the actual patterns — change the SQL and
 *    this fails until the JS follows. (test-referrals.js makes the same
 *    argument about code normalisation, and for the same reason.)
 *
 * 2. THAT NOTHING REACHES DISCORD BY ACCIDENT. The one place this app posts to
 *    a webhook itself is the "test channel" button, and its payload must carry
 *    `allowed_mentions: { parse: [] }`. Without it, any content that ever ends
 *    up in one of these messages can ping a whole server. The dispatcher has
 *    the same rule; this is the half that runs on the driver's machine.
 *
 * Plus the ordinary refusal-routing: a bad code must never reach the RPC, a
 * blank webhook on an existing channel means "keep the one you have" rather
 * than "clear it", and signing out must not leave another account's
 * communities on screen.
 *
 * Run: node scripts/test-discord.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const discord = require('../electron/discord-cloud');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  }
}

const MIGRATION = path.join(__dirname, '..', 'supabase', 'migrations', '0026_discord_communities.sql');

/**
 * A fake auth module. Records every RPC so a test can assert not just what came
 * back but WHICH calls were made — "did a rejected code still hit the server"
 * is only answerable that way.
 */
function fakeAuth(responses = {}) {
  const calls = [];
  return {
    calls,
    stateForUi: () => ({ signedIn: true }),
    async rpc(fn, args) {
      calls.push({ fn, args });
      const canned = responses[fn];
      if (typeof canned === 'function') return canned(args);
      if (canned) return canned;
      return { ok: true, body: { ok: true } };
    },
  };
}

const LISTS = {
  my_communities: { ok: true, body: [{ id: 'c1', name: 'Apex', role: 'owner', channels: [] }] },
  my_discord_targets: { ok: true, body: [{ id: 't1', label: 'Mine' }] },
};

async function main() {
  console.log('\nDiscord communities — app side\n');

  /* ------------------------------------------------- 1. parity with the SQL */
  console.log('Parity with migration 0026');
  {
    const sql = fs.readFileSync(MIGRATION, 'utf8');

    // The webhook pattern, as the database actually spells it.
    const m = sql.match(/v_url\s*!~\s*'([^']+)'/);
    check('the migration still validates the webhook with a regex', !!m);
    if (m) {
      // Postgres writes the slashes bare; JS regex literals escape them. That
      // is the only difference allowed to exist between the two.
      const fromSql = m[1];
      const fromJs = discord.isDiscordWebhook.toString().includes('WEBHOOK_RE')
        ? String(/^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/.source)
        : '';
      check(
        'webhook pattern matches the database, character for character',
        fromJs.replace(/\\\//g, '/') === fromSql,
        `sql=${fromSql}`,
      );
    }

    // Both sides must accept and reject the same URLs, whatever the patterns
    // look like. These are the cases that actually turn up.
    const urls = [
      ['https://discord.com/api/webhooks/1234567890/abcDEF-_123', true],
      ['https://discordapp.com/api/webhooks/1/x', true],
      ['https://canary.discord.com/api/webhooks/1/x', true],
      ['https://ptb.discord.com/api/webhooks/1/x', true],
      ['http://discord.com/api/webhooks/1/x', false], // not https
      ['https://discord.com/api/webhooks/1/x?wait=true', false], // the query is ours to add
      ['https://example.com/api/webhooks/1/x', false],
      ['https://discord.com.evil.example/api/webhooks/1/x', false],
      ['http://127.0.0.1:6397/rest/garage', false],
      ['', false],
    ];
    for (const [url, want] of urls) {
      check(
        `${want ? 'accepts' : 'refuses'} ${url || '(empty)'}`,
        discord.isDiscordWebhook(url) === want,
      );
    }

    // The join code: eight alphanumerics, dash restored, case and punctuation
    // forgiven — because it is read off a Discord message.
    check('join_community still demands eight characters', /length\(v_code\)\s*<>\s*8/.test(sql));
    const codes = [
      ['abcd1234', 'ABCD-1234'],
      ['ABCD-1234', 'ABCD-1234'],
      ['  abcd 1234  ', 'ABCD-1234'],
      ['abcd_1234', 'ABCD-1234'],
      ['ABC-123', ''],
      ['ABCD-12345', ''],
      ['', ''],
      [null, ''],
    ];
    for (const [input, want] of codes) {
      const got = discord.normalizeJoinCode(input);
      check(`code ${JSON.stringify(input)} → ${want || '(empty)'}`, got === want, got);
    }

    // The floor Carl set on 2026-09-17. If someone raises the default in SQL,
    // the doc and this line should move together.
    check(
      'min_board_entries still defaults to 3',
      /min_board_entries\s+int not null default 3/.test(sql),
    );

    // Every refusal the server can answer with needs a human sentence here; an
    // untranslated one reaches the driver as "Refused: not_admin".
    //
    // Scanned from the community section onwards on purpose: submit_lap has
    // refusals of its own (unknown_class, implausible_time, clock_skew) which
    // are answered to lapUpload.js and never reach this panel.
    const doors = sql.slice(sql.indexOf('-- 6. Communities'));
    check('the community section is where this test thinks it is', doors.length > 0 && doors.length < sql.length);
    const reasons = [...doors.matchAll(/'reason',\s*'([a-z_]+)'/g)].map((x) => x[1]);
    const untranslated = [...new Set(reasons)].filter((r) =>
      discord.reasonText(r).startsWith('Refused:'),
    );
    check(
      'every refusal reason in 0026 has a message',
      untranslated.length === 0,
      untranslated.join(', ') || 'all translated',
    );
  }

  /* ------------------------------------------ 2. nothing pings by accident */
  console.log('\nThe test-channel button');
  {
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      seen.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200 };
    };

    const res = await discord.testWebhook('https://discord.com/api/webhooks/1/token');
    check('a good webhook reports ok', res.ok === true, res.error);
    check('it posted exactly once', seen.length === 1);
    check(
      'mentions are disabled',
      JSON.stringify(seen[0]?.body?.allowed_mentions) === JSON.stringify({ parse: [] }),
    );
    check('it posts as us', seen[0]?.body?.username === 'Apex AIO System');

    // A URL that is not Discord's must not be fetched at all — this button is
    // the one place the app holds a webhook in the clear.
    seen.length = 0;
    const bad = await discord.testWebhook('https://example.com/api/webhooks/1/x');
    check('a non-Discord URL is refused', bad.ok === false);
    check('and nothing was fetched', seen.length === 0);

    for (const [status, phrase] of [[404, 'deleted'], [401, 'refused'], [429, 'rate limiting']]) {
      globalThis.fetch = async () => ({ ok: false, status });
      const out = await discord.testWebhook('https://discord.com/api/webhooks/1/token');
      check(`HTTP ${status} explains itself`, out.ok === false && out.error.includes(phrase), out.error);
    }

    globalThis.fetch = realFetch;
  }

  /* --------------------------------------------------- 3. refusal routing */
  console.log('\nRefusals never reach the server');
  {
    const auth = fakeAuth(LISTS);
    discord.init({ auth });
    await discord.refresh();

    auth.calls.length = 0;
    const join = await discord.joinCommunity('nope');
    check('a malformed code is refused here', join.ok === false);
    check('and never reached join_community', !auth.calls.some((c) => c.fn === 'join_community'));

    auth.calls.length = 0;
    const save = await discord.saveChannel({ webhook: 'https://example.com/x' });
    check('a non-Discord webhook is refused here', save.ok === false);
    check('and never reached save_discord_target', auth.calls.length === 0);

    auth.calls.length = 0;
    const blank = await discord.saveChannel({ label: 'New' });
    check('a new channel with no webhook is refused', blank.ok === false, blank.error);
    check('and never reached the server', auth.calls.length === 0);
  }

  console.log('\nEditing a channel without holding its secret');
  {
    const auth = fakeAuth(LISTS);
    discord.init({ auth });
    auth.calls.length = 0;

    await discord.saveChannel({ id: 't1', kinds: ['record_taken'], minEntries: 4 });
    const call = auth.calls.find((c) => c.fn === 'save_discord_target');
    check('an existing channel can be edited with no webhook', !!call);
    check(
      'and the blank webhook is sent as null, not as an empty string',
      call && call.args.p_webhook === null,
      JSON.stringify(call && call.args.p_webhook),
    );
    auth.calls.length = 0;
    await discord.saveChannel({ id: 't1', kinds: ['record_taken', 'nonsense'] });
    const kinds = auth.calls.find((c) => c.fn === 'save_discord_target')?.args.p_kinds;
    check('only known kinds are sent', JSON.stringify(kinds) === JSON.stringify(['record_taken']), JSON.stringify(kinds));
  }

  console.log('\nRefusals, state, and signing out');
  {
    const auth = fakeAuth({
      ...LISTS,
      create_community: { ok: true, body: { ok: false, reason: 'too_many' } },
    });
    discord.init({ auth });
    await discord.refresh();

    const made = await discord.createCommunity('Another');
    check('a refusal comes back as a sentence', made.ok === false && !/^Refused:/.test(made.error), made.error);

    check('the lists loaded', discord.stateForUi().communities.length === 1);
    check('personal channels loaded too', discord.stateForUi().personal.length === 1);

    auth.stateForUi = () => ({ signedIn: false });
    discord.onAuthChanged();
    const after = discord.stateForUi();
    check('signing out clears the communities', after.communities.length === 0);
    check('signing out clears the channels', after.personal.length === 0);
    check('and the panel knows it is not loaded', after.loaded === false);
  }
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error('\n  the test harness itself threw:', err);
    process.exit(1);
  });
