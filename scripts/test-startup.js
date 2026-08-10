/**
 * scripts/test-startup.js — auto-launch, and where a launch puts the window.
 * -----------------------------------------------------------------------------
 * Both rules in electron/startup.js fail somewhere nobody is looking:
 *
 *   - A bad Run-key entry does nothing at all today. It shows up at the next
 *     reboot, on someone else's machine, as an app that either never comes back
 *     or comes back as a blank Electron window.
 *   - A bad start mode leaves a running process with no window and no tray
 *     icon — reachable only through Task Manager.
 *
 * Neither is visible in a screenshot or a typecheck, so the rules are asserted
 * directly here. Everything is pure: no Electron, no registry, no window.
 *
 * Run: node scripts/test-startup.js
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const startup = require('../electron/startup');

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

const EXE = 'C:\\Program Files\\Apex Overlay System\\Apex Overlay System.exe';

/* -------------------------------------------------------------------------- */
console.log('\nwantsHiddenStart — did Windows start us, or did a person?');
/* -------------------------------------------------------------------------- */

check('the login item is recognised', startup.wantsHiddenStart([EXE, '--hidden']) === true);
check('a plain launch is not', startup.wantsHiddenStart([EXE]) === false);
check('argument order does not matter', startup.wantsHiddenStart(['--hidden', EXE]) === true);
check('whitespace survives the shell', startup.wantsHiddenStart([EXE, ' --hidden ']) === true);
// Every one of these resolves towards SHOWING the window, which is the safe
// direction: a spurious hidden start is an app the operator cannot find.
check('a lookalike flag is not it', startup.wantsHiddenStart([EXE, '--hidden-extra']) === false);
check('a bare word is not a flag', startup.wantsHiddenStart([EXE, 'hidden']) === false);
check('no argv at all is a normal launch', startup.wantsHiddenStart(undefined) === false);
check('a non-array is a normal launch', startup.wantsHiddenStart('--hidden') === false);

/* -------------------------------------------------------------------------- */
console.log('\nloginItemSettingsFor — what gets written into the Run key');
/* -------------------------------------------------------------------------- */

{
  const on = startup.loginItemSettingsFor({ enabled: true, execPath: EXE, isPackaged: true });
  check('enabling opens at login', on.openAtLogin === true);
  check('it points at this exe', on.path === EXE);
  check('and it starts hidden', on.args.includes('--hidden'), 'no window thrown at boot');

  const off = startup.loginItemSettingsFor({ enabled: false, execPath: EXE, isPackaged: true });
  check('disabling closes it', off.openAtLogin === false);
  // Electron matches the entry it REMOVES against these; a disable that
  // identified nothing would leave the app auto-starting with the switch off.
  check('disabling still names the exe', off.path === EXE, 'so the right entry is removed');
  check('disabling still names the args', off.args.includes('--hidden'));
}

// The one case that must write nothing: an unpackaged run's execPath is
// electron.exe, and registering that gives the developer a blank grey window
// every boot for the rest of the machine's life.
check(
  'a dev run is never registered',
  startup.loginItemSettingsFor({ enabled: true, execPath: EXE, isPackaged: false }) === null,
  'electron.exe must never reach the Run key',
);
check(
  'no exe path is never registered',
  startup.loginItemSettingsFor({ enabled: true, execPath: '', isPackaged: true }) === null,
);
check('no arguments at all is refused', startup.loginItemSettingsFor() === null);

/* -------------------------------------------------------------------------- */
console.log('\ninitialWindowMode — where this launch opens');
/* -------------------------------------------------------------------------- */

const mode = (argv, minimizeToTray) => startup.initialWindowMode({ argv, minimizeToTray });

check('a double-click opens maximised', mode([EXE], true) === 'maximized');
check('...whatever the tray setting says', mode([EXE], false) === 'maximized');
check('a boot with the tray on goes to the tray', mode([EXE, '--hidden'], true) === 'tray');
// The case that would otherwise strand the app: started by Windows, hidden, and
// no tray icon to get it back. It goes to the taskbar instead.
check(
  'a boot with the tray OFF goes to the taskbar',
  mode([EXE, '--hidden'], false) === 'minimized',
  'never hidden with no way back',
);
check('every mode is one of the three', ['maximized', 'tray', 'minimized'].includes(mode([], true)));

/* -------------------------------------------------------------------------- */
console.log('\nWiring — main.js uses these rules rather than its own copy');
/* -------------------------------------------------------------------------- */

{
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  check('main.js requires the module', /require\((['"])\.\/startup\1\)/.test(src));
  check('and asks it for the window mode', /startup\.initialWindowMode\(/.test(src));
  check('and asks it what to register', /startup\.loginItemSettingsFor\(/.test(src));
  // The whole point of minimise-to-tray is that nothing stops working while the
  // window is away; Chromium throttles a hidden renderer's timers to 1/minute
  // unless this is set.
  check(
    'the panel is not throttled while hidden',
    /backgroundThrottling:\s*false/.test(src.slice(src.indexOf('function createWindow'))),
    'the tray must not slow the app down',
  );
  // Two copies of the app cannot share the server port; with a tray icon the
  // second launch is otherwise invisible and just reports the port as busy.
  check('a second launch is handed to the running copy', /requestSingleInstanceLock\(\)/.test(src));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
