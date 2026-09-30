// schedule-refresh — keep the Schedule tab's shared calendar filled from the
// server, with nobody's game (or app) running.
// -----------------------------------------------------------------------------
// Until this existed, public.schedule_feed (migration 0037) was only ever
// written by members' desktop apps, and the daily races only by an app whose
// driver had LMU open — so the web page, and the app itself with the game
// shut, could sit empty for days. Every two hours (cron, migration 0038) this:
//
//   dailies_public ← racecontrol.gg's home page, parsed. The public mirror of
//                    the game's daily rotation; see _shared/schedule-sources.mjs
//                    for what it does and does not carry.
//   league         ← SimGrid's API, the two championships, shaped exactly as
//                    the desktop shapes them (electron/simgrid.js).
//
// The rich RaceOS copy a member's app publishes (source 'dailies') is never
// touched here; control-panel/schedule-core.js decides which daily copy to
// draw and fills the public one in from it.
//
// Safe to call by anyone: it only ever re-reads public calendars, and does
// nothing if the last refresh is under 50 minutes old (unless `force`).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { parseRaceControl, readLeague } from '../_shared/schedule-sources.mjs';

const RACECONTROL_URL = 'https://racecontrol.gg/';
// The league's GridOS key — the same one the desktop app ships with
// (electron/simgrid.js); not a user credential. A secret overrides it.
const SIMGRID_KEY = (Deno.env.get('SIMGRID_KEY') ?? '').trim() || 'PhEDyzEVPztV4yMJYsmQjKWy';
const MIN_GAP_MS = 50 * 60 * 1000;
const TIMEOUT_MS = 20_000;
/** A read with fewer than this is a page that half-rendered, not a day's races. */
const MIN_EVENTS = 6;

const db = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
);

function timed(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function lastWrite(source: string): Promise<number> {
  const { data } = await db.from('schedule_feed').select('published_at').eq('source', source).maybeSingle();
  const at = data ? Date.parse(data.published_at) : NaN;
  return Number.isFinite(at) ? at : 0;
}

async function store(source: string, payload: Record<string, unknown>, fetchedAt: string) {
  const { error } = await db.from('schedule_feed').upsert(
    { source, payload, fetched_at: fetchedAt, published_at: new Date().toISOString(), published_by: null },
    { onConflict: 'source' },
  );
  if (error) throw new Error(`${source}: ${error.message}`);
}

async function refreshDailies(now: number) {
  const res = await timed(RACECONTROL_URL, {
    headers: { Accept: 'text/html', 'User-Agent': 'ApexAIO-Schedule/1.0 (+https://aio.apexandchillracing.co.uk)' },
  });
  if (!res.ok) return { ok: false, reason: `racecontrol ${res.status}` };
  const payload = parseRaceControl(await res.text(), now);
  const events = payload ? payload.tiers.reduce((n: number, t: { events: unknown[] }) => n + t.events.length, 0) : 0;
  // A redesign reads as nothing (or next to nothing). Keep the last good copy.
  if (!payload || events < MIN_EVENTS) return { ok: false, reason: 'unparsed', events };
  await store('dailies_public', payload, payload.fetchedAt);
  return { ok: true, tiers: payload.tiers.length, events };
}

async function refreshLeague(now: number) {
  const payload = await readLeague(SIMGRID_KEY, timed, now);
  if (!payload) return { ok: false, reason: 'simgrid' };
  await store('league', payload, payload.fetchedAt);
  return { ok: true, leagues: payload.leagues.length };
}

Deno.serve(async (req) => {
  let force = false;
  try {
    const body = req.method === 'POST' ? await req.json() : {};
    force = !!(body && body.force);
  } catch {
    /* no body */
  }

  const now = Date.now();
  const out: Record<string, unknown> = {};
  for (const [source, run] of [
    ['dailies_public', refreshDailies],
    ['league', refreshLeague],
  ] as const) {
    try {
      if (!force && now - (await lastWrite(source)) < MIN_GAP_MS) {
        out[source] = { ok: true, skipped: 'fresh' };
        continue;
      }
      out[source] = await run(now);
    } catch (err) {
      out[source] = { ok: false, reason: String((err as Error)?.message ?? err) };
    }
  }
  console.log(JSON.stringify({ at: new Date(now).toISOString(), ...out }));
  return new Response(JSON.stringify({ ok: true, ...out }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
