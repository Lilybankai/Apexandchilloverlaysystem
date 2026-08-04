/**
 * electron/updateChannel.js — which builds an install is allowed to see.
 * -----------------------------------------------------------------------------
 * From v0.57.0 the same GitHub repo carries two feeds:
 *
 *   stable — normal releases. This is what the league runs.
 *   beta   — the same installer published as a GitHub *prerelease*, from a
 *            version tagged `-beta.N`. Only installs that asked for betas see
 *            them, because `electron-updater` on the stable channel reads
 *            `/releases/latest`, which GitHub defines as excluding prereleases.
 *
 * Two completely different programs have to agree on the rule: the app (which
 * feed do I follow, and is the thing I am running a beta?) and the release
 * script (do I publish this version as a prerelease?). If they ever disagree by
 * so much as a regex, a build meant for two people goes to everyone — so they
 * share this file rather than each carrying their own idea of what a beta is.
 *
 * Pure string/semver logic, no Electron, no fs — so it can be unit-tested:
 * `node scripts/test-updatechannel.js`.
 */

'use strict';

/** The feeds an install can follow. Anything else is not a channel. */
const CHANNELS = ['stable', 'beta'];

/**
 * `0.57.0-beta.2` is a prerelease; `0.57.0` is not. Deliberately anchored to a
 * full `x.y.z` first: a loose `includes('-')` would call the empty string, an
 * undefined version or a stray branch name a prerelease, and every one of those
 * would resolve towards "this is a beta" — the wrong way to fail. An unparseable
 * version is treated as stable, which at worst offers someone an update they
 * already have.
 */
function isPrereleaseVersion(version) {
  return /^\d+\.\d+\.\d+[-+]/.test(String(version || ''));
}

/** The channel a version belongs to — the ONLY thing that decides it. */
function channelForVersion(version) {
  return isPrereleaseVersion(version) ? 'beta' : 'stable';
}

/**
 * A stored/user-supplied channel, made safe. An unrecognised value falls back
 * to stable rather than to whatever was written: this setting decides which
 * builds reach a driver, so a corrupt config.json must fail towards the tested
 * one.
 */
function normalizeChannel(value) {
  return CHANNELS.includes(value) ? value : 'stable';
}

/**
 * The two electron-updater switches that implement all of the above.
 *
 * `allowPrerelease` is the channel itself: false makes the updater ask GitHub
 * for `/releases/latest` (prereleases excluded, by GitHub's own definition);
 * true makes it walk the releases feed and take the newest entry of either
 * kind. That second behaviour is why a beta tester still receives stable
 * releases — 0.58.0 beats 0.58.0-beta.3 — which is what makes promoting a beta
 * to main a non-event for the people who were testing it.
 *
 * `allowDowngrade` is the way BACK. Someone running 0.58.0-beta.3 who switches
 * to stable is on a version NEWER than anything on the stable feed, so without
 * it the app would report "up to date" and strand them on a beta until the
 * release caught up. It is enabled in exactly that case and no other: on the
 * beta channel, or for a stable build on stable, a downgrade could only ever
 * mean a release had been pulled — and quietly rolling every driver backwards
 * is not the right answer to that.
 */
function updaterFlags(channel, runningVersion) {
  const beta = normalizeChannel(channel) === 'beta';
  return {
    allowPrerelease: beta,
    allowDowngrade: !beta && isPrereleaseVersion(runningVersion),
  };
}

/**
 * Whether a version is one this repo knows how to publish, and why not.
 *
 * `x.y.z` and `x.y.z-beta.N` only. An `-rc.1`, an `-alpha.2` or a bare `-beta`
 * would all still build and publish, but drivers on the beta channel are
 * matched by the `beta` prerelease component and electron-updater orders these
 * tags in ways a human reading the number would not predict. A release is not
 * the place to find that out.
 */
function checkPublishableVersion(version) {
  const parsed = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(version || ''));
  if (!parsed) return { ok: false, reason: `not a semver version: "${version}"` };
  const preTag = parsed[4] || '';
  if (preTag && !/^beta\.\d+$/.test(preTag)) {
    return { ok: false, reason: `unsupported prerelease tag "${preTag}"` };
  }
  return { ok: true, channel: preTag ? 'beta' : 'stable' };
}

module.exports = {
  CHANNELS,
  isPrereleaseVersion,
  channelForVersion,
  normalizeChannel,
  updaterFlags,
  checkPublishableVersion,
};
