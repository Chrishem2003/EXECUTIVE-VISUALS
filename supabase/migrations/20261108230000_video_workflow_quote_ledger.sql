-- Durable, immutable quote records for governed Video Studio workflow generation.
-- Quotes are non-billable evidence only. This migration does not approve, reserve,
-- enqueue or enable provider execution.

create table if not exists executive_visuals.video_workflow_quotes (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references executive_visuals.projects(id) on delete cascade,
  request_id text not null check (request_id ~ '^[A-Za-z0-9._:-]{1,160}$'),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  provider text not null check (provider = 'runway'),
  model text not null check (model = 'model-router'),
  operation text not null check (operation in ('text-to-video','image-to-video','video-to-video')),
  routed_provider text not null check (char_length(routed_provider) between 1 and 100),
  routed_model text not null check (char_length(routed_model) between 1 and 160),
  estimated_credits integer not null check (estimated_credits > 0),
  estimated_amount numeric(14,6) not null check (estimated_amount > 0),
  currency text not null check (currency = 'USD'),
  config_id text not null check (char_length(config_id) <= 64),
  pricing_source text not null check (pricing_source = 'runway_model_router_dry_run'),
  state text not null default 'quoted' check (state in ('quoted','approved','consumed','expired','revoked')),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  check (expires_at > created_at),
  check (expires_at <= created_at + interval '5 minutes 30 seconds')
);

create index if not exists ev_video_workflow_quotes_scope_created
  on executive_visuals.video_workflow_quotes(owner_id, project_id, created_at desc);
create index if not exists ev_video_workflow_quotes_expiry
  on executive_visuals.video_workflow_quotes(expires_at)
  where state = 'quoted';

alter table executive_visuals.video_workflow_quotes enable row level security;
revoke all on executive_visuals.video_workflow_quotes from public, anon, authenticated;
grant select, insert, update on executive_visuals.video_workflow_quotes to service_role;

create or replace function executive_visuals.record_video_workflow_quote(
  p_quote_id uuid,
  p_owner_id uuid,
  p_project_id uuid,
  p_request_id text,
  p_request_hash text,
  p_provider text,
  p_model text,
  p_operation text,
  p_routed_provider text,
  p_routed_model text,
  p_estimated_credits integer,
  p_estimated_amount numeric,
  p_currency text,
  p_config_id text,
  p_pricing_source text,
  p_expires_at timestamptz
) returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $record_video_workflow_quote$
begin
  if p_quote_id is null or p_owner_id is null or p_project_id is null
     or p_provider is null or p_model is null or p_operation is null
     or p_currency is null or p_pricing_source is null
     or p_request_id is null or p_request_id !~ '^[A-Za-z0-9._:-]{1,160}$'
     or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
     or p_provider <> 'runway' or p_model <> 'model-router'
     or p_operation not in ('text-to-video','image-to-video','video-to-video')
     or p_routed_provider is null or char_length(p_routed_provider) not between 1 and 100
     or p_routed_model is null or char_length(p_routed_model) not between 1 and 160
     or p_estimated_credits is null or p_estimated_credits <= 0
     or p_estimated_amount is null or p_estimated_amount <= 0 or p_estimated_amount > 1000000
     or p_currency <> 'USD'
     or p_config_id is null or char_length(p_config_id) > 64
     or p_pricing_source <> 'runway_model_router_dry_run'
     or p_expires_at is null or p_expires_at <= clock_timestamp()
     or p_expires_at > clock_timestamp() + interval '5 minutes 30 seconds' then
    raise exception 'VIDEO_WORKFLOW_QUOTE_ARGUMENTS_INVALID';
  end if;
  if not exists (
    select 1 from executive_visuals.projects p where p.id = p_project_id and p.owner_id = p_owner_id
  ) then
    raise exception 'VIDEO_WORKFLOW_QUOTE_PROJECT_NOT_FOUND';
  end if;
  insert into executive_visuals.video_workflow_quotes(
    id,owner_id,project_id,request_id,request_hash,provider,model,operation,
    routed_provider,routed_model,estimated_credits,estimated_amount,currency,
    config_id,pricing_source,expires_at
  ) values (
    p_quote_id,p_owner_id,p_project_id,p_request_id,p_request_hash,p_provider,p_model,p_operation,
    p_routed_provider,p_routed_model,p_estimated_credits,p_estimated_amount,p_currency,
    p_config_id,p_pricing_source,p_expires_at
  );
  return p_quote_id;
end;
$record_video_workflow_quote$;

revoke all on function executive_visuals.record_video_workflow_quote(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,numeric,text,text,text,timestamptz)
  from public, anon, authenticated;
grant execute on function executive_visuals.record_video_workflow_quote(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,numeric,text,text,text,timestamptz)
  to service_role;
