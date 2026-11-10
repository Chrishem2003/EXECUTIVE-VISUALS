-- Flutterwave v4 one-time UGX credit-pack checkout.
-- Staging only. No products are activated or priced by this migration.
create table if not exists executive_visuals.billing_products (
  id uuid primary key default gen_random_uuid(),
  product_code text not null unique check (product_code ~ '^[a-z0-9][a-z0-9_-]{2,59}$'),
  name text not null check (char_length(name) between 3 and 120),
  description text not null default '',
  product_type text not null default 'credit_pack' check (product_type in ('credit_pack')),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'UGX' check (currency = 'UGX'),
  credit_units bigint not null check (credit_units > 0),
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists billing_products_active_idx
  on executive_visuals.billing_products(active, product_code);

alter table executive_visuals.billing_products enable row level security;
revoke all on executive_visuals.billing_products from anon, authenticated;
grant select, insert, update, delete on executive_visuals.billing_products to service_role;

create unique index if not exists payment_transactions_owner_idempotency_uq
  on executive_visuals.payment_transactions(owner_id, (metadata->>'idempotency_key'))
  where metadata ? 'idempotency_key';

create or replace function executive_visuals.finalize_payment_purchase(
  p_payment_id uuid,
  p_provider_transaction_id text,
  p_provider_payload jsonb,
  p_verified_at timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = executive_visuals, public
as $$
declare
  payment_row executive_visuals.payment_transactions%rowtype;
  credit_units bigint;
  invoice_id uuid;
  invoice_no text;
  grant_rows integer := 0;
begin
  if p_payment_id is null or nullif(p_provider_transaction_id,'') is null
     or jsonb_typeof(coalesce(p_provider_payload,'{}'::jsonb)) <> 'object' then
    raise exception 'Invalid verified payment settlement input';
  end if;

  select * into payment_row
    from executive_visuals.payment_transactions
   where id = p_payment_id
   for update;

  if not found then raise exception 'Payment transaction not found'; end if;
  if payment_row.provider <> 'flutterwave' then raise exception 'Unsupported payment provider'; end if;
  if payment_row.provider_transaction_id is not null
     and payment_row.provider_transaction_id <> p_provider_transaction_id then
    raise exception 'Provider transaction ID mismatch';
  end if;

  credit_units := nullif(payment_row.metadata->>'credit_units','')::bigint;
  if credit_units is null or credit_units <= 0 then
    raise exception 'Purchase does not contain a valid server-owned credit entitlement';
  end if;

  if payment_row.status = 'successful' then
    if payment_row.provider_transaction_id <> p_provider_transaction_id then
      raise exception 'Successful payment cannot be rebound to another provider transaction';
    end if;
    return jsonb_build_object('payment_id',payment_row.id,'status','successful','already_fulfilled',true);
  end if;

  if payment_row.status <> 'pending' then
    raise exception 'Only pending payments can be fulfilled';
  end if;

  update executive_visuals.payment_transactions
     set status='successful',
         provider_transaction_id=p_provider_transaction_id,
         flw_ref=nullif(p_provider_payload->>'flw_ref',''),
         payment_method=coalesce(nullif(p_provider_payload#>>'{payment_method_details,type}',''),payment_method),
         provider_fee_minor=case
           when p_provider_payload ? 'fees' then null
           else provider_fee_minor end,
         paid_at=p_verified_at,
         verified_at=p_verified_at,
         metadata=metadata || jsonb_build_object('provider_verification',p_provider_payload),
         updated_at=now()
   where id=payment_row.id;

  insert into executive_visuals.credit_ledger
    (owner_id,entry_type,credit_delta,idempotency_key,payment_transaction_id,reason,metadata)
  values
    (payment_row.owner_id,'purchase_grant',credit_units,
     'purchase:'||payment_row.id::text,payment_row.id,
     'Verified Flutterwave credit-pack purchase',
     jsonb_build_object('product_code',payment_row.metadata->>'product_code','provider_transaction_id',p_provider_transaction_id))
  on conflict(owner_id,idempotency_key) do nothing;

  get diagnostics grant_rows = row_count;

  invoice_no := 'EV-' || to_char(p_verified_at at time zone 'UTC','YYYYMMDD') || '-' || upper(substr(replace(payment_row.id::text,'-',''),1,10));
  insert into executive_visuals.billing_invoices
    (owner_id,payment_transaction_id,invoice_number,currency,total_minor,snapshot)
  values
    (payment_row.owner_id,payment_row.id,invoice_no,payment_row.currency,payment_row.amount_minor,
     jsonb_build_object(
       'invoice_number',invoice_no,
       'product_code',payment_row.metadata->>'product_code',
       'description',payment_row.description,
       'amount_minor',payment_row.amount_minor,
       'currency',payment_row.currency,
       'credit_units',credit_units,
       'provider','flutterwave',
       'provider_transaction_id',p_provider_transaction_id,
       'issued_at',p_verified_at
     ))
  on conflict(payment_transaction_id) do nothing
  returning id into invoice_id;

  insert into executive_visuals.billing_notification_outbox
    (owner_id,notification_type,dedupe_key,payload)
  values
    (payment_row.owner_id,'payment_receipt','payment-receipt:'||payment_row.id::text,
     jsonb_build_object('payment_id',payment_row.id,'invoice_number',invoice_no,'amount_minor',payment_row.amount_minor,'currency',payment_row.currency))
  on conflict(dedupe_key) do nothing;

  return jsonb_build_object(
    'payment_id',payment_row.id,'status','successful',
    'credit_units',credit_units,'credit_grant_inserted',(grant_rows = 1),
    'invoice_number',invoice_no
  );
end;
$$;

revoke all on function executive_visuals.finalize_payment_purchase(uuid,text,jsonb,timestamptz) from public, anon, authenticated;
grant execute on function executive_visuals.finalize_payment_purchase(uuid,text,jsonb,timestamptz) to service_role;
