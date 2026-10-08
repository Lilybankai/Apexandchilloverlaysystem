-- 0040_feedback_linear_issue — a bug report remembers the Linear issue it opened.
-- ---------------------------------------------------------------------------
-- "Report a problem" (THE-32) files a bug through the report-problem edge
-- function: one feedback row, exactly as the Suggestions tab always wrote, plus
-- an issue in Linear labelled Tester report with the driver's logs attached.
--
-- The Linear issue is a copy of personal data held outside this database, and
-- the privacy policy promises feedback is erased with the account. So the row
-- keeps the issue's id, and delete-account deletes those issues in Linear
-- before it deletes the rows. Without this column there would be no way to
-- find them again.
--
-- Written only by the edge function (service role). The driver can already
-- read their own rows ("own feedback readable"); the id is not secret.

alter table public.feedback
  add column if not exists linear_issue_id text;

-- delete-account looks the column up per user; the rate limit in
-- report-problem counts a user's recent bug rows. Both are by user_id.
create index if not exists feedback_user_created_idx
  on public.feedback(user_id, created_at desc);
