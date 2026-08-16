/**
 * scripts/test-raster.js — the canvas backing-store scale.
 * -----------------------------------------------------------------------------
 * overlay/js/raster.js decides how many real pixels every canvas widget draws
 * with. It exists because the old answer — `window.devicePixelRatio` — ignored
 * the CSS transform that BOTH rendering paths put the widgets inside:
 *
 *   - the OBS pages scale a fixed 1920x1080 design to the Browser Source size,
 *     so a 4K source magnifies everything by 2;
 *   - the in-game layer scales each widget on its own, up to 3x, which is how a
 *     driver makes the overlay readable on a big screen.
 *
 * Text re-rasterises under a transform and stayed sharp; canvases do not, so the
 * track map, radar and pedal traces were bitmaps blown up to twice their size.
 * It was invisible on the machine it was set up on — at scale 1 nothing is
 * wrong — and only showed up on a big screen or a stream watched back at 4K.
 * That is the whole reason this is pinned here rather than left to be noticed.
 *
 * Two of these tests are the traps the implementation has to keep avoiding:
 *
 *   • the BORDER trap — getBoundingClientRect() measures the border box and
 *     clientWidth excludes the border, so dividing one by the other reports an
 *     untransformed widget as ~1.007x scaled. Every widget here has a 1px
 *     border, so that would mean a permanently odd-sized bitmap on all of them;
 *   • the JITTER trap — callers treat a changed scale as "reallocate the bitmap
 *     and rebake every cache", so a sub-pixel wobble in the measured rectangle
 *     must not reach the result or it becomes an expensive loop mid-race.
 *
 * No test framework in this repo — plain node, run with `npm run test:raster`.
 * raster.js is a browser-side IIFE, so it is evaluated against a minimal window
 * stub rather than imported (same approach as test-ingame-layout.js).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
  if (ok) pass++;
  else fail++;
};

/** Load raster.js into a stubbed window and hand back its export. */
function load(devicePixelRatio) {
  const sandbox = { window: { devicePixelRatio } };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'overlay', 'js', 'raster.js'), 'utf8'),
    sandbox,
  );
  return sandbox.window.ApexRaster;
}

/**
 * A canvas as the DOM reports one: `offsetWidth` is the untransformed border
 * box, and getBoundingClientRect() returns that box with every ancestor
 * transform applied. `border` is what makes clientWidth differ from offsetWidth.
 */
function el({ width = 300, scale = 1, border = 1 }) {
  return {
    offsetWidth: width,
    clientWidth: width - border * 2,
    getBoundingClientRect: () => ({ width: width * scale }),
  };
}

console.log('\nthe backing scale, on an ordinary 1x monitor');
{
  const R = load(1);
  check('untransformed: 1 device pixel per CSS pixel', R.backingScale(el({})) === 1, String(R.backingScale(el({}))));
  check(
    'a widget scaled 2x asks for twice the pixels',
    R.backingScale(el({ scale: 2 })) === 2,
    String(R.backingScale(el({ scale: 2 }))),
  );
  check(
    'a widget scaled 2.5x asks for 2.5x',
    R.backingScale(el({ scale: 2.5 })) === 2.5,
    String(R.backingScale(el({ scale: 2.5 }))),
  );
  check(
    'the OBS 4K case: the 1920 stage doubled to a 3840 source',
    R.backingScale(el({ width: 320, scale: 3840 / 1920 })) === 2,
    String(R.backingScale(el({ width: 320, scale: 2 }))),
  );
  check(
    'the OBS 1440p case: a non-integer stage scale is carried through',
    R.backingScale(el({ width: 320, scale: 2560 / 1920 })) === 1.33,
    String(R.backingScale(el({ width: 320, scale: 2560 / 1920 }))),
  );
}

console.log('\nthe border trap (getBoundingClientRect measures the border box)');
{
  const R = load(1);
  // 300 wide with a 1px border: clientWidth is 298. Dividing rect.width by
  // clientWidth would give 1.01 and allocate an oversized bitmap on every widget
  // in the overlay, forever, with nothing on screen to explain why.
  check(
    'a bordered, untransformed widget is exactly 1x — not 1.01x',
    R.backingScale(el({ width: 300, border: 1 })) === 1,
    String(R.backingScale(el({ width: 300, border: 1 }))),
  );
  check(
    'a thick border does not inflate it either',
    R.backingScale(el({ width: 300, border: 4 })) === 1,
    String(R.backingScale(el({ width: 300, border: 4 }))),
  );
}

