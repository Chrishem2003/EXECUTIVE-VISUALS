#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must point to the isolated disposable PostgreSQL database}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

JOB_ID="88888888-8888-4888-8888-888888888888"
OWNER_ID="11111111-1111-4111-8111-111111111111"
PROJECT_ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<SQL
INSERT INTO executive_visuals.jobs(
  id, owner_id, project_id, job_type, status, input, available_at
) VALUES (
  '$JOB_ID', '$OWNER_ID', '$PROJECT_ID', 'timeline.render', 'queued',
  '{"integration":"concurrent-claim"}'::jsonb, clock_timestamp() - interval '1 second'
);
SQL

claim_worker() {
  local worker="$1"
  local output="$2"
  psql "$DATABASE_URL" -X -A -t -F '|' -v ON_ERROR_STOP=1 \
    -c "SELECT id::text, lease_token::text, lease_owner FROM executive_visuals.claim_next_job_v2('$worker', 30, ARRAY['timeline.render'])" \
    > "$output"
}

# Separate psql processes create separate database sessions. SKIP LOCKED must
# let only one worker claim this single queued job.
claim_worker "integration-worker-a" "$TMP_DIR/worker-a" &
PID_A=$!
claim_worker "integration-worker-b" "$TMP_DIR/worker-b" &
PID_B=$!
wait "$PID_A"
wait "$PID_B"

cat "$TMP_DIR/worker-a" "$TMP_DIR/worker-b" | awk 'NF { print }' > "$TMP_DIR/claims"
CLAIM_COUNT="$(wc -l < "$TMP_DIR/claims" | tr -d ' ')"
if [[ "$CLAIM_COUNT" != "1" ]]; then
  echo "Expected exactly one concurrent claim; observed $CLAIM_COUNT" >&2
  cat "$TMP_DIR/worker-a" "$TMP_DIR/worker-b" >&2
  exit 1
fi

IFS='|' read -r CLAIMED_JOB_ID OLD_TOKEN OLD_WORKER < "$TMP_DIR/claims"
if [[ "$CLAIMED_JOB_ID" != "$JOB_ID" || -z "$OLD_TOKEN" || -z "$OLD_WORKER" ]]; then
  echo "Concurrent claim returned an invalid job or fencing token" >&2
  exit 1
fi

# Expire the winning lease, recover it, and prove the old execution epoch
# cannot finish the job. The recovery backoff is one second for attempt one.
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<SQL
UPDATE executive_visuals.jobs
SET lease_expires_at = clock_timestamp() - interval '1 second'
WHERE id = '$JOB_ID' AND status = 'processing' AND lease_token = '$OLD_TOKEN';

