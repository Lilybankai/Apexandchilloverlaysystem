/**
 * setup-3d/car-model.js — the neon wireframe GT car, built from primitives.
 * -----------------------------------------------------------------------------
 * LMU's real car models are encrypted, so the editor draws its own: a stylised
 * low-poly GT silhouette as glowing line work — cyan shell, orange wheels,
 * spring coils that recolour with stiffness — deliberately a diagram, not a
 * replica. Every part that a setup value moves is its own named object so
 * `applySetup` can drive transforms directly:
 *
 *   body        — heave/pitch from the four WM_RIDEHEIGHT corners
 *   hubFL..RR   — camber (roll tilt) + toe (yaw) pivots holding wheel + disc
 *   springFL..  — helix recoloured cyan→purple by WM_SPRING position
 *   damperFL..  — opacity pulsing with WM_SLOWBUMP stiffness
 *   discFL..    — glow split front/rear by VM_BRAKE_BALANCE
 *   rearWingPivot — angle + glow from VM_REAR_WING
 *   splitter    — glow from VM_FRONT_WING where the car has one
 *
 * Everything is normalised by each key's own min..max, so the same model works
 * for any car class — a GT3 and an LMP2 just sit at different points of the
 * same visual range.
 *
 * Classic script: window.ApexCarModel. Depends on window.THREE (vendor bundle).
 * Coordinates: X right, Y up, Z forward (nose at +Z).
 */

