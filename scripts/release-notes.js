/**
 * scripts/release-notes.js — the GitHub release body, from the same changelog.
 * -----------------------------------------------------------------------------
 * electron-builder publishes the release with an EMPTY body unless it is handed
 * notes, which is why every release so far has needed a follow-up
 * `gh release edit --notes-file` by hand — and why one that was forgotten had a
 * blank release page.
 *
 * This writes `build/release-notes.md` — the section of CHANGELOG.md for the
 * version being built, verbatim — which package.json points electron-builder at
 * via `build.releaseInfo.releaseNotesFile`. One source of truth: the same text
 * lands in the repo, on the GitHub release page, and in the app's What's New
 * panel (which reads its own packaged copy of CHANGELOG.md).
 *
 * It also means the update banner can say what an update contains before it is
 * installed: electron-updater reads those notes off the release feed.
 *
 *   node scripts/release-notes.js           # notes for package.json's version
 *   node scripts/release-notes.js 0.57.0    # notes for a specific version
 *   node scripts/release-notes.js --print   # write, and echo to stdout
 *
 * Runs as part of `npm run release`; check-changelog.js has already guaranteed
 * the section exists by then.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'release-notes.md');

const args = process.argv.slice(2);
const print = args.includes('--print');
const wanted = args.find((a) => !a.startsWith('--'));

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = (wanted || pkg.version).replace(/^v/, '');

const lines = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);

/**
 * Slice out one version's section, raw. Deliberately NOT reassembled from the
 * parsed block tree: the release page should show exactly what a reader of the
 * repo sees, down to the line breaks the notes were written with.
 */
const heading = new RegExp(`^##\\s+v?${version.replace(/\./g, '\\.')}(\\s|$|[^\\d])`);
const start = lines.findIndex((l) => heading.test(l.trim()));
if (start === -1) {
  console.error(`  release-notes: no CHANGELOG.md section for ${version}.`);
  process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (/^##\s+/.test(lines[i])) {
    end = i;
    break;
  }
}

// The version heading itself is dropped — the GitHub release is already titled
// with the tag, so repeating it just wastes the first line of the body.
const body = lines
  .slice(start + 1, end)
  .join('\n')
  .trim();

const notes = `${body}\n`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, notes, 'utf8');

console.log(`  release-notes: wrote ${path.relative(ROOT, OUT)} for ${version} (${body.length} chars).`);
if (print) console.log(`\n${notes}`);
