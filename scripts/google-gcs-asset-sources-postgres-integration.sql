begin;

do $google_gcs_sources$
declare
  v_owner uuid := '11111111-1111-4111-8111-111111111111';
  v_project uuid := '22222222-2222-4222-8222-222222222222';
  v_asset uuid := '33333333-3333-4333-8333-333333333333';
  v_source uuid := '44444444-4444-4444-8444-444444444444';
  v_table regclass := 'executive_visuals.google_gcs_asset_sources'::regclass;
  v_rls boolean;
  v_force_rls boolean;
  v_state text;
begin
  select relrowsecurity, relforcerowsecurity into v_rls, v_force_rls
    from pg_class where oid = v_table;
  if not v_rls or not v_force_rls then
    raise exception 'GCS source registry must enable and force RLS';
  end if;

  if has_table_privilege('anon', v_table, 'SELECT') or
     has_table_privilege('authenticated', v_table, 'SELECT') or
     has_table_privilege('anon', v_table, 'INSERT') or
     has_table_privilege('authenticated', v_table, 'INSERT') or
     has_table_privilege('anon', v_table, 'UPDATE') or
     has_table_privilege('authenticated', v_table, 'UPDATE') or
     has_table_privilege('anon', v_table, 'DELETE') or
     has_table_privilege('authenticated', v_table, 'DELETE') then
    raise exception 'Browser roles must not access GCS source registry';
  end if;

  if not has_table_privilege('service_role', v_table, 'SELECT') or
     not has_table_privilege('service_role', v_table, 'INSERT') or
     not has_table_privilege('service_role', v_table, 'UPDATE') then
    raise exception 'Service role must have GCS source registry access';
  end if;

  insert into auth.users(id) values (v_owner);
  insert into executive_visuals.projects(id, owner_id, name) values (v_project, v_owner, 'GCS source test');
  insert into executive_visuals.assets(
    id, owner_id, project_id, original_name, media_type, byte_size, sha256,
    storage_bucket, object_path, deleted_at
  ) values (
    v_asset, v_owner, v_project, 'master.mp4', 'video/mp4', 1024, repeat('a',64),
    'executive-visuals-media', 'test/' || v_asset || '/master.mp4', null
  );

  insert into executive_visuals.google_gcs_asset_sources(
    id, asset_id, owner_id, project_id, bucket, object_name, generation,
    metageneration, byte_size, media_type, sha256
  ) values (
    v_source, v_asset, v_owner, v_project, 'private-media-bucket',
    'mirrors/' || v_project || '/master.mp4', '1762300800000000',
    '3', 1024, 'video/mp4', repeat('a',64)
  );

  begin
    insert into executive_visuals.google_gcs_asset_sources(
      asset_id, owner_id, project_id, bucket, object_name, generation,
      metageneration, byte_size, media_type, sha256
    ) values (
      v_asset, v_owner, v_project, 'private-media-bucket',
      'mirrors/' || v_project || '/duplicate.mp4', '1762300800000001',
      '1', 1024, 'video/mp4', repeat('a',64)
    );
    raise exception 'Expected one-active-source-per-asset constraint to reject duplicate';
  exception when unique_violation then
    null;
  end;

  begin
    update executive_visuals.google_gcs_asset_sources
       set object_name = 'mirrors/changed.mp4'
     where id = v_source;
    raise exception 'Expected source identity immutability trigger to reject mutation';
  exception when check_violation then
    null;
  end;

  update executive_visuals.google_gcs_asset_sources
     set state = 'REVOKED', revoked_at = clock_timestamp()
   where id = v_source and state = 'ACTIVE';

  select state into v_state
    from executive_visuals.google_gcs_asset_sources where id = v_source;
  if v_state <> 'REVOKED' then
    raise exception 'GCS source revocation did not persist';
  end if;

  begin
    update executive_visuals.google_gcs_asset_sources
       set state = 'ACTIVE', revoked_at = null
     where id = v_source;
    raise exception 'Expected revoked GCS source reactivation to be rejected';
  exception when check_violation then
    null;
  end;
end
$google_gcs_sources$;

rollback;
