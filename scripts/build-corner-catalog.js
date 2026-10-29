/**
 * scripts/build-corner-catalog.js — stable corner numbers per layout.
 * -----------------------------------------------------------------------------
 * `corners.ts findCorners()` cuts ONE lap into corners, and one lap is not a
 * stable thing to number from: on the laps on this machine it gives Road
 * Atlanta 9–12 corners, Daytona 7–10 and Le Mans 20–27, because a corner that
 * sits on a threshold (the Daytona banking, the 28° Le Mans kink at ~600 m, a
 * double apex that is sometimes one bend and sometimes two, a spin) comes and
 * goes with the line taken. The Practice tab numbers C1..Cn off whichever lap
 * is the reference, so "C5" meant a different corner from session to session.
 *
 * This dev tool (run by hand, never shipped) lets every clean dry lap of a
 * layout vote, and writes the corners most laps agree on to
 * `data/corners/<mapKey>.json` — a `CornerCatalog` (src/telemetry/coachContract.ts),
 * which `cornerCatalog.ts` then snaps each reference lap onto, so C5 is C5
 * every session.
 *
 *     node scripts/build-corner-catalog.js                   # local laps only
 *     node scripts/build-corner-catalog.js --cloud           # + the board traces
 *     node scripts/build-corner-catalog.js --offline         # + the board traces, from the last download
 *     node scripts/build-corner-catalog.js --dry-run         # report, write nothing
 *     node scripts/build-corner-catalog.js --only michelin-raceway-road-atlanta-4080
 *
 * Options: --min-laps N (8), --out DIR (data/corners), --cache DIR (cloud
 * download cache, default os.tmpdir()/apex-corner-catalog-cache), --supabase
 * PATH (the CLI; else $APEX_SUPABASE_CLI, else `supabase` on PATH),
 * --supabase-cwd DIR (where the project link lives; else $APEX_SUPABASE_CWD).
 * Needs `npm run build` first: it cuts laps with the app's own `dist/` code.
 *
 * ## What votes
 * - Local laps: `~/.apex-overlay/traces`, joined by id to the lap log, kept
 *   when the record is CLEAN and DRY and the trace covers the lap line to line.
 * - Cloud laps (`--cloud`): `lap_traces` rows (board bests, so clean by
 *   construction) whose `driver_best_laps` row is dry, read with a read-only
 *   SELECT through the Supabase CLI. A board lap that is also on this disk
 *   (same layout, same lap time) votes once.
 *
 * ## How a lap is cut
 * With the driven line (trace v2), `findCorners()` exactly as the app runs it.
 * Without one (v1), a line is dead-reckoned from lateral G — the heading turns
 * at `latG·g / v²` per metre — and `findCorners()` is run on that. On lined
 * laps the dead-reckoned curvature matches the real line's to a few per cent;
 * the banking is where it reads low (the bank carries part of the turn).
 * Direction is the sign of the heading change through the corner: in LMU's
 * axes a heading measured as atan2(dz, dx) falls through a RIGHT-hander
 * (checked against the steering column on real laps).
 *
 * The bundled track maps are NOT a corner source: eight of them (Bahrain,
 * Monza, Road Atlanta, Algarve, Barcelona, COTA, Fuji, Lusail) carry a fake
 * ~34° S-wiggle ~300 m after the line, and Spa's has a knot at 156–348 m.
 *
 * ## How the votes are counted
 * Per direction, every lap's apexes go into a density along the lap
 * (Gaussian, σ = {@link SIGMA_M}); its peaks are the candidate corners, and
 * each lap's nearest apex within {@link CLAIM_M} of a peak is that lap's vote
 * for it (one vote per lap). A candidate seen in at least {@link SUPPORT} of
 * the laps is a corner; entry, apex and exit are the medians of its votes.
 *
 * Rebuilding must not renumber: a corner already in the previous catalogue
 * stays while it is seen in at least {@link KEEP_SUPPORT} of the laps, and a
 * corner that was not in it needs {@link ADD_SUPPORT} to join, so a
 * borderline corner does not flicker in and out (and shift every number after
 * it) as laps are added. Deleting the file starts the vote afresh.
 *
 * ## Sequences
 * Neighbours are LINKED when fewer than {@link LINK_GAP_M} of road separate
 * one's exit from the next one's entry, or when they turn opposite ways with
 * no real full-throttle run between the apexes (median over laps under
 * {@link LINK_GAP_M}). Two linked → 'chicane', three or more → 'complex'.
 *
 * `headingFromLatG` duplicates the one the engine builder exports from
 * `cornerPhases.ts` on its own branch — dedupe once both are merged.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const dist = (m) => require(path.join(ROOT, 'dist', 'telemetry', m));

/** Share of laps a new corner must be seen in. */
const SUPPORT = 0.6;
/** Share of laps a corner already in the catalogue must keep being seen in. */
const KEEP_SUPPORT = 0.4;
/**
 * Share of laps a corner NOT in the previous catalogue must reach to be added
 * on a rebuild: a corner hovering at the threshold (the Le Mans kink at
 * ~630 m sits at 55–60%) must not come and go, renumbering everything after it.
 */
