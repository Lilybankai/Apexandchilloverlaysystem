# The web pit wall — aio.apexandchillracing.co.uk

Phase 1 of `docs/COMPANION-APP-PLAN.md`: the desktop Team tab (both of its
screens — **My car** and **Team**) and the desktop Schedule tab (the league's
SimGrid championships and LMU's daily, weekly and special races) in a browser,
on a PC or a tablet, behind the same account as the app. A **Telemetry |
Schedule** switch in the strip moves between them; `board.html#schedule`
opens on the calendar.

## How it is built

Nothing here is a second implementation of the board. `scripts/build-web.js`
copies the Team tab's own files out of `electron/control-panel/` — its
stylesheets, `team-panel.js`, `team-dashboard.js`, `team-charts.js`,
`team-fuel.js`, `team-guide.js`, the account screens' `auth.html`/`auth.js`/
`auth.css` — and adds only what a browser needs that Electron did not:

| File | Job |
|---|---|
| `src/web-bridge.js` | `window.apex` for a browser: Supabase Auth over REST (a port of `electron/auth.js`), the entitlement check, the team RPCs, and the two relay pollers (a port of `electron/team-cloud.js`'s reader). |
| `src/board.html` | The page frame: the desktop's top strip without its live controls, then the Team view lifted verbatim out of `index.html` at build time. |
| `src/web-shell.js` | The account pill, sign-out, the °C/°F switch, the Telemetry/Schedule switch, and the calls the desktop's tab router makes when a view opens. |
| `src/web.css` | Frame-only rules (no rail, phone strip, safe areas). Board styling must go in `team-panel.css` so both stay identical. |

Because the board files are copied, a change to the desktop Team tab is a
change to the web pit wall on the next deploy. The one difference on purpose
is the empty-state sentence, patched in the build (the board fills from the
driver's own desktop, not from "the overlay server on the Dashboard").

The Schedule tab is copied the same way: `schedule-panel.js` (the renderer,
split out of `control-panel.js` for exactly this), `schedule-panel.css`, and
`schedule-core.js` (the calendar rules below), with the
`<section data-view="schedule">` block lifted out of `index.html`. The
desktop's reminder bells are not on the web — they are a main-process
scheduler — and the panel draws none when the bridge has no `reminders`.

## Where the data comes from

A browser has no telemetry. Both screens read a relay written by the driver's
own desktop app once a second while they drive (migration
`supabase/migrations/0017_web_pit_wall.sql`):

- **My car** — `driver_relay`, one row per account, read by that account only
  (`driver_relay_read`). Published whenever **Settings ▸ Application ▸ Web
  pit wall** is on in the desktop app (on by default).
- **Team** — `team_relay`, unchanged from the desktop's Team view
  (`team_relay_read`).

The desktop now writes both rows with one call, `relay_publish`; the old
`team_relay_publish` still exists for installs that predate it. Payloads
carry `v: 1`.

**Schedule** — a browser can read neither of the desktop's sources (SimGrid
sends no CORS headers; RaceOS needs a Steam ticket from a running LMU), so it
reads `schedule_feed` (migration `0037_schedule_feed.sql`): one shared row per
calendar, published by members' desktop apps (`electron/schedule-cloud.js`) —
on every live read the Schedule tab makes, and by a half-hourly sweep that
re-reads a calendar only when the shared copy has gone stale (league 3 h,
dailies 2 h). Newest read wins; "you are entered" is cleared before
publishing. The bridge brings an old copy up to date with
`schedule-core.js` — the same `restore` the desktop applies to its own saved
calendar — so a stale copy never counts down to a race already gone.

## Working on it

```
npm run build             # once — the demo generator reads dist/
npm run web:demo          # 26 minutes of the demo race → web/dev/demo.json
npm run web:dev           # build web/dist and serve it on http://127.0.0.1:8790
```

- `http://127.0.0.1:8790/board.html?demo=1` — the board on the canned race,
  no account needed. This is the screenshot route for layout work.
- `board.html?demo=1#schedule` — the Schedule tab on `web/dev/schedule.json`
  (`npm run web:demo:schedule` rebuilds it from live SimGrid and this PC's
  saved daily calendar).
- `http://127.0.0.1:8790/` — the real sign-in against the live project.

`web/dist` is generated and gitignored.

## Deploying

`.github/workflows/web-pages.yml` builds `web/dist` and deploys it to GitHub
Pages on every push to `main` that touches the Team tab or `web/`, and on
demand from the Actions tab. `src/CNAME` names the custom domain.

DNS for the domain (one record, at whoever hosts apexandchillracing.co.uk):

```
aio.apexandchillracing.co.uk   CNAME   lilybankai.github.io
```

GitHub issues the HTTPS certificate itself once the record resolves
(Settings ▸ Pages ▸ Enforce HTTPS).
