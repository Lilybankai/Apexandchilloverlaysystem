/**
 * scripts/test-changelog.js — the changelog parser and the "what did I miss"
 * version maths.
 * -----------------------------------------------------------------------------
 * The What's New panel is only as trustworthy as two things:
 *
 *   1. compareVersions / entriesSince — which releases a driver gets shown after
 *      an update. Off by one here and they either re-read notes they have seen
 *      or, worse, silently miss a release. String comparison is the classic way
 *      to get this wrong (0.9.0 > 0.10.0), so it is asserted directly.
 *   2. parseChangelog — the real CHANGELOG.md is prose-heavy: multi-paragraph
 *      bullets, nested bullets, inline bold and code. If the parser drops the
 *      continuation paragraphs the panel shows one-line stubs of entries that
 *      are actually six paragraphs long.
 *
 * The real file is parsed at the end as a fixture, because it is the input that
 * actually matters. No Electron: the module only touches `fs`.
 * Run: node scripts/test-changelog.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cl = require('../electron/changelog');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  }
}

/* -------------------------------------------------------------------------- */
console.log('\ncompareVersions');
/* -------------------------------------------------------------------------- */

{
  const c = cl.compareVersions;
  check('equal versions', c('1.2.3', '1.2.3') === 0);
  check('major wins', c('2.0.0', '1.9.9') === 1);
  check('minor wins', c('0.10.0', '0.9.0') === 1, 'the string-compare trap');
  check('patch wins', c('0.47.2', '0.47.10') === -1);
  check('release beats its prerelease', c('0.9.0', '0.9.0-rc.1') === 1);
  check('prerelease ordering', c('0.9.0-rc.1', '0.9.0-rc.2') === -1);
  // The same string-compare trap the minor/patch cases above cover, one level
  // deeper — and this one actually shipped. Until 0.64.0-beta.10 the prerelease
  // tag was compared whole, as text, so "beta.10" sorted BELOW "beta.9": the
  // newest entry landed second in the file and entriesSince dropped it, which
  // is a What's New panel with nothing in it for everyone updating from beta.9.
  check('beta ordering is numeric, not textual', c('0.64.0-beta.10', '0.64.0-beta.9') === 1);
  check('…and the reverse', c('0.64.0-beta.9', '0.64.0-beta.10') === -1);
  check('two-digit betas keep ordering', c('0.64.0-beta.11', '0.64.0-beta.10') === 1);
  check('a bare tag sorts below a numbered one', c('1.0.0-beta', '1.0.0-beta.1') === -1);
  check('numeric identifiers sort below textual', c('1.0.0-1', '1.0.0-alpha') === -1);
  check('identical betas are equal', c('0.64.0-beta.10', '0.64.0-beta.10') === 0);
  check('a release still beats a two-digit beta', c('0.64.0', '0.64.0-beta.10') === 1);
  check('v prefix tolerated', c('v1.0.0', '1.0.0') === 0);
  check('garbage sorts last', c('not-a-version', '0.0.1') === -1);
}

/* -------------------------------------------------------------------------- */

