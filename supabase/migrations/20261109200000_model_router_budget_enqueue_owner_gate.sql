-- Repair the governed Runway Model Router workflow enqueue contract.
-- The generic video enqueue RPC intentionally supports direct provider adapters;
-- this workflow RPC has its own quote-bound price evidence and atomic reservation.
-- This migration is source-controlled only; do not apply to shared staging/production.

create or replace function executive_visuals.validate_video_budget_approval()
returns trigger
language plpgsql
set search_path = pg_catalog, executive_visuals
as $validate_video_budget_approval$
begin
  -- Server-side approval RPCs execute with service_role. Direct authenticated
  -- inserts remain bound to auth.uid() and the project's owner.
  if current_user not in ('postgres','service_role')
     and coalesce(auth.role(), '') <> 'service_role'
     and new.owner_id is distinct from auth.uid() then
    raise exception 'VIDEO_BUDGET_APPROVAL_OWNER_INVALID';
  end if;
  if new.project_id is not null and not exists (
    select 1 from executive_visuals.projects p
    where p.id = new.project_id and p.owner_id = new.owner_id
  ) then
    raise exception 'VIDEO_BUDGET_APPROVAL_PROJECT_OWNER_INVALID' using errcode = '42501';
  end if;
  new.created_at := clock_timestamp();
  new.consumed_at := null;
  if new.expires_at <= clock_timestamp()
     or new.expires_at > clock_timestamp() + interval '15 minutes' then
    raise exception 'VIDEO_BUDGET_APPROVAL_EXPIRY_INVALID';
  end if;
  return new;
end;
$validate_video_budget_approval$;

create or replace function executive_visuals.approve_and_enqueue_video_workflow(
  p_quote_id uuid,
  p_approval_id uuid,
  p_owner_id uuid,
  p_project_id uuid,
  p_request_hash text,
  p_config_id text,
  p_idempotency_key text,
  p_input jsonb,
  p_approved_max_amount numeric,
  p_approval_note text
)
returns table(
  job_id uuid,
  job_status text,
  idempotent_replay boolean,
  budget_reservation_id uuid,
  approval_id uuid
)
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $approve_and_enqueue_video_workflow$
declare
  quote_row executive_visuals.video_workflow_quotes;
  existing executive_visuals.jobs;
  policy executive_visuals.video_generation_budget_policies;
  inserted_job executive_visuals.jobs;
  reservation_id uuid;
  consumed_approval_id uuid;
  reservation_amount numeric;
  used_requests bigint;
