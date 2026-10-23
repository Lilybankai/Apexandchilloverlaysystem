/**
 * Shared validation for the nested race-engineer settings block.
 *
 * Main owns persistence, EngineerService owns live behaviour, and the panel
 * edits one field at a time. Keeping defaults and accepted values here prevents
 * those three paths from silently disagreeing after an app upgrade.
 */

'use strict';

const { isMicId, cleanName } = require('./control-panel/mic-picker');

const READOUT_PRESETS = Object.freeze(['off', 'essential', 'standard']);
const PRACTICE_PACE_REMINDER_LAPS = Object.freeze([2, 4, 6]);
// Mature radio (2026-10-08): how rude the engineer may be when you mess up.
// Mirrors engineerPhrases.ts RADIO_TONES; anything else reads as clean.
const RADIO_TONES = Object.freeze(['clean', 'banter', 'savage']);
const DEFAULT_ENGINEER_SETTINGS = Object.freeze({
  readouts: 'essential',
  volume: 100,
  practicePaceReminderLaps: 4,
  // Radio etiquette: proactive calls wait for a straight (urgent ones never
  // wait). Off = the old rule, quiet only while braking hard or side by side.
  onlyStraights: true,
  radioTone: 'clean',
  // The microphone the engineer listens on (2026-10-23): a SAPI audio-input
  // token id, '' = System default. The name is kept beside it so a choice
  // whose headset is unplugged can still be NAMED ("HyperX isn't connected").
  micId: '',
  micName: '',
});

function normalizePracticePaceReminderLaps(value, fallback = 4) {
  const laps = Number(value);
  if (PRACTICE_PACE_REMINDER_LAPS.includes(laps)) return laps;
  const safeFallback = Number(fallback);
  return PRACTICE_PACE_REMINDER_LAPS.includes(safeFallback) ? safeFallback : 4;
}

/**
 * The saved microphone: a valid token id or '' (System default), and its
 * name. '' is a real choice, not a missing value — picking System default
 * must win over an older saved device. Anything else keeps what was there.
 */
function sanitizeMic(s, base) {
  let micId;
  if (s.micId === '' || isMicId(s.micId)) micId = s.micId;
  else micId = isMicId(base.micId) ? base.micId : '';
  if (!micId) return { micId: '', micName: '' };
  const named = typeof s.micName === 'string' ? cleanName(s.micName) : '';
  const kept = micId === base.micId && typeof base.micName === 'string' ? cleanName(base.micName) : '';
  return { micId, micName: named || kept };
}

function sanitizeEngineer(stored, defaults = DEFAULT_ENGINEER_SETTINGS) {
  const s = stored && typeof stored === 'object' ? stored : {};
  const base = defaults && typeof defaults === 'object'
    ? defaults
    : DEFAULT_ENGINEER_SETTINGS;
  const vol = Number(s.volume);
  return {
    readouts: READOUT_PRESETS.includes(s.readouts)
      ? s.readouts
      : READOUT_PRESETS.includes(base.readouts)
        ? base.readouts
        : DEFAULT_ENGINEER_SETTINGS.readouts,
    volume: Number.isFinite(vol)
      ? Math.max(0, Math.min(100, Math.round(vol)))
      : typeof base.volume === 'number'
        ? base.volume
        : DEFAULT_ENGINEER_SETTINGS.volume,
    practicePaceReminderLaps: normalizePracticePaceReminderLaps(
      s.practicePaceReminderLaps,
      base.practicePaceReminderLaps,
    ),
    onlyStraights: typeof s.onlyStraights === 'boolean'
      ? s.onlyStraights
      : typeof base.onlyStraights === 'boolean'
        ? base.onlyStraights
        : DEFAULT_ENGINEER_SETTINGS.onlyStraights,
    radioTone: RADIO_TONES.includes(s.radioTone)
      ? s.radioTone
      : RADIO_TONES.includes(base.radioTone)
        ? base.radioTone
        : DEFAULT_ENGINEER_SETTINGS.radioTone,
    ...sanitizeMic(s, base),
  };
}

module.exports = {
  DEFAULT_ENGINEER_SETTINGS,
  PRACTICE_PACE_REMINDER_LAPS,
  RADIO_TONES,
  READOUT_PRESETS,
  normalizePracticePaceReminderLaps,
  sanitizeEngineer,
};
