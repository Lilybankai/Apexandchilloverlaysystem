/**
 * show-me.js — "Show me": a few steps of a lap, one at a time.
 * -----------------------------------------------------------------------------
 * 2026-10-29, the driving coach. The coach says where a lap lost time and
 * what to change; "Show me" walks the driver through it on their own lap —
 * this corner, framed, with where you braked and where they braked drawn on
 * the road, and the sentence that goes with it. Delta's Auto Insights does
 * the same and it is the part drivers remember.
 *
 * This file is only the step-through: a compact bar ("1 of 3 · C5 · Brake
 * later"), the step's words, previous / next and ←/→. It draws nothing on a
 * map. The HOST does that in `onStep(step, i)` — sets its window to
 * `step.window` and repaints its map and charts with `step.marks` and
 * `step.arrows` (review-charts.js `drawLapMap` / `drawChannels`, `opts.marks`
 * / `opts.arrows`). Two hosts use it, Review's Coach tab and the Practice
 * tab, so it knows neither: no element ids, no state of its own beyond which
 * step is on.
 *
 *   ShowMe.mount(el, { steps, onStep, start }) → { destroy(), go(i), index() }
 *
 * `steps` are `ShowStep`s (src/telemetry/coachContract.ts). `core(steps)` is
 * the stepping on its own, without a DOM, for the test (test:showme).
 *
 * The arrow keys are heard on the whole document — a driver who has just
 * clicked the map has focus on nothing in particular — but only while this
 * step-through is on screen, and never from a text field or with a modifier
 * held, and not when something nearer the key already handled it.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ShowMe = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const esc = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  /** What a mark kind is called, for a step with nothing better to be named by. */
  const KIND_WORD = { brake: 'Braking', turnin: 'Turn-in', apex: 'Apex speed', throttle: 'Throttle', full: 'Full throttle' };

  /**
   * A step's short name for the bar: "Brake later".
   *
   * A `title` on the step wins (an optional extra the coach may add). Else
   * the first arrow's words with the numbers taken out — "brake 12 m later"
   * is "Brake later", because the number is in the step's text and on the
   * map, and a bar that has to fit "1 of 3 · C14 ·" in front of it has room
   * for the verb only. Else the start of the text; else what was marked.
   */
  function titleOf(step) {
    if (!step) return '';
    if (typeof step.title === 'string' && step.title.trim()) return step.title.trim();
    const arrow = Array.isArray(step.arrows) ? step.arrows.find((a) => a && a.label) : null;
    if (arrow) {
      const bare = String(arrow.label)
        .replace(/[−+-]?\d+(?:[.,]\d+)?\s*(?:km\/h|kph|mph|m|s|%)?(?![a-z])/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (bare) return cap(bare);
    }
    const text = typeof step.text === 'string' ? step.text.trim() : '';
    if (text) {
      const first = text.split(/(?<=[.!?;:—])\s/)[0].replace(/[.!?;:—]+$/, '');
      if (first.length <= 32) return first;
      const cut = first.slice(0, 31);
      return `${cut.slice(0, Math.max(12, cut.lastIndexOf(' ')))}…`;
    }
    const mark = Array.isArray(step.marks) ? step.marks.find((m) => m && KIND_WORD[m.kind]) : null;
    return mark ? KIND_WORD[mark.kind] : '';
  }

  /** "1 of 3 · C5 · Brake later". */
  function headOf(steps, i) {
    const step = steps[i];
    if (!step) return '';
    return [`${i + 1} of ${steps.length}`, step.cornerId || '', titleOf(step)].filter(Boolean).join(' · ');
  }

  /**
   * The stepping, without a DOM: which step is on, and moving it. `go`
   * clamps (there is no wrapping round: the last step is the end of the
   * lesson, and coming back to the first by pressing "next" reads as a bug)
   * and says whether anything changed.
   */
  function core(steps) {
    const list = Array.isArray(steps) ? steps.filter((s) => s && typeof s === 'object') : [];
    let i = 0;
    return {
      steps: list,
      count: () => list.length,
      index: () => i,
      step: () => list[i] || null,
      go(k) {
        if (!list.length) return false;
        const to = Math.max(0, Math.min(list.length - 1, Math.round(Number(k) || 0)));
        if (to === i) return false;
        i = to;
        return true;
      },
      next() { return this.go(i + 1); },
      prev() { return this.go(i - 1); },
      atStart: () => i === 0,
      atEnd: () => i >= list.length - 1,
      head: () => headOf(list, i),
    };
  }

  /**
   * Mount a step-through in `el`. `onStep(step, i)` is called for the first
   * step straight away and for every move after; whatever it throws is kept
   * from breaking the bar. Returns `{ destroy(), go(i), index() }`.
   */
  function mount(el, opts) {
    const o = opts || {};
    const state = core(o.steps);
    const onStep = typeof o.onStep === 'function' ? o.onStep : null;
    const doc = el && el.ownerDocument ? el.ownerDocument : (typeof document !== 'undefined' ? document : null);
    let alive = true;

    if (!el) return { destroy() {}, go() {}, index: () => 0 };

    if (!state.count()) {
      el.innerHTML = `<div class="showme showme--empty">${esc(o.empty || 'Nothing to show on this lap.')}</div>`;
      return {
        destroy() { if (alive) { alive = false; el.innerHTML = ''; } },
        go() {},
        index: () => 0,
      };
    }

    const dots = state.steps.map((s, k) => `<button type="button" class="showme__dot" data-showme-go="${k}"
        aria-label="${esc(headOf(state.steps, k))}" title="${esc(headOf(state.steps, k))}"></button>`).join('');
    el.innerHTML = `
      <div class="showme" role="group" aria-label="Show me">
        <div class="showme__bar">
          <button type="button" class="showme__btn" data-showme="prev" aria-label="Previous step" title="Previous (←)">
            <span aria-hidden="true">&#8249;</span></button>
          <div class="showme__head" aria-live="polite">
            <b class="showme__count"></b><span class="showme__corner"></span><span class="showme__title"></span>
          </div>
          <button type="button" class="showme__btn" data-showme="next" aria-label="Next step" title="Next (→)">
            <span aria-hidden="true">&#8250;</span></button>
        </div>
        <p class="showme__text"></p>
        ${state.count() > 1 ? `<div class="showme__dots">${dots}</div>` : ''}
      </div>`;
    const root = el.querySelector('.showme');
    const q = (sel) => root.querySelector(sel);

    const paint = () => {
      const i = state.index();
      const step = state.step();
      q('.showme__count').textContent = `${i + 1} of ${state.count()}`;
      q('.showme__corner').textContent = step.cornerId || '';
      q('.showme__title').textContent = titleOf(step);
      q('.showme__text').textContent = step.text || '';
      q('[data-showme="prev"]').disabled = state.atStart();
      q('[data-showme="next"]').disabled = state.atEnd();
      for (const d of root.querySelectorAll('[data-showme-go]')) {
        d.setAttribute('data-on', String(Number(d.dataset.showmeGo) === i));
      }
      if (onStep) {
        try { onStep(step, i); } catch (err) {
          if (typeof console !== 'undefined') console.error('[showme] onStep failed:', err && err.message);
        }
      }
    };

    const go = (k) => {
      if (!alive) return;
      if (state.go(k)) paint();
    };

    const onClick = (evt) => {
      const t = evt.target;
      if (!t || !t.closest) return;
      const btn = t.closest('[data-showme]');
      if (btn) {
        go(state.index() + (btn.dataset.showme === 'next' ? 1 : -1));
        return;
      }
      const dot = t.closest('[data-showme-go]');
      if (dot) go(Number(dot.dataset.showmeGo));
    };

    const onKey = (evt) => {
      if (evt.key !== 'ArrowLeft' && evt.key !== 'ArrowRight') return;
      if (evt.defaultPrevented || evt.altKey || evt.ctrlKey || evt.metaKey || evt.shiftKey) return;
      if (!root.isConnected) return;
      // Hidden (its tab is not the one on screen): not ours to answer.
      if (typeof root.getClientRects === 'function' && root.getClientRects().length === 0) return;
      const t = evt.target;
      if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
      evt.preventDefault();
      go(state.index() + (evt.key === 'ArrowRight' ? 1 : -1));
    };

    root.addEventListener('click', onClick);
    if (doc) doc.addEventListener('keydown', onKey);

    // The first step, now: the host draws it from onStep like any other.
    const start = Math.max(0, Math.min(state.count() - 1, Math.round(Number(o.start) || 0)));
    state.go(start);
    paint();

    return {
      destroy() {
        if (!alive) return;
        alive = false;
        root.removeEventListener('click', onClick);
        if (doc) doc.removeEventListener('keydown', onKey);
        el.innerHTML = '';
      },
      go,
      index: () => state.index(),
    };
  }

  return { mount, core, titleOf, headOf };
});
