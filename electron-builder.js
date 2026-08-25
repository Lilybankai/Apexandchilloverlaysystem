'use strict';

const { execFileSync } = require('node:child_process');

/**
 * electron-builder configuration.
 *
 * This lives in a file rather than in package.json's `build` field because
 * signing has to be conditional, and a JSON field cannot ask whether the
 * credentials are present. Note that electron-builder reads `build` from
 * package.json in PREFERENCE to this file and never falls through to it: if
 * that field ever comes back, everything here is silently ignored and the
 * installer goes out unsigned.
 *
 * Windows installers are signed with Azure Trusted Signing. The credentials
 * only exist on the build box, so requiring them unconditionally would break
 * `npm run pack` and `npm run release:dry` everywhere else. Without them the
 * build still succeeds and produces an unsigned installer.
 */

/** Azure Trusted Signing account `apex26`, North Europe. */
const ENDPOINT = 'https://neu.codesigning.azure.net/';
const ACCOUNT_NAME = 'apex26';
const CERTIFICATE_PROFILE = 'ApexAIOSystem26';

/**
 * Trusted Signing's own timestamp authority. This is not optional: the
 * certificates it issues last about three days, and an untimestamped signature
 * becomes invalid the moment the certificate behind it expires. Countersigned,
 * the signature stays valid for the life of the timestamp certificate — years —
 * because verifiers check the signing time against the certificate's validity
 * window rather than against today's date.
 *
 * The PowerShell module declares its timestamp parameters with no defaults, so
 * leaving them out silently produces an untimestamped signature that verifies
 * perfectly today and fails on Saturday. Check with:
 *   signtool verify /pa /v <file>   ->  "File is not timestamped."
 */
const TIMESTAMP_URL = 'http://timestamp.acs.microsoft.com';

/**
 * The certificate's common name, exactly as it appears in the profile's
 * subject: `CN=The Lilybank Agency Ltd, O=The Lilybank Agency Ltd, STREET=...`.
 *
 * electron-builder writes this into latest.yml and electron-updater then
 * refuses any update whose signature does not match it, so a typo here breaks
 * updating for every install rather than failing at build time. It has to be
 * stated: electron-builder can only derive a publisher name by reading a local
 * .pfx, and Trusted Signing never puts a certificate on disk. Left unset, the
 * field is simply absent from latest.yml and clients skip verification
 * entirely.
 */
const PUBLISHER_NAME = 'The Lilybank Agency Ltd';

/*
 * The three variables electron-builder itself checks before it will attempt a
 * signature. It accepts three credential shapes (secret, client certificate,
 * username+password); this is the secret one, which is what the build box uses.
 * They are read from `electron-builder.env`, which the CLI loads on every run.
 */
const canSign = Boolean(
  process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET,
);

if (!canSign) {
  console.warn(
    '\n  WARNING  No Azure Trusted Signing credentials in the environment.\n' +
      '           This installer will be UNSIGNED, and Windows will show the\n' +
      '           SmartScreen "unknown publisher" warning on install.\n' +
      '           Fine for a local `pack`. Not fine for anything published.\n' +
      '           Needs AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET.\n',
  );
}

/** A PowerShell single-quoted literal: the only escape inside one is '' for '. */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Run one Invoke-TrustedSigning command, retrying a service-side failure.
 *
 * Trusted Signing can answer HTTP 200 with `{"status":"Failed","signature":
 * null}` for a single digest — a failure on Azure's side, not ours. The module
 * turns that into `SignerSign() failed (0x80004005)` and aborts the WHOLE
 * invocation, so one unlucky digest fails a folder of a dozen binaries and
 * takes the build with it. Seen twice in a row cutting v0.90.1, on the same
 * file both times, which then signed first try on its own.
 *
 * It matters more than the odds suggest because a release invokes
 * electron-builder twice (package, then publish) and each run signs every
 * bundled folder, so one build is four or more chances to be unlucky.
 *
 * Retrying the whole command is safe: signing is idempotent — signtool
 * replaces an existing signature rather than refusing or double-signing — so a
 * retry re-signs the files that already succeeded and costs only time.
 *
 * Bounded, and it still throws on the last attempt. A build that cannot sign
 * must fail: an unsigned installer is the SmartScreen warning this whole
 * mechanism exists to remove.
 */
