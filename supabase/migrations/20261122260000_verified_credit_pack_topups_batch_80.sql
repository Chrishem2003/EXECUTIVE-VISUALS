-- Batch 80: verified credit-pack top-ups must be marked before the legacy
-- purchase-grant trigger mirrors them into the generation wallet and Batch 71
-- revenue-source ledger. The browser never calls this RPC directly.
alter function executive_visuals.finalize_payment_purchase(uuid,text,jsonb,timestamptz)
  rename to finalize_payment_purchase_pre_batch80;

revoke all on function executive_visuals.finalize_payment_purchase_pre_batch80(uuid,text,jsonb,timestamptz)
  from public,anon,authenticated,service_role;

create or replace function executive_visuals.finalize_payment_purchase(
  p_payment_id uuid,
  p_provider_transaction_id text,
  p_provider_payload jsonb,
  p_verified_at timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $finalize_payment_purchase$
declare
  payment_row executive_visuals.payment_transactions%rowtype;
  v_snapshot jsonb;
  v_product_code text;
  v_credit_units bigint;
  v_amount_minor bigint;
begin
  if p_payment_id is null or nullif(p_provider_transaction_id,'') is null
     or p_verified_at is null or jsonb_typeof(coalesce(p_provider_payload,'{}'::jsonb))<>'object' then
    raise exception 'CREDIT_PACK_SETTLEMENT_ARGUMENTS_INVALID' using errcode='22023';
  end if;

  select * into payment_row
    from executive_visuals.payment_transactions
   where id=p_payment_id
   for update;
  if not found then raise exception 'Payment transaction not found' using errcode='P0002'; end if;

  -- Replays of an already successful payment are delegated to the original
  -- idempotent finalizer. Never mutate the provenance of historical payments.
  if payment_row.status='successful' then
    return executive_visuals.finalize_payment_purchase_pre_batch80(
      p_payment_id,p_provider_transaction_id,p_provider_payload,p_verified_at
    );
  end if;

  if payment_row.status<>'pending' then
    raise exception 'Only pending credit-pack payments can be fulfilled' using errcode='23514';
  end if;
  if payment_row.provider<>'flutterwave' then
    raise exception 'Unsupported payment provider' using errcode='23514';
  end if;
  if payment_row.metadata->>'payment_purpose' is distinct from 'credit_pack_purchase'
     or coalesce((payment_row.metadata->>'credit_pack_applied')::boolean,false) then
    raise exception 'CREDIT_PACK_PURPOSE_OR_STATE_INVALID' using errcode='23514';
  end if;

  v_snapshot:=payment_row.metadata->'credit_pack_snapshot';
  if jsonb_typeof(v_snapshot) is distinct from 'object'
     or v_snapshot->>'productType' is distinct from 'credit_pack'
     or v_snapshot->>'currency' is distinct from 'UGX'
     or (v_snapshot->>'productCode') is distinct from payment_row.metadata->>'product_code'
     or (v_snapshot->>'creditUnits') !~ '^[1-9][0-9]{0,17}$'
     or (v_snapshot->>'amountMinor') !~ '^[1-9][0-9]{0,17}$'
     or (payment_row.metadata->>'credit_units') !~ '^[1-9][0-9]{0,17}$' then
    raise exception 'CREDIT_PACK_SNAPSHOT_INVALID' using errcode='23514';
  end if;

  v_product_code:=v_snapshot->>'productCode';
  v_credit_units:=(v_snapshot->>'creditUnits')::bigint;
  v_amount_minor:=(v_snapshot->>'amountMinor')::bigint;
  if v_product_code is null
     or v_credit_units is distinct from (payment_row.metadata->>'credit_units')::bigint
     or v_amount_minor is distinct from payment_row.amount_minor
     or v_snapshot->>'currency' is distinct from payment_row.currency
     or v_product_code !~ '^[a-z0-9][a-z0-9_-]{2,59} using errcode='23514';
  end if;

  -- Set the verified source marker in the same transaction immediately before
  -- the original finalizer inserts the legacy grant. Batch 71's trigger now
  -- recognizes this as paid revenue and mirrors the exact same grant once.
  update executive_visuals.payment_transactions
     set metadata=metadata||jsonb_build_object(
       'credit_pack_applied',true,
       'credit_pack_applied_at',p_verified_at
     )
   where id=p_payment_id;

  return executive_visuals.finalize_payment_purchase_pre_batch80(
    p_payment_id,p_provider_transaction_id,p_provider_payload,p_verified_at
  );
end;
$finalize_payment_purchase$;

revoke all on function executive_visuals.finalize_payment_purchase(uuid,text,jsonb,timestamptz)
  from public,anon,authenticated;
grant execute on function executive_visuals.finalize_payment_purchase(uuid,text,jsonb,timestamptz)
  to service_role;

comment on function executive_visuals.finalize_payment_purchase(uuid,text,jsonb,timestamptz)
  is 'Verifies the server-owned credit-pack snapshot and marks paid credit provenance atomically before grant triggers run.';
 then
    raise exception 'CREDIT_PACK_SNAPSHOT_PAYMENT_MISMATCH' using errcode='23514';
  end if;

  -- Set the verified source marker in the same transaction immediately before
  -- the original finalizer inserts the legacy grant. Batch 71's trigger now
  -- recognizes this as paid revenue and mirrors the exact same grant once.
  update executive_visuals.payment_transactions
     set metadata=metadata||jsonb_build_object(
       'credit_pack_applied',true,
       'credit_pack_applied_at',p_verified_at
     )
   where id=p_payment_id;

  return executive_visuals.finalize_payment_purchase_pre_batch80(
    p_payment_id,p_provider_transaction_id,p_provider_payload,p_verified_at
  );
end;
$finalize_payment_purchase$;

revoke all on function executive_visuals.finalize_payment_purchase(uuid,text,jsonb,timestamptz)
  from public,anon,authenticated;
grant execute on function executive_visuals.finalize_payment_purchase(uuid,text,jsonb,timestamptz)
  to service_role;

comment on function executive_visuals.finalize_payment_purchase(uuid,text,jsonb,timestamptz)
  is 'Verifies the server-owned credit-pack snapshot and marks paid credit provenance atomically before grant triggers run.';
 then
    raise exception 'CREDIT_PACK_SNAPSHOT_PAYMENT_MISMATCH' using errcode='23514';
  end if;

  -- Set the verified source marker in the same transaction immediately before
  -- the original finalizer inserts the legacy grant. Batch 71's trigger now
  -- recognizes this as paid revenue and mirrors the exact same grant once.
  update executive_visuals.payment_transactions
     set metadata=metadata||jsonb_build_object(
       'credit_pack_applied',true,
       'credit_pack_applied_at',p_verified_at
     )
   where id=p_payment_id;

  return executive_visuals.finalize_payment_purchase_pre_batch80(
    p_payment_id,p_provider_transaction_id,p_provider_payload,p_verified_at
  );
end;
$finalize_payment_purchase$;

revoke all on function executive_visuals.finalize_payment_purchase(uuid,text,jsonb,timestamptz)
  from public,anon,authenticated;
grant execute on function executive_visuals.finalize_payment_purchase(uuid,text,jsonb,timestamptz)
  to service_role;

comment on function executive_visuals.finalize_payment_purchase(uuid,text,jsonb,timestamptz)
  is 'Verifies the server-owned credit-pack snapshot and marks paid credit provenance atomically before grant triggers run.';
 then
    raise exception 'CREDIT_PACK_SNAPSHOT_PAYMENT_MISMATCH' using errcode='23514';
  end if;

  -- Set the verified source marker in the same transaction immediately before
  -- the original finalizer inserts the legacy grant. Batch 71's trigger now
  -- recognizes this as paid revenue and mirrors the exact same grant once.
  update executive_visuals.payment_transactions
     set metadata=metadata||jsonb_build_object(
       'credit_pack_applied',true,
       'credit_pack_applied_at',p_verified_at
     )
   where id=p_payment_id;

  return executive_visuals.finalize_payment_purchase_pre_batch80(
    p_payment_id,p_provider_transaction_id,p_provider_payload,p_verified_at
  );
end;
$finalize_payment_purchase$;

revoke all on function executive_visuals.finalize_payment_purchase(uuid,text,jsonb,timestamptz)
  from public,anon,authenticated;
grant execute on function executive_visuals.finalize_payment_purchase(uuid,text,jsonb,timestamptz)
  to service_role;

comment on function executive_visuals.finalize_payment_purchase(uuid,text,jsonb,timestamptz)
  is 'Verifies the server-owned credit-pack snapshot and marks paid credit provenance atomically before grant triggers run.';
