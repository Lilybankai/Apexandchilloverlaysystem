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
// Live coach v2 (2026-11-04): how many corners it works on at once.
const LIVE_COACH_CORNERS = Object.freeze([1, 2, 3]);
const DEFAULT_ENGINEER_SETTINGS = Object.freeze({
  readouts: 'essential',
  volume: 100,
  practicePaceReminderLaps: 4,
  // Radio etiquette: proactive calls wait for a straight (urgent ones never
  // wait). Off = the old rule, quiet only while braking hard or side by side.
  onlyStraights: true,
  // The live practice coach (2026-11-03, electron/live-coach.js): one corner
  // to work on, said on the radio after a lap and shown on the in-game Focus
  // card. Beta only, practice and test days only; on by default there.
  liveCoach: true,
  // Coach v2 (2026-11-04): a short cue on the straight before each corner
  // being worked on ("corner five, brake ten metres later"), and how many
  // corners it works on at once (1–3; 1 = the v1 one-corner coach).
  liveCoachApproach: true,
  liveCoachCorners: 3,
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
    liveCoach: typeof s.liveCoach === 'boolean'
      ? s.liveCoach
      : typeof base.liveCoach === 'boolean'
        ? base.liveCoach
        : DEFAULT_ENGINEER_SETTINGS.liveCoach,
    liveCoachApproach: typeof s.liveCoachApproach === 'boolean'
      ? s.liveCoachApproach
      : typeof base.liveCoachApproach === 'boolean'
        ? base.liveCoachApproach
        : DEFAULT_ENGINEER_SETTINGS.liveCoachApproach,
    liveCoachCorners: LIVE_COACH_CORNERS.includes(Number(s.liveCoachCorners))
      ? Number(s.liveCoachCorners)
      : LIVE_COACH_CORNERS.includes(Number(base.liveCoachCorners))
        ? Number(base.liveCoachCorners)
        : DEFAULT_ENGINEER_SETTINGS.liveCoachCorners,
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
  LIVE_COACH_CORNERS,
  PRACTICE_PACE_REMINDER_LAPS,
  RADIO_TONES,
  READOUT_PRESETS,
  normalizePracticePaceReminderLaps,
  sanitizeEngineer,
};
