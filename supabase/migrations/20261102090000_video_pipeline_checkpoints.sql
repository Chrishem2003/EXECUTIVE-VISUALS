-- Add durable, server-only checkpoints for cloud video finishing pipelines.
-- Apply only after the isolated Executive Visuals core migration has been reviewed.
create table if not exists executive_visuals.video_pipeline_checkpoints (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references executive_visuals.projects(id) on delete cascade,
  pipeline_id text not null check (char_length(pipeline_id) between 1 and 160),
  step_id text not null check (char_length(step_id) between 1 and 120),
  status text not null check (status = 'succeeded'),
  input_asset_id uuid not null references executive_visuals.assets(id) on delete restrict,
  input_sha256 text not null check (input_sha256 ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null check (idempotency_key ~ '^[a-f0-9]{64}$'),
  output_json jsonb not null check (
    jsonb_typeof(output_json) = 'object'
    and octet_length(output_json::text) <= 32000
  ),
  approval_id text,
  created_at timestamptz not null default now(),
  unique(owner_id, project_id, pipeline_id, step_id),
  unique(owner_id, idempotency_key)
);

create index if not exists ev_video_pipeline_checkpoints_project_created
  on executive_visuals.video_pipeline_checkpoints(project_id, created_at desc);

alter table executive_visuals.video_pipeline_checkpoints enable row level security;
revoke all on executive_visuals.video_pipeline_checkpoints from public, anon, authenticated;
grant all privileges on executive_visuals.video_pipeline_checkpoints to service_role;

create or replace function executive_visuals.validate_video_pipeline_checkpoint_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $checkpoint_scope$
declare
  source_asset executive_visuals.assets;
  output_asset executive_visuals.assets;
  output_id_text text;
  output_sha256 text;
  output_media_type text;
begin
  if not exists (
    select 1
    from executive_visuals.projects p
    where p.id = new.project_id
      and p.owner_id = new.owner_id
      and p.archived_at is null
  ) then
    raise exception 'VIDEO_PIPELINE_CHECKPOINT_PROJECT_SCOPE_INVALID'
      using errcode = '23514';
  end if;

  select * into source_asset
  from executive_visuals.assets a
  where a.id = new.input_asset_id
  for share;

  if not found
     or source_asset.owner_id is distinct from new.owner_id
     or source_asset.project_id is distinct from new.project_id
     or source_asset.deleted_at is not null
     or source_asset.media_type not like 'video/%'
     or source_asset.sha256 is distinct from new.input_sha256
  then
    raise exception 'VIDEO_PIPELINE_CHECKPOINT_SOURCE_SCOPE_INVALID'
      using errcode = '23514';
  end if;

  output_id_text := coalesce(new.output_json ->> 'id', '');
  output_sha256 := lower(coalesce(new.output_json ->> 'sha256', ''));
  output_media_type := coalesce(new.output_json ->> 'mediaType', '');

  if output_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(new.output_json ->> 'derivativeOf', '') <> new.input_asset_id::text
     or output_media_type not like 'video/%'
     or output_sha256 !~ '^[a-f0-9]{64}$'
  then
    raise exception 'VIDEO_PIPELINE_CHECKPOINT_OUTPUT_INVALID'
      using errcode = '23514';
  end if;

  select * into output_asset
  from executive_visuals.assets a
  where a.id = output_id_text::uuid
  for share;

  if not found
     or output_asset.owner_id is distinct from new.owner_id
     or output_asset.project_id is distinct from new.project_id
     or output_asset.derivative_of is distinct from new.input_asset_id
     or output_asset.media_type is distinct from output_media_type
     or output_asset.sha256 is distinct from output_sha256
     or output_asset.deleted_at is not null
  then
    raise exception 'VIDEO_PIPELINE_CHECKPOINT_OUTPUT_SCOPE_INVALID'
      using errcode = '23514';
  end if;

  return new;
end;
$checkpoint_scope$;

drop trigger if exists ev_video_pipeline_checkpoints_validate_scope
  on executive_visuals.video_pipeline_checkpoints;
create trigger ev_video_pipeline_checkpoints_validate_scope
before insert on executive_visuals.video_pipeline_checkpoints
for each row execute function executive_visuals.validate_video_pipeline_checkpoint_scope();

revoke all on function executive_visuals.validate_video_pipeline_checkpoint_scope()
  from public, anon, authenticated, service_role;
