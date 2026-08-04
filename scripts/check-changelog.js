/**
 * scripts/check-changelog.js — the release gate.
 * -----------------------------------------------------------------------------
 * A release with no changelog entry is not just undocumented: since v0.56.0 the
 * app SHOWS the entry to every driver the first time they open the new build,
 * and pushes it to the GitHub release body. A missing entry means an update
 * that announces itself and then has nothing to say.
 *
 * So this refuses to let the release proceed unless CHANGELOG.md has a real
 * section for the version in package.json. It runs automatically as npm's
 * `prerelease` hook — `npm run release` cannot get past it — and can be run by
 * hand at any time:
 *
 *   node scripts/check-changelog.js            # check package.json's version
 *   node scripts/check-changelog.js 0.57.0     # check a version you are about to cut
 *
 * Exit code 0 = good to publish, 1 = fix the changelog first.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cl = require('../electron/changelog');

const ROOT = path.join(__dirname, '..');

/** Enough prose that the entry says something; a bare heading is not an entry. */
const MIN_CHARS = 60;

function fail(message, hint) {
  console.error(`\n  CHANGELOG CHECK FAILED\n\n  ${message}\n`);
  if (hint) console.error(`${hint}\n`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = (process.argv[2] || pkg.version || '').replace(/^v/, '');

if (!version) fail('package.json has no version.');

let text;
try {
  text = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
} catch {
  fail(
    'CHANGELOG.md is missing from the repo root.',
    '  It is packaged into the app and read by the What\'s New panel, so it\n' +
      '  has to exist before a release can be built.',
  );
}

const entries = cl.parseChangelog(text);
const entry = cl.findEntry(entries, version);

const template =
  `  Add a section at the TOP of CHANGELOG.md, above the previous release:\n\n` +
  `    ## ${version} — ${new Date().toISOString().slice(0, 10)}\n\n` +
  `    ### Added\n\n` +
  `    - **A one-line headline in bold.** Then the paragraph that explains what\n` +
  `      changed and why it matters to someone driving. Use ### Added / Changed /\n` +
  `      Fixed / Removed to group them.\n`;

if (!entry) {
  fail(
    `CHANGELOG.md has no entry for ${version} (the version in package.json).`,
    template,
  );
}

/** Rough character count of the parsed prose — headings alone don't count. */
function proseLength(blocks) {
  let n = 0;
  for (const b of blocks || []) {
    if (b.type === 'para') for (const s of b.spans) n += (s.s || '').length;
    else if (b.type === 'item') n += proseLength(b.body);
  }
  return n;
}

const length = proseLength(entry.blocks);
if (length < MIN_CHARS) {
  fail(
    `The entry for ${version} is empty or a stub (${length} characters of prose).`,
    template,
  );
}

if (!entry.date) {
  fail(
    `The entry for ${version} has no date.`,
    `  Write the heading as: ## ${version} — ${new Date().toISOString().slice(0, 10)}\n`,
  );
}

// The newest entry in the file should be the one being released; if it is not,
// the release is being cut from a changelog that has moved on without it.
if (entries[0] && cl.compareVersions(entries[0].version, version) > 0) {
  fail(
    `CHANGELOG.md's newest entry is ${entries[0].version}, which is NEWER than the\n` +
      `  version being released (${version}). package.json is probably behind.`,
  );
}

console.log(`  CHANGELOG ok — ${version} (${entry.date}), ${length} characters of notes.`);
