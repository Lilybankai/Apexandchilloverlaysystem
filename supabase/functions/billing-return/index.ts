// billing-return — the little page Checkout and the Customer Portal land on.
// -----------------------------------------------------------------------------
// The desktop app can't be a redirect target, so both flows return here: a
// static branded "you're done, go back to the app" page. Deployed with JWT
// verification OFF — it's opened by a browser, not by the app.

const PAGES: Record<string, { title: string; body: string }> = {
  success: {
    title: 'You’re in.',
    body:
      'Your subscription is live. Head back to the Apex Overlay app — it will pick this up within a few seconds.',
  },
  cancel: {
    title: 'Checkout cancelled',
    body: 'No payment was taken. You can restart the subscription from the app any time.',
  },
  portal: {
    title: 'All done',
    body: 'Any billing changes are saved. You can close this tab and head back to the Apex Overlay app.',
  },
};

Deno.serve((req) => {
  const outcome = new URL(req.url).searchParams.get('outcome') ?? 'portal';
  const page = PAGES[outcome] ?? PAGES.portal;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Apex Overlay — ${page.title}</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0b0d10; color: #e8eaed;
    font: 16px/1.6 "Segoe UI", system-ui, sans-serif;
  }
  main { text-align: center; padding: 48px 24px; max-width: 440px; }
  .mark {
    font-weight: 800; letter-spacing: .18em; font-size: 13px;
    color: #9aa3ad; text-transform: uppercase; margin-bottom: 28px;
  }
  .mark b { color: #4ade80; }
  h1 { font-size: 28px; margin: 0 0 12px; }
  p  { color: #b7bec7; margin: 0; }
</style>
</head>
<body>
<main>
  <div class="mark"><b>Apex</b> &amp; Chill · Overlay System</div>
  <h1>${page.title}</h1>
  <p>${page.body}</p>
</main>
</body>
</html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
});