function runSigning(command, what, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // powershell.exe rather than pwsh: the TrustedSigning module installs
      // into the Windows PowerShell module path, and that is where it is found.
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        stdio: 'inherit',
      });
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      console.warn(
        `\n  WARNING  signing ${what} failed (attempt ${attempt} of ${attempts}).\n` +
          '           Trusted Signing fails a digest service-side now and then;\n' +
          '           re-signing is harmless, so this is being retried.\n',
      );
      // A beat before retrying — the service's own 429s carry Retry-After: 1.
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep 5'], {
        stdio: 'ignore',
      });
    }
  }
}

/**
 * Sign one file with Azure Trusted Signing.
 *
 * This deliberately does NOT use electron-builder's own `win.azureSignOptions`.
 * That path builds its PowerShell command by joining every argument with a
 * space and quoting none of them, so a product name containing a space is torn
 * into separate arguments: `-Files ...\Apex Overlay System.exe` was read as the
 * file `...\Apex`, the folder `Overlay` and the filter `System.exe`, and signed
 * nothing. Since `Files` is applied after the caller's options, there is no way
 * to pre-quote it through the config either.
 *
 * Invoking the same PowerShell module directly is the whole fix — every value
 * goes in quoted.
 */
function signWithTrustedSigning(configuration) {
  const command =
    'Invoke-TrustedSigning' +
    ` -Endpoint ${psQuote(ENDPOINT)}` +
    ` -CodeSigningAccountName ${psQuote(ACCOUNT_NAME)}` +
    ` -CertificateProfileName ${psQuote(CERTIFICATE_PROFILE)}` +
    ' -FileDigest SHA256' +
    ` -TimestampRfc3161 ${psQuote(TIMESTAMP_URL)}` +
    ' -TimestampDigest SHA256' +
    ` -Files ${psQuote(configuration.path)}`;

  runSigning(command, configuration.path);
}

/**
 * Sign every exe and DLL under a folder — the bundled Piper and whisper
 * binaries. One module call per folder rather than per file: the module's
 * folder mode batches the digests, and a release signs ~a dozen files here.
 */
function signFolderWithTrustedSigning(folder, filter = 'exe,dll') {
  const command =
    'Invoke-TrustedSigning' +
    ` -Endpoint ${psQuote(ENDPOINT)}` +
    ` -CodeSigningAccountName ${psQuote(ACCOUNT_NAME)}` +
    ` -CertificateProfileName ${psQuote(CERTIFICATE_PROFILE)}` +
    ' -FileDigest SHA256' +
    ` -TimestampRfc3161 ${psQuote(TIMESTAMP_URL)}` +
    ' -TimestampDigest SHA256' +
    ` -FilesFolder ${psQuote(folder)}` +
    ` -FilesFolderFilter ${psQuote(filter)}` +
    ' -FilesFolderRecurse';

  runSigning(command, folder);
}

/**
 * After the app directory is assembled (and before the NSIS installer is
 * built from it): verify the bundled engineer assets actually made it in,
 * then sign their binaries.
 *
 * The verification is not optional politeness. A build made without
 * `build/bundled/` staged would succeed, ship, and silently fall back to
 * downloading unsigned binaries at runtime — the exact antivirus-quarantine
 * behaviour v0.79.0 exists to remove. Fail the build instead.
 *
 * Signing here rather than at stage time means the staged cache never holds
 * signed copies (staging also runs on machines without credentials), and
 * every published installer carries our signature on every binary it spawns —
 * which is what moves an AV verdict from "unknown unsigned exe" to "signed by
 * a known publisher".
 */
