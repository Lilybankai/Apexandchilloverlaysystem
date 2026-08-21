/**
 * bindings-guide.js — how to bind a Stream Deck, button box or macro pad.
 * -----------------------------------------------------------------------------
 * The Bindings card already knows how to capture a key and a wheel button.
 * What it does not say out loud is the thing Stream Deck / button-box users
 * keep asking: is there a detector, a plugin, a scan? There is not. Those
 * devices type a key, and the global hotkey already listens.
 *
 * This is the walkthrough for that path, opened from a button at the bottom
 * of the Bindings card (next to Scan for wheels — wheels are the other path).
 * Click-to-open, never a first-visit nag: Settings is used for a lot of
 * things, and a modal on the way to changing the port would be a nuisance.
 *
 * Same chrome as setup-guide.js / streamer-guide.js (`.su-guide`). Classic
 * script + module.exports so the step content can be asserted headlessly.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_BINDINGS_GUIDE = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /**
   * The walkthrough. `icon` is a sprite id from icons.js (no `i-` prefix);
   * `lead` is the sentence that would do on its own; the points are what you
   * would tell someone sitting at the rig.
   */
  const STEPS = [
    {
      id: 'no-plugin',
      icon: 'info',
      title: 'Nothing to install',
      lead: 'A Stream Deck, a button box, a macro pad — if it can type a key, Apex already hears it. There is no plugin, no detector and no device scan for these.',
      points: [
        'The app never talks to the Stream Deck (or to the box). It listens for a keyboard key, globally, so it fires while Le Mans Ultimate is in front.',
        'That is the whole trick: the device pretends to be a key, and a binding in this list catches it.',
        'Wheels are the exception — they speak DirectInput, not keystrokes. Scan for wheels on this card is that path.',
      ],
    },
    {
      id: 'free-key',
      icon: 'keyboard',
      title: 'Pick a key the sim does not use',
      lead: 'A bound key is consumed — it will not also reach LMU, OBS or Discord. Pick something none of them already own.',
      points: [
        'F13–F24 are the usual choice. No keyboard sold produces them, which is why a Stream Deck is built to send them, and why they cannot clash with a key you already press.',
        'Do not use WASD, the number row, F1–F12, or anything already bound in LMU, OBS or Discord.',
        'One key, one action. If two rows claim the same key, only the first one fires.',
      ],
    },
    {
      id: 'device',
      icon: 'zap',
      title: 'Teach the device that key',
      lead: 'In the Elgato software — or whatever talks to your button box — make a button whose action is Hotkey, and set it to the key you picked.',
      points: [
        'Stream Deck: add a Hotkey action, choose F13 (or whichever you picked), give the button a label you will recognise at speed — LAST LAP, GAP AHEAD, POINTS.',
        'A Simagic / Moza / Fanatec box, a cheap macro pad, a second keyboard: same idea. The firmware or its software has a "send this key" mode. Use that. Apex does not need to know the brand.',
        'You can test it in Notepad first: press the button, see the key land. If Notepad does not see it, Apex will not either.',
      ],
    },
    {
      id: 'bind',
      icon: 'sparkles',
      title: 'Bind the same key here',
      lead: 'Click Click to bind on the action you want, then press the Stream Deck button (or the key). The chip should show the key you picked.',
      points: [
        'Engineer Call … rows speak that fact over the radio with no microphone — last lap, sectors, gaps, fuel, track-limit points, and the rest.',
        'Ask the race engineer is still push-to-talk, for everything the Call rows do not cover.',
        'The same list binds overlay, pit menu ▲ ▼ + −, and anything else on this card. One key per row, same capture.',
      ],
    },
    {
      id: 'wheels',
      icon: 'check',
      title: 'Wheels stay on Scan for wheels',
      lead: 'A wheel button is not a key. Bind it with the wheel chip on the row, and use Scan for wheels if the base has gone missing.',
      points: [
        'Do not try to make the wheel type F13 unless you have already set that up in the wheel’s own software — most bases never send a keystroke at all.',
        'Hats and axes are not buttons. Scan for wheels prints the button / hat / axis counts so a funky switch that is really a hat is obvious.',
        'That is the card. This button reopens the walkthrough any time.',
      ],
    },
  ];

  const SVG_NS = 'http://www.w3.org/2000/svg';

  let step = 0;
  let open = false;
  let els = null;

  function lookup() {
    if (els) return els;
    const $ = (sel) => document.querySelector(sel);
    const root = $('#bindings-guide');
    if (!root) return null;
    els = {
      root,
      scrim: $('#bindings-guide-scrim'),
      icon: $('#bindings-guide-icon'),
      title: $('#bindings-guide-title'),
      sub: $('#bindings-guide-sub'),
      body: $('#bindings-guide-body'),
      dots: $('#bindings-guide-dots'),
      back: $('#bindings-guide-back'),
      next: $('#bindings-guide-next'),
      close: $('#bindings-guide-close'),
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

  function wire() {
    const e = lookup();
    if (!e) return;

    e.close.addEventListener('click', closeGuide);
    e.scrim.addEventListener('click', closeGuide);
    e.back.addEventListener('click', () => go(-1));
    e.next.addEventListener('click', () => go(1));

    const opener = document.querySelector('#bindings-guide-open');
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
    open: openGuide,
    close: closeGuide,
  };
});
