/**
 * electron/team-history.js — the Team page's race memory.
 * -----------------------------------------------------------------------------
 * The snapshot (team-snapshot.js) is an instant; the Positions chart, the
 * lap-time graph and the tyre projection need the RACE — position per car per
 * lap, lap time per car per lap, our tyre wear per lap. Nobody else records
 * these (the lap log records OUR laps for the database; the engineer keeps
 * rolling windows), so this accumulator does, fed once a second from the
 * status feed in main — ALWAYS, not only while the Team tab is open, because
 * an engineer opening the page on lap 40 wants laps 1–40 on the chart.
 *
 * Everything is keyed to a session identity (track + session type + a first
 * -seen fingerprint), and a change resets the lot: carrying lap 38 of the
 * last race into lap 1 of this one draws a chart that is confidently wrong.
 *
 * Pure — no Electron, no IO, no wall clock — so scripts/test-teamhistory.js
 * drives whole races through it in milliseconds.
 */

'use strict';

/** More cars than any LMU grid; a runaway feed must not grow without bound. */
const MAX_CARS = 80;
/** Longer than any race we care about (Le Mans ~380 laps for a Hypercar). */
const MAX_LAPS = 1200;

const known = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

class TeamHistory {
  constructor() {
    // Monotonic across resets: a consumer caching "history as of revision N"
    // must never see a new session reuse N.
    this.revision = 0;
    this.reset('');
  }

  reset(sessionKey) {
    this.sessionKey = sessionKey;
    /** slotId -> {slotId, name, cls, num, isPlayer, laps: [{lap,pos,clsPos,lastSec}]} */
    this.cars = new Map();
    /** Our car's wear-by-lap: [{lap, fl, fr, rl, rr}] (fractions 0..1). */
    this.wear = [];
    this.lastWearLap = -1;
  }

  /**
   * Feed one frame. Cheap by design: one pass over standings, appending only
   * when a car's lap count moved. Call at ~1 Hz.
   */
  update(frame) {
    if (!frame || !frame.session || !Array.isArray(frame.standings)) return;
    if (frame.connected === false) return; // demo frames must never pollute a race
    const s = frame.session;
    const key = `${s.track || ''}|${s.type || ''}`;
    if (key !== this.sessionKey) {
      this.reset(key);
      if (!s.track) return; // nothing identifiable yet — stay empty
      this.revision++;
    }

    let changed = false;
    for (const row of frame.standings) {
      if (!row || !known(row.slotId) || !known(row.lapsCompleted)) continue;
      let car = this.cars.get(row.slotId);
      if (!car) {
        if (this.cars.size >= MAX_CARS) continue;
        car = {
          slotId: row.slotId,
          name: row.driverName || `#${row.slotId}`,
          cls: row.carClass || '',
          num: row.carNumber != null ? String(row.carNumber) : '',
          isPlayer: !!row.isPlayer,
          laps: [],
        };
        this.cars.set(row.slotId, car);
        changed = true;
      }
      // Identity can firm up later (roster loads, driver swap in a team car).
      if (row.driverName && row.driverName !== car.name) { car.name = row.driverName; changed = true; }
      if (row.isPlayer !== car.isPlayer) { car.isPlayer = !!row.isPlayer; changed = true; }

      const prev = car.laps.length ? car.laps[car.laps.length - 1].lap : -1;
      if (row.lapsCompleted > prev && car.laps.length < MAX_LAPS) {
        car.laps.push({
          lap: row.lapsCompleted,
          pos: known(row.position) ? row.position : null,
          clsPos: known(row.classPosition) ? row.classPosition : null,
          lastSec: known(row.lastLapSec) && row.lastLapSec > 0 ? row.lastLapSec : null,
        });
        changed = true;
      }
    }

    // Our tyre wear, one point per completed lap. Wear is the pit-menu read,
    // so it can be stale for a moment — recording it AT the lap boundary is
    // exactly the cadence a per-lap rate wants.
    const mine = frame.standings.find((r) => r && r.isPlayer);
    const tyres = frame.player && frame.player.tyres;
    if (mine && tyres && known(mine.lapsCompleted) && mine.lapsCompleted > this.lastWearLap) {
      const w = (c) => (c && known(c.wear) ? c.wear : null);
      const fl = w(tyres.frontLeft), fr = w(tyres.frontRight);
      const rl = w(tyres.rearLeft), rr = w(tyres.rearRight);
      if ([fl, fr, rl, rr].every((v) => v != null) && this.wear.length < MAX_LAPS) {
        this.wear.push({ lap: mine.lapsCompleted, fl, fr, rl, rr });
        this.lastWearLap = mine.lapsCompleted;
        changed = true;
      }
    }

    if (changed) this.revision++;
  }

  /** The whole record, for the snapshot. Arrays are shared, not copied — the
   *  caller serialises immediately (IPC does), never mutates. */
  state() {
    return {
      sessionKey: this.sessionKey,
      revision: this.revision,
      cars: Array.from(this.cars.values()),
      wear: this.wear,
    };
  }
}

/**
 * Per-corner wear rate and remaining life, from the recorded wear series.
 * Linear fit over the most recent `window` laps (default 5); returns null
 * until there are two points. Exposed here (not in the renderer) so the test
 * can pin the maths.
 *
 * @returns {{ratePerLap: {fl,fr,rl,rr}, lapsTo25: number|null, worstCorner: string}|null}
 */
function tyreProjection(wear, window = 5) {
  if (!Array.isArray(wear) || wear.length < 2) return null;
  const pts = wear.slice(-Math.max(2, window));
  const first = pts[0];
  const last = pts[pts.length - 1];
  const laps = last.lap - first.lap;
  if (laps <= 0) return null;
  const rate = {};
  for (const c of ['fl', 'fr', 'rl', 'rr']) {
    rate[c] = Math.max(0, (first[c] - last[c]) / laps); // fraction lost per lap
  }
  let worstCorner = 'fl';
  let worstLapsLeft = Infinity;
  for (const c of ['fl', 'fr', 'rl', 'rr']) {
    if (rate[c] <= 0) continue;
    const lapsLeft = (last[c] - 0.25) / rate[c]; // laps until the 25% cliff
    if (lapsLeft < worstLapsLeft) {
      worstLapsLeft = lapsLeft;
      worstCorner = c;
    }
  }
  return {
    ratePerLap: rate,
    lapsTo25: Number.isFinite(worstLapsLeft) ? Math.max(0, Math.round(worstLapsLeft)) : null,
    worstCorner,
    asOfLap: last.lap,
  };
}

module.exports = { TeamHistory, tyreProjection };
