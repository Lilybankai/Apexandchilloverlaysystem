/**
 * scripts/fetch-reference-times.js — bake Ohne Speed's reference lap times into
 * a data file the app ships.
 * -----------------------------------------------------------------------------
 * Source: **Ohne Speed's LMU laptimes spreadsheet**, a community reference that
 * publishes, per track layout and per class, the pace an alien runs and the
 * 101–107% ladder underneath it. Times contributed by beAlien, Go and Hymo.
 * Everything the scoring feature does rests on their work; see CREDIT below,
 * which is copied into the generated file and shown in the app.
 *
 *   Sheet:    https://docs.google.com/spreadsheets/d/e/2PACX-1vTN03UvJDm99byA6vQPZHKOCYVvfxLu1zkJAzdaKyROykzEKY2-Xl1rl1q5znZEf36m88dxMKsY2eaO/pubhtml
 *   Discord:  https://discord.com/invite/dFAqhnuSXH
 *   YouTube:  https://www.youtube.com/@ohne_speed
 *
 * ## Why this is a build step and not a runtime fetch
 * The obvious alternative is to pull the sheet when the app starts. Three
 * reasons not to:
 *
 *   - **The control panel cannot.** Its CSP is `script-src 'self'` with no
 *     remote fetch, so a live pull would have to be proxied through the main
 *     process for a table that changes on a game patch, not on a lap.
 *   - **Offline has to work.** The lap database was built local-first precisely
 *     so a race weekend with the router down still counts; a score that vanishes
 *     when the wifi does would be the one part of that card that doesn't.
 *   - **Failure modes.** If the sheet is reshaped or unpublished, a baked file
 *     goes stale — which is visible and survivable. A live fetch goes blank.
 *
 * So: run this after an LMU patch, commit the result.
 *
 *   node scripts/fetch-reference-times.js            # fetch and write
 *   node scripts/fetch-reference-times.js --check    # fetch, diff, write nothing
 *   node scripts/fetch-reference-times.js --from x.csv
 *
 * ## It fails loudly on purpose
 * Every sheet row must land on a layout in `reference-tracks.js`, and every
 * layout must receive rows. A renamed track ("Fuji (chicane)" → "Fuji GP") would
 * otherwise silently drop a circuit from the feature, and nobody would notice
 * until a driver asked why Fuji never scores.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const { BANDS, CLASSES, CIRCUITS } = require('./reference-tracks');

const SHEET_ID =
  '2PACX-1vTN03UvJDm99byA6vQPZHKOCYVvfxLu1zkJAzdaKyROykzEKY2-Xl1rl1q5znZEf36m88dxMKsY2eaO';
const CSV_URL = `https://docs.google.com/spreadsheets/d/e/${SHEET_ID}/pub?output=csv`;

/** Attribution, copied verbatim into the generated file and rendered in the UI. */
const CREDIT = {
  title: "Ohne Speed's LMU laptimes spreadsheet",
  author: 'Ohne Speed',
  contributors: ['beAlien', 'Go', 'Hymo'],
  sheetUrl: `https://docs.google.com/spreadsheets/d/e/${SHEET_ID}/pubhtml`,
  discordUrl: 'https://discord.com/invite/dFAqhnuSXH',
  youtubeUrl: 'https://www.youtube.com/@ohne_speed',
  note:
    'Reference lap times and the Alien→Offline band labels are Ohne Speed\'s work, ' +
    'used with credit. Apex Overlay System only reads them.',
};

const OUT = path.join(__dirname, '..', 'overlay', 'js', 'data', 'reference-times.json');

/* -------------------------------------------------------------------------- */
/*  Fetch                                                                     */
/* -------------------------------------------------------------------------- */

