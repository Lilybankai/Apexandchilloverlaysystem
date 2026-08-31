/**
 * team-guide.js — the Team tab explains itself, once.
 * -----------------------------------------------------------------------------
 * Same shape and same manners as setup-guide.js and streamer-guide.js: the
 * first visit gets a short walkthrough, dismissing it in any way counts as
 * read, and "How it works" beside the title brings it back deliberately. The
 * seen flag is a renderer nicety in localStorage, never IPC.
 *
 * It exists for two reasons the tour cannot cover on its own:
 *
 *   1. The board is new to people who already walked the first-run tour. They
 *      will never see the Team tour again — it is marked seen — so the page
 *      has to introduce itself the first time they open it.
 *   2. Three of the facts a team needs are PRECONDITIONS, not controls, and a
 *      tour that points at buttons has nowhere to put them: every teammate
 *      needs their own subscription, every teammate has to be running Apex
 *      while they drive, and the pit wall only sees a car whose driver's own
 *      app is publishing. Nothing on screen can say that — the failure looks
 *      identical to "no telemetry yet".
 *
 * Classic script (window.APEX_TEAM_GUIDE) + module.exports so the step content
 * can be asserted headlessly from scripts/test-tour.js.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_TEAM_GUIDE = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** Bumping this re-offers the walkthrough to everyone, once. */
  const GUIDE_VERSION = '1';
  const SEEN_KEY = 'apex.team.guide.seen';

  const AUTO_DELAY_MS = 700;
  const AUTO_RETRY_MS = 400;
  const AUTO_TRIES = 8;

  /**
   * The walkthrough. `icon` is a sprite id from icons.js (no `i-` prefix);
   * `lead` is the sentence that would do on its own; the points are what you
   * would tell an engineer sitting next to you.
   */
  const STEPS = [
    {
      id: 'board',
      icon: 'layout-grid',
      title: 'One board, arranged the way you want it',
      lead: 'Everything the car is doing is on this screen at once — timing, the track map, fuel and energy, the plan to the flag, tyres, brakes, weather, position changes and lap times. Nothing is behind a tab.',
      points: [
        'Drag a widget by its title bar to move it. The others slide out of the way and close the gap behind it, so the board never ends up with a hole in the middle.',
        'Drag the bottom-right corner to resize. The charts, the map and the timing sheet all redraw at whatever size you give them — make the one you are living in this race the big one.',
        'Arrow keys nudge a widget once its title bar has focus; hold shift and the arrows resize it instead.',
        'Your arrangement is saved on this PC and comes back next race.',
      ],
    },
    {
      id: 'widgets',
      icon: 'sliders-horizontal',
      title: 'Board — presets, and what is on the wall',
      lead: 'The Board button holds three ready-made layouts and a switch for every widget.',
      points: [
        'Engineer leads with the full timing sheet. Strategist puts fuel, stints and the plan to the flag across the top. Car gives the map, tyres, brakes and weather the space instead. Start from whichever is closest and move things from there.',
        'Switch off anything you do not want this race — a widget that is off the board is not drawn at all, so it costs nothing.',
        'The ✕ on a widget title bar takes it off without opening the menu; the Board menu puts it back.',
        'Reset board puts everything back the way it shipped.',
      ],
    },
    {
      id: 'crew',
      icon: 'users',
      title: 'Your crew — adding the rest of the team',
      lead: 'The Crew button is where a team is made. One person creates it; everyone else joins with a code.',
      points: [
        'Create a team, give it a name, and Apex issues one invite code that looks like APX-XXXXXX. It stays the same until you replace it, exactly like a Discord invite.',
        'Copy code hands over just the code. Share invite copies a whole message — the download link, the sign-up step and the code — which is the one to paste into your team chat.',
        'Your teammates install Apex, make their own account, open the Team tab and use Join with a code.',
        'A team holds up to six seats. The owner can issue a New code (which retires the old one) and remove anyone from the roster.',
      ],
    },
    {
      id: 'requirements',
      icon: 'shield',
      title: 'What the pit wall needs from everyone',
      lead: 'This is the part nothing on screen can tell you, because a team set up wrong looks exactly like a session that has not started: the page simply stays empty.',
      points: [
        'Every teammate needs their own active Apex subscription and needs to be signed in. There is no watcher seat — a driver who is not subscribed cannot join the team and cannot be seen from the pit wall.',
        'Whoever is driving has to be running Apex on their own PC during the race, with the overlays going. Tyres, fuel, energy and damage exist only on the driving PC — the sim never publishes them to anyone else — so the driver’s own app is what relays them to you.',
        'Nothing has to be handed over at a driver swap. Apex follows whichever teammate is actually in the car, because that is the only machine with live tyre data, and the board switches over on its own.',
        'If a teammate closes Apex mid-stint, the pit wall stops updating for that car until they open it again.',
      ],
    },
    {
      id: 'watching',
      icon: 'monitor',
      title: 'Whose car you are watching, and how fresh it is',
      lead: 'Two controls in the header strip answer the two questions an engineer asks before trusting a number.',
      points: [
        'My car / Team switches the whole board between your own telemetry and the teammate who is currently driving. Every widget follows the switch — it is the same page, fed from somewhere else.',
        'The pill beside it is the data age: LIVE while frames are arriving, STALE with the number of seconds since the last one, DEMO when the figures are simulated. A confident-looking screen showing old numbers is the dangerous failure, so the page always wears its age.',
        'The header also carries the circuit, the flag, the race clock, the lap and the field size — the things you shout across the garage.',
        'That is the tab. "How it works" beside the header reopens this any time.',
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
    const root = $('#team-guide');
    if (!root) return null;
    els = {
      root,
      view: document.querySelector('[data-view="team"]'),
      scrim: $('#team-guide-scrim'),
      icon: $('#team-guide-icon'),
      title: $('#team-guide-title'),
      sub: $('#team-guide-sub'),
      body: $('#team-guide-body'),
      dots: $('#team-guide-dots'),
      back: $('#team-guide-back'),
      next: $('#team-guide-next'),
      close: $('#team-guide-close'),
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
    // itself and so ARRIVES here the same way a person does. Without this, a
    // tour reaching this tab trips the first-visit modal and the driver gets
    // two walkthroughs stacked on each other.
    return !!document.querySelector(
      '.sheet:not([hidden]), .su-pop:not([hidden]), .tour:not([hidden])',
    );
  }

  /** Called by the tab router on every switch to the Team tab. */
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

    const opener = document.querySelector('#team-guide-open');
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
