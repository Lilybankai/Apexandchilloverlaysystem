// email-dispatch — send whatever lifecycle email is due right now.
// -----------------------------------------------------------------------------
// Woken once an hour by pg_cron (see docs/EMAIL-LIFECYCLE.md). It is the only
// thing that talks to Resend, and it holds no schedule of its own: it asks
// email_lifecycle_due() what is ripe, renders each row from _shared/emails.ts,
// sends it, and writes the outcome back with email_lifecycle_record().
//
// The three properties that matter, in order:
//
//   1. IT CANNOT SEND TWICE. The record call inserts against a unique partial
//      index on the sent rows; a duplicate returns false instead of raising.
//      Two dispatchers running at once therefore cannot double-mail anybody —
//      the loser simply logs a race and moves on. Which also means the safe
//      failure mode of this function is "run it again".
//
//   2. ONE BAD ROW CANNOT STOP THE BATCH. Every send is wrapped; a failure is
//      recorded as a 'failed' row (retried up to three times by the due query)
//      and the loop continues.
//
//   3. IT WILL NOT RUN WITHOUT BEING ASKED BY SOMETHING THAT KNOWS THE SECRET.
//      The endpoint is public — every Supabase function is — so the shared
//      secret is the whole boundary, exactly like STRIPE_WEBHOOK_SECRET.
//
// Modes:
//   POST                     send the due batch
//   POST ?dry=1              render everything due, send nothing, return the
//                            subjects. Safe to run against live data.
//   POST ?to=me@example.com&campaign=trial&step=day3
//                            render one template with sample data and send it
//                            to that address only. Nothing is recorded, no
//                            account is touched — this is the preview path.
//
// Env: RESEND_API_KEY, EMAIL_DISPATCH_KEY, EMAIL_FROM, and the optional
// EMAIL_* overrides documented in _shared/emails.ts.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  render,
  renderTransactional,
  hasTemplate,
  hasTransactional,
  FROM_NAME,
  REPLY_TO,
  STEP_KEYS,
  TRANSACTIONAL_KEYS,
} from '../_shared/emails.ts';

const RESEND_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const DISPATCH_KEY = Deno.env.get('EMAIL_DISPATCH_KEY') ?? '';
const FROM_ADDR = Deno.env.get('EMAIL_FROM') ?? 'support@apexandchillracing.co.uk';
const FROM = `${FROM_NAME} <${FROM_ADDR}>`;

// Resend's default account limit is 2 requests/second. Sending is sequential
// with a gap rather than parallel: a batch is at most a few dozen mails an
// hour, so there is nothing to gain from racing the rate limiter.
const GAP_MS = 600;
const BATCH = 50;

const db = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
);

interface DueRow {
  user_id: string;
  email: string;
  first_name: string;
  campaign: string;
  step: string;
  due_at: string;
  unsubscribe_token: string;
  variant: string;
  opened_app: boolean;
  trial_end: string | null;
  days_left: number | null;
}

/** A row of public.email_outbox — transactional mail. See migration 0029. */
interface OutboxRow {
  id: number;
  user_id: string | null;
  email: string;
  template: string;
  params: Record<string, unknown> | null;
  attempts: number;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // The boundary. A missing EMAIL_DISPATCH_KEY means the function was deployed
  // before its secret was set, and that must fail closed, not open.
  const given = req.headers.get('x-dispatch-key') ?? '';
  if (!DISPATCH_KEY || given !== DISPATCH_KEY) {
    return json({ error: 'forbidden' }, 403);
  }
  if (!RESEND_KEY) return json({ error: 'RESEND_API_KEY is not set' }, 500);

  const url = new URL(req.url);
  const dry = url.searchParams.get('dry') === '1';
  const preview = url.searchParams.get('to');