{
  /*
   * The consequence, end to end: the panel a driver sees after updating. This
   * is the assertion the bug above would have failed — compareVersions is only
   * interesting because entriesSince is built on it.
   */
  const entries = cl.parseChangelog(
    [
      '# Changelog',
      '',
      '## 0.64.0-beta.10',
      '',
      '- the newest one',
      '',
      '## 0.64.0-beta.9',
      '',
      '- the one they already have',
      '',
    ].join('\n'),
  );
  const shown = cl.entriesSince(entries, '0.64.0-beta.9', '0.64.0-beta.10');
  check(
    'updating from beta.9 to beta.10 shows beta.10',
    shown.length === 1 && shown[0].version === '0.64.0-beta.10',
    shown.map((e) => e.version).join(',') || 'nothing shown',
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nparseChangelog — structure');
/* -------------------------------------------------------------------------- */

const SAMPLE = [
  '# Changelog',
  '',
  '## 0.3.0 — 2026-01-02',
  '',
  '### Added',
  '',
  '- **A bold lead.** First paragraph of the entry that',
  '  wraps across two source lines.',
  '',
  '  A second paragraph, still part of the same bullet.',
  '',
  '  - a nested bullet',
  '  - another nested bullet',
  '',
  '### Fixed',
  '',
  '- A plain entry with `code` and a [link](https://example.com).',
  '',
  '## 0.2.0',
  '',
  '- Dateless, like the oldest entries in the real file.',
  '',
].join('\n');

const entries = cl.parseChangelog(SAMPLE);

{
  check('two entries found', entries.length === 2, entries.length);
  check('newest first', entries[0].version === '0.3.0' && entries[1].version === '0.2.0');
  check('date captured', entries[0].date === '2026-01-02', entries[0].date);
  check('missing date is empty, not undefined', entries[1].date === '');

  const b = entries[0].blocks;
  const headings = b.filter((x) => x.type === 'heading').map((x) => x.text);
  check('both section headings', headings.join('/') === 'Added/Fixed', headings.join('/'));

  const items = b.filter((x) => x.type === 'item');
  check('two bullets at top level', items.length === 2, items.length);

  const first = items[0].body;
  const paras = first.filter((x) => x.type === 'para');
  check('bullet keeps its continuation paragraph', paras.length === 2, paras.length);
  check(
    'wrapped source lines join into one paragraph',
    paras[0].spans.some((s) => /wraps across two source lines/.test(s.s)),
  );
  const nested = first.filter((x) => x.type === 'item');
  check('nested bullets survive', nested.length === 2, nested.length);
}

/* -------------------------------------------------------------------------- */
console.log('\nparseInline — spans');
/* -------------------------------------------------------------------------- */

{
  const spans = cl.parseInline('A **bold** bit, `code`, and a [link](https://example.com).');
  const types = spans.map((s) => s.t).join(',');
  check('bold / code / link all typed', /b/.test(types) && /code/.test(types) && /link/.test(types), types);
  const link = spans.find((s) => s.t === 'link');
  check('link keeps href and text', link.href === 'https://example.com' && link.s === 'link');
  const bold = spans.find((s) => s.t === 'b');
  check('bold text has markers stripped', bold.s === 'bold', bold.s);
  check('plain text preserved', spans.some((s) => s.t === 'text' && s.s === 'A '));
  // The file emphasises single words with *one* asterisk. Read as literal text
  // those show up as stray asterisks mid-sentence in the panel.
  const em = cl.parseInline('not *where* it is');
  check('single asterisks are italic', em.some((s) => s.t === 'i' && s.s === 'where'), em.length);
  const strong = cl.parseInline('**bold**');
  check('bold is not read as two italics', strong.length === 1 && strong[0].t === 'b', strong[0].t);
  // No HTML ever crosses to the renderer — spans are text, drawn with
  // textContent. A tag in the source must stay literal text.
  const evil = cl.parseInline('<img src=x onerror=alert(1)>');
  check('markup stays inert text', evil.length === 1 && evil[0].t === 'text');
}

/* -------------------------------------------------------------------------- */
console.log('\nentriesSince — what a driver missed');
/* -------------------------------------------------------------------------- */

{
  const list = ['0.5.0', '0.4.1', '0.4.0', '0.3.0'].map((version) => ({ version, blocks: [] }));
  const since = cl.entriesSince(list, '0.4.0', '0.5.0').map((e) => e.version);
  check('excludes the version you were on', !since.includes('0.4.0'), since.join(','));
  check('includes the version you are on now', since.includes('0.5.0'));
  check('includes everything between', since.join(',') === '0.5.0,0.4.1', since.join(','));

  const capped = cl.entriesSince(list, '0.3.0', '0.4.1').map((e) => e.version);
  check('never shows unreleased future entries', capped.join(',') === '0.4.1,0.4.0', capped.join(','));

  const all = cl.entriesSince(list, '', '0.5.0');
  check('no lower bound → everything', all.length === 4, all.length);

  const none = cl.entriesSince(list, '0.5.0', '0.5.0');
  check('already current → nothing to show', none.length === 0, none.length);
}

/* -------------------------------------------------------------------------- */
console.log('\nThe real CHANGELOG.md');
/* -------------------------------------------------------------------------- */

{
  const root = path.join(__dirname, '..');
  const real = cl.parseChangelog(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'));
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

  check('parses into many entries', real.length > 20, real.length);
  check(
    'the shipping version has an entry',
    cl.findEntry(real, version) !== null,
    `package.json is ${version}`,
  );
  // Equal normally; ahead in the window between the feature commit (code +
  // changelog) and the `chore(release)` commit that bumps package.json. Behind
  // would mean a released version with no notes, which is what the release gate
  // in scripts/check-changelog.js refuses outright.
  check(
    'newest entry is at or ahead of the shipping version',
    cl.compareVersions(real[0].version, version) >= 0,
    `newest ${real[0].version}, package ${version}`,
  );

  // Every entry must have something to say — an empty one would render as a
  // bare version number in the panel.
  const empty = real.filter((e) => !e.blocks.length).map((e) => e.version);
  check('no entry is empty', empty.length === 0, empty.join(',') || 'none');

  // The newest entry is the one the panel shows after an update; check it came
  // through with its prose intact rather than as a heading and nothing else.
  const top = real[0].blocks;
  check('newest entry has bullets', top.some((x) => x.type === 'item'));
  const words = JSON.stringify(top).length;
  check('newest entry carries real prose', words > 200, `${words} chars of blocks`);

  // Ordering: the file is written newest-first and entriesSince trusts nothing,
  // but a file that drifted out of order would still be worth knowing about.
  let ordered = true;
  for (let i = 1; i < real.length; i += 1) {
    if (cl.compareVersions(real[i - 1].version, real[i].version) <= 0) ordered = false;
  }
  check('file is in descending version order', ordered);
}

/* -------------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
