-- Add governed Ray 3.2 source-video edit and reframe operations.
-- This is source-controlled only; it does not apply itself to a hosted database
-- or enable any provider. Extension remains gated until generation ownership is verified.

alter table executive_visuals.video_workflow_quotes
  drop constraint if exists video_workflow_quotes_operation_check;

alter table executive_visuals.video_workflow_quotes
  add constraint video_workflow_quotes_operation_check
    check ((provider='runway' and operation in ('text-to-video','image-to-video','video-to-video'))
        or (provider='google' and operation in ('generate','edit','extend'))
        or (provider='luma' and operation in ('generate','video_edit','video_reframe')));

do $luma_source_quote_rpc$
declare
  function_oid regprocedure;
  function_sql text;
  old_identity text := $old$or not ((p_provider='runway' and p_model='model-router')
       or (p_provider='google' and p_model='gemini-omni-1.1-flash')
       or (p_provider='luma' and p_model='ray-3.2'))
     or not ((p_provider='runway' and p_operation in ('text-to-video','image-to-video','video-to-video'))
       or (p_provider='google' and p_operation in ('generate','edit','extend'))
       or (p_provider='luma' and p_operation='generate'))$old$;
  new_identity text := $new$or not ((p_provider='runway' and p_model='model-router')
       or (p_provider='google' and p_model='gemini-omni-1.1-flash')
       or (p_provider='luma' and p_model='ray-3.2'))
     or not ((p_provider='runway' and p_operation in ('text-to-video','image-to-video','video-to-video'))
       or (p_provider='google' and p_operation in ('generate','edit','extend'))
       or (p_provider='luma' and p_operation in ('generate','video_edit','video_reframe')))$new$;
begin
  function_oid := to_regprocedure(
    'executive_visuals.record_video_workflow_quote(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,numeric,text,text,text,timestamptz)'
  );
  if function_oid is null then raise exception 'LUMA_SOURCE_QUOTE_RPC_NOT_FOUND'; end if;
  function_sql := pg_get_functiondef(function_oid);
  if strpos(function_sql,old_identity)>0 then
    function_sql := replace(function_sql,old_identity,new_identity);
    execute function_sql;
  elsif strpos(function_sql,new_identity)>0 then
    null;
  else
    raise exception 'LUMA_SOURCE_QUOTE_RPC_SOURCE_MISMATCH';
  end if;
end
$luma_source_quote_rpc$;

do $luma_source_enqueue_rpc$
declare
  function_oid regprocedure;
  function_sql text;
  old_luma_branch text := $old$  elsif p_provider = 'luma' then
    if coalesce(p_input ->> 'operation','') <> 'generate' then
      raise exception 'VIDEO_PRICE_OPERATION_INVALID';
    end if;
    if coalesce(p_input ->> 'durationSeconds','') not in ('5','10') then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if coalesce(p_input ->> 'resolution','') not in ('360p','540p','720p','1080p') then
      raise exception 'VIDEO_PRICE_UNSUPPORTED_RESOLUTION';
    end if;
    if coalesce(p_input ->> 'audioMode','none') <> 'none' then
      raise exception 'VIDEO_PRICE_UNSUPPORTED_AUDIO_MODE';
    end if;
    -- Exact Luma credits multiplied by the account/contract rate are recorded
    -- in the immutable quote. Approval RPC enforces the approved ceiling.$old$;
  new_luma_branch text := $new$  elsif p_provider = 'luma' then
    if coalesce(p_input ->> 'operation','') not in ('generate','edit','reframe') then
      raise exception 'VIDEO_PRICE_OPERATION_INVALID';
    end if;
    if coalesce(p_input ->> 'audioMode','none') <> 'none' then
      raise exception 'VIDEO_PRICE_UNSUPPORTED_AUDIO_MODE';
    end if;
    if coalesce(p_input ->> 'resolution','') not in ('360p','540p','720p','1080p') then
      raise exception 'VIDEO_PRICE_UNSUPPORTED_RESOLUTION';
    end if;
    if coalesce(p_input ->> 'operation','') = 'generate' then
      if coalesce(p_input ->> 'durationSeconds','') not in ('5','10') then
        raise exception 'VIDEO_PRICE_DURATION_INVALID';
      end if;
      if p_input ? 'sourceVideoAssetId' then
        raise exception 'VIDEO_PRICE_SOURCE_OPERATION_MISMATCH';
      end if;
    elsif coalesce(p_input ->> 'operation','') = 'edit' then
      if coalesce(p_input ->> 'durationSeconds','') not in ('5','10') then
        raise exception 'VIDEO_PRICE_DURATION_INVALID';
      end if;
      if not (p_input ? 'sourceVideoAssetId') or p_input ? 'startFrameAssetId'
         or p_input ? 'endFrameAssetId' or p_input ? 'keyframeAssetIds' then
        raise exception 'VIDEO_PRICE_SOURCE_OPERATION_MISMATCH';
      end if;
    elsif coalesce(p_input ->> 'operation','') = 'reframe' then
      if coalesce(p_input ->> 'durationSeconds','') !~ '^[2-9]$|^[1-2][0-9]$|^30$' then
        raise exception 'VIDEO_PRICE_DURATION_INVALID';
      end if;
      if not (p_input ? 'sourceVideoAssetId') or p_input ? 'startFrameAssetId'
         or p_input ? 'endFrameAssetId' or p_input ? 'keyframeAssetIds'
         or coalesce(p_input ->> 'resolution','') = '1080p' then
        raise exception 'VIDEO_PRICE_SOURCE_OPERATION_MISMATCH';
      end if;
    end if;
    -- Exact operation-specific Luma credits multiplied by the configured
    -- account/contract rate are recorded in the immutable quote. Actual spend
    -- is reconciled only from the provider task settlement evidence.$new$;
begin
  function_oid := to_regprocedure(
    'executive_visuals.enqueue_video_generation_job(uuid,uuid,text,text,text,text,jsonb,uuid,numeric,text)'
  );
  if function_oid is null then raise exception 'LUMA_SOURCE_ENQUEUE_RPC_NOT_FOUND'; end if;
  function_sql := pg_get_functiondef(function_oid);
  if strpos(function_sql,old_luma_branch)>0 then
    function_sql := replace(function_sql,old_luma_branch,new_luma_branch);
    execute function_sql;
  elsif strpos(function_sql,new_luma_branch)>0 then
    null;
  else
    raise exception 'LUMA_SOURCE_ENQUEUE_RPC_SOURCE_MISMATCH';
  end if;
end
$luma_source_enqueue_rpc$;
