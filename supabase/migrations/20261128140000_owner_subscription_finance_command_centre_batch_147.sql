-- Batch 147: owner finance command centre, subscription liability visibility and controlled review.
-- No provider calls, refunds, credit grants/revocations, or subscription mutations are performed here.

create table if not exists executive_visuals.subscription_financial_remediation_requests (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references executive_visuals.subscription_financial_reconciliation_runs(id) on delete restrict,
  finding_index integer not null check (finding_index between 0 and 499),
  finding_category text not null check (finding_category in (
    'successful_payment_not_applied','applied_payment_not_successful','subscription_record_missing',
    'subscription_provider_mismatch','subscription_allowance_grant_missing',
    'subscription_allowance_wallet_mirror_missing','active_subscription_period_elapsed',
    'past_due_grace_deadline_missing','multiple_current_subscriptions',
    'stale_pending_subscription_without_pending_payment'
  )),
  entity_id uuid not null,
  customer_owner_id uuid not null references auth.users(id) on delete restrict,
  finding_snapshot jsonb not null check (jsonb_typeof(finding_snapshot)='object'),
  proposed_action text not null check (proposed_action in (
    'review_payment_application','review_payment_status','review_subscription_mapping',
    'review_provider_mapping','review_credit_grant','review_credit_wallet_mirror',
    'review_subscription_expiry','review_grace_deadline','review_duplicate_subscriptions',
    'review_stale_pending_subscription','manual_investigation'
  )),
  reason text not null check (char_length(reason) between 8 and 1000),
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 180),
  status text not null default 'pending_approval' check (status in ('pending_approval','approved_for_manual_review','rejected')),
  requested_by uuid not null references auth.users(id) on delete restrict,
  decided_by uuid references auth.users(id) on delete restrict,
  decision_reason text,
  created_at timestamptz not null default clock_timestamp(),
  decided_at timestamptz,
  check ((status='pending_approval' and decided_by is null and decided_at is null and decision_reason is null)
      or (status<>'pending_approval' and decided_by is not null and decided_at is not null
          and decision_reason is not null and char_length(decision_reason) between 8 and 1000))
);
create index if not exists subscription_financial_remediation_status_idx
  on executive_visuals.subscription_financial_remediation_requests(status,created_at desc);
create index if not exists subscription_financial_remediation_customer_idx
  on executive_visuals.subscription_financial_remediation_requests(customer_owner_id,created_at desc);

create table if not exists executive_visuals.subscription_financial_remediation_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references executive_visuals.subscription_financial_remediation_requests(id) on delete restrict,
  actor_id uuid not null references auth.users(id) on delete restrict,
  event_type text not null check (event_type in ('requested','approved_for_manual_review','rejected')),
  from_status text,
  to_status text not null,
  note text not null,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists subscription_financial_remediation_events_request_idx
  on executive_visuals.subscription_financial_remediation_events(request_id,created_at,id);

alter table executive_visuals.subscription_financial_remediation_requests enable row level security;
alter table executive_visuals.subscription_financial_remediation_events enable row level security;
revoke all on executive_visuals.subscription_financial_remediation_requests from public,anon,authenticated,service_role;
revoke all on executive_visuals.subscription_financial_remediation_events from public,anon,authenticated,service_role;
grant select on executive_visuals.subscription_financial_remediation_requests to service_role;
grant select on executive_visuals.subscription_financial_remediation_events to service_role;

create or replace function executive_visuals.prevent_subscription_financial_remediation_event_mutation()
returns trigger language plpgsql set search_path=pg_catalog
as $prevent_subscription_financial_remediation_event_mutation$
begin
  raise exception 'SUBSCRIPTION_FINANCIAL_REMEDIATION_EVENTS_APPEND_ONLY';
end;
$prevent_subscription_financial_remediation_event_mutation$;
drop trigger if exists subscription_financial_remediation_events_immutable
  on executive_visuals.subscription_financial_remediation_events;
create trigger subscription_financial_remediation_events_immutable
  before update or delete on executive_visuals.subscription_financial_remediation_events
  for each row execute function executive_visuals.prevent_subscription_financial_remediation_event_mutation();

