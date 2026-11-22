-- Batch 57: customer-facing billing-period spend summary and allowance alerts.
-- Read-only summary over authoritative generation reservations. No grants, charges,
-- credit mutations, customer-visible allowance publication, or provider calls occur here.
create or replace function executive_visuals.get_customer_credit_spend_summary(
  p_owner_id uuid
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  active_count integer;
  subscription_row executive_visuals.customer_subscriptions%rowtype;
  period_start timestamptz;
  period_end timestamptz;
  period_type text;
  allowance bigint;
  allowance_published boolean:=false;
  settled_credits bigint:=0;
  reserved_credits bigint:=0;
  used_credits bigint:=0;
  usage_percent bigint;
  alerts jsonb:='[]'::jsonb;
begin
  if p_owner_id is null then
    raise exception 'CUSTOMER_CREDIT_SPEND_OWNER_REQUIRED' using errcode='22023';
  end if;

  select count(*)::integer into active_count
    from customer_subscriptions
   where owner_id=p_owner_id
     and status='active'
     and current_period_end>clock_timestamp();

  if active_count=1 then
    select * into subscription_row
      from customer_subscriptions
     where owner_id=p_owner_id
       and status='active'
       and current_period_end>clock_timestamp()
     order by current_period_end desc
     limit 1;
    period_start:=subscription_row.current_period_start;
    period_end:=subscription_row.current_period_end;
    period_type:='subscription_period';
    -- An allowance is actionable only when its trusted subscription snapshot
    -- explicitly marks it published. Draft prices and arbitrary credit values
    -- never activate customer-facing thresholds.
    if subscription_row.included_credits>0
       and subscription_row.entitlements_snapshot->>'credit_allowance_published'='true' then
      allowance:=subscription_row.included_credits;
      allowance_published:=true;
    end if;
  else
    period_start:=date_trunc('month',clock_timestamp());
    period_end:=period_start+interval '1 month';
    period_type:='calendar_month';
  end if;

  select coalesce(sum(actual_credits),0)::bigint
    into settled_credits
    from billing_credit_reservations r
   where r.owner_id=p_owner_id
     and r.state='settled'
     and r.created_at>=period_start
     and r.created_at<period_end;

  select coalesce(sum(r.reserved_credits),0)::bigint
    into reserved_credits
    from billing_credit_reservations r
   where r.owner_id=p_owner_id
     and r.state='reserved'
     and r.created_at>=period_start
     and r.created_at<period_end;

  used_credits:=settled_credits+reserved_credits;
  if allowance_published then
    usage_percent:=floor((used_credits::numeric*100)/allowance)::bigint;
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'threshold',threshold,
        'level',case when threshold=100 then 'critical' when threshold=80 then 'warning' else 'notice' end,
        'usedCredits',used_credits,
        'allowance',allowance,
        'usagePercent',usage_percent
      ) order by threshold
    ),'[]'::jsonb)
      into alerts
      from (values (50),(80),(100)) as thresholds(threshold)
     where used_credits::numeric*100>=allowance::numeric*threshold;
  end if;

  return jsonb_build_object(
    'periodStart',period_start,
    'periodEnd',period_end,
    'periodType',period_type,
    'subscriptionAmbiguous',active_count>1,
    'allowance',case when allowance_published then allowance else null end,
    'allowancePublished',allowance_published,
    'settledCredits',settled_credits,
    'reservedCredits',reserved_credits,
    'usedCredits',used_credits,
    'usagePercent',usage_percent,
    'alertsEnabled',allowance_published,
    'alerts',alerts,
    'accountingBasis','settled_actual_plus_active_reservations',
    'source','billing_credit_reservations'
  );
end;
$$;

revoke all on function executive_visuals.get_customer_credit_spend_summary(uuid)
  from public,anon,authenticated;
grant execute on function executive_visuals.get_customer_credit_spend_summary(uuid)
  to service_role;
