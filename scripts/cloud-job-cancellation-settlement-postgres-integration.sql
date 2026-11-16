-- Transactional regression for the owner-cancellation vs late-worker-completion race.
-- The synthetic owner and job are rolled back; no durable test data is retained.
begin;

do $cloud_cancel_smoke$
declare
  v_owner uuid := gen_random_uuid();
  v_job_id uuid := gen_random_uuid();
  v_claim executive_visuals.jobs%rowtype;
  v_reservation jsonb;
  v_reservation_id uuid;
  v_finished boolean;
begin
  if has_function_privilege('anon','executive_visuals.finish_job_v2(uuid,text,uuid,text,jsonb,jsonb)','EXECUTE')
     or has_function_privilege('authenticated','executive_visuals.finish_job_v2(uuid,text,uuid,text,jsonb,jsonb)','EXECUTE')
     or not has_function_privilege('service_role','executive_visuals.finish_job_v2(uuid,text,uuid,text,jsonb,jsonb)','EXECUTE') then
    raise exception 'Cloud job finalization RPC is not service-role only';
  end if;

  insert into auth.users(id) values(v_owner);
  insert into executive_visuals.credit_ledger(owner_id,entry_type,credit_delta,idempotency_key,reason,metadata)
  values(v_owner,'purchase_grant',100,'cloud-cancel-grant-'||v_job_id::text,'Cloud cancellation smoke grant','{}'::jsonb);

  insert into executive_visuals.jobs(
    id,owner_id,job_type,status,input,idempotency_key,max_attempts
  ) values(
    v_job_id,v_owner,'migration.smoke.cancel','queued','{}'::jsonb,
    'cloud-cancel-smoke-'||v_job_id::text,2
  );
  v_reservation := executive_visuals.reserve_credit_units(
    v_owner,25,'cloud-cancel-reserve-'||v_job_id::text,'Cloud cancellation smoke reservation',v_job_id,'{}'::jsonb
  );
  v_reservation_id := (v_reservation->>'reservation_id')::uuid;
  if v_reservation_id is null then raise exception 'Credit reservation was not created'; end if;

  select * into v_claim from executive_visuals.claim_next_job_v2(
    'cloud-cancel-smoke-worker',90,array['migration.smoke.cancel']
  );
  if v_claim.id is distinct from v_job_id or v_claim.lease_token is null then
    raise exception 'Cloud worker claim did not issue the expected job lease and fencing token';
  end if;

  update executive_visuals.jobs set cancel_requested_at=now() where id=v_job_id;
  v_finished := executive_visuals.finish_job_v2(
    v_job_id,'cloud-cancel-smoke-worker',v_claim.lease_token,'succeeded',
    '{"mustNotPersist":true}'::jsonb,null
  );
  if not v_finished
     or (select status from executive_visuals.jobs where id=v_job_id) <> 'cancelled'
     or (select output from executive_visuals.jobs where id=v_job_id) is not null
     or (select completed_at from executive_visuals.jobs where id=v_job_id) is null
     or (select status from executive_visuals.credit_reservations where id=v_reservation_id) <> 'released'
     or (select released_at from executive_visuals.credit_reservations where id=v_reservation_id) is null then
    raise exception 'Owner cancellation did not atomically override late worker completion';
  end if;
end;
$cloud_cancel_smoke$;

rollback;
