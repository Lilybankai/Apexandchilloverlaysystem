/**
 * electron/racelog-outlines.js — circuit outlines for the Race log tab.
 * -----------------------------------------------------------------------------
 * Each race card and race header draws its circuit, the way the Schedule tab's
 * cards do. The Schedule asks the running game for the geometry
 * (electron/lmu-trackmaps.js), but most races are read with the game shut, so
 * the outlines come from the circuits bundled with the app instead:
 * `data/trackmaps/`, the same shapes the in-game track map starts from.
 *
 * ## Which bundled circuit a race was on
 * A results file names its circuit (`<TrackCourse>`) and gives its length
 * (`<TrackLength>`). The bundle's keys are a slug plus the length rounded to
 * ten metres, but the names do not always agree (the results file says
 * `Silverstone Grand Prix Circuit - ELMS`, the bundle `... - WEC`; the bundle
 * mangled `Autódromo` into `aut-dromo`). So a match is a circuit within 1% of
 * the length whose name shares the most words, the nearer length breaking a
 * tie. With no length (a provisional race the game never saved), the name
 * alone, and only when most of its words agree.
 *
 * The path is drawn by lmu-trackmaps.js's `outlineOf`, so a race card and a
 * schedule card draw a circuit identically. Each outline is a kilobyte and is
 * remembered for the life of the process.
 *
 * `matchKey` is pure and unit-tested by scripts/test-racelog-outlines.js.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { outlineOf } = require('./lmu-trackmaps');

/** How far a bundled circuit's length may be from the file's, as a fraction. */
const LENGTH_SLACK = 0.01;

/** With no length to go on, the share of words that must agree. */
const NAME_ONLY_MIN = 0.75;

function words(s) {
  return new Set(
    String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

/** Shared words over all words: 1 for the same name, 0 for nothing in common. */
function likeness(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

/**
 * The bundled circuit a race was on: its key, or null.
 * `maps` is `data/trackmaps/index.json`'s `maps`.
 */
function matchKey(maps, track, lengthM) {
  if (!Array.isArray(maps) || !track) return null;
  const len = Number(lengthM);
  let best = null;
  for (const m of maps) {
    if (!m || !m.key) continue;
    const like = Math.max(likeness(track, m.name), likeness(track, m.config));
    let off = Infinity;
    if (len > 0) {
      off = Math.abs(Number(m.lengthM) - len) / len;
      if (!(off <= LENGTH_SLACK) || like === 0) continue;
    } else if (like < NAME_ONLY_MIN) {
      continue;
    }
    if (!best || like > best.like || (like === best.like && off < best.off)) best = { key: m.key, like, off };
  }
  return best ? best.key : null;
}

/* -------------------------------------------------------------------------- */
/*  The bundle                                                                */
/* -------------------------------------------------------------------------- */

let dir;
let index;
const outlines = new Map();

function bundleDir() {
  if (dir !== undefined) return dir;
  dir = null;
  const candidates = [
    path.join(__dirname, '..', 'data', 'trackmaps'),
    ...(process.resourcesPath ? [path.join(process.resourcesPath, 'data', 'trackmaps')] : []),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(path.join(c, 'index.json')).isFile()) {
        dir = c;
        break;
      }
    } catch {
      /* next */
    }
  }
  return dir;
}

function maps() {
  if (index !== undefined) return index;
  index = [];
  const d = bundleDir();
  if (!d) return index;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(d, 'index.json'), 'utf8'));
    if (parsed && Array.isArray(parsed.maps)) index = parsed.maps;
  } catch {
    /* no bundle: no outlines, and the cards draw without them */
  }
  return index;
}

/** `{ d, view }` for a bundled circuit, or null. */
function outlineForKey(key) {
  if (!key) return null;
  if (outlines.has(key)) return outlines.get(key);
  let out = null;
  const d = bundleDir();
  // Keys are the bundle's own file names; never a path from anywhere else.
  if (d && /^[a-z0-9-]+$/.test(key)) {
    try {
      const map = JSON.parse(fs.readFileSync(path.join(d, `${key}.json`), 'utf8'));
      const pts = Array.isArray(map.points) ? map.points : [];
      // The bundle stores `[x, z, y]`; outlineOf wants the game's `{ x, z }`.
      const o = outlineOf(pts.map((p) => ({ type: 0, x: p[0], z: p[1] })));
      if (o) out = { d: o.d, view: o.view };
    } catch {
      out = null;
    }
  }
  outlines.set(key, out);
  return out;
}

/**
 * The race list with a `mapKey` on each race, and every outline they name:
 * `{ races, outlines: { [key]: { d, view } } }`. One copy of each circuit
 * however many races were driven on it.
 */
function decorateList(races) {
  const all = maps();
  const out = {};
  const list = (Array.isArray(races) ? races : []).map((r) => {
    const key = matchKey(all, r.track, r.trackLength);
    if (key && !(key in out)) out[key] = outlineForKey(key);
    return key && out[key] ? { ...r, mapKey: key } : r;
  });
  return { races: list, outlines: out };
}

/** One race's log with its circuit's `outline`, when there is one. */
function decorateLog(log) {
  if (!log) return log;
  const outline = outlineForKey(matchKey(maps(), log.track, log.trackLength));
  return outline ? { ...log, outline } : log;
}

module.exports = { matchKey, likeness, decorateList, decorateLog, LENGTH_SLACK };
