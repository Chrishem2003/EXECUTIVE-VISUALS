-- Batch 147: PostgreSQL integration for owner finance reporting and two-person remediation approval.
-- The transaction is rolled back; no lasting test users, roles, payment or subscription changes.
begin;
grant usage on schema executive_visuals to service_role;
insert into executive_visuals.platform_admins(user_id,role,granted_by,reason) values
 ('33333333-3333-4333-8333-333333333333','owner','33333333-3333-4333-8333-333333333333','Disposable Batch 147 integration owner'),
 ('44444444-4444-4444-8444-444444444444','platform_admin','33333333-3333-4333-8333-333333333333','Disposable Batch 147 independent approver')
on conflict(user_id) do update set role=excluded.role,reason=excluded.reason;

set role service_role;
set search_path=executive_visuals,public;
do $batch147$
declare
  v_owner constant uuid:='33333333-3333-4333-8333-333333333333';
  v_approver constant uuid:='44444444-4444-4444-8444-444444444444';
  v_payment_id uuid;
  v_original_metadata jsonb;
  v_report jsonb;
  v_run_id uuid;
  v_finding_index integer;
  v_request jsonb;
  v_decision jsonb;
  v_request_id uuid;
  v_summary jsonb;
  v_event_count integer;
  v_metadata jsonb;
begin
  select id,metadata into v_payment_id,v_original_metadata
    from payment_transactions
   where provider='pesapal'
     and status='successful'
     and metadata->>'payment_purpose'='subscription_purchase'
   order by created_at limit 1;
  if v_payment_id is null then
    raise exception 'Batch 147 requires the Pesapal purchase fixture from the provider billing integration suite';
  end if;

  -- Create a real reconciliation finding from a disposable, temporarily altered marker.
  update payment_transactions
     set metadata=jsonb_set(metadata,'{subscription_applied}','false'::jsonb,true)
   where id=v_payment_id;
  v_report:=run_subscription_financial_reconciliation(100);
  if v_report->>'status'<>'completed' or v_report->>'mutationsApplied'<>'false' then
    raise exception 'Batch 147 reconciliation did not complete in read-only mode: %',v_report;
  end if;
  v_run_id:=(v_report->>'runId')::uuid;
  select (ordinality-1)::integer into v_finding_index
    from jsonb_array_elements(v_report->'findings') with ordinality
   where value->>'category'='successful_payment_not_applied'
     and value->>'entityId'=v_payment_id::text;
  if v_finding_index is null then
    raise exception 'Batch 147 did not report the deliberately unapplied successful payment: %',v_report;
  end if;

  v_request:=request_subscription_financial_remediation(
    v_owner,v_run_id,v_finding_index,'review_payment_application',
    'Independently review the verified payment application marker and subscription entitlement.',
    'batch147-owner-review-request-0001'
  );
  if v_request->>'status'<>'pending_approval' or v_request->>'replayed'<>'false' then
    raise exception 'Owner remediation request was not created in pending approval state: %',v_request;
  end if;
  v_request_id:=(v_request->>'requestId')::uuid;

  -- The requester cannot approve their own request.
  begin
    perform decide_subscription_financial_remediation(
      v_owner,v_request_id,'approve',
      'Requester must not approve their own financial remediation.'
    );
    raise exception 'Self-approval unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;

  v_decision:=decide_subscription_financial_remediation(
    v_approver,v_request_id,'approve',
    'Independent approval for manual investigation only; no ledger mutation authorized.'
  );
  if v_decision->>'status'<>'approved_for_manual_review'
     or v_decision->>'mutationsApplied'<>'false' then
    raise exception 'Independent approval did not remain a manual-review-only decision: %',v_decision;
  end if;

  select count(*)::integer into v_event_count
    from subscription_financial_remediation_events where request_id=v_request_id;
  if v_event_count<>2 then raise exception 'Expected immutable request and decision events, got %',v_event_count; end if;

  -- Approved review must not repair the payment or grant credits automatically.
  select metadata into v_metadata from payment_transactions where id=v_payment_id;
  if v_metadata->'subscription_applied'<>'false'::jsonb then
    raise exception 'Batch 147 unexpectedly changed the payment application marker';
  end if;

  -- Verify summary keeps currencies separated and does not invent a monetary credit liability.
  v_summary:=get_subscription_financial_liability_summary();
  if v_summary->'creditUnits'->>'monetaryLiabilityCalculated'<>'false'
     or jsonb_typeof(v_summary->'byCurrency')<>'array' then
    raise exception 'Subscription liability summary has unsafe credit-liability semantics: %',v_summary;
  end if;

  -- Event records are append-only.
  begin
    update subscription_financial_remediation_events
       set note='tampered'
     where request_id=v_request_id;
    raise exception 'Remediation event mutation unexpectedly succeeded';
  exception when raise_exception then
    if sqlerrm='Remediation event mutation unexpectedly succeeded' then raise; end if;
    if sqlerrm<>'SUBSCRIPTION_FINANCIAL_REMEDIATION_EVENTS_APPEND_ONLY' then raise; end if;
  end;

  raise notice 'Batch 147 owner finance command centre PostgreSQL acceptance passed';
end;
$batch147$;
reset role;
rollback;
