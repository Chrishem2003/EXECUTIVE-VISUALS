-- Aleph 2 transformation approval bridge.
-- Source-controlled only. Do not apply to shared staging or production without release approval.
-- Enables the existing transformation lane only after an exact, short-lived approval
-- is recorded in the durable budget ledger. Provider execution flags remain independent.

create or replace function executive_visuals.validate_video_budget_approval()
returns trigger
language plpgsql
set search_path = pg_catalog, executive_visuals
as $approval_trigger$
begin
  -- Preserve the authenticated owner check while allowing the trusted service-role RPC.
  if current_user <> 'service_role' and new.owner_id is distinct from auth.uid() then
    raise exception 'VIDEO_BUDGET_APPROVAL_OWNER_INVALID';
  end if;
  new.created_at := clock_timestamp();
  new.consumed_at := null;
  if new.expires_at <= clock_timestamp()
     or new.expires_at > clock_timestamp() + interval '15 minutes' then
    raise exception 'VIDEO_BUDGET_APPROVAL_EXPIRY_INVALID';
  end if;
  return new;
end;
$approval_trigger$;

create or replace function executive_visuals.create_video_generation_budget_approval(
  p_approval_id uuid,
  p_owner_id uuid,
  p_project_id uuid,
  p_provider text,
  p_model text,
  p_request_hash text,
  p_currency text,
  p_approved_max_amount numeric,
  p_approval_note text,
  p_expires_at timestamptz
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $video_approval$
declare
  policy executive_visuals.video_generation_budget_policies;
begin
  if p_approval_id is null or p_owner_id is null or p_project_id is null
     or p_provider <> 'runway' or p_model <> 'aleph2'
     or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
     or p_currency <> 'USD'
     or p_approved_max_amount is null or p_approved_max_amount < 0.56
     or p_approval_note is null or char_length(p_approval_note) > 1000
     or p_expires_at is null or p_expires_at <= clock_timestamp()
     or p_expires_at > clock_timestamp() + interval '15 minutes' then
    raise exception 'VIDEO_BUDGET_APPROVAL_ARGUMENTS_INVALID';
  end if;
  if not exists (
    select 1 from executive_visuals.projects p
    where p.id = p_project_id and p.owner_id = p_owner_id
  ) then
    raise exception 'VIDEO_JOB_PROJECT_FORBIDDEN';
  end if;
  select * into policy
  from executive_visuals.video_generation_budget_policies b
  where b.owner_id = p_owner_id and b.project_id = p_project_id
    and b.provider = p_provider and b.model = p_model
    and b.currency = p_currency and b.enabled = true
  for update;
  if policy.id is null then
    raise exception 'VIDEO_JOB_BUDGET_POLICY_DISABLED';
  end if;
  if p_approved_max_amount > policy.max_per_job_amount
     or policy.reserved_amount + policy.spent_amount + p_approved_max_amount > policy.spend_limit_amount then
    raise exception 'VIDEO_JOB_BUDGET_LIMIT_REACHED';
  end if;
  insert into executive_visuals.video_generation_budget_approvals(
    id,owner_id,project_id,provider,model,request_hash,currency,
    approved_max_amount,approval_note,expires_at
  ) values (
    p_approval_id,p_owner_id,p_project_id,p_provider,p_model,p_request_hash,p_currency,
    p_approved_max_amount,p_approval_note,p_expires_at
  );
  return p_approval_id;
end;
$video_approval$;

revoke all on function executive_visuals.create_video_generation_budget_approval(uuid,uuid,uuid,text,text,text,text,numeric,text,timestamptz)
  from public, anon, authenticated;
grant execute on function executive_visuals.create_video_generation_budget_approval(uuid,uuid,uuid,text,text,text,text,numeric,text,timestamptz)
  to service_role;

create or replace function executive_visuals.enqueue_video_generation_job(
  p_owner_id uuid,
  p_project_id uuid,
  p_idempotency_key text,
  p_provider text,
  p_model text,
  p_request_hash text,
  p_input jsonb,
  p_budget_approval_id uuid,
  p_reserved_amount numeric,
  p_currency text
)
returns table(job_id uuid, job_status text, idempotent_replay boolean, budget_reservation_id uuid)
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $video_enqueue$
declare
  existing executive_visuals.jobs;
  policy executive_visuals.video_generation_budget_policies;
  approval executive_visuals.video_generation_budget_approvals;
  inserted_job executive_visuals.jobs;
  reservation_id uuid;
  used_requests bigint;
begin
  if p_owner_id is null
     or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,180}$'
     or p_provider is null or char_length(p_provider) not between 1 and 100
     or p_model is null or char_length(p_model) not between 1 and 160
     or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(p_input) <> 'object'
     or octet_length(p_input::text) > 32000
     or coalesce(p_input ->> 'provider','') <> p_provider
     or coalesce(p_input ->> 'model','') <> p_model
     or coalesce(p_input ->> 'requestHash','') <> p_request_hash
     or coalesce(p_input ->> 'projectId','') <> coalesce(p_project_id::text,'')
     or p_reserved_amount is null or p_reserved_amount <= 0
     or p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'VIDEO_ENQUEUE_ARGUMENTS_INVALID';
  end if;
  if not (
    (p_provider = 'runway' and p_model in ('gen4.5','aleph2'))
    or (p_provider = 'google' and p_model = 'gemini-omni-1.1-flash')
  ) then
    raise exception 'VIDEO_ENQUEUE_PROVIDER_NOT_ENABLED';
  end if;
  if p_currency <> 'USD' then
    raise exception 'VIDEO_PRICE_CURRENCY_UNSUPPORTED';
  end if;
  if coalesce(p_input ->> 'outputFormat','mp4') <> 'mp4' then
    raise exception 'VIDEO_PRICE_OUTPUT_FORMAT_UNSUPPORTED';
  end if;
  if p_provider = 'runway' and p_model = 'aleph2' then
    if coalesce(p_input ->> 'operation','') <> 'video-to-video'
       or coalesce(p_input ->> 'durationSeconds','') !~ '^[0-9]'
       or coalesce(p_input ->> 'durationSeconds','') ~ '[^0-9]'
       or length(coalesce(p_input ->> 'durationSeconds','')) > 2
       or (p_input ->> 'durationSeconds')::numeric < 2
       or (p_input ->> 'durationSeconds')::numeric > 30 then
      raise exception 'VIDEO_PRICE_DURATION_OR_OPERATION_INVALID';
    end if;
    -- Aleph 2.0: 28 credits per output second, 56-credit minimum.
    if p_reserved_amount < greatest(0.56, (p_input ->> 'durationSeconds')::numeric * 0.28) then
      raise exception 'VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE';
    end if;
  elsif p_provider = 'runway' then
    if coalesce(p_input ->> 'durationSeconds','') not in ('2','3','4','5','6','7','8','9','10') then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if p_reserved_amount < ((p_input ->> 'durationSeconds')::numeric * 0.12) then
      raise exception 'VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE';
    end if;
  else
    -- Gemini Omni direct API preflight: 1,048,576 input tokens at $1.50/M
    -- plus 57,920 output video tokens (10s at 5,792 tokens/s) at $17.50/M.
    -- The reservation is deliberately conservative; actual usage is reconciled
    -- from the completed interaction before budget settlement.
    if coalesce(p_input ->> 'durationSeconds','') not in ('3','4','5','6','7','8','9','10') then
      raise exception 'VIDEO_PRICE_DURATION_INVALID';
    end if;
    if coalesce(p_input ->> 'resolution','provider_default') not in ('provider_default','720p') then
      raise exception 'VIDEO_PRICE_UNSUPPORTED_RESOLUTION';
    end if;
    if p_reserved_amount < 2.586464 then
      raise exception 'VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE';
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || p_idempotency_key, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':video.generate', 0));

  select * into existing from executive_visuals.jobs
  where owner_id = p_owner_id and idempotency_key = p_idempotency_key
  for update;
  if existing.id is not null then
    if existing.job_type <> 'video.generate'
       or existing.project_id is distinct from p_project_id
       or coalesce(existing.input ->> 'requestHash','') <> p_request_hash
       or coalesce(existing.input ->> 'provider','') <> p_provider
       or coalesce(existing.input ->> 'model','') <> p_model then
      raise exception 'VIDEO_JOB_IDEMPOTENCY_CONFLICT';
    end if;
    select r.id into reservation_id
    from executive_visuals.video_generation_budget_reservations r
    where r.job_id = existing.id;
    return query select existing.id, existing.status, true, reservation_id;
    return;
  end if;

  if p_project_id is not null and not exists (
    select 1 from executive_visuals.projects p
    where p.id = p_project_id and p.owner_id = p_owner_id
  ) then
    raise exception 'VIDEO_JOB_PROJECT_FORBIDDEN';
  end if;

  select * into policy
  from executive_visuals.video_generation_budget_policies b
  where b.owner_id = p_owner_id
    and b.project_id is not distinct from p_project_id
    and b.provider = p_provider and b.model = p_model
    and b.currency = p_currency and b.enabled = true
  for update;
  if policy.id is null then raise exception 'VIDEO_JOB_BUDGET_POLICY_DISABLED'; end if;
  if p_reserved_amount > policy.max_per_job_amount
     or policy.reserved_amount + policy.spent_amount + p_reserved_amount > policy.spend_limit_amount then
    raise exception 'VIDEO_JOB_BUDGET_LIMIT_REACHED';
  end if;

  select * into approval
  from executive_visuals.video_generation_budget_approvals a
  where a.id = p_budget_approval_id and a.owner_id = p_owner_id
  for update;
  if approval.id is null
     or approval.project_id is distinct from p_project_id
     or approval.provider <> p_provider or approval.model <> p_model
     or approval.request_hash <> p_request_hash or approval.currency <> p_currency
     or approval.approved_max_amount < p_reserved_amount
     or approval.expires_at <= clock_timestamp()
     or approval.consumed_at is not null then
    raise exception 'VIDEO_JOB_BUDGET_APPROVAL_INVALID';
  end if;

  select count(*) into used_requests
  from executive_visuals.video_generation_usage_reservations u
  where u.owner_id = p_owner_id and u.provider = p_provider and u.model = p_model
    and u.created_at >= clock_timestamp() - interval '24 hours';
  if policy.rolling_24h_request_limit = 0 or used_requests >= policy.rolling_24h_request_limit then
    raise exception 'VIDEO_JOB_USAGE_LIMIT_REACHED';
  end if;

  insert into executive_visuals.jobs(
    owner_id, project_id, job_type, status, input, idempotency_key,
    estimated_cost, approved_by, approved_at
  ) values (
    p_owner_id, p_project_id, 'video.generate', 'queued', p_input, p_idempotency_key,
    jsonb_build_object('amount', p_reserved_amount, 'currency', p_currency),
    p_owner_id, clock_timestamp()
  ) returning * into inserted_job;

  insert into executive_visuals.video_generation_budget_reservations(
    job_id, approval_id, policy_id, owner_id, project_id, provider, model, currency, reserved_amount
  ) values (
    inserted_job.id, approval.id, policy.id, p_owner_id, p_project_id,
    p_provider, p_model, p_currency, p_reserved_amount
  ) returning id into reservation_id;

  insert into executive_visuals.video_generation_usage_reservations(
    job_id, owner_id, provider, model
  ) values (inserted_job.id, p_owner_id, p_provider, p_model);

  update executive_visuals.video_generation_budget_policies
  set reserved_amount = reserved_amount + p_reserved_amount,
      updated_at = clock_timestamp()
  where id = policy.id;

  update executive_visuals.video_generation_budget_approvals
  set consumed_at = clock_timestamp()
  where id = approval.id;

  insert into executive_visuals.job_events(job_id, owner_id, event_type, event_data)
  values (
    inserted_job.id, p_owner_id, 'job.queued',
    jsonb_build_object('jobType','video.generate','provider',p_provider,'model',p_model,
      'requestHash',p_request_hash,'budgetReservationId',reservation_id,
      'reservedAmount',p_reserved_amount,'currency',p_currency)
  );

  insert into executive_visuals.audit_events(owner_id, project_id, event_type, subject_type, subject_id, details)
  values (
    p_owner_id, p_project_id, 'job.queued', 'job', inserted_job.id::text,
    jsonb_build_object('jobType','video.generate','provider',p_provider,'model',p_model,
      'requestHash',p_request_hash,'budgetReservationId',reservation_id)
  );

  return query select inserted_job.id, inserted_job.status, false, reservation_id;
end;
$video_enqueue$;


revoke all on function executive_visuals.enqueue_video_generation_job(uuid, uuid, text, text, text, text, jsonb, uuid, numeric, text)
  from public, anon, authenticated;
grant execute on function executive_visuals.enqueue_video_generation_job(uuid, uuid, text, text, text, text, jsonb, uuid, numeric, text)
  to service_role;
