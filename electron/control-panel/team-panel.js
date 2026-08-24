/**
 * team-panel.js — the Team tab: a pit-wall view of the race.
 * -----------------------------------------------------------------------------
 * Phase 1.5 of docs/TEAM-ENGINEER-PAGE.md: four sections under one page —
 * Timing (the full class-grouped sheet), Positions (the race drawn per lap),
 * Strategy (fuel + tyre planning to the flag), Telemetry (track map, tyre
 * widgets, car state, weather, lap-time comparison). All of it renders from
 * main's 1 Hz snapshot (electron/team-snapshot.js) plus two revision-cached
 * extras: the race history (electron/team-history.js) and the learned circuit
 * shape. When the team relay lands, the same payload arrives from a
 * teammate's machine and everything here works unchanged.
 *
 * Zero-cost-when-hidden, enforced the same way as the Setups tab: the router
 * calls shown()/hidden(), shown() subscribes main's pusher, hidden()
 * unsubscribes it. Within the page only the ACTIVE section renders — a canvas
 * repaint for a hidden section is pure waste at any rate. The one steady cost
 * while visible is a 1 s ticker for the data-age pill, which must move even
 * when frames stop (that is its job).
 *
 * The maths lives elsewhere on purpose: remaining-race fuel in team-fuel.js,
 * tyre projection in main (team-history.js), chart painting in
 * team-charts.js. This file wires and renders.
 */