(function () {
  'use strict';

  const CYAN = 0x26bbf4;
  const PURPLE = 0x6a2fd6;
  const ORANGE = 0xff9a3c;
  const MAGENTA = 0xd944ff;

  const CORNERS = [
    { tag: 'FL', x: -0.82, z: 1.42 },
    { tag: 'FR', x: 0.82, z: 1.42 },
    { tag: 'RL', x: -0.82, z: -1.42 },
    { tag: 'RR', x: 0.82, z: -1.42 },
  ];
  const WHEEL_R = 0.33;

  function lineMat(THREE, color, opacity) {
    return new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }

  /** Edge wireframe of a geometry, with a soft additive "glow" duplicate. */
  function edgeLines(THREE, geometry, color, opacity) {
    const edges = new THREE.EdgesGeometry(geometry, 12);
    const group = new THREE.Group();
    group.add(new THREE.LineSegments(edges, lineMat(THREE, color, opacity)));
    const glow = new THREE.LineSegments(edges, lineMat(THREE, color, opacity * 0.35));
    glow.scale.setScalar(1.012);
    group.add(glow);
    return group;
  }

  /** The GT side profile as a closed shape in the (z, y) plane. */
  function bodyProfile(THREE) {
    const s = new THREE.Shape();
    // Starting under the splitter, running nose → roof → tail → diffuser.
    s.moveTo(2.3, 0.16); // splitter lip
    s.lineTo(2.28, 0.34); // nose
    s.lineTo(1.55, 0.52); // hood
    s.lineTo(0.75, 0.6); // scuttle
    s.lineTo(0.25, 1.02); // windscreen
    s.lineTo(-0.55, 1.06); // roof
    s.lineTo(-1.25, 0.82); // rear glass
    s.lineTo(-2.05, 0.74); // deck
    s.lineTo(-2.3, 0.7); // tail top
    s.lineTo(-2.28, 0.42); // tail face
    s.lineTo(-2.05, 0.2); // diffuser exit
    s.lineTo(-1.1, 0.13); // floor rear
    s.lineTo(1.2, 0.13); // floor front
    s.closePath();
    return s;
  }

  function helixPoints(THREE, turns, radius, height, segs) {
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const a = t * turns * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * radius, t * height, Math.sin(a) * radius));
    }
    return pts;
  }

  function build(THREE) {
    const root = new THREE.Group();
    const parts = {};

    // Ground: a sparse grid receding into the dark — the reference image's floor.
    const grid = new THREE.GridHelper(14, 24, 0x123047, 0x0b1c2c);
    grid.position.y = 0;
    if (Array.isArray(grid.material)) {
      for (const m of grid.material) {
        m.transparent = true;
        m.opacity = 0.5;
      }
    } else {
      grid.material.transparent = true;
      grid.material.opacity = 0.5;
    }
    root.add(grid);

    // Body — extruded side profile, rendered as edges only.
    const extrude = new THREE.ExtrudeGeometry(bodyProfile(THREE), {
      depth: 1.72,
      bevelEnabled: true,
      bevelThickness: 0.1,
      bevelSize: 0.09,
      bevelSegments: 1,
      steps: 1,
    });
    // Extrude runs along +Z of the shape's plane; the shape lives in (z, y),
    // so rotate the result to put its depth across the car's X.
    extrude.rotateY(Math.PI / 2);
    extrude.translate(-0.95, 0, 0); // centre the width
    const body = new THREE.Group();
    body.add(edgeLines(THREE, extrude, CYAN, 0.85));

    // Cockpit accent — a magenta halo line like the reference image's doors.
    const cabin = new THREE.BoxGeometry(1.5, 0.42, 1.15);
    const cabinLines = edgeLines(THREE, cabin, MAGENTA, 0.5);
    cabinLines.position.set(0, 0.78, -0.15);
    body.add(cabinLines);

    // Splitter (front) and rear wing on its pivot ride WITH the body so ride
    // height and rake move them too.
    const splitter = edgeLines(THREE, new THREE.BoxGeometry(1.9, 0.035, 0.42), ORANGE, 0.7);
    splitter.position.set(0, 0.13, 2.32);
    body.add(splitter);
    parts.splitter = splitter;

    const wingPivot = new THREE.Group();
    wingPivot.position.set(0, 0.98, -2.1);
    const wing = edgeLines(THREE, new THREE.BoxGeometry(1.78, 0.03, 0.34), MAGENTA, 0.8);
    wingPivot.add(wing);
    const endplateGeo = new THREE.BoxGeometry(0.02, 0.22, 0.4);
    for (const side of [-1, 1]) {
      const ep = edgeLines(THREE, endplateGeo, MAGENTA, 0.6);
      ep.position.set(side * 0.9, 0.02, 0);
      wingPivot.add(ep);
    }
    body.add(wingPivot);
    parts.rearWingPivot = wingPivot;
    parts.rearWing = wing;

    parts.body = body;
    root.add(body);

    // Corners: hub pivot (camber/toe) holding wheel + disc; spring + damper
    // stand inboard of each wheel.
    const wheelGeo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.27, 14, 1, false);
    wheelGeo.rotateZ(Math.PI / 2); // axis across the car
    const discGeo = new THREE.TorusGeometry(0.17, 0.02, 6, 18);
    discGeo.rotateY(Math.PI / 2);

    for (const c of CORNERS) {
      const hub = new THREE.Group();
      hub.position.set(c.x, WHEEL_R, c.z);

      const wheel = edgeLines(THREE, wheelGeo, ORANGE, 0.75);
      hub.add(wheel);
      const disc = edgeLines(THREE, discGeo, ORANGE, 0.5);
      hub.add(disc);

      root.add(hub);
      parts['hub' + c.tag] = hub;
      parts['disc' + c.tag] = disc;

      const spring = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(helixPoints(THREE, 5, 0.085, 0.42, 60)),
        lineMat(THREE, CYAN, 0.9),
      );
      spring.position.set(c.x * 0.62, 0.36, c.z);
      root.add(spring);
      parts['spring' + c.tag] = spring;

      const damper = edgeLines(THREE, new THREE.CylinderGeometry(0.03, 0.03, 0.4, 8), CYAN, 0.5);
      damper.position.set(c.x * 0.62 + (c.x > 0 ? 0.14 : -0.14), 0.56, c.z);
      root.add(damper);
      parts['damper' + c.tag] = damper;
    }

    return { root, parts };
  }

  /* ---- setup → visuals -------------------------------------------------- */

  function reader(settings, staged) {
    return {
      norm(key) {
        const s = settings.get(key);
        if (!s || s.max <= s.min) return null;
        const v = staged && staged.has(key) ? staged.get(key) : s.value;
        return (v - s.min) / (s.max - s.min);
      },
    };
  }

  function avg(values) {
    const xs = values.filter((v) => v !== null && v !== undefined);
    if (!xs.length) return null;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  }

  function lerpColor(THREE, mat, from, to, t) {
    mat.color.copy(new THREE.Color(from).lerp(new THREE.Color(to), t));
  }

  /**
   * Drives the model from the live settings (+ staged overlay). Normalised
   * per-key, exaggerated for legibility — this is a diagram of the CHANGES,
   * not a physics render.
   */
  function applySetup(THREE, parts, settings, staged) {
    const r = reader(settings, staged);

    // Ride height → body heave + rake pitch.
    const front = avg([r.norm('WM_RIDEHEIGHT-W_FL'), r.norm('WM_RIDEHEIGHT-W_FR')]);
    const rear = avg([r.norm('WM_RIDEHEIGHT-W_RL'), r.norm('WM_RIDEHEIGHT-W_RR')]);
    if (front !== null || rear !== null) {
      const f = front ?? rear ?? 0.5;
      const b = rear ?? front ?? 0.5;
      parts.body.position.y = 0.02 + ((f + b) / 2) * 0.16;
      parts.body.rotation.x = (b - f) * 0.1; // rear high = nose down = +rake
    }

    for (const tag of ['FL', 'FR', 'RL', 'RR']) {
      const side = tag.endsWith('L') ? -1 : 1;

      // Camber: index high = less negative (from the live census), so tilt
      // tops-inboard by (1 - norm). Exaggerated to 6° full scale.
      const camber = r.norm(`WM_CAMBER-W_${tag}`);
      const hub = parts['hub' + tag];
      if (camber !== null && hub) hub.rotation.z = side * (1 - camber) * 0.105;

      // Toe: lower index = more toe-out (again per census); ±2.5° full scale.
      const toe = r.norm(tag.startsWith('F') ? 'VM_FRONT_TOEIN' : 'VM_REAR_TOEIN');
      if (toe !== null && hub) hub.rotation.y = side * (0.5 - toe) * 0.09;

      // Spring stiffness → coil colour cyan→purple.
      const spring = r.norm(`WM_SPRING-W_${tag}`);
      const coil = parts['spring' + tag];
      if (spring !== null && coil) lerpColor(THREE, coil.material, CYAN, PURPLE, spring);

      // Slow bump → damper prominence.
      const bump = r.norm(`WM_SLOWBUMP-W_${tag}`);
      const damper = parts['damper' + tag];
      if (bump !== null && damper) {
        damper.traverse((o) => {
          if (o.material) o.material.opacity = 0.25 + bump * 0.6;
        });
      }

      // Brake bias → disc glow split. Lower index = more FRONT bias.
      const bias = r.norm('VM_BRAKE_BALANCE');
      const disc = parts['disc' + tag];
      if (bias !== null && disc) {
        const share = tag.startsWith('F') ? 1 - bias : bias;
        disc.traverse((o) => {
          if (o.material) o.material.opacity = 0.2 + share * 0.75;
        });
      }
    }

    // Rear wing: more wing = steeper angle + brighter.
    const wingN = r.norm('VM_REAR_WING');
    if (wingN !== null && parts.rearWingPivot) {
      parts.rearWingPivot.rotation.x = -0.08 - wingN * 0.38;
      parts.rearWing.traverse((o) => {
        if (o.material) o.material.opacity = 0.35 + wingN * 0.6;
      });
    }
    const frontWingN = r.norm('VM_FRONT_WING');
    if (frontWingN !== null && parts.splitter) {
      parts.splitter.traverse((o) => {
        if (o.material) o.material.opacity = 0.3 + frontWingN * 0.6;
      });
    }
  }

  window.ApexCarModel = { build, applySetup };
})();
