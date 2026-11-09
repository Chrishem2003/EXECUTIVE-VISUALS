-- Atomic refund reservation and confirmed-refund credit settlement.
-- These RPCs are service-role only. They must never be callable from browser clients.

create or replace function executive_visuals.reserve_payment_refund(
  p_owner_id uuid,
  p_payment_transaction_id uuid,
  p_amount_minor bigint,
  p_currency text,
  p_reason text,
  p_idempotency_key text,
  p_requested_by uuid
) returns uuid
language plpgsql
security definer
set search_path = executive_visuals, pg_temp
as $$
declare
  payment_row executive_visuals.payment_transactions%rowtype;
  existing_row executive_visuals.payment_refunds%rowtype;
  reserved_minor bigint;
  refund_id uuid;
begin
  if p_owner_id is null or p_payment_transaction_id is null
     or p_amount_minor is null or p_amount_minor <= 0
     or p_currency is null or p_currency !~ '^[A-Z]{3}     or length(coalesce(p_reason,'')) not between 3 and 500
     or length(coalesce(p_idempotency_key,'')) not between 8 and 180 then
    raise exception 'Invalid refund reservation input' using errcode = '22023';
  end if;

  select * into existing_row
  from payment_refunds
  where owner_id = p_owner_id and idempotency_key = p_idempotency_key;
  if found then
    if existing_row.payment_transaction_id <> p_payment_transaction_id
       or existing_row.amount_minor <> p_amount_minor
       or existing_row.currency <> p_currency then
      raise exception 'Idempotency key conflict' using errcode = '23505';
    end if;
    return existing_row.id;
  end if;

  select * into payment_row
  from payment_transactions
  where id = p_payment_transaction_id and owner_id = p_owner_id
  for update;

  if not found or payment_row.status <> 'successful' then
    raise exception 'Payment is not refundable' using errcode = 'P0002';
  end if;

  -- Recheck the idempotency key after acquiring the payment row lock. This
  -- serializes concurrent requests using the same key and returns the original
  -- reservation instead of attempting a duplicate insert.
  select * into existing_row
  from payment_refunds
  where owner_id = p_owner_id and idempotency_key = p_idempotency_key;
  if found then
    if existing_row.payment_transaction_id <> p_payment_transaction_id
       or existing_row.amount_minor <> p_amount_minor
       or existing_row.currency <> p_currency then
      raise exception 'Idempotency key conflict' using errcode = '23505';
    end if;
    return existing_row.id;
  end if;

  if payment_row.currency <> p_currency then
    raise exception 'Refund currency mismatch' using errcode = '22023';
  end if;

  select coalesce(sum(amount_minor),0) into reserved_minor
  from payment_refunds
  where payment_transaction_id = p_payment_transaction_id
    and status in ('requested','processing','succeeded');

  if reserved_minor + p_amount_minor > payment_row.amount_minor then
    raise exception 'Refund exceeds remaining refundable amount' using errcode = '22023';
  end if;

  insert into payment_refunds(
    owner_id,payment_transaction_id,amount_minor,currency,status,
    reason,idempotency_key,requested_by
  ) values (
    p_owner_id,p_payment_transaction_id,p_amount_minor,p_currency,'requested',
    p_reason,p_idempotency_key,p_requested_by
  ) returning id into refund_id;

  return refund_id;
end;
$$;

