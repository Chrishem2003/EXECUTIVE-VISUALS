-- Batch 22: provider invoice ingestion, append-only reconciliation evidence and cost anomaly analysis.
create table if not exists executive_visuals.ai_provider_invoice_reconciliation_events(
 id uuid primary key default gen_random_uuid(),
 invoice_import_id uuid not null references executive_visuals.ai_provider_invoice_imports(id) on delete restrict,
 invoice_line_id uuid not null references executive_visuals.ai_provider_invoice_lines(id) on delete restrict,
 usage_event_id uuid references executive_visuals.ai_usage_cost_events(id) on delete restrict,
 match_status text not null check(match_status in('matched','unmatched','ambiguous','variance')),
 candidate_count integer not null check(candidate_count>=0),
 expected_amount_minor bigint not null,
 observed_amount_minor bigint,
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 evidence jsonb not null default '{}'::jsonb,
 idempotency_key text not null unique,
 created_at timestamptz not null default now(),
 check((match_status='matched' and usage_event_id is not null and candidate_count=1 and observed_amount_minor=expected_amount_minor)
  or (match_status<>'matched' and usage_event_id is null))
);
create unique index if not exists ai_invoice_reconciliation_one_match_per_usage
 on executive_visuals.ai_provider_invoice_reconciliation_events(usage_event_id)
 where usage_event_id is not null;
create index if not exists ai_invoice_reconciliation_import_idx
 on executive_visuals.ai_provider_invoice_reconciliation_events(invoice_import_id,match_status);
create index if not exists ai_usage_invoice_reference_idx
 on executive_visuals.ai_usage_cost_events(provider,requested_model,currency,invoice_line_reference)
 where invoice_line_reference<>'';
alter table executive_visuals.ai_provider_invoice_reconciliation_events enable row level security;
revoke all on executive_visuals.ai_provider_invoice_reconciliation_events from public,anon,authenticated;
grant select,insert on executive_visuals.ai_provider_invoice_reconciliation_events to service_role;
create trigger ai_provider_invoice_reconciliation_immutable before update or delete
 on executive_visuals.ai_provider_invoice_reconciliation_events
 for each row execute function executive_visuals.reject_revenue_intelligence_mutation();

