/**
 * fuel-data.js — circuits, layouts, classes, cars and consumption defaults for
 * the Fuel tab's strategy calculator.
 * -----------------------------------------------------------------------------
 * Ported verbatim from the standalone LMU fuel app (src/lib/raceData.js); only
 * the module wrapper changed (ESM -> classic script + module.exports). Keep the
 * data edits flowing through scripts/test-fuelcalc.js — its integrity checks
 * fail loudly when a track or car is added inconsistently.
 *
 * Domain rules that live in this file and must not be lost:
 *   - Hypercar + LMGT3 run Virtual Energy (tank = 100, consumption in %/lap);
 *     LMP2/LMP3/GTE run litres. classUsesVirtualEnergy() decides.
 *   - Default VE %/lap is derived (fuelPerLap / fuelCapacity) * 100 — an
 *     approximation the driver should override with the in-game HUD value.
 *   - LMP2 runs a 75L cap at Le Mans (getDefaultTankCapacity handles it).
 *   - Daytona / Laguna Seca numbers are estimates until US Track Pass matures;
 *     packs 2 (Sept 2026) and 3 (Dec 2026) add four more US tracks — extend
 *     CIRCUITS + DEFAULT_LAP_TIMES when they land.
 *
 * Loaded as a classic script by the panel (window.APEX_FUEL_DATA) and
 * require()d by scripts/test-fuelcalc.js — keep it dependency-free.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_FUEL_DATA = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // Circuits with layouts for Le Mans Ultimate
  const CIRCUITS = [
    {
      id: "portimao",
      name: "Algarve International Circuit",
      location: "Portimão, Portugal",
      layouts: [
        { id: "portimao_gp", name: "Grand Prix", length: 4.653 },
      ],
    },
    {
      id: "imola",
      name: "Autodromo Enzo e Dino Ferrari",
      location: "Imola, Italy",
      dlc: "2024 Pack 1",
      layouts: [
        { id: "imola_gp", name: "Grand Prix", length: 4.909 },
      ],
    },
    {
      id: "monza",
      name: "Autodromo Nazionale Monza",
      location: "Monza, Italy",
      layouts: [
        { id: "monza_gp", name: "Grand Prix", length: 5.793 },
        { id: "monza_curva_grande", name: "Curva Grande", length: 5.793 },
      ],
    },
    {
      id: "interlagos",
      name: "Autódromo José Carlos Pace",
      location: "São Paulo, Brazil",
      dlc: "2024 Pack 3",
      layouts: [
        { id: "interlagos_gp", name: "Grand Prix", length: 4.309 },
      ],
    },
    {
      id: "bahrain",
      name: "Bahrain International Circuit",
      location: "Sakhir, Bahrain",
      layouts: [
        { id: "bahrain_gp", name: "Grand Prix", length: 5.412 },
        { id: "bahrain_endurance", name: "Endurance", length: 6.299 },
        { id: "bahrain_outer", name: "Outer Circuit", length: 3.543 },
        { id: "bahrain_paddock", name: "Paddock Circuit", length: 3.705 },
      ],
    },
    {
      id: "barcelona",
      name: "Circuit de Barcelona-Catalunya",
      location: "Barcelona, Spain",
      dlc: "ELMS Pack 3",
      layouts: [
        { id: "barcelona_gp", name: "Grand Prix", length: 4.657 },
      ],
    },
    {
      id: "lemans",
      name: "Circuit de la Sarthe",
      location: "Le Mans, France",
      layouts: [
        { id: "lemans_full", name: "Full Circuit", length: 13.626 },
        { id: "lemans_mulsanne", name: "Mulsanne", length: 13.626 },
      ],
    },
    {
      id: "spa",
      name: "Circuit de Spa-Francorchamps",
      location: "Stavelot, Belgium",
      layouts: [
        { id: "spa_gp", name: "Grand Prix", length: 7.004 },
        { id: "spa_endurance", name: "Endurance Circuit", length: 7.004 },
      ],
    },
    {
      id: "cota",
      name: "Circuit of the Americas",
      location: "Austin, USA",
      dlc: "2024 Pack 2",
      layouts: [
        { id: "cota_gp", name: "Grand Prix", length: 5.513 },
        { id: "cota_national", name: "National Circuit", length: 3.702 },
      ],
    },
    {
      id: "daytona",
      name: "Daytona International Speedway",
      location: "Daytona Beach, USA",
      dlc: "US Track Pass 1",
      layouts: [
        { id: "daytona_road", name: "Road Course", length: 5.729 },
      ],
    },
    {
      id: "fuji",
      name: "Fuji Speedway",
      location: "Oyama, Japan",
      layouts: [
        { id: "fuji_gp", name: "Grand Prix", length: 4.563 },
        { id: "fuji_classic", name: "Classic Circuit", length: 4.526 },
      ],
    },
    {
      id: "qatar",
      name: "Lusail International Circuit",
      location: "Lusail, Qatar",
      dlc: "2024 Pack 5",
      layouts: [
        { id: "qatar_gp", name: "Grand Prix", length: 5.400 },
        { id: "qatar_short", name: "Short Circuit", length: 3.701 },
      ],
    },
    {
      id: "paul_ricard",
      name: "Circuit Paul Ricard",
      location: "Le Castellet, France",
      dlc: "ELMS Pack 2",
      layouts: [
        { id: "paul_ricard_gp", name: "ELMS", length: 5.842 },
        { id: "paul_ricard_1a", name: "Layout 1A", length: 5.752 },
        { id: "paul_ricard_1av2", name: "Layout 1A-V2", length: 5.842 },
        { id: "paul_ricard_1av2_short", name: "Layout 1A-V2-Short", length: 5.227 },
        { id: "paul_ricard_3a", name: "Layout 3A", length: 3.793 },
      ],
    },
    {
      id: "sebring",
      name: "Sebring International Raceway",
      location: "Sebring, USA",
      layouts: [
        { id: "sebring_full", name: "Full Circuit", length: 6.019 },
        { id: "sebring_school", name: "School Circuit", length: 3.219 },
      ],
    },
    {
      id: "silverstone",
      name: "Silverstone Circuit",
      location: "Silverstone, UK",
      dlc: "ELMS Pack 1",
      layouts: [
        { id: "silverstone_gp_wec", name: "Grand Prix Circuit (WEC)", length: 5.890 },
        { id: "silverstone_international", name: "International Circuit", length: 2.979 },
        { id: "silverstone_national", name: "National Circuit", length: 2.639 },
      ],
    },
    {
      id: "laguna_seca",
      name: "WeatherTech Raceway Laguna Seca",
      location: "Monterey, USA",
      dlc: "US Track Pass 1",
      layouts: [
        { id: "laguna_seca", name: "Full Circuit", length: 3.602 },
      ],
    },
  ];

  // usesVirtualEnergy: Hypercar and LMGT3 race on the Virtual Energy (NRG) tank
  // (0-100%, consumption in %/lap); LMP2, LMP3 and GTE use fuel in litres.
  const CAR_CLASSES = [
    { id: "hypercar", name: "Hypercar", color: "#FF3333", usesVirtualEnergy: true },
    { id: "lmp2", name: "LMP2", color: "#0088FF", usesVirtualEnergy: false },
    { id: "lmp3", name: "LMP3", color: "#00CCAA", usesVirtualEnergy: false },
    { id: "gte", name: "GTE", color: "#FFB800", usesVirtualEnergy: false },
    { id: "lmgt3", name: "LMGT3", color: "#BB44FF", usesVirtualEnergy: true },
  ];

  function classUsesVirtualEnergy(classId) {
    return CAR_CLASSES.find(c => c.id === classId)?.usesVirtualEnergy ?? false;
  }

  const CARS = {
    hypercar: [
      { id: "toyota_gr010", name: "Toyota GR010-Hybrid", fuelCapacity: 96, avgConsumption: 2.8, consumptionByTrack: {
        bahrain_gp: 2.95, bahrain_endurance: 3.43, bahrain_outer: 1.91, bahrain_paddock: 2.10,
        barcelona_gp: 2.47, lemans_full: 6.94, lemans_mulsanne: 6.76,
        cota_gp: 2.90, cota_national: 1.98, fuji_gp: 2.28, fuji_classic: 2.24,
        imola_gp: 2.76, interlagos_gp: 2.21, monza_gp: 2.99, monza_curva_grande: 2.92,
        paul_ricard_gp: 2.92, paul_ricard_1a: 2.83, paul_ricard_1av2: 2.82, paul_ricard_1av2_short: 2.67, paul_ricard_3a: 1.93,
        portimao_gp: 2.55, qatar_gp: 2.88, qatar_short: 1.92,
        silverstone_gp_wec: 3.10, silverstone_international: 1.65, silverstone_national: 1.40,
        sebring_full: 3.18, sebring_school: 1.65, spa_gp: 3.65,
      }},
      { id: "porsche_963", name: "Porsche 963", fuelCapacity: 96, avgConsumption: 3.0, consumptionByTrack: {
        bahrain_gp: 2.92, bahrain_endurance: 3.38, bahrain_outer: 1.93, bahrain_paddock: 2.09,
        barcelona_gp: 2.45, lemans_full: 7.35, lemans_mulsanne: 7.26,
        cota_gp: 2.85, cota_national: 1.93, fuji_gp: 2.27, fuji_classic: 2.25,
        imola_gp: 2.80, interlagos_gp: 2.17, monza_gp: 3.07, monza_curva_grande: 3.00,
        paul_ricard_gp: 2.93, paul_ricard_1a: 2.87, paul_ricard_1av2: 2.86, paul_ricard_1av2_short: 2.68, paul_ricard_3a: 1.95,
        portimao_gp: 2.54, qatar_gp: 2.88, qatar_short: 1.95,
        silverstone_gp_wec: 3.11, silverstone_international: 1.64, silverstone_national: 1.42,
        sebring_full: 3.20, sebring_school: 1.65, spa_gp: 3.72,
      }},
      { id: "ferrari_499p", name: "Ferrari 499P", fuelCapacity: 96, avgConsumption: 2.9, consumptionByTrack: {
        bahrain_gp: 2.86, bahrain_endurance: 3.31, bahrain_outer: 1.86, bahrain_paddock: 2.04,
        barcelona_gp: 2.39, lemans_full: 6.84, lemans_mulsanne: 6.73,
        cota_gp: 2.81, cota_national: 1.93, fuji_gp: 2.21, fuji_classic: 2.17,
        imola_gp: 2.69, interlagos_gp: 2.13, monza_gp: 2.92, monza_curva_grande: 2.86,
        paul_ricard_gp: 2.83, paul_ricard_1a: 2.74, paul_ricard_1av2: 2.74, paul_ricard_1av2_short: 2.60, paul_ricard_3a: 1.87,
        portimao_gp: 2.47, qatar_gp: 2.80, qatar_short: 1.86,
        silverstone_gp_wec: 3.01, silverstone_international: 1.62, silverstone_national: 1.36,
        sebring_full: 3.10, sebring_school: 1.60, spa_gp: 3.54,
      }},
      { id: "peugeot_9x8_2023", name: "Peugeot 9X8 2023", fuelCapacity: 96, avgConsumption: 3.1, consumptionByTrack: {
        bahrain_gp: 2.76, bahrain_endurance: 3.21, bahrain_outer: 1.80, bahrain_paddock: 1.96,
        barcelona_gp: 2.32, lemans_full: 6.62, lemans_mulsanne: 6.49,
        cota_gp: 2.73, cota_national: 1.87, fuji_gp: 2.14, fuji_classic: 2.10,
        imola_gp: 2.59, interlagos_gp: 2.06, monza_gp: 2.82, monza_curva_grande: 2.74,
        paul_ricard_gp: 2.74, paul_ricard_1a: 2.64, paul_ricard_1av2: 2.64, paul_ricard_1av2_short: 2.49, paul_ricard_3a: 1.81,
        portimao_gp: 2.38, qatar_gp: 2.70, qatar_short: 1.79,
        silverstone_gp_wec: 2.89, silverstone_international: 1.55, silverstone_national: 1.31,
        sebring_full: 2.99, sebring_school: 1.55, spa_gp: 3.43,
      }},
      { id: "peugeot_9x8_2024", name: "Peugeot 9X8 2024", fuelCapacity: 96, avgConsumption: 3.1, dlc: "2024 Pack 1", consumptionByTrack: {
        bahrain_gp: 2.76, bahrain_endurance: 3.21, bahrain_outer: 1.80, bahrain_paddock: 1.96,
        barcelona_gp: 2.32, lemans_full: 6.62, lemans_mulsanne: 6.49,
        cota_gp: 2.73, cota_national: 1.87, fuji_gp: 2.14, fuji_classic: 2.10,
        imola_gp: 2.59, interlagos_gp: 2.06, monza_gp: 2.82, monza_curva_grande: 2.74,
        paul_ricard_gp: 2.74, paul_ricard_1a: 2.64, paul_ricard_1av2: 2.64, paul_ricard_1av2_short: 2.49, paul_ricard_3a: 1.81,
        portimao_gp: 2.38, qatar_gp: 2.70, qatar_short: 1.79,
        silverstone_gp_wec: 2.89, silverstone_international: 1.55, silverstone_national: 1.31,
        sebring_full: 2.99, sebring_school: 1.55, spa_gp: 3.43,
      }},
      { id: "cadillac_vsr", name: "Cadillac V-Series.R", fuelCapacity: 96, avgConsumption: 3.1, consumptionByTrack: {
        bahrain_gp: 2.99, bahrain_endurance: 3.45, bahrain_outer: 1.98, bahrain_paddock: 2.14,
        barcelona_gp: 2.51, lemans_full: 7.50, lemans_mulsanne: 7.44,
        cota_gp: 2.92, cota_national: 1.98, fuji_gp: 2.32, fuji_classic: 2.29,
        imola_gp: 2.87, interlagos_gp: 2.23, monza_gp: 3.16, monza_curva_grande: 3.09,
        paul_ricard_gp: 3.00, paul_ricard_1a: 2.94, paul_ricard_1av2: 2.91, paul_ricard_1av2_short: 2.74, paul_ricard_3a: 2.00,
        portimao_gp: 2.61, qatar_gp: 2.95, qatar_short: 2.00,
        silverstone_gp_wec: 3.20, silverstone_international: 1.68, silverstone_national: 1.46,
        sebring_full: 3.33, sebring_school: 1.72, spa_gp: 3.80,
      }},
      { id: "bmw_mhybrid_v8", name: "BMW M Hybrid V8", fuelCapacity: 96, avgConsumption: 3.0, dlc: "Free DLC", consumptionByTrack: {
        bahrain_gp: 2.82, bahrain_endurance: 3.24, bahrain_outer: 1.86, bahrain_paddock: 2.02,
        barcelona_gp: 2.37, lemans_full: 7.11, lemans_mulsanne: 6.99,
        cota_gp: 2.76, cota_national: 1.88, fuji_gp: 2.19, fuji_classic: 2.17,
        imola_gp: 2.71, interlagos_gp: 2.09, monza_gp: 2.97, monza_curva_grande: 2.93,
        paul_ricard_gp: 2.84, paul_ricard_1a: 2.79, paul_ricard_1av2: 2.77, paul_ricard_1av2_short: 2.60, paul_ricard_3a: 1.89,
        portimao_gp: 2.46, qatar_gp: 2.79, qatar_short: 1.89,
        silverstone_gp_wec: 3.02, silverstone_international: 1.59, silverstone_national: 1.38,
        sebring_full: 3.09, sebring_school: 1.59, spa_gp: 3.58,
      }},
      { id: "alpine_a424", name: "Alpine A424", fuelCapacity: 96, avgConsumption: 3.0, dlc: "2024 Pack 2", consumptionByTrack: {
        bahrain_gp: 3.03, bahrain_endurance: 3.50, bahrain_outer: 2.00, bahrain_paddock: 2.17,
        barcelona_gp: 2.53, lemans_full: 7.70, lemans_mulsanne: 7.53,
        cota_gp: 2.95, cota_national: 2.01, fuji_gp: 2.36, fuji_classic: 2.34,
        imola_gp: 2.91, interlagos_gp: 2.25, monza_gp: 3.18, monza_curva_grande: 3.15,
        paul_ricard_gp: 3.04, paul_ricard_1a: 3.00, paul_ricard_1av2: 2.99, paul_ricard_1av2_short: 2.80, paul_ricard_3a: 2.02,
        portimao_gp: 2.63, qatar_gp: 2.98, qatar_short: 2.03,
        silverstone_gp_wec: 3.26, silverstone_international: 1.70, silverstone_national: 1.48,
        sebring_full: 3.33, sebring_school: 1.72, spa_gp: 3.86,
      }},
      { id: "lamborghini_sc63", name: "Lamborghini SC63", fuelCapacity: 96, avgConsumption: 3.1, dlc: "2024 Pack 1" },
      { id: "isotta_fraschini_tipo6c", name: "Isotta Fraschini Tipo 6-C", fuelCapacity: 96, avgConsumption: 3.1, dlc: "2024 Pack 2" },
      { id: "glickenhaus_007", name: "Glickenhaus SCG 007", fuelCapacity: 96, avgConsumption: 3.1 },
      { id: "vanwall_680", name: "Vanwall Vandervell 680", fuelCapacity: 96, avgConsumption: 3.0 },
      { id: "genesis_gmr001", name: "Genesis GMR-001 LMDh", fuelCapacity: 96, avgConsumption: 3.0, consumptionByTrack: {
        bahrain_gp: 2.76, bahrain_endurance: 3.20, bahrain_outer: 1.82, bahrain_paddock: 1.98,
        barcelona_gp: 2.27, lemans_full: 6.89, lemans_mulsanne: 6.74,
        cota_gp: 2.73, cota_national: 1.98, fuji_gp: 2.17, fuji_classic: 2.15,
        imola_gp: 2.62, interlagos_gp: 2.08, monza_gp: 2.88, monza_curva_grande: 2.84,
        paul_ricard_gp: 2.77, paul_ricard_1a: 2.94, paul_ricard_1av2: 2.70, paul_ricard_1av2_short: 2.54, paul_ricard_3a: 1.84,
        portimao_gp: 2.39, qatar_gp: 2.69, qatar_short: 1.82,
        silverstone_gp_wec: 2.93, silverstone_international: 1.54, silverstone_national: 1.34,
        sebring_full: 3.02, sebring_school: 1.56, spa_gp: 3.47,
      }},
      { id: "aston_martin_valkyrie", name: "Aston Martin Valkyrie AMR LMH", fuelCapacity: 96, avgConsumption: 2.9, consumptionByTrack: {
        bahrain_gp: 3.25, bahrain_endurance: 3.71, bahrain_outer: 2.14, bahrain_paddock: 2.32,
        barcelona_gp: 2.70, lemans_full: 8.09, lemans_mulsanne: 7.89,
        cota_gp: 3.13, cota_national: 2.11, fuji_gp: 2.47, fuji_classic: 2.47,
        imola_gp: 3.07, interlagos_gp: 2.39, monza_gp: 3.40, monza_curva_grande: 3.36,
        paul_ricard_gp: 3.26, paul_ricard_1a: 3.18, paul_ricard_1av2: 3.17, paul_ricard_1av2_short: 2.95, paul_ricard_3a: 2.14,
        portimao_gp: 2.81, qatar_gp: 3.18, qatar_short: 2.16,
        silverstone_gp_wec: 3.45, silverstone_international: 1.82, silverstone_national: 1.56,
        sebring_full: 3.55, sebring_school: 1.83, spa_gp: 4.10,
      }},
    ],
    lmp2: [
      { id: "oreca_07", name: "Oreca 07 Gibson 2023", fuelCapacity: 63, avgConsumption: 3.4, consumptionByTrack: {
        bahrain_gp: 2.65, bahrain_endurance: 3.07, bahrain_outer: 1.72, bahrain_paddock: 1.88,
        barcelona_gp: 2.16, lemans_full: 6.20, lemans_mulsanne: 6.19,
        cota_gp: 2.52, cota_national: 1.74, fuji_gp: 1.98, fuji_classic: 1.95,
        imola_gp: 2.37, interlagos_gp: 1.92, monza_gp: 2.73, monza_curva_grande: 2.70,
        paul_ricard_gp: 2.55, paul_ricard_1a: 2.46, paul_ricard_1av2: 2.48, paul_ricard_1av2_short: 2.33, paul_ricard_3a: 1.68,
        portimao_gp: 2.17, qatar_gp: 2.45, qatar_short: 1.63,
        silverstone_gp_wec: 2.65, silverstone_international: 1.44, silverstone_national: 1.20,
        sebring_full: 2.80, sebring_school: 1.44, spa_gp: 3.21,
      }},
      { id: "oreca_07_elms", name: "Oreca 07 Gibson 2024", fuelCapacity: 63, avgConsumption: 3.4 },
    ],
    lmp3: [
      { id: "ligier_jsp325", name: "Ligier JS P325", fuelCapacity: 65, avgConsumption: 2.5, dlc: "ELMS Pack 1" },
      { id: "ginetta_g61_evo", name: "Ginetta G61-LT-P3 Evo", fuelCapacity: 65, avgConsumption: 2.5, dlc: "ELMS Pack 2" },
      { id: "duqueine_d09", name: "Duqueine D09", fuelCapacity: 65, avgConsumption: 2.6, dlc: "ELMS Pack 3" },
    ],
    gte: [
      { id: "aston_martin_vantage_gte", name: "Aston Martin Vantage GTE", fuelCapacity: 95, avgConsumption: 3.9, consumptionByTrack: {
        bahrain_gp: 3.93, bahrain_endurance: 4.54, bahrain_outer: 2.57, bahrain_paddock: 2.80,
        barcelona_gp: 3.08, lemans_full: 8.14, lemans_mulsanne: 7.81,
        cota_gp: 3.51, cota_national: 2.41, fuji_gp: 2.89, fuji_classic: 2.85,
        imola_gp: 3.38, interlagos_gp: 2.57, monza_gp: 3.68, monza_curva_grande: 3.60,
        paul_ricard_gp: 3.69, paul_ricard_1a: 3.55, paul_ricard_1av2: 3.56, paul_ricard_1av2_short: 3.36, paul_ricard_3a: 2.43,
        portimao_gp: 3.16, qatar_gp: 3.26, qatar_short: 2.17,
        silverstone_gp_wec: 3.85, silverstone_international: 2.10, silverstone_national: 1.75,
        sebring_full: 3.93, sebring_school: 2.01, spa_gp: 4.54,
      }},
      { id: "corvette_c8r", name: "Chevrolet Corvette C8.R", fuelCapacity: 93, avgConsumption: 4.0, consumptionByTrack: {
        bahrain_gp: 3.82, bahrain_endurance: 4.42, bahrain_outer: 2.49, bahrain_paddock: 2.71,
        barcelona_gp: 3.14, lemans_full: 8.25, lemans_mulsanne: 7.97,
        cota_gp: 3.49, cota_national: 2.38, fuji_gp: 2.89, fuji_classic: 2.84,
        imola_gp: 3.33, interlagos_gp: 2.58, monza_gp: 3.70, monza_curva_grande: 3.61,
        paul_ricard_gp: 3.69, paul_ricard_1a: 3.55, paul_ricard_1av2: 3.54, paul_ricard_1av2_short: 3.34, paul_ricard_3a: 2.44,
        portimao_gp: 3.14, qatar_gp: 3.28, qatar_short: 2.17,
        silverstone_gp_wec: 3.86, silverstone_international: 2.10, silverstone_national: 1.75,
        sebring_full: 3.95, sebring_school: 2.03, spa_gp: 4.55,
      }},
      { id: "ferrari_488_gte", name: "Ferrari 488 GTE Evo", fuelCapacity: 90, avgConsumption: 3.9, consumptionByTrack: {
        bahrain_gp: 3.86, bahrain_endurance: 4.47, bahrain_outer: 2.51, bahrain_paddock: 2.74,
        barcelona_gp: 3.07, lemans_full: 8.24, lemans_mulsanne: 7.93,
        cota_gp: 3.53, cota_national: 2.43, fuji_gp: 2.93, fuji_classic: 2.89,
        imola_gp: 3.38, interlagos_gp: 2.85, monza_gp: 3.74, monza_curva_grande: 3.61,
        paul_ricard_gp: 3.71, paul_ricard_1a: 3.55, paul_ricard_1av2: 3.54, paul_ricard_1av2_short: 3.33, paul_ricard_3a: 2.44,
        portimao_gp: 3.23, qatar_gp: 3.62, qatar_short: 2.42,
        silverstone_gp_wec: 3.87, silverstone_international: 2.11, silverstone_national: 1.75,
        sebring_full: 4.03, sebring_school: 2.08, spa_gp: 4.61,
      }},
      { id: "porsche_911_rsr", name: "Porsche 911 RSR-19", fuelCapacity: 90, avgConsumption: 3.8, consumptionByTrack: {
        bahrain_gp: 3.78, bahrain_endurance: 4.38, bahrain_outer: 2.46, bahrain_paddock: 2.68,
        barcelona_gp: 3.12, lemans_full: 8.38, lemans_mulsanne: 8.03,
        cota_gp: 3.55, cota_national: 2.44, fuji_gp: 2.88, fuji_classic: 2.83,
        imola_gp: 3.33, interlagos_gp: 2.80, monza_gp: 3.71, monza_curva_grande: 3.62,
        paul_ricard_gp: 3.69, paul_ricard_1a: 3.55, paul_ricard_1av2: 3.54, paul_ricard_1av2_short: 3.35, paul_ricard_3a: 2.44,
        portimao_gp: 3.14, qatar_gp: 3.55, qatar_short: 2.35,
        silverstone_gp_wec: 3.86, silverstone_international: 2.10, silverstone_national: 1.75,
        sebring_full: 3.94, sebring_school: 2.03, spa_gp: 4.51,
      }},
    ],
    lmgt3: [
      { id: "aston_martin_lmgt3", name: "Aston Martin Vantage AMR LMGT3 Evo", fuelCapacity: 120, avgConsumption: 3.2, dlc: "2024 Pack 4", consumptionByTrack: {
        bahrain_gp: 3.09, bahrain_endurance: 3.55, bahrain_outer: 2.03, bahrain_paddock: 2.20,
        barcelona_gp: 2.52, lemans_full: 7.57, lemans_mulsanne: 7.34,
        cota_gp: 3.03, cota_national: 2.07, fuji_gp: 2.41, fuji_classic: 2.39,
        imola_gp: 2.89, interlagos_gp: 2.35, monza_gp: 3.20, monza_curva_grande: 3.14,
        paul_ricard_gp: 3.04, paul_ricard_1a: 2.92, paul_ricard_1av2: 2.92, paul_ricard_1av2_short: 2.75, paul_ricard_3a: 2.00,
        portimao_gp: 2.66, qatar_gp: 2.99, qatar_short: 2.01,
        silverstone_gp_wec: 3.18, silverstone_international: 1.71, silverstone_national: 1.45,
        sebring_full: 3.36, sebring_school: 1.75, spa_gp: 3.86,
      }},
      { id: "bmw_m4_lmgt3", name: "BMW M4 LMGT3", fuelCapacity: 120, avgConsumption: 3.3, dlc: "2024 Pack 3", consumptionByTrack: {
        bahrain_gp: 3.17, bahrain_endurance: 3.67, bahrain_outer: 2.08, bahrain_paddock: 2.26,
        barcelona_gp: 2.68, lemans_full: 7.79, lemans_mulsanne: 7.52,
        cota_gp: 3.14, cota_national: 2.16, fuji_gp: 2.50, fuji_classic: 2.47,
        imola_gp: 2.98, interlagos_gp: 2.41, monza_gp: 3.25, monza_curva_grande: 3.22,
        paul_ricard_gp: 3.22, paul_ricard_1a: 3.11, paul_ricard_1av2: 3.11, paul_ricard_1av2_short: 2.92, paul_ricard_3a: 2.12,
        portimao_gp: 2.77, qatar_gp: 3.10, qatar_short: 2.07,
        silverstone_gp_wec: 3.36, silverstone_international: 1.82, silverstone_national: 1.52,
        sebring_full: 3.47, sebring_school: 1.81, spa_gp: 3.97,
      }},
      { id: "bmw_m4_lmgt3_evo", name: "BMW M4 LMGT3 Evo", fuelCapacity: 120, avgConsumption: 3.3, dlc: "2024 Pack 3", consumptionByTrack: {
        bahrain_gp: 3.17, bahrain_endurance: 3.67, bahrain_outer: 2.08, bahrain_paddock: 2.26,
        barcelona_gp: 2.68, lemans_full: 7.79, lemans_mulsanne: 7.52,
        cota_gp: 3.14, cota_national: 2.16, fuji_gp: 2.50, fuji_classic: 2.47,
        imola_gp: 2.98, interlagos_gp: 2.41, monza_gp: 3.25, monza_curva_grande: 3.22,
        paul_ricard_gp: 3.22, paul_ricard_1a: 3.11, paul_ricard_1av2: 3.11, paul_ricard_1av2_short: 2.92, paul_ricard_3a: 2.12,
        portimao_gp: 2.77, qatar_gp: 3.10, qatar_short: 2.07,
        silverstone_gp_wec: 3.36, silverstone_international: 1.82, silverstone_national: 1.52,
        sebring_full: 3.47, sebring_school: 1.81, spa_gp: 3.97,
      }},
      { id: "corvette_z06_lmgt3r", name: "Chevrolet Corvette Z06 LMGT3.R", fuelCapacity: 120, avgConsumption: 3.3, dlc: "2024 Pack 3", consumptionByTrack: {
        bahrain_gp: 3.13, bahrain_endurance: 3.62, bahrain_outer: 2.03, bahrain_paddock: 2.23,
        barcelona_gp: 2.64, lemans_full: 7.69, lemans_mulsanne: 7.43,
        cota_gp: 3.10, cota_national: 2.14, fuji_gp: 2.46, fuji_classic: 2.44,
        imola_gp: 2.93, interlagos_gp: 2.39, monza_gp: 3.19, monza_curva_grande: 3.17,
        paul_ricard_gp: 3.18, paul_ricard_1a: 3.08, paul_ricard_1av2: 3.07, paul_ricard_1av2_short: 2.88, paul_ricard_3a: 2.08,
        portimao_gp: 2.71, qatar_gp: 3.05, qatar_short: 2.05,
        silverstone_gp_wec: 3.33, silverstone_international: 1.78, silverstone_national: 1.52,
        sebring_full: 3.42, sebring_school: 1.79, spa_gp: 3.87,
      }},
      { id: "ferrari_296_lmgt3", name: "Ferrari 296 LMGT3", fuelCapacity: 120, avgConsumption: 3.2, dlc: "2024 Pack 3", consumptionByTrack: {
        bahrain_gp: 3.21, bahrain_endurance: 3.71, bahrain_outer: 2.09, bahrain_paddock: 2.28,
        barcelona_gp: 2.62, lemans_full: 7.87, lemans_mulsanne: 7.72,
        cota_gp: 3.17, cota_national: 2.18, fuji_gp: 2.51, fuji_classic: 2.48,
        imola_gp: 3.00, interlagos_gp: 2.45, monza_gp: 3.30, monza_curva_grande: 3.22,
        paul_ricard_gp: 3.18, paul_ricard_1a: 3.04, paul_ricard_1av2: 3.05, paul_ricard_1av2_short: 2.85, paul_ricard_3a: 2.07,
        portimao_gp: 2.77, qatar_gp: 3.12, qatar_short: 2.07,
        silverstone_gp_wec: 3.30, silverstone_international: 1.78, silverstone_national: 1.50,
        sebring_full: 3.49, sebring_school: 1.81, spa_gp: 4.00,
      }},
      { id: "ford_mustang_lmgt3", name: "Ford Mustang LMGT3", fuelCapacity: 120, avgConsumption: 3.4, dlc: "Free DLC", consumptionByTrack: {
        bahrain_gp: 2.96, bahrain_endurance: 3.41, bahrain_outer: 1.94, bahrain_paddock: 2.11,
        barcelona_gp: 2.35, lemans_full: 7.19, lemans_mulsanne: 6.99,
        cota_gp: 2.91, cota_national: 1.98, fuji_gp: 2.32, fuji_classic: 2.28,
        imola_gp: 2.75, interlagos_gp: 2.25, monza_gp: 3.03, monza_curva_grande: 2.98,
        paul_ricard_gp: 2.82, paul_ricard_1a: 2.73, paul_ricard_1av2: 2.72, paul_ricard_1av2_short: 2.55, paul_ricard_3a: 1.86,
        portimao_gp: 2.55, qatar_gp: 2.84, qatar_short: 1.91,
        silverstone_gp_wec: 2.95, silverstone_international: 1.59, silverstone_national: 1.34,
        sebring_full: 3.19, sebring_school: 1.65, spa_gp: 3.68,
      }},
      { id: "lamborghini_lmgt3", name: "Lamborghini Huracán LMGT3 Evo 2", fuelCapacity: 120, avgConsumption: 3.3, dlc: "2024 Pack 5" },
      { id: "lexus_rcf_lmgt3", name: "Lexus RC F LMGT3", fuelCapacity: 120, avgConsumption: 3.2, dlc: "2024 Pack 5", consumptionByTrack: {
        bahrain_gp: 4.30, bahrain_endurance: 3.96, bahrain_outer: 2.22, bahrain_paddock: 2.43,
        barcelona_gp: 2.85, lemans_full: 8.05, lemans_mulsanne: 7.83,
        cota_gp: 3.38, cota_national: 2.31, fuji_gp: 2.66, fuji_classic: 2.62,
        imola_gp: 3.15, interlagos_gp: 2.60, monza_gp: 3.46, monza_curva_grande: 3.32,
        paul_ricard_gp: 3.39, paul_ricard_1a: 3.24, paul_ricard_1av2: 3.23, paul_ricard_1av2_short: 3.05, paul_ricard_3a: 2.24,
        portimao_gp: 2.95, qatar_gp: 3.28, qatar_short: 2.18,
        silverstone_gp_wec: 3.55, silverstone_international: 1.94, silverstone_national: 1.61,
        sebring_full: 3.69, sebring_school: 1.91, spa_gp: 4.20,
      }},
      { id: "mclaren_720s_lmgt3", name: "McLaren 720S LMGT3 Evo", fuelCapacity: 120, avgConsumption: 3.1, dlc: "Free DLC", consumptionByTrack: {
        bahrain_gp: 3.00, bahrain_endurance: 3.46, bahrain_outer: 1.95, bahrain_paddock: 2.13,
        barcelona_gp: 2.49, lemans_full: 7.31, lemans_mulsanne: 7.05,
        cota_gp: 3.00, cota_national: 2.06, fuji_gp: 2.34, fuji_classic: 2.32,
        imola_gp: 2.79, interlagos_gp: 2.28, monza_gp: 3.07, monza_curva_grande: 2.98,
        paul_ricard_gp: 3.00, paul_ricard_1a: 2.88, paul_ricard_1av2: 2.88, paul_ricard_1av2_short: 2.69, paul_ricard_3a: 1.97,
        portimao_gp: 2.59, qatar_gp: 2.92, qatar_short: 1.94,
        silverstone_gp_wec: 3.14, silverstone_international: 1.68, silverstone_national: 1.42,
        sebring_full: 3.24, sebring_school: 1.69, spa_gp: 3.74,
      }},
      { id: "mercedes_amg_lmgt3", name: "Mercedes-AMG LMGT3", fuelCapacity: 120, avgConsumption: 3.2, consumptionByTrack: {
        bahrain_gp: 3.44, bahrain_endurance: 3.94, bahrain_outer: 2.23, bahrain_paddock: 2.43,
        barcelona_gp: 2.83, lemans_full: 8.28, lemans_mulsanne: 8.09,
        cota_gp: 3.37, cota_national: 2.31, fuji_gp: 2.67, fuji_classic: 2.63,
        imola_gp: 3.17, interlagos_gp: 2.58, monza_gp: 3.50, monza_curva_grande: 3.40,
        paul_ricard_gp: 3.38, paul_ricard_1a: 3.25, paul_ricard_1av2: 3.26, paul_ricard_1av2_short: 3.04, paul_ricard_3a: 2.22,
        portimao_gp: 2.97, qatar_gp: 3.30, qatar_short: 2.20,
        silverstone_gp_wec: 3.54, silverstone_international: 1.94, silverstone_national: 1.61,
        sebring_full: 3.71, sebring_school: 1.93, spa_gp: 4.20,
      }},
      { id: "porsche_911_lmgt3r", name: "Porsche 911 LMGT3 R (992)", fuelCapacity: 120, avgConsumption: 3.1, dlc: "2024 Pack 4", consumptionByTrack: {
        bahrain_gp: 3.25, bahrain_endurance: 3.78, bahrain_outer: 2.13, bahrain_paddock: 2.32,
        barcelona_gp: 2.72, lemans_full: 7.74, lemans_mulsanne: 7.52,
        cota_gp: 3.23, cota_national: 2.21, fuji_gp: 2.54, fuji_classic: 2.50,
        imola_gp: 3.03, interlagos_gp: 2.48, monza_gp: 3.30, monza_curva_grande: 3.18,
        paul_ricard_gp: 3.23, paul_ricard_1a: 3.06, paul_ricard_1av2: 3.07, paul_ricard_1av2_short: 2.88, paul_ricard_3a: 2.12,
        portimao_gp: 2.84, qatar_gp: 3.15, qatar_short: 2.10,
        silverstone_gp_wec: 3.38, silverstone_international: 1.85, silverstone_national: 1.54,
        sebring_full: 3.54, sebring_school: 1.84, spa_gp: 4.02,
      }},
    ],
  };

  // Default lap times per layout per class (in seconds)
  const DEFAULT_LAP_TIMES = {
    // Le Mans
    lemans_full:              { hypercar: 212.68, lmp2: 223.37, lmp3: 234.80, gte: 240.80, lmgt3: 246.04 },
    lemans_mulsanne:          { hypercar: 198.51, lmp2: 207.40, lmp3: 219.70, gte: 223.94, lmgt3: 229.53 },
    // Monza
    monza_gp:                 { hypercar: 99.10, lmp2: 103.64, lmp3: 108.29, gte: 111.06, lmgt3: 113.59 },
    monza_curva_grande:       { hypercar: 90.26, lmp2: 94.33,  lmp3: 98.91, gte: 101.45, lmgt3: 103.49 },
    // Spa
    spa_gp:                   { hypercar: 125.45, lmp2: 130.60, lmp3: 136.30, gte: 141.07, lmgt3: 143.53 },
    spa_endurance:            { hypercar: 125.45, lmp2: 130.60, lmp3: 136.30, gte: 141.07, lmgt3: 143.53 },
    // Portimão
    portimao_gp:              { hypercar: 95.33, lmp2: 99.33, lmp3: 102.63, gte: 106.19, lmgt3: 107.78 },
    // Fuji
    fuji_gp:                  { hypercar: 92.43, lmp2: 95.98, lmp3: 98.91, gte: 103.21, lmgt3: 104.35 },
    fuji_classic:             { hypercar: 87.54, lmp2: 91.54, lmp3: 95.31, gte: 96.88, lmgt3: 100.34 },
    // Bahrain
    bahrain_gp:               { hypercar: 110.20, lmp2: 114.85, lmp3: 118.75, gte: 123.42, lmgt3: 123.92 },
    bahrain_endurance:        { hypercar: 136.73, lmp2: 141.87, lmp3: 145.66, gte: 149.23, lmgt3: 152.74 },
    bahrain_outer:            { hypercar: 67.42, lmp2: 69.69,  lmp3: 72.66, gte: 74.40,  lmgt3: 75.24 },
    bahrain_paddock:          { hypercar: 74.97, lmp2: 77.73,  lmp3: 80.81, gte: 82.87,  lmgt3: 84.62 },
    // Sebring
    sebring_full:             { hypercar: 110.53, lmp2: 114.83, lmp3: 119.21, gte: 123.54, lmgt3: 125.30 },
    sebring_school:           { hypercar: 56.96, lmp2: 59.66,  lmp3: 61.91, gte: 64.14,  lmgt3: 65.56 },
    // COTA
    cota_gp:                  { hypercar: 116.99, lmp2: 121.28, lmp3: 125.81, gte: 128.23, lmgt3: 131.23 },
    cota_national:            { hypercar: 84.97, lmp2: 87.39,  lmp3: 90.06, gte: 91.51,  lmgt3: 94.29 },
    // Imola
    imola_gp:                 { hypercar: 93.84, lmp2: 98.19, lmp3: 101.86, gte: 104.70, lmgt3: 106.43 },
    // Interlagos
    interlagos_gp:            { hypercar: 86.32, lmp2: 89.85, lmp3: 92.92, gte: 96.68, lmgt3: 97.64 },
    // Qatar
    qatar_gp:                 { hypercar: 103.71, lmp2: 107.40, lmp3: 111.56, gte: 116.89, lmgt3: 119.14 },
    qatar_short:              { hypercar: 62.73, lmp2: 64.38,  lmp3: 67.83, gte: 70.56,  lmgt3: 72.33 },
    // Barcelona
    barcelona_gp:             { hypercar: 92.59, lmp2: 104, lmp3: 98.80, gte: 111, lmgt3: 105.15 },
    // Paul Ricard
    paul_ricard_gp:           { hypercar: 113.68, lmp2: 117.75, lmp3: 122.43, gte: 128.64, lmgt3: 128.94 },
    paul_ricard_1a:           { hypercar: 100.77, lmp2: 118, lmp3: 109.38, gte: 124, lmgt3: 115.19 },
    paul_ricard_1av2:         { hypercar: 110, lmp2: 119, lmp3: 131, gte: 125, lmgt3: 120.73 },
    paul_ricard_1av2_short:   { hypercar: 100, lmp2: 108, lmp3: 119, gte: 114, lmgt3: 110.83 },
    paul_ricard_3a:           { hypercar: 73,  lmp2: 79,  lmp3: 87,  gte: 83,  lmgt3: 83.38 },
    // Silverstone
    silverstone_gp_wec:       { hypercar: 106.89, lmp2: 110.94, lmp3: 115.99, gte: 126, lmgt3: 123.15 },
    silverstone_international:{ hypercar: 59,  lmp2: 64,  lmp3: 60.21, gte: 68,  lmgt3: 69  },
    silverstone_national:     { hypercar: 52,  lmp2: 56,  lmp3: 52.45, gte: 60,  lmgt3: 55.46 },
    // Daytona (US Track Pass 1) — estimated from IMSA reference laps, override in-app
    daytona_road:             { hypercar: 95.5, lmp2: 99.8, lmp3: 101.5, gte: 104.5, lmgt3: 106.5 },
    // Laguna Seca (US Track Pass 1) — estimated from IMSA reference laps, override in-app
    laguna_seca:              { hypercar: 71.5, lmp2: 74.8, lmp3: 77.9, gte: 80.5, lmgt3: 81.8 },
  };

  // Layouts that share consumption data with another layout of the same circuit
  // (the per-car tables only carry one entry for these).
  const CONSUMPTION_LAYOUT_ALIASES = {
    spa_endurance: "spa_gp",
  };

  // Helper to find circuit and layout
  function getCircuit(circuitId) {
    return CIRCUITS.find(c => c.id === circuitId);
  }

  function getLayout(circuitId, layoutId) {
    const circuit = getCircuit(circuitId);
    if (!circuit) return null;
    return circuit.layouts.find(l => l.id === layoutId);
  }

  function findLayoutById(layoutId) {
    for (const circuit of CIRCUITS) {
      const layout = circuit.layouts.find(l => l.id === layoutId);
      if (layout) return layout;
    }
    return null;
  }

  function getDefaultLapTime(layoutId, classId) {
    return DEFAULT_LAP_TIMES[layoutId]?.[classId] || null;
  }

  function getCarData(classId, carId) {
    return CARS[classId]?.find(c => c.id === carId) || null;
  }

  // Estimate a car's consumption on a layout it has no measured entry for, by
  // scaling its known per-km consumption to the layout length. Falls back to the
  // class-average figure when the car has no measured tracks at all.
  function estimateFuelPerLap(car, layoutId) {
    const layout = findLayoutById(layoutId);
    const entries = Object.entries(car.consumptionByTrack || {});
    if (!layout || entries.length === 0) return car.avgConsumption;
    let perKmSum = 0;
    let counted = 0;
    for (const [id, litres] of entries) {
      const known = findLayoutById(id);
      if (!known) continue;
      perKmSum += litres / known.length;
      counted++;
    }
    if (counted === 0) return car.avgConsumption;
    return Math.round((perKmSum / counted) * layout.length * 100) / 100;
  }

  function getDefaultFuelPerLap(classId, carId, layoutId) {
    const car = getCarData(classId, carId);
    if (!car) return null;
    const lookupId = car.consumptionByTrack?.[layoutId] != null
      ? layoutId
      : (CONSUMPTION_LAYOUT_ALIASES[layoutId] || layoutId);
    return car.consumptionByTrack?.[lookupId] ?? estimateFuelPerLap(car, lookupId);
  }

  // Default Virtual Energy consumption in %/lap for VE classes. Derived from the
  // fuel model so stint lengths stay consistent with measured data; players should
  // override with the real %/lap read off the in-game HUD.
  function getDefaultEnergyPerLap(classId, carId, layoutId) {
    if (!classUsesVirtualEnergy(classId)) return null;
    const car = getCarData(classId, carId);
    const fuelPerLap = getDefaultFuelPerLap(classId, carId, layoutId);
    if (!car || !fuelPerLap) return null;
    return Math.round((fuelPerLap / car.fuelCapacity) * 100 * 10) / 10;
  }

  // LMP2 at Le Mans runs a 75L tank cap; otherwise the car default.
  function getDefaultTankCapacity(classId, carId, layoutId) {
    const car = getCarData(classId, carId);
    if (!car) return null;
    const isLemans = layoutId === "lemans_full" || layoutId === "lemans_mulsanne";
    return (classId === "lmp2" && isLemans) ? 75 : car.fuelCapacity;
  }

  function formatLapTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(1);
    return `${mins}:${secs.padStart(4, '0')}`;
  }
  return {
    CIRCUITS,
    CAR_CLASSES,
    CARS,
    DEFAULT_LAP_TIMES,
    CONSUMPTION_LAYOUT_ALIASES,
    classUsesVirtualEnergy,
    getCircuit,
    getLayout,
    findLayoutById,
    getDefaultLapTime,
    getCarData,
    getDefaultFuelPerLap,
    getDefaultEnergyPerLap,
    getDefaultTankCapacity,
    formatLapTime,
  };
});
