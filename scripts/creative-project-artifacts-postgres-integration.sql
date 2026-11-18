\set ON_ERROR_STOP on

-- Verify RLS, service-role-only table/function access and the private API contract.
DO $checks$
DECLARE rls boolean;
BEGIN
  SELECT c.relrowsecurity INTO rls
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='executive_visuals' AND c.relname='creative_project_artifacts';
  IF rls IS DISTINCT FROM true THEN RAISE EXCEPTION 'creative artifact table must have RLS enabled'; END IF;
  IF has_table_privilege('anon','executive_visuals.creative_project_artifacts','SELECT')
     OR has_table_privilege('authenticated','executive_visuals.creative_project_artifacts','SELECT')
     OR has_table_privilege('anon','executive_visuals.creative_project_artifacts','INSERT')
     OR has_table_privilege('authenticated','executive_visuals.creative_project_artifacts','INSERT') THEN
    RAISE EXCEPTION 'anon/authenticated must not access creative artifact rows';
  END IF;
  IF NOT has_table_privilege('service_role','executive_visuals.creative_project_artifacts','SELECT')
     OR NOT has_table_privilege('service_role','executive_visuals.creative_project_artifacts','INSERT')
     OR has_table_privilege('service_role','executive_visuals.creative_project_artifacts','UPDATE')
     OR has_table_privilege('service_role','executive_visuals.creative_project_artifacts','DELETE') THEN
    RAISE EXCEPTION 'service_role must have select/insert only';
  END IF;
  IF has_function_privilege('anon','executive_visuals.append_creative_project_artifact(uuid,uuid,uuid,text,text,text,jsonb,jsonb,text,jsonb)','EXECUTE')
     OR has_function_privilege('authenticated','executive_visuals.append_creative_project_artifact(uuid,uuid,uuid,text,text,text,jsonb,jsonb,text,jsonb)','EXECUTE')
     OR NOT has_function_privilege('service_role','executive_visuals.append_creative_project_artifact(uuid,uuid,uuid,text,text,text,jsonb,jsonb,text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'append RPC must be executable only by service_role';
  END IF;
END;
$checks$;

SET ROLE service_role;
SELECT revision FROM executive_visuals.append_creative_project_artifact(
 '523e4567-e89b-42d3-a456-426614174000',
 '423e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 'storyboard',repeat('a',64),repeat('b',64),
 '{"brief":"verified brief"}'::jsonb,'{"title":"Original storyboard"}'::jsonb,'ci-model','{"totalTokens":10}'::jsonb
);
SELECT revision FROM executive_visuals.append_creative_project_artifact(
 '623e4567-e89b-42d3-a456-426614174000',
 '423e4567-e89b-42d3-a456-426614174000',
 '223e4567-e89b-42d3-a456-426614174000',
 'storyboard',repeat('a',64),repeat('c',64),
 '{"brief":"verified brief"}'::jsonb,'{"title":"Editor revision"}'::jsonb,'ci-model','{"totalTokens":12}'::jsonb
);

DO $authorization$
BEGIN
  BEGIN
    PERFORM * FROM executive_visuals.append_creative_project_artifact(
      '723e4567-e89b-42d3-a456-426614174000','423e4567-e89b-42d3-a456-426614174000',
      '323e4567-e89b-42d3-a456-426614174000','storyboard',repeat('a',64),repeat('d',64),
      '{"brief":"reviewer"}'::jsonb,'{"title":"must be denied"}'::jsonb,'ci-model','{}'::jsonb
    );
    RAISE EXCEPTION 'reviewer write unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
  BEGIN
    PERFORM * FROM executive_visuals.append_creative_project_artifact(
      '823e4567-e89b-42d3-a456-426614174000','423e4567-e89b-42d3-a456-426614174000',
      '323e4567-e89b-42d3-a456-426614174001','storyboard',repeat('a',64),repeat('e',64),
      '{"brief":"viewer"}'::jsonb,'{"title":"must be denied"}'::jsonb,'ci-model','{}'::jsonb
    );
    RAISE EXCEPTION 'viewer write unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
END;
$authorization$;
RESET ROLE;

DO $history$
DECLARE first_revision integer; second_revision integer;
BEGIN
  SELECT revision INTO first_revision FROM executive_visuals.creative_project_artifacts
   WHERE id='523e4567-e89b-42d3-a456-426614174000';
  SELECT revision INTO second_revision FROM executive_visuals.creative_project_artifacts
   WHERE id='623e4567-e89b-42d3-a456-426614174000';
  IF first_revision<>1 OR second_revision<>2 THEN RAISE EXCEPTION 'expected immutable storyboard revisions 1 and 2'; END IF;
END;
$history$;

-- Even the database owner cannot rewrite or delete immutable artifact rows.
DO $immutable$
BEGIN
  BEGIN
    UPDATE executive_visuals.creative_project_artifacts SET content='{}'::jsonb
    WHERE id='523e4567-e89b-42d3-a456-426614174000';
    RAISE EXCEPTION 'artifact update unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    DELETE FROM executive_visuals.creative_project_artifacts
    WHERE id='523e4567-e89b-42d3-a456-426614174000';
    RAISE EXCEPTION 'artifact delete unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END;
$immutable$;

SELECT 'creative artifact Postgres integration passed' AS result;
