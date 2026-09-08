/**
 * scripts/mirror-release.js — publish the same release to the OLD repo too.
 * -----------------------------------------------------------------------------
 * Runs as part of npm's `postrelease`, after publish-notes.js.
 *
 * ## The problem this solves
 * Every copy of Apex already installed on a driver's PC has the old repo's name
 * baked into `resources/app-update.yml`, and that is the only place it will
 * ever look. Publishing the new build to the new repo alone would leave every
 * existing install checking an address nothing new is ever posted to — no
 * error, no message, just an app that says it is up to date forever.
 *
 * So during the migration window each release goes to BOTH repos: the new one,
 * where it belongs and where every future build will look, and the old one,
 * where the installed base is still looking. A driver picks the build up from
 * the old repo, installs it, and from that moment their app looks at the new
 * one. The mirror is what carries them across.
 *
 * ## Turning it off
 * Set MIRROR_TO_LEGACY false in scripts/lib/release-target.js, and only then
 * make the old repo private — in that order, and not before you are satisfied
 * the stragglers are gone. See that file.
 *
 * ## Two things that go wrong quietly, both guarded here
 * 1. **`gh release upload` turns spaces into dots.** electron-builder writes
 *    `Apex AIO System Setup 1.2.3.exe` to disk and uploads it hyphenated; the
 *    manifest names the hyphenated file. Upload the on-disk name and the
 *    release gets `Apex.AIO.System.Setup.1.2.3.exe`, which `latest.yml` does
 *    not name — the updater finds the release and then 404s on the download.
 *    So the files are copied to their manifest names first.
 * 2. **The prerelease flag.** A beta mirrored as a full release is offered to
 *    every driver on the stable channel within the hour. It is set at creation
 *    and read back, the same as on the primary release.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TARGET = require('./lib/release-target.js');
const { isPrereleaseVersion } = require('../electron/updateChannel');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'release');
const NOTES = path.join(ROOT, 'build', 'release-notes.md');

const wanted = process.argv.slice(2).find((a) => !a.startsWith('--'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = (wanted || pkg.version).replace(/^v/, '');
const tag = `v${version}`;
const isBeta = isPrereleaseVersion(version);

/*
 * This script PUBLISHES. It is not a check, a dry run, or a way to see what
 * would happen — running it creates a real, downloadable GitHub release that
 * installs can be offered within the hour.
 *
 * That is not obvious from its name, and it was run by hand during development
 * "to test the guard", which published a beta nobody had asked for. It had to
 * be deleted within two minutes. So it now refuses unless it is being run by
 * the release itself, or told explicitly that you mean it.
 */
const invokedByRelease = process.env.npm_lifecycle_event === 'postrelease';
const forced = process.argv.includes('--force');
if (!invokedByRelease && !forced) {
  console.error(
    `\n  mirror-release: this PUBLISHES a release to ${TARGET.LEGACY_SLUG}.\n\n`
      + `  It runs on its own as part of \`npm run release\`. To mirror a release that\n`
      + `  was published without it — the only reason to run it by hand — say so:\n\n`
      + `    node scripts/mirror-release.js --force\n`,
  );
  process.exit(1);
}

if (!TARGET.MIRROR_TO_LEGACY) {
  console.log(
    `  mirror-release: off — ${tag} was published to ${TARGET.SLUG} only.\n` +
      `  (scripts/lib/release-target.js)`,
  );
  process.exit(0);
}

