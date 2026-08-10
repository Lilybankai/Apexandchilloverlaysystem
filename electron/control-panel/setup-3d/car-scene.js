/**
 * setup-3d/car-scene.js — renderer, camera and lifecycle for the wireframe car.
 * -----------------------------------------------------------------------------
 * Owns the ONLY requestAnimationFrame in the panel, and holds the tab's
 * resource promise: `start()` is called when the Setups tab is shown (and the
 * canvas not collapsed), `stop()` the moment it hides — a stopped scene
 * schedules nothing and costs nothing. The renderer survives stop/start; only
 * the frame loop comes and goes.
 *
 * Interaction: slow auto-orbit, drag to look, wheel to zoom. No OrbitControls
 * dependency — the few lines below are all the control this card needs, and
 * they save vendoring (and CSP-proofing) another module.
 *
 * Classic script: window.ApexCarScene. Depends on window.THREE and
 * window.ApexCarModel, both loaded for it by setup-editor.js.
 */

(function () {
  'use strict';

  function createCarScene(container) {
    const THREE = window.THREE;
    const model = window.ApexCarModel;

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x05080f, 9, 16);

    const camera = new THREE.PerspectiveCamera(38, 4 / 3, 0.1, 60);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0); // the CSS radial gradient is the ground glow
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    container.appendChild(renderer.domElement);

    const hint = document.createElement('span');
    hint.className = 'su-canvas__hint';
    hint.textContent = 'drag to orbit';
    container.appendChild(hint);

    const { root, parts } = model.build(THREE);
    scene.add(root);

    /* ---- orbit state ---------------------------------------------------- */

    let yaw = 0.7; // start three-quarter front, like the reference image
    let pitch = 0.42;
    let radius = 7.2;
    let autoSpin = true;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    function placeCamera() {
      const p = Math.max(0.12, Math.min(1.25, pitch));
      pitch = p;
      camera.position.set(
        Math.sin(yaw) * Math.cos(p) * radius,
        Math.sin(p) * radius,
        Math.cos(yaw) * Math.cos(p) * radius,
      );
      camera.lookAt(0, 0.45, 0);
    }

    renderer.domElement.addEventListener('pointerdown', (e) => {
      dragging = true;
      autoSpin = false;
      lastX = e.clientX;
      lastY = e.clientY;
      renderer.domElement.setPointerCapture(e.pointerId);
    });
    renderer.domElement.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      yaw -= (e.clientX - lastX) * 0.008;
      pitch += (e.clientY - lastY) * 0.006;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    const endDrag = () => {
      dragging = false;
    };
    renderer.domElement.addEventListener('pointerup', endDrag);
    renderer.domElement.addEventListener('pointercancel', endDrag);
    renderer.domElement.addEventListener('dblclick', () => {
      autoSpin = true; // double-click hands the camera back to the slow spin
    });
    renderer.domElement.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        radius = Math.max(4.5, Math.min(11, radius + e.deltaY * 0.004));
      },
      { passive: false },
    );

    /* ---- sizing ----------------------------------------------------------- */

    function resize() {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    }
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();

    /* ---- frame loop --------------------------------------------------------- */

    let raf = 0;
    let running = false;
    let lastT = 0;

    function frame(t) {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0;
      lastT = t;
      if (autoSpin && !dragging) yaw += dt * 0.15;
      placeCamera();
      renderer.render(scene, camera);
    }

    return {
      start() {
        if (running) return;
        running = true;
        lastT = 0;
        raf = requestAnimationFrame(frame);
      },
      stop() {
        running = false;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      },
      applySetup(settings, staged) {
        model.applySetup(THREE, parts, settings, staged);
        // Paint even while stopped (e.g. collapsed→shown transitions repaint
        // before start()), but never schedule from here.
        if (!running) {
          placeCamera();
          renderer.render(scene, camera);
        }
      },
      dispose() {
        this.stop();
        ro.disconnect();
        renderer.dispose();
        renderer.domElement.remove();
        hint.remove();
      },
    };
  }

  window.ApexCarScene = { createCarScene };
})();
