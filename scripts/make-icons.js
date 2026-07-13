/**
 * scripts/make-icons.js — regenerate app icons from the ApexChill logo SVG.
 * -----------------------------------------------------------------------------
 * One-off tool (npm run icons). Outputs are committed so normal builds don't
 * need sharp installed:
 *   build/icon.png                          512×512 (electron-builder source)
 *   build/icon.ico                          multi-size Windows icon
 *   electron/control-panel/assets/icon.png  256×256 (BrowserWindow icon)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const pngToIcoModule = require('png-to-ico');
const pngToIco = pngToIcoModule.default || pngToIcoModule;

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'electron', 'control-panel', 'assets', 'logo.svg');

async function main() {
  const svg = fs.readFileSync(SVG);

  const png512 = await sharp(svg, { density: 300 }).resize(512, 512).png().toBuffer();
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), png512);

  const png256 = await sharp(png512).resize(256, 256).png().toBuffer();
  fs.writeFileSync(
    path.join(ROOT, 'electron', 'control-panel', 'assets', 'icon.png'),
    png256,
  );

  // ICO with the sizes Windows actually uses (Explorer, taskbar, alt-tab).
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = await Promise.all(
    sizes.map((s) => sharp(png512).resize(s, s).png().toBuffer()),
  );
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), await pngToIco(pngs));

  console.log('icons written: build/icon.png, build/icon.ico, electron/control-panel/assets/icon.png');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
