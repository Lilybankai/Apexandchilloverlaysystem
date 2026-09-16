/**
 * electron/featureUsage.js — what the app was used FOR, counted locally.
 * -----------------------------------------------------------------------------
 * The third of the app's three uploaders, and the smallest.
 *
 *   usageReporter.js — "this install was open, from then to now".
 *   lapUpload.js     — "these laps were driven".
 *   featureUsage.js  — "and this is what the driver was doing in the app".
 *
 * ## What it counts
 * Two ledgers, both keyed by LOCAL calendar day:
 *
 *   features — `{ 'tab:review': { uses: 12, seconds: 940 }, … }`
 *              The slugs come from control-panel/feature-catalog.js; the panel
 *              reports them through `usage:feature`, and main reports the few
 *              that only it can see.
 *   overlays — `{ delta: { enabled: true, obsLoads: 2, ingameSeconds: 3600 }, … }`
 *              Which overlays were switched on, how many times an OBS browser
 *              source fetched one, and how long the in-game layer carried it.
 *
 * ## What it does NOT count
 * Anything with a name, a time of day, or an order. There is no event list
 * here, only counters — so the file on disk and the row in the cloud can say
 * "the Review tab was opened twelve times on Tuesday" and can never say when,
 * in what order, or against which car. That is a deliberate ceiling, not an
 * omission: see the head of supabase/migrations/0022_feature_analytics.sql.
 *
 * ## Why counters and not events
 * The same idempotence the lap uploader relies on. The store holds the day's
 * RUNNING TOTALS, the uploader offers the whole day, and the server keeps the
 * greater of what it has and what it was sent. A dropped upload, a crash, a
 * second PC, a clock that jumped — none of them can double-count and none of
 * them can go backwards. The worst case is under-reporting, which is the right
 * way round for a number a roadmap is about to be built on.
 *
 * ## Failure policy
 * Nothing in here throws. It is driven from a timer, from IPC and from the HTTP
 * server's request path; a counter that can take any of those down is worth far
 * less than one that silently misses a beat. A write that fails leaves the
 * numbers in memory, and the next flush tries again.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

/* -------------------------------------------------------------------------- */
/*  Wiring                                                                    */
/* -------------------------------------------------------------------------- */

/** Set by init() — where `usage-counters.json` lives. */
let storePath = null;
/** The auth module, injected so this can be driven headless by a test. */
let auth = null;
/** Stamped onto each upload, so a chart can be read per release. */
let appVersion = '';

/**
 * Days kept on disk. Seven covers a weekend spent offline plus the days either
 * side; anything older has either been accepted by the server or is never
 * going to be, and keeping it forever turns a counter file into a diary.
 */
const KEEP_DAYS = 7;

/**
 * How often the counters are flushed to disk and offered to the cloud. The same
 * five minutes the session heartbeat and the lap uploader use — these are daily
 * aggregates, and nothing about them is worth a request per click.
 */
const FLUSH_MS = 5 * 60 * 1000;

/** `{ [day]: { features: {...}, overlays: {...} } }`, days as `YYYY-MM-DD`. */
let ledger = Object.create(null);
/** `{ [day]: signature }` for the last batch the server accepted. */
let sent = Object.create(null);
/** True when the in-memory ledger has moved since the last successful write. */
let dirty = false;
let timer = null;

/* -------------------------------------------------------------------------- */
/*  Days                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Today, in the DRIVER's timezone, not UTC.
 *
 * A UK evening race that runs past midnight UTC would otherwise be split across
 * two "days" in a way that matches nothing the driver experienced, and the
 * question this whole module exists to answer — "how many people used Analyse
 * today?" — is asked about their day, not the server's. The server accepts
 * tomorrow's date for exactly this reason (see submit_feature_usage).
 */
function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The day's bucket, created on demand. */
function bucket(day) {
  let b = ledger[day];
  if (!b) {
    b = { features: Object.create(null), overlays: Object.create(null) };
    ledger[day] = b;
  }
  return b;
}

/** Forget anything older than {@link KEEP_DAYS}, on both ledgers. */
function prune() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (KEEP_DAYS - 1));
  const pad = (n) => String(n).padStart(2, '0');
  const oldest = `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())}`;
  for (const day of Object.keys(ledger)) if (day < oldest) delete ledger[day];
  for (const day of Object.keys(sent)) if (day < oldest) delete sent[day];
}

/* -------------------------------------------------------------------------- */
/*  Counting — everything below is called from hot-ish paths and never throws  */
/* -------------------------------------------------------------------------- */

/** A slug the store will accept: non-empty, lower case, bounded. */
function cleanSlug(value, max) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (!s) return '';
  return s.slice(0, max);
}

/**
 * Record one use of a feature, and optionally the seconds it was on screen.
 *
 * @param {string} slug     e.g. `tab:review`, `action:setup.download`
 * @param {object} [opts]
 * @param {number} [opts.uses=1]    times used (0 to record dwell only)
 * @param {number} [opts.seconds=0] whole seconds it was the thing on screen
 */