  /* ------------------------------------------------------- preview mode */
  if (preview) {
    const campaign = url.searchParams.get('campaign') ?? 'trial';
    const step = url.searchParams.get('step') ?? 'day0';

    // Transactional templates preview through the same endpoint, with sample
    // params — the point of the preview path is to read every mail we can send
    // on a phone before anybody else does, and that includes these.
    if (hasTransactional(`${campaign}/${step}`)) {
      const code = url.searchParams.get('code') ?? 'CRAIG';
      const mail = renderTransactional(
        `${campaign}/${step}`,
        {
          code,
          url: `https://apexandchillracing.co.uk/r/${code}`,
          overlay_url: `https://apexandchillracing.co.uk/r/${code}/overlay`,
          percent_off: 10,
        },
        { first_name: url.searchParams.get('name') ?? 'Carl', unsubscribe_token: '' },
      );
      const sent = await sendOne(preview, mail);
      return json({ preview: `${campaign}/${step}`, to: preview, transactional: true, ...sent });
    }

    if (!hasTemplate(campaign, step)) {
      return json(
        {
          error: `no such template: ${campaign}/${step}`,
          known: STEP_KEYS,
          transactional: TRANSACTIONAL_KEYS,
        },
        400,
      );
    }
    const mail = render(campaign, step, {
      first_name: url.searchParams.get('name') ?? 'Carl',
      // A token that belongs to nobody: the preview's unsubscribe link is
      // deliberately inert, so clicking it while testing cannot opt out a real
      // account. email_lifecycle_unsubscribe() just returns false for it.
      unsubscribe_token: '00000000-0000-0000-0000-000000000000',
      variant: url.searchParams.get('variant') ?? 'convert',
      opened_app: url.searchParams.get('opened') !== '0',
      days_left: Number(url.searchParams.get('daysLeft') ?? '1'),
    });
    const sent = await sendOne(preview, mail);
    return json({ preview: `${campaign}/${step}`, to: preview, ...sent });
  }

  /* --------------------------------------------------------- the outbox */
  /*
   * Transactional mail goes FIRST, and goes even when the lifecycle sequences
   * are switched off. It is somebody waiting for an answer they were promised
   * — an approved partner application, today — rather than a marketing step,
   * so `email_settings.enabled` does not apply to it and neither do quiet
   * hours. The queue, the retry limit and the suppression check all live in
   * email_outbox_due(); this loop only renders and sends.
   */
  const outbox = await drainOutbox(dry);

  /* ----------------------------------------------------------- the batch */
  const { data, error } = await db.rpc('email_lifecycle_due', { p_limit: BATCH });
  if (error) {
    console.error('[email-dispatch] due query failed:', error.message);
    // The outbox already ran and its result is real work; report it rather
    // than throwing it away because the OTHER queue could not be read.
    return json({ error: 'due query failed', outbox }, 500);
  }
  const due = (data ?? []) as DueRow[];

  const result = {
    due: due.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    raced: 0,
    dry,
    outbox,
    steps: [] as string[],
  };

  for (const row of due) {
    const label = `${row.campaign}/${row.step}`;

    // A step in the schedule with no template is a deploy mistake. Record it
    // as skipped so it stops being offered every hour and shows up in the
    // admin card, rather than silently retrying forever.
    if (!hasTemplate(row.campaign, row.step)) {
      console.error(`[email-dispatch] no template for ${label}`);
      await record(row, '', 'skipped', '', 'no template');
      result.skipped++;
      continue;
    }

    let mail;
    try {
      mail = render(row.campaign, row.step, {
        first_name: row.first_name ?? '',
        unsubscribe_token: row.unsubscribe_token,
        variant: row.variant,
        opened_app: row.opened_app,
        days_left: row.days_left,
      });
    } catch (e) {
      console.error(`[email-dispatch] render ${label}:`, e);
      await record(row, '', 'failed', '', `render: ${String(e)}`);
      result.failed++;
      continue;
    }

    if (dry) {
      result.steps.push(`${label} → ${row.email}: ${mail.subject}`);
      continue;
    }

    const out = await sendOne(row.email, mail);
    if (out.ok) {
      // The record is what makes the send unrepeatable, so a false here means
      // another dispatcher got there first — not an error, but worth counting.
      const written = await record(row, mail.subject, 'sent', out.id ?? '', '');
      if (written) result.sent++;
      else result.raced++;
      result.steps.push(`${label} → ${row.email}`);
    } else {
      await record(row, mail.subject, 'failed', '', out.error ?? 'send failed');
      result.failed++;
      console.error(`[email-dispatch] send ${label} to ${row.email}: ${out.error}`);
    }

    await sleep(GAP_MS);
  }

  console.log(
    `[email-dispatch] due=${result.due} sent=${result.sent} failed=${result.failed} ` +
      `skipped=${result.skipped} raced=${result.raced} dry=${dry} ` +
      `outbox=${outbox.due}/${outbox.sent}`,
  );
  return json(result);
});

/* ---------------------------------------------------------------- outbox */

