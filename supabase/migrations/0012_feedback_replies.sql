-- ===========================================================================
-- 0012_feedback_replies — the league can answer a suggestion, and the driver
-- who filed it is told.
--
-- Until now feedback was a one-way drop box: a driver typed a message, an
-- admin triaged it to a status, and the driver never heard anything back.
-- This adds the return leg.
--
-- The reply lives on the feedback row rather than in a thread table on
-- purpose. This is one answer to one item, not a conversation — a second reply
-- overwrites the first, which is what "we have had another look" should do. If
-- it ever needs to be a thread, that is a new table, not a widening of this
-- one.
--
-- `reply_seen_at` is the unread flag. It is null while the driver has not
-- acknowledged the reply, and every new reply clears it, so editing an answer
-- shows it again rather than landing silently.
-- ===========================================================================

alter table public.feedback
  add column if not exists reply         text,
  add column if not exists replied_at    timestamptz,
  add column if not exists replied_by    uuid references auth.users(id) on delete set null,
  add column if not exists reply_seen_at timestamptz;

-- The driver-side unread lookup runs on every panel open, so give it an index
-- rather than a sequential scan of the whole inbox. Partial: only rows that
-- have been replied to and not yet acknowledged can ever match.
create index if not exists feedback_unread_reply_idx
  on public.feedback(user_id)
  where reply is not null and reply_seen_at is null;

-- ---------------------------------------------------------------------------
-- Driver-side RLS: they can already select their own rows (policy "own
-- feedback readable" in 0001), which now carries the reply. They also need to
-- mark one seen — and ONLY that. A blanket update policy would let a driver
-- rewrite their own message after an admin read it, or write their own
-- `reply`. So the acknowledgement goes through a security-definer RPC below
-- and there is deliberately still no update policy on the table.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- admin_feedback_reply — answer one item.
--
-- Optionally moves the status in the same call: replying is almost always the
-- moment you also decide what is happening to the idea, and two round trips to
-- do one thing is how the two drift apart.
-- ---------------------------------------------------------------------------
create or replace function public.admin_feedback_reply(
  p_id     bigint,
  p_reply  text,
  p_status text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reply text := nullif(btrim(coalesce(p_reply, '')), '');
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;
  if v_reply is null then
    raise exception 'empty_reply';
  end if;
  if p_status is not null
     and p_status not in ('new', 'planned', 'in_progress', 'done', 'declined') then
    raise exception 'bad_status';
  end if;

  update public.feedback
     set reply         = left(v_reply, 4000),
         replied_at    = now(),
         replied_by    = auth.uid(),
         -- Null, always: a new or edited answer is unread again.
         reply_seen_at = null,
         status        = coalesce(p_status, status),
         updated_at    = now()
   where id = p_id;

  if not found then
    raise exception 'no_such_feedback';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_feedback_clear_reply — take an answer back.
--
-- For the reply sent against the wrong item, or sent half-written. Removing it
-- also removes the driver's unread alert, so an answer withdrawn before it was
-- read is never shown at all.
-- ---------------------------------------------------------------------------
create or replace function public.admin_feedback_clear_reply(
  p_id bigint
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;
  update public.feedback
     set reply = null, replied_at = null, replied_by = null,
         reply_seen_at = null, updated_at = now()
   where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- feedback_unread_replies — what THIS driver has not read yet.
--
-- Returns the original message alongside the reply: an answer read days later
-- is meaningless without the question, and the panel should not need a second
-- call to put it in context.
-- ---------------------------------------------------------------------------
create or replace function public.feedback_unread_replies()
returns table (
  id         bigint,
  kind       text,
  message    text,
  status     text,
  reply      text,
  replied_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  return query
    select f.id, f.kind, f.message, f.status, f.reply, f.replied_at
      from public.feedback f
     where f.user_id = auth.uid()
       and f.reply is not null
       and f.reply_seen_at is null
     order by f.replied_at asc
     limit 20;
end;
$$;

-- ---------------------------------------------------------------------------
-- feedback_mark_reply_seen — acknowledge one reply.
--
-- The `user_id = auth.uid()` clause is the whole security boundary: this is
-- security definer, so without it any signed-in driver could clear anyone
-- else's unread flag by guessing an id.
-- ---------------------------------------------------------------------------
create or replace function public.feedback_mark_reply_seen(
  p_id bigint
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  update public.feedback
     set reply_seen_at = now()
   where id = p_id
     and user_id = auth.uid()
     and reply is not null
     and reply_seen_at is null;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_feedback_list — same shape as 0001 plus the reply, so the inbox shows
-- what was already said instead of an admin answering the same item twice.
--
-- Postgres will not change a function's OUT columns in place, so the old one
-- has to be dropped first. Dropping and recreating inside one migration is
-- safe: the file runs in a transaction, and the grant is reissued below.
-- ---------------------------------------------------------------------------
drop function if exists public.admin_feedback_list(text, int);

create or replace function public.admin_feedback_list(
  p_status text default null,
  p_limit  int  default 100
) returns table (
  id            bigint,
  kind          text,
  message       text,
  app_version   text,
  status        text,
  created_at    timestamptz,
  updated_at    timestamptz,
  driver        text,
  reply         text,
  replied_at    timestamptz,
  reply_seen_at timestamptz,
  replied_by    text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;
  return query
    select f.id, f.kind, f.message, f.app_version, f.status,
           f.created_at, f.updated_at,
           coalesce(p.display_name, 'Driver') as driver,
           f.reply, f.replied_at, f.reply_seen_at,
           coalesce(a.display_name, '') as replied_by
      from public.feedback f
      left join public.profiles p on p.id = f.user_id
      left join public.profiles a on a.id = f.replied_by
     where (p_status is null or f.status = p_status)
     order by f.created_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

grant execute on function public.admin_feedback_list(text, int)           to authenticated;
grant execute on function public.admin_feedback_reply(bigint, text, text) to authenticated;
grant execute on function public.admin_feedback_clear_reply(bigint)       to authenticated;
grant execute on function public.feedback_unread_replies()                to authenticated;
grant execute on function public.feedback_mark_reply_seen(bigint)         to authenticated;
