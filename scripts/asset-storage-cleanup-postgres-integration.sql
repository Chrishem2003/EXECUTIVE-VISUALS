\set ON_ERROR_STOP on

insert into auth.users(id) values
 ('11111111-1111-4111-8111-111111111111')
on conflict(id) do nothing;

do $cleanup_privileges$
declare
  v_table regclass := 'executive_visuals.asset_storage_cleanup'::regclass;
  v_rls boolean;
begin
  select relrowsecurity into v_rls from pg_class where oid=v_table;
  if not v_rls then raise exception 'storage cleanup outbox must enable RLS'; end if;
  if has_table_privilege('anon',v_table,'SELECT') or has_table_privilege('authenticated',v_table,'SELECT')
     or has_table_privilege('anon',v_table,'INSERT') or has_table_privilege('authenticated',v_table,'INSERT')
     or has_table_privilege('anon',v_table,'UPDATE') or has_table_privilege('authenticated',v_table,'UPDATE')
     or has_table_privilege('anon',v_table,'DELETE') or has_table_privilege('authenticated',v_table,'DELETE') then
    raise exception 'browser roles must not access storage cleanup outbox';
  end if;
  if not has_table_privilege('service_role',v_table,'SELECT')
     or not has_table_privilege('service_role',v_table,'INSERT')
     or not has_table_privilege('service_role',v_table,'UPDATE') then
    raise exception 'service_role must have storage cleanup outbox privileges';
  end if;
  if has_table_privilege('service_role',v_table,'DELETE') then
    raise exception 'service_role must not hard-delete cleanup history';
  end if;
end
$cleanup_privileges$;

set role service_role;
do $cleanup_behavior$
declare
  v_id uuid;
  v_path text := '22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/original.mp4';
  v_count integer;
begin
  insert into executive_visuals.asset_storage_cleanup(storage_bucket,object_path,reason)
  values ('executive-visuals-media',v_path,'integration_test')
  returning id into v_id;

  update executive_visuals.asset_storage_cleanup
  set attempts=2,next_attempt_at='2026-11-08T00:00:00Z',last_error='storage_remove_failed'
  where id=v_id;

  insert into executive_visuals.asset_storage_cleanup(storage_bucket,object_path,reason,attempts,next_attempt_at,completed_at,last_error)
  values ('executive-visuals-media',v_path,'requeued',0,now(),null,null)
  on conflict (object_path) do update
    set reason=excluded.reason,attempts=excluded.attempts,next_attempt_at=excluded.next_attempt_at,
        completed_at=excluded.completed_at,last_error=excluded.last_error;

  select count(*) into v_count
  from executive_visuals.asset_storage_cleanup
  where object_path=v_path and reason='requeued' and completed_at is null and attempts=0;
  if v_count<>1 then raise exception 'cleanup outbox upsert did not restore one pending record'; end if;

  begin
    insert into executive_visuals.asset_storage_cleanup(storage_bucket,object_path)
    values ('executive-visuals-media','../../unrelated.mp4');
    raise exception using errcode='P9999',message='unsafe cleanup path was accepted';
  exception when check_violation then
    null;
  end;
end
$cleanup_behavior$;
reset role;

select 'storage cleanup PostgreSQL integration passed' as result;
