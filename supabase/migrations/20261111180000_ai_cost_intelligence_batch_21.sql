-- Batch 21: AI usage metering, model rate cards and invoice reconciliation foundation.
create table if not exists executive_visuals.ai_model_price_catalog(
 id uuid primary key default gen_random_uuid(), provider text not null, model text not null,
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 input_per_million_minor numeric(24,8), output_per_million_minor numeric(24,8),
 image_unit_minor numeric(24,8), video_second_minor numeric(24,8), render_second_minor numeric(24,8),
 effective_from timestamptz not null, effective_to timestamptz,
 source_type text not null check(source_type in('provider_pricing','provider_contract','admin_verified')),
 source_reference text not null default '', recorded_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 check(effective_to is null or effective_to>effective_from),
 check(num_nonnulls(input_per_million_minor,output_per_million_minor,image_unit_minor,video_second_minor,render_second_minor)>0)
);
create index if not exists ai_model_price_lookup_idx on executive_visuals.ai_model_price_catalog(provider,model,currency,effective_from desc);
create table if not exists executive_visuals.ai_usage_cost_events(
 id uuid primary key default gen_random_uuid(), occurred_at timestamptz not null,
 period_month date not null check(period_month=date_trunc('month',period_month)::date),
 owner_id uuid references auth.users(id), project_id uuid, job_id uuid,
 operation_id text not null, provider text not null, requested_model text not null, response_model text,
 operation text not null check(operation in('text','image','video','render','upscale','audio','embedding','other')),
 status text not null check(status in('succeeded','failed','cancelled','unknown')),
 input_tokens bigint not null default 0 check(input_tokens>=0), output_tokens bigint not null default 0 check(output_tokens>=0),
 image_count numeric(20,6) not null default 0 check(image_count>=0),
 video_seconds numeric(20,6) not null default 0 check(video_seconds>=0),
 render_seconds numeric(20,6) not null default 0 check(render_seconds>=0),
 currency text, cost_minor bigint, cost_basis text not null check(cost_basis in('provider_reported','catalog_estimate','unpriced')),
 price_catalog_id uuid references executive_visuals.ai_model_price_catalog(id),
 invoice_line_reference text not null default '', trace_id text not null default '',
 idempotency_key text not null unique, recorded_at timestamptz not null default now(),
 check((cost_basis='unpriced' and cost_minor is null and currency is null)
  or (cost_basis<>'unpriced' and cost_minor is not null and cost_minor>=0 and currency ~ '^[A-Z]{3}$'))
);
create index if not exists ai_usage_period_idx on executive_visuals.ai_usage_cost_events(period_month,currency,provider,requested_model);
create index if not exists ai_usage_customer_idx on executive_visuals.ai_usage_cost_events(owner_id,period_month) where owner_id is not null;
create index if not exists ai_usage_job_idx on executive_visuals.ai_usage_cost_events(job_id) where job_id is not null;
create table if not exists executive_visuals.ai_provider_invoice_imports(
 id uuid primary key default gen_random_uuid(), provider text not null, invoice_reference text not null,
 currency text not null check(currency ~ '^[A-Z]{3}$'), period_start date not null, period_end date not null check(period_end>=period_start),
 total_minor bigint not null check(total_minor>=0), imported_line_count integer not null default 0,
 matched_line_count integer not null default 0 check(matched_line_count between 0 and imported_line_count),
 reconciliation_status text not null default 'pending' check(reconciliation_status in('pending','matched','variance','review_required')),
 source_fingerprint text not null, imported_by uuid not null references auth.users(id), imported_at timestamptz not null default now(),
 unique(provider,invoice_reference,currency,source_fingerprint)
);
create table if not exists executive_visuals.ai_provider_invoice_lines(
 id uuid primary key default gen_random_uuid(), import_id uuid not null references executive_visuals.ai_provider_invoice_imports(id),
 provider_line_reference text not null, usage_period date, owner_id uuid references auth.users(id),
 project_id uuid, job_id uuid, provider text not null, model text not null default '', operation text not null default '',
 currency text not null check(currency ~ '^[A-Z]{3}$'), amount_minor bigint not null,
 usage_quantity numeric(24,8), usage_unit text not null default '',
 matched_usage_event_id uuid references executive_visuals.ai_usage_cost_events(id),
 match_status text not null default 'unmatched' check(match_status in('matched','unmatched','ambiguous','variance')),
 created_at timestamptz not null default now(), unique(import_id,provider_line_reference)
);
create index if not exists ai_invoice_lines_match_idx on executive_visuals.ai_provider_invoice_lines(provider,model,usage_period,match_status);
alter table executive_visuals.ai_model_price_catalog enable row level security;
alter table executive_visuals.ai_usage_cost_events enable row level security;
alter table executive_visuals.ai_provider_invoice_imports enable row level security;
alter table executive_visuals.ai_provider_invoice_lines enable row level security;
revoke all on executive_visuals.ai_model_price_catalog,executive_visuals.ai_usage_cost_events,executive_visuals.ai_provider_invoice_imports,executive_visuals.ai_provider_invoice_lines from public,anon,authenticated;
grant select,insert on executive_visuals.ai_model_price_catalog,executive_visuals.ai_usage_cost_events,executive_visuals.ai_provider_invoice_imports,executive_visuals.ai_provider_invoice_lines to service_role;
create trigger ai_model_price_catalog_immutable before update or delete on executive_visuals.ai_model_price_catalog for each row execute function executive_visuals.reject_revenue_intelligence_mutation();
create trigger ai_usage_cost_events_immutable before update or delete on executive_visuals.ai_usage_cost_events for each row execute function executive_visuals.reject_revenue_intelligence_mutation();
create trigger ai_provider_invoice_imports_immutable before update or delete on executive_visuals.ai_provider_invoice_imports for each row execute function executive_visuals.reject_revenue_intelligence_mutation();
create trigger ai_provider_invoice_lines_immutable before update or delete on executive_visuals.ai_provider_invoice_lines for each row execute function executive_visuals.reject_revenue_intelligence_mutation();

