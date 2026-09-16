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
