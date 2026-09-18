// discord-dispatch — turn due notification rows into Discord messages.
// -----------------------------------------------------------------------------
// Woken every minute by pg_cron (see docs/DISCORD-NOTIFICATIONS.md). It holds no
// routing rules of its own: fanout_notification_events() decides who hears about
// what, claim_notifications() hands over the due rows, and this function's only
// job is to render an embed, post it, and write the outcome back.
//
// The four properties that matter, in order:
//
//   1. IT CANNOT POST TWICE. Claiming is `for update skip locked` and flips the
//      row to 'sending' in the same statement, so two dispatchers running at
//      once cannot both take the same row. The safe failure mode is "run it
//      again".
//
//   2. IT EDITS RATHER THAN REPEATS. A driver improving their own record four
//      times in one practice session is one message that changes, not four that
//      accumulate — claim_notifications hands back `edit_message_id` when this
//      channel showed the same board and driver in the last half hour, and the
//      post becomes a PATCH. This is why every POST carries ?wait=true: without
//      it Discord answers 204 with no body and the chance to edit is gone.
//
//   3. IT NEVER PINGS. `allowed_mentions: { parse: [] }` on every payload. A
//      driver display name is user-supplied text on its way into someone else's
//      Discord, and without this a driver called "@everyone" is an incident in
//      forty servers at once.
//
//   4. A DEAD CHANNEL PAUSES ITSELF. A webhook deleted in Discord answers 404
//      for ever; retrying that until the end of time is how a queue fills up.
//      404/401/403 are permanent — the row fails and the channel is paused with
//      the reason on it, for the admin to see in the app.
//
// Modes:
//   POST            fan out, then send the due batch
//   POST ?dry=1     fan out, claim nothing, return what would have been sent
//
// Env: DISCORD_DISPATCH_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'jsr:@supabase/supabase-js@2';

// Trimmed: a secret pasted into the dashboard arrives with the newline it was
// copied with, and 65 characters never equals 64. Found the hard way on
// 2026-09-18 — every minute a 403, and the value looked right on screen.
const DISPATCH_KEY = (Deno.env.get('DISCORD_DISPATCH_KEY') ?? '').trim();

// Discord's per-webhook limit is 5 requests/second, and a burst of records is
// at most a few dozen. Sequential with a gap beats racing the rate limiter.
const GAP_MS = 250;
const BATCH = 25;

const db = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
);

interface Claimed {
  id: number;
  webhook_url: string;
  axis: string;
  payload: Record<string, unknown>;
  edit_message_id: string | null;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // The boundary. A missing key means the function was deployed before its
  // secret was set, and that fails closed, not open.
  const given = (req.headers.get('x-dispatch-key') ?? '').trim();
  if (!DISPATCH_KEY || given !== DISPATCH_KEY) {
    return json({ error: 'forbidden' }, 403);
  }

  const dry = new URL(req.url).searchParams.get('dry') === '1';

  /* ------------------------------------------------------------- fan out */
  // Always first: an event with no outbox rows yet is invisible to the claim.
  const fan = await db.rpc('fanout_notification_events', { p_limit: 200 });
  if (fan.error) {
    console.error('[discord-dispatch] fanout failed:', fan.error.message);
    return json({ error: 'fanout failed' }, 500);
  }

  /* --------------------------------------------------------- the batch */
  if (dry) {
    return json({ fanned: fan.data ?? 0, dry: true });
  }

  const { data, error } = await db.rpc('claim_notifications', { p_limit: BATCH });
  if (error) {
    console.error('[discord-dispatch] claim failed:', error.message);
    return json({ error: 'claim failed' }, 500);
  }
  const rows = (data ?? []) as Claimed[];

  const result = { fanned: fan.data ?? 0, claimed: rows.length, sent: 0, edited: 0, failed: 0 };

