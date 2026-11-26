-- Batch 128: durable intent and outcome journal for private asset egress.
-- A started row with no terminal state is an interrupted/unknown transfer, never billable evidence.
create table if not exists executive_visuals.asset_egress_transfer_attempts (
  transfer_id uuid primary key,
  asset_id uuid not null references executive_visuals.assets(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete restrict,
  project_id uuid references executive_visuals.projects(id) on delete restrict,
  initiated_by uuid not null references auth.users(id) on delete restrict,
  status text not null default 'started'
    check (status in ('started','completed','partial','measurement_failed','reconciled')),
  transferred_bytes bigint not null default 0 check (transferred_bytes >= 0),
  upstream_status integer check (upstream_status between 200 and 599),
  measurement_id text,
  error_code text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  constraint asset_egress_attempt_terminal_shape check (
    (status='started' and finished_at is null and measurement_id is null)
    or
    (status<>'started' and finished_at is not null)
  )
);
create index if not exists asset_egress_attempts_owner_time_idx
  on executive_visuals.asset_egress_transfer_attempts(owner_id,started_at desc);
create index if not exists asset_egress_attempts_status_time_idx
  on executive_visuals.asset_egress_transfer_attempts(status,started_at);
alter table executive_visuals.asset_egress_transfer_attempts enable row level security;
alter table executive_visuals.asset_egress_transfer_attempts force row level security;
revoke all on table executive_visuals.asset_egress_transfer_attempts from public,anon,authenticated,service_role;

create or replace function executive_visuals.begin_asset_egress_transfer_attempt(
 p_actor_id uuid,p_transfer_id uuid,p_asset_id uuid,p_owner_id uuid,p_project_id uuid
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
set row_security=off
as $begin_egress$
declare v_asset executive_visuals.assets%rowtype;
begin
 if not exists(select 1 from executive_visuals.platform_admins
   where user_id=p_actor_id and role in ('owner','platform_admin','billing_admin')) then
   raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 select * into v_asset from executive_visuals.assets
 where id=p_asset_id and owner_id=p_owner_id and project_id is not distinct from p_project_id;
 if not found then raise exception 'Egress attempt asset attribution mismatch' using errcode='22023'; end if;
 insert into executive_visuals.asset_egress_transfer_attempts(
   transfer_id,asset_id,owner_id,project_id,initiated_by
 ) values(p_transfer_id,p_asset_id,p_owner_id,p_project_id,p_actor_id)
 on conflict(transfer_id) do nothing;
 if not exists(select 1 from executive_visuals.asset_egress_transfer_attempts
   where transfer_id=p_transfer_id and asset_id=p_asset_id and owner_id=p_owner_id
     and project_id is not distinct from p_project_id and initiated_by=p_actor_id) then
   raise exception 'Egress transfer identity conflict' using errcode='23505';
 end if;
 return jsonb_build_object('transferId',p_transfer_id,'status','started');
end;
$begin_egress$;

create or replace function executive_visuals.finish_asset_egress_transfer_attempt(
 p_actor_id uuid,p_transfer_id uuid,p_status text,p_transferred_bytes bigint,
 p_upstream_status integer,p_measurement_id text,p_error_code text default null
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,auth
set row_security=off
as $finish_egress$
declare v_attempt executive_visuals.asset_egress_transfer_attempts%rowtype;
begin
 if not exists(select 1 from executive_visuals.platform_admins
   where user_id=p_actor_id and role in ('owner','platform_admin','billing_admin')) then
   raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_status not in ('completed','partial','measurement_failed') or
    p_transferred_bytes<0 or p_transferred_bytes>2147483648 then
   raise exception 'Invalid egress attempt outcome' using errcode='22023';
 end if;
 select * into v_attempt from executive_visuals.asset_egress_transfer_attempts
 where transfer_id=p_transfer_id for update;
 if not found then raise exception 'Egress attempt not found' using errcode='P0002'; end if;
 if v_attempt.initiated_by<>p_actor_id then raise exception 'Egress attempt actor mismatch' using errcode='42501'; end if;
 if v_attempt.status<>'started' then
   if v_attempt.status=p_status and v_attempt.transferred_bytes=p_transferred_bytes
      and v_attempt.measurement_id is not distinct from p_measurement_id then
     return jsonb_build_object('transferId',p_transfer_id,'status',v_attempt.status,'idempotentReplay',true);
   end if;
   raise exception 'Egress attempt already finalized with different evidence' using errcode='23505';
 end if;
 if p_status in ('completed','partial') and (p_transferred_bytes<1 or p_measurement_id is null) then
   raise exception 'Transferred bytes require a measurement identity' using errcode='22023';
 end if;
 update executive_visuals.asset_egress_transfer_attempts
 set status=p_status,transferred_bytes=p_transferred_bytes,upstream_status=p_upstream_status,
     measurement_id=p_measurement_id,error_code=left(p_error_code,100),
     finished_at=now()
 where transfer_id=p_transfer_id;
 return jsonb_build_object('transferId',p_transfer_id,'status',p_status,'idempotentReplay',false);
end;
$finish_egress$;

revoke all on function executive_visuals.begin_asset_egress_transfer_attempt(uuid,uuid,uuid,uuid,uuid)
 from public,anon,authenticated;
revoke all on function executive_visuals.finish_asset_egress_transfer_attempt(uuid,uuid,text,bigint,integer,text,text)
 from public,anon,authenticated;
grant execute on function executive_visuals.begin_asset_egress_transfer_attempt(uuid,uuid,uuid,uuid,uuid) to service_role;
grant execute on function executive_visuals.finish_asset_egress_transfer_attempt(uuid,uuid,text,bigint,integer,text,text) to service_role;
comment on table executive_visuals.asset_egress_transfer_attempts is
 'Private asset egress transfer intent/outcome journal. Started or measurement_failed rows are operational exceptions, not billable evidence.';
