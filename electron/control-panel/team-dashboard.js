/**
 * team-dashboard.js — the Team page's widget grid.
 * -----------------------------------------------------------------------------
 * The pit wall is one screen, not four tabs: every widget is on the board at
 * once and the engineer arranges it the way their race wants it. This file is
 * the layout engine behind that — a 12-column grid where a widget is dragged
 * by its title bar, resized from its bottom-right corner, and everything else
 * gets out of the way.
 *
 * The maths is the react-grid-layout model, in ~200 lines of vanilla JS
 * (nothing external can load here — the panel's CSP is `default-src 'none'`):
 *
 *   • a layout is `{id, x, y, w, h, on}` in grid cells, never pixels;
 *   • moving an item pushes whatever it lands on DOWN (recursively), then the
 *     whole board compacts upward so there is never a hole — the "no dead
 *     space" rule the tabs were breaking;
 *   • every pointermove resolves from a CLONE of the layout as it stood when
 *     the drag began, so a slow drag across the board can't accumulate drift.
 *
 * Items are absolutely positioned rather than placed with `grid-area`, because
 * CSS cannot transition grid placement: absolute left/top/width/height means
 * the cards that get pushed out of the way glide instead of teleporting.
 * Widths come from the container, remeasured by a ResizeObserver, so the board
 * reflows with the window and the canvases (which size themselves from their
 * CSS box on every repaint) follow for free.
 *
 * Below `NARROW` px the board gives up and stacks in layout order — a grid
 * that fine cannot be read, let alone dragged, on a narrow panel.
 *
 * The engine knows nothing about telemetry. It is handed a catalogue of
 * widget elements by team-panel.js, and calls back when the set of VISIBLE
 * widgets changes so the page can skip rendering anything that is off the
 * board or off-screen.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_TEAM_DASH = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const COLS = 12;
  const ROW = 26;     // px per grid row
  const GAP = 12;     // px between cells
  const NARROW = 820; // below this the board stacks

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /** Do two placed items overlap? */
  function hits(a, b) {
    return a !== b
      && a.x < b.x + b.w && a.x + a.w > b.x
      && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  /** Reading order: top to bottom, then left to right. */
  const byRowCol = (items) => items.slice().sort((p, q) => (p.y - q.y) || (p.x - q.x));

  const cloneItems = (items) => items.map((i) => ({ ...i }));

  /**
   * Move `it` to (x, y) and push anything it lands on straight down, which may
   * cascade. `moved` guards against an item being shoved twice in one pass.
   */
  function moveTo(items, it, x, y) {
    it.x = x;
    it.y = Math.max(0, y);
    it.moved = true;
    for (const other of byRowCol(items)) {
      if (other === it || other.moved) continue;
      if (!hits(it, other)) continue;
      moveTo(items, other, other.x, it.y + it.h);
    }
  }

  /** Pull every item as far up as it will go — the board never holds a hole. */
  function compact(items) {
    const placed = [];
    for (const it of byRowCol(items)) {
      let y = it.y;
      while (y > 0) {
        const probe = { x: it.x, y: y - 1, w: it.w, h: it.h };
        if (placed.some((p) => hits(probe, p))) break;
        y -= 1;
      }
      it.y = y;
      placed.push(it);
    }
    return items;
  }

  /** One settle pass: resolve `id`'s new box against the board, then compact. */
  function settle(items, id) {
    const it = items.find((i) => i.id === id);
    if (!it) return items;
    for (const i of items) i.moved = false;
    moveTo(items, it, it.x, it.y);
    compact(items);
    for (const i of items) delete i.moved;
    return items;
  }

  /** Drop a brand-new item on the first row that has room for it. */
  function placeFree(items, it) {
    for (let y = 0; y < 400; y++) {
      for (let x = 0; x <= COLS - it.w; x++) {
        const probe = { x, y, w: it.w, h: it.h };
        if (!items.some((p) => hits(probe, p))) { it.x = x; it.y = y; return it; }
      }
    }
    it.x = 0;
    it.y = items.reduce((m, p) => Math.max(m, p.y + p.h), 0);
    return it;
  }

  /**
   * Build a live board.
   *
   * @param {object} opts
   * @param {HTMLElement} opts.grid       the positioning container
   * @param {Array} opts.catalog          [{id, el, min:{w,h}}] — elements already in the DOM
   * @param {object} opts.presets         name -> {id: {x,y,w,h,on}}
   * @param {function} opts.onLayout      called (visibleIds) whenever the board settles
   * @param {function} opts.onSave        called (layoutArray, preset) to persist
   */
  function create(opts) {
    const grid = opts.grid;
    const catalog = opts.catalog || [];
    const presets = opts.presets || {};
    const onLayout = opts.onLayout || (() => { });
    const onSave = opts.onSave || (() => { });
    const byId = new Map(catalog.map((c) => [c.id, c]));

    let items = [];        // the live layout
    let preset = null;     // name of the preset last applied, if untouched since
    let narrow = false;
    let drag = null;       // {id, mode, base, startX, startY, cellW, el, ph}
    let raf = 0;

    const minOf = (id) => (byId.get(id) && byId.get(id).min) || { w: 2, h: 3 };
    const elOf = (id) => (byId.get(id) ? byId.get(id).el : null);
    const live = () => items.filter((i) => i.on);

    // ── Layout in / out ────────────────────────────────────────────────────
    function fromPreset(name) {
      const src = presets[name] || presets[Object.keys(presets)[0]];
      return catalog.map((c) => {
        const p = src[c.id] || { x: 0, y: 999, w: 4, h: 6, on: false };
        return { id: c.id, x: p.x, y: p.y, w: p.w, h: p.h, on: p.on !== false };
      });
    }

    /** Accept a saved array, healing anything the catalogue no longer knows. */
    function adopt(saved, presetName) {
      const fallback = fromPreset(presetName || 'engineer');
      if (!Array.isArray(saved) || !saved.length) {
        items = fallback;
      } else {
        const seen = new Map(saved.filter((s) => s && byId.has(s.id)).map((s) => [s.id, s]));
        items = catalog.map((c) => {
          const s = seen.get(c.id);
          const d = fallback.find((f) => f.id === c.id);
          if (!s) return { ...d, on: false }; // a widget added since the save: off, not shoved in
          const min = minOf(c.id);
          const w = clamp(Math.round(s.w) || d.w, min.w, COLS);
          return {
            id: c.id,
            w,
            h: Math.max(min.h, Math.round(s.h) || d.h),
            x: clamp(Math.round(s.x) || 0, 0, COLS - w),
            y: Math.max(0, Math.round(s.y) || 0),
            on: s.on !== false,
          };
        });
      }
      preset = presetName || null;
      compact(live());
      apply();
    }

    function usePreset(name) {
      items = fromPreset(name);
      preset = name;
      compact(live());
      apply();
      save();
    }

    const save = () => onSave(items.map((i) => ({ ...i })), preset);

    // ── Painting ───────────────────────────────────────────────────────────
    function cellW() {
      const w = grid.clientWidth || 1200;
      return (w - GAP * (COLS - 1)) / COLS;
    }

    function apply() {
      narrow = (grid.clientWidth || 1200) < NARROW;
      grid.setAttribute('data-narrow', String(narrow));

      for (const c of catalog) {
        const it = items.find((i) => i.id === c.id);
        c.el.hidden = !it || !it.on;
      }

      if (narrow) {
        // Stacked: layout order decides the reading order, heights are natural.
        for (const it of byRowCol(live())) {
          const el = elOf(it.id);
          if (!el) continue;
          el.style.cssText = '';
          el.style.order = String(it.y * COLS + it.x);
        }
        grid.style.height = '';
      } else {
        const cw = cellW();
        let bottom = 0;
        for (const it of live()) {
          const el = elOf(it.id);
          if (!el) continue;
          el.style.order = '';
          el.style.left = `${Math.round(it.x * (cw + GAP))}px`;
          el.style.top = `${it.y * (ROW + GAP)}px`;
          el.style.width = `${Math.round(it.w * cw + (it.w - 1) * GAP)}px`;
          el.style.height = `${it.h * ROW + (it.h - 1) * GAP}px`;
          bottom = Math.max(bottom, it.y + it.h);
        }
        grid.style.height = `${Math.max(0, bottom * (ROW + GAP) - GAP)}px`;
      }
      onLayout(live().map((i) => i.id));
    }

    /** Coalesce the repaints a drag generates into one per frame. */
    function schedule() {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; apply(); });
    }

    // ── Drag + resize ──────────────────────────────────────────────────────
    function begin(e, mode, id) {
      if (narrow || drag) return;
      const el = elOf(id);
      const it = items.find((i) => i.id === id);
      if (!el || !it || !it.on) return;

      drag = {
        id, mode, el,
        base: cloneItems(items),
        startX: e.clientX, startY: e.clientY,
        cw: cellW(),
        ox: it.x, oy: it.y, ow: it.w, oh: it.h,
        ph: document.createElement('div'),
      };
      drag.ph.className = 'tw-ghost';
      grid.appendChild(drag.ph);
      grid.setAttribute('data-live', mode);
      el.setAttribute('data-live', mode);
      el.setAttribute('aria-grabbed', 'true');
      try { el.setPointerCapture(e.pointerId); } catch { /* mouse fallback */ }
      e.preventDefault();
      step(e);
    }

    function step(e) {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      const stepX = drag.cw + GAP;
      const stepY = ROW + GAP;
      const min = minOf(drag.id);

      const next = cloneItems(drag.base);
      const it = next.find((i) => i.id === drag.id);

      if (drag.mode === 'move') {
        it.x = clamp(drag.ox + Math.round(dx / stepX), 0, COLS - it.w);
        it.y = Math.max(0, drag.oy + Math.round(dy / stepY));
        drag.el.style.transform = `translate(${dx}px, ${dy}px)`;
      } else {
        it.w = clamp(drag.ow + Math.round(dx / stepX), min.w, COLS - it.x);
        it.h = Math.max(min.h, drag.oh + Math.round(dy / stepY));
      }

      items = next;
      // Only the live board settles; a widget that is off the board keeps the
      // box it had, ready for the day it is switched back on.
      settle(items.filter((i) => i.on), drag.id);

      const ghost = items.find((i) => i.id === drag.id);
      const cw = drag.cw;
      Object.assign(drag.ph.style, {
        left: `${Math.round(ghost.x * (cw + GAP))}px`,
        top: `${ghost.y * (ROW + GAP)}px`,
        width: `${Math.round(ghost.w * cw + (ghost.w - 1) * GAP)}px`,
        height: `${ghost.h * ROW + (ghost.h - 1) * GAP}px`,
      });
      schedule();
    }

    function end() {
      if (!drag) return;
      const { el, ph } = drag;
      el.style.transform = '';
      el.removeAttribute('data-live');
      el.setAttribute('aria-grabbed', 'false');
      grid.removeAttribute('data-live');
      if (ph.parentNode) ph.parentNode.removeChild(ph);
      preset = null; // the board is the driver's now, not a preset's
      drag = null;
      apply();
      save();
    }

    // ── Wiring ─────────────────────────────────────────────────────────────
    function onPointerDown(e) {
      if (e.button !== 0) return;
      const handle = e.target.closest('[data-twmove]');
      if (handle && !e.target.closest('button, input, select, a')) {
        begin(e, 'move', handle.closest('[data-widget]').dataset.widget);
        return;
      }
      const grip = e.target.closest('[data-twresize]');
      if (grip) begin(e, 'size', grip.closest('[data-widget]').dataset.widget);
    }

    /** Arrow keys nudge a focused title bar — a board that needs a mouse
     *  is a board half the pit wall cannot rearrange. */
    function onKeyDown(e) {
      const bar = e.target.closest('[data-twmove]');
      if (!bar || narrow) return;
      const id = bar.closest('[data-widget]').dataset.widget;
      const it = items.find((i) => i.id === id);
      if (!it || !it.on) return;
      const shift = e.shiftKey;
      const min = minOf(id);
      let dx = 0; let dy = 0;
      if (e.key === 'ArrowLeft') dx = -1;
      else if (e.key === 'ArrowRight') dx = 1;
      else if (e.key === 'ArrowUp') dy = -1;
      else if (e.key === 'ArrowDown') dy = 1;
      else return;
      e.preventDefault();
      if (shift) {          // Shift = resize
        it.w = clamp(it.w + dx, min.w, COLS - it.x);
        it.h = Math.max(min.h, it.h + dy);
      } else {
        it.x = clamp(it.x + dx, 0, COLS - it.w);
        it.y = Math.max(0, it.y + dy);
      }
      settle(live(), id);
      preset = null;
      apply();
      save();
    }

    grid.addEventListener('pointerdown', onPointerDown);
    grid.addEventListener('pointermove', step);
    grid.addEventListener('pointerup', end);
    grid.addEventListener('pointercancel', end);
    grid.addEventListener('keydown', onKeyDown);

    let ro = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => { if (!drag) schedule(); });
      ro.observe(grid);
    } else {
      window.addEventListener('resize', schedule);
    }

    return {
      adopt,
      usePreset,
      apply,
      presetName: () => preset,
      /** Which widgets are actually on the board right now. */
      visible: () => live().map((i) => i.id),
      isOn: (id) => { const it = items.find((i) => i.id === id); return !!(it && it.on); },
      /** Add or remove a widget. Adding drops it on the first free row. */
      setOn(id, on) {
        const it = items.find((i) => i.id === id);
        if (!it || it.on === !!on) return;
        it.on = !!on;
        if (it.on) placeFree(live().filter((i) => i !== it), it);
        compact(live());
        preset = null;
        apply();
        save();
      },
      destroy() {
        if (ro) ro.disconnect();
        grid.removeEventListener('pointerdown', onPointerDown);
        grid.removeEventListener('pointermove', step);
        grid.removeEventListener('pointerup', end);
        grid.removeEventListener('pointercancel', end);
        grid.removeEventListener('keydown', onKeyDown);
      },
    };
  }

  return { create, COLS, ROW, GAP, NARROW, hits, compact, moveTo, settle, placeFree };
});
