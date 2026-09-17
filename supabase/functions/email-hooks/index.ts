// email-hooks — Resend's webhook: hard bounces and spam complaints.
// -----------------------------------------------------------------------------
// Deploy with --no-verify-jwt (Resend does not carry a Supabase JWT) and point
// a Resend webhook at it for `email.bounced` and `email.complained`.
//
// Why this exists at all: a sequence that keeps mailing a dead address, or
// someone who pressed "spam", is how a sending domain gets itself filtered.
// One complaint from a person who never wanted the mail costs more reputation
// than the entire sequence earns. So both outcomes land in email_suppressions,
// which email_lifecycle_due() checks by ADDRESS before every send — the unit
// Resend reports in, and the unit the mailbox providers judge us on.
//
// Authentication is Resend's Svix signature, verified here by hand rather than
// by pulling the svix package in: it is one HMAC, and the same shape as the
// Stripe webhook's check next door. An unsigned or badly signed request is
// refused — this endpoint can suppress an address, so it is not open to
// anyone who finds the URL.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SECRET = Deno.env.get('RESEND_WEBHOOK_SECRET') ?? '';

const db = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  if (!SECRET) {
    console.error('[email-hooks] RESEND_WEBHOOK_SECRET is not set — refusing');
    return new Response('not configured', { status: 500 });
  }

  const raw = await req.text();
  if (!(await verify(req, raw))) {
    return new Response('bad signature', { status: 400 });
  }

  let event: { type?: string; data?: { to?: string[] | string; bounce?: { message?: string } } };
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response('bad json', { status: 400 });
  }

  const to = Array.isArray(event.data?.to) ? event.data?.to[0] : event.data?.to;
  const type = event.type ?? '';

  // Only these two suppress. A delivery, an open or a click is Resend's
  // business, not ours — we deliberately do not track opens.
  const reason =
    type === 'email.bounced' ? 'bounce' : type === 'email.complained' ? 'complaint' : null;

  if (reason && to) {
    const { error } = await db.rpc('email_suppress', {
      p_email: to,
      p_reason: reason,
      p_detail: event.data?.bounce?.message ?? type,
    });
    if (error) {
      console.error('[email-hooks] suppress failed:', error.message);
      // 500 so Resend retries: losing a suppression is the failure that
      // actually costs us something.
      return new Response('suppress failed', { status: 500 });
    }
    console.log(`[email-hooks] suppressed ${to} (${reason})`);
  }

  return new Response('ok', { status: 200 });
});

/**
 * Svix signature check: HMAC-SHA256 over `id.timestamp.body`, keyed with the
 * base64 body of the whsec_ secret, compared against any of the space-separated
 * `v1,` signatures in the header (Svix sends more than one during a rotation).
 */
async function verify(req: Request, raw: string): Promise<boolean> {
  const id = req.headers.get('svix-id') ?? '';
  const ts = req.headers.get('svix-timestamp') ?? '';
  const sigHeader = req.headers.get('svix-signature') ?? '';
  if (!id || !ts || !sigHeader) return false;

  // Reject anything more than five minutes old, so a captured request cannot
  // be replayed later.
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;

  const keyBytes = base64ToBytes(SECRET.replace(/^whsec_/, ''));
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${raw}`));
  const expected = bytesToBase64(new Uint8Array(mac));

  return sigHeader
    .split(' ')
    .map((p) => p.split(',')[1] ?? '')
    .some((s) => timingSafeEqual(s, expected));
}

/** Constant-time compare, so the check cannot be walked one character at a time. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
