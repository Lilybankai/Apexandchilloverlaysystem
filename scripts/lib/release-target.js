/**
 * scripts/lib/release-target.js — which repo the installers live in.
 * -----------------------------------------------------------------------------
 * One fact, one owner. `electron-builder.js` bakes it into every package's
 * `app-update.yml`, `publish-notes.js` edits the release it names, and
 * `mirror-release.js` copies each release back to the repo the app used to
 * look at. Three places that must never disagree, because the failure when
 * they do is silent: an installed app looks where ITS OWN build was told to,
 * and simply stops finding updates.
 *
 * ## Why there are two repos at all
 * The source repo is private. GitHub release assets on a private repo are not
 * publicly downloadable, so the installers live in a public repo of their own
 * that holds nothing else.
 *
 * ## Why LEGACY is still here
 * Every copy of the app already installed on a driver's PC has the OLD repo
 * baked into `resources/app-update.yml`. It will keep asking that repo for
 * updates until it installs a build that says otherwise — and it can only get
 * that build from the old repo. So for as long as the migration window is
 * open, every release is published to the new repo AND mirrored to the old
 * one, and the old repo stays public.
 *
 * ## Closing the window
 * Set `MIRROR_TO_LEGACY` to false, and only then make the old repo private.
 * In that order: a private repo's releases 404 for everyone, and an install
 * that never took a repointing build is stranded on the version it has, with
 * no message and no way back except downloading the installer by hand.
 *
 * Check who is left before closing it — `updater.log` on a driver's machine
 * names the version it decided was latest, and the old repo's release download
 * counts stop climbing once nobody is looking there any more.
 */

'use strict';

const OWNER = 'Lilybankai';

/** Where installers are published, and where every new build will look. */
const REPO = 'apex-aio-releases';

/** Where builds up to and including v0.99.3 were told to look. */
const LEGACY_REPO = 'Apexandchilloverlaysystem';

/**
 * Mirror every release to the legacy repo as well.
 *
 * True for the whole migration window. See "Closing the window" above — this
 * flag going false is a decision about drivers, not about tidiness.
 */
const MIRROR_TO_LEGACY = true;

module.exports = {
  OWNER,
  REPO,
  LEGACY_REPO,
  MIRROR_TO_LEGACY,
  SLUG: `${OWNER}/${REPO}`,
  LEGACY_SLUG: `${OWNER}/${LEGACY_REPO}`,
};
