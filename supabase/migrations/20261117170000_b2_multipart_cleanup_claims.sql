-- Add a recoverable claim state for abandoned B2 multipart uploads.
-- A worker first claims an expired session, then aborts the provider upload.
-- Stale cleanup claims can be reclaimed after the lease if a process crashes.
alter table executive_visuals.asset_multipart_upload_sessions
  add column if not exists cleanup_claimed_at timestamptz;

alter table executive_visuals.asset_multipart_upload_sessions
  drop constraint if exists asset_multipart_upload_sessions_status_check;

alter table executive_visuals.asset_multipart_upload_sessions
  add constraint asset_multipart_upload_sessions_status_check
  check (status in ('active','completing','cleanup_pending','completed','aborted','expired','failed'));

create index if not exists ev_multipart_sessions_cleanup_pending
  on executive_visuals.asset_multipart_upload_sessions(cleanup_claimed_at)
  where status = 'cleanup_pending';

comment on column executive_visuals.asset_multipart_upload_sessions.cleanup_claimed_at is
  'Lease timestamp for a service-role worker aborting expired provider multipart uploads; stale claims are recoverable.';
