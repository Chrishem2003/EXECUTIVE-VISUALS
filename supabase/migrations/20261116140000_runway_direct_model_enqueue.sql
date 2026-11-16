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
    or (p_provider = 'luma' and p_model = 'ray-3.2')
  ) then$old_allowlist$;
  new_allowlist text := $new_allowlist$  if not (
    (p_provider = 'runway' and p_model in ('gen4.5','aleph2','model-router','seedance2_5','kling_4','kling_4_flash','kling3.0_standard','kling3.0_pro','kling3.0_4k'))
    or (p_provider = 'google' and p_model = 'gemini-omni-1.1-flash')
    or (p_provider = 'luma' and p_model = 'ray-3.2')
  ) then$new_allowlist$;
  old_runway_branch text := $old_runway_branch$  elsif p_provider = 'runway' then
    if coalesce(p_input ->> 'durationSeconds','') not in ('2','3','4','5','6','7','8','9','10') then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;$old_runway_branch$;
  new_runway_branch text := $new_runway_branch$  elsif p_provider = 'runway' and p_model in ('seedance2_5','kling_4','kling_4_flash','kling3.0_standard','kling3.0_pro','kling3.0_4k') then
    if coalesce(p_input ->> 'operation','') not in ('text-to-video','image-to-video','video-to-video') then
      raise exception 'VIDEO_PRICE_OPERATION_INVALID';
    end if;
    if p_input ? 'draft' and jsonb_typeof(p_input -> 'draft') <> 'boolean' then
      raise exception 'VIDEO_DRAFT_FLAG_INVALID';
    end if;
    if p_input ->> 'draft' = 'true' and
       (p_model <> 'seedance2_5' or coalesce(p_input ->> 'resolution','') <> '480p' or coalesce(p_input ->> 'draftTargetResolution','') <> '1080p' or
        (p_input ->> 'operation' = 'video-to-video' and coalesce(p_input ->> 'mode','reference') <> 'reference')) then
      raise exception 'VIDEO_DRAFT_CONFIGURATION_INVALID';
    end if;
    if p_input ? 'draftTaskId' and
       (p_model <> 'seedance2_5' or coalesce(p_input ->> 'operation','') <> 'text-to-video' or
        coalesce(p_input ->> 'resolution','') <> '1080p' or p_input ->> 'draft' = 'true' or coalesce(p_input ->> 'draftEnhancement','') <> 'true' or
        coalesce(p_input ->> 'draftTaskId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or
        coalesce(p_input ->> 'sourceDraftJobId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then
      raise exception 'VIDEO_DRAFT_ENHANCEMENT_INVALID';
    end if;
    if coalesce(p_input ->> 'durationSeconds','') !~ '^[0-9]{1,2}$' then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if (p_model = 'seedance2_5' and ((p_input ->> 'durationSeconds')::numeric < 4 or (p_input ->> 'durationSeconds')::numeric > 30))
       or (p_model = 'kling_4' and ((p_input ->> 'durationSeconds')::numeric < 3 or (p_input ->> 'durationSeconds')::numeric > 30))
       or (p_model = 'kling_4_flash' and ((p_input ->> 'durationSeconds')::numeric < 3 or (p_input ->> 'durationSeconds')::numeric > 20))
       or (p_model in ('kling3.0_standard','kling3.0_pro','kling3.0_4k') and ((p_input ->> 'durationSeconds')::numeric < 3 or (p_input ->> 'durationSeconds')::numeric > 15)) then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if p_input ->> 'outputFormat' is distinct from 'mp4' then
      raise exception 'VIDEO_PRICE_OUTPUT_FORMAT_UNSUPPORTED';
    end if;
    if coalesce(p_input ->> 'prompt','') = ''
       or (p_model = 'seedance2_5' and length(p_input ->> 'prompt') > 15000)
       or (p_model in ('kling_4','kling_4_flash') and length(p_input ->> 'prompt') > 26000)
       or (p_model in ('kling3.0_standard','kling3.0_pro','kling3.0_4k') and length(p_input ->> 'prompt') > 2500) then
      raise exception 'VIDEO_GENERATION_PROMPT_INVALID';
    end if;
    if p_model = 'seedance2_5' and coalesce(p_input ->> 'resolution','') not in ('480p','720p','1080p','4k') then
      raise exception 'VIDEO_GENERATION_RESOLUTION_INVALID';
    end if;
    if p_model = 'kling_4' and coalesce(p_input ->> 'resolution','') not in ('720p','1080p') then
      raise exception 'VIDEO_GENERATION_RESOLUTION_INVALID';
    end if;
    if p_model = 'kling_4_flash' and coalesce(p_input ->> 'resolution','') <> '720p' then
      raise exception 'VIDEO_GENERATION_RESOLUTION_INVALID';
    end if;
    if p_model in ('kling3.0_standard','kling3.0_pro','kling3.0_4k') and
       coalesce(p_input ->> 'resolution','') <> 'provider_default' then
      raise exception 'VIDEO_GENERATION_RESOLUTION_INVALID';
    end if;
    if p_input ->> 'operation' = 'image-to-video' and coalesce(p_input ->> 'startFrameAssetId','') = '' then
      raise exception 'VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED';
    end if;
    if p_input ->> 'operation' = 'video-to-video' and
       (p_model not in ('seedance2_5','kling_4','kling_4_flash') or coalesce(p_input ->> 'sourceVideoAssetId','') = '') then
      raise exception 'VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED';
    end if;
    if p_model = 'seedance2_5' and p_input ->> 'operation' = 'video-to-video' and
       coalesce(p_input ->> 'mode','reference') not in ('reference','extend','edit') then
      raise exception 'VIDEO_PRICE_OPERATION_INVALID';
    end if;
    if p_model = 'seedance2_5' and p_input ->> 'mode' = 'edit' and p_input ->> 'duration' is distinct from 'auto' then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if p_model in ('kling3.0_standard','kling3.0_pro','kling3.0_4k') and jsonb_typeof(p_input -> 'multiPrompt') = 'array' then
      if jsonb_array_length(p_input -> 'multiPrompt') > 6 then
        raise exception 'VIDEO_GENERATION_UNSUPPORTED_CAPABILITY';
      end if;
    elsif p_input ? 'multiPrompt' and p_model not in ('kling3.0_standard','kling3.0_pro','kling3.0_4k') then
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
 or
        coalesce(p_input ->> 'sourceDraftJobId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}    if coalesce(p_input ->> 'durationSeconds','') !~ '^[0-9]{1,2}$' then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if (p_model = 'seedance2_5' and ((p_input ->> 'durationSeconds')::numeric < 4 or (p_input ->> 'durationSeconds')::numeric > 30))
       or (p_model = 'kling_4' and ((p_input ->> 'durationSeconds')::numeric < 3 or (p_input ->> 'durationSeconds')::numeric > 30))
       or (p_model = 'kling_4_flash' and ((p_input ->> 'durationSeconds')::numeric < 3 or (p_input ->> 'durationSeconds')::numeric > 20))
       or (p_model in ('kling3.0_standard','kling3.0_pro','kling3.0_4k') and ((p_input ->> 'durationSeconds')::numeric < 3 or (p_input ->> 'durationSeconds')::numeric > 15)) then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if p_input ->> 'outputFormat' is distinct from 'mp4' then
      raise exception 'VIDEO_PRICE_OUTPUT_FORMAT_UNSUPPORTED';
    end if;
    if coalesce(p_input ->> 'prompt','') = ''
       or (p_model = 'seedance2_5' and length(p_input ->> 'prompt') > 15000)
       or (p_model in ('kling_4','kling_4_flash') and length(p_input ->> 'prompt') > 26000)
       or (p_model in ('kling3.0_standard','kling3.0_pro','kling3.0_4k') and length(p_input ->> 'prompt') > 2500) then
      raise exception 'VIDEO_GENERATION_PROMPT_INVALID';
    end if;
    if p_model = 'seedance2_5' and coalesce(p_input ->> 'resolution','') not in ('480p','720p','1080p','4k') then
      raise exception 'VIDEO_GENERATION_RESOLUTION_INVALID';
    end if;
    if p_model = 'kling_4' and coalesce(p_input ->> 'resolution','') not in ('720p','1080p') then
      raise exception 'VIDEO_GENERATION_RESOLUTION_INVALID';
    end if;
    if p_model = 'kling_4_flash' and coalesce(p_input ->> 'resolution','') <> '720p' then
      raise exception 'VIDEO_GENERATION_RESOLUTION_INVALID';
    end if;
    if p_model in ('kling3.0_standard','kling3.0_pro','kling3.0_4k') and
       coalesce(p_input ->> 'resolution','') <> 'provider_default' then
      raise exception 'VIDEO_GENERATION_RESOLUTION_INVALID';
    end if;
    if p_input ->> 'operation' = 'image-to-video' and coalesce(p_input ->> 'startFrameAssetId','') = '' then
      raise exception 'VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED';
    end if;
    if p_input ->> 'operation' = 'video-to-video' and
       (p_model not in ('seedance2_5','kling_4','kling_4_flash') or coalesce(p_input ->> 'sourceVideoAssetId','') = '') then
      raise exception 'VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED';
    end if;
    if p_model = 'seedance2_5' and p_input ->> 'operation' = 'video-to-video' and
       coalesce(p_input ->> 'mode','reference') not in ('reference','extend','edit') then
      raise exception 'VIDEO_PRICE_OPERATION_INVALID';
    end if;
    if p_model = 'seedance2_5' and p_input ->> 'mode' = 'edit' and p_input ->> 'duration' is distinct from 'auto' then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if p_model in ('kling3.0_standard','kling3.0_pro','kling3.0_4k') and jsonb_typeof(p_input -> 'multiPrompt') = 'array' then
      if jsonb_array_length(p_input -> 'multiPrompt') > 6 then
        raise exception 'VIDEO_GENERATION_UNSUPPORTED_CAPABILITY';
      end if;
    elsif p_input ? 'multiPrompt' and p_model not in ('kling3.0_standard','kling3.0_pro','kling3.0_4k') then
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
) then
      raise exception 'VIDEO_DRAFT_ENHANCEMENT_INVALID';
    end if;
    if coalesce(p_input ->> 'durationSeconds','') !~ '^[0-9]{1,2}$' then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if (p_model = 'seedance2_5' and ((p_input ->> 'durationSeconds')::numeric < 4 or (p_input ->> 'durationSeconds')::numeric > 30))
       or (p_model = 'kling_4' and ((p_input ->> 'durationSeconds')::numeric < 3 or (p_input ->> 'durationSeconds')::numeric > 30))
       or (p_model = 'kling_4_flash' and ((p_input ->> 'durationSeconds')::numeric < 3 or (p_input ->> 'durationSeconds')::numeric > 20))
       or (p_model in ('kling3.0_standard','kling3.0_pro','kling3.0_4k') and ((p_input ->> 'durationSeconds')::numeric < 3 or (p_input ->> 'durationSeconds')::numeric > 15)) then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if p_input ->> 'outputFormat' is distinct from 'mp4' then
      raise exception 'VIDEO_PRICE_OUTPUT_FORMAT_UNSUPPORTED';
    end if;
    if coalesce(p_input ->> 'prompt','') = ''
       or (p_model = 'seedance2_5' and length(p_input ->> 'prompt') > 15000)
       or (p_model in ('kling_4','kling_4_flash') and length(p_input ->> 'prompt') > 26000)
       or (p_model in ('kling3.0_standard','kling3.0_pro','kling3.0_4k') and length(p_input ->> 'prompt') > 2500) then
      raise exception 'VIDEO_GENERATION_PROMPT_INVALID';
    end if;
    if p_model = 'seedance2_5' and coalesce(p_input ->> 'resolution','') not in ('480p','720p','1080p','4k') then
      raise exception 'VIDEO_GENERATION_RESOLUTION_INVALID';
    end if;
    if p_model = 'kling_4' and coalesce(p_input ->> 'resolution','') not in ('720p','1080p') then
      raise exception 'VIDEO_GENERATION_RESOLUTION_INVALID';
    end if;
    if p_model = 'kling_4_flash' and coalesce(p_input ->> 'resolution','') <> '720p' then
      raise exception 'VIDEO_GENERATION_RESOLUTION_INVALID';
    end if;
    if p_model in ('kling3.0_standard','kling3.0_pro','kling3.0_4k') and
       coalesce(p_input ->> 'resolution','') <> 'provider_default' then
      raise exception 'VIDEO_GENERATION_RESOLUTION_INVALID';
    end if;
    if p_input ->> 'operation' = 'image-to-video' and coalesce(p_input ->> 'startFrameAssetId','') = '' then
      raise exception 'VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED';
    end if;
    if p_input ->> 'operation' = 'video-to-video' and
       (p_model not in ('seedance2_5','kling_4','kling_4_flash') or coalesce(p_input ->> 'sourceVideoAssetId','') = '') then
      raise exception 'VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED';
    end if;
    if p_model = 'seedance2_5' and p_input ->> 'operation' = 'video-to-video' and
       coalesce(p_input ->> 'mode','reference') not in ('reference','extend','edit') then
      raise exception 'VIDEO_PRICE_OPERATION_INVALID';
    end if;
    if p_model = 'seedance2_5' and p_input ->> 'mode' = 'edit' and p_input ->> 'duration' is distinct from 'auto' then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if p_model in ('kling3.0_standard','kling3.0_pro','kling3.0_4k') and jsonb_typeof(p_input -> 'multiPrompt') = 'array' then
      if jsonb_array_length(p_input -> 'multiPrompt') > 6 then
        raise exception 'VIDEO_GENERATION_UNSUPPORTED_CAPABILITY';
      end if;
    elsif p_input ? 'multiPrompt' and p_model not in ('kling3.0_standard','kling3.0_pro','kling3.0_4k') then
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
