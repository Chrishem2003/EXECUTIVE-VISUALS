-- Batch 103: keep monthly AI-generation credits distinct from legacy timeline credits.
-- Allowances remain unpublished by default. Grants occur only after verified subscription activation/renewal.
alter table executive_visuals.subscription_plans
  add column if not exists included_generation_credits bigint not null default 0,
  add column if not exists generation_credit_allowance_published boolean not null default false;

alter table executive_visuals.subscription_plans
  drop constraint if exists subscription_plans_generation_credit_allowance_check;
alter table executive_visuals.subscription_plans
  add constraint subscription_plans_generation_credit_allowance_check
  check (included_generation_credits between 0 and 1000000000
    and (not generation_credit_allowance_published or included_generation_credits > 0));

alter table executive_visuals.customer_subscriptions
  add column if not exists included_generation_credits bigint not null default 0,
  add column if not exists scheduled_included_generation_credits bigint;

alter table executive_visuals.customer_subscriptions
  drop constraint if exists customer_subscriptions_generation_credits_check;
alter table executive_visuals.customer_subscriptions
  add constraint customer_subscriptions_generation_credits_check
  check (included_generation_credits between 0 and 1000000000
    and (scheduled_included_generation_credits is null
      or scheduled_included_generation_credits between 0 and 1000000000));

-- Copy the published generation allowance into the immutable subscription snapshot.
-- Legacy included_credits remains unchanged for existing timeline/render credit workflows.
create or replace function executive_visuals.sync_subscription_generation_credit_snapshot()
returns trigger
language plpgsql
set search_path = pg_catalog, executive_visuals
as $sync_subscription_generation_credit_snapshot$
declare
  plan_row executive_visuals.subscription_plans%rowtype;
begin
  select * into plan_row
    from executive_visuals.subscription_plans p
   where p.id = new.plan_id
     and p.plan_code = new.plan_code
     and p.version = new.plan_version;
  if not found then
    raise exception 'SUBSCRIPTION_GENERATION_CREDIT_PLAN_SNAPSHOT_MISMATCH';
  end if;
  new.included_generation_credits :=
    case when plan_row.generation_credit_allowance_published
      then plan_row.included_generation_credits else 0 end;
  return new;
end;
$sync_subscription_generation_credit_snapshot$;

revoke all on function executive_visuals.sync_subscription_generation_credit_snapshot()
  from public, anon, authenticated, service_role;
drop trigger if exists ev_subscription_generation_credit_snapshot on executive_visuals.customer_subscriptions;
create trigger ev_subscription_generation_credit_snapshot
before insert or update of plan_id, plan_code, plan_version
on executive_visuals.customer_subscriptions
for each row execute function executive_visuals.sync_subscription_generation_credit_snapshot();

-- Scheduled plan changes carry their future generation allowance, but do not grant it early.
create or replace function executive_visuals.sync_scheduled_subscription_generation_credit_snapshot()
returns trigger
language plpgsql
set search_path = pg_catalog, executive_visuals
as $sync_scheduled_subscription_generation_credit_snapshot$
declare
  plan_row executive_visuals.subscription_plans%rowtype;
begin
  if new.scheduled_plan_id is null then
    new.scheduled_included_generation_credits := null;
    return new;
  end if;
  select * into plan_row
    from executive_visuals.subscription_plans p
   where p.id = new.scheduled_plan_id
     and p.plan_code = new.scheduled_plan_code
     and p.version = new.scheduled_plan_version;
  if not found then
    raise exception 'SUBSCRIPTION_GENERATION_CREDIT_SCHEDULE_MISMATCH';
  end if;
  new.scheduled_included_generation_credits :=
    case when plan_row.generation_credit_allowance_published
      then plan_row.included_generation_credits else 0 end;
  return new;
end;
$sync_scheduled_subscription_generation_credit_snapshot$;

revoke all on function executive_visuals.sync_scheduled_subscription_generation_credit_snapshot()
  from public, anon, authenticated, service_role;
drop trigger if exists ev_scheduled_subscription_generation_credit_snapshot on executive_visuals.customer_subscriptions;
create trigger ev_scheduled_subscription_generation_credit_snapshot
before update of scheduled_plan_id
on executive_visuals.customer_subscriptions
for each row execute function executive_visuals.sync_scheduled_subscription_generation_credit_snapshot();