  for (const row of rows) {
    try {
      const body = JSON.stringify({
        username: 'Apex AIO System',
        // Never a ping, whatever a driver has called themselves.
        allowed_mentions: { parse: [] },
        embeds: [embedFor(row.payload)],
      });

      // An edit keeps the channel to one message per board per driver per
      // session; a fresh post asks for the id back so the NEXT improvement can
      // edit this one.
      const editing = !!row.edit_message_id;
      const url = editing
        ? `${row.webhook_url}/messages/${row.edit_message_id}`
        : `${row.webhook_url}?wait=true`;

      const res = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (res.ok) {
        const sent = await res.json().catch(() => ({} as Record<string, unknown>));
        // On an edit we keep the id we already had: PATCH returns the same
        // message, but a parse failure must not lose the thread.
        const id = String(sent?.id ?? row.edit_message_id ?? '');
        await db.rpc('mark_notification_sent', { p_id: row.id, p_message_id: id });
        if (editing) result.edited++;
        else result.sent++;
      } else if (res.status === 429) {
        // Discord's own back-off, honoured to the second it asks for.
        const retry = Number(res.headers.get('retry-after') ?? '5');
        const at = new Date(Date.now() + Math.min(Math.max(retry, 1), 900) * 1000);
        await db.rpc('mark_notification_failed', {
          p_id: row.id,
          p_error: `rate limited, retry in ${retry}s`,
          p_permanent: false,
          p_retry_at: at.toISOString(),
        });
        result.failed++;
      } else {
        // 404 = the webhook was deleted in Discord. 401/403 = the token was
        // rotated or the channel locked. None of those get better by waiting.
        const permanent = res.status === 404 || res.status === 401 || res.status === 403;
        const text = (await res.text().catch(() => '')).slice(0, 200);
        // An edit that 404s is the MESSAGE being gone, not the webhook — that
        // one retries as a fresh post rather than pausing the whole channel.
        const messageGone = editing && res.status === 404;
        await db.rpc('mark_notification_failed', {
          p_id: row.id,
          p_error: `HTTP ${res.status}${text ? `: ${text}` : ''}`,
          p_permanent: permanent && !messageGone,
          p_retry_at: messageGone ? new Date(Date.now() + 5000).toISOString() : null,
        });
        result.failed++;
      }
    } catch (err) {
      // One bad row cannot stop the batch.
      console.error('[discord-dispatch] send threw:', err);
      await db.rpc('mark_notification_failed', {
        p_id: row.id,
        p_error: String(err).slice(0, 200),
        p_permanent: false,
        p_retry_at: null,
      });
      result.failed++;
    }

    await sleep(GAP_MS);
  }

  return json(result);
});

/* -------------------------------------------------------------------------- */
/*  The embed                                                                 */
/* -------------------------------------------------------------------------- */

// One message per event, carrying however many achievements it earned. MyLMU
// posts one embed per achievement and stacks nine full-width fields under it,
// which on a phone is most of a screen for a lap time; these are three inline
// fields and a sentence.
const STYLES: Record<string, { colour: number; title: string }> = {
  record_taken:    { colour: 0xe23c3c, title: '⚔️ Record taken' },
  record_set:      { colour: 0xf5b301, title: '🏆 New record' },
  record_extended: { colour: 0x4a9d5b, title: '⏱️ Record improved' },
  session_result:  { colour: 0x8a8f98, title: '🏁 Race result' },
};

const CONDITIONS: Record<string, string> = {
  dry: '☀️ Dry',
  damp: '🌥️ Damp',
  wet: '🌧️ Wet',
};

function embedFor(p: Record<string, unknown>) {
  const kind = String(p.kind ?? 'record_set');
  const style = STYLES[kind] ?? STYLES.record_set;

  if (kind === 'session_result') return resultEmbed(p, style);

  const driver = clean(p.driver, 'A driver');
  const track = clean(p.track, 'an unknown circuit');
  const carClass = clean(p.car_class, '');
  const car = clean(p.car, '');
  const lap = lapTime(p.lap_ms);
  const holder = clean(p.holder, '');
  const gap = Number(p.gap_ms ?? 0);

  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: 'Lap', value: `**${lap}**`, inline: true },
    {
      name: 'Car',
      value: car && carClass ? `${car}\n${carClass}` : car || carClass || '—',
      inline: true,
    },
    {
      name: 'Track',
      value: CONDITIONS[String(p.condition ?? 'dry')] ?? 'Dry',
      inline: true,
    },
  ];

  // The previous record is the whole story of a `record_taken`, so it gets its
  // own line rather than being a field nobody reads: who held it, by how much
  // it fell, and how long they had it.
  if (holder && Number.isFinite(gap) && gap > 0) {
    const held = heldFor(p.held_since);
    fields.push({
      name: 'Previous',
      value:
        `${lapTime(p.previous_ms)} — ${holder}\n` +
        `beaten by **${(gap / 1000).toFixed(3)}s**${held ? ` · stood for ${held}` : ''}`,
      inline: false,
    });
  }

  // Session type is the honest label on a solo hotlap. A record set alone on a
  // clean track is still a record; hiding that it was is how a feed loses the
  // room.
  const session = clean(p.session_type, '');
  if (session) {
    fields.push({ name: 'Session', value: titleCase(session), inline: true });
  }

  return {
    color: style.colour,
    title: `${style.title} — ${track}`,
    description:
      kind === 'record_taken'
        ? `**${driver}** takes the ${carClass || 'class'} record from **${holder || 'the board'}**.`
        : kind === 'record_extended'
          ? `**${driver}** improves their own ${carClass || 'class'} record.`
          : `**${driver}** sets the ${carClass || 'class'} record.`,
    fields,
    footer: { text: 'Apex AIO System' },
    timestamp: isoOrNow(p.set_at),
  };
}

