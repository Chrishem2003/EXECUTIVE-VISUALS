-- Batch 65: verified, idempotent one-time credit-pack purchase foundation.
-- Uses the existing server-owned UGX billing_products catalogue and payment ledger.
-- Checkout remains sandbox/staging only; no product is activated here.

create or replace function executive_visuals.reserve_credit_pack_purchase(
  p_owner_id uuid,
  p_product_code text,
  p_provider text,
  p_customer_email text,
  p_idempotency_key text,
  p_tx_ref text
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  product_row executive_visuals.billing_products%rowtype;
  payment_row executive_visuals.payment_transactions%rowtype;
  payment_id uuid;
  email_value text;
begin
  email_value:=lower(btrim(coalesce(p_customer_email,'')));
  if p_owner_id is null
     or p_product_code !~ '^[a-z0-9][a-z0-9_-]{2,59}$'
     or lower(coalesce(p_provider,'')) not in ('flutterwave','pesapal')
     or email_value !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
     or p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 180
     or p_tx_ref is null or char_length(p_tx_ref) not between 8 and 180 then
    raise exception 'Invalid credit-pack purchase reservation input' using errcode='22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text,0));

  select * into payment_row
    from payment_transactions
   where owner_id=p_owner_id
     and metadata->>'idempotency_key'=p_idempotency_key
   for update;
  if found then
    if payment_row.provider<>lower(p_provider)
       or payment_row.metadata->>'payment_purpose'<>'credit_pack_purchase'
       or payment_row.metadata->>'product_code'<>p_product_code then
      raise exception 'Credit-pack idempotency key conflicts with another purchase' using errcode='23505';
    end if;
    return jsonb_build_object(
      'paymentId',payment_row.id,'txRef',payment_row.tx_ref,
      'amountMinor',payment_row.amount_minor,'currency',payment_row.currency,
      'creditUnits',(payment_row.metadata->>'credit_units')::bigint,
      'status',payment_row.status,'idempotentReplay',true
    );
  end if;

  select * into product_row from billing_products
   where product_code=p_product_code and active=true
   for share;
  if not found then raise exception 'Credit pack is not active' using errcode='P0002'; end if;
  if product_row.currency<>'UGX' or product_row.amount_minor<=0 or product_row.credit_units<=0 then
    raise exception 'Credit pack pricing is not eligible for provider checkout' using errcode='23514';
  end if;

  insert into payment_transactions(
    owner_id,provider,tx_ref,amount_minor,currency,status,payment_method,
    customer_email,description,metadata
  ) values(
    p_owner_id,lower(p_provider),p_tx_ref,product_row.amount_minor,product_row.currency,
    'pending',case when lower(p_provider)='flutterwave' then 'card_or_mobile_money' else 'hosted_checkout' end,
    email_value,'Executive Visuals credit pack: '||product_row.name,
    jsonb_build_object(
      'payment_purpose','credit_pack_purchase',
      'product_code',product_row.product_code,
      'credit_units',product_row.credit_units,
      'idempotency_key',p_idempotency_key,
      'provider',lower(p_provider)
    )
  ) returning id into payment_id;

  return jsonb_build_object(
    'paymentId',payment_id,'txRef',p_tx_ref,
    'amountMinor',product_row.amount_minor,'amountMajor',product_row.amount_minor,
    'currency',product_row.currency,'creditUnits',product_row.credit_units,
    'status','pending','idempotentReplay',false
  );
end;
$$;

create or replace function executive_visuals.finalize_credit_pack_purchase(
  p_payment_id uuid,
  p_provider_transaction_id text,
  p_provider_payload jsonb,
  p_verified_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  payment_row executive_visuals.payment_transactions%rowtype;
  credit_units bigint;
  amount_minor bigint;
  invoice_id uuid;
  invoice_no text;
  inserted_grants integer:=0;
begin
  if p_payment_id is null
     or nullif(btrim(p_provider_transaction_id),'') is null
     or p_verified_at is null
     or jsonb_typeof(coalesce(p_provider_payload,'{}'::jsonb))<>'object'
     or lower(coalesce(p_provider_payload->>'status',''))<>'succeeded' then
    raise exception 'Invalid verified credit-pack settlement input' using errcode='22023';
  end if;

  select * into payment_row from payment_transactions
   where id=p_payment_id for update;
  if not found then raise exception 'Credit-pack payment not found' using errcode='P0002'; end if;
  if payment_row.provider not in ('flutterwave','pesapal')
     or payment_row.metadata->>'payment_purpose'<>'credit_pack_purchase' then
    raise exception 'Payment is not a supported credit-pack purchase' using errcode='23514';
  end if;

  begin
    amount_minor:=(p_provider_payload->>'amount_minor')::bigint;
    credit_units:=(payment_row.metadata->>'credit_units')::bigint;
  exception when others then
    raise exception 'Verified credit-pack amount or entitlement is invalid' using errcode='22023';
  end;

  if credit_units<=0
     or amount_minor<>payment_row.amount_minor
     or upper(coalesce(p_provider_payload->>'currency',''))<>payment_row.currency
     or coalesce(p_provider_payload->>'reference','')<>payment_row.tx_ref
     or (payment_row.provider_transaction_id is not null
         and payment_row.provider_transaction_id<>p_provider_transaction_id) then
    raise exception 'Verified provider charge does not match the reserved credit pack' using errcode='23514';
  end if;

  if payment_row.status='successful'
     and coalesce((payment_row.metadata->>'credit_pack_applied')::boolean,false) then
    return jsonb_build_object('paymentId',payment_row.id,'status','successful','idempotentReplay',true);
  end if;
  if payment_row.status<>'pending' then
    raise exception 'Credit-pack payment is not pending' using errcode='23514';
  end if;

  update payment_transactions set
    status='successful',
    provider_transaction_id=p_provider_transaction_id,
    paid_at=coalesce(paid_at,p_verified_at),
    verified_at=p_verified_at,
    metadata=metadata||jsonb_build_object(
      'credit_pack_applied',true,
      'credit_pack_verified_at',p_verified_at,
      'provider_verification',p_provider_payload
    ),
    updated_at=now()
   where id=payment_row.id;

  insert into credit_ledger(
    owner_id,entry_type,credit_delta,idempotency_key,payment_transaction_id,reason,metadata
  ) values(
    payment_row.owner_id,'purchase_grant',credit_units,
    'credit-pack-purchase:'||payment_row.id::text,payment_row.id,
    'Credits granted after verified one-time credit-pack payment',
    jsonb_build_object(
      'product_code',payment_row.metadata->>'product_code',
      'provider',payment_row.provider,
      'provider_transaction_id',p_provider_transaction_id
    )
  ) on conflict(owner_id,idempotency_key) do nothing;
  get diagnostics inserted_grants=row_count;

  invoice_no:='EV-'||to_char(p_verified_at at time zone 'UTC','YYYYMMDD')||'-'||upper(substr(replace(payment_row.id::text,'-',''),1,10));
  insert into billing_invoices(
    owner_id,payment_transaction_id,invoice_number,currency,total_minor,snapshot
  ) values(
    payment_row.owner_id,payment_row.id,invoice_no,payment_row.currency,payment_row.amount_minor,
    jsonb_build_object(
      'invoice_number',invoice_no,
      'product_code',payment_row.metadata->>'product_code',
      'description',payment_row.description,
      'amount_minor',payment_row.amount_minor,
      'currency',payment_row.currency,
      'credit_units',credit_units,
      'provider',payment_row.provider,
      'provider_transaction_id',p_provider_transaction_id,
      'issued_at',p_verified_at
    )
  ) on conflict(payment_transaction_id) do nothing
  returning id into invoice_id;

  insert into billing_notification_outbox(owner_id,notification_type,dedupe_key,payload)
  values(
    payment_row.owner_id,'payment_receipt','credit-pack-receipt:'||payment_row.id::text,
    jsonb_build_object(
      'payment_id',payment_row.id,'invoice_number',invoice_no,
      'amount_minor',payment_row.amount_minor,'currency',payment_row.currency,
      'credit_units',credit_units
    )
  ) on conflict(dedupe_key) do nothing;

  return jsonb_build_object(
    'paymentId',payment_row.id,'status','successful',
    'creditUnits',credit_units,'creditGrantInserted',inserted_grants=1,
    'invoiceNumber',invoice_no,'invoiceId',invoice_id,'idempotentReplay',false
  );
end;
$$;

revoke all on function executive_visuals.reserve_credit_pack_purchase(uuid,text,text,text,text,text)
  from public,anon,authenticated;
revoke all on function executive_visuals.finalize_credit_pack_purchase(uuid,text,jsonb,timestamptz)
  from public,anon,authenticated;
grant execute on function executive_visuals.reserve_credit_pack_purchase(uuid,text,text,text,text,text)
  to service_role;
grant execute on function executive_visuals.finalize_credit_pack_purchase(uuid,text,jsonb,timestamptz)
  to service_role;

comment on function executive_visuals.reserve_credit_pack_purchase(uuid,text,text,text,text,text) is
  'Reserves an active server-priced UGX credit pack for Flutterwave or Pesapal; does not create a provider checkout or grant credits.';
comment on function executive_visuals.finalize_credit_pack_purchase(uuid,text,jsonb,timestamptz) is
  'Grants credit-pack units and issues invoice/outbox only after a verified matching provider payment.';
