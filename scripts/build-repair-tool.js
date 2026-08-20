/**
 * scripts/build-repair-tool.js — compile and sign the Apex Repair Tool.
 * -----------------------------------------------------------------------------
 * Turns tools/repair/ApexRepair.cs into a single signed `Apex-Repair-Tool.exe`
 * (in release/) that a tester double-clicks to clean up a broken install —
 * no PowerShell over Discord. See the .cs file for what it does and why.
 *
 * Compiler: the .NET Framework 4.x csc.exe that ships with every Windows
 * 10/11 install — nothing to download, and the exe it produces runs anywhere.
 *
 * Signing: reads electron-builder.env itself (the electron-builder CLI is not
 * in this loop) and signs with the same Trusted Signing profile as the app.
 * Without credentials it still builds, loudly unsigned — fine for a local
 * look, not for handing to a tester whose antivirus is the whole problem.
 *
 *   node scripts/build-repair-tool.js
 *
 * The exe is uploaded to the GitHub release by hand:
 *   gh release upload vX.Y.Z release/Apex-Repair-Tool.exe
 * (hyphenated name on purpose — `gh release upload` mangles spaces to dots.)
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'tools', 'repair', 'ApexRepair.cs');
const OUT = path.join(ROOT, 'release', 'Apex-Repair-Tool.exe');

/* ---- find the framework compiler ------------------------------------------ */

const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];
const csc = CSC_CANDIDATES.find((p) => fs.existsSync(p));
if (!csc) {
  console.error('[repair] no framework csc.exe found — is this a Windows box?');
  process.exit(1);
}

/* ---- compile --------------------------------------------------------------- */

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.rmSync(OUT, { force: true });
console.log('[repair] compiling ApexRepair.cs…');
execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${OUT}`, SOURCE], {
  stdio: 'inherit',
});

/* ---- sign ------------------------------------------------------------------ */

// electron-builder.env is loaded by the electron-builder CLI, not by node —
// read it here so this script signs standalone.
const envFile = path.join(ROOT, 'electron-builder.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const canSign = Boolean(
  process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET,
);

if (canSign) {
  console.log('[repair] signing…');
  const psQuote = (v) => `'${String(v).replace(/'/g, "''")}'`;
  const command =
    'Invoke-TrustedSigning' +
    " -Endpoint 'https://neu.codesigning.azure.net/'" +
    " -CodeSigningAccountName 'apex26'" +
    " -CertificateProfileName 'ApexAIOSystem26'" +
    ' -FileDigest SHA256' +
    " -TimestampRfc3161 'http://timestamp.acs.microsoft.com'" +
    ' -TimestampDigest SHA256' +
    ` -Files ${psQuote(OUT)}`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    stdio: 'inherit',
  });
} else {
  console.warn(
    '[repair] WARNING: no signing credentials — the tool is UNSIGNED.\n' +
      '         Do not hand an unsigned repair tool to a tester whose\n' +
      '         antivirus is the problem being repaired.',
  );
}

const mb = (fs.statSync(OUT).size / 1e6).toFixed(2);
console.log(`[repair] built ${path.relative(ROOT, OUT)} (${mb} MB, signed: ${canSign})`);
