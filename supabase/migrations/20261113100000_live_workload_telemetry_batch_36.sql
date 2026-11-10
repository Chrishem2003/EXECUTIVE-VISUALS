-- Batch 36: durable multidimensional workload telemetry, separate from estimates and invoices.
create table if not exists executive_visuals.ai_workload_telemetry_events(
 id uuid primary key default gen_random_uuid(),
 occurred_at timestamptz not null,
 period_month date not null check(period_month=date_trunc('month',period_month)::date),
 owner_id uuid references auth.users(id),
 project_id uuid,
 job_id uuid,
 operation_id text not null,
 provider text not null,
 model text not null,
 operation text not null check(operation in('text','image','video','render','upscale','audio','embedding','other')),
 evidence_source text not null check(evidence_source in('provider_response','worker_measurement','invoice_reconciliation','admin_import')),
 resolution_tier text not null default 'unknown' check(resolution_tier in('unknown','360p','480p','540p','720p','1080p','1440p','2160p','4k','custom')),
 currency text,
 provider_cost_minor bigint,
 dimensions jsonb not null default '{}'::jsonb check(jsonb_typeof(dimensions)='object'),
 resource_type text not null default '',
 resource_unit text not null default '',
 resource_quantity numeric(24,8),
 evidence_reference text not null default '',
 idempotency_key text not null unique,
 recorded_at timestamptz not null default now(),
 check(provider_cost_minor is null or provider_cost_minor>=0),
 check(currency is null or currency ~ '^[A-Z]{3}$'),
 check((provider_cost_minor is null and currency is null) or (provider_cost_minor is not null and currency is not null)),
 check(resource_quantity is null or resource_quantity>=0)
);
create index if not exists ai_workload_telemetry_period_idx
 on executive_visuals.ai_workload_telemetry_events(period_month,provider,model,operation);
create index if not exists ai_workload_telemetry_owner_idx
 on executive_visuals.ai_workload_telemetry_events(owner_id,period_month) where owner_id is not null;
create index if not exists ai_workload_telemetry_job_idx
 on executive_visuals.ai_workload_telemetry_events(job_id) where job_id is not null;
alter table executive_visuals.ai_workload_telemetry_events enable row level security;
revoke all on executive_visuals.ai_workload_telemetry_events from public,anon,authenticated;
grant select,insert on executive_visuals.ai_workload_telemetry_events to service_role;
create trigger ai_workload_telemetry_immutable before update or delete
 on executive_visuals.ai_workload_telemetry_events
 for each row execute function executive_visuals.reject_revenue_intelligence_mutation();

