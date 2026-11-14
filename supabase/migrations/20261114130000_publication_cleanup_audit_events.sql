-- Durable, append-only evidence for publication cleanup operations.
-- No owner/project foreign keys: audit history must survive tenant resource deletion.

create table if not exists executive_visuals.publication_cleanup_audit_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  event_type text not null check (event_type in (
    'publication.cleanup_candidate_eligible',
    'publication.cleanup_candidate_skipped',
    'publication.orphan_removed',
    'publication.cleanup_completed'
  )),
  actor_type text not null default 'system' check (actor_type in ('system','user','admin')),
  actor_id uuid,
  job_id uuid,
  owner_id uuid not null,
  project_id uuid,
  publication_key text check (publication_key is null or char_length(publication_key) between 1 and 200),
  claim_id uuid,
  object_path text,
  reason text check (reason is null or char_length(reason) between 1 and 100),
  dry_run boolean not null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  occurred_at timestamptz not null default pg_catalog.clock_timestamp()
);

create index if not exists ev_publication_cleanup_audit_owner_time
  on executive_visuals.publication_cleanup_audit_events(owner_id, occurred_at desc, id desc);
create index if not exists ev_publication_cleanup_audit_run
  on executive_visuals.publication_cleanup_audit_events(run_id, id);
create index if not exists ev_publication_cleanup_audit_job
  on executive_visuals.publication_cleanup_audit_events(job_id, occurred_at desc)
  where job_id is not null;
create index if not exists ev_publication_cleanup_audit_object
  on executive_visuals.publication_cleanup_audit_events(object_path, occurred_at desc)
  where object_path is not null;

alter table executive_visuals.publication_cleanup_audit_events enable row level security;
revoke all on executive_visuals.publication_cleanup_audit_events from public, anon, authenticated, service_role;
grant select, insert on executive_visuals.publication_cleanup_audit_events to service_role;

create or replace function executive_visuals.reject_publication_cleanup_audit_mutation_v1()
returns trigger
language plpgsql
set search_path = ''
as $audit_immutable$
begin
  raise exception 'publication cleanup audit events are append-only'
    using errcode = '55000';
end;
$audit_immutable$;

revoke all on function executive_visuals.reject_publication_cleanup_audit_mutation_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists ev_publication_cleanup_audit_immutable
  on executive_visuals.publication_cleanup_audit_events;
create trigger ev_publication_cleanup_audit_immutable
before update or delete on executive_visuals.publication_cleanup_audit_events
for each row execute function executive_visuals.reject_publication_cleanup_audit_mutation_v1();

comment on table executive_visuals.publication_cleanup_audit_events is
  'Append-only operational evidence for publication cleanup. Deliberately has no cascading tenant-resource foreign keys.';
