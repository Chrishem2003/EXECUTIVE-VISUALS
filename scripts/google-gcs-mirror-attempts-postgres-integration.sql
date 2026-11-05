begin;

do $google_gcs_attempts$
declare
  v_table regclass := 'executive_visuals.google_gcs_mirror_attempts'::regclass;
  v_rls boolean;
  v_force_rls boolean;
  v_owner uuid := '81111111-1111-4111-8111-111111111111';
  v_other uuid := '82222222-2222-4222-8222-222222222222';
  v_project uuid := '83333333-3333-4333-8333-333333333333';
  v_asset uuid := '84444444-4444-4444-8444-444444444444';
  v_attempt uuid := '85555555-5555-4555-8555-555555555555';
begin
  select relrowsecurity,relforcerowsecurity into v_rls,v_force_rls from pg_class where oid=v_table;
  if not v_rls or not v_force_rls then raise exception 'GCS mirror attempt ledger must enable and force RLS'; end if;
  if has_table_privilege('anon',v_table,'SELECT') or has_table_privilege('authenticated',v_table,'SELECT') or
     has_table_privilege('anon',v_table,'INSERT') or has_table_privilege('authenticated',v_table,'INSERT') or
     has_table_privilege('anon',v_table,'UPDATE') or has_table_privilege('authenticated',v_table,'UPDATE') then
    raise exception 'Browser roles must not access GCS mirror attempts';
  end if;
  if not has_table_privilege('service_role',v_table,'SELECT') or
     not has_table_privilege('service_role',v_table,'INSERT') or
     not has_table_privilege('service_role',v_table,'UPDATE') then
    raise exception 'Service role must access GCS mirror attempts';
  end if;
  if not exists(select 1 from pg_constraint where conrelid=v_table and conname='google_gcs_mirror_attempts_lease_pair_check') then
    raise exception 'GCS mirror attempt lease pair constraint is missing';
  end if;
  if not exists(select 1 from pg_constraint where conrelid=v_table and conname='google_gcs_mirror_attempts_session_state_check') then
    raise exception 'GCS mirror attempt encrypted session constraint is missing';
  end if;
  if not exists(select 1 from pg_indexes where schemaname='executive_visuals' and indexname='google_gcs_mirror_attempts_recovery_idx') then
    raise exception 'GCS mirror attempt recovery index is missing';
  end if;
  if not exists(select 1 from information_schema.columns where table_schema='executive_visuals' and table_name='google_gcs_mirror_attempts' and column_name='crc32c' and data_type='text') then
    raise exception 'Immutable GCS CRC32C receipt column is missing';
  end if;
  if not exists(select 1 from pg_constraint where conrelid=v_table and conname='google_gcs_mirror_attempts_crc32c_check') then
    raise exception 'GCS CRC32C receipt validation constraint is missing';
  end if;
  if not exists(select 1 from information_schema.columns where table_schema='executive_visuals' and table_name='google_gcs_mirror_attempts' and column_name='session_uri_ciphertext' and data_type='text') then
    raise exception 'Encrypted session URI column is missing';
  end if;
  if not exists(select 1 from pg_trigger where tgrelid=v_table and tgname='ev_google_gcs_mirror_attempt_guard' and not tgisinternal) then
    raise exception 'GCS mirror attempt identity/scope trigger is missing';
  end if;

  insert into auth.users(id) values (v_owner),(v_other);
  insert into executive_visuals.projects(id,owner_id,name) values (v_project,v_owner,'GCS mirror attempt test');
  insert into executive_visuals.assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path,deleted_at)
  values (v_asset,v_owner,v_project,'master.mp4','video/mp4',4,repeat('b',64),'executive-visuals-media','attempt-test/'||v_asset||'/master.mp4',null);

  insert into executive_visuals.google_gcs_mirror_attempts(
    id,attempt_key,asset_id,owner_id,project_id,bucket,object_name,media_type,byte_size,sha256,crc32c,state
  ) values (
    v_attempt,repeat('c',64),v_asset,v_owner,v_project,'private-media-bucket',
    'mirrors/'||v_asset||'/master.mp4','video/mp4',4,repeat('b',64),'4waSgw==','PREPARED'
  );

  begin
    insert into executive_visuals.google_gcs_mirror_attempts(
      id,attempt_key,asset_id,owner_id,project_id,bucket,object_name,media_type,byte_size,sha256,crc32c,state
    ) values (
      '86666666-6666-4666-8666-666666666666',repeat('d',64),v_asset,v_other,v_project,
      'private-media-bucket','mirrors/invalid.mp4','video/mp4',4,repeat('b',64),'4waSgw==','PREPARED'
    );
    raise exception 'Expected GCS mirror attempt owner mismatch to be rejected';
  exception when check_violation then
    null;
  end;

  begin
    update executive_visuals.google_gcs_mirror_attempts
       set crc32c='AAAAAA=='
     where id=v_attempt;
    raise exception 'Expected immutable GCS CRC32C receipt mutation to be rejected';
  exception when check_violation then
    null;
  end;

  update executive_visuals.google_gcs_mirror_attempts
     set state='UPLOADING',session_uri_ciphertext='encrypted-envelope-test',
         session_expires_at=clock_timestamp()+interval '1 day'
   where id=v_attempt;

  begin
    update executive_visuals.google_gcs_mirror_attempts
       set session_uri_ciphertext='tampered-envelope'
     where id=v_attempt;
    raise exception 'Expected GCS mirror session ciphertext mutation to be rejected';
  exception when check_violation then
    null;
  end;
end
$google_gcs_attempts$;

rollback;
