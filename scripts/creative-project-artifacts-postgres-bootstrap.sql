-- Executive Visuals durable creative artifacts: staging/bootstrap SQL.
-- Apply only to a dedicated Executive Visuals development database.
-- This file is a bootstrap/integration fixture, not a production migration.

create table if not exists executive_visuals.creative_project_artifacts (
  id uuid primary key,
  project_id uuid not null references executive_visuals.projects(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  artifact_type text not null check (artifact_type in ('creative_direction','storyboard')),
  revision integer not null check (revision > 0),
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  input jsonb not null check (jsonb_typeof(input)='object'),
  content jsonb not null check (jsonb_typeof(content)='object'),
  model text check (model is null or char_length(model)<=200),
  usage jsonb not null default '{}'::jsonb check (jsonb_typeof(usage)='object'),
  created_at timestamptz not null default now(),
  unique(project_id,artifact_type,revision)
);

create index if not exists ev_creative_artifacts_project_type_revision_idx
  on executive_visuals.creative_project_artifacts(project_id,artifact_type,revision desc);
create index if not exists ev_creative_artifacts_creator_created_idx
  on executive_visuals.creative_project_artifacts(created_by,created_at desc);

alter table executive_visuals.creative_project_artifacts enable row level security;
revoke all on table executive_visuals.creative_project_artifacts from public,anon,authenticated;
grant select,insert on table executive_visuals.creative_project_artifacts to service_role;

create or replace function executive_visuals.prevent_creative_project_artifact_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $$
begin
  raise exception 'CREATIVE_PROJECT_ARTIFACTS_IMMUTABLE' using errcode='55000';
end;
$$;

drop trigger if exists ev_creative_project_artifacts_immutable on executive_visuals.creative_project_artifacts;
create trigger ev_creative_project_artifacts_immutable
  before update or delete on executive_visuals.creative_project_artifacts
  for each row execute function executive_visuals.prevent_creative_project_artifact_mutation();

create or replace function executive_visuals.append_creative_project_artifact(
  p_id uuid,
  p_project_id uuid,
  p_created_by uuid,
  p_artifact_type text,
  p_input_hash text,
  p_content_hash text,
  p_input jsonb,
  p_content jsonb,
  p_model text,
  p_usage jsonb
)
returns setof executive_visuals.creative_project_artifacts
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $$
declare
  project_owner uuid;
  next_revision integer;
begin
  if p_artifact_type not in ('creative_direction','storyboard')
     or p_input_hash !~ '^[a-f0-9]{64}$'
     or p_content_hash !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(p_input)<>'object'
     or jsonb_typeof(p_content)<>'object'
     or jsonb_typeof(p_usage)<>'object'
     or octet_length(p_input::text)>524288
     or octet_length(p_content::text)>524288
     or octet_length(p_usage::text)>524288
     or (p_model is not null and char_length(p_model)>200) then
    raise exception 'CREATIVE_ARTIFACT_INVALID' using errcode='22023';
  end if;

  -- Serialize revisions for a project, avoiding MAX(revision)+1 races.
  select owner_id into project_owner
  from executive_visuals.projects
  where id=p_project_id and archived_at is null
  for update;

  if not found then
    raise exception 'CREATIVE_ARTIFACT_PROJECT_NOT_FOUND' using errcode='23503';
  end if;

  if project_owner<>p_created_by and not exists (
    select 1 from executive_visuals.project_members
    where project_id=p_project_id and member_id=p_created_by and role='editor'
  ) then
    raise exception 'CREATIVE_ARTIFACT_EDITOR_REQUIRED' using errcode='42501';
  end if;

  select coalesce(max(revision),0)+1 into next_revision
  from executive_visuals.creative_project_artifacts
  where project_id=p_project_id and artifact_type=p_artifact_type;

  return query
  insert into executive_visuals.creative_project_artifacts(
    id,project_id,created_by,artifact_type,revision,input_hash,content_hash,input,content,model,usage
  ) values (
    p_id,p_project_id,p_created_by,p_artifact_type,next_revision,p_input_hash,p_content_hash,p_input,p_content,p_model,p_usage
  )
  returning *;
end;
$$;

revoke all on function executive_visuals.append_creative_project_artifact(uuid,uuid,uuid,text,text,text,jsonb,jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function executive_visuals.append_creative_project_artifact(uuid,uuid,uuid,text,text,text,jsonb,jsonb,text,jsonb) to service_role;
