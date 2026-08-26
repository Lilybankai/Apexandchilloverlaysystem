/**
 * electron/team-snapshot.js — the Team tab's once-a-second telemetry snapshot.
 * -----------------------------------------------------------------------------
 * Main already holds every live TelemetryFrame (the status feed parses each one
 * to derive live/demo/no-data), and the Team page is a 1 Hz instrument — so
 * rather than give the renderer the 30 Hz firehose, main prunes the latest
 * frame down to exactly what the pit wall reads and pushes that over IPC.
 *
 * This shape is deliberately the seed of the future team relay payload
 * (docs/TEAM-ENGINEER-PAGE.md): what an engineer needs to see about a car is
 * the same whether the car is ours or a teammate's, so Phase 2 uploads this
 * object instead of inventing a second one.
 *
 * Pure — no Electron, no IO — so scripts/test-teamsnapshot.js can drive it
 * with recorded frames. Unknown numerics keep the feed's -1 sentinel; the
 * renderer owns turning those into em-dashes.
 */

'use strict';

/** Prune one tyre corner to what the page renders. */
function tyre(t) {
  if (!t) return null;
  return {
    wear: t.wear,
    tempC: t.tempC,
    coreC: t.coreC,
    innerC: t.innerC,
    middleC: t.middleC,
    outerC: t.outerC,
    pressureKpa: t.pressureKpa,
    brakeTempC: t.brakeTempC,
    optimalTempC: t.optimalTempC,
    compound: t.compound,
  };
}

/**
 * Build the Team page snapshot from one TelemetryFrame.
 *
 * @param {object} frame  A parsed TelemetryFrame (any source, any staleness).
 * @param {number} at     Wall-clock ms for the snapshot's age pill. Passed in
 *                        rather than read so tests are deterministic.
 * @returns {object|null} The snapshot, or null for a frame too broken to use.
 */
