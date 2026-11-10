-- Batch 25: verified provider-cost posting and monthly profitability trend reporting.
-- Invoice lines are posted only after exact one-to-one provider-reported usage reconciliation.

create table if not exists executive_visuals.financial_cost_attribution_links(
 id uuid primary key default gen_random_uuid(),
 reconciliation_event_id uuid not null unique
  references executive_visuals.ai_provider_invoice_reconciliation_events(id) on delete restrict,
 usage_event_id uuid not null unique references executive_visuals.ai_usage_cost_events(id) on delete restrict,
 service_cost_event_id uuid not null unique
  references executive_visuals.financial_service_cost_events(id) on delete restrict,
 owner_id uuid references auth.users(id) on delete restrict,
 project_id uuid,
 job_id uuid,
 provider text not null,
 model text not null,
 operation text not null,
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 amount_minor bigint not null check(amount_minor>=0),
 invoice_import_id uuid not null references executive_visuals.ai_provider_invoice_imports(id) on delete restrict,
 invoice_line_id uuid not null references executive_visuals.ai_provider_invoice_lines(id) on delete restrict,
 created_at timestamptz not null default now()
);
create index if not exists financial_cost_attribution_customer_idx
 on executive_visuals.financial_cost_attribution_links(owner_id,created_at desc)
 where owner_id is not null;
create index if not exists financial_cost_attribution_project_idx
 on executive_visuals.financial_cost_attribution_links(project_id,created_at desc)
 where project_id is not null;
alter table executive_visuals.financial_cost_attribution_links enable row level security;
revoke all on executive_visuals.financial_cost_attribution_links from public,anon,authenticated;
grant select,insert on executive_visuals.financial_cost_attribution_links to service_role;
create trigger financial_cost_attribution_links_immutable before update or delete
 on executive_visuals.financial_cost_attribution_links for each row
 execute function executive_visuals.reject_revenue_intelligence_mutation();

