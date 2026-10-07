/**
 * training-reference.js — Training ▸ Chase: which lap Ghost HUD chases.
 * -----------------------------------------------------------------------------
 * The renderer half of electron/trainingReference.js. Main owns the board
 * read, the trace fetch and the cache; this file only shows the choice and
 * sends it back.
 *
 * Self-contained on purpose: it renders into whatever element it is given and
 * reaches nothing by id, so the Training view's markup can change around it.
 *
 *   window.apexTrainingRef.mount(el)  — render into `el` and start listening
 *   window.apexTrainingRef.refresh()  — re-read the board and the status
 */

'use strict';

window.apexTrainingRef = (function () {
  let root = null;
  let data = null;
  let busy = false;
  let unsubscribe = null;
  let refreshTimer = 0;

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /* ---------------------------------------------------------------- copy */

  const OWN_REASON = {
    chosen: 'Chasing your own best.',
    'no-board-line': 'No board lap with a line for this combo — chasing your best.',
    'you-lead': 'You hold the quickest board lap here — chasing your own best.',
    'pinned-unavailable': 'That lap is no longer on the board with a line — chasing your best.',
    'board-unavailable': 'Couldn’t reach the leaderboard — chasing your best. It will try again.',
    'trace-unavailable': 'Couldn’t fetch that lap — chasing your best for now. It will try again.',
  };

  function statusText(st) {
    switch (st && st.state) {
      case 'board':
        return { text: `Chasing ${st.label}.`, tone: 'ok' };
      case 'loading':
        return { text: `Fetching ${st.label}…`, tone: 'busy' };
      case 'own':
        return { text: OWN_REASON[st.reason] || OWN_REASON.chosen, tone: st.reason === 'chosen' ? 'ok' : 'warn' };
      case 'signed-out':
        return { text: 'Sign in to chase a lap from the leaderboard. Until then the ghost is your own best.', tone: 'warn' };
      case 'not-dry':
        return { text: 'The track is damp or wet. Board laps are all dry, so the ghost is your own best.', tone: 'warn' };
      case 'no-combo':
        return { text: 'Drive onto a circuit and the board for your car class shows here.', tone: 'idle' };
      default:
        return { text: 'Ghost HUD is off. Turn it on to chase a lap.', tone: 'idle' };
    }
  }

  /* -------------------------------------------------------------- render */

  function choiceOf(d) {
    const c = d && d.choice;
    if (c && typeof c === 'object') return { kind: 'pin', driverId: c.driverId };
    return { kind: c === 'own' ? 'own' : 'auto' };
  }

  function render() {
    if (!root) return;
    const d = data || {};
    const st = statusText(d.status);
    const choice = choiceOf(d);
    const rows = Array.isArray(d.rows) ? d.rows : [];
    const lined = rows.filter((r) => r.hasLine);
    const unlined = rows.length - lined.length;
    const disabled = busy || !d.combo ? ' disabled' : '';

    const option = (kind, title, hint) => `
      <button type="button" class="tref__opt" data-tref-choice="${kind}"
              aria-pressed="${choice.kind === kind}"${disabled}>
        <span class="tref__opt-title">${title}</span>
        <span class="tref__opt-hint">${hint}</span>
      </button>`;

    const rowHtml = (r) => {
      const pinned = choice.kind === 'pin' && choice.driverId === r.driverId;
      const autoPick = choice.kind === 'auto' && d.selected === r.driverId;
      return `
        <li>
          <button type="button" class="tref__row" data-tref-driver="${esc(r.driverId)}"
                  data-tref-track="${esc(r.trackId)}" aria-pressed="${pinned}"${disabled}>
            <span class="tref__rank">${Number.isInteger(r.rank) ? r.rank : ''}</span>
            <span class="tref__name">${esc(r.name)}${r.isYou ? ' <span class="tref__tag">you</span>' : ''}${
              autoPick ? ' <span class="tref__tag" data-tone="cyan">auto</span>' : ''
            }</span>
            <span class="tref__time">${esc(r.time)}</span>
            <span class="tref__car" title="${esc(r.car)}">${esc(r.car)}</span>
          </button>
        </li>`;
    };

    let list = '';
    if (d.combo && !d.signedOut && d.combo.condition === 'dry') {
      list = lined.length
        ? `<ol class="tref__list">${lined.map(rowHtml).join('')}</ol>`
        : '<p class="tref__empty">No board lap here has a driven line yet.</p>';
      if (unlined > 0) {
        list += `<p class="tref__note">${unlined} more board lap${unlined === 1 ? '' : 's'} without a line — set before the line was recorded, so there is nothing to draw.</p>`;
      }
    }

    const where = d.combo
      ? `<p class="tref__combo">${esc(d.combo.track || d.combo.trackKey)} · ${esc(d.combo.carClass)}</p>`
      : '';

    root.innerHTML = `
      <div class="tref">
        <p class="tref__status" data-tone="${st.tone}" role="status">${esc(st.text)}</p>
        ${where}
        <div class="tref__opts">
          ${option('auto', 'Auto', 'The quickest board lap with a line in your class')}
          ${option('own', 'Your best', 'Your fastest clean lap on this surface')}
        </div>
        ${list}
        ${d.error && !d.signedOut ? `<p class="tref__note" data-tone="warn">${esc(d.error)}</p>` : ''}
      </div>`;
  }

  /* ------------------------------------------------------------- actions */

  async function refresh() {
    if (!root || !window.apex || typeof window.apex.trainingRefOptions !== 'function') return;
    try {
      data = await window.apex.trainingRefOptions();
    } catch (err) {
      data = { ok: false, rows: [], error: String((err && err.message) || err) };
    }
    render();
  }

  async function choose(choice) {
    if (busy) return;
    busy = true;
    render();
    try {
      const res = await window.apex.trainingSetRef({ choice });
      if (res && res.ok !== false) data = res;
      else if (data) data = { ...data, error: (res && res.error) || 'That did not work.' };
    } catch (err) {
      if (data) data = { ...data, error: String((err && err.message) || err) };
    } finally {
      busy = false;
      render();
    }
  }

  function onClick(e) {
    const opt = e.target.closest('[data-tref-choice]');
    if (opt && root.contains(opt)) {
      choose(opt.dataset.trefChoice === 'own' ? 'own' : 'auto');
      return;
    }
    const row = e.target.closest('[data-tref-driver]');
    if (row && root.contains(row)) {
      choose({ driverId: row.dataset.trefDriver, trackId: row.dataset.trefTrack });
    }
  }

  /** Status pushes arrive often while a lap is fetched; re-read once they settle. */
  function onStatus(status) {
    if (!root) return;
    if (data) data = { ...data, status };
    render();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 400);
  }

  function mount(el) {
    if (!el) return;
    if (root && root !== el) root.removeEventListener('click', onClick);
    root = el;
    root.addEventListener('click', onClick);
    if (!unsubscribe && window.apex && typeof window.apex.onTrainingRef === 'function') {
      unsubscribe = window.apex.onTrainingRef(onStatus);
    }
    render();
    refresh();
  }

  return { mount, refresh };
})();
