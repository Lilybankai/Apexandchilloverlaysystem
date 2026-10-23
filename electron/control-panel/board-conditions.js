/**
 * board-conditions.js — what a board lap was set in, on hover.
 * -----------------------------------------------------------------------------
 * Carl, 2026-10-23: "lots of people set their fastest times as quali laps, and
 * there's no accurate way to show the conditions a lap was set in." Every board
 * surface (the Leaderboard tab, Review's board peek and its Compare board, and
 * Training's Chase list) now marks a time that carries its conditions, and
 * hovering or focusing the time shows them: the session, track and air
 * temperature, the fuel in the car as the lap BEGAN (and as a share of the
 * tank), virtual energy, and the compound.
 *
 * The values come from `leaderboard()` / `board_for_lap()` as of migration
 * 0043 (session_type, track_temp_c, air_temp_c, fuel_start_l, fuel_capacity_l,
 * ve_start_pct, compound). Against a server from before 0043 those columns are
 * simply absent, `conditionsOf` answers null, and the row is drawn exactly as
 * it always was — no marker, no tooltip, nothing to explain.
 *
 * One module for all the surfaces so they cannot disagree about what a row
 * "has", and so the plausibility rules live in one place: a value outside a
 * believable range is treated as not recorded rather than shown, because a
 * tooltip reading "Fuel 0.0 L" on a pole lap is a claim, not a blank.
 *
 * Loaded as a classic script by the panel (window.APEX_BOARD_CONDITIONS) and
 * require()d by scripts/test-board-conditions.js — the pure half needs no DOM.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_BOARD_CONDITIONS = api;
  // Delegated listeners, so one install covers every board drawn later.
  if (root && root.document) api.install(root.document);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** Session categories as lapLog records them (`SessionType` in types.ts). */
  const SESSIONS = {
    practice: { short: 'P', long: 'Practice' },
    qualifying: { short: 'Q', long: 'Qualifying' },
    race: { short: 'R', long: 'Race' },
    warmup: { short: 'W', long: 'Warm-up' },
    testday: { short: 'T', long: 'Test day' },
  };

  /** °C or °F, as the panel's Units setting says. Celsius until told. */
  let tempUnit = 'c';

  function setTempUnit(unit) {
    tempUnit = unit === 'f' ? 'f' : 'c';
  }

  /** A finite number inside [lo, hi], else null. Strings of digits count. */
  function num(v, lo, hi) {
    let n = NaN;
    if (typeof v === 'number') n = v;
    else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
  }

  /**
   * The displayable conditions on one board row, normalised, or null when the
   * row carries none — which is every row from a server without 0043.
   */
  function conditionsOf(row) {
    if (!row || typeof row !== 'object') return null;
    const st = typeof row.session_type === 'string' ? row.session_type.trim().toLowerCase() : '';
    const session = SESSIONS[st] ? st : null;
    // Ranges: LMU has never published a surface outside ~5–60 °C, but rF2 mods
    // and night stints can be cold; anything beyond these is a broken reading.
    const trackTempC = num(row.track_temp_c, -30, 80);
    const airTempC = num(row.air_temp_c, -30, 60);
    // A lap that began with no fuel in the tank did not happen; a zero here is
    // "not read", which is how lapLog writes it (omitted, never 0).
    const fuelStartL = num(row.fuel_start_l, 0.1, 400);
    const capacityL = num(row.fuel_capacity_l, 1, 400);
    const veStartPct = num(row.ve_start_pct, 0.1, 100);
    const compound =
      typeof row.compound === 'string' ? row.compound.trim().slice(0, 24) : '';

    // The share of the tank only when both ends are believable together. A
    // level a little over capacity is a sensor rounding; well over is two
    // different cars' numbers and says nothing.
    let fuelPct = null;
    if (fuelStartL !== null && capacityL !== null && fuelStartL <= capacityL * 1.02) {
      fuelPct = Math.min(100, (fuelStartL / capacityL) * 100);
    }

    if (
      !session &&
      trackTempC === null &&
      airTempC === null &&
      fuelStartL === null &&
      veStartPct === null &&
      !compound
    ) {
      return null;
    }
    return { session, trackTempC, airTempC, fuelStartL, capacityL, fuelPct, veStartPct, compound };
  }

  /** `31°C` / `88°F`, whole degrees — the precision LMU's own HUD shows. */
  function degrees(c, unit) {
    const u = unit === 'f' || unit === 'c' ? unit : tempUnit;
    const v = u === 'f' ? c * 1.8 + 32 : c;
    return `${Math.round(v)}°${u === 'f' ? 'F' : 'C'}`;
  }

  function fuelText(cond) {
    if (cond.fuelStartL === null) return null;
    const litres = `${cond.fuelStartL.toFixed(1)} L`;
    return cond.fuelPct !== null ? `${litres} · ${Math.round(cond.fuelPct)}% of tank` : litres;
  }

  /** The letter on the marker: P / Q / R / W / T, or a dot with no session. */
  function markerText(cond) {
    return cond && cond.session ? SESSIONS[cond.session].short : '•';
  }

  /**
   * The tooltip's content as data: a heading and label/value lines. Fuel is
   * always listed, as "not recorded" when absent — it is the field a driver is
   * hovering to find, and a card that silently omits it reads as a bug.
   */
  function tipModel(cond, unit) {
    if (!cond) return null;
    const lines = [];
    if (cond.trackTempC !== null) lines.push({ label: 'Track', value: degrees(cond.trackTempC, unit) });
    if (cond.airTempC !== null) lines.push({ label: 'Air', value: degrees(cond.airTempC, unit) });
    const fuel = fuelText(cond);
    lines.push(fuel ? { label: 'Fuel at start', value: fuel } : { label: 'Fuel at start', value: 'not recorded', muted: true });
    if (cond.veStartPct !== null) {
      lines.push({ label: 'Energy at start', value: `${Math.round(cond.veStartPct)}%` });
    }
    if (cond.compound) lines.push({ label: 'Tyres', value: cond.compound });
    return {
      title: cond.session ? `Set in ${SESSIONS[cond.session].long.toLowerCase()}` : 'Lap conditions',
      session: cond.session,
      lines,
    };
  }

  /** The whole tooltip as one sentence, for aria-label. */
  function summaryText(cond, unit) {
    const m = tipModel(cond, unit);
    if (!m) return '';
    return `${m.title}. ${m.lines.map((l) => `${l.label} ${l.value}`).join(', ')}.`;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * A lap time as HTML, marked when the row carries conditions. For the
   * surfaces that render from template strings (Review, Training). `timeText`
   * is the already-formatted time; everything is escaped here.
   *
   * `focusable: false` for a time that sits inside a button (Training's Chase
   * rows) — a focus stop nested in a button is invalid, and hover still works.
   */
  function timeHtml(row, timeText, opts) {
    const o = opts || {};
    const cond = conditionsOf(row);
    if (!cond) return esc(timeText);
    const tab = o.focusable === false ? '' : ' tabindex="0"';
    return `<span class="lbcond" data-cond="${esc(JSON.stringify(cond))}"${tab} title="" aria-label="${esc(
      `${timeText}. ${summaryText(cond)}`,
    )}"><span class="lbcond__mark" data-session="${esc(cond.session || 'none')}" aria-hidden="true">${esc(
      markerText(cond),
    )}</span>${esc(timeText)}</span>`;
  }

  /**
   * The DOM version, for the Leaderboard tab, which builds its rows with
   * createElement (display names are user-supplied; nothing there goes
   * through innerHTML). Marks `el` in place and returns whether it did.
   */
  function decorate(el, row, timeText) {
    const cond = conditionsOf(row);
    if (!el || !cond) return false;
    const doc = el.ownerDocument;
    el.classList.add('lbcond');
    el.setAttribute('data-cond', JSON.stringify(cond));
    el.tabIndex = 0;
    // An empty title stops the row's own title (the reference score) from
    // showing as a native tooltip on top of this one.
    el.setAttribute('title', '');
    el.setAttribute('aria-label', `${timeText}. ${summaryText(cond)}`);
    const mark = doc.createElement('span');
    mark.className = 'lbcond__mark';
    mark.setAttribute('data-session', cond.session || 'none');
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = markerText(cond);
    el.textContent = '';
    el.append(mark, doc.createTextNode(timeText));
    return true;
  }

  /* ------------------------------------------------------------ the tooltip */
  /*
   * One floating card for the whole panel, positioned in viewport space. A
   * tooltip living inside the row would be clipped by the board's own
   * scrollers (Review's table sits in an overflow:auto box), and a native
   * `title` cannot hold a five-line card or be screenshotted.
   */

  let tip = null;
  let anchor = null;

  function ensureTip(doc) {
    if (tip && tip.ownerDocument === doc && tip.isConnected) return tip;
    tip = doc.createElement('div');
    tip.className = 'lbtip';
    tip.id = 'lbtip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    doc.body.append(tip);
    return tip;
  }

  function fillTip(el, model) {
    const doc = el.ownerDocument;
    el.textContent = '';
    const head = doc.createElement('div');
    head.className = 'lbtip__head';
    if (model.session) head.setAttribute('data-session', model.session);
    head.textContent = model.title;
    const list = doc.createElement('dl');
    list.className = 'lbtip__list';
    for (const line of model.lines) {
      const dt = doc.createElement('dt');
      dt.textContent = line.label;
      const dd = doc.createElement('dd');
      dd.textContent = line.value;
      if (line.muted) dd.setAttribute('data-muted', 'true');
      list.append(dt, dd);
    }
    el.append(head, list);
  }

  function show(target) {
    let cond = null;
    try {
      cond = JSON.parse(target.getAttribute('data-cond') || 'null');
    } catch {
      cond = null;
    }
    const model = tipModel(cond);
    if (!model) return;
    const doc = target.ownerDocument;
    const el = ensureTip(doc);
    fillTip(el, model);
    el.hidden = false;
    anchor = target;
    target.setAttribute('aria-describedby', 'lbtip');
    place(target, el);
  }

  /** Above the time, centred on it; below when there is no room; on screen. */
  function place(target, el) {
    const win = target.ownerDocument.defaultView;
    const r = target.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 8;
    let top = r.top - h - gap;
    if (top < 6) top = r.bottom + gap;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(6, Math.min(left, win.innerWidth - w - 6));
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
  }

  function hide() {
    if (anchor) anchor.removeAttribute('aria-describedby');
    anchor = null;
    if (tip) tip.hidden = true;
  }

  let installedOn = null;

  /** Wire the hover/focus card once per document. Safe to call repeatedly. */
  function install(doc) {
    if (!doc || installedOn === doc) return;
    installedOn = doc;
    const within = (e) => (e.target && e.target.closest ? e.target.closest('[data-cond]') : null);
    doc.addEventListener('mouseover', (e) => {
      const t = within(e);
      if (t && t !== anchor) show(t);
      else if (!t && anchor) hide();
    });
    // Leaving the window fires no mouseover anywhere, so it is caught here.
    doc.addEventListener('mouseout', (e) => {
      if (!e.relatedTarget && anchor) hide();
    });
    doc.addEventListener('focusin', (e) => {
      const t = within(e);
      if (t) show(t);
    });
    doc.addEventListener('focusout', (e) => {
      if (within(e) === anchor) hide();
    });
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && anchor) hide();
    });
    // Follow the time when a board scrolls (focusing a row scrolls it into
    // view, so hiding on every scroll would lose the card to the Tab key);
    // a card left hanging where the row used to be is worse than none, so it
    // goes once the time has left the window or been redrawn away.
    doc.addEventListener(
      'scroll',
      () => {
        if (!anchor || !tip || tip.hidden) return;
        const win = doc.defaultView;
        const r = anchor.getBoundingClientRect();
        if (!anchor.isConnected || r.bottom < 0 || r.top > win.innerHeight) hide();
        else place(anchor, tip);
      },
      true,
    );
  }

  return {
    SESSIONS,
    setTempUnit,
    conditionsOf,
    tipModel,
    summaryText,
    markerText,
    timeHtml,
    decorate,
    install,
    show,
    hide,
  };
});