-- The same subscription transaction that activates a paid period grants its
-- generation allowance. A stable subscription+period idempotency key prevents duplicates.
create or replace function executive_visuals.grant_verified_subscription_generation_credits()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $grant_verified_subscription_generation_credits$
declare
  payment_row executive_visuals.payment_transactions%rowtype;
  grant_result record;
  grant_key text;
  grant_evidence jsonb;
begin
  if tg_op = 'UPDATE'
     and new.status is not distinct from old.status
     and new.current_period_start is not distinct from old.current_period_start
     and new.current_period_end is not distinct from old.current_period_end then
    return new;
  end if;
  if new.status <> 'active' or new.included_generation_credits <= 0
     or new.current_period_start is null or new.current_period_end is null then
    return new;
  end if;

  grant_key := 'subscription-generation:' || new.id::text || ':' ||
    to_char(new.current_period_start at time zone 'UTC','YYYYMMDDHH24MISSUS');

  if new.provider = 'flutterwave' then
    select * into payment_row
      from executive_visuals.payment_transactions p
     where p.owner_id = new.owner_id
       and p.status = 'successful'
       and p.provider_transaction_id is not null
       and p.verified_at is not null
       and p.metadata->>'subscription_id' = new.id::text
       and (
         (p.metadata->>'payment_purpose' = 'subscription_purchase'
           and coalesce((p.metadata->>'subscription_applied')::boolean,false))
         or
         (p.metadata->>'payment_purpose' = 'subscription_renewal'
           and coalesce((p.metadata->>'renewal_applied')::boolean,false))
       )
     order by p.verified_at desc, p.created_at desc
     limit 1;
    if payment_row.id is null then
      raise exception 'SUBSCRIPTION_GENERATION_CREDIT_PAYMENT_EVIDENCE_MISSING';
    end if;
    grant_evidence := jsonb_build_object(
      'evidenceType','verified_subscription_payment',
      'provider','flutterwave',
      'paymentId',payment_row.id,
      'providerTransactionId',payment_row.provider_transaction_id,
      'paymentPurpose',payment_row.metadata->>'payment_purpose',
      'subscriptionId',new.id,
      'planCode',new.plan_code,
      'planVersion',new.plan_version,
      'periodStart',new.current_period_start,
      'periodEnd',new.current_period_end,
      'verifiedAt',payment_row.verified_at
    );
  elsif new.granted_by is not null then
    grant_evidence := jsonb_build_object(
      'evidenceType','admin_granted_subscription',
      'provider','platform_admin',
      'actorId',new.granted_by,
      'grantReason',new.grant_reason,
      'subscriptionId',new.id,
      'planCode',new.plan_code,
      'planVersion',new.plan_version,
      'periodStart',new.current_period_start,
      'periodEnd',new.current_period_end
    );
  else
    raise exception 'SUBSCRIPTION_GENERATION_CREDIT_GRANT_EVIDENCE_MISSING';
  end if;

  select * into grant_result
    from executive_visuals.grant_generation_credits(
      new.owner_id,
      new.included_generation_credits,
      grant_key,
      'Included AI-generation credits for verified subscription period',
      grant_evidence
    );
  if grant_result.ledger_id is null then
    raise exception 'SUBSCRIPTION_GENERATION_CREDIT_GRANT_INVALID';
  end if;
  return new;
end;
$grant_verified_subscription_generation_credits$;

revoke all on function executive_visuals.grant_verified_subscription_generation_credits()
  from public, anon, authenticated;
drop trigger if exists ev_verified_subscription_generation_credit_grant on executive_visuals.customer_subscriptions;
create trigger ev_verified_subscription_generation_credit_grant
after insert or update of status, current_period_start, current_period_end
on executive_visuals.customer_subscriptions
for each row execute function executive_visuals.grant_verified_subscription_generation_credits();

comment on column executive_visuals.subscription_plans.included_generation_credits is
  'Monthly/yearly AI-generation wallet allowance; distinct from legacy included_credits.';
comment on column executive_visuals.subscription_plans.generation_credit_allowance_published is
  'Explicit finance/product approval gate. Unpublished allowances are never copied or granted.';
comment on column executive_visuals.customer_subscriptions.included_generation_credits is
  'Versioned AI-generation allowance snapshot for the current paid subscription period.';
