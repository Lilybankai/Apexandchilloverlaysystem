/**
 * widgets/standings.js — full-field race standings (top-left panel).
 * -----------------------------------------------------------------------------
 * Renders `frame.standings` (StandingEntry[]) as a class-grouped timing tower:
 *
 *   ┌ session strip ─ LAP x/y · laps left · clock (or the session name) ──┐
 *   ├ FASTEST LAP · #20 Robin Frijns · 1:37.833 ──────────────────────────┤
 *   │ POS  ±  DRIVER            GAP     LAST      BEST    VE               │
 *   ├ HYPERCAR · 6 CARS ─────────────────────────────────────────────────┤
 *   │  1   ▲2  ● #7 Kamui Kobayashi   —  1:38.412  1:37.833  57%      [P] │
 *   ├ GT3 · 9 CARS ───────────────────────────────────────────────────────┤
 *   │  ...                                                                 │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * Extra columns vs. the plain tower:
 *   - ±  positions gained (green ▲) / lost (red ▼) vs. the grid, from
 *     `gridPosition`.
 *   - VE virtual-energy % remaining (`virtualEnergy`, LMU's per-car budget) with
 *     a thin fill bar behind it.
 *   - P  a flag on cars in the pit lane (`inPit`), at the right edge of the row
 *     rather than appended to the name — see createRow.
 * GAP counts either the cumulative gap to the class leader (the default) or the
 * interval to the car directly in front — an operator setting, because a
 * broadcast tower wants the first and a driver usually wants the second.
 * FASTEST LAP reports one lap per class (the default) or the one fastest lap in
 * the race — an operator setting. Per class is the default because in a
 * multiclass field the overall fastest belongs to the quickest category and says
 * nothing at all about the race the other three are having; a single-class field
 * gets a single line either way, so the default costs nothing there.
 * Highlighting:
 *   - the fastest lap of the race (or of each class) is shown in purple,
 *     persistently;
 *   - a car setting a new personal-best lap flashes its LAST time green for a
 *     few seconds, then fades.
 *
 * Rows are grouped by class (classes ordered by their leader's position), and
 * each group carries a subheader so a viewer instantly reads which category is
 * which. A keyed reconciler (one <tr> per slotId, reused across frames) keeps
 * the DOM churn-free: we only touch text that changed and reorder by moving
 * existing nodes rather than rebuilding innerHTML.
 */
