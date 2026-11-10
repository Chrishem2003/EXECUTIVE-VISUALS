-- Batch 40: cash positions, dated flows and scenario outputs on disposable PostgreSQL.
reset role;
insert into auth.users(id,email) values
 ('99999999-9999-4999-8999-999999999999','batch40-admin@example.invalid')
on conflict(id) do nothing;
insert into executive_visuals.platform_admins(user_id,role,reason)
values('99999999-9999-4999-8999-999999999999','owner','Batch 40 disposable integration test')
on conflict(user_id) do update set role='owner';
set role service_role;
do $batch40$
declare
 v_actor constant uuid:='99999999-9999-4999-8999-999999999999';
 v_position jsonb;
 v_item jsonb;
 v_report jsonb;
 v_base jsonb;
 v_downside jsonb;
 v_upside jsonb;
 v_horizon jsonb;
 v_replay jsonb;
begin
 v_position:=executive_visuals.record_financial_cash_position(v_actor,jsonb_build_object(
  'currency','ZZZ','availableCashMinor',1000000,'restrictedCashMinor',200000,'asOfDate',current_date,
  'sourceType','bank_statement','sourceReference','batch40-bank-statement','evidenceNote','Disposable reconciled test balance',
  'idempotencyKey','batch40-position-001'));
 if (v_position->>'availableCashMinor')::bigint<>1000000 then raise exception 'Cash position was not persisted: %',v_position; end if;
 v_replay:=executive_visuals.record_financial_cash_position(v_actor,jsonb_build_object(
  'currency','ZZZ','availableCashMinor',1,'restrictedCashMinor',0,'asOfDate',current_date,
  'sourceType','bank_statement','sourceReference','different-replay','evidenceNote','Idempotency replay must preserve original',
  'idempotencyKey','batch40-position-001'));
 if (v_replay->>'availableCashMinor')::bigint<>1000000 then raise exception 'Cash position idempotency replay changed source evidence: %',v_replay; end if;
 begin
  update executive_visuals.financial_cash_position_snapshots set available_cash_minor=0 where id=(v_position->>'id')::uuid;
  raise exception 'Append-only cash position evidence accepted an update';
 exception when sqlstate '55000' then null;
 end;
 v_item:=executive_visuals.record_financial_cashflow_item(v_actor,jsonb_build_object(
  'direction','inflow','currency','ZZZ','amountMinor',300000,'expectedDate',current_date+30,'confidenceBps',5000,
  'status','committed','sourceType','customer_receipt','sourceReference','batch40-invoice-30','description','Confidence-weighted receipt',
  'idempotencyKey','batch40-flow-001'));
 if (v_item->>'confidenceBps')::integer<>5000 then raise exception 'Cashflow item was not persisted: %',v_item; end if;
 perform executive_visuals.record_financial_cashflow_item(v_actor,jsonb_build_object(
  'direction','outflow','currency','ZZZ','amountMinor',400000,'expectedDate',current_date+30,'confidenceBps',10000,
  'status','committed','sourceType','payroll','sourceReference','batch40-payroll-30','description','Payroll due',
  'idempotencyKey','batch40-flow-002'));
 perform executive_visuals.record_financial_cashflow_item(v_actor,jsonb_build_object(
  'direction','outflow','currency','ZZZ','amountMinor',1200000,'expectedDate',current_date+60,'confidenceBps',10000,
  'status','planned','sourceType','vendor_bill','sourceReference','batch40-vendor-60','description','Large vendor payment',
  'idempotencyKey','batch40-flow-003'));
 v_report:=executive_visuals.financial_cashflow_forecast_overview(v_actor);
 select scenario_row.value into v_base from jsonb_array_elements(v_report->'scenarios') as scenario_row(value) where scenario_row.value->>'currency'='ZZZ' and scenario_row.value->>'scenario'='base';
 select scenario_row.value into v_downside from jsonb_array_elements(v_report->'scenarios') as scenario_row(value) where scenario_row.value->>'currency'='ZZZ' and scenario_row.value->>'scenario'='downside';
 select scenario_row.value into v_upside from jsonb_array_elements(v_report->'scenarios') as scenario_row(value) where scenario_row.value->>'currency'='ZZZ' and scenario_row.value->>'scenario'='upside';
 if v_base is null or v_downside is null or v_upside is null then raise exception 'Scenario set incomplete: %',v_report->'scenarios'; end if;
 if (v_base->>'runwayDays')::integer<>120 or (v_base->>'netBurn30Minor')::bigint<>250000 then raise exception 'Base runway estimate incorrect: %',v_base; end if;
 if (v_base->>'openingAvailableCashMinor')::bigint<>1000000 or (v_base->>'restrictedCashMinor')::bigint<>200000 then
  raise exception 'Available/restricted cash boundary incorrect: %',v_base;
 end if;
 select horizon_row.value into v_horizon from jsonb_array_elements(v_base->'horizons') as horizon_row(value) where horizon_row.value->>'days'='30';
 if (v_horizon->>'projectedClosingMinor')::bigint<>750000 then raise exception 'Base 30-day cash forecast incorrect: %',v_horizon; end if;
 select horizon_row.value into v_horizon from jsonb_array_elements(v_downside->'horizons') as horizon_row(value) where horizon_row.value->>'days'='30';
 if (v_horizon->>'projectedClosingMinor')::bigint<>680000 then raise exception 'Downside 30-day cash forecast incorrect: %',v_horizon; end if;
 select horizon_row.value into v_horizon from jsonb_array_elements(v_upside->'horizons') as horizon_row(value) where horizon_row.value->>'days'='30';
 if (v_horizon->>'projectedClosingMinor')::bigint<>765000 then raise exception 'Upside 30-day cash forecast incorrect: %',v_horizon; end if;
 select horizon_row.value into v_horizon from jsonb_array_elements(v_base->'horizons') as horizon_row(value) where horizon_row.value->>'days'='60';
 if (v_horizon->>'projectedClosingMinor')::bigint<>-450000 or (v_horizon->>'liquidityShortfall')::boolean is not true then
  raise exception '60-day liquidity shortfall not identified: %',v_horizon;
 end if;
 if jsonb_array_length(v_base->'weekly')<>13 or jsonb_array_length(v_base->'monthly')<>6 then
  raise exception 'Weekly/monthly rolling forecast periods missing: %',v_base;
 end if;
 if jsonb_array_length(v_report->'items')<>3 then raise exception 'Expected three scheduled cashflow items: %',v_report->'items'; end if;
end $batch40$;
reset role;
