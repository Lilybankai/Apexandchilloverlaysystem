'use strict';

/**
 * changelog.js — reads CHANGELOG.md and turns it into something the control
 * panel can draw.
 *
 * The release notes already exist, hand-written, in CHANGELOG.md at the repo
 * root. Rather than keep a second copy for the app (which would drift, and
 * would need a network round-trip to read), the file itself is shipped inside
 * the package and parsed here. That means "what's new" works offline, appears
 * the instant the updated app opens, and can never disagree with the release.
 *
 * The markdown is parsed to a block tree in the MAIN process on purpose: the
 * renderer runs under a strict CSP with no markdown library, and building the
 * DOM from typed blocks means no HTML string ever crosses the IPC boundary.
 *
 * Only the subset of markdown this changelog actually uses is supported —
 * `###` headings, bullet lists (nested one level), paragraphs, and inline
 * bold / code / links. There are no code fences or tables in the file, and a
 * line that isn't recognised falls through as plain text rather than vanishing.
 */

const fs = require('node:fs');
const path = require('node:path');

/** `## 0.55.0 — 2026-08-03`, with the date optional (the oldest entries lack one). */
const VERSION_HEADING = /^##\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*(?:[—–-]\s*(.*))?$/;

/* -------------------------------------------------------------------------- */
/*  Version comparison                                                         */
/* -------------------------------------------------------------------------- */

/** Split `1.2.3-beta.1` into numeric parts plus the prerelease tag. */
function splitVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

/**
 * Compare two semver-ish strings: -1 / 0 / 1. A prerelease sorts BEFORE its
 * release (0.9.0-rc.1 < 0.9.0), which is what electron-updater does too.
 * Unparseable input sorts last so a malformed heading can never be mistaken
 * for the newest release.
 */
function compareVersions(a, b) {
  const A = splitVersion(a);
  const B = splitVersion(b);
  if (!A && !B) return 0;
  if (!A) return -1;
  if (!B) return 1;
  for (const k of ['major', 'minor', 'patch']) {
    if (A[k] !== B[k]) return A[k] < B[k] ? -1 : 1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1; // release beats its own prerelease
  if (!B.pre) return -1;
  return A.pre < B.pre ? -1 : 1;
}

/* -------------------------------------------------------------------------- */
/*  Inline markdown                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Split one line of prose into typed spans: `**bold**`, `*italic*`,
 * `` `code` ``, `[text](url)` and plain text. Returns `[{ t, s, href? }]`.
 */
function parseInline(text) {
  const spans = [];
  const src = String(text);
  // One pass, one regex — whichever construct starts first wins, so a `code`
  // span containing asterisks is not mangled by the bold rule and vice versa.
  // Bold is listed before italic so `**x**` is never read as two italics.
  const re = /\*\*([\s\S]+?)\*\*|\*([^*\n]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) spans.push({ t: 'text', s: src.slice(last, m.index) });
    if (m[1] !== undefined) spans.push({ t: 'b', s: m[1] });
    else if (m[2] !== undefined) spans.push({ t: 'i', s: m[2] });
    else if (m[3] !== undefined) spans.push({ t: 'code', s: m[3] });
    else spans.push({ t: 'link', s: m[4], href: m[5] });
    last = m.index + m[0].length;
  }
  if (last < src.length) spans.push({ t: 'text', s: src.slice(last) });
  return spans.length ? spans : [{ t: 'text', s: '' }];
}

/* -------------------------------------------------------------------------- */
/*  Block markdown                                                             */
/* -------------------------------------------------------------------------- */

/** Leading-space count, tabs counted as two (the file uses spaces throughout). */
function indentOf(line) {
  const m = /^[ \t]*/.exec(line)[0];
  let n = 0;
  for (const ch of m) n += ch === '\t' ? 2 : 1;
  return n;
}

const BULLET = /^[-*]\s+/;

/**
 * Parse a run of lines into blocks:
 *   { type: 'heading', text }
 *   { type: 'para',   spans }
 *   { type: 'item',   body: [blocks] }   ← a bullet; its body can hold
 *                                          paragraphs and nested items
 *
 * A bullet owns every following line indented at least two spaces (its
 * continuation paragraphs and sub-bullets), which is dedented and parsed
 * recursively. That is how the long multi-paragraph entries in this changelog
 * are written, so it has to be the default rather than a special case.
 */
