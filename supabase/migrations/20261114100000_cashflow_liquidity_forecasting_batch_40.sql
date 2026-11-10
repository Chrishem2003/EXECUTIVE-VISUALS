-- Batch 40: evidence-backed cash positions, dated cash commitments and scenario forecasts.
create table if not exists executive_visuals.financial_cash_position_snapshots(
 id uuid primary key default gen_random_uuid(),
 actor_id uuid not null references auth.users(id) on delete restrict,
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 available_cash_minor bigint not null check(available_cash_minor>=0),
 restricted_cash_minor bigint not null default 0 check(restricted_cash_minor>=0),
 as_of_date date not null,
 source_type text not null check(source_type in('bank_statement','bank_portal','cashbook','manual_attestation','other')),
 source_reference text not null check(length(trim(source_reference)) between 3 and 240),
 evidence_note text not null check(length(trim(evidence_note)) between 3 and 1000),
 idempotency_key text not null unique check(length(idempotency_key) between 8 and 160),
 created_at timestamptz not null default now()
);
create index if not exists financial_cash_position_currency_date_idx
 on executive_visuals.financial_cash_position_snapshots(currency,as_of_date desc,created_at desc);

create table if not exists executive_visuals.financial_cashflow_items(
 id uuid primary key default gen_random_uuid(),
 actor_id uuid not null references auth.users(id) on delete restrict,
 direction text not null check(direction in('inflow','outflow')),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 amount_minor bigint not null check(amount_minor>0),
 expected_date date not null,
 confidence_bps integer not null default 10000 check(confidence_bps between 0 and 10000),
 status text not null check(status in('planned','committed','received','paid','cancelled')),
 source_type text not null check(source_type in('customer_receipt','subscription_collection','invoice','vendor_bill','payroll','infrastructure','tax','debt_service','capital_expenditure','other')),
 source_reference text not null check(length(trim(source_reference)) between 3 and 240),
 description text not null check(length(trim(description)) between 3 and 500),
 idempotency_key text not null unique check(length(idempotency_key) between 8 and 160),
 created_at timestamptz not null default now()
);
create index if not exists financial_cashflow_expected_date_idx
 on executive_visuals.financial_cashflow_items(currency,expected_date,status,direction);

