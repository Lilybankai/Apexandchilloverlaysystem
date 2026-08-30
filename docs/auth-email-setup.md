# Auth email — why reset was broken, and how it is set up

Status: written 2026-08-26 after password reset failed for a tester.

## The bug, in one line

The app asks for a **code**; the Supabase project was emailing a **link**.

`electron/control-panel/auth.html` (the `reset-verify` screen) has a field
placeholded `123456` with `autocomplete="one-time-code"`, and
`electron/auth.js:resetPassword` verifies whatever is typed as a GoTrue
recovery OTP. That is the correct shape for a desktop app. But the project's
**Reset password** email template was never changed from Supabase's stock
`{{ .ConfirmationURL }}`, so the email contained a hyperlink instead.

Clicking that link produced the two symptoms we saw:

- `#error=access_denied&error_code=otp_expired` — the link had already been
  spent. Supabase's own docs name the cause: spam/security scanners
  (Gmail, Microsoft Defender Safe Links) **prefetch URLs in incoming mail**,
  which consumes the one-time token before the human ever clicks.
- `http://localhost:3000` — the Site URL was still the stock default, so the
  post-verify redirect landed on a dead page.

**No application code was at fault and none was changed.**

## Why we send a code, not a link

This is a desktop app. There is no web front end to receive a redirect, and
`supabase/functions/billing-return` already documents the same conclusion for
Stripe: *"The desktop app can't be a redirect target."*

Stripe genuinely needs a browser, so it gets a landing page. Password reset
does not. A 6-digit code typed into the app:

- never leaves the app, so there is no page to host or brand;
- cannot be burned by a link scanner, because there is no link;
- is exactly what the UI was already built to accept.

## Configuration

All of the below is Supabase **dashboard** config, not code. Anyone
reproducing this project from scratch needs to redo it.

### 1. Reset password email template

Authentication → Email Templates → **Reset password**.

Subject (the code in the subject line lets people read it off the
notification without opening the mail):

```
{{ .Token }} is your Apex AIO reset code
```

Body:

```html
<h2>Reset your Apex AIO password</h2>
<p>Enter this code in the app to choose a new password:</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:700">{{ .Token }}</p>
<p>The code expires in one hour. If you didn't ask for this,
   ignore this email — nothing has changed.</p>
```

There must be **no `<a href>` anywhere in this template**. Adding one
reintroduces the prefetch bug.

The one-hour expiry is Authentication → Providers → Email → *Email OTP
Expiration* (3600s). The UI hint on the reset screen already promises an
hour, so keep the two in step.

### 2. Custom SMTP (Resend)

This is **mandatory, not cosmetic**. Supabase's built-in email service
*"will refuse to deliver messages to addresses that are not part of the
project's team"* — every tester outside the Supabase org would get
*Email address not authorized*. It is also rate-limited to a couple of
messages per hour project-wide.

Sending domain: **apexandchillracing.co.uk**

1. Resend → Domains → Add Domain → `apexandchillracing.co.uk`.
2. Add the DNS records Resend shows you. Copy them from the Resend
   dashboard rather than from here — the MX target is region-specific and
   the DKIM key is unique per domain. You will get roughly:
   - a DKIM `TXT` on `resend._domainkey`
   - an SPF `TXT` on the `send` subdomain
   - an `MX` on the `send` subdomain (bounce handling)
   Verification usually lands within minutes; DNS can take up to 48h.
3. Optional but worth doing: a DMARC `TXT` on `_dmarc`, starting at
   `v=DMARC1; p=none; rua=mailto:you@apexandchillracing.co.uk` so you get
   reports without risking legitimate mail.
4. Resend → API Keys → create one with **Sending access** only.
5. Supabase → Authentication → Emails → SMTP Settings → enable, then:
   - Host `smtp.resend.com`
   - Port `465`
   - Username `resend` (literal — not your email)
   - Password the `re_…` API key
   - Sender `noreply@apexandchillracing.co.uk`, sender name `Apex AIO System`
6. Supabase → Authentication → Rate Limits. Enabling custom SMTP drops you
   to a deliberately low **30 emails/hour**. Raise it to something sane for
   the tester group.

Do **not** turn on Resend's click/open tracking. It rewrites URLs in
outbound mail, which would break any auth link — and is pointless for us
since our template has no links.

### 3. Site URL

Authentication → URL Configuration. Site URL is
**`https://apexandchillracing.co.uk`** (the live marketing site), replacing the
stock `http://localhost:3000`.

With the template above nothing redirects there any more, so this is a
safety net rather than a fix — it stops any stray or legacy link landing on
a connection-refused page. Nothing needs adding to the Redirect URLs
allow-list: that governs OAuth/PKCE flows, which this app does not use, and
the Stripe landing pages are hardcoded to the `billing-return` function in
`create-checkout-session/index.ts` rather than going through Site URL.

## Troubleshooting

Auth mail failures show up in the dashboard logs, not in the app. The app
only ever sees a generic 500. To get the real reason:

Logs → Auth, or via the Management API / MCP:

```sql
select timestamp, event_message
from logs
where source = 'auth_logs'
order by timestamp desc
limit 40
```

Look for `"path":"/recover"` with `"level":"error"`. The `error` field
carries the raw SMTP response.

Seen so far:

- **`535 "Invalid username"`** (2026-08-26) — SMTP username was not the
  literal string `resend`. Resend wants username `resend` and the `re_…` API
  key as the password; putting an email address in the username field gives
  exactly this. Host/port were fine.
- **`535 "Authentication credentials invalid"`** (2026-08-26, immediately
  after the above was fixed) — username now accepted, API key rejected. Note
  the wording change between the two: it tells you *which half* of the
  credential pair Resend is unhappy with, so read the exact string rather
  than treating every 535 the same.

  To tell a bad key from a bad paste, test the key directly — a valid key
  returns 200, a revoked or truncated one returns 401:

  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" \
    -H "Authorization: Bearer re_YOUR_KEY" https://api.resend.com/domains
  ```

  Resend reveals a key in full only once, at creation. If it was not copied
  cleanly then, it cannot be recovered — create a new one.
- **`403: Email link is invalid or has expired` / `One-time token not
  found`** on `/verify` — the old link-based template being prefetched by a
  scanner. Should be impossible now the template has no links; if it
  reappears, someone has reintroduced an `<a href>`.

## Trap: email confirmation is currently OFF

As of 2026-08-26, 14 of 18 accounts were auto-confirmed with no email ever
sent. Signup works for everyone *because* confirmation is disabled.

**Do not re-enable "Confirm email" until custom SMTP is verified and
sending.** Turning it on while the built-in service is still in play would
lock out every user who is not a member of the Supabase org — they would
never receive the confirmation and could never sign in.

If confirmation is enabled later, the confirm screen
(`auth.html`, `data-screen="confirm"`) currently only offers a *resend*
button and expects a link. Moving it to a typed code, the way reset works,
would need a code-entry field and a `verifyOtp` call with `type: 'signup'`.
That is the consistent end state: no auth flow in this app should ever
depend on a browser.