console.log('\nthe jitter trap (a changed scale costs a reallocation + a rebake)');
{
  const R = load(1);
  const jittery = {
    offsetWidth: 300,
    clientWidth: 298,
    getBoundingClientRect: () => ({ width: 599.7 }), // 2x, measured imprecisely
  };
  check(
    'a sub-pixel wobble rounds to a stable scale',
    R.backingScale(jittery) === 2,
    String(R.backingScale(jittery)),
  );
  check(
    'the same element measured twice gives the same answer',
    R.backingScale(jittery) === R.backingScale(jittery),
  );
}

console.log('\nthe floor: a widget scaled DOWN keeps full sharpness');
{
  const R = load(1);
  // The widgets draw hairlines and small type in CSS units. Thinning the backing
  // store below 1:1 to save pixels is how those turn to mush, and the saving is
  // not worth the one thing this module exists to protect.
  check('scale 0.5 still allocates 1x', R.backingScale(el({ scale: 0.5 })) === 1, String(R.backingScale(el({ scale: 0.5 }))));
  check('scale 0.4 (the in-game minimum) still allocates 1x', R.backingScale(el({ scale: 0.4 })) === 1);
}

console.log('\nthe ceiling, and high-DPI screens');
{
  const R = load(2);
  check('a 2x screen, untransformed, asks for 2x', R.backingScale(el({})) === 2, String(R.backingScale(el({}))));
  check(
    'a 2x screen with a 1.5x widget asks for 3x',
    R.backingScale(el({ scale: 1.5 })) === 3,
    String(R.backingScale(el({ scale: 1.5 }))),
  );
  // 2x device ratio under the in-game maximum of 3x is an honest 6, and a track
  // map 900 CSS px wide would then rebake a 5400px bitmap on every resize.
  check(
    'the worst case is capped rather than allocated',
    R.backingScale(el({ scale: 3 })) === R.MAX_BACKING,
    String(R.backingScale(el({ scale: 3 })) + ' vs cap ' + R.MAX_BACKING),
  );
  check('the cap is past the point more pixels are visible', R.MAX_BACKING >= 4);
}

console.log('\ndegenerate input falls back rather than throwing');
{
  const R = load(1.5);
  check('no element at all', R.backingScale(null) === 1.5, String(R.backingScale(null)));
  check('not an element', R.backingScale({}) === 1.5, String(R.backingScale({})));
  check(
    'an unlaid-out element (display:none, or before first layout)',
    R.backingScale({ offsetWidth: 0, clientWidth: 0, getBoundingClientRect: () => ({ width: 0 }) }) === 1.5,
  );
  check(
    'a zero-width rectangle',
    R.backingScale({ offsetWidth: 300, clientWidth: 298, getBoundingClientRect: () => ({ width: 0 }) }) === 1.5,
  );
}

console.log('\nevery canvas widget asks raster.js rather than devicePixelRatio');
{
  // The helper only works if the widgets actually use it. These six size a
  // bitmap, and a seventh added later that reaches for devicePixelRatio would
  // silently reintroduce exactly the bug this module fixes.
  const widgets = ['pedals', 'pedalsv', 'motion', 'radar', 'trackmap', 'speedo'];
  for (const name of widgets) {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'overlay', 'js', 'widgets', name + '.js'),
      'utf8',
    );
    check(
      name + '.js sizes its canvas from ApexRaster.backingScale',
      src.includes('ApexRaster.backingScale') && !src.includes('window.devicePixelRatio'),
      src.includes('window.devicePixelRatio') ? 'still reads devicePixelRatio directly' : 'ok',
    );
  }

  // ...and only if every page that hosts them loads it, synchronously, before
  // the deferred widget scripts run.
  for (const page of ['index.html', 'widget.html', 'ingame.html']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'overlay', page), 'utf8');
    const raster = src.indexOf('js/raster.js');
    const firstWidget = src.indexOf('js/widgets/');
    check(
      page + ' loads raster.js before the widgets',
      raster !== -1 && (firstWidget === -1 || raster < firstWidget),
      raster === -1 ? 'not loaded at all' : 'ok',
    );
    check(page + ' loads raster.js synchronously', /raster\.js"\s*>/.test(src));
  }
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
