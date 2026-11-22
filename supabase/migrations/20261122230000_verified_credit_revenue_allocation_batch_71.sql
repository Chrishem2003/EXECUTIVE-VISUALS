-- Batch 71: verified payment-to-credit-to-job revenue allocation.
-- Cash is not recognized as generation revenue until paid credit units are consumed.
-- Subscription credit revenue remains blocked until Finance assigns the credit component.

create table if not exists executive_visuals.billing_credit_revenue_sources (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references executive_visuals.billing_credit_accounts(owner_id) on delete restrict,
  grant_ledger_id uuid not null unique references executive_visuals.billing_credit_ledger(id) on delete restrict,
  source_type text not null check(source_type in('paid_credit_pack','subscription_allowance','promotional','admin_compensation')),
  source_reference_id uuid references executive_visuals.payment_transactions(id) on delete restrict,
  credits_granted bigint not null check(credits_granted>0),
  allocatable_revenue_minor bigint check(allocatable_revenue_minor is null or allocatable_revenue_minor>=0),
  currency text check(currency is null or currency ~ '^[A-Z]{3}$'),
  revenue_status text not null check(revenue_status in('verified','pending_subscription_split','non_revenue')),
  evidence jsonb not null default '{}'::jsonb check(jsonb_typeof(evidence)='object'),
  created_at timestamptz not null default clock_timestamp(),
  check(
    (source_type='paid_credit_pack' and source_reference_id is not null and allocatable_revenue_minor is not null and allocatable_revenue_minor>0 and currency is not null and revenue_status='verified')
    or (source_type='subscription_allowance' and source_reference_id is not null and allocatable_revenue_minor is null and currency is not null and revenue_status='pending_subscription_split')
    or (source_type in('promotional','admin_compensation') and source_reference_id is null and allocatable_revenue_minor=0 and revenue_status='non_revenue')
  )
);
create index if not exists billing_credit_revenue_sources_fifo_idx
  on executive_visuals.billing_credit_revenue_sources(owner_id,created_at,id);

