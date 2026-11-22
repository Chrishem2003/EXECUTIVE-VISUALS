-- Batch 78: customer wallet visibility and subscription allowance expiry.
-- Purchased credit packs never expire here. Subscription allowances expire at
-- their verified billing period end. Active reservations defer expiry until
-- settlement/release so in-flight work cannot lose its reserved credits.

alter table executive_visuals.billing_credit_revenue_sources
  add column if not exists expires_at timestamptz;

create index if not exists billing_credit_revenue_sources_expiry_idx
  on executive_visuals.billing_credit_revenue_sources(owner_id,expires_at,id)
  where expires_at is not null;

create or replace function executive_visuals.try_parse_credit_period_end(p_value text)
returns timestamptz
language plpgsql
immutable
set search_path=pg_catalog
as $try_parse_credit_period_end$
begin
  if p_value is null or btrim(p_value)='' then return null; end if;
  return p_value::timestamptz;
exception when others then
  return null;
end;
$try_parse_credit_period_end$;
revoke all on function executive_visuals.try_parse_credit_period_end(text)
  from public,anon,authenticated,service_role;

create or replace function executive_visuals.set_generation_credit_source_expiry()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $set_generation_credit_source_expiry$
declare
  legacy_grant_id uuid;
  period_end timestamptz;
begin
  if new.source_type<>'subscription_allowance' then
    new.expires_at:=null;
    return new;
  end if;

  begin
    legacy_grant_id:=nullif(new.evidence->>'legacyCreditLedgerId','')::uuid;
  exception when invalid_text_representation then
    raise exception 'CREDIT_SOURCE_LEGACY_GRANT_REFERENCE_INVALID' using errcode='22023';
  end;

  if legacy_grant_id is not null then
    select executive_visuals.try_parse_credit_period_end(metadata->>'period_end')
      into period_end
      from executive_visuals.credit_ledger
     where id=legacy_grant_id and owner_id=new.owner_id
       and entry_type='purchase_grant';
  end if;
  if period_end is null and new.source_reference_id is not null then
    -- Batch 71's wallet-source trigger may register the source before the
    -- payment-ledger mirror supplies its richer evidence. Resolve the exact
    -- legacy grant through the verified payment reference, never by guessing.
    select nullif(metadata->>'period_end','')::timestamptz
      into period_end
      from executive_visuals.credit_ledger
     where owner_id=new.owner_id
       and payment_transaction_id=new.source_reference_id
       and entry_type='purchase_grant'
     order by created_at desc
     limit 1;
  end if;

  -- Older subscription grants without a recorded period end are deliberately
  -- non-expiring until their provenance is reconciled; never guess a date.
  new.expires_at:=period_end;
  return new;
end;
$set_generation_credit_source_expiry$;
revoke all on function executive_visuals.set_generation_credit_source_expiry()
  from public,anon,authenticated,service_role;
drop trigger if exists ev_set_generation_credit_source_expiry
  on executive_visuals.billing_credit_revenue_sources;
create trigger ev_set_generation_credit_source_expiry
  before insert on executive_visuals.billing_credit_revenue_sources
  for each row execute function executive_visuals.set_generation_credit_source_expiry();

-- Deterministic metadata-only backfill for already mirrored subscription
-- allowances. No wallet ledger balance or customer credit amount is changed.
update executive_visuals.billing_credit_revenue_sources s
   set expires_at=(
     select nullif(l.metadata->>'period_end','')::timestamptz
       from executive_visuals.credit_ledger l
      where l.owner_id=s.owner_id
        and l.payment_transaction_id=s.source_reference_id
        and l.entry_type='purchase_grant'
      order by l.created_at desc
      limit 1
   )
 where s.source_type='subscription_allowance'
   and s.expires_at is null
   and s.source_reference_id is not null
   and exists(
     select 1 from executive_visuals.credit_ledger l
      where l.owner_id=s.owner_id
        and l.payment_transaction_id=s.source_reference_id
        and l.entry_type='purchase_grant'
        and executive_visuals.try_parse_credit_period_end(l.metadata->>'period_end') is not null
   );

create table if not exists executive_visuals.billing_credit_source_expirations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references executive_visuals.billing_credit_accounts(owner_id) on delete restrict,
  source_id uuid not null unique references executive_visuals.billing_credit_revenue_sources(id) on delete restrict,
  expiration_ledger_id uuid unique references executive_visuals.billing_credit_ledger(id) on delete restrict,
  credits_expired bigint not null check(credits_expired>=0),
  expires_at timestamptz not null,
  expired_at timestamptz not null,
  evidence jsonb not null default '{}'::jsonb check(jsonb_typeof(evidence)='object'),
  check((credits_expired=0 and expiration_ledger_id is null) or (credits_expired>0 and expiration_ledger_id is not null))
);
alter table executive_visuals.billing_credit_source_expirations enable row level security;
revoke all on executive_visuals.billing_credit_source_expirations from public,anon,authenticated,service_role;
grant select on executive_visuals.billing_credit_source_expirations to service_role;

