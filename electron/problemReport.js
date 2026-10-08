/**
 * electron/problemReport.js — the logs a "Report a problem" sends, and only those.
 * -----------------------------------------------------------------------------
 * A bug report from the Suggestions tab can carry the two logs we otherwise
 * ask testers to dig out of %APPDATA% by hand: stalls.log (stall-watch) and
 * updater.log (updateCache). The report-problem edge function turns them into
 * attachments on a Linear issue.
 *
 * Three rules, all of them about what leaves the machine:
 *  - Only the tail. A long-lived install has megabytes of updater.log; the last
 *    stretch is the part anyone reads, and the function refuses big bodies.
 *  - No Windows username. Both logs are full of `C:\Users\<name>\AppData\…`
 *    paths, and the account name is often the driver's real name. It is
 *    replaced with `<user>`, as is anything shaped like an email address.
 *  - Never block main. This runs from an IPC handler on the main process —
 *    see the 2026-09 stall work — so every read is async and positioned, and a
 *    missing or locked file is skipped rather than reported.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** The logs a report may carry, in the order they are attached. */
const REPORT_LOGS = ['stalls.log', 'updater.log'];

/** Per-file cap. The edge function enforces its own, slightly larger, limit. */
const MAX_LOG_BYTES = 192 * 1024;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strip what identifies the driver from a log. `home` is the profile folder
 * (C:\Users\carl); its last segment is the account name.
 */
function scrubLog(text, home) {
  let out = String(text || '');
  const user = home ? path.win32.basename(String(home).replace(/[\\/]+$/, '')) : '';
  if (user && user.length >= 2) {
    // Both slash styles, any case: Electron logs `C:\Users\carl\…`, a few
    // Node errors print `c:/users/carl/…`.
    const re = new RegExp(`([\\\\/]Users[\\\\/])${escapeRegExp(user)}(?=[\\\\/'"\\s]|$)`, 'gi');
    out = out.replace(re, '$1<user>');
  }
  return out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
}

/**
 * The last `max` bytes of a buffer as text, starting on a whole line so the
 * attachment never opens mid-entry. `truncated` says whether anything was cut.
 */
function tailText(buf, max = MAX_LOG_BYTES) {
  if (buf.length <= max) return { text: buf.toString('utf8'), truncated: false };
  let slice = buf.subarray(buf.length - max);
  const nl = slice.indexOf(0x0a);
  if (nl >= 0 && nl < slice.length - 1) slice = slice.subarray(nl + 1);
  return { text: slice.toString('utf8'), truncated: true };
}

/** Read at most the last `max` bytes of a file without loading the rest. */
async function readTail(file, max = MAX_LOG_BYTES) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    // A little over the cap so tailText can drop the partial first line and
    // still hand back close to `max`.
    const want = Math.min(size, max + 4096);
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, want, size - want);
    return tailText(buf.subarray(0, bytesRead), max);
  } finally {
    await fh.close();
  }
}

/**
 * The logs to attach: `[{ name, text, truncated }]`, scrubbed, missing files
 * skipped. Never throws.
 */
async function collectReportLogs(userDataDir, opts = {}) {
  const home = opts.home !== undefined ? opts.home : os.homedir();
  const max = opts.maxBytes || MAX_LOG_BYTES;
  const out = [];
  for (const name of REPORT_LOGS) {
    try {
      const raw = await readTail(path.join(userDataDir, name), max);
      if (!raw.text.trim()) continue;
      // `<user>` can be longer than the name it replaces, so trim again after.
      const clean = tailText(Buffer.from(scrubLog(raw.text, home), 'utf8'), max);
      out.push({ name, text: clean.text, truncated: raw.truncated || clean.truncated });
    } catch {
      /* not written yet on this install, or locked — leave it out */
    }
  }
  return out;
}

module.exports = { REPORT_LOGS, MAX_LOG_BYTES, scrubLog, tailText, readTail, collectReportLogs };
