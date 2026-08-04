/**
 * scripts/test-updatechannel.js — who is allowed to see which build.
 * -----------------------------------------------------------------------------
 * The stable/beta split is one boolean deep. `allowPrerelease: false` makes
 * electron-updater read GitHub's `/releases/latest`, which excludes
 * prereleases; `true` makes it walk the whole feed. Get that backwards for one
 * release and every driver testing the platform is handed a build we were
 * midway through breaking — automatically, within the hour, with no way to
 * un-send it.
 *
 * So the rule is asserted directly rather than trusted to a regex written twice.
 * Everything here is pure: no Electron, no network, no GitHub.
 *
 * Run: node scripts/test-updatechannel.js
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const uc = require('../electron/updateChannel');

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
console.log('\nisPrereleaseVersion — what counts as a beta');
/* -------------------------------------------------------------------------- */

check('a release is not a prerelease', uc.isPrereleaseVersion('0.57.0') === false);
check('a beta is', uc.isPrereleaseVersion('0.57.0-beta.1') === true);
check('a two-digit minor still parses', uc.isPrereleaseVersion('0.100.2-beta.12') === true);
// Everything below would be called a prerelease by a naive `includes('-')`,
// and each one resolves the wrong way: towards showing someone a beta.
check('empty string is not', uc.isPrereleaseVersion('') === false, 'the naive-check trap');
check('undefined is not', uc.isPrereleaseVersion(undefined) === false);
check('null is not', uc.isPrereleaseVersion(null) === false);
check('a branch name is not', uc.isPrereleaseVersion('feature-beta') === false);
check('a v-prefixed tag is not a version', uc.isPrereleaseVersion('v0.57.0-beta.1') === false);

/* -------------------------------------------------------------------------- */
console.log('\nnormalizeChannel — a corrupt setting must fail towards stable');
/* -------------------------------------------------------------------------- */

check('stable stays stable', uc.normalizeChannel('stable') === 'stable');
check('beta stays beta', uc.normalizeChannel('beta') === 'beta');
check('missing → stable', uc.normalizeChannel(undefined) === 'stable');
check('nonsense → stable', uc.normalizeChannel('BETA') === 'stable', 'case is not a channel');
check('an object → stable', uc.normalizeChannel({ channel: 'beta' }) === 'stable');
check('true → stable', uc.normalizeChannel(true) === 'stable');

/* -------------------------------------------------------------------------- */
console.log('\nupdaterFlags — the two switches that do all the work');
/* -------------------------------------------------------------------------- */

{
  const stableOnStable = uc.updaterFlags('stable', '0.57.0');
  check('stable build, stable channel: no prereleases', stableOnStable.allowPrerelease === false);
  check(
    'stable build, stable channel: no downgrade',
    stableOnStable.allowDowngrade === false,
    'a pulled release must not roll the league backwards',
  );

  const stableOnBeta = uc.updaterFlags('beta', '0.57.0');
  check('stable build, beta channel: prereleases on', stableOnBeta.allowPrerelease === true);
  check('stable build, beta channel: no downgrade', stableOnBeta.allowDowngrade === false);

  const betaOnBeta = uc.updaterFlags('beta', '0.58.0-beta.2');
  check('beta build, beta channel: prereleases on', betaOnBeta.allowPrerelease === true);
  check('beta build, beta channel: no downgrade', betaOnBeta.allowDowngrade === false);

  // The way back. This is the only combination that may go backwards, and it
  // has to: 0.58.0-beta.3 is NEWER than every stable release, so without it
  // "switch me back to stable" silently leaves you on the beta forever.
  const betaOnStable = uc.updaterFlags('stable', '0.58.0-beta.3');
  check('beta build, stable channel: prereleases off', betaOnStable.allowPrerelease === false);
  check(
    'beta build, stable channel: downgrade ALLOWED',
    betaOnStable.allowDowngrade === true,
    'the way off the beta channel',
  );

  check('an unknown channel behaves as stable', uc.updaterFlags('nightly', '0.57.0').allowPrerelease === false);
}

/* -------------------------------------------------------------------------- */
console.log('\ncheckPublishableVersion — the release gate');
/* -------------------------------------------------------------------------- */

check('x.y.z publishes to stable', uc.checkPublishableVersion('0.57.0').channel === 'stable');
check('x.y.z-beta.N publishes to beta', uc.checkPublishableVersion('0.58.0-beta.1').channel === 'beta');
check('-rc.1 is refused', uc.checkPublishableVersion('0.58.0-rc.1').ok === false);
check('-alpha.1 is refused', uc.checkPublishableVersion('0.58.0-alpha.1').ok === false);
check('a bare -beta is refused', uc.checkPublishableVersion('0.58.0-beta').ok === false, 'no ordering');
check('a non-version is refused', uc.checkPublishableVersion('next').ok === false);

/* -------------------------------------------------------------------------- */
console.log('\nAgreement — the app and the release script share one rule');
/* -------------------------------------------------------------------------- */

/*
 * The failure this guards against is not a wrong answer, it is TWO answers: the
 * release script publishing 0.58.0-beta.1 as a full release because it decided
 * "beta" differently than the app did. Both must reach the channel through this
 * module, so neither file may carry its own copy of the test.
 */
for (const rel of ['scripts/release.js', 'scripts/publish-notes.js', 'electron/main.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  check(`${rel} uses the shared rule`, /require\((['"]).*updateChannel\1\)/.test(src));
}

for (const version of ['0.57.0', '0.58.0-beta.4']) {
  check(
    `${version}: publish gate and app agree on the channel`,
    uc.checkPublishableVersion(version).channel === uc.channelForVersion(version),
    uc.channelForVersion(version),
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nThe shipping version');
/* -------------------------------------------------------------------------- */

{
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const verdict = uc.checkPublishableVersion(pkg.version);
  check(`package.json's ${pkg.version} is publishable`, verdict.ok === true, verdict.reason || verdict.channel);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
