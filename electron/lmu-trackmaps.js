/**
 * electron/lmu-trackmaps.js — circuit outlines for the Schedule tab's cards.
 * -----------------------------------------------------------------------------
 * The game's own daily-race cards draw the circuit behind the name, and a card
 * without one is a paragraph. The obvious source is the artwork RaceOS serves
 * alongside the calendar (`cardimage`, `heroimage`) — but those live on S3, and
 * the panel's CSP allows images from itself, `data:` and SimGrid's CDN only.
 * Widening a security policy for decoration is a bad trade.
 *
 * So the outline is DRAWN, from geometry the running game already hands out on
 * localhost: `GET /rest/race/track` lists every installed circuit with a
 * `sceneDesc`, and `GET /rest/race/track/{id}/trackmap` returns its points.
 * That becomes an SVG path the renderer inlines — no remote request, no CSP
 * change, and it is the same shape the game itself draws.
 *
 * ## What the trackmap payload is
 * A flat array of `{ type, x, y, z }`. Verified live 2026-09-17 against Portimao
 * (1424 points):
 *
 *   type 0  — the circuit, in lap order, closing on itself (927 points, 4577 m
 *             of centreline against a stated 4653 m). This is the outline.
 *   type 1  — the pit lane (205 points).
 *   type ≥2 — grid and garage slots, exactly two points each.
 *
 * `y` is elevation and is dropped: these cards are plan views. `z` is negated so
 * the shape reads the way a map does rather than mirrored — the same correction
 * the team map needed.
 *
 * ## Why it is cached on disk
 * A trackmap is ~128 KB of JSON and the answer never changes for a given
 * circuit, so fetching one per card per refresh would be absurd. Each outline
 * reduces to about a kilobyte of path data, which is cached in userData and
 * survives restarts — and, once cached, the tab draws circuits with the game
 * shut, which is exactly when a driver is looking at tomorrow's schedule.
 *
 * `outlineOf` and the simplifier are pure and unit-tested by
 * `scripts/test-trackmaps.js`; nothing here imports Electron.
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/** Bumped when the produced path changes shape, to invalidate cached files. */
const CACHE_VERSION = 1;

/** The box an outline is normalised into. Unitless — the card sets the size. */
const VIEW = 100;

/**
 * How far a point may sit from the simplified line before it is kept, in
 * units of the normalised box. 0.35 of 100 holds every corner that reads at
 * card size while cutting ~927 points to ~150.
 */
const SIMPLIFY_TOLERANCE = 0.35;

const HTTP_TIMEOUT_MS = 8000;

/* -------------------------------------------------------------------------- */
/*  Geometry                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Ramer–Douglas–Peucker. Iterative rather than recursive: a circuit is a
 * thousand points and a pathological run of collinear ones would put a
 * recursive version a thousand frames deep.
 */
function simplify(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];

  while (stack.length) {
    const [first, last] = stack.pop();
    if (last <= first + 1) continue;
    const ax = points[first][0];
    const ay = points[first][1];
    const bx = points[last][0];
    const by = points[last][1];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);

    let worst = -1;
    let worstAt = -1;
    for (let i = first + 1; i < last; i += 1) {
      const px = points[i][0];
      const py = points[i][1];
      // Distance to the segment; to the endpoint when the segment is a point.
      const d =
        len === 0
          ? Math.hypot(px - ax, py - ay)
          : Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }

    if (worst > tolerance && worstAt > 0) {
      keep[worstAt] = 1;
      stack.push([first, worstAt], [worstAt, last]);
    }
  }

  const out = [];
  for (let i = 0; i < points.length; i += 1) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * The circuit as an SVG path, normalised into a VIEW-sized box with its aspect
 * ratio preserved (so Le Mans stays long and Monza stays square) and centred.
 *
 * Returns `null` rather than a degenerate path whenever the geometry cannot be
 * drawn — too few points, or every point on one spot. A card with no outline is
 * fine; a card with a dot claiming to be a circuit is not.
 */
