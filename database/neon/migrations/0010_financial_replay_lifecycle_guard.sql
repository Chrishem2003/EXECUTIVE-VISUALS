-- Executive Visuals: validate financial reservation lifecycle on idempotent video enqueue replay.
-- Source-controlled only. CI applies this to disposable PostgreSQL; do not apply to live Neon/production.
begin;

alter function executive_visuals.enqueue_video_generation_job_v1(uuid,uuid,text,jsonb,uuid,numeric,bigint,integer)
  rename to enqueue_video_generation_job_v1_pre_replay_guard;

create function executive_visuals.enqueue_video_generation_job_v1(
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
declare result_row record; job_row executive_visuals.jobs;
 budget_row executive_visuals.video_generation_budget_reservations;
 credit_row executive_visuals.billing_credit_reservations;
 lifecycle_valid boolean:=false;
begin
 select * into result_row from executive_visuals.enqueue_video_generation_job_v1_pre_replay_guard(
  p_owner_id,p_project_id,p_idempotency_key,p_input,p_budget_approval_id,
  p_reserved_amount,p_reserved_credits,p_max_attempts
 );

 if result_row.job_id is null then
  raise exception 'VIDEO_ENQUEUE_REPLAY_RECEIPT_INVALID';
 end if;

 if result_row.idempotent_replay then
  -- Lock the job and both reservation records before validating the replay.
  select * into job_row from executive_visuals.jobs
   where id=result_row.job_id and owner_id=p_owner_id and job_type='video.generate'
   for update;
  select * into budget_row from executive_visuals.video_generation_budget_reservations as reservation
   where reservation.job_id=result_row.job_id for update;
  select * into credit_row from executive_visuals.billing_credit_reservations as reservation
   where reservation.job_id=result_row.job_id for update;

  if job_row.id is null or budget_row.id is null or credit_row.id is null
   or budget_row.owner_id is distinct from p_owner_id
   or credit_row.owner_id is distinct from p_owner_id
   or budget_row.approval_id is distinct from p_budget_approval_id
   or budget_row.reserved_amount is distinct from p_reserved_amount
   or credit_row.reserved_credits is distinct from p_reserved_credits then
   raise exception 'VIDEO_FINANCIAL_REPLAY_RESERVATION_CONFLICT';
  end if;

  -- Active jobs retain provider budget. Customer credits may already be settled
  -- only after the authoritative pre-ingestion provider usage receipt.
  if job_row.status in ('queued','processing','reviewing','blocked','needs_input') then
   lifecycle_valid:=budget_row.state='reserved'
    and credit_row.state in ('reserved','settled');
   if credit_row.state='settled' then
    lifecycle_valid:=lifecycle_valid
     and credit_row.actual_credits is not null
     and jsonb_typeof(credit_row.evidence)='object'
     and coalesce(credit_row.evidence->>'provider','')=budget_row.provider
     and coalesce(credit_row.evidence->>'evidenceId','')<>''
     and coalesce(credit_row.evidence->>'evidenceReference','')<>'';
   end if;
  elsif job_row.status in ('succeeded','partial') then
   lifecycle_valid:=budget_row.state='settled'
    and credit_row.state='settled'
    and budget_row.actual_amount is not null
    and credit_row.actual_credits is not null;
  elsif job_row.status in ('failed','cancelled') then
   lifecycle_valid:=budget_row.state='released'
    and credit_row.state='released'
    and credit_row.actual_credits=0
    and coalesce(credit_row.evidence->>'evidenceType','') in
      ('verified_no_charge_cancellation','verified_no_submission');
  end if;

  if not lifecycle_valid then
   raise exception 'VIDEO_FINANCIAL_REPLAY_LIFECYCLE_CONFLICT';
  end if;
 end if;

 return query select result_row.job_id,result_row.job_status,result_row.idempotent_replay,
  result_row.budget_reservation_id,result_row.credit_reservation_id,result_row.available_credits;
end;
$$;

revoke all on function executive_visuals.enqueue_video_generation_job_v1(uuid,uuid,text,jsonb,uuid,numeric,bigint,integer)
 from public;

do $service_role_grants$
begin
 if exists(select 1 from pg_roles where rolname='service_role') then
  execute 'revoke all on function executive_visuals.enqueue_video_generation_job_v1_pre_replay_guard(uuid,uuid,text,jsonb,uuid,numeric,bigint,integer) from service_role';
  execute 'grant execute on function executive_visuals.enqueue_video_generation_job_v1(uuid,uuid,text,jsonb,uuid,numeric,bigint,integer) to service_role';
 end if;
end;
$service_role_grants$;
commit;
