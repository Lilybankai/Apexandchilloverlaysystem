/**
 * widgets/trackmap.js — the circuit, drawn as a raised ribbon, with the field on it.
 * -----------------------------------------------------------------------------
 * A "2.5-D" track map: the road is extruded off a dark plane and viewed from an
 * angle, so corners read as corners and the elevation of the place is visible
 * rather than implied. Every car in the session is a dot moving on the surface.
 *
 * ## Where the shape comes from
 * NOT from here, and not from the frame. The server learns the circuit from the
 * car driving it and serves the result at `/trackmap.json`
 * (see src/telemetry/trackMap.ts for why it is learned rather than shipped). The
 * telemetry frame carries only `trackMap.revision`; this widget refetches when
 * that number moves and otherwise never touches the network. Until a lap has
 * been driven at a new circuit there is no shape, and the widget shows how far
 * the learning has got instead of an empty panel.
 *
 * ## The projection, and why it is the whole widget
 * Three transforms, applied in this order to every point:
 *
 *   1. **Rotate** the circuit in the world plane so its longest axis lies across
 *      the widget. The angle comes from the shape itself (the principal axis of
 *      the point cloud), so Le Mans lands wide and Monaco lands tall with no
 *      per-track configuration — and it is deterministic, so a circuit is drawn
 *      the same way every session.
 *   2. **Tilt**: squash the depth axis by {@link TILT} and let it drive screen Y.
 *      This is the oblique projection that turns a flat plan into a view — the
 *      only reason a hairpin doubling back reads as a hairpin. The depth axis
 *      is negated on the way in; see {@link viewV} for why the map is a mirror
 *      of the real circuit without that one sign.
 *   3. **Lift** by elevation. Real circuits move ±30 m vertically across a
 *      1.5 km footprint, which is under 2% of the map's width — invisible at
 *      true scale. So the lift is scaled to a fixed share of the map's own size
 *      ({@link ELEV_SHARE}), capped at {@link ELEV_MAX_GAIN}×: Spa's hill is
 *      unmistakable, and a flat circuit stays flat rather than being given
 *      terrain it does not have. What the lift raises the road ABOVE is a real
 *      plane with a real extrusion down to it — see below.
 *
 * ## Drawing order IS the depth buffer
 * There is no z-buffer in canvas 2-D, so the ribbon is drawn back to front:
 * segments sorted by depth, and within each segment the far wall, then the road
 * surface, then the near wall. That ordering is what lets a circuit cross over
 * itself (every one of them does) without the far side punching through the
 * near side. Cars are drawn after the whole ribbon, sorted among themselves —
 * deliberately on top of it, because a dot hidden under a bridge is a dot the
 * driver reads as "not on track".
 *
 * The sort key is the depth the projection implies, which includes HEIGHT, not
 * just position on the plan. Where a circuit crosses itself the two roads share
 * a footprint, so the planar depth alone is the same for both and the sort
 * between them is a coin flip — with the extrusion below, that flip decides
 * whether the bridge or the road beneath it wins, and it can land either way
 * from one rebuild to the next. Adding the lift settles it the way the view
 * already says it should: the higher road is the nearer one.
 *
 * ## The material, and why it is one material
 * The ribbon is ONE colour lit by ONE light, not a light road with a coloured
 * wall glued to it. That is the whole difference between a solid object and a
 * paper cutout, and it is what the printed circuit-map style has always done.
 * Three things build it, all from the segment's own direction:
 *
 *   - **Lambert shading** against a fixed light in view space ({@link LIGHT}).
 *     The road surface faces up and stays bright; a side wall's normal is
 *     horizontal, so its shade swings with the heading — which is what makes a
 *     straight and the corner it feeds read as different faces of one solid.
 *   - **A bevel.** The surface is drawn as three strips across its width, the
 *     outer two tilted {@link BEVEL_TILT} toward their own edge. The strip
 *     facing the light lifts, the far one drops, and the road gains a rounded
 *     profile — with no extra geometry and no gradient objects.
 *   - **A rim** ({@link RIM_GAIN}) on the lit bevel only, cubed so it is a catch
 *     on the edge rather than a general brightening.
 *
 * Ambient never reaches zero ({@link AMBIENT}), so an unlit wall is dark red
 * rather than a hole in the map.
 *
 * ## The elevation is a solid, standing on a plane
 * Under the circuit is a ground plane, and hanging from the underside of the
 * road down to it is a curtain ({@link dropFace}) following the road all the
 * way round. The height of that curtain at any point IS the elevation there:
 * the hill stops being a gap you have to notice and becomes a mass with a
 * visible foot. A climb reads as the road pulling away from its own base, and
 * the two ends of a straight sit at obviously different heights.
 *
 * The plane is a pool of light rather than a plate — see {@link PLANE_TINT},
 * which is also where the reason lives (this widget is drawn on a background
 * the operator can turn off entirely, and a plate would put it back).
 *
 * The cast shadow survives all this, with a changed job. It used to be the ONLY
 * elevation cue: the ribbon over its own lift-removed silhouette, blurred, and
 * the gap between them was the hill. Now the curtain says that far more
 * directly, and the shadow — offset by {@link SHADOW_DX}/{@link SHADOW_DY} —
 * has become the contact shadow at the curtain's foot, which is what stops the
 * solid from floating on its own plane. It is also the whole elevation cue
 * again wherever there is no curtain: a flat circuit, or `?ground=0`.
 *
 * ## Cost
 * The ribbon is static: it is rendered ONCE to an offscreen canvas when the
 * shape or the widget's size changes, and every frame after that is one blit
 * plus a few dozen dots. That is what makes a full-circuit map affordable on a
 * streaming PC — redrawing 900 depth-sorted quads at 30 Hz would not be. The
 * shading is per-segment arithmetic inside that one render, so it costs nothing
 * per frame at all.
 *
 * The extrusion roughly doubles that one render — measured at 36 ms → 66 ms for
 * COTA at 428 px — because it adds two more faces per segment on top of the
 * five already there. It is worth being clear that this is the whole price: it
 * lands on a track change and on the rebuild after a resize settles, never on a
 * frame, and a flat circuit pays none of it.
 *
 * URL params (all optional):
 *   ?style=classic|brand  Palette. `classic` is the infographic red of a
 *                         printed circuit map (the default); `brand` runs the
 *                         overlay's own cyan→magenta round the lap. Both are
 *                         lit by the same model — only the base hue differs.
 *   ?rotate=<deg>         Override the automatic orientation.
 *   ?tilt=<0.2..0.9>      Override how steeply the view looks down.
 *   ?ground=0             Drop the ground plane and the extrusion down to it,
 *                         leaving the road floating over its shadow as it was
 *                         before v0.55.0.
 */
