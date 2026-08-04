/**
 * scripts/release.js — one release command, two channels.
 * -----------------------------------------------------------------------------
 * From v0.57.0 there are two feeds on the same GitHub repo:
 *
 *   stable — a normal GitHub release. `electron-updater` asks GitHub for
 *            `/releases/latest`, which by definition skips prereleases, so this
 *            is what every driver gets and the only thing they CAN get.
 *   beta   — the same installer published as a GitHub **prerelease**, from a
 *            version carrying a `-beta.N` tag. Invisible to `/releases/latest`,
 *            and therefore invisible to everyone whose app is on stable.
 *
 * The channel is not a flag anyone has to remember: it is read off the version
 * in package.json. `0.57.0` publishes to stable, `0.58.0-beta.1` publishes to
 * beta. That is deliberate — the failure that matters here is publishing a
 * half-finished build to the five people testing the platform, and a flag you
 * can forget is exactly how that happens. There is nothing to forget: to cut a
 * beta, give it a beta version number.
 *
 *   npm run release             # channel decided by package.json's version
 *   node scripts/release.js --dry-run   # build + notes, publish nothing
 *
 * Runs as npm's `release` script, so the `prerelease` hook (check-changelog.js)
 * has already refused to start unless CHANGELOG.md documents this exact version,
 * and the `postrelease` hook (publish-notes.js) puts those notes on the release
 * page afterwards and verifies the prerelease flag landed the right way up.
 *
 * Needs `GH_TOKEN` for the publish step:
 *   GH_TOKEN=$(gh auth token) npm run release
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

/* -------------------------------------------------------------------------- */
/*  Which channel is this?                                                     */
/* -------------------------------------------------------------------------- */

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = String(pkg.version || '');

// The same module the APP uses to decide what a beta is, so the release script
// and the installs it feeds can never hold two different opinions.
const uc = require('../electron/updateChannel');

const verdict = uc.checkPublishableVersion(version);
if (!verdict.ok) {
  console.error(
    `\n  RELEASE FAILED\n\n  package.json's version is ${verdict.reason}.\n\n` +
      `  This repo publishes exactly two kinds of build:\n` +
      `    X.Y.Z          → stable, every driver gets it\n` +
      `    X.Y.Z-beta.N   → beta, only installs following the beta channel\n`,
  );
  process.exit(1);
}

const channel = verdict.channel;
const isBeta = channel === 'beta';

/* -------------------------------------------------------------------------- */
/*  Steps                                                                      */
/* -------------------------------------------------------------------------- */

const BUILDER = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/**
 * Every step is a direct `node <script>` call rather than `npm run <name>`:
 * spawning npm on Windows means spawning a `.cmd` through a shell, and this is
 * the one script in the repo where an argument being re-parsed by cmd.exe could
 * quietly change what gets published.
 */
function run(label, script, scriptArgs, env) {
  console.log(`\n  ── ${label}`);
  execFileSync(process.execPath, [script, ...scriptArgs], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...(env || {}) },
  });
}

console.log(
  `\n  Releasing ${version} to the ${channel.toUpperCase()} channel` +
    `${dryRun ? ' (dry run — nothing will be published)' : ''}.`,
);
if (isBeta) {
  console.log(
    `  It will be published as a GitHub PRERELEASE, so installs on the stable\n` +
      `  channel will not see it.`,
  );
}

// Also npm's `prerelease` hook, so `npm run release` has already passed this.
// Repeated here because a dry run (and anything that calls this file directly)
// gets no hook, and "built an installer nobody can describe" is the one outcome
// the gate exists to prevent.
run('checking the changelog', path.join(__dirname, 'check-changelog.js'), [version]);
run('compiling the server', TSC, ['-p', 'tsconfig.json']);
run('baking the YouTube OAuth client', path.join(__dirname, 'write-oauth-client.js'), []);
run('writing the release notes', path.join(__dirname, 'release-notes.js'), [version]);
run('packaging the installer', BUILDER, ['--win']);
run('verifying the baked OAuth client', path.join(__dirname, 'verify-oauth-baked.js'), []);

if (dryRun) {
  console.log(`\n  Dry run complete — ${version} built, nothing published.\n`);
  process.exit(0);
}

if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  console.error(
    `\n  RELEASE FAILED\n\n  No GH_TOKEN in the environment, so the publish step would fail\n` +
      `  after a successful build.\n\n  Run it as:\n    GH_TOKEN=$(gh auth token) npm run release\n`,
  );
  process.exit(1);
}

// EP_PRE_RELEASE is what actually flags the GitHub release as a prerelease, and
// it is set here rather than in package.json because `build.publish.releaseType`
// is a constant and the channel is not. The env var wins over `releaseType`
// (see electron-publish/gitHubPublisher.js), which is exactly what is wanted:
// the version number decides, every time, with nothing to keep in step.
run('publishing to GitHub', BUILDER, ['--win', '--publish', 'always'], {
  EP_PRE_RELEASE: isBeta ? 'true' : 'false',
});

console.log(`\n  Published v${version} to the ${channel} channel.\n`);
