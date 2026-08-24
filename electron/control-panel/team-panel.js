/**
 * team-panel.js — the Team tab: a pit-wall view of the car.
 * -----------------------------------------------------------------------------
 * Phase 1 of docs/TEAM-ENGINEER-PAGE.md: an engineer screen for OUR car, fed
 * from local telemetry. Main prunes the live frame to a 1 Hz snapshot
 * (electron/team-snapshot.js) and pushes it over `team:update`; this file only
 * renders. When the team relay lands, the same snapshot shape arrives from a
 * teammate's machine and everything here works unchanged.
 *
 * Zero-cost-when-hidden, enforced the same way as the Setups tab: the router
 * calls shown()/hidden(), shown() subscribes main's pusher, hidden()
 * unsubscribes it — while another view is active main does not even build
 * snapshots. The one steady cost while visible is a 1 s ticker for the
 * data-age pill, which must move even when frames stop (that is its job).
 *
 * The dynamic fuel plan is team-fuel.js (window.APEX_TEAM_FUEL) on live
 * inputs: what the car is actually burning, against the race actually left.
 */

(function () {
  'use strict';

  const PLANNER = window.APEX_TEAM_FUEL;
  if (!PLANNER) return;

  const $ = (sel) => document.querySelector(sel);

  // ── State ────────────────────────────────────────────────────────────────
  const STORAGE_KEY = 'apex.panel.team';

  let prefs = { safetyLaps: 1 };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (Number.isFinite(saved.safetyLaps)) prefs.safetyLaps = saved.safetyLaps;
  } catch { /* corrupted save — defaults */ }

  const savePrefs = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { }
  };

  let snap = null;          // latest snapshot from main (null = nothing yet)
  let visible = false;
  let ageTimer = null;
  // Per-card render memo: innerHTML is only assigned when the markup actually
  // changed, so a 6-hour stint does not thrash layout once a second for cards
  // whose numbers are static (weather, session between laps).
  const lastHtml = new Map();

  // ── Element refs (ids contracted in scripts/test-panel-parity.js) ───────
  const els = {
    age: $('#team-age'),
    empty: $('#team-empty'),
    live: $('#team-live'),
    session: $('#team-session'),
    fuel: $('#team-fuel-body'),
    tyres: $('#team-tyres-body'),
    strategy: $('#team-strategy-body'),
    weather: $('#team-weather-body'),
    car: $('#team-car-body'),
    safety: $('#team-safety'),
  };

  const icon = (name) => (window.apexIcon ? window.apexIcon(name) : '');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ── Formatting ───────────────────────────────────────────────────────────
  // The feed's "unknown" sentinel is -1; a page that renders it as a number
  // would be lying with confidence, so every read goes through these.
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
  /**
   * The car plans in whichever budget the sim says it runs: a car publishing
   * Virtual Energy plans in %, everything else in litres. Sim truth, not a
   * class lookup table — a snapshot, unlike the Fuel tab, has the actual car.
   */
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

  // ── Renderers ────────────────────────────────────────────────────────────
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
    // The delta shares the -1 sentinel with a genuine -1 shortfall, so it is
    // only shown once consumption is known — the calculator publishes both
    // together, which disambiguates.
    const deltaKnown = known(perLap) && typeof delta === 'number' && Number.isFinite(delta);

    const warn = fuel.pitThisLap
      ? `<div class="fuel-warn">${icon('alert')}<span><b>PIT THIS LAP</b> — not enough ${fuel.pitThisLapReason === 'energy' ? 'virtual energy' : 'fuel'} to come around again.</span></div>`
      : '';

    setCard(els.fuel, `
      ${warn}
      <div class="fuel-hero">
        <div class="fuel-hero__label">${ve ? 'Virtual Energy' : 'Fuel on board'}</div>
        <div class="fuel-hero__value">${known(level) ? (ve ? fmt1(level) : fmt1(level)) : dash}<small>${u}</small></div>
        <div class="fuel-hero__sub">${known(lapsLeft) ? `≈ ${fmt1(lapsLeft)} laps in the tank` : 'consumption still learning'}</div>
      </div>
      <div class="fuel-tiles team-tiles--3">
        ${tile(`Per lap`, `${fmt2(perLap)}${known(perLap) ? u : ''}`)}
        ${tile('Laps to flag', fmt1(fuel.lapsToFinish))}
        ${tile('At the flag', deltaKnown ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}${u}` : dash,
          deltaKnown ? { band: delta >= 0 ? 'ok' : 'bad', accent: true } : {})}
      </div>`);
  }

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
      const temp = known(t.tempC) ? `${Math.round(t.tempC)}°` : dash;
      const inWindow = known(t.tempC) && known(t.optimalTempC)
        ? Math.abs(t.tempC - t.optimalTempC) <= 8 : null;
      return `
        <div class="team-tyre${band ? ` team-band--${band}` : ''}">
          <div class="team-tyre__corner">${label}</div>
          <div class="team-tyre__wear">${known(t.wear) ? `${Math.round(t.wear * 100)}%` : dash}</div>
          <div class="team-tyre__row"><span>${icon('thermometer')}${temp}</span>${inWindow != null ? `<span class="team-tyre__win" data-in="${inWindow}">${inWindow ? 'in window' : 'out of window'}</span>` : ''}</div>
          <div class="team-tyre__row"><span>${known(t.pressureKpa) ? `${t.pressureKpa.toFixed(0)} kPa` : dash}</span></div>
        </div>`;
    }).join('');
    setCard(els.tyres, `
      ${compounds.size ? `<p class="team-note">${esc(Array.from(compounds).join(' / '))} fitted</p>` : ''}
      <div class="team-tyres">${corners}</div>`);
  }

  function renderCar(car, sessionType) {
    if (!car) { setCard(els.car, ''); return; }
    const pos = known(car.position) ? `P${car.position}` : dash;
    const cls = known(car.classPosition) ? `P${car.classPosition}` : dash;
    const pitPhase = car.pit && car.pit.phase && car.pit.phase !== 'none' ? car.pit.phase : null;
    const pitText = pitPhase
      ? (car.pit.working ? `stopped — ${fmt0(car.pit.elapsedSec)}s` : pitPhase)
      : (car.inPit ? 'in pit lane' : 'on track');
    const dmg = car.damage;
    const dmgText = dmg
      ? (dmg.hasDamage ? `${esc(dmg.worst || 'damage')}${known(dmg.repairSeconds) && dmg.repairSeconds > 0 ? ` · ${fmt0(dmg.repairSeconds)}s repair` : ''}` : 'clean')
      : dash;
    setCard(els.car, `
      <div class="fuel-tiles team-tiles--3">
        ${tile('Class', `${cls}`, { accent: true })}
        ${tile('Overall', pos)}
        ${tile('Pit stops', fmt0(car.pitStops))}
        ${tile('Last lap', fmtLap(car.lap && car.lap.last))}
        ${tile('Best lap', fmtLap(car.lap && car.lap.best))}
        ${tile('Car status', esc(pitText), pitPhase || car.inPit ? { band: 'warn' } : {})}
        ${tile('Damage', dmgText, dmg && dmg.hasDamage ? { band: 'bad' } : {})}
        ${car.hybrid && known(car.hybrid.chargeFraction) ? tile('Hybrid', `${Math.round(car.hybrid.chargeFraction * 100)}%`) : ''}
        ${car.carClass ? tile('Entry', `${car.carNumber != null ? `#${esc(String(car.carNumber))} · ` : ''}${esc(car.carClass)}`) : ''}
      </div>`);
  }

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

    // Litres are added ("+41L"); Virtual Energy is set to a level ("to 97%") —
    // matching how each reads in LMU's own pit menu.
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

    const push = plan.stops >= 0 && known(plan.pushCeiling) && plan.pushCeiling > plan.perLap
      ? `<p class="team-note">Room to push: up to ${plan.pushCeiling}${u}/lap costs one extra stop.</p>`
      : '';

    setCard(els.strategy, `${headline}${window_}<div class="fuel-stints">${stints}</div>${save}${push}`);
  }

  function renderWeather(w) {
    if (!w) { setCard(els.weather, `<p class="team-note">No weather data.</p>`); return; }
    const nowBits = [
      w.trackCondition ? `<b>${esc(w.trackCondition)}</b>` : null,
      w.trackTrend && w.trackTrend !== 'steady' ? esc(w.trackTrend) : null,
      known(w.trackTempC) ? `track ${Math.round(w.trackTempC)}°` : null,
      known(w.ambientTempC) ? `air ${Math.round(w.ambientTempC)}°` : null,
      known(w.rainIntensity) && w.rainIntensity > 0 ? `rain ${Math.round(w.rainIntensity * 100)}%` : null,
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

  function renderAll() {
    renderAge();
    const has = !!snap;
    if (els.empty) els.empty.hidden = has;
    if (els.live) els.live.hidden = !has;
    if (!has) return;
    renderSession(snap.session);
    renderFuel(snap.fuel);
    renderStrategy(snap.fuel);
    renderTyres(snap.car && snap.car.tyres);
    renderCar(snap.car, snap.session && snap.session.type);
    renderWeather(snap.weather);
  }

  // ── Wiring ──────────────────────────────────────────────────────────────
  if (els.safety) {
    els.safety.value = prefs.safetyLaps;
    els.safety.addEventListener('change', () => {
      const v = parseFloat(els.safety.value);
      prefs.safetyLaps = Number.isFinite(v) ? Math.min(10, Math.max(0, Math.round(v))) : 1;
      els.safety.value = prefs.safetyLaps;
      savePrefs();
      if (snap) renderStrategy(snap.fuel);
    });
  }

  // The push listener lives for the app's lifetime; main only sends while
  // this tab is subscribed, so there is nothing to unhook on hidden().
  window.apex.onTeamUpdate((snapshot) => {
    snap = snapshot || null;
    if (visible) renderAll();
  });

  window.apexTeam = {
    shown() {
      if (visible) return;
      visible = true;
      window.apex.teamSubscribe().then((snapshot) => {
        if (snapshot !== undefined) snap = snapshot;
        if (visible) renderAll();
      });
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
