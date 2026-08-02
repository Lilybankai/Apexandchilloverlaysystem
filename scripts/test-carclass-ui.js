/**
 * scripts/test-carclass-ui.js — how a car class LOOKS, and what it is called.
 * -----------------------------------------------------------------------------
 * Three widgets draw a class now: the standings tower (a dot and a group
 * header), the radar (a blip) and the relative panel (a lettered tag). They all
 * read `classColor` / `classAbbrev` / `classLabel` out of the shared runtime,
 * because a colour that means GT3 in one panel and something else in the next is
 * worse than no colour at all. This pins that contract.
 *
 * Two things here are load-bearing beyond "the function returns a string":
 *
 *   1. THE THREE-CHARACTER CAP. `.relative__class` in css/overlay.css is a fixed
 *      box sized for three glyphs, so it can hold every driver name on the same
 *      left edge. A four-character tag does not widen it — it clips, or eats the
 *      name beside it. The cap therefore belongs in a test, not in a comment.
 *
 *   2. ALIAS PARITY WITH THE SERVER. `src/telemetry/carClass.ts` collapses the
 *      spellings LMU actually reports ("Hypercar", "LMDh", "GTP", "LMGT3"…) into
 *      canonical labels. The overlay cannot import that file (browser IIFE vs TS
 *      module) and keeps a mirror of the table, so the two are checked against
 *      each other here rather than trusted to stay in step.
 *
 * No test framework in this repo — plain node, run with `npm run test:classui`.
 * client.js is browser-side IIFE script, so it is evaluated against a minimal
 * DOM stub rather than imported (same approach as test-session-headline.js).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/** The smallest DOM client.js will load against; it never paints here. */
function makeElement(tag) {
  return {
    tagName: tag, className: '', textContent: '', innerHTML: '', hidden: false,
    children: [], attrs: {},
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    querySelector() { return null; },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c, on) { on ? this._set.add(c) : this._set.delete(c); },
    },
  };
}

function loadRuntime() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'overlay', 'js', 'client.js'), 'utf8');
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    // "loading" parks the boot path on DOMContentLoaded so nothing opens a
    // socket: this test is about three pure functions.
    document: {
      readyState: 'loading', documentElement: makeElement('html'),
      createElement: makeElement, querySelector: () => null,
      getElementById: () => null, addEventListener: () => {},
    },
    window: { addEventListener: () => {}, location: { search: '', protocol: 'http:' } },
  };
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'client.js' });
  if (!sandbox.window.ApexOverlay) throw new Error('client.js exposed no ApexOverlay');
  return sandbox.window.ApexOverlay;
}

const { classColor, classAbbrev, classLabel } = loadRuntime();

/* -------------------------------------------------------------------------- */

console.log('1) The tag is what a driver already says out loud');
{
  check('hypercar is HY', classAbbrev('HYPERCAR') === 'HY', classAbbrev('HYPERCAR'));
  check('LMP2 is P2', classAbbrev('LMP2') === 'P2', classAbbrev('LMP2'));
  check('LMP3 is P3', classAbbrev('LMP3') === 'P3', classAbbrev('LMP3'));
  check('GT3 keeps its own name', classAbbrev('GT3') === 'GT3', classAbbrev('GT3'));
  check('GTE keeps its own name', classAbbrev('GTE') === 'GTE', classAbbrev('GTE'));
  check('GT4 keeps its own name', classAbbrev('GT4') === 'GT4', classAbbrev('GT4'));
}

console.log('\n2) Every spelling LMU reports lands on the same tag and colour');
{
  // The raw strings carClass.ts documents seeing from the sim and from mods.
  const hyper = ['Hypercar', 'HYPER', 'LMH', 'LMDh', 'GTP', 'P1', 'LMP1'];
  check('every hypercar spelling tags HY',
    hyper.every((s) => classAbbrev(s) === 'HY'),
    hyper.map(classAbbrev).join(','));
  check('…and takes one colour',
    new Set(hyper.map(classColor)).size === 1, classColor('LMDh'));

  const gt3 = ['GT3', 'LMGT3', 'lm-gt3', 'GT3 Pro'];
  check('LMGT3 is GT3, punctuation and case ignored',
    gt3.every((s) => classAbbrev(s) === 'GT3'), gt3.map(classAbbrev).join(','));
  check('…and takes one colour', new Set(gt3.map(classColor)).size === 1, classColor('LMGT3'));

  check('P2/P3 shorthand resolves', classAbbrev('P2') === 'P2' && classAbbrev('P3') === 'P3');
  check('GTE Pro and GTE Am are both GTE',
    classAbbrev('GTE Pro') === 'GTE' && classAbbrev('GTE Am') === 'GTE');
}