create or replace function executive_visuals.finalize_payment_refund(
  p_refund_id uuid,
  p_provider_refund_id text,
  p_status text,
  p_provider_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = executive_visuals, pg_temp
as $$
declare
  refund_row executive_visuals.payment_refunds%rowtype;
  payment_row executive_visuals.payment_transactions%rowtype;
  original_credits bigint;
  confirmed_refund_minor bigint;
  reversed_credits bigint;
  target_reversed bigint;
  reversal_delta bigint;
begin
  if p_refund_id is null or p_status is null or p_status not in ('succeeded','failed')
     or jsonb_typeof(coalesce(p_provider_payload,'{}'::jsonb)) <> 'object' then
    raise exception 'Invalid refund finalization input' using errcode = '22023';
  end if;

  select * into refund_row from payment_refunds where id = p_refund_id for update;
  if not found then
    raise exception 'Refund not found' using errcode = 'P0002';
  end if;

  if refund_row.status = 'succeeded' then
    return jsonb_build_object('refundId',refund_row.id,'status','succeeded','creditReversalDelta',0,'idempotentReplay',true);
  end if;
  if refund_row.status = 'failed' and p_status <> 'failed' then
    raise exception 'A failed refund cannot be reopened by a stale event' using errcode = '23514';
  end if;

  if p_status = 'failed' then
    update payment_refunds
      set status='failed',
          provider_refund_id=coalesce(nullif(p_provider_refund_id,''),provider_refund_id),
          provider_payload=p_provider_payload,
          completed_at=now(),
          updated_at=now()
    where id=p_refund_id;
    return jsonb_build_object('refundId',refund_row.id,'status','failed','creditReversalDelta',0,'idempotentReplay',false);
  end if;

  select * into payment_row from payment_transactions
  where id=refund_row.payment_transaction_id and owner_id=refund_row.owner_id
  for update;
  if not found then raise exception 'Original payment not found' using errcode = 'P0002'; end if;

  update payment_refunds
    set status='succeeded',
        provider_refund_id=coalesce(nullif(p_provider_refund_id,''),provider_refund_id),
        provider_payload=p_provider_payload,
        completed_at=coalesce(completed_at,now()),
        updated_at=now()
  where id=p_refund_id;

  select coalesce(sum(credit_delta),0) into original_credits
  from credit_ledger
  where payment_transaction_id=payment_row.id and entry_type='purchase_grant' and credit_delta > 0;

  select coalesce(sum(amount_minor),0) into confirmed_refund_minor
  from payment_refunds
  where payment_transaction_id=payment_row.id and status='succeeded';

  if confirmed_refund_minor > payment_row.amount_minor then
    raise exception 'Confirmed refunds exceed original payment' using errcode = '23514';
  end if;

  select coalesce(-sum(credit_delta),0) into reversed_credits
  from credit_ledger
  where payment_transaction_id=payment_row.id and entry_type='refund_reversal' and credit_delta < 0;

  target_reversed := case
    when original_credits=0 or payment_row.amount_minor=0 then 0
    else floor((original_credits::numeric * confirmed_refund_minor::numeric) / payment_row.amount_minor)::bigint
  end;
  reversal_delta := target_reversed - reversed_credits;

  if reversal_delta < 0 then
    raise exception 'Existing credit reversals exceed confirmed refund allocation' using errcode = '23514';
  end if;

  if reversal_delta > 0 then
    insert into credit_ledger(
      owner_id,entry_type,credit_delta,idempotency_key,
      payment_transaction_id,refund_id,reason,metadata
    ) values (
      refund_row.owner_id,'refund_reversal',-reversal_delta,
      'refund-reversal:' || refund_row.id::text,
      payment_row.id,refund_row.id,
      'Credit reversal for provider-confirmed refund',
      jsonb_build_object('confirmedRefundMinor',confirmed_refund_minor,'originalPaymentMinor',payment_row.amount_minor)
    ) on conflict (owner_id,idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'refundId',refund_row.id,'status','succeeded',
    'creditReversalDelta',reversal_delta,
    'targetReversedCreditUnits',target_reversed,
    'idempotentReplay',false
  );
end;
$$;

revoke all on function executive_visuals.reserve_payment_refund(uuid,uuid,bigint,text,text,text,uuid) from public, anon, authenticated;
revoke all on function executive_visuals.finalize_payment_refund(uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function executive_visuals.reserve_payment_refund(uuid,uuid,bigint,text,text,text,uuid) to service_role;
grant execute on function executive_visuals.finalize_payment_refund(uuid,text,text,jsonb) to service_role;

     or length(coalesce(p_reason,'')) not between 3 and 500
     or length(coalesce(p_idempotency_key,'')) not between 8 and 180 then
    raise exception 'Invalid refund reservation input' using errcode = '22023';
  end if;

  select * into existing_row
  from payment_refunds
  where owner_id = p_owner_id and idempotency_key = p_idempotency_key;
  if found then
    if existing_row.payment_transaction_id <> p_payment_transaction_id
       or existing_row.amount_minor <> p_amount_minor
       or existing_row.currency <> p_currency then
      raise exception 'Idempotency key conflict' using errcode = '23505';
    end if;
    return existing_row.id;
  end if;

  select * into payment_row
  from payment_transactions
  where id = p_payment_transaction_id and owner_id = p_owner_id
  for update;

  if not found or payment_row.status <> 'successful' then
    raise exception 'Payment is not refundable' using errcode = 'P0002';
  end if;

  -- Recheck the idempotency key after acquiring the payment row lock. This
  -- serializes concurrent requests using the same key and returns the original
  -- reservation instead of attempting a duplicate insert.
  select * into existing_row
  from payment_refunds
  where owner_id = p_owner_id and idempotency_key = p_idempotency_key;
  if found then
    if existing_row.payment_transaction_id <> p_payment_transaction_id
       or existing_row.amount_minor <> p_amount_minor
       or existing_row.currency <> p_currency then
      raise exception 'Idempotency key conflict' using errcode = '23505';
    end if;
    return existing_row.id;
  end if;

  if payment_row.currency <> p_currency then
    raise exception 'Refund currency mismatch' using errcode = '22023';
  end if;

  select coalesce(sum(amount_minor),0) into reserved_minor
  from payment_refunds
  where payment_transaction_id = p_payment_transaction_id
    and status in ('requested','processing','succeeded');

  if reserved_minor + p_amount_minor > payment_row.amount_minor then
    raise exception 'Refund exceeds remaining refundable amount' using errcode = '22023';
  end if;

  insert into payment_refunds(
    owner_id,payment_transaction_id,amount_minor,currency,status,
    reason,idempotency_key,requested_by
  ) values (
    p_owner_id,p_payment_transaction_id,p_amount_minor,p_currency,'requested',
    p_reason,p_idempotency_key,p_requested_by
  ) returning id into refund_id;

  return refund_id;
end;
$$;

create or replace function executive_visuals.finalize_payment_refund(
  p_refund_id uuid,
  p_provider_refund_id text,
  p_status text,
  p_provider_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = executive_visuals, pg_temp
as $$
declare
  refund_row executive_visuals.payment_refunds%rowtype;
  payment_row executive_visuals.payment_transactions%rowtype;
  original_credits bigint;
  confirmed_refund_minor bigint;
  reversed_credits bigint;
  target_reversed bigint;
  reversal_delta bigint;
begin
  if p_refund_id is null or p_status is null or p_status not in ('succeeded','failed')
     or jsonb_typeof(coalesce(p_provider_payload,'{}'::jsonb)) <> 'object' then
    raise exception 'Invalid refund finalization input' using errcode = '22023';
  end if;

  select * into refund_row from payment_refunds where id = p_refund_id for update;
  if not found then
    raise exception 'Refund not found' using errcode = 'P0002';
  end if;

  if refund_row.status = 'succeeded' then
    return jsonb_build_object('refundId',refund_row.id,'status','succeeded','creditReversalDelta',0,'idempotentReplay',true);
  end if;
  if refund_row.status = 'failed' and p_status <> 'failed' then
    raise exception 'A failed refund cannot be reopened by a stale event' using errcode = '23514';
  end if;

  if p_status = 'failed' then
    update payment_refunds
      set status='failed',
          provider_refund_id=coalesce(nullif(p_provider_refund_id,''),provider_refund_id),
          provider_payload=p_provider_payload,
          completed_at=now(),
          updated_at=now()
    where id=p_refund_id;
    return jsonb_build_object('refundId',refund_row.id,'status','failed','creditReversalDelta',0,'idempotentReplay',false);
  end if;

  select * into payment_row from payment_transactions
  where id=refund_row.payment_transaction_id and owner_id=refund_row.owner_id
  for update;
  if not found then raise exception 'Original payment not found' using errcode = 'P0002'; end if;

  update payment_refunds
    set status='succeeded',
        provider_refund_id=coalesce(nullif(p_provider_refund_id,''),provider_refund_id),
        provider_payload=p_provider_payload,
        completed_at=coalesce(completed_at,now()),
        updated_at=now()
  where id=p_refund_id;

  select coalesce(sum(credit_delta),0) into original_credits
  from credit_ledger
  where payment_transaction_id=payment_row.id and entry_type='purchase_grant' and credit_delta > 0;

  select coalesce(sum(amount_minor),0) into confirmed_refund_minor
  from payment_refunds
  where payment_transaction_id=payment_row.id and status='succeeded';

  if confirmed_refund_minor > payment_row.amount_minor then
    raise exception 'Confirmed refunds exceed original payment' using errcode = '23514';
  end if;

  select coalesce(-sum(credit_delta),0) into reversed_credits
  from credit_ledger
  where payment_transaction_id=payment_row.id and entry_type='refund_reversal' and credit_delta < 0;

  target_reversed := case
    when original_credits=0 or payment_row.amount_minor=0 then 0
    else floor((original_credits::numeric * confirmed_refund_minor::numeric) / payment_row.amount_minor)::bigint
  end;
  reversal_delta := target_reversed - reversed_credits;

  if reversal_delta < 0 then
    raise exception 'Existing credit reversals exceed confirmed refund allocation' using errcode = '23514';
  end if;

  if reversal_delta > 0 then
    insert into credit_ledger(
      owner_id,entry_type,credit_delta,idempotency_key,
      payment_transaction_id,refund_id,reason,metadata
    ) values (
      refund_row.owner_id,'refund_reversal',-reversal_delta,
      'refund-reversal:' || refund_row.id::text,
      payment_row.id,refund_row.id,
      'Credit reversal for provider-confirmed refund',
      jsonb_build_object('confirmedRefundMinor',confirmed_refund_minor,'originalPaymentMinor',payment_row.amount_minor)
    ) on conflict (owner_id,idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'refundId',refund_row.id,'status','succeeded',
    'creditReversalDelta',reversal_delta,
    'targetReversedCreditUnits',target_reversed,
    'idempotentReplay',false
  );
end;
$$;

revoke all on function executive_visuals.reserve_payment_refund(uuid,uuid,bigint,text,text,text,uuid) from public, anon, authenticated;
revoke all on function executive_visuals.finalize_payment_refund(uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function executive_visuals.reserve_payment_refund(uuid,uuid,bigint,text,text,text,uuid) to service_role;
grant execute on function executive_visuals.finalize_payment_refund(uuid,text,text,jsonb) to service_role;

     or length(coalesce(p_reason,'')) not between 3 and 500
     or length(coalesce(p_idempotency_key,'')) not between 8 and 180 then
    raise exception 'Invalid refund reservation input' using errcode = '22023';
  end if;

  select * into existing_row
  from payment_refunds
  where owner_id = p_owner_id and idempotency_key = p_idempotency_key;
  if found then
    if existing_row.payment_transaction_id <> p_payment_transaction_id
       or existing_row.amount_minor <> p_amount_minor
       or existing_row.currency <> p_currency then
      raise exception 'Idempotency key conflict' using errcode = '23505';
    end if;
    return existing_row.id;
  end if;

  select * into payment_row
  from payment_transactions
  where id = p_payment_transaction_id and owner_id = p_owner_id
  for update;

  if not found or payment_row.status <> 'successful' then
    raise exception 'Payment is not refundable' using errcode = 'P0002';
  end if;

  -- Recheck the idempotency key after acquiring the payment row lock. This
  -- serializes concurrent requests using the same key and returns the original
  -- reservation instead of attempting a duplicate insert.
  select * into existing_row
  from payment_refunds
  where owner_id = p_owner_id and idempotency_key = p_idempotency_key;
  if found then
    if existing_row.payment_transaction_id <> p_payment_transaction_id
       or existing_row.amount_minor <> p_amount_minor
       or existing_row.currency <> p_currency then
      raise exception 'Idempotency key conflict' using errcode = '23505';
    end if;
    return existing_row.id;
  end if;

  if payment_row.currency <> p_currency then
    raise exception 'Refund currency mismatch' using errcode = '22023';
  end if;

  select coalesce(sum(amount_minor),0) into reserved_minor
  from payment_refunds
  where payment_transaction_id = p_payment_transaction_id
    and status in ('requested','processing','succeeded');

  if reserved_minor + p_amount_minor > payment_row.amount_minor then
    raise exception 'Refund exceeds remaining refundable amount' using errcode = '22023';
  end if;

  insert into payment_refunds(
    owner_id,payment_transaction_id,amount_minor,currency,status,
    reason,idempotency_key,requested_by
  ) values (
    p_owner_id,p_payment_transaction_id,p_amount_minor,p_currency,'requested',
    p_reason,p_idempotency_key,p_requested_by
  ) returning id into refund_id;

  return refund_id;
end;
$$;

create or replace function executive_visuals.finalize_payment_refund(
  p_refund_id uuid,
  p_provider_refund_id text,
  p_status text,
  p_provider_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = executive_visuals, pg_temp
as $$
declare
  refund_row executive_visuals.payment_refunds%rowtype;
  payment_row executive_visuals.payment_transactions%rowtype;
  original_credits bigint;
  confirmed_refund_minor bigint;
  reversed_credits bigint;
  target_reversed bigint;
  reversal_delta bigint;
begin
  if p_refund_id is null or p_status is null or p_status not in ('succeeded','failed')
     or jsonb_typeof(coalesce(p_provider_payload,'{}'::jsonb)) <> 'object' then
    raise exception 'Invalid refund finalization input' using errcode = '22023';
  end if;

  select * into refund_row from payment_refunds where id = p_refund_id for update;
  if not found then
    raise exception 'Refund not found' using errcode = 'P0002';
  end if;

  if refund_row.status = 'succeeded' then
    return jsonb_build_object('refundId',refund_row.id,'status','succeeded','creditReversalDelta',0,'idempotentReplay',true);
  end if;
  if refund_row.status = 'failed' and p_status <> 'failed' then
    raise exception 'A failed refund cannot be reopened by a stale event' using errcode = '23514';
  end if;

  if p_status = 'failed' then
    update payment_refunds
      set status='failed',
          provider_refund_id=coalesce(nullif(p_provider_refund_id,''),provider_refund_id),
          provider_payload=p_provider_payload,
          completed_at=now(),
          updated_at=now()
    where id=p_refund_id;
    return jsonb_build_object('refundId',refund_row.id,'status','failed','creditReversalDelta',0,'idempotentReplay',false);
  end if;

  select * into payment_row from payment_transactions
  where id=refund_row.payment_transaction_id and owner_id=refund_row.owner_id
  for update;
  if not found then raise exception 'Original payment not found' using errcode = 'P0002'; end if;

  update payment_refunds
    set status='succeeded',
        provider_refund_id=coalesce(nullif(p_provider_refund_id,''),provider_refund_id),
        provider_payload=p_provider_payload,
        completed_at=coalesce(completed_at,now()),
        updated_at=now()
  where id=p_refund_id;

  select coalesce(sum(credit_delta),0) into original_credits
  from credit_ledger
  where payment_transaction_id=payment_row.id and entry_type='purchase_grant' and credit_delta > 0;

  select coalesce(sum(amount_minor),0) into confirmed_refund_minor
  from payment_refunds
  where payment_transaction_id=payment_row.id and status='succeeded';

  if confirmed_refund_minor > payment_row.amount_minor then
    raise exception 'Confirmed refunds exceed original payment' using errcode = '23514';
  end if;

  select coalesce(-sum(credit_delta),0) into reversed_credits
  from credit_ledger
  where payment_transaction_id=payment_row.id and entry_type='refund_reversal' and credit_delta < 0;

  target_reversed := case
    when original_credits=0 or payment_row.amount_minor=0 then 0
    else floor((original_credits::numeric * confirmed_refund_minor::numeric) / payment_row.amount_minor)::bigint
  end;
  reversal_delta := target_reversed - reversed_credits;

  if reversal_delta < 0 then
    raise exception 'Existing credit reversals exceed confirmed refund allocation' using errcode = '23514';
  end if;

  if reversal_delta > 0 then
    insert into credit_ledger(
      owner_id,entry_type,credit_delta,idempotency_key,
      payment_transaction_id,refund_id,reason,metadata
    ) values (
      refund_row.owner_id,'refund_reversal',-reversal_delta,
      'refund-reversal:' || refund_row.id::text,
      payment_row.id,refund_row.id,
      'Credit reversal for provider-confirmed refund',
      jsonb_build_object('confirmedRefundMinor',confirmed_refund_minor,'originalPaymentMinor',payment_row.amount_minor)
    ) on conflict (owner_id,idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'refundId',refund_row.id,'status','succeeded',
    'creditReversalDelta',reversal_delta,
    'targetReversedCreditUnits',target_reversed,
    'idempotentReplay',false
  );
end;
$$;

revoke all on function executive_visuals.reserve_payment_refund(uuid,uuid,bigint,text,text,text,uuid) from public, anon, authenticated;
revoke all on function executive_visuals.finalize_payment_refund(uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function executive_visuals.reserve_payment_refund(uuid,uuid,bigint,text,text,text,uuid) to service_role;
grant execute on function executive_visuals.finalize_payment_refund(uuid,text,text,jsonb) to service_role;

     or length(coalesce(p_reason,'')) not between 3 and 500
     or length(coalesce(p_idempotency_key,'')) not between 8 and 180 then
    raise exception 'Invalid refund reservation input' using errcode = '22023';
  end if;

  select * into existing_row
  from payment_refunds
  where owner_id = p_owner_id and idempotency_key = p_idempotency_key;
  if found then
    if existing_row.payment_transaction_id <> p_payment_transaction_id
       or existing_row.amount_minor <> p_amount_minor
       or existing_row.currency <> p_currency then
      raise exception 'Idempotency key conflict' using errcode = '23505';
    end if;
    return existing_row.id;
  end if;

  select * into payment_row
  from payment_transactions
  where id = p_payment_transaction_id and owner_id = p_owner_id
  for update;

  if not found or payment_row.status <> 'successful' then
    raise exception 'Payment is not refundable' using errcode = 'P0002';
  end if;

  -- Recheck the idempotency key after acquiring the payment row lock. This
  -- serializes concurrent requests using the same key and returns the original
  -- reservation instead of attempting a duplicate insert.
  select * into existing_row
  from payment_refunds
  where owner_id = p_owner_id and idempotency_key = p_idempotency_key;
  if found then
    if existing_row.payment_transaction_id <> p_payment_transaction_id
       or existing_row.amount_minor <> p_amount_minor
       or existing_row.currency <> p_currency then
      raise exception 'Idempotency key conflict' using errcode = '23505';
    end if;
    return existing_row.id;
  end if;

  if payment_row.currency <> p_currency then
    raise exception 'Refund currency mismatch' using errcode = '22023';
  end if;

  select coalesce(sum(amount_minor),0) into reserved_minor
  from payment_refunds
  where payment_transaction_id = p_payment_transaction_id
    and status in ('requested','processing','succeeded');

  if reserved_minor + p_amount_minor > payment_row.amount_minor then
    raise exception 'Refund exceeds remaining refundable amount' using errcode = '22023';
  end if;

  insert into payment_refunds(
    owner_id,payment_transaction_id,amount_minor,currency,status,
    reason,idempotency_key,requested_by
  ) values (
    p_owner_id,p_payment_transaction_id,p_amount_minor,p_currency,'requested',
    p_reason,p_idempotency_key,p_requested_by
  ) returning id into refund_id;

  return refund_id;
end;
$$;

create or replace function executive_visuals.finalize_payment_refund(
  p_refund_id uuid,
  p_provider_refund_id text,
  p_status text,
  p_provider_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = executive_visuals, pg_temp
as $$
declare
  refund_row executive_visuals.payment_refunds%rowtype;
  payment_row executive_visuals.payment_transactions%rowtype;
  original_credits bigint;
  confirmed_refund_minor bigint;
  reversed_credits bigint;
  target_reversed bigint;
  reversal_delta bigint;
begin
  if p_refund_id is null or p_status not in ('succeeded','failed')
     or jsonb_typeof(coalesce(p_provider_payload,'{}'::jsonb)) <> 'object' then
    raise exception 'Invalid refund finalization input' using errcode = '22023';
  end if;

  select * into refund_row from payment_refunds where id = p_refund_id for update;
  if not found then
    raise exception 'Refund not found' using errcode = 'P0002';
  end if;

  if refund_row.status = 'succeeded' then
    return jsonb_build_object('refundId',refund_row.id,'status','succeeded','creditReversalDelta',0,'idempotentReplay',true);
  end if;
  if refund_row.status = 'failed' and p_status <> 'failed' then
    raise exception 'A failed refund cannot be reopened by a stale event' using errcode = '23514';
  end if;

  if p_status = 'failed' then
    update payment_refunds
      set status='failed',
          provider_refund_id=coalesce(nullif(p_provider_refund_id,''),provider_refund_id),
          provider_payload=p_provider_payload,
          completed_at=now(),
          updated_at=now()
    where id=p_refund_id;
    return jsonb_build_object('refundId',refund_row.id,'status','failed','creditReversalDelta',0,'idempotentReplay',false);
  end if;

  select * into payment_row from payment_transactions
  where id=refund_row.payment_transaction_id and owner_id=refund_row.owner_id
  for update;
  if not found then raise exception 'Original payment not found' using errcode = 'P0002'; end if;

  update payment_refunds
    set status='succeeded',
        provider_refund_id=coalesce(nullif(p_provider_refund_id,''),provider_refund_id),
        provider_payload=p_provider_payload,
        completed_at=coalesce(completed_at,now()),
        updated_at=now()
  where id=p_refund_id;

  select coalesce(sum(credit_delta),0) into original_credits
  from credit_ledger
  where payment_transaction_id=payment_row.id and entry_type='purchase_grant' and credit_delta > 0;

  select coalesce(sum(amount_minor),0) into confirmed_refund_minor
  from payment_refunds
  where payment_transaction_id=payment_row.id and status='succeeded';

  if confirmed_refund_minor > payment_row.amount_minor then
    raise exception 'Confirmed refunds exceed original payment' using errcode = '23514';
  end if;

  select coalesce(-sum(credit_delta),0) into reversed_credits
  from credit_ledger
  where payment_transaction_id=payment_row.id and entry_type='refund_reversal' and credit_delta < 0;

  target_reversed := case
    when original_credits=0 or payment_row.amount_minor=0 then 0
    else floor((original_credits::numeric * confirmed_refund_minor::numeric) / payment_row.amount_minor)::bigint
  end;
  reversal_delta := target_reversed - reversed_credits;

  if reversal_delta < 0 then
    raise exception 'Existing credit reversals exceed confirmed refund allocation' using errcode = '23514';
  end if;

  if reversal_delta > 0 then
    insert into credit_ledger(
      owner_id,entry_type,credit_delta,idempotency_key,
      payment_transaction_id,refund_id,reason,metadata
    ) values (
      refund_row.owner_id,'refund_reversal',-reversal_delta,
      'refund-reversal:' || refund_row.id::text,
      payment_row.id,refund_row.id,
      'Credit reversal for provider-confirmed refund',
      jsonb_build_object('confirmedRefundMinor',confirmed_refund_minor,'originalPaymentMinor',payment_row.amount_minor)
    ) on conflict (owner_id,idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'refundId',refund_row.id,'status','succeeded',
    'creditReversalDelta',reversal_delta,
    'targetReversedCreditUnits',target_reversed,
    'idempotentReplay',false
  );
end;
$$;

revoke all on function executive_visuals.reserve_payment_refund(uuid,uuid,bigint,text,text,text,uuid) from public, anon, authenticated;
revoke all on function executive_visuals.finalize_payment_refund(uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function executive_visuals.reserve_payment_refund(uuid,uuid,bigint,text,text,text,uuid) to service_role;
grant execute on function executive_visuals.finalize_payment_refund(uuid,text,text,jsonb) to service_role;