(function () {
  "use strict";

  var classColor = window.ApexOverlay.classColor;

  /* -------------------------------- config -------------------------------- */

  /**
   * How far the depth axis is squashed. 0.55 is a view from roughly 33° above
   * the plane: shallow enough that the circuit keeps its shape (at 0.2 every
   * corner is a flat line), steep enough to read as a view rather than a plan.
   */
  var TILT = 0.55;
  /** Border inset in CSS px, so the widest part of the circuit isn't clipped. */
  var PAD = 10;
  /**
   * The vertical lift given to the full elevation range, as a share of the map's
   * planar width — see the module note on why elevation is exaggerated at all.
   */
  var ELEV_SHARE = 0.16;
  /** Ceiling on the exaggeration, so a genuinely hilly circuit is not a wall. */
  var ELEV_MAX_GAIN = 5;
  /** Wall height as a share of the canvas height, clamped to these px bounds. */
  var WALL_SHARE = 0.042;
  var WALL_MIN_PX = 4;
  var WALL_MAX_PX = 12;
  /** How thick the start/finish bar is drawn, in px along the road. */
  var LINE_PX = 4.5;
  /** Height/width bounds for the canvas — a circuit's own aspect within reason. */
  var ASPECT_MIN = 0.34;
  var ASPECT_MAX = 0.8;
  /**
   * How long the panel must hold still before the ribbon is re-rendered.
   *
   * The ribbon costs tens of milliseconds to build and the layout editor resizes
   * a widget continuously while it is dragged — rebuilding per tick would make
   * the drag stutter for as long as it lasts. The cached bitmap is stretched to
   * the new size in the meantime, which is momentarily soft and instantly
   * correct again the moment the handle is released. The projection itself is
   * NOT deferred: it is cheap, and it is what puts the cars in the right place.
   */
  var RESIZE_SETTLE_MS = 140;
  /**
   * Roughly how many ribbon segments to draw, whatever the source path's
   * resolution. Le Mans arrives as 2000 points, which at map scale is a quarter
   * of a pixel each — all cost, no detail. Decimating to about this many keeps
   * every circuit at a similar draw cost and a similar smoothness.
   */
  var TARGET_SEGMENTS = 560;
  /**
   * The narrowest the road is ever drawn, in px.
   *
   * A whole circuit in a panel runs at a quarter of a pixel per metre, where a
   * real 12 m road is a hairline and the map becomes a wire diagram with a wall
   * on it. Every circuit map ever printed exaggerates the road for the same
   * reason. The exaggeration only ever ADDS width (a track wide enough at this
   * scale keeps its true one), and it never moves the centre line, so a car's
   * position on the map is unaffected — only how much road is drawn under it.
   */
  var MIN_ROAD_PX = 11;
  /** Dot radius in px for an opponent, and for the player. */
  var DOT_R = 4.2;
  var EGO_R = 5.6;

  /* -------------------------------- lighting ------------------------------- */

  /**
   * The light, in view space: (u across the widget, v into the depth axis, up).
   * Above and to the left, tipped slightly toward the viewer — the convention
   * every printed circuit map uses, and the one that leaves the near walls
   * legible instead of silhouetted.
   */
  var LIGHT = normalize3(-0.45, 0.3, 0.84);
  /** Floor on shading, so an unlit face is dark paint rather than a hole. */
  var AMBIENT = 0.36;
  /**
   * How far the outer surface strips tilt toward their own edge (0..1).
   *
   * Kept well under half: the bevel is a chamfer on a flat road, and tilting it
   * further turns the two strips into the light and dark halves of a cylinder —
   * at which point the ribbon reads as a pipe and the walls stop being walls.
   */
  var BEVEL_TILT = 0.45;
  /**
   * Width of one bevel strip as a share of the road, and its px bounds. Two
   * bevels come out of the same road, so this must stay small — at 0.22 they
   * take nearly half the surface and there is no flat top left to catch light.
   */
  var BEVEL_SHARE = 0.14;
  var BEVEL_MIN_PX = 0.8;
  var BEVEL_MAX_PX = 2;
  /** Extra brightening on the lit bevel, cubed into an edge catch. */
  var RIM_GAIN = 0.2;
  /**
   * Where the wall splits into its lit upper and occluded lower band, and how
   * far the lower one drops.
   *
   * The multiplier is deliberately mild. This map is drawn on a near-black
   * panel, not the white page a printed circuit map lives on: past about 0.6 the
   * bottom of the wall matches the background, the solid loses its base and the
   * ribbon starts to look like it is dissolving from underneath.
   */
  var WALL_SPLIT = 0.45;
  var WALL_LOWER_MUL = 0.72;
  /**
   * The curtain: the face hanging from the road's underside down to the ground
   * plane, so the gap between the two IS the elevation instead of implying it.
   *
   * It starts BELOW where the wall's lower band ends (0.72) and keeps falling.
   * That step is not a seam to be hidden — it is the road's own contact shadow
   * on the mass beneath it, and it is what separates "a wall" from "the wall,
   * and then the hill under it". The foot is the darkest thing on the map: a
   * curtain that stays bright all the way down is a solid block, and a block
   * makes a hill read as LESS tall than it is, not more.
   *
   * Going darker than {@link WALL_LOWER_MUL} is only safe because the curtain
   * now ENDS on a visible plane. The wall could not — see the note there about
   * a ribbon dissolving from underneath on a near-black panel.
   */
  var CURTAIN_TOP_MUL = 0.62;
  var CURTAIN_FOOT_MUL = 0.3;
  /**
   * Target height of one curtain band in px, and the ceiling on how many. The
   * count comes from the drop rather than being fixed, so a long climb gets a
   * falloff and a 3 px rise gets one flat quad instead of four hairlines.
   */
  var CURTAIN_BAND_PX = 9;
  var CURTAIN_BANDS_MAX = 4;
  /** Below this drop there is no hill to draw, only a seam. */
  var CURTAIN_MIN_PX = 1.5;
  /** The cast shadow: fixed offset in px, blur, and opacity. */
  var SHADOW_DX = 3;
  var SHADOW_DY = 6;
  var SHADOW_BLUR_MUL = 0.9;
  var SHADOW_BLUR_MIN = 3;
  var SHADOW_BLUR_MAX = 9;
  var SHADOW_ALPHA = 0.5;
  /**
   * ...and the same shadow once there is an extrusion for it to lie at the foot
   * of. Its job has changed: without the curtain it is the only elevation cue
   * and has to carry it alone, but under one it falls on an already-dark foot,
   * where the full weight stacks into a bruise around the hill.
   */
  var SHADOW_ALPHA_SOLID = 0.4;

  /* ------------------------------- the ground ------------------------------ */

  /**
   * The plane the circuit stands on: a pool of light under the map, fading to
   * nothing well before it reaches an edge.
   *
   * A pool rather than a slab, for two reasons. This projection has no
   * perspective, so any rectangle on the ground lands screen-axis-aligned — a
   * plate with a rim would read as a card behind the map, not as a surface
   * under it. And the operator can turn a widget's background down to zero
   * (`--panel-alpha`); an opaque plate would quietly put back the box they
   * switched off. Something that fades out has no edge to give itself away.
   *
   * Light, not dark: the panel is already near-black, so a dark plane is
   * invisible at full opacity and a smudge at none. The plane is not really the
   * feature — the CONTRAST between the curtain's dark foot and the plane is,
   * and that needs the plane to be the lighter of the two.
   */
  var PLANE_TINT = "150,170,210";
  var PLANE_ALPHA = 0.075;
  /** Where the pool starts fading, as a share of its radius. */
  var PLANE_FADE = 0.55;
  /** How far past the circuit's own footprint it runs, as a share of that. */
  var PLANE_BLEED = 0.1;

  /* -------------------------------- palettes ------------------------------- */

  /**
   * A palette is a base hue and nothing else — the lighting model above makes
   * every other shade from it. `from`/`to` is the colour at the start and end of
   * the lap: `classic` holds one red the whole way round (the printed
   * circuit-map look), `brand` runs the overlay's own cyan→magenta, which also
   * reads as *where* in the lap you are.
   *
   * The base is the colour of a FULLY LIT face; every drawn face is at or below
   * it, so these sit deliberately brighter than the map's average.
   */
  var PALETTES = {
    classic: {
      from: [235, 45, 48],
      to: [235, 45, 48],
      line: "#141821",
    },
    brand: {
      from: [34, 211, 238],
      to: [246, 95, 176],
      line: "#0b0e17",
    },
  };

  /* --------------------------------- state -------------------------------- */

  var canvas, gctx, statusEl, headerMeta;
  var cssW = 0, cssH = 0, dpr = 1;

  /** The fetched shape, and the revision/key it was fetched for. */
  var shape = null;
  var haveRevision = -1;
  var haveKey = "";
  var fetching = false;

  /** Projected geometry + the offscreen ribbon, both keyed on shape × size. */
  var geom = null;
  var ribbon = null;
  var ribbonKey = "";
  /**
   * Earliest time the ribbon may be re-rendered, as a guard against rebuilding
   * it on every frame of a resize drag — see {@link RESIZE_SETTLE_MS}.
   */
  var ribbonDeferUntil = 0;

  var palette = PALETTES.classic;
  var rotateOverrideRad = null;
  var tilt = TILT;
  /** The ground plane and the extrusion down to it. `?ground=0` turns both off. */
  var ground = true;

  /* ------------------------------- the fetch ------------------------------- */

  /**
   * Pull the circuit for `key`/`revision` if we don't already have it.
   *
   * Guarded by a single in-flight flag rather than a queue: the trigger fires at
   * most a few times a session (a track change), and a second request for the
   * same revision would only ever return the same bytes.
   */
  function ensureShape(map) {
    if (!map) return;
    // A shape can be WITHDRAWN, not only replaced. The server marks the map it
    // is serving against the car driving it and throws the map away when the two
    // disagree for a couple of hundred metres — a map that does not describe
    // this circuit (see src/telemetry/trackMap.ts). Holding on to the last one
    // fetched would go on drawing the circuit that was just condemned, which is
    // precisely the one that sends the field off the edge of the panel. The
    // moment the frame stops saying `ready`, or names a different track, what is
    // cached here is not a map of what is being driven.
    if (shape && (!map.ready || map.key !== haveKey)) {
      shape = null;
      geom = null;
      ribbon = null;
      ribbonKey = "";
      haveKey = "";
      haveRevision = -1;
    }
    if (!map.ready) return;
    if (fetching) return;
    if (shape && map.key === haveKey && map.revision === haveRevision) return;
    fetching = true;
    var wantKey = map.key, wantRev = map.revision;
    fetch("/trackmap.json", { cache: "no-store" })
      .then(function (r) {
        // 204 = the server has no shape yet (a race between the frame saying
        // ready and the file being published). Try again on the next change.
        if (r.status === 204) return null;
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        fetching = false;
        if (!data || !data.points || data.points.length < 8) return;
        shape = data;
        haveKey = wantKey;
        haveRevision = wantRev;
        geom = null;
        ribbon = null;
        sizeCanvas(true);
      })
      .catch(function () {
        fetching = false; // the next revision change retries; no spin
      });
  }

  /* ------------------------------ projection ------------------------------- */

  /**
   * The angle that lays the circuit's longest axis across the widget — the
   * principal axis of the point cloud, which is the closed-form answer to "which
   * way round wastes least of the panel".
   */
  function principalAngle(points) {
    var n = points.length, mx = 0, mz = 0, i;
    for (i = 0; i < n; i++) { mx += points[i][0]; mz += points[i][1]; }
    mx /= n; mz /= n;
    var sxx = 0, szz = 0, sxz = 0;
    for (i = 0; i < n; i++) {
      var dx = points[i][0] - mx, dz = points[i][1] - mz;
      sxx += dx * dx; szz += dz * dz; sxz += dx * dz;
    }
    return 0.5 * Math.atan2(2 * sxz, sxx - szz);
  }

  /**
   * World plan (x, z) → view space (u, v), for a rotation given as its cos/sin.
   *
   * The minus on `v` is the map's handedness, and it is not cosmetic. The sim's
   * Z axis runs one way across the circuit and the canvas' Y axis runs DOWN the
   * screen, so feeding z straight into screen Y draws every circuit as its own
   * mirror image — left-handers become right-handers and the shape stops
   * matching the one on the wall. One sign here corrects the ribbon, its
   * shadow, the lighting normals and the cars together, because all four are
   * built from this pair and nothing else.
   */
  function viewU(x, z, ca, sa) { return x * ca - z * sa; }
  function viewV(x, z, ca, sa) { return -(x * sa + z * ca); }

  /**
   * Decimate the source path down to about {@link TARGET_SEGMENTS} points,
   * always keeping index 0 — that point is the start/finish line, and the one
   * marker on the map whose position is a fact rather than a decoration.
   */
  function decimate(points) {
    var n = points.length;
    var step = Math.max(1, Math.floor(n / TARGET_SEGMENTS));
    if (step === 1) return points.slice();
    var out = [];
    for (var i = 0; i < n; i += step) out.push(points[i]);
    return out;
  }

  /**
   * Build everything that depends on the shape AND the canvas size: the rotated,
   * tilted, lifted screen positions of the road's two edges, the scale that fits
   * them, and the depth key each segment is sorted by.
   *
   * Returns `null` when there is nothing to draw yet.
   */
  function buildGeometry() {
    if (!shape || !cssW || !cssH) return null;
    var pts = decimate(shape.points);
    var n = pts.length;
    if (n < 8) return null;

    var ang = rotateOverrideRad !== null ? rotateOverrideRad : -principalAngle(shape.points);
    var ca = Math.cos(ang), sa = Math.sin(ang);

    // Elevation gain: fixed share of the planar width, capped. Computed from the
    // rotated extents, so it is the width the operator actually sees.
    var i, u, v, y;
    var minU = Infinity, maxU = -Infinity, minY = Infinity, maxY = -Infinity;
    for (i = 0; i < n; i++) {
      u = viewU(pts[i][0], pts[i][1], ca, sa);
      y = pts[i][2] || 0;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    var elevRange = maxY - minY;
    var elevGain = elevRange > 0.5
      ? Math.min(ELEV_MAX_GAIN, (ELEV_SHARE * (maxU - minU)) / elevRange)
      : 0;

    var wallPx = clamp(cssH * WALL_SHARE, WALL_MIN_PX, WALL_MAX_PX);
    var view = { ca: ca, sa: sa, minY: minY, elevGain: elevGain, tilt: tilt };

    // Fit twice. The first pass is the bare centre path, purely to find out what
    // a metre is worth in pixels; the road's drawn width is then set from that
    // (see {@link MIN_ROAD_PX}) and the second pass fits the ribbon that width
    // actually produces. One pass cannot do it: the width depends on the scale,
    // and the scale depends on the width.
    var probe = fitEdges(buildEdges(pts, 0), view, wallPx);
    var half = shape.halfWidthM > 0 ? shape.halfWidthM : 6;
    half = Math.max(half, MIN_ROAD_PX / (2 * probe.scale));
    var f = fitEdges(buildEdges(pts, half), view, wallPx);

    // How wide the road actually lands, in px. The bevel is sized from this
    // rather than from `half`, because the exaggeration above means the metres
    // and the pixels have stopped agreeing.
    var roadPx = 0;
    for (i = 0; i < f.screen.length; i++) {
      var sc = f.screen[i];
      roadPx += Math.hypot(sc.lx - sc.rx, sc.ly - sc.ry);
    }
    roadPx /= f.screen.length || 1;

    return {
      screen: f.screen,
      wallPx: wallPx,
      roadPx: roadPx,
      // Everything a car needs to be put in the same space as the ribbon.
      ca: ca, sa: sa, scale: f.scale, offX: f.offX, offY: f.offY,
      elevGain: elevGain, minY: minY, tilt: tilt,
      aspect: (f.boxH * f.scale + wallPx) / (f.boxW * f.scale),
      // The fine path, for placing a car that only knows its lap fraction.
      path: shape.points,
    };
  }

  /**
   * The road's two edges in world metres, `half` either side of the path along
   * the perpendicular to its tangent. Which side is "left" does not matter, only
   * that it is the same side all the way round the lap.
   */
  function buildEdges(pts, half) {
    var n = pts.length;
    var edges = new Array(n);
    for (var i = 0; i < n; i++) {
      var p = pts[i], a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
      var tx = b[0] - a[0], tz = b[1] - a[1];
      var len = Math.hypot(tx, tz) || 1;
      var nx = tz / len, nz = -tx / len;
      edges[i] = [
        p[0] + nx * half, p[1] + nz * half,
        p[0] - nx * half, p[1] - nz * half,
        p[2] || 0,
      ];
    }
    return edges;
  }

  /**
   * Project a ribbon's edges and scale them to fill the canvas.
   *
   * Each entry carries three things the renderer needs and cannot recover later:
   * the lit screen position, the SAME point with the elevation lift removed (the
   * ground plane the shadow lands on), and the rails' raw view-space `u`/`v`,
   * which are what every surface normal is built from. The last pair must be
   * pre-tilt and pre-scale — the tilt is a squash of the depth axis, and a
   * normal derived after it points the wrong way.
   */
  function fitEdges(edges, view, wallPx) {
    var n = edges.length, i;
    var raw = new Array(n);
    var minX = Infinity, maxX = -Infinity, minSY = Infinity, maxSY = -Infinity;
    for (i = 0; i < n; i++) {
      var e = edges[i];
      var lift = (e[4] - view.minY) * view.elevGain;
      var lu = viewU(e[0], e[1], view.ca, view.sa), lv = viewV(e[0], e[1], view.ca, view.sa);
      var ru = viewU(e[2], e[3], view.ca, view.sa), rv = viewV(e[2], e[3], view.ca, view.sa);
      var flY = lv * view.tilt, frY = rv * view.tilt;
      var lY = flY - lift, rY = frY - lift;
      raw[i] = {
        lx: lu, ly: lY, rx: ru, ry: rY,
        // Higher ground sorts as nearer. `v` alone cannot decide a crossover —
        // the two roads share a footprint, so their `v` is the same and the
        // sort is a coin flip. This is the orthogonal partner of the screen
        // mapping above (`y = v*tilt - lift`), so it is the depth that mapping
        // implies rather than a tie-break bolted onto it.
        depth: (lv + rv) / 2 + lift * view.tilt,
        // The same two points with lift = 0: where the road would be if the
        // circuit were flat. That is where its shadow falls, and — a wall's
        // height further down — where the ground plane sits and the extrusion
        // lands. See {@link dropFace} for why the wall is part of that offset.
        fly: flY, fry: frY,
        lu: lu, lv: lv, ru: ru, rv: rv, lift: lift,
      };
      minX = Math.min(minX, lu, ru); maxX = Math.max(maxX, lu, ru);
      // `lift` is never negative, so a rail's lit position is never BELOW its
      // flat one: the top of the drawing is still a lit rail, and once there is
      // an extrusion the bottom is always a flat one. The fit has to reserve
      // that difference or the curtain hangs off the bottom of the panel.
      minSY = Math.min(minSY, lY, rY);
      maxSY = ground ? Math.max(maxSY, flY, frY) : Math.max(maxSY, lY, rY);
    }

    var boxW = Math.max(1, maxX - minX);
    var boxH = Math.max(1, maxSY - minSY);
    var scale = Math.min(
      (cssW - PAD * 2) / boxW,
      (cssH - PAD * 2 - wallPx) / boxH
    );
    var offX = (cssW - boxW * scale) / 2 - minX * scale;
    var offY = (cssH - wallPx - boxH * scale) / 2 - minSY * scale;

    var screen = new Array(n);
    for (i = 0; i < n; i++) {
      var r = raw[i];
      screen[i] = {
        lx: r.lx * scale + offX, ly: r.ly * scale + offY,
        rx: r.rx * scale + offX, ry: r.ry * scale + offY,
        // Shadow rails share x with the lit ones — the lift only moves Y.
        fly: r.fly * scale + offY, fry: r.fry * scale + offY,
        depth: r.depth,
        lu: r.lu, lv: r.lv, ru: r.ru, rv: r.rv, lift: r.lift,
      };
    }
    return { screen: screen, scale: scale, offX: offX, offY: offY, boxW: boxW, boxH: boxH };
  }

  /** World position → canvas position + a depth key, through the same transform. */
  function project(g, x, z, y) {
    var lift = ((typeof y === "number" ? y : g.minY) - g.minY) * g.elevGain;
    var u = viewU(x, z, g.ca, g.sa);
    var v = viewV(x, z, g.ca, g.sa);
    return {
      x: u * g.scale + g.offX,
      y: (v * g.tilt - lift) * g.scale + g.offY,
      depth: v,
    };
  }

  /** The point `f` (0..1) of the way round the lap, interpolated between samples. */
  function pointAtFraction(g, f) {
    var pts = g.path, n = pts.length;
    var t = ((f % 1) + 1) % 1 * n;
    var i = Math.floor(t), k = t - i;
    var a = pts[i % n], b = pts[(i + 1) % n];
    return [
      a[0] + (b[0] - a[0]) * k,
      a[1] + (b[1] - a[1]) * k,
      (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * k,
    ];
  }

  /* -------------------------------- drawing -------------------------------- */

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  /* ------------------------------- the light ------------------------------- */

  /** A unit vector. Declared, not assigned, so {@link LIGHT} can use it above. */
  function normalize3(x, y, z) {
    var l = Math.sqrt(x * x + y * y + z * z) || 1;
    return [x / l, y / l, z / l];
  }

  /** How much of the light a face with normal `n` receives, floored at ambient. */
  function lambert(n) {
    var d = n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2];
    return AMBIENT + (1 - AMBIENT) * Math.max(0, d);
  }

  /** `a` tilted `t` of the way toward `b`, renormalised. */
  function tiltToward(a, b, t) {
    return normalize3(
      a[0] * (1 - t) + b[0] * t,
      a[1] * (1 - t) + b[1] * t,
      a[2] * (1 - t) + b[2] * t
    );
  }

  /** The lap's base colour at `t` (0..1), interpolated between the palette ends. */
  function baseAt(t) {
    var a = palette.from, b = palette.to;
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];
  }

  /** A base colour under intensity `k`, as a css string. */
  function shade(base, k) {
    return "rgb(" +
      Math.round(clamp(base[0] * k, 0, 255)) + "," +
      Math.round(clamp(base[1] * k, 0, 255)) + "," +
      Math.round(clamp(base[2] * k, 0, 255)) + ")";
  }

  /**
   * Render the whole ribbon to an offscreen canvas — see the module note on why
   * this happens once rather than every frame.
   */
  function renderRibbon(g) {
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(cssW * dpr));
    c.height = Math.max(1, Math.round(cssH * dpr));
    var x = c.getContext("2d");
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Set once for the whole ribbon: `poly` runs thousands of times and every
    // avoided state change is real here. The start/finish stroke resets it after.
    x.lineWidth = 1;

    var s = g.screen, n = s.length, i;

    // The ground first: nothing in the scene is ever below it, so it needs no
    // place in the depth sort. The cast shadow then lands ON it, which is what
    // it was always pretending to do.
    if (ground) drawPlane(x, s, n);
    drawShadow(x, s, n, g);

    // Whether there is a hill to extrude at all. A circuit flatter than half a
    // metre gets `elevGain = 0`, every lift is 0, and a curtain would be a run
    // of zero-height quads — so the flat case pays nothing for this.
    var extrude = ground && g.elevGain > 0;
    var bands = extrude ? curtainBands(s, n) : 0;

    // Back to front. The index is carried through the sort because the base
    // colour is a function of position round the LAP, not of draw order.
    var order = new Array(n);
    for (i = 0; i < n; i++) order[i] = i;
    order.sort(function (a, b) {
      return (s[a].depth + s[(a + 1) % n].depth) - (s[b].depth + s[(b + 1) % n].depth);
    });

    // Which rail is nearer, in PATH order. The sorted loop below cannot work
    // this out for itself: a station needs a cap exactly when its two
    // neighbouring segments disagree, and after the sort a segment's path
    // neighbour is somewhere else entirely.
    var nearer = new Array(n);
    for (i = 0; i < n; i++) {
      var na = s[i], nb = s[(i + 1) % n];
      nearer[i] = (na.ly + nb.ly) > (na.ry + nb.ry);
    }

    var wall = g.wallPx;
    // One bevel strip as a fraction of the width, from a px target — a share
    // alone would vanish on a long circuit and swallow the road on a short one.
    var bevel = clamp(g.roadPx * BEVEL_SHARE, BEVEL_MIN_PX, BEVEL_MAX_PX) / Math.max(1, g.roadPx);
    bevel = clamp(bevel, 0.05, 0.33);

    for (var k = 0; k < n; k++) {
      i = order[k];
      var j = (i + 1) % n;
      var a = s[i], b = s[j];
      var base = baseAt(i / n);

      // The segment's frame, in view space: du/dv is where the road is going,
      // dh how much it climbs doing it, and `out` the horizontal normal of the
      // LEFT rail — the right rail's is its negation, so only one is built.
      var du = (b.lu + b.ru) / 2 - (a.lu + a.ru) / 2;
      var dv = (b.lv + b.rv) / 2 - (a.lv + a.rv) / 2;
      var dh = b.lift - a.lift;
      var run = Math.hypot(du, dv) || 1;
      var out = normalize3(
        (a.lu - (a.lu + a.ru) / 2), (a.lv - (a.lv + a.rv) / 2), 0
      );
      // The surface normal: up, tipped back by however steeply the road climbs.
      // `dh` is already in the same units as u and v, so the ratio is the slope.
      var nTop = normalize3(-(dh * du) / (run * run), -(dh * dv) / (run * run), 1);

      // Which edge is nearer the viewer decides the draw order within the
      // segment, and which rail's wall is the one actually facing us.
      var leftNearer = nearer[i];
      var nOutL = out;
      var nOutR = [-out[0], -out[1], 0];

      // The road has turned through the depth axis at this station, so it is
      // the one place the solid shows its cross-section.
      var capAt = extrude && nearer[(i - 1 + n) % n] !== leftNearer;

      // Far side first, then the road, then the near side — and each side's
      // curtain with it, so the whole solid is built far-to-near in one pass.
      //
      // BOTH rails get a curtain, not just the near one. Where the road runs
      // across the view the far curtain is hidden by the road above it and the
      // near curtain below, and those fills are wasted. But where the road runs
      // straight at the viewer the two rails project to separate vertical
      // lines, neither hides the other, and drawing one leaves a gap down the
      // side of the hill. Paying for the hidden case is cheaper than detecting
      // it, on a ribbon that is rendered once and then blitted.
      // The far curtain is lit as though it were the NEAR one. Its own normal
      // faces away from the light and lands on {@link AMBIENT}, and the two
      // shades are far enough apart that any sliver of it left showing — one
      // pixel where the road doubles back and two parts of the lap land on the
      // same column — reads as a black hairline ruled down the hill. It is
      // never legitimately visible: wherever it does show it is standing in for
      // the near face, so it should look like it.
      if (extrude) curtain(x, a, b, leftNearer ? "r" : "l", wall, base, leftNearer ? nOutL : nOutR, bands);
      wallFace(x, a, b, leftNearer ? "r" : "l", wall, base, leftNearer ? nOutR : nOutL);
      surface(x, a, b, base, nTop, nOutL, nOutR, bevel);
      wallFace(x, a, b, leftNearer ? "l" : "r", wall, base, leftNearer ? nOutL : nOutR);
      if (extrude) curtain(x, a, b, leftNearer ? "l" : "r", wall, base, leftNearer ? nOutL : nOutR, bands);
      // Last, because at a station where the near rail swaps, the near curtain
      // has narrowed to nothing and the FAR one — lit by the opposite normal,
      // so much darker — is what shows through the gap it leaves. The cap is
      // the face actually pointing at the viewer there, so it wins.
      if (capAt) {
        var toward = dv > 0 ? 1 : -1;
        curtainCap(x, a, wall, base, [(du / run) * toward, (dv / run) * toward, 0], bands);
      }
    }

    // Start/finish: a bar ACROSS the road, drawn as a stroke of fixed pixel
    // width rather than as a run of segments. A run would be a chord — and where
    // the line happens to sit on a curve (it does at Spa, at Zandvoort, on any
    // circuit that starts near a corner) the chord cuts across the road instead
    // of lying on it. One segment's two edge points always give the true
    // perpendicular, and a stroke width keeps it visible at any circuit length.
    var f0 = s[0];
    x.strokeStyle = palette.line;
    x.lineWidth = LINE_PX;
    x.lineCap = "butt";
    x.beginPath();
    x.moveTo(f0.lx, f0.ly);
    x.lineTo(f0.rx, f0.ry);
    x.stroke();

    return c;
  }

  /**
   * Fill a polygon, optionally stroking its own outline in the same colour.
   *
   * The stroke is not decoration. Adjacent segments are separate fills, and
   * canvas antialiases each one's edge against what is already there — which
   * leaves a hairline of background between every pair. Half a pixel of stroke
   * closes it, and the ribbon stops looking like 560 tiles.
   *
   * Every face needs it, including the walls — they were tried without and the
   * ribbon grew a ladder of cross-ticks, because a wall's seam runs along the
   * silhouette where there is background directly behind it to show through.
   * The flag exists for the one case that genuinely does not: see the shadow.
   */
  function poly(x, pts, color, seam) {
    x.fillStyle = color;
    x.beginPath();
    x.moveTo(pts[0], pts[1]);
    for (var i = 2; i < pts.length; i += 2) x.lineTo(pts[i], pts[i + 1]);
    x.closePath();
    x.fill();
    if (seam) {
      x.strokeStyle = color;
      x.stroke();
    }
  }

  /** The point `f` of the way across the road at station `p` (0 = left rail). */
  function across(p, f) {
    return [p.lx + (p.rx - p.lx) * f, p.ly + (p.ry - p.ly) * f];
  }

  /**
   * The road surface of one segment, as three strips: a bevel at each rail
   * tilted toward its own edge, and the flat centre between them. See the module
   * note on why this is what makes the ribbon read as rounded.
   */
  function surface(x, a, b, base, nTop, nOutL, nOutR, bevel) {
    var strips = [
      [0, bevel, tiltToward(nTop, nOutL, BEVEL_TILT), true],
      [bevel, 1 - bevel, nTop, false],
      [1 - bevel, 1, tiltToward(nTop, nOutR, BEVEL_TILT), true],
    ];
    for (var i = 0; i < strips.length; i++) {
      var f0 = strips[i][0], f1 = strips[i][1], nrm = strips[i][2];
      var k = lambert(nrm);
      if (strips[i][3]) {
        // The rim, on the bevels only. Cubed, so it is a catch on the edge that
        // happens to face the light rather than a lift across the whole strip.
        var d = Math.max(0, nrm[0] * LIGHT[0] + nrm[1] * LIGHT[1] + nrm[2] * LIGHT[2]);
        k += RIM_GAIN * d * d * d;
      }
      var a0 = across(a, f0), a1 = across(a, f1);
      var b0 = across(b, f0), b1 = across(b, f1);
      poly(x, [a0[0], a0[1], b0[0], b0[1], b1[0], b1[1], a1[0], a1[1]], shade(base, k), true);
    }
  }

  /**
   * One wall face: the road edge dropped `wall` px to make a vertical side,
   * split into a lit upper band and an occluded lower one. The split is what
   * keeps a 6 px wall from reading as a flat coloured stripe.
   */
  function wallFace(x, a, b, side, wall, base, nOut) {
    var ax = side === "l" ? a.lx : a.rx, ay = side === "l" ? a.ly : a.ry;
    var bx = side === "l" ? b.lx : b.rx, by = side === "l" ? b.ly : b.ry;
    var k = lambert(nOut);
    var split = wall * WALL_SPLIT;
    poly(x, [ax, ay, bx, by, bx, by + split, ax, ay + split], shade(base, k), true);
    poly(
      x,
      [ax, ay + split, bx, by + split, bx, by + wall, ax, ay + wall],
      shade(base, k * WALL_LOWER_MUL),
      true
    );
  }

  /**
   * A vertical face from one height down to another, banded so it darkens as it
   * falls. The curtain's only primitive.
   *
   * Bands rather than a gradient fill. There are two of these per segment and
   * hundreds of segments, so a `createLinearGradient` per face is a thousand
   * throwaway objects and a `fillStyle` change of exactly the kind the note in
   * {@link renderRibbon} keeps count of. Bands cost one fill each and stop
   * being distinguishable from a gradient at this size.
   *
   * `bands` is the SAME for every face on the ribbon, and it has to be. Sizing
   * it per face — from that face's own drop — splits the bands at different
   * shades either side of a segment boundary, and the curtain grows a vertical
   * dark line everywhere the count steps from one to two. With a single count
   * the bands are the same fractions of every face, the drop varies smoothly
   * along the path because the road does, and the boundaries go with it.
   *
   * `x` never changes down a face — the lift only moves Y — so only the four Y
   * values interpolate.
   */
  function dropFace(x, ax, ay, aFoot, bx, by, bFoot, base, k, bands) {
    var dropA = aFoot - ay, dropB = bFoot - by;
    var mean = (dropA + dropB) / 2;
    if (mean < CURTAIN_MIN_PX) return;
    for (var i = 0; i < bands; i++) {
      var t0 = i / bands, t1 = (i + 1) / bands;
      // Shade from the band's midpoint, so a one-band face lands halfway down
      // the ramp rather than at its bright end.
      var mid = (t0 + t1) / 2;
      var mul = CURTAIN_TOP_MUL + (CURTAIN_FOOT_MUL - CURTAIN_TOP_MUL) * mid;
      poly(
        x,
        [
          ax, ay + dropA * t0, bx, by + dropB * t0,
          bx, by + dropB * t1, ax, ay + dropA * t1,
        ],
        shade(base, k * mul),
        true
      );
    }
  }

  /**
   * One segment's curtain: the face hanging from the underside of a rail's wall
   * down to that rail's own place on the ground plane.
   *
   * Both ends of the face are offset by the wall's height — the top because the
   * road slab already hangs that far below the rail, and the plane because it
   * sits a wall below the flat rails for exactly that reason. Measuring from
   * the rail instead would make the drop `lift - wall`, which goes NEGATIVE on
   * every segment lying lower than the wall is tall, and inverts the quad. With
   * the offset the drop is exactly the lift, and a flat circuit gets zero.
   *
   * Lit by the wall's own normal, so the curtain is the same material as the
   * face above it and the solid stays one object under one light.
   */
  function curtain(x, a, b, side, wall, base, nOut, bands) {
    var ax = side === "l" ? a.lx : a.rx, ay = side === "l" ? a.ly : a.ry;
    var bx = side === "l" ? b.lx : b.rx, by = side === "l" ? b.ly : b.ry;
    var af = side === "l" ? a.fly : a.fry, bf = side === "l" ? b.fly : b.fry;
    dropFace(x, ax, ay + wall, af + wall, bx, by + wall, bf + wall, base, lambert(nOut), bands);
  }

  /**
   * The extrusion's end cap: the face ACROSS the road at one station, from the
   * underside down to the plane.
   *
   * Needed only where the road runs at the viewer. There both rails project to
   * the same vertical line, both rail curtains collapse to zero width, and the
   * face the solid actually presents is its cross-section — which no rail face
   * covers, because a rail face has no width to cover it with.
   *
   * Those stations are exactly where the near rail swaps, so the caller knows
   * them already and does not have to test for the geometry. There are on the
   * order of a couple of dozen a lap.
   */
  function curtainCap(x, p, wall, base, nCap, bands) {
    dropFace(
      x,
      p.lx, p.ly + wall, p.fly + wall,
      p.rx, p.ry + wall, p.fry + wall,
      base, lambert(nCap), bands
    );
  }

  /**
   * How many bands every curtain on this ribbon is drawn in — from the TALLEST
   * drop, so the deepest face gets its falloff and every other face is split
   * the same way. See {@link dropFace} for why one count rather than one each.
   */
  function curtainBands(s, n) {
    var maxDrop = 0;
    for (var i = 0; i < n; i++) {
      var dl = s[i].fly - s[i].ly, dr = s[i].fry - s[i].ry;
      if (dl > maxDrop) maxDrop = dl;
      if (dr > maxDrop) maxDrop = dr;
    }
    return clamp(Math.round(maxDrop / CURTAIN_BAND_PX), 1, CURTAIN_BANDS_MAX);
  }

  /**
   * The ground the circuit stands on: a pool of light centred under its own
   * footprint, fading out before it reaches anything that could look like an
   * edge. See {@link PLANE_TINT} for why it is a pool and not a plate.
   *
   * Measured from the FLAT rails, so the pool is centred on where the circuit
   * meets the ground rather than on the lifted ribbon — on a hilly circuit
   * those are not the same place, and centring on the ribbon slides the light
   * out from under the tall end.
   */
  function drawPlane(x, s, n) {
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, i;
    for (i = 0; i < n; i++) {
      var p = s[i];
      if (p.lx < minX) minX = p.lx;
      if (p.lx > maxX) maxX = p.lx;
      if (p.rx < minX) minX = p.rx;
      if (p.rx > maxX) maxX = p.rx;
      if (p.fly < minY) minY = p.fly;
      if (p.fly > maxY) maxY = p.fly;
      if (p.fry < minY) minY = p.fry;
      if (p.fry > maxY) maxY = p.fry;
    }
    if (!isFinite(minX) || !isFinite(minY)) return;

    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    var rx = Math.max(1, (maxX - minX) / 2) * (1 + PLANE_BLEED);
    var ry = Math.max(1, (maxY - minY) / 2) * (1 + PLANE_BLEED);
    // A circular gradient squashed into the ellipse, rather than an elliptical
    // one: canvas has no elliptical gradient, and scaling the space is how the
    // falloff stays even all the way round.
    var grad = x.createRadialGradient(0, 0, 0, 0, 0, rx);
    grad.addColorStop(0, "rgba(" + PLANE_TINT + "," + PLANE_ALPHA + ")");
    grad.addColorStop(PLANE_FADE, "rgba(" + PLANE_TINT + "," + PLANE_ALPHA * 0.72 + ")");
    grad.addColorStop(1, "rgba(" + PLANE_TINT + ",0)");

    x.save();
    x.translate(cx, cy);
    x.scale(1, ry / rx);
    x.fillStyle = grad;
    x.beginPath();
    x.arc(0, 0, rx, 0, Math.PI * 2);
    x.fill();
    x.restore();
  }

  /**
   * The ribbon's silhouette on the ground plane, blurred and offset.
   *
   * Drawn from the FLAT rails, so where the circuit climbs the road separates
   * from its own shadow and the elevation becomes something you can see rather
   * than infer. One accumulated path filled nonzero — the segments overlap
   * heavily at every corner, and filling them individually would stack alpha
   * into a darker smear exactly where the map is busiest.
   */
  function drawShadow(x, s, n, g) {
    var sc = document.createElement("canvas");
    sc.width = Math.max(1, Math.round(cssW * dpr));
    sc.height = Math.max(1, Math.round(cssH * dpr));
    var sx = sc.getContext("2d");
    sx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sx.fillStyle = "#000";
    sx.beginPath();
    for (var i = 0; i < n; i++) {
      var a = s[i], b = s[(i + 1) % n];
      sx.moveTo(a.lx + SHADOW_DX, a.fly + SHADOW_DY);
      sx.lineTo(b.lx + SHADOW_DX, b.fly + SHADOW_DY);
      sx.lineTo(b.rx + SHADOW_DX, b.fry + SHADOW_DY + g.wallPx);
      sx.lineTo(a.rx + SHADOW_DX, a.fry + SHADOW_DY + g.wallPx);
      sx.closePath();
    }
    sx.fill();

    x.save();
    // `filter` is Chromium-only among the engines this ships on, and it is the
    // whole point of the pass — an unblurred silhouette reads as a second track,
    // not a shadow. Without it, no shadow at all is the better failure.
    if ("filter" in x) {
      x.filter = "blur(" + clamp(g.wallPx * SHADOW_BLUR_MUL, SHADOW_BLUR_MIN, SHADOW_BLUR_MAX) + "px)";
      x.globalAlpha = ground && g.elevGain > 0 ? SHADOW_ALPHA_SOLID : SHADOW_ALPHA;
      x.drawImage(sc, 0, 0, cssW, cssH);
    }
    x.restore();
  }

  /**
   * Where one car sits on the canvas, or `null` when the frame gave it neither
   * placement. World position wins over lap fraction: it is the car's real spot
   * on the road (and in the pit lane), where the fraction can only pin it to the
   * centre of the path. See `TrackMapCar` in types.ts.
   */
  function carPoint(g, car) {
    if (typeof car.x === "number" && typeof car.z === "number") {
      return project(g, car.x, car.z, car.y);
    }
    if (typeof car.lapFraction === "number") {
      var p = pointAtFraction(g, car.lapFraction);
      return project(g, p[0], p[1], p[2]);
    }
    return null;
  }

  /** One car: a shadow on the road, then the dot. */
  function drawCar(car, info, pos) {
    var isEgo = car.isPlayer;
    var r = isEgo ? EGO_R : DOT_R;
    gctx.globalAlpha = car.inPit ? 0.42 : 1;

    // Contact shadow — it is what makes a dot sit ON the road rather than float
    // over it, and it costs one ellipse.
    gctx.fillStyle = "rgba(0,0,0,0.38)";
    gctx.beginPath();
    gctx.ellipse(pos.x, pos.y + r * 0.55, r * 1.05, r * 0.5, 0, 0, Math.PI * 2);
    gctx.fill();

    gctx.beginPath();
    gctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    gctx.fillStyle = isEgo ? "#ffffff" : classColor(info && info.carClass);
    gctx.fill();
    // A full-strength dark outline, not a softened one. The road is now a lit
    // colour rather than near-white, and one class (Hypercar, #ff5470) sits
    // close enough to the classic red that the ring is the only thing holding
    // the dot off its background.
    gctx.lineWidth = isEgo ? 2 : 1.6;
    gctx.strokeStyle = "#0a0b12";
    gctx.stroke();

    // The player also gets a ring, so their own car is findable in a pack of
    // same-class dots without hunting for the white one.
    if (isEgo) {
      gctx.beginPath();
      gctx.arc(pos.x, pos.y, r + 3.2, 0, Math.PI * 2);
      gctx.strokeStyle = "rgba(34,211,238,0.9)";
      gctx.lineWidth = 1.6;
      gctx.stroke();
    }
    gctx.globalAlpha = 1;
  }

  /* -------------------------------- sizing --------------------------------- */

  /**
   * Size the bitmap to the panel, and the panel's height to the circuit.
   *
   * The height is not a constant: a map's useful aspect is the circuit's own
   * (Le Mans is long and thin, Zandvoort is square), and forcing every one into
   * the same box either crops the wide ones or wastes half the panel on the
   * square ones. The geometry is built once at a provisional height and the
   * canvas is then set to the aspect it asked for, which is why this can run
   * twice — cheap, and only on a resize or a track change.
   */
  function sizeCanvas(force) {
    if (!canvas) return;
    var w = canvas.clientWidth || 320;
    var provisional = Math.round(w * 0.5);
    var h = provisional;
    var d = window.devicePixelRatio || 1;

    if (w !== cssW || force) {
      cssW = w; cssH = provisional; dpr = d;
      var probe = buildGeometry();
      if (probe) h = Math.round(w * clamp(probe.aspect, ASPECT_MIN, ASPECT_MAX));
    } else {
      h = cssH;
    }

    var bw = Math.round(w * d), bh = Math.round(h * d);
    cssW = w; cssH = h; dpr = d;
    canvas.style.height = cssH + "px";
    // Add the border chrome back so the content box is exactly cssH tall and the
    // bitmap is never squashed to fit (same fix as motion.js / radar.js).
    var chrome = canvas.offsetHeight - canvas.clientHeight;
    if (chrome > 0) canvas.style.height = cssH + chrome + "px";
    canvas.width = bw; canvas.height = bh;
    if (gctx) gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    geom = null;
    // A forced call is a new circuit or a first paint — there is nothing worth
    // keeping and nothing to stutter, so let it rebuild at once. An observed
    // resize is the drag case, and waits.
    ribbonDeferUntil = force ? 0 : Date.now() + RESIZE_SETTLE_MS;
  }

  function watchSize(el) {
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(function () { sizeCanvas(false); }).observe(el);
    }
    window.addEventListener("resize", function () { sizeCanvas(false); }, { passive: true });
  }

  /* ---------------------------------- init --------------------------------- */

  function init(root) {
    headerMeta = root.querySelector('[data-role="meta"]');
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML = "";

    var params = new URLSearchParams(window.location.search);
    var style = (params.get("style") || "").toLowerCase();
    if (PALETTES[style]) palette = PALETTES[style];
    else if (window.ApexAppearance && window.ApexAppearance.onModes) {
      window.ApexAppearance.onModes(function (modes) {
        var m = modes && modes.trackmap;
        if (PALETTES[m] && PALETTES[m] !== palette) {
          palette = PALETTES[m];
          ribbon = null; // the shape is unchanged; only its paint is
        }
      });
    }
    var rot = parseFloat(params.get("rotate"));
    if (isFinite(rot)) rotateOverrideRad = (rot * Math.PI) / 180;
    var t = parseFloat(params.get("tilt"));
    if (isFinite(t)) tilt = clamp(t, 0.2, 0.9);
    if (params.get("ground") === "0") ground = false;

    var wrap = document.createElement("div");
    wrap.className = "trackmap__wrap";
    canvas = document.createElement("canvas");
    canvas.className = "trackmap__canvas";
    statusEl = document.createElement("div");
    statusEl.className = "trackmap__status";
    statusEl.textContent = "Awaiting telemetry…";
    wrap.appendChild(canvas);
    wrap.appendChild(statusEl);
    mount.appendChild(wrap);

    gctx = canvas.getContext("2d");
    sizeCanvas(true);
    watchSize(canvas);
  }

  /* --------------------------------- update -------------------------------- */

  function update(frame) {
    var map = frame && frame.trackMap;
    if (!map) {
      setStatus("Awaiting telemetry…");
      if (gctx) gctx.clearRect(0, 0, cssW, cssH);
      return;
    }
    ensureShape(map);

    if (headerMeta) {
      headerMeta.textContent = frame.session && frame.session.track
        ? frame.session.track
        : "—";
    }

    if (!shape) {
      // No shape yet: say what the system is doing about it. The progress is the
      // fraction of the lap the learner has seen, which moves as you drive and
      // is the honest answer to "why is there no map".
      //
      // "Rebuilding" is the same read after a map has been thrown away for not
      // matching the circuit. Without the distinction, a map that was on screen
      // last lap and is a progress bar this lap reads as the overlay breaking,
      // when it is the overlay repairing itself — and the driver has one lap of
      // wondering whether to restart something.
      setStatus(
        map.ready
          ? "Loading circuit…"
          : (map.relearning ? "Rebuilding the circuit — " : "Learning the circuit — ") +
              Math.round((map.progress || 0) * 100) + "%"
      );
      // Nothing painted this canvas but us, and until a map could be WITHDRAWN
      // this branch only ever ran before the first paint, so there was never
      // anything on it to remove. There is now: the ribbon of the map that was
      // just condemned, which would sit there under the progress read looking
      // like a live map with the wrong circuit on it.
      if (gctx) gctx.clearRect(0, 0, cssW, cssH);
      return;
    }
    setStatus("");

    if (!geom) {
      geom = buildGeometry();
      ribbon = null;
    }
    if (!geom) return;
    var key = haveKey + "|" + haveRevision + "|" + cssW + "x" + cssH + "|" + dpr;
    if (ribbonKey !== key) {
      // Never defer the FIRST ribbon: there is no cached bitmap to stretch, so
      // waiting would show an empty panel rather than a soft one.
      if (!ribbon || Date.now() >= ribbonDeferUntil) {
        ribbon = renderRibbon(geom);
        ribbonKey = key;
      }
    }

    gctx.clearRect(0, 0, cssW, cssH);
    // Stretched to the panel, which matters only in the gap between a resize and
    // the rebuild above; the rest of the time the two sizes are identical.
    gctx.drawImage(ribbon, 0, 0, cssW, cssH);

    // Identity (class colour, and therefore which dot is which) lives on the
    // standings rows; the map block carries only position. Joined by slot id
    // rather than duplicated on the wire — see TrackMapCar in types.ts.
    var byId = {};
    var rows = frame.standings || [];
    for (var i = 0; i < rows.length; i++) byId[rows[i].slotId] = rows[i];

    // Project once, then draw furthest first so a dot in front covers one behind
    // it rather than the other way round.
    var drawable = [];
    var ego = null;
    var cars = map.cars || [];
    for (i = 0; i < cars.length; i++) {
      var pos = carPoint(geom, cars[i]);
      if (!pos) continue;
      var item = { car: cars[i], info: byId[cars[i].slotId], pos: pos };
      // The player is held back and drawn last whatever its depth: it is the one
      // dot that must never end up under another, and the one the eye looks for
      // first.
      if (cars[i].isPlayer) ego = item;
      else drawable.push(item);
    }
    drawable.sort(function (a, b) { return a.pos.depth - b.pos.depth; });
    for (i = 0; i < drawable.length; i++) {
      drawCar(drawable[i].car, drawable[i].info, drawable[i].pos);
    }
    if (ego) drawCar(ego.car, ego.info, ego.pos);
  }

  function setStatus(text) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.style.display = text ? "" : "none";
  }

  window.ApexOverlay.registerWidget("trackmap", {
    // 20 Hz. The dots move continuously, but a whole circuit in a panel runs at
    // metres per pixel — past this the movement is smaller than a pixel and the
    // only thing going up is the CPU an OBS source costs.
    throttleMs: 50,
    init: init,
    update: update,
  });
})();
