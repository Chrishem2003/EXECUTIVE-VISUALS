-- Batch 26: measured, immutable allocation of shared service costs.
-- This is a management-accounting layer; it never mutates the source cost ledger.

create table if not exists executive_visuals.financial_shared_cost_allocation_policies(
 id uuid primary key default gen_random_uuid(),
 cost_category text not null check(cost_category in(
  'ai_inference','image_generation','video_generation','render_compute','storage','egress'
 )),
 driver_type text not null check(driver_type in(
  'inference_tokens','image_count','video_seconds','ffmpeg_seconds',
  'gpu_seconds','cpu_seconds','storage_gb_days','egress_gb'
 )),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 effective_from date not null check(effective_from=date_trunc('month',effective_from)::date),
 effective_to date,
 minimum_recipients integer not null default 2 check(minimum_recipients between 2 and 100000),
 idempotency_key text not null unique check(length(idempotency_key) between 8 and 160),
 created_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 check(effective_to is null or (effective_to=date_trunc('month',effective_to)::date and effective_to>effective_from)),
 check(
  (cost_category='ai_inference' and driver_type='inference_tokens') or
  (cost_category='image_generation' and driver_type='image_count') or
  (cost_category='video_generation' and driver_type='video_seconds') or
  (cost_category='render_compute' and driver_type in('ffmpeg_seconds','gpu_seconds','cpu_seconds')) or
  (cost_category='storage' and driver_type='storage_gb_days') or
  (cost_category='egress' and driver_type='egress_gb')
 )
);
create unique index if not exists financial_shared_cost_policy_effective_idx
 on executive_visuals.financial_shared_cost_allocation_policies(cost_category,currency,effective_from);
create index if not exists financial_shared_cost_policy_lookup_idx
 on executive_visuals.financial_shared_cost_allocation_policies(currency,cost_category,effective_from desc);
alter table executive_visuals.financial_shared_cost_allocation_policies enable row level security;
revoke all on executive_visuals.financial_shared_cost_allocation_policies from public,anon,authenticated;
grant select,insert on executive_visuals.financial_shared_cost_allocation_policies to service_role;
create trigger financial_shared_cost_allocation_policies_immutable before update or delete
 on executive_visuals.financial_shared_cost_allocation_policies for each row
 execute function executive_visuals.reject_revenue_intelligence_mutation();

create table if not exists executive_visuals.financial_shared_cost_allocation_batches(
 id uuid primary key default gen_random_uuid(),
 period_month date not null check(period_month=date_trunc('month',period_month)::date),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 cost_category text not null check(cost_category in(
  'ai_inference','image_generation','video_generation','render_compute','storage','egress'
 )),
 policy_id uuid not null references executive_visuals.financial_shared_cost_allocation_policies(id) on delete restrict,
 driver_type text not null,
 source_pool_minor bigint not null check(source_pool_minor>0),
 source_cost_event_count integer not null check(source_cost_event_count>0),
 source_fingerprint text not null check(length(source_fingerprint)=32),
 driver_event_count bigint not null check(driver_event_count>0),
 recipient_count integer not null check(recipient_count>=2),
 driver_units_total numeric(30,8) not null check(driver_units_total>0),
 allocated_minor bigint not null check(allocated_minor>=0),
 unallocated_minor bigint not null check(unallocated_minor>=0),
 allocation_method text not null default 'largest_remainder' check(allocation_method='largest_remainder'),
 created_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 unique(period_month,currency,cost_category),
 check(allocated_minor+unallocated_minor=source_pool_minor)
);
create index if not exists financial_shared_cost_allocation_batch_period_idx
 on executive_visuals.financial_shared_cost_allocation_batches(period_month,currency,cost_category);
alter table executive_visuals.financial_shared_cost_allocation_batches enable row level security;
revoke all on executive_visuals.financial_shared_cost_allocation_batches from public,anon,authenticated;
grant select,insert on executive_visuals.financial_shared_cost_allocation_batches to service_role;
create trigger financial_shared_cost_allocation_batches_immutable before update or delete
 on executive_visuals.financial_shared_cost_allocation_batches for each row
 execute function executive_visuals.reject_revenue_intelligence_mutation();

