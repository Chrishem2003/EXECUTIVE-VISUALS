-- Cloud video budget policy, explicit approval and atomic enqueue boundary.
-- Source-controlled only. Do not apply to shared staging or production from this PR.
-- Provider execution remains disabled by default. The service boundary and worker flags gate every remote provider submission.

create table if not exists executive_visuals.video_generation_budget_policies (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  provider text not null check (char_length(provider) between 1 and 100),
  model text not null check (char_length(model) between 1 and 160),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  spend_limit_amount numeric(14,6) not null check (spend_limit_amount > 0),
  max_per_job_amount numeric(14,6) not null check (max_per_job_amount > 0 and max_per_job_amount <= spend_limit_amount),
  reserved_amount numeric(14,6) not null default 0 check (reserved_amount >= 0),
  spent_amount numeric(14,6) not null default 0 check (spent_amount >= 0),
  rolling_24h_request_limit integer not null default 0 check (rolling_24h_request_limit between 0 and 10000),
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ev_video_budget_policy_scope
  on executive_visuals.video_generation_budget_policies
  (owner_id, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), provider, model);

create table if not exists executive_visuals.video_generation_budget_approvals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  provider text not null check (char_length(provider) between 1 and 100),
  model text not null check (char_length(model) between 1 and 160),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  approved_max_amount numeric(14,6) not null check (approved_max_amount > 0),
  approval_note text not null default '' check (char_length(approval_note) <= 1000),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create table if not exists executive_visuals.video_generation_budget_reservations (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references executive_visuals.jobs(id) on delete cascade,
  approval_id uuid not null unique references executive_visuals.video_generation_budget_approvals(id),
  policy_id uuid not null references executive_visuals.video_generation_budget_policies(id),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  provider text not null,
  model text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  reserved_amount numeric(14,6) not null check (reserved_amount > 0),
  actual_amount numeric(14,6) check (actual_amount is null or actual_amount >= 0),
  state text not null default 'reserved' check (state in ('reserved','settled','released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists executive_visuals.video_generation_usage_reservations (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references executive_visuals.jobs(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  model text not null,
  capability text not null default 'video.generate',
  created_at timestamptz not null default now()
);

create index if not exists ev_video_usage_owner_provider_created
  on executive_visuals.video_generation_usage_reservations(owner_id, provider, model, created_at desc);

alter table executive_visuals.video_generation_budget_policies enable row level security;
alter table executive_visuals.video_generation_budget_approvals enable row level security;
alter table executive_visuals.video_generation_budget_reservations enable row level security;
alter table executive_visuals.video_generation_usage_reservations enable row level security;

revoke all on executive_visuals.video_generation_budget_policies from public, anon, authenticated;
revoke all on executive_visuals.video_generation_budget_approvals from public, anon, authenticated;
revoke all on executive_visuals.video_generation_budget_reservations from public, anon, authenticated;
revoke all on executive_visuals.video_generation_usage_reservations from public, anon, authenticated;
grant select on executive_visuals.video_generation_budget_policies to authenticated;
-- Clients may configure limits but cannot forge the server-maintained accounting totals or scope.
grant insert (owner_id, project_id, provider, model, currency, spend_limit_amount, max_per_job_amount, rolling_24h_request_limit, enabled)
  on executive_visuals.video_generation_budget_policies to authenticated;
grant update (provider, model, currency, spend_limit_amount, max_per_job_amount, rolling_24h_request_limit, enabled, updated_at)
  on executive_visuals.video_generation_budget_policies to authenticated;
grant select, insert on executive_visuals.video_generation_budget_approvals to authenticated;
grant all privileges on executive_visuals.video_generation_budget_policies to service_role;
grant all privileges on executive_visuals.video_generation_budget_approvals to service_role;
grant all privileges on executive_visuals.video_generation_budget_reservations to service_role;
grant all privileges on executive_visuals.video_generation_usage_reservations to service_role;

create or replace function executive_visuals.validate_video_budget_approval()
returns trigger
language plpgsql
set search_path = pg_catalog, executive_visuals
as $$
begin
  if new.owner_id is distinct from auth.uid() then
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
$$;

create trigger ev_video_budget_approval_validate
  before insert on executive_visuals.video_generation_budget_approvals
  for each row execute function executive_visuals.validate_video_budget_approval();

create or replace function executive_visuals.validate_video_budget_policy_scope()
returns trigger
language plpgsql
set search_path = pg_catalog, executive_visuals
as $video_policy_scope$
begin
  if (new.provider is distinct from old.provider
      or new.model is distinct from old.model
      or new.currency is distinct from old.currency)
     and (old.reserved_amount > 0 or old.spent_amount > 0) then
    raise exception 'VIDEO_BUDGET_POLICY_SCOPE_LOCKED_AFTER_USE';
  end if;
  if new.spend_limit_amount < old.reserved_amount + old.spent_amount then
    raise exception 'VIDEO_BUDGET_LIMIT_BELOW_COMMITTED_SPEND';
  end if;
  return new;
end;
$video_policy_scope$;

create trigger ev_video_budget_policy_scope_immutable
  before update of provider, model, currency, spend_limit_amount on executive_visuals.video_generation_budget_policies
  for each row execute function executive_visuals.validate_video_budget_policy_scope();

create trigger ev_video_budget_policy_owner_immutable
  before update of owner_id on executive_visuals.video_generation_budget_policies
  for each row execute function executive_visuals.prevent_owner_reassignment();
create trigger ev_video_budget_approval_owner_immutable
  before update of owner_id on executive_visuals.video_generation_budget_approvals
  for each row execute function executive_visuals.prevent_owner_reassignment();

create policy ev_video_budget_policy_owner_all
  on executive_visuals.video_generation_budget_policies for all to authenticated
  using (
    owner_id = (select auth.uid())
    and (project_id is null or exists (
      select 1 from executive_visuals.projects p
      where p.id = video_generation_budget_policies.project_id
        and p.owner_id = (select auth.uid())
    ))
  )
  with check (
    owner_id = (select auth.uid())
    and (project_id is null or exists (
      select 1 from executive_visuals.projects p
      where p.id = video_generation_budget_policies.project_id
        and p.owner_id = (select auth.uid())
    ))
  );

create policy ev_video_budget_approval_owner_read
  on executive_visuals.video_generation_budget_approvals for select to authenticated
  using (owner_id = (select auth.uid()));

create policy ev_video_budget_approval_owner_insert
  on executive_visuals.video_generation_budget_approvals for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (project_id is null or exists (
      select 1 from executive_visuals.projects p
      where p.id = video_generation_budget_approvals.project_id
        and p.owner_id = (select auth.uid())
    ))
  );

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
    (p_provider = 'runway' and p_model = 'gen4.5')
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
  if p_provider = 'runway' then
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


create or replace function executive_visuals.finish_video_generation_job(
  p_job_id uuid,
  p_worker_id text,
  p_status text,
  p_output jsonb default null,
  p_error jsonb default null,
  p_actual_amount numeric default null
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $video_finish$
declare
  current_job executive_visuals.jobs;
  reservation executive_visuals.video_generation_budget_reservations;
  policy executive_visuals.video_generation_budget_policies;
  submission executive_visuals.video_generation_submissions;
  target_submission_state text;
  target_budget_state text;
  output_asset_id uuid;
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128
     or p_status is null or p_status not in ('succeeded','partial','failed','cancelled')
     or (p_output is not null and jsonb_typeof(p_output) <> 'object')
     or (p_error is not null and jsonb_typeof(p_error) <> 'object')
     or octet_length(coalesce(p_output,'{}'::jsonb)::text) > 32000
     or octet_length(coalesce(p_error,'{}'::jsonb)::text) > 8000
     or (p_actual_amount is not null and p_actual_amount < 0) then
    raise exception 'VIDEO_JOB_FINISH_ARGUMENTS_INVALID';
  end if;

  select * into current_job
  from executive_visuals.jobs j
  where j.id = p_job_id and j.job_type = 'video.generate'
  for update;
  if current_job.id is null or current_job.status <> 'processing'
     or current_job.lease_owner is distinct from p_worker_id
     or current_job.lease_expires_at is null
     or current_job.lease_expires_at <= clock_timestamp() then
    return false;
  end if;

  if p_status in ('succeeded','partial') and p_actual_amount is null then
    raise exception 'VIDEO_BUDGET_ACTUAL_COST_REQUIRED';
  end if;
  if p_status in ('failed','cancelled') and p_actual_amount is not null then
    raise exception 'VIDEO_BUDGET_FAILURE_MUST_RELEASE_RESERVATION';
  end if;

  select * into reservation
  from executive_visuals.video_generation_budget_reservations r
  where r.job_id = p_job_id
  for update;
  if reservation.id is null or reservation.state <> 'reserved' then
    raise exception 'VIDEO_BUDGET_RESERVATION_NOT_SETTLEABLE';
  end if;
  if p_actual_amount is not null and p_actual_amount > reservation.reserved_amount then
    raise exception 'VIDEO_BUDGET_ACTUAL_EXCEEDS_RESERVATION';
  end if;

  select * into policy
  from executive_visuals.video_generation_budget_policies b
  where b.id = reservation.policy_id
  for update;
  if policy.id is null or policy.reserved_amount < reservation.reserved_amount then
    raise exception 'VIDEO_BUDGET_LEDGER_INVARIANT_FAILED';
  end if;

  target_budget_state := case when p_actual_amount is null then 'released' else 'settled' end;
  update executive_visuals.video_generation_budget_policies
  set reserved_amount = reserved_amount - reservation.reserved_amount,
      spent_amount = spent_amount + coalesce(p_actual_amount, 0),
      updated_at = clock_timestamp()
  where id = policy.id;

  update executive_visuals.video_generation_budget_reservations
  set state = target_budget_state, actual_amount = p_actual_amount, updated_at = clock_timestamp()
  where id = reservation.id;

  target_submission_state := case when p_status in ('succeeded','partial') then 'succeeded' else p_status end;
  select * into submission
  from executive_visuals.video_generation_submissions s
  where s.job_id = p_job_id
  for update;
  if p_status in ('succeeded','partial') then
    if p_output is null
       or coalesce(jsonb_typeof(p_output -> 'assetIds'),'null') <> 'array'
       or coalesce(jsonb_array_length(p_output -> 'assetIds'),0) not between 1 and 10
       or p_output ->> 'providerTaskId' is distinct from submission.provider_task_id then
      raise exception 'VIDEO_JOB_OUTPUT_ASSET_RECEIPTS_INVALID';
    end if;
    for output_asset_id in
      select value::uuid from jsonb_array_elements_text(p_output -> 'assetIds') as asset_ids(value)
    loop
      if not exists (
        select 1 from executive_visuals.assets a
        where a.id = output_asset_id
          and a.owner_id = current_job.owner_id
          and a.project_id is not distinct from current_job.project_id
          and a.storage_bucket = 'executive-visuals-media'
          and a.media_type like 'video/%'
          and a.deleted_at is null
      ) then
        raise exception 'VIDEO_JOB_OUTPUT_ASSET_SCOPE_INVALID';
      end if;
    end loop;
  end if;

  if submission.id is not null then
    if p_status in ('succeeded','partial')
       and (submission.state <> 'submitted' or submission.provider_task_id is null) then
      raise exception 'VIDEO_SUBMISSION_TASK_ID_REQUIRED';
    end if;
    -- An interrupted POST may already have been accepted and billed. Never
    -- release its reservation until an operator reconciles the provider task.
    if p_status in ('failed','cancelled') and submission.state in ('submitting','unknown') then
      raise exception 'VIDEO_SUBMISSION_RECONCILIATION_REQUIRED';
    end if;
    if submission.state not in ('prepared','submitting','submitted','unknown') then
      raise exception 'VIDEO_SUBMISSION_NOT_SETTLEABLE';
    end if;
    update executive_visuals.video_generation_submissions
    set state = target_submission_state, updated_at = clock_timestamp(),
        metadata = metadata || jsonb_build_object('jobStatus',p_status,'budgetState',target_budget_state)
    where id = submission.id;
  elsif p_status in ('succeeded','partial') then
    raise exception 'VIDEO_SUBMISSION_LEDGER_REQUIRED';
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
  where id = p_job_id and status = 'processing' and lease_owner = p_worker_id;

  insert into executive_visuals.job_events(job_id, owner_id, event_type, event_data)
  values (
    p_job_id, current_job.owner_id, 'job.' || p_status,
    jsonb_build_object('status',p_status,'budgetReservationId',reservation.id,
      'reservedAmount',reservation.reserved_amount,'actualAmount',p_actual_amount,
      'currency',reservation.currency)
  );

  insert into executive_visuals.audit_events(owner_id, project_id, event_type, subject_type, subject_id, details)
  values (
    current_job.owner_id, current_job.project_id, 'video.budget.' || target_budget_state,
    'video_budget_reservation', reservation.id::text,
    jsonb_build_object('jobId',p_job_id,'reservedAmount',reservation.reserved_amount,
      'actualAmount',p_actual_amount,'currency',reservation.currency,'jobStatus',p_status)
  );
  return true;
end;
$video_finish$;

revoke all on function executive_visuals.finish_video_generation_job(uuid, text, text, jsonb, jsonb, numeric)
  from public, anon, authenticated;
grant execute on function executive_visuals.finish_video_generation_job(uuid, text, text, jsonb, jsonb, numeric)
  to service_role;

-- Job completion, submission terminalization and budget settlement commit atomically.


create or replace function executive_visuals.defer_video_generation_job(
  p_job_id uuid, p_worker_id text, p_delay_seconds integer default 30, p_reason_code text default 'VIDEO_PROVIDER_POLL_DEFERRED'
) returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $video_defer$
declare
  current_job executive_visuals.jobs;
  submission executive_visuals.video_generation_submissions;
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128
     or p_delay_seconds is null or p_delay_seconds not between 5 and 900
     or p_reason_code is null or p_reason_code !~ '^[A-Z0-9_]{1,100}$' then
    raise exception 'VIDEO_JOB_DEFER_ARGUMENTS_INVALID';
  end if;
  select * into current_job from executive_visuals.jobs
  where id=p_job_id and job_type='video.generate' for update;
  if current_job.id is null or current_job.status <> 'processing'
     or current_job.lease_owner is distinct from p_worker_id
     or current_job.lease_expires_at is null
     or current_job.lease_expires_at <= clock_timestamp() then
    return false;
  end if;
  select * into submission from executive_visuals.video_generation_submissions
  where job_id=p_job_id for update;
  if submission.id is null or submission.state <> 'submitted' or submission.provider_task_id is null then
    raise exception 'VIDEO_JOB_DEFER_REQUIRES_SUBMITTED_TASK';
  end if;
  if not exists (
    select 1 from executive_visuals.video_generation_budget_reservations r
    where r.job_id=p_job_id and r.state='reserved'
  ) then raise exception 'VIDEO_JOB_DEFER_BUDGET_RESERVATION_MISSING'; end if;

  update executive_visuals.jobs
  set status='queued', available_at=clock_timestamp()+make_interval(secs=>p_delay_seconds),
      error=null, updated_at=clock_timestamp(), lease_owner=null,
      lease_expires_at=null, lease_heartbeat_at=null
  where id=p_job_id;
  insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
  values(p_job_id,current_job.owner_id,'job.deferred',
    jsonb_build_object('reasonCode',p_reason_code,'delaySeconds',p_delay_seconds,'providerTaskId',submission.provider_task_id));
  insert into executive_visuals.audit_events(owner_id,project_id,event_type,subject_type,subject_id,details)
  values(current_job.owner_id,current_job.project_id,'job.deferred','job',p_job_id::text,
    jsonb_build_object('reasonCode',p_reason_code,'delaySeconds',p_delay_seconds));
  return true;
end;
$video_defer$;

revoke all on function executive_visuals.defer_video_generation_job(uuid,text,integer,text)
  from public, anon, authenticated;
grant execute on function executive_visuals.defer_video_generation_job(uuid,text,integer,text)
  to service_role;


create or replace function executive_visuals.quarantine_video_generation_job(
  p_job_id uuid, p_worker_id text, p_reason_code text default 'VIDEO_SUBMISSION_REQUIRES_RECONCILIATION'
) returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $video_quarantine$
declare
  current_job executive_visuals.jobs;
  submission executive_visuals.video_generation_submissions;
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128
     or p_reason_code is null or p_reason_code !~ '^[A-Z0-9_]{1,100}$' then
    raise exception 'VIDEO_JOB_QUARANTINE_ARGUMENTS_INVALID';
  end if;
  select * into current_job from executive_visuals.jobs
  where id=p_job_id and job_type='video.generate' for update;
  if current_job.id is null or current_job.status <> 'processing'
     or current_job.lease_owner is distinct from p_worker_id
     or current_job.lease_expires_at is null
     or current_job.lease_expires_at <= clock_timestamp() then
    return false;
  end if;
  select * into submission from executive_visuals.video_generation_submissions
  where job_id=p_job_id for update;
  if submission.id is null or submission.state not in ('submitting','unknown','submitted') then
    raise exception 'VIDEO_JOB_QUARANTINE_REQUIRES_AMBIGUOUS_SUBMISSION';
  end if;
  if not exists (
    select 1 from executive_visuals.video_generation_budget_reservations r
    where r.job_id=p_job_id and r.state='reserved'
  ) then raise exception 'VIDEO_JOB_QUARANTINE_BUDGET_RESERVATION_MISSING'; end if;

  update executive_visuals.jobs
  set status='needs_input', error=jsonb_build_object('code',p_reason_code,
      'message','Provider execution, output ingestion, or cost requires operator review.'),
      updated_at=clock_timestamp(), lease_owner=null,
      lease_expires_at=null, lease_heartbeat_at=null
  where id=p_job_id;
  insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
  values(p_job_id,current_job.owner_id,'job.needs_input',
    jsonb_build_object('reasonCode',p_reason_code,'submissionState',submission.state));
  insert into executive_visuals.audit_events(owner_id,project_id,event_type,subject_type,subject_id,details)
  values(current_job.owner_id,current_job.project_id,'job.needs_input','job',p_job_id::text,
    jsonb_build_object('reasonCode',p_reason_code,'submissionState',submission.state));
  return true;
end;
$video_quarantine$;

revoke all on function executive_visuals.quarantine_video_generation_job(uuid,text,text)
  from public, anon, authenticated;
grant execute on function executive_visuals.quarantine_video_generation_job(uuid,text,text)
  to service_role;


create or replace function executive_visuals.resume_reconciled_video_generation_job(
  p_job_id uuid, p_owner_id uuid, p_evidence_reference text
) returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $video_resume$
declare
  current_job executive_visuals.jobs;
  submission executive_visuals.video_generation_submissions;
begin
  if p_evidence_reference is null or char_length(btrim(p_evidence_reference)) not between 1 and 1000 then
    raise exception 'VIDEO_JOB_RESUME_EVIDENCE_REQUIRED';
  end if;
  select * into current_job from executive_visuals.jobs
  where id=p_job_id and owner_id=p_owner_id and job_type='video.generate'
  for update;
  if current_job.id is null or current_job.status <> 'needs_input' then return false; end if;
  select * into submission from executive_visuals.video_generation_submissions
  where job_id=p_job_id for update;
  if submission.id is null or submission.state <> 'submitted' or submission.provider_task_id is null then
    raise exception 'VIDEO_JOB_RESUME_REQUIRES_RECONCILED_TASK';
  end if;
  if not exists (
    select 1 from executive_visuals.video_generation_budget_reservations r
    where r.job_id=p_job_id and r.state='reserved'
  ) then raise exception 'VIDEO_JOB_RESUME_BUDGET_RESERVATION_MISSING'; end if;

  update executive_visuals.jobs
  set status='queued', available_at=clock_timestamp(), error=null,
      updated_at=clock_timestamp(), lease_owner=null,
      lease_expires_at=null, lease_heartbeat_at=null
  where id=p_job_id;
  insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
  values(p_job_id,p_owner_id,'job.reconciled_resumed',
    jsonb_build_object('providerTaskId',submission.provider_task_id,'evidenceReference',p_evidence_reference));
  insert into executive_visuals.audit_events(owner_id,project_id,event_type,subject_type,subject_id,details)
  values(p_owner_id,current_job.project_id,'job.reconciled_resumed','job',p_job_id::text,
    jsonb_build_object('providerTaskId',submission.provider_task_id,'evidenceReference',p_evidence_reference));
  return true;
end;
$video_resume$;

revoke all on function executive_visuals.resume_reconciled_video_generation_job(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function executive_visuals.resume_reconciled_video_generation_job(uuid,uuid,text)
  to service_role;


create or replace function executive_visuals.recover_expired_video_generation_jobs(p_limit integer default 100)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $video_recover$
declare
  expired executive_visuals.jobs;
  submission executive_visuals.video_generation_submissions;
  reservation executive_visuals.video_generation_budget_reservations;
  policy executive_visuals.video_generation_budget_policies;
  retryable boolean;
  delay_seconds integer;
  recovered integer := 0;
  recovery_code text;
begin
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'VIDEO_RECOVERY_LIMIT_INVALID';
  end if;

  for expired in
    select * from executive_visuals.jobs
    where job_type='video.generate' and status='processing'
      and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
    order by lease_expires_at nulls first, created_at
    limit p_limit
    for update skip locked
  loop
    select * into submission from executive_visuals.video_generation_submissions
    where job_id=expired.id for update;

    if submission.id is not null and submission.state <> 'prepared' then
      recovery_code := 'VIDEO_WORKER_LEASE_EXPIRED_REVIEW';
      update executive_visuals.jobs
      set status='needs_input',
          error=jsonb_build_object('code',recovery_code,
            'message','Video task state requires operator review before another worker attempt.'),
          updated_at=clock_timestamp(), completed_at=null,
          lease_owner=null, lease_expires_at=null, lease_heartbeat_at=null
      where id=expired.id;
      insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
      values(expired.id,expired.owner_id,'job.needs_input',
        jsonb_build_object('reasonCode',recovery_code,'submissionState',submission.state));
      insert into executive_visuals.audit_events(owner_id,project_id,event_type,subject_type,subject_id,details)
      values(expired.owner_id,expired.project_id,'job.needs_input','job',expired.id::text,
        jsonb_build_object('reasonCode',recovery_code,'submissionState',submission.state));
    else
      retryable := expired.attempt_count < expired.max_attempts;
      delay_seconds := case when retryable
        then least(300, 5 * (2 ^ greatest(0, expired.attempt_count - 1)))
        else 0 end;

      if retryable then
        update executive_visuals.jobs
        set status='queued', error=jsonb_build_object('code','VIDEO_WORKER_LEASE_EXPIRED',
            'message','No provider POST had started; the video job is safe to retry.'),
            updated_at=clock_timestamp(), completed_at=null,
            available_at=clock_timestamp()+make_interval(secs=>delay_seconds),
            lease_owner=null, lease_expires_at=null, lease_heartbeat_at=null
        where id=expired.id;
        insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
        values(expired.id,expired.owner_id,'job.lease_expired_retry',
          jsonb_build_object('retryDelaySeconds',delay_seconds,'submissionState',coalesce(submission.state,'absent')));
      else
        select * into reservation from executive_visuals.video_generation_budget_reservations
        where job_id=expired.id for update;
        if reservation.id is not null and reservation.state='reserved' then
          select * into policy from executive_visuals.video_generation_budget_policies
          where id=reservation.policy_id for update;
          if policy.id is null or policy.reserved_amount < reservation.reserved_amount then
            raise exception 'VIDEO_BUDGET_LEDGER_INVARIANT_FAILED';
          end if;
          update executive_visuals.video_generation_budget_policies
          set reserved_amount=reserved_amount-reservation.reserved_amount, updated_at=clock_timestamp()
          where id=policy.id;
          update executive_visuals.video_generation_budget_reservations
          set state='released', actual_amount=null, updated_at=clock_timestamp()
          where id=reservation.id;
        end if;
        if submission.id is not null and submission.state='prepared' then
          update executive_visuals.video_generation_submissions
          set state='failed', updated_at=clock_timestamp(),
              last_error_code='VIDEO_WORKER_LEASE_EXPIRED'
          where id=submission.id;
        end if;
        update executive_visuals.jobs
        set status='failed',
            error=jsonb_build_object('code','VIDEO_WORKER_LEASE_EXPIRED',
              'message','The video job exhausted its safe pre-submission attempts.'),
            updated_at=clock_timestamp(), completed_at=clock_timestamp(),
            available_at=null, lease_owner=null, lease_expires_at=null, lease_heartbeat_at=null
        where id=expired.id;
        insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
        values(expired.id,expired.owner_id,'job.lease_expired_failed',
          jsonb_build_object('submissionState',coalesce(submission.state,'absent'),'budgetReleased',reservation.id is not null));
        insert into executive_visuals.audit_events(owner_id,project_id,event_type,subject_type,subject_id,details)
        values(expired.owner_id,expired.project_id,'job.lease_expired_failed','job',expired.id::text,
          jsonb_build_object('submissionState',coalesce(submission.state,'absent'),'budgetReservationId',reservation.id));
      end if;
    end if;
    recovered := recovered + 1;
  end loop;
  return recovered;
end;
$video_recover$;

revoke all on function executive_visuals.recover_expired_video_generation_jobs(integer)
  from public, anon, authenticated;
grant execute on function executive_visuals.recover_expired_video_generation_jobs(integer)
  to service_role;
