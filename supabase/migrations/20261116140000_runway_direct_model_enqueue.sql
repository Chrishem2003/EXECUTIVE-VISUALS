-- Enable the explicitly gated direct Seedance and Kling worker profiles at the durable SQL boundary.
-- This migration does not enable environment gates, provider credentials, budgets or paid execution.
-- It preserves the existing approval, idempotency, credit-reservation and ledger logic by
-- applying guarded exact replacements to the existing enqueue function.
do $runway_direct_models$
declare
  function_oid regprocedure;
  function_sql text;
  old_allowlist text := $old_allowlist$  if not (
    (p_provider = 'runway' and p_model in ('gen4.5','aleph2','model-router'))
    or (p_provider = 'google' and p_model = 'gemini-omni-1.1-flash')
  ) then$old_allowlist$;
  new_allowlist text := $new_allowlist$  if not (
    (p_provider = 'runway' and p_model in ('gen4.5','aleph2','model-router','seedance2_5','kling_4','kling3.0_standard','kling3.0_pro','kling3.0_4k'))
    or (p_provider = 'google' and p_model = 'gemini-omni-1.1-flash')
  ) then$new_allowlist$;
  old_runway_branch text := $old_runway_branch$  elsif p_provider = 'runway' then
    if coalesce(p_input ->> 'durationSeconds','') not in ('2','3','4','5','6','7','8','9','10') then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;$old_runway_branch$;
  new_runway_branch text := $new_runway_branch$  elsif p_provider = 'runway' and p_model in ('seedance2_5','kling_4','kling3.0_standard','kling3.0_pro','kling3.0_4k') then
    if coalesce(p_input ->> 'operation','') not in ('text-to-video','image-to-video','video-to-video') then
      raise exception 'VIDEO_PRICE_OPERATION_INVALID';
    end if;
    if coalesce(p_input ->> 'durationSeconds','') !~ '^[0-9]{1,2}$' then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if (p_model = 'seedance2_5' and ((p_input ->> 'durationSeconds')::numeric < 4 or (p_input ->> 'durationSeconds')::numeric > 30))
       or (p_model = 'kling_4' and ((p_input ->> 'durationSeconds')::numeric < 3 or (p_input ->> 'durationSeconds')::numeric > 30))
       or (p_model in ('kling3.0_standard','kling3.0_pro','kling3.0_4k') and ((p_input ->> 'durationSeconds')::numeric < 3 or (p_input ->> 'durationSeconds')::numeric > 15)) then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if p_input ->> 'outputFormat' is distinct from 'mp4' then
      raise exception 'VIDEO_PRICE_OUTPUT_FORMAT_UNSUPPORTED';
    end if;
    if p_input ->> 'operation' = 'image-to-video' and coalesce(p_input ->> 'startFrameAssetId','') = '' then
      raise exception 'VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED';
    end if;
    if p_input ->> 'operation' = 'video-to-video' and
       (p_model not in ('seedance2_5','kling_4') or coalesce(p_input ->> 'sourceVideoAssetId','') = '') then
      raise exception 'VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED';
    end if;
    if p_model = 'seedance2_5' and p_input ->> 'operation' = 'video-to-video' and
       coalesce(p_input ->> 'mode','reference') not in ('reference','extend','edit') then
      raise exception 'VIDEO_PRICE_OPERATION_INVALID';
    end if;
    if p_model = 'seedance2_5' and p_input ->> 'mode' = 'edit' and p_input ->> 'duration' is distinct from 'auto' then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if p_model in ('kling3.0_standard','kling3.0_pro') and jsonb_typeof(p_input -> 'multiPrompt') = 'array' and
       jsonb_array_length(p_input -> 'multiPrompt') > 6 then
      raise exception 'VIDEO_GENERATION_UNSUPPORTED_CAPABILITY';
    end if;
    if p_model in ('kling3.0_standard','kling3.0_pro') and coalesce(p_input ->> 'audio','') not in ('true','false') then
      raise exception 'VIDEO_PRICE_INPUT_REQUIRED';
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
    raise exception 'RUNWAY_DIRECT_ENQUEUE_FUNCTION_NOT_FOUND';
  end if;
  function_sql := pg_get_functiondef(function_oid);
  if strpos(function_sql, old_allowlist) = 0 then
    raise exception 'RUNWAY_DIRECT_ENQUEUE_ALLOWLIST_SOURCE_MISMATCH';
  end if;
  if strpos(function_sql, old_runway_branch) = 0 then
    raise exception 'RUNWAY_DIRECT_ENQUEUE_PRICING_BRANCH_SOURCE_MISMATCH';
  end if;
  function_sql := replace(function_sql, old_allowlist, new_allowlist);
  function_sql := replace(function_sql, old_runway_branch, new_runway_branch);
  execute function_sql;
end
$runway_direct_models$;
