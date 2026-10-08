/**
 * scripts/test-problemreport.js — what a bug report's logs carry off the machine.
 * -----------------------------------------------------------------------------
 * electron/problemReport.js decides which bytes of stalls.log / updater.log
 * reach Linear. The failures worth catching are quiet ones: a driver's Windows
 * user name (often their real name) left in a path, a whole multi-megabyte
 * updater.log read into main, an attachment that opens halfway through a line,
 * or a missing log turning the whole report into an error.
 *
 * Run: node scripts/test-problemreport.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scrubLog, tailText, collectReportLogs, REPORT_LOGS } = require('../electron/problemReport');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

/* ---- scrubLog ------------------------------------------------------------ */

const HOME = 'C:\\Users\\carla';
{
  const line =
    "2026-10-08T19:44:25.003Z  INFO   New version downloaded to C:\\Users\\carla\\AppData\\Local\\apex-overlay-system-updater\\pending\\x.exe";
  const out = scrubLog(line, HOME);
  check('backslash path scrubbed', !/carla/i.test(out), out);
  check('path kept otherwise', out.includes('C:\\Users\\<user>\\AppData\\Local'), out);
}
{
  const out = scrubLog("unlink 'c:/users/Carla/AppData/x.exe'", HOME);
  check('forward slashes + case scrubbed', out === "unlink 'c:/users/<user>/AppData/x.exe'", out);
}
{
  const out = scrubLog('C:\\Users\\carla', HOME);
  check('path ending at the user name scrubbed', out === 'C:\\Users\\<user>', out);
}
{
  // A different profile that merely starts with the same letters is not ours.
  const out = scrubLog('C:\\Users\\carlana\\x', HOME);
  check('longer user name left alone', out === 'C:\\Users\\carlana\\x', out);
}
{
  const out = scrubLog('signed in as someone.racer+lmu@example.co.uk ok', HOME);
  check('email scrubbed', out === 'signed in as <email> ok', out);
}
{
  const out = scrubLog('a.b (.*) C:\\Users\\a.b\\x', 'C:\\Users\\a.b\\');
  check('regex chars in user name are literal', out === 'a.b (.*) C:\\Users\\<user>\\x', out);
}
check('no home → only emails touched', scrubLog('C:\\Users\\carla\\x', '') === 'C:\\Users\\carla\\x');

/* ---- tailText ------------------------------------------------------------ */

{
  const buf = Buffer.from('short\nlog\n');
  const t = tailText(buf, 1024);
  check('small file whole', t.text === 'short\nlog\n' && t.truncated === false);
}
{
  const lines = Array.from({ length: 100 }, (_, i) => `line ${String(i).padStart(3, '0')} xxxxxxxx`);
  const buf = Buffer.from(lines.join('\n') + '\n');
  const t = tailText(buf, 200);
  check('tail truncated flag', t.truncated === true);
  check('tail within cap', Buffer.byteLength(t.text) <= 200, String(Buffer.byteLength(t.text)));
  check('tail starts on a whole line', /^line \d{3} x{8}\n/.test(t.text), JSON.stringify(t.text.slice(0, 30)));
  check('tail keeps the last line', t.text.endsWith('line 099 xxxxxxxx\n'));
}

/* ---- collectReportLogs --------------------------------------------------- */

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-report-'));
  try {
    const none = await collectReportLogs(dir, { home: HOME });
    check('no logs → empty list, no throw', Array.isArray(none) && none.length === 0);

    const big = Array.from({ length: 20000 }, (_, i) => `2026-10-08 STALL ${i} C:\\Users\\carla\\AppData`).join('\n');
    fs.writeFileSync(path.join(dir, 'stalls.log'), big);
    fs.writeFileSync(path.join(dir, 'updater.log.1'), 'old rotated log');
    const one = await collectReportLogs(dir, { home: HOME, maxBytes: 64 * 1024 });
    check('only the present log', one.length === 1 && one[0].name === 'stalls.log', JSON.stringify(one.map((l) => l.name)));
    check('rotated logs never sent', !one.some((l) => l.name === 'updater.log.1'));
    check('big log tailed', one[0].truncated === true && Buffer.byteLength(one[0].text) <= 64 * 1024);
    check('big log scrubbed', !/carla/i.test(one[0].text));
    check('big log ends with the newest entry', one[0].text.endsWith('STALL 19999 C:\\Users\\<user>\\AppData'));

    fs.writeFileSync(path.join(dir, 'updater.log'), 'INFO Checking for update\n');
    const both = await collectReportLogs(dir, { home: HOME });
    check('order follows REPORT_LOGS', both.map((l) => l.name).join() === REPORT_LOGS.join());

    fs.writeFileSync(path.join(dir, 'updater.log'), '   \n');
    const blank = await collectReportLogs(dir, { home: HOME });
    check('blank log skipped', blank.length === 1 && blank[0].name === 'stalls.log');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`problemReport: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
