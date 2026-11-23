-- Batch 104 integration: verified credit-pack settlement is atomic, owner-scoped and idempotent.
begin;
grant usage on schema executive_visuals to service_role;

insert into auth.users(id,email) values
 ('87777777-7777-4777-8777-777777777777','batch104-credit-pack@example.test')
on conflict(id) do nothing;

insert into executive_visuals.billing_products(
 product_code,name,description,product_type,amount_minor,currency,credit_units,version,active
) values(
 'batch104-test-pack','Batch 104 test pack','Disposable integration product',
 'credit_pack',5000,'UGX',1250,3,true
)
on conflict(product_code) do update set
 product_type=excluded.product_type,amount_minor=excluded.amount_minor,currency=excluded.currency,
 credit_units=excluded.credit_units,version=excluded.version,active=true;

insert into executive_visuals.payment_transactions(
 id,owner_id,provider,tx_ref,amount_minor,currency,status,payment_method,customer_email,description,metadata
) values
 ('88888888-8888-4888-8888-888888888888','87777777-7777-4777-8777-777777777777','flutterwave',
  'EV-CREDIT-PACK-TEST-001',5000,'UGX','pending','mobile_money','batch104-credit-pack@example.test',
  'Batch 104 test pack',
  jsonb_build_object('product_type','credit_pack','product_code','batch104-test-pack','product_version',3,
    'product_amount_minor',5000,'product_currency','UGX','credit_units',1250,'idempotency_key','batch104-credit-pack-key-001')),
 ('89999999-9999-4999-8999-999999999999','87777777-7777-4777-8777-777777777777','flutterwave',
  'EV-CREDIT-PACK-TEST-FAILED',5000,'UGX','failed','mobile_money','batch104-credit-pack@example.test',
  'Batch 104 failed pack',
  jsonb_build_object('product_type','credit_pack','product_code','batch104-test-pack','product_version',3,
    'product_amount_minor',5000,'product_currency','UGX','credit_units',1250,'idempotency_key','batch104-credit-pack-key-failed')),
 ('8aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','87777777-7777-4777-8777-777777777777','flutterwave',
  'EV-CREDIT-PACK-TEST-MISMATCH',5000,'UGX','pending','mobile_money','batch104-credit-pack@example.test',
  'Batch 104 mismatch pack',
  jsonb_build_object('product_type','credit_pack','product_code','batch104-test-pack','product_version',3,
    'product_amount_minor',5000,'product_currency','UGX','credit_units',1250,'idempotency_key','batch104-credit-pack-key-mismatch'));

-- A product can be retired after checkout; the already-created, paid order keeps its snapshot.
update executive_visuals.billing_products set active=false where product_code='batch104-test-pack';

set role service_role;
do $credit_pack_settlement_assertions$
declare
  settled jsonb;
  replay jsonb;
  rejected boolean:=false;
  grant_count integer;
  balance bigint;
begin
  settled:=executive_visuals.finalize_credit_pack_purchase(
    '88888888-8888-4888-8888-888888888888','chg-batch104-verified',
    jsonb_build_object('id','chg-batch104-verified','reference','EV-CREDIT-PACK-TEST-001',
      'amount',5000,'currency','UGX','status','succeeded'),now()
  );
  if settled->>'status'<>'successful' or (settled->>'creditUnits')::bigint<>1250 then
    raise exception 'Verified credit-pack payment did not grant the snapshotted credits';
  end if;
  select coalesce(sum(amount),0)::bigint into balance
    from executive_visuals.billing_credit_ledger
   where owner_id='87777777-7777-4777-8777-777777777777';
  if balance<>1250 then raise exception 'Credit-pack wallet balance mismatch: %',balance; end if;
  select count(*) into grant_count
    from executive_visuals.billing_credit_ledger
   where owner_id='87777777-7777-4777-8777-777777777777'
     and event_type='grant' and amount=1250
     and evidence->>'evidenceType'='verified_credit_pack_payment'
     and evidence->>'paymentId'='88888888-8888-4888-8888-888888888888';
  if grant_count<>1 then raise exception 'Verified credit-pack evidence was not recorded exactly once'; end if;

  replay:=executive_visuals.finalize_credit_pack_purchase(
    '88888888-8888-4888-8888-888888888888','chg-batch104-verified',
    jsonb_build_object('id','chg-batch104-verified','reference','EV-CREDIT-PACK-TEST-001',
      'amount',5000,'currency','UGX','status','succeeded'),now()
  );
  if replay->>'idempotentReplay'<>'true' then raise exception 'Credit-pack payment replay was not idempotent'; end if;
  select count(*) into grant_count from executive_visuals.billing_credit_ledger
   where owner_id='87777777-7777-4777-8777-777777777777' and event_type='grant';
  if grant_count<>1 then raise exception 'Credit-pack replay duplicated wallet credits'; end if;

  begin
    perform executive_visuals.finalize_credit_pack_purchase(
      '89999999-9999-4999-8999-999999999999','chg-batch104-failed',
      jsonb_build_object('reference','EV-CREDIT-PACK-TEST-FAILED','amount',5000,'currency','UGX','status','succeeded'),now()
    );
  exception when others then
    rejected:=true;
  end;
  if not rejected then raise exception 'Failed payment was incorrectly eligible for credit-pack settlement'; end if;

  rejected:=false;
  begin
    perform executive_visuals.finalize_credit_pack_purchase(
      '8aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chg-batch104-mismatch',
      jsonb_build_object('reference','EV-CREDIT-PACK-TEST-MISMATCH','amount',6000,'currency','UGX','status','succeeded'),now()
    );
  exception when others then
    rejected:=true;
  end;
  if not rejected then raise exception 'Mismatched provider amount was incorrectly accepted'; end if;

  select count(*) into grant_count from executive_visuals.billing_credit_ledger
   where owner_id='87777777-7777-4777-8777-777777777777';
  if grant_count<>1 then raise exception 'Rejected credit-pack payments changed the customer wallet'; end if;
end;
$credit_pack_settlement_assertions$;
reset role;
rollback;

select 'Batch 104 verified credit-pack generation wallet settlement passed' as result;
