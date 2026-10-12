/**
 * scripts/test-relay-source-panel.js — the Relay source picker actually RENDERS.
 * -----------------------------------------------------------------------------
 * Same reason as test-engineer-panel.js: 1.3.5 shipped a tab blanked by a
 * module-level TDZ throw that every text-only id test passed. This runs the
 * real electron/control-panel/relay-source.js in a vm against a small fake
 * DOM, feeds it the roster push it consumes (team-cloud's stateForUi shape),
 * and fails on any throw — then checks the list, the selection, the status
 * line, and that a change writes the setting.
 *
 * Run: npm run test:relay-source-panel
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/** Just enough of an element for the picker: children, value, dataset, events. */
function el(tag) {
  const listeners = {};
  return {
    tagName: tag,
    children: [],
    dataset: {},
    value: '',
    textContent: '',
    disabled: false,
    replaceChildren(...kids) {
      this.children = kids;
      // A <select>'s value can only be one of its options.
      if (!kids.some((k) => k.value === this.value)) this.value = kids[0] ? kids[0].value : '';
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    fire(type) {
      return Promise.all((listeners[type] || []).map((fn) => fn({ target: this })));
    },
  };
}

function cloudState(over = {}) {
  return {
    signedIn: true,
    selfUserId: 'u-carl',
    activeTeamId: 't1',
    teams: [{
      id: 't1',
      name: 'Apex',
      members: [
        { user_id: 'u-carl', name: 'Carl Jones' },
        { user_id: 'u-micky', name: 'Micky Blue' },
        { user_id: 'u-scott', name: 'Scott Green' },
      ],
    }],
    relaySource: 'auto',
    relaySourceEffective: { mode: 'auto' },
    relayStatus: { state: 'showing', text: "Showing Micky Blue's telemetry on your overlays.", driverName: 'Micky Blue' },
    ...over,
  };
}

async function run(initial) {
  const select = el('select');
  const status = el('span');
  const document = {
    querySelector: (sel) => (sel === '#relay-source' ? select : sel === '#relay-source-status' ? status : null),
    createElement: (tag) => el(tag),
    activeElement: null,
  };
  const errors = [];
  const writes = [];
  let pushed = null;
  const api = {
    teamCloudState: async () => initial,
    onTeamCloud: (fn) => { pushed = fn; },
    updateSettings: async (patch) => { writes.push(patch); return {}; },
  };
  const context = vm.createContext({ window: { apex: api }, document, console, Promise, setTimeout });
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'control-panel', 'relay-source.js'), 'utf8');
  try {
    vm.runInContext(src, context, { filename: 'relay-source.js' });
  } catch (e) {
    errors.push(e);
  }
  await new Promise((r) => setTimeout(r, 20));
  const push = (state) => {
    try {
      if (pushed) pushed(state);
    } catch (e) {
      errors.push(e);
    }
  };
  return { select, status, errors, writes, push };
}

(async () => {
  console.log('\nAuto, three-member team');
  {
    const { select, status, errors, writes, push } = await run(cloudState());
    check('render() runs without throwing', errors.length === 0, errors.map((e) => String(e && e.message)).join(' | ') || 'clean');
    const values = select.children.map((o) => o.value);
    check('offers Auto, each teammate (not me), and Off',
      JSON.stringify(values) === JSON.stringify(['auto', 'u-micky', 'u-scott', 'off']), values.join(','));
    check('teammates are offered by name', select.children[1].textContent.includes('Micky Blue'));
    check('Auto is selected', select.value === 'auto', select.value);
    check('status shows whose data is on the overlays', /Micky Blue/.test(status.textContent), status.textContent);
    check('enabled when signed in', select.disabled === false);

    select.value = 'u-scott';
    await select.fire('change');
    check('picking a teammate writes the pin', writes.length === 1 && writes[0].relaySource === 'u-scott', JSON.stringify(writes));

    push(cloudState({
      relaySource: 'u-scott',
      relaySourceEffective: { mode: 'pin', pinUserId: 'u-scott', pinName: 'Scott Green' },
      relayStatus: { state: 'not-in-session', text: "Scott isn't in your session — nothing is relayed." },
    }));
    check('a push re-renders without throwing', errors.length === 0);
    check('the pin is shown as selected', select.value === 'u-scott', select.value);
    check('status says the pinned teammate is not in our session',
      /Scott isn't in your session/.test(status.textContent) && status.dataset.state === 'not-in-session', status.textContent);

    select.value = 'off';
    await select.fire('change');
    check('Off writes off', writes[writes.length - 1].relaySource === 'off');
    push(cloudState({
      relaySource: 'off',
      relaySourceEffective: { mode: 'off' },
      relayStatus: { state: 'off', text: "Relay off — teammates' telemetry is never put on your overlays." },
    }));
    check('Off is shown as selected with its status', select.value === 'off' && /Relay off/.test(status.textContent));
  }

  console.log('\nPinned teammate left the team');
  {
    const { select, status, errors } = await run(cloudState({
      teams: [{ id: 't1', members: [{ user_id: 'u-carl', name: 'Carl' }, { user_id: 'u-micky', name: 'Micky Blue' }] }],
      relaySource: 'u-scott',
      relaySourceEffective: { mode: 'auto' },
      relayStatus: { state: 'idle', text: 'Waiting for a teammate to drive your car.' },
    }));
    check('renders without throwing', errors.length === 0, errors.map((e) => String(e && e.message)).join(' | ') || 'clean');
    check('falls back to Auto in the picker', select.value === 'auto', select.value);
    check('and says why', /no longer on this team/.test(status.textContent), status.textContent);
  }

  console.log('\nSigned out, no teams');
  {
    const { select, status, errors } = await run({ signedIn: false, teams: [], activeTeamId: null });
    check('renders without throwing', errors.length === 0, errors.map((e) => String(e && e.message)).join(' | ') || 'clean');
    check('only Auto and Off', select.children.map((o) => o.value).join(',') === 'auto,off');
    check('disabled, with a sign-in hint', select.disabled === true && /Sign in/.test(status.textContent));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
