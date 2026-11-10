/**
 * Cuts a small, committed test fixture out of an iRacing capture made by the
 * irsdk probe (frames.ndjson + session-<n>.yaml), for scripts/test-iracing.js.
 *
 *   node scripts/make-iracing-fixture.js <captureDir> <outDir> [windows]
 *
 * `windows` is `from-to/stride,...` over 1-based frame numbers (default: the
 * windows that cover ir-cap1's practice traffic, the player's qualifying laps
 * and the race). Personal data is stripped (see anonymise). Only the variables
 * the provider reads are kept, the frames
 * and the session-info revisions they reference are gzipped, and index.json
 * records when each revision was written so CaptureSource can line them up.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const [captureDir, outDir, windowsArg] = process.argv.slice(2);
if (!captureDir || !outDir) {
  console.error('usage: node scripts/make-iracing-fixture.js <captureDir> <outDir> [from-to/stride,...]');
  process.exit(2);
}
const windows = (windowsArg ||
  '1-60/1,1150-1320/1,2380-2460/1,3080-3120/1,4000-4100/1,4200-4240/1,5600-8520/3,9900-13600/3')
  .split(',')
  .map((w) => {
    const m = /^(\d+)-(\d+)\/(\d+)$/.exec(w.trim());
    if (!m) throw new Error(`bad window ${w}`);
    return { from: +m[1], to: +m[2], stride: +m[3] };
  });

const KEEP = new Set([
  '_t', '_tick', '_status',
  'SessionNum', 'SessionUniqueID', 'SessionState', 'SessionFlags', 'SessionTime', 'SessionTimeRemain',
  'SessionLapsRemainEx', 'PlayerCarIdx', 'CamCarIdx', 'IsOnTrack', 'IsReplayPlaying', 'ReplayFrameNumEnd',
  'CarIdxPosition', 'CarIdxClassPosition', 'CarIdxLapCompleted', 'CarIdxLapDistPct', 'CarIdxTrackSurface',
  'CarIdxOnPitRoad', 'CarIdxBestLapTime', 'CarIdxLastLapTime', 'CarIdxF2Time', 'CarIdxEstTime',
  'CarIdxGear', 'CarIdxRPM',
  'TrackTempCrew', 'TrackTemp', 'AirTemp', 'Precipitation', 'TrackWetness', 'Skies', 'RelativeHumidity',
  'WindVel', 'FuelLevel', 'OnPitRoad', 'PlayerCarInPitStall', 'PlayerTrackSurface', 'LapCompleted',
  'LapDistPct', 'Speed', 'LapBestLapTime', 'LapLastLapTime', 'LapCurrentLapTime', 'LapDeltaToBestLap',
  'LapDeltaToBestLap_OK', 'Gear', 'RPM', 'VelocityX', 'VelocityY', 'Yaw', 'YawNorth', 'CarLeftRight',
  'Throttle', 'Brake', 'Clutch', 'SteeringWheelAngle', 'SteeringWheelAngleMax', 'BrakeABSactive',
  'PitstopActive', 'EngineWarnings', 'PlayerCarMyIncidentCount', 'PlayerTireCompound', 'LatAccel',
  'LongAccel', 'VertAccel', 'YawRate', 'PitchRate', 'RollRate', 'Pitch', 'Roll',
  // The race engineer's race-control block (irRaceControl.ts).
  'PitsOpen', 'PlayerCarTowTime',
]);
for (const c of ['LF', 'RF', 'LR', 'RR']) {
  for (const s of ['tempCL', 'tempCM', 'tempCR', 'wearL', 'wearM', 'wearR', 'coldPressure']) KEEP.add(c + s);
}

/**
 * Strip personal data before anything is committed: a capture of an online
 * session holds other people's names, iRacing customer ids and the session
 * ids that link to the public results page. Names become `Driver <CarIdx>`,
 * ids become synthetic, and the camera/radio/setup sections (never read by the
 * provider) are dropped. Ratings and licences stay — the tests need them —
 * but are no longer attached to anyone.
 */
function anonymise(text) {
  const out = [];
  let idx = -1;
  let drop = false;
  for (const line of text.split('\n')) {
    if (/^[A-Za-z]\w*:/.test(line)) drop = /^(CameraInfo|RadioInfo|CarSetup):/.test(line);
    if (drop) continue;
    const ci = /^\s*- CarIdx: (\d+)/.exec(line);
    if (ci) idx = +ci[1];
    const m = /^(\s*(?:- )?)(\w+): ?(.*)$/.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const [, pre, key] = m;
    const set = (v) => out.push(`${pre}${key}: ${v}`);
    switch (key) {
      case 'UserName':
      case 'TeamName':
        set(`Driver ${idx}`);
        break;
      case 'AbbrevName':
        set(`${idx}, D`);
        break;
      case 'Initials':
        set(`D${idx}`);
        break;
      case 'UserID':
        set(String(100000 + Math.max(0, idx)));
        break;
      case 'TeamID':
        set('0');
        break;
      case 'DriverUserID':
        set('100000');
        break;
      case 'FlairName':
        set('Flair');
        break;
      case 'FlairID':
      case 'ClubID':
        set('0');
        break;
      case 'ClubName':
        set('None');
        break;
      case 'SessionID':
      case 'SubSessionID':
      case 'SeasonID':
      case 'SeriesID':
        set('1');
        break;
      default:
        out.push(line);
    }
  }
  return out.join('\n');
}

const revs = fs
  .readdirSync(captureDir)
  .map((f) => ({ f, m: /^session-(\d+)\.yaml$/.exec(f) }))
  .filter((x) => x.m)
  .sort((a, b) => +a.m[1] - +b.m[1])
  .map((x) => ({ f: x.f, t: fs.statSync(path.join(captureDir, x.f)).mtimeMs }));
const revAt = (t) => {
  let k = -1;
  for (let i = 0; i < revs.length; i++) if (revs[i].t <= t + 50) k = i; else break;
  return k;
};

fs.mkdirSync(outDir, { recursive: true });
const keep = (n) => windows.some((w) => n >= w.from && n <= w.to && (n - w.from) % w.stride === 0);
const out = [];
const usedRevs = new Set();
let n = 0;
const rl = readline.createInterface({ input: fs.createReadStream(path.join(captureDir, 'frames.ndjson')) });
rl.on('line', (line) => {
  n++;
  if (!keep(n)) return;
  const o = JSON.parse(line);
  const slim = {};
  for (const k of Object.keys(o)) if (KEEP.has(k)) slim[k] = o[k];
  out.push(JSON.stringify(slim));
  const k = revAt(o._t);
  if (k >= 0) usedRevs.add(k);
});
rl.on('close', () => {
  fs.writeFileSync(path.join(outDir, 'frames.ndjson.gz'), zlib.gzipSync(out.join('\n') + '\n', { level: 9 }));
  const sessions = [];
  for (const k of [...usedRevs].sort((a, b) => a - b)) {
    const r = revs[k];
    const file = r.f + '.gz';
    const text = anonymise(fs.readFileSync(path.join(captureDir, r.f), 'utf8'));
    fs.writeFileSync(path.join(outDir, file), zlib.gzipSync(text, { level: 9 }));
    sessions.push({ file, t: r.t });
  }
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ source: path.basename(captureDir), frames: out.length, sessions }, null, 1) + '\n');
  const size = fs.readdirSync(outDir).reduce((s, f) => s + fs.statSync(path.join(outDir, f)).size, 0);
  console.log(`frames ${out.length}/${n}, revisions ${sessions.length}, ${(size / 1024).toFixed(0)} KB`);
});
