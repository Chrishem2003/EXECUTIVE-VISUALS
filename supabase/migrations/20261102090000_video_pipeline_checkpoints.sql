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
  output_json jsonb not null check (jsonb_typeof(output_json) = 'object' and octet_length(output_json::text) <= 32000),
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
