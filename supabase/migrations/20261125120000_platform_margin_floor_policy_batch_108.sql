-- Batch 108: platform-owner-controlled gross-margin floor and versioned audit history.
-- No default margin is invented. Missing/disabled policy blocks billable cloud dispatch.

create table if not exists executive_visuals.platform_financial_policies (
  policy_key text primary key check (policy_key='video_generation'),
  enabled boolean not null default false,
  minimum_gross_margin_bps integer not null check (minimum_gross_margin_bps between 1 and 9500),
  quote_max_age_seconds integer not null check (quote_max_age_seconds between 60 and 3600),
  rate_card_max_age_seconds integer not null check (rate_card_max_age_seconds between 3600 and 3888000),
  version bigint not null check (version>=1),
  updated_by uuid not null references auth.users(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists executive_visuals.platform_financial_policy_history (
  id uuid primary key default gen_random_uuid(),
  policy_key text not null check (policy_key='video_generation'),
  version bigint not null check (version>=1),
  enabled boolean not null,
  minimum_gross_margin_bps integer not null check (minimum_gross_margin_bps between 1 and 9500),
  quote_max_age_seconds integer not null check (quote_max_age_seconds between 60 and 3600),
  rate_card_max_age_seconds integer not null check (rate_card_max_age_seconds between 3600 and 3888000),
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 180),
  updated_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  unique(policy_key,version)
);

alter table executive_visuals.platform_financial_policies enable row level security;
alter table executive_visuals.platform_financial_policy_history enable row level security;
revoke all on executive_visuals.platform_financial_policies from public,anon,authenticated,service_role;
revoke all on executive_visuals.platform_financial_policy_history from public,anon,authenticated,service_role;
grant select on executive_visuals.platform_financial_policies to service_role;
grant select,update,delete on executive_visuals.platform_financial_policy_history to service_role;

create or replace function executive_visuals.reject_platform_financial_policy_history_mutation()
returns trigger language plpgsql set search_path=pg_catalog
as $reject_platform_financial_policy_history_mutation$
begin
 raise exception 'PLATFORM_FINANCIAL_POLICY_HISTORY_IS_APPEND_ONLY' using errcode='55000';
end;
$reject_platform_financial_policy_history_mutation$;
revoke all on function executive_visuals.reject_platform_financial_policy_history_mutation()
 from public,anon,authenticated,service_role;
drop trigger if exists ev_platform_financial_policy_history_immutable
 on executive_visuals.platform_financial_policy_history;
create trigger ev_platform_financial_policy_history_immutable
before update or delete on executive_visuals.platform_financial_policy_history
for each row execute function executive_visuals.reject_platform_financial_policy_history_mutation();

create or replace function executive_visuals.configure_platform_video_margin_policy(
 p_actor_id uuid,
 p_enabled boolean,
 p_minimum_gross_margin_bps integer,
 p_quote_max_age_seconds integer,
 p_rate_card_max_age_seconds integer,
 p_idempotency_key text
)
returns table(policy_version bigint,replayed boolean)
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals,auth
as $configure_platform_video_margin_policy$
declare
 current_policy executive_visuals.platform_financial_policies%rowtype;
 prior_change executive_visuals.platform_financial_policy_history%rowtype;
 next_version bigint;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'PLATFORM_FINANCIAL_POLICY_SERVICE_ROLE_REQUIRED' using errcode='42501';
 end if;
 if p_actor_id is null or p_enabled is null
    or p_minimum_gross_margin_bps is null or p_minimum_gross_margin_bps not between 1 and 9500
    or p_quote_max_age_seconds is null or p_quote_max_age_seconds not between 60 and 3600
    or p_rate_card_max_age_seconds is null or p_rate_card_max_age_seconds not between 3600 and 3888000
    or p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 180
    or not exists(select 1 from auth.users where id=p_actor_id) then
  raise exception 'PLATFORM_FINANCIAL_POLICY_ARGUMENTS_INVALID' using errcode='22023';
 end if;

 select * into prior_change from executive_visuals.platform_financial_policy_history
  where idempotency_key=p_idempotency_key;
 if found then
  if prior_change.updated_by is distinct from p_actor_id
     or prior_change.enabled is distinct from p_enabled
     or prior_change.minimum_gross_margin_bps is distinct from p_minimum_gross_margin_bps
     or prior_change.quote_max_age_seconds is distinct from p_quote_max_age_seconds
     or prior_change.rate_card_max_age_seconds is distinct from p_rate_card_max_age_seconds then
   raise exception 'PLATFORM_FINANCIAL_POLICY_IDEMPOTENCY_CONFLICT' using errcode='23505';
  end if;
  return query select prior_change.version,true;
  return;
 end if;

 select * into current_policy from executive_visuals.platform_financial_policies
  where policy_key='video_generation' for update;
 next_version:=case when current_policy.version is null then 1 else current_policy.version+1 end;

 insert into executive_visuals.platform_financial_policies(
  policy_key,enabled,minimum_gross_margin_bps,quote_max_age_seconds,
  rate_card_max_age_seconds,version,updated_by,updated_at
 ) values(
  'video_generation',p_enabled,p_minimum_gross_margin_bps,p_quote_max_age_seconds,
  p_rate_card_max_age_seconds,next_version,p_actor_id,clock_timestamp()
 )
 on conflict(policy_key) do update set
  enabled=excluded.enabled,
  minimum_gross_margin_bps=excluded.minimum_gross_margin_bps,
  quote_max_age_seconds=excluded.quote_max_age_seconds,
  rate_card_max_age_seconds=excluded.rate_card_max_age_seconds,
  version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at;

 insert into executive_visuals.platform_financial_policy_history(
  policy_key,version,enabled,minimum_gross_margin_bps,quote_max_age_seconds,
  rate_card_max_age_seconds,idempotency_key,updated_by
 ) values(
  'video_generation',next_version,p_enabled,p_minimum_gross_margin_bps,
  p_quote_max_age_seconds,p_rate_card_max_age_seconds,p_idempotency_key,p_actor_id
 );
 return query select next_version,false;
end;
$configure_platform_video_margin_policy$;

revoke all on function executive_visuals.configure_platform_video_margin_policy(
 uuid,boolean,integer,integer,integer,text
) from public,anon,authenticated;
grant execute on function executive_visuals.configure_platform_video_margin_policy(
 uuid,boolean,integer,integer,integer,text
) to service_role;

comment on table executive_visuals.platform_financial_policies is
 'Platform-owner financial controls. No default margin is assumed; cloud video dispatch must fail closed until explicitly configured.';
comment on table executive_visuals.platform_financial_policy_history is
 'Append-only version history of platform financial policy changes.';
comment on function executive_visuals.configure_platform_video_margin_policy(
 uuid,boolean,integer,integer,integer,text
) is
 'Service-role-only configuration RPC. The calling admin API must authorize the platform owner before invoking it.';
