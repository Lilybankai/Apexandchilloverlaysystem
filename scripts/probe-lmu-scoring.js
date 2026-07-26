/**
 * scripts/probe-lmu-scoring.js — verify the LMU Scoring buffer's layout live.
 * -----------------------------------------------------------------------------
 * `src/telemetry/lmuScoring.ts` reads three channels the REST API does not
 * publish — `mPathLateral`, `mTrackEdge` and `mNumPenalties` — out of the
 * shared-memory Scoring buffer at hard-coded offsets. Those offsets are
 * version-sensitive: LMU already ships a *telemetry* record a different size
 * from stock rF2's, so an update moving the scoring one is entirely possible.
 *
 * This is the tool that pins them. It does two things a single field read
 * cannot:
 *
 *   1. **Derives the record stride from the data**, by finding the driver-name
 *      strings and measuring how often they recur. If that comes back as
 *      anything other than 584, the layout has moved and `VS.stride` is wrong.
 *   2. **Decodes the whole field at once.** Thirty-seven cars whose names,
 *      classes, lap counts and places all line up with what the game is showing
 *      is overwhelming evidence the offsets are right; one plausible-looking
 *      number is not.
 *
 * The two lateral columns are the ones to eyeball: `pathLat` and `trkEdge`
 * should carry the SAME SIGN on every row (that is what makes the track-limits
 * test a comparison of magnitudes), and any car sitting in its garage should
 * read a |pathLat| well beyond its |trkEdge|.
 *
 * Usage — with Le Mans Ultimate running, in a session or a replay:
 *   node scripts/probe-lmu-scoring.js
 *   node scripts/probe-lmu-scoring.js --stride     (stride evidence only)
 */

'use strict';

const FILE_MAP_READ = 0x0004;
const MMF = '$rFactor2SMMP_Scoring$';

/** Offsets this probe is checking — kept in step with src/telemetry/lmuScoring.ts. */
const SI = { base: 12, mTrackName: 0, mSession: 64, mLapDist: 88, mNumVehicles: 104, sizeof: 548 };
const VS = {
  stride: 584,
  mID: 0,
  mDriverName: 4,
  mTotalLaps: 100,
  mLapDist: 104,
  mPathLateral: 112,
  mTrackEdge: 120,
  mNumPitstops: 192,
  mNumPenalties: 194,
  mIsPlayer: 196,
  mInPits: 198,
  mPlace: 199,
  mVehicleClass: 200,
  mPitState: 457,
  mFlag: 504,
  mInGarageStall: 507,
};

let koffi;
try {
  koffi = require('koffi');
} catch {
  console.error('koffi is not installed — run `npm install` first.');
  process.exit(1);
}
if (process.platform !== 'win32') {
  console.error('Shared memory is Windows-only; nothing to probe here.');
  process.exit(1);
}

const k32 = koffi.load('kernel32.dll');
const OpenFileMappingW = k32.func('void* __stdcall OpenFileMappingW(uint32, bool, str16)');
const MapViewOfFile = k32.func(
  'void* __stdcall MapViewOfFile(void*, uint32, uint32, uint32, size_t)',
);
const UnmapViewOfFile = k32.func('bool __stdcall UnmapViewOfFile(void*)');
const CloseHandle = k32.func('bool __stdcall CloseHandle(void*)');
const VirtualQuery = k32.func('size_t __stdcall VirtualQuery(void*, void*, size_t)');

const handle = OpenFileMappingW(FILE_MAP_READ, false, MMF);
if (!handle) {
  console.error(
    `${MMF} is not published.\n` +
      'Start Le Mans Ultimate (or rFactor 2) with the rF2 Shared Memory Map\n' +
      'plugin installed and enabled, then run this again.',
  );
  process.exit(1);
}
const view = MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
if (!view) {
  CloseHandle(handle);
  console.error('MapViewOfFile failed.');
  process.exit(1);
}
const mbi = Buffer.alloc(48);
VirtualQuery(view, mbi, 48);
const size = Number(mbi.readBigUInt64LE(24));
const buf = Buffer.from(koffi.decode(view, 0, koffi.array('uint8', size)));
UnmapViewOfFile(view);
CloseHandle(handle);

const str = (off, len) => buf.slice(off, off + len).toString('latin1').split('\0')[0];

console.log(`\n${MMF}  —  mapped region ${size} bytes`);
console.log(
  `version pair ${buf.readUInt32LE(0)} / ${buf.readUInt32LE(4)}` +
    (buf.readUInt32LE(0) === buf.readUInt32LE(4) ? '  (consistent)' : '  (TORN — re-run)'),
);

/* ---------------------------- 1. stride evidence -------------------------- */

