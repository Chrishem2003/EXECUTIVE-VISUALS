-- Governed cloud benchmark registry. Additive only; apply to a dedicated
-- development/staging project after reviewing the existing isolated schema.
create table if not exists executive_visuals.upscale_benchmark_fixtures (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references executive_visuals.projects(id) on delete cascade,
  source_asset_id uuid not null references executive_visuals.assets(id) on delete restrict,
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  fixture_category text not null check (fixture_category in ('portrait','fine_texture','text','animation','low_light_noisy')),
  label text not null default '',
  created_at timestamptz not null default now(),
  unique(project_id,source_asset_id),
  unique(id,project_id)
);
create index if not exists ev_upscale_fixture_project on executive_visuals.upscale_benchmark_fixtures(project_id,created_at desc);

create table if not exists executive_visuals.upscale_benchmark_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references executive_visuals.projects(id) on delete cascade,
  asset_id uuid not null references executive_visuals.assets(id) on delete restrict,
  fixture_id uuid not null,
  fixture_category text not null check (fixture_category in ('portrait','fine_texture','text','animation','low_light_noisy')),
  model text not null,
  model_version text not null,
  record jsonb not null check (jsonb_typeof(record)='object'),
  reviewer_id uuid references auth.users(id),
  review_decision text check (review_decision in ('reviewed_pass','reviewed_fail')),
  review_note text not null default '',
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(asset_id,fixture_id),
  foreign key(fixture_id,project_id) references executive_visuals.upscale_benchmark_fixtures(id,project_id) on delete cascade,
  check ((reviewer_id is null and review_decision is null and reviewed_at is null) or (reviewer_id is not null and review_decision is not null and reviewed_at is not null))
);
create index if not exists ev_upscale_run_project on executive_visuals.upscale_benchmark_runs(project_id,created_at desc);
create index if not exists ev_upscale_run_owner on executive_visuals.upscale_benchmark_runs(owner_id,created_at desc);

alter table executive_visuals.upscale_benchmark_fixtures enable row level security;
alter table executive_visuals.upscale_benchmark_runs enable row level security;
revoke all on executive_visuals.upscale_benchmark_fixtures, executive_visuals.upscale_benchmark_runs from public, anon;
-- All writes go through the authenticated server API using service_role.
-- No direct client grants or client RLS policies: clients cannot forge hashes,
-- reviewer identity, or immutable review decisions.
revoke all on executive_visuals.upscale_benchmark_fixtures, executive_visuals.upscale_benchmark_runs from authenticated;
grant all on executive_visuals.upscale_benchmark_fixtures, executive_visuals.upscale_benchmark_runs to service_role;
