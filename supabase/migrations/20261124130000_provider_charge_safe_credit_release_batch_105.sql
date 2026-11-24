-- Batch 105: prevent any generic reservation path from releasing customer credits
-- while provider billing may still be unresolved.
-- This guard is intentionally fail-closed. It does not activate provider dispatch,
-- alter payment entitlements, or release any existing reservation.
--
-- A future release path must first persist trusted, provider-verifiable no-charge
-- evidence and then replace this guard in a separately reviewed migration.

create or replace function executive_visuals.reject_unverified_credit_reservation_release()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $reject_unverified_credit_reservation_release$
begin
  if tg_table_name = 'credit_reservations' then
    if new.status = 'released' then
      if tg_op = 'INSERT' or old.status is distinct from 'released' then
        raise exception using
          message = 'CREDIT_RELEASE_REQUIRES_VERIFIED_NO_CHARGE_EVIDENCE',
          errcode = '55000';
      end if;
    end if;
  elsif tg_table_name = 'billing_credit_reservations' then
    if new.state = 'released' then
      if tg_op = 'INSERT' or old.state is distinct from 'released' then
        raise exception using
          message = 'BILLING_CREDIT_RELEASE_REQUIRES_VERIFIED_NO_CHARGE_EVIDENCE',
          errcode = '55000';
      end if;
    end if;
  else
    raise exception 'CREDIT_RELEASE_GUARD_TABLE_UNSUPPORTED';
  end if;
  return new;
end;
$reject_unverified_credit_reservation_release$;

revoke all on function executive_visuals.reject_unverified_credit_reservation_release()
  from public, anon, authenticated, service_role;

drop trigger if exists ev_credit_reservations_require_no_charge_evidence
  on executive_visuals.credit_reservations;
create trigger ev_credit_reservations_require_no_charge_evidence
before insert or update of status on executive_visuals.credit_reservations
for each row
execute function executive_visuals.reject_unverified_credit_reservation_release();

drop trigger if exists ev_billing_credit_reservations_require_no_charge_evidence
  on executive_visuals.billing_credit_reservations;
create trigger ev_billing_credit_reservations_require_no_charge_evidence
before insert or update of state on executive_visuals.billing_credit_reservations
for each row
execute function executive_visuals.reject_unverified_credit_reservation_release();

comment on function executive_visuals.reject_unverified_credit_reservation_release() is
  'Fail-closed guard: blocks reservation release until a separately reviewed provider-verifiable no-charge evidence path exists.';