(function () {
  'use strict';

  const PLANNER = window.APEX_TEAM_FUEL;
  const CHARTS = window.APEX_TEAM_CHARTS;
  if (!PLANNER || !CHARTS) return;

  const $ = (sel) => document.querySelector(sel);

  // ── State ────────────────────────────────────────────────────────────────
  const STORAGE_KEY = 'apex.panel.team';

  let prefs = { safetyLaps: 1, tab: 'timing', posMode: 'overall', hiddenPos: [], laptimeSel: [] };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (Number.isFinite(saved.safetyLaps)) prefs.safetyLaps = saved.safetyLaps;
    if (typeof saved.tab === 'string') prefs.tab = saved.tab;
    if (saved.posMode === 'class') prefs.posMode = 'class';
    if (Array.isArray(saved.hiddenPos)) prefs.hiddenPos = saved.hiddenPos;
    if (Array.isArray(saved.laptimeSel)) prefs.laptimeSel = saved.laptimeSel;
  } catch { /* corrupted save — defaults */ }

  const savePrefs = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { }
  };

  let snap = null;          // latest snapshot from main (null = nothing yet)
  let history = null;       // race history, cached across pushes by revision
  let mapShape = null;      // learned circuit shape, cached by revision
  let visible = false;
  let ageTimer = null;
  // Per-card render memo: innerHTML is only assigned when the markup actually
  // changed, so a 6-hour stint does not thrash layout once a second for cards
  // whose numbers are static.
  const lastHtml = new Map();

  // Lap-time selection is stored by driver NAME (slot ids are per-session);
  // resolved to slotIds against the current history on each render.
  const hiddenPos = new Set(prefs.hiddenPos);

  // ── Element refs (ids contracted in scripts/test-panel-parity.js) ───────
  const els = {
    age: $('#team-age'),
    empty: $('#team-empty'),
    live: $('#team-live'),
    session: $('#team-session'),
    subtabs: $('#team-subtabs'),
    tabTiming: $('#team-tab-timing'),
    tabPositions: $('#team-tab-positions'),
    tabStrategy: $('#team-tab-strategy'),
    tabTelemetry: $('#team-tab-telemetry'),
    timing: $('#team-timing-body'),
    posMode: $('#team-pos-mode'),
    posCanvas: $('#team-positions-canvas'),
    posLegend: $('#team-positions-legend'),
    fuel: $('#team-fuel-body'),
    tyreplan: $('#team-tyreplan-body'),
    strategy: $('#team-strategy-body'),
    safety: $('#team-safety'),
    mapCanvas: $('#team-map-canvas'),
    tyres: $('#team-tyres-body'),
    weather: $('#team-weather-body'),
    telemetry: $('#team-telemetry-body'),
    laptimeCanvas: $('#team-laptime-canvas'),
    laptimeLegend: $('#team-laptime-legend'),
  };

  const icon = (name) => (window.apexIcon ? window.apexIcon(name) : '');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ── Formatting ───────────────────────────────────────────────────────────
  const known = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const dash = '—';

  function fmtLap(sec) {
    if (!known(sec) || sec <= 0) return dash;
    const m = Math.floor(sec / 60);
    const s = (sec - m * 60).toFixed(3).padStart(6, '0');
    return `${m}:${s}`;
  }

  function fmtClock(sec) {
    if (!known(sec)) return dash;
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    return `${m}:${String(ss).padStart(2, '0')}`;
  }

  const fmt1 = (v) => (known(v) ? v.toFixed(1) : dash);
  const fmt2 = (v) => (known(v) ? v.toFixed(2) : dash);
  const fmt0 = (v) => (known(v) ? String(Math.round(v)) : dash);
  const fmtGap = (v) => (known(v) ? `+${v.toFixed(1)}` : dash);

  function setCard(el, html) {
    if (!el) return;
    if (lastHtml.get(el) === html) return;
    lastHtml.set(el, html);
    el.innerHTML = html;
  }

  const tile = (label, value, opts = {}) => `
    <div class="fuel-tile${opts.accent ? ' fuel-tile--accent' : ''}${opts.band ? ` team-band--${opts.band}` : ''}">
      <div class="fuel-tile__label">${label}</div>
      <div class="fuel-tile__value">${value}</div>
    </div>`;

  // ── The live fuel inputs ─────────────────────────────────────────────────
  function liveFuelInputs(fuel) {
    if (!fuel) return null;
    const ve = fuel.virtualEnergyPct != null && fuel.virtualEnergyPct >= 0;
    const level = ve ? fuel.virtualEnergyPct : fuel.levelLiters;
    const tank = ve ? 100 : fuel.capacityLiters;
    const perLap = ve ? fuel.virtualEnergyPerLapPct : fuel.perLapAvgLiters;
    const lapsToGo = fuel.lapsToFinish;
    if (![level, tank, perLap, lapsToGo].every(known) || perLap <= 0 || lapsToGo <= 0) {
      return { ve, unit: ve ? '%' : 'L', ready: false };
    }
    return { ve, unit: ve ? '%' : 'L', ready: true, level, tank, perLap, lapsToGo };
  }

  // ── Session strip ────────────────────────────────────────────────────────
  function renderSession(s) {
    const track = [s.track, s.trackConfig].filter(Boolean).join(' — ');
    const lap = known(s.currentLap)
      ? `Lap ${s.currentLap}${known(s.totalLaps) && s.totalLaps > 0 ? ` / ${s.totalLaps}` : ''}`
      : null;
    const bits = [
      `<span class="team-session__track">${esc(track || 'Unknown circuit')}</span>`,
      `<span class="team-session__meta">${esc([s.type, s.phase].filter(Boolean).join(' · '))}</span>`,
      known(s.timeRemainingSec) && s.timeRemainingSec > 0
        ? `<span class="team-session__meta">${icon('clock')}${fmtClock(s.timeRemainingSec)} left</span>` : null,
      lap ? `<span class="team-session__meta">${icon('list-ordered')}${esc(lap)}</span>` : null,
      known(s.numCars) ? `<span class="team-session__meta">${s.numCars} cars</span>` : null,
      s.serverName ? `<span class="team-session__meta team-session__server">${esc(s.serverName)}</span>` : null,
    ].filter(Boolean);
    setCard(els.session, bits.join(''));
  }

  // ── Timing sheet ─────────────────────────────────────────────────────────
  function renderTiming(standings) {
    if (!standings || !standings.length) {
      setCard(els.timing, `<p class="team-note">The timing sheet fills as the field appears.</p>`);
      return;
    }
    const anyVe = standings.some((r) => known(r.virtualEnergy));
    // Classes in the order their best-placed car runs overall.
    const byClass = new Map();
    for (const r of standings) {
      const cls = r.carClass || 'Unknown';
      if (!byClass.has(cls)) byClass.set(cls, []);
      byClass.get(cls).push(r);
    }
    const classes = Array.from(byClass.entries()).sort((a, b) => {
      const best = (rows) => Math.min(...rows.map((r) => (known(r.position) ? r.position : 999)));
      return best(a[1]) - best(b[1]);
    });

    const head = `
      <tr>
        <th>P</th><th>Ovr</th><th>#</th><th class="team-t__driver">Driver</th>
        <th>Pit</th><th>Stops</th>
        <th>Last</th><th>Best</th><th>Avg 5</th>
        <th>Gap</th><th>Int</th>
        ${anyVe ? '<th>VE</th>' : ''}<th>Tyre</th>
      </tr>`;

    const groups = classes.map(([cls, rows]) => {
      rows.sort((a, b) => {
        const ap = known(a.classPosition) ? a.classPosition : (known(a.position) ? a.position : 999);
        const bp = known(b.classPosition) ? b.classPosition : (known(b.position) ? b.position : 999);
        return ap - bp;
      });
      const color = CHARTS.classColor(cls);
      const body = rows.map((r) => {
        const gap = known(r.classLapsBehind) && r.classLapsBehind > 0
          ? `+${r.classLapsBehind}L`
          : fmtGap(r.gapToClassLeaderSec);
        return `
        <tr class="${r.isPlayer ? 'team-t__me' : ''}">
          <td>${fmt0(r.classPosition)}</td>
          <td class="team-t__dim">${fmt0(r.position)}</td>
          <td class="team-t__num">${r.carNumber != null ? esc(String(r.carNumber)) : ''}</td>
          <td class="team-t__driver">${esc(r.driverName || '')}</td>
          <td>${r.inPit ? '<span class="team-t__pit">PIT</span>' : ''}</td>
          <td>${fmt0(r.pitStops)}</td>
          <td>${fmtLap(r.lastLapSec)}</td>
          <td>${fmtLap(r.bestLapSec)}</td>
          <td>${fmtLap(r.avg5Sec)}</td>
          <td>${gap}</td>
          <td class="team-t__dim">${fmtGap(r.gapToAheadSec)}</td>
          ${anyVe ? `<td>${known(r.virtualEnergy) ? `${Math.round(r.virtualEnergy)}%` : dash}</td>` : ''}
          <td>${r.tyreCompound ? esc(String(r.tyreCompound)).slice(0, 6) : dash}</td>
        </tr>`;
      }).join('');
      return `
        <tr class="team-t__class"><td colspan="${anyVe ? 13 : 12}">
          <span class="team-t__dot" style="background:${color}"></span>${esc(cls)} · ${rows.length}
        </td></tr>${body}`;
    }).join('');

    setCard(els.timing, `
      <div class="team-t__wrap"><table class="team-t">
        <thead>${head}</thead><tbody>${groups}</tbody>
      </table></div>
      <p class="team-note">Gap is to the class leader; Int is to the car ahead overall.</p>`);
  }

  // ── Positions chart ──────────────────────────────────────────────────────
  function renderPositions() {
    if (!els.posCanvas) return;
    const cars = history && history.cars ? history.cars : [];
    CHARTS.drawPositions(els.posCanvas, history, {
      mode: prefs.posMode,
      hidden: hiddenPos,
      colorOf: (c, i) => CHARTS.driverColor(i),
    });
    const legend = cars.map((c, i) => `
      <button type="button" class="team-chip" data-slot="${c.slotId}"
              data-off="${hiddenPos.has(c.slotId)}"
              style="--chip:${CHARTS.driverColor(i)}">${esc(shortName(c))}</button>`).join('');
    setCard(els.posLegend, legend || '');
    for (const btn of els.posMode.querySelectorAll('[data-posmode]')) {
      btn.setAttribute('data-active', String(btn.dataset.posmode === prefs.posMode));
    }
  }

  function shortName(car) {
    const n = String(car.name || '').trim();
    const last = n.split(/\s+/).pop() || n;
    return (last.length > 3 ? last.slice(0, 3) : last).toUpperCase() || `#${car.num || car.slotId}`;
  }

  // ── Strategy: fuel card ──────────────────────────────────────────────────
  function renderFuel(fuel) {
    if (!fuel) {
      setCard(els.fuel, `<p class="team-note">No fuel data in this session.</p>`);
      return;
    }
    const li = liveFuelInputs(fuel);
    const ve = li && li.ve;
    const u = ve ? '%' : 'L';

    const level = ve ? fuel.virtualEnergyPct : fuel.levelLiters;
    const lapsLeft = ve ? fuel.virtualEnergyLapsRemaining : fuel.lapsRemaining;
    const perLap = ve ? fuel.virtualEnergyPerLapPct : fuel.perLapAvgLiters;
    const delta = ve ? fuel.virtualEnergyDeltaPct : fuel.fuelDeltaLiters;
    const deltaKnown = known(perLap) && typeof delta === 'number' && Number.isFinite(delta);

    const warn = fuel.pitThisLap
      ? `<div class="fuel-warn">${icon('alert')}<span><b>PIT THIS LAP</b> — not enough ${fuel.pitThisLapReason === 'energy' ? 'virtual energy' : 'fuel'} to come around again.</span></div>`
      : '';

    setCard(els.fuel, `
      ${warn}
      <div class="fuel-hero">
        <div class="fuel-hero__label">${ve ? 'Virtual Energy' : 'Fuel on board'}</div>
        <div class="fuel-hero__value">${known(level) ? fmt1(level) : dash}<small>${u}</small></div>
        <div class="fuel-hero__sub">${known(lapsLeft) ? `≈ ${fmt1(lapsLeft)} laps in the tank` : 'consumption still learning'}</div>
      </div>
      <div class="fuel-tiles team-tiles--3">
        ${tile(`Per lap`, `${fmt2(perLap)}${known(perLap) ? u : ''}`)}
        ${tile('Laps to flag', fmt1(fuel.lapsToFinish))}
        ${tile('At the flag', deltaKnown ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}${u}` : dash,
          deltaKnown ? { band: delta >= 0 ? 'ok' : 'bad', accent: true } : {})}
      </div>`);
  }

  // ── Strategy: remaining-race plan ────────────────────────────────────────
  function renderStrategy(fuel) {
    const li = liveFuelInputs(fuel);
    if (!li) {
      setCard(els.strategy, `<p class="team-note">No fuel data in this session.</p>`);
      return;
    }
    if (!li.ready) {
      setCard(els.strategy, `<p class="team-note">Learning the car — the plan appears once a lap of consumption and the race remaining are known.</p>`);
      return;
    }
    const plan = PLANNER.planRemaining({
      level: li.level, tank: li.tank, perLap: li.perLap,
      lapsToGo: li.lapsToGo, safetyLaps: prefs.safetyLaps,
    });
    if (!plan) {
      setCard(els.strategy, `<p class="team-note">Waiting for a usable consumption figure.</p>`);
      return;
    }
    const u = li.unit;

    const headline = plan.stops === 0
      ? `<div class="team-headline team-band--ok">${icon('check')}No more stops — ${plan.marginNoStop >= 0 ? '+' : ''}${plan.marginNoStop}${u} at the flag</div>`
      : `<div class="team-headline">${icon('timer')}${plan.stops} stop${plan.stops === 1 ? '' : 's'} to the flag</div>`;

    const window_ = plan.stops > 0
      ? `<p class="team-note">Pit window: ${plan.windowEarliest > 0 ? `in ${plan.windowEarliest}–${plan.windowLatest} laps` : `within ${plan.windowLatest} lap${plan.windowLatest === 1 ? '' : 's'}`} · dry in ${plan.lapsInTank}.</p>`
      : '';

    const fillText = (fill) => (fill == null ? '' : (li.ve ? `to ${fill}${u}` : `+${fill}${u}`));
    const stints = plan.stints.map((st) => `
      <div class="fuel-stint">
        <span class="fuel-stint__badge">${st.index}</span>
        <span class="fuel-stint__name">${st.current ? 'This stint' : `Stint ${st.index}`}</span>
        ${st.short ? '<span class="fuel-stint__tag">Tank-limited</span>' : ''}
        <span class="fuel-stint__spacer"></span>
        <span class="fuel-stint__fill">${fillText(st.fill)}</span>
        <span class="fuel-stint__laps">${st.laps} laps</span>
      </div>`).join('');

    const save = plan.saveTarget
      ? `<div class="fuel-alt fuel-alt--save" data-feasible="${plan.saveTarget.feasible}">
          ${icon('trending-up')}
          <div>
            <div class="fuel-alt__title">Save target <span class="fuel-alt__target">${plan.saveTarget.perLap}${u}/lap</span></div>
            <div class="fuel-alt__sub">Hit it and it's ${plan.saveTarget.stops === 0 ? 'no more stops' : `${plan.saveTarget.stops} stop${plan.saveTarget.stops === 1 ? '' : 's'}`} — a ${plan.saveTarget.savingPct}% save vs the current ${plan.perLap}${u}/lap${plan.saveTarget.feasible ? '' : ' · unrealistic by lift-and-coast alone'}.</div>
          </div>
        </div>`
      : '';

    const push = known(plan.pushCeiling) && plan.pushCeiling > plan.perLap
      ? `<p class="team-note">Room to push: up to ${plan.pushCeiling}${u}/lap costs one extra stop.</p>`
      : '';

    setCard(els.strategy, `${headline}${window_}<div class="fuel-stints">${stints}</div>${save}${push}`);
  }

  // ── Strategy: tyre plan ──────────────────────────────────────────────────
  const CORNER_LABELS = { fl: 'front-left', fr: 'front-right', rl: 'rear-left', rr: 'rear-right' };

  function renderTyrePlan(tyrePlan, fuel) {
    if (!tyrePlan) {
      setCard(els.tyreplan, `<p class="team-note">Wear rate appears after a couple of completed laps.</p>`);
      return;
    }
    const worst = tyrePlan.worstCorner;
    const rate = tyrePlan.ratePerLap[worst];
    const cliff = tyrePlan.lapsTo25;
    const li = liveFuelInputs(fuel);
    // The call an engineer actually wants: do the tyres outlast the fuel stint?
    let verdict = '';
    if (cliff != null && li && li.ready) {
      const fuelStint = Math.floor(li.level / li.perLap);
      verdict = cliff >= fuelStint
        ? `<div class="team-headline team-band--ok">${icon('check')}Tyres outlast the fuel stint (${cliff} vs ${fuelStint} laps)</div>`
        : `<div class="team-headline team-band--warn">${icon('alert')}${CORNER_LABELS[worst]} hits the cliff ~${cliff} laps in — before the fuel stop (~${fuelStint})</div>`;
    }
    const perCorner = ['fl', 'fr', 'rl', 'rr'].map((c) =>
      `${c.toUpperCase()} ${(tyrePlan.ratePerLap[c] * 100).toFixed(2)}%/lap`).join(' · ');
    setCard(els.tyreplan, `
      ${verdict}
      <div class="fuel-tiles team-tiles--3">
        ${tile('Worst corner', worst.toUpperCase(), { band: cliff != null && cliff < 10 ? 'warn' : 'ok' })}
        ${tile('Wear rate', `${(rate * 100).toFixed(2)}%/lap`)}
        ${tile('Laps to cliff', cliff != null ? String(cliff) : dash, cliff != null && cliff < 5 ? { band: 'bad' } : {})}
      </div>
      <p class="team-note">${perCorner}</p>
      <p class="team-note">Measured over the last laps (as of lap ${tyrePlan.asOfLap}); the cliff is 25% tread remaining.</p>`);
  }

  // ── Telemetry: tyres, car, weather, map, lap times ───────────────────────
  const CORNERS = [
    ['frontLeft', 'FL'], ['frontRight', 'FR'],
    ['rearLeft', 'RL'], ['rearRight', 'RR'],
  ];

  function wearBand(wear) {
    if (!known(wear)) return null;
    if (wear > 0.5) return 'ok';
    if (wear > 0.25) return 'warn';
    return 'bad';
  }

  function bandBars(t) {
    const bands = [t.innerC, t.middleC, t.outerC];
    if (!bands.every(known)) return '';
    const h = (c) => Math.round(Math.min(100, Math.max(8, ((c - 40) / 90) * 100)));
    const state = (c) => {
      if (!known(t.optimalTempC)) return 'flat';
      const d = c - t.optimalTempC;
      if (d > 10) return 'hot';
      if (d < -12) return 'cold';
      return 'ok';
    };
    return `<span class="team-tyre__bars" title="Inner / middle / outer tread (inner layer)">
      ${bands.map((c) => `<i data-heat="${state(c)}" style="height:${h(c)}%"></i>`).join('')}
    </span>`;
  }

  function renderTyres(tyres) {
    if (!tyres) {
      setCard(els.tyres, `<p class="team-note">No tyre data — the shared-memory plugin publishes this only while the car is on track.</p>`);
      return;
    }
    const compounds = new Set(CORNERS.map(([k]) => tyres[k] && tyres[k].compound).filter(Boolean));
    const corners = CORNERS.map(([key, label]) => {
      const t = tyres[key];
      if (!t) return `<div class="team-tyre"><div class="team-tyre__corner">${label}</div><div class="team-tyre__wear">${dash}</div></div>`;
      const band = wearBand(t.wear);
      const inWindow = known(t.tempC) && known(t.optimalTempC)
        ? Math.abs(t.tempC - t.optimalTempC) <= 8 : null;
      return `
        <div class="team-tyre${band ? ` team-band--${band}` : ''}">
          <div class="team-tyre__top">
            <span class="team-tyre__corner">${label}</span>
            <span class="team-tyre__wearwrap">
              <span class="team-tyre__wear">${known(t.wear) ? `${(t.wear * 100).toFixed(1)}%` : dash}</span>
              <span class="team-tyre__cap">tyre left</span>
            </span>
          </div>
          <div class="team-tyre__mid">
            <span class="team-tyre__kpa">${known(t.pressureKpa) ? `<b>${t.pressureKpa.toFixed(0)}</b><i>kPa</i>` : dash}</span>
            ${bandBars(t)}
            <span class="team-tyre__temps">
              <b>${known(t.tempC) ? `${Math.round(t.tempC)}°` : dash}</b>
              <i>${known(t.brakeTempC) ? `Brake ${Math.round(t.brakeTempC)}°C` : ''}</i>
            </span>
          </div>
          ${inWindow != null ? `<div class="team-tyre__row"><span class="team-tyre__win" data-in="${inWindow}">${inWindow ? 'in window' : 'out of window'}</span></div>` : ''}
        </div>`;
    }).join('');
    setCard(els.tyres, `
      ${compounds.size ? `<p class="team-note">${esc(Array.from(compounds).join(' / '))} fitted · temps are the inner-layer average, bars inner/middle/outer</p>` : ''}
      <div class="team-tyres">${corners}</div>`);
  }

  function renderTelemetry(car) {
    if (!car) { setCard(els.telemetry, ''); return; }
    const gearText = !known(car.gear) && car.gear !== 0 && car.gear !== -1 ? dash
      : car.gear === 0 ? 'N' : car.gear === -1 ? 'R' : String(car.gear);
    const tyres = car.tyres;
    const worstWear = tyres
      ? Math.min(...CORNERS.map(([k]) => (tyres[k] && known(tyres[k].wear) ? tyres[k].wear : Infinity)))
      : Infinity;
    const pitPhase = car.pit && car.pit.phase && car.pit.phase !== 'none' ? car.pit.phase : null;
    const pitText = pitPhase
      ? (car.pit.working ? `stopped ${fmt0(car.pit.elapsedSec)}s` : pitPhase)
      : (car.inPit ? 'in pit lane' : 'on track');
    const dmg = car.damage;
    const dmgText = dmg
      ? (dmg.hasDamage ? `${esc(dmg.worst || 'damage')}${known(dmg.repairSeconds) && dmg.repairSeconds > 0 ? ` · ${fmt0(dmg.repairSeconds)}s` : ''}` : 'clean')
      : dash;
    setCard(els.telemetry, `
      <div class="fuel-tiles team-tiles--4">
        ${tile('Speed', known(car.speedKph) ? `${car.speedKph} km/h` : dash)}
        ${tile('RPM', known(car.rpm) ? `${car.rpm}` : dash)}
        ${tile('Gear', gearText)}
        ${tile('Tyre life', Number.isFinite(worstWear) ? `${Math.round(worstWear * 100)}%` : dash,
          Number.isFinite(worstWear) ? { band: wearBand(worstWear) } : {})}
        ${tile('Pit status', esc(pitText), pitPhase || car.inPit ? { band: 'warn' } : { band: 'ok' })}
        ${tile('Pit limiter', car.pit && car.pit.limiterOn != null ? (car.pit.limiterOn ? 'ON' : 'OFF') : dash,
          car.pit && car.pit.limiterOn ? { band: 'warn' } : {})}
        ${tile('Damage', dmgText, dmg && dmg.hasDamage ? { band: 'bad' } : { band: 'ok' })}
        ${car.hybrid && known(car.hybrid.chargeFraction)
          ? tile('Hybrid', `${Math.round(car.hybrid.chargeFraction * 100)}%`)
          : tile('Position', `${known(car.classPosition) ? `P${car.classPosition}` : dash} <small>in class</small>`)}
      </div>
      <div class="fuel-tiles team-tiles--3">
        ${tile('Last lap', fmtLap(car.lap && car.lap.last))}
        ${tile('Best lap', fmtLap(car.lap && car.lap.best))}
        ${tile('Pit stops', fmt0(car.pitStops))}
      </div>`);
  }

  function renderWeather(w) {
    if (!w) { setCard(els.weather, `<p class="team-note">No weather data.</p>`); return; }
    const nowBits = [
      w.trackCondition ? `<b>${esc(w.trackCondition)}</b>` : null,
      w.trackTrend && w.trackTrend !== 'steady' ? esc(w.trackTrend) : null,
      known(w.trackTempC) ? `track ${Math.round(w.trackTempC)}°` : null,
      known(w.ambientTempC) ? `air ${Math.round(w.ambientTempC)}°` : null,
      known(w.rainIntensity) && w.rainIntensity > 0 ? `rain ${Math.round(w.rainIntensity * 100)}%` : null,
      known(w.trackWetness) && w.trackWetness > 0.005 ? `wetness ${Math.round(w.trackWetness * 100)}%` : null,
      known(w.trackSpread) && w.trackSpread > 0.15 ? 'uneven surface' : null,
    ].filter(Boolean).join(' · ');

    const slots = (w.forecast || []).map((f) => {
      const when = f.label || (f.minutesAhead === 0 ? 'NOW' : `+${f.minutesAhead}m`);
      const chance = known(f.rainChance) ? Math.round(f.rainChance * 100) : null;
      return `
        <div class="team-wx" data-rain="${chance != null && chance >= 50}">
          <div class="team-wx__when">${esc(when)}</div>
          <div class="team-wx__chance">${chance != null ? `${chance}%` : dash}</div>
          <div class="team-wx__bar"><span style="width:${known(f.rainIntensity) ? Math.round(f.rainIntensity * 100) : 0}%"></span></div>
        </div>`;
    }).join('');

    setCard(els.weather, `
      <p class="team-note">${nowBits || 'Conditions unknown.'}</p>
      ${slots ? `<div class="team-wxrow">${slots}</div>` : ''}`);
  }

  function renderMap() {
    if (!els.mapCanvas) return;
    const tm = snap && snap.trackMap;
    const classBySlot = new Map(
      (snap && snap.standings ? snap.standings : []).map((r) => [r.slotId, r.carClass]),
    );
    const progressText = tm && !tm.ready && known(tm.progress) && tm.progress > 0
      ? `Learning the track — ${Math.round(tm.progress * 100)}%`
      : undefined;
    CHARTS.drawTrackMap(
      els.mapCanvas,
      mapShape,
      tm ? tm.cars : [],
      (slotId) => classBySlot.get(slotId) || '',
      { progressText },
    );
  }

  function laptimeSelection(cars) {
    const byName = new Set(prefs.laptimeSel);
    let sel = new Set(cars.filter((c) => byName.has(c.name)).map((c) => c.slotId));
    if (!sel.size) {
      // Default: our car and its class rivals, capped to keep the chart legible.
      const me = cars.find((c) => c.isPlayer);
      const cls = me ? me.cls : '';
      for (const c of cars) {
        if (sel.size >= 6) break;
        if (c.isPlayer || (cls && c.cls === cls)) sel.add(c.slotId);
      }
    }
    return sel;
  }

  function renderLaptimes() {
    if (!els.laptimeCanvas) return;
    const cars = history && history.cars ? history.cars : [];
    const sel = laptimeSelection(cars);
    CHARTS.drawLapTimes(els.laptimeCanvas, history, {
      selected: sel,
      colorOf: (c, i) => CHARTS.driverColor(i),
    });
    const legend = cars.map((c, i) => `
      <button type="button" class="team-chip" data-ltslot="${c.slotId}" data-ltname="${esc(c.name)}"
              data-off="${!sel.has(c.slotId)}"
              style="--chip:${CHARTS.driverColor(i)}">${esc(shortName(c))}</button>`).join('');
    setCard(els.laptimeLegend, legend || '');
  }

  // ── Age pill — the page must wear its data age visibly ──────────────────
  function renderAge() {
    if (!els.age) return;
    if (!snap) {
      els.age.dataset.state = 'none';
      els.age.textContent = 'NO DATA';
      return;
    }
    const ageSec = Math.max(0, (Date.now() - snap.at) / 1000);
    if (ageSec > 5) {
      els.age.dataset.state = 'stale';
      els.age.textContent = `STALE ${Math.round(ageSec)}s`;
    } else if (!snap.connected) {
      els.age.dataset.state = 'demo';
      els.age.textContent = 'DEMO FEED';
    } else {
      els.age.dataset.state = 'live';
      els.age.textContent = 'LIVE';
    }
  }

  // ── Sub-tab router ───────────────────────────────────────────────────────
  const TABS = {
    timing: () => renderTiming(snap.standings),
    positions: () => renderPositions(),
    strategy: () => {
      renderFuel(snap.fuel);
      renderStrategy(snap.fuel);
      renderTyrePlan(snap.tyrePlan, snap.fuel);
    },
    telemetry: () => {
      renderMap();
      renderTyres(snap.car && snap.car.tyres);
      renderTelemetry(snap.car);
      renderWeather(snap.weather);
      renderLaptimes();
    },
  };

  function setTab(name) {
    const tab = TABS[name] ? name : 'timing';
    prefs.tab = tab;
    savePrefs();
    const sections = {
      timing: els.tabTiming, positions: els.tabPositions,
      strategy: els.tabStrategy, telemetry: els.tabTelemetry,
    };
    for (const [key, el] of Object.entries(sections)) {
      if (el) el.setAttribute('data-active', String(key === tab));
    }
    for (const btn of els.subtabs.querySelectorAll('[data-teamtab]')) {
      btn.setAttribute('data-active', String(btn.dataset.teamtab === tab));
    }
    if (snap) TABS[tab]();
  }

  function renderAll() {
    renderAge();
    const has = !!snap;
    if (els.empty) els.empty.hidden = has;
    if (els.live) els.live.hidden = !has;
    if (!has) return;
    renderSession(snap.session);
    TABS[TABS[prefs.tab] ? prefs.tab : 'timing']();
  }

  // ── Wiring ──────────────────────────────────────────────────────────────
  if (els.safety) {
    els.safety.value = prefs.safetyLaps;
    els.safety.addEventListener('change', () => {
      const v = parseFloat(els.safety.value);
      prefs.safetyLaps = Number.isFinite(v) ? Math.min(10, Math.max(0, Math.round(v))) : 1;
      els.safety.value = prefs.safetyLaps;
      savePrefs();
      if (snap) { renderStrategy(snap.fuel); renderTyrePlan(snap.tyrePlan, snap.fuel); }
    });
  }

  if (els.subtabs) {
    els.subtabs.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-teamtab]');
      if (btn) setTab(btn.dataset.teamtab);
    });
  }
  if (els.posMode) {
    els.posMode.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-posmode]');
      if (!btn) return;
      prefs.posMode = btn.dataset.posmode === 'class' ? 'class' : 'overall';
      savePrefs();
      renderPositions();
    });
  }
  if (els.posLegend) {
    els.posLegend.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-slot]');
      if (!btn) return;
      const slot = Number(btn.dataset.slot);
      if (hiddenPos.has(slot)) hiddenPos.delete(slot);
      else hiddenPos.add(slot);
      prefs.hiddenPos = Array.from(hiddenPos);
      savePrefs();
      lastHtml.delete(els.posLegend); // the chip states changed
      renderPositions();
    });
  }
  if (els.laptimeLegend) {
    els.laptimeLegend.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ltslot]');
      if (!btn || !history) return;
      const cars = history.cars || [];
      const sel = laptimeSelection(cars);
      const slot = Number(btn.dataset.ltslot);
      if (sel.has(slot)) sel.delete(slot);
      else sel.add(slot);
      // Persist by name so the pick survives a session's slot reshuffle.
      prefs.laptimeSel = cars.filter((c) => sel.has(c.slotId)).map((c) => c.name);
      savePrefs();
      lastHtml.delete(els.laptimeLegend);
      renderLaptimes();
    });
  }

  // The push listener lives for the app's lifetime; main only sends while
  // this tab is subscribed, so there is nothing to unhook on hidden().
  window.apex.onTeamUpdate((snapshot) => {
    if (snapshot) {
      // History and the map shape ride only when their revision moved (or on
      // subscribe); keep the last known copy across the pushes in between.
      if (snapshot.history) history = snapshot.history;
      if (snapshot.mapShape) mapShape = snapshot.mapShape;
      snap = snapshot;
    } else {
      snap = null;
    }
    if (visible) renderAll();
  });

  window.apexTeam = {
    shown() {
      if (visible) return;
      visible = true;
      window.apex.teamSubscribe().then((snapshot) => {
        if (snapshot) {
          if (snapshot.history) history = snapshot.history;
          if (snapshot.mapShape) mapShape = snapshot.mapShape;
          snap = snapshot;
        }
        if (visible) renderAll();
      });
      setTab(prefs.tab);
      renderAll();
      if (!ageTimer) ageTimer = setInterval(renderAge, 1000);
    },
    hidden() {
      if (!visible) return;
      visible = false;
      window.apex.teamUnsubscribe();
      if (ageTimer) { clearInterval(ageTimer); ageTimer = null; }
    },
  };
})();
