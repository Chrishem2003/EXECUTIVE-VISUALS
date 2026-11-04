-- Metadata needed to reuse existing private GCS objects without copying bytes.
-- Gemini registration is temporary access metadata; the source object remains in GCS.

alter table executive_visuals.google_provider_files
  add column if not exists source_type text not null default 'upload';

alter table executive_visuals.google_provider_files
  add column if not exists source_uri text;

alter table executive_visuals.google_provider_files
  add constraint google_provider_files_source_type_check
  check (source_type in ('upload', 'gcs_registration'));

alter table executive_visuals.google_provider_files
  add constraint google_provider_files_gcs_source_uri_check
  check (
    (source_type = 'upload' and source_uri is null) or
    (source_type = 'gcs_registration' and source_uri ~ '^gs://[a-z0-9][a-z0-9.-]{1,220}/[^?#[:space:]]+$')
  );

create index if not exists google_provider_files_source_type_idx
  on executive_visuals.google_provider_files (source_type, expires_at)
  where state = 'ACTIVE';
