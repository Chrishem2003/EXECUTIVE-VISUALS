-- Batch 104 integration: replay must match the customer-credit lifecycle.
-- Run after cloud-video-credit-unit-separation and project shared credit-pool migrations.
-- All mutations are rolled back; this only uses the disposable CI database.
begin;
set role service_role;

do $batch104_replay_lifecycle$
declare
  v_owner uuid := '123e4567-e89b-42d3-a456-426614174000';
  v_project uuid := '323e4567-e89b-42d3-a456-426614174000';
  v_quote uuid := '723e4567-e89b-42d3-a456-426614174001';
  v_job uuid;
  v_reservation uuid;
  v_result record;
  v_input jsonb := jsonb_build_object(
    'projectId','323e4567-e89b-42d3-a456-426614174000',
    'provider','runway','model','model-router','requestHash',repeat('f',64),
    'operation','text-to-video','durationSeconds',5,'outputFormat','mp4',
    'workflowQuoteId','723e4567-e89b-42d3-a456-426614174001',
    'workflowRequestId','pg-workflow-credit-separation-001'
  );
  v_evidence jsonb := jsonb_build_object(
    'provider','runway','evidenceType','provider_task_receipt',
    'evidenceId','batch104-provider-receipt-001',
    'evidenceReference','provider-receipt:batch104-001'
  );
begin
  select id into v_job from executive_visuals.jobs
   where owner_id=v_owner and idempotency_key='pg-workflow-credit-separation-001';
  select id into v_reservation from executive_visuals.billing_credit_reservations
   where owner_id=v_owner and job_id=v_job;
  if v_job is null or v_reservation is null then
    raise exception 'BATCH104_FIXTURE_MISSING';
  end if;

  -- An in-flight replay is valid only while its reservation remains held.
  select * into v_result from executive_visuals.approve_and_enqueue_video_workflow(
    v_quote,'e23e4567-e89b-42d3-a456-426614174001',v_owner,v_project,
    repeat('f',64),'studio-video','pg-workflow-credit-separation-001',
    v_input,0.10,'Batch 104 in-flight replay test'
  );
  if not v_result.idempotent_replay or v_result.job_id<>v_job then
    raise exception 'BATCH104_VALID_IN_FLIGHT_REPLAY_REJECTED';
  end if;

  update executive_visuals.billing_credit_reservations
    set state='released',actual_credits=null,evidence='{}'::jsonb
    where id=v_reservation;
  begin
    perform * from executive_visuals.approve_and_enqueue_video_workflow(
      v_quote,'e23e4567-e89b-42d3-a456-426614174001',v_owner,v_project,
      repeat('f',64),'studio-video','pg-workflow-credit-separation-001',
      v_input,0.10,'Released reservation must not replay'
    );
    raise exception 'BATCH104_RELEASED_ACTIVE_RESERVATION_REPLAYED';
  exception when others then
    if sqlerrm='BATCH104_RELEASED_ACTIVE_RESERVATION_REPLAYED' then raise; end if;
    if sqlerrm<>'VIDEO_WORKFLOW_REPLAY_CREDIT_LIFECYCLE_MISMATCH' then raise; end if;
  end;

  -- A completed job requires settled provider budget, a cost receipt, and
  -- provider-matched customer-credit usage proof. Keep the budget ledger coherent.
  update executive_visuals.video_generation_budget_reservations
    set state='settled',actual_amount=0.05,updated_at=clock_timestamp()
    where job_id=v_job and state='reserved';
  update executive_visuals.video_generation_budget_policies p
    set reserved_amount=reserved_amount-0.10,spent_amount=spent_amount+0.05,
        updated_at=clock_timestamp()
    where p.id=(select r.policy_id from executive_visuals.video_generation_budget_reservations r
                where r.job_id=v_job);
  update executive_visuals.billing_credit_reservations
    set state='settled',actual_credits=3000,evidence=v_evidence
    where id=v_reservation;
  update executive_visuals.jobs
    set status='succeeded',
        output=jsonb_build_object(
          'provider','runway','model','gen4.5',
          'providerTaskId','batch104-cost-ledger-task-001',
          'costEvidenceReference','provider-receipt:batch104-cost-ledger-001'
        )
    where id=v_job;
  select * into v_result from executive_visuals.approve_and_enqueue_video_workflow(
    v_quote,'e23e4567-e89b-42d3-a456-426614174001',v_owner,v_project,
    repeat('f',64),'studio-video','pg-workflow-credit-separation-001',
    v_input,0.10,'Batch 104 settled replay test'
  );
  if not v_result.idempotent_replay or v_result.job_status<>'succeeded' then
    raise exception 'BATCH104_VALID_SETTLED_REPLAY_REJECTED';
  end if;

  update executive_visuals.billing_credit_reservations
    set evidence=jsonb_set(evidence,'{provider}','"different-provider"'::jsonb)
    where id=v_reservation;
  begin
    perform * from executive_visuals.approve_and_enqueue_video_workflow(
      v_quote,'e23e4567-e89b-42d3-a456-426614174001',v_owner,v_project,
      repeat('f',64),'studio-video','pg-workflow-credit-separation-001',
      v_input,0.10,'Mismatched provider evidence must not replay'
    );
    raise exception 'BATCH104_PROVIDER_MISMATCH_REPLAYED';
  exception when others then
    if sqlerrm='BATCH104_PROVIDER_MISMATCH_REPLAYED' then raise; end if;
    if sqlerrm<>'VIDEO_WORKFLOW_REPLAY_USAGE_EVIDENCE_INVALID' then raise; end if;
  end;

  -- A failed/cancelled job is not financially cleared by a bare release.
  update executive_visuals.jobs set status='failed' where id=v_job;
  update executive_visuals.billing_credit_reservations
    set state='released',actual_credits=null,evidence='{}'::jsonb
    where id=v_reservation;
  begin
    perform * from executive_visuals.approve_and_enqueue_video_workflow(
      v_quote,'e23e4567-e89b-42d3-a456-426614174001',v_owner,v_project,
      repeat('f',64),'studio-video','pg-workflow-credit-separation-001',
      v_input,0.10,'Unverified release must not replay'
    );
    raise exception 'BATCH104_UNVERIFIED_RELEASE_REPLAYED';
  exception when others then
    if sqlerrm='BATCH104_UNVERIFIED_RELEASE_REPLAYED' then raise; end if;
    if sqlerrm<>'VIDEO_WORKFLOW_REPLAY_RELEASE_EVIDENCE_MISSING' then raise; end if;
  end;

  -- Future verified no-charge release evidence permits an exact replay.
  update executive_visuals.billing_credit_reservations
    set evidence=jsonb_build_object(
      'provider','runway','evidenceType','verified_no_charge_cancellation',
      'evidenceId','batch104-no-charge-001',
      'evidenceReference','provider-cancellation:batch104-001'
    )
    where id=v_reservation;
  select * into v_result from executive_visuals.approve_and_enqueue_video_workflow(
    v_quote,'e23e4567-e89b-42d3-a456-426614174001',v_owner,v_project,
    repeat('f',64),'studio-video','pg-workflow-credit-separation-001',
    v_input,0.10,'Batch 104 verified release replay test'
  );
  if not v_result.idempotent_replay or v_result.job_status<>'failed' then
    raise exception 'BATCH104_VERIFIED_RELEASE_REPLAY_REJECTED';
  end if;
end;
$batch104_replay_lifecycle$;

reset role;
rollback;
select 'SUPABASE_CREDIT_RESERVATION_REPLAY_GUARD_BATCH_104_OK' as result;
