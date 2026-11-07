-- Enable the existing Runway Model Router adapter at the durable SQL boundary.
-- This is an allowlist/contract migration only: it does not enable provider flags,
-- create customer budget policies, or submit paid tasks.
--
-- Use pg_get_functiondef + guarded exact replacements so the existing function's
-- approval binding, idempotency locks, reservation ledger and grants are preserved.
do $runway_router_enqueue$
declare
  function_oid regprocedure;
  function_sql text;
  old_allowlist text := $old_allowlist$  if not (
    (p_provider = 'runway' and p_model in ('gen4.5','aleph2'))
    or (p_provider = 'google' and p_model = 'gemini-omni-1.1-flash')
  ) then$old_allowlist$;
  new_allowlist text := $new_allowlist$  if not (
    (p_provider = 'runway' and p_model in ('gen4.5','aleph2','model-router'))
    or (p_provider = 'google' and p_model = 'gemini-omni-1.1-flash')
  ) then$new_allowlist$;
  old_runway_branch text := $old_runway_branch$  elsif p_provider = 'runway' then
    if coalesce(p_input ->> 'durationSeconds','') not in ('2','3','4','5','6','7','8','9','10') then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;$old_runway_branch$;
  new_runway_branch text := $new_runway_branch$  elsif p_provider = 'runway' and p_model = 'model-router' then
    if coalesce(p_input ->> 'operation','') not in ('text-to-video','image-to-video','video-to-video') then
      raise exception 'VIDEO_PRICE_OPERATION_INVALID';
    end if;
    if coalesce(p_input ->> 'durationSeconds','') !~ '^[0-9]{1,2}$' then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if (p_input ->> 'durationSeconds')::numeric < 2
       or (p_input ->> 'durationSeconds')::numeric > 30 then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
  elsif p_provider = 'runway' then
    if coalesce(p_input ->> 'durationSeconds','') not in ('2','3','4','5','6','7','8','9','10') then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;$new_runway_branch$;
begin
  function_oid := to_regprocedure(
    'executive_visuals.enqueue_video_generation_job(uuid,uuid,text,text,text,text,jsonb,uuid,numeric,text)'
  );
  if function_oid is null then
    raise exception 'RUNWAY_ROUTER_ENQUEUE_FUNCTION_NOT_FOUND';
  end if;
  function_sql := pg_get_functiondef(function_oid);
  if strpos(function_sql, old_allowlist) = 0 then
    raise exception 'RUNWAY_ROUTER_ENQUEUE_ALLOWLIST_SOURCE_MISMATCH';
  end if;
  if strpos(function_sql, old_runway_branch) = 0 then
    raise exception 'RUNWAY_ROUTER_ENQUEUE_PRICING_BRANCH_SOURCE_MISMATCH';
  end if;
  function_sql := replace(function_sql, old_allowlist, new_allowlist);
  function_sql := replace(function_sql, old_runway_branch, new_runway_branch);
  execute function_sql;
end
$runway_router_enqueue$;
