-- Batch 23: measured worker resource economics and evidence-gated model-routing shadow decisions.
create table if not exists executive_visuals.ai_resource_rate_catalog(
 id uuid primary key default gen_random_uuid(),
 provider text not null,
 resource_type text not null check(resource_type in('ffmpeg_second','render_second','gpu_second','cpu_second','storage_gb_day','egress_gb')),
 unit text not null check(unit in('second','gb_day','gb')),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 rate_minor_per_unit numeric(24,8) not null check(rate_minor_per_unit>=0),
 effective_from timestamptz not null,
 effective_to timestamptz,
 source_type text not null check(source_type in('provider_invoice','cloud_contract','admin_verified')),
 source_reference text not null,
 recorded_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 check(effective_to is null or effective_to>effective_from),
 unique(provider,resource_type,unit,currency,effective_from)
);
create index if not exists ai_resource_rate_lookup_idx
 on executive_visuals.ai_resource_rate_catalog(provider,resource_type,unit,currency,effective_from desc);
create table if not exists executive_visuals.ai_resource_cost_events(
 id uuid primary key default gen_random_uuid(),
 occurred_at timestamptz not null,
 period_month date not null check(period_month=date_trunc('month',period_month)::date),
 owner_id uuid references auth.users(id),
 project_id uuid,
 job_id uuid,
 operation_id text not null,
 provider text not null,
 model text not null,
 resource_type text not null check(resource_type in('ffmpeg_second','render_second','gpu_second','cpu_second','storage_gb_day','egress_gb')),
 quantity numeric(24,8) not null check(quantity>0),
 unit text not null check(unit in('second','gb_day','gb')),
 currency text,
 cost_minor bigint,
 cost_basis text not null check(cost_basis in('provider_reported','catalog_estimate','unpriced')),
 rate_catalog_id uuid references executive_visuals.ai_resource_rate_catalog(id),
 idempotency_key text not null unique,
 evidence jsonb not null default '{}'::jsonb,
 recorded_at timestamptz not null default now(),
 check((resource_type in('ffmpeg_second','render_second','gpu_second','cpu_second') and unit='second')
  or (resource_type='storage_gb_day' and unit='gb_day')
  or (resource_type='egress_gb' and unit='gb')),
 check((cost_basis='unpriced' and cost_minor is null and currency is null)
  or (cost_basis<>'unpriced' and cost_minor is not null and cost_minor>=0 and currency ~ '^[A-Z]{3}$'))
);
create index if not exists ai_resource_cost_period_idx
 on executive_visuals.ai_resource_cost_events(period_month,resource_type,currency,provider);
create index if not exists ai_resource_cost_customer_idx
 on executive_visuals.ai_resource_cost_events(owner_id,period_month) where owner_id is not null;
create index if not exists ai_resource_cost_job_idx
 on executive_visuals.ai_resource_cost_events(job_id) where job_id is not null;

create table if not exists executive_visuals.ai_model_performance_events(
 id uuid primary key default gen_random_uuid(),
 usage_event_id uuid not null unique references executive_visuals.ai_usage_cost_events(id) on delete restrict,
 provider text not null,
 model text not null,
 operation text not null check(operation in('text','image','video','render','upscale','audio','embedding','other')),
 latency_ms integer not null check(latency_ms between 1 and 86400000),
 quality_score numeric(6,5) not null check(quality_score between 0 and 1),
 quality_source text not null check(quality_source in('human_review','approved_evaluator')),
 evaluation_version text not null,
 idempotency_key text not null unique,
 evaluated_by uuid not null references auth.users(id),
 evaluated_at timestamptz not null default now()
);
create index if not exists ai_model_performance_lookup_idx
 on executive_visuals.ai_model_performance_events(operation,provider,model,evaluated_at desc);

create table if not exists executive_visuals.ai_model_route_shadow_decisions(
 id uuid primary key default gen_random_uuid(),
 operation text not null,
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 max_cost_minor bigint not null check(max_cost_minor>0),
 max_latency_ms integer not null check(max_latency_ms>0),
 min_quality_score numeric(6,5) not null check(min_quality_score between 0 and 1),
 recommended_provider text,
 recommended_model text,
 decision_status text not null check(decision_status in('recommended','insufficient_evidence','no_candidate_meets_constraints')),
 candidate_evidence jsonb not null default '[]'::jsonb,
 decision_mode text not null default 'shadow_only' check(decision_mode='shadow_only'),
 execution_changed boolean not null default false check(execution_changed=false),
 idempotency_key text not null unique,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now()
);

