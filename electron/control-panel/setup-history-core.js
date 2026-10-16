/**
 * setup-history-core.js — the pure half of the Setups tab's History.
 * -----------------------------------------------------------------------------
 * Every version of a car's setup at a track is kept as a SNAPSHOT — the step
 * index of every setup key, plus the sim's own wording for it — with the diff
 * from the version before. This file holds everything about those snapshots
 * that needs no disk, no clock and no Electron: building one from LMU's garage
 * payload, diffing two, capping a list, grouping it by day, summarising a diff
 * in a line, and working out what a restore has to write.
 *
 * Shared by both sides: main's recorder (electron/setupHistory.js) requires it,
 * and the panel loads it as a classic script so a restore is planned against
 * the same rules that recorded the version. scripts/test-setup-history.js pins
 * it down against the GT3 garage fixture.
 *
 * What is NOT a setup change: fuel, virtual energy and the pit-stop plan. A
 * driver refuels for every stint; a history that logged each of those would
 * bury the real changes, and a restore that put back last Tuesday's fuel load
 * would be a trap. Those keys never enter a snapshot, so they can never be
 * diffed or restored. (The lap fingerprint, setupFingerprint.ts, also drops
 * brake bias and mixture — deliberately NOT done here: in the garage those are
 * genuine setup choices the race engineer's macros write, and the endpoint is
 * frozen at garage values, so in-car thumb-wheel changes never reach us.)
 *
 * Classic script (window.APEX_SETUP_HISTORY) + module.exports for main/tests.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_SETUP_HISTORY = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** Versions kept per car + track; the oldest falls off first. */
  const CAP = 100;

  /** Per-stint keys that are strategy, not setup — see the file header. */
  const EXCLUDED = /^(VM_FUEL_LEVEL|VM_VIRTUAL_ENERGY|VM_NUM_PITSTOPS|VM_PITSTOP_\d+)$/;

  /** Only the garage's setting keys are tracked (not `symmetric`/`gearGraph`). */
  const SETTING_KEY = /^(VM_|WM_)/;

  /** Who made a version. Order is the order the UI explains them in. */
  const SOURCES = {
    session: 'Session start',
    editor: 'Editor',
    engineer: 'Race engineer',
    library: 'Library tune',
    game: 'Changed in LMU',
    restore: 'Restore',
  };

  function isTracked(key) {
    return typeof key === 'string' && SETTING_KEY.test(key) && !EXCLUDED.test(key);
  }

  const emptySnapshot = () => ({ values: {}, strings: {} });

  /**
   * Snapshot from the raw `getPlayerGarageData` payload. A setting row is
   * `{ value, maxValue, stringValue, available, ... }` (setupState.ts's shape
   * test); anything else — and any key the car does not have — is skipped.
   */
  function snapshotFromGarage(raw) {
    const snap = emptySnapshot();
    if (!raw || typeof raw !== 'object') return snap;
    for (const key of Object.keys(raw)) {
      if (!isTracked(key)) continue;
      const r = raw[key];
      if (!r || typeof r.value !== 'number' || typeof r.maxValue !== 'number') continue;
      if (r.available === false || !Number.isFinite(r.value)) continue;
      snap.values[key] = r.value;
      snap.strings[key] = typeof r.stringValue === 'string' ? r.stringValue : '';
    }
    return snap;
  }

  /** Snapshot from projected settings (setupState's `SetupSetting[]`). */
  function snapshotFromSettings(settings) {
    const snap = emptySnapshot();
    if (!Array.isArray(settings)) return snap;
    for (const s of settings) {
      if (!s || !isTracked(s.key) || s.available === false) continue;
      if (typeof s.value !== 'number' || !Number.isFinite(s.value)) continue;
      snap.values[s.key] = s.value;
      snap.strings[s.key] = typeof s.stringValue === 'string' ? s.stringValue : '';
    }
    return snap;
  }

  function cloneSnapshot(snap) {
    return { values: { ...(snap && snap.values) }, strings: { ...(snap && snap.strings) } };
  }

  /**
   * What changed from `a` to `b`, in `b`'s key order (the sim's own order).
   * Only keys present in BOTH count: a key appearing or vanishing without a
   * car change is the sim's business, not a setup edit, and a car change is a
   * different history altogether.
   */
  function diffSnapshots(a, b) {
    const out = [];
    if (!a || !b) return out;
    const av = a.values || {};
    const bv = b.values || {};
    for (const key of Object.keys(bv)) {
      if (!isTracked(key) || !(key in av)) continue;
      if (av[key] === bv[key]) continue;
      out.push({
        key,
        from: av[key],
        to: bv[key],
        fromStr: (a.strings && a.strings[key]) || '',
        toStr: (b.strings && b.strings[key]) || '',
      });
    }
    return out;
  }

  function sameSnapshot(a, b) {
    return diffSnapshots(a, b).length === 0 && diffSnapshots(b, a).length === 0;
  }

  /** Layer some writes (`{key, value, str?}`) onto a snapshot, returning a copy. */
  function applyWrites(snap, writes) {
    const next = cloneSnapshot(snap);
    for (const w of writes || []) {
      if (!w || !isTracked(w.key) || typeof w.value !== 'number') continue;
      next.values[w.key] = w.value;
      if (typeof w.str === 'string') next.strings[w.key] = w.str;
      else if (!(w.key in next.strings)) next.strings[w.key] = '';
    }
    return next;
  }

  /** Oldest-first list, trimmed to the newest `cap`. Returns a new array. */
  function capEntries(entries, cap) {
    const list = Array.isArray(entries) ? entries : [];
    const n = Number.isFinite(cap) && cap > 0 ? cap : CAP;
    return list.length > n ? list.slice(list.length - n) : list.slice();
  }

  /**
   * What a restore has to write to take the CURRENT car to `values`.
   *
   * `current` is the live setup: a Map or a plain object of key → projected
   * setting (`{value, min, max, isFree, available}`), or an array of them.
   * A key the car does not have, or the ruleset locks, or whose old index no
   * longer fits the car's range, is SKIPPED with a reason — never clamped,
   * because a clamped value is not the version the driver asked for. Keys the
   * car has that the snapshot lacks are left alone.
   */
  function restorePlan(values, current) {
    const writes = [];
    const skipped = [];
    let unchanged = 0;
    const get = toLookup(current);
    for (const key of Object.keys(values || {})) {
      if (!isTracked(key)) continue;
      const target = values[key];
      if (typeof target !== 'number' || !Number.isFinite(target)) continue;
      const s = get(key);
      if (!s || s.available === false) {
        skipped.push({ key, reason: 'not on this car' });
        continue;
      }
      if (s.value === target) {
        unchanged += 1;
        continue;
      }
      if (s.isFree === false) {
        skipped.push({ key, reason: 'fixed by ruleset' });
        continue;
      }
      const min = typeof s.min === 'number' ? s.min : 0;
      const max = typeof s.max === 'number' ? s.max : min;
      if (min >= max) {
        skipped.push({ key, reason: 'not adjustable' });
        continue;
      }
      if (target < min || target > max) {
        skipped.push({ key, reason: 'out of range on this car' });
        continue;
      }
      writes.push({ key, value: target });
    }
    return { writes, skipped, unchanged };
  }

  function toLookup(current) {
    if (!current) return () => null;
    if (typeof current.get === 'function') return (k) => current.get(k) || null;
    if (Array.isArray(current)) {
      const m = new Map();
      for (const s of current) if (s && s.key) m.set(s.key, s);
      return (k) => m.get(k) || null;
    }
    return (k) => current[k] || null;
  }

  /**
   * One line for a list row: "4 changes: Rear wing 5 → 6, Front ARB 3 → 4, …".
   * `labelFor(key)` names a key; the values are the sim's own wording when the
   * snapshot has it, the step index when it does not.
   */
  function summarise(changes, labelFor, max) {
    const list = Array.isArray(changes) ? changes : [];
    if (list.length === 0) return 'No changes';
    const name = typeof labelFor === 'function' ? labelFor : (k) => k;
    const shown = list.slice(0, Number.isFinite(max) ? max : 3).map(
      (c) => `${name(c.key)} ${c.fromStr || c.from} → ${c.toStr || c.to}`,
    );
    const more = list.length - shown.length;
    const head = `${list.length} change${list.length === 1 ? '' : 's'}: `;
    return head + shown.join(', ') + (more > 0 ? `, +${more} more` : '');
  }

  function dayKey(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /**
   * Newest-first entries grouped by local calendar day, each group labelled
   * Today / Yesterday / the date. `now` is injected so tests are clock-free.
   */
  function groupByDay(entries, now) {
    const groups = [];
    const today = dayKey(now);
    const yesterday = dayKey(now - 86400000);
    let cur = null;
    for (const e of entries || []) {
      const k = dayKey(e.at);
      if (!cur || cur.day !== k) {
        const label =
          k === today ? 'Today' : k === yesterday ? 'Yesterday' : new Date(e.at).toLocaleDateString();
        cur = { day: k, label, entries: [] };
        groups.push(cur);
      }
      cur.entries.push(e);
    }
    return groups;
  }

  /**
   * A history file, read back and checked. Returns null when it is not one
   * (the caller keeps it as .bak and starts fresh) — never throws. Entries
   * that are individually malformed are dropped; one bad row must not cost the
   * driver the other ninety-nine.
   */
  function validateFile(obj) {
    if (!obj || typeof obj !== 'object' || obj.v !== 1 || !Array.isArray(obj.entries)) return null;
    const entries = [];
    for (const e of obj.entries) {
      if (!e || typeof e.id !== 'string' || typeof e.at !== 'number') continue;
      if (!e.values || typeof e.values !== 'object') continue;
      entries.push({
        id: e.id,
        at: e.at,
        source: SOURCES[e.source] ? e.source : 'game',
        ...(typeof e.label === 'string' && e.label ? { label: e.label } : {}),
        values: e.values,
        strings: e.strings && typeof e.strings === 'object' ? e.strings : {},
        changes: Array.isArray(e.changes) ? e.changes : [],
      });
    }
    entries.sort((a, b) => a.at - b.at);
    return {
      v: 1,
      car: typeof obj.car === 'string' ? obj.car : '',
      trackFolder: typeof obj.trackFolder === 'string' ? obj.trackFolder : '',
      trackName: typeof obj.trackName === 'string' ? obj.trackName : '',
      carClass: typeof obj.carClass === 'string' ? obj.carClass : '',
      entries: capEntries(entries, CAP),
    };
  }

  /** The car + track identity a history is filed under. '' when either is unknown. */
  function keyId(car, trackFolder) {
    const c = String(car || '').trim();
    const t = String(trackFolder || '').trim();
    return c && t ? `${c}|${t}` : '';
  }

  return {
    CAP,
    SOURCES,
    isTracked,
    snapshotFromGarage,
    snapshotFromSettings,
    cloneSnapshot,
    diffSnapshots,
    sameSnapshot,
    applyWrites,
    capEntries,
    restorePlan,
    summarise,
    groupByDay,
    validateFile,
    keyId,
  };
});
