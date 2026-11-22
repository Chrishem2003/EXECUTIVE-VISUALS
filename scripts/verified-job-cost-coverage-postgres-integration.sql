-- Batch 70: invoice-backed job cost coverage and strict revenue-allocation gate.
set role service_role;
do $batch70$
declare
  v_actor constant uuid:='11111111-1111-4111-8111-111111111111';
  v_other constant uuid:='22222222-2222-4222-8222-222222222222';
  v_job_mixed constant uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  v_job_credit_only constant uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
  v_job_cost_only constant uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
  v_import_usd uuid:=gen_random_uuid();
  v_import_ugx uuid:=gen_random_uuid();
  v_line_usd uuid:=gen_random_uuid();
  v_line_ugx uuid:=gen_random_uuid();
  v_usage_usd uuid:=gen_random_uuid();
  v_usage_ugx uuid:=gen_random_uuid();
  v_report jsonb;
  v_row jsonb;
begin
  insert into auth.users(id,email) values
    (v_actor,'batch70-admin@example.invalid'),
    (v_other,'batch70-nonadmin@example.invalid')
  on conflict(id) do nothing;
  insert into executive_visuals.platform_admins(user_id,role,reason)
  values(v_actor,'billing_admin','Batch 70 disposable PostgreSQL integration')
  on conflict(user_id) do update set role=excluded.role,reason=excluded.reason;

  insert into executive_visuals.jobs(id,owner_id,job_type) values
    (v_job_mixed,v_actor,'video.generate'),
    (v_job_credit_only,v_actor,'video.generate'),
    (v_job_cost_only,v_actor,'video.generate')
  on conflict(id) do nothing;

  insert into executive_visuals.billing_credit_accounts(owner_id)
  values(v_actor) on conflict(owner_id) do nothing;
  insert into executive_visuals.billing_credit_reservations(
    owner_id,job_id,idempotency_key,reserved_credits,actual_credits,state,settled_at
  ) values
    (v_actor,v_job_mixed,'batch70-reservation-mixed',150,120,'settled','2026-11-22T10:00:00Z'),
    (v_actor,v_job_credit_only,'batch70-reservation-credit-only',50,40,'settled','2026-11-22T10:05:00Z');

  insert into executive_visuals.ai_usage_cost_events(
    id,occurred_at,period_month,owner_id,project_id,job_id,operation_id,
    provider,requested_model,response_model,operation,status,input_tokens,output_tokens,
    image_count,video_seconds,render_seconds,currency,cost_minor,cost_basis,
    invoice_line_reference,trace_id,idempotency_key
  ) values
    (v_usage_usd,'2026-11-22T10:00:00Z','2026-11-01',v_actor,null,v_job_mixed,
     'batch70-usd-op','runway','seedance2_5','seedance2_5','video','succeeded',
     0,0,0,5,0,'USD',680,'provider_reported','batch70-usd-line','batch70-usd-trace','batch70-usage-usd'),
    (v_usage_ugx,'2026-11-22T10:01:00Z','2026-11-01',v_actor,null,v_job_mixed,
     'batch70-ugx-op','runway','seedance2_5','seedance2_5','video','succeeded',
     0,0,0,5,0,'UGX',4000,'provider_reported','batch70-ugx-line','batch70-ugx-trace','batch70-usage-ugx');

  insert into executive_visuals.ai_provider_invoice_imports(
    id,provider,invoice_reference,currency,period_start,period_end,total_minor,
    imported_line_count,matched_line_count,reconciliation_status,source_fingerprint,imported_by
  ) values
    (v_import_usd,'runway','BATCH70-USD-'||v_import_usd::text,'USD','2026-11-01','2026-11-30',680,1,0,'pending',repeat('c',64),v_actor),
    (v_import_ugx,'runway','BATCH70-UGX-'||v_import_ugx::text,'UGX','2026-11-01','2026-11-30',4000,1,0,'pending',repeat('d',64),v_actor);

  insert into executive_visuals.ai_provider_invoice_lines(
    id,import_id,provider_line_reference,usage_period,owner_id,project_id,job_id,
    provider,model,operation,currency,amount_minor,usage_quantity,usage_unit
  ) values
    (v_line_usd,v_import_usd,'batch70-usd-line','2026-11-22',v_actor,null,v_job_mixed,'runway','seedance2_5','video','USD',680,5,'seconds'),
    (v_line_ugx,v_import_ugx,'batch70-ugx-line','2026-11-22',v_actor,null,v_job_mixed,'runway','seedance2_5','video','UGX',4000,5,'seconds');

  insert into executive_visuals.ai_provider_invoice_reconciliation_events(
    invoice_import_id,invoice_line_id,usage_event_id,match_status,candidate_count,
    expected_amount_minor,observed_amount_minor,currency,evidence,idempotency_key
  ) values
    (v_import_usd,v_line_usd,v_usage_usd,'matched',1,680,680,'USD','{"matchMethod":"exact_provider_line_reference"}','batch70-recon-usd'),
    (v_import_ugx,v_line_ugx,v_usage_ugx,'matched',1,4000,4000,'UGX','{"matchMethod":"exact_provider_line_reference"}','batch70-recon-ugx');

  v_report:=executive_visuals.get_verified_job_cost_coverage(v_actor,'2026-11-01',100);
  if (v_report->>'profitabilityAvailable')::boolean is distinct from false
     or (v_report->>'revenueAllocationAvailable')::boolean is distinct from false
     or v_report->>'blockedReason'<>'verified_revenue_allocation_not_available' then
    raise exception 'Coverage report did not preserve the revenue-allocation gate: %',v_report;
  end if;

  select value into v_row from jsonb_array_elements(v_report->'rows') where value->>'job_id'=v_job_mixed::text;
  if v_row is null
     or v_row->>'evidence_status'<>'mixed_currency_cost_review'
     or v_row->'actual_provider_cost_minor'<>'null'::jsonb
     or jsonb_array_length(v_row->'cost_by_currency')<>2
     or (v_row->>'credits_debited')::bigint<>120
     or v_row->'recognized_revenue_minor'<>'null'::jsonb
     or v_row->'gross_margin_pct'<>'null'::jsonb then
    raise exception 'Mixed-currency job was not safely reported without fabricated revenue or margin: %',v_row;
  end if;

  select value into v_row from jsonb_array_elements(v_report->'rows') where value->>'job_id'=v_job_credit_only::text;
  if v_row is null or v_row->>'evidence_status'<>'missing_invoice_backed_actual_cost' then
    raise exception 'Credit-only job was not surfaced as missing invoice-backed cost: %',v_row;
  end if;

  select value into v_row from jsonb_array_elements(v_report->'rows') where value->>'job_id'=v_job_cost_only::text;
  if v_row is not null then
    raise exception 'A job without a settled credit reservation should not be invented from unrelated data: %',v_row;
  end if;

  begin
    perform executive_visuals.get_verified_job_cost_coverage(v_other,'2026-11-01',100);
    raise exception 'Non-admin unexpectedly read verified job cost coverage';
  exception when sqlstate '42501' then null;
  end;

  begin
    perform executive_visuals.get_verified_job_cost_coverage(v_actor,'2026-11-02',100);
    raise exception 'Coverage report unexpectedly accepted a non-month-start date';
  exception when sqlstate '22023' then null;
  end;

  begin
    perform executive_visuals.get_verified_job_cost_coverage(v_actor,'2026-11-01',101);
    raise exception 'Coverage report unexpectedly accepted an excessive limit';
  exception when sqlstate '22023' then null;
  end;
end
$batch70$;
reset role;