create table if not exists executive_visuals.financial_shared_cost_allocation_lines(
 id uuid primary key default gen_random_uuid(),
 batch_id uuid not null references executive_visuals.financial_shared_cost_allocation_batches(id) on delete restrict,
 owner_id uuid not null references auth.users(id) on delete restrict,
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 driver_units numeric(30,8) not null check(driver_units>0),
 driver_event_count bigint not null check(driver_event_count>0),
 share_pct numeric(30,16) not null check(share_pct>=0 and share_pct<=100),
 amount_minor bigint not null check(amount_minor>0),
 created_at timestamptz not null default now(),
 unique(batch_id,owner_id)
);
create index if not exists financial_shared_cost_allocation_customer_idx
 on executive_visuals.financial_shared_cost_allocation_lines(owner_id,batch_id);
alter table executive_visuals.financial_shared_cost_allocation_lines enable row level security;
revoke all on executive_visuals.financial_shared_cost_allocation_lines from public,anon,authenticated;
grant select,insert on executive_visuals.financial_shared_cost_allocation_lines to service_role;
create trigger financial_shared_cost_allocation_lines_immutable before update or delete
 on executive_visuals.financial_shared_cost_allocation_lines for each row
 execute function executive_visuals.reject_revenue_intelligence_mutation();