create or replace function executive_visuals.record_financial_cash_position(p_actor_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_row financial_cash_position_snapshots%rowtype;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 insert into financial_cash_position_snapshots(actor_id,currency,available_cash_minor,restricted_cash_minor,as_of_date,source_type,source_reference,evidence_note,idempotency_key)
 values(p_actor_id,upper(p_payload->>'currency'),(p_payload->>'availableCashMinor')::bigint,coalesce((p_payload->>'restrictedCashMinor')::bigint,0),
  (p_payload->>'asOfDate')::date,p_payload->>'sourceType',trim(p_payload->>'sourceReference'),trim(p_payload->>'evidenceNote'),p_payload->>'idempotencyKey')
 on conflict(idempotency_key) do nothing;
 select * into v_row from financial_cash_position_snapshots where idempotency_key=p_payload->>'idempotencyKey';
 if v_row.actor_id<>p_actor_id then raise exception 'Cash position idempotency key belongs to another actor' using errcode='23505'; end if;
 return jsonb_build_object('id',v_row.id,'currency',v_row.currency,'availableCashMinor',v_row.available_cash_minor,
  'restrictedCashMinor',v_row.restricted_cash_minor,'asOfDate',v_row.as_of_date,'sourceType',v_row.source_type,'createdAt',v_row.created_at);
end $$;

create or replace function executive_visuals.record_financial_cashflow_item(p_actor_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_row financial_cashflow_items%rowtype;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 insert into financial_cashflow_items(actor_id,direction,currency,amount_minor,expected_date,confidence_bps,status,source_type,source_reference,description,idempotency_key)
 values(p_actor_id,p_payload->>'direction',upper(p_payload->>'currency'),(p_payload->>'amountMinor')::bigint,(p_payload->>'expectedDate')::date,
  coalesce((p_payload->>'confidenceBps')::integer,10000),p_payload->>'status',p_payload->>'sourceType',
  trim(p_payload->>'sourceReference'),trim(p_payload->>'description'),p_payload->>'idempotencyKey')
 on conflict(idempotency_key) do nothing;
 select * into v_row from financial_cashflow_items where idempotency_key=p_payload->>'idempotencyKey';
 if v_row.actor_id<>p_actor_id then raise exception 'Cashflow idempotency key belongs to another actor' using errcode='23505'; end if;
 return jsonb_build_object('id',v_row.id,'direction',v_row.direction,'currency',v_row.currency,'amountMinor',v_row.amount_minor,
  'expectedDate',v_row.expected_date,'confidenceBps',v_row.confidence_bps,'status',v_row.status,'sourceType',v_row.source_type);
end $$;

create or replace function executive_visuals.prevent_financial_cash_evidence_mutation()
returns trigger language plpgsql
set search_path=pg_catalog,executive_visuals
as $
begin
 raise exception 'Cash position and cashflow evidence is append-only; create a correcting evidence record instead.' using errcode='55000';
end $;
drop trigger if exists financial_cash_position_immutable on executive_visuals.financial_cash_position_snapshots;
create trigger financial_cash_position_immutable before update or delete on executive_visuals.financial_cash_position_snapshots
 for each row execute function executive_visuals.prevent_financial_cash_evidence_mutation();
drop trigger if exists financial_cashflow_item_immutable on executive_visuals.financial_cashflow_items;
create trigger financial_cashflow_item_immutable before update or delete on executive_visuals.financial_cashflow_items
 for each row execute function executive_visuals.prevent_financial_cash_evidence_mutation();

create or replace function executive_visuals.financial_cashflow_forecast_overview(p_actor_id uuid)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_result jsonb;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 with latest_positions as(
  select distinct on(currency) currency,available_cash_minor,restricted_cash_minor,as_of_date,source_type,source_reference,created_at
  from financial_cash_position_snapshots order by currency,as_of_date desc,created_at desc
 ), scenarios as(
  select * from (values
   ('base',10000::integer,10000::integer),
   ('downside',8000::integer,11000::integer),
   ('upside',11000::integer,10000::integer)
  ) s(name,inflow_factor_bps,outflow_factor_bps)
 ), currencies as(
  select p.*,sc.name scenario,sc.inflow_factor_bps,sc.outflow_factor_bps
  from latest_positions p cross join scenarios sc
 ), weekly_periods as(
  select c.currency,c.scenario,c.available_cash_minor,c.restricted_cash_minor,c.as_of_date,c.inflow_factor_bps,c.outflow_factor_bps,
   (c.as_of_date+(n*7))::date period_end,n period_number
  from currencies c cross join generate_series(1,13) n
 ), weekly_flows as(
  select w.*,coalesce(sum(case when i.direction='inflow' then round(i.amount_minor::numeric*i.confidence_bps/10000*w.inflow_factor_bps/10000) else 0 end),0)::bigint expected_inflows_minor,
   coalesce(sum(case when i.direction='outflow' then round(i.amount_minor::numeric*w.outflow_factor_bps/10000) else 0 end),0)::bigint expected_outflows_minor
  from weekly_periods w left join financial_cashflow_items i on i.currency=w.currency and i.expected_date>w.as_of_date and i.expected_date<=w.period_end and i.status in('planned','committed')
  group by w.currency,w.scenario,w.available_cash_minor,w.restricted_cash_minor,w.as_of_date,w.inflow_factor_bps,w.outflow_factor_bps,w.period_end,w.period_number
 ), weekly_rows as(
  select w.*,w.available_cash_minor+sum(w.expected_inflows_minor-w.expected_outflows_minor) over(partition by w.currency,w.scenario order by w.period_number) projected_closing_minor
  from weekly_flows w
 ), monthly_periods as(
  select c.currency,c.scenario,c.available_cash_minor,c.restricted_cash_minor,c.as_of_date,c.inflow_factor_bps,c.outflow_factor_bps,
   case when n=0 then c.as_of_date+1 else (date_trunc('month',c.as_of_date+1)+make_interval(months=>n))::date end period_start,
   (date_trunc('month',c.as_of_date+1)+make_interval(months=>n+1)-interval '1 day')::date period_end,n+1 period_number
  from currencies c cross join generate_series(0,5) n
 ), monthly_flows as(
  select m.*,coalesce(sum(case when i.direction='inflow' then round(i.amount_minor::numeric*i.confidence_bps/10000*m.inflow_factor_bps/10000) else 0 end),0)::bigint expected_inflows_minor,
   coalesce(sum(case when i.direction='outflow' then round(i.amount_minor::numeric*m.outflow_factor_bps/10000) else 0 end),0)::bigint expected_outflows_minor
  from monthly_periods m left join financial_cashflow_items i on i.currency=m.currency and i.expected_date>=m.period_start and i.expected_date<=m.period_end and i.status in('planned','committed')
  group by m.currency,m.scenario,m.available_cash_minor,m.restricted_cash_minor,m.as_of_date,m.inflow_factor_bps,m.outflow_factor_bps,m.period_start,m.period_end,m.period_number
 ), monthly_rows as(
  select m.*,m.available_cash_minor+sum(m.expected_inflows_minor-m.expected_outflows_minor) over(partition by m.currency,m.scenario order by m.period_number) projected_closing_minor
  from monthly_flows m
 ), horizons as(
  select c.currency,c.scenario,c.available_cash_minor,c.restricted_cash_minor,c.as_of_date,
   d.days,(c.as_of_date+d.days)::date horizon_date,c.inflow_factor_bps,c.outflow_factor_bps
  from currencies c cross join (values(30),(60),(90),(180)) d(days)
 ), horizon_rows as(
  select h.currency,h.scenario,h.available_cash_minor,h.restricted_cash_minor,h.as_of_date,h.days,h.horizon_date,
   h.available_cash_minor+coalesce(sum(case when i.direction='inflow' then round(i.amount_minor::numeric*i.confidence_bps/10000*h.inflow_factor_bps/10000)
    else -round(i.amount_minor::numeric*h.outflow_factor_bps/10000) end),0)::bigint projected_closing_minor,
   coalesce(sum(case when i.direction='inflow' then round(i.amount_minor::numeric*i.confidence_bps/10000*h.inflow_factor_bps/10000) else 0 end),0)::bigint inflows_minor,
   coalesce(sum(case when i.direction='outflow' then round(i.amount_minor::numeric*h.outflow_factor_bps/10000) else 0 end),0)::bigint outflows_minor
  from horizons h left join financial_cashflow_items i on i.currency=h.currency and i.expected_date>h.as_of_date and i.expected_date<=h.horizon_date and i.status in('planned','committed')
  group by h.currency,h.scenario,h.available_cash_minor,h.restricted_cash_minor,h.as_of_date,h.days,h.horizon_date
 ), currency_scenarios as(
  select c.currency,c.scenario,c.available_cash_minor,c.restricted_cash_minor,c.as_of_date,
   coalesce((select jsonb_agg(jsonb_build_object('weekEnd',w.period_end,'week',w.period_number,'expectedInflowsMinor',w.expected_inflows_minor,
    'expectedOutflowsMinor',w.expected_outflows_minor,'projectedClosingMinor',w.projected_closing_minor) order by w.period_number)
    from weekly_rows w where w.currency=c.currency and w.scenario=c.scenario),'[]'::jsonb) weekly,
   coalesce((select jsonb_agg(jsonb_build_object('periodStart',m.period_start,'periodEnd',m.period_end,'expectedInflowsMinor',m.expected_inflows_minor,
    'expectedOutflowsMinor',m.expected_outflows_minor,'projectedClosingMinor',m.projected_closing_minor) order by m.period_number)
    from monthly_rows m where m.currency=c.currency and m.scenario=c.scenario),'[]'::jsonb) monthly,
   coalesce((select jsonb_agg(jsonb_build_object('days',h.days,'date',h.horizon_date,'inflowsMinor',h.inflows_minor,'outflowsMinor',h.outflows_minor,
    'projectedClosingMinor',h.projected_closing_minor,'liquidityShortfall',h.projected_closing_minor<0) order by h.days)
    from horizon_rows h where h.currency=c.currency and h.scenario=c.scenario),'[]'::jsonb) horizons,
   (select min(w.week_end) from (select period_end week_end,projected_closing_minor from weekly_rows where currency=c.currency and scenario=c.scenario) w where w.projected_closing_minor<0) first_shortfall
  from currencies c
 )
 select jsonb_build_object('generatedAt',now(),'scenarios',coalesce((select jsonb_agg(jsonb_build_object(
  'currency',cs.currency,'scenario',cs.scenario,'openingAvailableCashMinor',cs.available_cash_minor,
  'restrictedCashMinor',cs.restricted_cash_minor,'asOfDate',cs.as_of_date,
  'positionAgeDays',(current_date-cs.as_of_date),'positionSource','captured_cash_position',
  'weekly',cs.weekly,'monthly',cs.monthly,'horizons',cs.horizons,'firstProjectedShortfallDate',cs.first_shortfall,
  'netBurn30Minor',(select h.outflows_minor-h.inflows_minor from horizon_rows h where h.currency=cs.currency and h.scenario=cs.scenario and h.days=30),
  'runwayDays',case when current_date-cs.as_of_date<=14 and
   (select h.outflows_minor-h.inflows_minor from horizon_rows h where h.currency=cs.currency and h.scenario=cs.scenario and h.days=30)>0
   then floor(cs.available_cash_minor::numeric*30/(select h.outflows_minor-h.inflows_minor from horizon_rows h where h.currency=cs.currency and h.scenario=cs.scenario and h.days=30))::integer else null end,
  'assumptions',jsonb_build_object('receiptConfidenceApplied',true,'baseInflowMultiplierBps',case cs.scenario when 'downside' then 8000 when 'upside' then 11000 else 10000 end,
   'outflowMultiplierBps',case cs.scenario when 'downside' then 11000 else 10000 end)
 ) order by cs.currency,case cs.scenario when 'base' then 1 when 'downside' then 2 else 3 end) from currency_scenarios cs),'[]'::jsonb),
 'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'direction',i.direction,'currency',i.currency,'amountMinor',i.amount_minor,
  'expectedDate',i.expected_date,'confidenceBps',i.confidence_bps,'status',i.status,'sourceType',i.source_type,'sourceReference',i.source_reference,'description',i.description)
  order by i.expected_date,i.currency) from financial_cashflow_items i where i.status in('planned','committed') and i.expected_date>=current_date and i.expected_date<=current_date+180),'[]'::jsonb),
 'positions',coalesce((select jsonb_agg(jsonb_build_object('currency',p.currency,'availableCashMinor',p.available_cash_minor,
  'restrictedCashMinor',p.restricted_cash_minor,'asOfDate',p.as_of_date,'sourceType',p.source_type,'sourceReference',p.source_reference)
  order by p.currency) from latest_positions p),'[]'::jsonb),
 'limitations',jsonb_build_array(
  'Forecasts are scenario models from manually captured, evidence-referenced cash positions and dated planned or committed items; no bank connection is assumed.',
  'MRR, invoices, recognized revenue and payment initiation are not treated as cash receipts unless an expected receipt is explicitly entered.',
  'Restricted cash is excluded from available liquidity.',
  'Receipt confidence is applied before scenario receipt multipliers; outflow scenarios apply a separate stress multiplier.',
  'Forecasts are not accounting statements, financing commitments or guarantees. Validate bank balances and due dates before decisions.',
  'A cash position older than 14 days is flagged as stale and should be refreshed before relying on runway or shortfall dates.'
 )) into v_result;
 return v_result;
end $$;

revoke all on table executive_visuals.financial_cash_position_snapshots,executive_visuals.financial_cashflow_items from public,anon,authenticated;
grant all on table executive_visuals.financial_cash_position_snapshots,executive_visuals.financial_cashflow_items to service_role;
revoke all on function executive_visuals.prevent_financial_cash_evidence_mutation() from public,anon,authenticated;
grant execute on function executive_visuals.prevent_financial_cash_evidence_mutation() to service_role;
revoke all on function executive_visuals.record_financial_cash_position(uuid,jsonb) from public,anon,authenticated;
revoke all on function executive_visuals.record_financial_cashflow_item(uuid,jsonb) from public,anon,authenticated;
revoke all on function executive_visuals.financial_cashflow_forecast_overview(uuid) from public,anon,authenticated;
grant execute on function executive_visuals.record_financial_cash_position(uuid,jsonb) to service_role;
grant execute on function executive_visuals.record_financial_cashflow_item(uuid,jsonb) to service_role;
grant execute on function executive_visuals.financial_cashflow_forecast_overview(uuid) to service_role;
