-- Add Luma Ray 3.2 to the existing immutable quote, approval and enqueue path.
-- This migration does not enable any provider or execute a generation request.

alter table executive_visuals.video_workflow_quotes
  drop constraint if exists video_workflow_quotes_provider_check;
alter table executive_visuals.video_workflow_quotes
  drop constraint if exists video_workflow_quotes_model_check;
alter table executive_visuals.video_workflow_quotes
  drop constraint if exists video_workflow_quotes_operation_check;
alter table executive_visuals.video_workflow_quotes
  drop constraint if exists video_workflow_quotes_pricing_source_check;

alter table executive_visuals.video_workflow_quotes
  add constraint video_workflow_quotes_provider_check
    check (provider in ('runway','google','luma')),
  add constraint video_workflow_quotes_model_check
    check ((provider='runway' and model='model-router')
        or (provider='google' and model='gemini-omni-1.1-flash')
        or (provider='luma' and model='ray-3.2')),
  add constraint video_workflow_quotes_operation_check
    check ((provider='runway' and operation in ('text-to-video','image-to-video','video-to-video'))
        or (provider='google' and operation in ('generate','edit','extend'))
        or (provider='luma' and operation='generate')),
  add constraint video_workflow_quotes_pricing_source_check
    check ((provider='runway' and pricing_source='runway_model_router_dry_run')
        or (provider='google' and pricing_source='google_gemini_omni_token_pricing_2026-11-05')
        or (provider='luma' and pricing_source='luma_ray32_published_credits_contract_rate'));

do $luma_workflow_quote_rpc$
declare
  function_oid regprocedure;
  function_sql text;
  old_identity text := $old$or not ((p_provider='runway' and p_model='model-router')
       or (p_provider='google' and p_model='gemini-omni-1.1-flash'))
     or not ((p_provider='runway' and p_operation in ('text-to-video','image-to-video','video-to-video'))
       or (p_provider='google' and p_operation in ('generate','edit','extend')))$old$;
  new_identity text := $new$or not ((p_provider='runway' and p_model='model-router')
       or (p_provider='google' and p_model='gemini-omni-1.1-flash')
       or (p_provider='luma' and p_model='ray-3.2'))
     or not ((p_provider='runway' and p_operation in ('text-to-video','image-to-video','video-to-video'))
       or (p_provider='google' and p_operation in ('generate','edit','extend'))
       or (p_provider='luma' and p_operation='generate'))$new$;
  old_pricing text := $old$or not ((p_provider='runway' and p_pricing_source='runway_model_router_dry_run')
       or (p_provider='google' and p_pricing_source='google_gemini_omni_token_pricing_2026-11-05'))$old$;
  new_pricing text := $new$or not ((p_provider='runway' and p_pricing_source='runway_model_router_dry_run')
       or (p_provider='google' and p_pricing_source='google_gemini_omni_token_pricing_2026-11-05')
       or (p_provider='luma' and p_pricing_source='luma_ray32_published_credits_contract_rate'))$new$;
begin
  function_oid := to_regprocedure(
    'executive_visuals.record_video_workflow_quote(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,numeric,text,text,text,timestamptz)'
  );
  if function_oid is null then raise exception 'LUMA_WORKFLOW_QUOTE_RPC_NOT_FOUND'; end if;
  function_sql := pg_get_functiondef(function_oid);
  if strpos(function_sql,old_identity)>0 and strpos(function_sql,old_pricing)>0 then
    function_sql := replace(function_sql,old_identity,new_identity);
    function_sql := replace(function_sql,old_pricing,new_pricing);
    execute function_sql;
  elsif strpos(function_sql,new_identity)>0 and strpos(function_sql,new_pricing)>0 then
    null;
  else
    raise exception 'LUMA_WORKFLOW_QUOTE_RPC_SOURCE_MISMATCH';
  end if;
end
$luma_workflow_quote_rpc$;

do $luma_workflow_approval_rpc$
declare
  function_oid regprocedure;
  function_sql text;
  old_identity text := $old$or not ((quote_row.provider='runway' and quote_row.model='model-router')
       or (quote_row.provider='google' and quote_row.model='gemini-omni-1.1-flash'))$old$;
  new_identity text := $new$or not ((quote_row.provider='runway' and quote_row.model='model-router')
       or (quote_row.provider='google' and quote_row.model='gemini-omni-1.1-flash')
       or (quote_row.provider='luma' and quote_row.model='ray-3.2'))$new$;