create or replace function executive_visuals.import_ai_provider_invoice(
 p_actor_id uuid,p_provider text,p_invoice_reference text,p_currency text,
 p_period_start date,p_period_end date,p_total_minor bigint,p_source_fingerprint text,p_lines jsonb
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_import_id uuid; v_existing ai_provider_invoice_imports%rowtype;
 v_count integer; v_sum numeric; v_line jsonb; v_ref text; v_amount bigint;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if coalesce(length(p_provider),0) not between 2 and 80 or p_provider !~ '^[a-z0-9][a-z0-9._-]{1,79}$'
  or coalesce(length(btrim(p_invoice_reference)),0) not between 1 and 180
  or coalesce(p_currency,'') !~ '^[A-Z]{3}$' or p_period_start is null or p_period_end is null or p_period_end<p_period_start
  or p_total_minor is null or p_total_minor<0 or coalesce(p_source_fingerprint,'') !~ '^[a-f0-9]{64}$'
  or case when jsonb_typeof(p_lines)='array' then not (jsonb_array_length(p_lines) between 1 and 5000) else true end then
  raise exception 'Invalid provider invoice import' using errcode='22023';
 end if;
 v_count:=jsonb_array_length(p_lines);
 for v_line in select value from jsonb_array_elements(p_lines) loop
  v_ref:=coalesce(v_line->>'lineReference','');
  if length(btrim(v_ref))<1 or length(v_ref)>180
   or coalesce(v_line->>'currency','')<>p_currency
   or coalesce(v_line->>'provider','')<>p_provider
   or coalesce(v_line->>'model','')='' or length(v_line->>'model')>160
   or coalesce(v_line->>'operation','') not in('text','image','video','render','upscale','audio','embedding','other')
   or coalesce(v_line->>'amountMinor','') !~ '^-?[0-9]{1,18}$'
   or coalesce(v_line->>'usagePeriod','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}
   raise exception 'Invoice contains an invalid line item' using errcode='22023';
  end if;
 end loop;
 select coalesce(sum((value->>'amountMinor')::numeric),0) into v_sum from jsonb_array_elements(p_lines);
 insert into ai_provider_invoice_imports(provider,invoice_reference,currency,period_start,period_end,total_minor,
  imported_line_count,matched_line_count,reconciliation_status,source_fingerprint,imported_by)
 values(p_provider,p_invoice_reference,p_currency,p_period_start,p_period_end,p_total_minor,v_count,0,
  case when v_sum=p_total_minor then 'pending' else 'variance' end,p_source_fingerprint,p_actor_id)
 on conflict(provider,invoice_reference,currency,source_fingerprint) do nothing returning id into v_import_id;
 if v_import_id is null then
  select * into v_existing from ai_provider_invoice_imports
   where provider=p_provider and invoice_reference=p_invoice_reference and currency=p_currency and source_fingerprint=p_source_fingerprint;
  return jsonb_build_object('importId',v_existing.id,'duplicate',true,'lineCount',v_existing.imported_line_count,
   'reconciliationStatus',v_existing.reconciliation_status);
 end if;
 for v_line in select value from jsonb_array_elements(p_lines) loop
  insert into ai_provider_invoice_lines(import_id,provider_line_reference,usage_period,owner_id,project_id,job_id,
   provider,model,operation,currency,amount_minor,usage_quantity,usage_unit)
  values(v_import_id,v_line->>'lineReference',(v_line->>'usagePeriod')::date,
   null,null,null,p_provider,v_line->>'model',v_line->>'operation',p_currency,(v_line->>'amountMinor')::bigint,
   nullif(v_line->>'usageQuantity','')::numeric,coalesce(v_line->>'usageUnit',''));
 end loop;
 perform write_financial_admin_audit(p_actor_id,'finance.ai_invoice.imported','ai_provider_invoice',v_import_id::text,
  'Imported provider invoice evidence',p_source_fingerprint,jsonb_build_object('provider',p_provider,'currency',p_currency,
  'lineCount',v_count,'invoiceTotalMinor',p_total_minor,'lineTotalMinor',v_sum,'reconciliationStatus',case when v_sum=p_total_minor then 'pending' else 'variance' end));
 return jsonb_build_object('importId',v_import_id,'duplicate',false,'lineCount',v_count,
  'invoiceTotalMinor',p_total_minor,'lineTotalMinor',v_sum,'reconciliationStatus',case when v_sum=p_total_minor then 'pending' else 'variance' end);
end $$;

create or replace function executive_visuals.reconcile_ai_provider_invoice(p_actor_id uuid,p_import_id uuid)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_import ai_provider_invoice_imports%rowtype; v_line ai_provider_invoice_lines%rowtype;
 v_candidates uuid[]; v_count integer; v_event ai_usage_cost_events%rowtype;
 v_status text; v_matched integer:=0; v_unmatched integer:=0; v_ambiguous integer:=0; v_variance integer:=0;
 v_key text;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 select * into v_import from ai_provider_invoice_imports where id=p_import_id;
 if not found then raise exception 'Invoice import not found' using errcode='P0002'; end if;
 if exists(select 1 from ai_provider_invoice_reconciliation_events where invoice_import_id=p_import_id) then
  select count(*) filter(where match_status='matched'),count(*) filter(where match_status='unmatched'),
   count(*) filter(where match_status='ambiguous'),count(*) filter(where match_status='variance')
   into v_matched,v_unmatched,v_ambiguous,v_variance
   from ai_provider_invoice_reconciliation_events where invoice_import_id=p_import_id;
  return jsonb_build_object('importId',p_import_id,'idempotentReplay',true,'matched',v_matched,
   'unmatched',v_unmatched,'ambiguous',v_ambiguous,'variance',v_variance,
   'reconciliationStatus',case when v_import.reconciliation_status='variance' then 'variance'
    when v_unmatched+v_ambiguous+v_variance>0 then 'review_required' else 'matched' end);
 end if;
 for v_line in select * from ai_provider_invoice_lines where import_id=p_import_id order by id loop
  select array_agg(id),count(*) into v_candidates,v_count from ai_usage_cost_events
   where provider=v_line.provider and requested_model=v_line.model and currency=v_line.currency
    and invoice_line_reference=v_line.provider_line_reference and cost_basis='provider_reported'
    and not exists(select 1 from ai_provider_invoice_reconciliation_events prior where prior.usage_event_id=ai_usage_cost_events.id);
  if coalesce(v_count,0)=0 then v_status:='unmatched';
  elsif v_count>1 then v_status:='ambiguous';
  else
   select * into v_event from ai_usage_cost_events where id=v_candidates[1];
   if v_event.cost_minor=v_line.amount_minor then v_status:='matched';
   else v_status:='variance';
   end if;
  end if;
  v_key:='ai-invoice-reconcile:'||p_import_id::text||':'||v_line.id::text;
  insert into ai_provider_invoice_reconciliation_events(invoice_import_id,invoice_line_id,usage_event_id,
   match_status,candidate_count,expected_amount_minor,observed_amount_minor,currency,evidence,idempotency_key)
  values(p_import_id,v_line.id,case when v_status='matched' then v_candidates[1] else null end,
   v_status,coalesce(v_count,0),v_line.amount_minor,
   case when v_count=1 then v_event.cost_minor else null end,v_line.currency,
   jsonb_build_object('matchMethod','exact_provider_line_reference','provider',v_line.provider,'model',v_line.model),
   v_key);
  if v_status='matched' then v_matched:=v_matched+1;
  elsif v_status='unmatched' then v_unmatched:=v_unmatched+1;
  elsif v_status='ambiguous' then v_ambiguous:=v_ambiguous+1;
  else v_variance:=v_variance+1;
  end if;
 end loop;
 return jsonb_build_object('importId',p_import_id,'idempotentReplay',false,'matched',v_matched,
  'unmatched',v_unmatched,'ambiguous',v_ambiguous,'variance',v_variance,
  'reconciliationStatus',case when v_import.reconciliation_status='variance' then 'variance'
   when v_unmatched+v_ambiguous+v_variance>0 then 'review_required' else 'matched' end);
end $$;

create or replace function executive_visuals.ai_cost_anomaly_report(
 p_actor_id uuid,p_period_month date default date_trunc('month',now())::date,
 p_min_cost_minor bigint default 100,p_spike_multiplier numeric default 2.0,p_failed_ratio numeric default 0.25
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_result jsonb;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_period_month is null or p_period_month<>date_trunc('month',p_period_month)::date
  or p_min_cost_minor<0 or p_spike_multiplier<1.1 or p_spike_multiplier>20
  or p_failed_ratio<0.05 or p_failed_ratio>1 then
  raise exception 'Invalid anomaly report parameters' using errcode='22023';
 end if;
 with daily as(
  select occurred_at::date day,provider,requested_model,currency,
   sum(cost_minor) filter(where cost_minor is not null)::numeric spend_minor,
   count(*) events,count(*) filter(where status='failed') failed_events,
   count(*) filter(where cost_basis='unpriced') unpriced_events
  from ai_usage_cost_events
  where occurred_at>=p_period_month-interval '30 days'
   and occurred_at<p_period_month+interval '1 month'
  group by occurred_at::date,provider,requested_model,currency
 ), anomalies as(
  select d.*,b.baseline,b.observations,
   case when d.spend_minor>=p_min_cost_minor and b.observations>=5 and d.spend_minor>greatest(b.baseline*p_spike_multiplier,p_min_cost_minor)
    then 'spend_spike'
    when d.spend_minor>=p_min_cost_minor and d.events>0 and d.failed_events::numeric/d.events>=p_failed_ratio
    then 'high_failed_operation_cost'
   end anomaly_type
  from daily d
  cross join lateral(
   select avg(prev.spend_minor) baseline,count(*) observations from daily prev
   where prev.provider=d.provider and prev.requested_model=d.requested_model
    and prev.currency=d.currency and prev.day<d.day and prev.day>=d.day-30
    and prev.spend_minor is not null and prev.spend_minor>0
  ) b
 ), unpriced as(
  select provider,requested_model,count(*) events from ai_usage_cost_events
  where period_month=p_period_month and cost_basis='unpriced'
  group by provider,requested_model
 ), invoice as(
  select i.provider,i.invoice_reference,i.currency,i.total_minor,i.reconciliation_status,
   count(r.id) filter(where r.match_status='unmatched')::integer unmatched_lines,
   count(r.id) filter(where r.match_status='ambiguous')::integer ambiguous_lines,
   count(r.id) filter(where r.match_status='variance')::integer variance_lines
  from ai_provider_invoice_imports i
  left join ai_provider_invoice_reconciliation_events r on r.invoice_import_id=i.id
  where i.period_start<p_period_month+interval '1 month' and i.period_end>=p_period_month
  group by i.id,i.provider,i.invoice_reference,i.currency,i.total_minor,i.reconciliation_status
  having i.reconciliation_status in('variance','review_required')
   or count(r.id) filter(where r.match_status<>'matched')>0
 )
 select jsonb_build_object('periodMonth',p_period_month,'generatedAt',now(),
  'spendAnomalies',coalesce((select jsonb_agg(jsonb_build_object('type',anomaly_type,'day',day,'provider',provider,
   'model',requested_model,'currency',currency,'spendMinor',spend_minor,'baselineMinor',round(baseline),
   'baselineDays',observations,'events',events,'failedEvents',failed_events)
   order by day desc) from anomalies where anomaly_type is not null),'[]'::jsonb),
  'unpricedUsage',coalesce((select jsonb_agg(to_jsonb(unpriced)) from unpriced),'[]'::jsonb),
  'invoiceExceptions',coalesce((select jsonb_agg(to_jsonb(invoice)) from invoice),'[]'::jsonb),
  'limitations',jsonb_build_array('Spend spike baseline uses prior observed days with known positive cost and requires at least five observations.',
   'Unpriced usage is surfaced but not assigned a fabricated amount.','Anomaly output is advisory and does not change provider routing or customer billing.')
 ) into v_result;
 return v_result;
end $$;

revoke all on function executive_visuals.import_ai_provider_invoice(uuid,text,text,text,date,date,bigint,text,jsonb) from public,anon,authenticated;
revoke all on function executive_visuals.reconcile_ai_provider_invoice(uuid,uuid) from public,anon,authenticated;
revoke all on function executive_visuals.ai_cost_anomaly_report(uuid,date,bigint,numeric,numeric) from public,anon,authenticated;
grant execute on function executive_visuals.import_ai_provider_invoice(uuid,text,text,text,date,date,bigint,text,jsonb) to service_role;
grant execute on function executive_visuals.reconcile_ai_provider_invoice(uuid,uuid) to service_role;
grant execute on function executive_visuals.ai_cost_anomaly_report(uuid,date,bigint,numeric,numeric) to service_role;

   or (v_line->>'usagePeriod')::date<p_period_start or (v_line->>'usagePeriod')::date>p_period_end then
   raise exception 'Invoice contains an invalid line item' using errcode='22023';
  end if;
 end loop;
 select coalesce(sum((value->>'amountMinor')::numeric),0) into v_sum from jsonb_array_elements(p_lines);
 insert into ai_provider_invoice_imports(provider,invoice_reference,currency,period_start,period_end,total_minor,
  imported_line_count,matched_line_count,reconciliation_status,source_fingerprint,imported_by)
 values(p_provider,p_invoice_reference,p_currency,p_period_start,p_period_end,p_total_minor,v_count,0,
  case when v_sum=p_total_minor then 'pending' else 'variance' end,p_source_fingerprint,p_actor_id)
 on conflict(provider,invoice_reference,currency,source_fingerprint) do nothing returning id into v_import_id;
 if v_import_id is null then
  select * into v_existing from ai_provider_invoice_imports
   where provider=p_provider and invoice_reference=p_invoice_reference and currency=p_currency and source_fingerprint=p_source_fingerprint;
  return jsonb_build_object('importId',v_existing.id,'duplicate',true,'lineCount',v_existing.imported_line_count,
   'reconciliationStatus',v_existing.reconciliation_status);
 end if;
 for v_line in select value from jsonb_array_elements(p_lines) loop
  insert into ai_provider_invoice_lines(import_id,provider_line_reference,usage_period,owner_id,project_id,job_id,
   provider,model,operation,currency,amount_minor,usage_quantity,usage_unit)
  values(v_import_id,v_line->>'lineReference',(v_line->>'usagePeriod')::date,
   null,null,null,p_provider,v_line->>'model',v_line->>'operation',p_currency,(v_line->>'amountMinor')::bigint,
   nullif(v_line->>'usageQuantity','')::numeric,coalesce(v_line->>'usageUnit',''));
 end loop;
 perform write_financial_admin_audit(p_actor_id,'finance.ai_invoice.imported','ai_provider_invoice',v_import_id::text,
  'Imported provider invoice evidence',p_source_fingerprint,jsonb_build_object('provider',p_provider,'currency',p_currency,
  'lineCount',v_count,'invoiceTotalMinor',p_total_minor,'lineTotalMinor',v_sum,'reconciliationStatus',case when v_sum=p_total_minor then 'pending' else 'variance' end));
 return jsonb_build_object('importId',v_import_id,'duplicate',false,'lineCount',v_count,
  'invoiceTotalMinor',p_total_minor,'lineTotalMinor',v_sum,'reconciliationStatus',case when v_sum=p_total_minor then 'pending' else 'variance' end);
end $$;

create or replace function executive_visuals.reconcile_ai_provider_invoice(p_actor_id uuid,p_import_id uuid)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_import ai_provider_invoice_imports%rowtype; v_line ai_provider_invoice_lines%rowtype;
 v_candidates uuid[]; v_count integer; v_event ai_usage_cost_events%rowtype;
 v_status text; v_matched integer:=0; v_unmatched integer:=0; v_ambiguous integer:=0; v_variance integer:=0;
 v_key text;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 select * into v_import from ai_provider_invoice_imports where id=p_import_id;
 if not found then raise exception 'Invoice import not found' using errcode='P0002'; end if;
 if exists(select 1 from ai_provider_invoice_reconciliation_events where invoice_import_id=p_import_id) then
  select count(*) filter(where match_status='matched'),count(*) filter(where match_status='unmatched'),
   count(*) filter(where match_status='ambiguous'),count(*) filter(where match_status='variance')
   into v_matched,v_unmatched,v_ambiguous,v_variance
   from ai_provider_invoice_reconciliation_events where invoice_import_id=p_import_id;
  return jsonb_build_object('importId',p_import_id,'idempotentReplay',true,'matched',v_matched,
   'unmatched',v_unmatched,'ambiguous',v_ambiguous,'variance',v_variance);
 end if;
 for v_line in select * from ai_provider_invoice_lines where import_id=p_import_id order by id loop
  select array_agg(id),count(*) into v_candidates,v_count from ai_usage_cost_events
   where provider=v_line.provider and requested_model=v_line.model and currency=v_line.currency
    and invoice_line_reference=v_line.provider_line_reference and cost_basis='provider_reported'
    and not exists(select 1 from ai_provider_invoice_reconciliation_events prior where prior.usage_event_id=ai_usage_cost_events.id);
  if coalesce(v_count,0)=0 then v_status:='unmatched';
  elsif v_count>1 then v_status:='ambiguous';
  else
   select * into v_event from ai_usage_cost_events where id=v_candidates[1];
   if v_event.cost_minor=v_line.amount_minor then v_status:='matched';
   else v_status:='variance';
   end if;
  end if;
  v_key:='ai-invoice-reconcile:'||p_import_id::text||':'||v_line.id::text;
  insert into ai_provider_invoice_reconciliation_events(invoice_import_id,invoice_line_id,usage_event_id,
   match_status,candidate_count,expected_amount_minor,observed_amount_minor,currency,evidence,idempotency_key)
  values(p_import_id,v_line.id,case when v_status='matched' then v_candidates[1] else null end,
   v_status,coalesce(v_count,0),v_line.amount_minor,
   case when v_count=1 then v_event.cost_minor else null end,v_line.currency,
   jsonb_build_object('matchMethod','exact_provider_line_reference','provider',v_line.provider,'model',v_line.model),
   v_key);
  if v_status='matched' then v_matched:=v_matched+1;
  elsif v_status='unmatched' then v_unmatched:=v_unmatched+1;
  elsif v_status='ambiguous' then v_ambiguous:=v_ambiguous+1;
  else v_variance:=v_variance+1;
  end if;
 end loop;
 return jsonb_build_object('importId',p_import_id,'idempotentReplay',false,'matched',v_matched,
  'unmatched',v_unmatched,'ambiguous',v_ambiguous,'variance',v_variance,
  'reconciliationStatus',case when v_unmatched+v_ambiguous+v_variance>0 then 'review_required' else 'matched' end);
end $$;

create or replace function executive_visuals.ai_cost_anomaly_report(
 p_actor_id uuid,p_period_month date default date_trunc('month',now())::date,
 p_min_cost_minor bigint default 100,p_spike_multiplier numeric default 2.0,p_failed_ratio numeric default 0.25
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_result jsonb;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_period_month is null or p_period_month<>date_trunc('month',p_period_month)::date
  or p_min_cost_minor<0 or p_spike_multiplier<1.1 or p_spike_multiplier>20
  or p_failed_ratio<0.05 or p_failed_ratio>1 then
  raise exception 'Invalid anomaly report parameters' using errcode='22023';
 end if;
 with daily as(
  select occurred_at::date day,provider,requested_model,currency,
   sum(cost_minor) filter(where cost_minor is not null)::numeric spend_minor,
   count(*) events,count(*) filter(where status='failed') failed_events,
   count(*) filter(where cost_basis='unpriced') unpriced_events
  from ai_usage_cost_events
  where occurred_at>=p_period_month-interval '30 days'
   and occurred_at<p_period_month+interval '1 month'
  group by occurred_at::date,provider,requested_model,currency
 ), anomalies as(
  select d.*,b.baseline,b.observations,
   case when d.spend_minor>=p_min_cost_minor and b.observations>=5 and d.spend_minor>greatest(b.baseline*p_spike_multiplier,p_min_cost_minor)
    then 'spend_spike'
    when d.spend_minor>=p_min_cost_minor and d.events>0 and d.failed_events::numeric/d.events>=p_failed_ratio
    then 'high_failed_operation_cost'
   end anomaly_type
  from daily d
  cross join lateral(
   select avg(prev.spend_minor) baseline,count(*) observations from daily prev
   where prev.provider=d.provider and prev.requested_model=d.requested_model
    and prev.currency=d.currency and prev.day<d.day and prev.day>=d.day-30
    and prev.spend_minor is not null and prev.spend_minor>0
  ) b
 ), unpriced as(
  select provider,requested_model,count(*) events from ai_usage_cost_events
  where period_month=p_period_month and cost_basis='unpriced'
  group by provider,requested_model
 ), invoice as(
  select i.provider,i.invoice_reference,i.currency,i.total_minor,i.reconciliation_status,
   count(r.id) filter(where r.match_status='unmatched')::integer unmatched_lines,
   count(r.id) filter(where r.match_status='ambiguous')::integer ambiguous_lines,
   count(r.id) filter(where r.match_status='variance')::integer variance_lines
  from ai_provider_invoice_imports i
  left join ai_provider_invoice_reconciliation_events r on r.invoice_import_id=i.id
  where i.period_start<p_period_month+interval '1 month' and i.period_end>=p_period_month
  group by i.id,i.provider,i.invoice_reference,i.currency,i.total_minor,i.reconciliation_status
  having i.reconciliation_status in('variance','review_required')
   or count(r.id) filter(where r.match_status<>'matched')>0
 )
 select jsonb_build_object('periodMonth',p_period_month,'generatedAt',now(),
  'spendAnomalies',coalesce((select jsonb_agg(jsonb_build_object('type',anomaly_type,'day',day,'provider',provider,
   'model',requested_model,'currency',currency,'spendMinor',spend_minor,'baselineMinor',round(baseline),
   'baselineDays',observations,'events',events,'failedEvents',failed_events)
   order by day desc) from anomalies where anomaly_type is not null),'[]'::jsonb),
  'unpricedUsage',coalesce((select jsonb_agg(to_jsonb(unpriced)) from unpriced),'[]'::jsonb),
  'invoiceExceptions',coalesce((select jsonb_agg(to_jsonb(invoice)) from invoice),'[]'::jsonb),
  'limitations',jsonb_build_array('Spend spike baseline uses prior observed days with known positive cost and requires at least five observations.',
   'Unpriced usage is surfaced but not assigned a fabricated amount.','Anomaly output is advisory and does not change provider routing or customer billing.')
 ) into v_result;
 return v_result;
end $$;

revoke all on function executive_visuals.import_ai_provider_invoice(uuid,text,text,text,date,date,bigint,text,jsonb) from public,anon,authenticated;
revoke all on function executive_visuals.reconcile_ai_provider_invoice(uuid,uuid) from public,anon,authenticated;
revoke all on function executive_visuals.ai_cost_anomaly_report(uuid,date,bigint,numeric,numeric) from public,anon,authenticated;
grant execute on function executive_visuals.import_ai_provider_invoice(uuid,text,text,text,date,date,bigint,text,jsonb) to service_role;
grant execute on function executive_visuals.reconcile_ai_provider_invoice(uuid,uuid) to service_role;
grant execute on function executive_visuals.ai_cost_anomaly_report(uuid,date,bigint,numeric,numeric) to service_role;
