// emails.ts — the lifecycle email templates, and the brand shell they sit in.
// -----------------------------------------------------------------------------
// One module, imported by `email-dispatch` (to send) and by scripts/test-emails.js
// (to render every step and check it, without a network call or an API key).
//
// Why the HTML looks like 2004:
//   Email clients are not browsers. Outlook renders with Word's engine, Gmail
//   strips <style> blocks on some clients and keeps them on others, and flexbox
//   is a coin toss everywhere. So: nested <table>, every rule inline, 600px
//   fixed, no external CSS, no web fonts. The app's own tokens are mirrored as
//   constants below rather than imported, because control-panel.css cannot be
//   loaded from Deno and a colour drifting is a cosmetic bug, not a broken mail.
//
// Images are OPTIONAL BY DESIGN. Most clients block remote images until the
// reader allows them, and our asset host is a GitHub Pages site that may or may
// not have its DNS pointed yet. So every screenshot has real alt text, sits in
// a bordered box that looks deliberate when empty, and never carries
// information that is not also in the prose. The mail reads correctly with
// images off — that is the test.
//
// The plain-text alternative is not a courtesy. A multipart mail with no text
// part scores badly with spam filters, and the whole sequence lives or dies on
// reaching the inbox.

/* ------------------------------------------------------------------ brand */

const C = {
  bg: '#060a12',
  panel: '#0c111c',
  panel2: '#101724',
  line: '#1d2536',
  text: '#f4f6fb',
  text2: '#9aa4b8',
  text3: '#66708a',
  blue: '#309be1',
  cyan: '#26bbf4',
  purple: '#6a2fd6',
  ok: '#35d07f',
};

// Bahnschrift is a Windows font and the app's display face; on a phone the
// stack falls through to the system UI font, which is the right answer.
const FONT = "'Segoe UI', Roboto, -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif";

/* ------------------------------------------------------------------- env */

/**
 * Read config from whichever runtime we are in. The dispatcher runs this on
 * Deno; scripts/test-emails.js and scripts/email-preview.js import the very
 * same file from Node (which strips the types natively as of v22.6), so the
 * copy that is checked and previewed is the copy that gets sent. Reaching
 * straight for `Deno.env` would make that impossible.
 */
const env = (key: string): string | undefined => {
  const g = globalThis as { Deno?: { env: { get(k: string): string | undefined } }; process?: { env: Record<string, string | undefined> } };
  return g.Deno?.env?.get(key) ?? g.process?.env?.[key];
};

/** Where the hero images live. See scripts/email-assets.js. */
export const ASSET_BASE = (
  env('EMAIL_ASSET_BASE') ?? 'https://aio.apexandchillracing.co.uk/email'
).replace(/\/+$/, '');

/** Public base for the unsubscribe endpoint (the email-unsubscribe function). */
export const UNSUB_BASE = (
  env('EMAIL_UNSUB_BASE') ?? `${env('SUPABASE_URL') ?? ''}/functions/v1/email-unsubscribe`
).replace(/\/+$/, '');

const LINKS = {
  download:
    env('EMAIL_LINK_DOWNLOAD') ??
    'https://github.com/Lilybankai/apex-aio-releases/releases/latest',
  web: env('EMAIL_LINK_WEB') ?? 'https://aio.apexandchillracing.co.uk',
  discord: env('EMAIL_LINK_DISCORD') ?? '',
  support: env('EMAIL_REPLY_TO') ?? 'support@apexandchillracing.co.uk',
};

const SENDER_NAME = env('EMAIL_FROM_NAME') ?? 'Carl at Apex & Chill';
const POSTAL = env('EMAIL_POSTAL_ADDRESS') ?? 'Apex & Chill Racing, United Kingdom';

/* ------------------------------------------------------------------ types */

export interface Recipient {
  first_name: string;
  unsubscribe_token: string;
  variant?: string;
  opened_app?: boolean;
  days_left?: number | null;
}

export interface Rendered {
  subject: string;
  html: string;
  text: string;
  /** RFC 8058 one-click unsubscribe, which Gmail and Yahoo now require. */
  listUnsubscribe: string;
}

