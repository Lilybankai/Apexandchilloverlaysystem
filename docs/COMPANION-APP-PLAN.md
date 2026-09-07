# Companion app plan (web / mobile) — rev 2

Written 2026-09-04 against stable 0.97.x, revised the same day after the
Discord thread (Haskins + Carl) and two reference screenshots (LMU Daily app,
Delta session history). Plan only — nothing here is built.

## Status

- **2026-09-07 — Phase 1 built (web only; mobile apps parked, Carl's call).**
  `web/` + `scripts/build-web.js` assemble the desktop Team tab (both screens,
  My car and Team) and the account screens into a static site for
  aio.apexandchillracing.co.uk, deployed by `.github/workflows/web-pages.yml` to
  GitHub Pages. Same account, same widgets, same files — the board's sources
  are copied verbatim at build time, see `web/README.md`. Migration
  `0017_web_pit_wall` adds the per-driver relay row the My car view needs
  (the desktop publishes it whenever Settings ▸ Application ▸ Web pit wall is
  on) and `relay_publish`, which writes the driver and team rows in one
  call; the relay payload now carries the `v` field this plan asked for.
  Verified end to end against the live project with a test account:
  sign-in, the subscribe gate, My car, Team, team creation. Polling, not
  Realtime (1 s visible, 5 s in a background tab). Still to do from the
  phase-1 list: a real endurance race with two drivers on phone + laptop, and
  the DNS record for the domain.
- Widget clipping in a narrow window (reported 2026-09-07) fixed in the
  shared `team-panel.css` with container queries, so both surfaces benefit.

## Scope (agreed 2026-09-04)

- **In:** three tabs — the race engineer board on a phone, a Schedule tab with
  the league calendar + weekly LMU dailies (push on release), and Statistics
  with a past-sessions list, an include/exclude switch per session, and a
  filter by kind (league / special event / daily / hosted / offline).
- **Access: members only.** Every viewer signs in with their own entitled
  account (same rule as the desktop Team tab). No spectator links.
- **Out:** championship standings/entry lists stay on the website. Overtakes
  dropped (a crash ahead reads as an overtake — Carl). Incidents dropped (LMU
  publishes no feed). The "lite" free-overlay tier Haskins raised is not in the
  plan: Carl's position is pre-launch subscribers + the 7-day trial answer it.
- **References:** LMU Daily (card per series: tier, duration, track, start
  times). Delta session history (date, P/Q/R, track, car, laps total/clean/
  dirty, avg, best, result).

## Verdict

| Tab | Verdict | Why |
|---|---|---|
| Engineer | **Build** | relay already carries the whole board; members only |
| Schedule + dailies | **Build the dailies feed** | league calendar exists; dailies hang on parsing Carl's weekly message |
| Statistics | **Capture now, show later** | needs a session record the desktop doesn't write, plus session-kind classification |

Shape: one web app as a PWA on the existing Supabase project. No store build
without a marketing need. Biggest accelerator: `team-panel.js` /
`team-dashboard.js` / `team-charts.js` are lib-free vanilla JS proven in a
plain browser by the stubbed-bridge harness → bridge-adapter port.

**Missing number:** teams / relay rows / active drivers since 2026-08-31 (SQL
refused from the session; read from the Admin tab). 12 accounts at billing
launch 2026-08-14.

## What already exists

- Team relay (`electron/team-cloud.js`, migration `team_engineer_phase2`): 1 Hz
  pruned snapshot per driving member; shape/history revision-gated (≤240 KB);
  RLS via `is_team_member()`.
- Accounts + billing: Supabase Auth, £4.99/mo, `entitlement_status()`.
- Local lap log v5 since 2026-07-27 (time, sectors, clean/dirty reasons, track,
  car, class, session type, fuel, wear, compound, temps). Cloud gets only
  per-day counts + best-per-class (`lapUpload.js`, idempotent, no queue).
- SimGrid: desktop Schedule tab (`electron/simgrid.js`, 25619 Thu / 24215 Sat)
  + the site's `ac-simgrid-lmu` WordPress plugin. Key is baked into the
  desktop client → browser needs an edge-function proxy.
- **Session origin: partial.** LMU's local REST publishes NO server name
  (`serverName` only exists in the demo provider). `/rest/multiplayer/teams`
  only answers on an online server → **online vs offline is detectable
  today**; official vs hosted is not.
- **Session record: not recorded.** Finish (`mFinishStatus`) + green-flag grid
  signals are verified, but nothing writes grid/finish/laps/kind per session.
- **Dailies: no feed.** Carl gets a weekly message listing next week's
  dailies; nothing consumes it. Channel/format unconfirmed.

## 1 · Engineer

Sign in → team → board (timing, positions, strategy, tyres, damage, weather,
map); laps gained/lost from relay history; phone-first preset (board already
stacks <820 px); Supabase Realtime in the browser (desktop avoided it only for
the renderer CSP; ~21,600 msgs/viewer per 6 h race); keep revision-gated
shape/history fetch; stale/empty states that state the three preconditions.
Effort 2–3 weeks. Acceptance: real endurance race, two drivers, phone + laptop.

## 2 · Statistics

**Session list**, newest first, one row per session Apex saw: date, P/Q/R,
kind, track, car, laps (total / clean / dirty by our own rule), best, result,
**include switch**. Totals above the list use included rows only. Filter by
kind. Offline defaults to excluded; online defaults to included.

**How a session gets its kind** (no official flag needed):
1. **Offline** — multiplayer teams endpoint doesn't answer → AI practice,
   excluded by default.
2. **League / special event** — track + start time inside a round on the
   SimGrid calendar (per championship id).
3. **Daily** — track + duration + start time match a slot in the dailies table
   (the same table feeds the Schedule tab).
4. **Hosted · other** — online, matched nothing. User can retag any row.
Probe next time LMU is up: does the local REST expose an official-server flag?
Nice-to-have, not a dependency.

**Stats kept:** sessions/races/laps/distance/driving time (lap time summed);
tracks/cars driven, most-driven, most-raced; best/avg lap, clean-lap share;
wins/podiums/poles (need the session record). Dropped: overtakes, incidents.

**Privacy:** `legal.html` promises the full lap history never leaves the PC.
Upload **one summary row per session + per-track aggregates, never laps**;
add a policy sentence; opt-in on first run after the update; idempotent
resend-everything like the activity upload. Backfill: approximate sessions
rebuilt from lap logs (group by track/car/time gap) with blank kind/result;
real rows start the day capture ships → capture goes in the next desktop
release regardless.

Effort: 1 week desktop (session record + summary upload) + 2 weeks tab (reuse
inside the desktop panel).

## 3 · Schedule and dailies

League calendar (as desktop) + dailies cards in the LMU Daily style; tap a
card for a slot reminder; push when a new week is published.

**Dailies pipeline:** (1) confirm channel + format of Carl's weekly message
(Discord / email / image) — the one unknown that sets effort; (2) ingest —
apexbot already runs in Discord and can forward one channel to an edge
function, or an email-forward address; store the raw message first;
(3) parse — regex for structured text, else the engineer's OpenRouter route
returning JSON {series, tier, duration, track, times, validFrom}, diff posted
back for Carl to eyeball; (4) fallback — Admin-tab paste box running the same
parser; (5) publish to a `dailies` table read by Schedule tab, classifier and
push. Worth asking the LMU Daily author about their source first.

Barriers: SimGrid key → proxy (½ day); web push on iOS needs Home Screen
install; timezone of the message vs the viewer. Effort: 1 week views + 1–2
weeks pipeline/push depending on format.

## Platform

PWA (recommended; manifest + service worker, push on both). Capacitor wrap
only on a marketing need (Apple/Google fees, review, iOS rule: sign-in only,
no Stripe link). No separate native apps.

## Cross-cutting barriers

Relay payload needs a version field before a second reader ships; Supabase
Realtime/edge limits at league scale; new tables cascade from `profiles` so
`delete-account` stays correct; stale phone at 11pm = support message; stats
cover only sessions where Apex was running — say so once on the tab.

## Action plan

- **Phase 0 (this week, desktop only):** team/relay/active counts from Admin;
  session record (start, kind guess, online flag, track, car, class, session
  type, grid, finish overall + class, laps, clean laps, best) next to the lap
  log; relay payload version field; confirm the dailies message channel and
  save three past copies for the parser.
- **Phase 1 (2–3 wks):** Engineer — site, sign-in, entitlement, team picker,
  board port, phone preset, Realtime, live-race acceptance.
- **Phase 2 (2–3 wks, parallel):** Schedule — SimGrid proxy, league view,
  dailies table + cards, PWA manifest, push, ingest + Admin paste fallback.
- **Phase 3 (3 wks, after phase 0 has accrued rows):** Statistics — opt-in
  summary upload + policy sentence; session list, include switch, filter,
  classifier; same tab in the desktop panel.
- **Phase 4 (only on marketing need):** Capacitor wrap.

## Decisions

Settled 2026-09-04: members only; overtakes + incidents out; no lite tier;
Delta + LMU Daily as visual references.

Open: (1) where/what format the weekly dailies message is; (2) session
summaries leaving the PC — aggregates + policy sentence, or wider change;
(3) default include for "hosted · other"; (4) domain; (5) go/no-go on phase 1
once team-usage numbers are in.
