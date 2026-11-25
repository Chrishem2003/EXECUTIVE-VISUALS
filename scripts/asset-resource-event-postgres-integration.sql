\set ON_ERROR_STOP on

insert into auth.users(id,email) values
 ('11111111-1111-4111-8111-111111111111','asset-owner@example.invalid'),
 ('44444444-4444-4444-8444-444444444444','finance-admin@example.invalid')
on conflict(id) do nothing;
insert into executive_visuals.projects(id,owner_id,name) values
 ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Asset resource integration')
on conflict(id) do nothing;
insert into executive_visuals.platform_admins(user_id,role)
values ('44444444-4444-4444-8444-444444444444','owner') on conflict(user_id) do update set role=excluded.role;
insert into executive_visuals.assets(
 id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path,created_at
) values (
 '33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111',
 '22222222-2222-4222-8222-222222222222','source.mp4','video/mp4',1000000000,repeat('a',64),
 'executive-visuals-media',
 '11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/original.mp4',
 '2026-11-24T00:00:00Z'
) on conflict(id) do nothing;

do $privileges$
declare
 v_events regclass := 'executive_visuals.asset_resource_measurement_events'::regclass;
 v_checkpoints regclass := 'executive_visuals.asset_storage_retention_checkpoints'::regclass;
begin
 if not (select relrowsecurity and relforcerowsecurity from pg_class where oid=v_events) then
  raise exception 'asset resource events must enable and force RLS';
 end if;
 if not (select relrowsecurity and relforcerowsecurity from pg_class where oid=v_checkpoints) then
  raise exception 'asset retention checkpoints must enable and force RLS';
 end if;
 if has_table_privilege('service_role',v_events,'SELECT')
   or has_table_privilege('service_role',v_events,'INSERT')
   or has_table_privilege('service_role',v_events,'UPDATE')
   or has_table_privilege('service_role',v_events,'DELETE') then
  raise exception 'service_role must use the guarded asset resource RPC, not direct table access';
 end if;
 if not has_function_privilege('service_role',
  'executive_visuals.record_asset_resource_measurement(uuid,uuid,uuid,uuid,text,text,text,text,numeric,timestamptz,timestamptz,timestamptz,bigint,text)',
  'EXECUTE') then raise exception 'service_role must execute asset resource RPC'; end if;
 if has_function_privilege('anon',
  'executive_visuals.record_asset_resource_measurement(uuid,uuid,uuid,uuid,text,text,text,text,numeric,timestamptz,timestamptz,timestamptz,bigint,text)',
  'EXECUTE') or has_function_privilege('authenticated',
  'executive_visuals.record_asset_resource_measurement(uuid,uuid,uuid,uuid,text,text,text,text,numeric,timestamptz,timestamptz,timestamptz,bigint,text)',
  'EXECUTE') then raise exception 'browser roles must not execute asset resource RPC'; end if;
end
$privileges$;

create or replace function executive_visuals.test_fail_retention_checkpoint()
returns trigger language plpgsql as $checkpoint_fail$
begin
 if old.cursor_at = '2026-11-25T00:00:00Z'::timestamptz
   and new.cursor_at = '2026-11-26T00:00:00Z'::timestamptz then
  raise exception 'INJECTED_CHECKPOINT_FAILURE';
 end if;
 return new;
end;
$checkpoint_fail$;
create trigger test_fail_retention_checkpoint before update
on executive_visuals.asset_storage_retention_checkpoints
for each row execute function executive_visuals.test_fail_retention_checkpoint();

set role service_role;
do $behavior$
declare
 v_actor uuid := '44444444-4444-4444-8444-444444444444';
 v_asset uuid := '33333333-3333-4333-8333-333333333333';
 v_owner uuid := '11111111-1111-4111-8111-111111111111';
 v_project uuid := '22222222-2222-4222-8222-222222222222';
 v_first jsonb; v_replay jsonb; v_egress jsonb; v_egress_replay jsonb;
 v_count integer; v_cursor timestamptz;
