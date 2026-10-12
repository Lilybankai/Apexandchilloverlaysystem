/**
 * scripts/test-relay-source-panel.js — the Relay source picker actually RENDERS.
 * -----------------------------------------------------------------------------
 * Same reason as test-engineer-panel.js: 1.3.5 shipped a tab blanked by a
 * module-level TDZ throw that every text-only id test passed. This runs the
 * real electron/control-panel/relay-source.js in a vm against a small fake
 * DOM, feeds it the roster push it consumes (team-cloud's stateForUi shape),
 * and fails on any throw — then checks the list, the selection, the status
 * line, that a change writes the setting, and that it only shows in a team.
 * Last, the placement: the control is in the Team tab (not Settings), hidden
 * by default, and the web pit wall build does not ship its renderer.
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
    hidden: false,
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
  const wrap = el('label');
  wrap.hidden = true; // the markup ships hidden
  const byId = { '#relay-source': select, '#relay-source-status': status, '#team-relay-source': wrap };
  const document = {
    querySelector: (sel) => byId[sel] || null,
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
  return { select, status, wrap, errors, writes, push };
}

(async () => {
  console.log('\nAuto, three-member team');
  {
    const { select, status, wrap, errors, writes, push } = await run(cloudState());
    check('render() runs without throwing', errors.length === 0, errors.map((e) => String(e && e.message)).join(' | ') || 'clean');
    check('shown in a team', wrap.hidden === false);
    check('the full status is on hover too', status.title === status.textContent);
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
    const { select, status, wrap, errors } = await run({ signedIn: false, teams: [], activeTeamId: null });
    check('renders without throwing', errors.length === 0, errors.map((e) => String(e && e.message)).join(' | ') || 'clean');
    check('hidden with no team', wrap.hidden === true);
    check('only Auto and Off', select.children.map((o) => o.value).join(',') === 'auto,off');
    check('disabled, with a sign-in hint', select.disabled === true && /Sign in/.test(status.textContent));
  }

  console.log('\nSigned in, no team yet');
  {
    const { wrap, errors } = await run(cloudState({ teams: [], activeTeamId: null }));
    check('renders without throwing', errors.length === 0, errors.map((e) => String(e && e.message)).join(' | ') || 'clean');
    check('hidden until a team is joined', wrap.hidden === true);
  }

  console.log('\nA bridge that does not know the setting (the web pit wall)');
  {
    const web = cloudState();
    delete web.relaySource;
    delete web.relaySourceEffective;
    delete web.relayStatus;
    const { wrap, errors } = await run(web);
    check('renders without throwing', errors.length === 0, errors.map((e) => String(e && e.message)).join(' | ') || 'clean');
    check('stays hidden even in a team', wrap.hidden === true);
  }

  console.log('\nPlacement');
  {
    const root = path.join(__dirname, '..');
    const html = fs.readFileSync(path.join(root, 'electron', 'control-panel', 'index.html'), 'utf8');
    const at = (needle) => html.indexOf(needle);
    const teamStart = at('<section class="view" data-view="team">');
    const teamEnd = html.indexOf('<section class="view" data-view="', teamStart + 10);
    const pick = at('id="relay-source"');
    check('the picker is on the Team tab', pick > teamStart && pick < teamEnd, `${teamStart} < ${pick} < ${teamEnd}`);
    check('...and only once (gone from Settings)', html.split('id="relay-source"').length === 2);
    check('...in the header strip, beside My car / Team',
      pick > at('id="team-source"') && pick < at('id="team-age"'));
    const wrapTag = /<label[^>]*id="team-relay-source"[^>]*>/.exec(html);
    check('the wrapper ships hidden', !!wrapTag && /\shidden[\s>]/.test(wrapTag[0]));
    const buildWeb = fs.readFileSync(path.join(root, 'scripts', 'build-web.js'), 'utf8');
    check('the web pit wall build does not ship relay-source.js',
      !/relay-source\.js/.test(buildWeb.replace(/\/\/.*$/gm, '')));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