function buildTeamSnapshot(frame, at) {
  if (!frame || typeof frame !== 'object' || !frame.session || !frame.player) return null;

  const s = frame.session;
  const p = frame.player;
  // The standings row flagged as ours carries the identity the PlayerState
  // does not: class, car number, class position, and the name on the entry.
  const mine = Array.isArray(frame.standings)
    ? frame.standings.find((row) => row && row.isPlayer)
    : null;

  return {
    at,
    connected: frame.connected !== false,
    source: frame.source,
    session: {
      type: s.type,
      phase: s.phase,
      flag: s.flag,
      track: s.track,
      trackConfig: s.trackConfig,
      timeRemainingSec: s.timeRemainingSec,
      scheduledLengthSec: s.scheduledLengthSec,
      totalLaps: s.totalLaps,
      lapsRemaining: s.lapsRemaining,
      currentLap: s.currentLap,
      numCars: s.numCars,
      serverName: s.serverName,
      onTrack: s.onTrack,
    },
    car: {
      driverName: mine ? mine.driverName : undefined,
      carNumber: mine ? mine.carNumber : undefined,
      carClass: mine ? mine.carClass : undefined,
      position: p.position,
      classPosition: mine ? mine.classPosition : undefined,
      // 1 Hz is deliberately coarse for these three — the pit wall reads them
      // as "what's the car doing", not as a live dashboard.
      speedKph: p.speedKph,
      rpm: p.rpm,
      maxRpm: p.maxRpm,
      gear: p.gear,
      lap: p.lap
        ? {
            current: p.lap.current,
            last: p.lap.last,
            best: p.lap.best,
            delta: p.lap.delta,
            sector: p.lap.sector,
          }
        : null,
      lapsCompleted: mine ? mine.lapsCompleted : undefined,
      inPit: mine ? mine.inPit : undefined,
      pitStops: mine ? mine.pitStops : undefined,
      pit: p.pit
        ? {
            phase: p.pit.phase,
            working: p.pit.working,
            elapsedSec: p.pit.elapsedSec,
            plannedSec: p.pit.plannedSec,
            limiterOn: p.pit.limiterOn,
          }
        : null,
      damage: p.damage
        ? {
            aero: p.damage.aero,
            // Per-corner severities ride along so the panel can NAME the worst
            // component the way the overlay's damage widget does — `worst`
            // alone is an anonymous fraction.
            suspension: Array.isArray(p.damage.suspension)
              ? p.damage.suspension.slice(0, 4)
              : undefined,
            worst: p.damage.worst,
            hasDamage: p.damage.hasDamage,
            repairSeconds: p.damage.repairSeconds,
            partsDetached: p.damage.partsDetached,
          }
        : null,
      hybrid: p.hybrid ? { chargeFraction: p.hybrid.chargeFraction } : null,
      tyres: p.tyres
        ? {
            frontLeft: tyre(p.tyres.frontLeft),
            frontRight: tyre(p.tyres.frontRight),
            rearLeft: tyre(p.tyres.rearLeft),
            rearRight: tyre(p.tyres.rearRight),
          }
        : null,
      finished: p.finished,
    },
    // The whole field, pruned to what the timing sheet reads. ~35 cars ×
    // ~18 small fields ≈ a few KB at 1 Hz over local IPC — cheap, and it is
    // the payload that makes the page a pit wall instead of a dashboard.
    standings: Array.isArray(frame.standings)
      ? frame.standings.slice(0, 80).map((row) => ({
          slotId: row.slotId,
          position: row.position,
          classPosition: row.classPosition,
          driverName: row.driverName,
          carNumber: row.carNumber,
          carClass: row.carClass,
          lapsCompleted: row.lapsCompleted,
          lapFraction: row.lapFraction,
          lastLapSec: row.lastLapSec,
          bestLapSec: row.bestLapSec,
          avg5Sec: row.avg5Sec,
          gapToLeaderSec: row.gapToLeaderSec,
          gapToAheadSec: row.gapToAheadSec,
          gapToClassLeaderSec: row.gapToClassLeaderSec,
          classLapsBehind: row.classLapsBehind,
          lapsBehind: row.lapsBehind,
          inPit: row.inPit,
          pitStops: row.pitStops,
          tyreCompound: row.tyreCompound,
          virtualEnergy: row.virtualEnergy,
          isPlayer: row.isPlayer,
        }))
      : [],
    trackMap: frame.trackMap
      ? {
          key: frame.trackMap.key,
          revision: frame.trackMap.revision,
          ready: frame.trackMap.ready,
          progress: frame.trackMap.progress,
          cars: Array.isArray(frame.trackMap.cars)
            ? frame.trackMap.cars.map((c) => ({
                slotId: c.slotId,
                x: c.x,
                z: c.z,
                lapFraction: c.lapFraction,
                inPit: c.inPit,
                isPlayer: c.isPlayer,
              }))
            : [],
        }
      : null,
    fuel: frame.fuel ? { ...frame.fuel } : null,
    weather: frame.weather
      ? {
          trackTempC: frame.weather.trackTempC,
          ambientTempC: frame.weather.ambientTempC,
          rainIntensity: frame.weather.rainIntensity,
          trackWetness: frame.weather.trackWetness,
          trackCondition: frame.weather.trackCondition,
          trackTrend: frame.weather.trackTrend,
          trackSpread: frame.weather.trackSpread,
          // The WHOLE forecast slot, not just the rain pair: the Team weather
          // card prints sky, temperature, humidity and wind per phase, and a
          // field dropped here reads as "LMU doesn't publish it" on the wall.
          forecast: Array.isArray(frame.weather.forecast)
            ? frame.weather.forecast.map((f) => ({
                minutesAhead: f.minutesAhead,
                label: f.label,
                rainChance: f.rainChance,
                rainIntensity: f.rainIntensity,
                trackTempC: f.trackTempC,
                airTempC: f.airTempC,
                humidityPct: f.humidityPct,
                windKph: f.windKph,
                sky: f.sky,
              }))
            : [],
        }
      : null,
  };
}

module.exports = { buildTeamSnapshot };
