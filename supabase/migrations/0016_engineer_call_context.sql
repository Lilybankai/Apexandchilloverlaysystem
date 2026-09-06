-- Engineer call log: record the follow-up context that rode the request.
--
-- The 2026-09-06 review of engineer_calls could not answer its own question.
-- "and the next lap." was asked by two drivers two days apart and answered two
-- different ways — once "No read on it, I'm afraid.", once with a lap count.
-- That fragment is exactly the follow-up case v11 added the `previous` block
-- for, but `previous` was never logged, so there is no way to tell whether the
-- model had the earlier exchange and misused it or never received it at all.
--
-- Nullable and additive: existing rows keep a NULL, meaning "not recorded",
-- which is honestly different from an ask that carried no previous exchange
-- (logged as a JSON null by the function from here on).
alter table public.engineer_calls
  add column if not exists previous jsonb;

comment on column public.engineer_calls.previous is
  'The prior exchange sent as follow-up context ({question, answer, secondsAgo}), '
  'JSON null when the ask was standalone, SQL NULL for rows logged before 2026-09-06.';
