-- 0044_relay_history_cap.sql — a long race no longer kills the team relay.
--
-- 2026-10-25, mid 24-hour race: the relay stopped with "history_too_large".
-- The app keeps the race history under 240 KB of JSON TEXT (team-cloud.js
-- HISTORY_MAX_BYTES), but this function measured pg_column_size of the jsonb,
-- which for this data (62 cars x ~50 laps of small numbers) is ~1.55x the
-- text: Carl's last accepted history was 261,781 bytes against a 262,144 cap
-- at lap 51, and every publish after it was refused.
--
-- It was worse than losing the charts: the refusal failed the WHOLE call, and
-- the app (which only marks history as sent on success) re-sent it every
-- second, so the live car, tyres and timing stopped reaching the team too.
--
-- Two changes, nothing else:
--   1. the history cap is 1 MB of jsonb. The app's 240 KB text cap is ~390 KB
--      of jsonb, so a history the app will send always fits.
--   2. a history over the cap anyway is dropped from that publish instead of
--      refusing it; the reply says history = 'too_large'. The payload,
--      shape and team halves behave exactly as before.
-- Stored rows are compressed (a 262 KB history stores as ~44 KB) and are
-- swept after an hour, so the larger cap costs little.
--
-- CREATE OR REPLACE with an unchanged signature keeps the existing ACL
-- {postgres, authenticated, service_role}; no grant changes.

CREATE OR REPLACE FUNCTION public.relay_publish(p_payload jsonb, p_team_id uuid DEFAULT NULL::uuid, p_map_shape jsonb DEFAULT NULL::jsonb, p_history jsonb DEFAULT NULL::jsonb, p_driver boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid  uuid := (select auth.uid());
  v_team text := null;
  v_hist text := null;
begin
  if v_uid is null then
    raise exception 'relay_publish: not authenticated';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    return jsonb_build_object('ok', false, 'reason', 'no_payload');
  end if;
  if pg_column_size(p_payload) > 65536 then
    return jsonb_build_object('ok', false, 'reason', 'payload_too_large');
  end if;
  if p_map_shape is not null and pg_column_size(p_map_shape) > 65536 then
    return jsonb_build_object('ok', false, 'reason', 'shape_too_large');
  end if;
  -- 0044: a history over the cap is dropped from THIS publish, not allowed to
  -- refuse the whole call. The live car still lands, and the row keeps the
  -- last history that fitted (the coalesce below).
  if p_history is not null and pg_column_size(p_history) > 1048576 then
    p_history := null;
    v_hist := 'too_large';
  end if;

  if coalesce(p_driver, true) then
    insert into public.driver_relay (user_id, payload, map_shape, history)
    values (v_uid, p_payload, p_map_shape, p_history)
    on conflict (user_id) do update
      set payload      = excluded.payload,
          map_shape    = coalesce(excluded.map_shape, driver_relay.map_shape),
          history      = coalesce(excluded.history, driver_relay.history),
          published_at = now();
    delete from public.driver_relay where published_at < now() - interval '1 hour';
  end if;

  if p_team_id is not null then
    if not exists (select 1 from public.team_members
                   where team_id = p_team_id and user_id = v_uid) then
      v_team := 'not_member';
    else
      insert into public.team_relay (team_id, user_id, payload, map_shape, history)
      values (p_team_id, v_uid, p_payload, p_map_shape, p_history)
      on conflict (team_id, user_id) do update
        set payload      = excluded.payload,
            map_shape    = coalesce(excluded.map_shape, team_relay.map_shape),
            history      = coalesce(excluded.history, team_relay.history),
            published_at = now();
      delete from public.team_relay
        where team_id = p_team_id and published_at < now() - interval '1 hour';
      v_team := 'ok';
    end if;
  end if;

  return jsonb_build_object('ok', true, 'team', v_team, 'history', v_hist);
end;
$function$;
