-- Verify the Luma Ray 3.2 durable quote/approval/enqueue contract after migration.
do $$
declare
  quotes_oid regclass := to_regclass('executive_visuals.video_workflow_quotes');
  constraint_def text;
  quote_rpc text;
  approval_rpc text;
  enqueue_rpc text;
begin
  if quotes_oid is null then raise exception 'VIDEO_WORKFLOW_QUOTES_TABLE_MISSING'; end if;

  select pg_get_constraintdef(oid) into constraint_def
    from pg_constraint where conrelid=quotes_oid and conname='video_workflow_quotes_provider_check';
  if constraint_def is null or position('luma' in constraint_def)=0 then
    raise exception 'LUMA_QUOTE_PROVIDER_CONSTRAINT_MISSING';
  end if;
  select pg_get_constraintdef(oid) into constraint_def
    from pg_constraint where conrelid=quotes_oid and conname='video_workflow_quotes_model_check';
  if constraint_def is null or position('ray-3.2' in constraint_def)=0 then
    raise exception 'LUMA_QUOTE_MODEL_CONSTRAINT_MISSING';
  end if;
  select pg_get_constraintdef(oid) into constraint_def
    from pg_constraint where conrelid=quotes_oid and conname='video_workflow_quotes_operation_check';
  if constraint_def is null or position('generate' in constraint_def)=0 or position('luma' in constraint_def)=0 then
    raise exception 'LUMA_QUOTE_OPERATION_CONSTRAINT_MISSING';
  end if;
  select pg_get_constraintdef(oid) into constraint_def
    from pg_constraint where conrelid=quotes_oid and conname='video_workflow_quotes_pricing_source_check';
  if constraint_def is null or position('luma_ray32_published_credits_contract_rate' in constraint_def)=0 then
    raise exception 'LUMA_QUOTE_PRICING_SOURCE_CONSTRAINT_MISSING';
  end if;

  quote_rpc := pg_get_functiondef(to_regprocedure(
    'executive_visuals.record_video_workflow_quote(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,numeric,text,text,text,timestamptz)'
  ));
  approval_rpc := pg_get_functiondef(to_regprocedure(
    'executive_visuals.approve_and_enqueue_video_workflow(uuid,uuid,uuid,uuid,text,text,text,jsonb,numeric,text)'
  ));
  enqueue_rpc := pg_get_functiondef(to_regprocedure(
    'executive_visuals.enqueue_video_generation_job(uuid,uuid,text,text,text,text,jsonb,uuid,numeric,text)'
  ));
  if position('luma' in quote_rpc)=0 or position('ray-3.2' in quote_rpc)=0 then
    raise exception 'LUMA_QUOTE_RPC_IDENTITY_GATE_MISSING';
  end if;
  if position('luma' in approval_rpc)=0 or position('ray-3.2' in approval_rpc)=0 then
    raise exception 'LUMA_APPROVAL_RPC_IDENTITY_GATE_MISSING';
  end if;
  if position('luma' in enqueue_rpc)=0 or position('ray-3.2' in enqueue_rpc)=0 then
    raise exception 'LUMA_ENQUEUE_RPC_PROVIDER_GATE_MISSING';
  end if;
end
$$;
