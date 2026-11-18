#!/usr/bin/env bash
set -euo pipefail
: "${POSTGRES_SERVICE_CONTAINER_ID:?PostgreSQL service container ID is required}"
source_db="executive_visuals_test"
restore_db="executive_visuals_restore"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

docker exec "$POSTGRES_SERVICE_CONTAINER_ID" pg_dump -U postgres -d "$source_db" -Fc --no-owner --no-acl >"$tmp/creative-artifacts.dump"
test -s "$tmp/creative-artifacts.dump"

docker exec "$POSTGRES_SERVICE_CONTAINER_ID" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $restore_db"
docker exec "$POSTGRES_SERVICE_CONTAINER_ID" createdb -U postgres "$restore_db"
docker exec -i "$POSTGRES_SERVICE_CONTAINER_ID" pg_restore -U postgres -d "$restore_db" --no-owner --no-acl <"$tmp/creative-artifacts.dump"

source_signature="$(docker exec "$POSTGRES_SERVICE_CONTAINER_ID" psql -U postgres -d "$source_db" -X -At -v ON_ERROR_STOP=1 -c "SELECT count(*)::text || ':' || coalesce(string_agg(id::text || ':' || artifact_type || ':' || revision::text || ':' || content_hash, ',' ORDER BY id),'') FROM executive_visuals.creative_project_artifacts")"
restored_signature="$(docker exec "$POSTGRES_SERVICE_CONTAINER_ID" psql -U postgres -d "$restore_db" -X -At -v ON_ERROR_STOP=1 -c "SELECT count(*)::text || ':' || coalesce(string_agg(id::text || ':' || artifact_type || ':' || revision::text || ':' || content_hash, ',' ORDER BY id),'') FROM executive_visuals.creative_project_artifacts")"
if [[ "$source_signature" != "$restored_signature" ]]; then
  echo "Creative artifact backup/restore mismatch." >&2
  echo "Source:   $source_signature" >&2
  echo "Restored: $restored_signature" >&2
  exit 1
fi

rls="$(docker exec "$POSTGRES_SERVICE_CONTAINER_ID" psql -U postgres -d "$restore_db" -X -At -v ON_ERROR_STOP=1 -c "SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='executive_visuals' AND c.relname='creative_project_artifacts'")"
trigger_count="$(docker exec "$POSTGRES_SERVICE_CONTAINER_ID" psql -U postgres -d "$restore_db" -X -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='executive_visuals' AND c.relname='creative_project_artifacts' AND NOT t.tgisinternal")"
function_count="$(docker exec "$POSTGRES_SERVICE_CONTAINER_ID" psql -U postgres -d "$restore_db" -X -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='executive_visuals' AND p.proname='append_creative_project_artifact'")"
if [[ "$rls" != "t" || "$trigger_count" -lt "1" || "$function_count" != "1" ]]; then
  echo "Restored database is missing creative artifact RLS, immutability trigger or append RPC." >&2
  exit 1
fi

echo "Creative artifact backup/restore passed: $source_signature"
