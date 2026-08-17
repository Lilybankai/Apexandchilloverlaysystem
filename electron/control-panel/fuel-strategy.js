/**
 * fuel-strategy.js — the Fuel tab's strategy engine.
 * -----------------------------------------------------------------------------
 * Ported verbatim from the standalone LMU fuel app (src/lib/strategy.js); only
 * the module wrapper changed (ESM -> classic script + module.exports).
 *
 * buildStrategy(inputs)     -> full plan (laps, stints, stops, pit times,
 *                              warnings) or null when infeasible.
 * compareStopOptions(inputs)-> fewer/more-stop alternatives with per-lap targets.
 *
 * LMU pit rule encoded here: refuelling and tyre changes are SEQUENTIAL, so a
 * stop costs pit-lane loss + refuel + tyres. Timed races solve lap count and
 * pit time to a fixed point (pit time reduces laps run).
 *
 * Loaded as a classic script by the panel (window.APEX_FUEL_STRATEGY) and
 * require()d by scripts/test-fuelcalc.js — keep it dependency-free.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_FUEL_STRATEGY = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // Race strategy engine for Le Mans Ultimate.
  //
  // Works in abstract consumption "units": litres for LMP2/LMP3/GTE, or
  // Virtual Energy percent (tank = 100) for Hypercar/LMGT3. All functions are
  // pure so they can be unit-tested without the UI.
  //
  // LMU pit rule: refuelling and tyre changes are strictly sequential — a stop's
  // stationary time is refuel time PLUS tyre time, never the max of the two.

  const DEFAULT_PIT_PARAMS = {
    pitLaneLossSec: 25,     // time lost entering/driving/exiting the pit lane vs a flying lap
    fuelRefuelRate: 2.5,    // L/s (ACO-style rig approximation)
    energyRefuelRate: 2.0,  // %/s for Virtual Energy classes
    tyreChangeSec: 30,      // full set of tyres
    tyresEveryStints: 1,    // change tyres every N stops (0 = never)
  };

  const MAX_ITER = 20;

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  // Build the stint/stop structure for a fixed number of racing laps.
  // Returns null when the inputs cannot produce a valid plan.
  function planForLaps({
    raceLaps,
    lapTimeSec,
    consumptionPerLap,
    tankCapacity,
    formationLap,
    safetyLaps,
    pit,
    stintMode, // 'maxFirst' | 'even'
  }) {
    if (raceLaps <= 0 || consumptionPerLap <= 0 || tankCapacity <= 0 || lapTimeSec <= 0) return null;

    const maxLapsPerStint = Math.floor(tankCapacity / consumptionPerLap);
    if (maxLapsPerStint < 1) return null;

    const formationUnits = formationLap ? consumptionPerLap : 0;
    const safetyUnits = (safetyLaps || 0) * consumptionPerLap;

    // The formation lap burns from stint 1's tank, so it costs stint capacity.
    const effectiveLaps = raceLaps + (formationLap ? 1 : 0);
    const numStints = Math.ceil(effectiveLaps / maxLapsPerStint);

    // Allocate racing laps across stints.
    const stintLaps = [];
    if (stintMode === "even") {
      const base = Math.floor(raceLaps / numStints);
      const remainder = raceLaps - base * numStints;
      for (let i = 0; i < numStints; i++) {
        // Remainder laps go to the later stints; stint 1 also carries the formation lap.
        stintLaps.push(base + (i >= numStints - remainder ? 1 : 0));
      }
    } else {
      // maxFirst: fill to the brim each stop, short final stint (splash if tiny).
      let remaining = raceLaps;
      for (let i = 0; i < numStints; i++) {
        // Stint 1 loses one lap of range to the formation lap.
        const cap = i === 0 && formationLap ? maxLapsPerStint - 1 : maxLapsPerStint;
        const laps = Math.min(Math.max(cap, 1), remaining);
        stintLaps.push(laps);
        remaining -= laps;
      }
      // Rounding edge: dump anything left on the last stint (capped by validity test below).
      if (remaining > 0) stintLaps[stintLaps.length - 1] += remaining;
    }

    const stints = [];
    let cumulativeTimeSec = 0;
    let totalPitTimeSec = 0;

    for (let i = 0; i < numStints; i++) {
      const laps = stintLaps[i];
      const isLast = i === numStints - 1;
      // Safety margin rides in the final stint so the plan never ends dry.
      let required = laps * consumptionPerLap
        + (i === 0 ? formationUnits : 0)
        + (isLast ? safetyUnits : 0);
      const fill = Math.min(round1(required), tankCapacity);

      cumulativeTimeSec += laps * lapTimeSec;

      let stopAfter = null;
      if (!isLast) {
        const nextIsLast = i + 1 === numStints - 1;
        const nextRequired = stintLaps[i + 1] * consumptionPerLap + (nextIsLast ? safetyUnits : 0);
        const nextFill = Math.min(round1(nextRequired), tankCapacity);
        const refuelSec = Math.ceil(nextFill / pit.refuelRatePerSec);
        const tyreSec = pit.tyresEveryStints > 0 && (i + 1) % pit.tyresEveryStints === 0
          ? pit.tyreChangeSec
          : 0;
        const totalSec = pit.pitLaneLossSec + refuelSec + tyreSec;
        stopAfter = { refuelSec, tyreSec, pitLaneSec: pit.pitLaneLossSec, totalSec };
        totalPitTimeSec += totalSec;
        cumulativeTimeSec += totalSec;
      }

      stints.push({
        index: i + 1,
        laps,
        fill,
        splash: isLast && numStints > 1 && laps <= Math.max(2, Math.floor(maxLapsPerStint * 0.15)),
        stopAfter,
        cumulativeTimeSec: Math.round(cumulativeTimeSec),
      });
    }

    return {
      stints,
      numStints,
      stops: numStints - 1,
      maxLapsPerStint,
      totalPitTimeSec: Math.round(totalPitTimeSec),
      totalTimeSec: Math.round(cumulativeTimeSec),
    };
  }

  // Solve total laps for a timed race, accounting for time spent in the pits
  // (pit time reduces the number of laps you actually run).
  function solveTimedLaps(inputs, raceSeconds) {
    let laps = Math.max(1, Math.ceil(raceSeconds / inputs.lapTimeSec));
    for (let i = 0; i < MAX_ITER; i++) {
      const plan = planForLaps({ ...inputs, raceLaps: laps });
      if (!plan) return { laps, plan: null };
      const next = Math.max(1, Math.ceil((raceSeconds - plan.totalPitTimeSec) / inputs.lapTimeSec));
      if (next === laps) return { laps, plan };
      laps = next;
    }
    return { laps, plan: planForLaps({ ...inputs, raceLaps: laps }) };
  }

  function buildStrategy({
    raceMode = "time",           // 'time' | 'laps'
    raceMinutes = 60,
    raceLaps = 0,
    lapTimeSec,
    consumptionPerLap,
    tankCapacity,
    useVirtualEnergy = false,
    formationLap = false,
    safetyLaps = 0,
    stintMode = "maxFirst",
    pit = {},
  }) {
    const pitParams = {
      pitLaneLossSec: pit.pitLaneLossSec ?? DEFAULT_PIT_PARAMS.pitLaneLossSec,
      refuelRatePerSec: pit.refuelRatePerSec
        ?? (useVirtualEnergy ? DEFAULT_PIT_PARAMS.energyRefuelRate : DEFAULT_PIT_PARAMS.fuelRefuelRate),
      tyreChangeSec: pit.tyreChangeSec ?? DEFAULT_PIT_PARAMS.tyreChangeSec,
      tyresEveryStints: pit.tyresEveryStints ?? DEFAULT_PIT_PARAMS.tyresEveryStints,
    };

    const core = {
      lapTimeSec,
      consumptionPerLap,
      tankCapacity,
      formationLap,
      safetyLaps,
      pit: pitParams,
      stintMode,
    };

    if (!lapTimeSec || !consumptionPerLap || !tankCapacity) return null;

    let laps;
    let plan;
    if (raceMode === "laps") {
      laps = Math.max(1, Math.round(raceLaps));
      plan = planForLaps({ ...core, raceLaps: laps });
    } else {
      const solved = solveTimedLaps(core, raceMinutes * 60);
      laps = solved.laps;
      plan = solved.plan;
    }
    if (!plan) return null;

    const formationUnits = formationLap ? consumptionPerLap : 0;
    const safetyUnits = safetyLaps * consumptionPerLap;
    const baseUnits = laps * consumptionPerLap;
    const totalUnits = baseUnits + formationUnits + safetyUnits;

    const warnings = [];
    if (useVirtualEnergy && safetyLaps === 0) {
      warnings.push("No safety margin: hitting 0% Virtual Energy costs a 100s stop-and-go penalty.");
    }
    const tightest = plan.stints.reduce((m, s) => Math.max(m, s.laps * consumptionPerLap
      + (s.index === 1 ? formationUnits : 0)), 0);
    if (tightest > tankCapacity * 0.995) {
      warnings.push(`Stint plan uses ${round1((tightest / tankCapacity) * 100)}% of the tank — no margin for a slow out-lap or push laps.`);
    }

    return {
      units: useVirtualEnergy ? "%" : "L",
      useVirtualEnergy,
      raceMode,
      raceMinutes: raceMode === "time" ? raceMinutes : null,
      raceLaps: laps,
      lapTimeSec,
      consumptionPerLap,
      tankCapacity,
      formationLap,
      safetyLaps,
      startingFill: plan.stints[0]?.fill ?? 0,
      baseUnits: round1(baseUnits),
      safetyUnits: round1(safetyUnits),
      formationUnits: round1(formationUnits),
      totalUnits: round1(totalUnits),
      tanksNeeded: round1(totalUnits / tankCapacity),
      maxLapsPerStint: plan.maxLapsPerStint,
      stops: plan.stops,
      stints: plan.stints,
      totalPitTimeSec: plan.totalPitTimeSec,
      totalTimeSec: plan.totalTimeSec,
      pit: pitParams,
      warnings,
    };
  }

  // Compare the current plan against running one fewer / one more stop.
  // For fewer stops: reports the consumption target per lap needed to stretch
  // the stints, and roughly how much pit time that saves. For more stops: the
  // consumption ceiling you could push to, at the cost of an extra stop.
  function compareStopOptions(inputs) {
    const base = buildStrategy(inputs);
    if (!base) return [];

    const effectiveLaps = base.raceLaps + (base.formationLap ? 1 : 0);
    const options = [];

    for (const targetStops of [base.stops - 1, base.stops, base.stops + 1]) {
      if (targetStops < 0) continue;
      const targetStints = targetStops + 1;
      // Consumption that makes the race fit exactly into targetStints full stints.
      const perLapLimit = (base.tankCapacity * targetStints)
        / (effectiveLaps + base.safetyLaps);

      if (targetStops === base.stops) {
        options.push({
          stops: targetStops,
          current: true,
          perLapTarget: base.consumptionPerLap,
          totalTimeSec: base.totalTimeSec,
          deltaSec: 0,
          lapsDelta: 0,
          feasible: true,
        });
        continue;
      }

      // Fewer stops: consumption must drop to the limit. More stops: you may
      // push up to the limit for that stint count.
      const perLapTarget = Math.floor(perLapLimit * 100) / 100;
      if (targetStops < base.stops && perLapTarget >= base.consumptionPerLap) continue;
      if (targetStops > base.stops && perLapTarget <= base.consumptionPerLap) continue;

      const candidate = buildStrategy({ ...inputs, consumptionPerLap: perLapTarget });
      if (!candidate || candidate.stops !== targetStops) continue;

      const savingPct = targetStops < base.stops
        ? ((base.consumptionPerLap - candidate.consumptionPerLap) / base.consumptionPerLap) * 100
        : null;
      // Beyond ~12% lift-and-coast saving is unrealistic in race conditions.
      const feasible = savingPct === null || savingPct <= 12;

      options.push({
        stops: targetStops,
        current: false,
        perLapTarget: Math.round(candidate.consumptionPerLap * 100) / 100,
        totalTimeSec: candidate.totalTimeSec,
        // In lap races fewer stops = shorter race; in timed races it = more laps run.
        deltaSec: candidate.totalTimeSec - base.totalTimeSec,
        lapsDelta: candidate.raceLaps - base.raceLaps,
        savingPct: savingPct === null ? null : round1(savingPct),
        feasible,
      });
    }

    return options;
  }

  function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
    if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
    return `${sec}s`;
  }

  return {
    DEFAULT_PIT_PARAMS,
    buildStrategy,
    compareStopOptions,
    formatDuration,
  };
});
