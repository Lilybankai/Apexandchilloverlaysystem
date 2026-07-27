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
  const audioToggle = $('#audio-toggle');
  const audioRange = $('#audio-range');
  const audioEcho = $('#audio-echo');
  const audioTest = $('#audio-test');
  const limitsRange = $('#limits-range');
  const limitsEcho = $('#limits-echo');
  const ingameToggle = $('#ingame-toggle');
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
  const combinedUrl = $('#combined-url');
  const toast = $('#toast');
  const errorBanner = $('#error-banner');
  const errorText = $('#error-text');
  const updateBanner = $('#update-banner');
  const updateText = $('#update-text');
  const updateAction = $('#update-action');

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
    audioToggle.checked = settings.audioCues !== false;
    audioRange.value = settings.audioVolume;
    audioEcho.textContent = settings.audioVolume;
    limitsRange.value = settings.trackLimitsMarginTenths;
    limitsEcho.textContent = (settings.trackLimitsMarginTenths / 10).toFixed(1);
    sponsorsToggle.checked = !!settings.sponsorsEnabled;
    sponsorRange.value = settings.sponsorIntervalSec;
    sponsorEcho.textContent = settings.sponsorIntervalSec;
    ingameToggle.checked = !!settings.ingameEnabled;
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
    for (const o of overlays) {
      const li = document.createElement('li');
      li.className = 'card ovcard';
      li.setAttribute('data-enabled', String(o.enabled));

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

      li.appendChild(head);
      li.appendChild(desc);
      li.appendChild(urlWrap);
      li.appendChild(foot);
      overlayList.appendChild(li);
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

    // The design system's dashboard stat tiles.
    setText('#stat-laps-week', String(s.laps || 0));
    setText('#stat-time-driven', formatDuration(s.drivingMs || 0));
    setText('#stat-time-sub', s.distanceM ? `${formatDistance(s.distanceM)} covered` : '');
    setText('#stat-clean-laps', String(s.cleanLaps || 0));
    setText(
      '#stat-clean-sub',
      s.laps ? `${Math.round((s.cleanLaps / s.laps) * 100)}% of your laps` : '',
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
    const list = $('#week-bests-list');
    if (!wrap || !list) return;
    wrap.hidden = bests.length === 0;
    list.textContent = '';

    // The design system's `.lbrow` shape, minus its position column — and that
    // omission is the point. A position only means something within one track
    // and one class; these rows span both, so numbering them would rank a 1:31
    // at Fuji above a 3:27 at Le Mans and call it a result. Same reasoning
    // retires the purple "fastest" highlight here: it is the kit's signal for
    // quickest in a comparable set, and nothing on this list is comparable.
    // The Leaderboard tab is where real positions belong.
    for (const b of bests) {
      const li = document.createElement('li');
      li.className = 'lbrow';
      // createElement rather than innerHTML throughout: track and car names come
      // from the sim, and the panel's CSP would not save us from a mod pack with
      // a bracket in its name mangling the row.
      const track = document.createElement('span');
      track.className = 'lbrow__name';
      track.textContent = b.track || '—';
      const cls = document.createElement('span');
      cls.className = 'chip';
      cls.textContent = b.carClass || '—';
      const car = document.createElement('span');
      car.className = 'lbrow__car';
      car.textContent = b.car || '';
      const time = document.createElement('span');
      time.className = 'lbrow__time';
      time.textContent = formatLapTime(b.lapMs);
      li.append(track, cls, car, time);
      list.append(li);
    }
  }

  /** Pull a fresh summary. Cheap, and always current when the card is shown. */
  function refreshWeek() {
    window.apex.lapsWeek().then(renderWeek).catch(() => renderWeek(null));
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
    if (s && s.status === 'ok') refreshWeek();
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

  bgRange.addEventListener('input', () => {
    bgEcho.textContent = bgRange.value;
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

  // Track-limits threshold. Live like the visual sliders, but it retunes the
  // SERVER's detection rather than an overlay's look — the driver drags it after
  // a lap that felt wrongly judged, so waiting for a restart would defeat it.
  const commitLimitsMargin = debounce(async (tenths) => {
    await window.apex.updateSettings({ trackLimitsMarginTenths: tenths });
  }, 120);

  limitsRange.addEventListener('input', () => {
    const tenths = parseInt(limitsRange.value, 10);
    limitsEcho.textContent = (tenths / 10).toFixed(1);
    commitLimitsMargin(tenths);
  });

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

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'hotkey__clear';
    clear.title = 'Clear binding';
    clear.innerHTML = '&times;';
    clear.addEventListener('click', () => void commitBinding(action.id, '', chip));

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
      chip.textContent = bound ? glyph + 'btn ' + bound.button : glyph + 'wheel';
      chip.setAttribute('data-empty', String(!bound));
      chip.title = bound ? `${bound.device} button ${bound.button}` : 'Click, then press a wheel button';
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
        showToast(`Bound to ${res.device} button ${res.button}`);
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

  // Live status pushes from the main process.
  window.apex.onStatus((status) => renderStatus(status));

  // Settings pushes — e.g. the global hotkey flipped "Show in game" while the
  // panel was open. Keep the toggle and controls in sync without a reload.
  window.apex.onSettings((settings) => {
    if (settings) renderSettings(settings);
  });

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
    // this window, so the card is refreshed on arrival rather than on a timer.
    if (target === 'dashboard') refreshWeek();
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
    account.hidden = !signedIn;
    signInBtn.hidden = signedIn;
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

  // --- App updates ---------------------------------------------------------

  function renderUpdate(u) {
    if (!u) return;
    // Show the banner only when there's something actionable to report.
    switch (u.status) {
      case 'available':
        updateBanner.hidden = false;
        updateText.textContent = `Version ${u.version} is available.`;
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
        updateText.textContent = `Version ${u.version} is ready to install.`;
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

  window.apex.onUpdate(renderUpdate);
  window.apex.getUpdateState().then(renderUpdate);

  // --- Boot ----------------------------------------------------------------
  window.apex.getState().then(renderAll);
  window.apex.auth.getState().then(renderAuth);
  void renderBindings();
  // The logo list lives on disk, not in settings, so it is fetched separately.
  window.apex.sponsorsList().then(renderSponsors);
  // Same for the lap history — files on disk, not part of app state.
  refreshWeek();
  refreshLapSync();
})();