function feature(slug, opts = {}) {
  try {
    const key = cleanSlug(slug, 64);
    if (!key) return;
    const uses = Math.max(0, Math.round(Number(opts.uses ?? 1) || 0));
    // Clamped to a day: a dwell computed across a suspend/resume can otherwise
    // arrive as a fortnight, and one such row makes every chart unreadable.
    const seconds = Math.min(86400, Math.max(0, Math.round(Number(opts.seconds ?? 0) || 0)));
    if (!uses && !seconds) return;
    const f = bucket(today()).features;
    const row = f[key] || (f[key] = { uses: 0, seconds: 0 });
    row.uses += uses;
    row.seconds = Math.min(86400, row.seconds + seconds);
    dirty = true;
  } catch {
    /* a counter must never be the thing that breaks a click */
  }
}

/** The day's overlay row, created on demand. */
function overlayRow(id) {
  const o = bucket(today()).overlays;
  return o[id] || (o[id] = { enabled: false, obsLoads: 0, ingameSeconds: 0 });
}

/**
 * Record which overlays are switched on right now.
 *
 * ORs into the day rather than replacing it: the question is "was this overlay
 * in use today", and a card toggled off at 9pm was still used all evening. A
 * driver who leaves it off simply stops appearing on later days.
 *
 * @param {string[]} ids overlay ids that are currently enabled
 */
function overlaysEnabled(ids) {
  try {
    if (!Array.isArray(ids)) return;
    for (const raw of ids) {
      const id = cleanSlug(raw, 32);
      if (!id) continue;
      overlayRow(id).enabled = true;
    }
    dirty = true;
  } catch {
    /* as above */
  }
}

/**
 * Record that an OBS browser source (or a browser tab) fetched a page carrying
 * these overlays. Called from the HTTP server's request path, so it takes the
 * whole set at once rather than one call per widget on the combined page.
 *
 * @param {string[]} ids overlay ids the fetched page renders
 */
function overlaysLoaded(ids) {
  try {
    if (!Array.isArray(ids)) return;
    for (const raw of ids) {
      const id = cleanSlug(raw, 32);
      if (!id) continue;
      const row = overlayRow(id);
      row.obsLoads = Math.min(100000, row.obsLoads + 1);
    }
    dirty = true;
  } catch {
    /* as above */
  }
}

/**
 * Record seconds the in-game layer was on screen carrying these overlays.
 *
 * @param {string[]} ids     overlay ids in the layer's set
 * @param {number}   seconds elapsed since the last report
 */
function overlaysOnScreen(ids, seconds) {
  try {
    if (!Array.isArray(ids)) return;
    const secs = Math.min(86400, Math.max(0, Math.round(Number(seconds) || 0)));
    if (!secs) return;
    for (const raw of ids) {
      const id = cleanSlug(raw, 32);
      if (!id) continue;
      const row = overlayRow(id);
      row.enabled = true;
      row.ingameSeconds = Math.min(86400, row.ingameSeconds + secs);
    }
    dirty = true;
  } catch {
    /* as above */
  }
}

/* -------------------------------------------------------------------------- */
/*  Disk                                                                      */
/* -------------------------------------------------------------------------- */

function load() {
  ledger = Object.create(null);
  sent = Object.create(null);
  if (!storePath) return;
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (raw && typeof raw.days === 'object' && raw.days) {
      for (const [day, b] of Object.entries(raw.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !b || typeof b !== 'object') continue;
        const dest = bucket(day);
        for (const [slug, row] of Object.entries(b.features || {})) {
          if (!row || typeof row !== 'object') continue;
          dest.features[slug] = {
            uses: Math.max(0, Number(row.uses) || 0),
            seconds: Math.max(0, Number(row.seconds) || 0),
          };
        }
        for (const [id, row] of Object.entries(b.overlays || {})) {
          if (!row || typeof row !== 'object') continue;
          dest.overlays[id] = {
            enabled: !!row.enabled,
            obsLoads: Math.max(0, Number(row.obsLoads) || 0),
            ingameSeconds: Math.max(0, Number(row.ingameSeconds) || 0),
          };
        }
      }
    }
    if (raw && typeof raw.sent === 'object' && raw.sent) {
      for (const [day, sig] of Object.entries(raw.sent)) {
        if (typeof sig === 'string') sent[day] = sig;
      }
    }
  } catch {
    // Missing on a fresh install, and unreadable if a crash caught a write
    // mid-flight. Both mean the same thing: start the week again. Counters are
    // not accounts — losing a few is better than refusing to count.
  }
  prune();
}

/**
 * Write the ledger out. Atomic (tmp + rename) because this file is rewritten
 * every five minutes for the life of the app, which is a lot of chances for a
 * power cut to land mid-write and leave half a JSON document behind.
 */
