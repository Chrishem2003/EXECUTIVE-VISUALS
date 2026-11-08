\set ON_ERROR_STOP on

insert into auth.users(id) values
 ('11111111-1111-4111-8111-111111111111'),
 ('44444444-4444-4444-8444-444444444444')
on conflict(id) do nothing;

insert into executive_visuals.projects(id,owner_id,name) values
 ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Asset publication integration')
on conflict(id) do nothing;

do $publication_privileges$
declare
  v_table regclass := 'executive_visuals.asset_publications'::regclass;
  v_rls boolean;
begin
  select relrowsecurity into v_rls from pg_class where oid=v_table;
  if not v_rls then raise exception 'asset publication ledger must enable RLS'; end if;
  if has_table_privilege('anon',v_table,'SELECT') or has_table_privilege('authenticated',v_table,'SELECT')
     or has_table_privilege('anon',v_table,'INSERT') or has_table_privilege('authenticated',v_table,'INSERT')
     or has_table_privilege('anon',v_table,'UPDATE') or has_table_privilege('authenticated',v_table,'UPDATE')
     or has_table_privilege('anon',v_table,'DELETE') or has_table_privilege('authenticated',v_table,'DELETE') then
    raise exception 'browser roles must not access asset publication ledger';
  end if;
  if not has_table_privilege('service_role',v_table,'SELECT')
     or not has_table_privilege('service_role',v_table,'INSERT')
     or not has_table_privilege('service_role',v_table,'UPDATE') then
    raise exception 'service_role must have required publication ledger privileges';
  end if;
  if has_function_privilege('anon','executive_visuals.reserve_asset_publication(uuid,uuid,text,text,uuid)','EXECUTE')
     or has_function_privilege('authenticated','executive_visuals.reserve_asset_publication(uuid,uuid,text,text,uuid)','EXECUTE')
     or has_function_privilege('anon','executive_visuals.complete_asset_publication(uuid,text,uuid)','EXECUTE')
     or has_function_privilege('authenticated','executive_visuals.complete_asset_publication(uuid,text,uuid)','EXECUTE') then
    raise exception 'browser roles must not execute asset publication RPCs';
  end if;
  if not has_function_privilege('service_role','executive_visuals.reserve_asset_publication(uuid,uuid,text,text,uuid)','EXECUTE')
     or not has_function_privilege('service_role','executive_visuals.complete_asset_publication(uuid,text,uuid)','EXECUTE') then
    raise exception 'service_role must execute asset publication RPCs';
  end if;
end
$publication_privileges$;

set role service_role;
do $publication_behavior$
declare
  first_reservation record;
  replay_reservation record;
  completed record;
  expected_asset uuid := '33333333-3333-4333-8333-333333333333';
begin
  select * into first_reservation
  from executive_visuals.reserve_asset_publication(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'job-integration:output:v1', repeat('a',64), expected_asset
  );

  select * into replay_reservation
  from executive_visuals.reserve_asset_publication(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'job-integration:output:v1', repeat('a',64),
    '55555555-5555-4555-8555-555555555555'
  );

  if first_reservation.asset_id is distinct from replay_reservation.asset_id
     or replay_reservation.asset_id is distinct from expected_asset then
    raise exception 'idempotent reservation did not preserve the first asset identity';
  end if;

  begin
    perform * from executive_visuals.reserve_asset_publication(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      'job-integration:output:v1', repeat('b',64),
      '66666666-6666-4666-8666-666666666666'
    );
    raise exception using errcode='P9999', message='expected checksum conflict was not rejected';
  exception when unique_violation then
    null;
  end;

  begin
    perform * from executive_visuals.complete_asset_publication(
      '11111111-1111-4111-8111-111111111111',
      'job-integration:output:v1', expected_asset
    );
    raise exception using errcode='P9999', message='publication completed without a matching asset';
  exception when raise_exception then
    if sqlerrm = 'publication completed without a matching asset' then raise; end if;
    if sqlerrm <> 'publication cannot be completed without its matching active asset' then raise; end if;
  end;

  insert into executive_visuals.assets(
    id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path,deleted_at
  ) values (
    expected_asset,'11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222','render.mp4','video/mp4',4,repeat('a',64),
    'executive-visuals-media',
    '22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/original.mp4',null
  );

  select * into completed
  from executive_visuals.complete_asset_publication(
    '11111111-1111-4111-8111-111111111111',
    'job-integration:output:v1', expected_asset
  );

  if completed.status <> 'published' or completed.asset_id <> expected_asset or completed.published_at is null then
    raise exception 'matching asset publication did not complete';
  end if;

  if (select count(*) from executive_visuals.asset_publications
      where owner_id='11111111-1111-4111-8111-111111111111'
        and publication_key='job-integration:output:v1') <> 1 then
    raise exception 'publication replay created duplicate ledger rows';
  end if;
end
$publication_behavior$;
reset role;

select 'asset publication PostgreSQL integration passed' as result;
