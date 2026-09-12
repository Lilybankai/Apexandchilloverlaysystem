/**
 * review-guide.js — the Review tab explains itself, once.
 * -----------------------------------------------------------------------------
 * Same shape and same manners as setup-guide.js, streamer-guide.js and
 * team-guide.js: the first visit gets a short walkthrough, dismissing it in any
 * way counts as read, and "How it works" beside the title brings it back
 * deliberately. The seen flag is a renderer nicety in localStorage, never IPC.
 *
 * It exists for the same two reasons the Team guide does, plus one of its own:
 *
 *   1. The tab is new to people who already walked the first-run tour. They
 *      will never be offered the Review tour again — it is marked seen — so
 *      the page has to introduce itself the first time they open it.
 *   2. Two of the facts are PRECONDITIONS a tour pointing at buttons has
 *      nowhere to put: a lap only opens if Apex was running when it was
 *      driven, and the driven line only exists on laps recorded by a build
 *      that captures it. An older lap is not broken; it is older.
 *   3. Nothing here is uploaded and nothing needs an account. That is unusual
 *      enough among the tabs that it is worth saying out loud — a driver who
 *      assumes their session went to a server behaves differently about it.
 *
 * Classic script (window.APEX_REVIEW_GUIDE) + module.exports so the step
 * content can be asserted headlessly from scripts/test-tour.js.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_REVIEW_GUIDE = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** Bumping this re-offers the walkthrough to everyone, once. */
  const GUIDE_VERSION = '1';
  const SEEN_KEY = 'apex.review.guide.seen';

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
      id: 'sessions',
      icon: 'activity',
      title: 'Every session you have driven is already in here',
      lead: 'Apex has been writing a file for every lap since the day you installed it. This tab reads those files back — nothing is uploaded, nothing needs an account, and nothing is ever thrown away.',
      points: [
        'The rail on the left is one card per session: the circuit, the car, your best lap in it, how many laps and how many stints. Newest at the top.',
        'The box above it searches by track or by car, and the dropdown narrows to practice, qualifying or race.',
        'The strip across the top is your whole career on this PC — laps, distance, hours at the wheel, and the circuit you have driven most.',
        'Sessions land while you are in the sim, not while you are looking at this page, so opening the tab IS the refresh. Refresh at the top right is only there for a session driven with the window already open.',
      ],
    },
    {
      id: 'report',
      icon: 'trophy',
      title: 'What the session came to',
      lead: 'The report at the top of a session is the part a driver actually wants: not just the best lap, but how much was left in it.',
      points: [
        'Optimal lap is your own best sector 1, best sector 2 and best sector 3 added together — a lap you have already driven in pieces. Untapped is the gap between that and your real best, which is the time on the table before you change anything about the car.',
        'Consistency leads with the real spread in seconds, not a percentage. ±0.31 s is something you can go and work on; 84% is a score.',
        'Clean driving is the share of your laps that kept inside the limits and out of the pits. A lap that broke the rule still appears — with the reason printed on it — rather than quietly vanishing.',
        'Under the report: the lap-time chart, your best here over the last 30 days, and tyre wear lap by lap.',
      ],
    },
    {
      id: 'sheet',
      icon: 'list-ordered',
      title: 'Stints, and the lap sheet',
      lead: 'Every stint is a card you can open, holding its lap sheet and the tyres it ended on.',
      points: [
        'Purple is the session best and green a stint best, the way every timing screen in the sport has coloured them for thirty years. Amber is a lap with a real time that broke the clean rule.',
        'A row with the small trace mark on it has telemetry behind it. Click that row and the lap opens.',
        'The vs button at the end of a row makes that lap the reference for the whole session — every lap you open afterwards opens against it.',
        'Only laps you drove with Apex running have telemetry. An older session may have times and no traces; that is the lap being older, not the tab being broken.',
      ],
    },
    {
      id: 'lap',
      icon: 'trending-up',
      title: 'One lap, and the lap you are chasing',
      lead: 'Open a lap and you get speed, throttle and brake, gear and steering, all drawn against DISTANCE round the circuit rather than against time — so two laps line up at the same corner instead of drifting apart.',
      points: [
        'The leaderboard card on the session screen lists everyone’s best here. Press vs on a driver and they are pinned to this circuit: every lap you open at this track is laid over theirs, dashed, in each channel’s own colour, until you unpin them. The vs on your own sheet does the same with one of your laps. The delta band above them reads slower above the line, faster below.',
        'Move the mouse across the traces to read every value at that point of the road. Click to hold a point; drag across a section to zoom into it; scroll to zoom.',
        'The chips under the charts split the lap into stretches of about 500 m and say what each one cost or gained against the other lap. Red is where the time went. Click one and the charts and the map both go there.',
        'This is the point of the tab: getting from "I was 0.7 s slower" to "I was 0.18 s slower into turn 11".',
      ],
    },
    {
      id: 'map',
      icon: 'circuit',
      title: 'The circuit, seen from directly above',
      lead: 'The map is drawn in plan and to scale — both axes the same, so a metre is a metre whichever way the road is pointing. That is what lets you put two racing lines side by side and believe the gap between them.',
      points: [
        'With a lap to compare against, the two lines are coloured by PACE rather than by whose they are: green is the quicker of the two and red the slower. The line under the map says which one is yours, and so does the colour of the pill at the top naming the other lap. On its own, with nothing to compare against, your line is cyan.',
        'Each line carries its own car at the point of road you are reading. Move the cursor across the traces and both cars move with it, so you can see where the other lap was when you were here.',
        'The road is shaded by its elevation, pale for the high ground — so a climb is on the screen without a slab tilted at you.',
        'Click any part of the road and the map frames that corner, filling the panel, with the charts following. Once you are zoomed in you can drag the map to move along the lap, and the charts come with you. The ribbon under the charts is the whole lap, one block per stretch of road, so when you are zoomed in it shows which piece you are looking at.',
        'A scale bar sits in the corner and the whole circuit appears as a small outline once you are zoomed in, so you never lose where you are.',
        'The driven line only exists on laps recorded by a build that captures it. An older lap still opens — the car simply follows the centreline. "How it works" beside Refresh reopens this any time.',
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
    const root = $('#review-guide');
    if (!root) return null;
    els = {
      root,
      view: document.querySelector('[data-view="review"]'),
      scrim: $('#review-guide-scrim'),
      icon: $('#review-guide-icon'),
      title: $('#review-guide-title'),
      sub: $('#review-guide-sub'),
      body: $('#review-guide-body'),
      dots: $('#review-guide-dots'),
      back: $('#review-guide-back'),
      next: $('#review-guide-next'),
      close: $('#review-guide-close'),
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

  /** Called by the tab router on every switch to the Review tab. */
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

    const opener = document.querySelector('#review-guide-open');
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
