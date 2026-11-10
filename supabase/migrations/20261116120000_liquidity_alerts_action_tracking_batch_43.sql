-- Batch 43: evidence-backed liquidity early-warning alerts and accountable action tracking.
create table if not exists executive_visuals.financial_liquidity_alerts(
 id uuid primary key default gen_random_uuid(),
 alert_key text not null unique,
 actor_id uuid not null references auth.users(id) on delete restrict,
 alert_type text not null check(alert_type in('minimum_cash_floor_breach','reserve_target_gap')),
 severity text not null check(severity in('critical','high','medium','low')),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 scenario text not null check(scenario in('base','downside','upside')),
 policy_effective_from date not null,
 title text not null check(length(title) between 3 and 240),
 created_at timestamptz not null default now()
);
create index if not exists financial_liquidity_alerts_currency_created_idx
 on executive_visuals.financial_liquidity_alerts(currency,created_at desc);

create table if not exists executive_visuals.financial_liquidity_alert_observations(
 id uuid primary key default gen_random_uuid(),
 alert_id uuid not null references executive_visuals.financial_liquidity_alerts(id) on delete restrict,
 forecast_date date,
 threshold_minor bigint not null check(threshold_minor>=0),
 observed_minor bigint not null,
 gap_minor bigint not null,
 evidence jsonb not null,
 evidence_fingerprint text not null,
 observed_at timestamptz not null default now(),
 unique(alert_id,evidence_fingerprint)
);
create index if not exists financial_liquidity_alert_observations_latest_idx
 on executive_visuals.financial_liquidity_alert_observations(alert_id,observed_at desc);

create table if not exists executive_visuals.financial_liquidity_alert_events(
 id uuid primary key default gen_random_uuid(),
 alert_id uuid not null references executive_visuals.financial_liquidity_alerts(id) on delete restrict,
 actor_id uuid not null references auth.users(id) on delete restrict,
 event_type text not null check(event_type in('opened','evidence_refreshed','acknowledged','action_assigned','in_progress','resolved','reopened','false_positive')),
 assigned_to text,
 due_date date,
 note text not null check(length(trim(note)) between 3 and 1000),
 idempotency_key text not null unique check(length(idempotency_key) between 8 and 180),
 created_at timestamptz not null default now(),
 check(event_type<>'action_assigned' or (assigned_to is not null and length(trim(assigned_to)) between 2 and 160))
);
create index if not exists financial_liquidity_alert_events_latest_idx
 on executive_visuals.financial_liquidity_alert_events(alert_id,created_at desc);

create or replace function executive_visuals.prevent_financial_liquidity_alert_history_mutation()
returns trigger language plpgsql set search_path=pg_catalog,executive_visuals
as $$ begin raise exception 'Liquidity alert evidence and action history are append-only.' using errcode='55000'; end $$;
drop trigger if exists financial_liquidity_alert_immutable on executive_visuals.financial_liquidity_alerts;
create trigger financial_liquidity_alert_immutable before update or delete on executive_visuals.financial_liquidity_alerts
 for each row execute function executive_visuals.prevent_financial_liquidity_alert_history_mutation();
drop trigger if exists financial_liquidity_alert_observation_immutable on executive_visuals.financial_liquidity_alert_observations;
create trigger financial_liquidity_alert_observation_immutable before update or delete on executive_visuals.financial_liquidity_alert_observations
 for each row execute function executive_visuals.prevent_financial_liquidity_alert_history_mutation();
drop trigger if exists financial_liquidity_alert_event_immutable on executive_visuals.financial_liquidity_alert_events;
create trigger financial_liquidity_alert_event_immutable before update or delete on executive_visuals.financial_liquidity_alert_events
 for each row execute function executive_visuals.prevent_financial_liquidity_alert_history_mutation();