interface Block {
  /** Hero screenshot filename under ASSET_BASE, or null for a text-only mail. */
  image: string | null;
  imageAlt: string;
  /** Short line under the logo — the mail's own kicker, not a subject repeat. */
  kicker: string;
  headline: string;
  /** Paragraphs of prose. Plain strings; `<b>` is the only markup allowed. */
  body: string[];
  /** The numbered "do this now" list. The single most useful part of each mail. */
  steps?: { title: string; detail: string }[];
  cta?: { label: string; url: string };
  /** One-line sign-off above the footer. */
  outro?: string;
}

/* ----------------------------------------------------------------- shell */

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** `<b>` survives; everything else is escaped. Keeps template copy safe. */
const rich = (s: string) =>
  esc(s).replace(/&lt;b&gt;/g, '<b style="color:#f4f6fb">').replace(/&lt;\/b&gt;/g, '</b>');

/**
 * How the mail explains itself at the bottom.
 *
 * `lifecycle` is a series someone can stop. `transactional` is the answer to
 * something they did — an approved partner application, say — and carries no
 * unsubscribe link, because there is nothing recurring to unsubscribe FROM and
 * offering one would imply there is. It is also why these ignore the lifecycle
 * opt-out: see the header of migration 0029.
 */
type Kind = 'lifecycle' | 'transactional';

interface ShellOpts {
  kind?: Kind;
  /** One line saying why this arrived. Transactional mail only. */
  reason?: string;
}

