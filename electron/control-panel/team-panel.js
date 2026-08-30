/**
 * team-panel.js — the Team tab: a pit-wall view of the race.
 * -----------------------------------------------------------------------------
 * Phase 1.5 of docs/TEAM-ENGINEER-PAGE.md: four sections under one page —
 * Timing (the full class-grouped sheet), Positions (the race drawn per lap),
 * Strategy (fuel + tyre planning to the flag), Telemetry (track map, tyre
 * widgets, car state, weather, lap-time comparison). All of it renders from
 * main's 1 Hz snapshot (electron/team-snapshot.js) plus two revision-cached
 * extras: the race history (electron/team-history.js) and the learned circuit
 * shape.
 *
 * Phase 2 adds the crew: a card for creating/joining teams by invite code
 * (electron/team-cloud.js), and a My car / Team source toggle. In Team view
 * every renderer below consumes the RELAYED snapshot — the same payload,
 * built by a teammate's machine and read from Supabase every ~3 s — through
 * the viewSnap()/viewHistory()/viewShape() accessors, so the four screens
 * work identically for both sources.
 *
 * Zero-cost-when-hidden, enforced the same way as the Setups tab: the router
 * calls shown()/hidden(), shown() subscribes main's pusher (and the relay
 * poll, in Team view), hidden() unsubscribes both. Within the page only the
 * ACTIVE section renders — a canvas repaint for a hidden section is pure
 * waste at any rate. The one steady cost while visible is a 1 s ticker for
 * the data-age pill, which must move even when frames stop (that is its job).
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

  let prefs = {
    safetyLaps: 1, tab: 'timing', posMode: 'overall',
    hiddenPos: [], laptimeSel: [], source: 'my',
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (Number.isFinite(saved.safetyLaps)) prefs.safetyLaps = saved.safetyLaps;
    if (typeof saved.tab === 'string') prefs.tab = saved.tab;
    if (saved.posMode === 'class') prefs.posMode = 'class';
    if (Array.isArray(saved.hiddenPos)) prefs.hiddenPos = saved.hiddenPos;
    if (Array.isArray(saved.laptimeSel)) prefs.laptimeSel = saved.laptimeSel;
    if (saved.source === 'team') prefs.source = 'team';
  } catch { /* corrupted save — defaults */ }

  const savePrefs = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { }
  };

  let snap = null;          // latest LOCAL snapshot from main (null = nothing yet)
  let history = null;       // local race history, cached across pushes by revision
  let mapShape = null;      // local learned circuit shape, cached by revision
  let cloud = null;         // teams/roster/publish state from team-cloud
  let relay = null;         // latest relay update (Team view's data source)
  let visible = false;
  let ageTimer = null;
  // Per-card render memo: innerHTML is only assigned when the markup actually
  // changed, so a 6-hour stint does not thrash layout once a second for cards
  // whose numbers are static.
  const lastHtml = new Map();

  // Lap-time selection is stored by driver NAME (slot ids are per-session);
  // resolved to slotIds against the current history on each render.
  const hiddenPos = new Set(prefs.hiddenPos);

  // ── Source accessors — every renderer reads through these ───────────────
  const teamView = () => prefs.source === 'team';
  const viewSnap = () => (teamView() ? (relay && relay.active ? relay.active.snapshot : null) : snap);
  const viewHistory = () => (teamView() ? (relay ? relay.history : null) : history);
  const viewShape = () => (teamView() ? (relay ? relay.mapShape : null) : mapShape);

  // ── Element refs (ids contracted in scripts/test-panel-parity.js) ───────
  const els = {
    age: $('#team-age'),
    source: $('#team-source'),
    crew: $('#team-crew'),
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

  /**
   * The driver's temperature unit, from Settings ▸ Appearance.
   *
   * The pit wall reads the same tyres the overlay does, so it has to print them
   * in the same unit — a teammate's front-left at 205 on the visor and 96 on
   * this page is the disagreement the app-wide setting exists to prevent. Only
   * the printing converts: `inWindow` below still judges in Celsius against the
   * sim's own optimum, as the tyre widget does.
   */
  let tempUnit = 'c';
  const degrees = (c) => (known(c) ? `${Math.round(tempUnit === 'f' ? c * 1.8 + 32 : c)}°` : dash);
  /** The same with the unit letter on it — for a figure that stands alone. */
  const degreesU = (c) => (known(c) ? `${degrees(c)}${tempUnit === 'f' ? 'F' : 'C'}` : dash);

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
    const driver = teamView() && relay && relay.active
      ? `<span class="team-session__meta">${icon('user')}${esc(relay.active.name || 'teammate')}'s car</span>`
      : null;
    const bits = [
      `<span class="team-session__track">${esc(track || 'Unknown circuit')}</span>`,
      driver,
      `<span class="team-session__meta">${esc([s.type, s.phase].filter(Boolean).join(' · '))}</span>`,
      known(s.timeRemainingSec) && s.timeRemainingSec > 0
        ? `<span class="team-session__meta">${icon('clock')}${fmtClock(s.timeRemainingSec)} left</span>` : null,
      lap ? `<span class="team-session__meta">${icon('list-ordered')}${esc(lap)}</span>` : null,
      known(s.numCars) ? `<span class="team-session__meta">${s.numCars} cars</span>` : null,
      s.serverName ? `<span class="team-session__meta team-session__server">${esc(s.serverName)}</span>` : null,
    ].filter(Boolean);
    setCard(els.session, bits.join(''));
  }

  /**
   * The Pit column. A retired car keeps every one of the sim's pit flags raised
   * for the rest of the race, so it must be tested first or a car that stopped
   * on lap 16 still reads "PIT" at the flag.
   */
  const pitCell = (r) => {
    if (r.retired) return '<span class="team-t__out">OUT</span>';
    return r.inPit ? '<span class="team-t__pit">PIT</span>' : '';
  };

  /**
   * A car's progress as one continuous number of laps, or `null` when the sim
   * placed no car on the track. The only scale on which two cars can honestly
   * be compared — see `classLapsBehindExact` on the server.
   */
  function progressOf(r) {
    const f = r && r.lapFraction;
    if (typeof f !== 'number' || !Number.isFinite(f) || f < 0 || f > 1) return null;
    return (known(r.lapsCompleted) ? r.lapsCompleted : 0) + f;
  }

  /**
   * A lap deficit, printed so it can be read ALONGSIDE the row above it.
   *
   * One decimal, not a whole number. `classLapsBehind` is floored per row, and
   * two floors do not subtract: at Daytona an LMP2 3.57 laps down printed +3L
   * and one 5.04 down printed +5L, so the sheet said two laps between cars that
   * were 1.47 apart — which is the whole reason this function exists. Falls
   * back to the floored count (with no decimal, so it is visibly the coarser
   * reading) when the sim published no track position to count from.
   */
  function fmtLapGap(exact, whole) {
    if (known(exact)) return `+${exact.toFixed(1)}L`;
    return known(whole) ? `+${whole}L` : dash;
  }

  /**
   * The signed gap from our own car to `r`, as the driver would say it: a car
   * in front is a negative number, one behind a positive one. Laps once the
   * pair is more than one apart, seconds below that.
   *
   * This is the column the sheet was missing. Every other gap on it is measured
   * to a leader or to the car ahead, so the one question a pit wall actually
   * asks — "how far away is HE" — could only be answered by subtracting two
   * numbers that do not subtract.
   */
  function fmtVsMe(r, me) {
    if (!me || !r || r.slotId === me.slotId) return dash;
    const a = progressOf(r);
    const b = progressOf(me);
    if (a === null || b === null) return dash;
    const laps = a - b;
    if (Math.abs(laps) >= 1) return `${laps > 0 ? '−' : '+'}${Math.abs(laps).toFixed(1)}L`;
    // Inside a lap, seconds are the readable unit — priced at the pace the car
    // in question is actually running, since a lap of track is worth different
    // amounts of time to a Hypercar and a GT3.
    const pace = known(r.avg5Sec) && r.avg5Sec > 0
      ? r.avg5Sec
      : known(r.bestLapSec) && r.bestLapSec > 0
        ? r.bestLapSec
        : 0;
    if (!pace) return dash;
    const sec = Math.abs(laps) * pace;
    return `${laps > 0 ? '−' : '+'}${sec.toFixed(1)}`;
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

    // Our own car, the reference for the "vs Me" column. `isPlayer` follows the
    // broadcast focus, so in a team race it is our car whenever the camera has
    // not been panned away from it.
    const me = standings.find((r) => r.isPlayer) || null;

    const head = `
      <tr>
        <th>P</th><th>Ovr</th><th>#</th><th class="team-t__driver">Driver</th>
        <th>Pit</th><th>Stops</th>
        <th>Last</th><th>Best</th><th>Avg 5</th>
        <th>Gap</th><th>Int</th>${me ? '<th>vs Me</th>' : ''}
        ${anyVe ? '<th>VE</th>' : ''}<th>Tyre</th>
      </tr>`;
    const cols = (anyVe ? 13 : 12) + (me ? 1 : 0);

    const groups = classes.map(([cls, rows]) => {
      rows.sort((a, b) => {
        const ap = known(a.classPosition) ? a.classPosition : (known(a.position) ? a.position : 999);
        const bp = known(b.classPosition) ? b.classPosition : (known(b.position) ? b.position : 999);
        return ap - bp;
      });
      const color = CHARTS.classColor(cls);
      // The interval to the car ahead IN CLASS, which is the block this row is
      // being read inside. `gapToAheadSec` is the sim's gap to the next car
      // OVERALL — under a class subheader that is an interval to whichever
      // Hypercar happens to be sitting between two GT3s, which is not the
      // number the row appears to be claiming. Counted off track position for
      // the same reason the Gap column is.
      const intervals = rows.map((r, i) => {
        const prev = rows[i - 1];
        if (!prev) return dash;
        const a = progressOf(prev);
        const b = progressOf(r);
        if (a !== null && b !== null && a - b >= 1) return `+${(a - b).toFixed(1)}L`;
        return fmtGap(r.gapToAheadSec);
      });
      const body = rows.map((r, i) => {
        // A class leader has nobody to be behind; "+0.0" read as a real gap.
        const gap = r.classPosition === 1
          ? dash
          : known(r.classLapsBehindExact) && r.classLapsBehindExact >= 1
            ? fmtLapGap(r.classLapsBehindExact, r.classLapsBehind)
            : known(r.gapToClassLeaderSec)
              ? fmtGap(r.gapToClassLeaderSec)
              : fmtLapGap(r.classLapsBehindExact, r.classLapsBehind);
        // "Avg 5" over fewer than five laps is the heading overstating what it
        // knows — true for the first minutes of a session, after every stop and
        // after every driver swap. Mark it rather than hide it.
        const partial = known(r.avg5Sec) && known(r.avg5Laps) && r.avg5Laps < 5;
        const avg = partial
          ? `<span class="team-t__partial" title="mean of ${r.avg5Laps} lap${r.avg5Laps === 1 ? '' : 's'}, not 5">${fmtLap(r.avg5Sec)}<sup>${r.avg5Laps}</sup></span>`
          : fmtLap(r.avg5Sec);
        return `
        <tr class="${r.isPlayer ? 'team-t__me' : ''}">
          <td>${fmt0(r.classPosition)}</td>
          <td class="team-t__dim">${fmt0(r.position)}</td>
          <td class="team-t__num">${r.carNumber != null ? esc(String(r.carNumber)) : ''}</td>
          <td class="team-t__driver">${esc(r.driverName || '')}</td>
          <td>${pitCell(r)}</td>
          <td>${fmt0(r.pitStops)}</td>
          <td>${fmtLap(r.lastLapSec)}</td>
          <td>${fmtLap(r.bestLapSec)}</td>
          <td>${avg}</td>
          <td>${gap}</td>
          <td class="team-t__dim">${intervals[i]}</td>
          ${me ? `<td class="team-t__vsme">${fmtVsMe(r, me)}</td>` : ''}
          ${anyVe ? `<td>${known(r.virtualEnergy) ? `${Math.round(r.virtualEnergy)}%` : dash}</td>` : ''}
          <td>${r.tyreCompound ? esc(String(r.tyreCompound)).slice(0, 6) : dash}</td>
        </tr>`;
      }).join('');
      return `
        <tr class="team-t__class"><td colspan="${cols}">
          <span class="team-t__dot" style="background:${color}"></span>${esc(cls)} · ${rows.length}
        </td></tr>${body}`;
    }).join('');

    setCard(els.timing, `
      <div class="team-t__wrap"><table class="team-t">
        <thead>${head}</thead><tbody>${groups}</tbody>
      </table></div>
      <p class="team-note">Gap is to the class leader, Int to the car ahead in class,
      vs&nbsp;Me to your own car (− ahead of you, + behind). Lap gaps carry a decimal
      so they can be compared row to row — a whole-lap figure is floored per row and
      two of them cannot be subtracted. A superscript on Avg&nbsp;5 means it is the
      mean of fewer than five laps.</p>`);
  }

  // ── Positions chart ──────────────────────────────────────────────────────
  function renderPositions() {
    if (!els.posCanvas) return;
    const h = viewHistory();
    const cars = h && h.cars ? h.cars : [];
    CHARTS.drawPositions(els.posCanvas, h, {
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

  /**
   * A tread temperature's colour on the same blue→red thermal ramp the
   * overlay's tyre widget uses (overlay/js/widgets/tyres.js rampColor) —
   * anchored on the sim's optimum so green lands on the window, falling back
   * to a fixed 35–105 °C sweep when no optimum is published. Continuous on
   * purpose: the first cut bucketed the stripes into three states around
   * optimal±12, and a GT3's liner spends whole stints inside one bucket, so
   * the stripes sat solid blue looking dead while the car's own tread map
   * visibly moved. '' when the temperature itself is unknown.
   */
  function rampColor(c, optimalC) {
    if (!known(c)) return '';
    const lo = known(optimalC) ? optimalC - 45 : 35;
    const hi = known(optimalC) ? optimalC + 25 : 105;
    let t = (c - lo) / (hi - lo);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return `hsl(${Math.round(210 * (1 - t))}, 85%, 52%)`;
  }

  /** Brake-disc heat. A working GT disc lives ~150–750 °C; below that it is
   *  cold carbon that won't bite, above it is cooking. */
  function brakeHeat(c) {
    if (!known(c)) return 'flat';
    if (c < 150) return 'cold';
    if (c > 750) return 'hot';
    return 'ok';
  }

  /**
   * One corner drawn as the wheel itself, concentric from the outside in:
   * a thin tread-remaining arc, the tyre (three tread stripes, oriented so the
   * inner shoulder faces the car's centreline), the brake disc coloured by its
   * temperature, and the pressure in the hub — the number the pit wall was
   * missing. `key` keeps the SVG mask id unique per corner.
   */
  function wheelSvg(t, key, rightSide) {
    const bands = [t.innerC, t.middleC, t.outerC];
    // Left-to-right stripes as drawn: the inner shoulder sits toward the car's
    // centreline, so left-side wheels read outer→inner and right-side wheels
    // inner→outer. No usable bands → paint the whole tread off the corner's
    // one temperature; no temperature at all → the CSS fallback grey.
    const stripes = bands.every(known)
      ? (rightSide ? bands : [...bands].reverse()).map((c) => rampColor(c, t.optimalTempC))
      : Array(3).fill(rampColor(t.tempC, t.optimalTempC));
    const C = 2 * Math.PI * 50;
    const wearKnown = known(t.wear);
    const wearLen = wearKnown ? Math.max(0.02, Math.min(1, t.wear)) * C : 0;
    const kpa = known(t.pressureKpa) ? String(Math.round(t.pressureKpa)) : dash;
    return `
      <svg class="team-wheel" viewBox="0 0 104 104" role="img"
           aria-label="tyre: ${kpa} kPa, ${degrees(t.tempC)}, brake ${degrees(t.brakeTempC)}">
        <defs>
          <mask id="team-tyremask-${key}">
            <circle cx="52" cy="52" r="45" fill="white"/>
            <circle cx="52" cy="52" r="28" fill="black"/>
          </mask>
        </defs>
        <g class="team-wheel__tread" mask="url(#team-tyremask-${key})">
          <rect x="4" y="4" width="30.6" height="96"${stripes[0] ? ` style="fill:${stripes[0]}"` : ''}/>
          <rect x="36.7" y="4" width="30.6" height="96"${stripes[1] ? ` style="fill:${stripes[1]}"` : ''}/>
          <rect x="69.4" y="4" width="30.6" height="96"${stripes[2] ? ` style="fill:${stripes[2]}"` : ''}/>
        </g>
        <circle class="team-wheel__rim" cx="52" cy="52" r="45"/>
        <circle class="team-wheel__rim" cx="52" cy="52" r="28"/>
        <circle class="team-wheel__weartrack" cx="52" cy="52" r="50"/>
        ${wearKnown ? `<circle class="team-wheel__weararc" data-band="${wearBand(t.wear)}" cx="52" cy="52" r="50"
          stroke-dasharray="${wearLen.toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 52 52)"/>` : ''}
        <circle class="team-wheel__disc" data-heat="${brakeHeat(t.brakeTempC)}" cx="52" cy="52" r="24"/>
        <circle class="team-wheel__hub" cx="52" cy="52" r="17"/>
        <text class="team-wheel__kpa" x="52" y="${known(t.pressureKpa) ? 55 : 57}" text-anchor="middle">${kpa}</text>
        ${known(t.pressureKpa) ? `<text class="team-wheel__unit" x="52" y="64" text-anchor="middle">kPa</text>` : ''}
      </svg>`;
  }

  function renderTyres(tyres) {
    if (!tyres) {
      setCard(els.tyres, `<p class="team-note">No tyre data — the shared-memory plugin publishes this only while the car is on track.</p>`);
      return;
    }
    const compounds = new Set(CORNERS.map(([k]) => tyres[k] && tyres[k].compound).filter(Boolean));
    const corners = CORNERS.map(([key, label]) => {
      const t = tyres[key];
      const right = key.endsWith('Right');
      if (!t) return `<div class="team-tyre"><div class="team-tyre__corner">${label}</div><div class="team-tyre__wear">${dash}</div></div>`;
      const band = wearBand(t.wear);
      const inWindow = known(t.tempC) && known(t.optimalTempC)
        ? Math.abs(t.tempC - t.optimalTempC) <= 8 : null;
      return `
        <div class="team-tyre${band ? ` team-band--${band}` : ''}${right ? ' team-tyre--right' : ''}">
          ${wheelSvg(t, key, right)}
          <div class="team-tyre__info">
            <div class="team-tyre__head">
              <span class="team-tyre__corner">${label}</span>
              ${inWindow != null ? `<span class="team-tyre__win" data-in="${inWindow}">${inWindow ? 'in window' : 'out of window'}</span>` : ''}
            </div>
            <span class="team-tyre__wear">${known(t.wear) ? `${(t.wear * 100).toFixed(1)}%` : dash}</span>
            <span class="team-tyre__cap">tyre left</span>
            <span class="team-tyre__temps">
              <b>${degrees(t.tempC)}</b>
              <i>${known(t.brakeTempC) ? `brake ${degreesU(t.brakeTempC)}` : ''}</i>
            </span>
          </div>
        </div>`;
    }).join('');
    setCard(els.tyres, `
      ${compounds.size ? `<p class="team-note">${esc(Array.from(compounds).join(' / '))} fitted · tread stripes face the car (inner shoulder inboard) · disc shows brake temp · hub is pressure</p>` : ''}
      <div class="team-tyres">${corners}</div>`);
  }

  /**
   * The Damage tile's text, matching the overlay damage widget's language:
   * the worst COMPONENT named with its severity — "FL susp 12%", "aero 13%" —
   * plus the sim's fix-all time. `worst` itself is a bare 0..1 fraction
   * (max across aero + the four suspension corners) and printing it raw is
   * exactly the "0.128665…" bug this replaces. Older relay rows may predate
   * the snapshot carrying `suspension`; without it the damage stays nameless.
   */
  const DMG_CORNERS = ['FL', 'FR', 'RL', 'RR'];
  function damageText(dmg) {
    if (!dmg) return dash;
    if (!dmg.hasDamage) return 'clean';
    const pct = (v) => `${Math.round(v * 100)}%`;
    let where = null;
    if (Array.isArray(dmg.suspension) && known(dmg.aero)) {
      let idx = -1;
      let max = dmg.aero;
      dmg.suspension.forEach((v, i) => {
        if (known(v) && v > max) { max = v; idx = i; }
      });
      where = idx < 0 ? `aero ${pct(dmg.aero)}` : `${DMG_CORNERS[idx]} susp ${pct(max)}`;
    } else if (known(dmg.worst)) {
      where = `worst ${pct(dmg.worst)}`;
    } else {
      where = 'damage';
    }
    const secs = known(dmg.repairSeconds) && dmg.repairSeconds > 0
      ? ` · ${fmt0(dmg.repairSeconds)}s` : '';
    return `${esc(where)}${secs}`;
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
    const dmgText = damageText(dmg);
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

  /** LMU's coarse sky states, in pit-wall words. */
  const SKY_WORDS = {
    clear: 'Clear',
    partlyCloudy: 'Part cloudy',
    overcast: 'Overcast',
    lightRain: 'Light rain',
    rain: 'Rain',
    storm: 'Storm',
  };

  function renderWeather(w) {
    if (!w) { setCard(els.weather, `<p class="team-note">No weather data.</p>`); return; }

    const rainNow = known(w.rainIntensity) && w.rainIntensity > 0;
    const wetPct = known(w.trackWetness) && w.trackWetness > 0.005
      ? Math.round(w.trackWetness * 100)
      : null;
    const surface = w.trackCondition
      ? `${esc(w.trackCondition)}${wetPct != null ? ` <small>${wetPct}%</small>` : ''}`
      : dash;
    const surfaceBand = !w.trackCondition
      ? {}
      : w.trackCondition === 'DRY' ? { band: 'ok' } : { band: 'warn' };

    const notes = [];
    if (w.trackTrend === 'drying') notes.push('track is drying');
    else if (w.trackTrend === 'wetting') notes.push('track is getting wetter');
    if (known(w.trackSpread) && w.trackSpread > 0.15) notes.push('uneven surface — wet and dry patches');

    const slots = (w.forecast || []).map((f) => {
      const when = f.label || (f.minutesAhead === 0 ? 'NOW'
        : known(f.minutesAhead) ? `+${f.minutesAhead}m` : dash);
      const chance = known(f.rainChance) ? Math.round(f.rainChance * 100) : null;
      const meta = [
        known(f.windKph) && f.windKph > 0 ? `wind ${Math.round(f.windKph)} kph` : null,
        known(f.humidityPct) && f.humidityPct > 0 ? `hum ${Math.round(f.humidityPct)}%` : null,
      ].filter(Boolean).join('<br>');
      return `
        <div class="team-wx" data-rain="${chance != null && chance >= 50}">
          <div class="team-wx__when">${esc(when)}</div>
          <div class="team-wx__sky">${SKY_WORDS[f.sky] ? esc(SKY_WORDS[f.sky]) : dash}</div>
          <div class="team-wx__temp">${degrees(known(f.trackTempC) ? f.trackTempC : f.airTempC)}</div>
          <div class="team-wx__chance">${chance != null ? `${chance}%` : dash}</div>
          <div class="team-wx__bar"><span style="width:${known(f.rainIntensity) ? Math.round(f.rainIntensity * 100) : 0}%"></span></div>
          ${meta ? `<div class="team-wx__meta">${meta}</div>` : ''}
        </div>`;
    }).join('');

    setCard(els.weather, `
      <div class="fuel-tiles team-tiles--4">
        ${tile('Air', degreesU(w.ambientTempC))}
        ${tile('Track', degreesU(w.trackTempC))}
        ${tile('Rain', rainNow ? `${Math.round(w.rainIntensity * 100)}%` : 'Dry', rainNow ? { band: 'warn' } : {})}
        ${tile('Surface', surface, surfaceBand)}
      </div>
      ${notes.length ? `<p class="team-note">${notes.map(esc).join(' · ')}</p>` : ''}
      ${slots ? `<div class="team-wxrow">${slots}</div>` : ''}`);
  }

  function renderMap() {
    if (!els.mapCanvas) return;
    const s = viewSnap();
    const tm = s && s.trackMap;
    const classBySlot = new Map(
      (s && s.standings ? s.standings : []).map((r) => [r.slotId, r.carClass]),
    );
    const progressText = tm && !tm.ready && known(tm.progress) && tm.progress > 0
      ? `Learning the track — ${Math.round(tm.progress * 100)}%`
      : undefined;
    CHARTS.drawTrackMap(
      els.mapCanvas,
      viewShape(),
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
    const h = viewHistory();
    const cars = h && h.cars ? h.cars : [];
    const sel = laptimeSelection(cars);
    CHARTS.drawLapTimes(els.laptimeCanvas, h, {
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
    if (teamView()) {
      const a = relay && relay.active;
      if (!a || !relay.at) {
        els.age.dataset.state = 'none';
        els.age.textContent = relay && relay.error ? 'RELAY ERROR' : 'NO TEAM DATA';
        // The reason, not just the fact — "signed out" and "nobody driving"
        // look the same on the pill and want completely different actions.
        els.age.title = relay && relay.error ? String(relay.error) : '';
        return;
      }
      // Age of the data itself: server-reported age at read time, plus the
      // time since that read landed here.
      const ageSec = Math.max(0, (Date.now() - relay.at) / 1000 + (a.ageSec || 0));
      if (ageSec > 12) {
        els.age.dataset.state = 'stale';
        els.age.textContent = `STALE ${Math.round(ageSec)}s`;
      } else {
        els.age.dataset.state = 'live';
        els.age.textContent = `RELAY · ${(a.name || 'TEAM').toUpperCase()}`;
      }
      return;
    }
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

  // ── Crew card (Phase 2) ──────────────────────────────────────────────────
  const DOWNLOAD_URL = 'https://github.com/Lilybankai/Apexandchilloverlaysystem/releases/latest';
  let crewMsg = null; // {kind: 'ok'|'err', text} — one-shot feedback line
  let crewBusy = false;
  let showJoinForm = false; // "Join another" toggles the code form back in

  function activeTeam() {
    if (!cloud || !Array.isArray(cloud.teams)) return null;
    return cloud.teams.find((t) => t.id === cloud.activeTeamId) || null;
  }

  function publishStatusText() {
    if (!cloud) return null;
    switch (cloud.publishStatus) {
      case 'publishing': return { state: 'publishing', text: 'relaying your car to the team' };
      case 'waiting': return { state: 'waiting', text: 'relay armed — publishes while you drive' };
      case 'error': return { state: 'error', text: `relay: ${cloud.publishError || 'error'}` };
      default: return null;
    }
  }

  function renderCrew() {
    if (!els.crew) return;
    if (!cloud) { setCard(els.crew, ''); els.crew.hidden = true; return; }
    els.crew.hidden = false;

    if (!cloud.signedIn) {
      setCard(els.crew, `<p class="team-note">Sign in to create or join a team — the pit wall can then follow whoever is in the car.</p>`);
      return;
    }

    const teams = cloud.teams || [];
    const msg = crewMsg
      ? `<div class="team-crew__msg" data-kind="${crewMsg.kind}">${esc(crewMsg.text)}</div>` : '';

    if (!teams.length) {
      setCard(els.crew, `
        <div class="team-crew__forms">
          <div class="team-crew__form field">
            <div>
              <span class="field__label">Create a team</span>
              <input class="field__input" data-crewfield="name" maxlength="40" placeholder="Team name" aria-label="Team name" />
            </div>
            <button type="button" class="btn btn--accent btn--sm" data-crew="create">Create</button>
          </div>
          <div class="team-crew__form field">
            <div>
              <span class="field__label">Join with a code</span>
              <input class="field__input" data-crewfield="code" maxlength="10" placeholder="APX-XXXXXX" spellcheck="false" aria-label="Invite code" />
            </div>
            <button type="button" class="btn btn--ghost btn--sm" data-crew="join">Join</button>
          </div>
        </div>
        ${msg}`);
      return;
    }

    const team = activeTeam() || teams[0];
    const isOwner = team.role === 'owner';
    const drivingId = teamView() && relay && relay.active ? relay.active.userId : null;
    const onlineIds = new Set(
      (relay && relay.sources ? relay.sources : [])
        .filter((s) => (s.ageSec || 0) < 30).map((s) => s.userId),
    );

    const picker = teams.length > 1
      ? `<select class="field__input team-crew__select" data-crew="pick" aria-label="Active team">
          ${teams.map((t) => `<option value="${t.id}" ${t.id === team.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select>`
      : `<span class="team-crew__name">${esc(team.name)}</span>`;

    const members = (team.members || []).map((m) => `
      <span class="team-member" data-driving="${m.user_id === drivingId}" data-online="${onlineIds.has(m.user_id)}">
        <span class="team-member__dot"></span>${esc(m.name)}
        ${m.role === 'owner' ? '<span class="team-member__role">OWNER</span>' : ''}
        ${isOwner && m.role !== 'owner'
          ? `<button type="button" class="team-member__kick" data-crew="kick" data-user="${m.user_id}" data-name="${esc(m.name)}" title="Remove from team">✕</button>`
          : ''}
      </span>`).join('');

    const status = publishStatusText();

    setCard(els.crew, `
      <div class="team-crew__row">
        ${picker}
        <span class="team-crew__code">
          <span class="team-crew__codeval">${esc(team.invite_code || '')}</span>
          <button type="button" class="btn btn--ghost btn--sm" data-crew="copy">Copy code</button>
          <button type="button" class="btn btn--ghost btn--sm" data-crew="share">Share invite</button>
          ${isOwner ? '<button type="button" class="btn btn--ghost btn--sm" data-crew="rotate" title="Invalidate the old code and issue a new one">New code</button>' : ''}
        </span>
        <span class="team-crew__spacer"></span>
        ${status ? `<span class="team-crew__status" data-state="${status.state}">${esc(status.text)}</span>` : ''}
        <button type="button" class="btn btn--ghost btn--sm" data-crew="joinmore" title="Join another team with a code">Join another</button>
        <button type="button" class="btn btn--ghost btn--sm btn--danger" data-crew="leave">Leave</button>
      </div>
      <div class="team-crew__members">${members}</div>
      ${showJoinForm ? `
        <div class="team-crew__forms" style="margin-top:10px">
          <div class="team-crew__form field">
            <input class="field__input" data-crewfield="code" maxlength="10" placeholder="APX-XXXXXX" spellcheck="false" aria-label="Invite code" />
            <button type="button" class="btn btn--ghost btn--sm" data-crew="join">Join</button>
          </div>
        </div>` : ''}
      ${msg}`);
  }

  function setCrewMsg(kind, text) {
    crewMsg = text ? { kind, text } : null;
    lastHtml.delete(els.crew);
    renderCrew();
  }

  async function crewOp(run, okText) {
    if (crewBusy) return;
    crewBusy = true;
    try {
      const res = await run();
      if (res && res.ok === false) setCrewMsg('err', res.error || 'That did not work.');
      else setCrewMsg('ok', okText || '');
    } catch (err) {
      setCrewMsg('err', err.message);
    } finally {
      crewBusy = false;
    }
  }

  function shareMessage(team) {
    return [
      `Join "${team.name}" on Apex AIO System 🏁`,
      `1. Install the app: ${DOWNLOAD_URL}`,
      `2. Create your account in the app (each seat needs its own subscription)`,
      `3. Team tab → Join with a code → ${team.invite_code}`,
    ].join('\n');
  }

  function onCrewClick(e) {
    const btn = e.target.closest('[data-crew]');
    if (!btn) return;
    const team = activeTeam() || (cloud && cloud.teams && cloud.teams[0]) || null;
    switch (btn.dataset.crew) {
      case 'create': {
        const input = els.crew.querySelector('[data-crewfield="name"]');
        void crewOp(() => window.apex.teamCreate(input ? input.value : ''), 'Team created — share the code with your crew.');
        break;
      }
      case 'join': {
        const input = els.crew.querySelector('[data-crewfield="code"]');
        showJoinForm = false;
        void crewOp(() => window.apex.teamJoin(input ? input.value : ''), 'Joined!');
        break;
      }
      case 'joinmore':
        showJoinForm = !showJoinForm;
        lastHtml.delete(els.crew);
        renderCrew();
        break;
      case 'copy':
        if (team) {
          navigator.clipboard.writeText(team.invite_code || '').then(
            () => setCrewMsg('ok', 'Code copied.'),
            () => setCrewMsg('err', 'Could not copy — select the code and copy it manually.'),
          );
        }
        break;
      case 'share':
        if (team) {
          navigator.clipboard.writeText(shareMessage(team)).then(
            () => setCrewMsg('ok', 'Invite message copied — paste it in your team Discord.'),
            () => setCrewMsg('err', 'Could not copy — select the code and copy it manually.'),
          );
        }
        break;
      case 'rotate':
        if (team && window.confirm('Issue a new invite code? The old one stops working.')) {
          void crewOp(() => window.apex.teamRotateCode(team.id), 'New code issued.');
        }
        break;
      case 'leave':
        if (team && window.confirm(`Leave "${team.name}"?${team.role === 'owner' ? ' Ownership passes to the longest-serving member (or the team is deleted if you are the last one).' : ''}`)) {
          void crewOp(() => window.apex.teamLeave(team.id), 'Left the team.');
        }
        break;
      case 'kick':
        if (team && window.confirm(`Remove ${btn.dataset.name || 'this member'} from the team?`)) {
          void crewOp(() => window.apex.teamRemoveMember(team.id, btn.dataset.user), 'Removed.');
        }
        break;
    }
  }

  function onCrewChange(e) {
    const sel = e.target.closest('[data-crew="pick"]');
    if (!sel) return;
    void window.apex.teamSetActive(sel.value);
  }

  // ── Source toggle ────────────────────────────────────────────────────────
  function updateSourceSeg() {
    if (!els.source) return;
    const inTeam = !!(cloud && cloud.signedIn && cloud.teams && cloud.teams.length);
    els.source.hidden = !inTeam;
    if (!inTeam && prefs.source === 'team') setSource('my');
    for (const btn of els.source.querySelectorAll('[data-teamsource]')) {
      btn.setAttribute('data-active', String(btn.dataset.teamsource === prefs.source));
    }
  }

  function setSource(source) {
    const next = source === 'team' ? 'team' : 'my';
    if (prefs.source === next) return;
    prefs.source = next;
    savePrefs();
    // The relay poll runs only while the pit wall is actually watching it.
    if (visible) void window.apex.teamWatch(next === 'team');
    // Chart canvases keyed to the other source's data must repaint.
    lastHtml.clear();
    updateSourceSeg();
    renderAll();
    renderCrew();
  }

  // ── Sub-tab router ───────────────────────────────────────────────────────
  const TABS = {
    timing: (s) => renderTiming(s.standings),
    positions: () => renderPositions(),
    strategy: (s) => {
      renderFuel(s.fuel);
      renderStrategy(s.fuel);
      renderTyrePlan(s.tyrePlan, s.fuel);
    },
    telemetry: (s) => {
      renderMap();
      renderTyres(s.car && s.car.tyres);
      renderTelemetry(s.car);
      renderWeather(s.weather);
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
    const s = viewSnap();
    if (s) TABS[tab](s);
  }

  function renderAll() {
    renderAge();
    const s = viewSnap();
    const has = !!s;
    if (els.empty) els.empty.hidden = has;
    if (els.live) els.live.hidden = !has;
    if (!has) return;
    renderSession(s.session);
    TABS[TABS[prefs.tab] ? prefs.tab : 'timing'](s);
  }

  // ── Wiring ──────────────────────────────────────────────────────────────
  // Temperature unit. The memo below caches markup, so a unit change has to
  // clear it or the cards would keep whichever unit they were last built with
  // until a number underneath them happened to move.
  const applyTempUnit = (settings) => {
    const next = settings && settings.tempUnit === 'f' ? 'f' : 'c';
    if (next === tempUnit) return;
    tempUnit = next;
    lastHtml.clear();
    if (visible) renderAll();
  };
  window.apex
    .getState()
    .then((state) => applyTempUnit(state && state.settings))
    .catch(() => { /* defaults stand */ });
  window.apex.onSettings(applyTempUnit);

  if (els.safety) {
    els.safety.value = prefs.safetyLaps;
    els.safety.addEventListener('change', () => {
      const v = parseFloat(els.safety.value);
      prefs.safetyLaps = Number.isFinite(v) ? Math.min(10, Math.max(0, Math.round(v))) : 1;
      els.safety.value = prefs.safetyLaps;
      savePrefs();
      const s = viewSnap();
      if (s) { renderStrategy(s.fuel); renderTyrePlan(s.tyrePlan, s.fuel); }
    });
  }

  if (els.subtabs) {
    els.subtabs.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-teamtab]');
      if (btn) setTab(btn.dataset.teamtab);
    });
  }
  if (els.source) {
    els.source.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-teamsource]');
      if (btn) setSource(btn.dataset.teamsource);
    });
  }
  if (els.crew) {
    els.crew.addEventListener('click', onCrewClick);
    els.crew.addEventListener('change', onCrewChange);
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
      const h = viewHistory();
      if (!btn || !h) return;
      const cars = h.cars || [];
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

  // The push listeners live for the app's lifetime; main only sends the
  // snapshot/relay streams while subscribed, so there is nothing to unhook on
  // hidden(). Roster pushes ('team:cloud') arrive whenever membership or
  // publish status changes — cheap and worth reflecting even in background.
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
    if (visible && !teamView()) renderAll();
    else if (visible) renderAge();
  });

  window.apex.onTeamCloud((state) => {
    cloud = state;
    updateSourceSeg();
    if (visible) { lastHtml.delete(els.crew); renderCrew(); }
  });

  window.apex.onTeamRelay((update) => {
    relay = update || null;
    if (!visible) return;
    if (teamView()) {
      renderAll();
      renderCrew(); // driving/online dots ride the relay
    }
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
      window.apex.teamCloudState().then((state) => {
        cloud = state;
        updateSourceSeg();
        if (visible) renderCrew();
        // Entering the tab is a natural moment for a roster refresh — an
        // invite accepted elsewhere shows up without a restart.
        return window.apex.teamRefresh();
      }).then((state) => {
        if (state) { cloud = state; updateSourceSeg(); if (visible) { lastHtml.delete(els.crew); renderCrew(); } }
      }).catch(() => { /* offline — the cached state stands */ });
      if (teamView()) void window.apex.teamWatch(true);
      setTab(prefs.tab);
      renderAll();
      renderCrew();
      if (!ageTimer) ageTimer = setInterval(renderAge, 1000);
    },
    hidden() {
      if (!visible) return;
      visible = false;
      window.apex.teamUnsubscribe();
      void window.apex.teamWatch(false);
      if (ageTimer) { clearInterval(ageTimer); ageTimer = null; }
    },
  };
})();