create or replace function executive_visuals.record_ai_usage_cost_event(
 p_actor_id uuid,p_occurred_at timestamptz,p_owner_id uuid,p_project_id uuid,p_job_id uuid,
 p_operation_id text,p_provider text,p_requested_model text,p_response_model text,p_operation text,
 p_status text,p_input_tokens bigint,p_output_tokens bigint,p_image_count numeric,p_video_seconds numeric,
 p_render_seconds numeric,p_currency text,p_provider_cost_minor bigint,p_invoice_line_reference text,
 p_trace_id text,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_existing ai_usage_cost_events%rowtype; v_price ai_model_price_catalog%rowtype;
 v_cost numeric; v_basis text:='unpriced'; v_currency text; v_catalog_id uuid; v_id uuid; v_month date;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_occurred_at is null or coalesce(length(p_operation_id),0) not between 1 and 180
  or coalesce(length(p_provider),0) not between 2 and 80 or coalesce(length(btrim(p_requested_model)),0) not between 1 and 160
  or p_operation not in('text','image','video','render','upscale','audio','embedding','other')
  or p_status not in('succeeded','failed','cancelled','unknown')
  or coalesce(p_input_tokens,0)<0 or coalesce(p_output_tokens,0)<0 or coalesce(p_image_count,0)<0
  or coalesce(p_video_seconds,0)<0 or coalesce(p_render_seconds,0)<0
  or (p_provider_cost_minor is not null and p_provider_cost_minor<0)
  or (p_currency is not null and p_currency !~ '^[A-Z]{3}$')
  or coalesce(length(p_idempotency_key),0) not between 8 and 180 then
  raise exception 'Invalid AI usage event' using errcode='22023';
 end if;
 v_month:=date_trunc('month',p_occurred_at)::date;
 select * into v_existing from ai_usage_cost_events where idempotency_key=p_idempotency_key;
 if found then
  if v_existing.operation_id<>p_operation_id or v_existing.provider<>p_provider or v_existing.requested_model<>p_requested_model or v_existing.occurred_at<>p_occurred_at then
   raise exception 'AI usage idempotency key conflicts with existing event' using errcode='23505';
  end if;
  return jsonb_build_object('id',v_existing.id,'costBasis',v_existing.cost_basis,'costMinor',v_existing.cost_minor,'currency',v_existing.currency,'idempotentReplay',true);
 end if;
 if p_provider_cost_minor is not null then
  if p_currency is null then raise exception 'Provider-reported cost requires a currency' using errcode='22023'; end if;
  v_cost:=p_provider_cost_minor; v_currency:=p_currency; v_basis:='provider_reported';
 else
  select * into v_price from ai_model_price_catalog where provider=p_provider and model=p_requested_model
   and effective_from<=p_occurred_at and (effective_to is null or effective_to>p_occurred_at)
   and currency=p_currency order by effective_from desc,created_at desc limit 1;
  if found then
   v_cost:=coalesce(p_input_tokens,0)*coalesce(v_price.input_per_million_minor,0)/1000000
    +coalesce(p_output_tokens,0)*coalesce(v_price.output_per_million_minor,0)/1000000
    +coalesce(p_image_count,0)*coalesce(v_price.image_unit_minor,0)
    +coalesce(p_video_seconds,0)*coalesce(v_price.video_second_minor,0)
    +coalesce(p_render_seconds,0)*coalesce(v_price.render_second_minor,0);
   v_currency:=v_price.currency; v_catalog_id:=v_price.id; v_basis:='catalog_estimate';
  end if;
 end if;
 insert into ai_usage_cost_events(occurred_at,period_month,owner_id,project_id,job_id,operation_id,provider,requested_model,response_model,operation,status,input_tokens,output_tokens,image_count,video_seconds,render_seconds,currency,cost_minor,cost_basis,price_catalog_id,invoice_line_reference,trace_id,idempotency_key)
 values(p_occurred_at,v_month,p_owner_id,p_project_id,p_job_id,p_operation_id,p_provider,p_requested_model,nullif(p_response_model,''),p_operation,p_status,coalesce(p_input_tokens,0),coalesce(p_output_tokens,0),coalesce(p_image_count,0),coalesce(p_video_seconds,0),coalesce(p_render_seconds,0),v_currency,case when v_basis='unpriced' then null else round(v_cost)::bigint end,v_basis,v_catalog_id,coalesce(p_invoice_line_reference,''),coalesce(p_trace_id,''),p_idempotency_key)
 returning id into v_id;
 perform write_financial_admin_audit(p_actor_id,'finance.ai_usage.recorded','ai_usage_cost_event',v_id::text,'Recorded AI provider usage and cost evidence',p_idempotency_key,jsonb_build_object('provider',p_provider,'model',p_requested_model,'operation',p_operation,'costBasis',v_basis,'currency',v_currency,'costMinor',case when v_basis='unpriced' then null else round(v_cost)::bigint end));
 return jsonb_build_object('id',v_id,'periodMonth',v_month,'costBasis',v_basis,'costMinor',case when v_basis='unpriced' then null else round(v_cost)::bigint end,'currency',v_currency,'priceCatalogId',v_catalog_id,'idempotentReplay',false);
end $$;

create or replace function executive_visuals.ai_cost_intelligence_overview(p_actor_id uuid,p_period_month date default date_trunc('month',now())::date)
returns jsonb language plpgsql security definer set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_result jsonb;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then raise exception 'Financial administrator access required' using errcode='42501'; end if;
 if p_period_month is null or p_period_month<>date_trunc('month',p_period_month)::date then raise exception 'Invalid reporting month' using errcode='22023'; end if;
 with usage as(
  select provider,requested_model,operation,currency,cost_basis,count(*)::integer events,
   count(*) filter(where status='failed')::integer failed_events,sum(input_tokens)::bigint input_tokens,
   sum(output_tokens)::bigint output_tokens,sum(image_count)::numeric image_count,
   sum(video_seconds)::numeric video_seconds,sum(render_seconds)::numeric render_seconds,
   sum(cost_minor) filter(where cost_minor is not null)::bigint known_cost_minor,
   count(*) filter(where cost_basis='unpriced')::integer unpriced_events
  from ai_usage_cost_events where period_month=p_period_month group by provider,requested_model,operation,currency,cost_basis
 ), customer as(
  select owner_id,currency,sum(cost_minor)::bigint cost_minor,count(*)::integer events
  from ai_usage_cost_events where period_month=p_period_month and owner_id is not null and cost_minor is not null group by owner_id,currency
 )
 select jsonb_build_object('periodMonth',p_period_month,'generatedAt',now(),
  'byProviderModel',coalesce((select jsonb_agg(to_jsonb(usage) order by provider,requested_model,operation,cost_basis) from usage),'[]'::jsonb),
  'byCustomer',coalesce((select jsonb_agg(to_jsonb(customer) order by currency,owner_id) from customer),'[]'::jsonb),
  'unpricedEvents',(select count(*) from ai_usage_cost_events where period_month=p_period_month and cost_basis='unpriced'),
  'limitations',jsonb_build_array('Provider-reported amounts are actual usage costs; catalog-derived amounts are estimates.','Invoice imports must be reconciled before estimates are treated as invoice-confirmed.','Shared infrastructure costs are not allocated without a measured driver.')
 ) into v_result;
 return v_result;
end $$;
revoke all on function executive_visuals.record_ai_usage_cost_event(uuid,timestamptz,uuid,uuid,uuid,text,text,text,text,text,text,bigint,bigint,numeric,numeric,numeric,text,bigint,text,text,text) from public,anon,authenticated;
revoke all on function executive_visuals.ai_cost_intelligence_overview(uuid,date) from public,anon,authenticated;
grant execute on function executive_visuals.record_ai_usage_cost_event(uuid,timestamptz,uuid,uuid,uuid,text,text,text,text,text,text,bigint,bigint,numeric,numeric,numeric,text,bigint,text,text,text) to service_role;
grant execute on function executive_visuals.ai_cost_intelligence_overview(uuid,date) to service_role;
