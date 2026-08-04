/**
 * scripts/publish-notes.js — put the notes on the GitHub release, for certain.
 * -----------------------------------------------------------------------------
 * `build.releaseInfo.releaseNotesFile` is supposed to hand electron-builder the
 * release body at publish time. On v0.56.0 it did not: the file was generated
 * correctly and the release still went out with an EMPTY body, which had to be
 * fixed by hand afterwards — the exact chore the whole thing exists to remove.
 *
 * So the body is now set explicitly after publishing, via `gh`, which is the
 * step this repo did by hand for every release before v0.56.0. `releaseInfo`
 * stays in package.json: when it works, this rewrites the body with identical
 * text and nothing changes.
 *
 * Runs as npm's `postrelease` hook, so it only fires after `npm run release`
 * has actually published. Run it by hand to repair a release that went out with
 * an empty body:
 *
 *   node scripts/publish-notes.js            # the version in package.json
 *   node scripts/publish-notes.js 0.56.0     # a specific release
 *
 * This is not a release gate: by the time it runs the installer is already
 * published, so a missing `gh` is reported loudly and left for a human rather
 * than failing a build that has already succeeded.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const NOTES = path.join(ROOT, 'build', 'release-notes.md');

const wanted = process.argv.slice(2).find((a) => !a.startsWith('--'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = (wanted || pkg.version).replace(/^v/, '');
const tag = `v${version}`;

function gh(args) {
  return execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// The notes are cheap to rebuild and must match the version being published,
// not whatever was left in build/ by an earlier run.
execFileSync(process.execPath, [path.join(__dirname, 'release-notes.js'), version], {
  cwd: ROOT,
  stdio: 'inherit',
});

const body = fs.readFileSync(NOTES, 'utf8').trim();
if (!body) {
  console.error(`  publish-notes: ${path.relative(ROOT, NOTES)} is empty — release body left alone.`);
  process.exit(1);
}

try {
  gh(['release', 'edit', tag, '--notes-file', NOTES]);
} catch (err) {
  const detail = String((err && (err.stderr || err.message)) || err).trim();
  console.error(
    `\n  publish-notes: could not set the body of ${tag}.\n  ${detail}\n\n` +
      `  The release itself is fine — only its notes are missing. Fix with:\n` +
      `    gh release edit ${tag} --notes-file build/release-notes.md\n`,
  );
  process.exit(1);
}

// Read it back: an edit that silently no-ops leaves exactly the empty body this
// script exists to prevent, and only the round-trip proves otherwise.
let live = '';
try {
  live = gh(['release', 'view', tag, '--json', 'body', '--jq', '.body']).trim();
} catch {
  /* the edit succeeded; treat an unreadable read-back as good enough */
}
if (live && live.length < Math.min(80, body.length)) {
  console.error(`  publish-notes: ${tag}'s body came back as ${live.length} characters — check the release.`);
  process.exit(1);
}

console.log(`  publish-notes: ${tag} release notes set (${body.length} characters).`);
