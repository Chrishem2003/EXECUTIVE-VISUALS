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
    '$JOB_ID', 'integration-worker-a', '$OLD_TOKEN'
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

echo "PostgreSQL concurrency and lease-recovery checks passed"
