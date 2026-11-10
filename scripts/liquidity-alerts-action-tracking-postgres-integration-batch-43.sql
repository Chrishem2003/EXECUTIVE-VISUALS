-- Batch 43: liquidity early-warning detection and immutable action lifecycle.
reset role;
set role service_role;
do $batch43$
declare
 v_actor constant uuid:='99999999-9999-4999-8999-999999999999';
 v_refresh jsonb;
 v_overview jsonb;
 v_alert jsonb;
 v_replay jsonb;
 v_event jsonb;
 v_alert_id uuid;
 v_event_id uuid;
 v_status text;
 v_count integer;
begin
 v_refresh:=executive_visuals.refresh_financial_liquidity_alerts(v_actor);
 if (v_refresh->>'scenariosEvaluated')::integer<3 then raise exception 'Expected base, downside and upside scenarios to be evaluated: %',v_refresh; end if;
 v_overview:=executive_visuals.financial_liquidity_alerts_overview(v_actor);
 v_count:=jsonb_array_length(v_overview->'alerts');
 if v_count<6 then raise exception 'Expected floor and reserve alerts for each scenario, found %: %',v_count,v_overview; end if;
 select value into v_alert from jsonb_array_elements(v_overview->'alerts')
  where value->>'currency'='ZZZ' and value->>'scenario'='base' and value->>'alertType'='minimum_cash_floor_breach';
 if v_alert is null then raise exception 'Base minimum cash floor breach alert missing: %',v_overview; end if;
 if v_alert->>'severity'<>'critical' or v_alert->>'status'<>'open' or (v_alert->>'gapMinor')::bigint<=0 then
  raise exception 'Base floor breach severity, status or gap incorrect: %',v_alert;
 end if;
 v_refresh:=executive_visuals.refresh_financial_liquidity_alerts(v_actor);
 if (v_refresh->>'newAlerts')::integer<>0 or (v_refresh->>'newObservations')::integer<>0 then
  raise exception 'Unchanged forecast refresh should not create duplicate alerts or observations: %',v_refresh;
 end if;
 v_alert_id:=(v_alert->>'id')::uuid;
 v_event:=executive_visuals.record_financial_liquidity_alert_event(v_actor,jsonb_build_object(
  'alertId',v_alert_id,'eventType','acknowledged','note','Treasury reviewed the projected cash floor breach.',
  'idempotencyKey','batch43-acknowledge-001'));
 v_replay:=executive_visuals.record_financial_liquidity_alert_event(v_actor,jsonb_build_object(
  'alertId',v_alert_id,'eventType','acknowledged','note','Treasury reviewed the projected cash floor breach.',
  'idempotencyKey','batch43-acknowledge-001'));
 if v_event->>'id'<>v_replay->>'id' then raise exception 'Action idempotency replay created duplicate event'; end if;
 v_event:=executive_visuals.record_financial_liquidity_alert_event(v_actor,jsonb_build_object(
  'alertId',v_alert_id,'eventType','action_assigned','assignedTo','Treasury team','dueDate',current_date+1,
  'note','Treasury team to validate collections and propose a cash protection plan.',
  'idempotencyKey','batch43-assign-0001'));
 v_event:=executive_visuals.record_financial_liquidity_alert_event(v_actor,jsonb_build_object(
  'alertId',v_alert_id,'eventType','in_progress','note','Collection and supplier timing review has started.',
  'idempotencyKey','batch43-progress-001'));
 v_event:=executive_visuals.record_financial_liquidity_alert_event(v_actor,jsonb_build_object(
  'alertId',v_alert_id,'eventType','resolved','note','A revised and evidenced cash plan removed the projected breach.',
  'idempotencyKey','batch43-resolve-001'));
 v_overview:=executive_visuals.financial_liquidity_alerts_overview(v_actor);
 select value into v_alert from jsonb_array_elements(v_overview->'alerts') where value->>'id'=v_alert_id::text;
 if v_alert->>'status'<>'resolved' or v_alert->>'assignedTo'<>'Treasury team' or jsonb_array_length(v_alert->'history')<5 then
  raise exception 'Resolved alert status, owner or history incorrect: %',v_alert;
 end if;
 begin
  perform executive_visuals.record_financial_liquidity_alert_event(v_actor,jsonb_build_object(
   'alertId',v_alert_id,'eventType','acknowledged','note','Invalid transition after resolution.',
   'idempotencyKey','batch43-invalid-transition'));
  raise exception 'Invalid action transition was accepted';
 exception when sqlstate '22023' then null;
 end;
 perform executive_visuals.record_financial_liquidity_alert_event(v_actor,jsonb_build_object(
  'alertId',v_alert_id,'eventType','reopened','note','New forecast evidence indicates the risk has returned.',
  'idempotencyKey','batch43-reopen-001'));
 v_overview:=executive_visuals.financial_liquidity_alerts_overview(v_actor);
 select value->>'status' into v_status from jsonb_array_elements(v_overview->'alerts') where value->>'id'=v_alert_id::text;
 if v_status<>'reopened' then raise exception 'Resolved alert could not be reopened: %',v_status; end if;
 begin
  update executive_visuals.financial_liquidity_alert_events set note='tampered' where id=(v_event->>'id')::uuid;
  raise exception 'Alert event history accepted an update';
 exception when sqlstate '55000' then null;
 end;
 begin
  delete from executive_visuals.financial_liquidity_alerts where id=v_alert_id;
  raise exception 'Alert record accepted deletion';
 exception when sqlstate '55000' then null;
 end;
 begin
  perform executive_visuals.refresh_financial_liquidity_alerts('88888888-8888-4888-8888-888888888888'::uuid);
  raise exception 'Unauthorized alert refresh was accepted';
 exception when sqlstate '42501' then null;
 end;
end $batch43$;
reset role;
