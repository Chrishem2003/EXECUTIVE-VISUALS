import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../../supabase/migrations/20261108010000_atomic_asset_publication_lease_fencing.sql", import.meta.url);
const leaseMigrationUrl = new URL("../../supabase/migrations/20261108000000_job_lease_fencing_tokens.sql", import.meta.url);
const cleanupMigrationUrl = new URL("../../supabase/migrations/20261108020000_asset_publication_cleanup_claims.sql", import.meta.url);

test("atomic publication migration serializes against the active job lease", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create or replace function executive_visuals\.finalize_asset_publication_v1\s*\(/i);
  assert.match(sql, /set search_path\s*=\s*''/i);
  assert.match(sql, /from executive_visuals\.jobs[\s\S]*?for update/i);
  assert.match(sql, /job_row\.lease_owner is distinct from p_worker_id/i);
  assert.match(sql, /job_row\.lease_token is distinct from p_lease_token/i);
  assert.match(sql, /job_row\.lease_expires_at <= pg_catalog\.clock_timestamp\(\)/i);
  assert.match(sql, /job_row.owner_id is distinct from p_owner_id/i);
  assert.match(sql, /job_row.project_id is distinct from p_project_id/i);
  assert.match(sql, /expected_extension := case p_media_type/i);
  assert.ok(sql.includes("attempt-[0-9a-f]{8}-") && sql.includes("|original)[.]"), "object path must be an exact UUID attempt or legacy original with a literal extension separator");
});

test("asset metadata and publication ledger are finalized inside the same database function", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /from executive_visuals\.asset_publications[\s\S]*?for update/i);
  assert.match(sql, /insert into executive_visuals\.assets/i);
  assert.match(sql, /on conflict \(id\) do nothing/i);
  assert.match(sql, /update executive_visuals\.asset_publications[\s\S]*?set status = 'published'/i);
  assert.match(sql, /return next asset_row/i);
  assert.match(sql, /asset_row.original_name is distinct from p_original_name/i);
  assert.match(sql, /asset_row.metadata is distinct from p_metadata/i);
  assert.match(sql, /asset_row.object_path !~/i);
});

test("atomic publication RPC is callable only by service_role", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /security definer\s+set search_path = ''/i);
  assert.match(sql, /revoke all on function executive_visuals\.finalize_asset_publication_v1[\s\S]*?from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function executive_visuals\.finalize_asset_publication_v1[\s\S]*?to service_role/i);
});

test("job lease fencing migration issues per-attempt tokens and replaces unfenced worker RPCs", async () => {
  const sql = await readFile(leaseMigrationUrl, "utf8");
  assert.match(sql, /add column if not exists lease_token uuid/i);
  assert.match(sql, /create or replace function executive_visuals\.claim_next_job_v2\s*\(/i);
  assert.match(sql, /create or replace function executive_visuals\.renew_job_lease_v2\s*\(/i);
  assert.match(sql, /create or replace function executive_visuals\.assert_job_lease_v2\s*\(/i);
  assert.match(sql, /create or replace function executive_visuals\.finish_job_v2\s*\(/i);
  assert.match(sql, /lease_token is distinct from p_lease_token/i);
  assert.match(sql, /revoke all on function executive_visuals\.claim_next_job_v2/i);
});

test("publication reservations are bound to a current worker lease and cleanup claims are fenced", async () => {
  const sql = await readFile(cleanupMigrationUrl, "utf8");
  assert.match(sql, /create or replace function executive_visuals\.reserve_asset_publication_v2\s*\(/i);
  assert.match(sql, /job_row\.lease_token is distinct from p_lease_token/i);
  assert.match(sql, /create or replace function executive_visuals\.claim_asset_storage_cleanup_v1\s*\(/i);
  assert.match(sql, /lease_token/i);
});