create table if not exists executive_visuals.billing_credit_revenue_source_reviews (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null unique references executive_visuals.billing_credit_revenue_sources(id) on delete restrict,
  owner_id uuid not null references executive_visuals.billing_credit_accounts(owner_id) on delete restrict,
  approved_revenue_minor bigint not null check(approved_revenue_minor>=0),
  currency text not null check(currency ~ '^[A-Z]{3}
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references executive_visuals.billing_credit_accounts(owner_id) on delete restrict,
  reservation_id uuid not null references executive_visuals.billing_credit_reservations(id) on delete restrict,
  job_id uuid not null references executive_visuals.jobs(id) on delete restrict,
  source_id uuid references executive_visuals.billing_credit_revenue_sources(id) on delete restrict,
  credits_consumed bigint not null check(credits_consumed>0),
  revenue_minor bigint check(revenue_minor is null or revenue_minor>=0),
  currency text check(currency is null or currency ~ '^[A-Z]{3}$'),
  allocation_status text not null check(allocation_status in('verified','pending_subscription_split','non_revenue','unattributed')),
  idempotency_key text not null unique,
  created_at timestamptz not null default clock_timestamp(),
  check(
    (allocation_status='verified' and source_id is not null and revenue_minor is not null and currency is not null)
    or (allocation_status='pending_subscription_split' and source_id is not null and revenue_minor is null and currency is not null)
    or (allocation_status='non_revenue' and source_id is not null and revenue_minor=0)
    or (allocation_status='unattributed' and source_id is null and revenue_minor is null and currency is null)
  )
);
create index if not exists billing_credit_revenue_allocations_job_idx
  on executive_visuals.billing_credit_revenue_allocations(owner_id,job_id,created_at);
create index if not exists billing_credit_revenue_allocations_source_idx
  on executive_visuals.billing_credit_revenue_allocations(source_id,created_at)
  where source_id is not null;

create table if not exists executive_visuals.billing_credit_revenue_allocation_runs (
  reservation_id uuid primary key references executive_visuals.billing_credit_reservations(id) on delete restrict,
  owner_id uuid not null references executive_visuals.billing_credit_accounts(owner_id) on delete restrict,
  job_id uuid not null references executive_visuals.jobs(id) on delete restrict,
  actual_credits bigint not null check(actual_credits>=0),
  allocated_credits bigint not null check(allocated_credits>=0),
  unattributed_credits bigint not null check(unattributed_credits>=0),
  pending_split_credits bigint not null check(pending_split_credits>=0),
  status text not null check(status in('complete','partial_unattributed','pending_subscription_split','no_usage')),
  created_at timestamptz not null default clock_timestamp(),
  check(allocated_credits+unattributed_credits=actual_credits)
);
alter table executive_visuals.billing_credit_revenue_sources enable row level security;
alter table executive_visuals.billing_credit_revenue_allocations enable row level security;
alter table executive_visuals.billing_credit_revenue_allocation_runs enable row level security;
revoke all on executive_visuals.billing_credit_revenue_sources from public,anon,authenticated;
revoke all on executive_visuals.billing_credit_revenue_allocations from public,anon,authenticated;
revoke all on executive_visuals.billing_credit_revenue_allocation_runs from public,anon,authenticated;
grant select,insert on executive_visuals.billing_credit_revenue_sources to service_role;
grant select,insert on executive_visuals.billing_credit_revenue_allocations to service_role;
grant select,insert on executive_visuals.billing_credit_revenue_allocation_runs to service_role;

create or replace function executive_visuals.register_generation_credit_revenue_source(
  p_owner_id uuid,
  p_grant_ledger_id uuid,
  p_source_type text,
  p_source_reference_id uuid,
  p_allocatable_revenue_minor bigint,
  p_currency text,
  p_evidence jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $register_generation_credit_revenue_source$
declare
  grant_row executive_visuals.billing_credit_ledger%rowtype;
  payment_row executive_visuals.payment_transactions%rowtype;
  old_grant executive_visuals.credit_ledger%rowtype;
  existing executive_visuals.billing_credit_revenue_sources%rowtype;
  v_status text;
  v_revenue bigint;
  v_currency text;
begin
  if p_owner_id is null or p_grant_ledger_id is null or p_source_type is null
     or p_source_type not in('paid_credit_pack','subscription_allowance','promotional','admin_compensation')
     or p_evidence is null or jsonb_typeof(p_evidence)<>'object' then
    raise exception 'CREDIT_REVENUE_SOURCE_ARGUMENTS_INVALID' using errcode='22023';
  end if;
  select * into grant_row from billing_credit_ledger
   where id=p_grant_ledger_id and owner_id=p_owner_id and event_type='grant';
  if not found or grant_row.amount<=0 then
    raise exception 'CREDIT_REVENUE_SOURCE_GRANT_NOT_FOUND' using errcode='23503';
  end if;

  if p_source_type in('paid_credit_pack','subscription_allowance') then
    if p_source_reference_id is null then
      raise exception 'CREDIT_REVENUE_PAYMENT_REFERENCE_REQUIRED' using errcode='22023';
    end if;
    select * into payment_row from payment_transactions
     where id=p_source_reference_id and owner_id=p_owner_id
       and status='successful' and verified_at is not null;
    if not found then
      raise exception 'CREDIT_REVENUE_PAYMENT_NOT_VERIFIED' using errcode='23514';
    end if;
    select * into old_grant from credit_ledger
     where owner_id=p_owner_id and payment_transaction_id=payment_row.id
       and entry_type='purchase_grant' and credit_delta=grant_row.amount
     order by created_at desc limit 1;
    if not found then
      raise exception 'CREDIT_REVENUE_PAYMENT_CREDIT_GRANT_MISMATCH' using errcode='23514';
    end if;
    v_currency:=payment_row.currency;
    if p_currency is distinct from v_currency then
      raise exception 'CREDIT_REVENUE_SOURCE_CURRENCY_MISMATCH' using errcode='23514';
    end if;

    if p_source_type='paid_credit_pack' then
      if payment_row.metadata->>'payment_purpose'<>'credit_pack_purchase'
         or coalesce((payment_row.metadata->>'credit_pack_applied')::boolean,false) is not true
         or p_allocatable_revenue_minor is distinct from payment_row.amount_minor then
        raise exception 'CREDIT_REVENUE_CREDIT_PACK_EVIDENCE_INVALID' using errcode='23514';
      end if;
      v_revenue:=payment_row.amount_minor;
      v_status:='verified';
    else
      if payment_row.metadata->>'payment_purpose' not in('subscription_purchase','subscription_renewal')
         or coalesce((payment_row.metadata->>'subscription_applied')::boolean,false) is not true
         or p_allocatable_revenue_minor is not null then
        raise exception 'CREDIT_REVENUE_SUBSCRIPTION_SPLIT_REQUIRED' using errcode='23514';
      end if;
      v_revenue:=null;
      v_status:='pending_subscription_split';
    end if;
  else
    if p_source_reference_id is not null or p_allocatable_revenue_minor is distinct from 0
       or p_currency is not null then
      raise exception 'CREDIT_REVENUE_NON_REVENUE_SOURCE_INVALID' using errcode='22023';
    end if;
    v_currency:=null;
    v_revenue:=0;
    v_status:='non_revenue';
  end if;

  select * into existing from billing_credit_revenue_sources where grant_ledger_id=grant_row.id;
  if found then
    if existing.owner_id<>p_owner_id or existing.source_type<>p_source_type
       or existing.source_reference_id is distinct from p_source_reference_id
       or existing.credits_granted<>grant_row.amount
       or existing.allocatable_revenue_minor is distinct from v_revenue
       or existing.currency is distinct from v_currency
       or existing.revenue_status<>v_status then
      raise exception 'CREDIT_REVENUE_SOURCE_IDEMPOTENCY_CONFLICT' using errcode='23505';
    end if;
    return jsonb_build_object('sourceId',existing.id,'creditsGranted',existing.credits_granted,'replayed',true,'revenueStatus',existing.revenue_status);
  end if;

  insert into billing_credit_revenue_sources(
    owner_id,grant_ledger_id,source_type,source_reference_id,credits_granted,
    allocatable_revenue_minor,currency,revenue_status,evidence
  ) values(
    p_owner_id,grant_row.id,p_source_type,p_source_reference_id,grant_row.amount,
    v_revenue,v_currency,v_status,p_evidence
  ) returning * into existing;
  return jsonb_build_object('sourceId',existing.id,'creditsGranted',existing.credits_granted,'replayed',false,'revenueStatus',existing.revenue_status);
end;
$register_generation_credit_revenue_source$;

revoke all on function executive_visuals.register_generation_credit_revenue_source(uuid,uuid,text,uuid,bigint,text,jsonb)
  from public,anon,authenticated;
grant execute on function executive_visuals.register_generation_credit_revenue_source(uuid,uuid,text,uuid,bigint,text,jsonb)
  to service_role;

create or replace function executive_visuals.approve_subscription_credit_revenue_split(
  p_actor_id uuid,
  p_source_id uuid,
  p_approved_revenue_minor bigint,
  p_reason text,
  p_evidence jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals,auth
as $approve_subscription_credit_revenue_split$
declare
  source_row executive_visuals.billing_credit_revenue_sources%rowtype;
  payment_row executive_visuals.payment_transactions%rowtype;
  existing executive_visuals.billing_credit_revenue_source_reviews%rowtype;
begin
  if p_actor_id is null or p_source_id is null or p_approved_revenue_minor is null
     or p_approved_revenue_minor<0 or p_reason is null or char_length(btrim(p_reason)) not between 8 and 500
     or p_evidence is null or jsonb_typeof(p_evidence)<>'object' then
    raise exception 'CREDIT_REVENUE_SPLIT_REVIEW_ARGUMENTS_INVALID' using errcode='22023';
  end if;
  if not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
    raise exception 'Financial administrator access required' using errcode='42501';
  end if;
  select * into source_row from billing_credit_revenue_sources where id=p_source_id for update;
  if not found or source_row.source_type<>'subscription_allowance'
     or source_row.revenue_status<>'pending_subscription_split' then
    raise exception 'CREDIT_REVENUE_SUBSCRIPTION_SOURCE_NOT_REVIEWABLE' using errcode='23514';
  end if;
  select * into payment_row from payment_transactions
   where id=source_row.source_reference_id and owner_id=source_row.owner_id
     and status='successful' and verified_at is not null;
  if not found or payment_row.currency<>source_row.currency
     or p_approved_revenue_minor>payment_row.amount_minor then
    raise exception 'CREDIT_REVENUE_SPLIT_EXCEEDS_VERIFIED_SUBSCRIPTION_PAYMENT' using errcode='23514';
  end if;

  select * into existing from billing_credit_revenue_source_reviews where source_id=source_row.id;
  if found then
    if existing.owner_id<>source_row.owner_id
       or existing.approved_revenue_minor<>p_approved_revenue_minor
       or existing.currency<>source_row.currency
       or existing.approved_by<>p_actor_id then
      raise exception 'CREDIT_REVENUE_SPLIT_REVIEW_CONFLICT' using errcode='23505';
    end if;
    return jsonb_build_object('reviewId',existing.id,'sourceId',source_row.id,'approvedRevenueMinor',existing.approved_revenue_minor,'currency',existing.currency,'replayed',true);
  end if;

  insert into billing_credit_revenue_source_reviews(
    source_id,owner_id,approved_revenue_minor,currency,approved_by,reason,evidence
  ) values(
    source_row.id,source_row.owner_id,p_approved_revenue_minor,source_row.currency,p_actor_id,btrim(p_reason),p_evidence
  ) returning * into existing;
  return jsonb_build_object('reviewId',existing.id,'sourceId',source_row.id,'approvedRevenueMinor',existing.approved_revenue_minor,'currency',existing.currency,'replayed',false);
end;
$approve_subscription_credit_revenue_split$;
revoke all on function executive_visuals.approve_subscription_credit_revenue_split(uuid,uuid,bigint,text,jsonb)
  from public,anon,authenticated;
grant execute on function executive_visuals.approve_subscription_credit_revenue_split(uuid,uuid,bigint,text,jsonb)
  to service_role;

-- Mirror only verified payment-backed legacy grants into the generation wallet.
-- This trigger keeps checkout/webhook implementations independent of wallet internals.
create or replace function executive_visuals.sync_verified_payment_credit_grant_to_generation_wallet()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $sync_verified_payment_credit_grant_to_generation_wallet$
declare
  payment_row executive_visuals.payment_transactions%rowtype;
  wallet_grant_id uuid;
  source_kind text;
  source_revenue bigint;
  source_currency text;
  source_evidence jsonb;
begin
  if new.entry_type<>'purchase_grant' or new.payment_transaction_id is null then
    return new;
  end if;

  select * into payment_row from payment_transactions
   where id=new.payment_transaction_id and owner_id=new.owner_id
     and status='successful' and verified_at is not null;
  if not found then return new; end if;

  if payment_row.metadata->>'payment_purpose'='credit_pack_purchase'
     and coalesce((payment_row.metadata->>'credit_pack_applied')::boolean,false) then
    source_kind:='paid_credit_pack';
    source_revenue:=payment_row.amount_minor;
    source_currency:=payment_row.currency;
  elsif payment_row.metadata->>'payment_purpose' in('subscription_purchase','subscription_renewal')
     and coalesce((payment_row.metadata->>'subscription_applied')::boolean,false) then
    source_kind:='subscription_allowance';
    source_revenue:=null;
    source_currency:=payment_row.currency;
  else
    return new;
  end if;

  source_evidence:=jsonb_build_object(
    'sourceType',source_kind,
    'paymentTransactionId',payment_row.id,
    'legacyCreditLedgerId',new.id,
    'provider',payment_row.provider,
    'verifiedAt',payment_row.verified_at
  );
  select ledger_id into wallet_grant_id
    from grant_generation_credits(
      new.owner_id,new.credit_delta,'payment-credit-ledger:'||new.id::text,
      new.reason,source_evidence
    );
  perform register_generation_credit_revenue_source(
    new.owner_id,wallet_grant_id,source_kind,payment_row.id,
    source_revenue,source_currency,source_evidence
  );
  return new;
end;
$sync_verified_payment_credit_grant_to_generation_wallet$;
revoke all on function executive_visuals.sync_verified_payment_credit_grant_to_generation_wallet()
  from public,anon,authenticated;
grant execute on function executive_visuals.sync_verified_payment_credit_grant_to_generation_wallet()
  to service_role;
drop trigger if exists ev_sync_verified_payment_credit_grant on executive_visuals.credit_ledger;
create trigger ev_sync_verified_payment_credit_grant
after insert on executive_visuals.credit_ledger
for each row execute function executive_visuals.sync_verified_payment_credit_grant_to_generation_wallet();

create or replace function executive_visuals.allocate_generation_credit_revenue_for_reservation(p_reservation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $allocate_generation_credit_revenue_for_reservation$
declare
  reservation_row executive_visuals.billing_credit_reservations%rowtype;
  source_row executive_visuals.billing_credit_revenue_sources%rowtype;
  existing_run executive_visuals.billing_credit_revenue_allocation_runs%rowtype;
  v_remaining bigint;
  v_available bigint;
  v_take bigint;
  v_prior_credits bigint;
  v_prior_revenue bigint;
  v_revenue bigint;
  v_allocated bigint:=0;
  v_unattributed bigint:=0;
  v_pending bigint:=0;
  v_status text;
  v_balance bigint;
begin
  select * into reservation_row from billing_credit_reservations
   where id=p_reservation_id and state='settled';
  if not found or reservation_row.actual_credits is null then
    raise exception 'CREDIT_REVENUE_RESERVATION_NOT_SETTLED' using errcode='23514';
  end if;
  perform 1 from billing_credit_accounts where owner_id=reservation_row.owner_id for update;
  select * into reservation_row from billing_credit_reservations
   where id=p_reservation_id and state='settled' for update;
  if not found then raise exception 'CREDIT_REVENUE_RESERVATION_NOT_SETTLED' using errcode='23514'; end if;
  select * into existing_run from billing_credit_revenue_allocation_runs where reservation_id=p_reservation_id;
  if found then
    return jsonb_build_object('reservationId',p_reservation_id,'status',existing_run.status,
      'allocatedCredits',existing_run.allocated_credits,'unattributedCredits',existing_run.unattributed_credits,
      'pendingSplitCredits',existing_run.pending_split_credits,'replayed',true);
  end if;

  v_remaining:=reservation_row.actual_credits;
  for source_row in
    select s.* from billing_credit_revenue_sources s
     where s.owner_id=reservation_row.owner_id
       and s.credits_granted>coalesce((
         select sum(a.credits_consumed) from billing_credit_revenue_allocations a where a.source_id=s.id
       ),0)
     order by s.created_at,s.id
     for update
  loop
    exit when v_remaining=0;
    select coalesce(sum(a.credits_consumed),0)::bigint,
           coalesce(sum(a.revenue_minor),0)::bigint
      into v_prior_credits,v_prior_revenue
      from billing_credit_revenue_allocations a where a.source_id=source_row.id;
    v_available:=source_row.credits_granted-v_prior_credits;
    v_take:=least(v_remaining,v_available);
    if v_take<=0 then continue; end if;

    if source_row.revenue_status='verified' then
      v_revenue:=floor(
        source_row.allocatable_revenue_minor::numeric*(v_prior_credits+v_take)::numeric
        /source_row.credits_granted::numeric
      )::bigint-v_prior_revenue;
      insert into billing_credit_revenue_allocations(
        owner_id,reservation_id,job_id,source_id,credits_consumed,revenue_minor,currency,allocation_status,idempotency_key
      ) values(
        reservation_row.owner_id,p_reservation_id,reservation_row.job_id,source_row.id,v_take,v_revenue,
        source_row.currency,'verified','credit-revenue:'||p_reservation_id::text||':'||source_row.id::text
      );
    elsif source_row.revenue_status='pending_subscription_split' then
      v_pending:=v_pending+v_take;
      insert into billing_credit_revenue_allocations(
        owner_id,reservation_id,job_id,source_id,credits_consumed,revenue_minor,currency,allocation_status,idempotency_key
      ) values(
        reservation_row.owner_id,p_reservation_id,reservation_row.job_id,source_row.id,v_take,null,
        source_row.currency,'pending_subscription_split','credit-revenue:'||p_reservation_id::text||':'||source_row.id::text
      );
    else
      insert into billing_credit_revenue_allocations(
        owner_id,reservation_id,job_id,source_id,credits_consumed,revenue_minor,currency,allocation_status,idempotency_key
      ) values(
        reservation_row.owner_id,p_reservation_id,reservation_row.job_id,source_row.id,v_take,0,
        null,'non_revenue','credit-revenue:'||p_reservation_id::text||':'||source_row.id::text
      );
    end if;
    v_allocated:=v_allocated+v_take;
    v_remaining:=v_remaining-v_take;
  end loop;

  if v_remaining>0 then
    v_unattributed:=v_remaining;
    insert into billing_credit_revenue_allocations(
      owner_id,reservation_id,job_id,source_id,credits_consumed,revenue_minor,currency,allocation_status,idempotency_key
    ) values(
      reservation_row.owner_id,p_reservation_id,reservation_row.job_id,null,v_remaining,null,null,
      'unattributed','credit-revenue:'||p_reservation_id::text||':unattributed'
    );
  end if;

  v_status:=case
    when reservation_row.actual_credits=0 then 'no_usage'
    when v_unattributed>0 then 'partial_unattributed'
    when v_pending>0 then 'pending_subscription_split'
    else 'complete'
  end;
  insert into billing_credit_revenue_allocation_runs(
    reservation_id,owner_id,job_id,actual_credits,allocated_credits,unattributed_credits,pending_split_credits,status
  ) values(
    p_reservation_id,reservation_row.owner_id,reservation_row.job_id,reservation_row.actual_credits,
    v_allocated,v_unattributed,v_pending,v_status
  );
  return jsonb_build_object('reservationId',p_reservation_id,'status',v_status,
    'allocatedCredits',v_allocated,'unattributedCredits',v_unattributed,
    'pendingSplitCredits',v_pending,'replayed',false);
end;
$allocate_generation_credit_revenue_for_reservation$;
revoke all on function executive_visuals.allocate_generation_credit_revenue_for_reservation(uuid)
  from public,anon,authenticated,service_role;

-- Wrap the existing evidence-gated settlement atomically. A failure in attribution
-- rolls back the credit settlement as well, preventing unaccounted successful jobs.
alter function executive_visuals.settle_generation_credit_reservation(uuid,bigint,jsonb)
  rename to settle_generation_credit_reservation_pre_revenue_batch71;
create or replace function executive_visuals.settle_generation_credit_reservation(
  p_reservation_id uuid,p_actual_credits bigint,p_evidence jsonb
) returns table(balance bigint,adjustment bigint,replayed boolean)
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $settle_generation_credit_reservation$
declare
  v_balance bigint;
  v_adjustment bigint;
  v_replayed boolean;
begin
  select r.balance,r.adjustment,r.replayed into v_balance,v_adjustment,v_replayed
    from settle_generation_credit_reservation_pre_revenue_batch71(p_reservation_id,p_actual_credits,p_evidence) r;
  perform allocate_generation_credit_revenue_for_reservation(p_reservation_id);
  return query select v_balance,v_adjustment,v_replayed;
end;
$settle_generation_credit_reservation$;
revoke all on function executive_visuals.settle_generation_credit_reservation(uuid,bigint,jsonb)
  from public,anon,authenticated;
grant execute on function executive_visuals.settle_generation_credit_reservation(uuid,bigint,jsonb)
  to service_role;

-- Expose a conservative, auditable revenue/cost view to the existing admin report.
create or replace function executive_visuals.get_verified_job_cost_coverage(
  p_actor_id uuid,p_period_month date,p_limit integer default 50
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals,auth
as $get_verified_job_cost_coverage$
declare
  v_rows jsonb:='[]'::jsonb;
  v_total integer:=0;
  v_revenue_complete boolean:=false;
  v_profitability_complete boolean:=false;
begin
  if p_actor_id is null or not exists(
    select 1 from platform_admins
     where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')
  ) then raise exception 'Financial administrator access required' using errcode='42501'; end if;
  if p_period_month is null or p_period_month<>date_trunc('month',p_period_month)::date
     or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Invalid job cost coverage period or limit' using errcode='22023';
  end if;

  with matched_imports as (
    select i.id from ai_provider_invoice_imports i
    join ai_provider_invoice_lines l on l.import_id=i.id
    join ai_provider_invoice_reconciliation_events r on r.invoice_import_id=i.id and r.invoice_line_id=l.id
    where i.reconciliation_status in('pending','matched')
    group by i.id,i.imported_line_count
    having count(r.id)=i.imported_line_count and count(*) filter(where r.match_status<>'matched')=0
  ), invoice_cost_currency as (
    select u.job_id,u.owner_id,e.currency,sum(e.expected_amount_minor)::numeric amount_minor,
      count(*)::integer line_count,count(*) filter(where e.expected_amount_minor<0)::integer negative_line_count
    from ai_provider_invoice_reconciliation_events e
    join matched_imports mi on mi.id=e.invoice_import_id
    join ai_usage_cost_events u on u.id=e.usage_event_id
    where e.match_status='matched' and u.period_month=p_period_month and u.job_id is not null
    group by u.job_id,u.owner_id,e.currency
  ), invoice_costs as (
    select job_id,owner_id,
      jsonb_agg(jsonb_build_object('currency',currency,'amountMinor',amount_minor,'matchedLineCount',line_count) order by currency) cost_by_currency,
      count(*)::integer currency_count,case when count(*)=1 then max(currency) end currency,
      case when count(*)=1 and sum(negative_line_count)=0 then max(amount_minor)::bigint end actual_provider_cost_minor,
      sum(line_count)::integer matched_invoice_line_count,sum(negative_line_count)::integer negative_invoice_line_count
    from invoice_cost_currency group by job_id,owner_id
  ), credit_usage as (
    select job_id,owner_id,sum(actual_credits)::bigint credits_debited,count(*)::integer settled_reservation_count
    from billing_credit_reservations
    where state='settled' and actual_credits is not null
      and settled_at>=p_period_month::timestamptz
      and settled_at<(p_period_month+interval '1 month')::timestamptz
      and job_id is not null group by job_id,owner_id
  ), allocation_revenue as (
    select a.job_id,a.owner_id,
      case when a.allocation_status='non_revenue' then null else coalesce(s.currency,a.currency) end currency,
      a.credits_consumed,
      case
        when a.allocation_status='non_revenue' then 'non_revenue'
        when a.source_id is null then 'unattributed'
        when s.revenue_status='verified' or review.source_id is not null then 'verified'
        else 'pending_subscription_split'
      end resolved_status,
      case
        when a.allocation_status='non_revenue' then 0::bigint
        when a.source_id is null then null::bigint
        when coalesce(s.allocatable_revenue_minor,review.approved_revenue_minor) is not null then
          floor(
            coalesce(s.allocatable_revenue_minor,review.approved_revenue_minor)::numeric
            * a.cumulative_credits::numeric / s.credits_granted::numeric
          )::bigint
          - floor(
            coalesce(s.allocatable_revenue_minor,review.approved_revenue_minor)::numeric
            * coalesce(a.prior_credits,0)::numeric / s.credits_granted::numeric
          )::bigint
        else null::bigint
      end revenue_minor
    from (
      select a.*,
        sum(a.credits_consumed) over(partition by a.source_id order by a.created_at,a.id rows between unbounded preceding and current row) cumulative_credits,
        sum(a.credits_consumed) over(partition by a.source_id order by a.created_at,a.id rows between unbounded preceding and 1 preceding) prior_credits
      from billing_credit_revenue_allocations a
      join billing_credit_revenue_allocation_runs r on r.reservation_id=a.reservation_id
      where r.created_at>=p_period_month::timestamptz
        and r.created_at<(p_period_month+interval '1 month')::timestamptz
    ) a
    left join billing_credit_revenue_sources s on s.id=a.source_id
    left join billing_credit_revenue_source_reviews review on review.source_id=s.id
  ), revenue_currency as (
    select job_id,owner_id,currency,
      sum(revenue_minor)::bigint revenue_minor,
      count(*) filter(where resolved_status not in('verified','non_revenue') or revenue_minor is null)::integer incomplete_count,
      count(*)::integer allocation_count
    from allocation_revenue
    group by job_id,owner_id,currency
  ), revenue_by_job as (
    select job_id,owner_id,
      jsonb_agg(jsonb_build_object('currency',currency,'revenueMinor',revenue_minor,'allocationCount',allocation_count) order by currency) revenue_by_currency,
      count(*) filter(where currency is not null)::integer currency_count,
      case when count(*) filter(where currency is not null)=1
        and sum(incomplete_count)=0
        then max(currency) end revenue_currency,
      case when count(*) filter(where currency is not null)=1
        and sum(incomplete_count)=0
        then max(revenue_minor) end recognized_revenue_minor,
      sum(incomplete_count)::integer incomplete_allocation_count
    from revenue_currency group by job_id,owner_id
  ), all_jobs as (
    select job_id,owner_id from invoice_costs
    union select job_id,owner_id from credit_usage
    union select job_id,owner_id from revenue_by_job
  ), report_rows as (
    select j.job_id,j.owner_id,c.currency,c.currency_count,c.cost_by_currency,c.actual_provider_cost_minor,
      coalesce(c.matched_invoice_line_count,0) matched_invoice_line_count,
      coalesce(c.negative_invoice_line_count,0) negative_invoice_line_count,
      coalesce(u.credits_debited,0) credits_debited,coalesce(u.settled_reservation_count,0) settled_reservation_count,
      r.revenue_currency,r.revenue_by_currency,r.recognized_revenue_minor,
      case when r.recognized_revenue_minor>0 and r.revenue_currency=c.currency
        and c.actual_provider_cost_minor is not null
        then round((r.recognized_revenue_minor-c.actual_provider_cost_minor)::numeric*100/r.recognized_revenue_minor,2)
        else null end gross_margin_pct,
      case when u.job_id is null then 'missing_settled_credit_usage'
        when r.job_id is null then 'missing_revenue_allocation'
        when r.incomplete_allocation_count>0 or r.recognized_revenue_minor is null then 'revenue_allocation_incomplete'
        when c.currency_count>1 then 'mixed_currency_cost_review'
        when c.actual_provider_cost_minor is null then 'missing_invoice_backed_actual_cost'
        when r.revenue_currency<>c.currency then 'currency_mismatch_review'
        else 'revenue_and_cost_evidence_available' end profitability_status,
      case when c.job_id is null then 'missing_invoice_backed_actual_cost'
        when c.negative_invoice_line_count>0 then 'negative_invoice_adjustment_review'
        when c.currency_count>1 then 'mixed_currency_cost_review'
        else 'cost_evidence_available' end evidence_status,
      count(*) over() total_jobs
    from all_jobs j
    left join invoice_costs c on c.job_id=j.job_id and c.owner_id=j.owner_id
    left join credit_usage u on u.job_id=j.job_id and u.owner_id=j.owner_id
    left join revenue_by_job r on r.job_id=j.job_id and r.owner_id=j.owner_id
  ), coverage as (
    select
      coalesce(bool_and(recognized_revenue_minor is not null and profitability_status not in(
        'missing_settled_credit_usage','missing_revenue_allocation','revenue_allocation_incomplete')),false) revenue_complete,
      coalesce(bool_and(recognized_revenue_minor is not null and actual_provider_cost_minor is not null
        and revenue_currency=currency and gross_margin_pct is not null),false) profitability_complete
    from report_rows
  )
  select coalesce(jsonb_agg(to_jsonb(p)-'total_jobs' order by p.actual_provider_cost_minor desc nulls last,p.job_id),'[]'::jsonb),
    coalesce(max(p.total_jobs),0),coverage.revenue_complete,coverage.profitability_complete
  into v_rows,v_total,v_revenue_complete,v_profitability_complete
  from (select * from report_rows order by actual_provider_cost_minor desc nulls last,job_id limit p_limit) p
  cross join coverage
  group by coverage.revenue_complete,coverage.profitability_complete;

  return jsonb_build_object(
    'periodMonth',p_period_month,'totalJobs',v_total,'returnedJobs',jsonb_array_length(v_rows),'rows',v_rows,
    'revenueAllocationAvailable',v_revenue_complete,'profitabilityAvailable',v_profitability_complete,
    'blockedReason',case when v_profitability_complete then null else 'verified_cost_or_revenue_allocation_incomplete' end,
    'accountingBasis','verified_payment_credit_grants_fifo_consumption_plus_matched_provider_invoice_lines',
    'limitations',jsonb_build_array(
      'Prepaid credit-pack revenue is allocated to generations in proportion to credits consumed, using integer minor-unit rounding across the lifetime of each grant.',
      'Subscription credit revenue remains pending until Finance records the credit component of the subscription price; the full subscription payment is never assumed to be generation revenue.',
      'Promotional and administrator-compensated credits carry zero cash revenue and are explicitly separated from paid credit sources.',
      'Legacy, project-pool or otherwise unlinked credits remain unattributed; they are never silently assigned to paid revenue.',
      'Gross margin excludes payment processing fees, refunds, chargebacks, tax, storage, rendering and other operating costs until those evidence sources are reconciled.'
    )
  );
end;
$get_verified_job_cost_coverage$;

),
  approved_by uuid not null references auth.users(id) on delete restrict,
  reason text not null check(char_length(reason) between 8 and 500),
  evidence jsonb not null default '{}'::jsonb check(jsonb_typeof(evidence)='object'),
  created_at timestamptz not null default clock_timestamp()
);
alter table executive_visuals.billing_credit_revenue_source_reviews enable row level security;
revoke all on executive_visuals.billing_credit_revenue_source_reviews from public,anon,authenticated;
grant select,insert on executive_visuals.billing_credit_revenue_source_reviews to service_role;

create table if not exists executive_visuals.billing_credit_revenue_allocations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references executive_visuals.billing_credit_accounts(owner_id) on delete restrict,
  reservation_id uuid not null references executive_visuals.billing_credit_reservations(id) on delete restrict,
  job_id uuid not null references executive_visuals.jobs(id) on delete restrict,
  source_id uuid references executive_visuals.billing_credit_revenue_sources(id) on delete restrict,
  credits_consumed bigint not null check(credits_consumed>0),
  revenue_minor bigint check(revenue_minor is null or revenue_minor>=0),
  currency text check(currency is null or currency ~ '^[A-Z]{3}$'),
  allocation_status text not null check(allocation_status in('verified','pending_subscription_split','non_revenue','unattributed')),
  idempotency_key text not null unique,
  created_at timestamptz not null default clock_timestamp(),
  check(
    (allocation_status='verified' and source_id is not null and revenue_minor is not null and currency is not null)
    or (allocation_status='pending_subscription_split' and source_id is not null and revenue_minor is null and currency is not null)
    or (allocation_status='non_revenue' and source_id is not null and revenue_minor=0)
    or (allocation_status='unattributed' and source_id is null and revenue_minor is null and currency is null)
  )
);
create index if not exists billing_credit_revenue_allocations_job_idx
  on executive_visuals.billing_credit_revenue_allocations(owner_id,job_id,created_at);
create index if not exists billing_credit_revenue_allocations_source_idx
  on executive_visuals.billing_credit_revenue_allocations(source_id,created_at)
  where source_id is not null;

create table if not exists executive_visuals.billing_credit_revenue_allocation_runs (
  reservation_id uuid primary key references executive_visuals.billing_credit_reservations(id) on delete restrict,
  owner_id uuid not null references executive_visuals.billing_credit_accounts(owner_id) on delete restrict,
  job_id uuid not null references executive_visuals.jobs(id) on delete restrict,
  actual_credits bigint not null check(actual_credits>=0),
  allocated_credits bigint not null check(allocated_credits>=0),
  unattributed_credits bigint not null check(unattributed_credits>=0),
  pending_split_credits bigint not null check(pending_split_credits>=0),
  status text not null check(status in('complete','partial_unattributed','pending_subscription_split','no_usage')),
  created_at timestamptz not null default clock_timestamp(),
  check(allocated_credits+unattributed_credits=actual_credits)
);
alter table executive_visuals.billing_credit_revenue_sources enable row level security;
alter table executive_visuals.billing_credit_revenue_allocations enable row level security;
alter table executive_visuals.billing_credit_revenue_allocation_runs enable row level security;
revoke all on executive_visuals.billing_credit_revenue_sources from public,anon,authenticated;
revoke all on executive_visuals.billing_credit_revenue_allocations from public,anon,authenticated;
revoke all on executive_visuals.billing_credit_revenue_allocation_runs from public,anon,authenticated;
grant select,insert on executive_visuals.billing_credit_revenue_sources to service_role;
grant select,insert on executive_visuals.billing_credit_revenue_allocations to service_role;
grant select,insert on executive_visuals.billing_credit_revenue_allocation_runs to service_role;

create or replace function executive_visuals.register_generation_credit_revenue_source(
  p_owner_id uuid,
  p_grant_ledger_id uuid,
  p_source_type text,
  p_source_reference_id uuid,
  p_allocatable_revenue_minor bigint,
  p_currency text,
  p_evidence jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $register_generation_credit_revenue_source$
declare
  grant_row executive_visuals.billing_credit_ledger%rowtype;
  payment_row executive_visuals.payment_transactions%rowtype;
  old_grant executive_visuals.credit_ledger%rowtype;
  existing executive_visuals.billing_credit_revenue_sources%rowtype;
  v_status text;
  v_revenue bigint;
  v_currency text;
begin
  if p_owner_id is null or p_grant_ledger_id is null or p_source_type is null
     or p_source_type not in('paid_credit_pack','subscription_allowance','promotional','admin_compensation')
     or p_evidence is null or jsonb_typeof(p_evidence)<>'object' then
    raise exception 'CREDIT_REVENUE_SOURCE_ARGUMENTS_INVALID' using errcode='22023';
  end if;
  select * into grant_row from billing_credit_ledger
   where id=p_grant_ledger_id and owner_id=p_owner_id and event_type='grant';
  if not found or grant_row.amount<=0 then
    raise exception 'CREDIT_REVENUE_SOURCE_GRANT_NOT_FOUND' using errcode='23503';
  end if;

  if p_source_type in('paid_credit_pack','subscription_allowance') then
    if p_source_reference_id is null then
      raise exception 'CREDIT_REVENUE_PAYMENT_REFERENCE_REQUIRED' using errcode='22023';
    end if;
    select * into payment_row from payment_transactions
     where id=p_source_reference_id and owner_id=p_owner_id
       and status='successful' and verified_at is not null;
    if not found then
      raise exception 'CREDIT_REVENUE_PAYMENT_NOT_VERIFIED' using errcode='23514';
    end if;
    select * into old_grant from credit_ledger
     where owner_id=p_owner_id and payment_transaction_id=payment_row.id
       and entry_type='purchase_grant' and credit_delta=grant_row.amount
     order by created_at desc limit 1;
    if not found then
      raise exception 'CREDIT_REVENUE_PAYMENT_CREDIT_GRANT_MISMATCH' using errcode='23514';
    end if;
    v_currency:=payment_row.currency;
    if p_currency is distinct from v_currency then
      raise exception 'CREDIT_REVENUE_SOURCE_CURRENCY_MISMATCH' using errcode='23514';
    end if;

    if p_source_type='paid_credit_pack' then
      if payment_row.metadata->>'payment_purpose'<>'credit_pack_purchase'
         or coalesce((payment_row.metadata->>'credit_pack_applied')::boolean,false) is not true
         or p_allocatable_revenue_minor is distinct from payment_row.amount_minor then
        raise exception 'CREDIT_REVENUE_CREDIT_PACK_EVIDENCE_INVALID' using errcode='23514';
      end if;
      v_revenue:=payment_row.amount_minor;
      v_status:='verified';
    else
      if payment_row.metadata->>'payment_purpose' not in('subscription_purchase','subscription_renewal')
         or coalesce((payment_row.metadata->>'subscription_applied')::boolean,false) is not true
         or p_allocatable_revenue_minor is not null then
        raise exception 'CREDIT_REVENUE_SUBSCRIPTION_SPLIT_REQUIRED' using errcode='23514';
      end if;
      v_revenue:=null;
      v_status:='pending_subscription_split';
    end if;
  else
    if p_source_reference_id is not null or p_allocatable_revenue_minor is distinct from 0
       or p_currency is not null then
      raise exception 'CREDIT_REVENUE_NON_REVENUE_SOURCE_INVALID' using errcode='22023';
    end if;
    v_currency:=null;
    v_revenue:=0;
    v_status:='non_revenue';
  end if;

  select * into existing from billing_credit_revenue_sources where grant_ledger_id=grant_row.id;
  if found then
    if existing.owner_id<>p_owner_id or existing.source_type<>p_source_type
       or existing.source_reference_id is distinct from p_source_reference_id
       or existing.credits_granted<>grant_row.amount
       or existing.allocatable_revenue_minor is distinct from v_revenue
       or existing.currency is distinct from v_currency
       or existing.revenue_status<>v_status then
      raise exception 'CREDIT_REVENUE_SOURCE_IDEMPOTENCY_CONFLICT' using errcode='23505';
    end if;
    return jsonb_build_object('sourceId',existing.id,'creditsGranted',existing.credits_granted,'replayed',true,'revenueStatus',existing.revenue_status);
  end if;

  insert into billing_credit_revenue_sources(
    owner_id,grant_ledger_id,source_type,source_reference_id,credits_granted,
    allocatable_revenue_minor,currency,revenue_status,evidence
  ) values(
    p_owner_id,grant_row.id,p_source_type,p_source_reference_id,grant_row.amount,
    v_revenue,v_currency,v_status,p_evidence
  ) returning * into existing;
  return jsonb_build_object('sourceId',existing.id,'creditsGranted',existing.credits_granted,'replayed',false,'revenueStatus',existing.revenue_status);
end;
$register_generation_credit_revenue_source$;

revoke all on function executive_visuals.register_generation_credit_revenue_source(uuid,uuid,text,uuid,bigint,text,jsonb)
  from public,anon,authenticated;
grant execute on function executive_visuals.register_generation_credit_revenue_source(uuid,uuid,text,uuid,bigint,text,jsonb)
  to service_role;

-- Mirror only verified payment-backed legacy grants into the generation wallet.
-- This trigger keeps checkout/webhook implementations independent of wallet internals.
create or replace function executive_visuals.sync_verified_payment_credit_grant_to_generation_wallet()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $sync_verified_payment_credit_grant_to_generation_wallet$
declare
  payment_row executive_visuals.payment_transactions%rowtype;
  wallet_grant_id uuid;
  source_kind text;
  source_revenue bigint;
  source_currency text;
  source_evidence jsonb;
begin
  if new.entry_type<>'purchase_grant' or new.payment_transaction_id is null then
    return new;
  end if;

  select * into payment_row from payment_transactions
   where id=new.payment_transaction_id and owner_id=new.owner_id
     and status='successful' and verified_at is not null;
  if not found then return new; end if;

  if payment_row.metadata->>'payment_purpose'='credit_pack_purchase'
     and coalesce((payment_row.metadata->>'credit_pack_applied')::boolean,false) then
    source_kind:='paid_credit_pack';
    source_revenue:=payment_row.amount_minor;
    source_currency:=payment_row.currency;
  elsif payment_row.metadata->>'payment_purpose' in('subscription_purchase','subscription_renewal')
     and coalesce((payment_row.metadata->>'subscription_applied')::boolean,false) then
    source_kind:='subscription_allowance';
    source_revenue:=null;
    source_currency:=payment_row.currency;
  else
    return new;
  end if;

  source_evidence:=jsonb_build_object(
    'sourceType',source_kind,
    'paymentTransactionId',payment_row.id,
    'legacyCreditLedgerId',new.id,
    'provider',payment_row.provider,
    'verifiedAt',payment_row.verified_at
  );
  select ledger_id into wallet_grant_id
    from grant_generation_credits(
      new.owner_id,new.credit_delta,'payment-credit-ledger:'||new.id::text,
      new.reason,source_evidence
    );
  perform register_generation_credit_revenue_source(
    new.owner_id,wallet_grant_id,source_kind,payment_row.id,
    source_revenue,source_currency,source_evidence
  );
  return new;
end;
$sync_verified_payment_credit_grant_to_generation_wallet$;
revoke all on function executive_visuals.sync_verified_payment_credit_grant_to_generation_wallet()
  from public,anon,authenticated;
grant execute on function executive_visuals.sync_verified_payment_credit_grant_to_generation_wallet()
  to service_role;
drop trigger if exists ev_sync_verified_payment_credit_grant on executive_visuals.credit_ledger;
create trigger ev_sync_verified_payment_credit_grant
after insert on executive_visuals.credit_ledger
for each row execute function executive_visuals.sync_verified_payment_credit_grant_to_generation_wallet();

create or replace function executive_visuals.allocate_generation_credit_revenue_for_reservation(p_reservation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $allocate_generation_credit_revenue_for_reservation$
declare
  reservation_row executive_visuals.billing_credit_reservations%rowtype;
  source_row executive_visuals.billing_credit_revenue_sources%rowtype;
  existing_run executive_visuals.billing_credit_revenue_allocation_runs%rowtype;
  v_remaining bigint;
  v_available bigint;
  v_take bigint;
  v_prior_credits bigint;
  v_prior_revenue bigint;
  v_revenue bigint;
  v_allocated bigint:=0;
  v_unattributed bigint:=0;
  v_pending bigint:=0;
  v_status text;
  v_balance bigint;
begin
  select * into reservation_row from billing_credit_reservations
   where id=p_reservation_id and state='settled';
  if not found or reservation_row.actual_credits is null then
    raise exception 'CREDIT_REVENUE_RESERVATION_NOT_SETTLED' using errcode='23514';
  end if;
  perform 1 from billing_credit_accounts where owner_id=reservation_row.owner_id for update;
  select * into reservation_row from billing_credit_reservations
   where id=p_reservation_id and state='settled' for update;
  if not found then raise exception 'CREDIT_REVENUE_RESERVATION_NOT_SETTLED' using errcode='23514'; end if;
  select * into existing_run from billing_credit_revenue_allocation_runs where reservation_id=p_reservation_id;
  if found then
    return jsonb_build_object('reservationId',p_reservation_id,'status',existing_run.status,
      'allocatedCredits',existing_run.allocated_credits,'unattributedCredits',existing_run.unattributed_credits,
      'pendingSplitCredits',existing_run.pending_split_credits,'replayed',true);
  end if;

  v_remaining:=reservation_row.actual_credits;
  for source_row in
    select s.* from billing_credit_revenue_sources s
     where s.owner_id=reservation_row.owner_id
       and s.credits_granted>coalesce((
         select sum(a.credits_consumed) from billing_credit_revenue_allocations a where a.source_id=s.id
       ),0)
     order by s.created_at,s.id
     for update
  loop
    exit when v_remaining=0;
    select coalesce(sum(a.credits_consumed),0)::bigint,
           coalesce(sum(a.revenue_minor),0)::bigint
      into v_prior_credits,v_prior_revenue
      from billing_credit_revenue_allocations a where a.source_id=source_row.id;
    v_available:=source_row.credits_granted-v_prior_credits;
    v_take:=least(v_remaining,v_available);
    if v_take<=0 then continue; end if;

    if source_row.revenue_status='verified' then
      v_revenue:=floor(
        source_row.allocatable_revenue_minor::numeric*(v_prior_credits+v_take)::numeric
        /source_row.credits_granted::numeric
      )::bigint-v_prior_revenue;
      insert into billing_credit_revenue_allocations(
        owner_id,reservation_id,job_id,source_id,credits_consumed,revenue_minor,currency,allocation_status,idempotency_key
      ) values(
        reservation_row.owner_id,p_reservation_id,reservation_row.job_id,source_row.id,v_take,v_revenue,
        source_row.currency,'verified','credit-revenue:'||p_reservation_id::text||':'||source_row.id::text
      );
    elsif source_row.revenue_status='pending_subscription_split' then
      v_pending:=v_pending+v_take;
      insert into billing_credit_revenue_allocations(
        owner_id,reservation_id,job_id,source_id,credits_consumed,revenue_minor,currency,allocation_status,idempotency_key
      ) values(
        reservation_row.owner_id,p_reservation_id,reservation_row.job_id,source_row.id,v_take,null,
        source_row.currency,'pending_subscription_split','credit-revenue:'||p_reservation_id::text||':'||source_row.id::text
      );
    else
      insert into billing_credit_revenue_allocations(
        owner_id,reservation_id,job_id,source_id,credits_consumed,revenue_minor,currency,allocation_status,idempotency_key
      ) values(
        reservation_row.owner_id,p_reservation_id,reservation_row.job_id,source_row.id,v_take,0,
        null,'non_revenue','credit-revenue:'||p_reservation_id::text||':'||source_row.id::text
      );
    end if;
    v_allocated:=v_allocated+v_take;
    v_remaining:=v_remaining-v_take;
  end loop;

  if v_remaining>0 then
    v_unattributed:=v_remaining;
    insert into billing_credit_revenue_allocations(
      owner_id,reservation_id,job_id,source_id,credits_consumed,revenue_minor,currency,allocation_status,idempotency_key
    ) values(
      reservation_row.owner_id,p_reservation_id,reservation_row.job_id,null,v_remaining,null,null,
      'unattributed','credit-revenue:'||p_reservation_id::text||':unattributed'
    );
  end if;

  v_status:=case
    when reservation_row.actual_credits=0 then 'no_usage'
    when v_unattributed>0 then 'partial_unattributed'
    when v_pending>0 then 'pending_subscription_split'
    else 'complete'
  end;
  insert into billing_credit_revenue_allocation_runs(
    reservation_id,owner_id,job_id,actual_credits,allocated_credits,unattributed_credits,pending_split_credits,status
  ) values(
    p_reservation_id,reservation_row.owner_id,reservation_row.job_id,reservation_row.actual_credits,
    v_allocated,v_unattributed,v_pending,v_status
  );
  return jsonb_build_object('reservationId',p_reservation_id,'status',v_status,
    'allocatedCredits',v_allocated,'unattributedCredits',v_unattributed,
    'pendingSplitCredits',v_pending,'replayed',false);
end;
$allocate_generation_credit_revenue_for_reservation$;
revoke all on function executive_visuals.allocate_generation_credit_revenue_for_reservation(uuid)
  from public,anon,authenticated,service_role;

-- Wrap the existing evidence-gated settlement atomically. A failure in attribution
-- rolls back the credit settlement as well, preventing unaccounted successful jobs.
alter function executive_visuals.settle_generation_credit_reservation(uuid,bigint,jsonb)
  rename to settle_generation_credit_reservation_pre_revenue_batch71;
create or replace function executive_visuals.settle_generation_credit_reservation(
  p_reservation_id uuid,p_actual_credits bigint,p_evidence jsonb
) returns table(balance bigint,adjustment bigint,replayed boolean)
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $settle_generation_credit_reservation$
declare
  v_balance bigint;
  v_adjustment bigint;
  v_replayed boolean;
begin
  select r.balance,r.adjustment,r.replayed into v_balance,v_adjustment,v_replayed
    from settle_generation_credit_reservation_pre_revenue_batch71(p_reservation_id,p_actual_credits,p_evidence) r;
  perform allocate_generation_credit_revenue_for_reservation(p_reservation_id);
  return query select v_balance,v_adjustment,v_replayed;
end;
$settle_generation_credit_reservation$;
revoke all on function executive_visuals.settle_generation_credit_reservation(uuid,bigint,jsonb)
  from public,anon,authenticated;
grant execute on function executive_visuals.settle_generation_credit_reservation(uuid,bigint,jsonb)
  to service_role;

-- Expose a conservative, auditable revenue/cost view to the existing admin report.
create or replace function executive_visuals.get_verified_job_cost_coverage(
  p_actor_id uuid,p_period_month date,p_limit integer default 50
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals,auth
as $get_verified_job_cost_coverage$
declare
  v_rows jsonb:='[]'::jsonb;
  v_total integer:=0;
  v_revenue_complete boolean:=false;
  v_profitability_complete boolean:=false;
begin
  if p_actor_id is null or not exists(
    select 1 from platform_admins
     where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')
  ) then raise exception 'Financial administrator access required' using errcode='42501'; end if;
  if p_period_month is null or p_period_month<>date_trunc('month',p_period_month)::date
     or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Invalid job cost coverage period or limit' using errcode='22023';
  end if;

  with matched_imports as (
    select i.id from ai_provider_invoice_imports i
    join ai_provider_invoice_lines l on l.import_id=i.id
    join ai_provider_invoice_reconciliation_events r on r.invoice_import_id=i.id and r.invoice_line_id=l.id
    where i.reconciliation_status in('pending','matched')
    group by i.id,i.imported_line_count
    having count(r.id)=i.imported_line_count and count(*) filter(where r.match_status<>'matched')=0
  ), invoice_cost_currency as (
    select u.job_id,u.owner_id,e.currency,sum(e.expected_amount_minor)::numeric amount_minor,
      count(*)::integer line_count,count(*) filter(where e.expected_amount_minor<0)::integer negative_line_count
    from ai_provider_invoice_reconciliation_events e
    join matched_imports mi on mi.id=e.invoice_import_id
    join ai_usage_cost_events u on u.id=e.usage_event_id
    where e.match_status='matched' and u.period_month=p_period_month and u.job_id is not null
    group by u.job_id,u.owner_id,e.currency
  ), invoice_costs as (
    select job_id,owner_id,
      jsonb_agg(jsonb_build_object('currency',currency,'amountMinor',amount_minor,'matchedLineCount',line_count) order by currency) cost_by_currency,
      count(*)::integer currency_count,case when count(*)=1 then max(currency) end currency,
      case when count(*)=1 and sum(negative_line_count)=0 then max(amount_minor)::bigint end actual_provider_cost_minor,
      sum(line_count)::integer matched_invoice_line_count,sum(negative_line_count)::integer negative_invoice_line_count
    from invoice_cost_currency group by job_id,owner_id
  ), credit_usage as (
    select job_id,owner_id,sum(actual_credits)::bigint credits_debited,count(*)::integer settled_reservation_count
    from billing_credit_reservations
    where state='settled' and actual_credits is not null
      and settled_at>=p_period_month::timestamptz
      and settled_at<(p_period_month+interval '1 month')::timestamptz
      and job_id is not null group by job_id,owner_id
  ), revenue_currency as (
    select a.job_id,a.owner_id,a.currency,
      sum(a.revenue_minor)::bigint revenue_minor,
      count(*) filter(where a.allocation_status not in('verified','non_revenue') or a.revenue_minor is null)::integer incomplete_count,
      count(*)::integer allocation_count
    from billing_credit_revenue_allocations a
    join billing_credit_revenue_allocation_runs r on r.reservation_id=a.reservation_id
    where r.created_at>=p_period_month::timestamptz
      and r.created_at<(p_period_month+interval '1 month')::timestamptz
    group by a.job_id,a.owner_id,a.currency
  ), revenue_by_job as (
    select job_id,owner_id,
      jsonb_agg(jsonb_build_object('currency',currency,'revenueMinor',revenue_minor,'allocationCount',allocation_count) order by currency) revenue_by_currency,
      count(*) filter(where currency is not null)::integer currency_count,
      case when count(*) filter(where currency is not null)=1
        and sum(incomplete_count)=0
        then max(currency) end revenue_currency,
      case when count(*) filter(where currency is not null)=1
        and sum(incomplete_count)=0
        then max(revenue_minor) end recognized_revenue_minor,
      sum(incomplete_count)::integer incomplete_allocation_count
    from revenue_currency group by job_id,owner_id
  ), all_jobs as (
    select job_id,owner_id from invoice_costs
    union select job_id,owner_id from credit_usage
    union select job_id,owner_id from revenue_by_job
  ), report_rows as (
    select j.job_id,j.owner_id,c.currency,c.currency_count,c.cost_by_currency,c.actual_provider_cost_minor,
      coalesce(c.matched_invoice_line_count,0) matched_invoice_line_count,
      coalesce(c.negative_invoice_line_count,0) negative_invoice_line_count,
      coalesce(u.credits_debited,0) credits_debited,coalesce(u.settled_reservation_count,0) settled_reservation_count,
      r.revenue_currency,r.revenue_by_currency,r.recognized_revenue_minor,
      case when r.recognized_revenue_minor>0 and r.revenue_currency=c.currency
        and c.actual_provider_cost_minor is not null
        then round((r.recognized_revenue_minor-c.actual_provider_cost_minor)::numeric*100/r.recognized_revenue_minor,2)
        else null end gross_margin_pct,
      case when u.job_id is null then 'missing_settled_credit_usage'
        when r.job_id is null then 'missing_revenue_allocation'
        when r.incomplete_allocation_count>0 or r.recognized_revenue_minor is null then 'revenue_allocation_incomplete'
        when c.currency_count>1 then 'mixed_currency_cost_review'
        when c.actual_provider_cost_minor is null then 'missing_invoice_backed_actual_cost'
        when r.revenue_currency<>c.currency then 'currency_mismatch_review'
        else 'revenue_and_cost_evidence_available' end profitability_status,
      case when c.job_id is null then 'missing_invoice_backed_actual_cost'
        when c.negative_invoice_line_count>0 then 'negative_invoice_adjustment_review'
        when c.currency_count>1 then 'mixed_currency_cost_review'
        else 'cost_evidence_available' end evidence_status,
      count(*) over() total_jobs
    from all_jobs j
    left join invoice_costs c on c.job_id=j.job_id and c.owner_id=j.owner_id
    left join credit_usage u on u.job_id=j.job_id and u.owner_id=j.owner_id
    left join revenue_by_job r on r.job_id=j.job_id and r.owner_id=j.owner_id
  ), coverage as (
    select
      coalesce(bool_and(recognized_revenue_minor is not null and profitability_status not in(
        'missing_settled_credit_usage','missing_revenue_allocation','revenue_allocation_incomplete')),false) revenue_complete,
      coalesce(bool_and(recognized_revenue_minor is not null and actual_provider_cost_minor is not null
        and revenue_currency=currency and gross_margin_pct is not null),false) profitability_complete
    from report_rows
  )
  select coalesce(jsonb_agg(to_jsonb(p)-'total_jobs' order by p.actual_provider_cost_minor desc nulls last,p.job_id),'[]'::jsonb),
    coalesce(max(p.total_jobs),0),coverage.revenue_complete,coverage.profitability_complete
  into v_rows,v_total,v_revenue_complete,v_profitability_complete
  from (select * from report_rows order by actual_provider_cost_minor desc nulls last,job_id limit p_limit) p
  cross join coverage
  group by coverage.revenue_complete,coverage.profitability_complete;

  return jsonb_build_object(
    'periodMonth',p_period_month,'totalJobs',v_total,'returnedJobs',jsonb_array_length(v_rows),'rows',v_rows,
    'revenueAllocationAvailable',v_revenue_complete,'profitabilityAvailable',v_profitability_complete,
    'blockedReason',case when v_profitability_complete then null else 'verified_cost_or_revenue_allocation_incomplete' end,
    'accountingBasis','verified_payment_credit_grants_fifo_consumption_plus_matched_provider_invoice_lines',
    'limitations',jsonb_build_array(
      'Prepaid credit-pack revenue is allocated to generations in proportion to credits consumed, using integer minor-unit rounding across the lifetime of each grant.',
      'Subscription credit revenue remains pending until Finance records the credit component of the subscription price; the full subscription payment is never assumed to be generation revenue.',
      'Promotional and administrator-compensated credits carry zero cash revenue and are explicitly separated from paid credit sources.',
      'Legacy, project-pool or otherwise unlinked credits remain unattributed; they are never silently assigned to paid revenue.',
      'Gross margin excludes payment processing fees, refunds, chargebacks, tax, storage, rendering and other operating costs until those evidence sources are reconciled.'
    )
  );
end;
$get_verified_job_cost_coverage$;

