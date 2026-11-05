-- Persist the URI returned at creation so later GET responses need not repeat it.
-- Source-controlled; applied only to the disposable PostgreSQL CI database by this PR.
alter table executive_visuals.google_video_interactions
  add column if not exists output_uri text;

alter table executive_visuals.google_video_interactions
  add constraint google_video_interactions_output_uri_check
  check (
    output_uri is null or
    output_uri ~ '^https://generativelanguage\.googleapis\.com/v1beta/files/[A-Za-z0-9_-]+(:download\?alt=media)?$'
  );
