/**
 * scripts/test-referrals.js — partner referral codes, on the app side.
 * -----------------------------------------------------------------------------
 * The subscribe screen has ONE code box that now takes two completely different
 * kinds of code, and the two have opposite consequences:
 *
 *   a LEAGUE code grants free access  → the driver goes straight into the app
 *   a REFERRAL code grants a discount → the driver stays on the paywall and
 *                                       still has to start a subscription
 *
 * Getting that backwards is the expensive bug in both directions. Let a referral
 * through as if it were league access and the app is free to anyone who knows a
 * streamer's code. Treat league access as a referral and a league racer who
 * should ride free is asked to pay. Neither raises anything — both just quietly
 * do the wrong thing — so the routing is asserted here rather than trusted.
 *
 * Also covered: that a failed redemption never re-reads entitlement (a rejected
 * code must not be able to churn the billing cache), and that the normalisation
 * this side applies matches the database's, because a code accepted by the
 * website's banner and refused by the app is the worst outcome of the lot.
 *
 * Run: node scripts/test-referrals.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const billing = require('../electron/billing');

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

/** A throwaway userData dir, so the billing cache never leaks between cases. */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-ref-'));
}

/**
 * A fake auth module. Records every RPC so a test can assert not just what came
 * back but WHICH calls were made — "did a rejected code trigger an entitlement
 * refresh" is only answerable that way.
 */
function fakeAuth(reply) {
  const calls = [];
  return {
    calls,
    names: () => calls.map((c) => c.fn),
    async rpc(fn, args) {
      calls.push({ fn, args });
      return reply(fn, args);
    },
  };
}

