/**
 * auth.js — renderer logic for the account screens.
 * -----------------------------------------------------------------------------
 * Pure DOM + the `window.apex.auth` bridge from preload.js. No framework and no
 * network access: every Supabase call happens in the main process, so this file
 * only routes between screens, validates enough to give instant feedback, and
 * renders whatever `{ ok, error }` comes back.
 *
 * Screens: signin · register · confirm · reset-request · reset-verify · reset-done
 */

'use strict';

const auth = window.apex && window.apex.auth;

/** Brand-panel copy, per screen — the pitch changes with the task at hand. */
const LEDE = {
  signin:
    'Sign in to manage your overlays, sync your lap database, and climb the league leaderboard.',
  register:
    'Every overlay, the lap database and the league boards — 7 days free, then £4.99/month. Racing in an Apex & Chill league? You ride free.',
  subscribe:
    'One subscription, everything: broadcast overlays, the in-game layer, setups, leaderboards and the race engineer. Cancel any time.',
  confirm:
    'One click in your inbox and your account is live — your laps then follow you to any PC you install the app on.',
  'reset-request':
    'Happens to everyone. Pop your email in and we will send a code to get you back on track.',
  'reset-verify':
    'Happens to everyone. Pop your email in and we will send a code to get you back on track.',
  'reset-done':
    'Back in business. Sign in with the new password and your laps and settings pick up where they left off.',
};

const MIN_PASSWORD = 8;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* -------------------------------------------------------------------------- */
/*  Screen routing                                                            */
/* -------------------------------------------------------------------------- */

let current = 'signin';

/** The field autofocused when a screen opens, so the keyboard just works. */
const FOCUS = {
  signin: '#si-email',
  register: '#rg-name',
  'reset-request': '#rr-email',
  'reset-verify': '#rv-code',
};

function show(screen) {
  current = screen;
  for (const section of $$('.form')) {
    section.hidden = section.dataset.screen !== screen;
  }
  $('#pitch-lede').textContent = LEDE[screen] || LEDE.signin;
  clearMessage(screen);

  const focus = FOCUS[screen] && $(FOCUS[screen]);
  if (focus) {
    // An empty field wins the focus; otherwise land on the first blank one so a
    // remembered email doesn't force a Tab press.
    const form = focus.closest('form');
    const blank = form ? $$('.inp', form).find((i) => !i.value) : null;
    (blank || focus).focus();
  }
}

/* -------------------------------------------------------------------------- */
/*  Messages                                                                  */
/* -------------------------------------------------------------------------- */

const MSG_ICON = { error: '#i-alert', ok: '#i-check', info: '#i-info' };

/** Render the banner for one screen. `kind` is 'error' | 'ok' | 'info'. */
function setMessage(screen, kind, text) {
  const box = $(`[data-msg="${screen}"]`);
  if (!box) return;
  box.dataset.kind = kind;
  box.innerHTML = '';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', MSG_ICON[kind] || MSG_ICON.info);
  svg.appendChild(use);

  const span = document.createElement('span');
  span.textContent = text;

  box.append(svg, span);
  box.hidden = false;
}

function clearMessage(screen) {
  const box = $(`[data-msg="${screen}"]`);
  if (box) {
    box.hidden = true;
    box.textContent = '';
  }
  // Drop any field-level highlight from the previous attempt.
  const section = $(`.form[data-screen="${screen}"]`);
  if (section) for (const inp of $$('.inp', section)) delete inp.dataset.invalid;
}

/** Highlight the field the main process blamed, when it named one. */
function markField(screen, field) {
  if (!field) return;
  const section = $(`.form[data-screen="${screen}"]`);
  if (!section) return;
  const input = $(`.inp[name="${field}"]`, section);
  if (input) {
    input.dataset.invalid = 'true';
    input.focus();
  }
}

/* -------------------------------------------------------------------------- */
/*  Busy state                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Swap a button to a spinner while an await is in flight and lock its form, so
 * a double-press can't fire two signups. `data-label` restores the caption.
 */
