/**
 * streamer-guide.js — the Streamers tab explains itself, once.
 * -----------------------------------------------------------------------------
 * Same shape (and same manners) as setup-guide.js: the Streamers tab is a
 * six-pane feature whose two most important facts are invisible — that the bot
 * types AS the streamer's own account, and that it only speaks while the app
 * is running. So the first visit gets a short walkthrough, dismissing it in
 * any way counts as read, and "How it works" beside the title brings it back
 * deliberately. The seen flag is a renderer nicety in localStorage, never IPC.
 *
 * Classic script (window.APEX_STREAMER_GUIDE) + module.exports so the step
 * content can be asserted headlessly from scripts/test-streambot.js.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_STREAMER_GUIDE = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** Bumping this re-offers the walkthrough to everyone, once. */
  const GUIDE_VERSION = '1';
  const SEEN_KEY = 'apex.streamers.guide.seen';

  const AUTO_DELAY_MS = 700;
  const AUTO_RETRY_MS = 400;
  const AUTO_TRIES = 8;

  /**
   * The walkthrough. `icon` is a sprite id from icons.js (no `i-` prefix);
   * `lead` is the sentence that would do on its own; the points are what you
   * would tell a streamer sitting next to you.
   */
  const STEPS = [
    {
      id: 'link',
      icon: 'user',
      title: 'Link your accounts, once',
      lead: 'Everything here runs through your own Twitch and YouTube accounts — the bot types as you, so there is no separate bot account to invite or trust.',
      points: [
        'Twitch channel: just type your channel name — reading chat needs no sign-in at all.',
        'Link Twitch… is what lets the bot TYPE. It shows a short code, opens twitch.tv/activate, and you enter the code there — no password ever touches this app, and your login stays on this PC.',
        'Link YouTube… opens a normal Google sign-in in your browser. If you linked before the bot existed, a "relink" note appears — the old sign-in was read-only, and one fresh sign-in lets the bot reply.',
        'Unlink either one at any time. Reading your Twitch chat keeps working even with no accounts linked.',
      ],
    },
    {
      id: 'bot',
      icon: 'zap',
      title: 'Turn the bot on — and know when it speaks',
      lead: 'Three switches on the Accounts pane: the master Bot enabled switch, and one per platform.',
      points: [
        'The bot runs while this app is open — close the app and it goes quiet with you.',
        'Twitch works any time, live or not. YouTube only has a chat while you are actually live, so the bot speaks there during a broadcast.',
        'The status line under the switch tells you exactly what is missing — "link your account to speak", "waiting for a live stream" — so a silent bot is never a mystery.',
        'YouTube usage is a simple tally of what the bot has posted there. It is information, not a limit — the optional caps below it stay at 0 (off) unless you want the bot to pace itself.',
      ],
    },
    {
      id: 'overlay',
      icon: 'message-circle',
      title: 'Put your chat on screen',
      lead: 'The Chat overlay pane holds the Stream Chat widget — both platforms merged into one clean feed, subs and Super Chats included.',
      points: [
        'OBS: copy the widget URL and add it as a Browser Source. It styles itself for capture — transparent background, readable at stream size.',
        'In game: flip the In game switch to see chat inside the sim on the transparent overlay layer — handy on a triple-screen rig.',
        'It reads through your linked accounts, so it works the moment the Accounts pane shows connected.',
      ],
    },
    {
      id: 'commands',
      icon: 'keyboard',
      title: '!commands — ask and the bot answers',
      lead: 'A viewer types !discord, the bot posts your reply. Add as many as you like.',
      points: [
        'Command is the word after the ! — typed in any capitalisation, matched all the same.',
        'Reply is exactly what the bot posts. Links are fine.',
        'Cooldown (seconds) is how long the bot ignores repeats of that command, so a busy chat cannot turn one command into spam.',
        'The On tick disables a command without deleting it. And yes — you can trigger your own commands from your own account.',
      ],
    },
    {
      id: 'timers',
      icon: 'clock',
      title: 'Timed messages — your regulars, on schedule',
      lead: 'Socials, the Discord invite, a sponsor shout — posted for you every so many MINUTES while you are live.',
      points: [
        'Every (min) is the gap between posts of that message, in minutes.',
        'Tick which platform each message goes to — Twitch, YouTube, or both.',
        'Timers hold off while you are not live, and a freshly enabled timer waits one full interval before its first post rather than blurting into a quiet chat.',
      ],
    },
    {
      id: 'alerts',
      icon: 'sparkles',
      title: 'Alerts and goals — thank people, and count them',
      lead: 'When someone subs, gifts, joins as a member or sends a Super Chat, the bot thanks them in chat by name — and your goals tick up on their own.',
      points: [
        'Alert templates use placeholders the bot fills in: {user}, {tier}, {months}, {count}, {amount}. A 20-sub gift bomb is one alert counted as twenty, not twenty alerts.',
        'A goal counts real events as they happen — Twitch subs or YouTube members — and announces progress every Nth one, plus a completion line when you hit the target.',
        'Now is editable: correct the count any time, and it survives restarting the app.',
        'That is the tab. "How it works" beside the Streamers title reopens this any time.',
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
    const root = $('#streamer-guide');
    if (!root) return null;
    els = {
      root,
      view: document.querySelector('[data-view="streamers"]'),
      scrim: $('#streamer-guide-scrim'),
      icon: $('#streamer-guide-icon'),
      title: $('#streamer-guide-title'),
      sub: $('#streamer-guide-sub'),
      body: $('#streamer-guide-body'),
      dots: $('#streamer-guide-dots'),
      back: $('#streamer-guide-back'),
      next: $('#streamer-guide-next'),
      close: $('#streamer-guide-close'),
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
    return !!document.querySelector('.sheet:not([hidden]), .su-pop:not([hidden])');
  }

  /** Called by the tab router on every switch to the Streamers tab. */
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

    const opener = document.querySelector('#streamer-guide-open');
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