alter table executive_visuals.ai_resource_rate_catalog enable row level security;
alter table executive_visuals.ai_resource_cost_events enable row level security;
alter table executive_visuals.ai_model_performance_events enable row level security;
alter table executive_visuals.ai_model_route_shadow_decisions enable row level security;
revoke all on executive_visuals.ai_resource_rate_catalog,executive_visuals.ai_resource_cost_events,
 executive_visuals.ai_model_performance_events,executive_visuals.ai_model_route_shadow_decisions
 from public,anon,authenticated;
grant select,insert on executive_visuals.ai_resource_rate_catalog,executive_visuals.ai_resource_cost_events,
 executive_visuals.ai_model_performance_events,executive_visuals.ai_model_route_shadow_decisions to service_role;
create trigger ai_resource_rate_catalog_immutable before update or delete
 on executive_visuals.ai_resource_rate_catalog for each row
 execute function executive_visuals.reject_revenue_intelligence_mutation();
create trigger ai_resource_cost_events_immutable before update or delete
 on executive_visuals.ai_resource_cost_events for each row
 execute function executive_visuals.reject_revenue_intelligence_mutation();
create trigger ai_model_performance_events_immutable before update or delete
 on executive_visuals.ai_model_performance_events for each row
 execute function executive_visuals.reject_revenue_intelligence_mutation();
create trigger ai_model_route_shadow_decisions_immutable before update or delete
 on executive_visuals.ai_model_route_shadow_decisions for each row
 execute function executive_visuals.reject_revenue_intelligence_mutation();