function busy(button, on) {
  if (!button) return;
  const form = button.closest('form') || button.closest('.form');
  button.disabled = on;
  if (on) {
    button.innerHTML = '';
    const ring = document.createElement('span');
    ring.className = 'spinner';
    button.append(ring, document.createTextNode(button.dataset.label || ''));
  } else {
    button.textContent = button.dataset.label || '';
  }
  if (form) {
    for (const el of $$('.inp, .chk', form)) el.disabled = on;
  }
}

/** Wrap an async submit: clear, spin, run, un-spin — never leave it stuck. */
async function submit(screen, button, run) {
  clearMessage(screen);
  busy(button, true);
  try {
    await run();
  } catch (err) {
    setMessage(screen, 'error', `Something went wrong: ${err && err.message ? err.message : err}`);
  } finally {
    busy(button, false);
    refreshRegisterGate();
  }
}

/* -------------------------------------------------------------------------- */
/*  Password reveal                                                           */
/* -------------------------------------------------------------------------- */

for (const btn of $$('[data-reveal]')) {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.reveal);
    if (!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    $('use', btn).setAttribute('href', showing ? '#i-eye' : '#i-eye-off');
    input.focus();
  });
}

/* -------------------------------------------------------------------------- */
/*  Plain navigation buttons                                                  */
/* -------------------------------------------------------------------------- */

/* The Terms / Privacy links inside the agree label. preventDefault matters:
 * without it the label forwards the click to the checkbox, so reading the
 * terms would silently tick "I agree" — the exact opposite of the point. */
for (const btn of $$('[data-legal]')) {
  btn.addEventListener('click', (evt) => {
    evt.preventDefault();
    window.apex.legal.open(btn.dataset.legal);
  });
}

for (const btn of $$('[data-go]')) {
  btn.addEventListener('click', () => {
    const target = btn.dataset.go;
    // Carry the email forward between the reset steps and back to sign-in, so
    // nobody retypes it three times.
    if (target === 'reset-request' && $('#si-email').value) {
      $('#rr-email').value = $('#si-email').value.trim();
    }
    if (target === 'signin' && !$('#si-email').value) {
      const carried = $('#rr-email').value || $('#rg-email').value;
      if (carried) $('#si-email').value = carried.trim();
    }
    if (target === 'reset-verify' && !$('#rv-email').value) {
      $('#rv-email').value = ($('#rr-email').value || '').trim();
    }
    show(target);
  });
}

/* -------------------------------------------------------------------------- */
/*  Sign in                                                                   */
/* -------------------------------------------------------------------------- */

$('#signin-form').addEventListener('submit', (evt) => {
  evt.preventDefault();
  const button = $('#signin-form button[type="submit"]');
  void submit('signin', button, async () => {
    const res = await auth.signIn({
      email: $('#si-email').value.trim(),
      password: $('#si-pw').value,
      remember: $('#si-remember').checked,
    });
    if (!res.ok) {
      setMessage('signin', 'error', res.error);
      markField('signin', res.field);
      return;
    }
    await enterOrSubscribe(); // panel if entitled, subscribe screen if not
  });
});

/* -------------------------------------------------------------------------- */
/*  Subscribe — the paywall between an account and the app                     */
/* -------------------------------------------------------------------------- */

const billing = window.apex && window.apex.billing;

/**
 * Route through the gate: main answers `entitled` from the server, and loads
 * the panel itself when the answer is yes. A "no" lands here, on the subscribe
 * screen, with the snapshot to phrase the button from.
 */
async function enterOrSubscribe() {
  const res = await auth.enterApp();
  if (res && res.entitled === false) {
    renderSubscribe(res.billing);
    show('subscribe');
  }
  // entitled (or an old main without the flag): main swapped the page already.
}

