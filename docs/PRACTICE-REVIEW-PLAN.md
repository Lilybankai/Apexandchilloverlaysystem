# Practice Review — plan

Asked for by Carl on 2026-10-08, the day the training overlays' new look worked
in the car: *"when someone leaves the practice session we should give them a
review of it, so they can review each of their laps and each of their corner
analysis back in the app, each of their telemetry lines, and have a really deep
dive into exactly where they're losing the time."* A league member added an
**accuracy score** per lap — how close the brakes, throttle and line were — to
keep improving against.

## Decisions (Carl, 2026-10-08)

| Question | Answer |
|---|---|
| How does the review appear? | An **in-game notice** says it is ready; the **Review tab opens on it** the next time the app is looked at. Never a window popped over the sim. |
| What is each lap measured against? | **The lap they chased** in Training (the Chase reference: a board lap, their best, or a pinned driver). Switchable to the session's best lap. |
| Scores shared? | **Personal first.** Local only; a shared accuracy board only once the scoring has proved fair. |
| Release? | Not before the review: the flicker fix and the new widgets ship with it. |

## What exists, and what does not

Exists: every lap is logged with `sessionType` (`lapLog.ts`) and a full trace
(`lapTrace.ts`; v2 adds the driven line `x/z`); the Review tab groups laps into
sessions (`stintReview.ts`), compares a lap against another lap or a board lap
by distance (`lapDetail.ts`: delta, micro-sectors), and draws map + charts with
one shared zoom window (`review-panel.js`, `review-charts.js`).
`corners.ts` finds a lap's corners (`findCorners`) and scores one corner
against a reference offline (`cornerResult`: time, braking point, apex speed).

Missing: no "practice ended" event; Review never knows which reference was
chased in Training; nothing scores a whole lap corner by corner; no score.

## The target is a snapshot

"The lap you chased" is captured **during the session**, from the ghost the
server actually published (`getPublishedGhost()` → `ghostJson()`), and saved
with the review. A board lap that is beaten next week, a Chase choice changed
tomorrow, or a cache that is cleared cannot change what a past session is
measured against. A session with no ghost (Training off, no reference) is
measured against its own best lap, and says so.

Saved at `userData/practice-reviews/<sessionKey>.json`:
`{ v: 1, sessionKey, track, car, carClass, trackLengthM, startedAt, endedAt,
target: { kind: 'chased', label, lapId, lapSec, columns: <ghost.json body> } | null }`.

## Phase 1 — the debrief

1. **Recognise the end** (`electron/practiceSession.js`, pure, injected clock,
   `scripts/test-practicesession.js`). Fed from every frame like the training
   gate. A practice/testday session with at least one timed lap has ended when
   the feed says plainly it is another session, or says nothing for
   `END_HOLD_MS` (20 s: longer than a loading screen, and the training gate's
   10 s hold already proves those gaps exist). One end per session.
2. **Snapshot the target** whenever the published ghost's `sourceLapId`
   changes during an eligible session (the last one chased wins).
3. **On end:** write the snapshot; `sendIngameNotice("Practice review ready —
   14 laps · best 1:21.402")`; mark it pending (`review:pending` IPC, plus a push
   so an open panel can show a banner). The Review tab, when next shown, opens
   the pending review once and clears it.
4. **`review:practice(sessionId)`** → `PracticeReview` (below), built by the
   pure `src/telemetry/practiceReview.ts` (`scripts/test-practicereview.js`).
5. **The debrief view** in the Review tab: header (track, car, laps, best,
   theoretical best, consistency, the target); a lap list (time, delta to the
   target, sparkline of corner losses, invalid laps marked); **"Where the time
   went"**: the three corners that cost the most on average, each with its
   typical fault ("braking 14 m early", "−6 km/h at the apex"); and a
   corner × lap heat grid (rows C1..Cn, columns laps, cells coloured by time
   lost). Clicking a lap opens phase 2's deep dive.

```ts
interface PracticeReview {
  id: string;                    // the stintReview session id
  track: string; car: string; carClass: string; trackLengthM: number;
  startedAt: string; endedAt: string;
  target: { kind: 'chased' | 'sessionBest'; label: string; lapId: string; lapSec: number } | null;
  laps: PracticeLap[];           // in driving order
  bestLapSec: number | null;     // best valid lap
  theoreticalBestSec: number | null; // best of every segment (corners and the straights between) added up
  consistencySec: number | null; // std dev of valid laps within 107% of the best
  corners: CornerSummary[];      // one per reference corner, C1..Cn
}
interface PracticeLap {
  at: string; lapNo: number; lapSec: number; valid: boolean; hasTrace: boolean;
  deltaSec: number | null;       // lapSec − target.lapSec
  corners: { index: number; deltaSec: number | null; brakeDeltaM: number | null; apexKphDelta: number | null }[];
}
interface CornerSummary {
  index: number;                 // C(index+1); the reference's own order, never official names
  entryD: number; apexD: number; exitD: number;
  laps: number;                  // laps that could be scored here
  avgLossSec: number | null; bestSec: number | null; worstSec: number | null;
  avgBrakeDeltaM: number | null; avgApexKphDelta: number | null;
}
```

## Phase 2 — the deep dive

`review:lap` gains `vs: { practice: sessionId }`, comparing against the
session's saved target columns. The lap view adds a **corner table**
(C1..Cn: time, braking point, apex speed, exit speed, line offset, a tip in the
Corner Analysis card's words); clicking a corner moves the one zoom window, so
map and every chart frame that corner.

## Phase 3 — the accuracy score

0–100 per corner and per lap, in four parts, each a published formula:
**Braking** (brake point and release against the reference's), **Throttle**
(pick-up point; time at full throttle), **Line** (lateral distance from the
reference's line through the corner — v2 laps only, left out rather than
guessed), **Speed** (minimum speed). Weights calibrated on real laps so that a
higher score means a faster lap. A trend across laps and sessions, and "points
to gain" per corner. Stored locally.

## Not in scope

A shared accuracy board; race and qualifying reviews; anything for laps
recorded before this ships beyond what their traces allow.