begin
  function_oid := to_regprocedure(
    'executive_visuals.approve_and_enqueue_video_workflow(uuid,uuid,uuid,uuid,text,text,text,jsonb,numeric,text)'
  );
  if function_oid is null then raise exception 'LUMA_WORKFLOW_APPROVAL_RPC_NOT_FOUND'; end if;
  function_sql := pg_get_functiondef(function_oid);
  if strpos(function_sql,old_identity)>0 then
    function_sql := replace(function_sql,old_identity,new_identity);
    execute function_sql;
  elsif strpos(function_sql,new_identity)>0 then
    null;
  else
    raise exception 'LUMA_WORKFLOW_APPROVAL_RPC_SOURCE_MISMATCH';
  end if;
end
$luma_workflow_approval_rpc$;

do $luma_enqueue_provider$
declare
  function_oid regprocedure;
  function_sql text;
  old_provider_gate text := $old$  if not (
    (p_provider = 'runway' and p_model in ('gen4.5','aleph2','model-router'))
    or (p_provider = 'google' and p_model = 'gemini-omni-1.1-flash')
  ) then
    raise exception 'VIDEO_ENQUEUE_PROVIDER_NOT_ENABLED';
  end if;$old$;
  new_provider_gate text := $new$  if not (
    (p_provider = 'runway' and p_model in ('gen4.5','aleph2','model-router'))
    or (p_provider = 'google' and p_model = 'gemini-omni-1.1-flash')
    or (p_provider = 'luma' and p_model = 'ray-3.2')
  ) then
    raise exception 'VIDEO_ENQUEUE_PROVIDER_NOT_ENABLED';
  end if;$new$;
  old_google_branch text := $old$  else
    -- Gemini Omni direct API preflight: 1,048,576 input tokens at $1.50/M
    -- plus 57,920 output video tokens (10s at 5,792 tokens/s) at $17.50/M.
    -- The reservation is deliberately conservative; actual usage is reconciled
    -- from the completed interaction before budget settlement.$old$;
  new_google_branch text := $new$  elsif p_provider = 'luma' then
    if coalesce(p_input ->> 'operation','') <> 'generate' then
      raise exception 'VIDEO_PRICE_OPERATION_INVALID';
    end if;
    if coalesce(p_input ->> 'durationSeconds','') not in ('5','10') then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if coalesce(p_input ->> 'resolution','') not in ('540p','720p','1080p') then
      raise exception 'VIDEO_PRICE_UNSUPPORTED_RESOLUTION';
    end if;
    if coalesce(p_input ->> 'audioMode','none') <> 'none' then
      raise exception 'VIDEO_PRICE_UNSUPPORTED_AUDIO_MODE';
    end if;
    -- Exact Luma credits multiplied by the account/contract rate are recorded
    -- in the immutable quote. Approval RPC enforces the approved ceiling.
  else
    -- Gemini Omni direct API preflight: 1,048,576 input tokens at $1.50/M
    -- plus 57,920 output video tokens (10s at 5,792 tokens/s) at $17.50/M.
    -- The reservation is deliberately conservative; actual usage is reconciled
    -- from the completed interaction before budget settlement.$new$;
begin
  function_oid := to_regprocedure(
    'executive_visuals.enqueue_video_generation_job(uuid,uuid,text,text,text,text,jsonb,uuid,numeric,text)'
  );
  if function_oid is null then raise exception 'LUMA_VIDEO_ENQUEUE_RPC_NOT_FOUND'; end if;
  function_sql := pg_get_functiondef(function_oid);
  if strpos(function_sql,old_provider_gate)>0 and strpos(function_sql,old_google_branch)>0 then
    function_sql := replace(function_sql,old_provider_gate,new_provider_gate);
    function_sql := replace(function_sql,old_google_branch,new_google_branch);
    execute function_sql;
  elsif strpos(function_sql,new_provider_gate)>0 and strpos(function_sql,new_google_branch)>0 then
    null;
  else
    raise exception 'LUMA_VIDEO_ENQUEUE_RPC_SOURCE_MISMATCH';
  end if;
end
$luma_enqueue_provider$;
