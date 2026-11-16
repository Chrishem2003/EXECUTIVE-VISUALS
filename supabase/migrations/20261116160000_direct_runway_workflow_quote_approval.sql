-- Extend the existing quote/owner-approval RPC to direct Runway model workers.
-- No provider is enabled here. This only allows the same durable approval path to
-- bind exact direct model quotes to their existing model-specific budget policies.

do $direct_runway_quote_constraints$
begin
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
      check ((provider='runway' and model in ('model-router','gen4.5','seedance2_5','kling_4','kling3.0_standard','kling3.0_pro','kling3.0_4k'))
          or (provider='google' and model='gemini-omni-1.1-flash')
          or (provider='luma' and model='ray-3.2')),
    add constraint video_workflow_quotes_operation_check
      check ((provider='runway' and operation in ('text-to-video','image-to-video','video-to-video'))
          or (provider='google' and operation in ('generate','edit','extend'))
          or (provider='luma' and operation in ('generate','video_edit','video_reframe'))),
    add constraint video_workflow_quotes_pricing_source_check
      check ((provider='runway' and pricing_source in ('runway_model_router_dry_run','runway_direct_model_list_price'))
          or (provider='google' and pricing_source='google_gemini_omni_token_pricing_2026-11-05')
          or (provider='luma' and pricing_source='luma_ray32_published_credits_contract_rate'));
end
$direct_runway_quote_constraints$;

do $direct_runway_quote_rpc$
declare
  function_oid regprocedure;
  function_sql text;
  new_identity text := $new$or not ((p_provider='runway' and p_model in ('model-router','gen4.5','seedance2_5','kling_4','kling3.0_standard','kling3.0_pro','kling3.0_4k'))
       or (p_provider='google' and p_model='gemini-omni-1.1-flash')
       or (p_provider='luma' and p_model='ray-3.2'))
     or not ((p_provider='runway' and p_operation in ('text-to-video','image-to-video','video-to-video'))
       or (p_provider='google' and p_operation in ('generate','edit','extend'))
       or (p_provider='luma' and p_operation in ('generate','video_edit','video_reframe')))$new$;
  new_identity text := $new$or not ((p_provider='runway' and p_model in ('model-router','gen4.5','seedance2_5','kling_4','kling3.0_standard','kling3.0_pro','kling3.0_4k'))
       or (p_provider='google' and p_model='gemini-omni-1.1-flash'))
     or not ((p_provider='runway' and p_operation in ('text-to-video','image-to-video','video-to-video'))
       or (p_provider='google' and p_operation in ('generate','edit','extend')))$new$;
  new_pricing text := $new$or not ((p_provider='runway' and p_pricing_source in ('runway_model_router_dry_run','runway_direct_model_list_price'))
       or (p_provider='google' and p_pricing_source='google_gemini_omni_token_pricing_2026-11-05')
       or (p_provider='luma' and p_pricing_source='luma_ray32_published_credits_contract_rate'))$new$;
  new_pricing text := $new$or not ((p_provider='runway' and p_pricing_source in ('runway_model_router_dry_run','runway_direct_model_list_price'))
       or (p_provider='google' and p_pricing_source='google_gemini_omni_token_pricing_2026-11-05'))$new$;
begin
  function_oid := to_regprocedure(
    'executive_visuals.record_video_workflow_quote(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,numeric,text,text,text,timestamptz)'
  );
  if function_oid is null then raise exception 'DIRECT_RUNWAY_WORKFLOW_QUOTE_RPC_NOT_FOUND'; end if;
  function_sql := pg_get_functiondef(function_oid);
  if strpos(function_sql,old_identity)>0 and strpos(function_sql,old_pricing)>0 then
    function_sql := replace(function_sql,old_identity,new_identity);
    function_sql := replace(function_sql,old_pricing,new_pricing);
    execute function_sql;
  elsif strpos(function_sql,new_identity)>0 and strpos(function_sql,new_pricing)>0 then
    null;
  else
    raise exception 'DIRECT_RUNWAY_WORKFLOW_QUOTE_RPC_SOURCE_MISMATCH';
  end if;
end
$direct_runway_quote_rpc$;

do $direct_runway_approval_rpc$
declare
  function_oid regprocedure;
  function_sql text;
  new_identity text := $new$or not ((quote_row.provider='runway' and quote_row.model in ('model-router','gen4.5','seedance2_5','kling_4','kling3.0_standard','kling3.0_pro','kling3.0_4k'))
       or (quote_row.provider='google' and quote_row.model='gemini-omni-1.1-flash')
       or (quote_row.provider='luma' and quote_row.model='ray-3.2'))$new$;
  new_identity text := $new$or not ((quote_row.provider='runway' and quote_row.model in ('model-router','gen4.5','seedance2_5','kling_4','kling3.0_standard','kling3.0_pro','kling3.0_4k'))
       or (quote_row.provider='google' and quote_row.model='gemini-omni-1.1-flash'))$new$;
begin
  function_oid := to_regprocedure(
    'executive_visuals.approve_and_enqueue_video_workflow(uuid,uuid,uuid,uuid,text,text,text,jsonb,numeric,text)'
  );
  if function_oid is null then raise exception 'DIRECT_RUNWAY_WORKFLOW_APPROVAL_RPC_NOT_FOUND'; end if;
  function_sql := pg_get_functiondef(function_oid);
  if strpos(function_sql,old_identity)>0 then
    function_sql := replace(function_sql,old_identity,new_identity);
    execute function_sql;
  elsif strpos(function_sql,new_identity)>0 then
    null;
  else
    raise exception 'DIRECT_RUNWAY_WORKFLOW_APPROVAL_RPC_SOURCE_MISMATCH';
  end if;
end
$direct_runway_approval_rpc$;
