/**
 * widgets/chat.js — live stream chat (YouTube + Twitch), merged.
 * -----------------------------------------------------------------------------
 * Shows the operator's YouTube and Twitch chat as one scrolling column over the
 * game — the widget triple-screen users park on a side monitor's dead space.
 *
 * ## This is the one widget NOT driven by the telemetry frame
 * Every other widget renders `frame.*` pushed over the /ws telemetry socket.
 * Chat is a different kind of data — bursty, ordered, external — so the server
 * carries it on its OWN socket (/chat, see src/server/chatWsServer.ts) and this
 * widget opens that socket itself. It still registers with the runtime so
 * client.js binds and initialises it like any other widget; its `update` is a
 * deliberate no-op because nothing about a telemetry frame concerns it.
 *
 * The server has already done the hard part (IRC tag parsing, emote ranges,
 * YouTube polling) and hands over a normalized message: an author, a colour,
 * badges, and a list of text/emote SEGMENTS. That segment split is what lets
 * this renderer stay safe — see below.
 *
 * ## Untrusted text, handled the only safe way
 * A chat line is arbitrary text typed by a stranger. Every text run is written
 * with `textContent`, never innerHTML, so markup in a message can never become
 * DOM. An emote is an `<img>` whose `src` is set only after its host is checked
 * against EMOTE_HOSTS — the same allowlist the server builds URLs from — so a
 * spoofed feed cannot turn a chat line into an arbitrary outbound request.
 *
 * ## Lightweight over a long stream
 * A three-hour stream is tens of thousands of messages; keeping them all would
 * leak memory until the overlay stutters. The column is a ring buffer — past
 * MAX_LINES the oldest row's DOM node is removed as a new one is appended — so
 * steady-state cost is fixed no matter how long chat runs or how fast it moves.
 *
 * URL params (all optional):
 *   ?chat=<url>    Full ws:// URL of the chat feed (defaults to /chat on the
 *                  page's own host/port, like the telemetry socket's ?ws=).
 *   ?opacity=0..1  HUD opacity (also a hover slider), to sit over the track.
 *   ?lines=<n>     Max visible lines to retain (8..200, default 60).
 */
