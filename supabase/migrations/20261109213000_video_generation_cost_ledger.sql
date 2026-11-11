-- Immutable, request-level provider cost ledger for cloud video completion.
-- Source-controlled only: CI applies this migration to disposable PostgreSQL.
-- It is deliberately separate from provider budget policy counters so every
-- completed paid task has a durable, independently reconcilable cost record.

create table if not exists executive_visuals.video_generation_cost_ledger (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique,
  owner_id uuid not null references auth.users(id) on delete restrict,
  project_id uuid references executive_visuals.projects(id) on delete set null,
  provider text not null check (char_length(provider) between 1 and 100),
  model text not null check (char_length(model) between 1 and 160),
  provider_task_id text not null check (char_length(provider_task_id) between 1 and 240),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  reserved_amount numeric(14,6) not null check (reserved_amount > 0),
  actual_amount numeric(14,6) not null check (actual_amount >= 0 and actual_amount <= reserved_amount),
  unused_reservation numeric(14,6) generated always as (reserved_amount - actual_amount) stored,
  evidence_reference text not null check (char_length(evidence_reference) between 1 and 1000),
  idempotency_key text not null unique,
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists ev_video_cost_owner_created
  on executive_visuals.video_generation_cost_ledger(owner_id,created_at desc);
create index if not exists ev_video_cost_provider_created
  on executive_visuals.video_generation_cost_ledger(provider,model,created_at desc);

alter table executive_visuals.video_generation_cost_ledger enable row level security;
revoke all on executive_visuals.video_generation_cost_ledger from public, anon, authenticated;
grant select, insert on executive_visuals.video_generation_cost_ledger to service_role;

create or replace function executive_visuals.record_video_generation_cost_ledger()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $record_video_generation_cost_ledger$
declare
  reservation executive_visuals.video_generation_budget_reservations;
  provider_name text;
  model_name text;
  task_id text;
  evidence_ref text;
begin
  if new.job_type <> 'video.generate'
     or new.status not in ('succeeded','partial')
     or old.status is not distinct from new.status then
    return new;
  end if;

  select * into reservation
  from executive_visuals.video_generation_budget_reservations r
  where r.job_id = new.id;

  if reservation.id is null or reservation.state <> 'settled'
     or reservation.actual_amount is null then
    raise exception 'VIDEO_COST_LEDGER_REQUIRES_SETTLED_BUDGET';
  end if;

  provider_name := lower(coalesce(new.output ->> 'provider',''));
  model_name := coalesce(new.output ->> 'model','');
  task_id := coalesce(new.output ->> 'providerTaskId','');
  evidence_ref := coalesce(new.output ->> 'costEvidenceReference','');

  if provider_name <> reservation.provider
     or model_name = ''
     or task_id = ''
     or char_length(task_id) > 240
     or evidence_ref = ''
     or char_length(evidence_ref) > 1000 then
    raise exception 'VIDEO_COST_LEDGER_EVIDENCE_INVALID';
  end if;

  insert into executive_visuals.video_generation_cost_ledger(
    job_id,owner_id,project_id,provider,model,provider_task_id,currency,
    reserved_amount,actual_amount,evidence_reference,idempotency_key
  ) values (
    new.id,new.owner_id,new.project_id,provider_name,model_name,task_id,
    reservation.currency,reservation.reserved_amount,reservation.actual_amount,
    evidence_ref,'video-generation-cost:' || new.id::text
  );

  return new;
end;
$record_video_generation_cost_ledger$;

revoke all on function executive_visuals.record_video_generation_cost_ledger()
  from public, anon, authenticated;

drop trigger if exists ev_video_generation_cost_ledger_after_completion
  on executive_visuals.jobs;
create trigger ev_video_generation_cost_ledger_after_completion
after update of status on executive_visuals.jobs
for each row
when (new.job_type = 'video.generate' and new.status in ('succeeded','partial'))
execute function executive_visuals.record_video_generation_cost_ledger();

comment on table executive_visuals.video_generation_cost_ledger is
  'Append-only provider actual-cost evidence written in the same transaction as cloud video job completion.';

create or replace function executive_visuals.reject_video_cost_ledger_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $reject_video_cost_ledger_mutation$
begin
  raise exception 'VIDEO_COST_LEDGER_IS_APPEND_ONLY';
end;
$reject_video_cost_ledger_mutation$;

revoke all on function executive_visuals.reject_video_cost_ledger_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists ev_video_cost_ledger_immutable
  on executive_visuals.video_generation_cost_ledger;
create trigger ev_video_cost_ledger_immutable
before update or delete on executive_visuals.video_generation_cost_ledger
for each row execute function executive_visuals.reject_video_cost_ledger_mutation();
