-- Executive Visuals isolated data model.
-- Apply only to a dedicated project or development branch after reviewing RLS.
-- This migration is intentionally not applied to the shared staging database.

create schema if not exists executive_visuals;
revoke all on schema executive_visuals from public, anon;
grant usage on schema executive_visuals to authenticated;

create table if not exists executive_visuals.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  description text not null default '',
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings)='object'),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists executive_visuals.project_members (
  project_id uuid not null references executive_visuals.projects(id) on delete cascade,
  member_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('editor','reviewer','viewer')),
  invited_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  primary key(project_id,member_id)
);

create table if not exists executive_visuals.workflows (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  revision integer not null default 1 check (revision > 0),
  graph jsonb not null check (jsonb_typeof(graph)='object'),
  graph_hash text not null check (char_length(graph_hash)=64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists executive_visuals.timelines (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  revision integer not null default 1 check (revision > 0),
  timeline jsonb not null check (jsonb_typeof(timeline)='object'),
  otio jsonb check (otio is null or jsonb_typeof(otio)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists executive_visuals.assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  original_name text not null,
  media_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  sha256 text not null check (char_length(sha256)=64),
  storage_bucket text not null default 'executive-visuals-media',
  object_path text not null unique,
  derivative_of uuid references executive_visuals.assets(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists executive_visuals.jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  workflow_id uuid references executive_visuals.workflows(id) on delete set null,
  job_type text not null,
  status text not null check (status in ('draft','validated','awaiting_approval','queued','submitted','processing','reviewing','succeeded','partial','failed','cancelled','blocked','needs_input','expired')),
  progress numeric(5,2) not null default 0 check (progress between 0 and 100),
  input jsonb not null check (jsonb_typeof(input)='object'),
  output jsonb check (output is null or jsonb_typeof(output)='object'),
  error jsonb check (error is null or jsonb_typeof(error)='object'),
  idempotency_key text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 2 check (max_attempts between 1 and 10),
  estimated_cost jsonb check (estimated_cost is null or jsonb_typeof(estimated_cost)='object'),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(owner_id,idempotency_key)
);

create table if not exists executive_visuals.job_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references executive_visuals.jobs(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (char_length(event_type) between 1 and 100),
  event_data jsonb not null default '{}'::jsonb check (jsonb_typeof(event_data)='object'),
  created_at timestamptz not null default now()
);

create table if not exists executive_visuals.consents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  subject_label text not null,
  consent_type text not null check (consent_type in ('likeness','voice','identity_transfer','brand','location','music','other')),
  evidence_reference text not null,
  granted_at timestamptz not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists executive_visuals.reviews (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references executive_visuals.projects(id) on delete cascade,
  asset_id uuid references executive_visuals.assets(id) on delete set null,
  version integer not null default 1,
  reviewer_id uuid references auth.users(id),
  timecode_seconds numeric(12,3),
  body text not null check (char_length(body) between 1 and 10000),
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists executive_visuals.audit_events (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete set null,
  event_type text not null,
  subject_type text not null,
  subject_id text not null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details)='object'),
  created_at timestamptz not null default now()
);

create index if not exists ev_projects_owner_updated on executive_visuals.projects(owner_id,updated_at desc);
create index if not exists ev_timelines_owner_updated on executive_visuals.timelines(owner_id,updated_at desc);
create index if not exists ev_assets_owner_created on executive_visuals.assets(owner_id,created_at desc);
create index if not exists ev_assets_project_created on executive_visuals.assets(project_id,created_at desc);
create index if not exists ev_jobs_status_created on executive_visuals.jobs(status,created_at);
create index if not exists ev_jobs_owner_created on executive_visuals.jobs(owner_id,created_at desc);
create index if not exists ev_job_events_job on executive_visuals.job_events(job_id,id);
create index if not exists ev_reviews_project_created on executive_visuals.reviews(project_id,created_at);
create index if not exists ev_audit_owner_id on executive_visuals.audit_events(owner_id,id desc);

alter table executive_visuals.projects enable row level security;
alter table executive_visuals.project_members enable row level security;
alter table executive_visuals.workflows enable row level security;
alter table executive_visuals.assets enable row level security;\nalter table executive_visuals.timelines enable row level security;
alter table executive_visuals.jobs enable row level security;
alter table executive_visuals.job_events enable row level security;
alter table executive_visuals.consents enable row level security;
alter table executive_visuals.reviews enable row level security;
alter table executive_visuals.audit_events enable row level security;

grant select,insert,update,delete on all tables in schema executive_visuals to authenticated;
grant usage,select on all sequences in schema executive_visuals to authenticated;

create policy ev_projects_read on executive_visuals.projects for select to authenticated
using (owner_id=(select auth.uid()) or exists (
  select 1 from executive_visuals.project_members m where m.project_id=projects.id and m.member_id=(select auth.uid())
));
create policy ev_projects_insert on executive_visuals.projects for insert to authenticated
with check (owner_id=(select auth.uid()));
create policy ev_projects_update on executive_visuals.projects for update to authenticated
using (owner_id=(select auth.uid())) with check (owner_id=(select auth.uid()));
create policy ev_projects_delete on executive_visuals.projects for delete to authenticated
using (owner_id=(select auth.uid()));

create policy ev_members_read on executive_visuals.project_members for select to authenticated
using (member_id=(select auth.uid()) or exists (
  select 1 from executive_visuals.projects p where p.id=project_members.project_id and p.owner_id=(select auth.uid())
));
create policy ev_members_insert on executive_visuals.project_members for insert to authenticated
with check (invited_by=(select auth.uid()) and exists (
  select 1 from executive_visuals.projects p where p.id=project_members.project_id and p.owner_id=(select auth.uid())
));
create policy ev_members_update on executive_visuals.project_members for update to authenticated
using (exists (select 1 from executive_visuals.projects p where p.id=project_members.project_id and p.owner_id=(select auth.uid())))
with check (exists (select 1 from executive_visuals.projects p where p.id=project_members.project_id and p.owner_id=(select auth.uid())));
create policy ev_members_delete on executive_visuals.project_members for delete to authenticated
using (exists (select 1 from executive_visuals.projects p where p.id=project_members.project_id and p.owner_id=(select auth.uid())));

create policy ev_workflows_read on executive_visuals.workflows for select to authenticated
using (owner_id=(select auth.uid()) or exists (
  select 1 from executive_visuals.project_members m where m.project_id=workflows.project_id and m.member_id=(select auth.uid())
));
create policy ev_workflows_insert on executive_visuals.workflows for insert to authenticated
with check (owner_id=(select auth.uid()));
create policy ev_workflows_update on executive_visuals.workflows for update to authenticated
using (owner_id=(select auth.uid())) with check (owner_id=(select auth.uid()));
create policy ev_workflows_delete on executive_visuals.workflows for delete to authenticated
using (owner_id=(select auth.uid()));

create policy ev_timelines_read on executive_visuals.timelines for select to authenticated
using (owner_id=(select auth.uid()) or exists (
  select 1 from executive_visuals.project_members m where m.project_id=timelines.project_id and m.member_id=(select auth.uid())
));
create policy ev_timelines_insert on executive_visuals.timelines for insert to authenticated
with check (owner_id=(select auth.uid()));
create policy ev_timelines_update on executive_visuals.timelines for update to authenticated
using (owner_id=(select auth.uid())) with check (owner_id=(select auth.uid()));
create policy ev_timelines_delete on executive_visuals.timelines for delete to authenticated
using (owner_id=(select auth.uid()));

create policy ev_assets_read on executive_visuals.assets for select to authenticated
using (owner_id=(select auth.uid()) or exists (
  select 1 from executive_visuals.project_members m where m.project_id=assets.project_id and m.member_id=(select auth.uid())
));
create policy ev_assets_insert on executive_visuals.assets for insert to authenticated
with check (owner_id=(select auth.uid()));
create policy ev_assets_update on executive_visuals.assets for update to authenticated
using (owner_id=(select auth.uid())) with check (owner_id=(select auth.uid()));
create policy ev_assets_delete on executive_visuals.assets for delete to authenticated
using (owner_id=(select auth.uid()));

create policy ev_jobs_read on executive_visuals.jobs for select to authenticated
using (owner_id=(select auth.uid()) or exists (
  select 1 from executive_visuals.project_members m where m.project_id=jobs.project_id and m.member_id=(select auth.uid())
));
create policy ev_jobs_insert on executive_visuals.jobs for insert to authenticated
with check (owner_id=(select auth.uid()));
create policy ev_jobs_update on executive_visuals.jobs for update to authenticated
using (owner_id=(select auth.uid())) with check (owner_id=(select auth.uid()));
create policy ev_jobs_delete on executive_visuals.jobs for delete to authenticated
using (owner_id=(select auth.uid()));

create policy ev_job_events_read on executive_visuals.job_events for select to authenticated
using (owner_id=(select auth.uid()));
create policy ev_job_events_insert on executive_visuals.job_events for insert to authenticated
with check (owner_id=(select auth.uid()));

create policy ev_consents_read on executive_visuals.consents for select to authenticated
using (owner_id=(select auth.uid()) or exists (
  select 1 from executive_visuals.project_members m where m.project_id=consents.project_id and m.member_id=(select auth.uid())
));
create policy ev_consents_insert on executive_visuals.consents for insert to authenticated
with check (owner_id=(select auth.uid()));
create policy ev_consents_update on executive_visuals.consents for update to authenticated
using (owner_id=(select auth.uid())) with check (owner_id=(select auth.uid()));

create policy ev_reviews_read on executive_visuals.reviews for select to authenticated
using (owner_id=(select auth.uid()) or exists (
  select 1 from executive_visuals.project_members m where m.project_id=reviews.project_id and m.member_id=(select auth.uid())
));
create policy ev_reviews_insert on executive_visuals.reviews for insert to authenticated
with check (owner_id=(select auth.uid()) and exists (
  select 1 from executive_visuals.project_members m where m.project_id=reviews.project_id and m.member_id=(select auth.uid())
));
create policy ev_reviews_update on executive_visuals.reviews for update to authenticated
using (owner_id=(select auth.uid())) with check (owner_id=(select auth.uid()));

create policy ev_audit_read on executive_visuals.audit_events for select to authenticated
using (owner_id=(select auth.uid()) or exists (
  select 1 from executive_visuals.project_members m where m.project_id=audit_events.project_id and m.member_id=(select auth.uid())
));
create policy ev_audit_insert on executive_visuals.audit_events for insert to authenticated
with check (owner_id=(select auth.uid()));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('executive-visuals-media','executive-visuals-media',false,262144000,
  array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','video/quicktime','video/x-matroska','audio/mpeg','audio/wav','audio/x-wav','audio/mp4','audio/ogg','application/pdf','text/plain','application/json'])
on conflict (id) do nothing;

create policy ev_storage_read on storage.objects for select to authenticated
using (bucket_id='executive-visuals-media' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy ev_storage_insert on storage.objects for insert to authenticated
with check (bucket_id='executive-visuals-media' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy ev_storage_update on storage.objects for update to authenticated
using (bucket_id='executive-visuals-media' and (storage.foldername(name))[1]=(select auth.uid())::text)
with check (bucket_id='executive-visuals-media' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy ev_storage_delete on storage.objects for delete to authenticated
using (bucket_id='executive-visuals-media' and (storage.foldername(name))[1]=(select auth.uid())::text);