const ADD_SUPPORT = 0.7;
/** Density kernel width along the lap, metres. */
const SIGMA_M = 10;
/** How far from a peak a lap's apex may sit and still vote for it, metres. */
const CLAIM_M = 40;
/** Peaks of one direction closer than this are one corner. */
const PEAK_MERGE_M = 25;
/** Same-direction candidates this close may be one corner placed two ways. */
const ALT_MERGE_M = 90;
/** …when at most this share of the smaller one's laps voted for both. */
const ALT_OVERLAP = 0.2;
/** Exit-to-entry gap under which neighbours are one sequence, metres. */
const LINK_GAP_M = 100;
/** Throttle at or above this is "full" — corners.ts FULL_THROTTLE. */
const FULL_THROTTLE = 0.9;
/** Fewer laps than this and a layout gets no catalogue. */
const MIN_LAPS = 8;
/** Half-span over which heading is measured on a line — corners.ts's. */
const HEADING_HALF_SPAN_M = 10;
const G = 9.80665;

/* -------------------------------------------------------------------------- */
/*  One lap                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Heading along the lap, radians, dead-reckoned from lateral G:
 * dθ/ds = latG·g / v². Positive latG turns the heading the way atan2(dz, dx)
 * turns in a LEFT-hander (the sign `findCorners` sees on a real line).
 * latG is averaged over three samples first (kerb strikes), and speed is
 * floored at 8 m/s so a crawl does not read as a hairpin.
 */
function headingFromLatG(d, latG, speedKph, lengthM) {
  const n = Math.min(d.length, latG.length, speedKph.length);
  const h = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const a = i - 1;
    const lat = (k) => {
      let s = 0;
      let c = 0;
      for (let j = k - 1; j <= k + 1; j += 1) {
        if (j >= 0 && j < n && Number.isFinite(latG[j])) {
          s += latG[j];
          c += 1;
        }
      }
      return c ? s / c : 0;
    };
    const v = Math.max(8, ((speedKph[a] + speedKph[i]) / 2) / 3.6);
    const ds = Math.max(0, (d[i] - d[a]) * lengthM);
    h[i] = h[a] + (((lat(a) + lat(i)) / 2) * G * ds) / (v * v);
  }
  return h;
}

/** A line laid along a heading, one sample per trace sample. */
function lineFromHeading(d, h, lengthM) {
  const n = h.length;
  const x = new Array(n).fill(0);
  const z = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const ds = Math.max(0, (d[i] - d[i - 1]) * lengthM);
    const hm = (h[i] + h[i - 1]) / 2;
    x[i] = x[i - 1] + Math.cos(hm) * ds;
    z[i] = z[i - 1] + Math.sin(hm) * ds;
  }
  return { x, z };
}

