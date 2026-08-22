/**
 * scripts/probe-lmu-team.js — what LMU publishes about a TEAM entry, live.
 * -----------------------------------------------------------------------------
 * Driver-swap events break every assumption the track-limits block was built on,
 * because they break the one it never states: that the car we care about is the
 * car being driven on this PC. During a teammate's stint no standings row has
 * `player: true` at all, so `playerCar` is `undefined`, the block is dropped, and
 * the tracker behind it is reset — the panel goes blank and then restarts from a
 * clean sheet when the driver swaps back in.
 *
 * Fixing that needs an answer to one question: **which car is ours when we are
 * not driving it?** This probe enumerates every source that could answer it, so
 * the fix joins on something the sim actually publishes rather than on a guess.
 *
 * It prints, in order:
 *
 *   1. `GetGameState` — `teamVehicleState` / `inControlOfVehicle`, the sim's own
 *      statement that this is a team entry and someone else is at the wheel.
 *   2. `/rest/multiplayer/teams` — the `teams` map, which carries a `carNumber`
 *      per team. That number is stable across swaps and joins straight onto a
 *      standings row, so it identifies the car without needing the driver.
 *   3. The standings row for that car, including its per-car `penalties`.
 *   4. Printable strings in the Scoring buffer's `ScoringInfo` header, which is
 *      where rF2 keeps `mPlayerName` / `mPlrFileName`. If our own profile name
 *      is in there it identifies us with no latch and no prior stint, which is
 *      the one case a latch cannot cover: the app being started mid-stint.
 *
 * Nothing here writes anything, to the game or to disk.
 *
 * Usage — with Le Mans Ultimate in a session (ideally a team event):
 *   node scripts/probe-lmu-team.js
 */

'use strict';

const http = require('node:http');

const PORT = Number(process.env.APEX_LMU_PORT || 6397);

/* -------------------------------------------------------------------------- */
/*  REST                                                                       */
/* -------------------------------------------------------------------------- */

function getJson(path, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ err: `HTTP ${res.statusCode}` });
        try {
          resolve({ json: JSON.parse(body) });
        } catch (e) {
          resolve({ err: 'unparseable: ' + e.message });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ err: 'timeout' });
    });
    req.on('error', (e) => resolve({ err: e.code || e.message }));
  });
}

/* -------------------------------------------------------------------------- */
/*  Shared memory                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Read the head of the Scoring buffer, or `null` when it is not published.
 * Same mapping dance as scripts/probe-lmu-scoring.js — see that file for why
 * the size comes from VirtualQuery rather than from a constant.
 */
function readScoringHead(bytes) {
  return readMmf('$rFactor2SMMP_Scoring$', bytes);
}

/** Map a shared-memory buffer read-only and copy out its first `bytes` bytes. */
function readMmf(name, bytes) {
  if (process.platform !== 'win32') return null;
  let koffi;
  try {
    koffi = require('koffi');
  } catch {
    return null;
  }
  const k32 = koffi.load('kernel32.dll');
  const OpenFileMappingW = k32.func('void* __stdcall OpenFileMappingW(uint32, bool, str16)');
  const MapViewOfFile = k32.func(
    'void* __stdcall MapViewOfFile(void*, uint32, uint32, uint32, size_t)',
  );
  const UnmapViewOfFile = k32.func('bool __stdcall UnmapViewOfFile(void*)');
  const CloseHandle = k32.func('bool __stdcall CloseHandle(void*)');
  const VirtualQuery = k32.func('size_t __stdcall VirtualQuery(void*, void*, size_t)');

  const handle = OpenFileMappingW(0x0004, false, name);
  if (!handle) return null;
  const view = MapViewOfFile(handle, 0x0004, 0, 0, 0);
  if (!view) {
    CloseHandle(handle);
    return null;
  }
  const mbi = Buffer.alloc(48);
  VirtualQuery(view, mbi, 48);
  const size = Number(mbi.readBigUInt64LE(24));
  const want = Math.min(bytes, size);
  const buf = Buffer.from(koffi.decode(view, 0, koffi.array('uint8', want)));
  UnmapViewOfFile(view);
  CloseHandle(handle);
  return buf;
}