/**
 * Send whatever transactional mail is queued.
 *
 * Every outcome is written back with `email_outbox_record`, which owns the
 * retry policy: a failure stays queued until the third attempt and is then
 * final. So the safe failure mode here is the same as everywhere else in this
 * function — run it again.
 *
 * A row whose template does not exist is recorded as a failure rather than
 * being skipped silently. It can only mean the database queued something this
 * deployment does not know how to render, which is a deploy that went out in
 * the wrong order, and it has to be visible.
 */
async function drainOutbox(dry: boolean) {
  const out = { due: 0, sent: 0, failed: 0, mails: [] as string[] };

  const { data, error } = await db.rpc('email_outbox_due', { p_limit: 25 });
  if (error) {
    // An older database with no 0029 has no such function. That is not an
    // error worth failing the run over — there is simply no outbox yet.
    if (!/does not exist|schema cache/i.test(error.message)) {
      console.error('[email-dispatch] outbox query failed:', error.message);
    }
    return out;
  }

  const rows = (data ?? []) as OutboxRow[];
  out.due = rows.length;

  for (const row of rows) {
    if (!hasTransactional(row.template)) {
      console.error(`[email-dispatch] no transactional template for ${row.template}`);
      await db.rpc('email_outbox_record', {
        p_id: row.id,
        p_ok: false,
        p_subject: '',
        p_provider_id: '',
        p_error: `no template for ${row.template}`,
      });
      out.failed++;
      continue;
    }

    let mail;
    try {
      mail = renderTransactional(row.template, row.params ?? {}, {
        first_name: String((row.params ?? {}).first_name ?? ''),
        // Never read by a transactional template — there is no unsubscribe
        // link — but the Recipient shape is shared with the lifecycle mail.
        unsubscribe_token: '',
      });
    } catch (e) {
      console.error(`[email-dispatch] render ${row.template}:`, e);
      await db.rpc('email_outbox_record', {
        p_id: row.id,
        p_ok: false,
        p_subject: '',
        p_provider_id: '',
        p_error: `render: ${String(e)}`.slice(0, 400),
      });
      out.failed++;
      continue;
    }

    if (dry) {
      out.mails.push(`${row.template} → ${row.email}: ${mail.subject}`);
      continue;
    }

    const res = await sendOne(row.email, mail);
    await db.rpc('email_outbox_record', {
      p_id: row.id,
      p_ok: res.ok,
      p_subject: mail.subject,
      p_provider_id: res.id ?? '',
      p_error: res.ok ? '' : (res.error ?? 'send failed').slice(0, 400),
    });
    if (res.ok) {
      out.sent++;
      out.mails.push(`${row.template} → ${row.email}`);
    } else {
      out.failed++;
      console.error(`[email-dispatch] outbox ${row.template} to ${row.email}: ${res.error}`);
    }
    await sleep(GAP_MS);
  }

  return out;
}

/* ------------------------------------------------------------------ send */

async function sendOne(
  to: string,
  mail: { subject: string; html: string; text: string; listUnsubscribe: string },
): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        reply_to: REPLY_TO,
        // RFC 8058. Gmail and Yahoo require a working one-click unsubscribe on
        // BULK mail; without both of these headers together they treat the whole
        // domain as a worse sender. Transactional mail (an empty
        // listUnsubscribe) gets neither: advertising an opt-out from a category
        // of one would point at the lifecycle endpoint and quietly opt them out
        // of a series they are not in.
        headers: mail.listUnsubscribe
          ? {
              'List-Unsubscribe': `<${mail.listUnsubscribe}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            }
          : {},
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `resend ${res.status}: ${body.slice(0, 300)}` };
    }
    const body = (await res.json()) as { id?: string };
    return { ok: true, id: body.id ?? '' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function record(
  row: DueRow,
  subject: string,
  status: 'sent' | 'failed' | 'skipped',
  providerId: string,
  err: string,
): Promise<boolean> {
  const { data, error } = await db.rpc('email_lifecycle_record', {
    p_user_id: row.user_id,
    p_email: row.email,
    p_campaign: row.campaign,
    p_step: row.step,
    p_subject: subject,
    p_status: status,
    p_provider_id: providerId,
    p_error: err,
  });
  if (error) {
    // The mail is already gone; failing to log it is bad but not worth
    // throwing, because the next run would then send it again.
    console.error('[email-dispatch] record failed:', error.message);
    return true;
  }
  return data !== false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
