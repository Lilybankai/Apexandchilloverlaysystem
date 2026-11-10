/**
 * sim-select.js — the sim chooser page (sim-select.html).
 * -----------------------------------------------------------------------------
 * Two cards, a "Remember my choice" box and Continue. The answer goes to main
 * (`window.apex.chooseSim`, main.js chooseSim), which saves it, starts the
 * telemetry server on that sim's provider and loads the panel with `?sim=`.
 *
 * The last sim used is preselected, so a driver who always picks the same one
 * is one Enter (or a double-click) away from the panel.
 */

'use strict';

(function () {
  const form = document.getElementById('pick-form');
  const go = document.getElementById('pick-go');
  const remember = document.getElementById('pick-remember');
  const msg = document.getElementById('pick-msg');
  const cards = Array.from(document.querySelectorAll('.card[data-sim]'));
  const radios = Array.from(document.querySelectorAll('.card__radio'));
  let busy = false;

  function picked() {
    const r = radios.find((x) => x.checked);
    return r ? r.value : null;
  }

  function paint() {
    const sim = picked();
    for (const card of cards) card.setAttribute('data-checked', String(card.dataset.sim === sim));
    go.disabled = busy || !sim;
  }

  function select(sim) {
    for (const r of radios) r.checked = r.value === sim;
    paint();
  }

  async function submit() {
    const sim = picked();
    if (!sim || busy) return;
    busy = true;
    paint();
    msg.hidden = true;
    go.querySelector('.btn__label').textContent = 'Starting…';
    let res = null;
    try {
      res = await window.apex.chooseSim(sim, { remember: remember.checked });
    } catch {
      res = null;
    }
    // On success main has already swapped the page; only a failure lands here.
    if (!res || res.ok === false) {
      busy = false;
      go.querySelector('.btn__label').textContent = 'Continue';
      msg.textContent = (res && res.error) || 'Something went wrong — try again.';
      msg.hidden = false;
      paint();
    }
  }

  for (const r of radios) r.addEventListener('change', paint);
  for (const card of cards) {
    card.addEventListener('dblclick', () => {
      select(card.dataset.sim);
      void submit();
    });
  }
  form.addEventListener('submit', (evt) => {
    evt.preventDefault();
    void submit();
  });

  // Preselect whichever sim was used last (LMU on an install from before
  // iRacing support), and the remembered box as it was.
  select('lmu');
  if (window.apex && typeof window.apex.getSim === 'function') {
    window.apex
      .getSim()
      .then((s) => {
        if (!s) return;
        if (s.sim === 'lmu' || s.sim === 'iracing') select(s.sim);
        remember.checked = !!s.remember;
      })
      .catch(() => {});
  }
  // Enter continues with whatever is picked, wherever focus is — the common
  // case is "same sim as last time", which is then one key from the panel.
  document.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter' || evt.defaultPrevented || evt.target === go) return;
    evt.preventDefault();
    void submit();
  });
})();
