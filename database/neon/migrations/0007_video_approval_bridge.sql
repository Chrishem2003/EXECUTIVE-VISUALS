-- Durable Neon-native mirror for the locally approved multi-shot production.
-- Source-controlled only. Do not apply to the connected Neon branch without the
-- separately approved staging-branch ancestry and migration gate.
begin;

create table if not exists executive_visuals.video_generation_approvals (
 id uuid primary key,
 owner_id uuid not null,
 project_id uuid not null,
 idempotency_key text not null check(char_length(idempotency_key) between 8 and 200),
 request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 snapshot_json jsonb not null check(jsonb_typeof(snapshot_json)='object' and octet_length(snapshot_json::text)<=1048576),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 quoted_amount_micros bigint not null check(quoted_amount_micros>0),
 budget_ceiling_micros bigint not null check(budget_ceiling_micros>=quoted_amount_micros),
 status text not null default 'approved_pending_submission' check(status in ('approved_pending_submission','processing')),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 unique(owner_id,idempotency_key)
);

create table if not exists executive_visuals.video_generation_approval_shots (
 approval_id uuid not null references executive_visuals.video_generation_approvals(id) on delete restrict,
 shot_index integer not null check(shot_index between 0 and 11),
 owner_id uuid not null,
 project_id uuid not null,
 provider text not null check(char_length(provider) between 1 and 100),
 model text not null check(char_length(model) between 1 and 160),
 request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 estimated_cost_micros bigint not null check(estimated_cost_micros>0),
 reserved_credits bigint check(reserved_credits is null or reserved_credits between 1 and 100000000),
 budget_approval_id uuid,
 job_id uuid references executive_visuals.jobs(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 primary key(approval_id,shot_index),
 unique(job_id),
 check((reserved_credits is null)=(budget_approval_id is null))
);
create index if not exists ev_neon_approval_owner_created on executive_visuals.video_generation_approvals(owner_id,created_at desc);
create index if not exists ev_neon_approval_shots_owner on executive_visuals.video_generation_approval_shots(owner_id,approval_id,shot_index);

commit;
