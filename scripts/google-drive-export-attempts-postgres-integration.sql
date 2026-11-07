do $drive_export_attempts_migration$
declare
  v_table regclass := 'executive_visuals.google_drive_export_attempts'::regclass;
  v_rls boolean;
  v_force_rls boolean;
  v_state_constraint text;
begin
  select c.relrowsecurity,c.relforcerowsecurity into v_rls,v_force_rls
    from pg_class c where c.oid=v_table;
  if not v_rls or not v_force_rls then
    raise exception 'Drive export-attempt ledger must enable and force row-level security';
  end if;
  if has_table_privilege('anon',v_table,'SELECT') or has_table_privilege('authenticated',v_table,'SELECT') or
     has_table_privilege('anon',v_table,'INSERT') or has_table_privilege('authenticated',v_table,'INSERT') or
     has_table_privilege('anon',v_table,'UPDATE') or has_table_privilege('authenticated',v_table,'UPDATE') or
     has_table_privilege('anon',v_table,'DELETE') or has_table_privilege('authenticated',v_table,'DELETE') then
    raise exception 'Browser roles must not access the Drive export-attempt ledger';
  end if;
  if not has_table_privilege('service_role',v_table,'SELECT') or
     not has_table_privilege('service_role',v_table,'INSERT') or
     not has_table_privilege('service_role',v_table,'UPDATE') or
     has_table_privilege('service_role',v_table,'DELETE') then
    raise exception 'Drive export-attempt service-role privileges are incorrect';
  end if;
  select pg_get_constraintdef(oid) into v_state_constraint
    from pg_constraint where conrelid=v_table and contype='c'
      and pg_get_constraintdef(oid) like '%RECONCILIATION_REQUIRED%';
  if v_state_constraint is null or v_state_constraint not like '%OUTCOME_UNKNOWN%' or
     v_state_constraint not like '%COMPLETED%' then
    raise exception 'Drive export-attempt state constraint is missing recovery states';
  end if;
  if not exists(select 1 from pg_constraint where conrelid=v_table and contype='f' and confrelid='executive_visuals.assets'::regclass) or
     not exists(select 1 from pg_constraint where conrelid=v_table and contype='f' and confrelid='auth.users'::regclass) then
    raise exception 'Drive export attempts must remain bound to private assets and owners';
  end if;
  if not exists(select 1 from information_schema.columns where table_schema='executive_visuals' and table_name='google_drive_export_attempts' and column_name='lease_token') or
     not exists(select 1 from information_schema.columns where table_schema='executive_visuals' and table_name='google_drive_export_attempts' and column_name='lease_expires_at') then
    raise exception 'Drive export-attempt ledger must persist exclusive recovery leases';
  end if;
  if not exists(select 1 from pg_constraint where conrelid=v_table and conname='google_drive_export_attempts_lease_pair_check' and contype='c') then
    raise exception 'Drive export-attempt lease token and expiry must be paired';
  end if;
  if to_regclass('executive_visuals.google_drive_export_attempts_expired_lease_idx') is null then
    raise exception 'Drive export-attempt expired-lease recovery index is missing';
  end if;
  if not exists(select 1 from pg_constraint where conrelid=v_table and contype='u' and pg_get_constraintdef(oid) like '%attempt_key%') or
     not exists(select 1 from pg_constraint where conrelid=v_table and contype='u' and pg_get_constraintdef(oid) like '%drive_file_id%') then
    raise exception 'Drive export attempts require unique idempotency and provider file IDs';
  end if;
end
$drive_export_attempts_migration$;

insert into executive_visuals.google_drive_export_attempts(
  attempt_key,owner_id,project_id,asset_id,drive_file_id,mime_type,byte_size,sha256,state
) values (
  repeat('c',64),'11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333',
  'driveFile_123456789','image/png',24,repeat('a',64),'PREPARED'
) on conflict(attempt_key) do update set state=excluded.state;

do $drive_export_attempts_row$
begin
  if not exists(select 1 from executive_visuals.google_drive_export_attempts
    where attempt_key=repeat('c',64) and state='PREPARED' and drive_file_id='driveFile_123456789') then
    raise exception 'Drive export attempt row was not persisted';
  end if;
end
$drive_export_attempts_row$;
