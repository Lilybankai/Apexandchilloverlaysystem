/**
 * audio.js — the overlay's audio cues.
 * -----------------------------------------------------------------------------
 * A handful of short tones that tell the driver something happened while their
 * eyes are on the track: a track-limits warning, a penalty, a pit release.
 *
 * ## Why there are no sound files
 * "Lightweight" is the whole brief, and an overlay that ships audio assets pays
 * for them on every source: OBS decodes and buffers each one, the in-game layer
 * holds them resident for a stint, and every Browser Source added to a scene
 * fetches its own copy over HTTP. These cues are **synthesised** instead — an
 * oscillator, a gain envelope, and nothing else. A cue costs two Web Audio nodes
 * that are created, played for under a fifth of a second, and thrown away; there
 * is no decoding, no buffer, no file to 404, and no network at all. It also
 * keeps the "no web fonts / no network" property the rest of the overlay has.
 *
 * The tones are deliberately plain. A driver is already listening to an engine,
 * a spotter and possibly a race director; the cue has to cut through that
 * WITHOUT sounding like part of the car, so each one is a clean sine at a pitch
 * nothing in a race weekend occupies, shaped so it reads as a signal rather than
 * a noise.
 *
 * ## The context is not created until the operator's setting says so
 * Chromium blocks an AudioContext started without a user gesture, and both hosts
 * that matter here — OBS's CEF and the Electron in-game window — are pages
 * nobody ever clicks. Both are launched with the autoplay policy relaxed (see
 * `autoplayPolicy` in electron/main.js), so the context starts suspended at
 * worst; `resume()` is retried on the first cue and on the next user gesture, so
 * a plain browser tab starts working the moment the operator interacts with it
 * rather than staying silently broken.
 *
 * ## Volume and on/off ride the appearance channel
 * Like the panel opacity and the radar's icon size, these are operator
 * look-and-feel set once from the control panel — not telemetry — so they arrive
 * over `js/appearance.js` and retune every live source without a reload.
 *
 * Cues are RATE-LIMITED per name (see MIN_GAP_MS): a widget may call `cue()`
 * every frame a condition holds and hear it once, which keeps the trigger logic
 * in the widgets simple and stops a channel dithering across a threshold from
 * producing a machine-gun.
 */
