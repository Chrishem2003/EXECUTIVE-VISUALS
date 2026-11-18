#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
pids=()
for i in $(seq 1 10); do
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q -t -A \
    -c "SET ROLE service_role" \
    -c "SELECT revision FROM executive_visuals.append_creative_project_artifact(gen_random_uuid(),'423e4567-e89b-42d3-a456-426614174001','123e4567-e89b-42d3-a456-426614174000','creative_direction',repeat('c',64),repeat('d',64),'{\"brief\":\"concurrent\"}'::jsonb,'{\"plan\":\"ci\"}'::jsonb,'ci-concurrency','{}'::jsonb)" \
    >"$tmp/$i" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
actual="$(cat "$tmp"/* | awk '/^[0-9]+$/ { print }' | sort -n | paste -sd, -)"
expected="$(seq 1 10 | paste -sd, -)"
if [[ "$actual" != "$expected" ]]; then
  echo "Concurrent append revisions were not unique and contiguous: expected $expected, received $actual" >&2
  exit 1
fi
echo "Concurrent append allocation passed: $actual"