function shell(b: Block, r: Recipient, o: ShellOpts = {}): string {
  const unsub = `${UNSUB_BASE}?t=${encodeURIComponent(r.unsubscribe_token)}`;
  const hi = r.first_name ? `Hi ${esc(r.first_name)},` : 'Hi there,';

  const hero = b.image
    ? `<tr><td style="padding:0 28px 24px">
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                style="border:1px solid ${C.line};border-radius:10px;background:${C.panel2}">
           <tr><td style="padding:8px">
             <img src="${ASSET_BASE}/${b.image}" alt="${esc(b.imageAlt)}" width="528"
                  style="display:block;width:100%;max-width:528px;height:auto;border-radius:6px;
                         border:0;outline:none;text-decoration:none;color:${C.text2};
                         font:italic 13px ${FONT}">
           </td></tr>
         </table>
       </td></tr>`
    : '';

  const steps = b.steps?.length
    ? `<tr><td style="padding:0 28px 24px">
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:${C.panel2};border:1px solid ${C.line};border-radius:10px">
           <tr><td style="padding:20px 22px 6px">
             <div style="font:700 12px/1 ${FONT};letter-spacing:1.4px;text-transform:uppercase;
                         color:${C.cyan};padding-bottom:14px">Try this now</div>
           </td></tr>
           ${b.steps
             .map(
               (s, i) => `<tr><td style="padding:0 22px 16px">
             <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
               <tr>
                 <td width="28" valign="top" style="font:700 15px/22px ${FONT};color:${C.blue}">${i + 1}.</td>
                 <td style="font:400 15px/22px ${FONT};color:${C.text}">
                   <b style="color:${C.text}">${rich(s.title)}</b><br>
                   <span style="color:${C.text2};font-size:14px;line-height:21px">${rich(s.detail)}</span>
                 </td>
               </tr>
             </table>
           </td></tr>`,
             )
             .join('')}
           <tr><td style="padding:0 22px 8px"></td></tr>
         </table>
       </td></tr>`
    : '';

  const cta = b.cta
    ? `<tr><td style="padding:0 28px 28px">
         <table role="presentation" cellpadding="0" cellspacing="0" border="0">
           <tr><td style="background:${C.blue};border-radius:8px">
             <a href="${b.cta.url}" style="display:inline-block;padding:13px 26px;
                font:700 15px/1 ${FONT};color:#ffffff;text-decoration:none">${esc(b.cta.label)}</a>
           </td></tr>
         </table>
       </td></tr>`
    : '';

  const outro = b.outro
    ? `<tr><td style="padding:0 28px 28px;font:400 15px/23px ${FONT};color:${C.text2}">
         ${rich(b.outro)}</td></tr>`
    : '';

  const footer =
    o.kind === 'transactional'
      ? `${esc(o.reason ?? 'You are getting this because of something you asked for in the app.')}<br>
         Reply to this message and it reaches a person.<br>`
      : `You are getting this because you created an Apex AIO System account.
         It is part of a short series about the app — not a newsletter.<br>
         <a href="${unsub}" style="color:${C.text2};text-decoration:underline">Stop these emails</a>
         &nbsp;&#183;&nbsp; Reply to this message and it reaches a person.<br>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(b.headline)}</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%">
<!-- Preheader: the grey line next to the subject in the inbox list. Hidden in
     the body, so it must repeat nothing the headline already says. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0">
  ${esc(b.kicker)}&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:${C.bg};padding:24px 12px">
 <tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
         style="width:100%;max-width:600px;background:${C.panel};border:1px solid ${C.line};
                border-radius:14px;overflow:hidden">

    <!-- gradient rule: the app's --grad, as the one piece of pure brand -->
    <tr><td style="height:4px;line-height:4px;font-size:0;
        background:${C.blue};
        background-image:linear-gradient(120deg,${C.blue} 0%,${C.cyan} 45%,${C.purple} 100%)">&nbsp;</td></tr>

    <!-- The badge is an image and the name is HTML text, deliberately. Most
         clients block remote images on a first mail, and a masthead that
         disappears with them makes the whole thing look like spam. -->
    <tr><td style="padding:26px 28px 6px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td valign="middle" style="padding-right:11px">
            <img src="${ASSET_BASE}/logo.png" alt="" width="40" height="40"
                 style="display:block;width:40px;height:40px;border:0;border-radius:8px">
          </td>
          <td valign="middle" style="font:700 17px/20px ${FONT};color:${C.text};
                                     letter-spacing:0.2px">
            Apex AIO System
          </td>
        </tr>
      </table>
    </td></tr>

    <tr><td style="padding:14px 28px 0">
      <div style="font:700 12px/1 ${FONT};letter-spacing:1.4px;text-transform:uppercase;color:${C.text3}">
        ${esc(b.kicker)}
      </div>
    </td></tr>

    <tr><td style="padding:10px 28px 4px;font:700 26px/32px ${FONT};color:${C.text}">
      ${esc(b.headline)}
    </td></tr>

    <tr><td style="padding:14px 28px 0;font:400 15px/23px ${FONT};color:${C.text2}">${hi}</td></tr>

    ${b.body
      .map(
        (p) =>
          `<tr><td style="padding:12px 28px 0;font:400 15px/23px ${FONT};color:${C.text2}">${rich(p)}</td></tr>`,
      )
      .join('')}

    <tr><td style="height:22px;line-height:22px;font-size:0">&nbsp;</td></tr>
    ${hero}
    ${steps}
    ${cta}
    ${outro}

    <tr><td style="padding:0 28px"><div style="height:1px;background:${C.line};font-size:0">&nbsp;</div></td></tr>
    <tr><td style="padding:20px 28px 28px;font:400 12px/19px ${FONT};color:${C.text3}">
      ${footer}
      <span style="color:#4a5470">${esc(POSTAL)}</span>
    </td></tr>
  </table>
 </td></tr>
</table>
</body></html>`;
}

function shellText(b: Block, r: Recipient, o: ShellOpts = {}): string {
  const unsub = `${UNSUB_BASE}?t=${encodeURIComponent(r.unsubscribe_token)}`;
  const strip = (s: string) => s.replace(/<\/?b>/g, '');
  const lines: string[] = [];
  lines.push(b.headline.toUpperCase(), '');
  lines.push(r.first_name ? `Hi ${r.first_name},` : 'Hi there,', '');
  b.body.forEach((p) => lines.push(strip(p), ''));
  if (b.steps?.length) {
    lines.push('TRY THIS NOW', '');
    b.steps.forEach((s, i) => lines.push(`${i + 1}. ${strip(s.title)}`, `   ${strip(s.detail)}`, ''));
  }
  if (b.cta) lines.push(`${b.cta.label}: ${b.cta.url}`, '');
  if (b.outro) lines.push(strip(b.outro), '');
  lines.push('--');
  if (o.kind === 'transactional') {
    lines.push(o.reason ?? 'You are getting this because of something you asked for in the app.');
  } else {
    lines.push('You are getting this because you created an Apex AIO System account.');
    lines.push(`Stop these emails: ${unsub}`);
  }
  lines.push('Reply to this message and it reaches a person.');
  lines.push(POSTAL);
  return lines.join('\n');
}