async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const fs = require('node:fs');
  const path = require('node:path');
  const resources = path.join(context.appOutDir, 'resources');

  execFileSync(process.execPath, [path.join(__dirname, 'scripts', 'stage-bundled.js'), '--check'], {
    stdio: 'inherit',
  });
  for (const probe of ['piper/piper.exe', 'whisper/ggml-base.en.bin', 'sidecars/voice-player.ps1']) {
    if (!fs.existsSync(path.join(resources, probe))) {
      throw new Error(
        `bundled engineer assets missing from the package (${probe}) — ` +
          'run `node scripts/stage-bundled.js` and rebuild',
      );
    }
  }

  if (canSign) {
    console.log('  • signing bundled engineer binaries (piper, whisper, sidecars)');
    signFolderWithTrustedSigning(path.join(resources, 'piper'));
    signFolderWithTrustedSigning(path.join(resources, 'whisper'));
    // .ps1 takes Authenticode like an exe does — verified against the live
    // signing account before this was wired in.
    signFolderWithTrustedSigning(path.join(resources, 'sidecars'), 'ps1');
  } else {
    console.warn(
      '  WARNING  bundled piper/whisper binaries are UNSIGNED (no credentials) —\n' +
        '           fine for a local pack, not for anything published.',
    );
  }
}

// NSIS stores a shortcut's description in a MAX_PATH buffer, so anything past
// 259 characters is written to the .lnk with a length prefix that no longer
// matches the bytes actually stored. Every length-prefixed string AFTER it --
// including the icon location -- then parses from a shifted offset, and the
// shell falls back to the blank-document icon. The shortcut still launches,
// because the target path is stored before the description, which is what makes
// this fail so quietly. electron-builder takes this string from package.json's
// `description`, so guard it here rather than trusting a comment nobody reads.
const NSIS_DESCRIPTION_LIMIT = 259;
const appDescription = require('./package.json').description || '';
if (appDescription.length > NSIS_DESCRIPTION_LIMIT) {
  throw new Error(
    `package.json "description" is ${appDescription.length} characters; NSIS ` +
      `truncates past ${NSIS_DESCRIPTION_LIMIT} and corrupts the shortcut icon. ` +
      'Shorten it.',
  );
}

module.exports = {
  // appId is the app's *identity* to NSIS (the uninstall GUID is derived from
  // it) and must survive the rename to "Apex AIO System" — changing it would
  // give every existing user a second, parallel install.
  appId: 'com.apexandchill.overlaysystem',
  productName: 'Apex AIO System',
  publish: {
    provider: 'github',
    owner: 'Lilybankai',
    repo: 'Apexandchilloverlaysystem',
    releaseType: 'release',
  },
  directories: {
    output: 'release',
  },
  releaseInfo: {
    releaseNotesFile: 'build/release-notes.md',
  },
  extraResources: [
    {
      from: 'build/plugin',
      to: 'plugin',
    },
    // The engineer's binaries, staged by scripts/stage-bundled.js and signed
    // in afterPack. Bundled (not downloaded at runtime) so antivirus sees
    // signed files with installer provenance instead of an app curling an
    // unknown exe into AppData — the Norton-quarantine class of failure.
    {
      from: 'build/bundled/piper',
      to: 'piper',
    },
    {
      from: 'build/bundled/whisper',
      to: 'whisper',
    },
    // The engineer's PowerShell sidecars: plain first-party scripts, signed in
    // afterPack, run with -File (never -EncodedCommand — an AV-heuristic tell).
    {
      from: 'electron/sidecars',
      to: 'sidecars',
    },
  ],
  afterPack,
  files: [
    'electron/**/*',
    // The screenshot harness (scripts/make-shot-harness.js) generates
    // __shot-* files into control-panel/ — dev-only, never packaged.
    '!electron/control-panel/__shot-*',
    'dist/**/*',
    'overlay/**/*',
    'data/**/*',
    'package.json',
    'CHANGELOG.md',
  ],
  asarUnpack: ['**/node_modules/koffi/**'],
  win: {
    target: ['nsis'],
    icon: 'build/icon.ico',
    // Spread rather than set-to-undefined: electron-builder branches on the
    // presence of these keys, so they must be absent, not empty.
    ...(canSign
      ? {
          signtoolOptions: {
            sign: signWithTrustedSigning,
            // Trusted Signing is SHA256-only. Without this electron-builder
            // defaults to ['sha1', 'sha256'] for .exe files and calls the sign
            // hook once per algorithm, signing everything twice.
            signingHashAlgorithms: ['sha256'],
            publisherName: PUBLISHER_NAME,
          },
        }
      : {}),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Apex AIO System',
  },
};
