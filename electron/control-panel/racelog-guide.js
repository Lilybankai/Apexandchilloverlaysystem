/**
 * racelog-guide.js — the Race log tab explains itself, once.
 * -----------------------------------------------------------------------------
 * Same shape and same manners as review-guide.js and vr-guide.js: the first
 * visit gets a short walkthrough, dismissing it in any way counts as read, and
 * "How it works" beside Refresh brings it back deliberately. The seen flag is
 * a renderer nicety in localStorage, never IPC.
 *
 * It was the last step of the Review guide until the race log became a tab of
 * its own (2026-09-30). What it has to say that the page cannot:
 *
 *   1. WHERE THE RACES COME FROM. The game's own results files, so races from
 *      before Apex are here too — and a race the game never saved is not.
 *   2. THE REPLAY'S PRECONDITIONS. The game at its main menu, a wait of up to
 *      a minute for a big replay, and only five replays kept per circuit. None
 *      of that is visible until a click fails.
 *   3. THE KEYS. Going through a race's incidents is the job the tab exists
 *      for, and the fast way through it is invisible unless someone says so.
 *
 * Classic script (window.APEX_RACELOG_GUIDE) + module.exports so the step
 * content can be asserted headlessly from scripts/test-tour.js.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_RACELOG_GUIDE = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** Bumping this re-offers the walkthrough to everyone, once. */
  const GUIDE_VERSION = '1';
  const SEEN_KEY = 'apex.racelog.guide.seen';

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
      icon: 'scroll-text',
      title: 'Every race, read back as a timeline',
      lead: 'Le Mans Ultimate saves a results file after every race it finishes. This tab reads those files back, so every race on this PC is here, including the ones driven before Apex was installed.',
      points: [
        'Open one and it reads down the page in order: the start, every lap, places gained and lost, each contact naming the other car, damage, track limits, penalties, pit stops and driver swaps.',
        'Contacts and penalties are red, limits and minor damage amber. Lap times are purple for a class best and green for a personal best, as on the lap sheet.',
        'The line under the facts is your place lap by lap, from the grid to the flag, overall and in class.',
        'The filters narrow the timeline. Incidents shows what a steward would read; Apex remembers the one you last used.',
      ],
    },
    {
      id: 'yours',
      icon: 'users',
      title: 'Which car was yours?',
      lead: 'Apex matches a race to your car from your lap log, or failing that your driver name. In a team race you may not have driven the car at all, so it can be left unsure.',
      points: [
        'When it cannot tell, the race opens on “Which car was yours?” with the whole field. Pick your car once and it is remembered for that race.',
        'Picked the wrong one, or a teammate drove the car it chose? “Not your car?” under the facts asks again.',
        'A race session in Review that has a log carries a Race log button in its header. It opens that race here.',
      ],
    },
    {
      id: 'replay',
      icon: 'video',
      title: 'Replay, from the game’s own recording',
      lead: 'Replay on a contact, a limits call, damage or a penalty loads the game’s own replay of that race, with the camera on your car, 5 s before the moment.',
      points: [
        'The game has to be at its main menu. From inside a session Apex will not pull you out of it, and says so.',
        'A big replay takes up to a minute to load. After that, every other Replay in the same race is a jump, not a reload.',
        'The game keeps five replays per circuit and deletes the oldest. A greyed Replay button says why when you hover over it: the replay is gone, or the game is not running.',
      ],
    },
    {
      id: 'steward',
      icon: 'keyboard',
      title: 'Going through the incidents',
      lead: 'Once a replay is in the game, Previous and Next in the replay strip step through the incidents one after another, each replayed in turn. The row being replayed stays marked and on screen.',
      points: [
        '↑ and ↓, or J and K, move a row cursor down the timeline. Enter replays the row the cursor is on.',
        '[ and ] step to the previous and next incident, the same as the buttons.',
        'The steps follow the filter. On Contacts, Next is the next contact; on Limits & penalties, the next call from race control.',
      ],
    },
    {
      id: 'copy',
      icon: 'copy',
      title: 'Copy as text',
      lead: 'Copy as text puts the lines on screen on the clipboard as plain text, headed with the circuit, the date and your car, ready for a protest or a league post.',
      points: [
        'It copies what the filter shows, so filter to Incidents first for a steward’s version.',
        'Refresh re-reads the game’s results after a race finished with this window open. Press “How it works” to open this guide again.',
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
    const root = $('#racelog-guide');
    if (!root) return null;
    els = {
      root,
      view: document.querySelector('[data-view="racelog"]'),
      scrim: $('#racelog-guide-scrim'),
      icon: $('#racelog-guide-icon'),
      title: $('#racelog-guide-title'),
      sub: $('#racelog-guide-sub'),
      body: $('#racelog-guide-body'),
      dots: $('#racelog-guide-dots'),
      back: $('#racelog-guide-back'),
      next: $('#racelog-guide-next'),
      close: $('#racelog-guide-close'),
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

  /** Called by the tab router on every switch to the Race log tab. */
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

    const opener = document.querySelector('#racelog-guide-open');
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
    const view = document.querySelector('[data-view="racelog"]');
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
