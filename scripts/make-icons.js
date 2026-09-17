/**
 * scripts/make-icons.js — regenerate app icons from the Apex AIO icon master.
 * -----------------------------------------------------------------------------
 * One-off tool (npm run icons). Outputs are committed so normal builds don't
 * need sharp installed:
 *   build/icon.png                          512×512 (electron-builder source)
 *   build/icon.ico                          multi-size Windows icon
 *   electron/control-panel/assets/icon.png  256×256 (BrowserWindow icon)
 *
 * The source is build/icon-master.png — the 1024px square icon straight out of
 * the Apex AIO logo pack — rather than the lockup SVG this used to rasterise.
 * Two reasons: the lockup is ~4:1 and a square app icon cut from it is either
 * squashed or mostly empty, and the pack's own square export already carries
 * the optical padding a Windows icon wants. The SVG masters live beside the
 * panel (assets/apex-aio-*.svg) and remain the source for everything that
 * scales.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const pngToIcoModule = require('png-to-ico');
const pngToIco = pngToIcoModule.default || pngToIcoModule;

const ROOT = path.join(__dirname, '..');
const MASTER = path.join(ROOT, 'build', 'icon-master.png');

async function main() {
  if (!fs.existsSync(MASTER)) {
    throw new Error(`missing icon master: ${path.relative(ROOT, MASTER)}`);
  }
  const master = fs.readFileSync(MASTER);

  // `fit: contain` on a transparent background: the master is square already,
  // and this makes a future non-square master pad rather than crop the mark.
  const square = (src, size) =>
    sharp(src)
      .resize(size, size, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png({ compressionLevel: 9 })
      .toBuffer();

  const png512 = await square(master, 512);
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), png512);

  const png256 = await square(master, 256);
  fs.writeFileSync(
    path.join(ROOT, 'electron', 'control-panel', 'assets', 'icon.png'),
    png256,
  );

  // ICO with the sizes Windows actually uses (Explorer, taskbar, alt-tab).
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = await Promise.all(sizes.map((s) => square(master, s)));
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), await pngToIco(pngs));

  console.log('icons written: build/icon.png, build/icon.ico, electron/control-panel/assets/icon.png');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
