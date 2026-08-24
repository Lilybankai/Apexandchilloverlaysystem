/**
 * team-fuel.js — the Team tab's mid-race fuel/energy re-planner.
 * -----------------------------------------------------------------------------
 * fuel-strategy.js plans a whole race from the grid, where every stint's fill
 * is yours to choose. Mid-race the first stint is NOT yours to choose — you
 * have whatever is in the tank right now — so this engine answers the pit
 * wall's question instead: **from here to the flag, what has to happen?**
 *
 * planRemaining(inputs) -> remaining-race plan (stops, stint laps and fills,
 *                          pit window, margin at the flag) or null while the
 *                          live numbers it needs are still unknown.
 *
 * Units are abstract like fuel-strategy.js: litres for LMP2/LMP3/GTE, Virtual
 * Energy percent (tank = 100) for Hypercar/LMGT3. The save/push targets reuse
 * the whole-race engine's honesty rule: a lift-and-coast saving beyond ~12%
 * is flagged unrealistic rather than presented as a plan.
 *
 * Loaded as a classic script by the panel (window.APEX_TEAM_FUEL) and
 * require()d by scripts/test-teamfuel.js — keep it dependency-free and pure.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_TEAM_FUEL = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // Beyond ~12% lift-and-coast saving is unrealistic in race conditions —
  // same ceiling fuel-strategy.js applies to its fewer-stop alternatives.
  const MAX_REALISTIC_SAVING_PCT = 12;

  const round1 = (n) => Math.round(n * 10) / 10;
  const round2 = (n) => Math.round(n * 100) / 100;

  /**
   * Plan the rest of the race from the current tank state.
   *
   * @param {object} inputs
   * @param {number} inputs.level      Units in the tank right now.
   * @param {number} inputs.tank      Tank capacity in units (100 for VE).
   * @param {number} inputs.perLap    Average consumption, units/lap.
   * @param {number} inputs.lapsToGo  Laps still to be completed to see the flag.
   * @param {number} [inputs.safetyLaps=0]  Laps of margin carried to the flag.
   * @returns {object|null} The remaining-race plan, or null while any of the
   *   live inputs is missing/absurd (the page shows "learning" rather than a
   *   plan built on a sentinel).
   */
  function planRemaining({ level, tank, perLap, lapsToGo, safetyLaps = 0 }) {
    if (![level, tank, perLap, lapsToGo].every(Number.isFinite)) return null;
    if (level < 0 || tank <= 0 || perLap <= 0 || lapsToGo <= 0) return null;
    const safety = Math.max(0, safetyLaps);

    const laps = Math.ceil(lapsToGo);
    const needUnits = laps * perLap;
    const safetyUnits = safety * perLap;
    const maxLapsFull = Math.floor(tank / perLap);
    if (maxLapsFull < 1) return null; // a full tank not covering one lap is a bad input, not a plan

    // What's left at the flag if the car never stops again. Negative = short.
    const marginNoStop = level - needUnits;

    // Stops needed: every stop may fill to the brim, so shortfall / tank.
    const stops = marginNoStop >= safetyUnits
      ? 0
      : Math.max(1, Math.ceil((needUnits + safetyUnits - level) / tank));

    // Laps the current tank still covers (to dry, not to the safety line).
    const lapsInTank = Math.floor(level / perLap);

    // Stint layout, maxFirst: run the current tank down, brim the middle
    // stints, and let the final stint carry the safety margin — mirroring
    // fuel-strategy.js so the two tabs never argue about shape.
    const stints = [];
    if (stops === 0) {
      stints.push({ index: 1, laps, fill: null, current: true });
    } else {
      const firstLaps = Math.min(lapsInTank, laps);
      stints.push({ index: 1, laps: firstLaps, fill: null, current: true });
      let remaining = laps - firstLaps;
      for (let i = 1; i <= stops; i++) {
        const isLast = i === stops;
        // Middle stints brim; the final stint takes what's left (which can
        // exceed maxLapsFull only through rounding — the fill cap below and
        // the shortfall flag keep that honest).
        const stintLaps = isLast ? remaining : Math.min(maxLapsFull, remaining - (stops - i));
        const wanted = stintLaps * perLap + (isLast ? safetyUnits : 0);
        stints.push({
          index: i + 1,
          laps: stintLaps,
          fill: round1(Math.min(wanted, tank)),
          current: false,
          short: wanted > tank + 1e-9,
        });
        remaining -= stintLaps;
      }
    }

    // Pit window in laps from now: you must not run dry (latest), and you must
    // have driven far enough that what remains fits in the stops you have left
    // (earliest a stop actually works).
    const windowLatest = Math.min(lapsInTank, laps);
    const windowEarliest = stops === 0 ? null : Math.max(0, laps - stops * maxLapsFull);

    // Save target: per-lap consumption that makes it one stop fewer. With one
    // stop, that means no more stops at all.
    let saveTarget = null;
    if (stops >= 1) {
      const available = level + (stops - 1) * tank;
      const target = available / (laps + safety);
      if (target < perLap) {
        const savingPct = ((perLap - target) / perLap) * 100;
        saveTarget = {
          perLap: round2(target),
          stops: stops - 1,
          savingPct: round1(savingPct),
          feasible: savingPct <= MAX_REALISTIC_SAVING_PCT,
        };
      }
    }

    // Push ceiling: what per-lap you could afford by accepting one more stop.
    const pushCeiling = round2((level + (stops + 1) * tank - safetyUnits) / laps);

    return {
      lapsToGo: laps,
      perLap: round2(perLap),
      stops,
      lapsInTank,
      maxLapsFull,
      needUnits: round1(needUnits),
      safetyUnits: round1(safetyUnits),
      marginNoStop: round1(marginNoStop),
      windowEarliest,
      windowLatest,
      stints,
      saveTarget,
      pushCeiling,
    };
  }

  return { planRemaining, MAX_REALISTIC_SAVING_PCT };
});
