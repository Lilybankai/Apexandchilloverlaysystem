/**
 * test-discord-sims.js — a Discord channel opting into iRacing posts.
 * -----------------------------------------------------------------------------
 * 0047 gave every channel `sims` (default {lmu}) and the fan-out honours it,
 * but nothing could change it, so iRacing records were written and never
 * delivered. 0048 adds set_discord_target_sims / my_discord_target_sims; the
 * app (discord-cloud.js + discord-panel.js) reads and sets them. Checked here:
 *
 *   1. The pure helpers: normalizeSims, withSims.
 *   2. saveChannel against a fake cloud: the sims door is called after the
 *      save with the channel's id, never without 0048, never with no sims.
 *   3. The SQL: 0048's grants and refusals match the app's reason table; the
 *      fan-out (0047) filters on sims and submit_lap stamps `sim` on the event;
 *      the dispatcher titles an iRacing post.
 *
 * Run: npm run test:discord-sims
 */

'use strict';

const fs = require('fs');
const path = require('path');
const dc = require('../electron/discord-cloud.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    return;
  }
  failed++;
  console.error(`  FAIL ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
}

// ── 1. Pure helpers ─────────────────────────────────────────────────────────
check('normalizeSims keeps known sims in order', dc.normalizeSims(['iRacing', ' lmu ', 'lmu']).join() === 'lmu,iracing');
check('normalizeSims drops unknown sims', dc.normalizeSims(['acc', 'rf2']).length === 0);
check('normalizeSims of junk is empty', dc.normalizeSims(null).length === 0);
{
  const chans = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
  const out = dc.withSims(chans, [{ id: 'a', sims: ['iracing', 'lmu'] }]);
  check('withSims decorates the channel it has a row for', out[0].sims.join() === 'lmu,iracing');
  check('withSims leaves a channel it has no row for alone', out[1].sims === undefined);
  check('withSims does not mutate', chans[0].sims === undefined);
  check('withSims with no rows (0048 not applied) changes nothing', dc.withSims(chans, null)[0].sims === undefined);
}

// ── 2. saveChannel against a fake cloud ─────────────────────────────────────
async function flows() {
  const calls = [];
  let have0048 = true;
  const auth = {
    stateForUi: () => ({ signedIn: true }),
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      if (fn === 'my_discord_target_sims') return have0048 ? { ok: true, body: [{ id: 'ch1', sims: ['lmu'] }] } : { ok: false, error: 'not found' };
      if (fn === 'my_communities') return { ok: true, body: [] };
      if (fn === 'my_discord_targets') return { ok: true, body: [{ id: 'ch1', label: 'Mine', kinds: [] }] };
      if (fn === 'save_discord_target') return { ok: true, body: { ok: true, id: 'ch1' } };
      if (fn === 'set_discord_target_sims') return { ok: true, body: { ok: true, id: args.p_id, sims: args.p_sims } };
      return { ok: true, body: {} };
    },
  };
  let last = null;
  dc.init({ auth, onState: (s) => { last = s; } });
  await dc.refresh();
  check('refresh: the cloud has 0048', last && last.simsAvailable === true);
  check('refresh: personal channel carries its sims', last.personal[0].sims.join() === 'lmu');
  check('state lists both sims', last.sims.join() === 'lmu,iracing');

  calls.length = 0;
  const res = await dc.saveChannel({ id: 'ch1', label: 'Mine', sims: ['lmu', 'iracing'] });
  const set = calls.find((c) => c.fn === 'set_discord_target_sims');
  check('save then set sims', res.ok && !!set, JSON.stringify(res));
  check('set sims uses the saved channel id', set && set.args.p_id === 'ch1');
  check('set sims sends both sims', set && set.args.p_sims.join() === 'lmu,iracing');
  check('sims set after the save, not before',
    calls.findIndex((c) => c.fn === 'save_discord_target') < calls.findIndex((c) => c.fn === 'set_discord_target_sims'));

  calls.length = 0;
  const none = await dc.saveChannel({ id: 'ch1', sims: [] });
  check('no sims ticked is refused before any call', !none.ok && calls.length === 0 && /at least one sim/.test(none.error));

  calls.length = 0;
  await dc.saveChannel({ id: 'ch1', label: 'x' });
  check('a save without sims never touches them', !calls.some((c) => c.fn === 'set_discord_target_sims'));

  have0048 = false;
  await dc.refresh();
  check('a cloud without 0048: simsAvailable false', last.simsAvailable === false);
  calls.length = 0;
  const old = await dc.saveChannel({ id: 'ch1', sims: ['iracing'] });
  check('without 0048 the channel still saves', old.ok);
  check('without 0048 the sims door is never called', !calls.some((c) => c.fn === 'set_discord_target_sims'));
}

// ── 3. The SQL and the dispatcher ───────────────────────────────────────────
function sqlChecks() {
  const mig = (f) => fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', f), 'utf8');
  const m48 = mig('0048_discord_target_sims.sql');
  check('0048 defines set_discord_target_sims', /create or replace function public\.set_discord_target_sims\(p_id uuid, p_sims text\[\]\)/.test(m48));
  check('0048 defines my_discord_target_sims', /create or replace function public\.my_discord_target_sims\(\)/.test(m48));
  for (const fn of ['set_discord_target_sims(uuid, text[])', 'my_discord_target_sims()']) {
    const esc = fn.replace(/[()[\]]/g, '\\$&');
    check(`0048 revokes ${fn} from anon`, new RegExp(`revoke all on function public\\.${esc} from public, anon`).test(m48));
    check(`0048 grants ${fn} to authenticated`, new RegExp(`grant execute on function public\\.${esc} to authenticated, service_role`).test(m48));
  }
  check('0048 accepts only lmu and iracing', /array\['lmu', 'iracing'\]/.test(m48));
  check('0048 does not touch save_discord_target', !/function public\.save_discord_target/.test(m48));
  check('0048 writes no row outside the function', !/^\s*(update|insert|delete)\b/im.test(m48.replace(/\$\$[\s\S]*?\$\$/g, '')));
  for (const reason of m48.match(/'reason', '([a-z_]+)'/g) || []) {
    const r = reason.replace(/.*'([a-z_]+)'$/, '$1');
    check(`app has words for 0048's ${r}`, !/^Refused:/.test(dc.reasonText(r)));
  }
  // Same permission rule as delete_discord_target (owner, or community owner/admin).
  check('0048 editing rule names owner/admin', /m\.role in \('owner', 'admin'\)/.test(m48));

  const m47 = mig('0047_iracing_boards.sql');
  check('fan-out filters on the channel\'s sims', /coalesce\(nullif\(v_evt\.payload ->> 'sim', ''\), 'lmu'\) = any\(t\.sims\)/.test(m47));
  check('submit_lap stamps the sim on the event', /'sim',\s+lower\(btrim\(coalesce\(p_sim, ''\)\)\)/.test(m47));
  check('the sims column defaults to LMU only', /sims text\[\] not null default array\['lmu'\]/.test(m47));

  const fn = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'discord-dispatch', 'index.ts'), 'utf8');
  check('the dispatcher knows an iRacing post', /String\(p\.sim \?\? ''\) === 'iracing'/.test(fn));

  const panel = fs.readFileSync(path.join(__dirname, '..', 'electron', 'control-panel', 'discord-panel.js'), 'utf8');
  check('the panel draws the sims switches', /data-sim="\$\{esc\(s\)\}"/.test(panel) && /simsHtml\(ch\)/.test(panel));
  check('the panel sends sims only when the cloud can store them', /sims: state\.simsAvailable/.test(panel));
}

flows()
  .then(sqlChecks)
  .then(() => {
    console.log(`discord sims: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