-- Keep terminal job state transitions available without refunding an unresolved
-- reservation. The reservation remains reserved for the reconciliation worker.
create or replace function executive_visuals.finish_job_v2(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_status text,
  p_output jsonb default null,
  p_error jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $finish_job_v2$
declare
  finished executive_visuals.jobs;
  reservation_row executive_visuals.credit_reservations%rowtype;
  cancellation_won boolean;
  reservation_status text := 'none';
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128
     or p_lease_token is null then
    raise exception 'invalid worker lease identity';
  end if;
  if p_status not in ('succeeded','partial','failed','cancelled') then
    raise exception 'invalid terminal job status';
  end if;
  if (p_output is not null and jsonb_typeof(p_output) <> 'object')
     or (p_error is not null and jsonb_typeof(p_error) <> 'object') then
    raise exception 'job output and error must be JSON objects';
  end if;

  update executive_visuals.jobs
  set status = case when cancel_requested_at is not null then 'cancelled' else p_status end,
      progress = case when cancel_requested_at is null and p_status in ('succeeded','partial') then 100 else progress end,
      output = case when cancel_requested_at is not null then null else p_output end,
      error = case when cancel_requested_at is not null
        then jsonb_build_object('code','JOB_CANCELLED','message','Cancellation was requested by the job owner.')
        else p_error end,
      completed_at = clock_timestamp(),
      updated_at = clock_timestamp(),
      lease_owner = null,
      lease_expires_at = null,
      lease_heartbeat_at = null
  where id = p_job_id
    and status = 'processing'
    and lease_owner = p_worker_id
    and lease_token = p_lease_token
    and lease_expires_at > clock_timestamp()
  returning * into finished;

  if finished.id is null then return false; end if;

  cancellation_won := finished.status = 'cancelled' and finished.cancel_requested_at is not null;
  perform pg_advisory_xact_lock(hashtextextended(finished.owner_id::text,0));

  select * into reservation_row
    from executive_visuals.credit_reservations
   where job_id = finished.id
   for update;

  if found then
    if reservation_row.owner_id <> finished.owner_id then
      raise exception 'Job credit reservation owner mismatch';
    end if;

    reservation_status := reservation_row.status;
    if reservation_row.status = 'reserved' then
      if finished.status = 'succeeded' then
        insert into executive_visuals.credit_ledger
          (owner_id,entry_type,credit_delta,idempotency_key,job_id,reason,metadata)
        values
          (reservation_row.owner_id,'settlement',-reservation_row.credit_units,
           'credit-settlement:'||reservation_row.id::text,reservation_row.job_id,
           'Settled reserved credits after successful cloud job',
           jsonb_build_object('reservation_id',reservation_row.id,'job_id',finished.id))
        on conflict(owner_id,idempotency_key) do nothing;

        update executive_visuals.credit_reservations
           set status='settled',settled_at=clock_timestamp(),updated_at=clock_timestamp()
         where id=reservation_row.id;
        reservation_status := 'settled';
      else
        -- A terminal job is not proof of zero provider charges. Keep the hold
        -- intact and let reconciliation settle or safely release it later.
        update executive_visuals.credit_reservations
           set metadata=metadata||jsonb_build_object(
             'reconciliation_required',true,
             'reconciliation_reason','Provider charge not yet verified',
             'terminal_status',finished.status,
             'owner_cancellation_won',cancellation_won
           ),
               updated_at=clock_timestamp()
         where id=reservation_row.id;
        reservation_status := 'reserved';
      end if;
    elsif reservation_row.status not in ('settled','released') then
      raise exception 'Unknown credit reservation state';
    end if;
  end if;

  insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
  values (
    finished.id,finished.owner_id,'job.'||finished.status,
    jsonb_build_object(
      'status',finished.status,
      'creditReservationStatus',reservation_status,
      'ownerCancellationWon',cancellation_won,
      'creditReconciliationRequired',reservation_status='reserved'
    )
  );
  return true;
end;
$finish_job_v2$;

create or replace function executive_visuals.finish_job(
  p_job_id uuid,
  p_worker_id text,
  p_status text,
  p_output jsonb default null,
  p_error jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $finish_job$
declare
  finished executive_visuals.jobs;
  reservation_row executive_visuals.credit_reservations%rowtype;
  reservation_status text := 'none';
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128 then
    raise exception 'worker_id must contain between 1 and 128 characters';
  end if;
  if p_status not in ('succeeded','partial','failed','cancelled') then
    raise exception 'invalid terminal job status';
  end if;
  if (p_output is not null and jsonb_typeof(p_output) <> 'object')
     or (p_error is not null and jsonb_typeof(p_error) <> 'object') then
    raise exception 'job output and error must be JSON objects';
  end if;

  update executive_visuals.jobs
  set status = p_status,
      progress = case when p_status in ('succeeded','partial') then 100 else progress end,
      output = p_output,
      error = p_error,
      completed_at = clock_timestamp(),
      updated_at = clock_timestamp(),
      lease_owner = null,
      lease_expires_at = null,
      lease_heartbeat_at = null
  where id = p_job_id
    and status = 'processing'
    and lease_owner = p_worker_id
    and lease_expires_at > clock_timestamp()
  returning * into finished;

  if finished.id is null then return false; end if;

  perform pg_advisory_xact_lock(hashtextextended(finished.owner_id::text,0));
  select * into reservation_row
    from executive_visuals.credit_reservations
   where job_id = finished.id
   for update;

  if found then
    if reservation_row.owner_id <> finished.owner_id then
      raise exception 'Job credit reservation owner mismatch';
    end if;

    reservation_status := reservation_row.status;
    if reservation_row.status = 'reserved' then
      if p_status = 'succeeded' then
        insert into executive_visuals.credit_ledger
          (owner_id,entry_type,credit_delta,idempotency_key,job_id,reason,metadata)
        values
          (reservation_row.owner_id,'settlement',-reservation_row.credit_units,
           'credit-settlement:'||reservation_row.id::text,reservation_row.job_id,
           'Settled reserved credits after successful cloud job',
           jsonb_build_object('reservation_id',reservation_row.id,'job_id',finished.id))
        on conflict(owner_id,idempotency_key) do nothing;

        update executive_visuals.credit_reservations
           set status='settled',settled_at=clock_timestamp(),updated_at=clock_timestamp()
         where id=reservation_row.id;
        reservation_status := 'settled';
      else
        update executive_visuals.credit_reservations
           set metadata=metadata||jsonb_build_object(
             'reconciliation_required',true,
             'reconciliation_reason','Provider charge not yet verified',
             'terminal_status',p_status
           ),
               updated_at=clock_timestamp()
         where id=reservation_row.id;
        reservation_status := 'reserved';
      end if;
    elsif reservation_row.status not in ('settled','released') then
      raise exception 'Unknown credit reservation state';
    end if;
  end if;

  insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
  values (
    finished.id,finished.owner_id,'job.'||p_status,
    jsonb_build_object(
      'status',p_status,
      'creditReservationStatus',reservation_status,
      'creditReconciliationRequired',reservation_status='reserved'
    )
  );
  return true;
end;
$finish_job$;

revoke all on function executive_visuals.finish_job_v2(uuid,text,uuid,text,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function executive_visuals.finish_job_v2(uuid,text,uuid,text,jsonb,jsonb)
  to service_role;
revoke all on function executive_visuals.finish_job(uuid,text,text,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function executive_visuals.finish_job(uuid,text,text,jsonb,jsonb)
  to service_role;