create or replace function executive_visuals.record_ai_workload_telemetry_event(
 p_actor_id uuid,p_occurred_at timestamptz,p_owner_id uuid,p_project_id uuid,p_job_id uuid,
 p_operation_id text,p_provider text,p_model text,p_operation text,p_evidence_source text,
 p_resolution_tier text,p_currency text,p_provider_cost_minor bigint,p_dimensions jsonb,
 p_resource_type text,p_resource_unit text,p_resource_quantity numeric,
 p_evidence_reference text,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_existing ai_workload_telemetry_events%rowtype; v_id uuid; v_month date;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_occurred_at is null or coalesce(length(p_operation_id),0) not between 1 and 180
  or coalesce(length(p_provider),0) not between 2 and 80 or coalesce(length(p_model),0) not between 1 and 160
  or p_operation not in('text','image','video','render','upscale','audio','embedding','other')
  or p_evidence_source not in('provider_response','worker_measurement','invoice_reconciliation','admin_import')
  or p_resolution_tier not in('unknown','360p','480p','540p','720p','1080p','1440p','2160p','4k','custom')
  or (p_currency is not null and p_currency !~ '^[A-Z]{3}$')
  or (p_provider_cost_minor is not null and (p_provider_cost_minor<0 or p_currency is null))
  or (p_resource_quantity is not null and p_resource_quantity<0)
  or coalesce(length(p_resource_type),0)>60 or coalesce(length(p_resource_unit),0)>30
  or coalesce(length(p_evidence_reference),0)>240
  or coalesce(length(p_idempotency_key),0) not between 8 and 180
  or jsonb_typeof(coalesce(p_dimensions,'{}'::jsonb))<>'object'
  or pg_column_size(coalesce(p_dimensions,'{}'::jsonb))>16000
  or exists(
    select 1 from jsonb_each(coalesce(p_dimensions,'{}'::jsonb)) d
    where d.key not in('inputAudioTokens','outputAudioTokens','cachedInputTokens','reasoningTokens',
      'inputImageCount','outputImageCount','referenceImageCount','referenceVideoSeconds',
      'generatedVideoSeconds','renderSeconds','upscaleImageCount','framesProcessed',
      'acceptedOutputs','rejectedOutputs','retryCount','attemptCount','latencyMs',
      'cpuSeconds','gpuSeconds','storageGbSeconds','egressBytes')
     or jsonb_typeof(d.value)<>'number' or (d.value #>> '{}')::numeric<0
  ) then
  raise exception 'Invalid multidimensional workload telemetry' using errcode='22023';
 end if;
 if p_owner_id is not null and not exists(select 1 from auth.users where id=p_owner_id) then
  raise exception 'Workload owner attribution does not exist' using errcode='22023';
 end if;
 v_month:=date_trunc('month',p_occurred_at)::date;
 select * into v_existing from ai_workload_telemetry_events where idempotency_key=p_idempotency_key;
 if found then
  if v_existing.operation_id<>p_operation_id or v_existing.provider<>p_provider or v_existing.model<>p_model
    or v_existing.occurred_at<>p_occurred_at then
   raise exception 'Workload telemetry idempotency key conflicts with existing event' using errcode='23505';
  end if;
  return jsonb_build_object('id',v_existing.id,'periodMonth',v_existing.period_month,'idempotentReplay',true);
 end if;
 insert into ai_workload_telemetry_events(occurred_at,period_month,owner_id,project_id,job_id,operation_id,
  provider,model,operation,evidence_source,resolution_tier,currency,provider_cost_minor,dimensions,
  resource_type,resource_unit,resource_quantity,evidence_reference,idempotency_key)
 values(p_occurred_at,v_month,p_owner_id,p_project_id,p_job_id,p_operation_id,p_provider,p_model,p_operation,
  p_evidence_source,p_resolution_tier,p_currency,p_provider_cost_minor,coalesce(p_dimensions,'{}'::jsonb),
  coalesce(p_resource_type,''),coalesce(p_resource_unit,''),p_resource_quantity,coalesce(p_evidence_reference,''),p_idempotency_key)
 returning id into v_id;
 perform write_financial_admin_audit(p_actor_id,'finance.ai_workload_telemetry.recorded',
  'ai_workload_telemetry_event',v_id::text,'Recorded multidimensional workload usage evidence',
  p_idempotency_key,jsonb_build_object('provider',p_provider,'model',p_model,'operation',p_operation,
   'evidenceSource',p_evidence_source,'dimensions',coalesce(p_dimensions,'{}'::jsonb),
   'providerCostMinor',p_provider_cost_minor,'currency',p_currency));
 return jsonb_build_object('id',v_id,'periodMonth',v_month,'idempotentReplay',false);
end $$;

create or replace function executive_visuals.ai_workload_telemetry_overview(
 p_actor_id uuid,p_period_month date default date_trunc('month',now())::date,p_limit integer default 100
) returns jsonb language plpgsql security definer set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_groups jsonb; v_totals jsonb;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_period_month is null or p_period_month<>date_trunc('month',p_period_month)::date or p_limit is null or p_limit not between 1 and 500 then
  raise exception 'Invalid workload telemetry period or limit' using errcode='22023';
 end if;
 select coalesce(jsonb_agg(to_jsonb(g)),'[]'::jsonb) into v_groups from (
  select provider,model,operation,evidence_source,resolution_tier,count(*) event_count,
   count(*) filter(where provider_cost_minor is not null) cost_evidence_count,
   count(*) filter(where owner_id is null) unattributed_count
  from ai_workload_telemetry_events where period_month=p_period_month
  group by provider,model,operation,evidence_source,resolution_tier
  order by count(*) desc,provider,model limit p_limit
 ) g;
 select jsonb_build_object('eventCount',count(*),
  'providerCostEvidenceCount',count(*) filter(where provider_cost_minor is not null),
  'unpricedCostEvidenceCount',count(*) filter(where provider_cost_minor is null),
  'unattributedCount',count(*) filter(where owner_id is null),
  'acceptedOutputs',coalesce(sum((dimensions->>'acceptedOutputs')::numeric),0),
  'rejectedOutputs',coalesce(sum((dimensions->>'rejectedOutputs')::numeric),0),
  'referenceVideoSeconds',coalesce(sum((dimensions->>'referenceVideoSeconds')::numeric),0),
  'generatedVideoSeconds',coalesce(sum((dimensions->>'generatedVideoSeconds')::numeric),0),
  'renderSeconds',coalesce(sum((dimensions->>'renderSeconds')::numeric),0),
  'framesProcessed',coalesce(sum((dimensions->>'framesProcessed')::numeric),0))
 into v_totals from ai_workload_telemetry_events where period_month=p_period_month;
 return jsonb_build_object('periodMonth',p_period_month,'totals',v_totals,'byProviderModelOperation',v_groups,
  'limitations',jsonb_build_array('Provider costs are reported evidence, not inferred from dimensions.','Dimension totals are observed counters and must not be interpreted as money.','Unattributed events remain visible and are not assigned to a customer by inference.'));
end $$;

revoke all on function executive_visuals.record_ai_workload_telemetry_event(uuid,timestamptz,uuid,uuid,uuid,text,text,text,text,text,text,text,bigint,jsonb,text,text,numeric,text,text) from public,anon,authenticated;
revoke all on function executive_visuals.ai_workload_telemetry_overview(uuid,date,integer) from public,anon,authenticated;
grant execute on function executive_visuals.record_ai_workload_telemetry_event(uuid,timestamptz,uuid,uuid,uuid,text,text,text,text,text,text,text,bigint,jsonb,text,text,numeric,text,text) to service_role;
grant execute on function executive_visuals.ai_workload_telemetry_overview(uuid,date,integer) to service_role;