/* ------------------------------------------------------------- templates */

type Template = (r: Recipient) => { subject: string } & Block;

const TEMPLATES: Record<string, Template> = {
  /* ---------------------------------------------------- trial: the 7 days */

  'trial/day0': () => ({
    subject: 'Your Apex AIO trial is live — 10 minutes to your first overlay',
    kicker: 'Day 1 of 7 · Getting on screen',
    headline: "You're in. Let's get something on screen.",
    image: 'hero-day0.png',
    imageAlt: 'The Apex AIO overlay layer running over Le Mans Ultimate',
    body: [
      'Your seven days start now, and the whole app is unlocked — overlays, the race engineer, setups, the pit wall, session review. No feature is held back for the paid plan.',
      "The only thing standing between you and a working overlay is letting the sim talk to the app. The app does that bit itself; you just have to let it, with LMU closed.",
    ],
    steps: [
      {
        title: 'Open the app with Le Mans Ultimate CLOSED',
        detail:
          'It installs its telemetry plugin into your LMU folder on first run. It will never write while the game is running, which is why the order matters.',
      },
      {
        title: 'Work down the Get started checklist',
        detail:
          'It is on the Dashboard. Nine short steps, each one opens the screen it is talking about. This is the fastest route through everything below.',
      },
      {
        title: 'Load any session and press your overlay key',
        detail:
          'Delta, tyres, fuel, radar and the track map appear over the game. If nothing shows, the checklist step "Let the sim talk to Apex" will tell you why.',
      },
    ],
    cta: { label: 'Open the checklist', url: LINKS.download },
    outro:
      "Over the next few days I will send one short email per feature — what it does, and the one trick that makes it worth having. If you would rather just explore, reply <b>stop</b> and I will leave you to it.",
  }),

  'trial/day1': (r) => ({
    subject: 'Move the overlays where you actually look',
    kicker: 'Day 2 of 7 · Overlays',
    headline: 'The default layout is a starting point, not the design.',
    image: 'hero-day1.png',
    imageAlt: 'Overlay edit mode, with widgets being dragged into place',
    body: r.opened_app
      ? [
          'Every widget can be dragged, resized and switched off independently. Most drivers end up with three or four on screen and bin the rest — the point is that the ones you keep are exactly where your eyes already go.',
          "Edit mode is the whole story: turn it on, arrange, turn it off. The layout is saved per screen, so a triple-screen and a single monitor keep their own arrangement.",
        ]
      : [
          "Your trial is running but the app has not been opened on this account yet — so this one is worth two minutes of setup before it makes sense.",
          'Once you are in, every widget can be dragged, resized and switched off independently. Most drivers keep three or four and bin the rest.',
        ],
    steps: [
      {
        title: 'Dashboard, then Edit layout',
        detail:
          'The overlay layer goes semi-transparent and every widget gets a handle. Drag to move, corner to resize.',
      },
      {
        title: 'Turn off what you do not read',
        detail:
          'Each widget has its own toggle in Overlays. A quiet screen is a faster screen — the radar and the delta earn their place, a widget you never glance at does not.',
      },
      {
        title: 'Bind a key to show and hide the lot',
        detail:
          'Settings, then your own buttons. One key clears the screen for a replay or a screenshot without unloading anything.',
      },
    ],
    outro:
      'Tomorrow: the feature people either love immediately or forget they have — the race engineer.',
  }),

  'trial/day2': () => ({
    subject: 'Ask out loud: "how much fuel have I got left?"',
    kicker: 'Day 3 of 7 · Race engineer',
    headline: 'You have a race engineer. Talk to them.',
    image: 'hero-day2.png',
    imageAlt: 'The race engineer panel mid-conversation during a stint',
    body: [
      'Hold your push-to-talk key, ask a question in plain English, and you get a spoken answer built from your live telemetry — not a canned phrase. It knows your fuel, your tyres, your gaps, the flags and where you are in the stint.',
      'It also speaks first when it matters: yellow in a sector, a penalty and its deadline, someone closing on you, the chequered flag.',
    ],
    steps: [
      {
        title: 'Bind push-to-talk, then ask three things',
        detail:
          '"How is my fuel?" · "What is the gap behind?" · "Should I pit this lap?" Those three cover most of a stint.',
      },
      {
        title: 'Ask it for a plan, not just a number',
        detail:
          '"Can I make the end on this tank?" makes it do the arithmetic against your actual consumption, rather than reading you a gauge.',
      },
      {
        title: 'Turn on Better Ears if it mishears you',
        detail:
          'Settings, Engineer. It quietly fetches a larger speech model in the background, off-track only. Wheel-to-wheel accuracy improves noticeably.',
      },
    ],
    outro: 'Tomorrow: the one that stops you throwing away endurance races — fuel and strategy.',
  }),

  'trial/day3': () => ({
    subject: 'Stop guessing the fuel number',
    kicker: 'Day 4 of 7 · Fuel & strategy',
    headline: 'How many laps that tank is really worth.',
    image: 'hero-day3.png',
    imageAlt: 'The Fuel tab showing consumption, stint length and a pit window',
    body: [
      'The Fuel tab learns your consumption from the laps you actually drive — this car, this track, this fuel map — instead of trusting the in-game estimate. It then tells you the number that matters: how many laps you have, and what to put in at the stop.',
      'For a race it goes further and lays the stops out: how many, roughly when, and what a splash-and-dash would save you.',
    ],
    steps: [
      {
        title: 'Run five clean laps in practice',
        detail: 'That is all the history it needs before its numbers get sharp.',
      },
      {
        title: 'Set the race length and read the plan',
        detail:
          'Laps or minutes. It works out the stops, the fuel per stop, and the lap you would have to pit on.',
      },
      {
        title: 'Put the fuel widget on screen for the race',
        detail:
          'Laps remaining on this tank, live, next to your delta. It is the difference between a confident last stint and a nervous one.',
      },
    ],
    outro: 'Tomorrow: how to stop building setups from scratch.',
  }),

  'trial/day4': () => ({
    subject: 'Borrow a setup instead of building one',
    kicker: 'Day 5 of 7 · Setups',
    headline: 'Someone has already solved this track.',
    image: 'hero-day4.png',
    imageAlt: 'The setup browser, with shared setups listed by car and track',
    body: [
      'Setups shared in the app install straight into Le Mans Ultimate as proper custom setups — they appear in the game\'s own setup list, alongside yours, and nothing of yours is overwritten.',
      'Where a lap has been uploaded with a setup, you can see the time it actually produced. That is the honest version of a setup rating: not a star, a lap.',
    ],
    steps: [
      {
        title: 'Setups, filter to your car and track',
        detail: 'Get it, then pick it in the garage like any other setup.',
      },
      {
        title: 'Change one thing at a time',
        detail:
          "A borrowed setup is a baseline, not an answer. Wings, then dampers, then bars — one change, three laps, keep or revert.",
      },
      {
        title: 'Share the one that worked',
        detail: 'Publishing yours is what keeps the list worth reading for everyone else.',
      },
    ],
    outro: 'Tomorrow: the bit that surprises people — your pit wall on a second screen.',
  }),

  'trial/day5': () => ({
    subject: 'Your pit wall, on a tablet next to you',
    kicker: 'Day 6 of 7 · Team pit wall',
    headline: 'A second screen that is not on your PC.',
    image: 'hero-day5.png',
    imageAlt: 'The web pit wall open on a tablet, showing live tyre and fuel cards',
    body: [
      "Everything the app knows about your car publishes to a web page you can open on a phone, a tablet or another PC, signed in with the same account. Tyres, temperatures and pressures per wheel, fuel, the track map, the standings.",
      'In a team it goes both ways: during a driver swap the whole team sees the same board, and whoever is not driving can actually be useful.',
    ],
    steps: [
      {
        title: 'Check Settings, Application, Web pit wall is on',
        detail: 'It is on by default. That is the switch that publishes the board.',
      },
      { title: 'Open the pit wall on your tablet and sign in', detail: LINKS.web },
      {
        title: 'Prop it where the pit board would be',
        detail:
          'It updates about once a second. It is the screen you look at on the straight, not mid-corner.',
      },
    ],
    cta: { label: 'Open the pit wall', url: LINKS.web },
    outro: 'Tomorrow: what to do with a session after you have finished driving it.',
  }),

  'trial/day6': () => ({
    subject: 'Where the last three tenths are hiding',
    kicker: 'Day 7 of 7 · Session review',
    headline: 'Read the session back.',
    image: 'hero-day6.png',
    imageAlt: 'The Review tab comparing two laps on a flat track map with speed traces',
    body: [
      'Every lap you drive is recorded with the line you took. In Review you can put your best lap against another one and see them drawn on the same map — where you turned in earlier, where you got on the throttle later, where the time actually went.',
      'The leaderboards run on a rolling week, split by class, so you are compared with cars that can do what yours does.',
    ],
    steps: [
      {
        title: 'Review, pick the session you just drove',
        detail: 'Every stint is there, with its laps, its consumption and its stops.',
      },
      {
        title: 'Compare your best lap with your second best',
        detail:
          'Two of your own laps first. The differences are small and entirely fixable — that is the useful comparison before you go chasing an alien.',
      },
      {
        title: 'Then check the weekly board for your class',
        detail: 'It resets on a rolling seven days, so a good week is always within reach.',
      },
    ],
    outro: 'One more tomorrow, and then I will stop filling your inbox.',
  }),

  'trial/day7': (r) => {
    const converting = r.variant !== 'thanks';
    const left = typeof r.days_left === 'number' ? r.days_left : 1;
    const when = left <= 0 ? 'today' : left === 1 ? 'tomorrow' : `in ${left} days`;
    return converting
      ? {
          subject: `Your trial ends ${when}`,
          kicker: 'Last day',
          headline: `Your trial ends ${when}.`,
          image: null,
          imageAlt: '',
          body: [
            'Nothing happens that you have to act on: the card you put down at the start rolls into £4.99 a month, and everything carries on exactly as it is. Cancel any time from Settings, Account, in two clicks — no email, no form.',
            'What keeps running: the overlays, the race engineer, fuel and strategy, setups, the pit wall, session review, the leaderboards, and every feature added while you are subscribed. It is one price for the lot.',
            "If it has not clicked, I would genuinely rather know why than have you drift off. <b>Reply to this email</b> — it comes to me, not to a ticket system.",
          ],
          outro:
            'Either way, thanks for giving it a proper go. Seven emails in seven days is enough from me — this is the last one.',
        }
      : {
          subject: 'That is the tour done — thank you',
          kicker: 'Last one',
          headline: 'That is the tour done.',
          image: null,
          imageAlt: '',
          body: [
            'You are subscribed, so nothing changes and there is nothing to do. This is just the last of the seven.',
            'The two things worth knowing: the app updates itself, and the Suggestions tab is read by a human — a good few of the features above started as somebody\'s message in there.',
            'If anything is not working the way you expected, <b>reply to this email</b>. It reaches me directly.',
          ],
          outro: 'Enjoy it. See you on track.',
        };
  },

  /* ------------------------------------- nudge: account made, never started */

  'nudge/why': () => ({
    subject: 'What stopped you?',
    kicker: 'One question',
    headline: 'You made an account and then stopped.',
    image: null,
    imageAlt: '',
    body: [
      'You set up an Apex AIO account but never started the trial, and I would like to know what got in the way. I am not going to guess at it in a sequence of emails.',
      'So, one question, and any answer helps: <b>what stopped you?</b>',
      'It is usually one of four things — it wanted a card up front, the setup looked like work, it was not obvious what it does that the game does not, or you simply got pulled away. If it is a fifth thing, that is the one I most want to hear.',
    ],
    outro:
      'Hit reply and say it in as few words as you like. It comes straight to me and I answer them all.',
  }),

  'nudge/proof': () => ({
    subject: 'What the seven days actually get you',
    kicker: 'The short version',
    headline: 'It is not another delta bar.',
    image: 'hero-nudge-proof.png',
    imageAlt: 'The Apex AIO overlays, engineer and pit wall side by side',
    body: [
      'In case it was never clear what the app is for, here is the whole thing in four lines — and all of it is unlocked for the trial, not a cut-down version.',
    ],
    steps: [
      {
        title: 'Overlays that sit over LMU',
        detail:
          'Delta, radar, tyres and pressures per wheel, fuel, track map, weather, damage, standings. Dragged wherever you want them.',
      },
      {
        title: 'A race engineer you talk to',
        detail:
          'Ask about fuel, tyres, gaps or strategy out loud and get a spoken answer from your live telemetry. It calls yellows and penalties before you see them.',
      },
      {
        title: 'Fuel and strategy that learn your driving',
        detail:
          'Consumption from your own laps, stop plans for the race, and the pit window read out to you.',
      },
      {
        title: 'A pit wall on your tablet, and a session review after',
        detail:
          'Live tyre and fuel cards on a second screen, then two laps drawn on the same map to find where the time went.',
      },
    ],
    cta: { label: 'Start the seven days', url: LINKS.download },
    outro:
      'Card up front, cancel in two clicks from inside the app, and nothing is taken during the seven days.',
  }),

  'nudge/last': () => ({
    subject: 'Last one from me',
    kicker: 'Closing the loop',
    headline: 'I will leave it there.',
    image: null,
    imageAlt: '',
    body: [
      'This is the last email I will send about starting a trial — the account stays exactly where it is, and there is nothing you need to do.',
      'If it turns out to be useful later, everything is still there when you sign in, and the seven days will not have been used up.',
      'And if there was a reason it was not for you, I would still like to hear it. Reply to this one and it reaches me.',
    ],
    outro: 'Thanks for taking a look either way. See you on track.',
  }),
};

