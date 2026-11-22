-- Batch 70: read-only, invoice-backed job cost and credit-usage coverage.
-- This report deliberately does not infer cash revenue from platform credit units.

create or replace function executive_visuals.get_verified_job_cost_coverage(
  p_actor_id uuid,
  p_period_month date,
  p_limit integer default 50
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals,auth
as $get_verified_job_cost_coverage$
declare
  v_rows jsonb := '[]'::jsonb;
  v_total integer := 0;
begin
  if p_actor_id is null or not exists(
    select 1 from platform_admins
    where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')
  ) then
    raise exception 'Financial administrator access required' using errcode='42501';
  end if;

  if p_period_month is null
     or p_period_month<>date_trunc('month',p_period_month)::date
     or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Invalid job cost coverage period or limit' using errcode='22023';
  end if;

  with matched_imports as (
    select i.id
    from ai_provider_invoice_imports i
    join ai_provider_invoice_lines l on l.import_id=i.id
    join ai_provider_invoice_reconciliation_events r
      on r.invoice_import_id=i.id and r.invoice_line_id=l.id
    where i.reconciliation_status='pending'
    group by i.id,i.imported_line_count
    having count(r.id)=i.imported_line_count
       and count(*) filter(where r.match_status<>'matched')=0
  ),
  invoice_cost_currency as (
    select u.job_id,u.owner_id,e.currency,
      sum(e.expected_amount_minor)::numeric as amount_minor,
      count(*)::integer as line_count,
      count(*) filter(where e.expected_amount_minor<0)::integer as negative_line_count
    from ai_provider_invoice_reconciliation_events e
    join matched_imports mi on mi.id=e.invoice_import_id
    join ai_usage_cost_events u on u.id=e.usage_event_id
    where e.match_status='matched'
      and u.period_month=p_period_month
      and u.job_id is not null
    group by u.job_id,u.owner_id,e.currency
  ),
  invoice_costs as (
    select job_id,owner_id,
      jsonb_agg(jsonb_build_object(
        'currency',currency,'amountMinor',amount_minor,'matchedLineCount',line_count
      ) order by currency) as cost_by_currency,
      count(*)::integer as currency_count,
      case when count(*)=1 then max(currency) else null end as currency,
      case when count(*)=1 and sum(negative_line_count)=0 then max(amount_minor)::bigint else null end as actual_provider_cost_minor,
      sum(line_count)::integer as matched_invoice_line_count,
      sum(negative_line_count)::integer as negative_invoice_line_count
    from invoice_cost_currency
    group by job_id,owner_id
  ),
  credit_usage as (
    select job_id,owner_id,sum(actual_credits)::bigint as credits_debited,
      count(*)::integer as settled_reservation_count
    from billing_credit_reservations
    where state='settled' and actual_credits is not null
      and settled_at>=p_period_month::timestamptz
      and settled_at<(p_period_month+interval '1 month')::timestamptz
      and job_id is not null
    group by job_id,owner_id
  ),
  all_jobs as (
    select job_id,owner_id from invoice_costs
    union
    select job_id,owner_id from credit_usage
  ),
  report_rows as (
    select j.job_id,j.owner_id,c.currency,c.currency_count,c.cost_by_currency,
      c.actual_provider_cost_minor,
      coalesce(c.matched_invoice_line_count,0) as matched_invoice_line_count,
      coalesce(c.negative_invoice_line_count,0) as negative_invoice_line_count,
      coalesce(u.credits_debited,0) as credits_debited,
      coalesce(u.settled_reservation_count,0) as settled_reservation_count,
      case
        when c.job_id is null then 'missing_invoice_backed_actual_cost'
        when u.job_id is null then 'missing_settled_credit_usage'
        when c.negative_invoice_line_count>0 then 'negative_invoice_adjustment_review'
        when c.currency_count>1 then 'mixed_currency_cost_review'
        else 'cost_and_credit_evidence_available'
      end as evidence_status,
      'revenue_allocation_required'::text as profitability_status,
      null::bigint as recognized_revenue_minor,
      null::numeric as gross_margin_pct,
      count(*) over()::integer as total_jobs
    from all_jobs j
    left join invoice_costs c on c.job_id=j.job_id and c.owner_id=j.owner_id
    left join credit_usage u on u.job_id=j.job_id and u.owner_id=j.owner_id
  )
  select
    coalesce(jsonb_agg(to_jsonb(page_row)-'total_jobs' order by page_row.actual_provider_cost_minor desc nulls last,page_row.job_id), '[]'::jsonb),
    coalesce(max(page_row.total_jobs),0)
  into v_rows,v_total
  from (
    select * from report_rows
    order by actual_provider_cost_minor desc nulls last,job_id
    limit p_limit
  ) page_row;

  return jsonb_build_object(
    'periodMonth',p_period_month,'totalJobs',v_total,
    'returnedJobs',jsonb_array_length(v_rows),'rows',v_rows,
    'revenueAllocationAvailable',false,'profitabilityAvailable',false,
    'blockedReason','verified_revenue_allocation_not_available',
    'accountingBasis','matched_provider_invoice_lines_plus_settled_generation_credit_reservations',
    'limitations',jsonb_build_array(
      'Only invoice lines with an immutable matched reconciliation event and a fully matched invoice import count as verified provider actual cost.',
      'Credit units are usage units, not money; recognized revenue is deliberately null until a separate verified revenue-allocation ledger is connected.',
      'Mixed-currency job costs are shown as separate currency totals and are not summed into a misleading monetary amount.',
      'This report is read-only and does not post ledger entries, change credits, set prices or initiate provider or payment activity.'
    )
  );
end;
$get_verified_job_cost_coverage$;

revoke all on function executive_visuals.get_verified_job_cost_coverage(uuid,date,integer)
  from public,anon,authenticated;
grant execute on function executive_visuals.get_verified_job_cost_coverage(uuid,date,integer)
  to service_role;
