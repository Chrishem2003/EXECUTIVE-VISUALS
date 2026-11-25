\set ON_ERROR_STOP on

insert into auth.users(id,email) values
 ('55555555-5555-4555-8555-555555555555','checkpoint-owner@example.invalid')
on conflict(id) do nothing;
insert into executive_visuals.projects(id,owner_id,name) values
 ('66666666-6666-4666-8666-666666666666','55555555-5555-4555-8555-555555555555','Checkpoint trigger integration')
on conflict(id) do nothing;

insert into executive_visuals.assets(
 id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path,created_at
) values (
 '77777777-7777-4777-8777-777777777777','55555555-5555-4555-8555-555555555555',
 '66666666-6666-4666-8666-666666666666','new-upload.mp4','video/mp4',500000000,repeat('b',64),
 'executive-visuals-media',
 '55555555-5555-4555-8555-555555555555/77777777-7777-4777-8777-777777777777/original.mp4',
 '2026-11-25T10:00:00Z'
);

do $checkpoint_autoinit$
declare
 v_cursor timestamptz; v_owner uuid; v_project uuid; v_count integer;
begin
 select cursor_at,owner_id,project_id into v_cursor,v_owner,v_project
 from executive_visuals.asset_storage_retention_checkpoints
 where asset_id='77777777-7777-4777-8777-777777777777';
 if not found then raise exception 'asset publication did not initialize a retention checkpoint'; end if;
 if v_cursor<>'2026-11-25T10:00:00Z' or
    v_owner<>'55555555-5555-4555-8555-555555555555' or
    v_project<>'66666666-6666-4666-8666-666666666666' then
  raise exception 'retention checkpoint did not preserve asset attribution and creation cursor';
 end if;
 select count(*) into v_count from executive_visuals.asset_resource_measurement_events
 where asset_id='77777777-7777-4777-8777-777777777777';
 if v_count<>0 then raise exception 'checkpoint initialization fabricated a cost event'; end if;
end
$checkpoint_autoinit$;

insert into executive_visuals.assets(
 id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path,created_at,deleted_at
) values (
 '88888888-8888-4888-8888-888888888888','55555555-5555-4555-8555-555555555555',
 '66666666-6666-4666-8666-666666666666','already-deleted.mp4','video/mp4',1000,repeat('c',64),
 'executive-visuals-media',
 '55555555-5555-4555-8555-555555555555/88888888-8888-4888-8888-888888888888/original.mp4',
 '2026-11-24T10:00:00Z','2026-11-25T10:00:00Z'
);

do $deleted_asset$
declare v_count integer;
begin
 select count(*) into v_count from executive_visuals.asset_storage_retention_checkpoints
 where asset_id='88888888-8888-4888-8888-888888888888';
 if v_count<>0 then raise exception 'already-deleted asset unexpectedly opened a new retention interval'; end if;
end
$deleted_asset$;

select 'asset upload retention checkpoint initialization passed' as result;
