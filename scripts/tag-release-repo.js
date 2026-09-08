/**
 * scripts/tag-release-repo.js — give the releases repo a commit and a tag.
 * -----------------------------------------------------------------------------
 * Run by scripts/release.js just before publishing. It writes this version's
 * CHANGELOG.md into the public releases repo through the Contents API — which
 * creates a commit — and then points `v<version>` at that commit.
 *
 * ## Why this exists at all
 * The releases repo holds no source, so nothing would ever commit to it. Left
 * alone, electron-builder's GitHub publisher creates each tag itself, at the
 * default branch's HEAD — which in a repo with one static README means EVERY
 * release tag lands on the SAME commit and inherits the same date.
 *
 * That is not cosmetic. An install on the beta channel reads `releases.atom`,
 * which is ordered by tag date rather than by version, and takes the first
 * entry. Give six releases one date and their order is arbitrary: a tester can
 * be offered a build older than the one they are running, or none at all. It
 * is the same failure that made v0.97.2-beta.3 invisible, arrived at from a
 * different direction — and this time it would hit every release, not one.
 *
 * A commit per release fixes it, costs one API call, and has the side effect of
 * making the repo readable: its history is the release history, and its
 * CHANGELOG.md is always the notes for the newest build in it.
 *
 * Idempotent. A tag that already exists is left exactly as it is, so a re-run
 * after a failed publish cannot move a tag that a release is already using.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TARGET = require('./lib/release-target.js');

const ROOT = path.join(__dirname, '..');
const wanted = process.argv.slice(2).find((a) => !a.startsWith('--'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = (wanted || pkg.version).replace(/^v/, '');
const tag = `v${version}`;

/** `gh api`, returning parsed JSON, or null when the call 404s. */
function api(args, { allow404 = false } = {}) {
  try {
    const out = execFileSync('gh', ['api', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim() ? JSON.parse(out) : null;
  } catch (err) {
    const detail = String((err && (err.stderr || err.message)) || err);
    if (allow404 && /HTTP 404|Not Found/i.test(detail)) return null;
    throw new Error(detail.trim());
  }
}

const repoPath = (p) => `repos/${TARGET.SLUG}/${p}`;

// Already tagged — a re-run after a half-finished publish must not move it.
const existing = api([repoPath(`git/ref/tags/${tag}`)], { allow404: true });
if (existing) {
  console.log(`  tag-release-repo: ${TARGET.SLUG} already has ${tag} — left alone.`);
  process.exit(0);
}

// The Contents API needs the sha of the file it is replacing, and returns the
// commit it made. One call does both the write and the commit.
const current = api([repoPath('contents/CHANGELOG.md')], { allow404: true });
const payload = {
  message: `${tag} — release notes`,
  content: fs.readFileSync(path.join(ROOT, 'CHANGELOG.md')).toString('base64'),
};
if (current && current.sha) payload.sha = current.sha;

const tmp = path.join(ROOT, 'build');
fs.mkdirSync(tmp, { recursive: true });
const payloadFile = path.join(tmp, 'release-repo-changelog.json');
fs.writeFileSync(payloadFile, JSON.stringify(payload));

let committed;
try {
  committed = api([repoPath('contents/CHANGELOG.md'), '-X', 'PUT', '--input', payloadFile]);
} finally {
  fs.rmSync(payloadFile, { force: true });
}

const sha = committed && committed.commit && committed.commit.sha;
if (!sha) {
  console.error(`\n  tag-release-repo: no commit came back from ${TARGET.SLUG}. Nothing tagged.\n`);
  process.exit(1);
}

api([
  repoPath('git/refs'), '-X', 'POST',
  '-f', `ref=refs/tags/${tag}`,
  '-f', `sha=${sha}`,
]);

console.log(`  tag-release-repo: ${TARGET.SLUG} ${tag} -> ${sha.slice(0, 7)}`);
