/**
 * scripts/make-installer-art.js — the NSIS installer's brand artwork.
 * -----------------------------------------------------------------------------
 * One-off tool (npm run installer:art). Outputs are committed so a normal
 * release build needs neither sharp nor this script:
 *   build/installerSidebar.bmp    164×314  welcome + finish pages
 *   build/uninstallerSidebar.bmp  164×314  the same, on the way out
 *   build/installerHeader.bmp     150×57   the strip on every inner page
 *
 * BMP, and written by hand, because that is the only format NSIS takes for
 * these slots and sharp can neither read nor write it. The encoder below is
 * the plain 24-bit BI_RGB form — no palette, no compression, no colour
 * profile — which is what NSIS has understood since forever and what
 * electron-builder's own stock images are.
 *
 * Two details a BMP gets wrong if you write one from memory: the rows run
 * BOTTOM-UP, and each row is padded to a 4-byte boundary. Both are handled in
 * `encodeBmp`, and `decodeBmpHeader` reads the result back so a silent
 * mistake here fails the script rather than the installer.
 *
 * The art itself is deliberately quiet. This is a window someone clicks
 * through in four seconds, so it is the mark on the brand navy with a single
 * gradient rule — not a poster.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'electron', 'control-panel', 'assets');

/** Core palette, from the logo pack's START-HERE. */
const NAVY = { r: 0x07, g: 0x0d, b: 0x16 };
const CYAN = [0x00, 0xc8, 0xef];
const VIOLET = [0x8b, 0x2c, 0xf5];

/* -------------------------------------------------------------------------- */
/*  BMP                                                                       */
/* -------------------------------------------------------------------------- */

/** Raw RGBA (top-down, no premultiply) → a 24-bit BI_RGB .bmp buffer. */
function encodeBmp(rgba, width, height) {
  const rowBytes = width * 3;
  const pad = (4 - (rowBytes % 4)) % 4;
  const stride = rowBytes + pad;
  const pixels = Buffer.alloc(stride * height); // zero-filled, so padding is 0

  for (let y = 0; y < height; y++) {
    // BMP rows run bottom-up: the last source row is written first.
    const src = (height - 1 - y) * width * 4;
    const dst = y * stride;
    for (let x = 0; x < width; x++) {
      const s = src + x * 4;
      const d = dst + x * 3;
      pixels[d] = rgba[s + 2]; // B
      pixels[d + 1] = rgba[s + 1]; // G
      pixels[d + 2] = rgba[s]; // R
    }
  }

  const FILE_HEADER = 14;
  const INFO_HEADER = 40;
  const header = Buffer.alloc(FILE_HEADER + INFO_HEADER);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(header.length + pixels.length, 2); // file size
  header.writeUInt32LE(header.length, 10); // pixel data offset
  header.writeUInt32LE(INFO_HEADER, 14); // BITMAPINFOHEADER
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22); // positive = bottom-up
  header.writeUInt16LE(1, 26); // planes
  header.writeUInt16LE(24, 28); // bits per pixel
  header.writeUInt32LE(0, 30); // BI_RGB, uncompressed
  header.writeUInt32LE(pixels.length, 34);
  header.writeInt32LE(2835, 38); // 72 dpi, in pixels/metre
  header.writeInt32LE(2835, 42);

  return Buffer.concat([header, pixels]);
}

/** Read our own output back, so a malformed file never reaches a release. */
function decodeBmpHeader(buf) {
  if (buf.toString('ascii', 0, 2) !== 'BM') throw new Error('not a BMP');
  const offset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const height = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  const stride = Math.ceil((width * bpp) / 32) * 4;
  return { offset, width, height, bpp, compression, expected: offset + stride * height };
}

/* -------------------------------------------------------------------------- */
/*  The images                                                                */
/* -------------------------------------------------------------------------- */

/** A flat navy panel with the brand gradient as a rule along one edge. */
function background(width, height, ruleAt) {
  const px = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      px[i] = NAVY.r;
      px[i + 1] = NAVY.g;
      px[i + 2] = NAVY.b;
      px[i + 3] = 255;
    }
  }
  // The one piece of pure brand: a 3px cyan→violet rule, left to right.
  for (let y = ruleAt; y < ruleAt + 3 && y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = width === 1 ? 0 : x / (width - 1);
      const i = (y * width + x) * 4;
      px[i] = Math.round(CYAN[0] + (VIOLET[0] - CYAN[0]) * t);
      px[i + 1] = Math.round(CYAN[1] + (VIOLET[1] - CYAN[1]) * t);
      px[i + 2] = Math.round(CYAN[2] + (VIOLET[2] - CYAN[2]) * t);
      px[i + 3] = 255;
    }
  }
  return px;
}

async function compose({ width, height, svg, artWidth, top, ruleAt, out }) {
  const art = await sharp(fs.readFileSync(path.join(ASSETS, svg)), { density: 600 })
    .resize({ width: artWidth, fit: 'inside' })
    .png()
    .toBuffer();
  const artMeta = await sharp(art).metadata();

  const base = await sharp(background(width, height, ruleAt), {
    raw: { width, height, channels: 4 },
  })
    .composite([
      {
        input: art,
        left: Math.round((width - artMeta.width) / 2),
        top: top === 'centre' ? Math.round((height - artMeta.height) / 2) : top,
      },
    ])
    .raw()
    .toBuffer();

  const bmp = encodeBmp(base, width, height);
  const head = decodeBmpHeader(bmp);
  if (head.width !== width || head.height !== height || head.bpp !== 24) {
    throw new Error(`bad BMP header for ${out}: ${JSON.stringify(head)}`);
  }
  if (head.expected !== bmp.length) {
    throw new Error(`bad BMP length for ${out}: ${bmp.length} vs ${head.expected}`);
  }

  fs.writeFileSync(path.join(ROOT, 'build', out), bmp);
  console.log(`  ${out}  ${width}×${height}  ${(bmp.length / 1024).toFixed(1)} kB`);
}

async function main() {
  // 164×314 and 150×57 are not choices: NSIS scales anything else, badly.
  await compose({
    width: 164,
    height: 314,
    svg: 'apex-aio-stacked.svg',
    artWidth: 120,
    top: 'centre',
    ruleAt: 292,
    out: 'installerSidebar.bmp',
  });
  fs.copyFileSync(
    path.join(ROOT, 'build', 'installerSidebar.bmp'),
    path.join(ROOT, 'build', 'uninstallerSidebar.bmp'),
  );
  console.log('  uninstallerSidebar.bmp  (copy)');

  await compose({
    width: 150,
    height: 57,
    svg: 'apex-aio-lockup.svg',
    artWidth: 118,
    top: 'centre',
    ruleAt: 54,
    out: 'installerHeader.bmp',
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
