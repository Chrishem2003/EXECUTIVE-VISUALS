-- Enforce paired worker-lease fields and make expired-lease recovery scans efficient.
-- Applied once by the migration runner; the index creation is safe to repeat.

alter table executive_visuals.google_drive_export_attempts
  add constraint google_drive_export_attempts_lease_pair_check
  check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  );

create index if not exists google_drive_export_attempts_expired_lease_idx
  on executive_visuals.google_drive_export_attempts (lease_expires_at, updated_at)
  where lease_token is not null;
