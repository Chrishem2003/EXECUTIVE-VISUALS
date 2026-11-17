-- Verify direct Runway model quote, approval and per-model budget policy wiring.
do $direct_runway_workflow_contract$
declare
  quote_sql text;
  approval_sql text;
  model_check text;
  pricing_check text;
begin
  select pg_get_functiondef(to_regprocedure(
    'executive_visuals.record_video_workflow_quote(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,numeric,text,text,text,timestamptz)'
  )) into quote_sql;
  select pg_get_functiondef(to_regprocedure(
    'executive_visuals.approve_and_enqueue_video_workflow(uuid,uuid,uuid,uuid,text,text,text,jsonb,numeric,text)'
  )) into approval_sql;
  if quote_sql is null or approval_sql is null then
    raise exception 'DIRECT_RUNWAY_WORKFLOW_RPC_MISSING';
  end if;
  if position('seedance2_5' in quote_sql)=0
     or position('kling_4' in quote_sql)=0
     or position('kling_4_flash' in quote_sql)=0
     or position('runway_direct_model_list_price' in quote_sql)=0 then
    raise exception 'DIRECT_RUNWAY_WORKFLOW_QUOTE_POLICY_MISSING';
  end if;
  if position('seedance2_5' in approval_sql)=0
     or position('kling_4' in approval_sql)=0
     or position('kling_4_flash' in approval_sql)=0
     or position('b.model = quote_row.model' in approval_sql)=0 then
    raise exception 'DIRECT_RUNWAY_WORKFLOW_APPROVAL_POLICY_MISSING';
  end if;
  select pg_get_constraintdef(oid) into model_check
  from pg_constraint where conrelid='executive_visuals.video_workflow_quotes'::regclass
    and conname='video_workflow_quotes_model_check';
  select pg_get_constraintdef(oid) into pricing_check
  from pg_constraint where conrelid='executive_visuals.video_workflow_quotes'::regclass
    and conname='video_workflow_quotes_pricing_source_check';
  if model_check is null or position('seedance2_5' in model_check)=0
     or position('kling_4' in model_check)=0
     or position('kling_4_flash' in model_check)=0
     or position('ray-3.2' in model_check)=0 then
    raise exception 'DIRECT_RUNWAY_WORKFLOW_QUOTE_MODEL_CONSTRAINT_MISSING';
  end if;
  if pricing_check is null or position('runway_direct_model_list_price' in pricing_check)=0
     or position('luma_ray32_published_credits_contract_rate' in pricing_check)=0 then
    raise exception 'DIRECT_RUNWAY_WORKFLOW_QUOTE_PRICING_CONSTRAINT_MISSING';
  end if;
end
$direct_runway_workflow_contract$;
select 'Direct Runway workflow quote and approval SQL contract passed' as result;