function save() {
  if (!storePath) return false;
  try {
    prune();
    const body = JSON.stringify({ version: 1, days: ledger, sent }, null, 2);
    const tmp = `${storePath}.tmp`;
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, storePath);
    dirty = false;
    return true;
  } catch (err) {
    console.error('[usage] could not save counters:', err.message);
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Upload                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A stable fingerprint of one day's counters. Two runs with the same numbers
 * produce the same string, so an idle app offers nothing rather than re-sending
 * the identical batch every five minutes for an evening.
 *
 * Exported for the test, which is the only way to prove "unchanged means no
 * request" without watching the network.
 */
function signature(day) {
  const b = ledger[day];
  if (!b) return '';
  const feats = Object.keys(b.features)
    .sort()
    .map((k) => `${k}:${b.features[k].uses}/${b.features[k].seconds}`)
    .join(',');
  const overs = Object.keys(b.overlays)
    .sort()
    .map((k) => {
      const r = b.overlays[k];
      return `${k}:${r.enabled ? 1 : 0}/${r.obsLoads}/${r.ingameSeconds}`;
    })
    .join(',');
  return `${feats}|${overs}`;
}

/** The wire shape submit_feature_usage takes: one array for the whole day. */
function featureRows(day) {
  const b = ledger[day];
  if (!b) return [];
  return Object.entries(b.features)
    .filter(([, r]) => r.uses > 0 || r.seconds > 0)
    .map(([feature, r]) => ({ feature, uses: r.uses, seconds: r.seconds }));
}

/** The wire shape submit_overlay_usage takes. */
function overlayRows(day) {
  const b = ledger[day];
  if (!b) return [];
  return Object.entries(b.overlays)
    .filter(([, r]) => r.enabled || r.obsLoads > 0 || r.ingameSeconds > 0)
    .map(([overlay, r]) => ({
      overlay,
      enabled: !!r.enabled,
      obsLoads: r.obsLoads,
      ingameSeconds: r.ingameSeconds,
    }));
}

/**
 * Offer every changed day to the cloud, oldest first.
 *
 * Never throws and never rejects. Signed-out is a state, not an error: the next
 * flush tries again, and the counters carry on accruing on disk meanwhile —
 * which is why a driver who signs in on Friday still contributes their week.
 *
 * @returns {Promise<{sent:number, skipped:number, signedOut?:boolean, error?:string}>}
 */
async function flush({ reason = 'timer' } = {}) {
  if (dirty) save();
  if (!auth || typeof auth.rpc !== 'function') return { sent: 0, skipped: 0, error: 'not-initialised' };

  let count = 0;
  let skipped = 0;
  let signedOut = false;
  let error = null;

  for (const day of Object.keys(ledger).sort()) {
    const sig = signature(day);
    if (!sig || sent[day] === sig) {
      skipped += 1;
      continue;
    }
    const features = featureRows(day);
    const overlays = overlayRows(day);
    if (!features.length && !overlays.length) {
      skipped += 1;
      continue;
    }

    // Both halves must land before the day is marked sent: marking it on a
    // half-success would strand whichever half failed until the counters
    // happened to change again.
    let ok = true;
    if (features.length) {
      const res = await auth.rpc('submit_feature_usage', {
        p_day: day,
        p_app_version: appVersion,
        p_rows: features,
      });
      if (!res.ok) {
        ok = false;
        if (res.signedOut) signedOut = true;
        else error = res.error || 'failed';
      }
    }
    if (ok && overlays.length) {
      const res = await auth.rpc('submit_overlay_usage', { p_day: day, p_rows: overlays });
      if (!res.ok) {
        ok = false;
        if (res.signedOut) signedOut = true;
        else error = res.error || 'failed';
      }
    }

    if (!ok) {
      // Signed out means every remaining day will fail the same way; anything
      // else is likely transient but still not worth hammering. Either way,
      // stop and try the whole backlog again next flush.
      break;
    }
    sent[day] = sig;
    count += 1;
  }

  if (count) {
    save();
    console.log(`[usage] ${count} day(s) of feature counters uploaded (${reason})`);
  }
  return { sent: count, skipped, signedOut: signedOut || undefined, error: error || undefined };
}

/* -------------------------------------------------------------------------- */
/*  Lifecycle                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Start counting. Loads whatever last week left behind, then flushes on a timer.
 *
 * @param opts.userDataDir where `usage-counters.json` lives
 * @param opts.auth        the auth module (injected for headless tests)
 * @param opts.appVersion  stamped onto each upload
 */
function init(opts = {}) {
  storePath = opts.userDataDir ? path.join(opts.userDataDir, 'usage-counters.json') : null;
  auth = opts.auth || null;
  appVersion = opts.appVersion || '';
  load();

  stop();
  timer = setInterval(() => void flush({ reason: 'timer' }), FLUSH_MS);
  // Must not hold the app open at quit.
  if (timer.unref) timer.unref();
}

/** Stop the timer. Safe to call when it was never started. */
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Last call before the app closes: persist the counters synchronously. The
 * upload is NOT attempted here — quit is not the place for a network round
 * trip, and the next launch offers the same day again for free.
 */
function shutdown() {
  stop();
  if (dirty) save();
}

module.exports = {
  init,
  stop,
  shutdown,
  flush,
  feature,
  overlaysEnabled,
  overlaysLoaded,
  overlaysOnScreen,
  // Exposed for scripts/test-usage.js only.
  _internals: {
    today,
    signature,
    featureRows,
    overlayRows,
    load,
    save,
    ledger: () => ledger,
    sent: () => sent,
  },
};
