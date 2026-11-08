-- Durable ownership and retention metadata for Gemini Omni Interactions.
-- Source-controlled only; do not apply to staging or production without review.

create table if not exists executive_visuals.google_video_interactions (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider = 'google'),
  model text not null check (model = 'gemini-omni-1.1-flash'),
  interaction_id text not null unique check (interaction_id ~ '^v1_[A-Za-z0-9_-]{6,200}$'),
  job_id uuid not null references executive_visuals.jobs(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  parent_interaction_id text check (
    parent_interaction_id is null or parent_interaction_id ~ '^v1_[A-Za-z0-9_-]{6,200}$'
  ),
  state text not null check (state in (
    'running', 'waiting', 'succeeded', 'failed', 'canceled', 'incomplete', 'unknown', 'deleting', 'deleted'
  )),
  output_file_name text,
  output_uri text,
  constraint google_video_interactions_output_uri_check check (
    output_uri is null or (
      split_part(output_uri, '/', 1) = 'https:' and
      split_part(output_uri, '/', 2) = '' and
      split_part(output_uri, '/', 3) = 'generativelanguage.googleapis.com' and
      split_part(output_uri, '/', 4) = 'v1beta' and
      split_part(output_uri, '/', 5) = 'files' and
      split_part(output_uri, '/', 6) ~ '^[A-Za-z0-9_-]+(:download[?]alt=media)?$' and
      array_length(string_to_array(output_uri, '/'), 1) = 6
    )
  ),
  submitted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  deleted_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists google_video_interactions_owner_project_idx
  on executive_visuals.google_video_interactions (owner_id, project_id, submitted_at desc);

create index if not exists google_video_interactions_expiry_idx
  on executive_visuals.google_video_interactions (expires_at)
  where state <> 'deleted';

create index if not exists google_video_interactions_job_idx
  on executive_visuals.google_video_interactions (job_id, owner_id);

alter table executive_visuals.google_video_interactions enable row level security;
alter table executive_visuals.google_video_interactions force row level security;

revoke all on table executive_visuals.google_video_interactions from public, anon, authenticated;
grant usage on schema executive_visuals to service_role;
grant select, insert, update, delete on table executive_visuals.google_video_interactions to service_role;