create or replace function executive_visuals.expire_due_subscription_credits(
  p_owner_id uuid default null,
  p_now timestamptz default clock_timestamp()
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $expire_due_subscription_credits$
declare
  account_row record;
  source_row executive_visuals.billing_credit_revenue_sources%rowtype;
  v_consumed bigint;
  v_remaining bigint;
  v_ledger_id uuid;
  v_expired bigint:=0;
  v_sources bigint:=0;
  v_deferred bigint:=0;
begin
  if p_now is null then
    raise exception 'CREDIT_EXPIRY_TIMESTAMP_REQUIRED' using errcode='22023';
  end if;

  for account_row in
    select a.owner_id from executive_visuals.billing_credit_accounts a
     where (p_owner_id is null or a.owner_id=p_owner_id)
     order by a.owner_id
     for update
  loop
    -- Without per-lot reservation mapping, defer all expiry for this owner
    -- while any generation reservation is open. This is conservative and safe.
    if exists(select 1 from executive_visuals.billing_credit_reservations r
      where r.owner_id=account_row.owner_id and r.state='reserved') then
      v_deferred:=v_deferred+1;
      continue;
    end if;

    for source_row in
      select s.* from executive_visuals.billing_credit_revenue_sources s
       where s.owner_id=account_row.owner_id
         and s.source_type='subscription_allowance'
         and s.expires_at is not null and s.expires_at<=p_now
         and not exists(select 1 from executive_visuals.billing_credit_source_expirations e where e.source_id=s.id)
       order by s.expires_at,s.created_at,s.id
       for update
    loop
      select coalesce(sum(a.credits_consumed),0)::bigint
        into v_consumed
        from executive_visuals.billing_credit_revenue_allocations a
       where a.source_id=source_row.id;
      v_remaining:=greatest(0,source_row.credits_granted-v_consumed);
      v_ledger_id:=null;

      if v_remaining>0 then
        insert into executive_visuals.billing_credit_ledger(
          owner_id,amount,event_type,reference_id,idempotency_key,description,evidence
        ) values(
          source_row.owner_id,-v_remaining,'expiry',source_row.grant_ledger_id,
          'credit-expiry:'||source_row.id::text,
          'Unused subscription allowance expired at billing-period end',
          jsonb_build_object('sourceId',source_row.id,'grantLedgerId',source_row.grant_ledger_id,
            'expiresAt',source_row.expires_at,'expiredAt',p_now,'creditsExpired',v_remaining)
        ) returning id into v_ledger_id;
        v_expired:=v_expired+v_remaining;
      end if;

      insert into executive_visuals.billing_credit_source_expirations(
        owner_id,source_id,expiration_ledger_id,credits_expired,expires_at,expired_at,evidence
      ) values(
        source_row.owner_id,source_row.id,v_ledger_id,v_remaining,source_row.expires_at,p_now,
        jsonb_build_object('method','source_remaining_after_verified_consumption',
          'creditsGranted',source_row.credits_granted,'creditsConsumed',v_consumed)
      );
      v_sources:=v_sources+1;
    end loop;
  end loop;

  return jsonb_build_object('sourcesExpired',v_sources,'creditsExpired',v_expired,
    'accountsDeferredForOpenReservations',v_deferred,'asOf',p_now);
end;
$expire_due_subscription_credits$;
revoke all on function executive_visuals.expire_due_subscription_credits(uuid,timestamptz)
  from public,anon,authenticated;
grant execute on function executive_visuals.expire_due_subscription_credits(uuid,timestamptz)
  to service_role;

-- Run expiry before every new reservation. The old atomic reservation RPC still
-- owns balance locking, idempotency and job-owner checks.
alter function executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text)
  rename to reserve_generation_credits_pre_batch78;
create or replace function executive_visuals.reserve_generation_credits(
  p_owner_id uuid,p_job_id uuid,p_credits bigint,p_idempotency_key text
) returns table(reservation_id uuid,balance bigint,replayed boolean)
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $reserve_generation_credits$
begin
  perform executive_visuals.expire_due_subscription_credits(p_owner_id,clock_timestamp());
  -- If expiry was deferred because another job is still open, block additional
  -- reservations rather than letting stale subscription credits be spent.
  if exists(
    select 1 from executive_visuals.billing_credit_reservations r
     where r.owner_id=p_owner_id and r.state='reserved'
  ) and exists(
    select 1 from executive_visuals.billing_credit_revenue_sources s
     where s.owner_id=p_owner_id and s.source_type='subscription_allowance'
       and s.expires_at is not null and s.expires_at<=clock_timestamp()
       and not exists(select 1 from executive_visuals.billing_credit_source_expirations e where e.source_id=s.id)
  ) then
    raise exception 'BILLING_CREDIT_EXPIRY_DEFERRED_OPEN_RESERVATION' using errcode='55000';
  end if;
  return query
    select * from executive_visuals.reserve_generation_credits_pre_batch78(
      p_owner_id,p_job_id,p_credits,p_idempotency_key
    );
end;
$reserve_generation_credits$;
revoke all on function executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text)
  from public,anon,authenticated;