/**
 * A race, not a driver.
 *
 * MyLMU posts one embed per driver it knows about, which for a league running
 * the same daily is a dozen embeds saying a dozen positions. This is the whole
 * event once: the podium, how big the field was, and then — the part the
 * channel actually cares about — how this community's own drivers got on.
 *
 * `mine` is resolved per channel by the fan-out, because who counts as "ours"
 * depends on which Discord this copy is going to. It can be empty, and the
 * embed simply does not have that section: the podium of a race your league
 * ran is still worth reading.
 */
function resultEmbed(p: Record<string, unknown>, style: { colour: number; title: string }) {
  const podium = Array.isArray(p.podium) ? (p.podium as Record<string, unknown>[]) : [];
  const mine = Array.isArray(p.mine) ? (p.mine as Record<string, unknown>[]) : [];
  const name = clean(p.name, '');
  const track = clean(p.track, 'an unknown circuit');
  const entries = Number(p.entries ?? 0);

  const STEPS = ['🥇', '🥈', '🥉'];
  const places = podium
    .slice(0, 3)
    .map((row, i) => `${STEPS[i] ?? '•'} ${clean(row.name, 'A driver')}${
      row.bestLapMs ? ` — ${lapTime(row.bestLapMs)}` : ''
    }`)
    .join('\n');

  const fields: { name: string; value: string; inline: boolean }[] = [];

  if (mine.length) {
    fields.push({
      name: mine.length === 1 ? 'Your driver' : 'Your drivers',
      // Capped: a league with thirty people in one race is a wall of text, and
      // Discord stops accepting the embed long before it stops being unreadable.
      value: mine
        .slice(0, 15)
        .map((row) => {
          const pos = Number(row.pos);
          const bits = [
            row.bestLapMs ? `best ${lapTime(row.bestLapMs)}` : '',
            Number.isFinite(Number(row.laps)) ? `${Number(row.laps)} laps` : '',
            clean(row.status, '') && String(row.status).toLowerCase() !== 'finished'
              ? clean(row.status, '')
              : '',
          ].filter(Boolean);
          return `**P${Number.isFinite(pos) ? pos : '?'}** ${clean(row.name, 'A driver')}${
            bits.length ? ` · ${bits.join(' · ')}` : ''
          }`;
        })
        .join('\n')
        .slice(0, 1024),
      inline: false,
    });
    if (mine.length > 15) {
      fields.push({ name: '​', value: `…and ${mine.length - 15} more`, inline: false });
    }
  }

  return {
    color: style.colour,
    title: `${style.title} — ${name || track}`,
    description:
      `${name ? `${track}\n` : ''}${places || 'No classification published.'}` +
      (entries ? `\n\n${entries} classified` : ''),
    fields,
    footer: { text: 'Apex AIO System' },
    timestamp: isoOrNow(p.started_at),
  };
}

/* -------------------------------------------------------------------------- */
/*  Formatting                                                                */
/* -------------------------------------------------------------------------- */

function lapTime(ms: unknown): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const m = Math.floor(n / 60000);
  const s = Math.floor((n % 60000) / 1000);
  const thousandths = Math.floor(n % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(thousandths).padStart(3, '0')}`;
}

function heldFor(since: unknown): string {
  const t = Date.parse(String(since ?? ''));
  if (!Number.isFinite(t)) return '';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 60) return `${Math.max(mins, 1)} min`;
  if (mins < 60 * 48) return `${Math.floor(mins / 60)} h`;
  return `${Math.floor(mins / 1440)} days`;
}

// Driver and car names are user-supplied text going into someone else's
// Discord. The mention parse is already off; this stops the markdown from
// mangling the embed and caps the length.
function clean(value: unknown, fallback: string): string {
  const s = String(value ?? '').replace(/[`*_~|\\]/g, '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 80) : fallback;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isoOrNow(value: unknown): string {
  const t = Date.parse(String(value ?? ''));
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
