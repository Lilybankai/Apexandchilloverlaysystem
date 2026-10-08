# The accuracy score

Practice Review, phase 3 (`docs/PRACTICE-REVIEW-PLAN.md`). Code:
`src/telemetry/accuracyScore.ts`. Calibration: `scripts/calibrate-accuracy.js`.
Tests: `scripts/test-accuracyscore.js`.

## What it is, in plain English

Every lap gets a score out of 100 for **how closely it copied the lap you were
chasing** — the same lap the training overlays showed you on track (or, when
nothing was chased, your best lap of the session). Every corner gets one too.

Each corner is judged four ways:

| Part | What it looks at |
|---|---|
| **Braking** | Where you went on the brakes compared with the target, and where you came off them. |
| **Throttle** | Where you got back to full throttle after the corner, and how much of the straight after it you spent flat. Getting on it *later* costs full points; *earlier* costs half. |
| **Line** | How far, on average, you were from the target's line through the corner. Only for laps recorded with the driven line; on older laps it is simply left out. |
| **Speed** | Your minimum speed through the corner. Only *slower* counts against you — carrying more speed than the target is never an error. |

A corner's score blends its four parts. A lap's score blends its corners,
counting each corner by how long the target takes through it — a hairpin
matters more than a kink. "Points to gain" on a corner is how much the lap's
score would go up if you nailed that one corner.

**The score was tuned on real laps so that a higher score means a faster
lap.** On this machine's laps, within each session, the laps with higher
scores were reliably the quicker ones (details below). It does not reward
looking tidy for its own sake.

## The formulas

Every part turns an error into points with one curve:

    points = 100 × exp(−error / scale)

so an error of exactly one *scale* leaves 37 points, half a scale 61, two
scales 14. Where a part has two measurements, their scaled errors are added
before the curve.

| Part | Error | Scale |
|---|---|---|
| Braking | \|your braking point − target's\| (m), plus \|your release − target's\| (m) | 10 m, 90 m |
| Throttle | full-throttle pick-up: metres later than the target (or ½ × metres earlier); plus percentage points of the following straight the target spent flat and you did not | 90 m, 35 pts |
| Line | mean distance from the target's line, entry → exit (m) | 4 m |
| Speed | km/h *below* the target's minimum speed (0 if faster) | 25 km/h |

Corner total = weighted mean of the parts that could be measured, with weights
**Braking 0.5 · Throttle 1 · Line 0.5 · Speed 3**. A part that could not be
measured (no driven line, no braking zone in a flat corner, no full-throttle
point before the next corner) is left out of the mean — it is never counted as
0 or as 100.

Lap total = mean of the corner totals, each weighted by the seconds the target
spends between that corner's entry and exit. The lap's per-part figures are
averaged the same way over the corners where that part was measured.

Definitions shared with the rest of the app: braking point = the brake crossing
12% (`brakePoints.ts`), searched from 100 m before the corner's entry to its
apex; release = the brake falling back under 5%; full throttle = 90% or more,
held for 20 m, searched from 40 m before the apex to the next corner's entry.
Corners are the target's own (`corners.ts`, or the list the overlay was
served), numbered C1..Cn.

## How the constants were chosen

**Data.** Every session in this machine's lap log with at least four clean,
timed, traced laps (2026-10-08: **50 sessions, 654 laps**, 267 of them with the
driven line). In each, the best lap was the target and every other lap within
110% of it was scored — a lap past 110% is a spin or a moment, and its time
says nothing about how the corners were copied.

**The test.** For a score to be honest it has to agree with the stopwatch:

- *Lap agreement* — within each session, do the laps with higher scores have
  smaller deltas to the target? Measured as Spearman rank correlation, taken
  session by session (tracks differ, so pooling across them would measure the
  tracks) and averaged. Reported as agreement = −ρ: **1 is perfect, 0 is no
  relation**.
- *Corner agreement* — the same question for every corner of every lap: does a
  corner's score fall as the time lost in it rises?

**The search.** Coordinate descent over a grid of plausible values for every
scale and weight, on 70% of the sessions; the other 30% held out to see
whether the result is real or fitted to noise. With 50 sessions a single
split's held-out figure moves by ±0.02 with the luck of the draw, so this was
done on **five different splits** and the candidate with the best *mean*
held-out agreement across all five was kept. Two guards, both learned on the
way:

- An unrestricted search "won" by switching parts off (a scale so large the
  part always scores 100). The held-out sessions showed that was fitting
  noise. Every part is kept in at a plausible scale, between half and double
  weight — the plan's rule is to down-weight a weak part, not hide it.
- Re-running the search from the chosen constants moves nothing.

**Result** (mean over the five splits):

| | lap agreement, train | lap agreement, held out |
|---|---|---|
| Hand-picked starting constants | 0.64 | 0.67 |
| **Chosen constants** | **0.71** | **0.76** |

Per part, alone (split 0; 39 sessions train / 11 held out):

| Part | lap agreement (train / held out) | corner agreement (train / held out) |
|---|---|---|
| **Total** | **0.70 / 0.80** | **0.49 / 0.52** |
| Braking | 0.35 / 0.28 | 0.27 / 0.30 |
| Throttle | 0.47 / 0.32 | −0.02 / 0.06 |
| Line | 0.36 / 0.32 | 0.19 / 0.21 |
| Speed | 0.55 / 0.80 | 0.52 / 0.51 |

**Which parts earned their place.** All four predict lap time on their own, and
the total beats every part alone.

- **Speed** is the strongest single predictor, which is why it carries the most
  weight: minimum speed through a corner is where lap time is made.
- **Braking** is weaker on held-out sessions than on training ones, so it is
  down-weighted (0.5). The braking *point* matters; the *release* point on its
  own predicts little, so its scale is loose (90 m).
- **Line** predicts about as well as braking and is kept at 0.5. It is only
  measured on laps with the driven line.
- **Throttle** agrees with the *lap* time (0.32–0.47) but not with the
  *corner's* time (≈0). That is expected, not a flaw: a late pick-up costs time
  on the straight AFTER the corner, and a corner's own time stops at its exit.
  It is kept at full weight for the lap.

## Re-running it

    npm run build && node scripts/calibrate-accuracy.js

It prints the table above for the constants in `accuracyScore.ts` (`SCORING`),
searches again, and prints what it would choose. Re-run it when the lap log
has grown a lot or after a change to the corner, braking or line code; adopt
new constants only if the held-out figure improves on the five splits.