grant execute on function executive_visuals.reserve_generation_credits(uuid,uuid,bigint,text)
  to service_role;

-- Expired source lots are excluded from subsequent FIFO revenue attribution.
-- Expiry is only processed when no open reservation exists for the account.
comment on column executive_visuals.billing_credit_revenue_sources.expires_at
  is 'Subscription allowance period end. Purchased packs and non-subscription grants do not expire.';
comment on table executive_visuals.billing_credit_source_expirations
  is 'Append-only evidence that the unconsumed remainder of a subscription allowance expired.';

create or replace function executive_visuals.get_customer_credit_wallet(p_owner_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $get_customer_credit_wallet$
declare
  v_wallet jsonb;
begin
  if p_owner_id is null then raise exception 'CREDIT_WALLET_OWNER_REQUIRED' using errcode='22023'; end if;
  perform executive_visuals.expire_due_subscription_credits(p_owner_id,clock_timestamp());

  select jsonb_build_object(
    'availableCredits',greatest(0,
      coalesce((select sum(l.amount) from billing_credit_ledger l where l.owner_id=p_owner_id),0)
      -coalesce((select sum(greatest(0,s.credits_granted-
        coalesce((select sum(a.credits_consumed) from billing_credit_revenue_allocations a where a.source_id=s.id),0)))
        from billing_credit_revenue_sources s
       where s.owner_id=p_owner_id and s.source_type='subscription_allowance'
         and s.expires_at is not null and s.expires_at<=clock_timestamp()
         and not exists(select 1 from billing_credit_source_expirations e where e.source_id=s.id)),0)
    ),
    'pendingExpiryCredits',coalesce((select sum(greatest(0,s.credits_granted-
      coalesce((select sum(a.credits_consumed) from billing_credit_revenue_allocations a where a.source_id=s.id),0)))
      from billing_credit_revenue_sources s where s.owner_id=p_owner_id
       and s.source_type='subscription_allowance' and s.expires_at is not null
       and s.expires_at<=clock_timestamp()
       and not exists(select 1 from billing_credit_source_expirations e where e.source_id=s.id)),0),
    'expiryDeferred',exists(select 1 from billing_credit_reservations r
      where r.owner_id=p_owner_id and r.state='reserved')
      and exists(select 1 from billing_credit_revenue_sources s
       where s.owner_id=p_owner_id and s.source_type='subscription_allowance'
         and s.expires_at is not null and s.expires_at<=clock_timestamp()
         and not exists(select 1 from billing_credit_source_expirations e where e.source_id=s.id)),
    'reservedCredits',coalesce((select sum(r.reserved_credits) from billing_credit_reservations r where r.owner_id=p_owner_id and r.state='reserved'),0),
    'consumedCredits',coalesce((select sum(r.actual_credits) from billing_credit_reservations r where r.owner_id=p_owner_id and r.state='settled'),0),
    'expiringWithinSevenDays',coalesce((select sum(s.credits_granted-
      coalesce((select sum(a.credits_consumed) from billing_credit_revenue_allocations a where a.source_id=s.id),0))
      from billing_credit_revenue_sources s where s.owner_id=p_owner_id
       and s.source_type='subscription_allowance' and s.expires_at>clock_timestamp()
       and s.expires_at<=clock_timestamp()+interval '7 days'
       and not exists(select 1 from billing_credit_source_expirations e where e.source_id=s.id)),0),
    'creditLots',coalesce((select jsonb_agg(jsonb_build_object(
      'sourceId',s.id,'sourceType',s.source_type,
      'creditsGranted',s.credits_granted,
      'creditsConsumed',coalesce((select sum(a.credits_consumed) from billing_credit_revenue_allocations a where a.source_id=s.id),0),
      'creditsRemaining',greatest(0,s.credits_granted-
        coalesce((select sum(a.credits_consumed) from billing_credit_revenue_allocations a where a.source_id=s.id),0)),
      'expiresAt',s.expires_at,'revenueStatus',s.revenue_status
    ) order by s.created_at,s.id) from billing_credit_revenue_sources s
      where s.owner_id=p_owner_id
        and not exists(select 1 from billing_credit_source_expirations e where e.source_id=s.id)
        and s.credits_granted>coalesce((select sum(a.credits_consumed) from billing_credit_revenue_allocations a where a.source_id=s.id),0)), '[]'::jsonb),
    'recentTransactions',coalesce((select jsonb_agg(jsonb_build_object(
      'id',l.id,'amount',l.amount,'eventType',l.event_type,'description',l.description,
      'createdAt',l.created_at,'evidence',l.evidence
    ) order by l.created_at desc) from (
      select * from billing_credit_ledger where owner_id=p_owner_id order by created_at desc limit 100
    ) l),'[]'::jsonb)
  ) into v_wallet;
  return v_wallet;
end;
$get_customer_credit_wallet$;
revoke all on function executive_visuals.get_customer_credit_wallet(uuid)
  from public,anon,authenticated;
grant execute on function executive_visuals.get_customer_credit_wallet(uuid) to service_role;
