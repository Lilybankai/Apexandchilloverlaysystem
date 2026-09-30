/**
 * vr-guide.js — the VR tab explains itself, once.
 * -----------------------------------------------------------------------------
 * Same shape and same manners as setup-guide.js, team-guide.js and
 * review-guide.js: the first visit gets a short walkthrough, dismissing it in
 * any way counts as read, and "How it works" beside the title brings it back
 * deliberately. The seen flag is a renderer nicety in localStorage, never IPC.
 *
 * It exists because almost everything that makes VR "not work" happens outside
 * this window, where the tab cannot point at it:
 *
 *   1. PRECONDITIONS. SteamVR installed, LMU started with its SteamVR launch
 *      option, and Apex running. Miss the launch option and LMU runs through
 *      another runtime where no SteamVR panel can ever appear — and nothing on
 *      this page is wrong.
 *   2. THE COORDINATES. Distance, height and left/right are measured from the
 *      driver's head at the last recentre, which is not something a slider
 *      label can say.
 *   3. THE ONE THING IT CANNOT DO. Panels draw over the game, hands included.
 *      That is how every out-of-process overlay works (fpsVR too) — worth
 *      saying before someone files it as a bug.
 *
 * Classic script (window.APEX_VR_GUIDE) + module.exports so the step content
 * can be asserted headlessly from scripts/test-tour.js.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_VR_GUIDE = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** Bumping this re-offers the walkthrough to everyone, once. */
  const GUIDE_VERSION = '1';
  const SEEN_KEY = 'apex.vr.guide.seen';

  const AUTO_DELAY_MS = 700;
  const AUTO_RETRY_MS = 400;
  const AUTO_TRIES = 8;

  /**
   * The walkthrough. `icon` is a sprite id from icons.js (no prefix); `lead` is
   * the sentence that would do on its own; the points are what you would tell
   * a driver sitting next to you with the tab open.
   */
  const STEPS = [
    {
      id: 'what',
      icon: 'vr-headset',
      title: 'Your overlays, inside the headset',
      lead: 'This tab puts your widgets on panels in VR — the speedo, the relative, standings, fuel and the rest — each one fixed in the cockpit exactly where you put it.',
      points: [
        'Every widget is its own panel. Put the relative by the left mirror and the speedo under the dash; each stays where it is while you look around.',
        'The panels are drawn by SteamVR from outside the game, the same way fpsVR draws its panels. Nothing is injected into Le Mans Ultimate, so anti-cheat has nothing to see.',
        'It is a beta. It should work with any headset that runs through SteamVR. So far it has been tested on a PSVR2.',
      ],
    },
    {
      id: 'before',
      icon: 'clipboard-list',
      title: 'Before you start',
      lead: 'Three things have to be true, and none of them are on this page.',
      points: [
        'SteamVR is installed. It is free on Steam. If it is missing, the line under the switch says so.',
        'Le Mans Ultimate is started with the SteamVR launch option. When you press Play in Steam, pick the SteamVR option. Started any other way, LMU runs through a different VR runtime and no SteamVR panel can appear, however the settings here are set.',
        'Apex is running, with the server started. The panels come from this app, so they go when it closes.',
        'Quest over Link or Virtual Desktop: the same rule applies, and it matters more. Both use their own VR runtime by default, so LMU has to be launched with the SteamVR option or the panels will not show.',
      ],
    },
    {
      id: 'on',
      icon: 'zap',
      title: 'Switch it on',
      lead: 'Turn on Show in VR headset. The line under the switch tells you what is happening from then on.',
      points: [
        '“Waiting for SteamVR” means Apex is ready and SteamVR is not running yet. Start LMU in VR and the panels appear on their own. Apex never starts SteamVR for you.',
        '“In your headset” means the panels are up. It also shows how often they are updating.',
        'You can switch it on before the game, or with the game already running. If SteamVR closes, Apex waits and reconnects when it comes back.',
        'The speedo and the relative are switched on to begin with. Use the widget chips to add or remove panels. Each one you turn on appears in the headset straight away.',
      ],
    },
    {
      id: 'place',
      icon: 'move-vertical',
      title: 'Place each panel',
      lead: 'Pick a widget under Adjust, then move it with the sliders. Changes show up in the headset as you drag, so the easiest way is to set it up with the headset on.',
      points: [
        'Distance is how far in front of you it sits. Height is up or down from your eyes, and a minus number means below them. Left / right is sideways, and a minus number means left. All three are in centimetres.',
        'All three are measured from where your head was at the last recentre. Recentre in LMU and the panels move with the cockpit, so they stay where you put them.',
        'Size is the panel’s width in centimetres. Its height follows the widget’s own shape.',
        'Each panel turns to face you wherever you put it. Tilt leans the top edge away from you, Turn swings the right edge away, and Roll rotates it clockwise.',
        'The − and + buttons beside each slider move it one step: 1 cm, 1 degree, or 5% opacity. Use them for the small adjustments that are hard to make by dragging.',
        '“Reset this widget” puts the selected panel back where it started. The others stay where they are.',
      ],
    },
    {
      id: 'mfd',
      icon: 'sliders-horizontal',
      title: 'The MFD in the headset',
      lead: 'Switch on the MFD chip and the pit menu and driving aids get a panel of their own. It stays out of the way until you need it, then hides again.',
      points: [
        'The pit menu buttons you already use on your wheel (▲ ▼ + −) work in the headset exactly as they do on screen. Pressing any of them brings the MFD up, and the highlighted row shows what + and − will change.',
        'It hides itself a few seconds after your last press, like the MFD on screen does with auto-fade on. “Hide after” in the MFD card sets how long it stays up: 3 to 20 seconds.',
        'Bind a button to “Show / hide the MFD in the VR headset” in the MFD card to bring it up just to read it, and press it again to put it away.',
        'Those bindings are the same ones as in Settings → Controls. Change one in either place and it changes in both.',
      ],
    },
    {
      id: 'hands',
      icon: 'eye',
      title: 'Why your hands go behind the panels',
      lead: 'Panels always draw on top of the game, including your hands and the wheel. Every SteamVR overlay works like this, fpsVR included, because only the game itself can put something behind your hands, and anti-cheat does not allow anything to draw inside the game.',
      points: [
        'Keep panels away from where your hands go. Above the dash, by the mirrors or down past the wheel rim all work well.',
        'If a panel has to sit over the wheel, lower its Opacity so you can see your hands through it.',
        'If text looks soft, increase the panel’s Size or move it closer. Bigger panels are easier to read in every headset.',
        'Press “How it works” at the top of the tab to open this guide again.',
      ],
    },
  ];

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /* ---- state ------------------------------------------------------------- */

  let step = 0;
  let open = false;
  let autoTimer = null;
  let els = null;

  /* ---- seen flag --------------------------------------------------------- */

  function hasSeen() {
    try {
      return localStorage.getItem(SEEN_KEY) === GUIDE_VERSION;
    } catch {
      return true;
    }
  }

  function markSeen() {
    try {
      localStorage.setItem(SEEN_KEY, GUIDE_VERSION);
    } catch {
      /* storage disabled — it just opens again next time */
    }
  }

  /* ---- DOM --------------------------------------------------------------- */

  function lookup() {
    if (els) return els;
    const $ = (sel) => document.querySelector(sel);
    const root = $('#vr-guide');
    if (!root) return null;
    els = {
      root,
      view: document.querySelector('[data-view="vr"]'),
      scrim: $('#vr-guide-scrim'),
      icon: $('#vr-guide-icon'),
      title: $('#vr-guide-title'),
      sub: $('#vr-guide-sub'),
      body: $('#vr-guide-body'),
      dots: $('#vr-guide-dots'),
      back: $('#vr-guide-back'),
      next: $('#vr-guide-next'),
      close: $('#vr-guide-close'),
    };
    return els;
  }

  /** A sprite icon built longhand, for the same parity-test reason as setup-guide. */
  function iconEl(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  /** Paint the current step. Text nodes only. */
  function paint() {
    const e = lookup();
    if (!e) return;
    const s = STEPS[step];

    e.icon.textContent = '';
    e.icon.appendChild(iconEl(s.icon));

    e.title.textContent = s.title;
    e.sub.textContent = `Step ${step + 1} of ${STEPS.length}`;

    e.body.textContent = '';
    const lead = document.createElement('p');
    lead.className = 'su-guide__lead';
    lead.textContent = s.lead;
    e.body.appendChild(lead);

    const list = document.createElement('ul');
    list.className = 'su-guide__points';
    for (const point of s.points) {
      const li = document.createElement('li');
      li.textContent = point;
      list.appendChild(li);
    }
    e.body.appendChild(list);
    e.body.scrollTop = 0;

    e.dots.textContent = '';
    for (let i = 0; i < STEPS.length; i += 1) {
      const dot = document.createElement('span');
      dot.className = 'su-guide__dot';
      dot.dataset.state = i === step ? 'now' : i < step ? 'done' : 'todo';
      e.dots.appendChild(dot);
    }

    e.back.disabled = step === 0;
    e.next.textContent = step === STEPS.length - 1 ? 'Got it' : 'Next';
  }

  /* ---- open / close ------------------------------------------------------ */

  function openGuide(from) {
    const e = lookup();
    if (!e) return;
    step = Math.min(Math.max(Number(from) || 0, 0), STEPS.length - 1);
    open = true;
    e.root.hidden = false;
    paint();
    if (e.next) e.next.focus();
  }

  function closeGuide() {
    const e = lookup();
    if (!e || e.root.hidden) return;
    e.root.hidden = true;
    open = false;
    markSeen();
  }

  function go(delta) {
    const next = step + delta;
    if (next < 0) return;
    if (next >= STEPS.length) {
      closeGuide();
      return;
    }
    step = next;
    paint();
  }

  /* ---- first open -------------------------------------------------------- */

  function screenIsBusy() {
    // `.tour` is the guided walkthrough (tour.js), which drives the tab router
    // itself and so arrives here the same way a person does — without this the
    // two walkthroughs would stack on each other.
    return !!document.querySelector(
      '.sheet:not([hidden]), .su-pop:not([hidden]), .tour:not([hidden])',
    );
  }

  /** Called by the tab router on every switch to the VR tab. */
  function maybeAutoOpen() {
    if (open || autoTimer || hasSeen()) return;
    let tries = AUTO_TRIES;

    const attempt = () => {
      autoTimer = null;
      if (open || hasSeen()) return;
      const e = lookup();
      if (!e || !e.view || e.view.getAttribute('data-active') !== 'true') return;
      if (document.visibilityState !== 'visible') return;
      if (screenIsBusy()) {
        tries -= 1;
        if (tries > 0) autoTimer = setTimeout(attempt, AUTO_RETRY_MS);
        return;
      }
      openGuide(0);
    };

    autoTimer = setTimeout(attempt, AUTO_DELAY_MS);
  }

  function cancelAutoOpen() {
    if (autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }
  }

  /* ---- wiring ------------------------------------------------------------ */

  function wire() {
    const e = lookup();
    if (!e) return;

    e.close.addEventListener('click', closeGuide);
    e.scrim.addEventListener('click', closeGuide);
    e.back.addEventListener('click', () => go(-1));
    e.next.addEventListener('click', () => go(1));

    const opener = document.querySelector('#vr-guide-open');
    if (opener) opener.addEventListener('click', () => openGuide(0));

    document.addEventListener('keydown', (ev) => {
      if (!open) return;
      if (ev.key === 'Escape') {
        closeGuide();
      } else if (ev.key === 'ArrowRight') {
        ev.preventDefault();
        go(1);
      } else if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        go(-1);
      }
    });
  }

  if (typeof document !== 'undefined') {
    wire();
    // The launch that OPENS on this tab (the last tab is remembered) runs the
    // router before this script is parsed, so its maybeAutoOpen() call was a
    // no-op. Offer the guide ourselves in that case.
    const view = document.querySelector('[data-view="vr"]');
    if (view && view.getAttribute('data-active') === 'true') maybeAutoOpen();
  }

  return {
    STEPS,
    GUIDE_VERSION,
    SEEN_KEY,
    open: openGuide,
    close: closeGuide,
    maybeAutoOpen,
    cancelAutoOpen,
    hasSeen,
  };
});
