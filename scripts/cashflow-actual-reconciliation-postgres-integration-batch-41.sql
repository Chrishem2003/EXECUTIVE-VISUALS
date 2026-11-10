-- Batch 41: actual cash movement evidence and forecast-to-actual reconciliation.
reset role;
insert into auth.users(id,email) values
 ('99999999-9999-4999-8999-999999999999','batch41-admin@example.invalid')
on conflict(id) do nothing;
insert into executive_visuals.platform_admins(user_id,role,reason)
values('99999999-9999-4999-8999-999999999999','owner','Batch 41 disposable integration test')
on conflict(user_id) do update set role='owner';
set role service_role;
do $batch41$
declare
 v_actor constant uuid:='99999999-9999-4999-8999-999999999999';
 v_item jsonb;
 v_actual jsonb;
 v_replay jsonb;
 v_report jsonb;
 v_row jsonb;
 v_currency jsonb;
begin
 v_item:=executive_visuals.record_financial_cashflow_item(v_actor,jsonb_build_object(
  'direction','inflow','currency','UGX','amountMinor',100000,'expectedDate',current_date,'confidenceBps',8000,
  'status','committed','sourceType','customer_receipt','sourceReference','batch41-invoice-001',
  'description','Expected customer collection','idempotencyKey','batch41-item-001'));
 v_actual:=executive_visuals.record_financial_cashflow_actual(v_actor,jsonb_build_object(
  'cashflowItemId',v_item->>'id','amountMinor',40000,'actualDate',current_date,'sourceType','bank_statement',
  'sourceReference','batch41-bank-line-001','evidenceNote','First partial receipt matched to customer invoice',
  'idempotencyKey','batch41-actual-001'));
 if (v_actual->>'amountMinor')::bigint<>40000 then raise exception 'First actual movement was not persisted: %',v_actual; end if;
 v_replay:=executive_visuals.record_financial_cashflow_actual(v_actor,jsonb_build_object(
  'cashflowItemId',v_item->>'id','amountMinor',40000,'actualDate',current_date,'sourceType','bank_statement',
  'sourceReference','batch41-bank-line-001','evidenceNote','First partial receipt matched to customer invoice',
  'idempotencyKey','batch41-actual-001'));
 if v_replay->>'id'<>v_actual->>'id' then raise exception 'Idempotent actual replay created a duplicate: %',v_replay; end if;
 v_report:=executive_visuals.financial_cashflow_reconciliation(v_actor,current_date,current_date);
 select item_row.value into v_row from jsonb_array_elements(v_report->'items') item_row(value) where item_row.value->>'id'=v_item->>'id';
 if v_row->>'settlementStatus'<>'partial' or (v_row->>'forecastAmountMinor')::bigint<>80000 or
  (v_row->>'actualAmountMinor')::bigint<>40000 or (v_row->>'remainingForecastMinor')::bigint<>40000 or
  (v_row->>'favorableVarianceMinor')::bigint<>-40000 then
  raise exception 'Partial settlement reconciliation is incorrect: %',v_row;
 end if;
 v_actual:=executive_visuals.record_financial_cashflow_actual(v_actor,jsonb_build_object(
  'cashflowItemId',v_item->>'id','amountMinor',50000,'actualDate',current_date,'sourceType','payment_confirmation',
  'sourceReference','batch41-bank-line-002','evidenceNote','Final receipt plus a small over-collection',
  'idempotencyKey','batch41-actual-002'));
 v_report:=executive_visuals.financial_cashflow_reconciliation(v_actor,current_date,current_date);
 select item_row.value into v_row from jsonb_array_elements(v_report->'items') item_row(value) where item_row.value->>'id'=v_item->>'id';
 if v_row->>'settlementStatus'<>'over_settled' or (v_row->>'actualAmountMinor')::bigint<>90000 or
  (v_row->>'favorableVarianceMinor')::bigint<>10000 or (v_row->>'actualCount')::integer<>2 then
  raise exception 'Over-settlement variance reconciliation is incorrect: %',v_row;
 end if;
 select currency_row.value into v_currency from jsonb_array_elements(v_report->'currencies') currency_row(value) where currency_row.value->>'currency'='UGX';
 if (v_currency->>'forecastAmountMinor')::bigint<>80000 or (v_currency->>'actualAmountMinor')::bigint<>90000 or
  (v_currency->>'favorableVarianceMinor')::bigint<>10000 then
  raise exception 'Currency reconciliation totals are incorrect: %',v_currency;
 end if;
 begin
  perform executive_visuals.record_financial_cashflow_actual(v_actor,jsonb_build_object(
   'cashflowItemId',v_item->>'id','amountMinor',41000,'actualDate',current_date,'sourceType','bank_statement',
   'sourceReference','different-payload','evidenceNote','Conflicting idempotency replay','idempotencyKey','batch41-actual-001'));
  raise exception 'Conflicting idempotency key replay was accepted';
 exception when sqlstate '23505' then null;
 end;
 begin
  update executive_visuals.financial_cashflow_actuals set amount_minor=1 where id=(v_actual->>'id')::uuid;
  raise exception 'Append-only actual evidence accepted an update';
 exception when sqlstate '55000' then null;
 end;
 begin
  perform executive_visuals.financial_cashflow_reconciliation(v_actor,current_date,current_date+400);
  raise exception 'Excessive reconciliation range was accepted';
 exception when sqlstate '22023' then null;
 end;
 begin
  perform executive_visuals.record_financial_cashflow_actual('88888888-8888-4888-8888-888888888888'::uuid,jsonb_build_object(
   'cashflowItemId',v_item->>'id','amountMinor',1000,'actualDate',current_date,'sourceType','bank_statement',
   'sourceReference','unauthorized','evidenceNote','Unauthorized test','idempotencyKey','batch41-unauthorized'));
  raise exception 'Unauthorized actual evidence write was accepted';
 exception when sqlstate '42501' then null;
 end;
end $batch41$;
reset role;
