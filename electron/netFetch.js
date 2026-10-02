/**
 * electron/netFetch.js — main-process HTTP that respects the driver's network.
 * -----------------------------------------------------------------------------
 * Node's built-in fetch (undici) ignores the Windows system proxy AND the
 * Windows certificate store. A driver whose route out is a system proxy (a VPN
 * client in proxy mode, a corporate proxy) or whose antivirus intercepts TLS
 * gets a bare "fetch failed" from undici while every browser on the machine —
 * and this app's own renderer — works fine. Electron's `net.fetch` runs on
 * Chromium's network stack, which honours both.
 *
 * So: Chromium's stack first, Node's as the fallback (a machine where the
 * proxy is broken but a direct route works still gets through). Outside
 * Electron — the test scripts — require('electron') resolves to a path string,
 * not the API, hence the shape check; Node's fetch is then the whole list.
 *
 * The voice download (engineer.js, v0.93.0) and the Discord webhook test
 * (discord-cloud.js) carry their own copies of this; sign-in went without it
 * until 2026-10-01 (tester behind a VPN: "Can't reach the account service").
 * Any new main-process request should come through here.
 */

'use strict';

function fetchStacks() {
  const stacks = [];
  try {
    const { net } = require('electron');
    if (net && typeof net.fetch === 'function') {
      stacks.push({ name: 'app', fetch: net.fetch.bind(net) });
    }
  } catch {
    /* plain Node — the test scripts */
  }
  stacks.push({ name: 'node', fetch: globalThis.fetch });
  return stacks;
}

/**
 * undici reports every connection-level failure as a bare "fetch failed" and
 * buries the reason in `err.cause`; Chromium says "net::ERR_…". Walk the cause
 * chain (and the first branch of an AggregateError) into one line, bounded by
 * hops so a self-referential chain still terminates.
 */
function describeFetchError(err) {
  const parts = [];
  let e = err;
  for (let hops = 0; e && hops < 4; hops++) {
    const msg = e.message ? String(e.message) : String(e);
    if (!parts.includes(msg)) parts.push(msg);
    e = Array.isArray(e.errors) && e.errors.length ? e.errors[0] : e.cause;
  }
  return parts.join(' — ');
}

/**
 * fetch(), tried on each stack in turn. An HTTP response of any status is
 * final — only a throw before a response moves on to the next stack. An abort
 * (the caller's timeout) is final too: the request may already have reached
 * the server, and a second full timeout on the other stack only doubles the
 * wait. Throws the LAST stack's error when every stack fails.
 *
 * `stacks` is injectable for the tests.
 */
async function fetchWithFallback(url, init = {}, stacks = fetchStacks()) {
  let lastErr = null;
  for (const stack of stacks) {
    try {
      return await stack.fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (init.signal && init.signal.aborted) throw err;
    }
  }
  throw lastErr || new Error('fetch failed');
}

module.exports = { fetchStacks, describeFetchError, fetchWithFallback };
