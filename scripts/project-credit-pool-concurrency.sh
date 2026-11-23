#!/usr/bin/env bash
# Prove two simultaneous project-wallet reservations cannot spend the same credits.
# Runs after project-shared-credit-pool-postgres-integration.sql in disposable CI PostgreSQL.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

owner="123e4567-e89b-42d3-a456-426614174000"
project="323e4567-e89b-42d3-a456-426614174000"
job_a="e23e4567-e89b-42d3-a456-426614174105"
job_b="e23e4567-e89b-42d3-a456-426614174106"
key_a="pool-concurrency-job-key-0005"
key_b="pool-concurrency-job-key-0006"

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<SQL
select * from executive_visuals.configure_project_credit_pool('$owner','$project',2000);
insert into executive_visuals.jobs(id,owner_id,project_id,job_type,status,input,idempotency_key)
values
 ('$job_a','$owner','$project','video.generate','queued','{"provider":"runway","model":"gen4.5"}'::jsonb,'pool-concurrency-job-05'),
 ('$job_b','$owner','$project','video.generate','queued','{"provider":"runway","model":"gen4.5"}'::jsonb,'pool-concurrency-job-06');
SQL

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

reserve() {
  local job="$1"
  local key="$2"
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc \
    "select reservation_id from executive_visuals.reserve_generation_credits('$owner','$job',500,'$key');"
}

set +e
reserve "$job_a" "$key_a" >"$tmp/a.out" 2>&1 &
pid_a=$!
reserve "$job_b" "$key_b" >"$tmp/b.out" 2>&1 &
pid_b=$!
wait "$pid_a"
status_a=$?
wait "$pid_b"
status_b=$?
set -e

successes=$(( (status_a == 0) + (status_b == 0) ))
if [[ "$successes" -ne 1 ]]; then
  echo "Expected exactly one concurrent 500-credit reservation to succeed; statuses: $status_a, $status_b" >&2
  cat "$tmp/a.out" "$tmp/b.out" >&2
  exit 1
fi

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<SQL
do \$credit_concurrency_assertion\$
declare pool_balance bigint; reservation_count integer; reserved_total bigint;
begin
 select coalesce(sum(amount),0) into pool_balance
 from executive_visuals.project_credit_pool_ledger where project_id='$project';
 select count(*),coalesce(sum(reserved_credits),0)
 into reservation_count,reserved_total
 from executive_visuals.project_credit_pool_reservations
 where job_id in ('$job_a','$job_b') and state='reserved';
 if pool_balance<>420 or reservation_count<>1 or reserved_total<>500 then
  raise exception 'Concurrent project wallet reservations overspent or double-reserved credits: balance %, reservations %, reserved %',
    pool_balance,reservation_count,reserved_total;
 end if;
end
\$credit_concurrency_assertion\$;
SQL


psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<SQL
-- Release the winning fixture reservation after the race assertion so this test
-- leaves the shared disposable database exactly as it found the monthly spend
-- budget for the following member-policy integration.
select * from executive_visuals.release_generation_credit_reservation(
 (select reservation_id from executive_visuals.project_credit_pool_reservations
  where job_id in ('$job_a','$job_b') and state='reserved'),
 'Concurrency acceptance fixture cleanup'
);
do \$credit_concurrency_cleanup\$
declare pool_balance bigint; active_count integer;
begin
 select coalesce(sum(amount),0) into pool_balance
  from executive_visuals.project_credit_pool_ledger where project_id='$project';
 select count(*) into active_count from executive_visuals.project_credit_pool_reservations
  where job_id in ('$job_a','$job_b') and state='reserved';
 if pool_balance<>920 or active_count<>0 then
  raise exception 'Concurrency fixture cleanup did not restore the project wallet: balance %, active reservations %',pool_balance,active_count;
 end if;
end
\$credit_concurrency_cleanup\$;
SQL

echo "Concurrent project-wallet reservation race passed: one 500-credit reservation accepted, one rejected; fixture reservation released and 920 credits restored."
