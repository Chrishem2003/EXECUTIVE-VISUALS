-- Batch 105: join Batch 71 verified credit-pack revenue to a fully posted invoice cost.
-- Expected result is an evidence-backed loss, proving negative margins are surfaced rather than hidden.

set role service_role;
do $batch105_verified_job_margin$
declare
  v_owner constant uuid:='71717171-7171-4171-8171-717171717171';
  v_job constant uuid:='71717171-7171-4171-8171-717171717101';
  v_usage uuid:=gen_random_uuid();
  v_import uuid:=gen_random_uuid();
  v_line uuid:=gen_random_uuid();
  v_recon uuid:=gen_random_uuid();
  v_report jsonb;
  v_job_report jsonb;
  v_reference text;
begin
  v_reference:='batch105-line-'||v_line::text;
  insert into executive_visuals.ai_usage_cost_events(
    id,occurred_at,period_month,owner_id,project_id,job_id,operation_id,provider,
    requested_model,response_model,operation,status,input_tokens,output_tokens,
    image_count,video_seconds,render_seconds,currency,cost_minor,cost_basis,
    invoice_line_reference,trace_id,idempotency_key
  ) values(
    v_usage,now(),date_trunc('month',now())::date,v_owner,null,v_job,
    'batch105-op-'||v_usage::text,'runway','gen4.5','gen4.5','video','succeeded',
    0,0,0,5,0,'USD',500,'provider_reported',v_reference,
    'batch105-trace-'||v_usage::text,'batch105-usage:'||v_usage::text
  );

  insert into executive_visuals.ai_provider_invoice_imports(
    id,provider,invoice_reference,currency,period_start,period_end,total_minor,
    imported_line_count,matched_line_count,reconciliation_status,source_fingerprint,imported_by
  ) values(
    v_import,'runway','BATCH105-'||v_import::text,'USD',
    date_trunc('month',current_date)::date,current_date,500,1,1,'pending',
    repeat('c',64),v_owner
  );
  insert into executive_visuals.ai_provider_invoice_lines(
    id,import_id,provider_line_reference,usage_period,owner_id,project_id,job_id,
    provider,model,operation,currency,amount_minor,usage_quantity,usage_unit
  ) values(
    v_line,v_import,v_reference,current_date,v_owner,null,v_job,
    'runway','gen4.5','video','USD',500,5,'seconds'
  );
  insert into executive_visuals.ai_provider_invoice_reconciliation_events(
    id,invoice_import_id,invoice_line_id,usage_event_id,match_status,candidate_count,
    expected_amount_minor,observed_amount_minor,currency,evidence,idempotency_key
  ) values(
    v_recon,v_import,v_line,v_usage,'matched',1,500,500,'USD',
    jsonb_build_object('matchMethod','exact_provider_task_invoice_line'),
    'batch105-recon:'||v_recon::text
  );

  perform executive_visuals.post_verified_ai_invoice_to_service_cost_ledger(v_owner,v_import);
  v_report:=executive_visuals.record_payment_processor_fee_evidence(
    v_owner,'71717171-7171-4171-8171-717171717201',30,'USD','batch71-provider-paid',
    jsonb_build_object('evidenceType','provider_payment_receipt','evidenceId','batch107-fee-receipt-0001',
      'evidenceReference','fixture:batch107:payment-fee:0001','evidenceSha256',repeat('f',64)),
    'batch107-fee-evidence-key-0001'
  );
  if v_report->>'recorded'<>'true' or v_report->>'idempotentReplay'<>'false' then
    raise exception 'Processor fee evidence was not recorded as a new immutable record: %',v_report;
  end if;
  v_report:=executive_visuals.record_payment_processor_fee_evidence(
    v_owner,'71717171-7171-4171-8171-717171717201',30,'USD','batch71-provider-paid',
    jsonb_build_object('evidenceType','provider_payment_receipt','evidenceId','batch107-fee-receipt-0001',
      'evidenceReference','fixture:batch107:payment-fee:0001','evidenceSha256',repeat('f',64)),
    'batch107-fee-evidence-key-0001'
  );
  if v_report->>'idempotentReplay'<>'true' then
    raise exception 'Processor fee evidence replay was not idempotent: %',v_report;
  end if;
  v_report:=executive_visuals.financial_job_profitability_report(v_owner,v_owner,100);
  select value into v_job_report
    from jsonb_array_elements(v_report->'jobs')
   where value->>'jobId'=v_job::text;

  if v_job_report is null
     or v_job_report#>>'{revenue,status}'<>'verified'
     or (v_job_report#>>'{revenue,recognizedMinor}')::bigint<>400
     or v_job_report#>>'{actualCost,status}'<>'verified'
     or (v_job_report#>>'{actualCost,amountMinor}')::bigint<>500
     or v_job_report#>>'{profitability,status}'<>'loss_making'
     or (v_job_report#>>'{profitability,contributionMinor}')::bigint<>-100
     or (v_job_report#>>'{profitability,grossMarginPct}')::numeric<>-25
     or v_job_report#>>'{processorFee,status}'<>'verified'
     or (v_job_report#>>'{processorFee,amountMinor}')::bigint<>12
     or (v_job_report#>>'{profitability,netContributionMinor}')::bigint<>-112
     or (v_job_report#>>'{profitability,netMarginPct}')::numeric<>-28 then
    raise exception 'Verified job revenue and posted invoice cost did not produce the expected loss report: %',v_job_report;
  end if;
end
$batch105_verified_job_margin$;
reset role;
select 'verified per-job contribution and negative-margin PostgreSQL integration checks passed' as result;
