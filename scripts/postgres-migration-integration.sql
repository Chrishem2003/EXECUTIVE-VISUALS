-- Runtime integration checks against a real PostgreSQL instance.
-- The companion shell script applies the complete isolated migration chain first.
\set ON_ERROR_STOP on

insert into auth.users(id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222')
on conflict do nothing;

insert into executive_visuals.projects(id,owner_id,name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','Integration project A'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','Integration project B'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','11111111-1111-4111-8111-111111111111','Integration project C')
on conflict do nothing;

insert into executive_visuals.assets(
  id,owner_id,project_id,original_name,media_type,byte_size,sha256,object_path,metadata
) values (
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'source.mp4','video/mp4',100,repeat('a',64),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/33333333-3333-4333-8333-333333333333/original.mp4',
  '{"role":"source"}'
),(
  '44444444-4444-4444-8444-444444444444',
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'derived.mp4','video/mp4',90,repeat('b',64),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/44444444-4444-4444-8444-444444444444/original.mp4',
  '{"role":"derivative"}'
)
on conflict do nothing;

update executive_visuals.assets
set derivative_of='33333333-3333-4333-8333-333333333333'
where id='44444444-4444-4444-8444-444444444444';

-- A valid checkpoint must bind the input checksum and the actual derivative asset.
insert into executive_visuals.video_pipeline_checkpoints(
  owner_id,project_id,pipeline_id,step_id,status,input_asset_id,input_sha256,
  idempotency_key,output_json
) values (
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'integration-pipeline','valid-output','succeeded',
  '33333333-3333-4333-8333-333333333333',repeat('a',64),repeat('1',64),
  '{"id":"44444444-4444-4444-8444-444444444444","derivativeOf":"33333333-3333-4333-8333-333333333333","mediaType":"video/mp4","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
);

DO $tests$
BEGIN
  BEGIN
    INSERT INTO executive_visuals.video_pipeline_checkpoints(
      owner_id,project_id,pipeline_id,step_id,status,input_asset_id,input_sha256,idempotency_key,output_json
    ) VALUES (
      '22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'integration-pipeline','cross-tenant','succeeded',
      '33333333-3333-4333-8333-333333333333',repeat('a',64),repeat('2',64),
      '{"id":"44444444-4444-4444-8444-444444444444","derivativeOf":"33333333-3333-4333-8333-333333333333","mediaType":"video/mp4","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
    );
    RAISE EXCEPTION 'cross-tenant checkpoint unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM = 'cross-tenant checkpoint unexpectedly succeeded' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO executive_visuals.video_pipeline_checkpoints(
      owner_id,project_id,pipeline_id,step_id,status,input_asset_id,input_sha256,idempotency_key,output_json
    ) VALUES (
      '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'integration-pipeline','wrong-source-hash','succeeded',
      '33333333-3333-4333-8333-333333333333',repeat('c',64),repeat('3',64),
      '{"id":"44444444-4444-4444-8444-444444444444","derivativeOf":"33333333-3333-4333-8333-333333333333","mediaType":"video/mp4","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
    );
    RAISE EXCEPTION 'checkpoint with mismatched source checksum unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM = 'checkpoint with mismatched source checksum unexpectedly succeeded' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE executive_visuals.assets
    SET project_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    WHERE id='33333333-3333-4333-8333-333333333333';
    RAISE EXCEPTION 'derivative source reassignment unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM = 'derivative source reassignment unexpectedly succeeded' THEN RAISE; END IF;
  END;
END;
$tests$;

-- Soft-deleted sources cannot acquire new checkpoints.
UPDATE executive_visuals.assets
SET deleted_at=clock_timestamp()
WHERE id='33333333-3333-4333-8333-333333333333';

DO $deleted_source$
BEGIN
  BEGIN
    INSERT INTO executive_visuals.video_pipeline_checkpoints(
      owner_id,project_id,pipeline_id,step_id,status,input_asset_id,input_sha256,idempotency_key,output_json
    ) VALUES (
      '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'integration-pipeline','deleted-source','succeeded',
      '33333333-3333-4333-8333-333333333333',repeat('a',64),repeat('4',64),
      '{"id":"44444444-4444-4444-8444-444444444444","derivativeOf":"33333333-3333-4333-8333-333333333333","mediaType":"video/mp4","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
    );
    RAISE EXCEPTION 'deleted source checkpoint unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM = 'deleted source checkpoint unexpectedly succeeded' THEN RAISE; END IF;
  END;
END;
$deleted_source$;

UPDATE executive_visuals.assets
SET deleted_at=NULL
WHERE id='33333333-3333-4333-8333-333333333333';

-- Atomic publication must validate the current lease and commit asset + ledger together.
INSERT INTO executive_visuals.jobs(
  id,owner_id,project_id,job_type,status,input,lease_owner,lease_token,
  lease_expires_at,lease_heartbeat_at
) VALUES (
  '55555555-5555-4555-8555-555555555555',
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'timeline.render','processing','{}'::jsonb,'integration-worker',
  '66666666-6666-4666-8666-666666666666',
  clock_timestamp()+interval '5 minutes',clock_timestamp()
);

SELECT * FROM executive_visuals.reserve_asset_publication_v2(
  '55555555-5555-4555-8555-555555555555',
  'integration-worker',
  '66666666-6666-4666-8666-666666666666',
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'integration:valid-publication',repeat('c',64),
  '77777777-7777-4777-8777-777777777777'
);

-- Stable idempotency keys must return the original reservation on retry.
DO $reservation_retry$
DECLARE
  retry_row record;
BEGIN
  SELECT * INTO retry_row
  FROM executive_visuals.reserve_asset_publication(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'integration:valid-publication',repeat('c',64),
    '77777777-7777-4777-8777-777777777777'
  );
  IF retry_row.asset_id <> '77777777-7777-4777-8777-777777777777'::uuid
     OR retry_row.status <> 'reserved' THEN
    RAISE EXCEPTION 'idempotent publication retry did not return original reservation';
  END IF;

  BEGIN
    PERFORM * FROM executive_visuals.reserve_asset_publication(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'integration:valid-publication',repeat('e',64),
      'aaaaaaaa-0000-4000-8000-000000000000'
    );
    RAISE EXCEPTION 'publication key payload mutation unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM = 'publication key payload mutation unexpectedly succeeded' THEN RAISE; END IF;
  END;
END;
$reservation_retry$;

SELECT id FROM executive_visuals.finalize_asset_publication_v1(
  '55555555-5555-4555-8555-555555555555',
  'integration-worker',
  '66666666-6666-4666-8666-666666666666',
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'integration:valid-publication',
  repeat('c',64),
  '77777777-7777-4777-8777-777777777777',
  'render.mp4','video/mp4',123,
  'executive-visuals-media',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/77777777-7777-4777-8777-777777777777/attempt-88888888-8888-4888-8888-888888888888.mp4',
  NULL,'{"integration":true}'::jsonb
);

DO $publication$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM executive_visuals.asset_publications
    WHERE owner_id='11111111-1111-4111-8111-111111111111'
      AND publication_key='integration:valid-publication'
      AND status='published'
  ) THEN RAISE EXCEPTION 'atomic publication ledger was not finalized'; END IF;

  IF has_function_privilege('anon',
    'executive_visuals.finalize_asset_publication_v1(uuid,text,uuid,uuid,uuid,text,text,uuid,text,text,bigint,text,text,uuid,jsonb)',
    'EXECUTE') THEN
    RAISE EXCEPTION 'anon unexpectedly has publication RPC access';
  END IF;
  IF has_function_privilege('authenticated',
    'executive_visuals.finalize_asset_publication_v1(uuid,text,uuid,uuid,uuid,text,text,uuid,text,text,bigint,text,text,uuid,jsonb)',
    'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated unexpectedly has publication RPC access';
  END IF;
  IF NOT has_function_privilege('service_role',
    'executive_visuals.finalize_asset_publication_v1(uuid,text,uuid,uuid,uuid,text,text,uuid,text,text,bigint,text,text,uuid,jsonb)',
    'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lacks publication RPC access';
  END IF;
END;
$publication$;

SELECT * FROM executive_visuals.reserve_asset_publication_v2(
  '55555555-5555-4555-8555-555555555555',
  'integration-worker',
  '66666666-6666-4666-8666-666666666666',
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'integration:stale-lease',repeat('d',64),
  '99999999-9999-4999-8999-999999999999'
);

DO $stale_lease$
BEGIN
  BEGIN
    PERFORM * FROM executive_visuals.finalize_asset_publication_v1(
      '55555555-5555-4555-8555-555555555555',
      'integration-worker',
      'aaaaaaaa-0000-4000-8000-000000000000',
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'integration:stale-lease',
      repeat('d',64),
      '99999999-9999-4999-8999-999999999999',
      'stale.mp4','video/mp4',123,
      'executive-visuals-media',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/99999999-9999-4999-8999-999999999999/attempt-88888888-8888-4888-8888-888888888888.mp4',
      NULL,'{"integration":true}'::jsonb
    );
    RAISE EXCEPTION 'stale lease publication unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM = 'stale lease publication unexpectedly succeeded' THEN RAISE; END IF;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM executive_visuals.asset_publications
    WHERE owner_id='11111111-1111-4111-8111-111111111111'
      AND publication_key='integration:stale-lease'
      AND status='reserved'
  ) THEN RAISE EXCEPTION 'stale lease changed publication ledger'; END IF;

  IF EXISTS (SELECT 1 FROM executive_visuals.assets WHERE id='99999999-9999-4999-8999-999999999999') THEN
    RAISE EXCEPTION 'stale lease inserted asset metadata';
  END IF;
END;
$stale_lease$;


-- Durable cleanup claims must fence a late worker from publishing the exact
-- object path selected for deletion. All work remains inside disposable CI DB.
INSERT INTO executive_visuals.jobs(
  id,owner_id,project_id,job_type,status,input,lease_owner,lease_token,
  lease_expires_at,lease_heartbeat_at
) VALUES (
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'timeline.render','processing','{"integration":"cleanup-fence"}'::jsonb,
  'cleanup-worker','abababab-abab-4aba-8aba-abababababab',
  clock_timestamp()+interval '5 minutes',clock_timestamp()
);

SELECT * FROM executive_visuals.reserve_asset_publication_v2(
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'cleanup-worker',
  'abababab-abab-4aba-8aba-abababababab',
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'integration:cleanup-fence',repeat('f',64),
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
);

UPDATE executive_visuals.jobs
SET status='failed',lease_owner=NULL,lease_token=NULL,
    lease_expires_at=NULL,lease_heartbeat_at=NULL
WHERE id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';

UPDATE executive_visuals.asset_publications
SET updated_at=clock_timestamp()-interval '25 hours'
WHERE owner_id='11111111-1111-4111-8111-111111111111'
  AND publication_key='integration:cleanup-fence';

CREATE TEMP TABLE cleanup_claim_result AS
SELECT * FROM executive_visuals.claim_asset_publication_cleanup_v1(
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'integration:cleanup-fence',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/attempt-99999999-9999-4999-8999-999999999998.mp4',
  interval '24 hours'
);

DO $cleanup_fence$
DECLARE claim_row record;
BEGIN
  SELECT * INTO claim_row FROM cleanup_claim_result;
  IF claim_row.status <> 'claimed' OR claim_row.claim_token IS NULL THEN
    RAISE EXCEPTION 'cleanup claim did not produce a durable fencing token';
  END IF;
END;
$cleanup_fence$;

-- Simulate a worker being claimed after the cleanup tombstone exists.
UPDATE executive_visuals.jobs
SET status='processing',lease_owner='late-worker',
    lease_token='ffffffff-ffff-4fff-8fff-ffffffffffff',
    lease_expires_at=clock_timestamp()+interval '5 minutes'
WHERE id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';

DO $late_publication$
BEGIN
  BEGIN
    PERFORM * FROM executive_visuals.finalize_asset_publication_v1(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'late-worker',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'integration:cleanup-fence',
      repeat('f',64),
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      'late-render.mp4','video/mp4',123,
      'executive-visuals-media',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/attempt-99999999-9999-4999-8999-999999999998.mp4',
      NULL,'{"integration":"must-be-fenced"}'::jsonb
    );
    RAISE EXCEPTION 'late publication bypassed durable cleanup fence';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM = 'late publication bypassed durable cleanup fence' THEN RAISE; END IF;
  END;

  IF EXISTS (
    SELECT 1 FROM executive_visuals.assets
    WHERE id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  ) THEN
    RAISE EXCEPTION 'fenced publication inserted asset metadata';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM executive_visuals.asset_publications
    WHERE owner_id='11111111-1111-4111-8111-111111111111'
      AND publication_key='integration:cleanup-fence'
      AND status='reserved'
  ) THEN
    RAISE EXCEPTION 'fenced publication unexpectedly changed its ledger';
  END IF;
