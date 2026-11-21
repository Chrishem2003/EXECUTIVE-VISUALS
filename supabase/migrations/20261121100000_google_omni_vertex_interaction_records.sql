-- Extend the existing service-role-only interaction ledger for Vertex Gemini Omni 1.2.
-- Source-controlled only. Review and apply in an isolated staging database first.
-- Existing 1.1 rows and their trusted Files API URI contract remain unchanged.

alter table executive_visuals.google_video_interactions
  drop constraint if exists google_video_interactions_model_check;

alter table executive_visuals.google_video_interactions
  add constraint google_video_interactions_model_check
  check (model in ('gemini-omni-1.1-flash', 'gemini-omni-1.2-flash'));

alter table executive_visuals.google_video_interactions
  drop constraint if exists google_video_interactions_output_uri_check;

alter table executive_visuals.google_video_interactions
  add constraint google_video_interactions_output_uri_check
  check (
    output_uri is null
    or (
      model = 'gemini-omni-1.1-flash'
      and split_part(output_uri, '/', 1) = 'https:'
      and split_part(output_uri, '/', 2) = ''
      and split_part(output_uri, '/', 3) = 'generativelanguage.googleapis.com'
      and split_part(output_uri, '/', 4) = 'v1beta'
      and split_part(output_uri, '/', 5) = 'files'
      and split_part(output_uri, '/', 6) ~ '^[A-Za-z0-9_-]+(:download[?]alt=media)?$'
      and array_length(string_to_array(output_uri, '/'), 1) = 6
    )
    or (
      model = 'gemini-omni-1.2-flash'
      and output_uri ~ '^gs://[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]/[A-Za-z0-9/_-]{1,180}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[a-f0-9]{64}/$'
      and output_uri !~ '//|/\.\.?/'
    )
  );