/** GET a URL as text, following the redirect Google's publish endpoint issues. */
function get(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('too many redirects'));
    https
      .get(url, { headers: { 'user-agent': 'apex-overlay-system/reference-times' } }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve(get(new URL(res.headers.location, url).toString(), hops + 1));
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${status} from ${url}`));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

/* -------------------------------------------------------------------------- */
/*  Parsing                                                                   */
/* -------------------------------------------------------------------------- */

/** Minimal RFC 4180 reader — quoted fields, escaped quotes, embedded newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** `"1:58.50"` / `"0:53.05"` → milliseconds. `0` when the cell is not a time. */
function timeToMs(raw) {
  const m = /^(\d+):([0-5]?\d)(?:\.(\d{1,3}))?$/.exec(String(raw || '').trim());
  if (!m) return 0;
  const frac = (m[3] || '0').padEnd(3, '0');
  return (Number(m[1]) * 60 + Number(m[2])) * 1000 + Number(frac);
}

/* -------------------------------------------------------------------------- */
/*  Extraction                                                                */
/* -------------------------------------------------------------------------- */

/** Every sheet class name we know how to place, e.g. `LMGT3`, `LMP2wec`. */
const SHEET_CLASSES = new Set(
  Object.values(CLASSES).flatMap((c) => c.sheet),
);

/**
 * Locate the header row and the columns we read off it.
 *
 * Resolved by NAME rather than by fixed index: the sheet carries several banner
 * rows above the table and a couple of unlabelled helper columns inside it, and
 * both have moved before. A hard-coded index would keep parsing happily and put
 * the 101% column's times in the 100% slot.
 */
function locateColumns(rows) {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const idx = (label) => row.findIndex((c) => c.trim() === label);
    const track = idx('Track');
    const race = idx('~100%');
    if (track < 0 || race < 0) continue;
    const cols = {
      headerRow: i,
      track,
      race,
      patch: idx('Patch'),
      hotlap: idx('Class avgW'),
      fastestCar: idx('Fastest car'),
      fastestTime: idx('Laptime'),
    };
    for (const [name, at] of Object.entries(cols)) {
      if (at < 0) throw new Error(`sheet header is missing the "${name}" column`);
    }
    return cols;
  }
  throw new Error('could not find the header row (no "Track" + "~100%" row)');
}

/**
 * The class cell sits past `Best/Avg` in an unlabelled column, so it is found by
 * VALUE — the first cell holding a class name we recognise. Scanning for the
 * value rather than trusting a position means an inserted column cannot quietly
 * shift every row onto the wrong class.
 */
function classOf(row, after) {
  for (let i = after; i < row.length; i++) {
    const v = row[i].trim();
    if (SHEET_CLASSES.has(v)) return v;
  }
  return '';
}

/** Free-text notes from the banner rows above the table (best effort). */
function readBanner(rows, headerRow) {
  let updated = '';
  for (let i = 0; i < headerRow; i++) {
    for (const cell of rows[i]) {
      const m = /Last updated:\s*(.+)$/i.exec(cell.trim());
      if (m) updated = m[1].trim();
    }
  }
  return updated;
}

/* -------------------------------------------------------------------------- */
/*  Build                                                                     */
/* -------------------------------------------------------------------------- */

function build(csv) {
  const rows = parseCsv(csv);
  const cols = locateColumns(rows);
  const sheetUpdated = readBanner(rows, cols.headerRow);

  /** Sheet track label → { circuitId, layoutId }. */
  const byLabel = new Map();
  for (const circuit of CIRCUITS) {
    for (const layout of circuit.layouts) {
      if (byLabel.has(layout.sheet)) {
        throw new Error(`two layouts claim the sheet label "${layout.sheet}"`);
      }
      byLabel.set(layout.sheet, { circuitId: circuit.id, layoutId: layout.id });
    }
  }

  /** layoutId → sheetClass → entry. */
  const times = {};
  const unplaced = new Set();
  const skipped = [];
  let placed = 0;

  for (let i = cols.headerRow + 1; i < rows.length; i++) {
    const row = rows[i];
    const label = (row[cols.track] || '').trim();
    if (!label) continue;
    const sheetClass = classOf(row, cols.fastestTime + 1);
    if (!sheetClass) continue;

    const hit = byLabel.get(label);
    if (!hit) {
      unplaced.add(label);
      continue;
    }

    const raceMs = timeToMs(row[cols.race]);
    if (!raceMs) {
      // A `#DIV/0!` or blank cell means the sheet has no data for that combo
      // yet. Skipping is right — an entry with no baseline cannot score, and a
      // zero would score everything as infinitely slow.
      skipped.push(`${label} / ${sheetClass}`);
      continue;
    }

    const entry = { raceMs };
    const hotlapMs = timeToMs(row[cols.hotlap]);
    if (hotlapMs) entry.hotlapMs = hotlapMs;
    const fastestMs = timeToMs(row[cols.fastestTime]);
    if (fastestMs) entry.fastestMs = fastestMs;
    const car = (row[cols.fastestCar] || '').trim();
    if (car) entry.fastestCar = car;
    const patch = (row[cols.patch] || '').trim();
    if (patch) entry.patch = patch;

    (times[hit.layoutId] ||= {})[sheetClass] = entry;
    placed++;
  }

  if (unplaced.size) {
    throw new Error(
      `the sheet has ${unplaced.size} track label(s) that reference-tracks.js does not map:\n` +
        [...unplaced].map((l) => `  - ${l}`).join('\n') +
        '\nAdd them (or fix a rename) rather than letting the circuit drop out.',
    );
  }

  const empty = [];
  for (const circuit of CIRCUITS) {
    for (const layout of circuit.layouts) {
      if (!times[layout.id]) empty.push(`${layout.id} ("${layout.sheet}")`);
    }
  }
  if (empty.length) {
    throw new Error(
      `these mapped layouts got no rows — the sheet label has probably changed:\n` +
        empty.map((l) => `  - ${l}`).join('\n'),
    );
  }

  return {
    doc: {
      what: 'Reference lap times per track layout and class, and the pace bands over them.',
      credit: CREDIT,
      sheetUpdated,
      generatedAt: new Date().toISOString(),
      generatedBy: 'scripts/fetch-reference-times.js',
      warning: 'Generated file — edit reference-tracks.js and re-run, never this.',
    },
    bands: BANDS.map((b) => ({
      ...b,
      // JSON has no Infinity; the runtime treats a null ceiling as "and above".
      maxPercent: Number.isFinite(b.maxPercent) ? b.maxPercent : null,
    })),
    classes: CLASSES,
    circuits: CIRCUITS,
    times,
    stats: { placed, skipped: skipped.length },
    skipped,
  };
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                      */
/* -------------------------------------------------------------------------- */

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const fromIdx = args.indexOf('--from');
  const fromFile = fromIdx >= 0 ? args[fromIdx + 1] : null;

  const csv = fromFile
    ? fs.readFileSync(fromFile, 'utf8')
    : await get(CSV_URL);

  const data = build(csv);
  const json = `${JSON.stringify(data, null, 2)}\n`;

  const layouts = Object.keys(data.times).length;
  console.log(
    `Ohne Speed's sheet: ${data.stats.placed} entries over ${layouts} layouts` +
      `${data.stats.skipped ? `, ${data.stats.skipped} skipped (no baseline)` : ''}` +
      `${data.doc.sheetUpdated ? ` — sheet updated ${data.doc.sheetUpdated}` : ''}`,
  );
  for (const s of data.skipped) console.log(`  skipped: ${s}`);

  if (checkOnly) {
    let before = '';
    try {
      before = fs.readFileSync(OUT, 'utf8');
    } catch {
      /* first run */
    }
    // `generatedAt` moves every run; compare everything else.
    const strip = (s) => s.replace(/"generatedAt": "[^"]*",?\n/, '');
    const same = strip(before) === strip(json);
    console.log(same ? 'No change.' : 'CHANGED — re-run without --check to write.');
    process.exit(same ? 0 : 1);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json, 'utf8');
  console.log(`Wrote ${path.relative(path.join(__dirname, '..'), OUT)}`);
}

main().catch((err) => {
  console.error(`\nfetch-reference-times failed: ${err.message}\n`);
  process.exit(1);
});