// Rather than measure gaps between ASCII runs — which finds the 200-byte hop
// from a record's driver name to its class name just as readily as the hop to
// the next record — score each CANDIDATE stride by how many records it lands on
// cleanly. A stride is right only if EVERY slot it implies has a plausible
// driver name at +4 and a class at +200; a wrong one falls off the pattern
// within a record or two. Strides are 4-byte aligned (ISI's pack(4)) and a
// record must be at least as long as its own last field.
const vehBase = SI.base + SI.sizeof;
const plausibleName = (off) => {
  if (off + 32 > size) return false;
  const c = buf[off];
  // Names are printable ASCII, NUL-terminated, and never start with a space.
  if (c < 0x21 || c > 0x7e) return false;
  let n = 0;
  while (n < 32 && buf[off + n] >= 0x20 && buf[off + n] < 0x7f) n++;
  return n >= 3 && n < 32 && buf[off + n] === 0;
};
const scoreStride = (s) => {
  let hits = 0;
  const slots = Math.min(64, Math.floor((size - vehBase) / s));
  for (let i = 0; i < slots; i++) {
    const o = vehBase + i * s;
    if (plausibleName(o + VS.mDriverName) && plausibleName(o + VS.mVehicleClass)) hits++;
    else break; // records are contiguous — the first miss ends the run
  }
  return hits;
};
let best = { stride: 0, hits: 0 };
for (let s = 512; s <= 704; s += 4) {
  const hits = scoreStride(s);
  if (hits > best.hits) best = { stride: s, hits };
}
console.log(
  `\nrecord stride, by fitting whole records: ${best.stride || 'n/a'}` +
    ` (${best.hits} consecutive slots decode cleanly)`,
);
if (best.stride === VS.stride) {
  console.log(`  OK — matches VS.stride in src/telemetry/lmuScoring.ts (${VS.stride}).`);
} else {
  console.log(
    `  MISMATCH — lmuScoring.ts uses ${VS.stride}. Update it to ${best.stride} and\n` +
      '  re-check every field below before trusting the reader.',
  );
}
if (process.argv.includes('--stride')) process.exit(0);

/* ------------------------------- 2. the field ----------------------------- */

const n = buf.readInt32LE(SI.base + SI.mNumVehicles);
console.log(
  `\ntrack "${str(SI.base + SI.mTrackName, 64)}"  ` +
    `session ${buf.readInt32LE(SI.base + SI.mSession)}  ` +
    `lap ${buf.readDoubleLE(SI.base + SI.mLapDist).toFixed(1)} m  ` +
    `cars ${n}`,
);
if (n <= 0) {
  console.log('\nNo cars in the buffer — load a session or a replay and re-run.\n');
  process.exit(0);
}

const base = SI.base + SI.sizeof;
console.log(
  '\nidx   id  driver                class      lap  pos   pathLat  trkEdge  sign  pen  pit  gar',
);
let signMismatches = 0;
for (let i = 0; i < Math.min(n, 128); i++) {
  const o = base + i * VS.stride;
  if (o + VS.stride > size) break;
  const lat = buf.readDoubleLE(o + VS.mPathLateral);
  const edge = buf.readDoubleLE(o + VS.mTrackEdge);
  const sameSign = lat === 0 || edge === 0 || lat > 0 === edge > 0;
  if (!sameSign) signMismatches++;
  console.log(
    [
      String(i).padStart(3),
      String(buf.readInt32LE(o + VS.mID)).padStart(4),
      str(o + VS.mDriverName, 32).padEnd(21).slice(0, 21),
      str(o + VS.mVehicleClass, 32).padEnd(9).slice(0, 9),
      String(buf.readInt16LE(o + VS.mTotalLaps)).padStart(4),
      String(buf.readUInt8(o + VS.mPlace)).padStart(4),
      lat.toFixed(2).padStart(9),
      edge.toFixed(2).padStart(8),
      (sameSign ? ' ok ' : 'DIFF').padStart(5),
      String(buf.readInt16LE(o + VS.mNumPenalties)).padStart(4),
      String(buf.readUInt8(o + VS.mPitState)).padStart(4),
      String(buf.readUInt8(o + VS.mInGarageStall)).padStart(4),
      buf.readUInt8(o + VS.mIsPlayer) ? '  <- player' : '',
    ].join(' '),
  );
}

console.log(
  signMismatches === 0
    ? '\nSign check: every car agrees — |pathLat| > |trkEdge| is a valid off-track test.'
    : `\nSign check: ${signMismatches} car(s) DISAGREE. The magnitude comparison in\n` +
        'telemetry/trackLimits.ts assumes matching signs — investigate before trusting it.',
);
console.log();
