/**
 * mic-picker.js — which microphone the race engineer listens on, as data.
 * -----------------------------------------------------------------------------
 * The engineer's ears are System.Speech in a PowerShell sidecar, so the
 * microphones it can open are SAPI's audio-input tokens, not the browser's
 * `enumerateDevices()` list: a token id looks like
 *   HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Speech\AudioInput\TokenEnums\MMAudioIn\{0.0.1.00000000}.{guid}
 * and is stable for as long as Windows keeps the endpoint (unplug and replug
 * the same headset and it comes back under the same id). '' means "System
 * default" — whatever Windows' default recording device is at listen time.
 *
 * Field report, 2026-10-23: "no microphone available" with a headset plugged
 * in. The listener used to take the default device or nothing, die silently
 * when the device would not open, and the panel's only words for any of that
 * were "no microphone was found". Everything a driver reads about the mic now
 * comes out of this file, so it says WHICH problem it is.
 *
 * One file, three readers, like feature-catalog.js:
 *   * main (engineer.js / engineer-settings.js) validates ids and parses scans;
 *   * the panel (window.APEX_MIC) builds the dropdown and the status lines;
 *   * scripts/test-mic-picker.js pins the selection and fallback rules.
 * Keep it dependency-free and side-effect-free.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_MIC = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** Longest id or name we keep: real token ids are ~120 chars. */
  const MAX_ID = 400;
  const MAX_NAME = 120;

  /**
   * A SAPI audio-input token id, and nothing else. The id is handed to the
   * sidecar (through an environment variable) and from there to SAPI, so the
   * settings file never gets to put an arbitrary string in that path.
   */
  function isMicId(v) {
    return (
      typeof v === 'string' &&
      v.length <= MAX_ID &&
      /^HKEY_[A-Z_]+\\SOFTWARE\\Microsoft\\Speech\\AudioInput\\TokenEnums\\[^\t\r\n]+$/i.test(v)
    );
  }

  /** A device name fit for a label: one line, no control characters, capped. */
  function cleanName(v) {
    if (typeof v !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_NAME);
  }

  /** Each of Windows' three microphone switches, as the scan reads them. */
  const PRIVACY_SWITCHES = [
    {
      key: 'device',
      label: 'Microphone access for this device',
      where: 'Settings › Privacy & security › Microphone (needs an administrator)',
    },
    {
      key: 'user',
      label: 'Microphone access',
      where: 'Settings › Privacy & security › Microphone',
    },
    {
      key: 'desktop',
      label: 'Let desktop apps access your microphone',
      where: 'Settings › Privacy & security › Microphone, at the bottom of the page',
    },
  ];

  /**
   * The sidecar's scan (voice-mics.ps1, list mode) is one JSON line. Anything
   * else — PowerShell noise, a BOM, a truncated write — reads as a failed scan
   * rather than as "no microphones", which would send the driver hunting for
   * a hardware fault that isn't there.
   */
  function parseScan(text) {
    const lines = String(text || '')
      .replace(/^﻿/, '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{'));
    if (!lines.length) return { ok: false, error: 'the device scan printed nothing', devices: [] };
    let raw;
    try {
      raw = JSON.parse(lines[lines.length - 1]);
    } catch {
      return { ok: false, error: 'the device scan printed something unreadable', devices: [] };
    }
    if (raw && typeof raw.error === 'string' && raw.error) {
      return { ok: false, error: cleanName(raw.error) || 'the device scan failed', devices: [] };
    }
    // ConvertTo-Json writes a one-element array as a bare object on some
    // PowerShell builds; accept either.
    const list = Array.isArray(raw && raw.devices) ? raw.devices : raw && raw.devices ? [raw.devices] : [];
    const seen = new Set();
    const devices = [];
    for (const d of list) {
      if (!d || !isMicId(d.id) || seen.has(d.id)) continue;
      seen.add(d.id);
      devices.push({ id: d.id, name: cleanName(d.name) || 'Unnamed microphone' });
    }
    const p = (raw && raw.privacy) || {};
    const privacy = {};
    for (const s of PRIVACY_SWITCHES) privacy[s.key] = typeof p[s.key] === 'string' ? p[s.key] : null;
    return {
      ok: true,
      devices,
      defaultName: cleanName(raw && raw.defaultName),
      privacy,
      // The Speech control panel's own pick (HKCU …\Speech\AudioInput
      // DefaultTokenId). Only reported: "System default" deliberately ignores
      // it and follows Windows' default recording device instead.
      speechDefault: typeof (raw && raw.speechDefault) === 'string' ? raw.speechDefault : '',
    };
  }

  /** The privacy switches that are OFF, in the order a driver should check them. */
  function privacyBlocks(privacy) {
    const p = privacy || {};
    return PRIVACY_SWITCHES.filter((s) => String(p[s.key] || '').toLowerCase() === 'deny');
  }

  /**
   * The dropdown: "System default" first, then every input the scan found,
   * then — only when it is not connected — the saved choice, kept so the
   * choice survives an unplugged headset and comes back with it.
   *
   * @param {object|null} scan   parseScan() output, or null before any scan
   * @param {{id?: string, name?: string}} saved   settings.engineer.micId/micName
   */
  function pickerOptions(scan, saved) {
    const s = saved || {};
    const devices = scan && scan.ok ? scan.devices : [];
    const def = scan && scan.ok && scan.defaultName ? `System default — ${scan.defaultName}` : 'System default';
    const out = [{ value: '', label: def, missing: false }];
    for (const d of devices) out.push({ value: d.id, label: d.name, missing: false });
    if (isMicId(s.id) && !devices.some((d) => d.id === s.id)) {
      const name = cleanName(s.name) || 'Your saved microphone';
      // Before the first scan we cannot know it is missing — don't say so.
      const label = scan && scan.ok ? `${name} — not connected` : name;
      out.push({ value: s.id, label, missing: !!(scan && scan.ok) });
    }
    return out;
  }

  /** The saved choice is set, a scan ran, and the device is not in it. */
  function savedMissing(scan, saved) {
    const s = saved || {};
    return !!(scan && scan.ok && isMicId(s.id) && !scan.devices.some((d) => d.id === s.id));
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /**
   * What the scan found, in a sentence, and whether to offer the Windows
   * privacy page. Never a bare "no microphone": it always says how many
   * inputs Windows reported and what to check next.
   *
   * @returns {{text: string, tone: ''|'warn', privacyHelp: boolean}}
   */
  function scanSummary(scan, saved) {
    if (!scan) return { text: '', tone: '', privacyHelp: false };
    if (!scan.ok) {
      return {
        text: `Couldn't list microphones (${scan.error}). Press Scan for devices to try again.`,
        tone: 'warn',
        privacyHelp: false,
      };
    }
    const n = scan.devices.length;
    const blocked = privacyBlocks(scan.privacy);
    if (blocked.length) {
      const first = blocked[0];
      return {
        text:
          `Windows is blocking the microphone: "${first.label}" is Off (${first.where}). ` +
          `The engineer can't hear you until it's On. Windows reported ${plural(n, 'input device', 'input devices')}.`,
        tone: 'warn',
        privacyHelp: true,
      };
    }
    if (n === 0) {
      return {
        text:
          'Windows reported 0 input devices, so there is nothing to listen on. Check that ' +
          'the headset is plugged in and enabled under Sound settings › Input, and that ' +
          '"Microphone access" and "Let desktop apps access your microphone" are On under ' +
          'Settings › Privacy & security › Microphone. Then press Scan for devices again.',
        tone: 'warn',
        privacyHelp: true,
      };
    }
    if (savedMissing(scan, saved)) {
      const name = cleanName(saved.name) || 'Your saved microphone';
      return {
        text:
          `"${name}" isn't connected, so the engineer is using the system default until it's back. ` +
          `Found ${plural(n, 'other input device', 'other input devices')}.`,
        tone: 'warn',
        privacyHelp: false,
      };
    }
    return { text: `Found ${plural(n, 'input device', 'input devices')}.`, tone: '', privacyHelp: false };
  }

  /**
   * SAPI's error text, for a driver. The two that matter in the field are
   * the "nothing to open" family and the "it would not open" family; the
   * second is what a privacy block or an exclusive-mode hog looks like.
   */
  function plainMicError(msg) {
    const m = String(msg || '').trim();
    if (!m) return 'the microphone would not open';
    if (/no audio device is installed|8004503a|cannot find the requested|not found/i.test(m)) {
      return 'Windows has no recording device to hand over';
    }
    if (/audio device error|device.*(in use|allocated)|access.*denied|80070005/i.test(m)) {
      return (
        'the device would not open — another app may be holding it in exclusive mode, ' +
        'or Windows privacy settings are blocking desktop apps'
      );
    }
    return m;
  }

  /**
   * The live listener's state (status().mic) as one line for the panel, or
   * null when the engineer is not running and there is nothing to say.
   *
   * @param {object} mic  { state: 'off'|'starting'|'ok'|'none', source, name, savedName, problem }
   * @returns {[string, ''|'live'|'warn']|null}
   */
  function micLine(mic) {
    if (!mic || mic.state === 'off' || !mic.state) return null;
    if (mic.state === 'starting') return ['Checking the microphone…', ''];
    if (mic.state === 'ok') {
      const name = cleanName(mic.name);
      if (mic.source === 'picked') return [`Listening on ${name || 'your chosen microphone'}.`, 'live'];
      if (mic.source === 'fallback') {
        const saved = cleanName(mic.savedName) || 'Your chosen microphone';
        return [
          `"${saved}" isn't connected — listening on the system default${name ? ` (${name})` : ''} until it's back.`,
          'warn',
        ];
      }
      return [`Listening on the system default${name ? ` (${name})` : ''}.`, 'live'];
    }
    return [
      `The engineer can't open a microphone: ${plainMicError(mic.problem)}. ` +
        'It tries again on every press — or press Scan for devices below.',
      'warn',
    ];
  }

  /** SAPI's audio level (0–100) as a meter width. Speech sits around 20–60. */
  function meterPct(level) {
    const n = Number(level);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.max(2, Math.min(100, Math.round(n * 1.6)));
  }

  /** The result of a mic test, in a sentence. */
  function testSummary(res) {
    if (!res) return { text: '', tone: '' };
    if (res.ok === false) {
      return { text: `Mic test failed: ${plainMicError(res.error)}.`, tone: 'warn' };
    }
    const on = cleanName(res.name) ? ` on ${cleanName(res.name)}` : '';
    if (res.speech || res.peak >= 10) return { text: `Heard you${on}. You're good to go.`, tone: 'live' };
    if (res.peak > 0) {
      return {
        text: `Only a faint signal${on} — speak up, or raise the mic level in Sound settings › Input.`,
        tone: 'warn',
      };
    }
    return {
      text:
        `Nothing at all${on}. Check the headset's mute switch, pick it in the list above, ` +
        'and that desktop apps may use the microphone (Settings › Privacy & security › Microphone).',
      tone: 'warn',
    };
  }

  return {
    MAX_ID,
    MAX_NAME,
    PRIVACY_SWITCHES,
    isMicId,
    cleanName,
    parseScan,
    privacyBlocks,
    pickerOptions,
    savedMissing,
    scanSummary,
    plainMicError,
    micLine,
    meterPct,
    testSummary,
  };
});
