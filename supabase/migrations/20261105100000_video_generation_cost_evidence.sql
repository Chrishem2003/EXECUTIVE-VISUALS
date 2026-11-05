-- Evidence-backed, owner-reviewed provider cost settlement.
-- Source-controlled only. This migration must first run in the disposable CI database
-- and then in a dedicated isolated Supabase project after explicit review.

create table if not exists executive_visuals.video_generation_cost_evidence (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references executive_visuals.jobs(id) on delete cascade,
  reservation_id uuid not null unique references executive_visuals.video_generation_budget_reservations(id),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  provider text not null check (char_length(provider) between 1 and 100),
  model text not null check (char_length(model) between 1 and 160),
  provider_task_id text not null check (char_length(provider_task_id) between 1 and 256),
  actual_amount numeric(14,6) not null check (actual_amount >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  source_type text not null check (source_type in ('provider_invoice','provider_export','provider_portal','provider_support')),
  evidence_reference text not null check (char_length(btrim(evidence_reference)) between 1 and 1000),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  reviewer_id uuid not null references auth.users(id),
  reviewer_note text not null default '' check (char_length(reviewer_note) <= 2000),
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists ev_video_cost_evidence_owner_reviewed
  on executive_visuals.video_generation_cost_evidence(owner_id, reviewed_at desc);

alter table executive_visuals.video_generation_cost_evidence enable row level security;
revoke all on executive_visuals.video_generation_cost_evidence from public, anon, authenticated;
grant select, insert on executive_visuals.video_generation_cost_evidence to authenticated;
grant all privileges on executive_visuals.video_generation_cost_evidence to service_role;

-- Owners may inspect their own reservation/submission metadata to prepare a review.
-- The underlying job RLS continues to enforce owner scope.
grant select on executive_visuals.video_generation_budget_reservations to authenticated;
grant select on executive_visuals.video_generation_submissions to authenticated;

create policy ev_video_budget_reservation_owner_read
  on executive_visuals.video_generation_budget_reservations for select to authenticated
  using (owner_id = (select auth.uid()));

create policy ev_video_submission_owner_read
  on executive_visuals.video_generation_submissions for select to authenticated
  using (owner_id = (select auth.uid()));

create policy ev_video_cost_evidence_owner_read
  on executive_visuals.video_generation_cost_evidence for select to authenticated
  using (owner_id = (select auth.uid()));

create policy ev_video_cost_evidence_owner_insert
  on executive_visuals.video_generation_cost_evidence for insert to authenticated
  with check (owner_id = (select auth.uid()) and reviewer_id = (select auth.uid()));

create or replace function executive_visuals.validate_video_generation_cost_evidence()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $video_cost_evidence_validate$
declare
  job_row executive_visuals.jobs;
  reservation_row executive_visuals.video_generation_budget_reservations;
  submission_row executive_visuals.video_generation_submissions;
  project_owner uuid;
begin
  if auth.uid() is null then
    raise exception 'VIDEO_COST_EVIDENCE_AUTHENTICATED_REVIEWER_REQUIRED';
  end if;

  select * into job_row
  from executive_visuals.jobs
  where id = new.job_id and owner_id = auth.uid() and job_type = 'video.generate';
  if job_row.id is null then
    raise exception 'VIDEO_COST_EVIDENCE_JOB_SCOPE_INVALID';
  end if;

  if job_row.project_id is not distinct from null then
    null;
  else
    select owner_id into project_owner from executive_visuals.projects where id = job_row.project_id;
    if project_owner is distinct from auth.uid() then
      raise exception 'VIDEO_COST_EVIDENCE_PROJECT_OWNER_REQUIRED';
    end if;
  end if;

  select * into reservation_row
  from executive_visuals.video_generation_budget_reservations
  where job_id = new.job_id and owner_id = auth.uid();
  if reservation_row.id is null or reservation_row.state <> 'reserved'
     or reservation_row.id <> new.reservation_id then
    raise exception 'VIDEO_COST_EVIDENCE_RESERVATION_INVALID';
  end if;

  select * into submission_row
  from executive_visuals.video_generation_submissions
  where job_id = new.job_id and owner_id = auth.uid();
  if submission_row.id is null or submission_row.state <> 'submitted'
     or submission_row.provider_task_id is null
     or submission_row.provider_task_id <> new.provider_task_id then
    raise exception 'VIDEO_COST_EVIDENCE_TASK_MISMATCH';
  end if;

  if new.owner_id <> auth.uid()
     or new.project_id is distinct from job_row.project_id
     or new.provider <> submission_row.provider
     or new.model <> submission_row.model
     or new.currency <> reservation_row.currency
     or new.actual_amount > reservation_row.reserved_amount then
    raise exception 'VIDEO_COST_EVIDENCE_SCOPE_OR_AMOUNT_INVALID';
  end if;

  new.reviewer_id := auth.uid();
  new.reviewed_at := clock_timestamp();
  new.created_at := clock_timestamp();
  return new;
end;
$video_cost_evidence_validate$;

create trigger ev_video_cost_evidence_validate
  before insert on executive_visuals.video_generation_cost_evidence
  for each row execute function executive_visuals.validate_video_generation_cost_evidence();

create trigger ev_video_cost_evidence_immutable
  before update or delete on executive_visuals.video_generation_cost_evidence
  for each row execute function executive_visuals.prevent_owner_reassignment();

-- Evidence rows are append-only. The owner can create one review receipt per job;
-- conflicting replacements require a separate audited correction workflow.
revoke update, delete on executive_visuals.video_generation_cost_evidence from authenticated;

create or replace function executive_visuals.get_video_generation_cost_evidence(p_job_id uuid)
returns setof executive_visuals.video_generation_cost_evidence
language sql
security invoker
set search_path = pg_catalog, executive_visuals
as $video_cost_evidence_get$
  select e.*
  from executive_visuals.video_generation_cost_evidence e
  where e.job_id = p_job_id
$$;

revoke all on function executive_visuals.get_video_generation_cost_evidence(uuid) from public, anon, authenticated;
grant execute on function executive_visuals.get_video_generation_cost_evidence(uuid) to service_role;

-- Success settlement is allowed only when the exact provider task and amount
-- match an immutable owner-reviewed evidence receipt.
create or replace function executive_visuals.finish_video_generation_job_with_evidence(
  p_job_id uuid,
  p_worker_id text,
  p_output jsonb,
  p_actual_amount numeric,
  p_evidence_reference text
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $video_finish_with_evidence$
declare
  job_row executive_visuals.jobs;
  reservation_row executive_visuals.video_generation_budget_reservations;
  submission_row executive_visuals.video_generation_submissions;
  evidence_row executive_visuals.video_generation_cost_evidence;
begin
  if p_job_id is null or p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128
     or p_output is null or jsonb_typeof(p_output) <> 'object'
     or p_actual_amount is null or p_actual_amount < 0
     or p_evidence_reference is null or char_length(btrim(p_evidence_reference)) not between 1 and 1000
     or p_output ->> 'costEvidenceReference' is distinct from p_evidence_reference then
    raise exception 'VIDEO_COST_EVIDENCE_FINALIZATION_ARGUMENTS_INVALID';
  end if;

  select * into job_row from executive_visuals.jobs
  where id = p_job_id and job_type = 'video.generate'
    and status = 'processing' and lease_owner = p_worker_id
    and lease_expires_at > clock_timestamp()
  for update;
  if job_row.id is null then return false; end if;

  select * into reservation_row
  from executive_visuals.video_generation_budget_reservations
  where job_id = p_job_id and owner_id = job_row.owner_id
  for update;
  select * into submission_row
  from executive_visuals.video_generation_submissions
  where job_id = p_job_id and owner_id = job_row.owner_id
  for update;
  select * into evidence_row
  from executive_visuals.video_generation_cost_evidence
  where job_id = p_job_id and owner_id = job_row.owner_id
  for update;

  if reservation_row.id is null or reservation_row.state <> 'reserved'
     or submission_row.id is null or submission_row.state <> 'submitted'
     or evidence_row.id is null
     or evidence_row.reservation_id <> reservation_row.id
     or evidence_row.provider <> submission_row.provider
     or evidence_row.model <> submission_row.model
     or evidence_row.provider_task_id is distinct from submission_row.provider_task_id
     or evidence_row.actual_amount <> p_actual_amount
     or evidence_row.currency <> reservation_row.currency
     or evidence_row.evidence_reference <> p_evidence_reference
     or p_output ->> 'providerTaskId' is distinct from submission_row.provider_task_id then
    raise exception 'VIDEO_COST_EVIDENCE_RECEIPT_MISMATCH';
  end if;

  return executive_visuals.finish_video_generation_job(
    p_job_id, p_worker_id, 'succeeded', p_output, null, p_actual_amount
  );
end;
$video_finish_with_evidence$;

revoke all on function executive_visuals.finish_video_generation_job_with_evidence(uuid,text,jsonb,numeric,text) from public, anon, authenticated;
grant execute on function executive_visuals.finish_video_generation_job_with_evidence(uuid,text,jsonb,numeric,text) to service_role;