create or replace function executive_visuals.refresh_financial_liquidity_alerts(p_actor_id uuid)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare
 v_report jsonb;
 v_scenario jsonb;
 v_policy jsonb;
 v_week jsonb;
 v_alert_id uuid;
 v_alert_key text;
 v_type text;
 v_severity text;
 v_date date;
 v_threshold bigint;
 v_observed bigint;
 v_gap bigint;
 v_evidence jsonb;
 v_fingerprint text;
 v_created integer:=0;
 v_observations integer:=0;
 v_scenarios integer:=0;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 v_report:=executive_visuals.financial_liquidity_guardrails_overview(p_actor_id);
 for v_scenario in select value from jsonb_array_elements(coalesce(v_report->'scenarios','[]'::jsonb)) loop
  v_scenarios:=v_scenarios+1;
  select value into v_policy from jsonb_array_elements(coalesce(v_report->'policies','[]'::jsonb))
   where value->>'currency'=v_scenario->>'currency' limit 1;
  if v_policy is null then continue; end if;
  if (v_scenario->>'firstFloorBreachDate') is not null then
   v_type:='minimum_cash_floor_breach';
   v_date:=(v_scenario->>'firstFloorBreachDate')::date;
   v_threshold:=(v_scenario->>'minimumCashFloorMinor')::bigint;
   select (value->>'projectedClosingMinor')::bigint into v_observed
    from jsonb_array_elements(coalesce(v_scenario->'weekly','[]'::jsonb))
    where (value->>'weekEnd')::date=v_date limit 1;
   v_observed:=coalesce(v_observed,(v_scenario->>'lowestProjectedClosingMinor')::bigint);
   v_gap:=greatest(v_threshold-v_observed,0);
   v_severity:=case v_scenario->>'scenario' when 'base' then 'critical' when 'downside' then 'high' else 'medium' end;
   v_alert_key:=concat_ws('|',v_type,v_scenario->>'currency',v_scenario->>'scenario',v_policy->>'effectiveFrom',v_date::text);
   v_evidence:=jsonb_build_object('currency',v_scenario->>'currency','scenario',v_scenario->>'scenario',
    'policyEffectiveFrom',v_policy->>'effectiveFrom','forecastDate',v_date,'minimumCashFloorMinor',v_threshold,
    'projectedClosingMinor',v_observed,'shortfallMinor',v_gap,'lowestProjectedClosingMinor',v_scenario->>'lowestProjectedClosingMinor',
    'lowestHeadroomMinor',v_scenario->>'lowestHeadroomMinor','forecastGeneratedAt',v_report->>'generatedAt');
   insert into financial_liquidity_alerts(alert_key,actor_id,alert_type,severity,currency,scenario,policy_effective_from,title)
    values(v_alert_key,p_actor_id,v_type,v_severity,v_scenario->>'currency',v_scenario->>'scenario',(v_policy->>'effectiveFrom')::date,
     concat(v_scenario->>'currency',' ',upper(v_scenario->>'scenario'),' forecast breaches the minimum cash floor'))
    on conflict(alert_key) do nothing returning id into v_alert_id;
   if v_alert_id is not null then
    v_created:=v_created+1;
    insert into financial_liquidity_alert_events(alert_id,actor_id,event_type,note,idempotency_key)
     values(v_alert_id,p_actor_id,'opened','Automatically detected from the current evidence-backed liquidity forecast.','liquidity-opened:'||v_alert_key);
   else select id into v_alert_id from financial_liquidity_alerts where alert_key=v_alert_key; end if;
   v_fingerprint:=md5(v_evidence::text);
   insert into financial_liquidity_alert_observations(alert_id,forecast_date,threshold_minor,observed_minor,gap_minor,evidence,evidence_fingerprint)
    values(v_alert_id,v_date,v_threshold,v_observed,v_gap,v_evidence,v_fingerprint) on conflict(alert_id,evidence_fingerprint) do nothing;
   if found then v_observations:=v_observations+1;
    insert into financial_liquidity_alert_events(alert_id,actor_id,event_type,note,idempotency_key)
     values(v_alert_id,p_actor_id,'evidence_refreshed','Forecast evidence changed; review the latest observation before taking action.',
      'liquidity-evidence:'||v_alert_id::text||':'||v_fingerprint) on conflict(idempotency_key) do nothing;
   end if;
  end if;
  if coalesce((v_scenario->>'maximumReserveGapMinor')::bigint,0)>0 then
   v_type:='reserve_target_gap';
   v_threshold:=(v_scenario->>'reserveTargetMinor')::bigint;
   v_gap:=(v_scenario->>'maximumReserveGapMinor')::bigint;
   v_observed:=coalesce(v_threshold-v_gap,0);
   select min((value->>'weekEnd')::date) into v_date from jsonb_array_elements(coalesce(v_scenario->'weekly','[]'::jsonb))
    where coalesce((value->>'reserveGapMinor')::bigint,0)>0;
   v_severity:=case v_scenario->>'scenario' when 'base' then 'medium' when 'downside' then 'low' else 'low' end;
   v_alert_key:=concat_ws('|',v_type,v_scenario->>'currency',v_scenario->>'scenario',v_policy->>'effectiveFrom');
   v_evidence:=jsonb_build_object('currency',v_scenario->>'currency','scenario',v_scenario->>'scenario',
    'policyEffectiveFrom',v_policy->>'effectiveFrom','reserveTargetMinor',v_threshold,'maximumReserveGapMinor',v_gap,
    'projectedCashAtMaximumGapMinor',v_observed,'firstReserveGapDate',v_date,
    'forecastGeneratedAt',v_report->>'generatedAt','weekly',v_scenario->'weekly');
   insert into financial_liquidity_alerts(alert_key,actor_id,alert_type,severity,currency,scenario,policy_effective_from,title)
    values(v_alert_key,p_actor_id,v_type,v_severity,v_scenario->>'currency',v_scenario->>'scenario',(v_policy->>'effectiveFrom')::date,
     concat(v_scenario->>'currency',' ',upper(v_scenario->>'scenario'),' forecast falls below the reserve target'))
    on conflict(alert_key) do nothing returning id into v_alert_id;
   if v_alert_id is not null then
    v_created:=v_created+1;
    insert into financial_liquidity_alert_events(alert_id,actor_id,event_type,note,idempotency_key)
     values(v_alert_id,p_actor_id,'opened','Reserve gap detected from the current evidence-backed liquidity forecast.','liquidity-opened:'||v_alert_key);
   else select id into v_alert_id from financial_liquidity_alerts where alert_key=v_alert_key; end if;
   v_fingerprint:=md5(v_evidence::text);
   insert into financial_liquidity_alert_observations(alert_id,forecast_date,threshold_minor,observed_minor,gap_minor,evidence,evidence_fingerprint)
    values(v_alert_id,v_date,v_threshold,v_observed,v_gap,v_evidence,v_fingerprint) on conflict(alert_id,evidence_fingerprint) do nothing;
   if found then v_observations:=v_observations+1;
    insert into financial_liquidity_alert_events(alert_id,actor_id,event_type,note,idempotency_key)
     values(v_alert_id,p_actor_id,'evidence_refreshed','Reserve forecast evidence changed; review the latest observation.',
      'liquidity-evidence:'||v_alert_id::text||':'||v_fingerprint) on conflict(idempotency_key) do nothing;
   end if;
  end if;
 end loop;
 return jsonb_build_object('scenariosEvaluated',v_scenarios,'newAlerts',v_created,'newObservations',v_observations,'refreshedAt',now());
