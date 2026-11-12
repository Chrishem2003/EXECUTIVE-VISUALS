-- Smoke-test the complete Supabase local stack after `supabase db reset`.
-- This test only targets the disposable local database used by CI/developers.
DO $$
DECLARE
  table_name text;
  table_oid oid;
  expected_tables text[] := ARRAY[
    'projects',
    'project_workspace_documents',
    'project_members',
    'workflows',
    'timelines',
    'assets',
    'jobs',
    'workflow_runs',
    'workflow_node_runs',
    'job_events',
    'consents',
    'reviews',
    'audit_events',
    'video_pipeline_checkpoints'
  ];
  applied_migrations bigint;
BEGIN
  FOREACH table_name IN ARRAY expected_tables LOOP
    table_oid := to_regclass(format('executive_visuals.%I', table_name));
    IF table_oid IS NULL THEN
      RAISE EXCEPTION 'Missing Executive Visuals table: %', table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid = table_oid AND relrowsecurity = true
    ) THEN
      RAISE EXCEPTION 'Row-level security is not enabled on executive_visuals.%', table_name;
    END IF;
  END LOOP;

  SELECT count(*) INTO applied_migrations
  FROM supabase_migrations.schema_migrations
  WHERE version IN (
    '20261108000000',
    '20261108010000',
    '20261108020000',
    '20261108030000'
  );

  IF applied_migrations <> 4 THEN
    RAISE EXCEPTION 'Expected all four lease-fenced asset publication migrations, found %', applied_migrations;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id = 'executive-visuals-media'
      AND public = false
      AND file_size_limit = 262144000
  ) THEN
    RAISE EXCEPTION 'Private Executive Visuals media bucket is missing or misconfigured';
  END IF;

  IF to_regprocedure('executive_visuals.validate_video_pipeline_checkpoint_scope()') IS NULL THEN
    RAISE EXCEPTION 'Video pipeline checkpoint scope trigger function is missing';
  END IF;

  IF has_table_privilege('anon', 'executive_visuals.video_pipeline_checkpoints', 'SELECT')
     OR has_table_privilege('authenticated', 'executive_visuals.video_pipeline_checkpoints', 'SELECT') THEN
    RAISE EXCEPTION 'Video pipeline checkpoints must remain server-only';
  END IF;

  IF NOT has_table_privilege('service_role', 'executive_visuals.video_pipeline_checkpoints', 'INSERT') THEN
    RAISE EXCEPTION 'Service role is missing video pipeline checkpoint insert permission';
  END IF;

  IF (
    SELECT count(*) FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname IN ('ev_storage_read','ev_storage_insert','ev_storage_update','ev_storage_delete')
  ) <> 4 THEN
    RAISE EXCEPTION 'Expected all four owner/project-scoped private storage policies';
  END IF;
END
$$;

SELECT
  'Executive Visuals local Supabase stack verified' AS result,
  (SELECT count(*) FROM supabase_migrations.schema_migrations) AS applied_migrations,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='executive_visuals' AND c.relkind='r' AND c.relrowsecurity) AS rls_protected_tables,
  (SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects'
    AND policyname LIKE 'ev_storage_%') AS private_storage_policies;