/* ------------------------------------------- transactional (outbox) mail */

/*
 * Mail sent because something HAPPENED, not because a clock ticked. Queued
 * into public.email_outbox by a database function and drained by the same
 * dispatcher, which is why it lives in this file rather than a second one:
 * one brand shell, one place the copy is read and edited.
 *
 * These are kept apart from TEMPLATES above on purpose. A lifecycle step is
 * addressed to a Recipient and rendered from their schedule position; a
 * transactional mail is addressed to a Recipient and rendered from PARAMS the
 * event supplied (a code, a link). Sharing one registry would mean one of the
 * two always carrying fields it has no use for.
 */

interface Transactional {
  /** The footer line. Says what they did that caused this. */
  reason: string;
  build: (p: Record<string, unknown>, r: Recipient) => { subject: string } & Block;
}

/** Params are JSON from the database, so nothing is assumed to be a string. */
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

const TRANSACTIONAL: Record<string, Transactional> = {
  /*
   * A partner application was approved.
   *
   * The hard part of this mail is honesty. The scheme pays the partner
   * NOTHING — it is a promotion tool, not an affiliate programme (see
   * docs/REFERRALS.md) — and someone who applied may well have assumed
   * otherwise. Saying so here, plainly, in the mail that welcomes them, is far
   * better than letting them find out when they ask where their money is. So
   * the discount they are handing out is the headline, and "what you get" is
   * answered rather than dodged.
   */
  'partner/approved': {
    reason: 'You are getting this because you applied to become an Apex AIO partner.',
    build: (p) => {
      const code = str(p.code);
      const url = str(p.url);
      const overlay = str(p.overlay_url);
      const pct = Number(p.percent_off) || 10;
      return {
        subject: `You're an Apex AIO partner — your code is ${code}`,
        kicker: 'Partner application · approved',
        headline: `Your code is ${code}.`,
        image: null,
        imageAlt: '',
        body: [
          `You are in. Anyone who uses your link or types <b>${code}</b> in the app gets <b>${pct}% off Apex AIO for as long as they stay subscribed</b> — not a first-month discount, every month.`,
          `Your link: <b>${url}</b>`,
          // Said in the welcome, not discovered later. See the comment above.
          'To be straight with you about what this is: the discount goes to the people who use your code, and there is no commission or payout to you today. It is a promotion tool — something to put on a stream or in a description that is worth something to your audience. Every redemption is recorded against your code, so if that ever changes it will be based on real numbers rather than starting from zero.',
        ],
        steps: [
          {
            title: 'Open Settings → Account in the app',
            detail:
              'Your link, your stream overlay and your three numbers — opens, redemptions, and how many of those are subscribed — are all on that page now. Nobody sees who used the code, including you; the numbers are totals.',
          },
          {
            title: 'Put the overlay in OBS',
            detail: overlay
              ? `Add ${overlay} as a Browser Source and your code sits on screen on a transparent background. There is a Style dropdown in the app that builds the bar, badge and light-scene versions.`
              : 'Add the overlay URL from Settings → Account as a Browser Source and your code sits on screen on a transparent background.',
          },
          {
            title: 'Say the code, do not only link it',
            detail: `${code} is case- and punctuation-insensitive and works with no link at all — read out loud, posted in Discord, on a sticker. That is how most of them actually get used.`,
          },
        ],
        cta: url ? { label: 'Open your link', url } : undefined,
        outro:
          'If you want the code changed to something else, or you would rather not do this after all, reply to this email and it reaches a person.',
      };
    },
  },
};