(function () {
  "use strict";

  // What a class looks like and what it is called both come from the shared
  // runtime (js/client.js). This palette and label map used to live here and
  // AGAIN, verbatim, in radar.js — one edit away from the tower and the radar
  // disagreeing about which green is GT3. The relative panel now draws the same
  // colours a third time, which made keeping copies indefensible.
  var classColor = window.ApexOverlay.classColor;
  var classLabel = window.ApexOverlay.classLabel;

  /**
   * The name as the driver entered it, tidied of stray whitespace and nothing
   * else. Names that outrun the column are cut with an ellipsis by the CSS.
   *
   * This used to render the broadcast form, "theo Pereira" -> "T. Pereira", and
   * that is the wrong trade for a field of people you race with by name: an
   * initial is unrecognisable in a sim field where several drivers share a
   * surname and everyone knows each other by their first name. It is also a
   * false economy — the abbreviation saved a handful of pixels on the names that
   * already fitted, and the long ones it was supposed to rescue still clipped.
   * Where a name does not fit, the cut now falls at the END of it, so the first
   * name always survives (relative.js has always drawn names this way).
   */
  function displayName(name) {
    if (!name) return "—";
    return name.trim().replace(/\s+/g, " ");
  }

  /** How long a new personal-best lap flashes green (ms). */
  var PB_FLASH_MS = 5000;

  var mount, setSession, sessFastest, tbody;
  /** The GAP column heading — its wording follows the operator's gap mode. */
  var headGap = null;
  /** @type {Map<number, object>} slotId -> cached row element + last values. */
  var rows = new Map();
  /** @type {Map<number, object>} slotId -> { laps, best, flashUntil }. */
  var track = new Map();
  /** @type {Map<string, object>} classKey -> cached subheader element. */
  var groups = new Map();
  /**
   * @type {Map<string, object>} banner line key -> cached element. One entry
   * under `__overall`, or one per class in `fastest=class`.
   */
  var fastestLines = new Map();

  function createRow() {
    var tr = document.createElement("tr");
    tr.className = "standings__row";

    var posTd = document.createElement("td");
    posTd.className = "standings__cell standings__pos";

    // Positions gained/lost vs. the grid.
    var deltaTd = document.createElement("td");
    deltaTd.className = "standings__cell standings__delta";

    var driverTd = document.createElement("td");
    driverTd.className = "standings__cell standings__driver";
    // "YOU", first thing in the cell, on the driver's own row and nowhere else.
    // The row highlight is a colour, and in this tower a colour is ambiguous by
    // construction: every class already owns one, the palette LMP3 hashes to is
    // the same cyan the player accent uses, and the purple and green on the lap
    // times are colours too. A word is not ambiguous. It is also the only mark
    // that still reads when the Widget background slider is at 0 and there is
    // tarmac behind the row.
    //
    // Leading rather than trailing: it costs the player's row a few pixels of
    // name, which is the one row whose name the driver already knows, and it
    // lands at the same x as every other row's class dot — so the eye running
    // DOWN the tower meets it without having to read across.
    var you = document.createElement("span");
    you.className = "standings__you";
    you.textContent = "YOU";
    you.hidden = true;
    var classDot = document.createElement("span");
    classDot.className = "standings__class";
    // Manufacturer badge, between the class dot and the name — the game's own
    // brand artwork, proxied by our server (see renderRow). Hidden until a
    // manufacturer is known, and re-hidden if its file fails to load, so a sim
    // with no badge set (rF2, demo) renders exactly the tower it always did.
    var badge = document.createElement("img");
    badge.className = "standings__badge";
    badge.alt = "";
    badge.hidden = true;
    badge.onerror = function () {
      badge.hidden = true;
    };
    var nameSpan = document.createElement("span");
    driverTd.appendChild(you);
    driverTd.appendChild(classDot);
    driverTd.appendChild(badge);
    driverTd.appendChild(nameSpan);

    // Virtual energy: a bar-backed % cell.
    var veTd = document.createElement("td");
    veTd.className = "standings__cell standings__ve";
    var veBar = document.createElement("span");
    veBar.className = "standings__ve-bar";
    var veText = document.createElement("span");
    veText.className = "standings__ve-text";
    veTd.appendChild(veBar);
    veTd.appendChild(veText);

    var gapTd = document.createElement("td");
    gapTd.className = "standings__cell standings__gap";

    var bestTd = document.createElement("td");
    bestTd.className = "standings__cell standings__best";

    var lastTd = document.createElement("td");
    // is-crit carries the bloom for a personal best landing (see renderRow). The
    // lap TIME itself is not routed through ctx.crit — every car's last lap
    // changes every lap, and 32 rows blooming in sequence is wallpaper.
    lastTd.className = "standings__cell standings__last is-crit";

    // Pit flag: a marker at the far RIGHT of the row rather than a " ·PIT"
    // glued to the driver's name. The name column is the one the eye reads
    // DOWN the tower, and a suffix there put a transient state inside an
    // identity — it moved with the name, took four more characters off the
    // column that has none to give, and vanished into the text around it. In
    // its own column the flag lands at the same x on every row, which is what
    // makes a pit lane scannable at a glance.
    var pitTd = document.createElement("td");
    pitTd.className = "standings__cell standings__pit";
    var pitFlag = document.createElement("span");
    // `is-off`, not the `hidden` attribute the badge above uses: the flag has to
    // keep its box when it is off or the column would resize as the pit lane
    // fills and empties. See .pit-flag.is-off.
    pitFlag.className = "pit-flag is-off";
    pitFlag.textContent = "P";
    pitFlag.title = "In the pit lane";
    pitTd.appendChild(pitFlag);

    // VE goes to the RIGHT of the lap times, not between the name and the gap.
    // The tower reads left to right as identity then race — who the car is, then
    // where it is and how fast it is going — and energy is neither: it is the
    // strategy fact you consult after you have read the race, and it was
    // interrupting the run of times to sit where it did. Its bar is also the only
    // non-text mark in the table, and against the driver names it was the loudest
    // thing in a column that is meant to be scanned, not looked at.
    // LAST sits next to GAP, BEST outside it. The two of them are read together:
    // the gap tells you where a car is and its last lap tells you whether that
    // gap is about to change. BEST is a season-long fact by comparison — it
    // answers what a car is capable of, which is a question you ask once.
    tr.appendChild(posTd);
    tr.appendChild(deltaTd);
    tr.appendChild(driverTd);
    tr.appendChild(gapTd);
    tr.appendChild(lastTd);
    tr.appendChild(bestTd);
    tr.appendChild(veTd);
    tr.appendChild(pitTd);

    return {
      tr: tr,
      posTd: posTd,
      deltaTd: deltaTd,
      driverTd: driverTd,
      you: you,
      classDot: classDot,
      badge: badge,
      nameSpan: nameSpan,
      veTd: veTd,
      veBar: veBar,
      veText: veText,
      gapTd: gapTd,
      bestTd: bestTd,
      lastTd: lastTd,
      pitFlag: pitFlag,
      cache: {},
    };
  }

  /** A full-width subheader row that introduces a class group. */
  function createGroup() {
    var tr = document.createElement("tr");
    tr.className = "standings__grouprow";
    var td = document.createElement("td");
    td.className = "standings__group";
    td.colSpan = 8;
    var dot = document.createElement("span");
    dot.className = "standings__group-dot";
    var label = document.createElement("span");
    label.className = "standings__group-label";
    var count = document.createElement("span");
    count.className = "standings__group-count";
    td.appendChild(dot);
    td.appendChild(label);
    td.appendChild(count);
    tr.appendChild(td);
    return { tr: tr, dot: dot, label: label, count: count, cache: {} };
  }

  // Only write to the DOM when a value actually changed.
  function set(row, key, el, prop, value) {
    if (row.cache[key] === value) return;
    row.cache[key] = value;
    el[prop] = value;
  }

  /* ------------------------------------------------------------------ */
  /*  How much of the field to draw                                      */
  /* ------------------------------------------------------------------ */

  /**
   * A full grid is 20-30 rows: right for a broadcast, far too much screen for
   * someone driving. `view` says how much of it to keep.
   *
   *   limit   'all' draws the field, exactly as this tower always has.
   *   top     leaders always kept
   *   ahead   cars in front of you
   *   behind  cars behind you
   *   scope   whether those are counted inside YOUR CLASS or across the field
   *
   * Two ideas rather than a list of layout modes, because they compose: "three
   * in front, three behind" is top 0 with a 3/3 window, and "top ten of each
   * class" is top 10, scope class. Anything anyone has asked for so far is one
   * of those two with different numbers.
   */
  var view = {
    limit: "all",
    scope: "class",
    top: 0,
    ahead: 3,
    behind: 3,
    gap: "leader",
    fastest: "class",
  };
  var viewPinned = false;

  /**
   * `?standings=all` or `?standings=top=10,scope=class,ahead=3,behind=3` pins
   * the composition for one OBS source. Same contract as the tyres widget's
   * `?tyres=`: a source set up to show the front of the race must not change
   * because a driver pressed something.
   *
   * `gap=ahead` switches the GAP column to intervals, and `fastest=overall`
   * collapses the banner's per-class lines to the one fastest lap of the race.
   * Both are independent of the composition, so
   * `?standings=all,gap=ahead,fastest=overall` is the whole field with intervals
   * and a single fastest lap.
   */
  function initView(params) {
    var raw = (params.get("standings") || "").trim().toLowerCase();
    if (raw) {
      viewPinned = true;
      var next = {
        limit: "custom",
        scope: "class",
        top: 0,
        ahead: 0,
        behind: 0,
        gap: "leader",
        fastest: "class",
      };
      var parts = raw.split(",");
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i].trim();
        // `all` is a bare token rather than a key=value, so the long-standing
        // `?standings=all` keeps working — and still combines with `gap=`.
        if (part === "all") {
          next.limit = "all";
          continue;
        }
        var kv = part.split("=");
        var key = (kv[0] || "").trim();
        var val = (kv[1] || "").trim();
        if (key === "scope") next.scope = val === "field" ? "field" : "class";
        else if (key === "gap") next.gap = val === "ahead" ? "ahead" : "leader";
        else if (key === "fastest") next.fastest = val === "overall" ? "overall" : "class";
        else if (key === "top" || key === "ahead" || key === "behind") {
          var n = parseInt(val, 10);
          if (isFinite(n)) next[key] = Math.min(30, Math.max(0, n));
        }
      }
      view = next;
      return;
    }
    if (window.ApexAppearance && window.ApexAppearance.onStandings) {
      window.ApexAppearance.onStandings(function (next) {
        if (viewPinned || !next) return;
        view = next;
      });
    }
  }

  /** Index of the player in a list, or -1 when they are not in it. */
  function playerIndex(list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].isPlayer) return i;
    }
    return -1;
  }

  /** Keep the first `n` of `list`. */
  function keepTop(list, n, keep) {
    for (var i = 0; i < n && i < list.length; i++) keep[list[i].slotId] = true;
  }

  /**
   * Keep a window around the player: `ahead` in front, `behind` behind, and the
   * player themselves.
   *
   * With no player in the list — a spectator feed, a replay — the window is
   * anchored at the leader instead of vanishing, so the same setting still
   * draws the same NUMBER of cars. A tower that empties itself the moment you
   * leave the car would look broken rather than configured.
   */
  function keepWindow(list, idx, ahead, behind, keep) {
    var anchor = idx < 0 ? 0 : idx;
    var from = idx < 0 ? 0 : anchor - ahead;
    var to = idx < 0 ? ahead + behind : anchor + behind;
    for (var i = Math.max(0, from); i <= to && i < list.length; i++) {
      keep[list[i].slotId] = true;
    }
  }

  /**
   * The cars this tower draws, in the order the server sent them.
   *
   * Selection only — the caller still groups by class and renders, so a filtered
   * tower is the same tower with fewer rows in it, not a second layout to keep
   * in step with the first.
   */
  function selectField(list) {
    if (!view || view.limit !== "custom") return list;

    var keep = {};
    var fieldPlayer = playerIndex(list);
    if (view.scope === "field") {
      keepTop(list, view.top, keep);
      keepWindow(list, fieldPlayer, view.ahead, view.behind, keep);
    } else {
      var byClass = {};
      var order = [];
      for (var i = 0; i < list.length; i++) {
        var k = list[i].carClass || "—";
        if (!byClass[k]) {
          byClass[k] = [];
          order.push(k);
        }
        byClass[k].push(list[i]);
      }
      for (var g = 0; g < order.length; g++) {
        var members = byClass[order[g]];
        keepTop(members, view.top, keep);
        var pIdx = playerIndex(members);
        // Only the player's own class gets a window — a 3-ahead/3-behind view
        // means the cars racing YOU, not three arbitrary cars from every class.
        // With nobody driving at all (spectating, a replay) there is no "you" to
        // be racing, so every class anchors its window at its own leader. That
        // keeps the two scopes consistent: the same setting draws the same
        // number of cars whether or not anyone is in a car.
        if (pIdx >= 0) keepWindow(members, pIdx, view.ahead, view.behind, keep);
        else if (fieldPlayer < 0) keepWindow(members, -1, view.ahead, view.behind, keep);
      }
    }

    // You are never filtered out of your own standings.
    if (fieldPlayer >= 0) keep[list[fieldPlayer].slotId] = true;

    var out = [];
    for (var j = 0; j < list.length; j++) {
      if (keep[list[j].slotId]) out.push(list[j]);
    }
    // A composition that selects nobody would draw an empty panel, which reads
    // as a broken widget rather than a configured one.
    return out.length ? out : list;
  }

  /* ------------------------------------------------------------------ */
  /*  What the GAP column counts                                         */
  /* ------------------------------------------------------------------ */

  /** Whole laps behind, treating an absent count as "same lap". */
  function lapsOf(n) {
    return typeof n === "number" && n > 0 ? n : 0;
  }

  /**
   * One GAP cell: a dash when there is nobody in front, whole laps when the
   * deficit is a lap or more, otherwise seconds. Both readings of the column
   * (to the leader, to the car ahead) go through here so they stay one shape.
   */
  function gapCell(isFirst, laps, sec, fmt) {
    if (isFirst) return "—";
    if (laps > 0) return "+" + laps + "L";
    return fmt.gap(sec);
  }

  /**
   * Interval to the car directly in front, keyed by slotId.
   *
   * Derived rather than read from `gapToAheadSec`, which is the sim's gap to the
   * next car OVERALL: under a class subheader showing in-class positions, an
   * interval to a Hypercar that happens to be sitting between two GT3s is not
   * the number the row appears to be claiming. Differencing two cars' gaps to
   * their shared class leader cancels the leader term and leaves exactly the
   * in-class interval; `gapToAheadSec` stays as the fallback for a field with no
   * class information, and for a pair the sim gives no class gaps for.
   *
   * Computed from the FULL field, never the drawn rows — with the tower capped
   * to a few cars, the row above yours on screen is usually not the car you are
   * actually chasing.
   */
  function computeIntervals(full, fmt) {
    var out = {};
    var prevInClass = {};
    for (var i = 0; i < full.length; i++) {
      var e = full[i];
      var inClass = fmt.has(e.classPosition) && e.classPosition > 0;
      var key = e.carClass || "—";
      var prev = inClass ? prevInClass[key] : full[i - 1];
      if (inClass) prevInClass[key] = e;

      // Nobody ahead: a class leader when we are counting in class, P1 when we
      // are not. Same dash the leader reading shows, for the same reason.
      if (!prev) {
        out[e.slotId] = { lead: true, laps: 0, sec: -1 };
        continue;
      }

      var laps = inClass
        ? lapsOf(e.classLapsBehind) - lapsOf(prev.classLapsBehind)
        : lapsOf(e.lapsBehind) - lapsOf(prev.lapsBehind);
      var sec = -1;
      if (inClass && fmt.has(e.gapToClassLeaderSec) && fmt.has(prev.gapToClassLeaderSec)) {
        // Clamped at zero: two gaps sampled a frame apart can cross by a
        // millisecond, and a negative interval to the car in FRONT of you reads
        // as a broken widget rather than as noise.
        sec = Math.max(0, e.gapToClassLeaderSec - prev.gapToClassLeaderSec);
      } else if (prev === full[i - 1]) {
        // No class gaps to difference, but the car ahead in class is also the
        // car ahead overall — so the sim's own figure is the same interval.
        sec = e.gapToAheadSec;
      }
      out[e.slotId] = { lead: false, laps: laps > 0 ? laps : 0, sec: sec };
    }
    return out;
  }

  function init(root) {
    initView(new URLSearchParams(window.location.search));
    mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML = "";

    // Session strip: the lap counter, the laps still to run, and a countdown
    // clock for timed sessions. Practice and qualifying have a clock but no lap
    // total to count towards, so the counter there is the driver's own tally of
    // laps completed and the session's name moves beside it. The runtime owns
    // all of that wording (client.js `sessionHeadline`) so this strip and the
    // fuel panel's cannot end up disagreeing about how much of the session is
    // left.
    setSession = window.ApexOverlay.sessionStrip(mount, { flush: true });

    // Fastest-lap banner: who holds it and what it is. Sits on its own line
    // under the session strip so it never squeezes the lap counter. A container
    // rather than a single line, because in `fastest=class` it carries one line
    // per class (see updateFastestBanner).
    sessFastest = document.createElement("div");
    sessFastest.className = "standings__fastest";
    sessFastest.hidden = true;
    mount.appendChild(sessFastest);

    var table = document.createElement("table");
    table.className = "standings__table";
    // Explicit column widths via <colgroup> so table-layout:fixed sizes columns
    // deterministically — without this the class-header (a colspan row) makes
    // the browser split the table into equal columns and starve the driver name.
    // The driver column has no width, so it absorbs the remaining space.
    var colgroup = document.createElement("colgroup");
    // pos, ±, driver(rest), gap, last, best, VE, pit — the order the cells are
    // appended in createRow, and it has to stay in step with it (as does the
    // heading row in createHead). The seven fixed columns total 316px of the
    // panel's 474px, leaving ~158px for the driver name. The three time columns
    // are sized for a full "1:58.492" — undersize them and the tenths silently
    // clip off the right.
    //
    // The pit column is 18px of mostly-empty table, and it is reserved on every
    // row on purpose: sizing it to the field's current pit lane would shift
    // every name sideways each time the lane emptied, and the name column is
    // the one being read.
    //
    // Given in em, NOT px, because these widths are only correct relative to the
    // text they hold and that text now scales with --fs-scale (the operator's
    // "Text size" slider). At a fixed 70px, "1:58.492" clips the moment the
    // slider passes ~110%. em on a <col> resolves against the font-size it
    // inherits from the table, which is --fs-body — so the divisor here is the
    // 12px --fs-body is defined as, and the ratios hold at every scale.
    var BASE_PX = 12;
    var widths = [26, 28, 0, 62, 70, 70, 42, 18];
    for (var c = 0; c < widths.length; c++) {
      var col = document.createElement("col");
      if (widths[c] > 0) col.style.width = (widths[c] / BASE_PX).toFixed(3) + "em";
      colgroup.appendChild(col);
    }
    table.appendChild(colgroup);
    table.appendChild(createHead());
    tbody = document.createElement("tbody");
    table.appendChild(tbody);
    mount.appendChild(table);

    initSponsors(mount);
  }

  /**
   * Column headings, one row, above the first class group.
   *
   * Six of these columns are numbers with no units, and until now the only way
   * to know that the third of them was the car's BEST lap rather than its last
   * was to have been told. That is fine for the operator who configured the
   * panel and useless to everyone watching it.
   *
   * They are deliberately the quietest text in the widget — micro, muted, in the
   * display face — because a heading is read once and then never again, while
   * the rows under it are read all race. The GAP heading is the exception that
   * changes: it says what the column is actually counting, which is an operator
   * setting (see the gap logic in renderRow) and not something a viewer can
   * infer from the numbers. The pit column has no heading — a three-letter word
   * does not fit in 18px, and the flag under it carries its own tooltip.
   */
  function createHead() {
    var thead = document.createElement("thead");
    var tr = document.createElement("tr");
    tr.className = "standings__headrow";
    var labels = ["POS", "±", "DRIVER", "GAP", "LAST", "BEST", "VE", ""];
    var classes = ["pos", "delta", "driver", "gap", "last", "best", "ve", "pit"];
    for (var i = 0; i < labels.length; i++) {
      var th = document.createElement("th");
      th.className = "standings__head standings__" + classes[i];
      th.scope = "col";
      th.textContent = labels[i];
      tr.appendChild(th);
    }
    headGap = tr.children[3];
    thead.appendChild(tr);
    return thead;
  }

  /* ------------------------------ sponsor strip ---------------------------- */

  /**
   * Rotating sponsor logo strip under the tower, the way a real broadcast
   * timing graphic carries its partners.
   *
   * The list comes from `/sponsors/index.json` (operator configuration served by
   * our own server), NOT from the telemetry frame — branding is static, and
   * putting it on the wire would repeat the same payload 30 times a second.
   * Rotation is a CSS opacity transition driven by one timer, so the widget
   * costs nothing per telemetry frame.
   */
  var sponsorStrip, sponsorImgA, sponsorImgB;
  var sponsorLogos = [];
  var sponsorIdx = 0;
  var sponsorShowingA = true;
  var sponsorTimer = null;

  function initSponsors(root) {
    sponsorStrip = document.createElement("div");
    sponsorStrip.className = "standings__sponsors";
    sponsorStrip.hidden = true;
    // Two stacked images cross-fade between them; swapping the src of a single
    // <img> would flash white while the next file decodes.
    sponsorImgA = document.createElement("img");
    sponsorImgA.className = "standings__sponsor is-on";
    sponsorImgA.alt = "";
    sponsorImgB = document.createElement("img");
    sponsorImgB.className = "standings__sponsor";
    sponsorImgB.alt = "";
    sponsorStrip.appendChild(sponsorImgA);
    sponsorStrip.appendChild(sponsorImgB);
    root.appendChild(sponsorStrip);
    loadSponsors();
  }

  function loadSponsors() {
    fetch("/sponsors/index.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) {
        if (!cfg || !Array.isArray(cfg.logos) || cfg.logos.length === 0) {
          sponsorStrip.hidden = true;
          return;
        }
        sponsorLogos = cfg.logos.map(function (n) {
          return "/sponsors/" + encodeURIComponent(n);
        });
        var everySec = typeof cfg.intervalSec === "number" && cfg.intervalSec >= 3
          ? cfg.intervalSec
          : 12;
        sponsorIdx = 0;
        sponsorImgA.src = sponsorLogos[0];
        sponsorStrip.hidden = false;
        if (sponsorTimer) clearInterval(sponsorTimer);
        // A single logo has nothing to rotate to — show it and stop.
        if (sponsorLogos.length > 1) {
          sponsorTimer = setInterval(rotateSponsor, everySec * 1000);
        }
      })
      .catch(function () {
        // No server route / no sponsors configured: stay hidden. This is the
        // normal case for most users, not an error worth logging.
        sponsorStrip.hidden = true;
      });
  }

  function rotateSponsor() {
    sponsorIdx = (sponsorIdx + 1) % sponsorLogos.length;
    var incoming = sponsorShowingA ? sponsorImgB : sponsorImgA;
    var outgoing = sponsorShowingA ? sponsorImgA : sponsorImgB;
    incoming.src = sponsorLogos[sponsorIdx];
    incoming.classList.add("is-on");
    outgoing.classList.remove("is-on");
    sponsorShowingA = !sponsorShowingA;
  }

  function update(frame, ctx) {
    var fmt = ctx.fmt;
    var now = Date.now();
    // `full` is the field; `list` is what this tower draws. The two differ only
    // when the operator has capped the view — and everything that is a fact
    // about the RACE rather than about the panel (the purple lap, each class's
    // benchmark, how many cars are in a class) is still read from the full
    // field. A trimmed tower must not claim GT3 has three cars in it.
    var full = frame.standings || [];
    var list = selectField(full);
    var seen = new Set();
    // Intervals are only derived when the column is actually showing them — a
    // pass over the field every frame is cheap, but not free, and the default
    // view never reads it.
    var intervals = view && view.gap === "ahead" ? computeIntervals(full, fmt) : null;

    // The GAP heading says which of the two readings the column holds. Written
    // here rather than in init because the mode is a view setting read from the
    // URL, and this is the one place that already knows which way it went.
    var gapHead = intervals ? "INT" : "GAP";
    if (headGap && headGap.textContent !== gapHead) {
      headGap.textContent = gapHead;
      headGap.title = intervals
        ? "Interval to the car directly ahead"
        : "Gap to the class leader";
    }

    setSession(frame.session, window.ApexOverlay.playerLapsCompleted(frame));

    // Fastest lap of the race and fastest lap per class. Both are always
    // derived: which one the banner and the purple actually mean is the
    // `fastest` setting, and the other still feeds the green benchmark below.
    // Class order here follows the field, so the banner lists classes in the
    // same order the tower groups them.
    var fastestSlot = -1;
    var fastestSec = Infinity;
    var fastestEntry = null;
    /** @type {Object<string, {sec: number, slot: number, entry: object}>} */
    var classFastest = {};
    /** @type {string[]} class keys, in leader order. */
    var classOrder = [];
    for (var f = 0; f < full.length; f++) {
      var ck = full[f].carClass || "—";
      if (!classFastest[ck]) {
        classFastest[ck] = null;
        classOrder.push(ck);
      }
      var b = full[f].bestLapSec;
      if (!fmt.has(b)) continue;
      if (b < fastestSec) {
        fastestSec = b;
        fastestSlot = full[f].slotId;
        fastestEntry = full[f];
      }
      if (!classFastest[ck] || b < classFastest[ck].sec) {
        classFastest[ck] = { sec: b, slot: full[f].slotId, entry: full[f] };
      }
    }
    // Tested against 'overall' rather than for 'class' so that a view arriving
    // without the field at all — an older config, a server that has not been
    // updated — lands on the default rather than silently on the other mode.
    var perClass = !view || view.fastest !== "overall";
    updateFastestBanner(perClass, classOrder, classFastest, fastestEntry, fastestSec, fmt);

    // Group entries by class, preserving position order within a class and
    // ordering the classes by their best (lowest) position.
    var order = [];
    var byClass = {};
    for (var i = 0; i < list.length; i++) {
      var key = list[i].carClass || "—";
      if (!byClass[key]) {
        byClass[key] = [];
        order.push(key);
      }
      byClass[key].push(list[i]);
    }

    // True class sizes, so a capped tower still says how big the class is.
    var classTotal = {};
    for (var t = 0; t < full.length; t++) {
      var tk = full[t].carClass || "—";
      classTotal[tk] = (classTotal[tk] || 0) + 1;
    }

    var seenGroups = new Set();
    for (var g = 0; g < order.length; g++) {
      var cls = order[g];
      var members = byClass[cls];

      // Class subheader.
      var grp = groups.get(cls);
      if (!grp) {
        grp = createGroup();
        groups.set(cls, grp);
      }
      seenGroups.add(cls);
      var col = classColor(cls);
      if (grp.cache.dot !== col) {
        grp.cache.dot = col;
        grp.dot.style.background = col;
        grp.tr.style.setProperty("--class-color", col);
      }
      set(grp, "label", grp.label, "textContent", classLabel(cls));
      var total = classTotal[cls] || members.length;
      var countText =
        members.length < total
          ? members.length + " OF " + total + " CARS"
          : total + (total === 1 ? " CAR" : " CARS");
      set(grp, "count", grp.count, "textContent", countText);
      tbody.appendChild(grp.tr);

      // Member rows. Which lap wears the purple is the `fastest` setting: the
      // one fastest lap in the race, or this class's. In per-class mode the
      // green benchmark is dropped rather than moved — it exists to surface the
      // class best when the purple cannot, and there the purple already is it.
      var clsFastestSlot = classFastest[cls] ? classFastest[cls].slot : -1;
      var purpleSlot = perClass ? clsFastestSlot : fastestSlot;
      var greenSlot = perClass ? -1 : clsFastestSlot;
      for (var m = 0; m < members.length; m++) {
        renderRow(members[m], fmt, now, purpleSlot, greenSlot, ctx, intervals);
        seen.add(members[m].slotId);
      }
    }

    // Drop rows for cars no longer in the field.
    rows.forEach(function (row, slot) {
      if (!seen.has(slot)) {
        if (row.tr.parentNode) row.tr.parentNode.removeChild(row.tr);
        rows.delete(slot);
        track.delete(slot);
      }
    });
    // Drop subheaders for classes no longer present.
    groups.forEach(function (grp, cls) {
      if (!seenGroups.has(cls)) {
        if (grp.tr.parentNode) grp.tr.parentNode.removeChild(grp.tr);
        groups.delete(cls);
      }
    });
  }

  /** "#7 M. Slater", or just the name when the car carries no number. */
  function holderName(entry) {
    var who = displayName(entry.driverName);
    return entry.carNumber ? "#" + entry.carNumber + " " + who : who;
  }

  /**
   * Fastest-lap banner. Persists once set — a fastest lap is a race fact, not a
   * transient state, so it stays visible after the holder pits or retires (which
   * is exactly when a viewer most wants to be reminded of it).
   *
   * By default it draws one line per class rather than one for the race: the
   * overall fastest lap in a multiclass field is always a Hypercar's, and it
   * tells the GT3 runner nothing about the race they are in. `fastest=overall`
   * collapses it back to the single lap. Lines are keyed by class and reconciled
   * in place, like every other repeated node in this tower, so a lap landing
   * somewhere down the field does not rebuild the banner.
   */
  function updateFastestBanner(perClass, classOrder, classFastest, entry, sec, fmt) {
    /** @type {Array<{key: string, label: string, color: string|null, entry: object, sec: number}>} */
    var lines = [];
    if (perClass) {
      for (var i = 0; i < classOrder.length; i++) {
        var cls = classOrder[i];
        var cf = classFastest[cls];
        if (!cf || !fmt.has(cf.sec)) continue;
        lines.push({
          key: cls,
          label: classLabel(cls),
          color: classColor(cls),
          entry: cf.entry,
          sec: cf.sec,
        });
      }
    } else if (entry && fmt.has(sec)) {
      lines.push({ key: "__overall", label: "FASTEST LAP", color: null, entry: entry, sec: sec });
    }

    if (!lines.length) {
      if (!sessFastest.hidden) sessFastest.hidden = true;
      return;
    }

    for (var n = 0; n < lines.length; n++) {
      var ln = lines[n];
      var el = fastestLines.get(ln.key);
      if (!el) {
        el = { div: document.createElement("div"), cache: {} };
        el.div.className = "standings__fastest-line";
        fastestLines.set(ln.key, el);
      }
      // A per-class line carries its class colour on the left bar and the label;
      // the overall line keeps the purple the banner has always been, which is
      // also what the purple lap in the tower is.
      if (el.cache.color !== ln.color) {
        el.cache.color = ln.color;
        if (ln.color) el.div.style.setProperty("--fastest-color", ln.color);
        else el.div.style.removeProperty("--fastest-color");
      }
      var txt = ln.label + " · " + holderName(ln.entry) + " · " + fmt.lapTime(ln.sec);
      if (el.cache.txt !== txt) {
        el.cache.txt = txt;
        el.div.textContent = txt;
      }
      // appendChild on an existing child is a move, so this also fixes the order
      // when a class's leader position changes.
      sessFastest.appendChild(el.div);
    }

    // Drop lines for classes that are no longer in the field — and, on a switch
    // between the two modes, the lines the other mode left behind.
    var keep = new Set();
    for (var k = 0; k < lines.length; k++) keep.add(lines[k].key);
    fastestLines.forEach(function (el, key) {
      if (keep.has(key)) return;
      if (el.div.parentNode) el.div.parentNode.removeChild(el.div);
      fastestLines.delete(key);
    });

    if (sessFastest.hidden) sessFastest.hidden = false;
  }

  /**
   * `purpleSlot` is whichever car's BEST wears the purple in this group — the
   * race's fastest lap, or the class's, per the `fastest` setting. `greenSlot`
   * is the class benchmark, and is -1 when the purple already marks it.
   */
  function renderRow(e, fmt, now, purpleSlot, greenSlot, ctx, intervals) {
    var row = rows.get(e.slotId);
    if (!row) {
      row = createRow();
      rows.set(e.slotId, row);
    }

    // --- personal-best flash bookkeeping -------------------------------------
    var t = track.get(e.slotId);
    if (!t) {
      t = { laps: e.lapsCompleted, best: e.bestLapSec, flashUntil: 0 };
      track.set(e.slotId, t);
    } else if (e.lapsCompleted > t.laps) {
      // Completed a new lap: flash green if it set/matched a personal best.
      if (fmt.has(e.lastLapSec) && (!fmt.has(t.best) || e.lastLapSec <= t.best + 1e-6)) {
        t.flashUntil = now + PB_FLASH_MS;
        // The green hold and the bloom do different jobs and both are kept: the
        // bloom catches the eye at the instant the lap lands, the five-second
        // green says WHAT it was long enough to actually be read. Collapsing the
        // hold into the bloom's half-second would lose the second of those.
        if (ctx.critPulse) ctx.critPulse(row.lastTd);
      }
      t.laps = e.lapsCompleted;
    }
    if (fmt.has(e.bestLapSec)) t.best = e.bestLapSec;

    var isFastest = e.slotId === purpleSlot && fmt.has(e.bestLapSec);
    var flashing = now < t.flashUntil;

    // Player highlight (+ carries the fastest-lap purple accent on the row).
    var isPlayer = !!e.isPlayer;
    var cls = "standings__row";
    if (isPlayer) cls += " standings__row--player";
    if (isFastest) cls += " standings__row--fastest";
    set(row, "cls", row.tr, "className", cls);
    // `hidden`, not the pit flag's `is-off`: that flag holds a column open on
    // every row and must keep its box, whereas this tag exists on one row in the
    // tower and every other row wants the space back for its driver's name.
    if (row.cache.you !== isPlayer) {
      row.cache.you = isPlayer;
      row.you.hidden = !isPlayer;
    }

    // Rows are grouped under a class subheader, so the number that belongs in
    // the position column is the position IN CLASS — that is what the driver is
    // actually racing for in a multiclass field. The overall position is kept on
    // the title attribute rather than dropped.
    var hasClassPos = fmt.has(e.classPosition) && e.classPosition > 0;
    set(row, "pos", row.posTd, "textContent",
      fmt.intVal(hasClassPos ? e.classPosition : e.position));
    set(row, "posTitle", row.posTd, "title",
      hasClassPos ? "P" + e.position + " overall" : "");

    // Positions gained/lost vs. the grid.
    var dTxt = "";
    var dState = "flat";
    if (fmt.has(e.gridPosition) && e.gridPosition > 0 && fmt.has(e.position)) {
      var d = e.gridPosition - e.position;
      if (d > 0) {
        dTxt = "▲" + d;
        dState = "gain";
      } else if (d < 0) {
        dTxt = "▼" + -d;
        dState = "loss";
      } else {
        dTxt = "•";
        dState = "flat";
      }
    }
    set(row, "delta", row.deltaTd, "textContent", dTxt);
    if (row.cache.dState !== dState) {
      row.cache.dState = dState;
      row.deltaTd.setAttribute("data-state", dState);
    }

    var dotColor = classColor(e.carClass);
    if (row.cache.dot !== dotColor) {
      row.cache.dot = dotColor;
      row.classDot.style.background = dotColor;
    }

    // Manufacturer badge. `hidden` is cleared on every src change — a previous
    // name's load error may have hidden the element, and the error handler only
    // fires for the file it belongs to.
    var manu = e.manufacturer || "";
    if (row.cache.manu !== manu) {
      row.cache.manu = manu;
      if (manu) {
        row.badge.src = "/carbadges/" + encodeURIComponent(manu) + ".svg";
        row.badge.hidden = false;
      } else {
        row.badge.removeAttribute("src");
        row.badge.hidden = true;
      }
    }

    var name = displayName(e.driverName);
    if (e.carNumber) name = "#" + e.carNumber + " " + name;
    set(row, "name", row.nameSpan, "textContent", name);
    // Full names are drawn in full and cut by the CSS where they do not fit, so
    // the cell carries the whole thing for the pages that have a cursor (the
    // browser source and OBS). The in-game layer never sees a hover and pays
    // nothing for it but the attribute.
    set(row, "nameTitle", row.driverTd, "title", name);

    // Pit state, flagged in the right-hand column (see createRow).
    var inPit = !!e.inPit;
    if (row.cache.inPit !== inPit) {
      row.cache.inPit = inPit;
      row.pitFlag.classList.toggle("is-off", !inPit);
    }

    // Virtual energy: % + a fill bar behind the number.
    var hasVe = fmt.has(e.virtualEnergy) && e.virtualEnergy >= 0;
    var vePct = hasVe ? Math.round(e.virtualEnergy * 100) : -1;
    set(row, "veText", row.veText, "textContent", hasVe ? vePct + "%" : "—");
    if (row.cache.vePct !== vePct) {
      row.cache.vePct = vePct;
      row.veBar.style.width = hasVe ? Math.max(0, Math.min(100, vePct)) + "%" : "0%";
      // Colour the bar by remaining energy: healthy -> low -> critical.
      var veState = !hasVe ? "none" : vePct <= 15 ? "crit" : vePct <= 35 ? "low" : "ok";
      row.veTd.setAttribute("data-ve", veState);
    }

    // GAP. Two readings, and which one is drawn is the operator's choice (the
    // Hub's standings card, or `?standings=gap=ahead`):
    //
    //   leader  cumulative to the leader OF THIS CLASS, matching the in-class
    //           position beside it — an overall gap under a class subheader
    //           reads as a contradiction (a GT3 P1 showing +2 laps). Falls back
    //           to the overall gap when the class is unknown.
    //   ahead   the interval to the car directly in front, which is what a
    //           driver is actually racing; the leader gap says nothing about
    //           whether the car ahead is coming back to you.
    //
    // Whichever is shown, the other goes on the title so nothing is lost.
    var useClass = hasClassPos && fmt.has(e.gapToClassLeaderSec);
    var toLeader = gapCell(
      useClass ? e.classPosition === 1 : e.position === 1,
      lapsOf(useClass ? e.classLapsBehind : e.lapsBehind),
      useClass ? e.gapToClassLeaderSec : e.gapToLeaderSec,
      fmt
    );
    var gapText = toLeader;
    var gapTitle =
      useClass && e.position !== 1
        ? "to race leader " + (e.lapsBehind > 0 ? "+" + e.lapsBehind + "L" : fmt.gap(e.gapToLeaderSec))
        : "";
    if (intervals) {
      var iv = intervals[e.slotId];
      gapText = iv ? gapCell(iv.lead, iv.laps, iv.sec, fmt) : "—";
      gapTitle = toLeader === "—" ? "" : "to " + (useClass ? "class leader " : "leader ") + toLeader;
    }
    set(row, "gap", row.gapTd, "textContent", gapText);
    set(row, "gapTitle", row.gapTd, "title", gapTitle);

    // BEST: purple for the fastest lap the `fastest` setting means (the race's,
    // or this class's), green for the fastest lap of this class where the purple
    // is the race's — the benchmark that is otherwise invisible in a multiclass
    // field, since only one car can hold an overall purple.
    set(row, "best", row.bestTd, "textContent", fmt.lapTime(e.bestLapSec));
    var bestState = !fmt.has(e.bestLapSec)
      ? ""
      : isFastest
        ? "fastest"
        : e.slotId === greenSlot
          ? "classbest"
          : "";
    if (row.cache.bestState !== bestState) {
      row.cache.bestState = bestState;
      row.bestTd.classList.toggle("lap-purple", bestState === "fastest");
      row.bestTd.classList.toggle("lap-green", bestState === "classbest");
    }

    set(row, "last", row.lastTd, "textContent", fmt.lapTime(e.lastLapSec));
    // Last-lap colour: a green flash for a freshly-set personal best, otherwise
    // the default text colour. The purple deliberately lives on BEST only — it
    // marks the fastest lap of the race, which is a *best* lap. Painting LAST
    // purple too (as this did before the BEST column existed) claimed the
    // holder's most recent lap was the fastest one, which it usually isn't.
    var lastState = flashing ? "pb" : "";
    if (row.cache.lastState !== lastState) {
      row.cache.lastState = lastState;
      row.lastTd.classList.toggle("lap-green", lastState === "pb");
    }

    // Reorder: append in standings order (moves existing node, no rebuild).
    tbody.appendChild(row.tr);
  }

  window.ApexOverlay.registerWidget("standings", {
    throttleMs: 120,
    init: init,
    update: update,
  });
})();
