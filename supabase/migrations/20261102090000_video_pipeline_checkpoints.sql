-- Add durable, server-only checkpoints for cloud video finishing pipelines.
-- This migration is replayed in the disposable local Supabase stack in CI.
create table if not exists executive_visuals.video_pipeline_checkpoints (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references executive_visuals.projects(id) on delete cascade,
  pipeline_id text not null check (char_length(pipeline_id) between 1 and 160),
  step_id text not null check (char_length(step_id) between 1 and 120),
  status text not null check (status = 'succeeded'),
  input_asset_id uuid not null references executive_visuals.assets(id) on delete restrict,
  input_sha256 text not null check (
    char_length(input_sha256) = 64 and input_sha256 !~ '[^a-f0-9]'
  ),
  idempotency_key text not null check (
    char_length(idempotency_key) = 64 and idempotency_key !~ '[^a-f0-9]'
  ),
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
set search_path = pg_catalog, executive_visuals
as $evfn$
declare
  source_asset executive_visuals.assets%rowtype;
  published_asset executive_visuals.assets%rowtype;
  output_id_text text;
  output_sha text;
  output_media_type text;
begin
  if not exists (
    select 1
    from executive_visuals.projects p
    where p.id = new.project_id
      and p.owner_id = new.owner_id
      and p.archived_at is null
  ) then
    raise exception 'VIDEO_PIPELINE_CHECKPOINT_PROJECT_SCOPE_INVALID';
  end if;

  select a.*
    into source_asset
  from executive_visuals.assets a
  where a.id = new.input_asset_id
    and a.owner_id = new.owner_id
    and a.project_id = new.project_id
    and a.deleted_at is null
    and a.media_type like 'video/%'
    and lower(a.sha256) = lower(new.input_sha256);

  if not found then
    raise exception 'VIDEO_PIPELINE_CHECKPOINT_SOURCE_SCOPE_INVALID';
  end if;

  output_id_text := coalesce(new.output_json ->> 'id', '');
  output_sha := lower(coalesce(new.output_json ->> 'sha256', ''));
  output_media_type := coalesce(new.output_json ->> 'mediaType', '');

  if not pg_catalog.pg_input_is_valid(output_id_text, 'uuid')
     or char_length(output_sha) <> 64
     or output_sha ~ '[^a-f0-9]'
     or coalesce(new.output_json ->> 'derivativeOf', '') <> new.input_asset_id::text
     or output_media_type not like 'video/%' then
    raise exception 'VIDEO_PIPELINE_CHECKPOINT_OUTPUT_INVALID';
  end if;

  select output_asset.*
    into published_asset
  from executive_visuals.assets output_asset
  where output_asset.id = output_id_text::uuid
    and output_asset.owner_id = new.owner_id
    and output_asset.project_id = new.project_id
    and output_asset.derivative_of = new.input_asset_id
    and output_asset.media_type = output_media_type
    and output_asset.sha256 = lower(new.output_json ->> 'sha256')
    and output_asset.deleted_at is null;

  if not found then
    raise exception 'VIDEO_PIPELINE_CHECKPOINT_OUTPUT_SCOPE_INVALID';
  end if;

  return new;
end;
$evfn$;

create trigger ev_video_pipeline_checkpoints_validate_scope
before insert on executive_visuals.video_pipeline_checkpoints
for each row execute function executive_visuals.validate_video_pipeline_checkpoint_scope();

revoke all on function executive_visuals.validate_video_pipeline_checkpoint_scope() from public, anon, authenticated;
