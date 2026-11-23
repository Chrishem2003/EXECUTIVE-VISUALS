-- Batch 108: read-only, evidence-backed refund attribution to consumed paid-credit jobs.
-- Confirmed refunds reduce recognized job revenue proportionally to paid-credit usage.
-- Pending/failed refunds are exposure only and never reduce realized revenue.
-- Chargebacks remain separately reported exposure; they are not double-counted as refunds.

create or replace function executive_visuals.financial_job_refund_attribution_report(
  p_actor_id uuid,
  p_owner_id uuid default null,
  p_limit integer default 100
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals,auth
as $financial_job_refund_attribution_report$
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
    raise exception 'Refund attribution limit must be between 1 and 100' using errcode='22023';
  end if;
  if p_owner_id is not null and not exists(select 1 from auth.users where id=p_owner_id) then
    raise exception 'Refund attribution customer account was not found' using errcode='22023';
  end if;

  with scoped_jobs as (
    select j.id job_id,j.owner_id,j.created_at
    from executive_visuals.jobs j
    where j.job_type='video.generate' and j.status in('succeeded','partial')
      and (p_owner_id is null or j.owner_id=p_owner_id)
    order by j.created_at desc,j.id
    limit p_limit
  ), payment_source_totals as (
    select s.source_reference_id payment_id,s.owner_id,
      sum(s.credits_granted)::bigint total_granted_credits,
      count(*)::integer source_count,
      count(*) filter(where s.revenue_status<>'verified')::integer unresolved_source_count,
      min(s.currency) currency,
      count(distinct s.currency)::integer currency_count
    from executive_visuals.billing_credit_revenue_sources s
    where s.source_type='paid_credit_pack' and s.source_reference_id is not null
    group by s.source_reference_id,s.owner_id
  ), job_payment_usage as (
    -- Include every consuming job for each payment, not merely the displayed page,
    -- so cumulative minor-unit rounding reconciles across the complete source.
    select s.source_reference_id payment_id,s.owner_id,a.job_id,
      sum(a.credits_consumed)::bigint credits_consumed,
      count(*) filter(where a.allocation_status<>'verified')::integer unresolved_allocations,
      count(*)::integer allocation_count
    from executive_visuals.billing_credit_revenue_allocations a
    join executive_visuals.billing_credit_revenue_sources s on s.id=a.source_id
    join executive_visuals.jobs j on j.id=a.job_id and j.owner_id=a.owner_id
    where s.source_type='paid_credit_pack' and s.source_reference_id is not null
      and j.job_type='video.generate' and j.status in('succeeded','partial')
    group by s.source_reference_id,s.owner_id,a.job_id
  ), refund_rows as (
    select r.id refund_id,r.owner_id,r.payment_transaction_id payment_id,
      r.amount_minor,r.currency,r.status,r.completed_at
    from executive_visuals.payment_refunds r
    where r.status in('requested','processing','succeeded','failed')
      and (p_owner_id is null or r.owner_id=p_owner_id)
  ), confirmed_allocations as (
    select r.refund_id,r.owner_id,r.payment_id,r.amount_minor,r.currency,
      u.job_id,u.credits_consumed,t.total_granted_credits,
      u.unresolved_allocations,t.unresolved_source_count,t.currency source_currency,
      t.currency_count,
      sum(u.credits_consumed) over(partition by r.refund_id order by u.job_id
        rows between unbounded preceding and current row) cumulative_credits,
      coalesce(sum(u.credits_consumed) over(partition by r.refund_id order by u.job_id
        rows between unbounded preceding and 1 preceding),0) prior_credits,
      sum(u.credits_consumed) over(partition by r.refund_id) total_consumed
    from refund_rows r
    join payment_source_totals t on t.payment_id=r.payment_id and t.owner_id=r.owner_id
    join job_payment_usage u on u.payment_id=r.payment_id and u.owner_id=r.owner_id
    where r.status='succeeded'
  ), allocated_refunds as (
    select c.*,
      case when c.total_granted_credits>0
        then round(c.amount_minor::numeric*c.cumulative_credits/c.total_granted_credits)
           - round(c.amount_minor::numeric*c.prior_credits/c.total_granted_credits)
        else null end allocated_refund_minor,
      (c.total_consumed<=c.total_granted_credits
        and c.unresolved_allocations=0 and c.unresolved_source_count=0
        and c.currency_count=1 and c.source_currency=c.currency) evidence_complete
    from confirmed_allocations c
  ), refund_by_job as (
    select a.job_id,a.owner_id,
      count(distinct a.refund_id)::integer confirmed_refund_count,
      sum(a.allocated_refund_minor)::bigint confirmed_refund_minor,
      count(*) filter(where not a.evidence_complete)::integer incomplete_refund_allocations,
      min(a.currency) currency,
      count(distinct a.currency)::integer currency_count,
      jsonb_agg(jsonb_build_object(
        'refundId',a.refund_id,'paymentId',a.payment_id,
        'currency',a.currency,'refundAmountMinor',a.amount_minor,
        'allocatedRefundMinor',a.allocated_refund_minor,
        'creditsConsumed',a.credits_consumed,'sourceCredits',a.total_granted_credits,
        'status','succeeded','evidenceComplete',a.evidence_complete
      ) order by a.refund_id) refund_lines
    from allocated_refunds a
    group by a.job_id,a.owner_id
  ), pending_by_job as (
    select u.job_id,u.owner_id,
      count(distinct r.refund_id)::integer pending_refund_count,
      coalesce(sum(round(r.amount_minor::numeric*u.credits_consumed/t.total_granted_credits)),0)::bigint pending_refund_exposure_minor,
      min(r.currency) currency,count(distinct r.currency)::integer currency_count
    from refund_rows r
    join payment_source_totals t on t.payment_id=r.payment_id and t.owner_id=r.owner_id
    join job_payment_usage u on u.payment_id=r.payment_id and u.owner_id=r.owner_id
    where r.status in('requested','processing')
    group by u.job_id,u.owner_id
  )
  select jsonb_build_object(
    'generatedAt',clock_timestamp(),
    'source','provider-confirmed payment_refunds + paid-credit source grants + settled job credit consumption',
    'count',count(*),
    'jobs',coalesce(jsonb_agg(jsonb_build_object(
      'jobId',s.job_id,'ownerId',s.owner_id,
      'confirmedRefund',jsonb_build_object(
        'status',case when coalesce(f.incomplete_refund_allocations,0)>0 or coalesce(f.currency_count,0)>1
          then 'incomplete' else 'verified' end,
        'amountMinor',case when coalesce(f.incomplete_refund_allocations,0)=0 and coalesce(f.currency_count,0)=1
          then f.confirmed_refund_minor else null end,
        'currency',case when coalesce(f.currency_count,0)=1 then f.currency else null end,
        'count',coalesce(f.confirmed_refund_count,0),
        'lines',coalesce(f.refund_lines,'[]'::jsonb)
      ),
      'pendingRefundExposure',jsonb_build_object(
        'status',case when coalesce(p.pending_refund_count,0)=0 then 'none'
          when p.currency_count=1 then 'pending_not_deducted' else 'currency_incomplete' end,
        'amountMinor',case when p.currency_count=1 then p.pending_refund_exposure_minor else null end,
        'currency',case when p.currency_count=1 then p.currency else null end,
        'count',coalesce(p.pending_refund_count,0)
      ),
      'profitabilityAdjustment',jsonb_build_object(
        'status',case when coalesce(f.incomplete_refund_allocations,0)>0 or coalesce(f.currency_count,0)>1
          then 'withheld_incomplete_refund_attribution'
          when coalesce(f.confirmed_refund_count,0)>0 then 'subtract_from_job_revenue'
          else 'no_confirmed_refund'
        end,
        'confirmedRefundMinor',case when coalesce(f.incomplete_refund_allocations,0)=0 and coalesce(f.currency_count,0)=1
          then coalesce(f.confirmed_refund_minor,0) else null end
      )
    ) order by s.created_at desc,s.job_id),'[]'::jsonb),
    'limitations',jsonb_build_array(
      'Only provider-confirmed succeeded refunds reduce recognized paid-credit job revenue.',
      'Requested, processing and failed refunds are not deducted; pending amounts are shown as exposure only.',
      'Refunds are allocated proportionally to consumed paid-credit units across every job using the payment source, with cumulative minor-unit rounding.',
      'Attribution is withheld when paid-credit source coverage, allocation status or currency evidence is incomplete, or consumed credits exceed granted credits.',
      'Subscription credit splits, promotional credits, taxes, chargeback fees and shared overhead are not allocated by this report.',
      'Chargebacks remain separate from refunds and must not be added to refund losses without overlap reconciliation.',
      'This report is read-only and does not change balances, issue refunds, or initiate provider work.'
    )
  ) into v_result
  from scoped_jobs s
  left join refund_by_job f on f.job_id=s.job_id and f.owner_id=s.owner_id
  left join pending_by_job p on p.job_id=s.job_id and p.owner_id=s.owner_id;

  return v_result;
end;
$financial_job_refund_attribution_report$;

revoke all on function executive_visuals.financial_job_refund_attribution_report(uuid,uuid,integer)
  from public,anon,authenticated;
grant execute on function executive_visuals.financial_job_refund_attribution_report(uuid,uuid,integer)
  to service_role;
