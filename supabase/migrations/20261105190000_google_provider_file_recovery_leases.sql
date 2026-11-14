-- Lease-fenced Gemini Files recovery claims.
-- Additive only; apply to an isolated staging database after review.

alter table executive_visuals.google_provider_file_upload_attempts
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz;

do $gemini_recovery_lease_constraint$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'executive_visuals.google_provider_file_upload_attempts'::regclass
       and conname = 'google_provider_file_upload_attempts_lease_pair_check'
  ) then
    alter table executive_visuals.google_provider_file_upload_attempts
      add constraint google_provider_file_upload_attempts_lease_pair_check
      check ((lease_token is null) = (lease_expires_at is null));
  end if;
end
$gemini_recovery_lease_constraint$;

create index if not exists google_provider_file_upload_attempts_recovery_lease_idx
  on executive_visuals.google_provider_file_upload_attempts (state, lease_expires_at, updated_at)
  where state in ('UPLOADING','OUTCOME_UNKNOWN','PROVIDER_CREATED');

revoke all on table executive_visuals.google_provider_file_upload_attempts from public, anon, authenticated;
grant select, insert, update on table executive_visuals.google_provider_file_upload_attempts to service_role;
