begin;

-- Admit a video request and reserve its budget + customer credits atomically.
-- A failure in either reservation rolls back the queue row and enqueue event.
create or replace function executive_visuals.enqueue_video_generation_job_v1(
 p_owner_id uuid,
 p_project_id uuid,
 p_idempotency_key text,
 p_input jsonb,
 p_budget_approval_id uuid,
 p_reserved_amount numeric,
 p_reserved_credits bigint,
 p_max_attempts integer default 2
) returns table(
 job_id uuid,
 job_status text,
 idempotent_replay boolean,
 budget_reservation_id uuid,
 credit_reservation_id uuid,
 available_credits bigint
)
language plpgsql security definer
set search_path=pg_catalog,executive_visuals as $$
declare queued record; reserved record; credit_key text;
begin
 if p_owner_id is null or p_budget_approval_id is null
  or p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200
  or p_input is null or jsonb_typeof(p_input)<>'object'
  or octet_length(p_input::text)>1048576
  or coalesce(p_input->>'provider','')=''
  or coalesce(p_input->>'model','')=''
  or coalesce(p_input->>'requestHash','') !~ '^[a-f0-9]{64}$'
  or p_reserved_amount is null or p_reserved_amount<=0 or p_reserved_amount>1000000
  or p_reserved_credits is null or p_reserved_credits<1 or p_reserved_credits>100000000
  or p_max_attempts is null or p_max_attempts not between 1 and 10 then
  raise exception 'VIDEO_ENQUEUE_ARGUMENTS_INVALID';
 end if;

 select * into queued from executive_visuals.enqueue_job_v1(
  p_owner_id,p_project_id,'video.generate',p_input,p_idempotency_key,p_max_attempts
 );
 if queued.job_id is null then raise exception 'VIDEO_ENQUEUE_JOB_ADMISSION_FAILED'; end if;

 credit_key:='video-generation-reserve:'||queued.job_id::text;
 select * into reserved from executive_visuals.reserve_video_generation_financials_v1(
  queued.job_id,p_owner_id,p_budget_approval_id,p_reserved_amount,p_reserved_credits,credit_key
 );
 if reserved.budget_reservation_id is null or reserved.credit_reservation_id is null then
  raise exception 'VIDEO_ENQUEUE_FINANCIAL_RESERVATION_FAILED';
 end if;

 return query select queued.job_id,queued.status,queued.replayed,
  reserved.budget_reservation_id,reserved.credit_reservation_id,reserved.available_credits;
end $$;

revoke all on function executive_visuals.enqueue_video_generation_job_v1(uuid,uuid,text,jsonb,uuid,numeric,bigint,integer) from public;
commit;
