import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../../supabase/migrations/20261117093508_add_cloud_asset_storage_quotas.sql", import.meta.url), "utf8");

test("storage quota config starts below the Supabase free storage allowance", () => {
  assert.match(migration, /values\s*\(true\s*,\s*786432000\s*,\s*536870912\)/i);
  assert.match(migration, /asset_storage_limits/i);
});

test("quota trigger serializes concurrent writes and checks total plus owner limits", () => {
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended/i);
  assert.match(migration, /CLOUD_ASSET_STORAGE_QUOTA_EXCEEDED/);
  assert.match(migration, /CLOUD_ASSET_OWNER_QUOTA_EXCEEDED/);
  assert.match(migration, /before insert or update of byte_size, owner_id, deleted_at/i);
  assert.match(migration, /a\.deleted_at is null/i);
});

test("private usage RPC is service-role-only and exposes both global and owner counters", () => {
  assert.match(migration, /create or replace function executive_visuals\.get_asset_storage_usage/i);
  assert.match(migration, /global_asset_count/i);
  assert.match(migration, /owner_asset_count/i);
  assert.match(migration, /remaining_total_bytes/i);
  assert.match(migration, /remaining_owner_bytes/i);
  assert.match(migration, /revoke all on function executive_visuals\.get_asset_storage_usage\(uuid\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function executive_visuals\.get_asset_storage_usage\(uuid\) to service_role/i);
});
