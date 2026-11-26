#!/usr/bin/env bash
set -euo pipefail

: "${POSTGRES_SERVICE_CONTAINER_ID:?PostgreSQL service container ID is required}"
source_db="executive_visuals_billing_test"
restore_db="executive_visuals_billing_restore"
tmp="$(mktemp -d)"
cleanup() {
  docker exec "$POSTGRES_SERVICE_CONTAINER_ID" dropdb -U postgres --if-exists "$restore_db" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

# Create a custom-format dump from the fully migrated disposable Supabase-compatible CI database.
docker exec "$POSTGRES_SERVICE_CONTAINER_ID" pg_dump -U postgres -d "$source_db" --format=custom --no-owner --no-acl >"$tmp/backup.dump"
test -s "$tmp/backup.dump"
sha256sum "$tmp/backup.dump" >"$tmp/backup.dump.sha256"

docker exec "$POSTGRES_SERVICE_CONTAINER_ID" createdb -U postgres "$restore_db"
docker exec -i "$POSTGRES_SERVICE_CONTAINER_ID" pg_restore -U postgres -d "$restore_db" --no-owner --no-acl --exit-on-error <"$tmp/backup.dump"

table_counts() {
  local database="$1"
  local table escaped count
  while IFS= read -r table; do
    [[ -z "$table" ]] && continue
    escaped="${table//\"/\"\"}"
    count="$(docker exec "$POSTGRES_SERVICE_CONTAINER_ID" psql -U postgres -d "$database" -X -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM executive_visuals.\"$escaped\"")"
    printf '%s:%s\n' "$table" "$count"
  done < <(docker exec "$POSTGRES_SERVICE_CONTAINER_ID" psql -U postgres -d "$database" -X -At -v ON_ERROR_STOP=1 -c "SELECT tablename FROM pg_tables WHERE schemaname='executive_visuals' ORDER BY tablename")
}

source_counts="$(table_counts "$source_db")"
restored_counts="$(table_counts "$restore_db")"
if [[ "$source_counts" != "$restored_counts" ]]; then
  echo "Database restore row-count comparison failed." >&2
  diff -u <(printf '%s\n' "$source_counts") <(printf '%s\n' "$restored_counts") >&2 || true
  exit 1
fi

metadata_signature() {
  docker exec "$POSTGRES_SERVICE_CONTAINER_ID" psql -U postgres -d "$1" -X -At -v ON_ERROR_STOP=1 -c "
    SELECT
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='executive_visuals' AND c.relkind IN ('r','p','v','m')) || ':' ||
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='executive_visuals') || ':' ||
      (SELECT count(*) FROM pg_policies WHERE schemaname='executive_visuals') || ':' ||
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='executive_visuals' AND c.relrowsecurity) || ':' ||
      (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='executive_visuals' AND NOT t.tgisinternal)
  "
}

source_metadata="$(metadata_signature "$source_db")"
restored_metadata="$(metadata_signature "$restore_db")"
if [[ "$source_metadata" != "$restored_metadata" ]]; then
  echo "Database restore schema/security metadata comparison failed." >&2
  echo "Source metadata:   $source_metadata" >&2
  echo "Restored metadata: $restored_metadata" >&2
  exit 1
fi

table_count="$(printf '%s\n' "$source_counts" | sed '/^$/d' | wc -l | tr -d ' ')"
echo "Disposable database backup/restore passed."
echo "Tables compared: $table_count"
echo "Schema/security signature: $source_metadata"
echo "Backup SHA-256: $(cut -d ' ' -f1 "$tmp/backup.dump")"
