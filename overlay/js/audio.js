/**
 * audio.js — the overlay's audio cues.
 * -----------------------------------------------------------------------------
 * A handful of short tones that tell the driver something happened while their
 * eyes are on the track: a track-limits warning, a penalty, a pit release.
 *
 * ## Why almost all of these are synthesised
 * "Lightweight" is the whole brief, and an overlay that ships a *library* of
 * audio assets pays for it on every source: OBS decodes and buffers each one,
 * the in-game layer holds them resident for a stint, and every Browser Source
 * added to a scene fetches its own copy over HTTP. So the routine cues are
 * **synthesised** — an oscillator, a gain envelope, and nothing else. A cue
 * costs two Web Audio nodes that are created, played for under a fifth of a
 * second, and thrown away; no decoding, no buffer, no file to 404.
 *
 * The one exception is the fuel call, which plays a real recording. That is a
 * judgement about what the cue has to *be*, not a relaxation of the rule: it is
 * the only alarm that demands the driver change their race in the next lap, and
 * it has to be identifiable as itself in the half second before they think about
 * it — which is more than a sine tone can carry. It costs 4 KB, fetched once and
 * decoded once per source, which is the size of a small icon. Anything that
 * would need a second file should be a tone instead.
 *
 * A sampled cue also cannot be allowed to fail quietly, so every one carries a
 * synthesised `fallback` played if the file 404s or the host refuses to decode
 * it. An alarm that is silent because an asset did not load is the worst
 * possible bug in this file.
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
    /**
     * The fuel/energy pit call — the only sampled cue, and the only one that
     * repeats while its condition holds.
     *
     * Played as a TRIPLET rather than the single blip the file contains. On its
     * own the clip is 130 ms, which is under the threshold where a sound
     * registers as a deliberate signal rather than as something that might have
     * been the car; three of them in quick succession is unmistakably a pattern,
     * and a pattern is what makes it identifiable as this alarm and not the
     * track-limits blip.
     *
     * `minGapMs` is the whole repeat strategy. The alarm it belongs to stands
     * for a full lap, so the widgets simply ask for the cue on every frame it is
     * up and this decides how often that is actually heard — roughly four or
     * five times over a lap. Often enough that it cannot be missed while the
     * driver is busy, rarely enough that it stays an alarm instead of becoming
     * background noise to be tuned out.
     */
    fuel: {
      src: "audio/fuel-warning.mp3",
      repeat: 3,
      spacingMs: 190,
      gain: 1,
      minGapMs: 20000,
      // If the sample can't be had: a hard, high triple-blip. Not as
      // identifiable, but never silent.
      fallback: { freq: [1046, 1046, 1046], stepMs: 120, gain: 0.85 },
    },
  };

  /**
   * Minimum time between two firings of the SAME cue, milliseconds. A cue may
   * override it with `minGapMs` — see the fuel call, which uses it to pace a
   * repeat rather than merely to debounce.
   *
   * Widgets are allowed to be naive — "call cue() whenever this is true" — and
   * this is what makes that safe. A second is longer than any of the cues and
   * far longer than the few frames a threshold takes to settle, while still
   * letting two genuinely separate events a second apart both be heard.
   */
  var MIN_GAP_MS = 1000;

  /**
   * How long after asking for a sampled cue its file may still arrive and be
   * played. Covers the first firing, where the fetch and decode have not
   * happened yet; beyond this the moment has passed and playing it would be
   * announcing something that is no longer news.
   */
  var SAMPLE_LATE_MS = 3000;

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

  /** Decoded sample buffers by cue name; `null` once known to be unusable. */
  var samples = {};
  /** Cue names whose fetch is in flight, so it is only started once. */
  var loading = {};

  /**
   * Fetch and decode a cue's sample, then hand it to `then`. Failure is
   * recorded as `null` so the fallback is used from that point on without
   * retrying a file that is not coming.
   */
  function loadSample(ctx, name, spec, then) {
    if (loading[name]) return;
    loading[name] = true;
    var fail = function () {
      samples[name] = null;
      then(null);
    };
    try {
      fetch(spec.src)
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.arrayBuffer();
        })
        // The callback form as well as the promise: Safari and older CEF builds
        // only implement the former, and this has to work in whatever browser
        // the operator's OBS happens to embed.
        .then(function (buf) {
          return new Promise(function (resolve, reject) {
            var p = ctx.decodeAudioData(buf, resolve, reject);
            if (p && typeof p.then === "function") p.then(resolve, reject);
          });
        })
        .then(function (decoded) {
          samples[name] = decoded;
          then(decoded);
        })
        .catch(fail);
    } catch (e) {
      fail();
    }
  }

  /** Play a decoded sample `repeat` times, `spacingMs` apart. */
  function playSample(ctx, buffer, spec, peak) {
    var at = ctx.currentTime + 0.01;
    var reps = spec.repeat || 1;
    var spacing = (spec.spacingMs || 0) / 1000;
    for (var i = 0; i < reps; i++) {
      var src = ctx.createBufferSource();
      var gain = ctx.createGain();
      src.buffer = buffer;
      gain.gain.setValueAtTime(peak, at);
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start(at + i * spacing);
    }
  }

  /** Play a cue's synthesised tones (its own, or a sampled cue's fallback). */
  function playTones(ctx, spec, peak) {
    // A few ms of lead, so the first tone's attack ramp is scheduled in the
    // future rather than already-past (which some hosts render as a click).
    var at = ctx.currentTime + 0.01;
    var step = spec.stepMs / 1000;
    for (var i = 0; i < spec.freq.length; i++) {
      tone(ctx, spec.freq[i], at + i * step, step * 0.92, peak);
    }
  }

  /**
   * Fire a cue by name. Safe to call every frame a condition holds — see
   * MIN_GAP_MS — and safe to call for a name that does not exist.
   *
   * Returns `true` when a sound was actually scheduled, which is only used by
   * the audio test button in the control panel; widgets ignore it. A sampled cue
   * firing for the first time returns `true` on the strength of having started
   * its fetch — the sound follows a moment later.
   */
  function cue(name) {
    if (!enabled || volume <= 0) return false;
    var spec = CUES[name];
    if (!spec) return false;
    var t = nowMs();
    var gap = spec.minGapMs || MIN_GAP_MS;
    if (lastAt[name] && t - lastAt[name] < gap) return false;
    var ctx = context();
    if (!ctx) return false;
    resume();
    lastAt[name] = t;
    var peak = spec.gain * volume;
    try {
      if (!spec.src) {
        playTones(ctx, spec, peak);
        return true;
      }
      if (samples[name]) {
        playSample(ctx, samples[name], spec, peak);
        return true;
      }
      if (samples[name] === null) {
        playTones(ctx, spec.fallback, spec.fallback.gain * volume);
        return true;
      }
      // First ask for this sample: start the fetch and play on arrival, unless
      // so much time has passed that the moment is gone.
      loadSample(ctx, name, spec, function (decoded) {
        if (nowMs() - t > SAMPLE_LATE_MS) return;
        if (decoded) playSample(ctx, decoded, spec, peak);
        else if (spec.fallback) playTones(ctx, spec.fallback, spec.fallback.gain * volume);
      });
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
