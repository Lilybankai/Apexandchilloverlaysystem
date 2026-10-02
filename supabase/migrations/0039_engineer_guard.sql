-- Engineer call log: record what the number guard did to the answer.
--
-- Prompt v14 (2026-10-02) puts a server-side guard between the model and the
-- radio (supabase/functions/engineer/guard.ts). When the model speaks a figure
-- the data does not hold for the car that was asked about — "P5 is doing
-- 79.4" with no P5 in the summary, 79.4 being the Competitive pace target —
-- the function retries once or replaces the line with a no-read. The `answer`
-- column then holds what was SPOKEN, so without this column the log could no
-- longer show what the model actually said, and a review could not tell a
-- clean answer from a rescued one.
--
-- Shape (jsonb, written by the function):
--   NULL                       guard passed the first answer (or row predates v14)
--   { "verdict": "retried",    first answer failed, the retry passed
--     "first": "...", "unsupported": ["79.4"], "targets": ["P5"],
--     "firstMs": 812 }
--   { "verdict": "replaced",   first (and retry, if any) failed; a no-read was spoken
--     "first": "...", "retry": "...", "unsupported": [...], "targets": [...],
--     "reason": "retry-failed" | "no-budget" | "retry-error", "firstMs": 812 }
--
-- Nullable and additive. The v14 function writes this column only when the
-- insert accepts it: if this migration has not been applied yet, it retries
-- the insert without `guard`, so deploying the function first is safe — the
-- guard still runs, it just goes unlogged.
alter table public.engineer_calls
  add column if not exists guard jsonb;

comment on column public.engineer_calls.guard is
  'Number-guard outcome from prompt v14: NULL = first answer passed (or pre-v14 row); '
  '{verdict: retried|replaced, first, unsupported, targets, ...} when the spoken answer differs from the model''s first.';