(function () {
  "use strict";

  /** Image hosts an emote may load from — mirrors EMOTE_HOSTS in chatHub.ts. */
  var EMOTE_HOSTS = [
    "static-cdn.jtvnw.net",
    "yt3.ggpht.com",
    "www.youtube.com",
    "i.ytimg.com",
  ];

  /** Ring-buffer cap: past this the oldest row is dropped as a new one arrives. */
  var MAX_LINES = 60;

  /** localStorage key for the operator's chosen opacity (mirrors radar.js). */
  var OPACITY_KEY = "apex-chat-opacity";
  var MIN_OPACITY = 0.15;

  /**
   * Author-name colours for messages whose platform supplied none (every
   * YouTube message, and Twitch users who never picked one). Hashed from the
   * name so a given viewer is always the same colour. All are light enough to
   * read on the dark panel and over pale tarmac alike.
   */
  var NAME_COLORS = [
    "#ff5470", "#35d07f", "#4f8bff", "#ffb020", "#22d3ee",
    "#ec4899", "#b06bff", "#f65fb0", "#5edaa0", "#ffd23e",
  ];

  var mount, listEl, statusEl;
  var rows = [];
  var atBottom = true;
  var ws = null;
  var reconnectTimer = null;
  var reconnectDelay = 500;
  var RECONNECT_MAX = 8000;
  var chatUrl = "";

  /* ------------------------------- helpers -------------------------------- */

  function nameColor(name) {
    var hash = 0;
    var s = String(name || "");
    for (var i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
    return NAME_COLORS[Math.abs(hash) % NAME_COLORS.length];
  }

  /** True only for an http(s) URL whose host is on the emote allowlist. */
  function safeEmoteUrl(url) {
    if (typeof url !== "string" || !url) return false;
    try {
      var u = new URL(url);
      return (u.protocol === "https:" || u.protocol === "http:") &&
        EMOTE_HOSTS.indexOf(u.hostname) !== -1;
    } catch (e) {
      return false;
    }
  }

  /** Resolve the chat WS URL from the page location, allowing ?chat= override. */
  function resolveChatUrl() {
    var params = new URLSearchParams(window.location.search);
    var explicit = params.get("chat");
    if (explicit) return explicit;
    var proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    var host = window.location.hostname || "127.0.0.1";
    var port = params.get("port") || window.location.port || "8080";
    return proto + "//" + host + ":" + port + "/chat";
  }

  /* ------------------------------- rendering ------------------------------ */

  /** A small platform tag (YT / TW), coloured to the service. */
  function platformTag(platform) {
    var tag = document.createElement("span");
    tag.className = "chat__plat chat__plat--" + (platform === "youtube" ? "yt" : "tw");
    tag.textContent = platform === "youtube" ? "YT" : "TW";
    return tag;
  }

  /** The role badges before a name, from the shared vocabulary. */
  var BADGE_LABEL = {
    broadcaster: "HOST",
    mod: "MOD",
    vip: "VIP",
    member: "MBR",
    verified: "✓",
  };

  function badgeEl(kind) {
    var b = document.createElement("span");
    b.className = "chat__badge chat__badge--" + kind;
    b.textContent = BADGE_LABEL[kind] || "";
    b.title = kind;
    return b;
  }

  /** Build one chat row from a normalized message. Text is never innerHTML. */
  function buildRow(msg) {
    var row = document.createElement("div");
    row.className = "chat__row";

    row.appendChild(platformTag(msg.platform));

    var badges = msg.badges || [];
    for (var i = 0; i < badges.length; i++) {
      if (BADGE_LABEL[badges[i]]) row.appendChild(badgeEl(badges[i]));
    }

    var author = document.createElement("span");
    author.className = "chat__author";
    author.textContent = msg.author || "—";
    author.style.color =
      /^#[0-9a-fA-F]{6}$/.test(msg.color || "") ? msg.color : nameColor(msg.author);
    row.appendChild(author);

    var sep = document.createElement("span");
    sep.className = "chat__sep";
    sep.textContent = ":";
    row.appendChild(sep);

    var body = document.createElement("span");
    body.className = "chat__body";
    var segments = msg.segments || [];
    for (var s = 0; s < segments.length; s++) {
      var seg = segments[s];
      if (seg && seg.kind === "emote" && safeEmoteUrl(seg.url)) {
        var img = document.createElement("img");
        img.className = "chat__emote";
        img.alt = String(seg.text || "");
        img.src = seg.url;
        // A missing/blocked emote must never leave a broken-image glyph in the
        // line — fall back to its name text.
        img.onerror = (function (el, name) {
          return function () {
            var t = document.createElement("span");
            t.textContent = name;
            if (el.parentNode) el.parentNode.replaceChild(t, el);
          };
        })(img, seg.text || "");
        body.appendChild(img);
      } else if (seg) {
        // Text (or an emote whose URL failed the host check — render its name).
        body.appendChild(document.createTextNode(String(seg.text || "")));
      }
    }
    row.appendChild(body);
    return row;
  }

  /** Append a message, dropping the oldest row past the ring-buffer cap. */
  function addMessage(msg) {
    if (!listEl || !msg) return;
    var row = buildRow(msg);
    listEl.appendChild(row);
    rows.push(row);
    while (rows.length > MAX_LINES) {
      var old = rows.shift();
      if (old && old.parentNode) old.parentNode.removeChild(old);
    }
    if (atBottom) listEl.scrollTop = listEl.scrollHeight;
  }

  function setStatus(text, show) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.hidden = !show;
  }

  /* ------------------------------ connection ------------------------------ */

  function scheduleReconnect() {
    if (reconnectTimer) return;
    setStatus("Reconnecting…", rows.length === 0);
    reconnectTimer = window.setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(RECONNECT_MAX, reconnectDelay * 2);
  }

  function connect() {
    try {
      ws = new WebSocket(chatUrl);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    ws.onopen = function () {
      reconnectDelay = 500;
      setStatus("Waiting for chat…", rows.length === 0);
    };
    ws.onmessage = function (event) {
      var env;
      try {
        env = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (!env || typeof env !== "object") return;
      if (env.type === "backlog" && Array.isArray(env.messages)) {
        for (var i = 0; i < env.messages.length; i++) addMessage(env.messages[i]);
        if (env.messages.length) setStatus("", false);
      } else if (env.type === "msg" && env.message) {
        setStatus("", false);
        addMessage(env.message);
      }
    };
    ws.onclose = function () {
      ws = null;
      scheduleReconnect();
    };
    ws.onerror = function () {
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        try { ws.close(); } catch (e) { /* ignore */ }
      }
    };
  }

  /* ------------------------------- controls ------------------------------- */
  // Same hover-slider contract as radar.js: fade the CONTENTS, not the section,
  // so the slider stays reachable, and stop a slider drag from dragging the
  // whole widget in the in-game layer.

  function stored(key) {
    try {
      var raw = localStorage.getItem(key);
      if (raw !== null && isFinite(parseFloat(raw))) return parseFloat(raw);
    } catch (e) { /* private mode */ }
    return null;
  }

  function buildControls(root, params) {
    var applyOpacity = function (v) {
      root.style.setProperty("--chat-op", String(v));
      root.setAttribute("data-transparent", v < 1 ? "true" : "false");
    };
    var savedOp = stored(OPACITY_KEY);
    var urlOp = parseFloat(params.get("opacity"));
    var op = isFinite(urlOp) ? urlOp : savedOp !== null ? savedOp : 1;
    op = Math.min(1, Math.max(MIN_OPACITY, op));

    var anchor = document.createElement("div");
    anchor.className = "chat__ctl-anchor";
    var bar = document.createElement("div");
    bar.className = "chat__ctl";
    var label = document.createElement("span");
    label.className = "chat__ctl-label";
    label.textContent = "OPACITY";
    var slider = document.createElement("input");
    slider.className = "chat__ctl-range";
    slider.type = "range";
    slider.min = String(Math.round(MIN_OPACITY * 100));
    slider.max = "100";
    slider.step = "1";
    slider.value = String(Math.round(op * 100));
    var readout = document.createElement("span");
    readout.className = "chat__ctl-val";
    readout.textContent = slider.value + "%";
    slider.addEventListener("input", function () {
      var v = Math.min(100, Math.max(MIN_OPACITY * 100, Number(slider.value)));
      readout.textContent = Math.round(v) + "%";
      applyOpacity(v / 100);
      try { localStorage.setItem(OPACITY_KEY, String(v / 100)); } catch (e) { /* ignore */ }
    });
    ["pointerdown", "mousedown", "touchstart"].forEach(function (evt) {
      bar.addEventListener(evt, function (e) { e.stopPropagation(); });
    });
    bar.appendChild(label);
    bar.appendChild(slider);
    bar.appendChild(readout);
    anchor.appendChild(bar);
    root.appendChild(anchor);
    applyOpacity(op);
  }

  /* --------------------------------- init --------------------------------- */

  function init(root) {
    mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML = "";
    var params = new URLSearchParams(window.location.search);

    var lines = parseInt(params.get("lines"), 10);
    if (isFinite(lines)) MAX_LINES = Math.min(200, Math.max(8, lines));

    buildControls(root, params);

    listEl = document.createElement("div");
    listEl.className = "chat__list";
    // Track whether the operator has scrolled up (interact mode) so a burst of
    // new messages doesn't yank them back to the bottom mid-read.
    listEl.addEventListener("scroll", function () {
      atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 24;
    });
    mount.appendChild(listEl);

    statusEl = document.createElement("div");
    statusEl.className = "chat__status";
    statusEl.textContent = "Connecting…";
    mount.appendChild(statusEl);

    chatUrl = resolveChatUrl();
    connect();

    window.addEventListener("pagehide", function () {
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
    });
  }

  window.ApexOverlay.registerWidget("chat", {
    throttleMs: 1000,
    init: init,
    // Chat rides its own /chat socket, not the telemetry frame — nothing to do
    // here, but a no-op keeps the dispatcher from logging a missing handler.
    update: function () {},
  });
})();
