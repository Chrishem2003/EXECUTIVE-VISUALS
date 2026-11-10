-- Batch 25: verified invoice-to-ledger posting, idempotency and trend report integration.
set role service_role;
do $batch25$
declare
 v_actor constant uuid:='11111111-1111-4111-8111-111111111111';
 v_import uuid:=gen_random_uuid();
 v_incomplete_import uuid:=gen_random_uuid();
 v_incomplete_line uuid:=gen_random_uuid();
 v_line uuid:=gen_random_uuid();
 v_usage uuid:=gen_random_uuid();
 v_recon uuid:=gen_random_uuid();
 v_result jsonb;
 v_replay jsonb;
 v_trends jsonb;
 v_ledger_count integer;
 v_link_count integer;
begin
 insert into executive_visuals.ai_usage_cost_events(
  id,occurred_at,period_month,owner_id,project_id,job_id,operation_id,provider,
  requested_model,response_model,operation,status,input_tokens,output_tokens,
  image_count,video_seconds,render_seconds,currency,cost_minor,cost_basis,
  invoice_line_reference,trace_id,idempotency_key
 ) values(
  v_usage,now(),date_trunc('month',now())::date,v_actor,null,null,
  'batch25-op-'||v_usage::text,'openai','gpt-batch25','gpt-batch25','text','succeeded',
  100,20,0,0,0,'USD',500,'provider_reported','batch25-line-'||v_line::text,
  'batch25-trace-'||v_usage::text,'batch25-usage:'||v_usage::text
 );
 insert into executive_visuals.ai_provider_invoice_imports(
  id,provider,invoice_reference,currency,period_start,period_end,total_minor,
  imported_line_count,matched_line_count,reconciliation_status,source_fingerprint,imported_by
 ) values(
  v_import,'openai','BATCH25-'||v_import::text,'USD',
  date_trunc('month',now())::date,current_date,500,1,1,'pending',
  repeat('a',64),v_actor
 );
 insert into executive_visuals.ai_provider_invoice_lines(
  id,import_id,provider_line_reference,usage_period,owner_id,project_id,job_id,
  provider,model,operation,currency,amount_minor,usage_quantity,usage_unit
 ) values(
  v_line,v_import,'batch25-line-'||v_line::text,current_date,v_actor,null,null,
  'openai','gpt-batch25','text','USD',500,120,'tokens'
 );
 insert into executive_visuals.ai_provider_invoice_reconciliation_events(
  id,invoice_import_id,invoice_line_id,usage_event_id,match_status,candidate_count,
  expected_amount_minor,observed_amount_minor,currency,evidence,idempotency_key
 ) values(
  v_recon,v_import,v_line,v_usage,'matched',1,500,500,'USD',
  jsonb_build_object('matchMethod','integration_fixture'),'batch25-recon:'||v_recon::text
 );
 v_result:=executive_visuals.post_verified_ai_invoice_to_service_cost_ledger(v_actor,v_import);
 if (v_result->>'posted')::integer<>1 or v_result->>'status'<>'posted_to_service_cost_ledger' then
  raise exception 'Verified invoice line did not post to the service-cost ledger: %',v_result;
 end if;
 select count(*) into v_ledger_count from executive_visuals.financial_service_cost_events
  where idempotency_key='ai-invoice-cost:'||v_recon::text
   and owner_id=v_actor and amount_minor=500 and currency='USD';
 select count(*) into v_link_count from executive_visuals.financial_cost_attribution_links
  where reconciliation_event_id=v_recon and usage_event_id=v_usage;
 if v_ledger_count<>1 or v_link_count<>1 then
  raise exception 'Invoice posting did not create exactly one ledger entry and attribution link';
 end if;
 v_replay:=executive_visuals.post_verified_ai_invoice_to_service_cost_ledger(v_actor,v_import);
 if (v_replay->>'idempotentReplays')::integer<>1 then
  raise exception 'Repeated invoice posting did not replay idempotently: %',v_replay;
 end if;
 select count(*) into v_ledger_count from executive_visuals.financial_service_cost_events
  where idempotency_key='ai-invoice-cost:'||v_recon::text;
 if v_ledger_count<>1 then raise exception 'Repeated invoice posting duplicated the service-cost ledger entry'; end if;
 insert into executive_visuals.ai_provider_invoice_imports(
  id,provider,invoice_reference,currency,period_start,period_end,total_minor,
  imported_line_count,matched_line_count,reconciliation_status,source_fingerprint,imported_by
 ) values(
  v_incomplete_import,'openai','BATCH25-INCOMPLETE-'||v_incomplete_import::text,'USD',
  date_trunc('month',now())::date,current_date,100,1,0,'pending',
  repeat('b',64),v_actor
 );
 insert into executive_visuals.ai_provider_invoice_lines(
  id,import_id,provider_line_reference,usage_period,provider,model,operation,
  currency,amount_minor,usage_quantity,usage_unit
 ) values(
  v_incomplete_line,v_incomplete_import,'batch25-incomplete-'||v_incomplete_line::text,
  current_date,'openai','gpt-unmatched','text','USD',100,20,'tokens'
 );
 begin
  perform executive_visuals.post_verified_ai_invoice_to_service_cost_ledger(v_actor,v_incomplete_import);
  raise exception 'Unmatched invoice unexpectedly posted to the service-cost ledger';
 exception when sqlstate '22023' then null;
 end;
 v_trends:=executive_visuals.financial_profitability_trend_report(v_actor,12);
 if jsonb_typeof(v_trends->'periods')<>'array'
  or (v_trends->>'months')::integer<>12 then
  raise exception 'Profitability trend report did not return its bounded monthly series: %',v_trends;
 end if;
 begin
  perform executive_visuals.financial_profitability_trend_report(v_actor,2);
  raise exception 'Trend report unexpectedly accepted an invalid month range';
 exception when sqlstate '22023' then null;
 end;
end $batch25$;
reset role;
