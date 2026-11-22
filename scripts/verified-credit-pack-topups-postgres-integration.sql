-- Batch 65 integration test. Run only against disposable billing PostgreSQL.
begin;

insert into auth.users(id,email) values
 ('56565656-5656-4565-8565-565656565656','batch65-topup@example.test')
on conflict(id) do nothing;

insert into executive_visuals.billing_products(
  product_code,name,description,amount_minor,currency,credit_units,active
) values(
  'batch65-credit-pack','Batch 65 credit pack','Disposable integration fixture',15000,'UGX',5000,true
)
on conflict(product_code) do update set
  amount_minor=excluded.amount_minor,currency=excluded.currency,
  credit_units=excluded.credit_units,active=true,updated_at=now();

set role service_role;
do $batch65$
declare
  owner_id constant uuid:='56565656-5656-4565-8565-565656565656';
  payment_id uuid;
  reference text;
  result jsonb;
  replay jsonb;
  grant_count integer;
  invoice_count integer;
  outbox_count integer;
begin
  result:=executive_visuals.reserve_credit_pack_purchase(
    owner_id,'batch65-credit-pack','pesapal','batch65-topup@example.test',
    'batch65-topup-idempotency-0001','EVP-BATCH65-TOPUP-0001'
  );
  if result->>'status'<>'pending'
     or result->>'currency'<>'UGX'
     or (result->>'amountMinor')::bigint<>15000
     or (result->>'creditUnits')::bigint<>5000
     or result->>'idempotentReplay'<>'false' then
    raise exception 'Credit-pack reservation did not use the server-owned product price and credit amount';
  end if;
  payment_id:=(result->>'paymentId')::uuid;
  reference:=result->>'txRef';

  replay:=executive_visuals.reserve_credit_pack_purchase(
    owner_id,'batch65-credit-pack','pesapal','batch65-topup@example.test',
    'batch65-topup-idempotency-0001','EVP-BATCH65-TOPUP-0001'
  );
  if (replay->>'paymentId')::uuid<>payment_id or replay->>'idempotentReplay'<>'true' then
    raise exception 'Duplicate credit-pack reservation was not idempotent';
  end if;

  begin
    perform executive_visuals.finalize_credit_pack_purchase(
      payment_id,'pesapal-batch65-transaction-bad',
      jsonb_build_object('status','succeeded','amount_minor',14999,'currency','UGX','reference',reference),
      now()
    );
    raise exception 'Mismatched provider amount unexpectedly fulfilled a credit pack';
  exception when check_violation then
    null;
  end;

  if not exists(
    select 1 from executive_visuals.payment_transactions
    where id=payment_id and status='pending'
      and coalesce((metadata->>'credit_pack_applied')::boolean,false)=false
  ) then
    raise exception 'Rejected payment mismatch changed the pending payment';
  end if;
  if exists(select 1 from executive_visuals.credit_ledger where payment_transaction_id=payment_id) then
    raise exception 'Rejected payment mismatch granted credits';
  end if;

  result:=executive_visuals.finalize_credit_pack_purchase(
    payment_id,'pesapal-batch65-transaction-001',
    jsonb_build_object('status','succeeded','amount_minor',15000,'currency','UGX','reference',reference),
    now()
  );
  if result->>'status'<>'successful'
     or (result->>'creditUnits')::bigint<>5000
     or result->>'creditGrantInserted'<>'true'
     or not (result ? 'invoiceNumber') then
    raise exception 'Verified credit-pack purchase did not grant credits and issue invoice';
  end if;

  replay:=executive_visuals.finalize_credit_pack_purchase(
    payment_id,'pesapal-batch65-transaction-001',
    jsonb_build_object('status','succeeded','amount_minor',15000,'currency','UGX','reference',reference),
    now()
  );
  if replay->>'idempotentReplay'<>'true' then
    raise exception 'Duplicate verified top-up settlement was not idempotent';
  end if;

  select count(*) into grant_count from executive_visuals.credit_ledger
   where payment_transaction_id=payment_id and entry_type='purchase_grant'
     and credit_delta=5000;
  select count(*) into invoice_count from executive_visuals.billing_invoices
   where payment_transaction_id=payment_id;
  select count(*) into outbox_count from executive_visuals.billing_notification_outbox
   where dedupe_key='credit-pack-receipt:'||payment_id::text;

  if grant_count<>1 or invoice_count<>1 or outbox_count<>1 then
    raise exception 'Credit-pack grant, invoice or receipt outbox was duplicated or missing';
  end if;
end;
$batch65$;
reset role;
rollback;
