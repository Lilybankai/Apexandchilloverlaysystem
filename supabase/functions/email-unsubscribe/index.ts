// email-unsubscribe — the "stop these emails" link at the foot of every mail.
// -----------------------------------------------------------------------------
// Deploy with --no-verify-jwt: the person clicking is reading their inbox, not
// signed into anything. The token in the URL is the only credential, which is
// why it is a random uuid per account (email_prefs.unsubscribe_token) and never
// the address itself.
//
// GET DOES NOT UNSUBSCRIBE. This is the same trap that broke password reset —
// see docs/auth-email-setup.md: Gmail and Microsoft Defender PREFETCH links in
// incoming mail, so a GET that acts would opt people out of a sequence they
// never even opened. GET therefore renders a page with one button, and the
// button POSTs.
//
// The exception is deliberate and required: RFC 8058 one-click unsubscribe,
// which Gmail and Yahoo demand on bulk mail, sends a POST straight to this URL
// from the mail client's own "unsubscribe" control. A POST is a considered
// action by definition, so it acts immediately — that is the whole point of
// the standard, and the reason the List-Unsubscribe-Post header exists.
//
// The response is the same whether or not the token was real. A link that says
// "unknown token" is a token oracle.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const db = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
);

const C = {
  bg: '#060a12',
  panel: '#0c111c',
  line: '#1d2536',
  text: '#f4f6fb',
  text2: '#9aa4b8',
  text3: '#66708a',
  blue: '#309be1',
  cyan: '#26bbf4',
  purple: '#6a2fd6',
  ok: '#35d07f',
};
const FONT = "'Segoe UI', Roboto, -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif";

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // The token can arrive in the query string (our own link) or in the form
  // body (a mail client's one-click control posting the whole URL back).
  let token = url.searchParams.get('t') ?? '';
  if (req.method === 'POST') {
    try {
      const ct = req.headers.get('content-type') ?? '';
      if (ct.includes('form')) {
        const form = await req.formData();
        token = (form.get('t') as string) || token;
      }
    } catch {
      /* the query-string token stands */
    }
  }

  if (req.method === 'GET') {
    return page(confirmBody(token), 200);
  }
  if (req.method !== 'POST') {
    return page(messageBody('Not found', 'That link does not lead anywhere.'), 405);
  }

  if (isUuid(token)) {
    const { error } = await db.rpc('email_lifecycle_unsubscribe', { p_token: token });
    if (error) console.error('[email-unsubscribe]', error.message);
  }

  // Same page for a good token, a bad token, and a database that just fell
  // over. The reader's experience of "I have unsubscribed" must not depend on
  // our internals, and an honest error here would only invite a retry loop.
  return page(
    messageBody(
      "You're unsubscribed.",
      'You will not get any more of these emails. Your account and your subscription are untouched — nothing else has changed.',
    ),
    200,
  );
});

function confirmBody(token: string): string {
  const t = isUuid(token) ? token : '';
  return `
    <h1 style="margin:0 0 12px;font:700 26px/32px ${FONT};color:${C.text}">
      Stop these emails?
    </h1>
    <p style="margin:0 0 22px;font:400 15px/23px ${FONT};color:${C.text2}">
      This turns off the short series of emails about the app. It does not
      cancel your subscription, delete your account, or stop the ones you
      actually need — password resets and receipts still arrive.
    </p>
    <form method="POST" style="margin:0">
      <input type="hidden" name="t" value="${escapeAttr(t)}">
      <button type="submit" style="display:inline-block;padding:13px 26px;border:0;
        border-radius:8px;background:${C.blue};color:#fff;font:700 15px/1 ${FONT};cursor:pointer">
        Yes, stop them
      </button>
    </form>
    <p style="margin:22px 0 0;font:400 13px/20px ${FONT};color:${C.text3}">
      Changed your mind? Close this tab — nothing happens until you press the button.
    </p>`;
}

function messageBody(title: string, detail: string): string {
  return `
    <h1 style="margin:0 0 12px;font:700 26px/32px ${FONT};color:${C.text}">${title}</h1>
    <p style="margin:0 0 8px;font:400 15px/23px ${FONT};color:${C.text2}">${detail}</p>
    <p style="margin:18px 0 0;font:400 13px/20px ${FONT};color:${C.text3}">
      If you meant to do something else, reply to any of our emails and a person will read it.
    </p>`;
}

function page(inner: string, status: number): Response {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Apex AIO System — email preferences</title>
</head>
<body style="margin:0;background:${C.bg};padding:40px 16px;font-family:${FONT}">
  <div style="max-width:520px;margin:0 auto;background:${C.panel};border:1px solid ${C.line};
              border-radius:14px;overflow:hidden">
    <div style="height:4px;background:${C.blue};
                background-image:linear-gradient(120deg,${C.blue} 0%,${C.cyan} 45%,${C.purple} 100%)"></div>
    <div style="padding:32px 30px 34px">
      <div style="font:700 12px/1 ${FONT};letter-spacing:1.4px;text-transform:uppercase;
                  color:${C.text3};margin-bottom:18px">Apex AIO System</div>
      ${inner}
    </div>
  </div>
</body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Nothing here should sit in a proxy or a scanner's cache.
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const escapeAttr = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