(function () {
  "use strict";

  /**
   * The cue vocabulary. Each is a short envelope over one or two sine tones:
   *   `freq`   pitch(es) in Hz, played in sequence
   *   `stepMs` how long each tone lasts
   *   `gain`   peak gain BEFORE the operator's master volume
   *
   * Pitch carries the meaning, so the three are far enough apart to be told
   * apart through a headset without thinking about it:
   *
   *   limit    one mid blip — "that was wide". Deliberately the mildest of the
   *            three: it fires on a mistake the driver already knows they made,
   *            and its job is to confirm the count moved, not to startle them
   *            mid-corner.
   *   penalty  two descending low tones — the classic "bad news" fall, and the
   *            only cue that reports someone else's decision about you.
   *   release  two rising tones — the pit-lane green light. Rising, because it
   *            is the one cue in the set that means GO.
   */
  var CUES = {
    limit: { freq: [880], stepMs: 90, gain: 0.5 },
    penalty: { freq: [520, 360], stepMs: 130, gain: 0.7 },
    release: { freq: [660, 990], stepMs: 90, gain: 0.6 },
  };

  /**
   * Minimum time between two firings of the SAME cue, milliseconds.
   *
   * Widgets are allowed to be naive — "call cue() whenever this is true" — and
   * this is what makes that safe. A second is longer than any of the cues and
   * far longer than the few frames a threshold takes to settle, while still
   * letting two genuinely separate events a second apart both be heard.
   */
  var MIN_GAP_MS = 1000;

  /** Master volume, 0..1, from the operator. 0 (or `enabled: false`) is silent. */
  var volume = 0.6;
  var enabled = true;

  /** The shared AudioContext, created lazily on the first cue that may sound. */
  var actx = null;
  /** Last time each cue fired, keyed by name. */
  var lastAt = {};

  function nowMs() {
    return typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  }

  /**
   * The AudioContext, created on demand, or null when this host has no Web
   * Audio at all. Never throws: audio is a nicety, and an overlay that failed to
   * render because a cue could not be built would be a far worse bug than a
   * silent one.
   */
  function context() {
    if (actx) return actx;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try {
      actx = new Ctor();
    } catch (e) {
      return null;
    }
    // Started suspended (a host that still enforces the gesture policy): try to
    // resume now, and again on the first real gesture.
    if (actx.state === "suspended") {
      resume();
      bindGestureResume();
    }
    return actx;
  }

  function resume() {
    if (!actx || actx.state !== "suspended") return;
    try {
      var p = actx.resume();
      if (p && typeof p.catch === "function") p.catch(function () { /* stays suspended */ });
    } catch (e) {
      /* nothing more to try */
    }
  }

  var gestureBound = false;
  function bindGestureResume() {
    if (gestureBound) return;
    gestureBound = true;
    var once = function () {
      resume();
      ["pointerdown", "keydown", "touchstart"].forEach(function (evt) {
        window.removeEventListener(evt, once);
      });
    };
    ["pointerdown", "keydown", "touchstart"].forEach(function (evt) {
      window.addEventListener(evt, once, { passive: true });
    });
  }

  /**
   * Play one tone at `at` seconds on the context's clock.
   *
   * The envelope matters more than the waveform: a bare oscillator switched on
   * and off clicks at both ends, which on a short blip is most of what you
   * actually hear. A few milliseconds of ramp either side removes it entirely.
   * Both nodes are disposable — `stop()` releases them, so nothing accumulates
   * over a three-hour stint.
   */
  function tone(ctx, freq, at, durSec, peak) {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, at);
    var attack = 0.006;
    var release = 0.04;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + attack);
    gain.gain.setValueAtTime(peak, at + Math.max(attack, durSec - release));
    gain.gain.linearRampToValueAtTime(0, at + durSec);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + durSec + 0.01);
  }

  /**
   * Fire a cue by name. Safe to call every frame a condition holds — see
   * MIN_GAP_MS — and safe to call for a name that does not exist.
   *
   * Returns `true` when a sound was actually scheduled, which is only used by
   * the audio test button in the control panel; widgets ignore it.
   */
  function cue(name) {
    if (!enabled || volume <= 0) return false;
    var spec = CUES[name];
    if (!spec) return false;
    var t = nowMs();
    if (lastAt[name] && t - lastAt[name] < MIN_GAP_MS) return false;
    var ctx = context();
    if (!ctx) return false;
    resume();
    lastAt[name] = t;
    try {
      // A few ms of lead, so the first tone's attack ramp is scheduled in the
      // future rather than already-past (which some hosts render as a click).
      var at = ctx.currentTime + 0.01;
      var step = spec.stepMs / 1000;
      var peak = spec.gain * volume;
      for (var i = 0; i < spec.freq.length; i++) {
        tone(ctx, spec.freq[i], at + i * step, step * 0.92, peak);
      }
    } catch (e) {
      if (window.console) console.error("[Apex] audio cue failed:", e);
      return false;
    }
    return true;
  }

  /** Accepts 0..1 (a fraction) or 1..100 (a percentage), as the panel sends. */
  function toVolume(value) {
    var n = typeof value === "number" ? value : parseFloat(value);
    if (!isFinite(n)) return null;
    if (n > 1) n = n / 100;
    return Math.min(1, Math.max(0, n));
  }

  window.ApexAudio = {
    cue: cue,
    /** Names the operator/control panel can ask for — the single source of truth. */
    cues: Object.keys(CUES),
    /** Called by js/appearance.js when the operator's settings arrive/change. */
    configure: function (settings) {
      if (!settings) return;
      if (settings.audioCues !== undefined) {
        enabled = !(
          settings.audioCues === false ||
          settings.audioCues === "false" ||
          settings.audioCues === 0 ||
          settings.audioCues === "0"
        );
      }
      var v = settings.audioVolume === undefined ? null : toVolume(settings.audioVolume);
      if (v !== null) volume = v;
    },
    /** Current state, for the control panel's preview button. */
    get enabled() {
      return enabled;
    },
    get volume() {
      return volume;
    },
  };
})();
