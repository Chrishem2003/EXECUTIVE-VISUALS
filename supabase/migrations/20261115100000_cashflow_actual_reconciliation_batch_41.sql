-- Batch 41: evidence-backed actual cash movements and forecast-to-actual reconciliation.
create table if not exists executive_visuals.financial_cashflow_actuals(
 id uuid primary key default gen_random_uuid(),
 actor_id uuid not null references auth.users(id) on delete restrict,
 cashflow_item_id uuid not null references executive_visuals.financial_cashflow_items(id) on delete restrict,
 amount_minor bigint not null check(amount_minor>0),
 actual_date date not null,
 source_type text not null check(source_type in('bank_statement','bank_portal','cashbook','payment_confirmation','receipt_confirmation','other')),
 source_reference text not null check(length(trim(source_reference)) between 3 and 240),
 evidence_note text not null check(length(trim(evidence_note)) between 3 and 1000),
 idempotency_key text not null unique check(length(idempotency_key) between 8 and 160),
 created_at timestamptz not null default now()
);
create index if not exists financial_cashflow_actual_item_date_idx
 on executive_visuals.financial_cashflow_actuals(cashflow_item_id,actual_date,created_at);

create or replace function executive_visuals.record_financial_cashflow_actual(p_actor_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare
 v_item financial_cashflow_items%rowtype;
 v_row financial_cashflow_actuals%rowtype;
 v_item_id uuid;
 v_amount bigint;
 v_date date;
 v_source text;
 v_reference text;
 v_note text;
 v_key text;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 v_item_id:=(p_payload->>'cashflowItemId')::uuid;
 v_amount:=(p_payload->>'amountMinor')::bigint;
 v_date:=(p_payload->>'actualDate')::date;
 v_source:=p_payload->>'sourceType';
 v_reference:=trim(p_payload->>'sourceReference');
 v_note:=trim(p_payload->>'evidenceNote');
 v_key:=p_payload->>'idempotencyKey';
 select * into v_item from financial_cashflow_items where id=v_item_id;
 if not found or v_item.actor_id<>p_actor_id or v_item.status not in('planned','committed') then
  raise exception 'An active cashflow item owned by this finance administrator is required' using errcode='22023';
 end if;
 if v_amount is null or v_amount<=0 or v_date is null or v_date>current_date or
  v_source not in('bank_statement','bank_portal','cashbook','payment_confirmation','receipt_confirmation','other') or
  length(v_reference) not between 3 and 240 or length(v_note) not between 3 and 1000 or length(v_key) not between 8 and 160 then
  raise exception 'Valid positive actual amount, non-future date, evidence and idempotency key are required' using errcode='22023';
 end if;
 insert into financial_cashflow_actuals(actor_id,cashflow_item_id,amount_minor,actual_date,source_type,source_reference,evidence_note,idempotency_key)
 values(p_actor_id,v_item_id,v_amount,v_date,v_source,v_reference,v_note,v_key)
 on conflict(idempotency_key) do nothing;
 select * into v_row from financial_cashflow_actuals where idempotency_key=v_key;
 if v_row.actor_id<>p_actor_id or v_row.cashflow_item_id<>v_item_id or v_row.amount_minor<>v_amount or
  v_row.actual_date<>v_date or v_row.source_type<>v_source or v_row.source_reference<>v_reference or v_row.evidence_note<>v_note then
  raise exception 'Actual cashflow idempotency key conflicts with existing evidence' using errcode='23505';
 end if;
 return jsonb_build_object('id',v_row.id,'cashflowItemId',v_row.cashflow_item_id,'amountMinor',v_row.amount_minor,
  'actualDate',v_row.actual_date,'sourceType',v_row.source_type,'sourceReference',v_row.source_reference,'createdAt',v_row.created_at);
end $$;

create or replace function executive_visuals.financial_cashflow_reconciliation(p_actor_id uuid,p_from_date date,p_to_date date)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_result jsonb;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_from_date is null or p_to_date is null or p_to_date<p_from_date or p_to_date-p_from_date>366 then
  raise exception 'Reconciliation date range must be ordered and no longer than 367 days' using errcode='22023';
 end if;
 with expected as(
  select i.id,i.direction,i.currency,i.amount_minor,i.expected_date,i.confidence_bps,i.status,i.source_type,i.source_reference,i.description,
   case when i.direction='inflow' then round(i.amount_minor::numeric*i.confidence_bps/10000)::bigint else i.amount_minor end forecast_amount_minor
  from financial_cashflow_items i
  where i.actor_id=p_actor_id and i.expected_date between p_from_date and p_to_date and i.status in('planned','committed')
 ), actuals as(
  select a.cashflow_item_id,sum(a.amount_minor)::bigint actual_amount_minor,max(a.actual_date) latest_actual_date,
   count(*)::integer actual_count,jsonb_agg(jsonb_build_object('id',a.id,'amountMinor',a.amount_minor,'actualDate',a.actual_date,
    'sourceType',a.source_type,'sourceReference',a.source_reference,'evidenceNote',a.evidence_note) order by a.actual_date,a.created_at) evidence
  from financial_cashflow_actuals a
  where a.actor_id=p_actor_id and exists(select 1 from expected e where e.id=a.cashflow_item_id)
  group by a.cashflow_item_id
 ), reconciliation_rows as(
  select e.*,coalesce(a.actual_amount_minor,0)::bigint actual_amount_minor,a.latest_actual_date,
   coalesce(a.actual_count,0) actual_count,coalesce(a.evidence,'[]'::jsonb) actual_evidence,
   (coalesce(a.actual_amount_minor,0)-e.forecast_amount_minor) amount_delta_minor,
   case when e.direction='inflow' then coalesce(a.actual_amount_minor,0)-e.forecast_amount_minor
    else e.forecast_amount_minor-coalesce(a.actual_amount_minor,0) end favorable_variance_minor,
   greatest(e.forecast_amount_minor-coalesce(a.actual_amount_minor,0),0)::bigint remaining_forecast_minor
  from expected e left join actuals a on a.cashflow_item_id=e.id
 )
 select jsonb_build_object(
  'generatedAt',now(),'fromDate',p_from_date,'toDate',p_to_date,
  'items',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'direction',r.direction,'currency',r.currency,
   'amountMinor',r.amount_minor,'forecastAmountMinor',r.forecast_amount_minor,'actualAmountMinor',r.actual_amount_minor,
   'amountDeltaMinor',r.amount_delta_minor,'favorableVarianceMinor',r.favorable_variance_minor,
   'remainingForecastMinor',r.remaining_forecast_minor,'expectedDate',r.expected_date,'latestActualDate',r.latest_actual_date,
   'latestActualDelayDays',case when r.latest_actual_date is not null then r.latest_actual_date-r.expected_date else null end,
   'actualCount',r.actual_count,'settlementStatus',case when r.actual_count=0 then 'not_recorded'
    when r.actual_amount_minor<r.forecast_amount_minor then 'partial' when r.actual_amount_minor=r.forecast_amount_minor then 'settled' else 'over_settled' end,
   'confidenceBps',r.confidence_bps,'status',r.status,'sourceType',r.source_type,'sourceReference',r.source_reference,
   'description',r.description,'actualEvidence',r.actual_evidence) order by r.expected_date,r.currency,r.id) from reconciliation_rows r),'[]'::jsonb),
  'currencies',coalesce((select jsonb_agg(jsonb_build_object('currency',c.currency,'forecastAmountMinor',c.forecast_minor,
   'actualAmountMinor',c.actual_minor,'amountDeltaMinor',c.actual_minor-c.forecast_minor,
   'favorableVarianceMinor',c.favorable_minor,'remainingForecastMinor',c.remaining_minor,'itemCount',c.item_count,
   'reconciledItemCount',c.reconciled_count) order by c.currency)
   from(select r.currency,sum(r.forecast_amount_minor)::bigint forecast_minor,sum(r.actual_amount_minor)::bigint actual_minor,
    sum(r.favorable_variance_minor)::bigint favorable_minor,sum(r.remaining_forecast_minor)::bigint remaining_minor,
    count(*)::integer item_count,count(*) filter(where r.actual_count>0)::integer reconciled_count from reconciliation_rows r group by r.currency)c),'[]'::jsonb),
  'limitations',jsonb_build_array(
   'Actual movements are manually recorded from evidence; no bank feed, payment initiation or automatic settlement matching is implied.',
   'Actuals are linked explicitly to a planned or committed cashflow item. Unmatched bank movements are not silently allocated.',
   'Inflow forecasts are confidence-adjusted; outflow forecasts use the full scheduled amount.',
   'Favorable variance is actual less forecast for receipts and forecast less actual for payments; positive values are favorable.',
   'Latest actual date is shown for partial settlements; timing variance is not a final settlement-delay measure until the item is fully settled.'
  )
 ) into v_result;
 return v_result;
