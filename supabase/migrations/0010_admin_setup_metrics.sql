-- 0010_admin_setup_metrics.sql — the setup-sharing health on the Admin overview.
--
-- The league wants to know whether the setup library is doing its job, so this
-- extends admin_usage_overview() (0001) with four setup facts:
--
--   setupCreators              — distinct drivers who have shared ≥1 setup.
--   publicSetups               — how many shared setups are live right now.
--   setupDownloads / …30d / …ers — how OFTEN setups are used (total fetches,
--                                the last 30 days, and how many distinct drivers).
--   driversImprovedWithSetups  — how many drivers are getting FASTER on a shared
--                                setup: a driver whose board lap is attributed to
--                                a setup (lap_traces.setup_id, migration 0009) or
--                                who logged a verified lap driven on one it rated
--                                (setup_ratings.lap_on_setup, migration 0006).
--
-- Only admin_usage_overview is redefined — a `create or replace` that keeps every
-- existing key byte-for-byte and appends the setup keys, so the Members / Billing
-- / Feedback panes are untouched. The function stays SECURITY DEFINER behind
-- is_admin(). Re-runnable.

create or replace function public.admin_usage_overview()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result json;
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;
  select json_build_object(
    'totalUsers',   (select count(*) from public.profiles),
    'activeToday',  (select count(distinct user_id) from public.app_sessions
                       where last_seen_at >= now() - interval '1 day'),
    'activeWeek',   (select count(distinct user_id) from public.app_sessions
                       where last_seen_at >= now() - interval '7 days'),
    'activeMonth',  (select count(distinct user_id) from public.app_sessions
                       where last_seen_at >= now() - interval '30 days'),
    'sessionsWeek', (select count(*) from public.app_sessions
                       where started_at >= now() - interval '7 days'),
    'newFeedback',  (select count(*) from public.feedback where status = 'new'),
    'versions', (
      select coalesce(json_agg(row_to_json(v) order by v.users desc), '[]'::json)
      from (
        select app_version, count(distinct user_id) as users
        from public.app_sessions
        where last_seen_at >= now() - interval '30 days' and app_version <> ''
        group by app_version
      ) v
    ),
    'daily', (
      select coalesce(json_agg(row_to_json(d) order by d.day), '[]'::json)
      from (
        select to_char(date_trunc('day', last_seen_at), 'YYYY-MM-DD') as day,
               count(distinct user_id) as users,
               count(*)                as sessions
        from public.app_sessions
        where last_seen_at >= now() - interval '14 days'
        group by 1
      ) d
    ),
    -- --- setup-sharing health -------------------------------------------------
    'setupCreators', (select count(distinct owner_id) from public.setups),
    'publicSetups',  (select count(*) from public.setups where is_public),
    'setupDownloads',    (select count(*) from public.setup_downloads),
    'setupDownloads30d', (select count(*) from public.setup_downloads
                            where created_at >= now() - interval '30 days'),
    'setupDownloaders',  (select count(distinct user_id) from public.setup_downloads),
    'driversImprovedWithSetups', (
      select count(*) from (
        select driver_id as uid from public.lap_traces where setup_id is not null
        union
        select user_id as uid from public.setup_ratings where lap_on_setup
      ) improved
    )
  ) into result;
  return result;
end;
$$;

grant execute on function public.admin_usage_overview() to authenticated;
