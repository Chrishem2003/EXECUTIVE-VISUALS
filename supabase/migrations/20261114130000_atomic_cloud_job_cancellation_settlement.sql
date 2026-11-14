-- Keep generic cloud-job cancellation, worker fencing and credit settlement atomic.
-- This migration is additive and must be applied only to the isolated Executive Visuals database
-- after review. It is not applied to shared staging or production by this change.

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
as $$
declare
  finished executive_visuals.jobs;
  reservation_row executive_visuals.credit_reservations%rowtype;
  cancellation_won boolean;
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

  -- Lock the exact active attempt. If the owner cancellation request committed
  -- first, cancellation wins over a late success/failure finalization.
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

  if finished.id is null then
    return false;
  end if;

  cancellation_won := finished.status = 'cancelled';

  -- Preserve the owner-level credit lock order used by reserve/release RPCs.
  perform pg_advisory_xact_lock(hashtextextended(finished.owner_id::text,0));

  select * into reservation_row
    from executive_visuals.credit_reservations
   where job_id = finished.id
   for update;

  if found then
    if reservation_row.owner_id <> finished.owner_id then
      raise exception 'Job credit reservation owner mismatch';
    end if;

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
      else
        update executive_visuals.credit_reservations
           set status='released',released_at=clock_timestamp(),updated_at=clock_timestamp(),
               metadata=metadata||jsonb_build_object(
                 'release_reason','Cloud job ended with status '||finished.status,
                 'terminal_status',finished.status,
                 'owner_cancellation_won',cancellation_won
               )
         where id=reservation_row.id;
      end if;
    elsif reservation_row.status not in ('settled','released') then
      raise exception 'Unknown credit reservation state';
    end if;
  end if;

  insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
  values (
    finished.id,
    finished.owner_id,
    'job.'||finished.status,
    jsonb_build_object(
      'status',finished.status,
      'creditReservationStatus',case when reservation_row.id is null then 'none'
        when finished.status='succeeded' then 'settled'
        else 'released' end,
      'ownerCancellationWon',cancellation_won
    )
  );
  return true;
end;
$$;

revoke all on function executive_visuals.finish_job_v2(uuid,text,uuid,text,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function executive_visuals.finish_job_v2(uuid,text,uuid,text,jsonb,jsonb)
  to service_role;
