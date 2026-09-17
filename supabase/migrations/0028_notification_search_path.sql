-- 0028_notification_search_path.sql — pin the two helpers 0026 left unpinned.
--
-- Supabase's database linter flagged `function_search_path_mutable` on
-- `mask_webhook` and `new_join_code` the moment 0026 landed. Neither is a hole
-- today: both are plain (not SECURITY DEFINER) helpers, and neither is
-- executable by `anon` or `authenticated` — they are only ever called from
-- inside the definer functions that are the actual doors, and a function with
-- no `SET search_path` runs with its caller's, which those doors have already
-- pinned.
--
-- It is still worth closing, for the same reason this repo closed it twice
-- before (`team_caps_search_path`, `feature_analytics_counter_search_path`):
-- the containment is a property of every CURRENT caller rather than of the
-- function itself. The day one of these is called from somewhere that has not
-- pinned its own path — a trigger, a new RPC, a psql session — the resolution
-- of `regexp_replace` or `gen_random_uuid` becomes the caller's business.
-- Pinning it here means that day cannot arrive.
--
-- `to ''` rather than `= public`, so every reference has to be schema-qualified
-- and nothing resolves by luck. Both bodies are rewritten accordingly.
--
-- Re-runnable: `create or replace` throughout, no state touched.

create or replace function public.mask_webhook(p_url text)
returns text
language sql
immutable
set search_path to ''
as $$
  select case
    when coalesce(p_url, '') = '' then ''
    -- .../webhooks/<id>/<token> — the id is harmless and identifies the row to
    -- a human; the token is the whole of the secret and never comes back out.
    else pg_catalog.regexp_replace(
           p_url,
           '^(https://[^/]+/api/webhooks/[0-9]+/).*$',
           '\1' || pg_catalog.repeat('.', 8))
  end;
$$;

comment on function public.mask_webhook(text) is
  'A webhook URL with its token replaced by dots. The only form of a webhook that is allowed back out of this database.';

create or replace function public.new_join_code()
returns text
language sql
volatile
set search_path to ''
as $$
  select pg_catalog.substr(h, 1, 4) || '-' || pg_catalog.substr(h, 5, 4)
  from (
    -- pg_catalog's, not the extensions one: both exist on this database (pgcrypto
    -- installs a copy) and the built-in has shipped with Postgres since 13, so
    -- qualifying it this way drops a dependency rather than adding one.
    select pg_catalog.upper(
             pg_catalog.replace(
               (pg_catalog.gen_random_uuid())::text, '-', '')) as h
  ) g;
$$;

comment on function public.new_join_code() is
  'A community invite code, XXXX-XXXX, in the shape 0007 already uses for league vouchers. No prefix: these codes belong to other people''s leagues.';
