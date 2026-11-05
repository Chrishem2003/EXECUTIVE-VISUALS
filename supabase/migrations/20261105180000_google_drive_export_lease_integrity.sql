-- Enforce paired worker-lease fields and make expired-lease recovery scans efficient.
-- Source-controlled only: apply to an isolated staging database after review.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'google_drive_export_attempts_lease_pair_check'
      and conrelid = 'executive_visuals.google_drive_export_attempts'::regclass
  ) then
    alter table executive_visuals.google_drive_export_attempts
      add constraint google_drive_export_attempts_lease_pair_check
      check (
        (lease_token is null and lease_expires_at is null)
        or
        (lease_token is not null and lease_expires_at is not null)
      );
  end if;
end
$$;

create index if not exists google_drive_export_attempts_expired_lease_idx
  on executive_visuals.google_drive_export_attempts (lease_expires_at, updated_at)
  where lease_token is not null;