function parseBlocks(lines) {
  const blocks = [];
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'para', spans: parseInline(paragraph.join(' ').trim()) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (/^#{3,6}\s+/.test(trimmed)) {
      flushParagraph();
      blocks.push({ type: 'heading', text: trimmed.replace(/^#{3,6}\s+/, '') });
      continue;
    }

    if (indentOf(line) === 0 && BULLET.test(trimmed)) {
      flushParagraph();
      // Gather this bullet's own text plus everything indented beneath it.
      const owned = [trimmed.replace(BULLET, '')];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const next = lines[j];
        if (!next.trim()) {
          // A blank line only ends the bullet if what follows is un-indented.
          const after = lines[j + 1];
          if (after === undefined || (after.trim() && indentOf(after) === 0)) break;
          owned.push('');
          continue;
        }
        if (indentOf(next) < 2) break;
        owned.push(next.slice(2));
      }
      i = j - 1;
      blocks.push({ type: 'item', body: parseBlocks(owned) });
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  return blocks;
}

/* -------------------------------------------------------------------------- */
/*  Whole-file parsing                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Parse CHANGELOG.md into `[{ version, date, blocks }]`, newest first (the
 * order the file is written in is preserved, not re-sorted — the file is the
 * record). Anything above the first version heading is ignored.
 */
function parseChangelog(text) {
  const lines = String(text || '').split(/\r?\n/);
  const entries = [];
  let current = null;
  let buffer = [];

  const flush = () => {
    if (current) {
      current.blocks = parseBlocks(buffer);
      entries.push(current);
    }
    buffer = [];
  };

  for (const line of lines) {
    const m = VERSION_HEADING.exec(line.trim());
    if (m) {
      flush();
      current = { version: m[1], date: (m[2] || '').trim(), blocks: [] };
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return entries;
}

/** The entry for one exact version, or null. */
function findEntry(entries, version) {
  return entries.find((e) => compareVersions(e.version, version) === 0) || null;
}

/**
 * Everything released after `fromVersion` up to and including `toVersion` —
 * i.e. exactly what a driver missed while they were on the old build. Both
 * bounds are optional: with no `fromVersion` you get everything up to `to`.
 */
function entriesSince(entries, fromVersion, toVersion) {
  return entries.filter((e) => {
    if (fromVersion && compareVersions(e.version, fromVersion) <= 0) return false;
    if (toVersion && compareVersions(e.version, toVersion) > 0) return false;
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/*  Loading from disk                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Where CHANGELOG.md lives. `app.getAppPath()` is the repo root in a dev run
 * and the asar root in a packaged one, and the file is listed in
 * `build.files`, so the same join works for both. The extra candidates cover
 * running this module from a script (tests) where no app path is passed.
 */
function candidatePaths(appPath) {
  const out = [];
  if (appPath) out.push(path.join(appPath, 'CHANGELOG.md'));
  out.push(path.join(__dirname, '..', 'CHANGELOG.md'));
  out.push(path.join(process.cwd(), 'CHANGELOG.md'));
  return out;
}

let cache = null;

/**
 * Read + parse the changelog once per run. A missing or unreadable file is not
 * an error worth surfacing — the app simply has no notes to show, and the
 * panel hides the whole feature rather than reporting a failure the driver can
 * do nothing about.
 */
function loadEntries(appPath) {
  if (cache) return cache;
  for (const p of candidatePaths(appPath)) {
    try {
      const text = fs.readFileSync(p, 'utf8');
      const entries = parseChangelog(text);
      if (entries.length) {
        cache = entries;
        return cache;
      }
    } catch {
      /* try the next candidate */
    }
  }
  cache = [];
  return cache;
}

/** Drop the cache (tests, and a dev run editing the file). */
function reset() {
  cache = null;
}

module.exports = {
  compareVersions,
  entriesSince,
  findEntry,
  loadEntries,
  parseChangelog,
  parseInline,
  reset,
};
