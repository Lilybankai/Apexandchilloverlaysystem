/**
 * fair-chips.js — "is this a fair lap to chase?" as pills on a board row.
 * -----------------------------------------------------------------------------
 * 2026-10-29 (AI driving coach, "fair" piece). A board lap 1.2 s quicker than
 * yours may be a qualifying lap on ten litres, on a cooler track, in another
 * car. The rules are in `src/telemetry/fairTarget.ts` and run in the main
 * process (`review:fairChips`, electron/fair-ipc.js) against the session's
 * own best lap as the lap log recorded it; this file only asks and draws.
 *
 *   FairChips.sync(sessionId, rows, onChange) → { html(row) }
 *     For a surface that renders a board from template strings (Review's
 *     board card). Asks once per (session, rows array) and calls `onChange`
 *     when the answer lands, so the caller can repaint; `html(row)` is the
 *     row's pills, '' until then — or for good when the call is missing or
 *     fails (signed out, no valid lap): the board reads as it always did.
 *     `rowHtml(row, cols)` is the same pills as a table row of their own to
 *     go under the driver's row (the driver column alone is too narrow to
 *     read a pill in), '' when there are none.
 *
 *   FairChips.chipsHtml(flags, { pick }) → string
 *     The pills alone, for any surface that already holds the flags (the
 *     Practice tab gets them from `practiceTargets`). Escaped here.
 *
 * Severity → look: `drop` red ("not picked automatically"), `warn` amber,
 * `info` muted. "fair pick" marks the lap `pickFairTarget` would chase.
 *
 * Loaded as a classic script by the panel (window.FairChips) and require()d
 * by scripts/test-fairipc.js — the pure half needs no DOM.
 */

(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FairChips = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
  'use strict';

  const ORDER = { drop: 0, warn: 1, info: 2 };
  /** Pills shown per row; the rest are in the title of the last one. */
  const MAX_PILLS = 3;

  /** The board-row fields the assessment reads — nothing else crosses the bridge. */
  const FIELDS = [
    'driver_id', 'display_name', 'car', 'lap_ms', 'is_you', 'has_trace', 'has_line', 'condition',
    'session_type', 'track_temp_c', 'air_temp_c', 'fuel_start_l', 'fuel_capacity_l', 've_start_pct', 'compound',
  ];

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Flags, worst first, as pills. `opts.pick` adds the "fair pick" pill. */
  function chipsHtml(flags, opts) {
    const list = (Array.isArray(flags) ? flags : [])
      .filter((f) => f && typeof f.text === 'string' && ORDER[f.severity] !== undefined)
      .slice()
      .sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
    const pills = [];
    if (opts && opts.pick) {
      pills.push('<span class="fairchip" data-sev="pick" title="The fairest quicker lap to chase">fair pick</span>');
    }
    const shown = list.slice(0, MAX_PILLS);
    const rest = list.slice(MAX_PILLS);
    shown.forEach((f, i) => {
      const extra = i === shown.length - 1 && rest.length ? ` · ${rest.map((r) => r.text).join(' · ')}` : '';
      const title = f.severity === 'drop' ? `${f.text} — not picked automatically${extra}` : `${f.text}${extra}`;
      pills.push(`<span class="fairchip" data-sev="${esc(f.severity)}" data-kind="${esc(f.kind)}" title="${esc(title)}">${esc(
        f.text,
      )}${i === shown.length - 1 && rest.length ? ` +${rest.length}` : ''}</span>`);
    });
    return pills.length ? `<span class="fairchips">${pills.join('')}</span>` : '';
  }

  /** Board rows trimmed to what the assessment reads. */
  function slimRows(rows) {
    return (Array.isArray(rows) ? rows : []).map((r) => {
      const o = {};
      if (!r || typeof r !== 'object') return o;
      for (const k of FIELDS) if (r[k] !== undefined) o[k] = r[k];
      return o;
    });
  }

  /** What has been asked, and the answer: one board at a time is all a panel shows. */
  let state = { sessionId: '', rows: null, chips: null, pick: null };

  function apexCall() {
    const apex = root && root.apex;
    return apex && typeof apex.reviewFairChips === 'function' ? apex.reviewFairChips : null;
  }

  function sync(sessionId, rows, onChange) {
    const call = apexCall();
    const none = { html: () => '', rowHtml: () => '' };
    if (!call || !sessionId || !Array.isArray(rows) || !rows.length) return none;
    if (state.sessionId !== sessionId || state.rows !== rows) {
      const asked = { sessionId, rows, chips: null, pick: null };
      state = asked;
      Promise.resolve()
        .then(() => call({ sessionId, rows: slimRows(rows) }))
        .then((res) => {
          if (state !== asked) return;
          if (res && res.ok && res.chips && typeof res.chips === 'object') {
            asked.chips = res.chips;
            asked.pick = typeof res.pick === 'string' ? res.pick : null;
            if (typeof onChange === 'function') onChange();
          }
        })
        .catch(() => {
          /* no chips is the board as it always was */
        });
    }
    const cur = state;
    const html = (row) => {
      if (!cur.chips || !row || typeof row.driver_id !== 'string') return '';
      return chipsHtml(cur.chips[row.driver_id], { pick: cur.pick === row.driver_id });
    };
    return {
      html,
      rowHtml(row, cols) {
        const pills = html(row);
        if (!pills) return '';
        const n = Math.max(2, Number(cols) || 2);
        return `<tr class="fairrow"><td></td><td colspan="${n - 1}">${pills}</td></tr>`;
      },
    };
  }

  return { sync, chipsHtml, slimRows, esc, MAX_PILLS };
});
