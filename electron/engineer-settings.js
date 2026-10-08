/**
 * Shared validation for the nested race-engineer settings block.
 *
 * Main owns persistence, EngineerService owns live behaviour, and the panel
 * edits one field at a time. Keeping defaults and accepted values here prevents
 * those three paths from silently disagreeing after an app upgrade.
 */

'use strict';

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
});

function normalizePracticePaceReminderLaps(value, fallback = 4) {
  const laps = Number(value);
  if (PRACTICE_PACE_REMINDER_LAPS.includes(laps)) return laps;
  const safeFallback = Number(fallback);
  return PRACTICE_PACE_REMINDER_LAPS.includes(safeFallback) ? safeFallback : 4;
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
