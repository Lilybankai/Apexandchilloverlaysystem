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
 * Given an optional `pit` block it also prices every remaining stop, which is
 * what turns "will I make it" into "what does making it cost". A fuel target is
 * not a decision until it has a number of seconds next to it: dropping a stop
 * saves whatever that stop was going to cost, and the pit box's refuelling rate
 * is now measured rather than guessed, so that figure is worth trusting. The
 * costs stay OUT of the fuel arithmetic — a wrong rig rate must never change
 * how much fuel the car needs, only how long it takes to put in.
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
  /**
   * Price one stop: the lane, plus the fuel going in, plus tyres if they are
   * due. LMU services sequentially, so these ADD — the same rule fuel-strategy.js
   * encodes for a race planned from the grid.
   */
  function stopCost(pit, fill, stopNumber) {
    if (!pit || !Number.isFinite(pit.pitLaneLossSec) || !Number.isFinite(pit.refuelRatePerSec)) {
      return null;
    }
    const refuelSec = pit.refuelRatePerSec > 0 ? fill / pit.refuelRatePerSec : 0;
    const every = pit.tyresEveryStints == null ? 1 : pit.tyresEveryStints;
    const tyreSec = every > 0 && stopNumber % every === 0 ? (pit.tyreChangeSec || 0) : 0;
    return {
      laneSec: round1(pit.pitLaneLossSec),
      refuelSec: round1(refuelSec),
      tyreSec: round1(tyreSec),
      totalSec: round1(pit.pitLaneLossSec + refuelSec + tyreSec),
    };
  }

  function planRemaining({ level, tank, perLap, lapsToGo, safetyLaps = 0, pit = null }) {
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
        const fill = round1(Math.min(wanted, tank));
        stints.push({
          index: i + 1,
          laps: stintLaps,
          fill,
          current: false,
          short: wanted > tank + 1e-9,
          // The stop that STARTS this stint. Null when no pit parameters were
          // supplied — an absent price is not a free stop.
          stop: stopCost(pit, fill, i),
        });
        remaining -= stintLaps;
      }
    }

    // Pit window in laps from now: you must not run dry (latest), and you must
    // have driven far enough that what remains fits in the stops you have left
    // (earliest a stop actually works).
    const windowLatest = Math.min(lapsInTank, laps);
    const windowEarliest = stops === 0 ? null : Math.max(0, laps - stops * maxLapsFull);

    // What the remaining stops cost, all in. Null rather than 0 when the pit
    // parameters were not supplied: "unpriced" and "free" must not look alike.
    const priced = stints.filter((s) => s.stop);
    const totalStopSec = priced.length === stops && stops > 0
      ? round1(priced.reduce((sum, s) => sum + s.stop.totalSec, 0))
      : (stops === 0 ? 0 : null);

    // Save target: per-lap consumption that makes it one stop fewer. With one
    // stop, that means no more stops at all.
    let saveTarget = null;
    if (stops >= 1) {
      const available = level + (stops - 1) * tank;
      const target = available / (laps + safety);
      if (target < perLap) {
        const savingPct = ((perLap - target) / perLap) * 100;
        // A saving is only worth making if it buys something. The stop it
        // removes is the LAST one, so that is the one whose price it saves.
        const dropped = priced.length === stops ? priced[priced.length - 1] : null;
        saveTarget = {
          perLap: round2(target),
          stops: stops - 1,
          savingPct: round1(savingPct),
          feasible: savingPct <= MAX_REALISTIC_SAVING_PCT,
          savesSec: dropped ? dropped.stop.totalSec : null,
        };
      }
    }

    // Push ceiling: what per-lap you could afford by accepting one more stop.
    const pushCeiling = round2((level + (stops + 1) * tank - safetyUnits) / laps);
    // …and what that extra stop would cost. A brimming stop is the honest
    // worst case: an extra stop taken to go faster is not a splash.
    const extra = stopCost(pit, tank, stops + 1);
    const pushCostSec = extra ? extra.totalSec : null;

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
      totalStopSec,
      pushCostSec,
      // Where the numbers pricing those stops came from, straight through from
      // fuel-strategy.js's resolver, so the page can label them the same way.
      pitProvenance: (pit && pit.provenance) || null,
    };
  }

  return { planRemaining, MAX_REALISTIC_SAVING_PCT };
});
