-- Batch 37: customer subscription economics using existing immutable revenue, cost and credit ledgers.
-- This is a reporting extension. It does not post revenue, credits, provider costs or customer charges.
create or replace function executive_visuals.subscription_customer_economics_report(
 p_actor_id uuid,p_period_month date default date_trunc('month',now())::date,p_limit integer default 250
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_result jsonb;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins
  where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_period_month is null or p_period_month<>date_trunc('month',p_period_month)::date
  or p_limit is null or p_limit not between 1 and 1000 then
  raise exception 'Invalid subscription economics period or limit' using errcode='22023';
 end if;

 with revenue as(
  select s.snapshot_month,s.owner_id,s.cohort_month,s.currency,s.mrr_minor,s.subscription_status
  from subscription_revenue_snapshots s where s.snapshot_month=p_period_month
 ), direct_costs as(
  select c.owner_id,c.currency,sum(c.amount_minor)::bigint direct_cost_minor,
   sum(c.amount_minor) filter(where c.source_type in('provider_invoice','provider_usage_export'))::bigint verified_provider_cost_minor,
   sum(c.amount_minor) filter(where c.source_type not in('provider_invoice','provider_usage_export'))::bigint other_direct_cost_minor,
   count(*)::integer cost_event_count
  from financial_service_cost_events c
  where c.period_month=p_period_month and c.owner_id is not null
  group by c.owner_id,c.currency
 ), cash_activity as(
  select owner_id,currency,sum(cash_collected_minor)::bigint cash_collected_minor,
   sum(refunded_minor)::bigint refunded_minor,sum(cash_event_count)::integer cash_event_count
  from (
   select p.owner_id,p.currency,sum(p.amount_minor)::bigint cash_collected_minor,
    0::bigint refunded_minor,count(*)::integer cash_event_count
   from payment_transactions p
   where p.status='successful' and p.paid_at>=p_period_month::timestamptz
    and p.paid_at<((p_period_month+interval '1 month')::date)::timestamptz
    and p.metadata->>'payment_purpose' in('subscription_purchase','subscription_renewal')
   group by p.owner_id,p.currency
   union all
   select r.owner_id,r.currency,0::bigint,sum(r.amount_minor)::bigint,count(*)::integer cash_event_count
   from payment_refunds r
   where r.status='succeeded' and r.completed_at>=p_period_month::timestamptz
    and r.completed_at<((p_period_month+interval '1 month')::date)::timestamptz
   group by r.owner_id,r.currency
  ) movements
  group by owner_id,currency
 ), credits as(
  select l.owner_id,
   coalesce(sum(l.credit_delta) filter(where l.entry_type='purchase_grant' and l.metadata ? 'subscription_id' and l.credit_delta>0
    and l.created_at>=p_period_month::timestamptz and l.created_at<((p_period_month+interval '1 month')::date)::timestamptz),0)::bigint subscription_credits_granted,
   coalesce(-sum(l.credit_delta) filter(where l.entry_type='settlement' and l.credit_delta<0
    and l.created_at>=p_period_month::timestamptz and l.created_at<((p_period_month+interval '1 month')::date)::timestamptz),0)::bigint credits_consumed,
   coalesce(-sum(l.credit_delta) filter(where l.entry_type='refund_reversal' and l.credit_delta<0
    and l.created_at>=p_period_month::timestamptz and l.created_at<((p_period_month+interval '1 month')::date)::timestamptz),0)::bigint credits_reversed,
   coalesce(sum(l.credit_delta) filter(where l.created_at<((p_period_month+interval '1 month')::date)::timestamptz),0)::bigint ledger_balance_at_period_end
  from credit_ledger l
  where l.created_at<((p_period_month+interval '1 month')::date)::timestamptz
  group by l.owner_id
 ), telemetry as(
  select t.owner_id,count(*)::integer telemetry_event_count,
   count(*) filter(where t.provider_cost_minor is not null)::integer provider_cost_evidence_count,
   coalesce(sum((t.dimensions->>'inputImageCount')::numeric),0) input_image_count,
   coalesce(sum((t.dimensions->>'outputImageCount')::numeric),0) output_image_count,
   coalesce(sum((t.dimensions->>'referenceVideoSeconds')::numeric),0) reference_video_seconds,
   coalesce(sum((t.dimensions->>'generatedVideoSeconds')::numeric),0) generated_video_seconds,
   coalesce(sum((t.dimensions->>'renderSeconds')::numeric),0) render_seconds,
   coalesce(sum((t.dimensions->>'inputAudioTokens')::numeric),0) input_audio_tokens,
   coalesce(sum((t.dimensions->>'outputAudioTokens')::numeric),0) output_audio_tokens,
   coalesce(sum((t.dimensions->>'framesProcessed')::numeric),0) frames_processed,
   coalesce(sum((t.dimensions->>'retryCount')::numeric),0) retry_count
  from ai_workload_telemetry_events t where t.period_month=p_period_month and t.owner_id is not null
  group by t.owner_id
 ), customer_rows as(
  select r.*,coalesce(d.direct_cost_minor,0)::bigint direct_cost_minor,
   coalesce(d.verified_provider_cost_minor,0)::bigint verified_provider_cost_minor,
   coalesce(d.other_direct_cost_minor,0)::bigint other_direct_cost_minor,
   coalesce(d.cost_event_count,0)::integer cost_event_count,
   (r.mrr_minor-coalesce(d.direct_cost_minor,0))::bigint contribution_minor,
   coalesce(ca.cash_collected_minor,0)::bigint cash_collected_minor,
   coalesce(ca.refunded_minor,0)::bigint refunded_minor,
   (coalesce(ca.cash_collected_minor,0)-coalesce(ca.refunded_minor,0))::bigint net_cash_collected_minor,
   coalesce(ca.cash_event_count,0)::integer cash_event_count,
   case when r.mrr_minor>0 then round((r.mrr_minor-coalesce(d.direct_cost_minor,0))*100.0/r.mrr_minor,2) else null end gross_margin_pct,
   coalesce(cr.subscription_credits_granted,0)::bigint subscription_credits_granted,
   coalesce(cr.credits_consumed,0)::bigint credits_consumed,
   coalesce(cr.credits_reversed,0)::bigint credits_reversed,
   cr.ledger_balance_at_period_end,
   cs.id subscription_id,cs.plan_code,cs.plan_version,cs.billing_interval,cs.included_credits,
   coalesce(t.telemetry_event_count,0)::integer telemetry_event_count,
   coalesce(t.provider_cost_evidence_count,0)::integer provider_cost_evidence_count,
   coalesce(t.input_image_count,0) input_image_count,coalesce(t.output_image_count,0) output_image_count,
   coalesce(t.reference_video_seconds,0) reference_video_seconds,
   coalesce(t.generated_video_seconds,0) generated_video_seconds,coalesce(t.render_seconds,0) render_seconds,
   coalesce(t.input_audio_tokens,0) input_audio_tokens,coalesce(t.output_audio_tokens,0) output_audio_tokens,
   coalesce(t.frames_processed,0) frames_processed,coalesce(t.retry_count,0) retry_count
  from revenue r
  left join direct_costs d on d.owner_id=r.owner_id and d.currency=r.currency
  left join credits cr on cr.owner_id=r.owner_id
  left join cash_activity ca on ca.owner_id=r.owner_id and ca.currency=r.currency
  left join telemetry t on t.owner_id=r.owner_id
  left join lateral(
   select s.id,s.plan_code,s.plan_version,s.billing_interval,s.included_credits
   from customer_subscriptions s
   where s.owner_id=r.owner_id and s.current_period_start<((p_period_month+interval '1 month')::date)::timestamptz
    and coalesce(s.current_period_end,'infinity'::timestamptz)>=p_period_month::timestamptz
   order by s.current_period_start desc,s.created_at desc limit 1
  ) cs on true
 ), totals as(
  select currency,count(*)::integer customers,
   count(*) filter(where mrr_minor>0)::integer paid_customers,
   sum(mrr_minor)::bigint mrr_minor,sum(direct_cost_minor)::bigint direct_cost_minor,
   sum(contribution_minor)::bigint contribution_minor,
   sum(cash_collected_minor)::bigint cash_collected_minor,
   sum(refunded_minor)::bigint refunded_minor,
   sum(net_cash_collected_minor)::bigint net_cash_collected_minor,
   sum(cash_event_count)::bigint cash_event_count,
   case when sum(mrr_minor)>0 then round(sum(contribution_minor)*100.0/sum(mrr_minor),2) else null end gross_margin_pct,
   sum(subscription_credits_granted)::bigint subscription_credits_granted,
   sum(credits_consumed)::bigint credits_consumed,
   sum(telemetry_event_count)::bigint telemetry_events,
   sum(provider_cost_evidence_count)::bigint provider_cost_evidence_events,
   count(*) filter(where contribution_minor<0)::integer negative_contribution_customers
  from customer_rows group by currency
 )
 select jsonb_build_object(
  'periodMonth',p_period_month,'generatedAt',now(),'customers',
  coalesce((select jsonb_agg(jsonb_build_object(
   'ownerId',owner_id,'currency',currency,'subscriptionStatus',subscription_status,
   'planCode',plan_code,'planVersion',plan_version,'billingInterval',billing_interval,
   'subscriptionIncludedCredits',included_credits,'mrrMinor',mrr_minor,
   'directCostMinor',direct_cost_minor,'verifiedProviderCostMinor',verified_provider_cost_minor,
   'otherDirectCostMinor',other_direct_cost_minor,'costEventCount',cost_event_count,
   'contributionMinor',contribution_minor,'grossMarginPct',gross_margin_pct,
   'cashCollectedMinor',cash_collected_minor,'refundedMinor',refunded_minor,
   'netCashCollectedMinor',net_cash_collected_minor,'cashEventCount',cash_event_count,
   'subscriptionCreditsGranted',subscription_credits_granted,'creditsConsumed',credits_consumed,
   'creditsReversed',credits_reversed,'creditLedgerBalanceAtPeriodEnd',ledger_balance_at_period_end,
   'telemetryEventCount',telemetry_event_count,'providerCostEvidenceCount',provider_cost_evidence_count,
   'inputImageCount',input_image_count,'outputImageCount',output_image_count,
   'referenceVideoSeconds',reference_video_seconds,'generatedVideoSeconds',generated_video_seconds,
   'renderSeconds',render_seconds,'inputAudioTokens',input_audio_tokens,'outputAudioTokens',output_audio_tokens,
   'framesProcessed',frames_processed,'retryCount',retry_count,
   'marginStatus',case when mrr_minor<=0 then 'non_recurring_or_zero_revenue'
    when contribution_minor<0 then 'negative_contribution'
    when gross_margin_pct<30 then 'low_margin' else 'positive_contribution' end,
   'costEvidenceStatus',case when cost_event_count=0 then 'no_direct_cost_posted'
    when verified_provider_cost_minor>0 then 'contains_verified_provider_cost'
    else 'direct_costs_without_verified_provider_invoice' end
  ) order by case when mrr_minor>0 then gross_margin_pct else null end asc nulls first,owner_id)
  from (select * from customer_rows order by case when mrr_minor>0 then gross_margin_pct else null end asc nulls first,owner_id limit p_limit) ranked),'[]'::jsonb),
  'byCurrency',coalesce((select jsonb_agg(jsonb_build_object(
   'currency',currency,'customers',customers,'paidCustomers',paid_customers,
   'mrrMinor',mrr_minor,'directCostMinor',direct_cost_minor,'contributionMinor',contribution_minor,
   'grossMarginPct',gross_margin_pct,'cashCollectedMinor',cash_collected_minor,
   'refundedMinor',refunded_minor,'netCashCollectedMinor',net_cash_collected_minor,
   'cashEventCount',cash_event_count,'subscriptionCreditsGranted',subscription_credits_granted,
   'creditsConsumed',credits_consumed,'telemetryEvents',telemetry_events,
   'providerCostEvidenceEvents',provider_cost_evidence_events,
   'negativeContributionCustomers',negative_contribution_customers
  ) order by currency) from totals),'[]'::jsonb),
  'limitations',jsonb_build_array(
   'MRR is the recorded subscription revenue snapshot; successful subscription cash receipts and completed refunds are reported separately by payment date.',
   'Direct cost includes only immutable service-cost ledger entries assigned to the customer and same currency; shared overhead is excluded.',
   'Provider costs are counted in contribution only after reconciliation and posting to the service-cost ledger.',
   'Workload telemetry counters and provider-cost evidence counts are diagnostic and are not added again to costs.',
   'Subscription credit grants and settled credit consumption are operational units, not currency or profit.',
   'The credit ledger balance excludes outstanding reservations; available credits can be lower.',
   'Customer rows require an existing subscription revenue snapshot; no missing revenue, usage or customer attribution is inferred.',
   'Customers are ranked by direct contribution margin; output is limited and aggregate totals cover all snapshot customers.'
  )
 ) into v_result;
 return v_result;
end $$;
revoke all on function executive_visuals.subscription_customer_economics_report(uuid,date,integer) from public,anon,authenticated;
grant execute on function executive_visuals.subscription_customer_economics_report(uuid,date,integer) to service_role;