DO \$recovery\$
DECLARE recovered integer;
BEGIN
  recovered := executive_visuals.recover_expired_jobs(10);
  IF recovered <> 1 THEN
    RAISE EXCEPTION 'expected one expired job to recover, got %', recovered;
  END IF;
  IF EXISTS (
    SELECT 1 FROM executive_visuals.jobs
    WHERE id = '$JOB_ID' AND (
      status <> 'queued' OR lease_token IS NOT NULL OR lease_owner IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'recovery did not clear the previous lease epoch';
  END IF;
  IF executive_visuals.assert_job_lease_v2(
    '$JOB_ID', '$OLD_WORKER', '$OLD_TOKEN'
  ) THEN
    RAISE EXCEPTION 'expired worker fencing token remained valid after recovery';
  END IF;
  IF executive_visuals.finish_job_v2(
    '$JOB_ID', '$OLD_WORKER', '$OLD_TOKEN', 'succeeded',
    '{"stale":true}'::jsonb, NULL
  ) THEN
    RAISE EXCEPTION 'stale worker unexpectedly completed recovered job';
  END IF;
END;
\$recovery\$;
SQL

sleep 2
psql "$DATABASE_URL" -X -A -t -F '|' -v ON_ERROR_STOP=1 \
  -c "SELECT id::text, lease_token::text FROM executive_visuals.claim_next_job_v2('integration-worker-retry', 30, ARRAY['timeline.render'])" \
  > "$TMP_DIR/retry"

IFS='|' read -r RETRIED_JOB_ID NEW_TOKEN < "$TMP_DIR/retry"
if [[ "$RETRIED_JOB_ID" != "$JOB_ID" || -z "$NEW_TOKEN" || "$NEW_TOKEN" == "$OLD_TOKEN" ]]; then
  echo "Retry did not receive a fresh fencing token" >&2
  exit 1
fi

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<SQL
DO \$fencing\$
BEGIN
  IF executive_visuals.assert_job_lease_v2(
    '$JOB_ID', '$OLD_WORKER', '$OLD_TOKEN'
  ) THEN
    RAISE EXCEPTION 'previous worker token became valid again after retry';
  END IF;
  IF NOT executive_visuals.assert_job_lease_v2(
    '$JOB_ID', 'integration-worker-retry', '$NEW_TOKEN'
  ) THEN
    RAISE EXCEPTION 'new retry worker token is not valid';
  END IF;
END;
\$fencing\$;
SQL

# Publication and cleanup must serialize on the same job -> publication locks.
# Independent psql processes hold the first transaction open after its RPC
# returns, forcing the competing RPC to wait on the same job row.
wait_for_marker() {
  local marker="$1"
  for _ in $(seq 1 100); do
    [[ -f "$marker" ]] && return 0
    sleep 0.05
  done
  echo "Timed out waiting for transaction marker: $marker" >&2
  exit 1
}

expect_sql_failure() {
  local label="$1"
  local sql_file="$2"
  local output="$TMP_DIR/$label.log"
  if psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$sql_file" >"$output" 2>&1; then
    echo "Expected $label to be rejected, but it succeeded" >&2
    cat "$output" >&2
    exit 1
  fi
  if ! grep -q "ERROR:" "$output"; then
    echo "$label failed without a PostgreSQL error diagnostic" >&2
    cat "$output" >&2
    exit 1
  fi
}

# Case A: finalization locks first; cleanup must wait and then reject.
RACE_A_JOB="88888888-8888-4888-8888-888888888881"
RACE_A_ASSET="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1"
RACE_A_TOKEN="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa81"
RACE_A_ATTEMPT="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb881"
RACE_A_PATH="$PROJECT_ID/$RACE_A_ASSET/attempt-$RACE_A_ATTEMPT.mp4"
RACE_A_KEY="integration:race-finalize-wins"

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<SQL
INSERT INTO executive_visuals.jobs(
  id,owner_id,project_id,job_type,status,input,lease_owner,lease_token,
  lease_expires_at,lease_heartbeat_at
) VALUES (
  '$RACE_A_JOB','$OWNER_ID','$PROJECT_ID','timeline.render','processing',
  '{"integration":"race-finalize-wins"}'::jsonb,'race-finalizer-a',
  '$RACE_A_TOKEN',clock_timestamp()+interval '5 minutes',clock_timestamp()
);
SELECT * FROM executive_visuals.reserve_asset_publication_v2(
  '$RACE_A_JOB','race-finalizer-a','$RACE_A_TOKEN','$OWNER_ID','$PROJECT_ID',
  '$RACE_A_KEY',repeat('a',64),'$RACE_A_ASSET'
);
UPDATE executive_visuals.asset_publications
SET updated_at=clock_timestamp()-interval '25 hours'
WHERE owner_id='$OWNER_ID' AND publication_key='$RACE_A_KEY';
SQL

cat >"$TMP_DIR/finalizer-wins.sql" <<SQL
BEGIN;
SELECT id FROM executive_visuals.finalize_asset_publication_v1(
  '$RACE_A_JOB','race-finalizer-a','$RACE_A_TOKEN','$OWNER_ID','$PROJECT_ID',
  '$RACE_A_KEY',repeat('a',64),'$RACE_A_ASSET','race-a.mp4','video/mp4',123,
  'executive-visuals-media','$RACE_A_PATH',NULL,'{"race":"finalizer-wins"}'::jsonb
);
\! touch "$TMP_DIR/finalizer-wins-held"
SELECT pg_sleep(2);
COMMIT;
SQL

cat >"$TMP_DIR/cleanup-after-finalize.sql" <<SQL
SELECT * FROM executive_visuals.claim_asset_publication_cleanup_v1(
  '$RACE_A_JOB','$OWNER_ID','$PROJECT_ID','$RACE_A_KEY','$RACE_A_PATH',interval '24 hours'
);
SQL

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TMP_DIR/finalizer-wins.sql" >"$TMP_DIR/finalizer-wins.log" 2>&1 &
FINALIZER_PID=$!
wait_for_marker "$TMP_DIR/finalizer-wins-held"
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TMP_DIR/cleanup-after-finalize.sql" >"$TMP_DIR/cleanup-after-finalize.log" 2>&1 &
CLEANUP_PID=$!
wait "$FINALIZER_PID"
set +e
wait "$CLEANUP_PID"
CLEANUP_STATUS=$?
set -e
if [[ "$CLEANUP_STATUS" == "0" ]]; then
  echo "Cleanup unexpectedly claimed an object after publication won the race" >&2
  cat "$TMP_DIR/cleanup-after-finalize.log" >&2
  exit 1
fi
if ! grep -q "publication cleanup is blocked by a missing, mismatched, or active job" "$TMP_DIR/cleanup-after-finalize.log"; then
  echo "Cleanup did not wait for publication and reject the still-active job" >&2
  cat "$TMP_DIR/cleanup-after-finalize.log" >&2
  exit 1
fi

# A terminal job still cannot make an already-published ledger row cleanable.
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<SQL
UPDATE executive_visuals.jobs
SET status='failed',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL
WHERE id='$RACE_A_JOB';
DO \$assert_no_claim_after_publish\$
BEGIN
  BEGIN
    PERFORM * FROM executive_visuals.claim_asset_publication_cleanup_v1(
      '$RACE_A_JOB','$OWNER_ID','$PROJECT_ID','$RACE_A_KEY','$RACE_A_PATH',interval '24 hours'
    );
    RAISE EXCEPTION 'published object unexpectedly received a cleanup claim';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM = 'published object unexpectedly received a cleanup claim' THEN RAISE; END IF;
  END;
  IF EXISTS (
    SELECT 1 FROM executive_visuals.asset_publication_cleanup_claims
    WHERE object_path='$RACE_A_PATH'
  ) THEN RAISE EXCEPTION 'published object has a cleanup tombstone'; END IF;
END;
\$assert_no_claim_after_publish\$;
SQL

# Case B: cleanup locks first; a concurrent finalizer waits and is rejected.
# Even a later recovered worker with a fresh lease must remain tombstone-fenced.
RACE_B_JOB="99999999-9999-4999-8999-999999999881"
RACE_B_ASSET="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2"
RACE_B_TOKEN="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa82"
RACE_B_NEW_TOKEN="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa83"
RACE_B_ATTEMPT="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb882"
RACE_B_PATH="$PROJECT_ID/$RACE_B_ASSET/attempt-$RACE_B_ATTEMPT.mp4"
RACE_B_KEY="integration:race-cleanup-wins"

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<SQL
INSERT INTO executive_visuals.jobs(
  id,owner_id,project_id,job_type,status,input,lease_owner,lease_token,
  lease_expires_at,lease_heartbeat_at
) VALUES (
  '$RACE_B_JOB','$OWNER_ID','$PROJECT_ID','timeline.render','processing',
  '{"integration":"race-cleanup-wins"}'::jsonb,'race-cleanup-b',
  '$RACE_B_TOKEN',clock_timestamp()+interval '5 minutes',clock_timestamp()
);
SELECT * FROM executive_visuals.reserve_asset_publication_v2(
  '$RACE_B_JOB','race-cleanup-b','$RACE_B_TOKEN','$OWNER_ID','$PROJECT_ID',
  '$RACE_B_KEY',repeat('b',64),'$RACE_B_ASSET'
);
UPDATE executive_visuals.jobs
SET status='failed',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL
WHERE id='$RACE_B_JOB';
UPDATE executive_visuals.asset_publications
SET updated_at=clock_timestamp()-interval '25 hours'
WHERE owner_id='$OWNER_ID' AND publication_key='$RACE_B_KEY';
SQL

cat >"$TMP_DIR/cleanup-wins.sql" <<SQL
BEGIN;
SELECT * FROM executive_visuals.claim_asset_publication_cleanup_v1(
  '$RACE_B_JOB','$OWNER_ID','$PROJECT_ID','$RACE_B_KEY','$RACE_B_PATH',interval '24 hours'
);
\! touch "$TMP_DIR/cleanup-wins-held"
SELECT pg_sleep(2);
COMMIT;
SQL

cat >"$TMP_DIR/finalizer-after-cleanup.sql" <<SQL
SELECT id FROM executive_visuals.finalize_asset_publication_v1(
  '$RACE_B_JOB','race-cleanup-b','$RACE_B_TOKEN','$OWNER_ID','$PROJECT_ID',
  '$RACE_B_KEY',repeat('b',64),'$RACE_B_ASSET','race-b.mp4','video/mp4',123,
  'executive-visuals-media','$RACE_B_PATH',NULL,'{"race":"cleanup-wins"}'::jsonb
);
SQL

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TMP_DIR/cleanup-wins.sql" >"$TMP_DIR/cleanup-wins.log" 2>&1 &
CLEANUP_WIN_PID=$!
wait_for_marker "$TMP_DIR/cleanup-wins-held"
expect_sql_failure "finalizer-after-cleanup" "$TMP_DIR/finalizer-after-cleanup.sql"
wait "$CLEANUP_WIN_PID"

# Model a recovered worker with a fresh lease; the tombstone must still win.
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<SQL
UPDATE executive_visuals.jobs
SET status='processing',lease_owner='race-cleanup-retry',
    lease_token='$RACE_B_NEW_TOKEN',
    lease_expires_at=clock_timestamp()+interval '5 minutes',
    lease_heartbeat_at=clock_timestamp()
WHERE id='$RACE_B_JOB';
SQL

cat >"$TMP_DIR/finalizer-after-reclaim.sql" <<SQL
SELECT id FROM executive_visuals.finalize_asset_publication_v1(
  '$RACE_B_JOB','race-cleanup-retry','$RACE_B_NEW_TOKEN','$OWNER_ID','$PROJECT_ID',
  '$RACE_B_KEY',repeat('b',64),'$RACE_B_ASSET','race-b.mp4','video/mp4',123,
  'executive-visuals-media','$RACE_B_PATH',NULL,'{"race":"must-remain-fenced"}'::jsonb
);
SQL
expect_sql_failure "finalizer-after-reclaim" "$TMP_DIR/finalizer-after-reclaim.sql"

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<SQL
DO \$assert_cleanup_wins\$
BEGIN
  IF EXISTS (SELECT 1 FROM executive_visuals.assets WHERE id='$RACE_B_ASSET') THEN
    RAISE EXCEPTION 'cleanup-winner race inserted asset metadata';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM executive_visuals.asset_publications
    WHERE owner_id='$OWNER_ID' AND publication_key='$RACE_B_KEY' AND status='reserved'
  ) THEN
    RAISE EXCEPTION 'cleanup-winner race unexpectedly finalized publication ledger';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM executive_visuals.asset_publication_cleanup_claims
    WHERE object_path='$RACE_B_PATH' AND status='claimed'
  ) THEN
    RAISE EXCEPTION 'cleanup-winner race did not retain its durable tombstone';
  END IF;
END;
\$assert_cleanup_wins\$;
SQL

echo "PostgreSQL concurrency, lease-recovery, and publication/cleanup race checks passed"