/** Wire billing up against a fake server for one case. */
function withAuth(reply) {
  const dir = tmpDir();
  const auth = fakeAuth(reply);
  billing.init({ auth, userDataDir: dir, onChange: null });
  return { auth, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** The shape auth.rpc resolves with on success. */
const ok = (body) => ({ ok: true, body });

async function main() {
  /* ====================================================================== */
  console.log('\nRedeeming — one box, two kinds of code');
  /* ====================================================================== */
  {
    const { auth, cleanup } = withAuth((fn) => {
      if (fn === 'redeem_code') {
        return ok({ ok: true, kind: 'referral', code: 'CRAIG', ownerName: 'Craig M.', percentOff: 10 });
      }
      return ok({ entitled: true });
    });

    const res = await billing.redeemCode('craig');
    check('a referral code is accepted', res.ok === true);
    check('and is reported AS a referral', res.kind === 'referral', res.kind);
    check('carrying the partner name for the message', res.ownerName === 'Craig M.', res.ownerName);
    check('and the discount', res.percentOff === 10, res.percentOff);
    check('it goes through redeem_code, not the old league RPC',
      auth.names().includes('redeem_code') && !auth.names().includes('redeem_league_code'),
      auth.names().join(','));
    // THE one that matters: a discount is not access. Re-reading entitlement
    // here would be harmless, but LETTING THEM IN would not, and the absence of
    // a refresh is the signal that this path does not think it granted access.
    check('a referral does NOT re-read entitlement',
      !auth.names().includes('entitlement_status'), auth.names().join(','));
    cleanup();
  }

  {
    const { auth, cleanup } = withAuth((fn) => {
      if (fn === 'redeem_code') return ok({ ok: true, kind: 'league' });
      if (fn === 'entitlement_status') return ok({ entitled: true, source: 'league' });
      return ok({});
    });

    const res = await billing.redeemCode('APEX-1234-5678');
    check('a league code is accepted', res.ok === true);
    check('and is reported AS league access', res.kind === 'league', res.kind);
    // The mirror of the case above: this one DID grant access, so the cached
    // entitlement has to be re-read before the screen acts on it.
    check('a league code DOES re-read entitlement',
      auth.names().includes('entitlement_status'), auth.names().join(','));
    cleanup();
  }

  {
    const { auth, cleanup } = withAuth((fn) => {
      if (fn === 'redeem_code') return ok({ ok: false, error: 'That code isn’t recognised.' });
      return ok({});
    });

    const res = await billing.redeemCode('NONSENSE');
    check('an unknown code is refused', res.ok === false);
    check('with the server’s own wording', /isn’t recognised/.test(res.error), res.error);
    check('and nothing else is called',
      auth.names().join(',') === 'redeem_code', auth.names().join(','));
    cleanup();
  }

  {
    const { cleanup } = withAuth(() => ok({}));
    const empty = await billing.redeemCode('   ');
    check('whitespace is not a code', empty.ok === false, empty.error);
    const none = await billing.redeemCode(undefined);
    check('and neither is nothing at all', none.ok === false, none.error);
    cleanup();
  }

  {
    // Signed out must read as a state, not as a rejected code: telling someone
    // their partner's code is invalid when they simply are not signed in sends
    // them back to the partner complaining about a code that works.
    const { cleanup } = withAuth(() => ({ ok: false, signedOut: true }));
    const res = await billing.redeemCode('CRAIG');
    check('signed out is reported as signed out', res.signedOut === true);
    check('and says so rather than blaming the code', /Sign in/.test(res.error), res.error);
    cleanup();
  }

  {
    // Long input is clamped before it reaches the server.
    const { auth, cleanup } = withAuth(() => ok({ ok: true, kind: 'referral', code: 'X' }));
    await billing.redeemCode('C'.repeat(200));
    check('an over-long code is clamped',
      auth.calls[0].args.p_code.length === 40, auth.calls[0].args.p_code.length);
    cleanup();
  }

  /* ====================================================================== */
  console.log('\nThe attached discount — what the paywall shows');
  /* ====================================================================== */
  {
    const { auth, cleanup } = withAuth((fn) =>
      fn === 'my_referral'
        ? ok({ ok: true, code: 'CRAIG', ownerName: 'Craig M.', percentOff: 10, active: true })
        : ok({}));
    const r = await billing.referral();
    check('an attached discount is reported', r.ok === true);
    check('with the partner name', r.ownerName === 'Craig M.', r.ownerName);
    check('and is marked active', r.active === true);
    check('read through my_referral', auth.names().join(',') === 'my_referral');
    cleanup();
  }

  {
    const { cleanup } = withAuth(() => ok({ ok: false }));
    const r = await billing.referral();
    check('no discount attached reads as ok:false', r.ok === false);
    cleanup();
  }

  {
    // A revoked partner still leaves the attribution in place, but the screen
    // must not keep promising 10% that checkout will not give.
    const { cleanup } = withAuth(() =>
      ok({ ok: true, code: 'GONE', ownerName: 'Ex Partner', percentOff: 10, active: false }));
    const r = await billing.referral();
    check('a revoked code comes back inactive', r.ok === true && r.active === false);
    cleanup();
  }

  {
    // Nothing about a discount may be able to break the paywall.
    const { cleanup } = withAuth(() => {
      throw new Error('network down');
    });
    let threw = false;
    let r = null;
    try {
      r = await billing.referral();
    } catch {
      threw = true;
    }
    check('a thrown RPC does not escape referral()', !threw);
    check('and degrades to "no discount"', r && r.ok === false);
    cleanup();
  }

  {
    const { cleanup } = withAuth(() => ({ ok: false, signedOut: true }));
    const r = await billing.referral();
    check('signed out degrades quietly too', r.ok === false && r.signedOut === true);
    cleanup();
  }

  /* ====================================================================== */
  console.log('\nNormalisation — the app and the website must agree');
  /* ====================================================================== */
  {
    /*
     * The website normalises in TypeScript (lib/referral.ts) and the database in
     * SQL (referral_normalise). The app sends the raw string and lets the
     * database decide, which is why there is no third implementation here — but
     * the website's copy has to match, or its banner accepts a spelling the app
     * then refuses. This asserts the rule the website implements.
     */
    const normalise = (raw) =>
      (raw ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 24);

    const cases = [
      ['craig', 'CRAIG'],
      [' Craig ', 'CRAIG'],
      ['cr-aig', 'CRAIG'],
      ['CR AIG', 'CRAIG'],
      ['craig!', 'CRAIG'],
      ['', ''],
      [null, ''],
      ['a'.repeat(50), 'A'.repeat(24)],
    ];
    for (const [input, want] of cases) {
      const got = normalise(input);
      check(`${JSON.stringify(input)} → ${want || '(empty)'}`, got === want, got);
    }
  }

  /* ====================================================================== */
  console.log('\nApplying to become a partner (migration 0029)');
  /* ====================================================================== */
  {
    /*
     * These are read off the SQL rather than exercised, because every rule
     * worth asserting lives in the database and the app is only a client of
     * it. That is itself the property being protected: the card in Settings
     * hides the form for someone who cannot apply, but hiding a form has never
     * stopped anybody, and referral_request_submit is what actually decides.
     */
    const SQL = fs.readFileSync(
      path.join(__dirname, '..', 'supabase', 'migrations', '0029_partner_requests.sql'),
      'utf8',
    );

    const fn = (name) =>
      (SQL.match(
        new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$fn\\$([\\s\\S]*?)\\$fn\\$`),
      ) || [])[1] || '';

    const submit = fn('referral_request_submit');
    const approve = fn('admin_approve_referral_request');
    const decline = fn('admin_decline_referral_request');

    check('all three functions are there', !!submit && !!approve && !!decline);

    // One application at a time, enforced by an index and not only by a check
    // — two clicks a second apart would otherwise both pass the query.
    check(
      'a second pending application is impossible',
      /create unique index[\s\S]{0,140}referral_requests \(user_id\) where status = 'pending'/.test(SQL),
    );
    check(
      'someone who already owns a code cannot apply',
      /owner_user_id = v_uid and active and revoked_at is null/.test(submit),
    );
    check('a decline starts a cooldown, not a ban', /interval '30 days'/.test(submit));

    // Only an admin decides, and both answers say so before touching anything.
    for (const [name, body] of [['approve', approve], ['decline', decline]]) {
      check(`${name} is admin-only`, /if not public\.is_admin\(\) then/.test(body));
      check(
        `${name} refuses an application that was already decided`,
        /v_row\.status <> 'pending'/.test(body),
      );
    }

    /*
     * The approval is four things at once — code, link, decision, email — and
     * any subset of them is a broken state a person has to spot and repair by
     * hand. An approved application with no code is the worst of them: the
     * driver is told they are a partner and there is nothing to promote.
     */
    check('approving issues the code through the one validator',
      /public\.admin_issue_referral_code\(/.test(approve));
    check('…linked to the applicant', /p_owner_user_id => v_row\.user_id/.test(approve));
    check('…and closes the application', /set status      = 'approved'/.test(approve));
    check('…and queues exactly one email',
      (approve.match(/email_outbox_enqueue/g) || []).length === 1);
    check('…keyed per application, so a double click cannot send twice',
      /'partner\/approved:' \|\| p_id::text/.test(approve));

    // A code that cannot be minted must not leave an approved application
    // behind it — the check is that the UPDATE comes after the issue.
    check(
      'a refused code leaves the application pending',
      approve.indexOf('admin_issue_referral_code') <
        approve.indexOf("set status      = 'approved'"),
    );

    // The deliberate absence. A rejection email is worse than finding out
    // quietly in the app, and the reason is shown there instead.
    check('declining emails nobody', !/email_outbox_enqueue|email_outbox_poke/.test(decline));
    check('and the reason is kept to show them', /decline_reason = left\(/.test(decline));

    // A driver reads their own application and no one else's.
    check(
      'applications are readable only by the person who sent one',
      /create policy "own request readable"[\s\S]{0,120}user_id = auth\.uid\(\)/.test(SQL),
    );
  }

  /* ====================================================================== */
  console.log('\nThe wiring — a button with no handler is a dead button');
  /* ====================================================================== */
  {
    /*
     * The renderer calls window.apex.*, the preload turns that into an
     * ipcRenderer.invoke of a named channel, and main.js answers it. Nothing
     * type-checks the name in the middle: get it wrong and the promise simply
     * never resolves, while the button still looks alive. Cheap to assert, and
     * the only failure mode of this feature that a screenshot cannot catch.
     */
    const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
    const preload = read('electron', 'preload.js');
    const main = read('electron', 'main.js');
    const panel = read('electron', 'control-panel', 'control-panel.js');

    for (const channel of [
      'referral:requestMine',
      'referral:requestSubmit',
      'admin:referralRequests',
      'admin:approveReferralRequest',
      'admin:declineReferralRequest',
    ]) {
      check(
        `${channel} is both invoked and handled`,
        preload.includes(`invoke('${channel}'`) && main.includes(`handle('${channel}'`),
      );
    }

    for (const api of [
      'referralRequestMine',
      'referralRequestSubmit',
      'admin.referralRequests',
      'admin.approveReferralRequest',
      'admin.declineReferralRequest',
    ]) {
      const leaf = api.split('.').pop();
      check(`window.apex.${api} is exposed and used`,
        preload.includes(`${leaf}:`) && panel.includes(leaf));
    }
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
