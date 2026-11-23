-- Batch 105: read-only per-job profitability from settled customer credit revenue
-- allocations and immutable provider invoice attribution links.
-- No ledger writes, credit grants, reversals, or currency conversion occur here.

create or replace function executive_visuals.financial_job_profitability_report(
  p_actor_id uuid,
  p_owner_id uuid default null,
  p_limit integer default 50
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals,auth
as $financial_job_profitability_report$
declare
  v_result jsonb;
begin
  if p_actor_id is null or not exists(
    select 1 from executive_visuals.platform_admins
    where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')
  ) then
    raise exception 'Financial administrator access required' using errcode='42501';
  end if;
  if p_limit is null or p_limit<1 or p_limit>100 then
    raise exception 'Job profitability limit must be between 1 and 100' using errcode='22023';
  end if;
  if p_owner_id is not null and not exists(
    select 1 from auth.users where id=p_owner_id
  ) then
    raise exception 'Profitability customer account was not found' using errcode='22023';
  end if;

  with scoped_jobs as (
    select j.id,j.owner_id,j.project_id,j.status,j.created_at,
      r.id reservation_id,r.actual_credits
    from executive_visuals.jobs j
    join executive_visuals.billing_credit_reservations r
      on r.job_id=j.id and r.owner_id=j.owner_id and r.state='settled'
    where j.job_type='video.generate'
      and j.status in('succeeded','partial')
      and (p_owner_id is null or j.owner_id=p_owner_id)
    order by j.created_at desc,j.id
    limit p_limit
  ), revenue_by_job as (
    select a.job_id,
      count(*)::integer allocation_count,
      count(*) filter(where a.allocation_status not in('verified','non_revenue'))::integer unresolved_count,
      coalesce(sum(a.credits_consumed),0)::bigint credits_attributed,
      coalesce(jsonb_agg(jsonb_build_object(
        'currency',a.currency,
        'recognizedRevenueMinor',a.revenue_minor,
        'creditsConsumed',a.credits_consumed,
        'allocationStatus',a.allocation_status
      ) order by a.currency,a.id),'[]'::jsonb) allocations,
      coalesce(jsonb_agg(distinct a.currency) filter(where a.allocation_status='verified' and a.currency is not null),'[]'::jsonb) currencies,
      count(distinct a.currency) filter(where a.allocation_status='verified')::integer currency_count,
      coalesce(sum(a.revenue_minor) filter(where a.allocation_status='verified'),0)::bigint revenue_minor
    from executive_visuals.billing_credit_revenue_allocations a
    join scoped_jobs j on j.id=a.job_id and j.owner_id=a.owner_id
    group by a.job_id
  ), cost_by_job as (
    select c.job_id,count(*)::integer invoice_line_count,
      count(distinct c.currency)::integer currency_count,
      coalesce(sum(c.amount_minor),0)::bigint cost_minor,
      coalesce(jsonb_agg(jsonb_build_object(
        'currency',c.currency,'amountMinor',c.amount_minor,'provider',c.provider,
        'model',c.model,'operation',c.operation,'invoiceImportId',c.invoice_import_id,
        'invoiceLineId',c.invoice_line_id
      ) order by c.created_at,c.id),'[]'::jsonb) cost_lines,
      min(c.currency) currency
    from executive_visuals.financial_cost_attribution_links c
    join scoped_jobs j on j.id=c.job_id and j.owner_id=c.owner_id
    group by c.job_id
  ), usage_by_job as (
    select u.job_id,count(*) filter(where u.status='succeeded')::integer succeeded_usage_events
    from executive_visuals.ai_usage_cost_events u
    join scoped_jobs j on j.id=u.job_id
    group by u.job_id
  ), rows as (
    select j.*,
      coalesce(rv.allocation_count,0) allocation_count,
      coalesce(rv.unresolved_count,0) unresolved_count,
      coalesce(rv.credits_attributed,0) credits_attributed,
      coalesce(rv.allocations,'[]'::jsonb) allocations,
      coalesce(rv.currencies,'[]'::jsonb) revenue_currencies,
      coalesce(rv.currency_count,0) revenue_currency_count,
      coalesce(rv.revenue_minor,0) revenue_minor,
      coalesce(cv.invoice_line_count,0) invoice_line_count,
      coalesce(cv.currency_count,0) cost_currency_count,
      coalesce(cv.cost_minor,0) cost_minor,
      cv.currency cost_currency,
      coalesce(cv.cost_lines,'[]'::jsonb) cost_lines,
      coalesce(uv.succeeded_usage_events,0) succeeded_usage_events
    from scoped_jobs j
    left join revenue_by_job rv on rv.job_id=j.id
    left join cost_by_job cv on cv.job_id=j.id
    left join usage_by_job uv on uv.job_id=j.id
  )
  select jsonb_build_object(
    'generatedAt',clock_timestamp(),
    'source','settled customer credit revenue allocations + immutable invoice cost attribution',
    'count',count(*),
    'jobs',coalesce(jsonb_agg(jsonb_build_object(
      'jobId',id,'ownerId',owner_id,'projectId',project_id,'jobStatus',status,
      'createdAt',created_at,'reservationId',reservation_id,'actualCredits',actual_credits,
      'revenue',jsonb_build_object('status',
        case when allocation_count=0 then 'missing'
             when unresolved_count>0 or credits_attributed<>actual_credits then 'incomplete'
             when revenue_currency_count=1 then 'verified'
             when revenue_currency_count=0 then 'non_revenue_only'
             else 'mixed_currency' end,
        'recognizedMinor',case when unresolved_count=0 and revenue_currency_count=1 then revenue_minor else null end,
        'currencies',revenue_currencies,'allocationCount',allocation_count,
        'unresolvedAllocations',unresolved_count,'creditsAttributed',credits_attributed,
        'allocations',allocations),
      'actualCost',jsonb_build_object('status',
        case when invoice_line_count=0 then 'missing'
             when succeeded_usage_events<>invoice_line_count then 'partial_invoice_coverage'
             when cost_currency_count<>1 then 'mixed_currency'
             else 'verified' end,
        'amountMinor',case when invoice_line_count>0 and succeeded_usage_events=invoice_line_count and cost_currency_count=1 then cost_minor else null end,
        'currency',case when cost_currency_count=1 then cost_currency else null end,
        'invoiceLineCount',invoice_line_count,'succeededUsageEvents',succeeded_usage_events,
        'lines',cost_lines),
      'profitability',jsonb_build_object(
        'status',case
          when unresolved_count>0 then 'revenue_incomplete'
          when allocation_count=0 or revenue_currency_count=0 then 'revenue_unavailable'
          when revenue_currency_count<>1 or cost_currency_count>1 then 'mixed_currency'
          when invoice_line_count=0 or succeeded_usage_events<>invoice_line_count then 'cost_incomplete'
          when revenue_minor-cost_minor>0 then 'profitable'
          when revenue_minor-cost_minor=0 then 'break_even'
          else 'loss_making' end,
        'currency',case when unresolved_count=0 and revenue_currency_count=1 and cost_currency_count=1
          and invoice_line_count>0 and succeeded_usage_events=invoice_line_count
          and (revenue_currencies->>0)=cost_currency then cost_currency else null end,
        'contributionMinor',case when unresolved_count=0 and revenue_currency_count=1 and cost_currency_count=1
          and invoice_line_count>0 and succeeded_usage_events=invoice_line_count
          and (revenue_currencies->>0)=cost_currency then revenue_minor-cost_minor else null end,
        'grossMarginPct',case when unresolved_count=0 and revenue_currency_count=1 and cost_currency_count=1
          and invoice_line_count>0 and succeeded_usage_events=invoice_line_count
          and (revenue_currencies->>0)=cost_currency and revenue_minor>0
          then round(((revenue_minor-cost_minor)*100.0)/revenue_minor,2) else null end
      )
    ) order by created_at desc,id),'[]'::jsonb),
    'limitations',jsonb_build_array(
      'Revenue is recognized only from verified paid-credit allocations; promotional credits contribute zero revenue.',
      'Subscription allowances awaiting finance revenue-split approval and unattributed credits are not treated as revenue.',
      'Provider cost is recognized only from immutable invoice-to-usage attribution links.',
      'Profitability is withheld when invoice coverage is incomplete, currencies differ, or revenue attribution is unresolved.',
      'Shared overhead, taxes, refunds and chargebacks are excluded unless directly attributed in the underlying ledgers.',
      'This report is read-only and never changes balances, grants credits, or initiates provider work.'
    )
  ) into v_result from rows;

  return v_result;
end;
$financial_job_profitability_report$;

revoke all on function executive_visuals.financial_job_profitability_report(uuid,uuid,integer)
  from public,anon,authenticated;
grant execute on function executive_visuals.financial_job_profitability_report(uuid,uuid,integer)
  to service_role;
