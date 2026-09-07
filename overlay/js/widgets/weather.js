/**
 * widgets/weather.js — current conditions + forecast timeline (top-centre).
 * -----------------------------------------------------------------------------
 * Renders `frame.weather` (WeatherState): a "now" block (track/ambient temp,
 * wetness) plus a compact forecast strip of upcoming slots with rain chance.
 * The forecast strip is only rebuilt when its content signature changes, since
 * forecasts evolve slowly relative to the broadcast rate.
 *
 * Every slot carries a SKY ICON. The sky was already here — the provider maps
 * LMU's own forecast nodes to a SkyState per slot (lmuRestProvider's mapSky) and
 * this file already stamped it on the cell as `data-sky` — but nothing drew it,
 * so the only sky in the widget was one text label for the current slot and the
 * four slots saying what is COMING carried none. A glyph is what that data is
 * worth: shape resolves in a single fixation, where a word has to be read, and
 * this widget is looked at for a fifth of a second at a time.
 *
 * The icons are inline SVG rather than a font or a sprite for a reason that is
 * specific to this overlay: both rendering paths put the widgets inside a CSS
 * transform (the OBS pages scale a fixed 1920x1080 design to the source size,
 * the in-game layer scales each widget up to 3x). Text and vectors re-rasterise
 * under that transform; bitmaps are magnified. See js/raster.js, which exists
 * because the canvas widgets could NOT do this.
 */
