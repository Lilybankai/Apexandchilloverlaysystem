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
    const [text, tone] = statusText(s);
    statusEl.textContent = text;
    statusEl.className = 'eng-status' + (tone ? ` eng-status--${tone}` : '');

    voicesEl.replaceChildren(...s.voices.map((v) => voiceRow(v, s)));

    if (!grammarEl.childElementCount && s.grammar) {
      grammarEl.replaceChildren(
        ...s.grammar.map((g) => {
          const row = document.createElement('div');
          row.className = 'eng-grammar__row';
          const what = document.createElement('span');
          what.className = 'eng-grammar__what';
          what.textContent = INTENT_LABELS[g.intent] || g.intent;
          const phrases = document.createElement('span');
          phrases.className = 'eng-grammar__phrases';
          phrases.textContent = `“${g.phrases.join('” · “')}”`;
          row.append(what, phrases);
          return row;
        }),
      );
    }
  }

  /* ---- wiring ------------------------------------------------------------------ */

  toggle.addEventListener('change', () => {
    void api.updateSettings({ engineerEnabled: toggle.checked });
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

  api.onEngineerStatus(render);
  void api.engineerStatus().then(render);
  void renderPtt();
})();
