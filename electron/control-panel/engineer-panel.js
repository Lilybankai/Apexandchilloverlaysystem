/**
 * engineer-panel.js — the Engineer tab.
 * -----------------------------------------------------------------------------
 * A thin renderer over main's engineer service: everything real (downloads,
 * the pipeline, the microphone) lives in electron/engineer.js; this file turns
 * `engineer:status` payloads into the voice picker, the push-to-talk binding
 * row and the phrase reference, and turns clicks into IPC calls.
 *
 * No polling: the initial status is fetched once, then re-renders ride the
 * pushes (which include download progress once a second while curl works).
 * Voice SAMPLES stream from the voice library over <audio> (allowed by the
 * page's media-src); "Hear" speaks locally through the real radio channel,
 * which is the honest preview once a voice is installed.
 */

(function () {
  'use strict';

  const api = window.apex;
  if (!api || !api.engineerStatus) return;

  const $ = (sel) => document.querySelector(sel);
  const toggle = $('#eng-toggle');
  const statusEl = $('#eng-status');
  const voicesEl = $('#eng-voices');
  const grammarEl = $('#eng-grammar');
  const pttChip = $('#eng-ptt-chip');
  const pttBind = $('#eng-ptt-bind');
  const pttClear = $('#eng-ptt-clear');
  const readouts = $('#eng-readouts');
  const readoutsHint = $('#eng-readouts-hint');
  const sttStatus = $('#eng-stt-status');
  const sttDownload = $('#eng-stt-download');
  const lastWrap = $('#eng-last-call-wrap');
  const lastQ = $('#eng-last-q');
  const lastA = $('#eng-last-a');
  const rateRow = $('#eng-rate-row');
  const rateDone = $('#eng-rate-done');

  /** What each preset means, spelled out under the picker. */
  const READOUT_HINTS = {
    off: 'Nothing unprompted — the engineer only speaks when you press the button.',
    essential:
      'Calls the things that change the rules or end races: flags, fuel, ' +
      'penalties, damage. Never reads out what your screen already shows, and ' +
      'stays quiet while you are side by side or deep in the brakes.',
    standard:
      'Essential plus the race story: your fastest laps, the field’s, places ' +
      'gained and lost, the rivals’ stops, blue flags. Your question always ' +
      'cuts in front of a call.',
  };

  function renderReadoutsHint() {
    readoutsHint.textContent = READOUT_HINTS[readouts.value] || READOUT_HINTS.essential;
  }

  /** What a driver would call each intent — keys mirror engineerCommands.ts. */
  const INTENT_LABELS = {
    gapAhead: 'Gap to the car ahead',
    gapBehind: 'Gap to the car behind',
    avgAhead: 'Five-lap pace vs the car ahead',
    carAhead: "Who's ahead, and their pace",
    carBehind: "Who's behind, and their pace",
    traffic: 'Backmarkers & blue-flag traffic',
    lapsLeft: 'Laps / time left',
    fuel: 'Fuel state',
    lastLap: 'Last lap time',
    position: 'Position',
    tyres: 'Tyre temps & wear',
    pressures: 'Tyre pressures',
    damage: 'Damage report',
    brakes: 'Brake wear',
    pitStop: 'Planned pit stop',
    pitWindow: 'Pit window',
    energy: 'Virtual energy & who stops first',
    hybrid: 'Hybrid battery',
    pace: 'Pace score / predicted lap',
    bestLap: 'Your best lap',
    fieldFastest: "The field's fastest lap",
    leader: 'The leader, and your gap',
    gridStart: 'Places gained since the start',
    trackLimits: 'Track-limit points & penalties',
    flags: 'Yellow flags right now',
    weather: 'Weather & rain risk',
    brakeBias: 'Brake bias',
    tractionControl: 'Traction control setting',
  };

  let last = null; // latest status payload
  let sample = null; // the one <audio> that may be playing
  let sampleBtn = null;

  /* ---- status line ---------------------------------------------------------- */

  function statusText(s) {
    if (!s.engineInstalled || !s.selectedInstalled) {
      return ['Download a voice to go live — one click on the right.', 'warn'];
    }
    if (!s.enabled) return ['Off. Flip the switch to put the engineer on the radio.', ''];
    if (s.lastError) return [s.lastError, 'warn'];
    if (!s.running) return ['Starting…', ''];
    if (s.micAvailable === false) return ['Running, but no microphone was found.', 'warn'];
    return ['Live. Press the button and ask.', 'live'];
  }

  /* ---- voice list ------------------------------------------------------------ */

  function stopSample() {
    if (sample) {
      sample.pause();
      sample = null;
    }
    if (sampleBtn) {
      sampleBtn.textContent = 'Sample';
      sampleBtn = null;
    }
  }

  function voiceRow(v, s) {
    const row = document.createElement('div');
    row.className = 'eng-voice' + (v.selected ? ' eng-voice--selected' : '');

    const name = document.createElement('div');
    name.className = 'eng-voice__name';
    name.textContent = v.label;
    if (v.selected) {
      const b = document.createElement('span');
      b.className = 'eng-voice__badge eng-voice__badge--selected';
      b.textContent = 'On the radio';
      name.appendChild(b);
    } else if (v.installed) {
      const b = document.createElement('span');
      b.className = 'eng-voice__badge';
      b.textContent = 'Downloaded';
      name.appendChild(b);
    }
    row.appendChild(name);

    const actions = document.createElement('div');
    actions.className = 'eng-voice__actions';

    // Sample: stream the library's raw clip. One at a time; click again stops.
    const sampleB = document.createElement('button');
    sampleB.type = 'button';
    sampleB.className = 'btn btn--ghost btn--sm';
    sampleB.textContent = 'Sample';
    sampleB.addEventListener('click', () => {
      if (sampleBtn === sampleB) {
        stopSample();
        return;
      }
      stopSample();
      sample = new Audio(v.sampleUrl);
      sample.addEventListener('ended', stopSample);
      sample.addEventListener('error', () => {
        sampleB.textContent = 'Sample unavailable';
        sample = null;
        sampleBtn = null;
      });
      void sample.play();
      sampleBtn = sampleB;
      sampleB.textContent = 'Stop';
    });
    actions.appendChild(sampleB);

    if (!v.installed) {
      const dl = document.createElement('button');
      dl.type = 'button';
      dl.className = 'btn btn--sm';
      const busyThis = s.busy === `download:${v.id}`;
      dl.textContent = busyThis ? 'Downloading…' : `Download · ${v.sizeMb} MB`;
      dl.disabled = !!s.busy;
      dl.addEventListener('click', async () => {
        dl.disabled = true;
        dl.textContent = 'Downloading…';
        const res = await api.engineerDownload(v.id);
        if (res && res.ok === false) {
          dl.textContent = 'Retry download';
          dl.disabled = false;
        }
        // Success re-renders via the status push.
      });
      actions.appendChild(dl);
    } else {
      const hear = document.createElement('button');
      hear.type = 'button';
      hear.className = 'btn btn--ghost btn--sm';
      hear.textContent = 'Hear';
      hear.title = 'Speak the sample line locally, through the radio effect.';
      hear.addEventListener('click', () => void api.engineerPreview(v.id));
      actions.appendChild(hear);

      if (!v.selected) {
        const use = document.createElement('button');
        use.type = 'button';
        use.className = 'btn btn--sm';
        use.textContent = 'Use this voice';
        use.addEventListener('click', () => void api.updateSettings({ engineerVoice: v.id }));
        actions.appendChild(use);
      }
    }
    row.appendChild(actions);

    const blurb = document.createElement('p');
    blurb.className = 'eng-voice__blurb';
    blurb.textContent = v.blurb;
    row.appendChild(blurb);

    if (s.progress && s.progress.voiceId === v.id) {
      const bar = document.createElement('div');
      bar.className = 'eng-voice__progress';
      const fill = document.createElement('span');
      const pct = Math.min(100, Math.round((s.progress.mb / s.progress.totalMb) * 100));
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      row.appendChild(bar);
    }

    return row;
  }

  /* ---- push-to-talk binding --------------------------------------------------- */

  async function renderPtt() {
    if (!api.actionsList) return;
    const list = await api.actionsList();
    const action = list.find((a) => a.id === 'engineer.ask');
    const wheel = action && action.wheel && action.wheel.inc;
    const key = action && action.binding;
    const parts = [];
    if (wheel) parts.push(wheel.label || `button ${wheel.button}`);
    if (key) parts.push(key);
    pttChip.textContent = parts.length ? parts.join('  ·  ') : 'Not bound';
    pttChip.classList.toggle('eng-ptt-chip--bound', parts.length > 0);
    pttClear.hidden = !wheel;
  }

  pttBind.addEventListener('click', async () => {
    pttBind.disabled = true;
    pttChip.textContent = 'Press a wheel button…';
    try {
      const res = await api.wheelCapture();
      if (res && res.ok) {
        await api.wheelBind('engineer.ask', 'inc', { device: res.device, button: res.button });
      }
    } finally {
      pttBind.disabled = false;
      void renderPtt();
    }
  });

  pttClear.addEventListener('click', async () => {
    await api.wheelBind('engineer.ask', 'inc', null);
    void renderPtt();
  });

  /* ---- render ----------------------------------------------------------------- */

  function render(s) {
    last = s;
    toggle.checked = !!s.enabled;
    if (s.readouts && readouts.value !== s.readouts) readouts.value = s.readouts;
    renderReadoutsHint();
    const [text, tone] = statusText(s);
    statusEl.textContent = text;
    statusEl.className = 'eng-status' + (tone ? ` eng-status--${tone}` : '');

    voicesEl.replaceChildren(...s.voices.map((v) => voiceRow(v, s)));

    renderStt(s);
    renderLastCall(s);

    if (!grammarEl.childElementCount && s.grammar) renderGrammar(s.grammar);
  }

  function renderStt(s) {
    if (!sttStatus) return;
    const busy = s.busy === 'download:stt';
    if (s.progress && s.progress.voiceId === 'stt') {
      const pct = Math.min(100, Math.round((s.progress.mb / s.progress.totalMb) * 100));
      sttStatus.textContent = `Downloading… ${pct}%`;
      sttStatus.className = 'eng-status';
      sttDownload.hidden = true;
      return;
    }
    if (s.sttInstalled) {
      // The one number a driver cares about: how many advanced questions are
      // left this month. No plumbing talk.
      if (s.budget && typeof s.budget.remaining === 'number') {
        sttStatus.textContent =
          s.budget.remaining > 0
            ? `Ready — ${s.budget.remaining} advanced questions left this month.`
            : 'None left this month — back on the phrase list until it resets.';
        sttStatus.className =
          'eng-status ' + (s.budget.remaining > 0 ? 'eng-status--live' : 'eng-status--warn');
      } else {
        sttStatus.textContent = 'Ready.';
        sttStatus.className = 'eng-status eng-status--live';
      }
      sttDownload.hidden = true;
      return;
    }
    sttStatus.textContent = `Needs a one-time ${s.sttSizeMb || 148} MB download. The phrase list works without it.`;
    sttStatus.className = 'eng-status eng-status--warn';
    sttDownload.hidden = false;
    sttDownload.disabled = busy || !!s.busy;
    sttDownload.textContent = busy ? 'Downloading…' : `Download · ${s.sttSizeMb || 148} MB`;
  }

  function renderLastCall(s) {
    if (!lastWrap) return;
    const call = s.lastCall;
    if (!call || !call.answer) {
      lastWrap.hidden = true;
      return;
    }
    lastWrap.hidden = false;
    lastQ.textContent = 'You: ' + (call.question || '');
    lastA.textContent = 'Engineer: ' + call.answer;
    const rated = call.rating === 'useful' || call.rating === 'wrong';
    rateRow.hidden = rated;
    rateDone.hidden = !rated;
    if (rated) rateDone.textContent = call.rating === 'useful' ? 'Marked useful.' : 'Marked wrong.';
  }

  /* ---- the phrase reference ------------------------------------------------- */

  const sayFilter = $('#eng-say-filter');
  const sayEmpty = $('#eng-say-empty');

  /**
   * Grouped, columnar phrasebook. Groups come off the GRAMMAR table itself
   * (single source, same order the service ships), each phrase is a chip, and
   * the first phrase is the canonical one — visually louder so a new driver
   * learns the short form first. Rendered once; the filter only toggles
   * visibility.
   */
  function renderGrammar(grammar) {
    const groups = new Map(); // name → entries, insertion-ordered like GRAMMAR
    for (const g of grammar) {
      const name = g.group || 'More';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(g);
    }

    grammarEl.replaceChildren(
      ...[...groups.entries()].map(([name, entries]) => {
        const section = document.createElement('section');
        section.className = 'eng-say__group';

        const head = document.createElement('h3');
        head.className = 'eng-say__label';
        const title = document.createElement('span');
        title.textContent = name;
        const count = document.createElement('span');
        count.className = 'eng-say__count';
        count.textContent = String(entries.length);
        head.append(title, count);
        section.appendChild(head);

        for (const g of entries) {
          const row = document.createElement('div');
          row.className = 'eng-say__row';
          row.dataset.search = (
            name + ' ' + (INTENT_LABELS[g.intent] || g.intent) + ' ' + g.phrases.join(' ')
          ).toLowerCase();

          const what = document.createElement('div');
          what.className = 'eng-say__what';
          what.textContent = INTENT_LABELS[g.intent] || g.intent;
          row.appendChild(what);

          const chips = document.createElement('div');
          chips.className = 'eng-say__chips';
          g.phrases.forEach((p, i) => {
            const chip = document.createElement('span');
            chip.className = 'eng-say__chip' + (i === 0 ? ' eng-say__chip--primary' : '');
            chip.textContent = p;
            chips.appendChild(chip);
          });
          row.appendChild(chips);
          section.appendChild(row);
        }
        return section;
      }),
    );
  }

  /** Hide rows that don't match, groups that emptied, and say so when all did. */
  function applySayFilter() {
    const q = sayFilter.value.trim().toLowerCase();
    let any = false;
    for (const group of grammarEl.querySelectorAll('.eng-say__group')) {
      let visible = 0;
      for (const row of group.querySelectorAll('.eng-say__row')) {
        const hit = !q || row.dataset.search.includes(q);
        row.hidden = !hit;
        if (hit) visible++;
      }
      group.hidden = visible === 0;
      const count = group.querySelector('.eng-say__count');
      if (count) count.textContent = String(visible);
      if (visible) any = true;
    }
    sayEmpty.hidden = any;
  }

  /* ---- wiring ------------------------------------------------------------------ */

  sayFilter.addEventListener('input', applySayFilter);

  toggle.addEventListener('change', () => {
    void api.updateSettings({ engineerEnabled: toggle.checked });
  });
  readouts.addEventListener('change', () => {
    renderReadoutsHint();
    void api.updateSettings({ engineer: { readouts: readouts.value } });
  });
  $('#eng-radio-check').addEventListener('click', async () => {
    const res = await api.engineerTest();
    if (res && res.ok === false && last) {
      statusEl.textContent = res.error;
      statusEl.className = 'eng-status eng-status--warn';
    }
  });
  $('#eng-ask').addEventListener('click', async () => {
    const res = await api.engineerAsk();
    if (res && res.ok === false) {
      statusEl.textContent = res.error;
      statusEl.className = 'eng-status eng-status--warn';
    }
  });

  if (sttDownload) {
    sttDownload.addEventListener('click', async () => {
      sttDownload.disabled = true;
      sttDownload.textContent = 'Downloading…';
      const res = await api.engineerDownloadStt();
      if (res && res.ok === false) {
        sttDownload.disabled = false;
        sttDownload.textContent = 'Retry download';
        sttStatus.textContent = res.error || 'Download failed';
        sttStatus.className = 'eng-status eng-status--warn';
      }
    });
  }

  async function rate(which) {
    if (!last || !last.lastCall || !last.lastCall.id || !api.engineerRate) return;
    const res = await api.engineerRate(last.lastCall.id, which);
    if (res && res.ok === false && sttStatus) {
      sttStatus.textContent = res.error || 'Could not save rating';
      sttStatus.className = 'eng-status eng-status--warn';
    }
  }
  const usefulBtn = $('#eng-rate-useful');
  const wrongBtn = $('#eng-rate-wrong');
  if (usefulBtn) usefulBtn.addEventListener('click', () => void rate('useful'));
  if (wrongBtn) wrongBtn.addEventListener('click', () => void rate('wrong'));

  api.onEngineerStatus(render);
  void api.engineerStatus().then(render);
  void renderPtt();
})();
