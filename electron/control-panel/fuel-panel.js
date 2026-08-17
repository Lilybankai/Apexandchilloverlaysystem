/**
 * fuel-panel.js — the Fuel tab: race fuel & pit-strategy calculator.
 * -----------------------------------------------------------------------------
 * A vanilla port of the standalone LMU fuel app's Calculator page, on top of
 * the engine in fuel-data.js / fuel-strategy.js (window.APEX_FUEL_DATA /
 * APEX_FUEL_STRATEGY). Everything is computed locally from the driver's
 * choices — no sim connection, no IPC, no polling — so unlike the Setups tab
 * there is no shown()/hidden() lifecycle to run: the tab costs nothing while
 * another view is active.
 *
 * Unit rule carried over from the source app: Hypercar and LMGT3 plan in
 * Virtual Energy (tank fixed at 100, consumption in %/lap, no tank override);
 * LMP2/LMP3/GTE plan in litres. Empty consumption / lap-time / tank inputs
 * mean "auto" — the placeholder shows the default for the chosen car & track.
 */

(function () {
  'use strict';

  const DATA = window.APEX_FUEL_DATA;
  const ENGINE = window.APEX_FUEL_STRATEGY;
  if (!DATA || !ENGINE) return;

  const $ = (sel) => document.querySelector(sel);

  // ── State ────────────────────────────────────────────────────────────────
  const STORAGE_KEY = 'apex.panel.fuelcalc';

  const DEFAULT_STATE = {
    circuitId: '', layoutId: '', classId: '', carId: '',
    raceMode: 'time', raceMinutes: 60, raceLaps: 30,
    customConsumption: null, customLapTime: null, customTankCapacity: null,
    safetyLaps: 2, formationLap: false,
    pitOverrides: {}, stintMode: 'maxFirst',
  };

  let state = { ...DEFAULT_STATE };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    state = {
      ...DEFAULT_STATE,
      ...saved,
      pitOverrides: (saved && typeof saved.pitOverrides === 'object' && saved.pitOverrides) || {},
    };
  } catch { /* corrupted save — start clean */ }

  // Manufacturer filter is a view convenience, deliberately not persisted
  // (matches the source app, where it was local component state).
  let makerFilter = '';

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { }
  }

  // ── Element refs (all static ids live in scripts/test-panel-parity.js) ──
  const els = {
    circuit: $('#fuel-circuit'),
    layout: $('#fuel-layout'),
    cls: $('#fuel-class'),
    maker: $('#fuel-maker'),
    car: $('#fuel-car'),
    modeSeg: $('#fuel-mode-seg'),
    minutesField: $('#fuel-minutes-field'),
    minutes: $('#fuel-minutes'),
    chips: $('#fuel-chips'),
    lapsField: $('#fuel-laps-field'),
    laps: $('#fuel-laps'),
    ltMin: $('#fuel-laptime-min'),
    ltSec: $('#fuel-laptime-sec'),
    ltHint: $('#fuel-laptime-hint'),
    consumption: $('#fuel-consumption'),
    consumptionLabel: $('#fuel-consumption-label'),
    consumptionHint: $('#fuel-consumption-hint'),
    safety: $('#fuel-safety'),
    formation: $('#fuel-formation'),
    tankField: $('#fuel-tank-field'),
    tank: $('#fuel-tank'),
    tankHint: $('#fuel-tank-hint'),
    stintSeg: $('#fuel-stint-seg'),
    pitLoss: $('#fuel-pit-loss'),
    pitRate: $('#fuel-pit-rate'),
    pitRateLabel: $('#fuel-pit-rate-label'),
    pitTyres: $('#fuel-pit-tyres'),
    pitEvery: $('#fuel-pit-every'),
    pitReset: $('#fuel-pit-reset'),
    reset: $('#fuel-reset'),
    empty: $('#fuel-empty'),
    result: $('#fuel-result'),
  };

  const icon = (name) => (window.apexIcon ? window.apexIcon(name) : '');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Race-length quick picks; under an hour reads as minutes, from 1h as hours.
  const CHIP_MINUTES = [20, 30, 45, 60, 120, 240, 360, 480, 720, 1440];
  const chipLabel = (m) => (m < 60 ? `${m}m` : `${m / 60}h`);

  const MULTI_WORD_MAKERS = [
    'Aston Martin', 'Chevrolet', 'Mercedes-AMG', 'McLaren', 'United Autosport', 'Isotta Fraschini',
  ];
  function makerOf(carName) {
    const hit = MULTI_WORD_MAKERS.find((m) => carName.startsWith(m));
    return hit || carName.split(' ')[0];
  }

  // ── Derivations ─────────────────────────────────────────────────────────
  function derive() {
    const isVE = DATA.classUsesVirtualEnergy(state.classId);
    const circuit = DATA.getCircuit(state.circuitId);
    const layout = DATA.getLayout(state.circuitId, state.layoutId);
    const car = DATA.getCarData(state.classId, state.carId);
    const defaultLapTime = state.layoutId && state.classId
      ? DATA.getDefaultLapTime(state.layoutId, state.classId) : null;
    const defaultConsumption = state.classId && state.carId && state.layoutId
      ? (isVE
        ? DATA.getDefaultEnergyPerLap(state.classId, state.carId, state.layoutId)
        : DATA.getDefaultFuelPerLap(state.classId, state.carId, state.layoutId))
      : null;
    const defaultTank = state.classId && state.carId
      ? DATA.getDefaultTankCapacity(state.classId, state.carId, state.layoutId) : null;

    const pit = {
      pitLaneLossSec: state.pitOverrides.pitLaneLossSec ?? ENGINE.DEFAULT_PIT_PARAMS.pitLaneLossSec,
      refuelRatePerSec: state.pitOverrides.refuelRatePerSec
        ?? (isVE ? ENGINE.DEFAULT_PIT_PARAMS.energyRefuelRate : ENGINE.DEFAULT_PIT_PARAMS.fuelRefuelRate),
      tyreChangeSec: state.pitOverrides.tyreChangeSec ?? ENGINE.DEFAULT_PIT_PARAMS.tyreChangeSec,
      tyresEveryStints: state.pitOverrides.tyresEveryStints ?? ENGINE.DEFAULT_PIT_PARAMS.tyresEveryStints,
    };

    const consumptionPerLap = state.customConsumption ?? defaultConsumption;
    const lapTimeSec = state.customLapTime ?? defaultLapTime;
    const tankCapacity = isVE ? 100 : (state.customTankCapacity ?? defaultTank);

    let inputs = null;
    if (circuit && layout && car && consumptionPerLap && lapTimeSec && tankCapacity) {
      inputs = {
        raceMode: state.raceMode,
        raceMinutes: state.raceMinutes,
        raceLaps: state.raceLaps,
        lapTimeSec,
        consumptionPerLap,
        tankCapacity,
        useVirtualEnergy: isVE,
        formationLap: state.formationLap,
        safetyLaps: state.safetyLaps,
        stintMode: state.stintMode,
        pit,
      };
    }

    return { isVE, circuit, layout, car, defaultLapTime, defaultConsumption, defaultTank, pit, inputs };
  }

  // ── Controls sync ───────────────────────────────────────────────────────
  function fillSelect(select, options, value, placeholder) {
    const parts = [`<option value="">${esc(placeholder)}</option>`];
    for (const o of options) {
      parts.push(`<option value="${esc(o.value)}"${o.value === value ? ' selected' : ''}>${esc(o.label)}</option>`);
    }
    select.innerHTML = parts.join('');
  }

  function syncControls(d) {
    fillSelect(els.circuit, DATA.CIRCUITS.map((c) => ({
      value: c.id,
      label: c.name + (c.dlc ? ` · ${c.dlc}` : ''),
    })), state.circuitId, 'Select circuit');

    const layouts = d.circuit ? d.circuit.layouts : [];
    fillSelect(els.layout, layouts.map((l) => ({
      value: l.id,
      label: `${l.name} — ${l.length} km`,
    })), state.layoutId, d.circuit ? 'Select layout' : 'Choose a circuit first');
    els.layout.disabled = !d.circuit;

    fillSelect(els.cls, DATA.CAR_CLASSES.map((c) => ({
      value: c.id,
      label: c.name + (c.usesVirtualEnergy ? ' · Virtual Energy' : ''),
    })), state.classId, 'Select class');

    const cars = state.classId ? (DATA.CARS[state.classId] || []) : [];
    const makers = Array.from(new Set(cars.map((c) => makerOf(c.name)))).sort();
    if (makerFilter && !makers.includes(makerFilter)) makerFilter = '';
    fillSelect(els.maker, makers.map((m) => ({ value: m, label: m })), makerFilter, 'All manufacturers');
    els.maker.disabled = !state.classId;

    const shown = makerFilter ? cars.filter((c) => makerOf(c.name) === makerFilter) : cars;
    fillSelect(els.car, shown.map((c) => {
      const perLap = state.layoutId
        ? (d.isVE
          ? DATA.getDefaultEnergyPerLap(state.classId, c.id, state.layoutId)
          : DATA.getDefaultFuelPerLap(state.classId, c.id, state.layoutId))
        : null;
      const unit = d.isVE ? '%' : 'L';
      const sub = [perLap ? `~${perLap}${unit}/lap` : null, c.dlc].filter(Boolean).join(' · ');
      return { value: c.id, label: c.name + (sub ? ` — ${sub}` : '') };
    }), state.carId, state.classId ? 'Select car' : 'Choose a class first');
    els.car.disabled = !state.classId;

    // Race length.
    for (const btn of els.modeSeg.querySelectorAll('[data-fuelmode]')) {
      btn.setAttribute('data-active', String(btn.dataset.fuelmode === state.raceMode));
    }
    els.minutesField.hidden = state.raceMode !== 'time';
    els.chips.hidden = state.raceMode !== 'time';
    els.lapsField.hidden = state.raceMode !== 'laps';
    els.minutes.value = state.raceMinutes;
    els.laps.value = state.raceLaps;
    els.chips.innerHTML = CHIP_MINUTES.map((m) =>
      `<button type="button" class="fuel-chip" data-minutes="${m}" data-active="${m === state.raceMinutes}">${chipLabel(m)}</button>`
    ).join('');

    // Lap time override (empty = auto).
    if (state.customLapTime != null) {
      els.ltMin.value = Math.floor(state.customLapTime / 60);
      els.ltSec.value = Math.round((state.customLapTime % 60) * 10) / 10;
    } else {
      els.ltMin.value = '';
      els.ltSec.value = '';
    }
    els.ltMin.placeholder = d.defaultLapTime ? String(Math.floor(d.defaultLapTime / 60)) : 'm';
    els.ltSec.placeholder = d.defaultLapTime ? (d.defaultLapTime % 60).toFixed(1) : 's';
    els.ltHint.textContent = state.customLapTime == null
      ? (d.defaultLapTime ? `Auto — ${DATA.formatLapTime(d.defaultLapTime)} default for this track & class.` : 'Auto — pick a track and class first.')
      : 'Manual override — clear both fields to go back to auto.';

    // Consumption override.
    const unit = d.isVE ? '%' : 'L';
    els.consumptionLabel.textContent = d.isVE ? 'Energy per lap (%)' : 'Fuel per lap (L)';
    els.consumption.value = state.customConsumption ?? '';
    els.consumption.placeholder = d.defaultConsumption ?? '';
    els.consumptionHint.textContent = state.customConsumption == null
      ? (d.defaultConsumption
        ? `Auto — ${d.defaultConsumption}${unit}/lap default for this car${d.isVE ? ' (derived; the in-game HUD value is better)' : ''}.`
        : 'Auto — pick a car and track first.')
      : 'Manual override — clear the field to go back to auto.';

    els.safety.value = state.safetyLaps;
    els.formation.checked = state.formationLap;

    // Tank override — meaningless under Virtual Energy (tank is always 100%).
    els.tankField.hidden = d.isVE;
    els.tank.value = state.customTankCapacity ?? '';
    els.tank.placeholder = d.defaultTank ?? '';
    els.tankHint.textContent = state.customTankCapacity == null
      ? (d.defaultTank ? `Auto — ${d.defaultTank}L default for this car.` : 'Auto — pick a car first.')
      : 'Manual override — clear the field to go back to auto.';

    for (const btn of els.stintSeg.querySelectorAll('[data-fuelstint]')) {
      btn.setAttribute('data-active', String(btn.dataset.fuelstint === state.stintMode));
    }

    // Pit parameters always display the resolved value; overriding one field
    // does not freeze the others (the refuel-rate default keeps tracking the
    // class's unit until the driver touches it).
    els.pitLoss.value = d.pit.pitLaneLossSec;
    els.pitRate.value = d.pit.refuelRatePerSec;
    els.pitRateLabel.textContent = d.isVE ? 'Refuel rate (%/s)' : 'Refuel rate (L/s)';
    els.pitTyres.value = d.pit.tyreChangeSec;
    els.pitEvery.value = d.pit.tyresEveryStints;
    els.pitReset.hidden = Object.keys(state.pitOverrides).length === 0;
  }

  // ── Result rendering ────────────────────────────────────────────────────
  function renderResult(d) {
    if (!d.inputs) {
      els.empty.hidden = false;
      els.result.hidden = true;
      els.result.innerHTML = '';
      return;
    }
    const plan = ENGINE.buildStrategy(d.inputs);
    if (!plan) {
      els.empty.hidden = true;
      els.result.hidden = false;
      els.result.innerHTML = `
        <div class="fuel-warn">${icon('alert')}<span>No feasible plan: one full tank does not cover a single lap at this consumption. Check the per-lap value.</span></div>`;
      return;
    }
    const options = ENGINE.compareStopOptions(d.inputs);
    const u = plan.units;
    const fmt = ENGINE.formatDuration;

    const heroSub = [
      plan.useVirtualEnergy ? `${plan.tanksNeeded} energy tanks` : null,
      plan.safetyUnits > 0 ? `includes ${plan.safetyUnits}${u} safety margin` : null,
      plan.formationUnits > 0 ? `formation lap ${plan.formationUnits}${u}` : null,
    ].filter(Boolean).join(' · ');

    const tiles = [
      ['Race laps', String(plan.raceLaps), true],
      ['Pit stops', String(plan.stops), true],
      ['Race time', fmt(plan.totalTimeSec), false],
      ['Time in pits', fmt(plan.totalPitTimeSec), false],
      ['Max laps / stint', String(plan.maxLapsPerStint), false],
      [plan.useVirtualEnergy ? 'Energy / lap' : 'Fuel / lap', `${plan.consumptionPerLap}${u}`, false],
      ['Starting fill', `${plan.startingFill}${u}`, false],
      ['Lap time', DATA.formatLapTime(plan.lapTimeSec), false],
    ].map(([label, value, accent]) => `
      <div class="fuel-tile${accent ? ' fuel-tile--accent' : ''}">
        <div class="fuel-tile__label">${label}</div>
        <div class="fuel-tile__value">${value}</div>
      </div>`).join('');

    const stints = plan.stints.map((st) => {
      const stop = st.stopAfter ? `
        <div class="fuel-stop">${icon('timer')}<span>Pit stop ${st.index} —
          refuel <b>${st.stopAfter.refuelSec}s</b>${st.stopAfter.tyreSec > 0 ? ` + tyres <b>${st.stopAfter.tyreSec}s</b>` : ''}
          · <b>${st.stopAfter.totalSec}s</b> total</span></div>` : '';
      return `
        <div class="fuel-stint">
          <span class="fuel-stint__badge">${st.index}</span>
          <span class="fuel-stint__name">Stint ${st.index}</span>
          ${st.splash ? '<span class="fuel-stint__tag">Splash</span>' : ''}
          <span class="fuel-stint__spacer"></span>
          <span class="fuel-stint__fill">${st.fill}${u}</span>
          <span class="fuel-stint__laps">${st.laps} laps</span>
        </div>${stop}`;
    }).join('');

    const alts = options.filter((o) => !o.current).map((o) => {
      const fewer = o.savingPct != null;
      let sub;
      if (fewer) {
        sub = `Save ${o.savingPct}% per lap`;
        if (o.lapsDelta > 0) sub += ` — gains ~${o.lapsDelta} lap${o.lapsDelta === 1 ? '' : 's'} of track time`;
        else if (o.deltaSec < 0) sub += ` — saves ~${fmt(-o.deltaSec)}`;
        if (!o.feasible) sub += ' · unrealistic saving target';
      } else {
        sub = `Push up to ${o.perLapTarget}${u}/lap at the cost of an extra stop`;
        if (o.lapsDelta < 0) sub += ` (~${-o.lapsDelta} lap${o.lapsDelta === -1 ? '' : 's'} lost)`;
        else if (o.deltaSec > 0) sub += ` (+${fmt(o.deltaSec)})`;
      }
      return `
        <div class="fuel-alt${fewer ? ' fuel-alt--save' : ''}" data-feasible="${o.feasible}">
          ${icon(fewer ? 'trending-up' : 'timer')}
          <div>
            <div class="fuel-alt__title">${o.stops} stop${o.stops === 1 ? '' : 's'}
              <span class="fuel-alt__target">${o.perLapTarget}${u}/lap</span></div>
            <div class="fuel-alt__sub">${sub}</div>
          </div>
        </div>`;
    }).join('');

    els.empty.hidden = true;
    els.result.hidden = false;
    els.result.innerHTML = `
      <div class="fuel-hero">
        <div class="fuel-hero__label">${plan.useVirtualEnergy ? 'Total Virtual Energy' : 'Total fuel required'}</div>
        <div class="fuel-hero__value">${plan.totalUnits}<small>${u}</small></div>
        ${heroSub ? `<div class="fuel-hero__sub">${heroSub}</div>` : ''}
      </div>
      ${plan.warnings.map((w) => `<div class="fuel-warn">${icon('alert')}<span>${esc(w)}</span></div>`).join('')}
      <div class="fuel-tiles">${tiles}</div>
      <div class="fuel-section">${icon('list-ordered')}Stint plan</div>
      <div class="fuel-stints">${stints}</div>
      ${alts ? `<div class="fuel-section">${icon('target')}Alternative strategies</div><div class="fuel-alts">${alts}</div>` : ''}
      <div class="fuel-foot">
        <span>${esc(d.car.name)} · ${esc(d.circuit.name)} — ${esc(d.layout.name)}</span>
        <span>${plan.useVirtualEnergy ? 'Virtual Energy tank: 100%' : `Fuel tank capacity: ${plan.tankCapacity}L`}</span>
      </div>`;
  }

  function update() {
    const d = derive();
    syncControls(d);
    renderResult(d);
    save();
  }

  // ── Input helpers ───────────────────────────────────────────────────────
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  function numOrNull(raw) {
    const v = parseFloat(raw);
    return Number.isFinite(v) ? v : null;
  }

  // ── Wiring ──────────────────────────────────────────────────────────────
  els.circuit.addEventListener('change', () => {
    state.circuitId = els.circuit.value;
    const c = DATA.getCircuit(state.circuitId);
    // A circuit with a single layout selects it for you.
    state.layoutId = c && c.layouts.length === 1 ? c.layouts[0].id : '';
    update();
  });
  els.layout.addEventListener('change', () => { state.layoutId = els.layout.value; update(); });

  els.cls.addEventListener('change', () => {
    state.classId = els.cls.value;
    state.carId = '';
    makerFilter = '';
    // Units flip between litres and %, so class-specific overrides reset.
    state.customConsumption = null;
    state.customTankCapacity = null;
    update();
  });
  els.maker.addEventListener('change', () => {
    makerFilter = els.maker.value;
    const cars = DATA.CARS[state.classId] || [];
    const car = cars.find((c) => c.id === state.carId);
    if (makerFilter && car && makerOf(car.name) !== makerFilter) state.carId = '';
    update();
  });
  els.car.addEventListener('change', () => { state.carId = els.car.value; update(); });

  els.modeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fuelmode]');
    if (!btn) return;
    state.raceMode = btn.dataset.fuelmode;
    update();
  });
  els.chips.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-minutes]');
    if (!chip) return;
    state.raceMinutes = Number(chip.dataset.minutes);
    update();
  });
  els.minutes.addEventListener('change', () => {
    const v = numOrNull(els.minutes.value);
    if (v != null) state.raceMinutes = clamp(Math.round(v), 1, 1440);
    update();
  });
  els.laps.addEventListener('change', () => {
    const v = numOrNull(els.laps.value);
    if (v != null) state.raceLaps = clamp(Math.round(v), 1, 500);
    update();
  });

  function commitLapTime() {
    const m = numOrNull(els.ltMin.value);
    const s = numOrNull(els.ltSec.value);
    if (m == null && s == null) { state.customLapTime = null; update(); return; }
    const total = clamp(m ?? 0, 0, 59) * 60 + clamp(s ?? 0, 0, 59.9);
    const d = derive();
    state.customLapTime = total <= 0 || total === d.defaultLapTime ? null : total;
    update();
  }
  els.ltMin.addEventListener('change', commitLapTime);
  els.ltSec.addEventListener('change', commitLapTime);

  els.consumption.addEventListener('change', () => {
    const v = numOrNull(els.consumption.value);
    const d = derive();
    if (v == null || v <= 0) state.customConsumption = null;
    else if (d.defaultConsumption != null && Math.abs(v - d.defaultConsumption) < 0.001) state.customConsumption = null;
    else state.customConsumption = Math.round(clamp(v, 0.01, 99) * 100) / 100;
    update();
  });

  els.safety.addEventListener('change', () => {
    const v = numOrNull(els.safety.value);
    if (v != null) state.safetyLaps = clamp(Math.round(v), 0, 10);
    update();
  });
  els.formation.addEventListener('change', () => { state.formationLap = els.formation.checked; update(); });

  els.tank.addEventListener('change', () => {
    const v = numOrNull(els.tank.value);
    const d = derive();
    if (v == null || v <= 0) state.customTankCapacity = null;
    else {
      const clamped = clamp(Math.round(v), 20, 150);
      state.customTankCapacity = clamped === d.defaultTank ? null : clamped;
    }
    update();
  });

  els.stintSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fuelstint]');
    if (!btn) return;
    state.stintMode = btn.dataset.fuelstint;
    update();
  });

  function wirePit(input, key, min, max, round) {
    input.addEventListener('change', () => {
      const v = numOrNull(input.value);
      if (v == null) { delete state.pitOverrides[key]; update(); return; }
      const clamped = clamp(round ? Math.round(v) : v, min, max);
      state.pitOverrides = { ...state.pitOverrides, [key]: clamped };
      update();
    });
  }
  wirePit(els.pitLoss, 'pitLaneLossSec', 5, 120, true);
  wirePit(els.pitRate, 'refuelRatePerSec', 0.1, 10, false);
  wirePit(els.pitTyres, 'tyreChangeSec', 0, 120, true);
  wirePit(els.pitEvery, 'tyresEveryStints', 0, 10, true);
  els.pitReset.addEventListener('click', () => { state.pitOverrides = {}; update(); });

  els.reset.addEventListener('click', () => {
    // Race length survives on purpose — you replan the same race for a new
    // car far more often than you change the race.
    state = {
      ...DEFAULT_STATE,
      raceMode: state.raceMode,
      raceMinutes: state.raceMinutes,
      raceLaps: state.raceLaps,
    };
    makerFilter = '';
    update();
  });

  update();
})();