create or replace function executive_visuals.add_ai_resource_rate_card(
 p_actor_id uuid,p_provider text,p_resource_type text,p_unit text,p_currency text,
 p_rate_minor_per_unit numeric,p_effective_from timestamptz,p_effective_to timestamptz,
 p_source_type text,p_source_reference text
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_id uuid;v_duplicate boolean:=false;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if coalesce(length(p_provider),0) not between 2 and 80
  or p_resource_type not in('ffmpeg_second','render_second','gpu_second','cpu_second','storage_gb_day','egress_gb')
  or p_unit not in('second','gb_day','gb')
  or (p_resource_type in('ffmpeg_second','render_second','gpu_second','cpu_second') and p_unit<>'second')
  or (p_resource_type='storage_gb_day' and p_unit<>'gb_day')
  or (p_resource_type='egress_gb' and p_unit<>'gb')
  or coalesce(p_currency,'') !~ '^[A-Z]{3}$'
  or p_rate_minor_per_unit is null or p_rate_minor_per_unit<0 or p_rate_minor_per_unit>1000000000000
  or p_effective_from is null or (p_effective_to is not null and p_effective_to<=p_effective_from)
  or p_source_type not in('provider_invoice','cloud_contract','admin_verified')
  or coalesce(length(btrim(p_source_reference)),0) not between 3 and 240 then
  raise exception 'Invalid resource rate card' using errcode='22023';
 end if;
 insert into ai_resource_rate_catalog(provider,resource_type,unit,currency,rate_minor_per_unit,
  effective_from,effective_to,source_type,source_reference,recorded_by)
 values(lower(p_provider),p_resource_type,p_unit,p_currency,p_rate_minor_per_unit,
  p_effective_from,p_effective_to,p_source_type,p_source_reference,p_actor_id)
 on conflict(provider,resource_type,unit,currency,effective_from) do nothing
 returning id into v_id;
 if v_id is null then
  select id into v_id from ai_resource_rate_catalog
  where provider=lower(p_provider) and resource_type=p_resource_type and unit=p_unit
   and currency=p_currency and effective_from=p_effective_from;
  v_duplicate:=true;
 end if;
 perform write_financial_admin_audit(p_actor_id,'finance.resource_rate.created','ai_resource_rate_catalog',
  v_id::text,'Added effective-dated resource cost rate',p_source_reference,
  jsonb_build_object('provider',lower(p_provider),'resourceType',p_resource_type,'unit',p_unit,
   'currency',p_currency,'rateMinorPerUnit',p_rate_minor_per_unit,'effectiveFrom',p_effective_from));
 return jsonb_build_object('rateCardId',v_id,'duplicate',v_duplicate);
end $$;

create or replace function executive_visuals.record_ai_resource_usage_event(
 p_actor_id uuid,p_occurred_at timestamptz,p_owner_id uuid,p_project_id uuid,p_job_id uuid,
 p_operation_id text,p_provider text,p_model text,p_resource_type text,p_quantity numeric,
 p_unit text,p_currency text,p_provider_cost_minor bigint,p_idempotency_key text,p_evidence jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_existing ai_resource_cost_events%rowtype; v_rate ai_resource_rate_catalog%rowtype;
 v_cost numeric; v_basis text:='unpriced'; v_currency text; v_rate_id uuid; v_id uuid; v_month date;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_occurred_at is null or coalesce(length(p_operation_id),0) not between 1 and 180
  or coalesce(length(p_provider),0) not between 2 and 80 or coalesce(length(p_model),0) not between 1 and 160
  or p_resource_type not in('ffmpeg_second','render_second','gpu_second','cpu_second','storage_gb_day','egress_gb')
  or p_quantity is null or p_quantity<=0 or p_quantity>1000000000000
  or p_unit not in('second','gb_day','gb')
  or (p_resource_type in('ffmpeg_second','render_second','gpu_second','cpu_second') and p_unit<>'second')
  or (p_resource_type='storage_gb_day' and p_unit<>'gb_day')
  or (p_resource_type='egress_gb' and p_unit<>'gb')
  or (p_currency is not null and p_currency !~ '^[A-Z]{3}$')
  or (p_provider_cost_minor is not null and (p_provider_cost_minor<0 or p_currency is null))
  or coalesce(length(p_idempotency_key),0) not between 8 and 180
  or jsonb_typeof(coalesce(p_evidence,'{}'::jsonb))<>'object'
  or length(coalesce(p_evidence::text,''))>4000 then
  raise exception 'Invalid resource usage event' using errcode='22023';
 end if;
 v_month:=date_trunc('month',p_occurred_at)::date;
 select * into v_existing from ai_resource_cost_events where idempotency_key=p_idempotency_key;
 if found then
  if v_existing.operation_id<>p_operation_id or v_existing.resource_type<>p_resource_type
   or v_existing.quantity<>p_quantity or v_existing.provider<>lower(p_provider)
   or v_existing.model<>p_model or v_existing.unit<>p_unit
   or v_existing.owner_id is distinct from p_owner_id
   or v_existing.project_id is distinct from p_project_id
   or v_existing.job_id is distinct from p_job_id then
   raise exception 'Resource usage idempotency key conflicts with an existing event' using errcode='23505';
  end if;
  return jsonb_build_object('id',v_existing.id,'costBasis',v_existing.cost_basis,
   'costMinor',v_existing.cost_minor,'currency',v_existing.currency,'idempotentReplay',true);
 end if;
 if p_provider_cost_minor is not null then
  v_cost:=p_provider_cost_minor;v_currency:=p_currency;v_basis:='provider_reported';
 else
  if p_currency is not null then
   select * into v_rate from ai_resource_rate_catalog
   where provider=lower(p_provider) and resource_type=p_resource_type and unit=p_unit
    and currency=p_currency and effective_from<=p_occurred_at
    and (effective_to is null or effective_to>p_occurred_at)
   order by effective_from desc,created_at desc limit 1;
   if found then
    v_cost:=round(p_quantity*v_rate.rate_minor_per_unit);
    v_currency:=p_currency;v_rate_id:=v_rate.id;v_basis:='catalog_estimate';
   end if;
  end if;
 end if;
 insert into ai_resource_cost_events(occurred_at,period_month,owner_id,project_id,job_id,
  operation_id,provider,model,resource_type,quantity,unit,currency,cost_minor,cost_basis,
  rate_catalog_id,idempotency_key,evidence)
 values(p_occurred_at,v_month,p_owner_id,p_project_id,p_job_id,p_operation_id,lower(p_provider),
  p_model,p_resource_type,p_quantity,p_unit,v_currency,v_cost::bigint,v_basis,v_rate_id,
  p_idempotency_key,coalesce(p_evidence,'{}'::jsonb))
 returning id into v_id;
 return jsonb_build_object('id',v_id,'costBasis',v_basis,'costMinor',v_cost::bigint,
  'currency',v_currency,'rateCatalogId',v_rate_id,'idempotentReplay',false);
end $$;

create or replace function executive_visuals.ai_resource_economics_overview(
 p_actor_id uuid,p_period_month date
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_result jsonb;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_period_month is null or p_period_month<>date_trunc('month',p_period_month)::date then
  raise exception 'A valid first-of-month period is required' using errcode='22023';
 end if;
 with resource as(
  select provider,resource_type,unit,currency,count(*) events,sum(quantity) quantity,
   sum(cost_minor) filter(where cost_minor is not null) cost_minor,
   count(*) filter(where cost_basis='provider_reported') actual_cost_events,
   count(*) filter(where cost_basis='catalog_estimate') estimated_cost_events,
   count(*) filter(where cost_basis='unpriced') unpriced_events
  from ai_resource_cost_events where period_month=p_period_month
  group by provider,resource_type,unit,currency
 ), customer as(
  select owner_id,currency,sum(cost_minor) cost_minor,count(*) events
  from ai_resource_cost_events where period_month=p_period_month and owner_id is not null
   and cost_minor is not null group by owner_id,currency
 ), jobs as(
  select job_id,owner_id,provider,model,currency,sum(cost_minor) cost_minor,count(*) events
  from ai_resource_cost_events where period_month=p_period_month and job_id is not null
   and cost_minor is not null group by job_id,owner_id,provider,model,currency
  order by sum(cost_minor) desc limit 50
 )
 select jsonb_build_object('periodMonth',p_period_month,'generatedAt',now(),
  'byResource',coalesce((select jsonb_agg(to_jsonb(resource) order by cost_minor desc nulls last) from resource),'[]'::jsonb),
  'byCustomer',coalesce((select jsonb_agg(to_jsonb(customer) order by cost_minor desc) from customer),'[]'::jsonb),
  'topJobs',coalesce((select jsonb_agg(to_jsonb(jobs) order by cost_minor desc) from jobs),'[]'::jsonb),
  'unpricedEvents',(select count(*) from ai_resource_cost_events where period_month=p_period_month and cost_basis='unpriced'),
  'limitations',jsonb_build_array(
   'Only measured resource events are attributed; shared infrastructure is not allocated without a measured driver.',
   'FFmpeg elapsed time is wall-clock process duration, not CPU time.',
   'GPU time, memory, storage retention and egress remain unmeasured unless a worker or provider supplies those telemetry events.',
   'Catalog estimates remain distinct from provider-reported actual costs.'
  )
 ) into v_result;
 return v_result;
end $$;

create or replace function executive_visuals.record_ai_model_performance_event(
 p_actor_id uuid,p_usage_event_id uuid,p_provider text,p_model text,p_operation text,
 p_latency_ms integer,p_quality_score numeric,p_quality_source text,p_evaluation_version text,
 p_idempotency_key text
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_usage ai_usage_cost_events%rowtype;v_id uuid;v_existing ai_model_performance_events%rowtype;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_usage_event_id is null or p_latency_ms is null or p_latency_ms not between 1 and 86400000
  or p_quality_score is null or p_quality_score not between 0 and 1
  or p_quality_source not in('human_review','approved_evaluator')
  or coalesce(length(p_evaluation_version),0) not between 1 and 120
  or coalesce(length(p_idempotency_key),0) not between 8 and 180 then
  raise exception 'Invalid model performance evidence' using errcode='22023';
 end if;
 select * into v_usage from ai_usage_cost_events where id=p_usage_event_id;
 if not found or v_usage.provider<>lower(p_provider) or v_usage.requested_model<>p_model
  or v_usage.operation<>p_operation or v_usage.status<>'succeeded' then
  raise exception 'Performance evidence must reference a matching successful usage event' using errcode='22023';
 end if;
 select * into v_existing from ai_model_performance_events where idempotency_key=p_idempotency_key;
 if found then
  if v_existing.usage_event_id<>p_usage_event_id or v_existing.latency_ms<>p_latency_ms
   or v_existing.quality_score<>p_quality_score or v_existing.quality_source<>p_quality_source
   or v_existing.evaluation_version<>p_evaluation_version then
   raise exception 'Model performance idempotency key conflict' using errcode='23505';end if;
  return jsonb_build_object('id',v_existing.id,'idempotentReplay',true);
 end if;
 insert into ai_model_performance_events(usage_event_id,provider,model,operation,latency_ms,
  quality_score,quality_source,evaluation_version,idempotency_key,evaluated_by)
 values(p_usage_event_id,lower(p_provider),p_model,p_operation,p_latency_ms,p_quality_score,
  p_quality_source,p_evaluation_version,p_idempotency_key,p_actor_id)
 returning id into v_id;
 perform write_financial_admin_audit(p_actor_id,'finance.model_performance.recorded',
  'ai_model_performance_event',v_id::text,'Recorded model latency and quality evidence',
  p_idempotency_key,jsonb_build_object('provider',lower(p_provider),'model',p_model,
   'operation',p_operation,'latencyMs',p_latency_ms,'qualityScore',p_quality_score,
   'qualitySource',p_quality_source,'evaluationVersion',p_evaluation_version));
 return jsonb_build_object('id',v_id,'idempotentReplay',false);
end $$;

create or replace function executive_visuals.recommend_ai_model_route_shadow(
 p_actor_id uuid,p_operation text,p_currency text,p_max_cost_minor bigint,
 p_max_latency_ms integer,p_min_quality_score numeric,p_idempotency_key text
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_existing ai_model_route_shadow_decisions%rowtype;v_id uuid;v_candidates jsonb;
 v_provider text;v_model text;v_status text;v_samples integer;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_operation not in('text','image','video','render','upscale','audio','embedding','other')
  or coalesce(p_currency,'') !~ '^[A-Z]{3}$' or p_max_cost_minor is null or p_max_cost_minor<1
  or p_max_latency_ms is null or p_max_latency_ms not between 1 and 86400000
  or p_min_quality_score is null or p_min_quality_score not between 0 and 1
  or coalesce(length(p_idempotency_key),0) not between 8 and 180 then
  raise exception 'Invalid shadow routing constraints' using errcode='22023';
 end if;
 select * into v_existing from ai_model_route_shadow_decisions where idempotency_key=p_idempotency_key;
 if found then
  if v_existing.operation<>p_operation or v_existing.currency<>p_currency
   or v_existing.max_cost_minor<>p_max_cost_minor or v_existing.max_latency_ms<>p_max_latency_ms
   or v_existing.min_quality_score<>p_min_quality_score then
   raise exception 'Shadow route idempotency key conflicts with existing constraints' using errcode='23505';
  end if;
  return jsonb_build_object('decisionId',v_existing.id,'decisionStatus',v_existing.decision_status,
   'recommendedProvider',v_existing.recommended_provider,'recommendedModel',v_existing.recommended_model,
   'candidates',v_existing.candidate_evidence,'decisionMode','shadow_only',
   'executionChanged',false,'idempotentReplay',true);
 end if;
 with samples as(
  select u.provider,u.requested_model model,count(*)::integer samples,
   avg(u.cost_minor)::numeric avg_cost_minor,
   percentile_cont(0.95) within group(order by p.latency_ms)::numeric p95_latency_ms,
   avg(p.quality_score)::numeric avg_quality_score
  from ai_model_performance_events p
  join ai_usage_cost_events u on u.id=p.usage_event_id
  where p.operation=p_operation and u.operation=p_operation and u.currency=p_currency
   and u.cost_basis='provider_reported' and u.cost_minor is not null and u.status='succeeded'
   and p.evaluated_at>=now()-interval '30 days'
  group by u.provider,u.requested_model
 ), scored as(
  select samples.*,
   (samples.samples>=20 and samples.avg_cost_minor<=p_max_cost_minor
    and samples.p95_latency_ms<=p_max_latency_ms and samples.avg_quality_score>=p_min_quality_score) eligible,
   case when samples.samples>=20 and samples.avg_cost_minor<=p_max_cost_minor
     and samples.p95_latency_ms<=p_max_latency_ms and samples.avg_quality_score>=p_min_quality_score
    then samples.avg_quality_score*0.60
      +(1-samples.avg_cost_minor/p_max_cost_minor)*0.25
      +(1-samples.p95_latency_ms/p_max_latency_ms)*0.15
    else null end score
  from samples
 ), chosen as(
  select * from scored where eligible
  order by score desc,avg_cost_minor asc,p95_latency_ms asc,provider,model limit 1
 )
 select
  coalesce((select jsonb_agg(jsonb_build_object('provider',provider,'model',model,'samples',samples,
   'avgCostMinor',round(avg_cost_minor,2),'p95LatencyMs',round(p95_latency_ms,2),
   'avgQualityScore',round(avg_quality_score,5),'eligible',eligible,'score',score)
   order by eligible desc,score desc nulls last,avg_cost_minor asc) from scored),'[]'::jsonb),
  (select provider from chosen),(select model from chosen),
  (select samples from chosen)
 into v_candidates,v_provider,v_model,v_samples;
 v_status:=case when v_provider is not null then 'recommended'
  when jsonb_array_length(v_candidates)=0 then 'insufficient_evidence'
  else 'no_candidate_meets_constraints' end;
 insert into ai_model_route_shadow_decisions(operation,currency,max_cost_minor,max_latency_ms,
  min_quality_score,recommended_provider,recommended_model,decision_status,candidate_evidence,
  idempotency_key,created_by)
 values(p_operation,p_currency,p_max_cost_minor,p_max_latency_ms,p_min_quality_score,
  v_provider,v_model,v_status,v_candidates,p_idempotency_key,p_actor_id)
 returning id into v_id;
 perform write_financial_admin_audit(p_actor_id,'finance.model_route.shadow_recommended',
  'ai_model_route_shadow_decision',v_id::text,'Recorded shadow-only model route recommendation',
  p_idempotency_key,jsonb_build_object('operation',p_operation,'currency',p_currency,
   'decisionStatus',v_status,'recommendedProvider',v_provider,'recommendedModel',v_model,
   'sampleCount',v_samples,'decisionMode','shadow_only','executionChanged',false));
 return jsonb_build_object('decisionId',v_id,'decisionStatus',v_status,
  'recommendedProvider',v_provider,'recommendedModel',v_model,'candidates',v_candidates,
  'decisionMode','shadow_only','executionChanged',false,'idempotentReplay',false);
end $$;

revoke all on function executive_visuals.add_ai_resource_rate_card(uuid,text,text,text,text,numeric,timestamptz,timestamptz,text,text) from public,anon,authenticated;
revoke all on function executive_visuals.record_ai_resource_usage_event(uuid,timestamptz,uuid,uuid,uuid,text,text,text,text,numeric,text,text,bigint,text,jsonb) from public,anon,authenticated;
revoke all on function executive_visuals.ai_resource_economics_overview(uuid,date) from public,anon,authenticated;
revoke all on function executive_visuals.record_ai_model_performance_event(uuid,uuid,text,text,text,integer,numeric,text,text,text) from public,anon,authenticated;
revoke all on function executive_visuals.recommend_ai_model_route_shadow(uuid,text,text,bigint,integer,numeric,text) from public,anon,authenticated;
grant execute on function executive_visuals.add_ai_resource_rate_card(uuid,text,text,text,text,numeric,timestamptz,timestamptz,text,text) to service_role;
grant execute on function executive_visuals.record_ai_resource_usage_event(uuid,timestamptz,uuid,uuid,uuid,text,text,text,text,numeric,text,text,bigint,text,jsonb) to service_role;
grant execute on function executive_visuals.ai_resource_economics_overview(uuid,date) to service_role;
grant execute on function executive_visuals.record_ai_model_performance_event(uuid,uuid,text,text,text,integer,numeric,text,text,text) to service_role;
grant execute on function executive_visuals.recommend_ai_model_route_shadow(uuid,text,text,bigint,integer,numeric,text) to service_role;