create or replace function executive_visuals.add_financial_shared_cost_allocation_policy(
 p_actor_id uuid,p_cost_category text,p_driver_type text,p_currency text,
 p_effective_from date,p_effective_to date,p_minimum_recipients integer,p_idempotency_key text
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_id uuid;v_existing financial_shared_cost_allocation_policies%rowtype;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins
  where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_cost_category not in('ai_inference','image_generation','video_generation','render_compute','storage','egress')
  or p_driver_type not in('inference_tokens','image_count','video_seconds','ffmpeg_seconds','gpu_seconds','cpu_seconds','storage_gb_days','egress_gb')
  or not(
   (p_cost_category='ai_inference' and p_driver_type='inference_tokens') or
   (p_cost_category='image_generation' and p_driver_type='image_count') or
   (p_cost_category='video_generation' and p_driver_type='video_seconds') or
   (p_cost_category='render_compute' and p_driver_type in('ffmpeg_seconds','gpu_seconds','cpu_seconds')) or
   (p_cost_category='storage' and p_driver_type='storage_gb_days') or
   (p_cost_category='egress' and p_driver_type='egress_gb')
  )
  or coalesce(p_currency,'') !~ '^[A-Z]{3}$'
  or p_effective_from is null or p_effective_from<>date_trunc('month',p_effective_from)::date
  or p_effective_from>date_trunc('month',now())::date
  or (p_effective_to is not null and (p_effective_to<>date_trunc('month',p_effective_to)::date or p_effective_to<=p_effective_from))
  or p_minimum_recipients is null or p_minimum_recipients<2 or p_minimum_recipients>100000
  or length(coalesce(p_idempotency_key,'')) not between 8 and 160 then
  raise exception 'Invalid shared-cost allocation policy or unsupported measured driver' using errcode='22023';
 end if;
 select * into v_existing from financial_shared_cost_allocation_policies where idempotency_key=p_idempotency_key;
 if found then
  if v_existing.created_by<>p_actor_id or v_existing.cost_category<>p_cost_category
   or v_existing.driver_type<>p_driver_type or v_existing.currency<>p_currency
   or v_existing.effective_from<>p_effective_from or v_existing.effective_to is distinct from p_effective_to
   or v_existing.minimum_recipients<>p_minimum_recipients then
   raise exception 'Idempotency key was already used with different allocation policy details' using errcode='23505';
  end if;
  return jsonb_build_object('policyId',v_existing.id,'duplicate',true,'costCategory',v_existing.cost_category,
   'driverType',v_existing.driver_type,'currency',v_existing.currency,'effectiveFrom',v_existing.effective_from);
 end if;
 insert into financial_shared_cost_allocation_policies(
  cost_category,driver_type,currency,effective_from,effective_to,minimum_recipients,idempotency_key,created_by
 ) values(
  p_cost_category,p_driver_type,p_currency,p_effective_from,p_effective_to,p_minimum_recipients,p_idempotency_key,p_actor_id
 ) returning id into v_id;
 perform write_financial_admin_audit(p_actor_id,'finance.shared_cost_allocation.policy_created',
  'financial_shared_cost_allocation_policy',v_id::text,'Created a measured shared-cost allocation policy',
  p_idempotency_key,jsonb_build_object('costCategory',p_cost_category,'driverType',p_driver_type,
   'currency',p_currency,'effectiveFrom',p_effective_from,'effectiveTo',p_effective_to,
   'minimumRecipients',p_minimum_recipients));
 return jsonb_build_object('policyId',v_id,'duplicate',false,'costCategory',p_cost_category,
  'driverType',p_driver_type,'currency',p_currency,'effectiveFrom',p_effective_from);
end $$;

create or replace function executive_visuals.run_financial_shared_cost_allocation(
 p_actor_id uuid,p_period_month date,p_currency text,p_cost_category text
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare
 v_policy financial_shared_cost_allocation_policies%rowtype;
 v_existing financial_shared_cost_allocation_batches%rowtype;
 v_batch_id uuid;
 v_pool bigint;
 v_source_count integer;
 v_fingerprint text;
 v_driver_total numeric(30,8);
 v_driver_events bigint;
 v_recipients integer;
 v_allocated bigint;
 v_unallocated bigint;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins
  where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_period_month is null or p_period_month<>date_trunc('month',p_period_month)::date
  or p_period_month>date_trunc('month',now())::date
  or coalesce(p_currency,'') !~ '^[A-Z]{3}$'
  or p_cost_category not in('ai_inference','image_generation','video_generation','render_compute','storage','egress') then
  raise exception 'Invalid allocation month, currency or cost category' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtext('shared-cost-allocation:'||p_period_month::text||':'||p_currency||':'||p_cost_category));
 select * into v_existing from financial_shared_cost_allocation_batches
 where period_month=p_period_month and currency=p_currency and cost_category=p_cost_category;
 if found then
  return jsonb_build_object('batchId',v_existing.id,'status','already_allocated',
   'sourcePoolMinor',v_existing.source_pool_minor,'allocatedMinor',v_existing.allocated_minor,
   'unallocatedMinor',v_existing.unallocated_minor,'recipientCount',v_existing.recipient_count,
   'driverType',v_existing.driver_type,'duplicate',true);
 end if;
 select * into v_policy from financial_shared_cost_allocation_policies p
 where p.cost_category=p_cost_category and p.currency=p_currency
  and p.effective_from<=p_period_month and (p.effective_to is null or p.effective_to>p_period_month)
 order by p.effective_from desc,p.created_at desc limit 1;
 if not found then
  return jsonb_build_object('status','no_active_policy','periodMonth',p_period_month,
   'currency',p_currency,'costCategory',p_cost_category);
 end if;
 select coalesce(sum(c.amount_minor),0)::bigint,count(*)::integer,
  md5(coalesce(string_agg(c.id::text,',' order by c.id),'')) 
 into v_pool,v_source_count,v_fingerprint
 from financial_service_cost_events c
 where c.period_month=p_period_month and c.currency=p_currency
  and c.cost_category=p_cost_category and c.owner_id is null;
 if v_source_count=0 or v_pool<=0 then
  return jsonb_build_object('status','no_positive_shared_cost_pool','periodMonth',p_period_month,
   'currency',p_currency,'costCategory',p_cost_category,'sourcePoolMinor',v_pool);
 end if;
 with driver_rows as(
  select u.owner_id,
   case v_policy.driver_type
    when 'inference_tokens' then (u.input_tokens+u.output_tokens)::numeric
    when 'image_count' then u.image_count
    when 'video_seconds' then u.video_seconds
    else 0::numeric end units
  from ai_usage_cost_events u
  where u.period_month=p_period_month and u.status='succeeded' and u.owner_id is not null
   and ((v_policy.driver_type='inference_tokens' and u.operation in('text','embedding','audio'))
    or (v_policy.driver_type='image_count' and u.operation='image')
    or (v_policy.driver_type='video_seconds' and u.operation='video'))
  union all
  select r.owner_id,r.quantity
  from ai_resource_cost_events r
  where r.period_month=p_period_month and r.owner_id is not null
   and ((v_policy.driver_type='ffmpeg_seconds' and r.resource_type='ffmpeg_second')
    or (v_policy.driver_type='gpu_seconds' and r.resource_type='gpu_second')
    or (v_policy.driver_type='cpu_seconds' and r.resource_type='cpu_second')
    or (v_policy.driver_type='storage_gb_days' and r.resource_type='storage_gb_day')
    or (v_policy.driver_type='egress_gb' and r.resource_type='egress_gb'))
 ), drivers as(
  select owner_id,sum(units)::numeric(30,8) units,count(*)::bigint event_count
  from driver_rows where units>0 group by owner_id
 )
 select coalesce(sum(units),0),coalesce(sum(event_count),0),count(*)::integer
 into v_driver_total,v_driver_events,v_recipients from drivers;
 if v_recipients<v_policy.minimum_recipients or v_driver_total<=0 then
  return jsonb_build_object('status','insufficient_measured_coverage','periodMonth',p_period_month,
   'currency',p_currency,'costCategory',p_cost_category,'driverType',v_policy.driver_type,
   'recipientCount',v_recipients,'minimumRecipients',v_policy.minimum_recipients,
   'driverEventCount',v_driver_events,'sourcePoolMinor',v_pool);
 end if;
 insert into financial_shared_cost_allocation_batches(
  period_month,currency,cost_category,policy_id,driver_type,source_pool_minor,
  source_cost_event_count,source_fingerprint,driver_event_count,recipient_count,
  driver_units_total,allocated_minor,unallocated_minor,created_by
 ) values(
  p_period_month,p_currency,p_cost_category,v_policy.id,v_policy.driver_type,v_pool,
  v_source_count,v_fingerprint,v_driver_events,v_recipients,v_driver_total,v_pool,0,p_actor_id
 ) on conflict(period_month,currency,cost_category) do nothing returning id into v_batch_id;
 if v_batch_id is null then
  select * into v_existing from financial_shared_cost_allocation_batches
  where period_month=p_period_month and currency=p_currency and cost_category=p_cost_category;
  return jsonb_build_object('batchId',v_existing.id,'status','already_allocated',
   'sourcePoolMinor',v_existing.source_pool_minor,'allocatedMinor',v_existing.allocated_minor,
   'unallocatedMinor',v_existing.unallocated_minor,'recipientCount',v_existing.recipient_count,
   'driverType',v_existing.driver_type,'duplicate',true);
 end if;
 with driver_rows as(
  select u.owner_id,
   case v_policy.driver_type
    when 'inference_tokens' then (u.input_tokens+u.output_tokens)::numeric
    when 'image_count' then u.image_count
    when 'video_seconds' then u.video_seconds
    else 0::numeric end units
  from ai_usage_cost_events u
  where u.period_month=p_period_month and u.status='succeeded' and u.owner_id is not null
   and ((v_policy.driver_type='inference_tokens' and u.operation in('text','embedding','audio'))
    or (v_policy.driver_type='image_count' and u.operation='image')
    or (v_policy.driver_type='video_seconds' and u.operation='video'))
  union all
  select r.owner_id,r.quantity
  from ai_resource_cost_events r
  where r.period_month=p_period_month and r.owner_id is not null
   and ((v_policy.driver_type='ffmpeg_seconds' and r.resource_type='ffmpeg_second')
    or (v_policy.driver_type='gpu_seconds' and r.resource_type='gpu_second')
    or (v_policy.driver_type='cpu_seconds' and r.resource_type='cpu_second')
    or (v_policy.driver_type='storage_gb_days' and r.resource_type='storage_gb_day')
    or (v_policy.driver_type='egress_gb' and r.resource_type='egress_gb'))
 ), drivers as(
  select owner_id,sum(units)::numeric(30,8) units,count(*)::bigint event_count
  from driver_rows where units>0 group by owner_id
 ), raw_shares as(
  select d.owner_id,d.units,d.event_count,
   floor(v_pool::numeric*d.units/v_driver_total)::bigint base_minor,
   (v_pool::numeric*d.units/v_driver_total)-floor(v_pool::numeric*d.units/v_driver_total) fractional_remainder,
   (v_pool::numeric*d.units/v_driver_total*100) / v_pool share_pct
  from drivers d
 ), ranked as(
  select r.*,row_number() over(order by fractional_remainder desc,owner_id) remainder_rank,
   (v_pool-(select coalesce(sum(base_minor),0) from raw_shares)) remainder_units
  from raw_shares r
 )
 insert into financial_shared_cost_allocation_lines(
  batch_id,owner_id,currency,driver_units,driver_event_count,share_pct,amount_minor
 )
 select v_batch_id,owner_id,p_currency,units,event_count,share_pct,
  base_minor+case when remainder_rank<=remainder_units then 1 else 0 end
 from ranked
 where base_minor+case when remainder_rank<=remainder_units then 1 else 0 end>0;
 select coalesce(sum(l.amount_minor),0)::bigint into v_allocated
 from financial_shared_cost_allocation_lines l where l.batch_id=v_batch_id;
 v_unallocated:=v_pool-v_allocated;
 if v_allocated<>v_pool then
  raise exception 'Shared-cost allocation did not reconcile exactly to its source pool' using errcode='23514';
 end if;
 perform write_financial_admin_audit(p_actor_id,'finance.shared_cost_allocation.completed',
  'financial_shared_cost_allocation_batch',v_batch_id::text,
  'Allocated shared service costs using measured workload consumption',
  'shared-cost-allocation:'||p_period_month::text||':'||p_currency||':'||p_cost_category,
  jsonb_build_object('periodMonth',p_period_month,'currency',p_currency,'costCategory',p_cost_category,
   'driverType',v_policy.driver_type,'sourcePoolMinor',v_pool,'allocatedMinor',v_allocated,
   'unallocatedMinor',v_unallocated,'recipientCount',v_recipients,'driverEventCount',v_driver_events,
   'sourceCostEventCount',v_source_count,'sourceFingerprint',v_fingerprint,'allocationMethod','largest_remainder'));
 return jsonb_build_object('batchId',v_batch_id,'status','allocated','periodMonth',p_period_month,
  'currency',p_currency,'costCategory',p_cost_category,'driverType',v_policy.driver_type,
  'sourcePoolMinor',v_pool,'allocatedMinor',v_allocated,'unallocatedMinor',v_unallocated,
  'recipientCount',v_recipients,'driverEventCount',v_driver_events,'duplicate',false);
end $$;

create or replace function executive_visuals.financial_shared_cost_allocation_overview(
 p_actor_id uuid,p_months integer default 12
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_result jsonb;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins
  where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_months is null or p_months<1 or p_months>36 then
  raise exception 'Allocation report period must be between 1 and 36 months' using errcode='22023';
 end if;
 with batches as(
  select b.* from financial_shared_cost_allocation_batches b
  where b.period_month>=date_trunc('month',now())::date-(p_months-1)*interval '1 month'
 ), allocations as(
  select b.period_month,b.currency,b.cost_category,l.owner_id,
   sum(l.amount_minor)::bigint allocated_minor,sum(l.driver_units)::numeric(30,8) driver_units,
   sum(l.driver_event_count)::bigint driver_event_count
  from batches b join financial_shared_cost_allocation_lines l on l.batch_id=b.id
  group by b.period_month,b.currency,b.cost_category,l.owner_id
 )
 select jsonb_build_object('generatedAt',now(),'months',p_months,
  'policies',coalesce((select jsonb_agg(jsonb_build_object(
   'policyId',p.id,'costCategory',p.cost_category,'driverType',p.driver_type,
   'currency',p.currency,'effectiveFrom',p.effective_from,'effectiveTo',p.effective_to,
   'minimumRecipients',p.minimum_recipients,'createdAt',p.created_at
  ) order by p.currency,p.cost_category,p.effective_from desc)
  from financial_shared_cost_allocation_policies p),'[]'::jsonb),
  'batches',coalesce((select jsonb_agg(jsonb_build_object(
   'batchId',b.id,'periodMonth',b.period_month,'currency',b.currency,'costCategory',b.cost_category,
   'driverType',b.driver_type,'sourcePoolMinor',b.source_pool_minor,
   'allocatedMinor',b.allocated_minor,'unallocatedMinor',b.unallocated_minor,
   'sourceCostEventCount',b.source_cost_event_count,'driverEventCount',b.driver_event_count,
   'recipientCount',b.recipient_count,'driverUnitsTotal',b.driver_units_total,
   'allocationMethod',b.allocation_method,'createdAt',b.created_at
  ) order by b.period_month desc,b.currency,b.cost_category)
  from batches b),'[]'::jsonb),
  'customers',coalesce((select jsonb_agg(jsonb_build_object(
   'periodMonth',a.period_month,'ownerId',a.owner_id,'currency',a.currency,
   'costCategory',a.cost_category,'allocatedMinor',a.allocated_minor,
   'driverUnits',a.driver_units,'driverEventCount',a.driver_event_count
  ) order by a.period_month desc,a.currency,a.owner_id,a.cost_category)
  from allocations a),'[]'::jsonb),
  'limitations',jsonb_build_array(
   'Only shared service-cost ledger pools with an active approved policy and measured workload drivers are allocated.',
   'Allocation uses successful, customer-attributed AI usage or recorded resource telemetry for the same month.',
   'Payment processing, support and other costs remain unallocated until suitable causal telemetry is instrumented.',
   'Direct customer costs are never redistributed. Original immutable service-cost events are never modified.',
   'Integer minor-unit remainders use a deterministic largest-remainder method; allocated totals reconcile exactly to each source pool.',
   'Allocations are management-accounting showback and do not change customer invoices, provider routing or statutory accounts.'
  )
 ) into v_result;
 return v_result;
end $$;

create or replace function executive_visuals.financial_profitability_trend_report(
 p_actor_id uuid,p_months integer default 12
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_result jsonb;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins
  where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_months is null or p_months<3 or p_months>36 then
  raise exception 'Trend period must be between 3 and 36 months' using errcode='22023';
 end if;
 with revenue as(
  select s.snapshot_month,s.currency,s.owner_id,sum(s.mrr_minor)::bigint mrr_minor
  from subscription_revenue_snapshots s
  where s.snapshot_month>=(
   select coalesce(max(snapshot_month),date_trunc('month',now())::date)
   from subscription_revenue_snapshots
  )-(p_months-1)*interval '1 month'
  group by s.snapshot_month,s.currency,s.owner_id
 ), direct_costs as(
  select c.period_month,c.currency,c.owner_id,sum(c.amount_minor)::bigint direct_cost_minor
  from financial_service_cost_events c
  where c.owner_id is not null
  group by c.period_month,c.currency,c.owner_id
 ), shared_costs as(
  select c.period_month,c.currency,sum(c.amount_minor)::bigint shared_cost_minor
  from financial_service_cost_events c
  where c.owner_id is null
  group by c.period_month,c.currency
 ), allocated_costs as(
  select b.period_month,b.currency,l.owner_id,sum(l.amount_minor)::bigint allocated_shared_cost_minor
  from financial_shared_cost_allocation_batches b
  join financial_shared_cost_allocation_lines l on l.batch_id=b.id
  group by b.period_month,b.currency,l.owner_id
 ), customer_rows as(
  select r.snapshot_month,r.currency,r.owner_id,r.mrr_minor,
   coalesce(d.direct_cost_minor,0)::bigint direct_cost_minor,
   coalesce(a.allocated_shared_cost_minor,0)::bigint allocated_shared_cost_minor,
   (r.mrr_minor-coalesce(d.direct_cost_minor,0))::bigint contribution_minor,
   (r.mrr_minor-coalesce(d.direct_cost_minor,0)-coalesce(a.allocated_shared_cost_minor,0))::bigint fully_loaded_contribution_minor
  from revenue r
  left join direct_costs d on d.period_month=r.snapshot_month and d.currency=r.currency and d.owner_id=r.owner_id
  left join allocated_costs a on a.period_month=r.snapshot_month and a.currency=r.currency and a.owner_id=r.owner_id
 ), periods as(
  select c.snapshot_month,c.currency,count(*) filter(where c.mrr_minor>0)::integer paid_customers,
   sum(c.mrr_minor)::bigint mrr_minor,sum(c.direct_cost_minor)::bigint direct_cost_minor,
   sum(c.allocated_shared_cost_minor)::bigint allocated_shared_cost_minor,
   sum(c.contribution_minor)::bigint contribution_minor,
   sum(c.fully_loaded_contribution_minor)::bigint fully_loaded_contribution_minor,
   case when sum(c.mrr_minor)>0 then round((sum(c.contribution_minor)*100.0)/sum(c.mrr_minor),2) else null end gross_margin_pct,
   case when sum(c.mrr_minor)>0 then round((sum(c.fully_loaded_contribution_minor)*100.0)/sum(c.mrr_minor),2) else null end fully_loaded_gross_margin_pct,
   count(*) filter(where c.contribution_minor<0)::integer negative_contribution_customers,
   count(*) filter(where c.fully_loaded_contribution_minor<0)::integer negative_fully_loaded_customers,
   coalesce(s.shared_cost_minor,0)::bigint shared_cost_minor,
   (coalesce(s.shared_cost_minor,0)-coalesce(sum(c.allocated_shared_cost_minor),0))::bigint unallocated_shared_cost_minor
  from customer_rows c left join shared_costs s
   on s.period_month=c.snapshot_month and s.currency=c.currency
  group by c.snapshot_month,c.currency,s.shared_cost_minor
 )
 select jsonb_build_object('generatedAt',now(),'months',p_months,
  'periods',coalesce((select jsonb_agg(jsonb_build_object(
   'periodMonth',snapshot_month,'currency',currency,'paidCustomers',paid_customers,
   'mrrMinor',mrr_minor,'directCostMinor',direct_cost_minor,
   'allocatedSharedCostMinor',allocated_shared_cost_minor,
   'contributionMinor',contribution_minor,'grossMarginPct',gross_margin_pct,
   'fullyLoadedContributionMinor',fully_loaded_contribution_minor,
   'fullyLoadedGrossMarginPct',fully_loaded_gross_margin_pct,
   'negativeContributionCustomers',negative_contribution_customers,
   'negativeFullyLoadedCustomers',negative_fully_loaded_customers,
   'sharedCostMinor',shared_cost_minor,'unallocatedSharedCostMinor',unallocated_shared_cost_minor,
   'sharedOverheadAllocated',(allocated_shared_cost_minor>0)
  ) order by snapshot_month,currency) from periods),'[]'::jsonb),
  'limitations',jsonb_build_array(
   'Direct contribution subtracts only recorded customer-attributed service costs; fully loaded contribution also subtracts measured shared-cost allocations.',
   'Shared-cost allocations use immutable, month-matched batches and are shown separately from directly attributable expense.',
   'Shared costs without an approved policy, sufficient measured driver coverage or supported driver remain unallocated.',
   'Allocation does not change original service-cost ledger events, customer invoices, provider routing or statutory accounting.',
   'Trends use captured subscription revenue snapshots; missing periods are not inferred or backfilled.',
   'Currency totals remain isolated. This report is management accounting, not statutory revenue recognition or an audited financial statement.'
  )
 ) into v_result;
 return v_result;
end $$;

revoke all on function executive_visuals.add_financial_shared_cost_allocation_policy(uuid,text,text,text,date,date,integer,text) from public,anon,authenticated;
revoke all on function executive_visuals.run_financial_shared_cost_allocation(uuid,date,text,text) from public,anon,authenticated;
revoke all on function executive_visuals.financial_shared_cost_allocation_overview(uuid,integer) from public,anon,authenticated;
revoke all on function executive_visuals.financial_profitability_trend_report(uuid,integer) from public,anon,authenticated;
grant execute on function executive_visuals.add_financial_shared_cost_allocation_policy(uuid,text,text,text,date,date,integer,text) to service_role;
grant execute on function executive_visuals.run_financial_shared_cost_allocation(uuid,date,text,text) to service_role;
grant execute on function executive_visuals.financial_shared_cost_allocation_overview(uuid,integer) to service_role;
grant execute on function executive_visuals.financial_profitability_trend_report(uuid,integer) to service_role;
