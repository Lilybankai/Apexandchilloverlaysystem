/**
 * scripts/test-auth.js — the pure parts of the account flow.
 * -----------------------------------------------------------------------------
 * Sign-in, register and reset all hinge on two bits of logic that are easy to
 * get quietly wrong and impossible to spot on a screenshot:
 *
 *   1. parseRecoveryToken — what the operator pastes into the reset screen can
 *      be a short one-time code OR the whole reset link, and those go to
 *      DIFFERENT GoTrue fields (`token` vs `token_hash`). Mis-classify and every
 *      reset fails with "invalid token" while the code in the email is fine.
 *   2. publicUser — the only user shape the renderer ever sees. If a token ever
 *      leaked through here it would end up in the panel's DOM, so the shape is
 *      asserted field by field.
 *
 * No network, no Electron: auth.js only touches `app` via the userData dir it is
 * handed, so these functions are importable as-is. Run: node scripts/test-auth.js
 */

'use strict';

const auth = require('../electron/auth');

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

/* -------------------------------------------------------------------------- */
console.log('\nparseRecoveryToken — code vs link');
/* -------------------------------------------------------------------------- */

const p = auth.parseRecoveryToken;

{
  const r = p('123456');
  check('6-digit code → otp', r && r.kind === 'otp' && r.value === '123456', r && r.kind);
}
{
  const r = p('  935214  ');
  check('code is trimmed', r && r.value === '935214', r && `"${r.value}"`);
}
{
  // The default Supabase template mails a verify LINK whose token= param is the
  // already-hashed token — that must go to token_hash, not token.
  const link =
    'https://svtyxuhbsbbodsecbnsc.supabase.co/auth/v1/verify?token=pkce_9f8a7b6c5d&type=recovery&redirect_to=http://localhost:3000';
  const r = p(link);
  check('reset link → hash', r && r.kind === 'hash', r && r.kind);
  check('reset link → token value only', r && r.value === 'pkce_9f8a7b6c5d', r && r.value);
}
{
  const r = p('https://example.com/reset?token_hash=abc123def456&type=recovery');
  check('explicit token_hash → hash', r && r.kind === 'hash' && r.value === 'abc123def456');
}
{
  // PKCE redirect: needs the browser's code_verifier, so it cannot be used here
  // and must be reported rather than sent as a token.
  const r = p('http://localhost:3000/welcome?code=6e5f4a3b-2c1d');
  check('pkce redirect flagged', r && r.kind === 'pkce', r && r.kind);
}
{
  check('empty input rejected', p('') === null && p('   ') === null && p(null) === null);
  check('prose rejected', p('here is the link i got') === null);
  check('too-short code rejected', p('123') === null);
}
{
  // URL-encoded params must be decoded, or the token is sent with %2B intact.
  const r = p('https://x.co/v?token=ab%2Bcd%3D%3D&type=recovery');
  check('token is url-decoded', r && r.value === 'ab+cd==', r && r.value);
}

/* -------------------------------------------------------------------------- */
console.log('\npublicUser — the shape the renderer receives');
/* -------------------------------------------------------------------------- */

{
  const u = auth.publicUser({
    id: 'uuid-1',
    email: 'carl@apexandchill.gg',
    email_confirmed_at: '2026-07-26T10:00:00Z',
    // Deliberately present: these must NOT survive into the renderer's copy.
    access_token: 'SECRET',
    refresh_token: 'ALSO-SECRET',
    user_metadata: { display_name: 'Carl Jones', primary_sim: 'iRacing', marketing_opt_in: true },
  });
  check('display name passed through', u.displayName === 'Carl Jones', u.displayName);
  check('initials from two words', u.initials === 'CJ', u.initials);
  check('primary sim passed through', u.primarySim === 'iRacing', u.primarySim);
  check('opt-in coerced to boolean', u.marketingOptIn === true);
  check('email confirmed flag', u.emailConfirmed === true);
  const keys = Object.keys(u).sort().join(',');
  check(
    'no token fields leak',
    !('access_token' in u) && !('refresh_token' in u) && !/token/i.test(keys),
    keys,
  );
}
{
  // No display name yet (e.g. confirmation still pending) — fall back to the
  // local part of the address rather than rendering "undefined" in the top bar.
  const u = auth.publicUser({ id: 'uuid-2', email: 'lonewolf@example.com', user_metadata: {} });
  check('name falls back to email local part', u.displayName === 'lonewolf', u.displayName);
  check('single-word initials', u.initials === 'L', u.initials);
  check('unconfirmed reads false', u.emailConfirmed === false);
}
{
  const u = auth.publicUser({ id: 'u3', email: '', user_metadata: { display_name: '   ' } });
  check('blank name never renders empty', u.displayName === 'Driver', u.displayName);
  check('initials always non-empty', u.initials === 'D', u.initials);
}
{
  const u = auth.publicUser({
    id: 'u4',
    email: 'x@y.z',
    user_metadata: { display_name: 'Jean-Éric Van Der Berg' },
  });
  check('initials cap at two letters', u.initials === 'JV', u.initials);
}
check('null user stays null', auth.publicUser(null) === null);

/* -------------------------------------------------------------------------- */
console.log('\nContract with the UI');
/* -------------------------------------------------------------------------- */

{
  // The register screen's <select> is built from this list and the same list is
  // the whitelist register() validates against — one source, no drift.
  check('sim list is non-empty', Array.isArray(auth.PRIMARY_SIMS) && auth.PRIMARY_SIMS.length > 0);
  check('rFactor 2 / LMU is the default sim', auth.PRIMARY_SIMS[0] === 'rFactor 2 / LMU');
  // auth.css / auth.js promise "8+ characters" in three places.
  check('min password matches the UI copy', auth.MIN_PASSWORD === 8, auth.MIN_PASSWORD);
}
{
  const state = auth.stateForUi();
  check('signed out by default', state.signedIn === false && state.user === null);
  check('project is configured', state.configured === true);
}

/* -------------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