console.log('\n3) An unrecognised class is still labelled, never blank');
{
  // A colour with no letters beside it is the puzzle the tag exists to remove,
  // so a mod class gets a derived tag rather than an empty box.
  check('a short first word is used whole', classAbbrev('TCR Cup') === 'TCR', classAbbrev('TCR Cup'));
  check('several words give initials',
    classAbbrev('Porsche Carrera Cup') === 'PCC', classAbbrev('Porsche Carrera Cup'));
  check('one long word is truncated', classAbbrev('Clubsport') === 'CLU', classAbbrev('Clubsport'));
  check('punctuation-only text still yields something',
    classAbbrev('---') === '?', classAbbrev('---'));
  check('no class at all draws no tag', classAbbrev('') === '' && classAbbrev(undefined) === '');
}

console.log('\n4) The three-character cap — the tag box does not grow');
{
  const samples = [
    'HYPERCAR', 'LMP2', 'LMP3', 'GT3', 'GTE', 'GT4', 'LMGT3', 'GTE Pro', 'GTP',
    'TCR Cup', 'Porsche Carrera Cup', 'Clubsport', 'Formula Regional Americas',
    'A', 'ABCDEFGHIJKLMNOP', '2024 GT WORLD CHALLENGE', 'x'.repeat(200),
  ];
  const over = samples.filter((s) => classAbbrev(s).length > 3);
  check('nothing exceeds three characters', over.length === 0,
    over.map((s) => s + '→' + classAbbrev(s)).join(' '));
}

console.log('\n5) A colour is stable, and stable across spellings');
{
  check('the same string gives the same colour twice',
    classColor('TCR Cup') === classColor('TCR Cup'), classColor('TCR Cup'));
  check('an unknown class hashes on its normalised form, so case cannot fork it',
    classColor('TCR Cup') === classColor('tcr-cup'),
    classColor('TCR Cup') + ' vs ' + classColor('tcr-cup'));
  check('every known class has a colour', ['HYPERCAR', 'LMP2', 'LMP3', 'GT3', 'GTE', 'GT4']
    .every((c) => /^#[0-9a-f]{6}$/i.test(classColor(c))));
  check('no class gives the grey reserved for "no class"',
    classColor('GT3') !== '#6b7387' && classColor('') === '#6b7387');
  // Known classes must be distinguishable from each other on screen. GTE and GT4
  // deliberately share amber today — they are never on the same grid in LMU —
  // and this counts the distinct colours so that stays a decision rather than a
  // drift.
  const known = ['HYPERCAR', 'LMP2', 'LMP3', 'GT3', 'GTE', 'GT4'].map(classColor);
  check('five distinct colours across the six known classes',
    new Set(known).size === 5, new Set(known).size + ' distinct');
}

console.log('\n6) The full name, for a group header or a tooltip');
{
  check('aliases collapse to the canonical name',
    classLabel('LMDh') === 'HYPERCAR' && classLabel('LMGT3') === 'GT3',
    classLabel('LMDh') + '/' + classLabel('LMGT3'));
  check('an unknown class keeps its own spacing',
    classLabel('TCR Cup') === 'TCR CUP', classLabel('TCR Cup'));
  check('no class reads as OTHER, not as empty',
    classLabel('') === 'OTHER' && classLabel(undefined) === 'OTHER');
}

console.log('\n7) The overlay table still agrees with the server\'s');
{
  // carClass.ts is the source of truth for which spellings exist; this mirror
  // lives in client.js only because a browser IIFE cannot import a TS module.
  // If a spelling is added there and not here, the overlay silently hashes it to
  // a random colour — which is exactly the bug this catches.
  const ts = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'telemetry', 'carClass.ts'), 'utf8');
  const js = fs.readFileSync(
    path.join(__dirname, '..', 'overlay', 'js', 'client.js'), 'utf8');
  const aliasesOf = (src, start) => {
    // From the opening brace, not the declaration: `const ALIASES: Record<…> = {`
    // otherwise reads as an alias of its own ("ALIASES" → "R"ecord).
    const from = src.indexOf('{', src.indexOf(start));
    const body = src.slice(from, src.indexOf('};', from));
    const out = new Set();
    const re = /([A-Z][A-Z0-9]*)\s*:\s*'?"?([A-Z0-9]+)'?"?/g;
    let m;
    while ((m = re.exec(body))) out.add(m[1] + '=' + m[2]);
    return out;
  };
  const server = aliasesOf(ts, 'const ALIASES');
  const overlay = aliasesOf(js, 'var CLASS_ALIASES');
  const missing = [...server].filter((k) => !overlay.has(k));
  const extra = [...overlay].filter((k) => !server.has(k));
  check('every server alias is known to the overlay', missing.length === 0, missing.join(' '));
  check('and the overlay invents none of its own', extra.length === 0, extra.join(' '));
  check('the tables are not empty (the scrape still finds them)',
    server.size > 10, server.size + ' aliases');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
