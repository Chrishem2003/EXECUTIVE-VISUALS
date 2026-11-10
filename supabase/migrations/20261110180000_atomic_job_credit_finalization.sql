-- Batch 5: atomically settle or release reserved credits with the cloud job's terminal transition.
-- A worker must never mark a billable job complete without finalizing its reservation.
create unique index if not exists credit_reservations_one_per_job_idx
  on executive_visuals.credit_reservations(job_id)
  where job_id is not null;

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
as $$
declare
  finished executive_visuals.jobs;
  reservation_row executive_visuals.credit_reservations%rowtype;
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

  if finished.id is null then
    return false;
  end if;

  -- Keep owner-level credit lock ordering consistent with reserve/release RPCs.
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
      else
        update executive_visuals.credit_reservations
           set status='released',released_at=clock_timestamp(),updated_at=clock_timestamp(),
               metadata=metadata||jsonb_build_object(
                 'release_reason','Cloud job ended with status '||p_status,
                 'terminal_status',p_status
               )
         where id=reservation_row.id;
      end if;
    elsif reservation_row.status not in ('settled','released') then
      raise exception 'Unknown credit reservation state';
    end if;
  end if;

  insert into executive_visuals.job_events(job_id, owner_id, event_type, event_data)
  values (
    finished.id,
    finished.owner_id,
    'job.' || p_status,
    jsonb_build_object('status', p_status,
      'creditReservationStatus',case when reservation_row.id is null then 'none'
        else reservation_row.status end)
  );
  return true;
end;
$$;

revoke all on function executive_visuals.finish_job(uuid,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function executive_visuals.finish_job(uuid,text,text,jsonb,jsonb) to service_role;