/** Unwrapped heading of a line, measured across ±10 m as `corners.ts` does. */
function lineHeading(x, z, d, lengthM) {
  const n = Math.min(x.length, z.length, d.length);
  const step = ((d[n - 1] - d[0]) * lengthM) / Math.max(1, n - 1);
  const k = Math.max(1, Math.round(HEADING_HALF_SPAN_M / Math.max(step, 1e-6)));
  const th = new Array(n);
  let prev = NaN;
  for (let i = 0; i < n; i += 1) {
    const a = Math.max(0, i - k);
    const b = Math.min(n - 1, i + k);
    const dx = x[b] - x[a];
    const dz = z[b] - z[a];
    if (Math.hypot(dx, dz) < 1 && Number.isFinite(prev)) {
      th[i] = prev;
      continue;
    }
    let hh = Math.atan2(dz, dx);
    if (Number.isFinite(prev)) {
      while (hh - prev > Math.PI) hh -= 2 * Math.PI;
      while (hh - prev < -Math.PI) hh += 2 * Math.PI;
    }
    th[i] = hh;
    prev = hh;
  }
  return th;
}

const finiteCol = (c, n) => Array.isArray(c) && c.length >= n && c.every((v) => Number.isFinite(v));

/** Does this trace cover the lap from line to line, with the columns a cut needs? */
function usableTrace(tr) {
  if (!tr || !Array.isArray(tr.d) || !Array.isArray(tr.speedKph)) return false;
  const n = tr.d.length;
  if (n < 100 || tr.truncated === true) return false;
  if (!(tr.d[0] <= 0.02 && tr.d[n - 1] >= 0.98)) return false;
  return finiteCol(tr.speedKph, n);
}

const hasLine = (tr) => finiteCol(tr.x, tr.d.length) && finiteCol(tr.z, tr.d.length);

/**
 * One lap's corners, in metres, with their direction — or `null` when the lap
 * can be cut neither by its line nor by lateral G.
 */
function lapCorners(tr, lengthM) {
  const { findCorners } = dist('corners');
  if (!usableTrace(tr)) return null;
  const n = tr.d.length;
  let x;
  let z;
  let source;
  if (hasLine(tr)) {
    x = tr.x;
    z = tr.z;
    source = 'line';
  } else if (finiteCol(tr.latG, n)) {
    ({ x, z } = lineFromHeading(tr.d, headingFromLatG(tr.d, tr.latG, tr.speedKph, lengthM), lengthM));
    source = 'latG';
  } else {
    return null;
  }
  const cut = {
    d: tr.d,
    speedKph: tr.speedKph,
    ...(Array.isArray(tr.brake) ? { brake: tr.brake } : {}),
    ...(Array.isArray(tr.throttle) ? { throttle: tr.throttle } : {}),
    x,
    z,
  };
  const th = lineHeading(x, z, tr.d, lengthM);
  const corners = findCorners(cut, lengthM).map((c) => {
    const turn = th[c.exitI] - th[c.entryI];
    return {
      entryM: c.entryD * lengthM,
      apexM: c.apexD * lengthM,
      exitM: c.exitD * lengthM,
      dir: turn < 0 ? 'R' : 'L',
      turnDeg: c.turnDeg,
      minKph: c.minKph,
      braked: c.brakeD !== null,
    };
  });
  return { source, corners, fullRuns: fullThrottleRuns(tr, lengthM) };
}