end $$;

create or replace function executive_visuals.prevent_financial_cash_actual_mutation()
returns trigger language plpgsql
set search_path=pg_catalog,executive_visuals
as $$
begin
 raise exception 'Actual cash movement evidence is append-only; create a correcting evidence record instead.' using errcode='55000';
end $$;
drop trigger if exists financial_cashflow_actual_immutable on executive_visuals.financial_cashflow_actuals;
create trigger financial_cashflow_actual_immutable before update or delete on executive_visuals.financial_cashflow_actuals
 for each row execute function executive_visuals.prevent_financial_cash_actual_mutation();

revoke all on table executive_visuals.financial_cashflow_actuals from public,anon,authenticated;
grant all on table executive_visuals.financial_cashflow_actuals to service_role;
revoke all on function executive_visuals.prevent_financial_cash_actual_mutation() from public,anon,authenticated;
grant execute on function executive_visuals.prevent_financial_cash_actual_mutation() to service_role;
revoke all on function executive_visuals.record_financial_cashflow_actual(uuid,jsonb) from public,anon,authenticated;
revoke all on function executive_visuals.financial_cashflow_reconciliation(uuid,date,date) from public,anon,authenticated;
grant execute on function executive_visuals.record_financial_cashflow_actual(uuid,jsonb) to service_role;
grant execute on function executive_visuals.financial_cashflow_reconciliation(uuid,date,date) to service_role;
