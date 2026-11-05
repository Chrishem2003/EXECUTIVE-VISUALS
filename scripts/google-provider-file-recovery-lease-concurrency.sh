#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
attempt_key="$(printf 'c%.0s' {1..64})"
asset_id="33333333-3333-4333-8333-333333333333"
owner_id="11111111-1111-4111-8111-111111111111"
project_id="22222222-2222-4222-8222-222222222222"
display_name="executive-visuals-$(printf 'c%.0s' {1..32})"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q <<SQL
insert into executive_visuals.google_provider_file_upload_attempts (
  attempt_key, asset_id, owner_id, project_id, mime_type, byte_size, sha256,
  google_display_name, state, lease_token, lease_expires_at
) values (
  '$attempt_key', '$asset_id', '$owner_id', '$project_id', 'image/png', 24,
  repeat('a', 64), '$display_name', 'OUTCOME_UNKNOWN', null, null
)
on conflict (attempt_key) do update
set state = 'OUTCOME_UNKNOWN', lease_token = null, lease_expires_at = null;
SQL

claim_sql="update executive_visuals.google_provider_file_upload_attempts
set lease_token = gen_random_uuid(),
    lease_expires_at = clock_timestamp() + interval '15 minutes',
    updated_at = clock_timestamp()
where attempt_key = '$attempt_key'
  and state = 'OUTCOME_UNKNOWN'
  and (lease_token is null or lease_expires_at < clock_timestamp())
returning lease_token;"

psql "$DATABASE_URL" -X -Atq -v ON_ERROR_STOP=1 -c "$claim_sql" > "$tmp_dir/claim-a" &
pid_a=$!
psql "$DATABASE_URL" -X -Atq -v ON_ERROR_STOP=1 -c "$claim_sql" > "$tmp_dir/claim-b" &
pid_b=$!
wait "$pid_a"
wait "$pid_b"

winner_count=0
for result in "$tmp_dir/claim-a" "$tmp_dir/claim-b"; do
  if [[ -s "$result" ]]; then
    winner_count=$((winner_count + 1))
  fi
done

if [[ "$winner_count" -ne 1 ]]; then
  echo "Expected exactly one concurrent Gemini recovery lease winner; got $winner_count." >&2
  exit 1
fi

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q <<SQL
do \$verify_gemini_recovery_lease\$
begin
  if not exists (
    select 1 from executive_visuals.google_provider_file_upload_attempts
     where attempt_key = '$attempt_key'
       and lease_token is not null
       and lease_expires_at > clock_timestamp()
  ) then
    raise exception 'Concurrent Gemini recovery claim did not persist a live lease';
  end if;
end
\$verify_gemini_recovery_lease\$;
SQL

echo "Gemini recovery lease concurrency passed: exactly one worker acquired the lease."
