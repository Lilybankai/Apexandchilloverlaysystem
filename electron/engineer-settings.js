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
const DEFAULT_ENGINEER_SETTINGS = Object.freeze({
  readouts: 'essential',
  volume: 100,
  practicePaceReminderLaps: 4,
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
  };
}

module.exports = {
  DEFAULT_ENGINEER_SETTINGS,
  PRACTICE_PACE_REMINDER_LAPS,
  READOUT_PRESETS,
  normalizePracticePaceReminderLaps,
  sanitizeEngineer,
};
