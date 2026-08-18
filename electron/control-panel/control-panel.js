/**
 * control-panel.js — renderer logic for the Apex Overlay System window.
 * -----------------------------------------------------------------------------
 * Talks to the main process only through the `window.apex` bridge (preload.js).
 * Responsibilities:
 *   - Load and render current settings + the overlay catalog (with OBS URLs).
 *   - Persist setting changes as the operator edits them.
 *   - Start/stop the server and reflect the live feed status pill.
 *   - Copy overlay URLs to the clipboard.
 */

'use strict';

(function () {
  const $ = (sel) => document.querySelector(sel);

  // --- Elements ------------------------------------------------------------
  const feedPill = $('#feed-pill');
  const feedText = $('#feed-text');
  const powerBtn = $('#power-btn');
  const portInput = $('#port-input');
  const portEcho = $('#port-echo');
  const rateRange = $('#rate-range');
  const rateEcho = $('#rate-echo');
  const demoToggle = $('#demo-toggle');
  const bgRange = $('#bg-range');
  const bgEcho = $('#bg-echo');
  const textRange = $('#text-range');
  const textEcho = $('#text-echo');
  const radarIconsRange = $('#radar-icons-range');
  const radarIconsEcho = $('#radar-icons-echo');
  const glowToggle = $('#glow-toggle');
  const startupToggle = $('#startup-toggle');
  const speedUnit = $('#speed-unit');
  const audioToggle = $('#audio-toggle');
  const audioRange = $('#audio-range');
  const audioEcho = $('#audio-echo');
  const audioTest = $('#audio-test');
  const ingameToggle = $('#ingame-toggle');
  const ingameAutoToggle = $('#ingame-auto-toggle');
  const igEditBtn = $('#ig-edit-btn');
  const igResetBtn = $('#ig-reset-btn');
  const igHotkeyBtn = $('#ig-hotkey');
  const igHotkeyClear = $('#ig-hotkey-clear');
  const sponsorsToggle = $('#sponsors-toggle');
  const sponsorRange = $('#sponsor-range');
  const sponsorEcho = $('#sponsor-echo');
  const sponsorList = $('#sponsor-list');
  const sponsorAdd = $('#sponsor-add');
  const overlayList = $('#overlay-list');
  // Widgets whose catalog entry says group:'streaming' render inside the
  // Streamers tab instead of the main grid — same cards, different mount.
  const streamersWidgetList = $('#streamers-widget-list');
  const combinedUrl = $('#combined-url');
  const toast = $('#toast');
  const errorBanner = $('#error-banner');
  const errorText = $('#error-text');
  const updateBanner = $('#update-banner');
  const updateText = $('#update-text');
  const updateAction = $('#update-action');
  const updateNotes = $('#update-notes');
  const updatesCard = $('#updates-card');
  const updateChannelSel = $('#update-channel');
  const updateChannelHint = $('#update-channel-hint');
  const updateRunning = $('#update-running');
  const updateStatus = $('#update-status');
  const updateCheck = $('#update-check');

  // The Updates card is shown when EITHER is true, and the two answers arrive
  // from different places at different times (admin:whoami over the network,
  // the channel from the main process), so both are remembered rather than read
  // back off the DOM — whichever lands second must not hide what the first one
  // revealed.
  let isStaffAccount = false;
  let followingBeta = false;

  /** League staff can switch channel; anyone already ON beta can switch back. */
  function applyUpdatesCardVisibility() {
    if (updatesCard) updatesCard.hidden = !(isStaffAccount || followingBeta);
  }

  // Human-readable label + dot colour per feed state.
  const FEED_LABEL = {
    live: 'LIVE',
    demo: 'DEMO DATA',
    'no-data': 'NO DATA',
    stopped: 'STOPPED',
  };

  let toastTimer = null;
  function showToast(message) {
    toast.textContent = message;
    toast.setAttribute('data-show', 'true');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.removeAttribute('data-show'), 1400);
  }

  // --- Rendering -----------------------------------------------------------

  // Latest known status/settings — the in-game buttons depend on both.
  let lastStatus = { running: false };
  let lastIngameEnabled = false;

  function syncIngameControls() {
    // Editing needs a live in-game layer: server running + display enabled.
    const canEdit = !!lastStatus.running && lastIngameEnabled;
    const editing = !!lastStatus.ingameEditing;
    igEditBtn.disabled = !canEdit;
    igEditBtn.textContent = editing ? 'Finish editing' : 'Edit layout';
    igEditBtn.setAttribute('data-active', String(editing));
  }

  function renderStatus(status) {
    lastStatus = status;
    const feed = status.running ? status.feed || 'no-data' : 'stopped';
    feedPill.setAttribute('data-feed', feed);
    feedText.textContent = FEED_LABEL[feed] || feed.toUpperCase();
    powerBtn.textContent = status.running ? 'Stop' : 'Start';
    powerBtn.setAttribute('data-running', String(!!status.running));

    // Surface a start-up failure (e.g. busy port) as a persistent banner.
    if (status.error && !status.running) {
      errorText.textContent = status.error;
      errorBanner.hidden = false;
    } else {
      errorBanner.hidden = true;
    }
    syncIngameControls();
    renderShellStatus(status, feed);
  }

  /**
   * The footer status bar. Reads the same status object the nav pill does —
   * deliberately no second source of truth, so the two can never disagree about
   * whether the feed is live.
   *
   * This used to also drive three dashboard stat tiles (feed, port, update
   * rate). The design system spends that strip on driver stats instead, and
   * those three were the same three facts this footer already carries — so the
   * tiles went and the footer stayed.
   */
  function renderShellStatus(status, feed) {
    const label = FEED_LABEL[feed] || feed.toUpperCase();
    setText('#foot-feed-text', label);
    setAttr('#foot-feed', 'data-feed', feed);

    const port = status.port || Number(portInput.value) || null;
    setText('#foot-url', port ? `127.0.0.1:${port}` : '—');

    // The provider is only meaningful while the server is up; "demo" is a feed
    // state rather than a source, so it is named as such instead of as a sim.
    setText(
      '#foot-source',
      !status.running
        ? 'server stopped'
        : feed === 'demo'
          ? 'simulated data'
          : `rFactor 2 / LMU · ${rateRange.value} Hz`,
    );
  }

  /** The one stat tile fed by settings rather than by the lap database. */
  function renderShellSettings(settings) {
    const on = Object.values(settings.enabledOverlays || {}).filter(Boolean).length;
    const total = Object.keys(settings.enabledOverlays || {}).length;
    setText('#stat-widgets', total ? `${on} / ${total}` : '—');
  }

  function setText(sel, text) {
    const el = $(sel);
    if (el) el.textContent = text;
  }

  function setAttr(sel, name, value) {
    const el = $(sel);
    if (el) el.setAttribute(name, value);
  }

  function renderSettings(settings) {
    portInput.value = settings.httpPort;
    portEcho.textContent = settings.httpPort;
    rateRange.value = settings.updateRateHz;
    rateEcho.textContent = settings.updateRateHz;
    demoToggle.checked = !!settings.forceSimulator;
    bgRange.value = settings.panelOpacity;
    bgEcho.textContent = settings.panelOpacity;
    textRange.value = settings.textScale;
    textEcho.textContent = settings.textScale;
    radarIconsRange.value = settings.radarIconScale;
    radarIconsEcho.textContent = settings.radarIconScale;
    glowToggle.checked = settings.changeGlow !== false;
    if (startupToggle) startupToggle.checked = !!settings.launchOnStartup;
    if (speedUnit) speedUnit.value = settings.speedUnit === 'mph' ? 'mph' : 'kph';
    audioToggle.checked = settings.audioCues !== false;
    audioRange.value = settings.audioVolume;
    audioEcho.textContent = settings.audioVolume;
    sponsorsToggle.checked = !!settings.sponsorsEnabled;
    sponsorRange.value = settings.sponsorIntervalSec;
    sponsorEcho.textContent = settings.sponsorIntervalSec;
    ingameToggle.checked = !!settings.ingameEnabled;
    // Missing (pre-update config) reads as ON — the setting ships enabled.
    ingameAutoToggle.checked = settings.ingameAutoHide !== false;
    lastIngameEnabled = !!settings.ingameEnabled;
    if (!capturingHotkey) renderHotkey(settings.ingameToggleShortcut);
    syncIngameControls();
    renderShellSettings(settings);
  }

  // --- In-game toggle hotkey capture --------------------------------------

  let capturingHotkey = false;
  let lastShortcut = 'F8';

  function renderHotkey(accel) {
    lastShortcut = accel || '';
    igHotkeyBtn.textContent = accel || 'Click to set';
    igHotkeyBtn.setAttribute('data-empty', String(!accel));
  }

  // Map a keydown event to an Electron accelerator string, or null if the key
  // is only a modifier / not bindable on its own.
  function eventToAccelerator(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');

    let key = e.key;
    if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') {
      return null; // a bare modifier — wait for the real key
    }
    if (key === ' ' || key === 'Spacebar') key = 'Space';
    else if (key === '+') key = 'Plus';
    else if (/^F\d{1,2}$/.test(key)) {
      /* function keys pass through as-is */
    } else if (key.length === 1) {
      key = key.toUpperCase();
    } else {
      // Named keys (ArrowUp, Escape, Tab, …) — Electron accepts most verbatim.
      key = key.charAt(0).toUpperCase() + key.slice(1);
    }
    return [...mods, key].join('+');
  }

  async function commitHotkey(accel) {
    const state = await window.apex.updateSettings({ ingameToggleShortcut: accel });
    renderHotkey(state.settings.ingameToggleShortcut);
  }

  /**
   * The card's own background slider — this widget's exception to the global
   * "Widget background" one in Appearance.
   *
   * It exists for a layout the global slider cannot express: the whole set faded
   * to 50% so the track shows through, except the one panel that has to be read
   * at a glance, which stays solid. Which panel that is differs per driver and
   * per session, so it is an edit on one card rather than a second global mode.
   *
   * Two states, and the difference matters:
   *   AUTO   no override. The slider SHOWS the global value and follows it as
   *          the operator drags the global one — it is a preview of what this
   *          widget is doing, not a stale copy.
   *   own    an override. The widget ignores the global entirely, at any value,
   *          including one that happens to equal it right now.
   *
   * Touching the slider takes the widget out of Auto; the button beside it puts
   * it back. Without that button an override could only be approximated by
   * dragging back to whatever the global happens to be, which would then stop
   * tracking the global the moment it moved.
   */
  /**
   * How much of the field the standings tower draws.
   *
   * A full grid is 20-30 rows: right for a broadcast, far too much screen for
   * someone driving. Rather than a list of layout presets, the view is composed
   * from the leaders plus a window around you, counted either inside your class
   * or across the field — so "three in front, three behind" and "top ten of
   * each class" are the same three numbers with different values, and anything
   * between them works without anyone having thought of it first.
   *
   * Only the standings card gets this (see `view` in overlaysForUi).
   */
  function standingsRow(o) {
    const wrap = document.createElement('div');
    wrap.className = 'ovcard__view';

    const v = o.view;

    // Sends one field; main merges it over the rest, so the row never has to
    // restate the whole object and two controls cannot race each other.
    const send = async (patch) => {
      await window.apex.updateSettings({ standings: patch });
    };

    const label = document.createElement('span');
    label.className = 'ovcard__bg-label';
    label.textContent = 'SHOW';

    const limit = document.createElement('select');
    limit.className = 'field__input field__input--inline';
    limit.id = 'standings-limit';
    for (const [value, text] of [
      ['all', 'Whole field'],
      ['custom', 'Just these cars…'],
    ]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      limit.appendChild(opt);
    }
    limit.value = v.limit;
    limit.title = 'How much of the field the standings tower draws';

    // The four numbers, hidden wholesale while the tower shows everything —
    // there is nothing to tune in that state, and four disabled spinners read
    // as a broken card rather than an inapplicable one.
    const detail = document.createElement('div');
    detail.className = 'ovcard__view-detail';

    const num = (id, key, text, hint) => {
      const field = document.createElement('label');
      field.className = 'ovcard__view-num';
      const cap = document.createElement('span');
      cap.className = 'ovcard__view-cap';
      cap.textContent = text;
      const input = document.createElement('input');
      input.className = 'field__input';
      input.id = id;
      input.type = 'number';
      input.min = '0';
      input.max = '30';
      input.step = '1';
      input.value = String(v[key]);
      input.title = hint;
      input.addEventListener('change', () => {
        let n = parseInt(input.value, 10);
        if (!Number.isFinite(n)) n = 0;
        n = Math.min(30, Math.max(0, n));
        input.value = String(n);
        void send({ [key]: n });
      });
      field.appendChild(cap);
      field.appendChild(input);
      return field;
    };

    const scope = document.createElement('select');
    // Short labels on purpose: this sits in a half-width cell on a card, and a
    // clipped option is worse than a terse one.
    scope.className = 'field__input';
    scope.id = 'standings-scope';
    for (const [value, text] of [
      ['class', 'My class'],
      ['field', 'All classes'],
    ]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      scope.appendChild(opt);
    }
    scope.value = v.scope;
    scope.title =
      'Whether the counts below mean cars in your own class, or cars anywhere in the field';
    scope.addEventListener('change', () => void send({ scope: scope.value }));

    const scopeWrap = document.createElement('label');
    scopeWrap.className = 'ovcard__view-num';
    const scopeCap = document.createElement('span');
    scopeCap.className = 'ovcard__view-cap';
    scopeCap.textContent = 'Counted';
    scopeWrap.appendChild(scopeCap);
    scopeWrap.appendChild(scope);

    detail.appendChild(num('standings-top', 'top', 'Leaders', 'Cars at the front, always shown'));
    detail.appendChild(num('standings-ahead', 'ahead', 'Ahead', 'Cars in front of you'));
    detail.appendChild(num('standings-behind', 'behind', 'Behind', 'Cars behind you'));
    detail.appendChild(scopeWrap);

    const paint = () => {
      detail.hidden = limit.value !== 'custom';
    };
    limit.addEventListener('change', () => {
      paint();
      void send({ limit: limit.value });
    });
    paint();

    const head = document.createElement('div');
    head.className = 'ovcard__view-head';
    head.appendChild(label);
    head.appendChild(limit);

    // What the GAP column counts. Its own row rather than part of the detail
    // block above: this applies to every row the tower draws, so it must stay
    // reachable while the tower is showing the whole field.
    const gapLabel = document.createElement('span');
    gapLabel.className = 'ovcard__bg-label';
    gapLabel.textContent = 'GAP';

    const gap = document.createElement('select');
    gap.className = 'field__input field__input--inline';
    gap.id = 'standings-gap';
    for (const [value, text] of [
      ['leader', 'To the leader'],
      ['ahead', 'To the car ahead'],
    ]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      gap.appendChild(opt);
    }
    gap.value = v.gap;
    gap.title =
      'Whether the GAP column counts the cumulative gap to the class leader, ' +
      'or the interval to the car directly in front';
    gap.addEventListener('change', () => void send({ gap: gap.value }));

    const gapHead = document.createElement('div');
    gapHead.className = 'ovcard__view-head';
    gapHead.appendChild(gapLabel);
    gapHead.appendChild(gap);

    // What the fastest-lap banner reports. Also its own row, and for the same
    // reason as GAP: it is a fact about the race rather than about the panel's
    // composition, so it has to stay reachable however much of the field is
    // showing.
    const flLabel = document.createElement('span');
    flLabel.className = 'ovcard__bg-label';
    // "FASTEST", not "FASTEST LAP": the labels in this card set the width every
    // dropdown aligns to (see .ovcard__view-head), and the longer wording buys
    // nothing next to a control that says "Fastest overall".
    flLabel.textContent = 'FASTEST';

    const fastest = document.createElement('select');
    fastest.className = 'field__input field__input--inline';
    fastest.id = 'standings-fastest';
    for (const [value, text] of [
      ['class', 'Fastest in each class'],
      ['overall', 'Fastest overall'],
    ]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      fastest.appendChild(opt);
    }
    fastest.value = v.fastest;
    fastest.title =
      'Whether the banner reports one fastest lap per class, or the single ' +
      'fastest lap of the race — in a multiclass field the overall fastest ' +
      'always belongs to the quickest category';
    fastest.addEventListener('change', () => void send({ fastest: fastest.value }));

    const flHead = document.createElement('div');
    flHead.className = 'ovcard__view-head';
    flHead.appendChild(flLabel);
    flHead.appendChild(fastest);

    // Which position the panel header reports. Its own row for the same reason
    // again: it is a fact about the driver's race, not about how many rows are
    // drawn, and in a multiclass field it is the setting that decides whether
    // the biggest number on the panel is the one being raced for.
    const posLabel = document.createElement('span');
    posLabel.className = 'ovcard__bg-label';
    posLabel.textContent = 'POSITION';

    const pos = document.createElement('select');
    pos.className = 'field__input field__input--inline';
    pos.id = 'standings-pos';
    for (const [value, text] of [
      ['overall', 'In the field'],
      ['class', 'In my class'],
    ]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      pos.appendChild(opt);
    }
    // Defensive default: a config written by an older build has no `pos` at all,
    // and a select handed undefined shows an empty box rather than a setting.
    pos.value = v.pos === 'class' ? 'class' : 'overall';
    pos.title =
      'Whether the number in the standings header is your place in the whole ' +
      'field or in your own class — in a multiclass race a GT3 running 35th ' +
      'of 38 can be leading its class';
    pos.addEventListener('change', () => void send({ pos: pos.value }));

    const posHead = document.createElement('div');
    posHead.className = 'ovcard__view-head';
    posHead.appendChild(posLabel);
    posHead.appendChild(pos);

    // How precisely the GAP/INT column is read. Directly under GAP, because it
    // is a fact about that same column and the two are set together.
    const dpLabel = document.createElement('span');
    dpLabel.className = 'ovcard__bg-label';
    // "DECIMALS", not "PRECISION": the label column has a 58px floor sized to
    // clear the longest of these (see .ovcard__view-head), and a ninth character
    // would push this one dropdown out of line with the other four.
    dpLabel.textContent = 'DECIMALS';

    const decimals = document.createElement('select');
    decimals.className = 'field__input field__input--inline';
    decimals.id = 'standings-decimals';
    for (const [value, text] of [
      ['3', '+1.234  (thousandths)'],
      ['2', '+1.23  (hundredths)'],
      ['1', '+1.2  (tenths)'],
    ]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      decimals.appendChild(opt);
    }
    // Defensive default, same idiom as POSITION below: a config written by an
    // older build has no `decimals` at all, and a select handed undefined shows
    // an empty box rather than a setting.
    decimals.value = String(v.decimals === 1 || v.decimals === 2 ? v.decimals : 3);
    decimals.title =
      'How many decimal places the GAP column shows. The third one changes ' +
      'every frame whatever the cars are doing, so fewer places is often the ' +
      'more readable number — and the column hands the width it saves to the ' +
      'driver names';
    decimals.addEventListener('change', () =>
      void send({ decimals: parseInt(decimals.value, 10) })
    );

    const dpHead = document.createElement('div');
    dpHead.className = 'ovcard__view-head';
    dpHead.appendChild(dpLabel);
    dpHead.appendChild(decimals);

    // How the driver names are written. Its own row for the same reason as the
    // rest: it applies to every row the tower draws, however many that is.
    const nmLabel = document.createElement('span');
    nmLabel.className = 'ovcard__bg-label';
    nmLabel.textContent = 'NAMES';

    const names = document.createElement('select');
    names.className = 'field__input field__input--inline';
    names.id = 'standings-names';
    // The options are the abbreviation itself rather than a description of it —
    // "Initial and surname" is a sentence you have to decode, "M.Haskins" is the
    // thing that will be on the screen.
    for (const [value, text] of [
      ['full', 'Matt Haskins  (in full)'],
      ['surname', 'M.Haskins'],
      ['forename', 'Matt.H'],
    ]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      names.appendChild(opt);
    }
    names.value = v.names === 'surname' || v.names === 'forename' ? v.names : 'full';
    names.title =
      'How driver names are written in the tower. Abbreviating also stands the ' +
      'rating marks down so the name actually gets the room — the car badge ' +
      'stays, the ratings are in the relative panel, and the name in full is ' +
      "always on the row's tooltip";
    names.addEventListener('change', () => void send({ names: names.value }));

    const nmHead = document.createElement('div');
    nmHead.className = 'ovcard__view-head';
    nmHead.appendChild(nmLabel);
    nmHead.appendChild(names);

    wrap.appendChild(head);
    wrap.appendChild(detail);
    wrap.appendChild(gapHead);
    wrap.appendChild(dpHead);
    wrap.appendChild(nmHead);
    wrap.appendChild(flHead);
    wrap.appendChild(posHead);
    return wrap;
  }

  /**
   * The design dropdown, for widgets whose catalog entry declares `designs`
   * (today: the speedo cluster's Apex / LMP2 skins). Entirely data-driven — the
   * options come off the catalog entry and the choice is stored per widget id in
   * `widgetModes`, so the next widget to grow designs adds a list in main.js and
   * nothing here. Selecting the FIRST (default) entry sends `null`, which
   * removes the stored override instead of pinning the default — a config that
   * never chose anything stays silent about it.
   */
  function designRow(o) {
    const row = document.createElement('div');
    row.className = 'ovcard__bg';

    const label = document.createElement('span');
    label.className = 'ovcard__bg-label';
    label.textContent = 'DESIGN';

    const select = document.createElement('select');
    select.className = 'field__input field__input--inline';
    select.id = `design-${o.id}`;
    for (const d of o.designs) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.label;
      select.appendChild(opt);
    }
    select.value = o.design || o.designs[0].id;
    select.title = `Which design the ${o.label} draws — applies live, in OBS and in game`;
    select.setAttribute('aria-label', `${o.label} design`);
    select.addEventListener('change', () => {
      const value = select.value === o.designs[0].id ? null : select.value;
      void window.apex.updateSettings({ widgetModes: { [o.id]: value } });
    });

    row.appendChild(label);
    row.appendChild(select);
    return row;
  }

  function opacityRow(o) {
    const row = document.createElement('div');
    row.className = 'ovcard__bg';
    const auto = o.opacity === undefined || o.opacity === null;
    // The LIVE global, read off its own slider rather than from the state this
    // card was rendered from: the two sliders are on the same screen, and a card
    // still on Auto has to agree with the one the operator just dragged.
    const globalBg = () => {
      const v = parseInt(bgRange.value, 10);
      return Number.isFinite(v) ? v : (o.globalOpacity ?? 100);
    };

    const label = document.createElement('span');
    label.className = 'ovcard__bg-label';
    label.textContent = 'BG';

    const range = document.createElement('input');
    range.className = 'field__range ovcard__bg-range';
    range.type = 'range';
    range.min = '0';
    range.max = '100';
    range.step = '5';
    range.value = String(auto ? globalBg() : o.opacity);
    range.title = `Background for ${o.label} only`;
    range.setAttribute('aria-label', `${o.label} background opacity`);

    const echo = document.createElement('span');
    echo.className = 'ovcard__bg-echo';

    const autoBtn = document.createElement('button');
    autoBtn.type = 'button';
    autoBtn.className = 'ovcard__bg-auto';
    autoBtn.textContent = 'Auto';
    autoBtn.title = 'Follow the global Widget background slider';

    /** Reflect the two states in one place, so they cannot disagree. */
    const paint = (isAuto) => {
      row.setAttribute('data-auto', String(isAuto));
      echo.textContent = `${range.value}%`;
      autoBtn.disabled = isAuto;
      // The echo says WHY the number is what it is; a bare "50%" on a card that
      // is merely following the global reads as an override that isn't there.
      echo.title = isAuto ? 'Following the global slider' : 'This widget only';
    };
    paint(auto);

    range.addEventListener('input', () => {
      paint(false);
      commitWidgetOpacity(o.id, parseInt(range.value, 10));
    });

    autoBtn.addEventListener('click', () => {
      range.value = String(globalBg());
      paint(true);
      // null, not a number: the override is REMOVED (see the settings:update
      // handler), which is what puts the widget back under the global slider.
      commitWidgetOpacity(o.id, null);
    });

    row.appendChild(label);
    row.appendChild(range);
    row.appendChild(echo);
    row.appendChild(autoBtn);
    return row;
  }

  /**
   * One card per widget, in the design system's Overlays grid (`.ovgrid` /
   * `.ovcard` from Views.jsx). The kit's card carries a single switch; ours
   * carries the two destinations the app actually has — the OBS Browser-Source
   * URL and the in-game layer — because a widget can be on in one and off in the
   * other, and collapsing them to one toggle would remove a real capability.
   *
   * Built with createElement and per-card listeners, exactly as the previous
   * row list was: the handlers are attached to the elements this function
   * creates, so restyling cannot detach them. Only class names and nesting
   * changed here — the same five controls exist per widget.
   */
  function renderOverlays(overlays, combined) {
    overlayList.innerHTML = '';
    if (streamersWidgetList) streamersWidgetList.innerHTML = '';
    for (const o of overlays) {
      const li = document.createElement('li');
      li.className = 'card ovcard';
      li.setAttribute('data-enabled', String(o.enabled));

      /* -- banner: a widget that has been reworked says so, across the top of
       * its own card. Driven entirely by `banner` on the catalog entry (see
       * OVERLAY_CATALOG in main.js), so this stays a plain map over the catalog
       * and no widget id is named here. */
      let bannerEl = null;
      if (o.banner) {
        bannerEl = document.createElement('div');
        bannerEl.className = 'ovcard__banner';
        bannerEl.textContent = o.banner;
      }

      /* -- header: icon, name, OBS switch -- */
      const head = document.createElement('div');
      head.className = 'ovcard__head';

      const icon = document.createElement('span');
      icon.className = 'ovIcon';
      const iconName = (window.APEX_WIDGET_ICONS || {})[o.id] || 'monitor';
      icon.innerHTML = window.apexIcon ? window.apexIcon(iconName) : '';

      const name = document.createElement('span');
      name.className = 'ovcard__name';
      name.textContent = o.label;
      name.title = o.label;

      head.appendChild(icon);
      head.appendChild(name);

      /* -- description -- */
      const desc = document.createElement('p');
      desc.className = 'ovcard__desc';
      desc.textContent = o.description;

      /* -- URL + copy + preview -- */
      const urlWrap = document.createElement('div');
      urlWrap.className = 'ovcard__url url-box';
      const urlInput = document.createElement('input');
      urlInput.className = 'url-box__input';
      urlInput.type = 'text';
      urlInput.readOnly = true;
      urlInput.value = o.url;
      // Icon buttons: at four cards across there is no room for two text
      // buttons, and copy/open are the two most universally understood glyphs.
      const copyBtn = document.createElement('button');
      copyBtn.className = 'iconbtn sm';
      copyBtn.type = 'button';
      copyBtn.title = 'Copy URL';
      copyBtn.setAttribute('aria-label', `Copy ${o.label} URL`);
      copyBtn.innerHTML = window.apexIcon ? window.apexIcon('copy') : 'Copy';
      copyBtn.addEventListener('click', () => copyUrl(o.url, o.label));
      const previewBtn = document.createElement('button');
      previewBtn.className = 'iconbtn sm';
      previewBtn.type = 'button';
      previewBtn.title = 'Preview in browser';
      previewBtn.setAttribute('aria-label', `Preview ${o.label}`);
      previewBtn.innerHTML = window.apexIcon ? window.apexIcon('external-link') : 'Preview';
      previewBtn.addEventListener('click', () => window.apex.openInBrowser(o.url));
      urlWrap.appendChild(urlInput);
      urlWrap.appendChild(copyBtn);
      urlWrap.appendChild(previewBtn);

      /* -- footer: the two destinations, each labelled --
       *
       * Both switches live here side by side rather than one in the header,
       * because "on" is ambiguous for a widget with two independent
       * destinations: a card whose only toggle sat next to its name would say
       * nothing about WHICH of OBS and the in-game layer it controlled. The app's
       * own .switch component is reused so these read as the same control as
       * "Show in game" and "Demo mode" elsewhere. */
      const foot = document.createElement('div');
      foot.className = 'ovcard__foot';

      /** One labelled destination toggle. */
      const destination = (label, on, title, onChange) => {
        const wrap = document.createElement('label');
        wrap.className = 'ovcard__dest';
        wrap.setAttribute('data-on', String(!!on));
        wrap.title = title;
        const text = document.createElement('span');
        text.className = 'ovcard__dest-label';
        text.textContent = label;
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!on;
        const track = document.createElement('span');
        track.className = 'switch__track';
        track.innerHTML = '<span class="switch__thumb"></span>';
        const sw = document.createElement('span');
        sw.className = 'switch';
        sw.appendChild(input);
        sw.appendChild(track);
        input.addEventListener('change', () => {
          wrap.setAttribute('data-on', String(input.checked));
          onChange(input.checked);
        });
        wrap.appendChild(text);
        wrap.appendChild(sw);
        return wrap;
      };

      const obsDest = destination('OBS', o.enabled, 'Show as an OBS Browser Source', (on) =>
        toggleOverlay(o.id, on),
      );

      const igDest = destination(
        'In game',
        o.ingame,
        'Show on screen in game (needs "Show in game" on the Dashboard)',
        async (on) => {
          await window.apex.updateSettings({ ingameOverlays: { [o.id]: on } });
        },
      );

      foot.appendChild(obsDest);
      foot.appendChild(igDest);

      // Before the head so it reads as a band across the top of the card; the
      // CSS pulls it out to the card's edges through the card padding.
      if (bannerEl) li.appendChild(bannerEl);
      li.appendChild(head);
      li.appendChild(desc);
      li.appendChild(urlWrap);
      li.appendChild(opacityRow(o));
      if (Array.isArray(o.designs) && o.designs.length) li.appendChild(designRow(o));
      if (o.view) li.appendChild(standingsRow(o));
      li.appendChild(foot);
      const mount = o.group === 'streaming' && streamersWidgetList ? streamersWidgetList : overlayList;
      mount.appendChild(li);
    }
    combinedUrl.value = combined;
  }

  /**
   * The running build, in the top bar under the wordmark. Only rendered once,
   * from the initial state — the version cannot change while the app is open.
   */
  function renderVersion(version) {
    const el = $('#app-version');
    if (!el) return;
    el.textContent = version ? 'v' + version : '';
  }

  function renderAll(state) {
    renderSettings(state.settings);
    renderOverlays(state.overlays, state.combinedUrl);
    renderStatus(state.status);
    renderVersion(state.appVersion);
  }

  // --- Your week -----------------------------------------------------------
  /*
   * The lap database's dashboard card. Everything it shows is read from local
   * files by the main process, so it renders with no account and no network.
   */

  /** `138123` → `"2:18.123"`. Leaderboard formatting: always m:ss.mmm. */
  function formatLapTime(ms) {
    if (!(ms > 0)) return '—';
    const total = Math.round(ms);
    const minutes = Math.floor(total / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    const millis = total % 1000;
    return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }

  /**
   * Time on track, as a driver would say it: "3h 42m", "42m", "8m".
   * Seconds are dropped above a minute — nobody reads the seconds digit of a
   * weekly total, and it would be the only part of the card that never settles.
   */
  function formatDuration(ms) {
    const totalMin = Math.floor(ms / 60000);
    if (totalMin < 1) return ms > 0 ? '<1m' : '0m';
    const hours = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    return hours ? `${hours}h ${mins}m` : `${mins}m`;
  }

  /**
   * Metres → km with one decimal below 100 km, whole km above.
   *
   * Empty reads `0 km`, not `0 m`: this tile is a kilometre tile, and on first
   * run — the state every new driver sees — switching the unit just to say zero
   * makes the card look like it is reporting something it isn't.
   */
  function formatDistance(metres) {
    if (!metres) return '0 km';
    const km = metres / 1000;
    if (km < 1) return `${Math.round(metres)} m`;
    return km < 100 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
  }

  /** `"2026-07-21"` → `"21 Jul"`. Parsed as parts, not `new Date(str)`. */
  function formatDayStamp(stamp) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(stamp || ''));
    if (!m) return '';
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] || ''}`.trim();
  }

  /** `"2026-07-21"` → `"Tue"`. Built from the stamp, never from a local Date. */
  function weekdayOf(stamp) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(stamp || ''));
    if (!m) return '';
    // Parsed as UTC to match how the day files are named. Using the local
    // constructor would relabel every bar for anyone west of Greenwich.
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()] || '';
  }

  /**
   * The design system's WeeklyCard: one bar per day, the busiest lit with the
   * brand gradient and captioned with its lap count.
   *
   * Bars are sized as a percentage of the biggest day rather than of some fixed
   * ceiling, so the chart is about the SHAPE of your week — which days you
   * actually drove — rather than about hitting a target nobody set.
   */
  function renderWeekChart(byDay) {
    const chart = $('#week-chart');
    if (!chart) return;
    chart.textContent = '';
    const peak = byDay.reduce((max, d) => Math.max(max, d.laps || 0), 0);

    for (const entry of byDay) {
      const laps = entry.laps || 0;
      // Ties go to the later day, so "busiest" reads as the most recent peak
      // rather than an identical one from six days ago.
      const isPeak = peak > 0 && laps === peak;

      const col = document.createElement('div');
      col.className = 'weekbar';
      col.setAttribute('data-peak', String(isPeak));
      col.title = `${entry.day} — ${laps} lap${laps === 1 ? '' : 's'}`;

      const track = document.createElement('div');
      track.className = 'weekbar__track';
      const fill = document.createElement('div');
      fill.className = 'weekbar__fill';
      // A floor of 4% so a zero day still draws a visible baseline — an absent
      // bar reads as missing data rather than as a day off.
      fill.style.height = peak > 0 ? `${Math.max(4, (laps / peak) * 100)}%` : '4%';
      if (isPeak) {
        const cap = document.createElement('span');
        cap.className = 'weekbar__count';
        cap.textContent = String(laps);
        fill.append(cap);
      }
      track.append(fill);

      const label = document.createElement('span');
      label.className = 'weekbar__day';
      label.textContent = weekdayOf(entry.day);

      col.append(track, label);
      chart.append(col);
    }
  }

  function renderWeek(summary) {
    const s = summary || {};
    const byDay = Array.isArray(s.byDay) ? s.byDay : [];

    // Spell the window out. "This week" is ambiguous the moment anyone wonders
    // whether it means the last seven days or since Monday — and here it is
    // firmly the former, so the card says which seven days it is counting.
    if (byDay.length) {
      const from = formatDayStamp(byDay[0].day);
      const to = formatDayStamp(byDay[byDay.length - 1].day);
      setText(
        '#week-sub',
        `Rolling 7 days · ${from} – ${to}. Laps are counted whenever the server is running.`,
      );
    }

    // The design system's dashboard stat tiles. The fourth is Best pace, filled
    // separately by refreshPace() — it reads all-time bests, not this window.
    setText('#stat-laps-week', String(s.laps || 0));
    setText('#stat-time-driven', formatDuration(s.drivingMs || 0));
    setText('#stat-time-sub', s.distanceM ? `${formatDistance(s.distanceM)} covered` : '');
    setText(
      '#week-clean',
      s.laps
        ? `${s.cleanLaps} clean — ${Math.round((s.cleanLaps / s.laps) * 100)}% of your laps.`
        : '',
    );

    // With no laps at all the chart is seven flat slivers, which reads as broken
    // rather than as empty. Show the explanation instead, and bring the chart
    // back the moment there is a shape to draw.
    const hasLaps = (s.laps || 0) > 0;
    renderWeekChart(byDay);
    const chart = $('#week-chart');
    if (chart) chart.hidden = !hasLaps;
    const empty = $('#week-empty');
    if (empty) empty.hidden = hasLaps;

    const bests = Array.isArray(s.bests) ? s.bests : [];
    const wrap = $('#week-bests');
    if (wrap) wrap.hidden = bests.length === 0;
    // Each entry holds the lap and, once the main process answers, its score.
    weekBests = bests.map((b) => ({ best: b, row: null }));
    renderWeekBests();
    scoreWeekBests();
  }

  /**
   * This week's best laps, with their reference scores once they arrive.
   *
   * Held in module state for the same reason `lastPaceData` is: clicking a row
   * has to repaint the list's selection, and re-reading the lap files to do that
   * would make a highlight cost a disk scan.
   */
  let weekBests = [];
  /** Guards a slow scoring reply from painting over a newer summary. */
  let weekScoreRequest = 0;

  /**
   * Score the week's laps.
   *
   * These cannot come from `lapsPace()`, which reads ALL-TIME bests: at a track
   * where you went quicker last month, that call would score a lap that is not
   * the one on this list and print the percentage next to this week's time. So
   * the rows are scored as themselves, through the same scorer.
   */
  function scoreWeekBests() {
    if (!weekBests.length) return;
    const ticket = ++weekScoreRequest;
    const laps = weekBests.map(({ best: b }) => ({
      track: b.track,
      // The three layout hints the lap already carried when it was recorded.
      // Without them a multi-layout circuit cannot be resolved and the row comes
      // back unscored — which is the honest answer, not a reason to guess.
      trackConfig: b.trackConfig,
      simTrackName: b.simTrackName,
      trackLengthM: b.trackLengthM,
      carClass: b.carClass,
      car: b.car,
      lapMs: b.lapMs,
    }));
    window.apex
      .lapsScore(laps)
      .then((scored) => {
        if (ticket !== weekScoreRequest) return;
        // A short array means scoring was unavailable (an unbuilt `dist/`), and
        // the rows stay unscored and inert rather than pairing up out of step.
        if (!Array.isArray(scored) || scored.length !== weekBests.length) return;
        weekBests.forEach((entry, i) => {
          entry.row = scored[i];
        });
        renderWeekBests();
      })
      .catch(() => {});
  }

  /**
   * The week's bests as the pace list's row shape — track, class, lap, score.
   *
   * Still no position column, and that omission is the point. A position only
   * means something within one track and one class; these rows span both, so
   * numbering them would rank a 1:31 at Fuji above a 3:27 at Le Mans and call it
   * a result. Same reasoning retires the purple "fastest" highlight here: it is
   * the kit's signal for quickest in a comparable set, and nothing on this list
   * is comparable. The percentage IS comparable across tracks, which is exactly
   * why it can be added where a position cannot. The Leaderboard tab is where
   * real positions belong.
   */
  function renderWeekBests() {
    const list = $('#week-bests-list');
    if (!list) return;
    list.textContent = '';

    // A week row is highlighted only when it was the one clicked. With nothing
    // selected the cards are describing your ALL-TIME best, which is a lap from
    // the other list — highlighting the week row that happens to share its key
    // would point at a different time from the one on the card.
    const shownKey =
      selectedPace && selectedPace.source === 'week' ? selectedPace.key : '';

    for (const { best: b, row } of weekBests) {
      const li = document.createElement('li');
      li.className = 'lbrow';
      li.setAttribute('data-band', paceBandOf(row));

      // Only a scored row is selectable, exactly as on the pace list: there is
      // nothing for the card above to show for a lap whose reference could not
      // be found, and a button that visibly does nothing is worse than a row
      // that was never a button.
      if (row && row.ok) {
        const selected = String(paceKeyOf(row) === shownKey);
        li.setAttribute('data-pick', 'true');
        li.setAttribute('data-selected', selected);
        li.tabIndex = 0;
        li.setAttribute('role', 'button');
        li.setAttribute('aria-pressed', selected);
        li.title = 'Show this lap in Pace rank';
        li.addEventListener('click', () => selectPaceRow(row, 'week'));
        // Keyboard parity: the list is a column of buttons, so it has to be
        // reachable without a mouse like every other control in the panel.
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectPaceRow(row, 'week');
          }
        });
      }

      // createElement rather than innerHTML throughout: track and car names come
      // from the sim, and the panel's CSP would not save us from a mod pack with
      // a bracket in its name mangling the row.
      const track = document.createElement('span');
      track.className = 'lbrow__name';
      // Once scored, the venue the reference table names — which is what the
      // card above will say, and two names for one circuit on one screen reads
      // as two circuits.
      track.textContent = row && row.ok ? paceWhere(row) : b.track || '—';
      track.title = track.textContent;

      const mid = document.createElement('span');
      mid.className = 'lbrow__mid';
      const cls = document.createElement('span');
      cls.className = 'chip';
      cls.textContent = (row && row.ok && row.sheetClass) || classLabel(b.carClass) || '—';
      mid.append(cls);
      if (row && !row.ok) {
        // The reason, where the eye already is. A driver who wonders why one row
        // has no score is asking about that row, not about the feature.
        const why = document.createElement('span');
        why.className = 'lbrow__why';
        why.textContent = row.detail || 'No reference for this combination.';
        why.title = why.textContent;
        mid.append(why);
      } else {
        const car = document.createElement('span');
        car.className = 'lbrow__car';
        car.textContent = b.car || '';
        car.title = b.car || '';
        mid.append(car);
      }

      const time = document.createElement('span');
      time.className = 'lbrow__time';
      time.textContent = formatLapTime(b.lapMs);

      const score = document.createElement('span');
      score.className = 'lbrow__score';
      if (row && row.ok) {
        score.textContent = `${row.percent.toFixed(1)}%`;
        score.title = row.assumed
          ? `${row.bandLabel} — reference row partly assumed (${row.sheetClass})`
          : `${row.bandLabel} — reference ${formatLapTime(row.refMs)}`;
        // The assumption the scorer flagged gets a visible mark rather than
        // being silently rounded away.
        if (row.assumed) score.textContent += ' ?';
      } else {
        score.textContent = row ? '—' : '';
      }

      li.append(track, mid, time, score);
      list.append(li);
    }
  }

  /** Pull a fresh summary. Cheap, and always current when the card is shown. */
  function refreshWeek() {
    window.apex.lapsWeek().then(renderWeek).catch(() => renderWeek(null));
  }

  // --- Pace vs reference ---------------------------------------------------
  /*
   * Your best clean laps scored against the pace an alien runs in the same class
   * at the same track — the Dashboard's fourth tile and the Leaderboard tab's
   * card. All the numbers come from Ohne Speed's spreadsheet; see the credit
   * block, which renders from the same payload as the scores so the two cannot
   * be separated.
   *
   * Two things this deliberately does NOT do:
   *   - rank the rows against each other. 101% at Spa and 103% at Fuji are
   *     comparable in a way lap times are not, so the list IS sorted best-first
   *     — but it carries no position column, because a position implies a field
   *     and there is only one driver in this data.
   *   - hide the laps it could not score. "Monza has two layouts and the sim
   *     didn't say which" is the answer to the question a driver would otherwise
   *     ask, and dropping those rows turns a known limitation into a mystery.
   */

  /** Where a percentage sits on the band ladder, for the row's tint. */
  function paceBandOf(row) {
    return row && row.ok ? row.bandId || 'none' : 'none';
  }

  /**
   * A car class as a person would write it.
   *
   * Boards are keyed on the canonical class the provider sends, and one of those
   * carries LMU's own punctuation: `LMP2_ELMS`. The key has to stay as it is —
   * it is what the lap database stores and what the reference table looks up —
   * but an underscore has no business on a filter chip. Mirrors the same map in
   * `overlay/js/client.js`; there is no import between a renderer and the overlay
   * bundle, so this is a deliberate two-line copy.
   */
  const CLASS_LABELS = { LMP2_ELMS: 'LMP2 ELMS' };
  function classLabel(cls) {
    return CLASS_LABELS[cls] || cls || '';
  }

  /**
   * Percent-off-reference → a 0–100 position on the kit's RankBar.
   *
   * The RankBar runs OK → GOOD → 102% → ALIEN left to right, so faster is
   * further RIGHT. The overlay refpace ladder uses the same convention via an
   * inverted `ladderPos()` in refpace.js — keep the two in sync.
   *
   * 100% pins to Alien and 107% to the floor, which puts 102% at 71 — within a
   * few pixels of where the kit prints its own "102%" zone label.
   */
  const RANK_FLOOR_PCT = 107;
  const RANK_TOP_PCT = 100;
  function paceRankPct(percent) {
    const span = RANK_FLOOR_PCT - RANK_TOP_PCT;
    return Math.max(0, Math.min(100, ((RANK_FLOOR_PCT - percent) / span) * 100));
  }

  /** `+0.42` / `−1.08` / `—`. Signed with a real minus, like the overlay. */
  function formatGap(sec) {
    if (typeof sec !== 'number' || !isFinite(sec)) return '';
    return `${sec > 0 ? '+' : sec < 0 ? '−' : ''}${Math.abs(sec).toFixed(2)}s`;
  }

  /**
   * Where a scored row was set, in as few words as carry the meaning.
   *
   * A layout name alone is useless — "Grand Prix" is fourteen different
   * circuits — and the venue alone loses the distinction the whole resolver
   * exists to make. So it is the venue, plus the layout only where the circuit
   * actually has more than one worth naming.
   */
  function paceWhere(row) {
    const venue = row.circuitName || row.track || '';
    const layout = row.layoutName || '';
    if (!layout || !venue) return venue || layout || '—';
    // `via: 'only'` means the reference table holds one layout for this circuit,
    // so naming it adds nothing — "Circuit de Spa-Francorchamps · Grand Prix"
    // is just a longer way of saying Spa.
    if (row.via === 'only') return venue;
    return venue.toLowerCase().includes(layout.toLowerCase()) ? venue : `${venue} · ${layout}`;
  }

  /**
   * Fill one RankBar card — the Dashboard's and the Leaderboard's are the same
   * component with different ids, exactly as they are the same `<RankBar>` in
   * the kit. Passing the ids in rather than duplicating the function is what
   * stops the two drifting into slightly different wording.
   */
  function renderRankCard(ids, best) {
    const card = $(ids.card);
    if (card) card.hidden = !best;
    if (!best) return;

    setAttr(ids.card, 'data-band', paceBandOf(best));
    setText(ids.pct, `${best.percent.toFixed(1)}%`);
    setText(ids.band, best.bandLabel || '—');
    setText(ids.rankName, best.bandLabel || '—');
    setText(ids.lap, formatLapTime(best.lapMs));

    const gap = (best.lapMs - best.refMs) / 1000;
    setText(ids.gap, `${formatGap(gap)} to reference`);
    setAttr(ids.gap, 'data-state', gap > 0 ? 'behind' : gap < 0 ? 'ahead' : 'flat');

    const dot = $(ids.dot);
    if (dot) {
      dot.hidden = false;
      dot.style.left = `${paceRankPct(best.percent)}%`;
    }

    // The kit writes this line as "0.24s from 102% pace" — a distance to the
    // next rung rather than a restatement of the number above it, which is the
    // only part of the card that says what to do next.
    const note = $(ids.note);
    if (note) {
      note.textContent = '';
      const target = best.percent > 102 ? 102 : best.percent > 100 ? 100 : null;
      if (target === null) {
        note.append(
          document.createTextNode(
            `On the reference pace for ${best.sheetClass} at ${paceWhere(best)}.`,
          ),
        );
      } else {
        const need = (best.lapMs - best.refMs * (target / 100)) / 1000;
        note.append(document.createTextNode(`${need.toFixed(2)}s from `));
        const strong = document.createElement('strong');
        strong.textContent = `${target}%`;
        note.append(strong, document.createTextNode(` pace at ${paceWhere(best)}.`));
      }
    }
  }

  /**
   * Which scored lap of YOURS the two RankBar cards are describing.
   *
   * It used to be hardwired to your single best result, which made the card a
   * headline rather than a tool: the lap you want to look at is almost never
   * your best one, it is the one you just drove badly. So the lists are
   * selectable and this holds the choice, keyed by track+class+car rather than
   * by index — a refresh re-sorts the rows, and an index would quietly slide
   * onto a different lap underneath you.
   *
   * The SOURCE is part of the selection, not decoration. Two lists feed this and
   * they hold different laps: the Leaderboard's are all-time bests, the
   * Dashboard's are this week's. At a track where you went quicker last month
   * both lists carry a row with the same track, class and car — the same key —
   * and different times. Without the source, clicking the week's 2:20.4 would
   * find the all-time row first and the card would answer with 2:19.5: a lap you
   * did not click, three lines above a row that says otherwise.
   *
   * The row travels along so the card can always show the lap that was clicked,
   * even when a refresh no longer carries it.
   */
  let selectedPace = null;
  /** Last payload, so a selection can re-render without another IPC round trip. */
  let lastPaceData = null;

  function paceKeyOf(row) {
    return row ? `${row.track}|${row.carClass}|${row.car || ''}` : '';
  }

  /** The row the cards should show: the chosen one, or your best as the default. */
  function selectedPaceRow(data) {
    const rows = (data && data.rows) || [];
    const scored = rows.filter((r) => r.ok);
    if (selectedPace) {
      // Re-resolve within the SAME list, so a refresh updates the numbers rather
      // than freezing the click — and never crosses to the other list, where an
      // equal key means a different lap.
      const fresh =
        selectedPace.source === 'week'
          ? weekBests.map((e) => e.row).filter((r) => r && r.ok)
          : scored;
      return fresh.find((r) => paceKeyOf(r) === selectedPace.key) || selectedPace.row;
    }
    return (data && data.best) || scored[0] || null;
  }

  /**
   * Load one of your laps into the cards.
   *
   * `source` is which list it came from — `'pace'` for the Leaderboard's
   * all-time bests, `'week'` for the Dashboard's. Both lists are repainted
   * because only one of them can hold the selection at a time, and the other has
   * to let go of whatever it was showing as selected.
   */
  function selectPaceRow(row, source) {
    if (!row || !row.ok) return;
    const key = paceKeyOf(row);
    // Clicking the selected row again clears back to your best, so the default
    // view is always one click away rather than requiring a tab round trip.
    selectedPace =
      selectedPace && selectedPace.source === source && selectedPace.key === key
        ? null
        : { source, key, row };
    renderPace(lastPaceData);
    renderWeekBests();
  }

  function renderPace(data) {
    const d = data || {};
    lastPaceData = d;
    const rows = Array.isArray(d.rows) ? d.rows : [];
    // The tile always reports your best; only the detail cards follow the
    // selection. A stat tile that changed when you clicked a list further down
    // the page would stop being a stat.
    const best = d.best || null;
    const shown = selectedPaceRow(d);

    // --- Dashboard tile ---
    // The kit's Stat shows the BAND as the value ("Good"), not the number: a
    // band is actionable at a glance and a percentage has to be decoded first.
    // The number moves to the sub-line, where it qualifies rather than leads.
    setText('#stat-pace', best ? best.bandLabel : '—');
    setAttr('#stat-pace', 'data-band', paceBandOf(best));
    setText(
      '#stat-pace-sub',
      best
        ? `${best.percent.toFixed(1)}% · ${best.sheetClass} at ${paceWhere(best)}`
        : rows.length
          ? 'No lap could be matched to a reference yet.'
          : '',
    );

    // --- The two RankBar cards ---
    renderRankCard(
      {
        card: '#pace-card',
        pct: '#rank-pct',
        band: '#rank-band',
        rankName: '#rank-name',
        lap: '#rank-lap',
        gap: '#rank-gap',
        dot: '#rank-dot',
        note: '#rank-note',
      },
      shown,
    );
    renderLbRank();

    // --- Leaderboard card ---
    const list = $('#pace-list');
    const empty = $('#pace-empty');
    if (!list || !empty) return;
    list.textContent = '';
    empty.hidden = rows.length > 0;

    // Highlight this list's own selection, or — with nothing selected — the best
    // lap the cards default to. While a DASHBOARD row is selected nothing here
    // is highlighted: the cards are describing a lap from that list, and a row
    // here with the same key is a different time at the same track.
    const shownKey =
      selectedPace && selectedPace.source === 'week' ? '' : paceKeyOf(shown);
    for (const row of rows) {
      const li = document.createElement('li');
      li.className = 'lbrow';
      li.setAttribute('data-band', paceBandOf(row));

      // Only a scored row is selectable: there is nothing for the cards above to
      // show for a lap whose reference could not be found, and a button that
      // visibly does nothing is worse than a row that was never a button.
      if (row.ok) {
        li.setAttribute('data-pick', 'true');
        li.setAttribute('data-selected', String(paceKeyOf(row) === shownKey));
        li.tabIndex = 0;
        li.setAttribute('role', 'button');
        li.setAttribute(
          'aria-pressed',
          String(paceKeyOf(row) === shownKey),
        );
        li.title = 'Show this lap against its reference';
        li.addEventListener('click', () => selectPaceRow(row, 'pace'));
        // Keyboard parity: the list is a column of buttons, so it has to be
        // reachable without a mouse like every other control in the panel.
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectPaceRow(row, 'pace');
          }
        });
      }

      // createElement throughout — track and car names come from the sim, and
      // the panel's CSP would not save the row from a mod pack with a bracket
      // in its name. Same reasoning as the week card's bests list.
      const name = document.createElement('span');
      name.className = 'lbrow__name';
      name.textContent = row.ok ? paceWhere(row) : row.track || '—';
      name.title = name.textContent;

      // The middle column: the class, and — on a row that could not be scored —
      // the reason, spelled out where the eye already is. It was a tooltip, and
      // a tooltip on the one row a driver will actually question is the wrong
      // place for the answer.
      const mid = document.createElement('span');
      mid.className = 'lbrow__mid';
      const cls = document.createElement('span');
      cls.className = 'chip';
      cls.textContent = row.sheetClass || classLabel(row.carClass) || '—';
      mid.append(cls);
      if (!row.ok) {
        const why = document.createElement('span');
        why.className = 'lbrow__why';
        why.textContent = row.detail || 'No reference for this combination.';
        why.title = why.textContent;
        mid.append(why);
      }

      const time = document.createElement('span');
      time.className = 'lbrow__time';
      time.textContent = formatLapTime(row.lapMs);

      const score = document.createElement('span');
      score.className = 'lbrow__score';
      if (row.ok) {
        score.textContent = `${row.percent.toFixed(1)}%`;
        // The assumption the server flagged — today only the LMP2 ruleset —
        // gets a visible mark rather than being silently rounded away.
        score.title = row.assumed
          ? `${row.bandLabel} — reference row partly assumed (${row.sheetClass})`
          : `${row.bandLabel} — reference ${formatLapTime(row.refMs)}`;
        if (row.assumed) score.textContent += ' ?';
      } else {
        score.textContent = '—';
      }

      li.append(name, mid, time, score);
      list.append(li);
    }

    // --- Attribution ---
    const credit = d.credit;
    const block = $('#pace-credit');
    if (block) block.hidden = !credit;
    if (credit) {
      setText('#pace-credit-title', credit.title);
      setText(
        '#pace-credit-people',
        Array.isArray(credit.contributors) && credit.contributors.length
          ? credit.contributors.join(', ')
          : 'the community',
      );
      setText('#pace-credit-updated', d.sheetUpdated ? `Sheet updated ${d.sheetUpdated}.` : '');
      creditLinks = {
        '#pace-credit-sheet': credit.sheetUrl,
        '#pace-credit-discord': credit.discordUrl,
        '#pace-credit-youtube': credit.youtubeUrl,
      };
    }
  }

  /**
   * The Leaderboard tab's RankBar card, which answers about ONE driver at a time.
   *
   * By default that driver is you, and the card matches the Dashboard's. Click a
   * name on a league board and it answers about them instead: the same
   * percentage, band and ladder position, computed from the same spreadsheet —
   * which is the question a board actually provokes. A board tells you someone
   * is 1.4s up the road; it does not tell you whether that is alien pace or a
   * quiet Tuesday, and the two want different things from you.
   *
   * Only this card follows a board selection. The Dashboard's Pace rank stays
   * yours whatever is clicked here — a tab about your own driving that could be
   * left showing a stranger's lap would be a trap, and you would find it days
   * later wondering when you got quick at Sebring.
   */
  function renderLbRank() {
    const focus = boardFocus || { row: selectedPaceRow(lastPaceData), who: null };
    setText('#lb-rank-title', focus.who ? `${focus.who}'s pace` : 'Your pace');
    renderRankCard(
      {
        card: '#lb-rank',
        pct: '#lb-pct',
        band: '#lb-band',
        rankName: '#lb-rank-name',
        lap: '#lb-lap',
        gap: '#lb-gap',
        dot: '#lb-dot',
        note: '#lb-note',
      },
      focus.row,
    );
  }

  /**
   * The credit block's outbound URLs, filled once the payload arrives.
   *
   * Held in JS rather than written into the HTML as anchors because the panel
   * opens links through the main process (`openInBrowser`) — an <a href> inside
   * an Electron window would navigate the panel itself.
   */
  let creditLinks = {};
  for (const sel of ['#pace-credit-sheet', '#pace-credit-discord', '#pace-credit-youtube']) {
    const btn = $(sel);
    if (btn) {
      btn.addEventListener('click', () => {
        const url = creditLinks[sel];
        if (url) window.apex.openInBrowser(url);
      });
    }
  }

  function refreshPace() {
    window.apex.lapsPace().then(renderPace).catch(() => renderPace(null));
  }

  // --- League leaderboard --------------------------------------------------
  /*
   * The league's own boards, from the cloud — Leaderboard.jsx's sidebar and
   * table. Everything else on this page reads local files; this is the one part
   * of the lap database that is inherently about other people, so it is the one
   * part that needs an account and a connection.
   *
   * The filter list is derived from what the boards ACTUALLY hold
   * (`leaderboard_filters`), never from a hardcoded track list. Offering a
   * dropdown of 31 circuits when three have laps on them is the fastest way to
   * make a working feature look broken.
   */

  /** Every (track, class, car) combination with laps, as returned by the RPC. */
  let boardFilters = [];
  /** The current selection. `car` empty means "All cars". */
  let boardPick = { trackId: '', carClass: '', car: '' };
  /** Guards against an older request overwriting a newer one. */
  let boardRequest = 0;

  function uniqueBy(rows, key) {
    const seen = new Map();
    for (const r of rows) if (!seen.has(r[key])) seen.set(r[key], r);
    return [...seen.values()];
  }

  /** Rebuild the three controls from `boardFilters`, preserving the selection. */
  function renderBoardFilters() {
    const trackSel = $('#board-track');
    const clsWrap = $('#board-classes');
    const carSel = $('#board-car');
    if (!trackSel || !clsWrap || !carSel) return;

    // --- Track ---
    const tracks = uniqueBy(boardFilters, 'track_id').sort((a, b) =>
      String(a.track_name).localeCompare(String(b.track_name)),
    );
    if (!tracks.some((t) => t.track_id === boardPick.trackId)) {
      boardPick.trackId = tracks.length ? tracks[0].track_id : '';
    }
    trackSel.textContent = '';
    for (const t of tracks) {
      const opt = document.createElement('option');
      opt.value = t.track_id;
      opt.textContent = t.track_name;
      opt.selected = t.track_id === boardPick.trackId;
      trackSel.append(opt);
    }
    trackSel.disabled = tracks.length === 0;

    // --- Class: only the classes that have laps AT the chosen track ---
    const atTrack = boardFilters.filter((f) => f.track_id === boardPick.trackId);
    const classes = [...new Set(atTrack.map((f) => f.car_class))].sort();
    if (!classes.includes(boardPick.carClass)) boardPick.carClass = classes[0] || '';
    clsWrap.textContent = '';
    for (const cls of classes) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'clschip';
      btn.textContent = classLabel(cls);
      btn.setAttribute('data-active', String(cls === boardPick.carClass));
      btn.addEventListener('click', () => {
        boardPick.carClass = cls;
        // The car list belongs to the class, so a class change invalidates it.
        boardPick.car = '';
        renderBoardFilters();
        refreshBoard();
      });
      clsWrap.append(btn);
    }

    // --- Car: only cars that have laps in the chosen track AND class ---
    const cars = [
      ...new Set(atTrack.filter((f) => f.car_class === boardPick.carClass).map((f) => f.car)),
    ]
      .filter(Boolean)
      .sort();
    if (boardPick.car && !cars.includes(boardPick.car)) boardPick.car = '';
    carSel.textContent = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All cars';
    all.selected = !boardPick.car;
    carSel.append(all);
    for (const car of cars) {
      const opt = document.createElement('option');
      opt.value = car;
      opt.textContent = car;
      opt.selected = car === boardPick.car;
      carSel.append(opt);
    }
    // One car and no alternative is not a choice; leave it visible but inert
    // rather than offering a filter that cannot change anything.
    carSel.disabled = cars.length < 2;
  }

  /* ---- Scoring a board ----
   *
   * A board ranks its drivers against each other. Clicking one ranks that lap
   * against the reference instead — the same spreadsheet, the same bands, the
   * same ladder the pace cards use for your own laps. That turns "P4, 1.4s off"
   * into "P4, and the whole board is inside 101%", which is a different fact
   * about the same afternoon and the one that says whether the gap is worth
   * chasing.
   */

  /** The board's rows, with their reference scores once those arrive. */
  let boardEntries = [];
  /** The driver whose lap the Leaderboard's RankBar card is showing, if not you. */
  let boardFocus = null;
  /** Guards a slow scoring reply from painting over a newer board. */
  let boardScoreRequest = 0;

  /**
   * Identity of one board entry, for the selection.
   *
   * Name plus lap time rather than the rank: a refresh that adds a quicker
   * driver renumbers everyone below them, and a selection keyed on rank would
   * slide onto the next driver down without appearing to move.
   */
  function boardKeyOf(row) {
    return row ? `${row.display_name || ''}|${row.lap_ms}` : '';
  }

  function selectBoardRow(entry) {
    if (!entry.scored || !entry.scored.ok) return;
    const key = boardKeyOf(entry.row);
    // Clicking the selected driver again hands the card back to you.
    boardFocus =
      boardFocus && boardFocus.key === key
        ? null
        : {
            key,
            row: entry.scored,
            // Your own row hands the card back too, rather than titling it
            // "You's pace". It is still worth clicking: it is how you compare
            // one board entry against another without leaving the tab.
            who: entry.row.is_you ? null : entry.row.display_name || 'Driver',
          };
    renderBoardList();
    renderLbRank();
  }

  function renderBoard(result) {
    const rows = (result && result.rows) || [];
    const track = boardFilters.find((f) => f.track_id === boardPick.trackId);
    setText(
      '#board-title',
      boardPick.carClass && track
        ? `${classLabel(boardPick.carClass)} · ${track.track_name}`
        : 'Leaderboard',
    );
    setText(
      '#board-count',
      rows.length ? `${rows.length} driver${rows.length === 1 ? '' : 's'}` : '',
    );

    const empty = $('#board-empty');
    if (empty) {
      if (!result || !result.ok) {
        empty.hidden = false;
        empty.textContent =
          (result && result.error) || 'The league boards could not be reached.';
      } else if (!rows.length) {
        empty.hidden = false;
        empty.textContent =
          'No laps on this board yet. Drive a clean lap here and it will appear.';
      } else {
        empty.hidden = true;
      }
    }

    boardEntries = (result && result.ok ? rows : []).map((row) => ({ row, scored: null }));
    renderBoardList();
    scoreBoardRows();
  }

  /**
   * Ask the main process to score every lap on the board.
   *
   * The whole board at once rather than on each click: scoring is a table lookup
   * and a division, so a board costs less than the round trip that fetched it,
   * and doing it up front is what lets a row know whether it is clickable BEFORE
   * anyone clicks it. A row that accepts a click and then reports there is no
   * reference for it would have wasted the only click a driver gives it.
   */
  function scoreBoardRows() {
    if (!boardEntries.length) return;
    const track = boardFilters.find((f) => f.track_id === boardPick.trackId);
    if (!track) return;
    const ticket = ++boardScoreRequest;
    // The sim's measured lap distance, from the filter row. It is the only thing
    // that can tell one layout of a circuit from another here — a board row
    // carries no track metadata, because `leaderboard` returns a ranking rather
    // than the laps' identity. Null on a track recorded before the length was
    // known, which the scorer reads as "no hint" and answers `ambiguous-layout`
    // for rather than guessing between layouts.
    const trackLengthM = Number(track.track_length_m) || 0;
    const laps = boardEntries.map(({ row }) => ({
      track: track.track_name,
      trackLengthM,
      // The board's class, not the row's: boards are keyed on (track, class) and
      // the car is metadata that travelled with the time.
      carClass: boardPick.carClass,
      car: row.car || '',
      lapMs: row.lap_ms,
    }));
    window.apex
      .lapsScore(laps)
      .then((scored) => {
        if (ticket !== boardScoreRequest) return;
        if (!Array.isArray(scored) || scored.length !== boardEntries.length) return;
        boardEntries.forEach((entry, i) => {
          entry.scored = scored[i];
        });
        renderBoardList();
      })
      .catch(() => {});
  }

  function renderBoardList() {
    const list = $('#board-list');
    if (!list) return;
    list.textContent = '';

    const focusKey = boardFocus ? boardFocus.key : '';
    for (const entry of boardEntries) {
      const { row, scored } = entry;
      const li = document.createElement('li');
      li.className = 'lbrow lbrow--board';
      // The kit marks your own row rather than only your position card: on a
      // board of names, finding yourself is the first thing anyone does.
      li.setAttribute('data-you', String(!!row.is_you));
      li.setAttribute('data-band', paceBandOf(scored));

      if (scored && scored.ok) {
        const selected = String(boardKeyOf(row) === focusKey);
        li.setAttribute('data-pick', 'true');
        li.setAttribute('data-selected', selected);
        li.tabIndex = 0;
        li.setAttribute('role', 'button');
        li.setAttribute('aria-pressed', selected);
        li.title = `Score this lap against the reference — ${scored.bandLabel}, ${scored.percent.toFixed(1)}%`;
        li.addEventListener('click', () => selectBoardRow(entry));
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectBoardRow(entry);
          }
        });
      } else if (scored) {
        li.title = scored.detail || 'This lap has no reference to score against.';
      }

      const pos = document.createElement('span');
      pos.className = 'lbrow__pos';
      pos.textContent = String(row.rank);

      const driver = document.createElement('span');
      driver.className = 'lbrow__driver';
      // createElement, never innerHTML: display names are user-supplied.
      driver.textContent = row.is_you ? 'You' : row.display_name || 'Driver';
      driver.title = row.display_name || '';

      const car = document.createElement('span');
      car.className = 'lbrow__car';
      car.textContent = row.car || '';
      car.title = row.car || '';

      const lap = document.createElement('span');
      lap.className = 'lbrow__time';
      // P1 gets the kit's purple: it is the quickest in a genuinely comparable
      // set, which is the one place that highlight means anything.
      if (row.rank === 1) lap.setAttribute('data-fastest', 'true');
      lap.textContent = formatLapTime(row.lap_ms);

      const gap = document.createElement('span');
      gap.className = 'lbrow__gap';
      gap.textContent =
        typeof row.gap_ms === 'number' ? `+${(row.gap_ms / 1000).toFixed(3)}` : '—';

      // The grade, on the row. It used to be behind a click, which made an
      // unscorable row indistinguishable from a broken one: you clicked, nothing
      // happened, and the only explanation was a grey line under the board. A
      // percentage in its own column answers the question without the click, and
      // an em dash is visibly "no score" rather than a button that ignored you.
      const score = document.createElement('span');
      score.className = 'lbrow__score';
      if (scored && scored.ok) {
        score.textContent = `${scored.percent.toFixed(1)}%`;
        if (scored.assumed) score.textContent += ' ?';
      } else {
        score.textContent = scored ? '—' : '';
      }

      li.append(pos, driver, car, lap, gap, score);
      list.append(li);
    }

    // Why a board full of times has no scores, on the one screen where the
    // question comes up. Every row fails for the same reason when it fails at
    // all — they share a track and a class — so it is said once, under the
    // board, rather than as sixteen identical tooltips.
    const scoredRows = boardEntries.filter((e) => e.scored);
    const none = scoredRows.length > 0 && !scoredRows.some((e) => e.scored.ok);

    const note = $('#board-refnote');
    if (note) {
      note.hidden = !none;
      if (none) {
        note.textContent = `These laps can't be scored against the reference: ${
          scoredRows[0].scored.detail || 'no reference covers this track and class.'
        }`;
      }
    }

    // Do not invite a click the board cannot honour. Telling someone to click a
    // lap and then doing nothing when they do is what made this read as broken
    // rather than as a limitation; the note above takes over instead.
    const hint = $('#board-hint');
    if (hint) hint.hidden = none || !boardEntries.length;
  }

  function refreshBoard() {
    // A new board means the selected driver is no longer on screen, and a card
    // still headed with their name over a board they are not on is worse than
    // no selection at all.
    boardFocus = null;
    renderLbRank();
    if (!boardPick.trackId || !boardPick.carClass) {
      renderBoard({ ok: true, rows: [] });
      return;
    }
    const ticket = ++boardRequest;
    window.apex
      .leaderboardRows({ ...boardPick })
      .then((res) => {
        // A slow request for a board you have already navigated away from must
        // not paint over the one you are looking at.
        if (ticket === boardRequest) renderBoard(res);
      })
      .catch(() => {
        if (ticket === boardRequest) renderBoard(null);
      });
  }

  function refreshBoardFilters() {
    return window.apex
      .leaderboardFilters()
      .then((res) => {
        if (!res || !res.ok) {
          boardFilters = [];
          renderBoardFilters();
          renderBoard(res);
          return;
        }
        boardFilters = res.rows || [];
        renderBoardFilters();
        refreshBoard();
      })
      .catch(() => {
        boardFilters = [];
        renderBoardFilters();
        renderBoard(null);
      });
  }

  {
    const trackSel = $('#board-track');
    if (trackSel) {
      trackSel.addEventListener('change', () => {
        boardPick.trackId = trackSel.value;
        // Class and car both belong to the track; carrying them across would
        // ask for a board that has no laps on it.
        boardPick.carClass = '';
        boardPick.car = '';
        renderBoardFilters();
        refreshBoard();
      });
    }
    const carSel = $('#board-car');
    if (carSel) {
      carSel.addEventListener('change', () => {
        boardPick.car = carSel.value;
        refreshBoard();
      });
    }
  }

  // --- Lap sync ------------------------------------------------------------
  /*
   * Whether the local laps have reached the league. Worth a line of its own
   * because the failure it reports is invisible otherwise: laps keep recording
   * perfectly while signed out, so without this the first sign that nothing was
   * uploading would be an empty leaderboard weeks later.
   */

  /** "just now", "6 min ago", "3 h ago" — enough precision to trust it. */
  function formatAgo(ms) {
    const mins = Math.floor((Date.now() - ms) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.floor(mins / 60);
    return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
  }

  function renderLapSync(sync) {
    const s = sync || {};
    const btn = $('#sync-btn');
    let text;
    switch (s.status) {
      case 'syncing':
        text = 'Uploading…';
        break;
      case 'signed-out':
        // Not an error. Laps are safe locally and go up on the next sign-in.
        text = 'Sign in to put your laps on the league boards.';
        break;
      case 'offline':
        text = s.pending
          ? `Offline — ${s.pending} to upload when you're back.`
          : 'Offline — will retry.';
        break;
      case 'error':
        text = s.error || 'Upload failed — will retry.';
        break;
      case 'ok':
        text = s.pending
          ? `${s.pending} still to upload.`
          : `Laps synced to the league${s.lastOkAt ? ` · ${formatAgo(s.lastOkAt)}` : ''}.`;
        break;
      default:
        text = 'Waiting to sync.';
    }
    setText('#sync-text', text);
    setAttr('#sync-dot', 'data-status', s.status || 'idle');
    if (btn) btn.disabled = s.status === 'syncing' || s.status === 'signed-out';
  }

  function refreshLapSync() {
    window.apex.lapsSyncState().then(renderLapSync).catch(() => renderLapSync(null));
  }

  window.apex.onLapSync((s) => {
    renderLapSync(s);
    // A completed upload changes nothing on the chart, but the run that follows
    // a stint usually coincides with new laps on disk — cheap to re-read.
    if (s && s.status === 'ok') {
      refreshWeek();
      refreshPace();
    }
  });

  $('#sync-btn').addEventListener('click', async () => {
    renderLapSync({ status: 'syncing' });
    renderLapSync(await window.apex.lapsSync());
  });

  // --- Actions -------------------------------------------------------------

  async function copyUrl(url, label) {
    await window.apex.copy(url);
    showToast((label ? label + ' URL' : 'URL') + ' copied');
  }

  async function toggleOverlay(id, enabled) {
    const state = await window.apex.updateSettings({
      enabledOverlays: { [id]: enabled },
    });
    renderOverlays(state.overlays, state.combinedUrl);
  }

  // Debounce rapid edits (typing a port, dragging the rate slider) so we don't
  // restart the server on every keystroke.
  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  const commitPort = debounce(async (value) => {
    const state = await window.apex.updateSettings({ httpPort: value });
    renderSettings(state.settings);
    renderOverlays(state.overlays, state.combinedUrl);
    renderStatus(state.status);
  }, 600);

  const commitRate = debounce(async (value) => {
    const state = await window.apex.updateSettings({ updateRateHz: value });
    renderStatus(state.status);
  }, 350);

  // --- Wiring --------------------------------------------------------------

  portInput.addEventListener('input', () => {
    portEcho.textContent = portInput.value;
    const n = parseInt(portInput.value, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 65535) commitPort(n);
  });

  rateRange.addEventListener('input', () => {
    rateEcho.textContent = rateRange.value;
    commitRate(parseInt(rateRange.value, 10));
  });

  demoToggle.addEventListener('change', async () => {
    const state = await window.apex.updateSettings({ forceSimulator: demoToggle.checked });
    renderStatus(state.status);
  });

  // Widget background opacity. Debounced only lightly: nothing restarts on this
  // change, it is pushed straight to the overlays, so the operator can watch the
  // panels fade as they drag.
  const commitPanelOpacity = debounce(async (value) => {
    await window.apex.updateSettings({ panelOpacity: value });
  }, 120);

  /**
   * Per-widget background override. Same live-push contract as the global
   * slider — nothing restarts, the value goes straight out to the overlays — so
   * the operator drags it with the widget in view. `null` clears the override
   * and hands the widget back to the global slider.
   */
  const commitWidgetOpacity = debounce(async (id, value) => {
    await window.apex.updateSettings({ widgetOpacity: { [id]: value } });
  }, 120);

  /**
   * Keep every card still on Auto showing the global value as it is dragged.
   * Those sliders are a preview of what the widget is actually doing, so one
   * left sitting at the old number would be saying something untrue.
   */
  function syncAutoOpacityRows(value) {
    overlayList.querySelectorAll('.ovcard__bg[data-auto="true"]').forEach((row) => {
      const range = row.querySelector('.ovcard__bg-range');
      const echo = row.querySelector('.ovcard__bg-echo');
      if (range) range.value = String(value);
      if (echo) echo.textContent = `${value}%`;
    });
  }

  bgRange.addEventListener('input', () => {
    bgEcho.textContent = bgRange.value;
    syncAutoOpacityRows(parseInt(bgRange.value, 10));
    commitPanelOpacity(parseInt(bgRange.value, 10));
  });

  // Text size. Same contract as the background slider — pushed straight to the
  // overlays, so the operator drags it while watching the widgets resize and
  // stops where the critical values read cleanly from their seat.
  const commitTextScale = debounce(async (value) => {
    await window.apex.updateSettings({ textScale: value });
  }, 120);

  textRange.addEventListener('input', () => {
    textEcho.textContent = textRange.value;
    commitTextScale(parseInt(textRange.value, 10));
  });

  // Radar car size. Same live-push contract as the two sliders above — it is the
  // radar's zoom, so the operator drags it with the widget in view and stops
  // where the cars read at a glance without crowding each other.
  const commitRadarIcons = debounce(async (value) => {
    await window.apex.updateSettings({ radarIconScale: value });
  }, 120);

  radarIconsRange.addEventListener('input', () => {
    radarIconsEcho.textContent = radarIconsRange.value;
    commitRadarIcons(parseInt(radarIconsRange.value, 10));
  });

  glowToggle.addEventListener('change', async () => {
    await window.apex.updateSettings({ changeGlow: glowToggle.checked });
  });

  // Application behaviour. Confirmed with a toast rather than left silent: the
  // switch has no visible effect at the moment it moves — it pays off at the
  // next boot — so without a word back there is nothing to tell a working
  // switch from a dead one.
  if (startupToggle) {
    startupToggle.addEventListener('change', async () => {
      await window.apex.updateSettings({ launchOnStartup: startupToggle.checked });
      showToast(
        startupToggle.checked
          ? 'Apex will start with Windows, minimised.'
          : 'Apex will no longer start with Windows.',
      );
    });
  }

  // Speed units ride the appearance channel, so every readout in every widget
  // and every OBS source retunes without a restart.
  if (speedUnit) {
    speedUnit.addEventListener('change', async () => {
      await window.apex.updateSettings({
        speedUnit: speedUnit.value === 'mph' ? 'mph' : 'kph',
      });
    });
  }

  // --- Audio cues ----------------------------------------------------------

  /**
   * Preview the cue at the current volume, right here in the panel.
   *
   * A volume slider you cannot hear is a slider you set by guessing, and the
   * alternative — drive a lap, run wide, listen — is not a way to tune anything.
   * So the panel plays its own tone.
   *
   * This is a deliberate, and deliberately small, echo of the `release` cue in
   * `overlay/js/audio.js`: the two live in different worlds (this page is a
   * file:// document under a strict `script-src 'self'` policy, the overlays are
   * served over HTTP) and there is no way for one to load the other's script.
   * What is duplicated is one envelope and two frequencies — kept in step by
   * hand, and worth it for a slider the operator can actually set by ear. The
   * cue vocabulary itself is NOT duplicated; audio.js remains the only place
   * that decides which event sounds like what.
   */
  let previewCtx = null;

  function previewCue() {
    const volume = Math.min(1, Math.max(0, parseInt(audioRange.value, 10) / 100));
    if (!audioToggle.checked || volume <= 0) return;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    try {
      if (!previewCtx) previewCtx = new Ctor();
      if (previewCtx.state === 'suspended') void previewCtx.resume();
      // The `release` cue: two rising tones. Mirrors CUES.release in audio.js.
      const peak = 0.6 * volume;
      const step = 0.09;
      const at = previewCtx.currentTime + 0.01;
      [660, 990].forEach((freq, i) => {
        const osc = previewCtx.createOscillator();
        const gain = previewCtx.createGain();
        const t0 = at + i * step;
        const dur = step * 0.92;
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t0);
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(peak, t0 + 0.006);
        gain.gain.setValueAtTime(peak, t0 + Math.max(0.006, dur - 0.04));
        gain.gain.linearRampToValueAtTime(0, t0 + dur);
        osc.connect(gain);
        gain.connect(previewCtx.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.01);
      });
    } catch {
      // No audio device / blocked context — the setting still saves and the
      // overlays still cue; only this preview is silent.
    }
  }

  audioToggle.addEventListener('change', async () => {
    await window.apex.updateSettings({ audioCues: audioToggle.checked });
    if (audioToggle.checked) previewCue();
  });

  // Same live-push contract as the visual sliders, plus a preview on release
  // rather than on every input event — dragging a slider through forty values
  // would otherwise fire forty overlapping tones.
  const commitAudioVolume = debounce(async (value) => {
    await window.apex.updateSettings({ audioVolume: value });
  }, 120);

  audioRange.addEventListener('input', () => {
    audioEcho.textContent = audioRange.value;
    commitAudioVolume(parseInt(audioRange.value, 10));
  });
  audioRange.addEventListener('change', previewCue);

  audioTest.addEventListener('click', (e) => {
    // The button sits inside the field's <label>, so a bare click would also
    // toggle/focus the control the label is for.
    e.preventDefault();
    previewCue();
  });

  // --- Sponsor logos -------------------------------------------------------

  /**
   * Render the installed logo list. Empty is the normal state for most users,
   * so it gets a plain explanatory row rather than looking like a failure.
   */
  function renderSponsors(names) {
    sponsorList.innerHTML = '';
    if (!names || names.length === 0) {
      const li = document.createElement('li');
      li.className = 'sponsor-list__empty';
      li.textContent = 'No logos added yet.';
      sponsorList.appendChild(li);
      return;
    }
    names.forEach((name) => {
      const li = document.createElement('li');
      li.className = 'sponsor-list__item';
      const label = document.createElement('span');
      label.className = 'sponsor-list__name';
      label.textContent = name;
      const remove = document.createElement('button');
      remove.className = 'btn btn--ghost btn--sm';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        renderSponsors(await window.apex.sponsorsRemove(name));
      });
      li.appendChild(label);
      li.appendChild(remove);
      sponsorList.appendChild(li);
    });
  }

  sponsorsToggle.addEventListener('change', async () => {
    const state = await window.apex.updateSettings({ sponsorsEnabled: sponsorsToggle.checked });
    renderStatus(state.status);
  });

  const commitSponsorInterval = debounce(async (value) => {
    const state = await window.apex.updateSettings({ sponsorIntervalSec: value });
    renderStatus(state.status);
  }, 350);

  sponsorRange.addEventListener('input', () => {
    sponsorEcho.textContent = sponsorRange.value;
    commitSponsorInterval(parseInt(sponsorRange.value, 10));
  });

  sponsorAdd.addEventListener('click', async () => {
    sponsorAdd.disabled = true;
    try {
      renderSponsors(await window.apex.sponsorsAdd());
    } finally {
      sponsorAdd.disabled = false;
    }
  });

  ingameToggle.addEventListener('change', async () => {
    const state = await window.apex.updateSettings({ ingameEnabled: ingameToggle.checked });
    renderSettings(state.settings);
    renderStatus(state.status);
    if (ingameToggle.checked && !state.status.running) {
      showToast('Press Start to show the overlays');
    }
  });

  ingameAutoToggle.addEventListener('change', async () => {
    const state = await window.apex.updateSettings({ ingameAutoHide: ingameAutoToggle.checked });
    renderSettings(state.settings);
    renderStatus(state.status);
  });

  igEditBtn.addEventListener('click', async () => {
    const editing = !!lastStatus.ingameEditing;
    const status = editing
      ? await window.apex.ingameEditStop()
      : await window.apex.ingameEditStart();
    renderStatus(status);
  });

  igResetBtn.addEventListener('click', async () => {
    await window.apex.ingameLayoutReset();
    showToast('In-game layout reset');
  });

  // Click the hotkey chip, then press a combination to bind it.
  igHotkeyBtn.addEventListener('click', () => {
    capturingHotkey = true;
    igHotkeyBtn.textContent = 'Press a key…';
    igHotkeyBtn.setAttribute('data-capturing', 'true');
    igHotkeyBtn.focus();
  });

  function stopCapture() {
    capturingHotkey = false;
    igHotkeyBtn.removeAttribute('data-capturing');
  }

  igHotkeyBtn.addEventListener('keydown', (e) => {
    if (!capturingHotkey) return;
    e.preventDefault();
    if (e.key === 'Escape') {
      stopCapture();
      renderHotkey(lastShortcut);
      return;
    }
    const accel = eventToAccelerator(e);
    if (!accel) return; // still holding only modifiers
    stopCapture();
    lastShortcut = accel;
    void commitHotkey(accel);
    showToast('Hotkey set to ' + accel);
  });

  igHotkeyBtn.addEventListener('blur', () => {
    if (capturingHotkey) {
      stopCapture();
      renderHotkey(lastShortcut);
    }
  });

  igHotkeyClear.addEventListener('click', async () => {
    stopCapture();
    lastShortcut = '';
    await commitHotkey('');
    showToast('Hotkey cleared');
  });

  powerBtn.addEventListener('click', async () => {
    const running = powerBtn.getAttribute('data-running') === 'true';
    powerBtn.disabled = true;
    const status = running ? await window.apex.stopServer() : await window.apex.startServer();
    renderStatus(status);
    // Refresh overlay URLs in case the port changed while stopped.
    const state = await window.apex.getState();
    renderOverlays(state.overlays, state.combinedUrl);
    powerBtn.disabled = false;
  });

  // Copy buttons that reference a target input by id (the combined URL box).
  document.querySelectorAll('[data-copy-target]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = document.getElementById(btn.getAttribute('data-copy-target'));
      if (target) await copyUrl(target.value, 'All-in-one');
    });
  });

  // --- Bindings -------------------------------------------------------------
  // Each row captures a key the same way the in-game hotkey chip does
  // (eventToAccelerator above), so there is one capture behaviour in the app.

  const bindingList = $('#binding-list');
  /** The row currently capturing, so a second click elsewhere cancels it. */
  let capturingBind = null;

  function stopBindCapture() {
    if (!capturingBind) return;
    const { chip, previous } = capturingBind;
    chip.removeAttribute('data-capturing');
    chip.textContent = previous || 'Click to bind';
    chip.setAttribute('data-empty', String(!previous));
    capturingBind = null;
  }

  async function commitBinding(actionId, accel, chip) {
    const res = await window.apex.actionBind(actionId, accel);
    if (res && res.ok === false && res.error) {
      // The key registered nowhere — almost always another app owning it.
      chip.setAttribute('data-error', 'true');
      showToast(`Could not bind: ${res.error}`);
      setTimeout(() => chip.removeAttribute('data-error'), 1600);
    } else {
      showToast(accel ? `Bound to ${accel}` : 'Binding cleared');
    }
    await renderBindings();
  }

  function bindingRow(action) {
    const li = document.createElement('li');
    li.className = 'binding-row';

    const info = document.createElement('div');
    info.className = 'binding-row__info';
    const label = document.createElement('div');
    label.className = 'binding-row__label';
    label.textContent = action.label;
    const meta = document.createElement('div');
    meta.className = 'binding-row__meta';
    // A delta action is one an encoder can sweep; say so, it changes how you bind it.
    meta.textContent = action.kind === 'delta' ? 'steps up / down' : 'single press';
    info.appendChild(label);
    info.appendChild(meta);

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'hotkey__key binding-row__key';
    chip.textContent = action.binding || 'Click to bind';
    chip.setAttribute('data-empty', String(!action.binding));
    chip.addEventListener('click', () => {
      stopBindCapture();
      capturingBind = { chip, actionId: action.id, previous: action.binding };
      chip.setAttribute('data-capturing', 'true');
      chip.textContent = 'Press a key…';
      chip.focus();
    });
    chip.addEventListener('keydown', (e) => {
      if (!capturingBind || capturingBind.chip !== chip) return;
      e.preventDefault();
      if (e.key === 'Escape') return stopBindCapture();
      const accel = eventToAccelerator(e);
      if (!accel) return; // modifier held on its own — keep waiting
      const id = capturingBind.actionId;
      capturingBind = null;
      chip.removeAttribute('data-capturing');
      void commitBinding(id, accel, chip);
    });
    chip.addEventListener('blur', () => {
      if (capturingBind && capturingBind.chip === chip) stopBindCapture();
    });

    // Clears EVERYTHING bound to this action — the key and both wheel
    // directions. It used to clear only the key, which is not what a row-level
    // "×" says it does: the wheel binding stayed, kept firing, and the only way
    // to remove it was a right-click on the chip that nothing advertised.
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'hotkey__clear';
    clear.title = 'Clear every binding on this action (key and wheel)';
    clear.innerHTML = '&times;';
    clear.addEventListener('click', async () => {
      await commitBinding(action.id, '', chip);
      if (action.wheel && (action.wheel.inc || action.wheel.dec)) {
        for (const dir of ['inc', 'dec']) {
          if (action.wheel[dir]) await window.apex.wheelBind(action.id, dir, null);
        }
        showToast('Cleared key and wheel bindings');
        await renderBindings();
      }
    });

    // Wheel chips. A `delta` action gets two (an encoder's two directions); a
    // `pulse` action gets one. Unlike a global hotkey, a wheel button is NOT
    // consumed — the sim still receives it, so it can safely be a button LMU
    // also uses.
    const wheelWrap = document.createElement('div');
    wheelWrap.className = 'binding-row__wheels';
    const dirs = action.kind === 'delta' ? ['dec', 'inc'] : ['inc'];
    for (const dir of dirs) {
      const bound = action.wheel && action.wheel[dir];
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'hotkey__key binding-row__wheel';
      const glyph = action.kind === 'delta' ? (dir === 'dec' ? '− ' : '+ ') : '';
      // `label` names hat directions ("hat 1 up") that a bare number cannot.
      // Bindings saved before hats existed have none, so fall back to the number.
      const boundLabel = bound ? bound.label || `btn ${bound.button}` : '';
      chip.textContent = bound ? glyph + boundLabel : glyph + 'wheel';
      chip.setAttribute('data-empty', String(!bound));
      chip.title = bound
        ? `${bound.device} ${boundLabel} — click to rebind, right-click to clear`
        : 'Click, then press a wheel button';
      chip.addEventListener('click', async () => {
        chip.setAttribute('data-capturing', 'true');
        chip.textContent = 'press…';
        const res = await window.apex.wheelCapture();
        chip.removeAttribute('data-capturing');
        if (!res || res.ok === false) {
          showToast(res && res.error ? res.error : 'No button captured');
          await renderBindings();
          return;
        }
        await window.apex.wheelBind(action.id, dir, { device: res.device, button: res.button });
        showToast(`Bound to ${res.device} ${res.label || `button ${res.button}`}`);
        await renderBindings();
      });
      // Right-click clears, keeping the row from growing a third control.
      chip.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        await window.apex.wheelBind(action.id, dir, null);
        showToast('Wheel binding cleared');
        await renderBindings();
      });
      wheelWrap.appendChild(chip);
    }

    const test = document.createElement('button');
    test.type = 'button';
    test.className = 'btn btn--ghost btn--sm';
    test.textContent = 'Test';
    test.addEventListener('click', async () => {
      const res = await window.apex.actionRun(action.id, 1);
      // Aid actions legitimately refuse when the sim isn't focused; that is a
      // useful answer, not a failure to hide.
      showToast(res && res.ok === false ? res.error || 'Action failed' : 'Sent');
    });

    li.appendChild(info);
    li.appendChild(chip);
    li.appendChild(clear);
    li.appendChild(wheelWrap);
    li.appendChild(test);
    return li;
  }

  async function renderBindings() {
    const list = await window.apex.actionsList();
    bindingList.innerHTML = '';
    let group = null;
    for (const action of list) {
      if (action.group !== group) {
        group = action.group;
        const head = document.createElement('li');
        head.className = 'binding-group';
        head.textContent = group;
        bindingList.appendChild(head);
      }
      bindingList.appendChild(bindingRow(action));
    }
    if (list.length === 0) {
      const li = document.createElement('li');
      li.className = 'sponsor-list__empty';
      li.textContent = 'No actions available.';
      bindingList.appendChild(li);
    }
  }

  /*
   * Which controllers the app can actually see, and what each one exposes.
   *
   * Worth a place in the UI because "my wheel does nothing" has two very
   * different causes that look identical from the outside: the device is not
   * being enumerated at all, or it is, but the control being pressed is not a
   * button. Showing the hat/axis counts separates those in one glance — a rim
   * whose funky switches are hats reads as such here, and a knob left in
   * Simagic's "absolute value mode" shows up in the axis count instead of the
   * button count, which is exactly why it refuses to bind.
   */
  const wheelDevicesScan = document.getElementById('wheel-devices-scan');
  const wheelDevicesOut = document.getElementById('wheel-devices-out');

  function showWheelDevices(res) {
    if (!res || res.available === false) {
      wheelDevicesOut.textContent = ` controller input unavailable: ${
        (res && res.error) || 'unknown reason'}`;
      return;
    }
    const parts = (res.devices || []).map((d) => {
      const c = d.caps;
      const spec = c ? ` (${c.buttons} buttons, ${c.povs} hats, ${c.axes} axes)` : '';
      return d.product + spec;
    });
    for (const p of res.problems || []) parts.push(`${p.product} — could not open: ${p.error}`);
    wheelDevicesOut.textContent = parts.length
      ? ` ${parts.join(' · ')}`
      : ' no controllers attached';
  }

  async function renderWheelDevices() {
    wheelDevicesOut.textContent = ' scanning…';
    showWheelDevices(await window.apex.wheelDevices());
  }

  wheelDevicesScan.addEventListener('click', () => void renderWheelDevices());
  // Scan on load, so the wheel is listed the moment the page is open rather
  // than only after the button is pressed…
  void renderWheelDevices();
  // …and track the reader's own re-scans, so a wheel whose driver dropped and
  // recreated it mid-session updates this line without anyone clicking Scan.
  window.apex.onWheelDevices((res) => showWheelDevices(res));

  // --- LMU's own controls file ----------------------------------------------
  /*
   * Shows what the overlay would bind inside LMU and writes it on request. The
   * whole card is inert while the game is running: LMU rewrites its controls
   * file from memory when it exits, so a write made now would survive a test
   * and be gone at the next launch — the worst kind of failure, because it
   * looks like success.
   */
  const lmuBindList = document.getElementById('lmu-bind-list');
  const lmuBindApply = document.getElementById('lmu-bind-apply');
  const lmuBindRestore = document.getElementById('lmu-bind-restore');
  const lmuBindStatus = document.getElementById('lmu-bind-status');

  function lmuBindRow(row) {
    const li = document.createElement('li');
    li.className = 'binding-row';
    const name = document.createElement('span');
    name.className = 'binding-row__label';
    name.textContent = row.label;
    const state = document.createElement('span');
    state.className = 'field__hint';
    if (row.status === 'already-bound') {
      state.textContent = 'already bound in LMU';
    } else if (row.status === 'will-bind') {
      state.textContent = `will bind → ${row.proposedLabel}`;
    } else {
      state.textContent = 'no spare key left';
    }
    li.appendChild(name);
    li.appendChild(state);
    return li;
  }

  async function renderLmuBindings() {
    if (!lmuBindList) return;
    const plan = await window.apex.lmuBindPlan();
    lmuBindList.innerHTML = '';
    if (!plan || plan.ok === false || !plan.path) {
      lmuBindStatus.textContent =
        (plan && plan.error) || 'Le Mans Ultimate not found on this PC.';
      lmuBindApply.disabled = true;
      lmuBindRestore.disabled = true;
      return;
    }
    for (const row of plan.rows) lmuBindList.appendChild(lmuBindRow(row));

    // Running > nothing-to-do > ready, in that order: the reason it is disabled
    // matters more to the operator than the fact that it is.
    if (plan.lmuRunning) {
      lmuBindStatus.textContent = 'Close Le Mans Ultimate to apply.';
      lmuBindApply.disabled = true;
      lmuBindRestore.disabled = true;
    } else if (plan.toBind === 0) {
      lmuBindStatus.textContent = 'Everything the overlay drives already has a key.';
      lmuBindApply.disabled = true;
      lmuBindRestore.disabled = false;
    } else {
      lmuBindStatus.textContent = `${plan.toBind} control${plan.toBind === 1 ? '' : 's'} to bind.`;
      lmuBindApply.disabled = false;
      lmuBindRestore.disabled = false;
    }
    if (plan.unbindable > 0) {
      lmuBindStatus.textContent += ` ${plan.unbindable} could not be covered — bind those in LMU by hand.`;
    }
  }

  if (lmuBindApply) {
    lmuBindApply.addEventListener('click', async () => {
      lmuBindApply.disabled = true;
      lmuBindStatus.textContent = 'Writing…';
      const res = await window.apex.lmuBindApply();
      if (!res || res.ok === false) {
        lmuBindStatus.textContent = (res && res.error) || 'Could not write LMU\'s controls file.';
      } else {
        lmuBindStatus.textContent = `Bound ${res.written.length}. Launch LMU to pick them up.`;
      }
      await renderLmuBindings();
    });
  }
  if (lmuBindRestore) {
    lmuBindRestore.addEventListener('click', async () => {
      lmuBindRestore.disabled = true;
      const res = await window.apex.lmuBindRestore();
      lmuBindStatus.textContent =
        res && res.ok ? `Restored from ${res.from}.` : (res && res.error) || 'Nothing to restore.';
      await renderLmuBindings();
    });
  }

  // Live status pushes from the main process.
  window.apex.onStatus((status) => renderStatus(status));

  // Settings pushes — e.g. the global hotkey flipped "Show in game" while the
  // panel was open. Keep the toggle and controls in sync without a reload.
  window.apex.onSettings((settings) => {
    if (settings) renderSettings(settings);
  });

  // --- Suggestions (feedback) ----------------------------------------------
  /*
   * The Suggestions tab's form. Writes one row through submit_feedback with the
   * app version attached, so the admin inbox reads it in context. Signed-in only
   * (the RPC needs a session); a signed-out driver is told to sign in rather than
   * silently dropped.
   */
  const fbKind = $('#fb-kind');
  const fbMessage = $('#fb-message');
  const fbSubmit = $('#fb-submit');

  function setFbStatus(text, state) {
    const el = $('#fb-status');
    if (!el) return;
    el.textContent = text || '';
    el.setAttribute('data-state', state || 'idle');
  }

  if (fbSubmit) {
    fbSubmit.addEventListener('click', async () => {
      const message = (fbMessage.value || '').trim();
      if (!message) {
        setFbStatus('Type a message first.', 'error');
        fbMessage.focus();
        return;
      }
      fbSubmit.disabled = true;
      setFbStatus('Sending…', 'idle');
      try {
        const res = await window.apex.feedback.submit({ kind: fbKind.value, message });
        if (res && res.ok) {
          fbMessage.value = '';
          setFbStatus('Thanks — sent to the league.', 'ok');
        } else {
          setFbStatus((res && res.error) || 'Could not send.', 'error');
        }
      } catch {
        setFbStatus('Could not send.', 'error');
      } finally {
        fbSubmit.disabled = false;
      }
    });
  }

  // --- Admin panel ---------------------------------------------------------
  /*
   * League-staff view. The tab is revealed only when admin:whoami confirms this
   * account is an admin; every read is authorised again server-side, so the
   * hidden attribute is convenience, not the boundary. All numbers are
   * aggregates — the panel never sees another driver's raw rows.
   */
  const STATUS_LABELS = {
    new: 'New',
    planned: 'Planned',
    in_progress: 'In progress',
    done: 'Done',
    declined: 'Declined',
  };

  function setAdminMsg(text) {
    const el = $('#admin-msg');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  }

  function numberOr(n) {
    return Number.isFinite(Number(n)) ? String(Number(n)) : '—';
  }

  /**
   * Show or hide the staff-only surfaces: the Admin tab, and the Updates card
   * that can put this install on the beta feed. Both are gated on the same
   * answer because they are the same trust boundary — a driver testing the
   * league's overlay should never be one dropdown away from a build we are
   * still breaking. Neither is a security control: the beta releases are public
   * on GitHub, and every admin READ is authorised again server-side.
   */
  async function revealAdminTab() {
    const tab = $('#admin-tab');
    let isAdmin = false;
    try {
      const res = await window.apex.admin.whoami();
      isAdmin = !!(res && res.ok && res.isAdmin);
    } catch {
      isAdmin = false; // not admin, or offline — the staff surfaces stay away
    }
    if (tab) tab.hidden = !isAdmin;
    // Someone already following beta keeps the card whatever whoami says, so a
    // dropped session can never hide the only control that gets them back onto
    // stable.
    isStaffAccount = isAdmin;
    applyUpdatesCardVisibility();
  }

  /**
   * Which of the four Admin sections is showing. Remembered like the main tab
   * is, and for the same reason: the section someone lives in says what they
   * open the tab FOR, and being dropped back on Overview every launch is a
   * small daily annoyance.
   */
  const ADMIN_PANE_KEY = 'apex.panel.adminPane';

  function showAdminPane(name) {
    const panes = Array.from(document.querySelectorAll('.admin-pane[data-adminpane]'));
    const known = panes.some((p) => p.dataset.adminpane === name);
    const target = known ? name : 'overview';
    for (const pane of panes) {
      pane.setAttribute('data-active', String(pane.dataset.adminpane === target));
    }
    for (const btn of document.querySelectorAll('#admin-seg button[data-adminpane]')) {
      btn.setAttribute('data-active', String(btn.dataset.adminpane === target));
    }
    // Each section starts from its own top, same rule the main router follows.
    const content = $('#content');
    if (content) content.scrollTop = 0;
    try {
      localStorage.setItem(ADMIN_PANE_KEY, target);
    } catch {
      /* storage disabled — the section just won't persist */
    }
  }

  /** The unread count, on the Feedback button. Hidden entirely at zero. */
  function setFeedbackBadge(n) {
    const btn = document.querySelector('#admin-seg button[data-adminpane="feedback"]');
    if (!btn) return;
    let badge = btn.querySelector('.admin-seg__badge');
    const count = Number(n) || 0;
    if (!count) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'admin-seg__badge';
      btn.append(badge);
    }
    badge.textContent = String(count);
  }

  function renderAdminOverview(data) {
    const d = data || {};
    setText('#adm-active-today', numberOr(d.activeToday));
    setText('#adm-active-week', d.activeWeek != null ? `${d.activeWeek} this week` : '');
    setText('#adm-active-month', numberOr(d.activeMonth));
    setText('#adm-sessions-week', d.sessionsWeek != null ? `${d.sessionsWeek} sessions · 7d` : '');
    setText('#adm-total-users', numberOr(d.totalUsers));
    // Setup-sharing health (migration 0010). Absent on an older backend, in
    // which case the tiles simply read "—".
    setText('#adm-setup-creators', numberOr(d.setupCreators));
    setText(
      '#adm-setup-creators-sub',
      d.publicSetups != null ? `${d.publicSetups} setup${d.publicSetups === 1 ? '' : 's'} shared` : '',
    );
    setText('#adm-setup-improved', numberOr(d.driversImprovedWithSetups));
    setText('#adm-setup-improved-sub', 'verified pace on a shared setup');
    setText('#adm-setup-downloads', numberOr(d.setupDownloads));
    setText(
      '#adm-setup-downloads-sub',
      d.setupDownloads != null
        ? `${numberOr(d.setupDownloads30d)} in 30d · ${numberOr(d.setupDownloaders)} driver${
            d.setupDownloaders === 1 ? '' : 's'
          }`
        : '',
    );
    setFeedbackBadge(d.newFeedback);
    renderAdminDaily(Array.isArray(d.daily) ? d.daily : []);
    renderAdminVersions(Array.isArray(d.versions) ? d.versions : []);
  }

  /** The 14-day active-users chart — the week card's bars, keyed on users. */
  function renderAdminDaily(days) {
    const chart = $('#adm-daily-chart');
    const empty = $('#adm-daily-empty');
    if (!chart) return;
    chart.textContent = '';
    if (!days.length) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    const peak = days.reduce((m, d) => Math.max(m, d.users || 0), 0);
    for (const entry of days) {
      const users = entry.users || 0;
      const isPeak = peak > 0 && users === peak;
      const col = document.createElement('div');
      col.className = 'weekbar';
      col.setAttribute('data-peak', String(isPeak));
      col.title = `${entry.day} — ${users} user${users === 1 ? '' : 's'}, ${entry.sessions || 0} session${
        entry.sessions === 1 ? '' : 's'
      }`;
      const track = document.createElement('div');
      track.className = 'weekbar__track';
      const fill = document.createElement('div');
      fill.className = 'weekbar__fill';
      fill.style.height = peak > 0 ? `${Math.max(4, (users / peak) * 100)}%` : '4%';
      if (isPeak) {
        const cap = document.createElement('span');
        cap.className = 'weekbar__count';
        cap.textContent = String(users);
        fill.append(cap);
      }
      track.append(fill);
      const label = document.createElement('span');
      label.className = 'weekbar__day';
      label.textContent = weekdayOf(entry.day);
      col.append(track, label);
      chart.append(col);
    }
  }

  /*
   * Version adoption as proportional bars, widest = most users.
   *
   * Sixty-odd builds have shipped, and every beta among them earns its own row,
   * so the honest full list is several screens of one-user tails that bury the
   * only thing anyone reads this card for: are people on the current build? So
   * it shows the top few and folds the rest away — with a foot note that says
   * how many are folded and how many drivers are in them, because a chart that
   * quietly drops most of its data is worse than a long one.
   */
  const VERSION_ROWS = 6;
  let versionsExpanded = false;
  let versionsCache = [];

  function renderAdminVersions(versions) {
    versionsCache = Array.isArray(versions) ? versions : [];
    paintVersions();
  }

  function paintVersions() {
    const list = $('#adm-versions');
    const empty = $('#adm-versions-empty');
    const more = $('#adm-versions-more');
    const foot = $('#adm-versions-foot');
    if (!list) return;
    list.textContent = '';
    const all = versionsCache;
    if (!all.length) {
      if (empty) empty.hidden = false;
      if (more) more.hidden = true;
      if (foot) foot.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;

    const shown = versionsExpanded ? all : all.slice(0, VERSION_ROWS);
    const hidden = all.length - shown.length;
    // Scale against the widest bar ON SCREEN, not the widest overall, so the
    // collapsed view still uses its full width instead of squashing everything
    // against a leader that has been folded away.
    const peak = shown.reduce((m, v) => Math.max(m, v.users || 0), 0) || 1;
    for (const v of shown) {
      const li = document.createElement('li');
      li.className = 'admin-bars__row';
      const label = document.createElement('span');
      label.className = 'admin-bars__label';
      label.textContent = v.app_version || '—';
      const track = document.createElement('span');
      track.className = 'admin-bars__track';
      const fill = document.createElement('span');
      fill.className = 'admin-bars__fill';
      fill.style.width = `${Math.max(3, ((v.users || 0) / peak) * 100)}%`;
      track.append(fill);
      const count = document.createElement('span');
      count.className = 'admin-bars__count';
      count.textContent = String(v.users || 0);
      li.append(label, track, count);
      list.append(li);
    }

    if (more) {
      more.hidden = all.length <= VERSION_ROWS;
      more.textContent = versionsExpanded ? 'Show fewer' : `Show all ${all.length}`;
    }
    if (foot) {
      if (hidden > 0) {
        const tail = all.slice(shown.length).reduce((n, v) => n + (v.users || 0), 0);
        foot.textContent = `${hidden} older build${hidden === 1 ? '' : 's'} hidden · ${tail} driver${
          tail === 1 ? '' : 's'
        }`;
        foot.hidden = false;
      } else {
        foot.hidden = true;
      }
    }
  }

  /*
   * The driver roster. Unlike everything above it this is per-person — name,
   * email, app opens, last active — which is the point: "how many" was already
   * answered by the tiles, and "who" was not. Nothing about how anyone drives
   * appears here, and the server checks is_admin on every call regardless of
   * which tab the panel happens to be showing.
   */
  function renderAdminUsers(rows) {
    const list = $('#adm-users-list');
    const empty = $('#adm-users-empty');
    const note = $('#adm-users-note');
    if (!list) return;
    list.textContent = '';
    if (!rows.length) {
      if (empty) empty.hidden = false;
      if (note) note.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;
    for (const row of rows) list.append(buildUserRow(row));
    if (note) {
      // The caveat matters: a 0 here means "no launch recorded since sessions
      // started being kept", not "has never used the app". Saying so in the UI
      // is cheaper than answering it every time someone reads the column.
      const never = rows.filter((r) => !r.last_seen_at).length;
      note.textContent =
        `${rows.length} account${rows.length === 1 ? '' : 's'} · logins count app opens recorded since v0.49.0` +
        (never ? ` · ${never} with none yet` : '');
      note.hidden = false;
    }
  }

  function buildUserRow(row) {
    const li = document.createElement('li');
    li.className = 'admin-row';

    const who = document.createElement('div');
    who.className = 'admin-row__who';
    const name = document.createElement('span');
    name.className = 'admin-row__name';
    name.textContent = row.name || 'Driver';
    who.append(name);
    if (row.is_admin) {
      const tag = document.createElement('span');
      tag.className = 'admin-row__tag';
      tag.textContent = 'admin';
      who.append(tag);
    }
    const email = document.createElement('span');
    email.className = 'admin-row__email';
    email.textContent = row.email || '—';
    who.append(email);

    const logins = document.createElement('span');
    logins.className = 'admin-row__logins';
    logins.textContent = numberOr(row.logins);

    const last = document.createElement('span');
    last.className = 'admin-row__last';
    const seen = row.last_seen_at ? new Date(row.last_seen_at) : null;
    if (seen && !Number.isNaN(seen.getTime())) {
      last.textContent = formatAgo(seen.getTime());
    } else {
      last.textContent = 'Never';
      last.setAttribute('data-never', 'true');
    }

    // The rest — version and join date — is hover detail rather than another
    // two columns: useful when chasing one driver, noise on every row.
    const joined = row.joined_at ? new Date(row.joined_at) : null;
    li.title = [
      row.email || '',
      row.app_version ? `last on v${row.app_version}` : 'no version recorded',
      joined && !Number.isNaN(joined.getTime()) ? `joined ${joined.toLocaleDateString()}` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    li.append(who, logins, last, buildAccessControl(row));
    return li;
  }

  /**
   * How free access reads in the roster, and what each grant is FOR. Kept to
   * two short words because these are <option> labels in a narrow column, and a
   * browser select truncates rather than wraps — "Free · beta test" helps
   * nobody.
   */
  const FREE_REASONS = {
    league: 'Free · league',
    beta: 'Free · beta',
    friend: 'Free · guest',
    staff: 'Free · team',
  };

  /** Live Stripe states, which the panel reports but must not try to change. */
  const PAID_STATES = {
    trialing: 'On trial',
    active: 'Paying',
    past_due: 'Payment failed',
  };

  /**
   * The access cell. Two shapes, deliberately:
   *
   *   - No live subscription → a <select> that grants or revokes free access.
   *     This is the control the league actually needs: someone joins, they ride
   *     free; someone leaves, you set them to Paying and the next launch asks
   *     them for £4.99.
   *   - A live Stripe subscription → static text. Comping a paying customer
   *     would leave them being charged AND free, and cancelling their card is
   *     Stripe's job; neither belongs behind a dropdown in a roster.
   */
  function buildAccessControl(row) {
    const reason = row.free_access_reason || null;
    const paid = PAID_STATES[row.billing_status];

    if (!reason && paid) {
      const span = document.createElement('span');
      span.className = 'admin-row__paid';
      span.setAttribute('data-state', row.billing_status);
      span.textContent = paid;
      span.title = 'Managed by Stripe — cancel or refund from the Stripe dashboard.';
      return span;
    }

    const select = document.createElement('select');
    select.className = 'field__input admin-row__access';
    select.setAttribute('data-free', String(!!reason));
    select.title = reason
      ? row.free_access_note || 'On free access'
      : 'Not on free access — this account pays like anyone else.';

    const none = document.createElement('option');
    none.value = '';
    none.textContent = paid ? `Paying (${paid.toLowerCase()})` : 'Paying';
    select.append(none);
    for (const [value, label] of Object.entries(FREE_REASONS)) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      select.append(opt);
    }
    select.value = reason && FREE_REASONS[reason] ? reason : '';

    select.addEventListener('change', async () => {
      const next = select.value;
      const previous = reason || '';
      select.disabled = true;
      try {
        const res = next
          ? await window.apex.admin.grantFree({
              userId: row.user_id,
              reason: next,
              // Who did this and when, so a year from now the Free access list
              // is not a set of names with no explanation attached.
              note: `set from the admin roster ${new Date().toLocaleDateString()}`,
            })
          : await window.apex.admin.revokeFree({ userId: row.user_id });
        if (!res || !res.ok) {
          showToast((res && res.error) || 'Could not change access.');
          select.value = previous; // put the control back where the server is
          return;
        }
        showToast(
          next
            ? `${row.name || 'Driver'} is on free access.`
            : `${row.name || 'Driver'} now pays like anyone else.`,
        );
        // Both lists move: the roster row and the codes card (revoking burns
        // any code that account redeemed).
        await Promise.all([refreshAdminUsers(), refreshFreeAccess(), refreshAdminBilling()]);
      } finally {
        select.disabled = false;
      }
    });
    return select;
  }

  function renderAdminFeedback(rows) {
    const list = $('#adm-feedback-list');
    const empty = $('#adm-feedback-empty');
    if (!list) return;
    list.textContent = '';
    if (!rows.length) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    for (const row of rows) list.append(buildFeedbackItem(row));
  }

  function buildFeedbackItem(row) {
    const li = document.createElement('li');
    li.className = 'admin-item';

    const badge = document.createElement('span');
    badge.className = 'admin-item__badge';
    badge.setAttribute('data-kind', row.kind || 'other');
    badge.textContent = row.kind || 'other';

    const mid = document.createElement('div');
    mid.className = 'admin-item__msg';
    const text = document.createElement('p');
    text.className = 'admin-item__text';
    text.textContent = row.message || '';
    const meta = document.createElement('p');
    meta.className = 'admin-item__meta';
    const when = row.created_at ? new Date(row.created_at) : null;
    const whenTxt = when && !Number.isNaN(when.getTime()) ? formatAgo(when.getTime()) : '';
    meta.textContent = [row.driver || 'Driver', row.app_version ? `v${row.app_version}` : '', whenTxt]
      .filter(Boolean)
      .join(' · ');
    mid.append(text, meta);

    const select = document.createElement('select');
    select.className = 'field__input admin-item__status';
    for (const [value, label] of Object.entries(STATUS_LABELS)) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      if (value === row.status) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener('change', async () => {
      select.disabled = true;
      try {
        const res = await window.apex.admin.setFeedbackStatus({ id: row.id, status: select.value });
        if (!res || !res.ok) showToast((res && res.error) || 'Could not update.');
        else row.status = select.value;
      } finally {
        select.disabled = false;
      }
    });

    li.append(badge, mid, select);
    return li;
  }

  /** The roster's current query, read straight off its two controls. */
  function adminUsersQuery() {
    const search = $('#adm-users-search');
    const sort = $('#adm-users-sort');
    return {
      search: search ? search.value.trim() : '',
      sort: sort ? sort.value : 'last_seen',
    };
  }

  /** Load (or reload) everything on the Admin view. */
  async function loadAdmin() {
    setAdminMsg('');
    const filter = $('#adm-fb-filter');
    try {
      const [overview, feedback, users, free, billing] = await Promise.all([
        window.apex.admin.overview(),
        window.apex.admin.feedback({ status: filter ? filter.value : '' }),
        window.apex.admin.users(adminUsersQuery()),
        window.apex.admin.freeAccess(),
        window.apex.admin.billing(),
      ]);
      if (overview && overview.ok) {
        renderAdminOverview(overview.data);
      } else if (overview) {
        setAdminMsg(
          overview.signedOut
            ? 'Sign in as an admin to see usage.'
            : overview.error || 'Usage numbers are unavailable right now.',
        );
      }
      renderAdminFeedback(feedback && feedback.ok ? feedback.rows : []);
      renderAdminUsers(users && users.ok ? users.rows : []);
      renderFreeAccess(free && free.ok ? free.data : null);
      renderAdminBilling(billing && billing.ok ? billing.data : null);
    } catch {
      setAdminMsg('Could not reach the league.');
    }
  }

  /** Reload just the Free access card, after issuing or revoking. */
  async function refreshFreeAccess() {
    const res = await window.apex.admin.freeAccess();
    renderFreeAccess(res && res.ok ? res.data : null);
  }

  /*
   * The League codes card: every code and what became of it.
   *
   * This used to also list the comped accounts. It no longer does — that list
   * said less than the roster does (no email, no last-active) and disagreed
   * with it the moment either changed. Access is set on the driver's own row;
   * this card is only about codes, which exist for people who have no account
   * to find in the roster yet.
   */
  function renderFreeAccess(data) {
    const codes = Array.isArray(data && data.codes) ? data.codes : [];
    const codeList = $('#adm-codes-list');
    const codeEmpty = $('#adm-codes-empty');
    if (codeList) {
      codeList.textContent = '';
      for (const c of codes) codeList.append(buildCodeRow(c));
    }
    if (codeEmpty) codeEmpty.hidden = codes.length > 0;
  }

  /** One issued code: the code, who it was cut for, and what became of it. */
  function buildCodeRow(row) {
    const li = document.createElement('li');
    li.className = 'admin-row';

    const who = document.createElement('div');
    who.className = 'admin-row__who';
    const code = document.createElement('span');
    code.className = 'admin-row__name';
    code.textContent = row.code || '—';
    who.append(code);
    if (row.note) {
      const note = document.createElement('span');
      note.className = 'admin-row__email';
      note.textContent = row.note;
      who.append(note);
    }

    const state = document.createElement('span');
    state.className = 'admin-row__last';
    if (row.revoked_at) {
      state.textContent = 'Revoked';
      state.setAttribute('data-never', 'true');
    } else if (row.redeemed_at) {
      state.textContent = `Used — ${row.redeemed_by_name || 'Driver'}`;
    } else {
      state.textContent = 'Unused';
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn--ghost btn--sm';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      await window.apex.copy(row.code || '');
      showToast('Code copied.');
    });

    li.append(who, state, copyBtn);
    return li;
  }

  /* ------------------------------ Billing -------------------------------- *
   *
   * Five questions, one RPC: how many ride free, how many are trying it, how
   * many pay, what that is worth a month, and how many leave. Everything is
   * computed server-side from each subscription's LIFETIME (see migration
   * 0008), so the charts can look backwards without the app having kept a
   * single snapshot.
   */

  /** Pence → "£4.99". Whole amounts lose the ".00" — £5 reads faster than £5.00. */
  function money(pence, currency) {
    const n = Number(pence) || 0;
    const code = (currency || 'gbp').toUpperCase();
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: code,
        minimumFractionDigits: n % 100 === 0 ? 0 : 2,
      }).format(n / 100);
    } catch {
      return `${(n / 100).toFixed(2)}`;
    }
  }

  /** How each bucket of the mix is labelled, in the order it is drawn. */
  const MIX_ROWS = [
    ['free', 'Free access'],
    ['trial', 'On trial'],
    ['paying', 'Paying'],
    ['past_due', 'Payment failed'],
    ['lapsed', 'Lapsed'],
    ['none', 'Never subscribed'],
  ];

  // Named for the section, not for "billing": renderBilling already belongs to
  // the Settings subscription card further down this file, and two function
  // declarations with one name in one scope do not collide loudly — the later
  // one simply wins and the earlier caller quietly gets the wrong renderer.
  function renderAdminBilling(data) {
    const d = data || {};
    const mix = d.mix || {};
    const cur = d.currency || 'gbp';
    const series = Array.isArray(d.series) ? d.series : [];

    const free = Number(mix.free) || 0;
    const trial = Number(mix.trial) || 0;
    const paying = Number(mix.paying) || 0;
    const total = Number(d.totalAccounts) || 0;

    setText('#adm-bill-free', numberOr(free));
    setText('#adm-bill-trial', numberOr(trial));
    setText('#adm-bill-paying', numberOr(paying));
    setText('#adm-bill-mrr', money(d.mrrPence, cur));
    setText('#adm-mrr-tile', money(d.mrrPence, cur));

    // The breakdown of WHY people are free is the number that decides whether
    // the comp list has quietly become the business model.
    const byReason = Array.isArray(d.freeByReason) ? d.freeByReason : [];
    setText(
      '#adm-bill-free-sub',
      byReason.map((r) => `${r.users} ${r.reason}`).join(' · '),
    );
    setText(
      '#adm-bill-paying-sub',
      total ? `${Math.round((paying / total) * 100)}% of ${total} accounts` : '',
    );
    const perHead = paying > 0 ? money(Math.round((Number(d.mrrPence) || 0) / paying), cur) : '';
    setText('#adm-bill-mrr-sub', perHead ? `${perHead} per paying driver` : 'No paying drivers yet');
    setText('#adm-mrr-tile-sub', paying ? `${paying} paying` : 'Nobody paying yet');

    renderMix(mix, total);
    renderMrrChart(series, cur);
    renderChurnChart(series);
  }

  /** The mix as proportional bars — the same idiom as version adoption. */
  function renderMix(mix, total) {
    const list = $('#adm-bill-mix');
    const empty = $('#adm-bill-mix-empty');
    if (!list) return;
    list.textContent = '';
    const rows = MIX_ROWS.map(([key, label]) => [label, Number(mix[key]) || 0]).filter(
      ([, n]) => n > 0,
    );
    if (!rows.length) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    // Scaled against the roster, not against the biggest bucket: these are
    // parts of a whole, and a "Paying: 2" bar running the full width of the
    // card would read as success rather than as two people.
    const peak = Math.max(total || 0, ...rows.map(([, n]) => n)) || 1;
    for (const [label, n] of rows) {
      const li = document.createElement('li');
      li.className = 'admin-bars__row';
      const name = document.createElement('span');
      name.className = 'admin-bars__label';
      name.textContent = label;
      const track = document.createElement('span');
      track.className = 'admin-bars__track';
      const fill = document.createElement('span');
      fill.className = 'admin-bars__fill';
      fill.style.width = `${Math.max(3, (n / peak) * 100)}%`;
      track.append(fill);
      const count = document.createElement('span');
      count.className = 'admin-bars__count';
      count.textContent = String(n);
      li.append(name, track, count);
      li.title = total ? `${label}: ${n} of ${total} accounts` : `${label}: ${n}`;
      list.append(li);
    }
  }

  /** "2026-08" → "Aug". Falls back to the raw key if it is ever malformed. */
  function monthLabel(key) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
    if (!m) return String(key || '');
    const date = new Date(Number(m[1]), Number(m[2]) - 1, 1);
    return date.toLocaleDateString(undefined, { month: 'short' });
  }

  /**
   * One month-series bar chart. Shared by revenue and churn because they are
   * the same shape: twelve columns, the tallest labelled, every one carrying
   * its own tooltip. `points` is [{ label, value, empty, title, display }].
   */
  function renderMonthChart(chartSel, emptySel, points) {
    const chart = $(chartSel);
    const empty = $(emptySel);
    if (!chart) return;
    chart.textContent = '';
    const real = points.filter((p) => !p.empty);
    if (!real.length) {
      chart.hidden = true;
      if (empty) empty.hidden = false;
      return;
    }
    chart.hidden = false;
    if (empty) empty.hidden = true;
    const peak = real.reduce((m, p) => Math.max(m, p.value), 0);
    for (const p of points) {
      const isPeak = peak > 0 && !p.empty && p.value === peak;
      const col = document.createElement('div');
      col.className = 'weekbar';
      col.setAttribute('data-peak', String(isPeak));
      if (p.empty) col.setAttribute('data-empty', 'true');
      col.title = p.title;
      const track = document.createElement('div');
      track.className = 'weekbar__track';
      const fill = document.createElement('div');
      fill.className = 'weekbar__fill';
      fill.style.height = p.empty || peak <= 0 ? '4%' : `${Math.max(4, (p.value / peak) * 100)}%`;
      if (isPeak) {
        const cap = document.createElement('span');
        cap.className = 'weekbar__count';
        cap.textContent = p.display;
        fill.append(cap);
      }
      track.append(fill);
      const label = document.createElement('span');
      label.className = 'weekbar__day';
      label.textContent = p.label;
      col.append(track, label);
      chart.append(col);
    }
  }

  function renderMrrChart(series, cur) {
    renderMonthChart(
      '#adm-mrr-chart',
      '#adm-mrr-empty',
      series.map((s) => {
        const pence = Number(s.mrrPence) || 0;
        return {
          label: monthLabel(s.month),
          value: pence,
          // A month before anyone subscribed is not £0 of revenue, it is no
          // data — drawn flat and grey so the chart does not imply a business
          // that was earning nothing rather than one that did not exist.
          empty: pence === 0 && !Number(s.active),
          display: money(pence, cur),
          title: `${s.month} — ${money(pence, cur)} from ${s.active} subscriber${
            Number(s.active) === 1 ? '' : 's'
          }`,
        };
      }),
    );
    const foot = $('#adm-mrr-foot');
    if (foot) {
      // The one caveat worth printing: history starts when the paywall did.
      foot.textContent =
        'Live subscriptions only — trials count as £0 until they convert. History begins when billing went live.';
      foot.hidden = false;
    }
  }

  function renderChurnChart(series) {
    renderMonthChart(
      '#adm-churn-chart',
      '#adm-churn-empty',
      series.map((s) => {
        const rate = s.churnRate == null ? null : Number(s.churnRate);
        return {
          label: monthLabel(s.month),
          value: rate == null ? 0 : rate,
          empty: rate == null,
          display: `${rate == null ? '—' : rate}%`,
          title:
            rate == null
              ? `${s.month} — no subscribers to lose`
              : `${s.month} — ${s.churned} of ${s.activeStart} left (${rate}%)`,
        };
      }),
    );
    const foot = $('#adm-churn-foot');
    if (foot) {
      const lost = series.reduce((n, s) => n + (Number(s.churned) || 0), 0);
      const gained = series.reduce((n, s) => n + (Number(s.started) || 0), 0);
      foot.textContent = `${gained} started · ${lost} cancelled over 12 months. A month with no subscribers is left blank rather than shown as 0%.`;
      foot.hidden = false;
    }
  }

  /** Reload just the Billing section. */
  async function refreshAdminBilling() {
    const res = await window.apex.admin.billing();
    if (res && res.ok) renderAdminBilling(res.data);
  }

  async function refreshAdminFeedback() {
    const filter = $('#adm-fb-filter');
    const res = await window.apex.admin.feedback({ status: filter ? filter.value : '' });
    renderAdminFeedback(res && res.ok ? res.rows : []);
  }

  async function refreshAdminUsers() {
    const res = await window.apex.admin.users(adminUsersQuery());
    renderAdminUsers(res && res.ok ? res.rows : []);
  }

  {
    // Section nav. Everything is already loaded by loadAdmin(), so switching is
    // a pure show/hide — no spinner, no second round trip.
    for (const btn of document.querySelectorAll('#admin-seg button[data-adminpane]')) {
      btn.addEventListener('click', () => showAdminPane(btn.dataset.adminpane));
    }
    let startPane = 'overview';
    try {
      startPane = localStorage.getItem(ADMIN_PANE_KEY) || 'overview';
    } catch {
      /* storage disabled — start on Overview */
    }
    showAdminPane(startPane);

    const versionsMore = $('#adm-versions-more');
    if (versionsMore) {
      versionsMore.addEventListener('click', () => {
        versionsExpanded = !versionsExpanded;
        paintVersions();
      });
    }

    const refreshBtn = $('#admin-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', () => void loadAdmin());
    const filter = $('#adm-fb-filter');
    if (filter) filter.addEventListener('change', () => void refreshAdminFeedback());

    // Free access: cut N codes with one shared note. The fresh codes go
    // straight onto the clipboard AND into the card — a code that has to be
    // retyped out of a screenshot is a code with a typo in it.
    const issueBtn = $('#adm-code-issue');
    if (issueBtn) {
      issueBtn.addEventListener('click', async () => {
        const countInput = $('#adm-code-count');
        const noteInput = $('#adm-code-note');
        const count = Math.max(1, Math.min(50, Math.round(Number(countInput?.value) || 1)));
        const note = noteInput ? noteInput.value.trim() : '';
        issueBtn.disabled = true;
        try {
          const res = await window.apex.admin.issueCodes({ count, note });
          if (!res || !res.ok || !Array.isArray(res.codes) || !res.codes.length) {
            showToast((res && res.error) || 'Could not issue codes.');
            return;
          }
          const out = $('#adm-code-out');
          if (out) {
            out.textContent = `New code${res.codes.length === 1 ? '' : 's'}: ${res.codes.join('   ')}`;
            out.hidden = false;
          }
          await window.apex.copy(res.codes.join('\n'));
          showToast(
            res.codes.length === 1 ? 'Code copied to clipboard.' : `${res.codes.length} codes copied.`,
          );
          if (noteInput) noteInput.value = '';
          await refreshFreeAccess();
        } finally {
          issueBtn.disabled = false;
        }
      });
    }

    const sort = $('#adm-users-sort');
    if (sort) sort.addEventListener('change', () => void refreshAdminUsers());

    // Typing a search hits the league, so wait for the typist to stop first —
    // an eight-letter name should be one query, not eight.
    const search = $('#adm-users-search');
    if (search) {
      let debounce = null;
      search.addEventListener('input', () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void refreshAdminUsers(), 250);
      });
    }
  }

  // The admin flag can change with the account, so re-check on sign-in/out too.
  void revealAdminTab();
  window.apex.auth.onChange(() => void revealAdminTab());

  // --- Tab router ----------------------------------------------------------
  /*
   * The Hub shell's five tabs plus the gear, over one document: each view is a
   * [data-view] section and only the active one is displayed. No routing library
   * and no page loads — a reload would drop the WebSocket status feed and make
   * the panel flash black between tabs.
   *
   * The chosen tab is remembered, because the tab someone lives in says what
   * they use the app for: a streamer setting up sits in Overlays, and being
   * dropped back on Dashboard every launch would be a small daily annoyance.
   */

  const TAB_STORAGE_KEY = 'apex.panel.tab';
  const views = Array.from(document.querySelectorAll('[data-view]'));
  const tabButtons = Array.from(document.querySelectorAll('.tab[data-tab]'));
  const settingsBtn = $('#settings-btn');

  function showView(name) {
    const known = views.some((v) => v.dataset.view === name);
    const target = known ? name : 'dashboard';
    for (const view of views) {
      view.setAttribute('data-active', String(view.dataset.view === target));
    }
    for (const tab of tabButtons) {
      tab.setAttribute('data-active', String(tab.dataset.tab === target));
    }
    // Settings has no tab of its own — the gear is its affordance, so light it.
    settingsBtn.setAttribute('data-active', String(target === 'settings'));
    // Each view scrolls from its own top; carrying the previous view's scroll
    // position over lands you halfway down an unrelated page.
    const content = $('#content');
    if (content) content.scrollTop = 0;
    // Laps land while the driver is in the sim, not while they are looking at
    // this window, so the cards are refreshed on arrival rather than on a timer.
    if (target === 'dashboard') {
      refreshWeek();
      refreshPace();
    }
    if (target === 'leaderboard') {
      refreshPace();
      refreshBoardFilters();
    }
    if (target === 'admin') {
      void loadAdmin();
    }
    // The bot's lists live in main; re-ask on entry so another window's edits
    // (or a fresh install's defaults) are never stale here. First visit also
    // offers the walkthrough (same manners as the Setups guide).
    if (target === 'streamers') {
      void refreshStreamBot();
      window.APEX_STREAMER_GUIDE?.maybeAutoOpen();
    } else {
      window.APEX_STREAMER_GUIDE?.cancelAutoOpen();
    }
    // Plan state changes out-of-app (in the browser, on Stripe's pages), so
    // the card re-asks whenever Settings comes back into view.
    if (target === 'settings') void refreshBilling();
    // The setup editor is the one tab with a poll loop (and an animation
    // frame), and this is where its zero-cost-when-hidden rule is enforced:
    // shown() starts everything, hidden() stops everything, and the router is
    // the single owner of which view is active. Optional-chained because the
    // editor lives in setup-editor.js, loaded after this file.
    if (target === 'setups') window.apexSetup?.shown();
    else window.apexSetup?.hidden();
    try {
      localStorage.setItem(TAB_STORAGE_KEY, target);
    } catch {
      /* storage disabled — the tab just won't persist */
    }
  }

  /** The last tab-bar view, so the gear has somewhere to return to. */
  let lastContentTab = 'dashboard';

  for (const tab of tabButtons) {
    tab.addEventListener('click', () => {
      lastContentTab = tab.dataset.tab;
      showView(tab.dataset.tab);
    });
  }

  settingsBtn.addEventListener('click', () => {
    // The gear both opens and closes Settings: it is the only affordance for a
    // view with no tab of its own, so it has to be able to undo itself.
    const open = settingsBtn.getAttribute('data-active') === 'true';
    showView(open ? lastContentTab : 'settings');
  });

  let restored = 'dashboard';
  try {
    restored = localStorage.getItem(TAB_STORAGE_KEY) || 'dashboard';
  } catch {
    /* storage disabled */
  }
  if (restored !== 'settings') lastContentTab = restored;
  showView(restored);

  // --- Subscription (the Settings card) ------------------------------------
  /*
   * Read-only standing plus one button: everything that actually changes the
   * subscription (cancel, card, invoices) is Stripe's Customer Portal in the
   * system browser. The card hides while signed out — there is no plan to show.
   */

  const subCard = $('#sub-card');
  const subPlanStatus = $('#sub-plan-status');
  const subHint = $('#sub-hint');
  const subManageBtn = $('#sub-manage-btn');

  /** Whether anyone is signed in, per the last auth push — decides the card. */
  let authSignedIn = false;

  function shortDate(iso) {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime())
      ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
      : '';
  }

  function renderBilling(b) {
    if (!subCard) return;
    subCard.hidden = !authSignedIn || !b;
    if (subCard.hidden) return;
    let status = 'Not subscribed';
    let hint = 'Subscribe from the account screen to use the app.';
    if (b.source === 'free') {
      status = 'Free access';
      hint =
        {
          beta: 'Beta tester — thank you for driving the rough builds.',
          staff: 'Team account — free access, no billing.',
          friend: 'Guest of the team — free access, no billing.',
        }[b.freeReason] ||
        'League member — free while you race with Apex & Chill.';
    } else if (b.status === 'trialing') {
      status = `Free trial — ends ${shortDate(b.trialEnd) || 'soon'}`;
      hint = 'Then £4.99/month. Cancel any time under Manage subscription.';
    } else if (b.status === 'active') {
      status = b.cancelAtPeriodEnd
        ? `Active — ends ${shortDate(b.currentPeriodEnd) || 'at period end'}`
        : `Active — renews ${shortDate(b.currentPeriodEnd) || 'monthly'}`;
      hint = b.cancelAtPeriodEnd
        ? 'Cancellation booked; access runs to the end of the paid period.'
        : '£4.99/month. Manage the card, see invoices or cancel any time.';
    } else if (b.status === 'past_due') {
      status = 'Payment problem';
      hint = 'The last charge failed — update your card under Manage subscription to keep access.';
    }
    if (subPlanStatus) subPlanStatus.textContent = status;
    if (subHint) subHint.textContent = hint;
    // No Stripe customer means nothing for the portal to show (league comps
    // that never started a trial) — the button would only 404 at them.
    if (subManageBtn) subManageBtn.hidden = !b.hasCustomer;
  }

  async function refreshBilling() {
    if (!window.apex.billing) return;
    try {
      renderBilling(await window.apex.billing.status());
    } catch {
      /* offline — the card keeps its last words */
    }
  }

  if (subManageBtn) {
    subManageBtn.addEventListener('click', async () => {
      subManageBtn.disabled = true;
      try {
        const res = await window.apex.billing.portal();
        if (!res || !res.ok) showToast((res && res.error) || 'Could not open the billing page.');
        else showToast('Billing opened in your browser.');
      } finally {
        subManageBtn.disabled = false;
      }
    });
  }

  if (window.apex.billing) window.apex.billing.onChange(renderBilling);

  // --- Account -------------------------------------------------------------
  /*
   * The account screens live on their own page (auth.html); the panel only shows
   * who is signed in and offers the way in/out. Main swaps the page.
   */

  const account = $('#account');
  const accountInitials = $('#account-initials');
  const accountName = $('#account-name');
  const accountEmail = $('#account-email');
  const signOutBtn = $('#signout-btn');
  const signInBtn = $('#signin-btn');

  function renderAuth(state) {
    const user = state && state.user;
    const signedIn = !!(state && state.signedIn && user);
    authSignedIn = signedIn;
    account.hidden = !signedIn;
    signInBtn.hidden = signedIn;
    // The Subscription card follows the account: appears on sign-in, goes with
    // it on sign-out, and re-reads the plan when the account changes.
    void refreshBilling();
    if (!signedIn) return;
    accountInitials.textContent = user.initials;
    accountName.textContent = user.displayName;
    accountEmail.textContent = user.email;
  }

  signOutBtn.addEventListener('click', async () => {
    signOutBtn.disabled = true;
    // Main sends us back to the account screens, so there's nothing to re-render
    // on success; only a failure leaves us here with a live button.
    try {
      await window.apex.auth.signOut();
    } finally {
      signOutBtn.disabled = false;
    }
  });

  signInBtn.addEventListener('click', () => window.apex.auth.showAuth());

  window.apex.auth.onChange(renderAuth);

  // --- Streaming chat linking ---------------------------------------------

  const chatTwitchInput = $('#chat-twitch-input');
  const chatTwitchStatus = $('#chat-twitch-status');
  const chatYtLink = $('#chat-yt-link');
  const chatYtUnlink = $('#chat-yt-unlink');
  const chatYtStatus = $('#chat-yt-status');
  const chatYtRelink = $('#chat-yt-relink');
  const chatTwLink = $('#chat-tw-link');
  const chatTwUnlink = $('#chat-tw-unlink');
  const chatTwStatus = $('#chat-tw-status');
  const chatTwCode = $('#chat-tw-code');

  /** Whether the operator is mid-edit, so a push doesn't clobber their typing. */
  let chatTwitchEditing = false;

  function renderChatState(state) {
    if (!state) return;
    if (chatTwitchInput && !chatTwitchEditing) {
      chatTwitchInput.value = state.twitchChannel || '';
    }
    if (chatTwitchStatus) {
      chatTwitchStatus.textContent = state.twitchLinked ? '· connected' : '';
    }
    // YouTube: three states — not available on this build, not linked, linked.
    if (chatYtLink && chatYtUnlink && chatYtStatus) {
      if (!state.youTubeConfigured) {
        chatYtLink.hidden = true;
        chatYtUnlink.hidden = true;
        chatYtStatus.textContent = 'Not available on this build.';
      } else if (state.youTubeLinked) {
        chatYtLink.hidden = true;
        chatYtUnlink.hidden = false;
        const who = state.youTubeAccount ? ` (${state.youTubeAccount})` : '';
        chatYtStatus.textContent = state.youTubeLive
          ? `Linked${who} · live chat found`
          : `Linked${who} · waiting for a live stream`;
      } else {
        chatYtLink.hidden = false;
        chatYtUnlink.hidden = true;
        chatYtStatus.textContent = '';
      }
    }
    // Old (read-only) YouTube grants keep the widget alive but gate the bot —
    // the banner is the one place that explains why it isn't typing.
    if (chatYtRelink) chatYtRelink.hidden = !state.youTubeNeedsRelink;
    // Twitch account (the bot's login) — mirrors the YouTube three-state row,
    // plus the device code while a link is pending.
    if (chatTwLink && chatTwUnlink && chatTwStatus) {
      if (!state.twitchConfigured) {
        chatTwLink.hidden = true;
        chatTwUnlink.hidden = true;
        chatTwStatus.textContent = 'Not available on this build.';
      } else if (state.twitchAuthed) {
        chatTwLink.hidden = true;
        chatTwUnlink.hidden = false;
        chatTwStatus.textContent = `Linked (${state.twitchAccount || 'your account'})`;
      } else {
        chatTwLink.hidden = false;
        chatTwUnlink.hidden = true;
        chatTwStatus.textContent = '';
      }
    }
    if (chatTwCode) {
      const pending = state.twitchLinkPending;
      chatTwCode.hidden = !pending;
      chatTwCode.textContent = pending
        ? `Enter code ${pending.userCode} at ${pending.verificationUri.replace(/^https?:\/\//, '')}`
        : '';
    }
  }

  if (chatTwitchInput) {
    const commitTwitch = debounce(async (value) => {
      await window.apex.chatLink.setTwitchChannel(value);
    }, 400);
    chatTwitchInput.addEventListener('focus', () => {
      chatTwitchEditing = true;
    });
    chatTwitchInput.addEventListener('input', () => commitTwitch(chatTwitchInput.value));
    chatTwitchInput.addEventListener('blur', () => {
      chatTwitchEditing = false;
      void window.apex.chatLink.setTwitchChannel(chatTwitchInput.value);
    });
  }

  if (chatYtLink) {
    chatYtLink.addEventListener('click', async () => {
      chatYtLink.disabled = true;
      chatYtStatus.textContent = 'Opening browser… complete sign-in there.';
      try {
        const res = await window.apex.chatLink.linkYouTube();
        if (res && res.ok) renderChatState(res.state);
        else chatYtStatus.textContent = (res && res.error) || 'Linking failed.';
      } finally {
        chatYtLink.disabled = false;
      }
    });
  }

  if (chatYtUnlink) {
    chatYtUnlink.addEventListener('click', async () => {
      chatYtUnlink.disabled = true;
      try {
        const res = await window.apex.chatLink.unlinkYouTube();
        if (res && res.state) renderChatState(res.state);
      } finally {
        chatYtUnlink.disabled = false;
      }
    });
  }

  if (chatTwLink) {
    chatTwLink.addEventListener('click', async () => {
      chatTwLink.disabled = true;
      chatTwStatus.textContent = 'Opening browser… enter the code shown below.';
      try {
        const res = await window.apex.chatLink.linkTwitch();
        if (res && res.ok) renderChatState(res.state);
        else chatTwStatus.textContent = (res && res.error) || 'Linking failed.';
      } finally {
        chatTwLink.disabled = false;
      }
    });
  }

  if (chatTwUnlink) {
    chatTwUnlink.addEventListener('click', async () => {
      chatTwUnlink.disabled = true;
      try {
        const res = await window.apex.chatLink.unlinkTwitch();
        if (res && res.state) renderChatState(res.state);
      } finally {
        chatTwUnlink.disabled = false;
      }
    });
  }

  window.apex.chatLink.onChange(renderChatState);

  // --- Streamers: sub-panes + the StreamBot editor --------------------------
  /*
   * Same shape as the Admin tab: one .seg control, panes display:none'd rather
   * than unbuilt. The bot editor edits plain local arrays and commits WHOLE
   * sections over IPC (streamBot:update validates and echoes back) — no
   * per-row patch grammar, and the echo is skipped while the operator is
   * typing so a push can't clobber a half-written command.
   */

  const STREAMERS_PANE_KEY = 'apex.panel.streamersPane';

  function showStreamersPane(name) {
    const panes = Array.from(document.querySelectorAll('.streamers-pane[data-streamerspane]'));
    const known = panes.some((p) => p.dataset.streamerspane === name);
    const target = known ? name : 'accounts';
    for (const pane of panes) {
      pane.setAttribute('data-active', String(pane.dataset.streamerspane === target));
    }
    for (const btn of document.querySelectorAll('#streamers-seg button[data-streamerspane]')) {
      btn.setAttribute('data-active', String(btn.dataset.streamerspane === target));
    }
    const content = $('#content');
    if (content) content.scrollTop = 0;
    try {
      localStorage.setItem(STREAMERS_PANE_KEY, target);
    } catch {
      /* storage disabled — the pane just won't persist */
    }
  }

  for (const btn of document.querySelectorAll('#streamers-seg button[data-streamerspane]')) {
    btn.addEventListener('click', () => showStreamersPane(btn.dataset.streamerspane));
  }
  try {
    showStreamersPane(localStorage.getItem(STREAMERS_PANE_KEY) || 'accounts');
  } catch {
    /* defaults to accounts */
  }

  const sbEnabled = $('#sb-enabled');
  const sbPlatformTwitch = $('#sb-platform-twitch');
  const sbPlatformYoutube = $('#sb-platform-youtube');
  const sbStatus = $('#sb-status');
  const sbBudgetBar = $('#sb-budget-bar');
  const sbBudgetText = $('#sb-budget-text');
  const sbBudgetSession = $('#sb-budget-session');
  const sbBudgetDaily = $('#sb-budget-daily');
  const sbBudgetMin = $('#sb-budget-mininterval');
  const sbCmdList = $('#sb-cmd-list');
  const sbCmdAdd = $('#sb-cmd-add');
  const sbTimerList = $('#sb-timer-list');
  const sbTimerAdd = $('#sb-timer-add');
  const sbAlertList = $('#sb-alert-list');
  const sbGoalList = $('#sb-goal-list');
  const sbGoalAdd = $('#sb-goal-add');

  /** The panel's working copy — mutated by inputs, committed per section. */
  let bot = null;
  /** The last link state, for the bot's status line only. */
  let botLinks = null;

  /**
   * One debounce timer PER section, plus an in-flight flag. A shared timer
   * (the plain debounce() above) silently cancels a pending commands commit
   * when a settings commit follows inside the window — which is "my command
   * never saved" from the operator's chair.
   */
  const botCommitTimers = new Map();
  const botCommitPending = new Set();

  function commitBotSection(section) {
    if (botCommitTimers.has(section)) clearTimeout(botCommitTimers.get(section));
    botCommitPending.add(section);
    botCommitTimers.set(
      section,
      setTimeout(async () => {
        botCommitTimers.delete(section);
        if (!bot || !window.apex.streamBot) {
          botCommitPending.delete(section);
          return;
        }
        try {
          await window.apex.streamBot.update(section, section === 'settings'
            ? { enabled: bot.enabled, platforms: bot.platforms, youtubeBudget: bot.youtubeBudget }
            : bot[section]);
        } finally {
          // Only mark clean if no NEW edit re-armed the timer while in flight.
          if (!botCommitTimers.has(section)) botCommitPending.delete(section);
        }
      }, 500),
    );
  }

  /** Whether the operator is typing somewhere a re-render would destroy. */
  function botEditing() {
    const active = document.activeElement;
    if (!active) return false;
    return [sbCmdList, sbTimerList, sbAlertList, sbGoalList].some((el) => el && el.contains(active));
  }

  /** A fresh row id, minted client-side so it stays stable across saves. */
  function sbNewId() {
    return `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  }

  /**
   * Whether a section's local rows would survive the main process's validator
   * unchanged. A half-typed row (no name yet, no response yet) is dropped by
   * the validator, so while one exists the echoed state is MISSING it — a
   * "clean save" echo and a "your row was thrown away" echo look identical,
   * and only this predicate tells them apart.
   */
  function botSectionComplete(section) {
    if (!bot) return true;
    if (section === 'commands') return bot.commands.every((c) => c.name && c.response);
    if (section === 'timers') return bot.timers.every((t) => t.text);
    if (section === 'goals') return bot.goals.every((g) => g.label);
    return true;
  }

  /* ---- tiny DOM builders (textContent-safe, no markup from data) ---------- */

  function sbInput(value, placeholder, onInput, type) {
    const input = document.createElement('input');
    input.className = 'field__input';
    input.type = type || 'text';
    if (type === 'number') input.min = '0';
    input.value = value == null ? '' : String(value);
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener('input', () => onInput(input));
    return input;
  }

  function sbCheck(label, checked, onChange, title) {
    const wrap = document.createElement('label');
    wrap.className = 'sb-check';
    if (title) wrap.title = title;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    wrap.appendChild(input);
    wrap.appendChild(document.createTextNode(label));
    return wrap;
  }

  function sbDelete(onClick, what) {
    const btn = document.createElement('button');
    btn.className = 'iconbtn sm sb-row__del';
    btn.type = 'button';
    btn.title = `Delete ${what}`;
    btn.setAttribute('aria-label', `Delete ${what}`);
    btn.innerHTML = window.apexIcon ? window.apexIcon('trash-2') : '✕';
    btn.addEventListener('click', onClick);
    return btn;
  }

  function sbEmpty(list, text) {
    const li = document.createElement('li');
    li.className = 'sb-empty';
    li.textContent = text;
    list.appendChild(li);
  }

  /**
   * A header row naming each column — above all, which UNIT a number is in
   * ("every … minutes", "cooldown seconds"); a bare number box invites typing
   * 30 seconds into a minutes field. Same grid template as the data rows so
   * the labels sit exactly over their columns.
   */
  function sbHead(list, rowClass, labels) {
    const li = document.createElement('li');
    li.className = `sb-row ${rowClass} sb-head`;
    for (const label of labels) {
      const span = document.createElement('span');
      span.textContent = label;
      li.appendChild(span);
    }
    list.appendChild(li);
  }

  /* ---- the four editors --------------------------------------------------- */

  function renderCommands() {
    if (!sbCmdList || !bot) return;
    sbCmdList.innerHTML = '';
    if (!bot.commands.length) sbEmpty(sbCmdList, 'No commands yet — add !discord, !socials, !specs…');
    else sbHead(sbCmdList, 'sb-row--cmd', ['Command', 'Reply', 'Cooldown (sec)', '', '']);
    bot.commands.forEach((c, i) => {
      const li = document.createElement('li');
      li.className = 'sb-row sb-row--cmd';
      li.appendChild(sbInput(c.name ? `!${c.name}` : '', '!discord', (el) => {
        c.name = el.value.replace(/^!+/, '').toLowerCase().replace(/[^a-z0-9_]/g, '');
        commitBotSection('commands');
      }));
      li.appendChild(sbInput(c.response, 'The reply the bot posts', (el) => {
        c.response = el.value;
        commitBotSection('commands');
      }));
      const cooldown = sbInput(c.cooldownSec, 'sec', (el) => {
        c.cooldownSec = Math.max(0, Math.floor(Number(el.value) || 0));
        commitBotSection('commands');
      }, 'number');
      cooldown.title = 'Cooldown (seconds)';
      li.appendChild(cooldown);
      li.appendChild(sbCheck('On', c.enabled, (on) => {
        c.enabled = on;
        commitBotSection('commands');
      }));
      li.appendChild(sbDelete(() => {
        bot.commands.splice(i, 1);
        renderCommands();
        commitBotSection('commands');
      }, `!${c.name || 'command'}`));
      sbCmdList.appendChild(li);
    });
  }

  function renderTimers() {
    if (!sbTimerList || !bot) return;
    sbTimerList.innerHTML = '';
    if (!bot.timers.length) sbEmpty(sbTimerList, 'No timed messages yet.');
    else sbHead(sbTimerList, 'sb-row--timer', ['Message', 'Every (min)', '', '', '', '']);
    bot.timers.forEach((t, i) => {
      const li = document.createElement('li');
      li.className = 'sb-row sb-row--timer';
      li.appendChild(sbInput(t.text, 'Follow us at …', (el) => {
        t.text = el.value;
        commitBotSection('timers');
      }));
      const interval = sbInput(t.intervalMin, 'min', (el) => {
        t.intervalMin = Math.max(1, Math.floor(Number(el.value) || 1));
        commitBotSection('timers');
      }, 'number');
      interval.title = 'Interval (minutes) — YouTube enforces its own minimum';
      li.appendChild(interval);
      li.appendChild(sbCheck('Twitch', t.platforms.twitch, (on) => {
        t.platforms.twitch = on;
        commitBotSection('timers');
      }));
      li.appendChild(sbCheck('YouTube', t.platforms.youtube, (on) => {
        t.platforms.youtube = on;
        commitBotSection('timers');
      }, 'Spends the YouTube budget'));
      li.appendChild(sbCheck('On', t.enabled, (on) => {
        t.enabled = on;
        commitBotSection('timers');
      }));
      li.appendChild(sbDelete(() => {
        bot.timers.splice(i, 1);
        renderTimers();
        commitBotSection('timers');
      }, 'timed message'));
      sbTimerList.appendChild(li);
    });
  }

  const SB_ALERT_LABELS = {
    sub: 'New sub',
    resub: 'Resub',
    gift: 'Gifted subs',
    membership: 'New member',
    superchat: 'Super Chat',
  };

  function renderAlerts() {
    if (!sbAlertList || !bot) return;
    sbAlertList.innerHTML = '';
    for (const key of Object.keys(SB_ALERT_LABELS)) {
      const alert = bot.alerts[key];
      if (!alert) continue;
      const li = document.createElement('li');
      li.className = 'sb-row sb-row--alert';
      const label = document.createElement('span');
      label.className = 'sb-row__label';
      label.textContent = SB_ALERT_LABELS[key];
      li.appendChild(label);
      li.appendChild(sbInput(alert.template, 'Thanks {user}!', (el) => {
        alert.template = el.value;
        commitBotSection('alerts');
      }));
      li.appendChild(sbCheck('On', alert.enabled, (on) => {
        alert.enabled = on;
        commitBotSection('alerts');
      }));
      sbAlertList.appendChild(li);
    }
  }

  function renderGoals() {
    if (!sbGoalList || !bot) return;
    sbGoalList.innerHTML = '';
    if (!bot.goals.length) sbEmpty(sbGoalList, 'No goals yet — try a sub goal for the next stream.');
    else sbHead(sbGoalList, 'sb-row--goal', ['Goal', 'Counts', 'Now', 'Target', 'Every Nth', '', '']);
    bot.goals.forEach((g, i) => {
      const li = document.createElement('li');
      li.className = 'sb-row sb-row--goal';
      li.appendChild(sbInput(g.label, 'Sub goal', (el) => {
        g.label = el.value;
        commitBotSection('goals');
      }));
      const type = document.createElement('select');
      type.className = 'field__input';
      type.title = 'What the goal counts';
      for (const [value, text] of [['twitch_subs', 'Twitch subs'], ['yt_members', 'YT members']]) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        type.appendChild(opt);
      }
      type.value = g.type;
      type.addEventListener('change', () => {
        g.type = type.value;
        commitBotSection('goals');
      });
      li.appendChild(type);
      const current = sbInput(g.current, 'now', (el) => {
        g.current = Math.max(0, Math.floor(Number(el.value) || 0));
        commitBotSection('goals');
      }, 'number');
      current.title = 'Current count (auto-counts new events; correct it here)';
      li.appendChild(current);
      const target = sbInput(g.target, 'target', (el) => {
        g.target = Math.max(1, Math.floor(Number(el.value) || 1));
        commitBotSection('goals');
      }, 'number');
      target.title = 'Target';
      li.appendChild(target);
      const every = sbInput(g.announceEveryN, 'every', (el) => {
        g.announceEveryN = Math.max(1, Math.floor(Number(el.value) || 1));
        commitBotSection('goals');
      }, 'number');
      every.title = 'Announce progress every N';
      li.appendChild(every);
      li.appendChild(sbCheck('On', g.enabled, (on) => {
        g.enabled = on;
        commitBotSection('goals');
      }));
      li.appendChild(sbDelete(() => {
        bot.goals.splice(i, 1);
        renderGoals();
        commitBotSection('goals');
      }, g.label || 'goal'));
      sbGoalList.appendChild(li);
    });
  }

  /* ---- status + budget ----------------------------------------------------- */

  function renderBotStatus() {
    if (!sbStatus || !bot) return;
    if (!bot.enabled) {
      sbStatus.textContent = 'Off';
      return;
    }
    const parts = [];
    if (bot.platforms.twitch) {
      parts.push(botLinks && botLinks.twitchAuthed
        ? `Twitch as ${botLinks.twitchAccount || 'you'}`
        : 'Twitch (link your account to speak)');
    }
    if (bot.platforms.youtube) {
      if (!botLinks || !botLinks.youTubeLinked) parts.push('YouTube (link your account)');
      else if (botLinks.youTubeNeedsRelink) parts.push('YouTube (relink to speak)');
      else parts.push(botLinks.youTubeLive ? 'YouTube live' : 'YouTube (waiting for a live stream)');
    }
    sbStatus.textContent = parts.length ? `On — ${parts.join(' · ')}` : 'On — no platforms selected';
  }

  function renderBotBudget() {
    if (!bot || !bot.usage) return;
    const u = bot.usage;
    const capped = u.sessionCap > 0 || u.dailyCap > 0;
    // The meter only means something against a cap the streamer set. Uncapped,
    // the bar hides and the text is a plain tally — service-level numbers are
    // an internal concern and never belong on a user's screen.
    const spentFraction = capped
      ? Math.max(
          u.sessionCap > 0 ? u.usedSession / u.sessionCap : 0,
          u.dailyCap > 0 ? u.usedToday / u.dailyCap : 0,
        )
      : 0;
    if (sbBudgetBar) {
      if (sbBudgetBar.parentElement) sbBudgetBar.parentElement.hidden = !capped;
      sbBudgetBar.style.width = `${Math.min(100, Math.round(spentFraction * 100))}%`;
      sbBudgetBar.setAttribute('data-warn', String(capped && spentFraction >= 0.75));
    }
    if (sbBudgetText) {
      if (capped) {
        const cap = (used, max) => (max > 0 ? `${used}/${max}` : `${used}`);
        sbBudgetText.textContent =
          `${cap(u.usedSession, u.sessionCap)} this stream · ${cap(u.usedToday, u.dailyCap)} today` +
          (spentFraction >= 1 ? ' — YouTube sending paused until the cap resets' : '');
      } else {
        sbBudgetText.textContent = `${u.usedSession} sent this stream · ${u.usedToday} today`;
      }
    }
  }

  /** The list sections and their renderers, for the per-section merge below. */
  const BOT_SECTIONS = [
    ['commands', renderCommands],
    ['timers', renderTimers],
    ['alerts', renderAlerts],
    ['goals', renderGoals],
  ];

  function renderBotState(state) {
    if (!state) return;
    if (!bot) {
      // First load: nothing local to protect.
      bot = state;
      for (const [, render] of BOT_SECTIONS) render();
    } else {
      // MERGE, never replace: the row objects on screen are closed over by
      // their inputs, so swapping the model out from under them detaches every
      // keystroke that follows (and a half-typed row, which the validator
      // rightly drops from the echo, would silently vanish). A section only
      // adopts the pushed copy when the local one has nothing unsaved: no
      // pending commit, no incomplete row, and the cursor not inside it.
      bot.usage = state.usage;
      bot.enabled = state.enabled;
      bot.platforms = state.platforms;
      bot.youtubeBudget = state.youtubeBudget;
      const editing = botEditing();
      for (const [section, render] of BOT_SECTIONS) {
        if (botCommitPending.has(section) || !botSectionComplete(section) || editing) continue;
        bot[section] = state[section];
        render();
      }
    }
    if (sbEnabled) sbEnabled.checked = !!bot.enabled;
    if (sbPlatformTwitch) sbPlatformTwitch.checked = !!bot.platforms.twitch;
    if (sbPlatformYoutube) sbPlatformYoutube.checked = !!bot.platforms.youtube;
    if (sbBudgetSession && document.activeElement !== sbBudgetSession) sbBudgetSession.value = bot.youtubeBudget.sessionCap;
    if (sbBudgetDaily && document.activeElement !== sbBudgetDaily) sbBudgetDaily.value = bot.youtubeBudget.dailyCap;
    if (sbBudgetMin && document.activeElement !== sbBudgetMin) sbBudgetMin.value = bot.youtubeBudget.minTimerIntervalMin;
    renderBotStatus();
    renderBotBudget();
  }

  async function refreshStreamBot() {
    if (!window.apex.streamBot) return;
    try {
      renderBotState(await window.apex.streamBot.get());
    } catch {
      /* main not ready — the push channel will catch us up */
    }
  }

  /* ---- wiring -------------------------------------------------------------- */

  if (sbEnabled) {
    sbEnabled.addEventListener('change', () => {
      if (!bot) return;
      bot.enabled = sbEnabled.checked;
      renderBotStatus();
      void window.apex.streamBot.setEnabled(sbEnabled.checked);
    });
  }
  for (const [el, key] of [[sbPlatformTwitch, 'twitch'], [sbPlatformYoutube, 'youtube']]) {
    if (!el) continue;
    el.addEventListener('change', () => {
      if (!bot) return;
      bot.platforms[key] = el.checked;
      renderBotStatus();
      commitBotSection('settings');
    });
  }
  for (const [el, key] of [
    [sbBudgetSession, 'sessionCap'],
    [sbBudgetDaily, 'dailyCap'],
    [sbBudgetMin, 'minTimerIntervalMin'],
  ]) {
    if (!el) continue;
    el.addEventListener('input', () => {
      if (!bot) return;
      bot.youtubeBudget[key] = Math.max(0, Math.floor(Number(el.value) || 0));
      commitBotSection('settings');
    });
  }

  if (sbCmdAdd) {
    sbCmdAdd.addEventListener('click', () => {
      if (!bot) return;
      bot.commands.push({ id: sbNewId(), name: '', response: '', cooldownSec: 10, enabled: true });
      renderCommands();
      const first = sbCmdList && sbCmdList.querySelector('li:last-child input');
      if (first) first.focus();
    });
  }
  if (sbTimerAdd) {
    sbTimerAdd.addEventListener('click', () => {
      if (!bot) return;
      bot.timers.push({
        id: sbNewId(),
        text: '',
        intervalMin: 15,
        onlyWhileLive: true,
        platforms: { twitch: true, youtube: false },
        enabled: true,
      });
      renderTimers();
      const first = sbTimerList && sbTimerList.querySelector('li:last-child input');
      if (first) first.focus();
    });
  }
  if (sbGoalAdd) {
    sbGoalAdd.addEventListener('click', () => {
      if (!bot) return;
      bot.goals.push({
        id: sbNewId(),
        type: 'twitch_subs',
        label: '',
        target: 10,
        current: 0,
        announceEveryN: 5,
        enabled: true,
        templates: { progress: '{label}: {current}/{target}!', complete: 'GOAL COMPLETE — {label} hit {target}! 🏁' },
      });
      renderGoals();
      const first = sbGoalList && sbGoalList.querySelector('li:last-child input');
      if (first) first.focus();
    });
  }

  if (window.apex.streamBot) {
    window.apex.streamBot.onChange(renderBotState);
    void refreshStreamBot();
  }
  window.apex.chatLink.onChange((state) => {
    botLinks = state;
    renderBotStatus();
  });
  window.apex.chatLink.status().then((state) => {
    botLinks = state;
    renderBotStatus();
  });

  // --- What's new ----------------------------------------------------------
  /*
   * The release notes, drawn from the CHANGELOG.md packaged with the app. Opens
   * by itself once after an update — listing every release between the build
   * that was last opened and this one — and on demand from the version in the
   * footer.
   *
   * The main process sends parsed BLOCKS, never HTML (see electron/changelog.js),
   * and everything below is built with createElement + textContent. That is the
   * point: release notes are the one screen whose content comes from a file that
   * travels with the release, and later from a GitHub release body, so nothing
   * here may be able to inject markup into the panel.
   */

  const RELEASES_URL = 'https://github.com/Lilybankai/Apexandchilloverlaysystem/releases';

  const sheet = $('#whatsnew');
  const sheetBody = $('#whatsnew-body');
  const sheetSub = $('#whatsnew-sub');
  const sheetTitle = $('#whatsnew-title');

  /** Inline spans → text nodes and the three elements the changelog uses. */
  function appendSpans(parent, spans) {
    for (const span of spans || []) {
      if (span.t === 'b') {
        const b = document.createElement('b');
        b.textContent = span.s;
        parent.appendChild(b);
      } else if (span.t === 'i') {
        const i = document.createElement('i');
        i.textContent = span.s;
        parent.appendChild(i);
      } else if (span.t === 'code') {
        const c = document.createElement('code');
        c.textContent = span.s;
        parent.appendChild(c);
      } else if (span.t === 'link') {
        // A real <a href> would navigate the panel window itself, so links go
        // out through the main process like every other outbound URL here.
        const a = document.createElement('a');
        a.href = '#';
        a.textContent = span.s;
        a.addEventListener('click', (e) => {
          e.preventDefault();
          window.apex.openInBrowser(span.href);
        });
        parent.appendChild(a);
      } else {
        parent.appendChild(document.createTextNode(span.s));
      }
    }
  }

  /** Blocks → DOM, recursing into nested bullets. */
  function appendBlocks(parent, blocks) {
    for (const block of blocks || []) {
      if (block.type === 'heading') {
        const h = document.createElement('p');
        h.className = 'release__section';
        h.textContent = block.text;
        // Added / Fixed / Changed / Removed get their colour from the data
        // attribute; anything else (the occasional prose heading in the file)
        // is left neutral rather than mis-coloured.
        const kind = String(block.text).trim().toLowerCase();
        if (['added', 'fixed', 'changed', 'removed'].includes(kind)) h.dataset.kind = kind;
        parent.appendChild(h);
      } else if (block.type === 'item') {
        const item = document.createElement('div');
        item.className = 'release__item';
        appendBlocks(item, block.body);
        parent.appendChild(item);
      } else if (block.type === 'para') {
        const p = document.createElement('p');
        p.className = 'release__para';
        appendSpans(p, block.spans);
        parent.appendChild(p);
      }
    }
  }

  /** One release: its version, date, and body. */
  function appendRelease(parent, entry, currentVersion) {
    const wrap = document.createElement('article');
    wrap.className = 'release';

    const head = document.createElement('header');
    head.className = 'release__head';
    const version = document.createElement('span');
    version.className = 'release__version';
    version.textContent = `v${entry.version}`;
    head.appendChild(version);
    if (entry.version === currentVersion) {
      const badge = document.createElement('span');
      badge.className = 'release__badge';
      badge.textContent = 'Installed';
      head.appendChild(badge);
    }
    if (entry.date) {
      const date = document.createElement('span');
      date.className = 'release__date';
      date.textContent = entry.date;
      head.appendChild(date);
    }
    wrap.appendChild(head);

    appendBlocks(wrap, entry.blocks);
    parent.appendChild(wrap);
  }

  /**
   * Open the sheet. `mode` decides the framing, not the content:
   *   'updated' — after an update, "here is what you missed"
   *   'history' — opened deliberately from the footer
   *   'pending' — notes for an update that is offered but not yet installed
   */
  function openSheet({ mode, current, from, entries, rawNotes, version }) {
    sheetBody.textContent = '';

    if (mode === 'pending') {
      sheetTitle.textContent = `What's new in ${version || 'the update'}`;
      sheetSub.textContent = 'From the release — this update is not installed yet.';
      const pre = document.createElement('p');
      pre.className = 'release__raw';
      pre.textContent = rawNotes;
      sheetBody.appendChild(pre);
    } else {
      const count = (entries || []).length;
      if (mode === 'updated') {
        sheetTitle.textContent = `Updated to v${current}`;
        sheetSub.textContent =
          count > 1
            ? `${count} releases since v${from} — everything you missed.`
            : `What changed since v${from}.`;
      } else {
        sheetTitle.textContent = 'Release notes';
        sheetSub.textContent = `You are running v${current}.`;
      }
      if (!count) {
        const empty = document.createElement('p');
        empty.className = 'release__empty';
        empty.textContent = 'No release notes were packaged with this build.';
        sheetBody.appendChild(empty);
      } else {
        for (const entry of entries) appendRelease(sheetBody, entry, current);
      }
    }

    // Unhide first: scrollTop does not take on a display:none element, and the
    // sheet would open where the last read left off.
    sheet.hidden = false;
    sheetBody.scrollTop = 0;
    const done = $('#whatsnew-done');
    if (done) done.focus();
  }

  /**
   * Close, and record this version as read — on close rather than on open, so
   * a crash or a force-quit part-way through means the notes are offered again.
   */
  function closeSheet() {
    if (sheet.hidden) return;
    sheet.hidden = true;
    void window.apex.changelog.markSeen();
  }

  for (const sel of ['#whatsnew-close', '#whatsnew-done', '#whatsnew-scrim']) {
    const el = $(sel);
    if (el) el.addEventListener('click', closeSheet);
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheet();
  });
  const sheetAll = $('#whatsnew-all');
  if (sheetAll) {
    sheetAll.addEventListener('click', (e) => {
      e.preventDefault();
      window.apex.openInBrowser(RELEASES_URL);
    });
  }

  const whatsnewOpen = $('#whatsnew-open');
  if (whatsnewOpen) {
    whatsnewOpen.addEventListener('click', async () => {
      const h = await window.apex.changelog.history();
      openSheet({ mode: 'history', current: h.current, entries: h.entries });
    });
  }

  // The one automatic appearance: first launch on a new version.
  window.apex.changelog
    .pending()
    .then((p) => {
      if (p && p.show) openSheet({ mode: 'updated', ...p });
    })
    .catch(() => {
      /* no notes packaged — the footer link still works */
    });

  // --- App updates ---------------------------------------------------------

  /**
   * The Updates card in Settings (league staff only — see revealAdminTab).
   *
   * It answers three questions in the order they get asked: which feed am I on,
   * what am I actually running, and did the last check find anything. The last
   * one matters most right after a switch: picking "beta" when no beta has been
   * published yet is indistinguishable from a broken toggle unless the card
   * says "no beta build yet — you're on the newest there is".
   */
  function renderUpdatesCard(u) {
    if (!updateChannelSel || !u) return;
    const beta = u.channel === 'beta';
    updateChannelSel.value = beta ? 'beta' : 'stable';
    // Running a beta build counts as being on it, even if the setting has since
    // been put back to stable and the stable feed has not caught up yet.
    followingBeta = beta || !!u.runningIsBeta;
    applyUpdatesCardVisibility();
    updateChannelHint.textContent = beta
      ? 'Prereleases included. These are ours to test — expect them to be rough.'
      : 'Only full releases. This is what the league is running.';

    if (updateRunning) {
      updateRunning.textContent = u.running ? `v${u.running}` : '—';
      updateRunning.setAttribute('data-beta', u.runningIsBeta ? 'true' : 'false');
    }
    if (!updateStatus) return;
    switch (u.status) {
      case 'checking':
        updateStatus.textContent = 'Checking…';
        break;
      case 'available':
      case 'downloading':
      case 'ready':
        updateStatus.textContent = `v${u.version}${u.offeredIsBeta ? ' (beta)' : ''} — see the banner at the top.`;
        break;
      case 'none':
        // On stable while running a beta, "up to date" would be a lie: it means
        // the stable feed has not caught up with the build in front of you yet.
        updateStatus.textContent =
          !beta && u.runningIsBeta
            ? 'No stable release has passed this build yet — you stay on it until one does.'
            : `Up to date on the ${beta ? 'beta' : 'stable'} channel.`;
        break;
      case 'error':
        updateStatus.textContent = `Could not check: ${u.error || 'unknown error'}`;
        break;
      default:
        updateStatus.textContent = '—';
    }
  }

  function renderUpdate(u) {
    if (!u) return;
    renderUpdatesCard(u);
    // "What's new" rides alongside the action for as long as an update is
    // pending: the notes come off the release feed, so they exist before the
    // download does and stay useful right up to the restart.
    if (updateNotes) {
      const pending = u.status === 'available' || u.status === 'downloading' || u.status === 'ready';
      updateNotes.hidden = !(pending && u.notes);
      updateNotes.onclick = () =>
        openSheet({ mode: 'pending', version: u.version ? `v${u.version}` : '', rawNotes: u.notes });
    }
    // A beta is named as one everywhere it is offered. The banner is the last
    // thing seen before installing, so it is the last chance to say so.
    const label = u.offeredIsBeta ? `Beta ${u.version}` : `Version ${u.version}`;
    // Show the banner only when there's something actionable to report.
    switch (u.status) {
      case 'available':
        updateBanner.hidden = false;
        updateText.textContent = `${label} is available.`;
        updateAction.hidden = false;
        updateAction.disabled = false;
        updateAction.textContent = 'Download & install';
        updateAction.onclick = () => window.apex.downloadUpdate();
        break;
      case 'downloading':
        updateBanner.hidden = false;
        updateText.textContent = `Downloading update… ${u.percent}%`;
        updateAction.disabled = true;
        updateAction.textContent = 'Downloading…';
        break;
      case 'ready':
        updateBanner.hidden = false;
        updateText.textContent = `${label} is ready to install.`;
        updateAction.hidden = false;
        updateAction.disabled = false;
        updateAction.textContent = 'Restart & update';
        updateAction.onclick = () => window.apex.installUpdate();
        break;
      case 'error':
        // Stay quiet on background errors (offline, no releases yet).
        updateBanner.hidden = true;
        break;
      default:
        // idle / checking / none → keep the banner hidden.
        updateBanner.hidden = true;
    }
  }

  if (updateChannelSel) {
    updateChannelSel.addEventListener('change', async () => {
      const channel = updateChannelSel.value === 'beta' ? 'beta' : 'stable';
      updateChannelSel.disabled = true;
      try {
        renderUpdate(await window.apex.setUpdateChannel(channel));
        showToast(channel === 'beta' ? 'Following beta builds.' : 'Following stable releases.');
      } finally {
        updateChannelSel.disabled = false;
      }
    });
  }
  if (updateCheck) {
    updateCheck.addEventListener('click', async () => {
      updateCheck.disabled = true;
      try {
        renderUpdate(await window.apex.checkForUpdate());
      } finally {
        updateCheck.disabled = false;
      }
    });
  }

  window.apex.onUpdate(renderUpdate);
  window.apex.getUpdateState().then(renderUpdate);

  // --- Boot ----------------------------------------------------------------
  window.apex.getState().then(renderAll);
  window.apex.auth.getState().then(renderAuth);
  window.apex.chatLink.status().then(renderChatState);
  void renderBindings();
  void renderLmuBindings();
  // The logo list lives on disk, not in settings, so it is fetched separately.
  window.apex.sponsorsList().then(renderSponsors);
  // Same for the lap history — files on disk, not part of app state.
  refreshWeek();
  refreshLapSync();
})();
