/**
 * widgets/weather.js — current conditions + forecast timeline (top-centre).
 * -----------------------------------------------------------------------------
 * Renders `frame.weather` (WeatherState): a "now" block (track/ambient temp,
 * wetness) plus a compact forecast strip of upcoming slots with rain chance.
 * The forecast strip is only rebuilt when its content signature changes, since
 * forecasts evolve slowly relative to the broadcast rate.
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

  var mount, headerState;
  var tempEl, ambientEl, wetEl, skyEl, forecastEl;
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
    skyEl = document.createElement("span");
    skyEl.textContent = "—";
    meta.appendChild(ambientEl);
    meta.appendChild(wetEl);
    meta.appendChild(skyEl);

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
    var trackStr = fmt.tempC(w.trackTempC);
    if (headerState && cache.hdr !== trackStr) {
      cache.hdr = trackStr;
      headerState.textContent = "TRACK " + trackStr;
    }
    if (cache.track !== trackStr) {
      cache.track = trackStr;
      tempEl.innerHTML = trackStr + "<small> track</small>";
    }
    var airStr = "Air " + fmt.tempC(w.ambientTempC);
    if (cache.air !== airStr) { cache.air = airStr; ambientEl.textContent = airStr; }

    // Wetness / rain description.
    var wetPct = fmt.pct(w.trackWetness);
    var rainPct = fmt.pct(w.rainIntensity);
    var wetStr = rainPct > 2 ? "Rain " + Math.round(rainPct) + "%"
      : wetPct > 2 ? "Wet " + Math.round(wetPct) + "%"
      : "Dry";
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
    var wetState = rainPct > 2 ? "rain" : wetPct > 2 ? "wet" : "dry";
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

    // Current sky label from the now-slot when present.
    var nowSlot = slots.length ? slots[0] : null;
    if (nowSlot && cache.sky !== nowSlot.sky) {
      cache.sky = nowSlot.sky;
      skyEl.textContent = SKY_LABEL[nowSlot.sky] || "—";
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

      // Temperature forecast for this slot (air temp when present).
      var tempC = typeof s.airTempC === "number" ? s.airTempC : s.trackTempC;
      var temp = document.createElement("div");
      temp.className = "weather__slot-temp";
      temp.textContent = fmt.has(tempC) ? Math.round(tempC) + "°" : "—";

      var rain = document.createElement("div");
      rain.className = "weather__slot-rain";
      rain.textContent = Math.round(fmt.pct(s.rainChance)) + "%";

      cell.appendChild(time);
      cell.appendChild(temp);
      cell.appendChild(rain);
      forecastEl.appendChild(cell);
    }
  }

  window.ApexOverlay.registerWidget("weather", {
    throttleMs: 250,
    init: init,
    update: update,
  });
})();