create or replace function executive_visuals.request_subscription_financial_remediation(
  p_actor_id uuid,p_run_id uuid,p_finding_index integer,p_proposed_action text,
  p_reason text,p_idempotency_key text
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $request_subscription_financial_remediation$
declare
  run_row executive_visuals.subscription_financial_reconciliation_runs%rowtype;
  finding jsonb;
  request_row executive_visuals.subscription_financial_remediation_requests%rowtype;
  category text;
  entity_id_value uuid;
  customer_id uuid;
begin
  if p_actor_id is null or p_run_id is null or p_finding_index is null
     or p_finding_index not between 0 and 499
     or p_proposed_action not in ('review_payment_application','review_payment_status',
       'review_subscription_mapping','review_provider_mapping','review_credit_grant',
       'review_credit_wallet_mirror','review_subscription_expiry','review_grace_deadline',
       'review_duplicate_subscriptions','review_stale_pending_subscription','manual_investigation')
     or char_length(trim(coalesce(p_reason,''))) not between 8 and 1000
     or char_length(coalesce(p_idempotency_key,'')) not between 8 and 180 then
    raise exception 'SUBSCRIPTION_FINANCIAL_REMEDIATION_INPUT_INVALID' using errcode='22023';
  end if;
  if not exists(select 1 from platform_admins a where a.user_id=p_actor_id and a.role in ('owner','platform_admin')) then
    raise exception 'SUBSCRIPTION_FINANCIAL_OWNER_REQUIRED' using errcode='42501';
  end if;
  select * into run_row from subscription_financial_reconciliation_runs where id=p_run_id;
  if not found or run_row.status<>'completed' then
    raise exception 'SUBSCRIPTION_FINANCIAL_RECONCILIATION_RUN_NOT_FOUND' using errcode='P0002';
  end if;
  finding:=run_row.findings->p_finding_index;
  if finding is null or jsonb_typeof(finding)<>'object' then
    raise exception 'SUBSCRIPTION_FINANCIAL_FINDING_NOT_FOUND' using errcode='P0002';
  end if;
  category:=finding->>'category';
  if category not in ('successful_payment_not_applied','applied_payment_not_successful',
    'subscription_record_missing','subscription_provider_mismatch','subscription_allowance_grant_missing',
    'subscription_allowance_wallet_mirror_missing','active_subscription_period_elapsed',
    'past_due_grace_deadline_missing','multiple_current_subscriptions',
    'stale_pending_subscription_without_pending_payment') then
    raise exception 'SUBSCRIPTION_FINANCIAL_FINDING_CATEGORY_INVALID' using errcode='22023';
  end if;
  begin
    entity_id_value:=(finding->>'entityId')::uuid;
    customer_id:=(finding->'details'->>'ownerId')::uuid;
  exception when invalid_text_representation then
    raise exception 'SUBSCRIPTION_FINANCIAL_FINDING_IDENTIFIERS_INVALID' using errcode='22023';
  end;
  if entity_id_value is null or customer_id is null then
    raise exception 'SUBSCRIPTION_FINANCIAL_FINDING_IDENTIFIERS_MISSING' using errcode='22023';
  end if;

  insert into subscription_financial_remediation_requests(
    run_id,finding_index,finding_category,entity_id,customer_owner_id,finding_snapshot,
    proposed_action,reason,idempotency_key,requested_by
  ) values (
    p_run_id,p_finding_index,category,entity_id_value,customer_id,finding,
    p_proposed_action,trim(p_reason),p_idempotency_key,p_actor_id
  ) on conflict(idempotency_key) do nothing
  returning * into request_row;

  if request_row.id is null then
    select * into request_row from subscription_financial_remediation_requests
     where idempotency_key=p_idempotency_key;
    if request_row.run_id<>p_run_id or request_row.finding_index<>p_finding_index
       or request_row.proposed_action<>p_proposed_action or request_row.reason<>trim(p_reason)
       or request_row.requested_by<>p_actor_id then
      raise exception 'SUBSCRIPTION_FINANCIAL_REMEDIATION_IDEMPOTENCY_CONFLICT' using errcode='23505';
    end if;
    return jsonb_build_object('requestId',request_row.id,'status',request_row.status,'replayed',true);
  end if;

  insert into subscription_financial_remediation_events(
    request_id,actor_id,event_type,from_status,to_status,note
  ) values(request_row.id,p_actor_id,'requested',null,'pending_approval',trim(p_reason));

  return jsonb_build_object('requestId',request_row.id,'status',request_row.status,'replayed',false);
end;
$request_subscription_financial_remediation$;

create or replace function executive_visuals.decide_subscription_financial_remediation(
  p_actor_id uuid,p_request_id uuid,p_decision text,p_reason text
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $decide_subscription_financial_remediation$
declare
  request_row executive_visuals.subscription_financial_remediation_requests%rowtype;
  next_status text;
begin
  if p_actor_id is null or p_request_id is null
     or p_decision not in ('approve','reject')
     or char_length(trim(coalesce(p_reason,''))) not between 8 and 1000 then
    raise exception 'SUBSCRIPTION_FINANCIAL_REMEDIATION_DECISION_INVALID' using errcode='22023';
  end if;
  if not exists(select 1 from platform_admins a where a.user_id=p_actor_id and a.role in ('owner','platform_admin')) then
    raise exception 'SUBSCRIPTION_FINANCIAL_OWNER_REQUIRED' using errcode='42501';
  end if;
  select * into request_row from subscription_financial_remediation_requests
   where id=p_request_id for update;
  if not found then raise exception 'SUBSCRIPTION_FINANCIAL_REMEDIATION_NOT_FOUND' using errcode='P0002'; end if;
  if request_row.status<>'pending_approval' then
    raise exception 'SUBSCRIPTION_FINANCIAL_REMEDIATION_ALREADY_DECIDED' using errcode='23514';
  end if;
  if request_row.requested_by=p_actor_id then
    raise exception 'SUBSCRIPTION_FINANCIAL_REMEDIATION_SELF_APPROVAL_FORBIDDEN' using errcode='42501';
  end if;
  next_status:=case when p_decision='approve' then 'approved_for_manual_review' else 'rejected' end;
  update subscription_financial_remediation_requests
     set status=next_status,decided_by=p_actor_id,decision_reason=trim(p_reason),
         decided_at=clock_timestamp()
   where id=p_request_id;
  insert into subscription_financial_remediation_events(
    request_id,actor_id,event_type,from_status,to_status,note
  ) values(p_request_id,p_actor_id,next_status,'pending_approval',next_status,trim(p_reason));
  return jsonb_build_object('requestId',p_request_id,'status',next_status,
    'decidedBy',p_actor_id,'decidedAt',clock_timestamp(),'mutationsApplied',false);
end;
$decide_subscription_financial_remediation$;

revoke all on function executive_visuals.request_subscription_financial_remediation(uuid,uuid,integer,text,text,text)
  from public,anon,authenticated;
revoke all on function executive_visuals.decide_subscription_financial_remediation(uuid,uuid,text,text)
  from public,anon,authenticated;
grant execute on function executive_visuals.request_subscription_financial_remediation(uuid,uuid,integer,text,text,text)
  to service_role;
grant execute on function executive_visuals.decide_subscription_financial_remediation(uuid,uuid,text,text)
  to service_role;

create or replace function executive_visuals.get_subscription_financial_liability_summary()
returns jsonb language sql stable security definer
set search_path=pg_catalog,executive_visuals
as $get_subscription_financial_liability_summary$
  with subscription_summary as (
    select currency,
      count(*) filter(where status='active')::integer as active_subscriptions,
      count(*) filter(where status='trialing')::integer as trialing_subscriptions,
      count(*) filter(where status='past_due')::integer as past_due_subscriptions,
      coalesce(sum(case when status='active' then
        case billing_interval when 'monthly' then amount_minor
          when 'yearly' then round(amount_minor::numeric/12)::bigint else 0 end
        else 0 end),0)::bigint as mrr_minor,
      coalesce(sum(case when status='past_due' then amount_minor else 0 end),0)::bigint as past_due_amount_minor,
      coalesce(sum(case when status='active' then included_credits else 0 end),0)::bigint as included_credit_units_per_cycle
    from customer_subscriptions
    group by currency
  ), cash_summary as (
    select currency,
      coalesce(sum(amount_minor) filter(where status='successful'),0)::bigint as gross_subscription_cash_minor,
      count(*) filter(where status='successful')::integer as successful_subscription_payments
    from payment_transactions
    where provider in ('paddle','pesapal')
      and metadata->>'payment_purpose' in ('subscription_purchase','subscription_renewal')
    group by currency
  ), refund_summary as (
    select currency,coalesce(sum(amount_minor) filter(where status='succeeded'),0)::bigint as refunded_subscription_cash_minor,
      count(*) filter(where status='succeeded')::integer as successful_subscription_refunds
    from payment_refunds
    where provider in ('paddle','pesapal')
      and payment_transaction_id in (
        select id from payment_transactions
         where provider in ('paddle','pesapal')
           and metadata->>'payment_purpose' in ('subscription_purchase','subscription_renewal')
      )
    group by currency
  ), currencies as (
    select currency from subscription_summary
    union select currency from cash_summary
    union select currency from refund_summary
  ), currency_rows as (
    select c.currency,
      coalesce(s.active_subscriptions,0) as active_subscriptions,
      coalesce(s.trialing_subscriptions,0) as trialing_subscriptions,
      coalesce(s.past_due_subscriptions,0) as past_due_subscriptions,
      coalesce(s.mrr_minor,0) as mrr_minor,
      coalesce(s.past_due_amount_minor,0) as past_due_amount_minor,
      coalesce(s.included_credit_units_per_cycle,0) as included_credit_units_per_cycle,
      coalesce(cs.gross_subscription_cash_minor,0) as gross_subscription_cash_minor,
      coalesce(cs.successful_subscription_payments,0) as successful_subscription_payments,
      coalesce(rs.refunded_subscription_cash_minor,0) as refunded_subscription_cash_minor,
      coalesce(rs.successful_subscription_refunds,0) as successful_subscription_refunds
    from currencies c left join subscription_summary s using(currency)
    left join cash_summary cs using(currency) left join refund_summary rs using(currency)
  ), wallet as (
    select coalesce(sum(amount),0)::bigint as available_credit_units
      from billing_credit_ledger
  ), reserved as (
    select coalesce(sum(reserved_credits),0)::bigint as reserved_credit_units
      from billing_credit_reservations where state='reserved'
  ), pending_split as (
    select coalesce(sum(credits_granted),0)::bigint as pending_subscription_split_credit_units,
      count(*)::integer as pending_subscription_split_sources
    from billing_credit_revenue_sources
    where source_type='subscription_allowance' and revenue_status='pending_subscription_split'
  )
  select jsonb_build_object(
    'generatedAt',clock_timestamp(),
    'byCurrency',coalesce((select jsonb_agg(to_jsonb(currency_rows) order by currency) from currency_rows),'[]'::jsonb),
    'creditUnits',jsonb_build_object(
      'available',wallet.available_credit_units,
      'reserved',reserved.reserved_credit_units,
      'grossOutstanding',wallet.available_credit_units+reserved.reserved_credit_units,
      'pendingSubscriptionSplit',pending_split.pending_subscription_split_credit_units,
      'pendingSubscriptionSplitSources',pending_split.pending_subscription_split_sources,
      'monetaryLiabilityCalculated',false,
      'note','Credit units are not converted to cash liability without an approved subscription credit-price allocation.'
    )
  )
  from wallet,reserved,pending_split;
$get_subscription_financial_liability_summary$;

revoke all on function executive_visuals.get_subscription_financial_liability_summary() from public,anon,authenticated;
grant execute on function executive_visuals.get_subscription_financial_liability_summary() to service_role;

-- Supabase Cron is optional. If pg_cron is already enabled, install an hourly
-- read-only reconciliation. The migration never enables an extension or provisions a paid service.
do $batch147_optional_cron$
begin
  if to_regnamespace('cron') is not null then
    execute $schedule$
      select cron.schedule(
        'executive-visuals-subscription-financial-reconciliation',
        '0 * * * *',
        'select executive_visuals.run_subscription_financial_reconciliation(100)'
      )
    $schedule$;
  end if;
exception when others then
  raise notice 'Batch 147 optional pg_cron schedule was not installed: %',sqlerrm;
end;
$batch147_optional_cron$;