/** Stretches of the lap at full throttle, metres `[from, to]`. */
function fullThrottleRuns(tr, lengthM) {
  const thr = tr.throttle;
  if (!Array.isArray(thr)) return null;
  const out = [];
  let start = -1;
  for (let i = 0; i < tr.d.length; i += 1) {
    const on = (thr[i] ?? 0) >= FULL_THROTTLE;
    if (on && start < 0) start = i;
    if ((!on || i === tr.d.length - 1) && start >= 0) {
      out.push([tr.d[start] * lengthM, tr.d[on ? i : i - 1] * lengthM]);
      start = -1;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  The vote                                                                  */
/* -------------------------------------------------------------------------- */

function median(xs) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Candidate corners of one direction: peaks of the apex density, each with
 * the one vote per lap nearest to it.
 */
function clusterDir(cut, dir, lengthM) {
  const apexes = [];
  cut.forEach((lap, li) => {
    for (const c of lap.corners) if (c.dir === dir) apexes.push({ li, c });
  });
  if (!apexes.length) return [];
  const STEP = 2;
  const bins = Math.ceil(lengthM / STEP) + 1;
  const dens = new Float64Array(bins);
  const reach = Math.ceil((3 * SIGMA_M) / STEP);
  for (const { c } of apexes) {
    const b0 = Math.round(c.apexM / STEP);
    for (let b = Math.max(0, b0 - reach); b <= Math.min(bins - 1, b0 + reach); b += 1) {
      const u = (b * STEP - c.apexM) / SIGMA_M;
      dens[b] += Math.exp(-0.5 * u * u);
    }
  }
  const peaks = [];
  for (let b = 0; b < bins; b += 1) {
    const l = b > 0 ? dens[b - 1] : -1;
    const r = b + 1 < bins ? dens[b + 1] : -1;
    if (dens[b] > 0.5 && dens[b] >= l && dens[b] > r) peaks.push({ m: b * STEP, h: dens[b] });
  }
  peaks.sort((a, b) => b.h - a.h);
  const kept = [];
  for (const p of peaks) if (!kept.some((k) => Math.abs(k.m - p.m) < PEAK_MERGE_M)) kept.push(p);
  // Strongest peak first claims its votes; a lap votes at most once per peak
  // and each of its corners votes for at most one peak.
  const used = new Set();
  const out = [];
  for (const p of kept) {
    const byLap = new Map();
    for (let k = 0; k < apexes.length; k += 1) {
      if (used.has(k)) continue;
      const dist = Math.abs(apexes[k].c.apexM - p.m);
      if (dist > CLAIM_M) continue;
      const prev = byLap.get(apexes[k].li);
      if (!prev || dist < prev.dist) byLap.set(apexes[k].li, { k, dist });
    }
    for (const { k } of byLap.values()) used.add(k);
    const votes = [...byLap.values()].map(({ k }) => apexes[k]);
    out.push({ dir, peakM: p.m, votes });
  }
  return mergeAlternatives(out.filter((c) => c.votes.length > 0));
}

/**
 * Two neighbouring peaks that are the SAME corner placed two ways: a corner
 * taken flat has its apex "half way round", which wanders with the line, and
 * the density can split it in two (Le Mans at 12.2 km: 32% + 56% of laps, and
 * almost no lap with both). Peaks within {@link ALT_MERGE_M} that few laps
 * vote for together are merged; a real double apex, which most laps read as
 * two corners, is not.
 */
function mergeAlternatives(cls) {
  const lapsOf = (c) => new Set(c.votes.map((v) => v.li));
  let merged = true;
  while (merged) {
    merged = false;
    cls.sort((a, b) => median(a.votes.map((v) => v.c.apexM)) - median(b.votes.map((v) => v.c.apexM)));
    for (let k = 0; k + 1 < cls.length; k += 1) {
      const a = cls[k];
      const b = cls[k + 1];
      const gap = median(b.votes.map((v) => v.c.apexM)) - median(a.votes.map((v) => v.c.apexM));
      if (gap > ALT_MERGE_M) continue;
      const la = lapsOf(a);
      const lb = lapsOf(b);
      let both = 0;
      for (const li of la) if (lb.has(li)) both += 1;
      if (both > ALT_OVERLAP * Math.min(la.size, lb.size)) continue;
      // One vote per lap: where a lap voted for both, the stronger peak's stands.
      const keepA = la.size >= lb.size;
      const votes = (keepA ? a.votes : b.votes).concat(
        (keepA ? b.votes : a.votes).filter((v) => !(keepA ? la : lb).has(v.li)),
      );
      cls.splice(k, 2, { dir: a.dir, peakM: keepA ? a.peakM : b.peakM, votes });
      merged = true;
      break;
    }
  }
  return cls;
}

/**
 * Build one layout's catalogue from its laps' cuts.
 *
 * @param laps  - `{ trace, trackLengthM, ... }` per lap; laps that cannot be cut are skipped.
 * @param opts.mapKey - the layout.
 * @param opts.previous - the catalogue being rebuilt, if any (see "Rebuilding" above).
 * @param opts.at - build date, ISO.
 */
function buildCatalog(laps, opts) {
  const lengths = laps.map((l) => l.trackLengthM).filter((v) => v > 0);
  const L = Math.round(median(lengths));
  const cut = [];
  const sources = { line: 0, latG: 0 };
  const from = { local: 0, cloud: 0 };
  const classes = {};
  for (const lap of laps) {
    const c = lapCorners(lap.trace, lap.trackLengthM > 0 ? lap.trackLengthM : L);
    if (!c) continue;
    cut.push(c);
    sources[c.source] += 1;
    from[lap.source === 'cloud' ? 'cloud' : 'local'] += 1;
    if (lap.carClass) classes[lap.carClass] = (classes[lap.carClass] || 0) + 1;
  }
  const N = cut.length;
  const prev = opts.previous && Array.isArray(opts.previous.corners) ? opts.previous.corners : [];
  const prevL = opts.previous && opts.previous.trackLengthM > 0 ? opts.previous.trackLengthM : L;
  const wasThere = (cand) =>
    prev.some((p) => p.dir === cand.dir && Math.abs(p.apexD * prevL - cand.apexM) <= CLAIM_M);

  const candidates = [...clusterDir(cut, 'L', L), ...clusterDir(cut, 'R', L)].map((cl) => {
    const support = N ? new Set(cl.votes.map((v) => v.li)).size / N : 0;
    return {
      dir: cl.dir,
      support,
      entryM: median(cl.votes.map((v) => v.c.entryM)),
      apexM: median(cl.votes.map((v) => v.c.apexM)),
      exitM: median(cl.votes.map((v) => v.c.exitM)),
      minKph: median(cl.votes.map((v) => v.c.minKph)),
      braked: cl.votes.filter((v) => v.c.braked).length / Math.max(1, cl.votes.length),
    };
  });
  const fresh = prev.length === 0;
  for (const c of candidates) c.kept = c.support >= (fresh ? SUPPORT : wasThere(c) ? KEEP_SUPPORT : ADD_SUPPORT);
  const kept = candidates.filter((c) => c.kept).sort((a, b) => a.apexM - b.apexM);

  // Medians of different neighbours can overlap where laps disagree about the
  // corner between; a catalogue's corners never do.
  for (let k = 0; k + 1 < kept.length; k += 1) {
    const a = kept[k];
    const b = kept[k + 1];
    if (a.exitM > b.entryM) {
      const cut2 = b.entryM > a.apexM ? b.entryM : (a.apexM + b.apexM) / 2;
      a.exitM = Math.max(Math.min(a.exitM, cut2), a.apexM + 1);
      b.entryM = Math.min(Math.max(b.entryM, a.exitM), b.apexM - 1);
    }
  }
  for (const c of kept) {
    c.entryM = Math.max(0, Math.min(c.entryM, c.apexM - 1));
    c.exitM = Math.min(L, Math.max(c.exitM, c.apexM + 1));
  }

  // Sequences.
  const linked = [];
  for (let k = 0; k + 1 < kept.length; k += 1) {
    const a = kept[k];
    const b = kept[k + 1];
    const gap = b.entryM - a.exitM;
    let link = gap < LINK_GAP_M;
    if (!link && a.dir !== b.dir) {
      const runs = cut
        .filter((c) => c.fullRuns)
        .map((c) => {
          let best = 0;
          for (const [s, e] of c.fullRuns) {
            const lo = Math.max(s, a.apexM);
            const hi = Math.min(e, b.apexM);
            if (hi > lo) best = Math.max(best, hi - lo);
          }
          return best;
        });
      link = runs.length > 0 && median(runs) < LINK_GAP_M;
    }
    linked.push(link);
  }
  const rd = (v) => Math.round(v * 1e6) / 1e6;
  const corners = kept.map((c, i) => ({
    id: `C${i + 1}`,
    entryD: rd(c.entryM / L),
    apexD: rd(c.apexM / L),
    exitD: rd(c.exitM / L),
    dir: c.dir,
    seq: null,
  }));
  const sequences = [];
  for (let k = 0; k < kept.length; ) {
    let j = k;
    while (j < linked.length && linked[j]) j += 1;
    if (j > k) {
      const ids = corners.slice(k, j + 1).map((c) => c.id);
      const id = `S${sequences.length + 1}`;
      sequences.push({ id, cornerIds: ids, kind: ids.length >= 3 ? 'complex' : 'chicane' });
      for (let m = k; m <= j; m += 1) corners[m].seq = id;
    }
    k = j + 1;
  }

  return {
    catalog: {
      mapKey: opts.mapKey,
      trackLengthM: L,
      builtFrom: N,
      corners,
      sequences,
      built: {
        at: opts.at || new Date().toISOString().slice(0, 10),
        tool: 'scripts/build-corner-catalog.js',
        laps: N,
        local: from.local,
        cloud: from.cloud,
        cutBy: sources,
        classes,
        support: kept.map((c) => Math.round(c.support * 100) / 100),
      },
    },
    candidates: candidates.sort((a, b) => a.apexM - b.apexM),
    perLapCounts: cut.map((c) => c.corners.length),
  };
}

/* -------------------------------------------------------------------------- */
/*  Gathering laps                                                            */
/* -------------------------------------------------------------------------- */

function conditionOfRec(rec) {
  if (rec.condition) return rec.condition;
  if (rec.wet === true) return 'wet';
  const { conditionOf } = dist('lapLog');
  return conditionOf(rec.wetness);
}

/** Clean, dry, traced laps on this machine. */
function localLaps() {
  const { lapDir } = dist('lapLog');
  const { traceDir } = dist('lapTrace');
  const { mapKeyForLap } = dist('lapDetail');
  const recs = new Map();
  const ldir = lapDir();
  for (const f of safeReaddir(ldir)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of fs.readFileSync(path.join(ldir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && r.id) recs.set(r.id, r);
      } catch {
        /* a torn line */
      }
    }
  }
  const out = [];
  const tdir = traceDir();
  for (const day of safeReaddir(tdir)) {
    for (const f of safeReaddir(path.join(tdir, day))) {
      if (!f.endsWith('.json')) continue;
      const rec = recs.get(f.slice(0, -5));
      if (!rec || rec.clean !== true || conditionOfRec(rec) !== 'dry') continue;
      let file;
      try {
        file = JSON.parse(fs.readFileSync(path.join(tdir, day, f), 'utf8'));
      } catch {
        continue;
      }
      if (!file || !usableTrace(file.trace)) continue;
      out.push({
        source: 'local',
        lapId: rec.id,
        mapKey: mapKeyForLap(rec),
        trackLengthM: Number(rec.trackLengthM) || Number(file.trackLengthM) || 0,
        lapMs: Number(rec.lapMs) || 0,
        carClass: rec.carClass || '',
        trace: file.trace,
      });
    }
  }
  return out;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Run one read-only SELECT through the Supabase CLI; the rows. */
function cloudQuery(sql, cli, cwd, scratch) {
  // The SQL goes in a file (`-f`): through a Windows .cmd shim an argument
  // with spaces is split into words. An npm `.bin` shim is run as the
  // package's own script under this node, which needs no shell at all.
  const sqlFile = path.join(scratch, 'query.sql');
  fs.writeFileSync(sqlFile, sql);
  const shimJs = path.join(path.dirname(cli), '..', 'supabase', 'dist', 'supabase.js');
  const viaNode = /[\\/]\.bin[\\/]supabase(\.cmd)?$/i.test(cli) && fs.existsSync(shimJs);
  const args = ['db', 'query', '--linked', '--output-format', 'json', '-f', sqlFile];
  const out = execFileSync(viaNode ? process.execPath : cli, viaNode ? [shimJs, ...args] : args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const start = out.indexOf('{');
  const body = JSON.parse(out.slice(start, out.lastIndexOf('}') + 1));
  return Array.isArray(body.rows) ? body.rows : [];
}

/**
 * Board traces whose board row is dry, with only the columns a cut reads.
 * Cached per track on disk: the table is ~35 MB of jsonb.
 */
function cloudLaps(opts) {
  const { trackKey } = dist('trackMap');
  const cli = opts.supabase || process.env.APEX_SUPABASE_CLI || 'supabase';
  const cwd = opts.supabaseCwd || process.env.APEX_SUPABASE_CWD || process.cwd();
  fs.mkdirSync(opts.cache, { recursive: true });
  // `--offline` rebuilds from the cache alone (the last download's list).
  const listFile = path.join(opts.cache, 'tracks.json');
  const tracks = opts.offline
    ? JSON.parse(fs.readFileSync(listFile, 'utf8'))
    : cloudQuery(
        "select t.id, t.name, t.length_m, count(*)::int n from lap_traces lt join tracks t on t.id = lt.track_id " +
          "join driver_best_laps b on b.driver_id = lt.driver_id and b.track_id = lt.track_id and b.car_class = lt.car_class " +
          "and b.lap_ms = lt.lap_ms where b.condition = 'dry' group by 1, 2, 3 order by 2",
        cli,
        cwd,
        opts.cache,
      );
  if (!opts.offline) fs.writeFileSync(listFile, JSON.stringify(tracks));
  const out = [];
  for (const t of tracks) {
    const mapKey = trackKey(t.name, undefined, Number(t.length_m) || 0);
    if (opts.only && opts.only !== mapKey) continue;
    const cacheFile = path.join(opts.cache, `${mapKey}.json`);
    let rows = null;
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached && cached.n === t.n) rows = cached.rows;
    } catch {
      /* not cached yet */
    }
    if (!rows) {
      rows = [];
      const PAGE = 20;
      for (let off = 0; off < t.n; off += PAGE) {
        const page = cloudQuery(
          "select lt.lap_ms, lt.car_class, jsonb_build_object('d', lt.data->'d', 'speedKph', lt.data->'speedKph', " +
            "'brake', lt.data->'brake', 'throttle', lt.data->'throttle', 'latG', lt.data->'latG', 'steer', lt.data->'steer', " +
            "'truncated', lt.data->'truncated', 'x', lt.data->'x', 'z', lt.data->'z') tr " +
            "from lap_traces lt join driver_best_laps b on b.driver_id = lt.driver_id and b.track_id = lt.track_id " +
            "and b.car_class = lt.car_class and b.lap_ms = lt.lap_ms " +
            `where lt.track_id = '${String(t.id).replace(/[^0-9a-f-]/gi, '')}' and b.condition = 'dry' ` +
            `order by lt.driver_id, lt.car_class limit ${PAGE} offset ${off}`,
          cli,
          cwd,
          opts.cache,
        );
        rows.push(...page);
      }
      fs.writeFileSync(cacheFile, JSON.stringify({ n: t.n, rows }));
    }
    for (const r of rows) {
      const tr = typeof r.tr === 'string' ? JSON.parse(r.tr) : r.tr;
      if (!tr) continue;
      for (const k of Object.keys(tr)) if (tr[k] === null) delete tr[k];
      if (!usableTrace(tr)) continue;
      out.push({
        source: 'cloud',
        lapId: '',
        mapKey,
        trackLengthM: Number(t.length_m) || 0,
        lapMs: Number(r.lap_ms) || 0,
        carClass: r.car_class || '',
        trace: tr,
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  CLI                                                                       */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const o = {
    cloud: false,
    offline: false,
    dryRun: false,
    only: '',
    minLaps: MIN_LAPS,
    out: path.join(ROOT, 'data', 'corners'),
    cache: path.join(os.tmpdir(), 'apex-corner-catalog-cache'),
    supabase: '',
    supabaseCwd: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--cloud') o.cloud = true;
    else if (a === '--offline') o.offline = o.cloud = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--only') o.only = next();
    else if (a === '--min-laps') o.minLaps = Number(next());
    else if (a === '--out') o.out = path.resolve(next());
    else if (a === '--cache') o.cache = path.resolve(next());
    else if (a === '--supabase') o.supabase = next();
    else if (a === '--supabase-cwd') o.supabaseCwd = next();
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let laps = localLaps().filter((l) => !opts.only || l.mapKey === opts.only);
  if (opts.cloud) {
    const local = new Set(laps.map((l) => `${l.mapKey}|${l.lapMs}`));
    const cloud = cloudLaps(opts).filter((l) => !local.has(`${l.mapKey}|${l.lapMs}`));
    laps = laps.concat(cloud);
  }
  const byKey = new Map();
  for (const l of laps) {
    if (!byKey.has(l.mapKey)) byKey.set(l.mapKey, []);
    byKey.get(l.mapKey).push(l);
  }
  const at = new Date().toISOString().slice(0, 10);
  const summary = [];
  for (const [mapKey, group] of [...byKey.entries()].sort()) {
    if (group.length < opts.minLaps) {
      summary.push(`${mapKey.padEnd(52)} ${String(group.length).padStart(4)} laps  — too few, no catalogue`);
      continue;
    }
    const file = path.join(opts.out, `${mapKey}.json`);
    let previous = null;
    try {
      previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* first build */
    }
    const { catalog, candidates, perLapCounts } = buildCatalog(group, { mapKey, previous, at });
    if (catalog.builtFrom < opts.minLaps) {
      summary.push(`${mapKey.padEnd(52)} ${String(catalog.builtFrom).padStart(4)} laps cut — too few, no catalogue`);
      continue;
    }
    const counts = {};
    for (const c of perLapCounts) counts[c] = (counts[c] || 0) + 1;
    summary.push(
      `${mapKey.padEnd(52)} ${String(catalog.builtFrom).padStart(4)} laps  ${String(catalog.corners.length).padStart(2)} corners` +
        `  ${catalog.sequences.length} seq   per-lap counts ${JSON.stringify(counts)}`,
    );
    console.log(`\n${mapKey}  (${catalog.builtFrom} laps: ${JSON.stringify(catalog.built.cutBy)}, ${JSON.stringify(catalog.built.classes)})`);
    for (const c of candidates) {
      if (c.support < 0.15) continue;
      const id = catalog.corners.find((k) => Math.abs(k.apexD * catalog.trackLengthM - c.apexM) < 1.5 && k.dir === c.dir);
      console.log(
        `  ${(id ? id.id : c.kept ? '?' : '-').padEnd(4)} ${c.dir} apex ${String(Math.round(c.apexM)).padStart(6)} m` +
          `  ${String(Math.round(c.entryM)).padStart(6)}–${String(Math.round(c.exitM)).padEnd(6)}` +
          `  seen ${String(Math.round(c.support * 100)).padStart(3)}%  min ${Math.round(c.minKph)} km/h${id && id.seq ? `  ${id.seq}` : ''}`,
      );
    }
    if (!opts.dryRun) {
      fs.mkdirSync(opts.out, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(catalog, null, 2)}\n`);
    }
  }
  console.log(`\n${summary.join('\n')}`);
}

module.exports = {
  headingFromLatG,
  lineFromHeading,
  lapCorners,
  buildCatalog,
  usableTrace,
  SUPPORT,
  KEEP_SUPPORT,
  ADD_SUPPORT,
  CLAIM_M,
};

if (require.main === module) main();