/** True when `campaign/step` names a transactional template we can render. */
export function hasTransactional(key: string): boolean {
  return key in TRANSACTIONAL;
}

export const TRANSACTIONAL_KEYS = Object.keys(TRANSACTIONAL);

/**
 * Render one transactional mail from an outbox row.
 *
 * Unlike render() below there is no unsubscribe URL to validate, because there
 * is no unsubscribe link: a mail with no link cannot have a broken one. Which
 * also means these keep working if the lifecycle sequences are ever switched
 * off — they are not part of that decision.
 */
export function renderTransactional(
  key: string,
  params: Record<string, unknown>,
  r: Recipient,
): Rendered {
  const t = TRANSACTIONAL[key];
  if (!t) throw new Error(`no transactional template for ${key}`);
  const block = t.build(params ?? {}, r);
  const o: ShellOpts = { kind: 'transactional', reason: t.reason };
  return {
    subject: block.subject,
    html: shell(block, r, o),
    text: shellText(block, r, o),
    // No List-Unsubscribe header on transactional mail. Gmail requires one on
    // BULK mail; adding it here would advertise an opt-out from a category of
    // one, and the endpoint would opt them out of the lifecycle series instead.
    listUnsubscribe: '',
  };
}

/* ------------------------------------------------------------------- api */