end $$;

create or replace function executive_visuals.record_financial_liquidity_alert_event(p_actor_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare
 v_alert_id uuid:=(p_payload->>'alertId')::uuid;
 v_type text:=p_payload->>'eventType';
 v_note text:=trim(p_payload->>'note');
 v_assigned text:=nullif(trim(p_payload->>'assignedTo'),'');
 v_due date:=nullif(p_payload->>'dueDate','')::date;
 v_key text:=p_payload->>'idempotencyKey';
 v_current text;
 v_event financial_liquidity_alert_events%rowtype;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if v_alert_id is null or v_type not in('acknowledged','action_assigned','in_progress','resolved','reopened','false_positive') or
  length(v_note) not between 3 and 1000 or length(v_key) not between 8 and 180 or
  (v_type='action_assigned' and (v_assigned is null or length(v_assigned) not between 2 and 160)) or
  (v_due is not null and v_due<current_date) then
  raise exception 'Valid alert action, note, assignee and due date are required' using errcode='22023';
 end if;
 if not exists(select 1 from financial_liquidity_alerts where id=v_alert_id) then
  raise exception 'Liquidity alert not found' using errcode='P0002';
 end if;
 select event_type into v_current from financial_liquidity_alert_events where alert_id=v_alert_id
  order by created_at desc,id desc limit 1;
 if (v_type='acknowledged' and v_current not in('opened','evidence_refreshed')) or
  (v_type='action_assigned' and v_current not in('opened','evidence_refreshed','acknowledged','action_assigned')) or
  (v_type='in_progress' and v_current not in('opened','evidence_refreshed','acknowledged','action_assigned','in_progress')) or
  (v_type='resolved' and v_current not in('acknowledged','action_assigned','in_progress')) or
  (v_type='reopened' and v_current not in('resolved','false_positive')) or
  (v_type='false_positive' and v_current not in('opened','evidence_refreshed','acknowledged','action_assigned')) then
  raise exception 'Liquidity alert action is not valid for its current state' using errcode='22023';
 end if;
 insert into financial_liquidity_alert_events(alert_id,actor_id,event_type,assigned_to,due_date,note,idempotency_key)
 values(v_alert_id,p_actor_id,v_type,v_assigned,v_due,v_note,v_key)
 on conflict(idempotency_key) do nothing;
 select * into v_event from financial_liquidity_alert_events where idempotency_key=v_key;
 if v_event.alert_id<>v_alert_id or v_event.actor_id<>p_actor_id or v_event.event_type<>v_type or
  v_event.note<>v_note or v_event.assigned_to is distinct from v_assigned or v_event.due_date is distinct from v_due then
  raise exception 'Alert action idempotency key conflicts with existing evidence' using errcode='23505';
 end if;
 return jsonb_build_object('id',v_event.id,'alertId',v_event.alert_id,'eventType',v_event.event_type,
  'assignedTo',v_event.assigned_to,'dueDate',v_event.due_date,'note',v_event.note,'createdAt',v_event.created_at);
end $$;

create or replace function executive_visuals.financial_liquidity_alerts_overview(p_actor_id uuid)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_result jsonb;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 with alert_rows as(
  select a.id,a.alert_key,a.alert_type,a.severity,a.currency,a.scenario,a.policy_effective_from,a.title,a.created_at,
   o.forecast_date,o.threshold_minor,o.observed_minor,o.gap_minor,o.evidence,o.observed_at,
   e.event_type current_event,e.assigned_to,e.due_date,e.note latest_note,e.created_at latest_event_at,
   coalesce((select jsonb_agg(jsonb_build_object('eventType',h.event_type,'assignedTo',h.assigned_to,'dueDate',h.due_date,
    'note',h.note,'createdAt',h.created_at) order by h.created_at,h.id)
    from financial_liquidity_alert_events h where h.alert_id=a.id),'[]'::jsonb) history
  from financial_liquidity_alerts a
  left join lateral(select * from financial_liquidity_alert_observations x where x.alert_id=a.id order by x.observed_at desc,x.id desc limit 1)o on true
  left join lateral(select * from financial_liquidity_alert_events x where x.alert_id=a.id order by x.created_at desc,x.id desc limit 1)e on true
 )
 select jsonb_build_object('generatedAt',now(),'alerts',coalesce(jsonb_agg(jsonb_build_object(
  'id',r.id,'alertType',r.alert_type,'severity',r.severity,'currency',r.currency,'scenario',r.scenario,
  'policyEffectiveFrom',r.policy_effective_from,'title',r.title,'status',case
   when r.current_event in('resolved','false_positive') then r.current_event
   when r.current_event='in_progress' then 'in_progress'
   when r.current_event='action_assigned' then 'action_assigned'
   when r.current_event='acknowledged' then 'acknowledged'
   else 'open' end,
  'forecastDate',r.forecast_date,'thresholdMinor',r.threshold_minor,'observedMinor',r.observed_minor,
  'gapMinor',r.gap_minor,'evidence',r.evidence,'observedAt',r.observed_at,
  'assignedTo',r.assigned_to,'dueDate',r.due_date,'latestNote',r.latest_note,'latestEventAt',r.latest_event_at,
  'history',r.history,'createdAt',r.created_at) order by
   case r.severity when 'critical' then 1 when 'high' then 2 when 'medium' then 3 else 4 end,r.created_at desc),'[]'::jsonb))
 into v_result from alert_rows r;
 return v_result;
end $$;

revoke all on table executive_visuals.financial_liquidity_alerts from public,anon,authenticated;
revoke all on table executive_visuals.financial_liquidity_alert_observations from public,anon,authenticated;
revoke all on table executive_visuals.financial_liquidity_alert_events from public,anon,authenticated;
grant all on table executive_visuals.financial_liquidity_alerts to service_role;
grant all on table executive_visuals.financial_liquidity_alert_observations to service_role;
grant all on table executive_visuals.financial_liquidity_alert_events to service_role;
revoke all on function executive_visuals.prevent_financial_liquidity_alert_history_mutation() from public,anon,authenticated;
revoke all on function executive_visuals.refresh_financial_liquidity_alerts(uuid) from public,anon,authenticated;
revoke all on function executive_visuals.record_financial_liquidity_alert_event(uuid,jsonb) from public,anon,authenticated;
revoke all on function executive_visuals.financial_liquidity_alerts_overview(uuid) from public,anon,authenticated;
grant execute on function executive_visuals.prevent_financial_liquidity_alert_history_mutation() to service_role;
grant execute on function executive_visuals.refresh_financial_liquidity_alerts(uuid) to service_role;
grant execute on function executive_visuals.record_financial_liquidity_alert_event(uuid,jsonb) to service_role;
grant execute on function executive_visuals.financial_liquidity_alerts_overview(uuid) to service_role;
