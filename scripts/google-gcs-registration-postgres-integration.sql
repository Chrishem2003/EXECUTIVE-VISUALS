do $google_gcs_registration_migration$
declare
  v_table regclass := 'executive_visuals.google_provider_files'::regclass;
  v_rls boolean;
  v_force_rls boolean;
begin
  select c.relrowsecurity, c.relforcerowsecurity
    into v_rls, v_force_rls
    from pg_class c
   where c.oid = v_table;

  if not v_rls or not v_force_rls then
    raise exception 'Google GCS registration mappings must enable and force RLS';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'executive_visuals'
       and table_name = 'google_provider_files'
       and column_name = 'source_type'
  ) or not exists (
    select 1 from information_schema.columns
     where table_schema = 'executive_visuals'
       and table_name = 'google_provider_files'
       and column_name = 'source_uri'
  ) then
    raise exception 'Google provider-file source metadata columns are required';
  end if;

  if has_table_privilege('anon', v_table, 'SELECT') or
     has_table_privilege('authenticated', v_table, 'SELECT') or
     has_table_privilege('anon', v_table, 'INSERT') or
     has_table_privilege('authenticated', v_table, 'INSERT') or
     has_table_privilege('anon', v_table, 'UPDATE') or
     has_table_privilege('authenticated', v_table, 'UPDATE') or
     has_table_privilege('anon', v_table, 'DELETE') or
     has_table_privilege('authenticated', v_table, 'DELETE') then
    raise exception 'Browser roles must not access Google GCS registration metadata';
  end if;

  if not has_table_privilege('service_role', v_table, 'SELECT') or
     not has_table_privilege('service_role', v_table, 'INSERT') or
     not has_table_privilege('service_role', v_table, 'UPDATE') or
     not has_table_privilege('service_role', v_table, 'DELETE') then
    raise exception 'Service role must retain access to Google GCS registration metadata';
  end if;
end
$google_gcs_registration_migration$;
