-- Batch 111: owner-only, read-only deferred credit revenue and liability report.
-- Unconsumed verified paid-credit value remains deferred; credit units are never treated as currency.
create or replace function executive_visuals.financial_credit_liability_report(
  p_actor_id uuid,
  p_owner_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals,auth
as $financial_credit_liability_report$
declare
  v_result jsonb;
begin
  if p_actor_id is null or not exists(
    select 1 from executive_visuals.platform_admins
    where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')
  ) then
    raise exception 'Financial administrator access required' using errcode='42501';
  end if;
  if p_owner_id is not null and not exists(select 1 from auth.users where id=p_owner_id) then
    raise exception 'Credit liability customer account was not found' using errcode='22023';
  end if;

  with allocation_totals as (
    select a.source_id,
      coalesce(sum(a.credits_consumed),0)::bigint consumed_credits,
      coalesce(sum(a.revenue_minor) filter(where a.allocation_status='verified'),0)::bigint recognized_revenue_minor,
      count(*) filter(where a.allocation_status='pending_subscription_split')::integer pending_allocation_rows,
      coalesce(sum(a.credits_consumed) filter(where a.allocation_status='pending_subscription_split'),0)::bigint pending_split_credits,
      coalesce(sum(a.credits_consumed) filter(where a.allocation_status='unattributed'),0)::bigint unattributed_credits,
      count(*) filter(where a.allocation_status='verified' and a.currency is distinct from s.currency)::integer currency_mismatch_rows
    from executive_visuals.billing_credit_revenue_allocations a
    join executive_visuals.billing_credit_revenue_sources s on s.id=a.source_id
    where p_owner_id is null or a.owner_id=p_owner_id
    group by a.source_id
  ), source_rows as (
    select s.id,s.owner_id,s.source_type,s.currency,s.revenue_status,
      s.credits_granted,
      greatest(s.credits_granted-coalesce(a.consumed_credits,0),0)::bigint remaining_credits,
      coalesce(a.consumed_credits,0)::bigint consumed_credits,
      coalesce(a.recognized_revenue_minor,0)::bigint recognized_revenue_minor,
      case when s.revenue_status='verified'
        and coalesce(a.currency_mismatch_rows,0)=0
        and coalesce(a.recognized_revenue_minor,0)<=s.allocatable_revenue_minor
        then s.allocatable_revenue_minor-coalesce(a.recognized_revenue_minor,0)
        else null end deferred_revenue_minor,
      coalesce(a.pending_split_credits,0)::bigint pending_split_credits,
      coalesce(a.unattributed_credits,0)::bigint unattributed_credits,
      case when s.revenue_status='verified' and (
        coalesce(a.currency_mismatch_rows,0)>0 or coalesce(a.recognized_revenue_minor,0)>s.allocatable_revenue_minor
        or coalesce(a.consumed_credits,0)>s.credits_granted
      ) then true else false end integrity_exception
    from executive_visuals.billing_credit_revenue_sources s
    left join allocation_totals a on a.source_id=s.id
    where p_owner_id is null or s.owner_id=p_owner_id
  ), currency_rows as (
    select currency,
      count(*)::integer source_count,
      coalesce(sum(credits_granted),0)::bigint credits_granted,
      coalesce(sum(consumed_credits),0)::bigint credits_consumed,
      coalesce(sum(remaining_credits),0)::bigint credits_remaining,
      coalesce(sum(recognized_revenue_minor) filter(where revenue_status='verified'),0)::bigint recognized_revenue_minor,
      case when count(*) filter(where integrity_exception)>0 then null
        else coalesce(sum(deferred_revenue_minor) filter(where revenue_status='verified'),0)::bigint end deferred_revenue_liability_minor,
      coalesce(sum(remaining_credits) filter(where revenue_status='pending_subscription_split'),0)::bigint pending_subscription_split_credits,
      coalesce(sum(remaining_credits) filter(where revenue_status='unattributed'),0)::bigint unattributed_credits,
      count(*) filter(where integrity_exception)::integer integrity_exception_sources
    from source_rows
    where currency is not null
    group by currency
  ), unpriced as (
    select
      coalesce(sum(remaining_credits) filter(where revenue_status='pending_subscription_split'),0)::bigint pending_split_credits,
      coalesce(sum(remaining_credits) filter(where revenue_status='unattributed'),0)::bigint unattributed_credits,
      count(*) filter(where integrity_exception)::integer integrity_exception_sources,
      count(*) filter(where currency is null)::integer currency_unassigned_sources
    from source_rows
  )
  select jsonb_build_object(
    'generatedAt',clock_timestamp(),
    'scope',case when p_owner_id is null then 'all_customers' else 'single_customer' end,
    'byCurrency',coalesce((select jsonb_agg(jsonb_build_object(
      'currency',currency,'sourceCount',source_count,'creditsGranted',credits_granted,
      'creditsConsumed',credits_consumed,'creditsRemaining',credits_remaining,
      'recognizedRevenueMinor',recognized_revenue_minor,
      'deferredRevenueLiabilityMinor',deferred_revenue_liability_minor,
      'pendingSubscriptionSplitCredits',pending_subscription_split_credits,
      'unattributedCredits',unattributed_credits,
      'integrityExceptionSources',integrity_exception_sources
    ) order by currency) from currency_rows),'[]'::jsonb),
    'unpriced', (select to_jsonb(unpriced) from unpriced),
    'limitations',jsonb_build_array(
      'Deferred revenue liability is calculated only for verified paid-credit sources with matching currency and complete allocation evidence.',
      'Subscription allowance value awaiting an approved revenue split is reported as pending credits, not recognized revenue or a currency liability.',
      'Promotional and administrative compensation credits are non-revenue; unattributed credits remain an explicit exception.',
      'Cash receipts, processor fees, refunds, tax and subscription MRR are reported in their own finance reports and are not added to deferred credit value.',
      'This report is read-only; it does not post journal entries, change customer balances, approve subscription splits or initiate payments.'
    )
  ) into v_result;
  return v_result;
end;
$financial_credit_liability_report$;

revoke all on function executive_visuals.financial_credit_liability_report(uuid,uuid) from public,anon,authenticated;
grant execute on function executive_visuals.financial_credit_liability_report(uuid,uuid) to service_role;
