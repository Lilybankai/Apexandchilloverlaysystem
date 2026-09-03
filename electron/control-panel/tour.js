/**
 * tour.js — the guided walkthrough: five tours, anchored to real controls.
 * -----------------------------------------------------------------------------
 * The checklist (onboarding.js) says WHAT is left to do and drops you on the
 * right card. This is the other half: it stands next to each control in turn
 * and says what it is for.
 *
 * The difference from the three `.su-guide` walkthroughs already in the app is
 * the anchor. Those are centred modals that describe a tab in the abstract —
 * good for "what is this page FOR", useless for "which of these two switches
 * is the OBS one". A tour step here points at the actual element: it cuts a
 * hole in a dimmed screen around that control and puts the explanation beside
 * it. Six of the things a new driver has to find (the per-card OBS toggle, the
 * in-game toggle beside it, the copy button, Apply, the staged count, the
 * push-to-talk chip) are three words on a control that is 30px wide, and no
 * amount of prose in a centred box makes them findable.
 *
 * THE PAGE STAYS LIVE. The dim is drawn by one element's enormous box-shadow
 * and that element is `pointer-events: none`, so a driver can actually press
 * the button being described while it is being described. A walkthrough you
 * have to close before you can do the thing is a slideshow.
 *
 * Six tours, one per section, in the order the checklist lists them:
 *
 *   settings  — the plugin, the sim's own controls, your own bindings
 *   overlays  — which overlays go where, and how one reaches OBS
 *   ingame    — the on-screen layer, the hotkey that cycles, laying it out
 *   engineer  — voice, push-to-talk, how much it volunteers
 *   setups    — the sim holds the car, nothing moves until Apply
 *   team      — the pit-wall board, and the three things a crew needs to feed it
 *
 * `runAll()` chains them, which is the "walk me through the whole app" the
 * checklist's own button offers.
 *
 * A step whose anchor is missing does not dead-end: the element may be hidden
 * behind a pane, absent on this build (beta-gated tabs), or not yet rendered
 * (the overlay cards are injected). The step falls back to a centred card and
 * says its piece anyway — a tour that stops halfway through with no
 * explanation is worse than one that occasionally cannot point.
 *
 * Classic script (window.APEX_TOUR) + module.exports, so TOURS can be required
 * and asserted with no browser — scripts/test-tour.js does that.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_TOUR = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** Bumping this re-offers every tour to everyone, once. */
  const TOUR_VERSION = '1';
  const SEEN_PREFIX = 'apex.tour.seen.';

  /** Room left around the ring, and between the ring and its callout. */
  const RING_PAD = 8;
  const GAP = 14;
  const EDGE = 16;
  /** How long to let a view swap settle before measuring the anchor. */
  const SETTLE_MS = 90;

  /**
   * The tours.
   *
   * `anchor` is a CSS selector for the control the step is about. Ids are
   * written with their `#` deliberately: the parity guard treats any bare
   * hash-prefixed string literal as an element being looked up, so a renamed
   * card fails the test suite instead of silently un-anchoring a step in front
   * of a new driver. (Which is also why this sentence spells that out in words
   * rather than showing one — the scanner reads comments too, and an example
   * here would be hunted for as a real element. It bit once already.)
   * Class selectors (the injected overlay cards) it ignores, which is correct —
   * those elements do not exist until the page renders them.
   *
   * `body` is what you would say standing behind someone's chair. Short: this
   * is read beside a highlighted control, not instead of it.
   */
  const TOURS = [
    {
      id: 'settings',
      title: 'Settings',
      icon: 'settings',
      blurb: 'The three things that have to be right before anything else works.',
      steps: [
        {
          id: 'plugin',
          view: 'settings',
          pane: 'general',
          anchor: '#plugin-card',
          title: 'Start here — the telemetry plugin',
          body:
            'Le Mans Ultimate publishes nothing on its own. Apex installs a small plugin into the ' +
            'game and switches it on for you. All three rows want a tick.',
          note:
            'If this is wrong, every overlay is simply blank and nothing anywhere says why — which ' +
            'is exactly why it is the first thing on this page.',
        },
        {
          id: 'plugin-runtime',
          view: 'settings',
          pane: 'general',
          anchor: '#plugin-checks',
          title: 'The row people get caught by',
          body:
            'Windows runtime. The plugin needs VC++ 2013, and without it LMU skips the plugin in ' +
            'silence while every file on disk looks perfect.',
          note: 'If it says MISSING, the button below fetches it. Restart the game afterwards.',
        },
        {
          id: 'lmu-controls',
          view: 'settings',
          pane: 'controls',
          anchor: '#lmu-controls-card',
          title: "Now let Apex press the sim's buttons",
          body:
            'Pit limiter, the MFD pages, fuel and tyre changes. Apex can only press what LMU has ' +
            'bound to a KEY — a wheel button cannot be pressed from outside the game.',
        },
        {
          id: 'lmu-apply',
          view: 'settings',
          pane: 'controls',
          anchor: '#lmu-bind-apply',
          title: 'One click does all of it',
          body:
            'It gives the missing controls keys taken from Japanese and Brazilian layouts — keys ' +
            'that do not exist on your keyboard, so nothing you, OBS or Discord already use can ' +
            'clash. Anything you had bound already is left alone.',
          note:
            'Close Le Mans Ultimate first. It rewrites its controls file from memory when it exits ' +
            'and would throw the change away.',
        },
        {
          id: 'bindings',
          view: 'settings',
          pane: 'controls',
          anchor: '#bindings-card',
          title: 'And now your own buttons',
          body:
            'These are the keys YOU press mid-stint: ask the engineer, call your last lap, show the ' +
            'gap ahead. They are global, so they fire while the sim has focus.',
        },
        {
          id: 'binding-row',
          view: 'settings',
          pane: 'controls',
          anchor: '#binding-list',
          title: 'Click to bind, then press the key',
          body:
            'Pick a key the sim does not already use — F13 to F24 are the usual choice, because no ' +
            'keyboard produces them. A bound key is consumed and will not also reach LMU.',
          note:
            'A Stream Deck button set to that key works too. There is no plugin and no device scan ' +
            '— it just sends a keystroke.',
        },
      ],
    },

    {
      id: 'overlays',
      title: 'Overlays',
      icon: 'monitor',
      blurb: 'Which widgets you want, and how they reach OBS or your screen.',
      steps: [
        {
          id: 'grid',
          view: 'overlays',
          // One card, not `.overlay-list`: the list is twenty cards tall and a
          // ring around all of it marks the whole screen, which marks nothing.
          anchor: '.ovcard:first-child',
          title: 'Every widget has a card',
          body:
            'They all start switched on. This page is where you turn off the ones you do not want ' +
            'and decide where each of the rest is allowed to appear.',
        },
        {
          id: 'destinations',
          view: 'overlays',
          anchor: '.ovcard:first-child .ovcard__foot',
          title: 'Two destinations, not one switch',
          body:
            'OBS puts this widget on its Browser-Source URL. In game draws it over the sim itself. ' +
            'They are independent — a widget can do both, either, or neither.',
        },
        {
          id: 'copy',
          view: 'overlays',
          anchor: '.ovcard:first-child .ovcard__url',
          title: 'This is the bit OBS needs',
          body:
            'Copy takes the widget’s URL. In OBS: + under Sources, Browser, paste it, set the ' +
            'size, OK. Where a widget needs a particular source size — the speedo cluster does — ' +
            'the card prints it under the URL, because OBS’s own default is too small for it. ' +
            'The eye beside it opens the same page in your browser so you can see it works.',
        },
        {
          id: 'opacity',
          view: 'overlays',
          anchor: '.ovcard:first-child',
          title: 'Per-widget look',
          body:
            'Each card also carries its own background opacity, and — for widgets that have more ' +
            'than one design, like the speedo — a design picker. Auto follows the global setting.',
        },
        {
          id: 'combined',
          view: 'overlays',
          anchor: '#combined-url',
          title: 'Or take the lot as one source',
          body:
            'The all-in-one page is every widget on a single 1920x1080 source at fixed positions. ' +
            'One Browser Source instead of a dozen, if you would rather not place them yourself.',
        },
      ],
    },

    {
      id: 'ingame',
      title: 'On-screen layer',
      icon: 'layout-grid',
      blurb: 'Overlays drawn over the sim, and how you move them without leaving the car.',
      steps: [
        {
          id: 'switch',
          view: 'dashboard',
          anchor: '#ingame-toggle',
          title: 'Show in game',
          body:
            'Draws the overlays over Le Mans Ultimate itself — no OBS involved. The sim has to be ' +
            'in Borderless or Windowed mode; exclusive fullscreen draws over everything.',
        },
        {
          id: 'auto',
          view: 'dashboard',
          anchor: '#ingame-auto-toggle',
          title: 'Auto show & hide',
          body:
            'With this on, the layer appears when you are actually at the wheel and hides on the ' +
            "sim's own screens — ESC, the garage, the setup pages — and between sessions.",
        },
        {
          id: 'hotkey',
          view: 'dashboard',
          anchor: '#ig-hotkey',
          title: 'One key does three things',
          body:
            'The overlay hotkey CYCLES: shown, off, edit layout, shown. That is how you get to edit ' +
            'mode without alt-tabbing back to this window mid-session.',
        },
        {
          id: 'edit',
          view: 'dashboard',
          anchor: '#ig-edit-btn',
          title: 'Edit layout — drag them where you want',
          body:
            'In edit mode every widget can be dragged and resized. On triple screens the layer ' +
            'covers all three, so a widget dragged onto a side monitor stays there.',
        },
        {
          id: 'dock',
          view: 'dashboard',
          anchor: '#ingame-dock-toggle',
          // Not in every build — see `optional` on the step reader below.
          optional: true,
          title: 'Magnetic docking',
          body:
            'While editing, a widget dragged near another snaps flush against it and takes its ' +
            'neighbour’s size along the shared edge, so a row comes out aligned instead of ' +
            'eyeballed. Hold Alt while dragging to place one freely.',
        },
      ],
    },

    {
      id: 'engineer',
      title: 'Race engineer',
      icon: 'mic',
      blurb: 'A voice on the radio that answers from your own telemetry.',
      steps: [
        {
          id: 'voices',
          view: 'engineer',
          anchor: '#eng-voices',
          title: 'Pick a voice and download it',
          body:
            'Sample plays a short clip of the raw voice. Download is one-off and the voice then ' +
            'lives on this PC — the engineer speaks with no internet connection at all.',
        },
        {
          id: 'toggle',
          view: 'engineer',
          anchor: '#eng-toggle',
          title: 'Then switch it on',
          body:
            'Off until you ask for it, because the feature spawns helper processes. The status line ' +
            'underneath always says exactly what is still missing, so a silent engineer is never a ' +
            'mystery.',
        },
        {
          id: 'ptt',
          view: 'engineer',
          anchor: '#eng-ptt-chip',
          title: 'Push-to-talk',
          body:
            'Bind a wheel button, hold it, ask your question out loud. Your voice is understood on ' +
            'this machine and never leaves it.',
          note:
            'You do not need a microphone at all for the common ones — the Call… rows in Settings ' +
            'speak your last lap, gaps, fuel and track-limit points off a key press.',
        },
        {
          id: 'readouts',
          view: 'engineer',
          anchor: '#eng-readouts',
          title: 'How much it volunteers',
          body:
            'Essential keeps the radio quiet and speaks when something matters. The chattier ' +
            'settings add per-lap colour. This is taste, and it is easy to change mid-season.',
        },
        {
          id: 'test',
          view: 'engineer',
          anchor: '#eng-radio-check',
          title: 'Check it before you need it',
          body:
            'Radio check speaks a test line through the whole chain — voice, radio effect, your ' +
            'speakers. Worth doing once now rather than discovering it on lap 1.',
        },
      ],
    },

    {
      id: 'setups',
      title: 'Setups',
      icon: 'sliders-horizontal',
      blurb: 'A live two-way editor for the car the sim is holding right now.',
      steps: [
        {
          id: 'status',
          view: 'setups',
          anchor: '#setup-status',
          title: 'The sim holds the car, not this page',
          body:
            'This reads OFFLINE until Le Mans Ultimate is running and you are in a session with a ' +
            'car. Everything on this tab is a live view of that car — there is no file to open.',
        },
        {
          id: 'rows',
          view: 'setups',
          anchor: '#setup-tabs',
          altAnchor: '#setup-offline',
          title: 'The same pages the sim has',
          body:
            'Suspension, aero, brakes, differential and the rest — each page holds the real values, ' +
            'in the real units, with the real limits the car allows.',
          note: 'They appear here once you are in a session — this panel is what shows until then.',
        },
        {
          id: 'staged',
          view: 'setups',
          anchor: '#setup-staged',
          altAnchor: '#setup-offline',
          title: 'Nothing reaches the car until Apply',
          body:
            'Drag a slider and the change is STAGED, not sent. The count here tells you how many ' +
            'are waiting. Apply sends them together; Revert throws them away.',
          note:
            'This is the single most important thing about this tab: it is deliberate, so you can ' +
            'plan a change in the pits and commit it in one go.',
        },
        {
          id: 'library',
          view: 'setups',
          anchor: '#setup-library',
          title: 'Your own library',
          body:
            'Save the current setup with a name, and load it back on the same car and track later. ' +
            'Import and export move them between PCs, or to a team-mate.',
        },
        {
          id: 'community',
          view: 'setups',
          anchor: '#setup-community',
          title: 'And everyone else’s',
          body:
            'Setups other drivers have published, filtered by track, car and class. Download one ' +
            'and it lands in your library, where you can rate it — the ratings come from people ' +
            'who actually downloaded it.',
        },
      ],
    },
    {
      id: 'team',
      title: 'Team',
      icon: 'users',
      blurb: 'The pit wall: one board of live widgets, and the crew who feed it.',
      steps: [
        {
          id: 'board',
          view: 'team',
          anchor: '#team-dash',
          optional: true,
          gate: '[data-tab="team"]',
          title: 'The whole race on one board',
          body:
            'Timing, the track map, fuel and energy, the plan to the flag, tyres, brakes, weather, ' +
            'position changes and lap times — all on screen together. Drag a widget by its title ' +
            'bar to move it, or by its bottom-right corner to resize it; everything else slides out ' +
            'of the way and closes the gap behind it.',
          note: 'Your arrangement is saved on this PC and comes back next race.',
        },
        {
          id: 'presets',
          view: 'team',
          anchor: '#team-board-toggle',
          optional: true,
          gate: '[data-tab="team"]',
          title: 'Board — layouts, and what is on the wall',
          body:
            'Three ready-made boards to start from — Engineer, Strategist and Car — plus a ' +
            'switch for every widget. Turn off what you do not want this race and it is not drawn ' +
            'at all. Reset board puts it back the way it shipped.',
        },
        {
          id: 'crew',
          view: 'team',
          anchor: '#team-crew-toggle',
          optional: true,
          gate: '[data-tab="team"]',
          title: 'Crew — how team-mates get added',
          body:
            'One person creates the team and Apex issues a single invite code, like a Discord ' +
            'invite. Share invite copies a whole message — download link, sign-up step and code ' +
            '— to paste into your team chat; everyone else opens this tab and uses Join with a code.',
          note: 'Up to six seats. The owner can issue a new code or remove someone at any time.',
        },
        {
          id: 'seats',
          view: 'team',
          anchor: '#team-crew',
          optional: true,
          gate: '[data-tab="team"]',
          title: 'Everyone needs their own subscription',
          body:
            'There is no watcher seat. Each team-mate signs in with their own active Apex ' +
            'subscription — someone without one cannot join the team, and cannot be seen from ' +
            'the pit wall.',
        },
        {
          id: 'relay',
          view: 'team',
          anchor: '#team-source',
          optional: true,
          gate: '[data-tab="team"]',
          title: 'And has to be running Apex while they drive',
          body:
            'Tyres, fuel, energy and damage exist only on the PC of whoever is in the car — the ' +
            'sim never publishes them to anyone else. So the driver keeps Apex running with their ' +
            'overlays during the race, and their own app relays those numbers to the rest of you.',
          note:
            'Nothing is handed over at a driver swap: Apex follows whichever team-mate has live ' +
            'tyre data, so the board switches car on its own.',
        },
        {
          id: 'age',
          view: 'team',
          anchor: '#team-age',
          optional: true,
          gate: '[data-tab="team"]',
          title: 'Always check the age',
          body:
            'LIVE while frames are arriving, STALE with the seconds since the last one, DEMO when ' +
            'the numbers are simulated. A screen full of confident-looking old numbers is the ' +
            'dangerous failure, so this pill never lets one hide.',
        },
      ],
    },
  ];

  /* ---- pure helpers ------------------------------------------------------- */

  /** One tour by id, or null. Exported: the checklist looks tours up by name. */
  function tourById(id) {
    return TOURS.find((t) => t.id === id) || null;
  }

  /** Every step across every tour, in order — what runAll() walks. */
  function allSteps() {
    return TOURS.flatMap((t) => t.steps.map((s) => ({ ...s, tour: t.id })));
  }

  /**
   * Drop steps whose feature is not in this build.
   *
   * Not every control exists in every package. Some features are gated to the
   * beta channel, and a stable release is cut from an older tag, so a step
   * written against `main` can describe something the running build simply
   * does not have. The fallback for a missing anchor is a centred card that
   * says its piece anyway — which is right for a control that is merely
   * hidden, and exactly wrong here: it would explain a feature to someone who
   * has no way to use it, and then it would not be there when they looked.
   *
   * So a step marked `optional` has to find its anchor in the document or it
   * is not part of the tour at all. Presence, not visibility — the element may
   * legitimately be on another tab when the tour starts.
   */
  function usableSteps(list) {
    if (typeof document === 'undefined') return list;
    return list.filter((s) => {
      if (!s.optional || !s.anchor) return true;
      try {
        if (!document.querySelector(s.anchor)) return false;
        // `gate` is the beta-channel case, and it is the one place presence is
        // not enough. The Team tab's markup is in every build; what decides
        // whether a driver can reach it is the nav button's `hidden`. A step
        // whose gate is hidden would otherwise walk someone to a tab that
        // cannot be opened, which is exactly what `optional` exists to prevent.
        if (s.gate) {
          const el = document.querySelector(s.gate);
          if (!el || el.hidden) return false;
        }
        return true;
      } catch {
        return false;
      }
    });
  }

  function seenKey(id) {
    return `${SEEN_PREFIX}${id}`;
  }

  function hasSeen(id) {
    try {
      return localStorage.getItem(seenKey(id)) === TOUR_VERSION;
    } catch {
      return true;
    }
  }

  function markSeen(id) {
    try {
      localStorage.setItem(seenKey(id), TOUR_VERSION);
    } catch {
      /* storage disabled — it just offers itself again */
    }
  }

  /* ---- state -------------------------------------------------------------- */

  const SVG_NS = 'http://www.w3.org/2000/svg';

  let els = null;
  let steps = [];
  let at = 0;
  let running = false;
  let trackTimer = null;

  function lookup() {
    if (els) return els;
    const root = document.getElementById('tour');
    if (!root) return null;
    els = {
      root,
      ring: document.getElementById('tour-ring'),
      pop: document.getElementById('tour-pop'),
      icon: document.getElementById('tour-icon'),
      section: document.getElementById('tour-section'),
      count: document.getElementById('tour-count'),
      title: document.getElementById('tour-title'),
      body: document.getElementById('tour-body'),
      note: document.getElementById('tour-note'),
      back: document.getElementById('tour-back'),
      next: document.getElementById('tour-next'),
      skip: document.getElementById('tour-skip'),
    };
    return els;
  }

  function iconEl(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  /* ---- placing the ring and the callout ----------------------------------- */

  /**
   * Put the ring over `el` and the callout beside it.
   *
   * The ring is a plain box at the element's viewport rect; the dimming is its
   * own outward box-shadow, which is why one element makes the whole spotlight
   * and why nothing has to be layered behind the page. With no element to
   * point at, the ring is hidden and the callout goes to the middle — the step
   * still gets said.
   */
  function place(el) {
    const e = lookup();
    if (!e) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (!el) {
      // No ring means no spotlight, so the container paints the dim itself —
      // otherwise the callout floats over a fully lit page and reads as a
      // stray dialog rather than part of the walkthrough.
      e.ring.hidden = true;
      e.root.dataset.dim = 'true';
      e.pop.dataset.placement = 'center';
      e.pop.style.left = `${Math.round((vw - e.pop.offsetWidth) / 2)}px`;
      e.pop.style.top = `${Math.round((vh - e.pop.offsetHeight) / 2)}px`;
      return;
    }

    const raw = el.getBoundingClientRect();

    /*
     * Clamp the ring to the viewport.
     *
     * Some anchors are containers taller than the window — the overlay grid is
     * 1500px of cards. Ringing the whole thing puts the outline off both ends
     * of the screen, which highlights nothing and leaves the callout nowhere
     * to go. Clamped, the ring marks the part you can actually see, which is
     * the part the sentence is about.
     */
    const r = {
      left: Math.max(EDGE, raw.left),
      top: Math.max(EDGE, raw.top),
      right: Math.min(vw - EDGE, raw.right),
      bottom: Math.min(vh - EDGE, raw.bottom),
    };
    r.width = Math.max(0, r.right - r.left);
    r.height = Math.max(0, r.bottom - r.top);

    e.ring.hidden = false;
    e.root.dataset.dim = 'false';
    e.ring.style.left = `${Math.round(r.left - RING_PAD)}px`;
    e.ring.style.top = `${Math.round(r.top - RING_PAD)}px`;
    e.ring.style.width = `${Math.round(r.width + RING_PAD * 2)}px`;
    e.ring.style.height = `${Math.round(r.height + RING_PAD * 2)}px`;

    const pw = e.pop.offsetWidth;
    const ph = e.pop.offsetHeight;

    /*
     * Where the callout goes. Below by preference, then above, then to
     * whichever side has room — and the fallback is checked rather than
     * assumed, because the one thing that must never happen is the callout
     * covering the control it is pointing at. A tall anchor low on the screen
     * used to produce exactly that: no room below, not quite enough above, and
     * a "beside" that was still vertically on top of the ring.
     */
    const clampX = (x) => Math.max(EDGE, Math.min(vw - pw - EDGE, x));
    const clampY = (y) => Math.max(EDGE, Math.min(vh - ph - EDGE, y));
    const centredX = clampX(r.left + r.width / 2 - pw / 2);
    const centredY = clampY(r.top + r.height / 2 - ph / 2);

    const options = [
      { placement: 'below', left: centredX, top: r.bottom + RING_PAD + GAP },
      { placement: 'above', left: centredX, top: r.top - RING_PAD - GAP - ph },
      { placement: 'beside', left: r.left - RING_PAD - GAP - pw, top: centredY },
      { placement: 'beside', left: r.right + RING_PAD + GAP, top: centredY },
    ];

    const fits = (o) =>
      o.left >= EDGE &&
      o.top >= EDGE &&
      o.left + pw <= vw - EDGE &&
      o.top + ph <= vh - EDGE &&
      // And genuinely clear of the ring, not merely on the preferred side.
      (o.left + pw < r.left - RING_PAD ||
        o.left > r.right + RING_PAD ||
        o.top + ph < r.top - RING_PAD ||
        o.top > r.bottom + RING_PAD);

    // Nothing clear anywhere (a ring filling the screen): sit it in the corner
    // with the most room rather than dead centre on top of everything.
    const corner = {
      placement: 'beside',
      left: r.left > vw - r.right ? EDGE : vw - pw - EDGE,
      top: r.top > vh - r.bottom ? EDGE : vh - ph - EDGE,
    };
    const chosen = options.find(fits) || corner;

    e.pop.dataset.placement = chosen.placement;
    e.pop.style.left = `${Math.round(clampX(chosen.left))}px`;
    e.pop.style.top = `${Math.round(clampY(chosen.top))}px`;
  }

  /** One selector, or null when it matches nothing with a size on screen. */
  function visible(selector) {
    if (!selector) return null;
    let el = null;
    try {
      el = document.querySelector(selector);
    } catch {
      return null;
    }
    if (!el) return null;
    // Rendered but collapsed (a hidden pane, an empty injected list) cannot be
    // pointed at meaningfully — treat it as absent.
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return el;
  }

  /**
   * The element a step points at.
   *
   * `altAnchor` is the fallback for controls that only exist in one state of
   * the app. The Setups tab is the case that forced it: its pages and its
   * staged-changes bar live inside a body that is hidden until the sim is
   * running with a car, and doing the walkthrough BEFORE launching the game is
   * the normal way round. Without a fallback, three of that tour's five steps
   * pointed at nothing on a perfectly healthy machine.
   */
  function anchorFor(step) {
    return visible(step.anchor) || visible(step.altAnchor);
  }

  /* ---- painting ----------------------------------------------------------- */

  function paint() {
    const e = lookup();
    if (!e) return;
    const step = steps[at];
    if (!step) return;

    const tour = tourById(step.tour) || {};

    e.icon.textContent = '';
    e.icon.appendChild(iconEl(tour.icon || 'info'));
    e.section.textContent = tour.title || '';
    e.count.textContent = `${at + 1} of ${steps.length}`;
    e.title.textContent = step.title;
    e.body.textContent = step.body;
    e.note.textContent = step.note || '';
    e.note.hidden = !step.note;

    e.back.disabled = at === 0;
    e.next.textContent = at === steps.length - 1 ? 'Finish' : 'Next';

    // Navigate first, then measure: the anchor may live on another tab.
    const nav = window.apexNav;
    if (step.view && nav && typeof nav.showView === 'function') nav.showView(step.view);
    if (step.pane && nav && typeof nav.showSettingsPane === 'function') {
      nav.showSettingsPane(step.pane);
    }

    setTimeout(() => {
      const el = anchorFor(step);
      if (el) {
        // `nearest` rather than `center`: a control already in view should not
        // jump the page under someone mid-sentence.
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      // Let the smooth scroll settle before the ring is measured, or it lands
      // where the element WAS.
      setTimeout(() => place(anchorFor(step)), 260);
    }, SETTLE_MS);
  }

  /**
   * Keep the ring on its element while the page moves under it. Cheap enough
   * to run on a timer as well as on scroll/resize: a card can also change size
   * on its own (the plugin card re-renders when its check comes back), and no
   * event fires for that.
   */
  function startTracking() {
    stopTracking();
    const step = () => place(anchorFor(steps[at] || {}));
    window.addEventListener('scroll', step, true);
    window.addEventListener('resize', step);
    trackTimer = setInterval(step, 400);
    els._untrack = () => {
      window.removeEventListener('scroll', step, true);
      window.removeEventListener('resize', step);
    };
  }

  function stopTracking() {
    if (trackTimer) clearInterval(trackTimer);
    trackTimer = null;
    if (els && els._untrack) {
      els._untrack();
      els._untrack = null;
    }
  }

  /* ---- running ------------------------------------------------------------ */

  /**
   * Start a tour by id, or every tour end to end with 'all'. Marks the tour
   * seen on START, not on finish: someone who walks two steps in and closes it
   * has made a decision, and re-offering it next visit would be a nag.
   */
  function start(id) {
    const e = lookup();
    if (!e) return;
    if (id === 'all') {
      steps = usableSteps(allSteps());
      for (const t of TOURS) markSeen(t.id);
    } else {
      const tour = tourById(id);
      if (!tour) return;
      steps = usableSteps(tour.steps.map((s) => ({ ...s, tour: tour.id })));
      markSeen(tour.id);
    }
    if (!steps.length) return;

    /*
     * Clear the way. The three per-tab modal walkthroughs offer themselves on
     * a first visit, and a tour drives the tab router itself — so it arrives
     * at Setups and Streamers exactly the way a person does and trips them.
     * Their own screenIsBusy() now treats an open tour as busy, which stops
     * one being scheduled; this closes one that is already up, and drops any
     * pending timer, so a tour never starts underneath a modal.
     */
    for (const name of [
      'APEX_SETUP_GUIDE', 'APEX_STREAMER_GUIDE', 'APEX_BINDINGS_GUIDE', 'APEX_TEAM_GUIDE',
    ]) {
      const guide = window[name];
      guide?.cancelAutoOpen?.();
      guide?.close?.();
    }

    at = 0;
    running = true;
    e.root.hidden = false;
    paint();
    startTracking();
    e.next.focus();
  }

  function stop() {
    const e = lookup();
    if (!e || e.root.hidden) return;
    stopTracking();
    e.root.hidden = true;
    running = false;
    // The checklist's ticks may well have moved during the tour — the whole
    // point is that the driver did the things.
    window.APEX_ONBOARDING?.refresh();
  }

  function go(delta) {
    const next = at + delta;
    if (next < 0) return;
    if (next >= steps.length) {
      stop();
      return;
    }
    at = next;
    paint();
  }

  /* ---- wiring ------------------------------------------------------------- */

  function wire() {
    const e = lookup();
    if (!e) return;
    e.back.addEventListener('click', () => go(-1));
    e.next.addEventListener('click', () => go(1));
    e.skip.addEventListener('click', stop);
    document.addEventListener('keydown', (ev) => {
      if (!running) return;
      if (ev.key === 'Escape') {
        stop();
      } else if (ev.key === 'ArrowRight') {
        ev.preventDefault();
        go(1);
      } else if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        go(-1);
      }
    });
  }

  if (typeof document !== 'undefined') wire();

  return {
    TOURS,
    TOUR_VERSION,
    SEEN_PREFIX,
    tourById,
    allSteps,
    usableSteps,
    hasSeen,
    markSeen,
    start,
    stop,
    isRunning: () => running,
  };
});
