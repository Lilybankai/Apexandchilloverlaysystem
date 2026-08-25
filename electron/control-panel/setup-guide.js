/**
 * setup-guide.js — the Setups tab explains itself, once.
 * -----------------------------------------------------------------------------
 * The Setups tab is the densest screen in the app: a live two-way editor, an
 * engineer that stages changes rather than applying them, a library, and a
 * shared board of other people's tunes. Opened cold it looks like a wall of
 * sliders, and the two things most worth knowing about it are invisible —
 * that the sim is the one holding the car, and that nothing reaches that car
 * until Apply. So the first time a driver opens the tab, the tab says so.
 *
 * Shown ONCE, and only ever on the Setups tab — never on the Dashboard, where
 * it would be one more thing between someone and their overlays. (The panel
 * reopens on the last tab used, so a driver who left it on Setups does meet it
 * at launch; that is the same visit, just without the click.) Dismissing it in
 * any way (✕, scrim, Escape, Got it) counts as read: a walkthrough that comes
 * back after you closed it is a nag, and "How it works" beside the title is
 * always there to bring it back deliberately.
 *
 * The seen flag lives in localStorage next to the tab's other preferences
 * (apex.setup.3d, apex.setup.community.follow) rather than in the main
 * process's settings.json — it is a renderer nicety, not something the app
 * needs to know about itself, and it costs no IPC.
 *
 * Classic script (window.APEX_SETUP_GUIDE) + module.exports for the headless
 * tests, like setup-info.js. Everything DOM lives inside functions, so the
 * step content can be required and asserted with no browser at all.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_SETUP_GUIDE = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /**
   * Bumping this re-offers the walkthrough to everyone, once. Worth doing when
   * the tab gains something a driver could not find on their own; not worth
   * doing for wording.
   */
  const GUIDE_VERSION = '1';
  const SEEN_KEY = 'apex.setup.guide.seen';

  /**
   * The walkthrough waits for a quiet screen before opening itself, and it can
   * be kept waiting: on the launch that restores straight onto the Setups tab,
   * the What's New sheet is still an async IPC round-trip away from appearing,
   * so "nothing is open yet" is not the same as "nothing is coming". It
   * re-checks a few times and then gives up for this visit rather than landing
   * underneath something — two stacked modals is worse than either alone.
   */
  const AUTO_DELAY_MS = 700;
  const AUTO_RETRY_MS = 400;
  const AUTO_TRIES = 8; // ~3.5 s in total, then it waits for the next visit

  /**
   * The walkthrough itself. `icon` is a sprite id from icons.js (without the
   * `i-` prefix); `lead` is the one sentence that would do on its own, and the
   * points are what you would tell someone sitting next to you.
   */
  const STEPS = [
    {
      id: 'live',
      icon: 'sliders-horizontal',
      title: 'This is the car in the garage',
      lead: "Not a copy of it and not a file — the same setup Le Mans Ultimate is holding right now.",
      points: [
        'Move something here and the game’s own setup screen moves with it. Change something in the game and this page catches up within a second.',
        'It needs LMU running with a car in the garage. With the sim closed the page says so and waits.',
        'Every value is the sim’s own — the same names, the same steps, and the same limits your car actually has.',
      ],
    },
    {
      id: 'editor',
      icon: 'layout-grid',
      title: 'Six pages, every setting the car has',
      lead: 'The tabs across the top are the same six pages the game uses, in the same order.',
      points: [
        'A padlock means the ruleset fixes that value — shown so you know it is there, not so you can move it.',
        'Settings your car does not have never appear at all: an LMP2 never sees an ABS row.',
        'An amber dot marks anything that differs from the setup file you loaded — the same thing the game’s asterisk tells you.',
        'The ⓘ beside a row says what the part physically does and which way to turn it for which handling change.',
      ],
    },
    {
      id: 'engineer',
      icon: 'zap',
      title: 'Tell the engineer what you want the car to do',
      lead: 'The sliders on the right speak in intent — more front turn-in, more rear traction, softer over kerbs — and each moves a weighted set of real settings at once.',
      points: [
        'Nothing reaches the car while you drag. Affected rows preview old → new, and the counter says how much is staged.',
        'One Apply sends the lot; Revert forgets it. Settings the ruleset locks are skipped, and say so.',
        'If changes land on a page you are not looking at, that tab button glows amber until you apply or revert — a staged edit cannot hide behind the tab you happen to have open.',
      ],
    },
    {
      id: 'library',
      icon: 'database',
      title: 'Save a tune, and find it again',
      lead: '“Save current setup” writes the car exactly as the garage holds it — name it, tag it Race or Quali, give it a colour.',
      points: [
        'It files itself under the track and car it came from, so the filters are already right for wherever you are.',
        'Sort by your best clean lap on that track in that class — read live from your lap database, so the number never goes stale.',
        'Load stages the tune in the editor first: every row previews old → new, and nothing touches the car until you press Apply.',
        'Share hands you the raw .svm — save it as a file, or copy it straight into a Discord or WhatsApp message. Import brings one back in.',
      ],
    },
    {
      id: 'community',
      icon: 'users',
      title: 'The league’s setups, and yours',
      lead: 'The Community setups card lists every tune the league has published.',
      points: [
        'With the sim running it follows the car and track you are in — turn that off to browse anything.',
        'A download is written into LMU’s own setup folder for that track, so it appears in the game’s setup screen without a restart, and a copy is filed in your library.',
        'Publish any library entry with a note. The app suggests character chips read from the tune’s own numbers — Sharp turn-in, Stable & safe, Low drag — and you can change them before it goes up.',
        'Unpublish whenever you like. Your local files are never touched either way.',
      ],
    },
    {
      id: 'trust',
      icon: 'check',
      title: 'Stars you can trust, and where to find this again',
      lead: 'Every opinion on a shared setup is gated on having actually used it.',
      points: [
        'Only drivers who downloaded a setup can rate it, and never its author.',
        'The pace beside a setup is read from the lap database, never typed. A ✓ means that lap was driven on that exact setup; a dimmed time is the driver’s track best from before their app could prove it — shown, but not sworn to.',
        'That is the tab. “How it works” beside the Setups title reopens this any time.',
      ],
    },
  ];

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /* ---- state ------------------------------------------------------------- */

  let step = 0;
  let open = false;
  let autoTimer = null;
  let els = null; // looked up on first open — this file loads before the view is used

  /* ---- seen flag --------------------------------------------------------- */

  /**
   * With storage unavailable this reports "already seen": a walkthrough that
   * cannot remember being dismissed would open on every single visit to the
   * tab, which is far worse than never opening by itself.
   */
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
    const root = $('#setup-guide');
    if (!root) return null;
    els = {
      root,
      view: document.querySelector('[data-view="setups"]'),
      scrim: $('#setup-guide-scrim'),
      icon: $('#setup-guide-icon'),
      title: $('#setup-guide-title'),
      sub: $('#setup-guide-sub'),
      body: $('#setup-guide-body'),
      dots: $('#setup-guide-dots'),
      back: $('#setup-guide-back'),
      next: $('#setup-guide-next'),
      close: $('#setup-guide-close'),
    };
    return els;
  }

  /**
   * A sprite icon as an element tree rather than parsed markup — an svg with a
   * single use pointing at the sprite symbol for `name`. Written out longhand
   * because a quoted sprite selector in this file reads to the parity test as a
   * page id being looked up, and it would fail hunting for an element named
   * after the placeholder.
   */
  function iconEl(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  /** Paint the current step. Text nodes only — none of this comes from a file. */
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

    // The dots are a progress read, not a control — a six-step tour with
    // clickable dots invites hunting instead of reading.
    e.dots.textContent = '';
    for (let i = 0; i < STEPS.length; i += 1) {
      const dot = document.createElement('span');
      dot.className = 'su-guide__dot';
      dot.dataset.state = i === step ? 'now' : i < step ? 'done' : 'todo';
      e.dots.appendChild(dot);
    }

    e.back.disabled = step === 0;
    const last = step === STEPS.length - 1;
    e.next.textContent = last ? 'Got it' : 'Next';
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

  /** Closing IS reading it — see the header note. */
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

  /**
   * Another dialog already has the screen. The walkthrough is the least urgent
   * thing the panel can show, so it yields and tries again the next time the
   * tab is opened — it is not marked seen, so nothing is lost.
   */
  function screenIsBusy() {
    // `.tour` is the guided walkthrough (tour.js), which drives the tab router
    // itself and so ARRIVES here the same way a person does. Without this, a
    // tour reaching this tab trips the first-visit modal and the driver gets
    // two walkthroughs stacked on each other — seen, once, on the Setups tab.
    return !!document.querySelector(
      '.sheet:not([hidden]), .su-pop:not([hidden]), .tour:not([hidden])',
    );
  }

  /** Called by the editor's shown() on every switch to the tab. */
  function maybeAutoOpen() {
    if (open || autoTimer || hasSeen()) return;
    let tries = AUTO_TRIES;

    const attempt = () => {
      autoTimer = null;
      if (open || hasSeen()) return;
      const e = lookup();
      // The driver may have switched away while we waited; a modal arriving
      // over the Overlays tab would be baffling. Same for a minimised window.
      if (!e || !e.view || e.view.getAttribute('data-active') !== 'true') return;
      if (document.visibilityState !== 'visible') return;
      if (screenIsBusy()) {
        tries -= 1;
        if (tries > 0) autoTimer = setTimeout(attempt, AUTO_RETRY_MS);
        return; // not marked seen — the next visit tries again
      }
      openGuide(0);
    };

    autoTimer = setTimeout(attempt, AUTO_DELAY_MS);
  }

  /** The tab was left — drop a pending auto-open rather than firing it late. */
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

    const opener = document.querySelector('#setup-guide-open');
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
    // This script sits below the markup it wires (like setup-editor.js), so the
    // elements already exist; no DOMContentLoaded dance needed.
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
