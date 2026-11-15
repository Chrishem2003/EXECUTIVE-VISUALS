-- Contract test for the Luma Ray 3.2 private provider-file ledger.
do $$
declare
  files_oid regclass := to_regclass('executive_visuals.luma_provider_files');
  attempts_oid regclass := to_regclass('executive_visuals.luma_provider_file_upload_attempts');
  files_rls boolean;
  files_force_rls boolean;
  attempts_rls boolean;
  attempts_force_rls boolean;
begin
  if files_oid is null or attempts_oid is null then
    raise exception 'Luma provider-file tables are missing';
  end if;

  select c.relrowsecurity,c.relforcerowsecurity into files_rls,files_force_rls
    from pg_class c where c.oid=files_oid;
  select c.relrowsecurity,c.relforcerowsecurity into attempts_rls,attempts_force_rls
    from pg_class c where c.oid=attempts_oid;
  if not files_rls or not files_force_rls or not attempts_rls or not attempts_force_rls then
    raise exception 'Luma provider-file tables must enable and force row-level security';
  end if;

  if has_table_privilege('anon',files_oid,'select') or
     has_table_privilege('authenticated',files_oid,'select') or
     has_table_privilege('anon',attempts_oid,'select') or
     has_table_privilege('authenticated',attempts_oid,'select') then
    raise exception 'Luma provider-file ledgers must not be readable by anon or authenticated roles';
  end if;
  if not has_table_privilege('service_role',files_oid,'select,insert,update,delete') or
     not has_table_privilege('service_role',attempts_oid,'select,insert,update') then
    raise exception 'Luma provider-file service role privileges are incomplete';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid=files_oid and contype='u'
      and pg_get_constraintdef(oid) like '%provider_file_id%'
  ) then raise exception 'Luma provider file ID uniqueness is missing'; end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid=files_oid and contype='u'
      and pg_get_constraintdef(oid) like '%asset_id%owner_id%purpose%'
  ) then raise exception 'Luma owner/asset/purpose mapping uniqueness is missing'; end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid=attempts_oid and contype='u'
      and pg_get_constraintdef(oid) like '%attempt_key%'
  ) then raise exception 'Luma upload attempt idempotency uniqueness is missing'; end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid=files_oid and contype='f'
      and pg_get_constraintdef(oid) like '%assets%'
  ) then raise exception 'Luma provider-file asset ownership foreign key is missing'; end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid=attempts_oid and contype='c'
      and pg_get_constraintdef(oid) like '%OUTCOME_UNKNOWN%'
  ) then raise exception 'Luma upload attempt recovery states are missing'; end if;

  if to_regclass('executive_visuals.luma_provider_files_owner_state_idx') is null or
     to_regclass('executive_visuals.luma_provider_file_attempts_recovery_idx') is null then
    raise exception 'Luma provider-file recovery indexes are missing';
  end if;
end
$$;
