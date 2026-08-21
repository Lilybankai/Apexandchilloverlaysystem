// billing-return — the little page Checkout and the Customer Portal land on.
// -----------------------------------------------------------------------------
// The desktop app can't be a redirect target, so both flows return here.
//
// This is PLAIN TEXT on purpose. Supabase's functions domain refuses to serve
// HTML: whatever Content-Type we set, the gateway rewrites it to `text/plain`
// and adds `X-Content-Type-Options: nosniff` + a `sandbox` CSP, so a browser
// shows the markup as source instead of rendering it. (That is an anti-phishing
// measure on *.supabase.co — it is not something we can override from here.)
//
// The rewritten header also carries NO charset, so the browser falls back to
// Windows-1252 and mangles any UTF-8. Hence: ASCII only. No em dashes, no curly
// quotes, no middot — they arrive as mojibake.
//
// If this page ever needs branding, it has to move off this domain: a Supabase
// custom domain, or a static page hosted anywhere else that we redirect to.
// Deployed with JWT verification OFF — it's opened by a browser, not the app.

const PAGES: Record<string, string> = {
  success: [
    "APEX AIO SYSTEM",
    "",
    "You're in.",
    "",
    'Your subscription is live. Head back to the Apex AIO app - it will',
    'pick this up within a few seconds.',
    '',
    'You can close this tab.',
  ].join('\n'),
  cancel: [
    'APEX AIO SYSTEM',
    '',
    'Checkout cancelled.',
    '',
    'No payment was taken. You can restart the subscription from the app',
    'any time.',
    '',
    'You can close this tab.',
  ].join('\n'),
  portal: [
    'APEX AIO SYSTEM',
    '',
    'All done.',
    '',
    'Any billing changes are saved. Head back to the Apex AIO app - it',
    'will pick this up within a few seconds.',
    '',
    'You can close this tab.',
  ].join('\n'),
};

Deno.serve((req) => {
  const outcome = new URL(req.url).searchParams.get('outcome') ?? 'portal';
  const body = PAGES[outcome] ?? PAGES.portal;
  return new Response(body + '\n', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
});