begin
  if p_quote_id is null or p_approval_id is null or p_owner_id is null or p_project_id is null
     or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
     or p_config_id is null or p_config_id !~ '^[a-z][a-z0-9_-]{0,63}$'
     or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,180}$'
     or jsonb_typeof(p_input) is distinct from 'object'
     or octet_length(p_input::text) > 32000
     or p_approved_max_amount is null or p_approved_max_amount <= 0 or p_approved_max_amount > 1000000
     or p_approval_note is null or char_length(btrim(p_approval_note)) < 1
     or char_length(p_approval_note) > 1000 then
    raise exception 'VIDEO_WORKFLOW_APPROVAL_ARGUMENTS_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || p_idempotency_key, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':video.generate', 0));

  if not exists (
    select 1 from executive_visuals.projects p
    where p.id = p_project_id and p.owner_id = p_owner_id
    for update
  ) then
    raise exception 'VIDEO_JOB_PROJECT_FORBIDDEN';
  end if;

  select * into quote_row
  from executive_visuals.video_workflow_quotes q
  where q.id = p_quote_id
  for update;

  if quote_row.id is null
     or quote_row.owner_id is distinct from p_owner_id
     or quote_row.project_id is distinct from p_project_id then
    raise exception 'VIDEO_WORKFLOW_QUOTE_NOT_FOUND';
  end if;

  -- A retry of the exact same consumed quote returns its original job and
  -- reservation. It never creates a second approval or charges twice.
  select * into existing
  from executive_visuals.jobs j
  where j.owner_id = p_owner_id and j.idempotency_key = p_idempotency_key
  for update;

  if existing.id is not null then
    if existing.job_type <> 'video.generate'
       or existing.project_id is distinct from p_project_id
       or coalesce(existing.input ->> 'requestHash','') <> p_request_hash
       or existing.input is distinct from p_input
       or coalesce(existing.input ->> 'workflowQuoteId','') <> p_quote_id::text
       or coalesce(existing.input ->> 'workflowRequestId','') <> quote_row.request_id
       or coalesce(existing.input ->> 'provider','') <> 'runway'
       or coalesce(existing.input ->> 'model','') <> 'model-router'
       or quote_row.request_hash <> p_request_hash
       or quote_row.request_id <> p_idempotency_key
       or quote_row.config_id <> p_config_id
       or quote_row.state <> 'consumed' then
      raise exception 'VIDEO_WORKFLOW_APPROVAL_IDEMPOTENCY_CONFLICT';
    end if;

    select r.id, r.approval_id, r.reserved_amount
      into reservation_id, consumed_approval_id, reservation_amount
    from executive_visuals.video_generation_budget_reservations r
    where r.job_id = existing.id;

    if reservation_id is null or consumed_approval_id is null
       or reservation_amount is distinct from p_approved_max_amount then
      raise exception 'VIDEO_WORKFLOW_APPROVAL_RESERVATION_MISSING';
    end if;

    return query select existing.id, existing.status, true, reservation_id, consumed_approval_id;
    return;
  end if;

  if quote_row.state <> 'quoted' or quote_row.expires_at <= clock_timestamp() then
    raise exception 'VIDEO_WORKFLOW_QUOTE_EXPIRED_OR_CONSUMED';
  end if;

  if quote_row.request_hash <> p_request_hash
     or quote_row.request_id <> p_idempotency_key
     or quote_row.provider <> 'runway'
     or quote_row.model <> 'model-router'
     or quote_row.config_id <> p_config_id
     or coalesce(p_input ->> 'provider','') <> quote_row.provider
     or coalesce(p_input ->> 'model','') <> quote_row.model
     or coalesce(p_input ->> 'operation','') <> quote_row.operation
     or coalesce(p_input ->> 'requestHash','') <> quote_row.request_hash
     or coalesce(p_input ->> 'projectId','') <> quote_row.project_id::text
     or coalesce(p_input ->> 'workflowQuoteId','') <> quote_row.id::text
     or coalesce(p_input ->> 'workflowRequestId','') <> quote_row.request_id
     or coalesce(p_input ->> 'outputFormat','mp4') <> 'mp4'
     or coalesce(p_input ->> 'durationSeconds','') !~ '^[0-9]{1,2}$'
     or (p_input ->> 'durationSeconds')::integer not between 2 and 30 then
    raise exception 'VIDEO_WORKFLOW_APPROVAL_REQUEST_MISMATCH';
  end if;

  if p_approved_max_amount < quote_row.estimated_amount then
    raise exception 'VIDEO_WORKFLOW_APPROVAL_BELOW_QUOTE';
  end if;

  select * into policy
  from executive_visuals.video_generation_budget_policies b
  where b.owner_id = p_owner_id
    and b.project_id = p_project_id
    and b.provider = 'runway'
    and b.model = 'model-router'
    and b.currency = quote_row.currency
    and b.enabled = true
  for update;

  if policy.id is null then
    raise exception 'VIDEO_JOB_BUDGET_POLICY_DISABLED';
  end if;

  if p_approved_max_amount > policy.max_per_job_amount
     or policy.reserved_amount + policy.spent_amount + p_approved_max_amount > policy.spend_limit_amount then
    raise exception 'VIDEO_JOB_BUDGET_LIMIT_REACHED';
  end if;

  select count(*) into used_requests
  from executive_visuals.video_generation_usage_reservations u
  where u.owner_id = p_owner_id and u.provider = 'runway' and u.model = 'model-router'
    and u.created_at >= clock_timestamp() - interval '24 hours';

  if policy.rolling_24h_request_limit = 0 or used_requests >= policy.rolling_24h_request_limit then
    raise exception 'VIDEO_JOB_USAGE_LIMIT_REACHED';
  end if;

  insert into executive_visuals.video_generation_budget_approvals(
    id,owner_id,project_id,provider,model,request_hash,currency,
    approved_max_amount,approval_note,expires_at
  ) values (
    p_approval_id,p_owner_id,p_project_id,'runway','model-router',
    quote_row.request_hash,quote_row.currency,p_approved_max_amount,
    btrim(p_approval_note),quote_row.expires_at
  );

  -- Model Router uses a quote-bound dynamic route, so its verified dry-run
  -- estimate is the price floor. The generic direct-provider allowlist and
  -- hard-coded per-second price floor do not apply to this adapter.
  insert into executive_visuals.jobs(
    owner_id,project_id,job_type,status,input,idempotency_key,
    estimated_cost,approved_by,approved_at
  ) values (
    p_owner_id,p_project_id,'video.generate','queued',p_input,p_idempotency_key,
    jsonb_build_object('amount',p_approved_max_amount,'currency',quote_row.currency),
    p_owner_id,clock_timestamp()
  ) returning * into inserted_job;

  insert into executive_visuals.video_generation_budget_reservations(
    job_id,approval_id,policy_id,owner_id,project_id,provider,model,currency,reserved_amount
  ) values (
    inserted_job.id,p_approval_id,policy.id,p_owner_id,p_project_id,
    'runway','model-router',quote_row.currency,p_approved_max_amount
  ) returning id into reservation_id;

  insert into executive_visuals.video_generation_usage_reservations(job_id,owner_id,provider,model)
  values (inserted_job.id,p_owner_id,'runway','model-router');

  update executive_visuals.video_generation_budget_policies
  set reserved_amount=reserved_amount+p_approved_max_amount,updated_at=clock_timestamp()
  where id=policy.id;

  update executive_visuals.video_generation_budget_approvals
  set consumed_at=clock_timestamp()
  where id=p_approval_id;

  update executive_visuals.video_workflow_quotes
  set state='consumed'
  where id=p_quote_id and state='quoted';

  if not found then
    raise exception 'VIDEO_WORKFLOW_QUOTE_STATE_CONFLICT';
  end if;

  insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
  values (
    inserted_job.id,p_owner_id,'job.queued',
    jsonb_build_object('jobType','video.generate','provider','runway','model','model-router',
      'requestHash',p_request_hash,'workflowQuoteId',p_quote_id,
      'budgetReservationId',reservation_id,'reservedAmount',p_approved_max_amount,'currency',quote_row.currency)
  );

  insert into executive_visuals.audit_events(owner_id,project_id,event_type,subject_type,subject_id,details)
  values (
    p_owner_id,p_project_id,'job.queued','job',inserted_job.id::text,
    jsonb_build_object('jobType','video.generate','provider','runway','model','model-router',
      'requestHash',p_request_hash,'workflowQuoteId',p_quote_id,'budgetReservationId',reservation_id)
  );

  return query select inserted_job.id,inserted_job.status,false,reservation_id,p_approval_id;
end;
$approve_and_enqueue_video_workflow$;

revoke all on function executive_visuals.approve_and_enqueue_video_workflow(uuid,uuid,uuid,uuid,text,text,text,jsonb,numeric,text)
  from public, anon, authenticated;
grant execute on function executive_visuals.approve_and_enqueue_video_workflow(uuid,uuid,uuid,uuid,text,text,text,jsonb,numeric,text)
  to service_role;
