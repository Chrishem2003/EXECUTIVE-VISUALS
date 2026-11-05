do $google_upload_attempts_migration$
declare
  v_table regclass := 'executive_visuals.google_provider_file_upload_attempts'::regclass;
  v_rls boolean;
  v_force_rls boolean;
  v_state_constraint text;
  v_attempt_index text;
begin
  select c.relrowsecurity, c.relforcerowsecurity
    into v_rls, v_force_rls
    from pg_class c
   where c.oid = v_table;

  if not v_rls or not v_force_rls then
    raise exception 'Gemini upload-attempt ledger must enable and force row-level security';
  end if;

  if has_table_privilege('anon', v_table, 'SELECT') or
     has_table_privilege('authenticated', v_table, 'SELECT') or
     has_table_privilege('anon', v_table, 'INSERT') or
     has_table_privilege('authenticated', v_table, 'INSERT') or
     has_table_privilege('anon', v_table, 'UPDATE') or
     has_table_privilege('authenticated', v_table, 'UPDATE') or
     has_table_privilege('anon', v_table, 'DELETE') or
     has_table_privilege('authenticated', v_table, 'DELETE') then
    raise exception 'Browser roles must not access the Gemini upload-attempt ledger';
  end if;

  if not has_table_privilege('service_role', v_table, 'SELECT') or
     not has_table_privilege('service_role', v_table, 'INSERT') or
     not has_table_privilege('service_role', v_table, 'UPDATE') or
     has_table_privilege('service_role', v_table, 'DELETE') then
    raise exception 'Gemini upload-attempt ledger service-role privileges are incorrect';
  end if;

  select pg_get_constraintdef(oid)
    into v_state_constraint
    from pg_constraint
   where conrelid = v_table
     and contype = 'c'
     and pg_get_constraintdef(oid) like '%QUARANTINED%';

  if v_state_constraint is null or
     v_state_constraint not like '%OUTCOME_UNKNOWN%' or
     v_state_constraint not like '%PROVIDER_CREATED%' then
    raise exception 'Gemini upload-attempt state constraint is missing recovery states';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = v_table and contype = 'f'
       and confrelid = 'executive_visuals.assets'::regclass
  ) or not exists (
    select 1 from pg_constraint
     where conrelid = v_table and contype = 'f'
       and confrelid = 'auth.users'::regclass
  ) then
    raise exception 'Gemini upload attempts must remain bound to private assets and owners';
  end if;

  select indexdef into v_attempt_index
    from pg_indexes
   where schemaname = 'executive_visuals'
     and tablename = 'google_provider_file_upload_attempts'
     and indexname = 'google_provider_file_upload_attempts_recovery_idx';

  if v_attempt_index is null or
     v_attempt_index not like '%UPLOADING%' or
     v_attempt_index not like '%OUTCOME_UNKNOWN%' or
     v_attempt_index not like '%PROVIDER_CREATED%' then
    raise exception 'Gemini upload-attempt recovery index is missing expected states';
  end if;
end
$google_upload_attempts_migration$;

-- Prove the terminal quarantine state is accepted by the actual database constraint.
insert into auth.users (id)
values ('11111111-1111-4111-8111-111111111111')
on conflict (id) do nothing;

insert into executive_visuals.projects (id, owner_id, name)
values ('22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111', 'Gemini upload migration test')
on conflict (id) do nothing;

insert into executive_visuals.assets (
  id, owner_id, project_id, original_name, media_type, byte_size, sha256,
  storage_bucket, object_path
)
values (
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'recovery-fixture.png', 'image/png', 24, repeat('a', 64),
  'private-assets', 'migration-tests/gemini-recovery-fixture.png'
)
on conflict (id) do nothing;

insert into executive_visuals.google_provider_file_upload_attempts (
  attempt_key, asset_id, owner_id, project_id, mime_type, byte_size, sha256,
  google_display_name, state, last_error_code
)
values (
  repeat('b', 64),
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'image/png', 24, repeat('a', 64),
  'executive-visuals-' || repeat('b', 32),
  'QUARANTINED', 'GEMINI_FILE_RECOVERY_NO_PROVIDER_EVIDENCE'
)
on conflict (attempt_key) do update
  set state = excluded.state,
      last_error_code = excluded.last_error_code;

do $google_quarantine_state$
begin
  if not exists (
    select 1 from executive_visuals.google_provider_file_upload_attempts
     where attempt_key = repeat('b', 64)
       and state = 'QUARANTINED'
       and last_error_code = 'GEMINI_FILE_RECOVERY_NO_PROVIDER_EVIDENCE'
  ) then
    raise exception 'Gemini upload quarantine state was not persisted';
  end if;
end
$google_quarantine_state$;