(function () {
  "use strict";

  var SKY_LABEL = {
    clear: "CLEAR",
    partlyCloudy: "PART CLOUD",
    overcast: "OVERCAST",
    lightRain: "LIGHT RAIN",
    rain: "RAIN",
    storm: "STORM",
  };

  /* -----------------------------------------------------------------------
   * Sky glyphs — a 24x24 box each, drawn flat.
   *
   * Sized for where they actually land: ~16px in a forecast slot. That is small
   * enough that detail is not just wasted but harmful — soft edges and gradients
   * turn to mush, and worse in an OBS source that has been scaled down — so
   * every glyph is a hard silhouette with at most one accent colour.
   *
   * The cloud is deliberately IDENTICAL across overcast/lightRain/rain/storm and
   * pinned to the same coordinates, so the only thing that changes between the
   * four wet states is what falls out of it. That is the distinction worth
   * making instantly; clear-vs-partly-cloudy is not, because neither changes a
   * tyre call.
   * -------------------------------------------------------------------- */
  var CLOUD =
    '<circle cx="8" cy="11" r="4.6"/>' +
    '<circle cx="15.5" cy="11" r="5.2"/>' +
    '<circle cx="11.5" cy="7.6" r="5.6"/>' +
    '<rect x="3" y="10.2" width="17.5" height="5.6" rx="2.8"/>';

  /** The partly-cloudy sun sits clear of its cloud rather than behind it: at
   *  16px a cutout gap is thinner than a pixel, so an overlap merges the two
   *  shapes into one unreadable blob. */
  var CLOUD_SM =
    '<circle cx="13" cy="15.6" r="3.6"/>' +
    '<circle cx="18" cy="15.6" r="4"/>' +
    '<circle cx="15.4" cy="12.4" r="4.4"/>' +
    '<rect x="9.6" y="15" width="11.6" height="5" rx="2.5"/>';

  /** Falling rain as slanted strokes, not teardrops — a 3px teardrop is a dot.
   *  2.6 units of stroke, not 2: at 18px a 2-unit line lands on 1.5 device
   *  pixels, and the first pass had rain you had to look for. */
  function rain(xs, y1, y2) {
    var out = '<g class="wx-wet" stroke-width="2.6" stroke-linecap="round">';
    for (var i = 0; i < xs.length; i++) {
      out += '<line x1="' + xs[i] + '" y1="' + y1 +
        '" x2="' + (xs[i] - 1.6) + '" y2="' + y2 + '"/>';
    }
    return out + "</g>";
  }

  /** Sun rays. `angles` are degrees anticlockwise from east, screen y inverted. */
  function rays(cx, cy, r0, r1, angles) {
    var out = '<g class="wx-ray" stroke-width="2.2" stroke-linecap="round">';
    for (var i = 0; i < angles.length; i++) {
      var a = (angles[i] * Math.PI) / 180;
      var dx = Math.cos(a), dy = -Math.sin(a);
      out += '<line x1="' + (cx + dx * r0).toFixed(2) + '" y1="' + (cy + dy * r0).toFixed(2) +
        '" x2="' + (cx + dx * r1).toFixed(2) + '" y2="' + (cy + dy * r1).toFixed(2) + '"/>';
    }
    return out + "</g>";
  }

  var SKY_ICON = {
    clear:
      rays(12, 12, 7.6, 10.4, [0, 45, 90, 135, 180, 225, 270, 315]) +
      '<circle cx="12" cy="12" r="5.2"/>',
    // Five rays, not eight: the three the cloud would sit on are the three that
    // cannot be drawn without the two shapes touching.
    partlyCloudy:
      rays(7.4, 7.2, 5.6, 7.8, [45, 90, 135, 180, 225]) +
      '<circle cx="7.4" cy="7.2" r="4"/>' +
      CLOUD_SM,
    overcast: CLOUD,
    lightRain: CLOUD + rain([10.4, 15.4], 17.6, 21.8),
    rain: CLOUD + rain([8.4, 12.6, 16.8], 17.4, 22.4),
    // The bolt is the one glyph carrying a second colour. At this size the
    // zigzag alone is marginal, so amber does the work the shape cannot.
    storm:
      CLOUD +
      rain([17.4], 17.4, 22.4) +
      '<path class="wx-bolt" d="M13.2 16.6 L8.6 21.8 L11.6 21.8 L10.4 23.8 L15.4 18.4 L12.4 18.4 Z"/>',
  };

  /**
   * Paint a sky into an icon holder. An UNKNOWN sky draws nothing rather than
   * falling back to a cloud: an icon is read as fact at a glance, and inventing
   * an overcast sky for a provider that did not send one is worse than a gap.
   */
  function setIcon(el, sky) {
    var body = SKY_ICON[sky];
    el.setAttribute("data-sky", sky || "");
    el.setAttribute("aria-label", SKY_LABEL[sky] || "");
    el.innerHTML = body
      ? '<svg viewBox="0 0 24 24" aria-hidden="true">' + body + "</svg>"
      : "";
  }

  function makeIcon(cls) {
    var el = document.createElement("span");
    el.className = cls;
    el.setAttribute("role", "img");
    return el;
  }

  var mount, headerState;
  var tempEl, ambientEl, wetEl, nowIconEl, forecastEl;
  var cache = {};

  /** Coarse rain bucket used to colour a forecast slot's top border. */
  function rainBucket(chance) {
    if (typeof chance !== "number" || chance < 0.15) return "dry";
    if (chance < 0.5) return "low";
    return "high";
  }

  function init(root) {
    headerState = root.querySelector('[data-role="track-state"]');
    mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML = "";

    var now = document.createElement("div");
    now.className = "weather__now";

    // Beside the big number, the way the sky is read off a broadcast graphic.
    // This replaces the "PART CLOUD" text line that used to sit third in the
    // meta column, which buys the block a line back as well as a faster read.
    nowIconEl = makeIcon("weather__icon weather__icon--now");

    tempEl = document.createElement("div");
    tempEl.className = "weather__temp";
    tempEl.innerHTML = '—<small> track</small>';

    var meta = document.createElement("div");
    meta.className = "weather__meta";
    ambientEl = document.createElement("span");
    ambientEl.textContent = "Air —°";
    // Tier 1. Whether the track is wet, and how wet, changes tyre choice, brake
    // points and everything else — it was previously one of three 11px lines.
    wetEl = document.createElement("span");
    wetEl.className = "weather__wet is-crit";
    wetEl.textContent = "Dry";
    meta.appendChild(ambientEl);
    meta.appendChild(wetEl);

    now.appendChild(nowIconEl);
    now.appendChild(tempEl);
    now.appendChild(meta);

    forecastEl = document.createElement("div");
    forecastEl.className = "weather__forecast";

    mount.appendChild(now);
    mount.appendChild(forecastEl);
  }

  function update(frame, ctx) {
    var fmt = ctx.fmt;
    var w = frame.weather;
    if (!w) return;

    // Header + now block.
    var trackStr = fmt.temp(w.trackTempC);
    if (headerState && cache.hdr !== trackStr) {
      cache.hdr = trackStr;
      headerState.textContent = "TRACK " + trackStr;
    }
    if (cache.track !== trackStr) {
      cache.track = trackStr;
      tempEl.innerHTML = trackStr + "<small> track</small>";
    }
    var airStr = "Air " + fmt.temp(w.ambientTempC);
    if (cache.air !== airStr) { cache.air = airStr; ambientEl.textContent = airStr; }

    // Wetness / rain description. The named condition leads when the provider
    // has one — the tyre decision changes at DAMP→WET, not at 41% — with the
    // percentage kept behind it for anyone who wants the number, and the trend
    // appended because a track at 30% drying is a completely different call
    // from a track at 30% getting wetter.
    var wetPct = fmt.pct(w.trackWetness);
    var rainPct = fmt.pct(w.rainIntensity);
    var wetStr;
    if (w.trackCondition) {
      wetStr = w.trackCondition;
      if (wetPct > 2) wetStr += " " + Math.round(wetPct) + "%";
      if (rainPct > 2) wetStr += " · rain " + Math.round(rainPct) + "%";
      if (w.trackTrend === "drying") wetStr += " ▼";
      else if (w.trackTrend === "wetting") wetStr += " ▲";
    } else {
      wetStr = rainPct > 2 ? "Rain " + Math.round(rainPct) + "%"
        : wetPct > 2 ? "Wet " + Math.round(wetPct) + "%"
        : "Dry";
    }
    if (cache.wet !== wetStr) {
      cache.wet = wetStr;
      wetEl.textContent = wetStr;
      // classList, not className: a wholesale assignment here would drop the
      // is-crit marker the first time the track went wet, silently disabling the
      // glow on the one value most worth glowing.
      wetEl.classList.toggle("neg", rainPct > 2 || wetPct > 20);
    }
    // Bloom on the CONDITION changing, not on the percentage: in the wet the
    // number moves every frame, and "Dry → Wet" is the moment that matters.
    // Keyed on the named band when there is one, so crossing DAMP→WET blooms —
    // that is the moment a tyre call changes, and it is invisible in a
    // percentage that has been creeping all lap.
    var wetState = w.trackCondition
      ? w.trackCondition
      : rainPct > 2 ? "rain" : wetPct > 2 ? "wet" : "dry";
    if (cache.wetState !== wetState) {
      var firstWet = cache.wetState === undefined;
      cache.wetState = wetState;
      if (!firstWet && ctx.critPulse) ctx.critPulse(wetEl);
    }

    // Forecast strip — rebuild only when the signature changes. `sky` is part
    // of the signature so a pure sky change (at unchanged rain %) still refreshes
    // the "now" sky label below.
    var slots = w.forecast || [];
    var sig = "";
    for (var i = 0; i < slots.length; i++) {
      var fs = slots[i];
      var ftemp = typeof fs.airTempC === "number" ? fs.airTempC : fs.trackTempC;
      sig += (fs.label || fs.minutesAhead) + ":" + Math.round(fmt.pct(fs.rainChance)) +
        ":" + Math.round(ftemp) + ":" + fs.sky + "|";
    }
    if (cache.sig === sig) return;
    cache.sig = sig;

    // Current sky from the now-slot when present.
    var nowSlot = slots.length ? slots[0] : null;
    if (nowSlot && cache.sky !== nowSlot.sky) {
      cache.sky = nowSlot.sky;
      setIcon(nowIconEl, nowSlot.sky);
    }

    forecastEl.innerHTML = "";
    for (var j = 0; j < slots.length; j++) {
      var s = slots[j];
      var cell = document.createElement("div");
      cell.className = "weather__slot";
      cell.setAttribute("data-rain", rainBucket(s.rainChance));
      cell.setAttribute("data-sky", s.sky || "");
      // Slot 0 is "now" — already covered by the block above. Slot 1 is what is
      // about to happen, which is the only forecast entry that changes a decision
      // in the next few laps, so it is the one that gets read at a glance.
      if (j === 1) cell.setAttribute("data-next", "true");

      var time = document.createElement("div");
      time.className = "weather__slot-time";
      // Prefer the session-phase label (START/25%/…); fall back to a minute offset.
      time.textContent = s.label ? s.label : s.minutesAhead === 0 ? "NOW" : "+" + s.minutesAhead + "m";

      // Sky + temperature share a row. Stacking the icon on its own line would
      // have cost the strip ~18px of height, and this is the top-centre widget —
      // on a broadcast that band is where the car is.
      var row = document.createElement("div");
      row.className = "weather__slot-row";

      var icon = makeIcon("weather__icon");
      setIcon(icon, s.sky);

      // Temperature forecast for this slot (air temp when present).
      var tempC = typeof s.airTempC === "number" ? s.airTempC : s.trackTempC;
      var temp = document.createElement("div");
      temp.className = "weather__slot-temp";
      temp.textContent = fmt.temp(tempC);

      row.appendChild(icon);
      row.appendChild(temp);

      var rainEl = document.createElement("div");
      rainEl.className = "weather__slot-rain";
      rainEl.textContent = Math.round(fmt.pct(s.rainChance)) + "%";

      cell.appendChild(time);
      cell.appendChild(row);
      cell.appendChild(rainEl);
      forecastEl.appendChild(cell);
    }
  }

  window.ApexOverlay.registerWidget("weather", {
    throttleMs: 250,
    init: init,
    update: update,
  });
})();