/** Every run of >= 4 printable bytes in `buf`, as `[offset, text]`. */
function strings(buf, limit) {
  const out = [];
  let start = -1;
  for (let i = 0; i < Math.min(limit, buf.length); i++) {
    const c = buf[i];
    if (c >= 0x20 && c <= 0x7e) {
      if (start < 0) start = i;
    } else {
      if (start >= 0 && i - start >= 4) out.push([start, buf.toString('latin1', start, i)]);
      start = -1;
    }
  }
  return out;
}

/** Map the Telemetry buffer and return its bytes plus a record count. */
function readTelemetry() {
  const buf = readMmf('$rFactor2SMMP_Telemetry$', 16 + 128 * 1888);
  if (!buf) return null;
  // The header's own count undercounts LMU's buffer, so bound by what fits.
  const count = Math.min(128, Math.floor((buf.length - 16) / 1888));
  return { buf, count };
}

/** Our car's slot id, filled in by section 3 so section 5 can look it up. */
let teamCarSlot = null;

/**
 * The local player's name from the Scoring header (`mPlayerName`, char[32] at
 * ScoringInfo +116, i.e. absolute 128). Read up front because sections 2 and 3
 * both need it to pick our entry out of the rosters — it is the only identity
 * that survives not being in the car.
 */
const PLAYER_NAME = (() => {
  const head = readScoringHead(256);
  if (!head) return '';
  return head.toString('latin1', 128, 160).split('\0')[0].trim();
})();

/* -------------------------------------------------------------------------- */