create or replace function executive_visuals.post_verified_ai_invoice_to_service_cost_ledger(
 p_actor_id uuid,p_import_id uuid
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare
 v_import ai_provider_invoice_imports%rowtype;
 v_line ai_provider_invoice_lines%rowtype;
 v_recon ai_provider_invoice_reconciliation_events%rowtype;
 v_usage ai_usage_cost_events%rowtype;
 v_cost jsonb;
 v_category text;
 v_period date;
 v_posted integer:=0;
 v_replayed integer:=0;
 v_shared integer:=0;
 v_total numeric:=0;
 v_count integer:=0;
 v_link uuid;
 v_cost_id uuid;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins
  where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_import_id is null then raise exception 'Invoice import ID is required' using errcode='22023'; end if;
 select * into v_import from ai_provider_invoice_imports where id=p_import_id for update;
 if not found then raise exception 'Invoice import not found' using errcode='P0002'; end if;
 perform pg_advisory_xact_lock(hashtext('ai-invoice-ledger-post:'||p_import_id::text));
 select count(*),coalesce(sum(l.amount_minor),0)
 into v_count,v_total
 from ai_provider_invoice_lines l where l.import_id=p_import_id;
 if v_count=0 or v_count<>v_import.imported_line_count or v_total<>v_import.total_minor
  or v_import.reconciliation_status='variance'
  or exists(select 1 from ai_provider_invoice_lines l where l.import_id=p_import_id and l.amount_minor<=0) then
  raise exception 'Invoice total or line evidence is incomplete or non-positive; resolve invoice variance before posting' using errcode='22023';
 end if;
 if (select count(*) from ai_provider_invoice_reconciliation_events r
     where r.invoice_import_id=p_import_id)<>v_count
  or exists(select 1 from ai_provider_invoice_reconciliation_events r
    where r.invoice_import_id=p_import_id and r.match_status<>'matched')
  or (select count(*) from ai_provider_invoice_reconciliation_events r
      where r.invoice_import_id=p_import_id and r.match_status='matched')<>v_count then
  raise exception 'Every invoice line must have one exact provider-reported usage match before posting' using errcode='22023';
 end if;

 for v_line in
  select l.* from ai_provider_invoice_lines l
  where l.import_id=p_import_id order by l.id
 loop
  select * into v_recon from ai_provider_invoice_reconciliation_events r
  where r.invoice_line_id=v_line.id and r.invoice_import_id=p_import_id
   and r.match_status='matched';
  if not found or v_recon.usage_event_id is null then
   raise exception 'Invoice line is missing its exact usage reconciliation evidence' using errcode='22023';
  end if;
  select * into v_usage from ai_usage_cost_events u
  where u.id=v_recon.usage_event_id and u.cost_basis='provider_reported'
   and u.cost_minor=v_line.amount_minor and u.currency=v_line.currency
   and u.provider=v_line.provider and u.requested_model=v_line.model
   and u.invoice_line_reference=v_line.provider_line_reference;
  if not found then
   raise exception 'Matched usage event no longer satisfies invoice evidence' using errcode='22023';
  end if;
  if v_usage.period_month<>date_trunc('month',v_line.usage_period)::date then
   raise exception 'Invoice line usage period does not match metered usage month' using errcode='22023';
  end if;
  v_category:=case v_line.operation
   when 'image' then 'image_generation'
   when 'video' then 'video_generation'
   when 'render' then 'render_compute'
   else 'ai_inference' end;
  v_period:=v_usage.period_month;
  v_cost:=record_financial_service_cost(
   p_actor_id,v_period,v_usage.owner_id,v_category,'provider_invoice',
   v_line.currency,v_line.amount_minor,
   left(v_import.provider||':'||v_import.invoice_reference||':'||v_line.provider_line_reference,160),
   left('Verified provider invoice '||v_import.invoice_reference||' / '||v_line.provider_line_reference,500),
   'ai-invoice-cost:'||v_recon.id::text,null
  );
  v_cost_id:=(v_cost->>'id')::uuid;
  insert into financial_cost_attribution_links(
   reconciliation_event_id,usage_event_id,service_cost_event_id,owner_id,
   project_id,job_id,provider,model,operation,currency,amount_minor,
   invoice_import_id,invoice_line_id
  ) values(
   v_recon.id,v_usage.id,v_cost_id,v_usage.owner_id,v_usage.project_id,v_usage.job_id,
   v_usage.provider,coalesce(v_usage.response_model,v_usage.requested_model),v_usage.operation,v_line.currency,
   v_line.amount_minor,p_import_id,v_line.id
  ) on conflict(reconciliation_event_id) do nothing;
  if coalesce((v_cost->>'idempotentReplay')::boolean,false) then
   v_replayed:=v_replayed+1;
  else
   v_posted:=v_posted+1;
  end if;
  if v_usage.owner_id is null then v_shared:=v_shared+1; end if;
 end loop;
 perform write_financial_admin_audit(p_actor_id,'finance.ai_invoice.posted_to_service_cost_ledger',
  'ai_provider_invoice',p_import_id::text,
  'Posted fully reconciled provider invoice costs to immutable service-cost ledger',
  'ai-invoice-ledger-post:'||p_import_id::text,
  jsonb_build_object('lineCount',v_count,'posted',v_posted,'idempotentReplays',v_replayed,
   'sharedCostLines',v_shared,'invoiceTotalMinor',v_import.total_minor,'currency',v_import.currency));
 return jsonb_build_object('importId',p_import_id,'lineCount',v_count,
  'posted',v_posted,'idempotentReplays',v_replayed,'sharedCostLines',v_shared,
  'totalMinor',v_import.total_minor,'currency',v_import.currency,
  'status','posted_to_service_cost_ledger');
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
 ), customer_rows as(
  select r.snapshot_month,r.currency,r.owner_id,r.mrr_minor,
   coalesce(d.direct_cost_minor,0)::bigint direct_cost_minor,
   (r.mrr_minor-coalesce(d.direct_cost_minor,0))::bigint contribution_minor
  from revenue r left join direct_costs d
   on d.period_month=r.snapshot_month and d.currency=r.currency and d.owner_id=r.owner_id
 ), periods as(
  select c.snapshot_month,c.currency,count(*) filter(where c.mrr_minor>0)::integer paid_customers,
   sum(c.mrr_minor)::bigint mrr_minor,sum(c.direct_cost_minor)::bigint direct_cost_minor,
   sum(c.contribution_minor)::bigint contribution_minor,
   case when sum(c.mrr_minor)>0 then round((sum(c.contribution_minor)*100.0)/sum(c.mrr_minor),2) else null end gross_margin_pct,
   count(*) filter(where c.contribution_minor<0)::integer negative_contribution_customers,
   coalesce(s.shared_cost_minor,0)::bigint shared_cost_minor
  from customer_rows c left join shared_costs s
   on s.period_month=c.snapshot_month and s.currency=c.currency
  group by c.snapshot_month,c.currency,s.shared_cost_minor
 )
 select jsonb_build_object('generatedAt',now(),'months',p_months,
  'periods',coalesce((select jsonb_agg(jsonb_build_object(
   'periodMonth',snapshot_month,'currency',currency,'paidCustomers',paid_customers,
   'mrrMinor',mrr_minor,'directCostMinor',direct_cost_minor,
   'contributionMinor',contribution_minor,'grossMarginPct',gross_margin_pct,
   'negativeContributionCustomers',negative_contribution_customers,
   'sharedCostMinor',shared_cost_minor,'sharedOverheadAllocated',false
  ) order by snapshot_month,currency) from periods),'[]'::jsonb),
  'limitations',jsonb_build_array(
   'Trends use recorded subscription revenue snapshots and immutable service-cost ledger entries only.',
   'Direct gross margin excludes shared overhead; shared costs are shown separately and are not arbitrarily allocated.',
   'Provider costs appear here only after exact invoice-to-usage reconciliation and explicit posting to the service-cost ledger.',
   'Periods without a revenue snapshot are not inferred or backfilled.'
  )
 ) into v_result;
 return v_result;
end $$;

revoke all on function executive_visuals.post_verified_ai_invoice_to_service_cost_ledger(uuid,uuid) from public,anon,authenticated;
revoke all on function executive_visuals.financial_profitability_trend_report(uuid,integer) from public,anon,authenticated;
grant execute on function executive_visuals.post_verified_ai_invoice_to_service_cost_ledger(uuid,uuid) to service_role;
grant execute on function executive_visuals.financial_profitability_trend_report(uuid,integer) to service_role;