/** Phrase the plan pitch: the trial is first-subscription-only. */
function renderSubscribe(b) {
  const trial = !b || !b.status || b.status === 'none';
  const btn = $('#sub-start-btn');
  btn.dataset.label = trial ? 'Start 7-day free trial' : 'Subscribe — £4.99/month';
  btn.textContent = btn.dataset.label;
  $('#sub-lede').innerHTML = trial
    ? 'Free for 7 days, then <strong>£4.99/month</strong> — billed automatically unless you cancel first.'
    : 'Welcome back — pick up where you left off for <strong>£4.99/month</strong>. Cancel any time.';
}

/** Ask the server again; walk through the moment the answer turns yes. */
async function recheckSubscription(silent) {
  const b = await billing.status();
  if (b && b.entitled) {
    await auth.enterApp();
    return;
  }
  renderSubscribe(b);
  if (!silent) {
    setMessage(
      'subscribe',
      'info',
      'No active subscription on this account yet — a payment made just now can take a few seconds to land. Try again shortly.',
    );
  }
}

$('#sub-start-btn').addEventListener('click', () => {
  const button = $('#sub-start-btn');
  void submit('subscribe', button, async () => {
    const res = await billing.checkout();
    if (!res.ok) {
      setMessage('subscribe', 'error', res.error || 'Could not start checkout.');
      return;
    }
    if (res.alreadySubscribed) {
      await recheckSubscription(true);
      return;
    }
    setMessage(
      'subscribe',
      'info',
      'Checkout is open in your browser. Finish there, then come back — this screen picks it up on its own.',
    );
  });
});

$('#sub-code-form').addEventListener('submit', (evt) => {
  evt.preventDefault();
  const button = $('#sub-code-btn');
  const code = $('#sub-code-input').value.trim();
  if (!code) {
    setMessage('subscribe', 'error', 'Type your league code first.');
    return;
  }
  void submit('subscribe', button, async () => {
    const res = await billing.redeemCode(code);
    if (!res.ok) {
      setMessage('subscribe', 'error', res.error || 'That code was not accepted.');
      markField('subscribe', 'code');
      return;
    }
    await auth.enterApp();
  });
});

$('#sub-refresh-btn').addEventListener('click', () => {
  void recheckSubscription(false);
});

$('#sub-signout-btn').addEventListener('click', async () => {
  // Main reloads this page signed-out; nothing to re-render here on success.
  await auth.signOut();
});

// Checkout ends with an alt-tab back to this window — that focus IS the
// "I've paid" signal, so ask again without making anyone find the button.
window.addEventListener('focus', () => {
  if (current === 'subscribe' && billing) void recheckSubscription(true);
});

/* -------------------------------------------------------------------------- */
/*  Register                                                                  */
/* -------------------------------------------------------------------------- */

/** The terms tick gates the submit — re-checked after every busy() unlock. */
function refreshRegisterGate() {
  const btn = $('#register-form button[type="submit"]');
  if (btn && !btn.querySelector('.spinner')) btn.disabled = !$('#rg-agree').checked;
}

$('#rg-agree').addEventListener('change', refreshRegisterGate);

$('#register-form').addEventListener('submit', (evt) => {
  evt.preventDefault();
  const button = $('#register-form button[type="submit"]');

  // Local check first: a round trip to say "too short" is a waste of a second.
  if ($('#rg-pw').value.length < MIN_PASSWORD) {
    setMessage('register', 'error', `Use at least ${MIN_PASSWORD} characters for your password.`);
    markField('register', 'password');
    return;
  }

  void submit('register', button, async () => {
    const res = await auth.register({
      displayName: $('#rg-name').value.trim(),
      email: $('#rg-email').value.trim(),
      password: $('#rg-pw').value,
      marketingOptIn: $('#rg-opt').checked,
    });
    if (!res.ok) {
      setMessage('register', 'error', res.error);
      markField('register', res.field);
      return;
    }
    if (res.needsConfirmation) {
      $('[data-echo="confirm-email"]').textContent = res.email;
      show('confirm');
      return;
    }
    // Confirmation disabled on the project — straight to the gate, which for a
    // brand-new account means the subscribe screen and its trial button.
    await enterOrSubscribe();
  });
});

