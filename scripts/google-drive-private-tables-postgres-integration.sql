do $google_drive_private_tables$
declare
  item record;
  v_table regclass;
  v_rls boolean;
  v_force boolean;
begin
  for item in
    select * from (values
      ('google_drive_connections'::text, true),
      ('google_drive_oauth_states'::text, true),
      ('google_drive_export_attempts'::text, false)
    ) as t(table_name, service_delete_allowed)
  loop
    v_table := to_regclass('executive_visuals.' || item.table_name);
    if v_table is null then raise exception 'Google Drive table % is missing', item.table_name; end if;
    select c.relrowsecurity,c.relforcerowsecurity into v_rls,v_force from pg_class c where c.oid=v_table;
    if not v_rls or not v_force then raise exception 'RLS must be enabled and forced on %', item.table_name; end if;
    if has_table_privilege('anon',v_table,'SELECT') or has_table_privilege('authenticated',v_table,'SELECT') or
       has_table_privilege('anon',v_table,'INSERT') or has_table_privilege('authenticated',v_table,'INSERT') or
       has_table_privilege('anon',v_table,'UPDATE') or has_table_privilege('authenticated',v_table,'UPDATE') or
       has_table_privilege('anon',v_table,'DELETE') or has_table_privilege('authenticated',v_table,'DELETE') then
      raise exception 'Browser roles must not access %', item.table_name;
    end if;
    if not has_table_privilege('service_role',v_table,'SELECT') or
       not has_table_privilege('service_role',v_table,'INSERT') or
       not has_table_privilege('service_role',v_table,'UPDATE') then
      raise exception 'Service role lacks required access to %', item.table_name;
    end if;
    if item.service_delete_allowed and not has_table_privilege('service_role',v_table,'DELETE') then
      raise exception 'Service role requires DELETE on %', item.table_name;
    end if;
    if not item.service_delete_allowed and has_table_privilege('service_role',v_table,'DELETE') then
      raise exception 'Service role must not DELETE from %', item.table_name;
    end if;
  end loop;
  if not exists(select 1 from information_schema.columns where table_schema='executive_visuals' and table_name='google_drive_connections' and column_name='encrypted_refresh_token') or
     not exists(select 1 from information_schema.columns where table_schema='executive_visuals' and table_name='google_drive_oauth_states' and column_name='encrypted_payload') or
     not exists(select 1 from information_schema.columns where table_schema='executive_visuals' and table_name='google_drive_export_attempts' and column_name='encrypted_session_uri') then
    raise exception 'Google Drive credentials and resumable-session URLs must be encrypted at rest';
  end if;
  if exists(select 1 from information_schema.columns where table_schema='executive_visuals' and table_name='google_drive_connections' and column_name in ('refresh_token','access_token')) or
     exists(select 1 from information_schema.columns where table_schema='executive_visuals' and table_name='google_drive_oauth_states' and column_name in ('pkce_verifier','nonce')) or
     exists(select 1 from information_schema.columns where table_schema='executive_visuals' and table_name='google_drive_export_attempts' and column_name='session_uri') then
    raise exception 'Plaintext Google credentials or session URLs must not be stored';
  end if;
end
$google_drive_private_tables$;