function gh(args) {
  return execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/* ---- the three files, under the names the manifest uses ------------------ */

const PRODUCT = 'Apex AIO System Setup';
const onDisk = [
  `${PRODUCT} ${version}.exe`,
  `${PRODUCT} ${version}.exe.blockmap`,
  'latest.yml',
];
const published = [
  `Apex-AIO-System-Setup-${version}.exe`,
  `Apex-AIO-System-Setup-${version}.exe.blockmap`,
  'latest.yml',
];

const missing = onDisk.filter((f) => !fs.existsSync(path.join(OUT, f)));
if (missing.length) {
  console.error(
    `\n  mirror-release: nothing to mirror — these are not in release/:\n` +
      missing.map((f) => `    ${f}`).join('\n') +
      `\n\n  Run this straight after a build, or re-run the release.\n`,
  );
  process.exit(1);
}

// latest.yml is the file the updater actually reads, and it names the installer
// by its hyphenated filename. If those two ever disagree the release looks
// perfect and downloads nothing, so it is checked rather than assumed.
const manifest = fs.readFileSync(path.join(OUT, 'latest.yml'), 'utf8');
if (!manifest.includes(published[0])) {
  console.error(
    `\n  mirror-release: release/latest.yml does not name ${published[0]}.\n` +
      `  Mirroring it would publish a manifest pointing at a file that is not there.\n`,
  );
  process.exit(1);
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-mirror-'));
const staged = onDisk.map((from, i) => {
  const to = path.join(stage, published[i]);
  fs.copyFileSync(path.join(OUT, from), to);
  return to;
});

/* ---- create it, or fill in the one that is already there ----------------- */

let exists = true;
try {
  gh(['release', 'view', tag, '--repo', TARGET.LEGACY_SLUG, '--json', 'tagName']);
} catch {
  exists = false;
}

try {
  if (!exists) {
    gh([
      'release', 'create', tag,
      '--repo', TARGET.LEGACY_SLUG,
      '--title', version,
      '--notes-file', NOTES,
      `--prerelease=${isBeta}`,
      `--latest=${!isBeta}`,
      ...staged,
    ]);
  } else {
    gh(['release', 'upload', tag, '--repo', TARGET.LEGACY_SLUG, '--clobber', ...staged]);
    gh(['release', 'edit', tag, '--repo', TARGET.LEGACY_SLUG, '--notes-file', NOTES,
      `--prerelease=${isBeta}`, `--latest=${!isBeta}`]);
  }
} catch (err) {
  const detail = String((err && (err.stderr || err.message)) || err).trim();
  console.error(
    `\n  mirror-release: COULD NOT MIRROR ${tag} TO ${TARGET.LEGACY_SLUG}.\n  ${detail}\n\n` +
      `  ${TARGET.SLUG} has the release, so anyone on a recent build is fine.\n` +
      `  Everyone still running an older build is NOT being offered it. Fix with:\n` +
      `    gh release create ${tag} --repo ${TARGET.LEGACY_SLUG} --title ${version} \\\n` +
      `      --notes-file build/release-notes.md --prerelease=${isBeta} --latest=${!isBeta} \\\n` +
      `      ${published.map((f) => `release/${f}`).join(' ')}\n`,
  );
  fs.rmSync(stage, { recursive: true, force: true });
  process.exit(1);
}

fs.rmSync(stage, { recursive: true, force: true });

/* ---- read it back ------------------------------------------------------- */

const seen = JSON.parse(
  gh(['release', 'view', tag, '--repo', TARGET.LEGACY_SLUG, '--json', 'assets,isPrerelease']),
);
const names = (seen.assets || []).map((a) => a.name);
const absent = published.filter((f) => !names.includes(f));

if (absent.length || seen.isPrerelease !== isBeta) {
  console.error(
    `\n  mirror-release: ${tag} reached ${TARGET.LEGACY_SLUG} but is not right.\n` +
      (absent.length ? `  missing assets: ${absent.join(', ')}\n` : '') +
      (seen.isPrerelease !== isBeta
        ? `  prerelease flag is ${seen.isPrerelease}, should be ${isBeta}\n`
        : '') +
      `  got: ${names.join(', ')}\n`,
  );
  process.exit(1);
}

console.log(
  `  mirror-release: ${tag} mirrored to ${TARGET.LEGACY_SLUG} ` +
    `(${names.length} assets, ${isBeta ? 'prerelease' : 'stable'}) — existing installs will find it.`,
);
