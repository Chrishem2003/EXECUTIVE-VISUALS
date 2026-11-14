-- Extend the existing authenticated quote/approval/enqueue contract to the
-- already-budgeted Gemini Omni worker. Provider execution remains opt-in.
do $google_workflow_constraints$
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
      check (provider in ('runway','google')),
    add constraint video_workflow_quotes_model_check
      check ((provider='runway' and model='model-router')
          or (provider='google' and model='gemini-omni-1.1-flash')),
    add constraint video_workflow_quotes_operation_check
      check ((provider='runway' and operation in ('text-to-video','image-to-video','video-to-video'))
          or (provider='google' and operation in ('generate','edit','extend'))),
    add constraint video_workflow_quotes_pricing_source_check
      check ((provider='runway' and pricing_source='runway_model_router_dry_run')
          or (provider='google' and pricing_source='google_gemini_omni_token_pricing_2026-11-05'));
end
$google_workflow_constraints$;

do $google_workflow_quote_rpc$
declare
  function_oid regprocedure;
  function_sql text;
  old_identity text := $old$or p_provider <> 'runway' or p_model <> 'model-router'
     or p_operation not in ('text-to-video','image-to-video','video-to-video')$old$;
  new_identity text := $new$or not ((p_provider='runway' and p_model='model-router')
       or (p_provider='google' and p_model='gemini-omni-1.1-flash'))
     or not ((p_provider='runway' and p_operation in ('text-to-video','image-to-video','video-to-video'))
       or (p_provider='google' and p_operation in ('generate','edit','extend')))$new$;
  old_pricing text := $old$or p_pricing_source <> 'runway_model_router_dry_run'$old$;
  new_pricing text := $new$or not ((p_provider='runway' and p_pricing_source='runway_model_router_dry_run')
       or (p_provider='google' and p_pricing_source='google_gemini_omni_token_pricing_2026-11-05'))$new$;
begin
  function_oid := to_regprocedure(
    'executive_visuals.record_video_workflow_quote(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,numeric,text,text,text,timestamptz)'
  );
  if function_oid is null then raise exception 'GOOGLE_WORKFLOW_QUOTE_RPC_NOT_FOUND'; end if;
  function_sql := pg_get_functiondef(function_oid);
  if strpos(function_sql,old_identity)>0 and strpos(function_sql,old_pricing)>0 then
    function_sql := replace(function_sql,old_identity,new_identity);
    function_sql := replace(function_sql,old_pricing,new_pricing);
    execute function_sql;
  elsif strpos(function_sql,new_identity)>0 and strpos(function_sql,new_pricing)>0 then
    null;
  else
    raise exception 'GOOGLE_WORKFLOW_QUOTE_RPC_SOURCE_MISMATCH';
  end if;
end
$google_workflow_quote_rpc$;

do $google_workflow_approval_rpc$
declare
  function_oid regprocedure;
  function_sql text;
  old_replay text := $old$or coalesce(existing.input ->> 'provider','') <> 'runway'
       or coalesce(existing.input ->> 'model','') <> 'model-router'$old$;
  new_replay text := $new$or coalesce(existing.input ->> 'provider','') <> quote_row.provider
       or coalesce(existing.input ->> 'model','') <> quote_row.model$new$;
  old_identity text := $old$or quote_row.provider <> 'runway'
     or quote_row.model <> 'model-router'$old$;
  new_identity text := $new$or not ((quote_row.provider='runway' and quote_row.model='model-router')
       or (quote_row.provider='google' and quote_row.model='gemini-omni-1.1-flash'))$new$;
  old_policy text := $old$and b.provider = 'runway'
    and b.model = 'model-router'$old$;
  new_policy text := $new$and b.provider = quote_row.provider
    and b.model = quote_row.model$new$;
begin
  function_oid := to_regprocedure(
    'executive_visuals.approve_and_enqueue_video_workflow(uuid,uuid,uuid,uuid,text,text,text,jsonb,numeric,text)'
  );
  if function_oid is null then raise exception 'GOOGLE_WORKFLOW_APPROVAL_RPC_NOT_FOUND'; end if;
  function_sql := pg_get_functiondef(function_oid);
  if strpos(function_sql,old_replay)>0 and strpos(function_sql,old_identity)>0 and strpos(function_sql,old_policy)>0 then
    function_sql := replace(function_sql,old_replay,new_replay);
    function_sql := replace(function_sql,old_identity,new_identity);
    function_sql := replace(function_sql,old_policy,new_policy);
    execute function_sql;
  elsif strpos(function_sql,new_replay)>0 and strpos(function_sql,new_identity)>0 and strpos(function_sql,new_policy)>0 then
    null;
  else
    raise exception 'GOOGLE_WORKFLOW_APPROVAL_RPC_SOURCE_MISMATCH';
  end if;
end
$google_workflow_approval_rpc$;