(async () => {
  console.log(`\n=== 1) GetGameState — is this a team entry, and who is driving? ===`);
  const gs = await getJson('/rest/sessions/GetGameState');
  if (gs.err) {
    console.log('  unavailable:', gs.err);
  } else {
    for (const k of [
      'teamVehicleState',
      'inControlOfVehicle',
      'inMonitor',
      'MultiStintState',
      'playerVehicleLoaded',
      'gamePhase',
    ]) {
      console.log('  ' + k.padEnd(22), JSON.stringify(gs.json[k]));
    }
  }

  console.log('  local player (shared memory):', JSON.stringify(PLAYER_NAME) || '(unreadable)');

  console.log(`\n=== 2) /rest/multiplayer/teams — teams, their carNumber, their drivers ===`);
  const teams = await getJson('/rest/multiplayer/teams');
  let teamRows = [];
  if (teams.err) {
    console.log('  unavailable:', teams.err, '(single-player, or no team server)');
  } else {
    const map = teams.json.teams || {};
    teamRows = Object.entries(map).map(([utid, t]) => ({
      utid,
      carNumber: String(t.carNumber ?? ''),
      name: t.name,
      vehicle: t.vehicle,
      drivers: Object.keys(t.drivers || {}),
    }));
    console.log(`  ${teamRows.length} teams; ${Object.keys(teams.json.drivers || {}).length} drivers`);
    console.log('  utid    #car  team                                drivers');
    for (const t of teamRows.slice(0, 40)) {
      console.log(
        '  ' +
          t.utid.padEnd(7) +
          t.carNumber.padStart(4) +
          '  ' +
          String(t.name).slice(0, 34).padEnd(35) +
          t.drivers.join(', '),
      );
    }
    const multi = teamRows.filter((t) => t.drivers.length > 1).length;
    console.log(`  -> ${multi} of ${teamRows.length} teams have more than one driver.`);
  }

  console.log(`\n=== 3) Standings — is any row the player's, and what does each carry? ===`);
  const st = await getJson('/rest/watch/standings');
  if (st.err) {
    console.log('  unavailable:', st.err);
  } else {
    const cars = st.json;
    const me = cars.find((c) => c.player);
    const focus = cars.find((c) => c.hasFocus || c.focus);
    console.log('  cars:', cars.length);
    console.log(
      '  player row:',
      me
        ? `slot ${me.slotID} #${me.carNumber} ${me.driverName} (${me.fullTeamName}) penalties=${me.penalties}`
        : 'NONE — nobody is driving on this PC (spectating / teammate at the wheel)',
    );
    console.log(
      '  focus row: ',
      focus ? `slot ${focus.slotID} #${focus.carNumber} ${focus.driverName}` : 'none',
    );
    // Our car: the player row when driving, else the team's carNumber, else focus.
    const myTeam = teamRows.find((t) => t.drivers.some((d) => d === PLAYER_NAME));
    const mine =
      me ?? (myTeam ? cars.find((c) => String(c.carNumber ?? '') === myTeam.carNumber) : undefined);
    if (mine) {
      teamCarSlot = mine.slotID;
      console.log(
        `  OUR car:    slot ${mine.slotID} #${mine.carNumber} ${mine.driverName}` +
          ` (${myTeam ? myTeam.name : mine.fullTeamName}) penalties=${mine.penalties}`,
      );
    } else {
      console.log('  OUR car:    could not identify (no player row, no team match)');
    }
    // The join the fix depends on: team carNumber -> standings row.
    if (teamRows.length) {
      const byNumber = new Map(cars.map((c) => [String(c.carNumber ?? ''), c]));
      const joined = teamRows.filter((t) => byNumber.has(t.carNumber)).length;
      console.log(
        `  carNumber join: ${joined}/${teamRows.length} teams match a standings row` +
          (joined === teamRows.length ? '  <- usable as the car identity' : '  <- INCOMPLETE'),
      );
    }
    const withPen = cars.filter((c) => typeof c.penalties === 'number' && c.penalties > 0);
    console.log(
      '  cars with penalties > 0:',
      withPen.length
        ? withPen.map((c) => `#${c.carNumber} ${c.driverName}=${c.penalties}`).join(', ')
        : 'none right now',
    );
  }

  console.log(`\n=== 4) Scoring buffer ScoringInfo header — does it name the local player? ===`);
  const head = readScoringHead(2048);
  if (!head) {
    console.log('  Scoring buffer not published (game not running, or plugin missing).');
  } else {
    // The vehicle array starts at 12 + 548; anything before that is ScoringInfo.
    const found = strings(head, 12 + 548);
    if (!found.length) console.log('  no printable strings in the header.');
    for (const [off, s] of found) console.log('  +' + String(off).padStart(4), JSON.stringify(s));
    console.log(
      '  -> if one of these is your own profile name, it identifies our entry with\n' +
        '     no latch and no prior stint, which is the case a latch cannot cover.',
    );
  }
  console.log(`\n=== 5) Telemetry buffer — is TYRE WEAR published for our team car? ===`);
  // The app's tyre wear comes from /rest/garage/UIScreen/RepairAndRefuel, which
  // 404s while spectating (see above) — so a Race Engineer watching a teammate
  // gets no wear at all. LMU's own MFD shows it for your registered car, so the
  // question is whether the data reaches this PC by another road. Shared memory
  // is the candidate: the telemetry buffer carries a record per car.
  //
  // rF2Wheel: wheel array at +848, 260 bytes per wheel, wear at wheel-start +152
  // (all three verified in src/telemetry/lmuLocalCar.ts). Wear is 1.0 fresh and
  // falls toward 0.
  const telem = readTelemetry();
  if (!telem) {
    console.log('  Telemetry buffer not published.');
  } else {
    const target = teamCarSlot;
    const rows = [];
    for (let i = 0; i < telem.count; i++) {
      const off = 16 + i * 1888;
      if (off + 1888 > telem.buf.length) break;
      const id = telem.buf.readInt32LE(off);
      const wear = [0, 1, 2, 3].map((w) => telem.buf.readDoubleLE(off + 848 + w * 260 + 152));
      const ok = wear.every((v) => Number.isFinite(v) && v >= 0 && v <= 1);
      rows.push({ id, wear, ok, moved: wear.some((v) => v > 0 && v < 0.999) });
    }
    const mine = rows.find((r) => r.id === target);
    console.log(`  records: ${rows.length}; plausible wear (0..1) on ${rows.filter((r) => r.ok).length}`);
    console.log(`  showing partial wear (actually being consumed): ${rows.filter((r) => r.moved).length}`);
    if (mine) {
      console.log(
        `  OUR CAR slot ${target}: ` +
          mine.wear.map((v) => (Number.isFinite(v) ? v.toFixed(4) : 'NaN')).join('  ') +
          (mine.moved ? '   <- REAL WEAR, usable while spectating' : '   <- flat/unpopulated'),
      );
    } else if (target === null) {
      console.log('  our car not identified above, so nothing to look up.');
    } else {
      console.log(`  no telemetry record for slot ${target}.`);
    }
    const others = rows.filter((r) => r.id !== target && r.moved).slice(0, 5);
    console.log(
      '  other cars showing real wear: ' +
        (others.length ? others.map((r) => `slot ${r.id}`).join(', ') : 'none') +
        (others.length ? '  <- wear is published field-wide' : '  <- wear is NOT a field-wide channel'),
    );
  }
  console.log('');
})();
