begin;

do $google_gcs_attempts$
declare
  v_table regclass := 'executive_visuals.google_gcs_mirror_attempts'::regclass;
  v_rls boolean;
  v_force_rls boolean;
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
  if not exists(select 1 from information_schema.columns where table_schema='executive_visuals' and table_name='google_gcs_mirror_attempts' and column_name='session_uri_ciphertext' and data_type='text') then
    raise exception 'Encrypted session URI column is missing';
  end if;
end
$google_gcs_attempts$;

rollback;
