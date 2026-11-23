-- Batch 104: settle one-time credit-pack purchases into the customer generation wallet.
-- Products are inactive by default; checkout only starts for an explicitly active product.
create table if not exists executive_visuals.billing_products (
  product_code text primary key,
  name text not null,
  description text not null default '',
  product_type text not null default 'credit_pack',
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  credit_units bigint not null check (credit_units between 1 and 1000000000),
  version integer not null default 1 check (version > 0),
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table executive_visuals.billing_products
  add column if not exists product_type text,
  add column if not exists version integer not null default 1,
  add column if not exists active boolean not null default false;

create unique index if not exists billing_products_product_code_uidx
  on executive_visuals.billing_products(product_code);

grant select on executive_visuals.billing_products to service_role;

create or replace function executive_visuals.finalize_credit_pack_purchase(
  p_payment_id uuid,
  p_provider_transaction_id text,
  p_provider_payload jsonb,
  p_verified_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $finalize_credit_pack_purchase$
declare
  payment_row executive_visuals.payment_transactions%rowtype;
  product_row executive_visuals.billing_products%rowtype;
  grant_result record;
  credit_units bigint;
  product_version integer;
  snapshot_amount bigint;
  snapshot_currency text;
  grant_key text;
  grant_evidence jsonb;
begin
  if p_payment_id is null
     or nullif(btrim(p_provider_transaction_id),'') is null
     or p_verified_at is null
     or p_provider_payload is null
     or jsonb_typeof(p_provider_payload)<>'object'
     or lower(coalesce(p_provider_payload->>'status',''))<>'succeeded' then
    raise exception 'CREDIT_PACK_VERIFIED_PAYMENT_ARGUMENTS_INVALID';
  end if;

  select * into payment_row
    from executive_visuals.payment_transactions p
   where p.id=p_payment_id
   for update;
  if payment_row.id is null then raise exception 'CREDIT_PACK_PAYMENT_NOT_FOUND'; end if;

  if payment_row.provider is distinct from 'flutterwave'
     or payment_row.currency<>'UGX'
     or coalesce(p_provider_payload->>'id','')<>p_provider_transaction_id
     or upper(coalesce(p_provider_payload->>'currency',''))<>payment_row.currency
     or coalesce(p_provider_payload->>'reference','')<>payment_row.tx_ref
     or coalesce((p_provider_payload->>'amount')::numeric,-1)<>payment_row.amount_minor::numeric
     or payment_row.provider_transaction_id is distinct from p_provider_transaction_id then
    raise exception 'CREDIT_PACK_PROVIDER_PAYMENT_MISMATCH';
  end if;

  if payment_row.metadata->>'product_type'<>'credit_pack'
     or nullif(payment_row.metadata->>'product_code','') is null
     or nullif(payment_row.metadata->>'idempotency_key','') is null then
    raise exception 'CREDIT_PACK_PRODUCT_SNAPSHOT_INVALID';
  end if;

  begin
    credit_units:=(payment_row.metadata->>'credit_units')::bigint;
    product_version:=(payment_row.metadata->>'product_version')::integer;
    snapshot_amount:=(payment_row.metadata->>'product_amount_minor')::bigint;
  exception when others then
    raise exception 'CREDIT_PACK_PRODUCT_SNAPSHOT_INVALID';
  end;
  snapshot_currency:=upper(coalesce(payment_row.metadata->>'product_currency',''));
  if credit_units not between 1 and 1000000000
     or product_version<1
     or snapshot_amount<>payment_row.amount_minor
     or snapshot_currency<>payment_row.currency then
    raise exception 'CREDIT_PACK_PRODUCT_SNAPSHOT_INVALID';
  end if;

  if payment_row.status='successful'
     and coalesce((payment_row.metadata->>'credit_pack_applied')::boolean,false) then
    return jsonb_build_object(
      'paymentId',payment_row.id,'status','successful',
      'creditUnits',credit_units,
      'idempotentReplay',true
    );
  end if;
  if payment_row.status<>'pending' then
    raise exception 'CREDIT_PACK_PAYMENT_NOT_PENDING';
  end if;

  select * into product_row
    from executive_visuals.billing_products p
   where p.product_code=payment_row.metadata->>'product_code';
  if product_row.product_code is null or product_row.product_type<>'credit_pack' then
    raise exception 'CREDIT_PACK_PRODUCT_NOT_FOUND';
  end if;

  grant_key:='credit-pack:'||payment_row.id::text;
  grant_evidence:=jsonb_build_object(
    'evidenceType','verified_credit_pack_payment',
    'provider','flutterwave',
    'evidenceId',p_provider_transaction_id,
    'evidenceReference',payment_row.tx_ref,
    'paymentId',payment_row.id,
    'productCode',payment_row.metadata->>'product_code',
    'productVersion',product_version,
    'amountMinor',payment_row.amount_minor,
    'currency',payment_row.currency,
    'creditUnits',credit_units,
    'verifiedAt',p_verified_at
  );

  update executive_visuals.payment_transactions
     set status='successful',
         provider_transaction_id=p_provider_transaction_id,
         paid_at=coalesce(paid_at,p_verified_at),
         verified_at=p_verified_at,
         metadata=metadata||jsonb_build_object(
           'credit_pack_applied',true,
           'credit_pack_grant_idempotency_key',grant_key,
           'credit_pack_verified_at',p_verified_at
         ),
         updated_at=now()
   where id=payment_row.id;

  select * into grant_result
    from executive_visuals.grant_generation_credits(
      payment_row.owner_id,
      credit_units,
      grant_key,
      'Purchased AI-generation credit pack: '||left(payment_row.metadata->>'product_code',100),
      grant_evidence
    );
  if grant_result.ledger_id is null then
    raise exception 'CREDIT_PACK_GRANT_FAILED';
  end if;

  update executive_visuals.payment_transactions
     set metadata=metadata||jsonb_build_object(
       'credit_pack_grant_ledger_id',grant_result.ledger_id,
       'credit_pack_balance_after',grant_result.balance
     )
   where id=payment_row.id;

  return jsonb_build_object(
    'paymentId',payment_row.id,
    'status','successful',
    'creditUnits',credit_units,
    'ledgerId',grant_result.ledger_id,
    'balance',grant_result.balance,
    'idempotentReplay',false
  );
end;
$finalize_credit_pack_purchase$;

revoke all on function executive_visuals.finalize_credit_pack_purchase(uuid,text,jsonb,timestamptz)
  from public,anon,authenticated;
grant execute on function executive_visuals.finalize_credit_pack_purchase(uuid,text,jsonb,timestamptz)
  to service_role;
