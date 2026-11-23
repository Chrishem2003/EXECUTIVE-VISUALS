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
  ), fee_source_scope as (
    select distinct a.source_id
    from executive_visuals.billing_credit_revenue_allocations a
    join scoped_jobs j on j.id=a.job_id and j.owner_id=a.owner_id
    where a.source_id is not null
  ), fee_allocations as (
    -- Window over every job consuming each source, not just the displayed page.
    -- Cumulative rounding makes allocated minor units add exactly to the source fee.
    select a.job_id,a.owner_id,a.source_id,s.source_type,s.credits_granted,
      p.currency,p.provider_fee_minor,a.credits_consumed,
      sum(a.credits_consumed) over(
        partition by a.source_id order by a.created_at,a.id
        rows between unbounded preceding and current row
      ) cumulative_credits,
      coalesce(sum(a.credits_consumed) over(
        partition by a.source_id order by a.created_at,a.id
        rows between unbounded preceding and 1 preceding
      ),0) prior_credits,
      case when p.provider_fee_minor is null then null else
        round(p.provider_fee_minor::numeric*
          sum(a.credits_consumed) over(partition by a.source_id order by a.created_at,a.id
            rows between unbounded preceding and current row)/s.credits_granted)
        -round(p.provider_fee_minor::numeric*
          coalesce(sum(a.credits_consumed) over(partition by a.source_id order by a.created_at,a.id
            rows between unbounded preceding and 1 preceding
          ),0)/s.credits_granted)
      end allocated_fee_minor
    from executive_visuals.billing_credit_revenue_allocations a
    join executive_visuals.billing_credit_revenue_sources s on s.id=a.source_id
    left join executive_visuals.payment_transactions p
      on p.id=s.source_reference_id and p.owner_id=s.owner_id
    where a.source_id in(select source_id from fee_source_scope)
      and s.source_type in('paid_credit_pack','subscription_allowance')
  ), fee_by_job as (
    select f.job_id,count(*)::integer fee_source_count,
      count(*) filter(where f.provider_fee_minor is null)::integer missing_fee_count,
      count(distinct f.currency)::integer fee_currency_count,
      coalesce(sum(f.allocated_fee_minor),0)::bigint fee_minor,
      min(f.currency) fee_currency,
      coalesce(jsonb_agg(jsonb_build_object(
        'sourceId',f.source_id,'sourceType',f.source_type,'currency',f.currency,
        'creditsConsumed',f.credits_consumed,'sourceCredits',f.credits_granted,
        'providerFeeMinor',f.provider_fee_minor,'allocatedFeeMinor',f.allocated_fee_minor
      ) order by f.source_id,f.job_id),'[]'::jsonb) fee_lines
    from fee_allocations f
    join scoped_jobs j on j.id=f.job_id and j.owner_id=f.owner_id
    group by f.job_id
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
      coalesce(uv.succeeded_usage_events,0) succeeded_usage_events,
      coalesce(fv.fee_source_count,0) fee_source_count,
      coalesce(fv.missing_fee_count,0) missing_fee_count,
      coalesce(fv.fee_currency_count,0) fee_currency_count,
      coalesce(fv.fee_minor,0) fee_minor,
      fv.fee_currency,
      coalesce(fv.fee_lines,'[]'::jsonb) fee_lines
    from scoped_jobs j
    left join revenue_by_job rv on rv.job_id=j.id
    left join cost_by_job cv on cv.job_id=j.id
    left join usage_by_job uv on uv.job_id=j.id
    left join fee_by_job fv on fv.job_id=j.id
  )
  select jsonb_build_object(
    'generatedAt',clock_timestamp(),
    'source','settled customer credit revenue allocations + immutable provider invoice and payment-fee attribution',
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
      'processorFee',jsonb_build_object(
        'status',case when fee_source_count=0 then 'not_applicable'
          when missing_fee_count>0 then 'missing'
          when fee_currency_count<>1 then 'mixed_currency' else 'verified' end,
        'amountMinor',case when fee_source_count=0 then 0
          when missing_fee_count=0 and fee_currency_count=1 then fee_minor else null end,
        'currency',case when fee_currency_count=1 then fee_currency else null end,
        'sourceCount',fee_source_count,'missingFeeSources',missing_fee_count,'lines',fee_lines
      ),
      'profitability',jsonb_build_object(
        'status',case
          when unresolved_count>0 then 'revenue_incomplete'
          when allocation_count=0 or revenue_currency_count=0 then 'revenue_unavailable'
          when revenue_currency_count<>1 or cost_currency_count>1 then 'mixed_currency'
          when cost_currency_count=1 and (revenue_currencies->>0)<>cost_currency then 'currency_mismatch'
          when credits_attributed<>actual_credits then 'revenue_incomplete'
          when invoice_line_count=0 or succeeded_usage_events<>invoice_line_count then 'cost_incomplete'
          when fee_source_count>0 and missing_fee_count>0 then 'processor_fee_incomplete'
          when fee_source_count>0 and fee_currency_count<>1 then 'mixed_currency'
          when fee_source_count>0 and fee_currency<>(revenue_currencies->>0) then 'currency_mismatch'
          when revenue_minor-cost_minor-coalesce(fee_minor,0)>0 then 'profitable'
          when revenue_minor-cost_minor-coalesce(fee_minor,0)=0 then 'break_even'
          else 'loss_making' end,
        'currency',case when unresolved_count=0 and credits_attributed=actual_credits and revenue_currency_count=1 and cost_currency_count=1
          and (revenue_currencies->>0)=cost_currency and invoice_line_count>0 and succeeded_usage_events=invoice_line_count
          then cost_currency else null end,
        'contributionMinor',case when unresolved_count=0 and credits_attributed=actual_credits and revenue_currency_count=1 and cost_currency_count=1
          and invoice_line_count>0 and succeeded_usage_events=invoice_line_count
          and (revenue_currencies->>0)=cost_currency then revenue_minor-cost_minor else null end,
        'grossMarginPct',case when unresolved_count=0 and credits_attributed=actual_credits and revenue_currency_count=1 and cost_currency_count=1
          and invoice_line_count>0 and succeeded_usage_events=invoice_line_count
          and (revenue_currencies->>0)=cost_currency and revenue_minor>0
          then round(((revenue_minor-cost_minor)*100.0)/revenue_minor,2) else null end,
        'netContributionMinor',case when unresolved_count=0 and credits_attributed=actual_credits
          and revenue_currency_count=1 and cost_currency_count=1 and invoice_line_count>0
          and succeeded_usage_events=invoice_line_count and (revenue_currencies->>0)=cost_currency
          and (fee_source_count=0 or (missing_fee_count=0 and fee_currency_count=1 and fee_currency=(revenue_currencies->>0)))
          then revenue_minor-cost_minor-coalesce(fee_minor,0) else null end,
        'netMarginPct',case when unresolved_count=0 and credits_attributed=actual_credits
          and revenue_currency_count=1 and cost_currency_count=1 and invoice_line_count>0
          and succeeded_usage_events=invoice_line_count and (revenue_currencies->>0)=cost_currency
          and (fee_source_count=0 or (missing_fee_count=0 and fee_currency_count=1 and fee_currency=(revenue_currencies->>0)))
          and revenue_minor>0
          then round(((revenue_minor-cost_minor-coalesce(fee_minor,0))*100.0)/revenue_minor,2) else null end
      )
    ) order by created_at desc,id),'[]'::jsonb),
    'limitations',jsonb_build_array(
      'Revenue is recognized only from verified paid-credit allocations; promotional credits contribute zero revenue.',
      'Subscription allowances awaiting finance revenue-split approval and unattributed credits are not treated as revenue.',
      'Provider cost is recognized only from immutable invoice-to-usage attribution links.',
      'Profitability is withheld when invoice coverage is incomplete, currencies differ, or revenue attribution is unresolved.',
      'Provider payment fees are allocated to consumed paid/subscription credits using cumulative minor-unit rounding; missing fee evidence blocks net contribution.',
      'Shared overhead, taxes, refunds and chargebacks are excluded until directly linked to credit-source reversals.',
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