/* -------------------------------------------------------------------------- */
/*  Confirmation email resend                                                 */
/* -------------------------------------------------------------------------- */

$('#resend-btn').addEventListener('click', () => {
  const button = $('#resend-btn');
  void submit('confirm', button, async () => {
    const email = $('[data-echo="confirm-email"]').textContent.trim();
    const res = await auth.resendConfirmation({ email });
    if (!res.ok) setMessage('confirm', 'error', res.error);
    else setMessage('confirm', 'ok', `Sent again to ${email}. Give it a minute to arrive.`);
  });
});

/* -------------------------------------------------------------------------- */
/*  Reset · step 1 — request a code                                           */
/* -------------------------------------------------------------------------- */

$('#reset-request-form').addEventListener('submit', (evt) => {
  evt.preventDefault();
  const button = $('#reset-request-form button[type="submit"]');
  void submit('reset-request', button, async () => {
    const email = $('#rr-email').value.trim();
    const res = await auth.requestReset({ email });
    if (!res.ok) {
      setMessage('reset-request', 'error', res.error);
      markField('reset-request', res.field);
      return;
    }
    $('#rv-email').value = email;
    show('reset-verify');
    // Supabase answers 200 whether or not the address is registered — say so
    // honestly rather than confirming an account exists.
    setMessage(
      'reset-verify',
      'info',
      `If ${email} has an account, a reset code is on its way. Check spam too.`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  Reset · step 2 — code + new password                                      */
/* -------------------------------------------------------------------------- */

$('#reset-verify-form').addEventListener('submit', (evt) => {
  evt.preventDefault();
  const button = $('#reset-verify-form button[type="submit"]');

  const pw = $('#rv-pw').value;
  if (pw.length < MIN_PASSWORD) {
    setMessage('reset-verify', 'error', `Use at least ${MIN_PASSWORD} characters.`);
    markField('reset-verify', 'password');
    return;
  }
  if (pw !== $('#rv-pw2').value) {
    setMessage('reset-verify', 'error', 'Those two passwords don’t match.');
    markField('reset-verify', 'password2');
    return;
  }

  void submit('reset-verify', button, async () => {
    const res = await auth.resetPassword({
      email: $('#rv-email').value.trim(),
      token: $('#rv-code').value.trim(),
      password: pw,
    });
    if (!res.ok) {
      setMessage('reset-verify', 'error', res.error);
      markField('reset-verify', res.field);
      return;
    }
    $('#si-email').value = res.email || $('#rv-email').value.trim();
    $('#si-pw').value = '';
    // Don't leave the new password sitting in the DOM once it's been set.
    $('#reset-verify-form').reset();
    show('reset-done');
  });
});

/* -------------------------------------------------------------------------- */
/*  Boot                                                                      */
/* -------------------------------------------------------------------------- */

async function boot() {
  if (!auth) {
    // Only possible if the preload failed to load — say so instead of showing a
    // form whose buttons silently do nothing.
    setMessage('signin', 'error', 'Account service unavailable — restart the app.');
    return;
  }
  const state = await auth.getState();

  if (state.lastEmail) $('#si-email').value = state.lastEmail;

  refreshRegisterGate();

  // Signed in but parked on this page: the account exists, the subscription
  // doesn't (or main is still deciding). Land on subscribe, not sign-in — the
  // recheck walks them straight through if the gate opens.
  if (state.signedIn && billing) {
    show('subscribe');
    void recheckSubscription(true);
    return;
  }
  show('signin');
}

/**
 * Dev screenshot hook, driven by APEX_SHOT in electron/main.js: six of the
 * app's states live on this one page, so the capture pass needs a way to walk
 * them. All it can do is switch screens — the same thing the buttons do.
 */
window.__shot = (screen) => {
  if (screen === 'confirm' && !$('[data-echo="confirm-email"]').textContent) {
    $('[data-echo="confirm-email"]').textContent = 'you@example.com';
  }
  show(screen);
};

void boot();
