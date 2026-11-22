-- Batch 81: auditable, role-gated administrator credit adjustments.
-- Positive adjustments are non-revenue compensation grants. Negative adjustments
-- cannot consume credits already reserved for in-flight generation work.
create table if not exists executive_visuals.billing_credit_admin_adjustments (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete restrict,
  owner_id uuid not null references executive_visuals.billing_credit_accounts(owner_id) on delete restrict,
  ledger_id uuid not null unique references executive_visuals.billing_credit_ledger(id) on delete restrict,
  delta_credits bigint not null check(delta_credits between -1000000000 and 1000000000 and delta_credits<>0),
  balance_after bigint not null,
  idempotency_key text not null unique check(char_length(idempotency_key) between 8 and 180),
  reason text not null check(char_length(reason) between 8 and 500),
  evidence jsonb not null default '{}'::jsonb check(jsonb_typeof(evidence)='object'),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists billing_credit_admin_adjustments_owner_created_idx
  on executive_visuals.billing_credit_admin_adjustments(owner_id,created_at desc);
create index if not exists billing_credit_admin_adjustments_actor_created_idx
  on executive_visuals.billing_credit_admin_adjustments(actor_id,created_at desc);
alter table executive_visuals.billing_credit_admin_adjustments enable row level security;
revoke all on executive_visuals.billing_credit_admin_adjustments from public,anon,authenticated,service_role;

create or replace function executive_visuals.apply_admin_credit_adjustment(
  p_actor_id uuid,
  p_owner_id uuid,
  p_delta_credits bigint,
  p_idempotency_key text,
  p_reason text,
  p_evidence jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $apply_admin_credit_adjustment$
declare
  existing executive_visuals.billing_credit_admin_adjustments%rowtype;
  account_status text;
  v_adjustment_id uuid:=gen_random_uuid();
  v_ledger_id uuid;
  v_balance bigint;
  v_evidence jsonb;
  v_ledger_key text;
begin
  if p_actor_id is null or p_owner_id is null
     or p_delta_credits is null or p_delta_credits=0
     or p_delta_credits not between -1000000000 and 1000000000
     or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,180}$'
     or p_reason is null or char_length(btrim(p_reason)) not between 8 and 500
     or p_evidence is null or jsonb_typeof(p_evidence) is distinct from 'object'
     or octet_length(p_evidence::text)>8000 then
    raise exception 'ADMIN_CREDIT_ADJUSTMENT_ARGUMENTS_INVALID' using errcode='22023';
  end if;

  if not exists(select 1 from executive_visuals.platform_admins a
    where a.user_id=p_actor_id and a.role in('owner','platform_admin','billing_admin')) then
    raise exception 'FINANCIAL_ADMIN_REQUIRED' using errcode='42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('admin-credit-adjustment:'||p_idempotency_key,0));

  -- Expire due subscription allowance before a debit, unless active reservations
  -- cause the expiry function to defer the owner safely.
  perform executive_visuals.expire_due_subscription_credits(p_owner_id,clock_timestamp());

  insert into executive_visuals.billing_credit_accounts(owner_id)
    values(p_owner_id) on conflict(owner_id) do nothing;
  select a.status into account_status from executive_visuals.billing_credit_accounts a
   where a.owner_id=p_owner_id for update;
  if account_status is distinct from 'active' then
    raise exception 'BILLING_ACCOUNT_NOT_ACTIVE' using errcode='23514';
  end if;

  select * into existing from executive_visuals.billing_credit_admin_adjustments
   where idempotency_key=p_idempotency_key for update;
  if found then
    if existing.actor_id is distinct from p_actor_id
       or existing.owner_id is distinct from p_owner_id
       or existing.delta_credits is distinct from p_delta_credits
       or existing.reason is distinct from btrim(p_reason)
       or existing.evidence is distinct from p_evidence then
      raise exception 'ADMIN_CREDIT_ADJUSTMENT_IDEMPOTENCY_CONFLICT' using errcode='23505';
    end if;
    select coalesce(sum(l.amount),0)::bigint into v_balance
      from executive_visuals.billing_credit_ledger l where l.owner_id=p_owner_id;
    return jsonb_build_object('adjustmentId',existing.id,'ledgerId',existing.ledger_id,
      'ownerId',p_owner_id,'deltaCredits',existing.delta_credits,
      'balanceAfter',existing.balance_after,'currentBalance',v_balance,
      'idempotentReplay',true);
  end if;

  select coalesce(sum(l.amount),0)::bigint into v_balance
    from executive_visuals.billing_credit_ledger l where l.owner_id=p_owner_id;
  -- Active generation reservations already have negative ledger entries, so
  -- the ledger sum is the spendable balance. Do not subtract reservation rows twice.
  if p_delta_credits<0 and v_balance < abs(p_delta_credits) then
    raise exception 'ADMIN_CREDIT_ADJUSTMENT_EXCEEDS_AVAILABLE_BALANCE' using errcode='23514',
      detail=jsonb_build_object('availableCredits',greatest(0,v_balance),
        'requestedDebit',abs(p_delta_credits))::text;
  end if;

  v_evidence:=p_evidence||jsonb_build_object(
    'adminAdjustmentId',v_adjustment_id,'actorId',p_actor_id,
    'sourceType',case when p_delta_credits>0 then 'admin_compensation' else 'admin_debit' end,
    'reason',btrim(p_reason),'batch','81'
  );
  v_ledger_key:='admin-credit-adjustment:'||p_idempotency_key;

  if p_delta_credits>0 then
    -- A normal grant row allows Batch 71's trigger to register this as
    -- zero-cash admin compensation, never as paid credit revenue.
    insert into executive_visuals.billing_credit_ledger(
      owner_id,amount,event_type,reference_id,idempotency_key,description,evidence
    ) values(p_owner_id,p_delta_credits,'grant',v_adjustment_id,v_ledger_key,
      left('Administrator compensation: '||btrim(p_reason),500),v_evidence)
    returning id into v_ledger_id;
  else
    insert into executive_visuals.billing_credit_ledger(
      owner_id,amount,event_type,reference_id,idempotency_key,description,evidence
    ) values(p_owner_id,p_delta_credits,'admin_adjustment',v_adjustment_id,v_ledger_key,
      left('Administrator credit debit: '||btrim(p_reason),500),v_evidence)
    returning id into v_ledger_id;
  end if;

  select coalesce(sum(l.amount),0)::bigint into v_balance
    from executive_visuals.billing_credit_ledger l where l.owner_id=p_owner_id;
  insert into executive_visuals.billing_credit_admin_adjustments(
    id,actor_id,owner_id,ledger_id,delta_credits,balance_after,idempotency_key,reason,evidence
  ) values(v_adjustment_id,p_actor_id,p_owner_id,v_ledger_id,p_delta_credits,v_balance,
    p_idempotency_key,btrim(p_reason),v_evidence);
  update executive_visuals.billing_credit_accounts set updated_at=clock_timestamp()
   where owner_id=p_owner_id;

  return jsonb_build_object('adjustmentId',v_adjustment_id,'ledgerId',v_ledger_id,
    'ownerId',p_owner_id,'deltaCredits',p_delta_credits,
    'balanceAfter',v_balance,'currentBalance',v_balance,'idempotentReplay',false);
end;
$apply_admin_credit_adjustment$;
revoke all on function executive_visuals.apply_admin_credit_adjustment(uuid,uuid,bigint,text,text,jsonb)
  from public,anon,authenticated;
grant execute on function executive_visuals.apply_admin_credit_adjustment(uuid,uuid,bigint,text,text,jsonb)
  to service_role;

create or replace function executive_visuals.list_admin_credit_adjustments(
  p_actor_id uuid,
  p_owner_id uuid default null,
  p_limit integer default 50
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $list_admin_credit_adjustments$
declare
  v_result jsonb;
begin
  if p_actor_id is null or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'ADMIN_CREDIT_ADJUSTMENT_LIST_ARGUMENTS_INVALID' using errcode='22023';
  end if;
  if not exists(select 1 from executive_visuals.platform_admins a
    where a.user_id=p_actor_id and a.role in('owner','platform_admin','billing_admin')) then
    raise exception 'FINANCIAL_ADMIN_REQUIRED' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc),'[]'::jsonb)
    into v_result
    from (
      select id,actor_id,owner_id,ledger_id,delta_credits,balance_after,
        idempotency_key,reason,evidence,created_at
      from executive_visuals.billing_credit_admin_adjustments
      where p_owner_id is null or owner_id=p_owner_id
      order by created_at desc limit p_limit
    ) q;
  return v_result;
end;
$list_admin_credit_adjustments$;
revoke all on function executive_visuals.list_admin_credit_adjustments(uuid,uuid,integer)
  from public,anon,authenticated;
grant execute on function executive_visuals.list_admin_credit_adjustments(uuid,uuid,integer)
  to service_role;

comment on table executive_visuals.billing_credit_admin_adjustments
  is 'Append-only administrator credit adjustment audit trail; positive adjustments are non-revenue compensation and debits cannot consume reserved credits.';