END;
$late_publication$;

DO $cleanup_complete$
DECLARE claim_row record;
BEGIN
  SELECT * INTO claim_row FROM cleanup_claim_result;
  IF NOT executive_visuals.complete_asset_publication_cleanup_v1(
    claim_row.claim_id,claim_row.claim_token
  ) THEN
    RAISE EXCEPTION 'cleanup claim could not be completed';
  END IF;
  IF NOT executive_visuals.complete_asset_publication_cleanup_v1(
    claim_row.claim_id,claim_row.claim_token
  ) THEN
    RAISE EXCEPTION 'cleanup completion retry was not idempotent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM executive_visuals.asset_publication_cleanup_claims
    WHERE id=claim_row.claim_id AND status='deleted' AND deleted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'completed cleanup tombstone was not retained';
  END IF;
END;
$cleanup_complete$;


-- If a stale in-flight uploader recreates an already-cleaned attempt path,
-- a later storage listing may re-claim that same tombstone with a fresh token.
UPDATE executive_visuals.jobs
SET status='failed',lease_owner=NULL,lease_token=NULL,
    lease_expires_at=NULL,lease_heartbeat_at=NULL
WHERE id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';

CREATE TEMP TABLE cleanup_reclaim_result AS
SELECT * FROM executive_visuals.claim_asset_publication_cleanup_v1(
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'integration:cleanup-fence',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/attempt-99999999-9999-4999-8999-999999999998.mp4',
  interval '24 hours'
);

DO $cleanup_reclaim$
DECLARE old_claim record; new_claim record;
BEGIN
  SELECT * INTO old_claim FROM cleanup_claim_result;
  SELECT * INTO new_claim FROM cleanup_reclaim_result;
  IF new_claim.status <> 'claimed'
     OR new_claim.claim_token = old_claim.claim_token THEN
    RAISE EXCEPTION 'reappeared orphan path did not receive a fresh cleanup claim token';
  END IF;
  IF NOT executive_visuals.complete_asset_publication_cleanup_v1(
    new_claim.claim_id,new_claim.claim_token
  ) THEN
    RAISE EXCEPTION 'reclaimed orphan path could not be completed';
  END IF;
END;
$cleanup_reclaim$;

SELECT 'PostgreSQL migration integration checks passed' AS result;