begin
 v_first := executive_visuals.record_asset_resource_measurement(
  v_actor,v_asset,v_owner,v_project,'asset-storage:interval-000001','storage_retention',
  'storage_gb_day','gb_day',1.0,'2026-11-25T00:00:00Z','2026-11-24T00:00:00Z',
  '2026-11-25T00:00:00Z',null,'asset-resource:storage-000001'
 );
 if v_first->>'idempotentReplay' <> 'false' or v_first->>'checkpointAdvanced' <> 'true' then
  raise exception 'first storage interval was not recorded and checkpointed: %',v_first;
 end if;
 select cursor_at into v_cursor from executive_visuals.asset_storage_retention_checkpoints where asset_id=v_asset;
 if v_cursor <> '2026-11-25T00:00:00Z' then raise exception 'storage checkpoint did not advance'; end if;

 v_replay := executive_visuals.record_asset_resource_measurement(
  v_actor,v_asset,v_owner,v_project,'asset-storage:interval-000001','storage_retention',
  'storage_gb_day','gb_day',1.0,'2026-11-25T00:00:00Z','2026-11-24T00:00:00Z',
  '2026-11-25T00:00:00Z',null,'asset-resource:storage-000001'
 );
 if v_replay->>'idempotentReplay' <> 'true' then raise exception 'storage replay was not idempotent: %',v_replay; end if;
 select version into v_count from executive_visuals.asset_storage_retention_checkpoints where asset_id=v_asset;
 if v_count <> 1 then raise exception 'storage replay advanced checkpoint more than once'; end if;

 begin
  perform executive_visuals.record_asset_resource_measurement(
   v_actor,v_asset,v_owner,v_project,'asset-storage:interval-000001','storage_retention',
   'storage_gb_day','gb_day',2.0,'2026-11-25T00:00:00Z','2026-11-24T00:00:00Z',
   '2026-11-25T00:00:00Z',null,'asset-resource:storage-000001'
  );
  raise exception using errcode='P9999',message='changed measurement payload was accepted';
 exception when unique_violation then null;
 end;

 begin
  perform executive_visuals.record_asset_resource_measurement(
   v_actor,v_asset,v_owner,v_project,'asset-storage:interval-gap-001','storage_retention',
   'storage_gb_day','gb_day',1.0,'2026-11-27T00:00:00Z','2026-11-26T00:00:00Z',
   '2026-11-27T00:00:00Z',null,'asset-resource:storage-gap-001'
  );
  raise exception using errcode='P9999',message='retention checkpoint gap was accepted';
 exception when check_violation then null;
 end;

 v_egress := executive_visuals.record_asset_resource_measurement(
  v_actor,v_asset,v_owner,v_project,'asset-egress:transfer-000001','egress',
  'egress_gb','gb',0.25,'2026-11-25T12:00:00Z',null,null,250000000,'asset-resource:egress-000001'
 );
 v_egress_replay := executive_visuals.record_asset_resource_measurement(
  v_actor,v_asset,v_owner,v_project,'asset-egress:transfer-000001','egress',
  'egress_gb','gb',0.25,'2026-11-25T12:00:00Z',null,null,250000000,'asset-resource:egress-000001'
 );
 if v_egress->>'idempotentReplay' <> 'false' or v_egress_replay->>'idempotentReplay' <> 'true' then
  raise exception 'egress event replay behavior is incorrect';
 end if;

 begin
  perform executive_visuals.record_asset_resource_measurement(
   v_actor,v_asset,v_owner,v_project,'asset-egress:transfer-too-large','egress',
   'egress_gb','gb',1.25,'2026-11-25T13:00:00Z',null,null,1250000000,'asset-resource:egress-too-large'
  );
  raise exception using errcode='P9999',message='egress larger than the asset was accepted';
 exception when sqlstate '22023' then null;
 end;

 -- Inject a failure after event insertion but before checkpoint update. The RPC
 -- transaction must roll back both writes, leaving no event and the old cursor.
 begin
  perform executive_visuals.record_asset_resource_measurement(
   v_actor,v_asset,v_owner,v_project,'asset-storage:interval-rollback','storage_retention',
   'storage_gb_day','gb_day',1.0,'2026-11-26T00:00:00Z','2026-11-25T00:00:00Z',
   '2026-11-26T00:00:00Z',null,'asset-resource:storage-rollback'
  );
  raise exception using errcode='P9999',message='injected checkpoint failure was not triggered';
 exception when raise_exception then
  if sqlerrm='injected checkpoint failure was not triggered' then raise; end if;
  if sqlerrm<>'INJECTED_CHECKPOINT_FAILURE' then raise; end if;
 end;
 select count(*) into v_count from executive_visuals.asset_resource_measurement_events
  where measurement_id='asset-storage:interval-rollback';
 if v_count<>0 then raise exception 'failed checkpoint transaction left an orphan measurement event'; end if;
 select cursor_at into v_cursor from executive_visuals.asset_storage_retention_checkpoints where asset_id=v_asset;
 if v_cursor <> '2026-11-25T00:00:00Z' then raise exception 'failed checkpoint transaction advanced cursor'; end if;

 select count(*) into v_count from executive_visuals.asset_resource_measurement_events where asset_id=v_asset;
 if v_count<>2 then raise exception 'expected exactly one storage and one egress event, found %',v_count; end if;
end
$behavior$;
reset role;
drop trigger test_fail_retention_checkpoint on executive_visuals.asset_storage_retention_checkpoints;
drop function executive_visuals.test_fail_retention_checkpoint();

do $immutability$
begin
 begin
  update executive_visuals.asset_resource_measurement_events set quantity=quantity+1
   where measurement_id='asset-egress:transfer-000001';
  raise exception using errcode='P9999',message='asset resource evidence update was accepted';
 exception when raise_exception then
  if sqlerrm='asset resource evidence update was accepted' then raise; end if;
  if sqlerrm<>'ASSET_RESOURCE_MEASUREMENTS_IMMUTABLE' then raise; end if;
 end;
end
$immutability$;

select 'asset resource event ledger PostgreSQL integration passed' as result;
