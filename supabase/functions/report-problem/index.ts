// report-problem — a bug report from the app becomes a Linear issue, logs attached.
// -----------------------------------------------------------------------------
// THE-32. Tester bugs used to arrive as Discord messages and screenshots, then
// someone dug stalls.log / updater.log out of %APPDATA% by hand. The Suggestions
// tab's "Bug report" now posts here instead, with those logs (tail only, the
// Windows user name already scrubbed by electron/problemReport.js).
//
// Two writes, in this order:
//   1. A feedback row, kind 'bug' — the durable record. It is what the admin
//      inbox lists, what the league replies on, what delete-account erases,
//      and what the rate limit counts. If only this lands, the report still
//      reached the league.
//   2. A Linear issue in team THE labelled Tester report + Bug, the logs
//      uploaded as files and linked from the description. Its id goes back on
//      the row (0040) so delete-account can find and delete it.
// A Linear failure (or no LINEAR_API_KEY yet) is logged and the call still
// succeeds: the driver did their part.
//
// Secrets: LINEAR_API_KEY (required for step 2). Optional overrides:
// LINEAR_TEAM_ID, LINEAR_LABEL_IDS (comma-separated), LINEAR_PROJECT_ID.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createIssue, linearKey, uploadText } from '../_shared/linear.ts';

// Team THE and its Tester report + Bug labels. Ids, not secrets.
const DEFAULT_TEAM_ID = 'a521b3aa-c9fb-4b42-963f-25d78dfe3e3f';
const DEFAULT_LABEL_IDS = [
  'ed81297a-4dfd-4071-8ad2-5405e0600534', // Tester report
  'd2a7411b-af29-433f-8746-10b168477aa6', // Bug
];

// Per account. A tester mid-event may genuinely hit three things in an hour;
// more than that is a loop or a stuck button, and each one is a Linear issue.
const LIMIT_HOUR = 3;
const LIMIT_DAY = 10;

const ALLOWED_LOGS = new Set(['stalls.log', 'updater.log']);
const MAX_LOG_CHARS = 256 * 1024;
const MAX_MESSAGE = 4000;

type LogIn = { name?: unknown; text?: unknown; truncated?: unknown };
type Body = { message?: unknown; appVersion?: unknown; os?: unknown; channel?: unknown; logs?: unknown };

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: Body = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Bad request.' }, 400);
  }
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, MAX_MESSAGE) : '';
  if (!message) return json({ error: 'Type a message first.' }, 400);
  const appVersion = str(body.appVersion, 32);
  const osName = str(body.os, 64);
  const channel = str(body.channel, 16);
  const logs = (Array.isArray(body.logs) ? (body.logs as LogIn[]) : [])
    .filter((l) => typeof l?.name === 'string' && ALLOWED_LOGS.has(l.name) && typeof l.text === 'string')
    .slice(0, ALLOWED_LOGS.size)
    .map((l) => ({
      name: l.name as string,
      text: (l.text as string).slice(-MAX_LOG_CHARS),
      truncated: l.truncated === true || (l.text as string).length > MAX_LOG_CHARS,
    }));

  const auth = req.headers.get('Authorization') ?? '';
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: auth } } },
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return json({ error: 'Sign in to send a bug report.' }, 401);

  const db = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  // Rate limit, counted from the rows themselves — nothing else to keep in step.
  const dayAgo = new Date(Date.now() - 24 * 3600_000);
  const { data: recent, error: recentErr } = await db
    .from('feedback')
    .select('created_at')
    .eq('user_id', user.id)
    .eq('kind', 'bug')
    .gte('created_at', dayAgo.toISOString())
    .order('created_at', { ascending: false })
    .limit(LIMIT_DAY);
  if (recentErr) {
    console.error('report-problem: rate-limit read failed', recentErr);
    return json({ error: 'Could not send right now — try again shortly.' }, 500);
  }
  const hourAgo = Date.now() - 3600_000;
  const inHour = (recent ?? []).filter((r) => Date.parse(r.created_at) >= hourAgo).length;
  if (inHour >= LIMIT_HOUR || (recent ?? []).length >= LIMIT_DAY) {
    return json(
      { error: 'You’ve sent several bug reports recently — thanks! Give it a while before sending another.' },
      429,
    );
  }

  // 1. The durable record.
  const { data: row, error: insErr } = await db
    .from('feedback')
    .insert({ user_id: user.id, kind: 'bug', message, app_version: appVersion })
    .select('id')
    .single();
  if (insErr || !row) {
    console.error('report-problem: feedback insert failed', insErr);
    return json({ error: 'Could not send right now — try again shortly.' }, 500);
  }

  // 2. The Linear issue. Best effort.
  let issue: string | null = null;
  if (linearKey()) {
    try {
      const { data: profile } = await db
        .from('profiles')
        .select('display_name')
        .eq('id', user.id)
        .maybeSingle();
      const driver = (profile?.display_name || '').trim() || 'Driver';

      const links: string[] = [];
      for (const log of logs) {
        try {
          const url = await uploadText(log.name, log.text);
          links.push(`- [${log.name}](${url})${log.truncated ? ' — last part only' : ''}`);
        } catch (err) {
          console.error(`report-problem: upload ${log.name} failed`, err);
          links.push(`- ${log.name} — upload failed`);
        }
      }

      const created = await createIssue({
        teamId: Deno.env.get('LINEAR_TEAM_ID') || DEFAULT_TEAM_ID,
        title: titleFrom(message, appVersion),
        description: describe({ message, driver, appVersion, osName, channel, feedbackId: row.id, links }),
        labelIds: (Deno.env.get('LINEAR_LABEL_IDS') || DEFAULT_LABEL_IDS.join(','))
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        ...(Deno.env.get('LINEAR_PROJECT_ID') ? { projectId: Deno.env.get('LINEAR_PROJECT_ID') } : {}),
      });
      issue = created.identifier;
      const { error: linkErr } = await db
        .from('feedback')
        .update({ linear_issue_id: created.id })
        .eq('id', row.id);
      if (linkErr) console.error(`report-problem: could not link ${created.identifier} to #${row.id}`, linkErr);
    } catch (err) {
      console.error('report-problem: linear issue failed', err);
    }
  } else {
    console.warn('report-problem: LINEAR_API_KEY not set — saved to feedback only');
  }

  return json({ ok: true, id: row.id, issue, logs: logs.length });
});

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** First line of the message, short enough for a Linear list row. */
function titleFrom(message: string, version: string): string {
  const first = message.split(/\r?\n/).find((l) => l.trim())?.trim() ?? 'Bug report';
  const clipped = first.length > 80 ? `${first.slice(0, 77)}…` : first;
  return version ? `${clipped} (v${version})` : clipped;
}

function describe(r: {
  message: string;
  driver: string;
  appVersion: string;
  osName: string;
  channel: string;
  feedbackId: number;
  links: string[];
}): string {
  const quoted = r.message
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join('\n');
  const facts = [
    `**From:** ${r.driver}`,
    `**App:** ${r.appVersion || 'unknown'}${r.channel ? ` (${r.channel})` : ''}`,
    r.osName ? `**OS:** ${r.osName}` : '',
    `**Feedback:** #${r.feedbackId} — reply from the app's Admin → Feedback and it pops up for the driver.`,
  ].filter(Boolean);
  const logs = r.links.length ? r.links.join('\n') : '_No logs attached._';
  return `${quoted}\n\n${facts.join('\n')}\n\n**Logs** (Windows user name removed)\n${logs}\n\n_Sent from the app's Report a problem (THE-32)._`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
