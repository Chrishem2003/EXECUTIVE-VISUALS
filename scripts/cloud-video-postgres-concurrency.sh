#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
sql="set role service_role; select job_id from executive_visuals.enqueue_video_generation_job(
  '123e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000',
  'pg-concurrent-video-001','runway','gen4.5',repeat('b',64),
  jsonb_build_object('projectId','323e4567-e89b-42d3-a456-426614174000',
    'provider','runway','model','gen4.5','requestHash',repeat('b',64),'prompt','concurrent test','durationSeconds',2),
  '823e4567-e89b-42d3-a456-426614174000',0.5,'USD'
);"
psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "$sql" > "$tmp_dir/first" &
first_pid=$!
psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "$sql" > "$tmp_dir/second" &
second_pid=$!
wait "$first_pid"
wait "$second_pid"
first_id="$(tail -n 1 "$tmp_dir/first" | tr -d '[:space:]')"
second_id="$(tail -n 1 "$tmp_dir/second" | tr -d '[:space:]')"
if [[ -z "$first_id" || "$first_id" != "$second_id" ]]; then
  echo "Concurrent idempotent enqueue returned different job IDs." >&2
  cat "$tmp_dir/first" "$tmp_dir/second" >&2
  exit 1
fi
count="$(psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "select count(*) from executive_visuals.jobs where idempotency_key='pg-concurrent-video-001';")"
reservations="$(psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "select count(*) from executive_visuals.video_generation_budget_reservations where job_id='$first_id';")"
usage="$(psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "select count(*) from executive_visuals.video_generation_usage_reservations where job_id='$first_id';")"
if [[ "$count" != "1" || "$reservations" != "1" || "$usage" != "1" ]]; then
  echo "Concurrent enqueue duplicated job, budget reservation, or usage reservation." >&2
  exit 1
fi
echo "Concurrent cloud video enqueue passed: both requests returned $first_id and created one job/reservation."