function outlineOf(rawPoints) {
  if (!Array.isArray(rawPoints)) return null;

  const pts = [];
  for (const p of rawPoints) {
    if (!p || p.type !== 0) continue;
    const x = Number(p.x);
    const z = Number(p.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    // y is elevation and is dropped; z is negated so north reads up.
    pts.push([x, -z]);
  }
  if (pts.length < 8) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const span = Math.max(spanX, spanY);
  if (!(span > 0)) return null;

  const scale = VIEW / span;
  const offX = (VIEW - spanX * scale) / 2;
  const offY = (VIEW - spanY * scale) / 2;

  const flat = pts.map(([x, y]) => [
    (x - minX) * scale + offX,
    (y - minY) * scale + offY,
  ]);

  const kept = simplify(flat, SIMPLIFY_TOLERANCE);
  if (kept.length < 8) return null;

  /* One decimal is a tenth of a percent of the box — well under a pixel at any
     size a card draws this, and it halves the string. */
  const n = (v) => {
    const r = Math.round(v * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  };

  let d = `M${n(kept[0][0])} ${n(kept[0][1])}`;
  for (let i = 1; i < kept.length; i += 1) d += `L${n(kept[i][0])} ${n(kept[i][1])}`;
  // The lap closes on itself; Z draws the last few metres and joins the ends.
  d += 'Z';

  return { d, view: VIEW, points: kept.length };
}

/* -------------------------------------------------------------------------- */
/*  The game's local endpoints                                                */
/* -------------------------------------------------------------------------- */

function getJson(port, apiPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: apiPath, timeout: HTTP_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`${apiPath} HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`${apiPath} timeout`)));
  });
}

/**
 * The scene key both sides are matched on. RaceOS spells it `PortimaoELMS` and
 * the game spells it `PORTIMAOELMS`, so case is folded; nothing else is, because
 * `SPAWEC` and `SPAELMS` are different circuits and so are `PAULRICARD1A` and
 * `PAULRICARD1A-V2-SHORT`.
 */
function sceneKey(scene) {
  return typeof scene === 'string' ? scene.trim().toUpperCase() : '';
}

/* -------------------------------------------------------------------------- */
/*  The cache                                                                 */
/* -------------------------------------------------------------------------- */

let cacheDir = null;
/** scene key → outline | null. `null` is a remembered "this one has no map". */
const memory = new Map();
/** Scene keys already attempted this run, so a miss is not retried per card. */
const attempted = new Set();
/** The installed-circuit index, read once per run. */
let trackIndex = null;

function init(dir) {
  cacheDir = dir || null;
  if (cacheDir) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
    } catch {
      cacheDir = null; // a read-only profile is not a reason to fail the tab
    }
  }
}

function cacheFile(key) {
  if (!cacheDir) return null;
  // Scene names are alphanumeric plus '-' and '_', but never trust that.
  return path.join(cacheDir, `${key.replace(/[^A-Z0-9_-]/gi, '_')}.json`);
}

function readCached(key) {
  const file = cacheFile(key);
  if (!file) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.v === CACHE_VERSION && typeof raw.d === 'string' && raw.d) {
      return { d: raw.d, view: raw.view || VIEW, points: raw.points || 0 };
    }
  } catch {
    /* absent or unreadable — refetch */
  }
  return undefined;
}

function writeCached(key, outline) {
  const file = cacheFile(key);
  if (!file || !outline) return;
  try {
    fs.writeFileSync(file, JSON.stringify({ v: CACHE_VERSION, ...outline }));
  } catch {
    /* the outline still works this run */
  }
}

/* -------------------------------------------------------------------------- */
/*  Resolution                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One circuit's outline, from the disk cache if it is there and from the
 * running game if it is not. Resolves to `null` for anything it cannot draw —
 * the game shut, the circuit not installed, geometry it will not trust.
 */
async function outlineFor(scene, opts = {}) {
  const key = sceneKey(scene);
  if (!key) return null;

  if (memory.has(key)) return memory.get(key);

  const cached = readCached(key);
  if (cached) {
    memory.set(key, cached);
    return cached;
  }

  // One attempt per scene per run: with the game shut this would otherwise be
  // nine failing HTTP calls every time the tab is opened.
  if (attempted.has(key)) return null;
  attempted.add(key);

  const port = Number(opts.port) || Number(process.env.APEX_LMU_PORT) || 6397;
  const fetchJson = opts.fetchJson || ((p) => getJson(port, p));

  try {
    if (!trackIndex) {
      const list = await fetchJson('/rest/race/track');
      trackIndex = new Map();
      for (const t of Array.isArray(list) ? list : []) {
        const k = sceneKey(t && t.sceneDesc);
        if (k && t.id && !trackIndex.has(k)) trackIndex.set(k, String(t.id));
      }
    }
    const id = trackIndex.get(key);
    if (!id) return null;

    const points = await fetchJson(`/rest/race/track/${encodeURIComponent(id)}/trackmap`);
    const outline = outlineOf(points);
    if (!outline) return null;

    memory.set(key, outline);
    writeCached(key, outline);
    return outline;
  } catch {
    // The index may have half-loaded; drop it so the next run retries cleanly.
    trackIndex = null;
    return null;
  }
}

/**
 * Adds `map` to every event, occurrence and series in a dailies payload that
 * has a circuit we can draw. Mutates and returns the payload.
 *
 * Never throws and never rejects: an outline is decoration, and a tab that
 * fails to load because a drawing did is worse than a tab with no drawings.
 */
async function decorate(payload, opts = {}) {
  if (!payload || !Array.isArray(payload.tiers)) return payload;

  /* Collect the distinct scenes first — the three Beginner occurrences of
     "LMGT3 Fixed" are all Bahrain, and nine cards share nine circuits at most. */
  const scenes = new Set();
  for (const tier of payload.tiers) {
    for (const ev of tier.events || []) if (ev.scene) scenes.add(ev.scene);
    for (const occ of tier.upcoming || []) if (occ.scene) scenes.add(occ.scene);
    if (tier.next && tier.next.scene) scenes.add(tier.next.scene);
  }
  for (const s of payload.series || []) if (s.scene) scenes.add(s.scene);

  const found = new Map();
  await Promise.all(
    [...scenes].map(async (scene) => {
      try {
        const outline = await outlineFor(scene, opts);
        if (outline) found.set(sceneKey(scene), outline);
      } catch {
        /* decoration only */
      }
    }),
  );

  const stamp = (obj) => {
    if (obj && obj.scene) {
      const hit = found.get(sceneKey(obj.scene));
      if (hit) obj.map = hit;
    }
  };

  for (const tier of payload.tiers) {
    for (const ev of tier.events || []) stamp(ev);
    for (const occ of tier.upcoming || []) stamp(occ);
    stamp(tier.next);
  }
  for (const s of payload.series || []) stamp(s);

  return payload;
}

/** Drops every cached outline in memory. The disk cache is left alone. */
function resetCache() {
  memory.clear();
  attempted.clear();
  trackIndex = null;
}

module.exports = {
  CACHE_VERSION,
  VIEW,
  SIMPLIFY_TOLERANCE,
  simplify,
  outlineOf,
  sceneKey,
  init,
  outlineFor,
  decorate,
  resetCache,
};
