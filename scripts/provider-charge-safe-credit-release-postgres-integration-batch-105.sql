-- Batch 105: exercise the actual release RPCs and both job finalizers.
-- The disposable PostgreSQL transaction is rolled back; no customer data is retained.
begin;

do $batch105_user$
declare v_owner uuid := gen_random_uuid();
begin
  insert into auth.users(id) values(v_owner);
  perform set_config('batch105.owner_id',v_owner::text,true);
end;
$batch105_user$;

set role service_role;

do $batch105_release_guards$
declare
  v_owner uuid := current_setting('batch105.owner_id')::uuid;
  v_v2_job uuid := gen_random_uuid();
  v_legacy_job uuid := gen_random_uuid();
  v_direct_job uuid := gen_random_uuid();
  v_billing_job uuid := gen_random_uuid();
  v_v2_reservation uuid;
  v_legacy_reservation uuid;
  v_direct_reservation uuid;
  v_billing_reservation uuid;
  v_finished boolean;
  v_claim executive_visuals.jobs%rowtype;
begin
  insert into executive_visuals.credit_ledger(owner_id,entry_type,credit_delta,idempotency_key,reason,metadata)
  values(v_owner,'purchase_grant',500,'batch105-grant-'||v_owner::text,'Batch 105 test grant','{}'::jsonb);

  insert into executive_visuals.jobs(id,owner_id,job_type,status,input,idempotency_key,max_attempts)
  values
    (v_v2_job,v_owner,'batch105.v2','queued','{}'::jsonb,'batch105-v2-'||v_v2_job::text,2),
    (v_legacy_job,v_owner,'batch105.legacy','queued','{}'::jsonb,'batch105-legacy-'||v_legacy_job::text,2),
    (v_direct_job,v_owner,'batch105.direct','queued','{}'::jsonb,'batch105-direct-'||v_direct_job::text,2),
    (v_billing_job,v_owner,'video.generate','queued','{"provider":"runway","model":"model-router"}'::jsonb,'batch105-billing-'||v_billing_job::text,2);

  v_v2_reservation := (executive_visuals.reserve_credit_units(
    v_owner,50,'batch105-v2-reserve-'||v_v2_job::text,'Batch 105 v2 reservation',v_v2_job,'{}'::jsonb
  )->>'reservation_id')::uuid;
  v_legacy_reservation := (executive_visuals.reserve_credit_units(
    v_owner,50,'batch105-legacy-reserve-'||v_legacy_job::text,'Batch 105 legacy reservation',v_legacy_job,'{}'::jsonb
  )->>'reservation_id')::uuid;
  v_direct_reservation := (executive_visuals.reserve_credit_units(
    v_owner,50,'batch105-direct-reserve-'||v_direct_job::text,'Batch 105 direct reservation',v_direct_job,'{}'::jsonb
  )->>'reservation_id')::uuid;

  -- finish_job_v2 must not atomically refund an unresolved provider charge.
  select * into v_claim from executive_visuals.claim_next_job_v2('batch105-worker-v2',90,array['batch105.v2']);
  if v_claim.id is distinct from v_v2_job then raise exception 'BATCH105_V2_FIXTURE_CLAIM_FAILED'; end if;
  begin
    v_finished := executive_visuals.finish_job_v2(
      v_v2_job,'batch105-worker-v2',v_claim.lease_token,'failed',null,
      '{"code":"PROVIDER_FAILURE","message":"provider charge not reconciled"}'::jsonb
    );
    raise exception 'BATCH105_V2_UNVERIFIED_RELEASE_WAS_NOT_BLOCKED';
  exception when sqlstate '55000' then
    if sqlerrm <> 'CREDIT_RELEASE_REQUIRES_VERIFIED_NO_CHARGE_EVIDENCE' then raise; end if;
  end;
  if (select status from executive_visuals.jobs where id=v_v2_job) <> 'processing'
     or (select status from executive_visuals.credit_reservations where id=v_v2_reservation) <> 'reserved' then
    raise exception 'BATCH105_V2_FAILURE_DID_NOT_ROLL_BACK_ATOMICALLY';
  end if;

  -- The legacy finalizer is guarded by the same database-level invariant.
  update executive_visuals.jobs
    set status='processing',lease_owner='batch105-worker-legacy',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '2 minutes'
    where id=v_legacy_job;
  begin
    v_finished := executive_visuals.finish_job(
      v_legacy_job,'batch105-worker-legacy','cancelled',null,
      '{"code":"CANCELLED","message":"provider charge not reconciled"}'::jsonb
    );
    raise exception 'BATCH105_LEGACY_UNVERIFIED_RELEASE_WAS_NOT_BLOCKED';
  exception when sqlstate '55000' then
    if sqlerrm <> 'CREDIT_RELEASE_REQUIRES_VERIFIED_NO_CHARGE_EVIDENCE' then raise; end if;
  end;
  if (select status from executive_visuals.jobs where id=v_legacy_job) <> 'processing'
     or (select status from executive_visuals.credit_reservations where id=v_legacy_reservation) <> 'reserved' then
    raise exception 'BATCH105_LEGACY_FAILURE_DID_NOT_ROLL_BACK_ATOMICALLY';
  end if;

  -- The direct generic release RPC cannot bypass the trigger.
  begin
    perform executive_visuals.release_credit_reservation(v_direct_reservation,'operator requested release');
    raise exception 'BATCH105_DIRECT_RELEASE_WAS_NOT_BLOCKED';
  exception when sqlstate '55000' then
    if sqlerrm <> 'CREDIT_RELEASE_REQUIRES_VERIFIED_NO_CHARGE_EVIDENCE' then raise; end if;
  end;
  if (select status from executive_visuals.credit_reservations where id=v_direct_reservation) <> 'reserved' then
    raise exception 'BATCH105_DIRECT_RELEASE_CHANGED_RESERVATION';
  end if;

  -- Customer workflow credits have a separate release RPC; it must fail closed too.
  insert into executive_visuals.billing_credit_accounts(owner_id) values(v_owner)
    on conflict(owner_id) do nothing;
  insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,idempotency_key,description)
  values(v_owner,1000,'grant','batch105-billing-grant-'||v_owner::text,'Batch 105 billing test grant');
  insert into executive_visuals.billing_credit_reservations(owner_id,job_id,idempotency_key,reserved_credits)
  values(v_owner,v_billing_job,'batch105-billing-reserve-'||v_billing_job::text,100)
  returning id into v_billing_reservation;

  begin
    perform * from executive_visuals.release_generation_credit_reservation(v_billing_reservation,'provider cancellation requested');
    raise exception 'BATCH105_BILLING_RELEASE_WAS_NOT_BLOCKED';
  exception when sqlstate '55000' then
    if sqlerrm <> 'BILLING_CREDIT_RELEASE_REQUIRES_VERIFIED_NO_CHARGE_EVIDENCE' then raise; end if;
  end;
  if (select state from executive_visuals.billing_credit_reservations where id=v_billing_reservation) <> 'reserved'
     or exists(select 1 from executive_visuals.billing_credit_ledger
       where reference_id=v_billing_job and event_type='generation_refund') then
    raise exception 'BATCH105_BILLING_RELEASE_CHANGED_CREDITS_OR_LEDGER';
  end if;
end;
$batch105_release_guards$;

reset role;
rollback;
select 'PROVIDER_CHARGE_SAFE_CREDIT_RELEASE_BATCH_105_OK' as result;