export const STEP_KEYS = Object.keys(TEMPLATES);

/** True when campaign/step names a template we can actually render. */
export function hasTemplate(campaign: string, step: string): boolean {
  return `${campaign}/${step}` in TEMPLATES;
}

/**
 * Render one lifecycle email. Throws on an unknown campaign/step rather than
 * sending something blank — a missing template is a deploy mistake, and the
 * dispatcher logs it as a failure so it shows up in admin_email_stats().
 */
export function render(campaign: string, step: string, r: Recipient): Rendered {
  const t = TEMPLATES[`${campaign}/${step}`];
  if (!t) throw new Error(`no template for ${campaign}/${step}`);

  /*
   * Fail closed on a bad unsubscribe base. If SUPABASE_URL is missing at
   * runtime this resolves to a bare path, and a relative href in an email
   * points nowhere — which would mean sending bulk mail with no working way
   * out of it. That is worse than sending nothing, so it throws here and the
   * dispatcher records a failed render instead.
   */
  if (!/^https:\/\//.test(UNSUB_BASE)) {
    throw new Error(
      `unsubscribe base is not an absolute https url ("${UNSUB_BASE}") — ` +
        'set SUPABASE_URL or EMAIL_UNSUB_BASE',
    );
  }

  const block = t(r);
  const unsub = `${UNSUB_BASE}?t=${encodeURIComponent(r.unsubscribe_token)}`;
  return {
    subject: block.subject,
    html: shell(block, r),
    text: shellText(block, r),
    listUnsubscribe: unsub,
  };
}

export const FROM_NAME = SENDER_NAME;
export const REPLY_TO = LINKS.support;
