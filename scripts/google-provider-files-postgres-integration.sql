do $google_files_migration$
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
    raise exception 'Google provider-file mapping table must enable and force row-level security';
  end if;

  if has_table_privilege('anon', v_table, 'SELECT') or
     has_table_privilege('authenticated', v_table, 'SELECT') or
     has_table_privilege('anon', v_table, 'INSERT') or
     has_table_privilege('authenticated', v_table, 'INSERT') or
     has_table_privilege('anon', v_table, 'UPDATE') or
     has_table_privilege('authenticated', v_table, 'UPDATE') or
     has_table_privilege('anon', v_table, 'DELETE') or
     has_table_privilege('authenticated', v_table, 'DELETE') then
    raise exception 'Browser roles must not have direct access to Google provider-file mappings';
  end if;

  if not has_table_privilege('service_role', v_table, 'SELECT') or
     not has_table_privilege('service_role', v_table, 'INSERT') or
     not has_table_privilege('service_role', v_table, 'UPDATE') or
     not has_table_privilege('service_role', v_table, 'DELETE') then
    raise exception 'Service role must have the required Google provider-file mapping privileges';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = v_table
       and contype = 'f'
       and confrelid = 'executive_visuals.assets'::regclass
  ) then
    raise exception 'Google provider-file mapping must reference private application assets';
  end if;
end
$google_files_migration$;
