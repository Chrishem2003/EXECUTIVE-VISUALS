import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../../supabase/migrations/20261107010000_atomic_asset_publication_lease_fencing.sql", import.meta.url);

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

test("asset derivatives cannot cross owner/project boundaries or use deleted sources", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create or replace function executive_visuals\.validate_asset_derivative_scope_v1\s*\(/i);
  assert.ok(sql.includes("as $derivative_scope$") && sql.includes("$derivative_scope$;"), "derivative trigger function must use complete named dollar quoting");
  assert.match(sql, /from executive_visuals\.assets[\s\S]*?where id = new\.derivative_of[\s\S]*?for share/i);
  assert.match(sql, /parent_asset\.owner_id is distinct from new\.owner_id/i);
  assert.match(sql, /parent_asset\.project_id is distinct from new\.project_id/i);
  assert.match(sql, /parent_asset\.deleted_at is not null/i);
  assert.match(sql, /tg_op = 'UPDATE'[\s\S]*?new\.project_id is distinct from old\.project_id[\s\S]*?where derivative_of = old\.id[\s\S]*?asset with derivatives cannot change owner\/project scope/i);
  assert.match(sql, /create trigger ev_assets_validate_derivative_scope[\s\S]*?before insert or update of derivative_of, owner_id, project_id[\s\S]*?on executive_visuals\.assets/i);
  assert.match(sql, /revoke all on function executive_visuals\.validate_asset_derivative_scope_v1\(\)[\s\S]*?from public, anon, authenticated, service_role/i);
});

test("video pipeline checkpoint migration enforces source and output integrity exactly once", async () => {
  const migration = await readFile(
    new URL("../../supabase/migrations/20261102090000_video_pipeline_checkpoints.sql", import.meta.url),
    "utf8",
  );
  assert.equal((migration.match(/create or replace function executive_visuals\.validate_video_pipeline_checkpoint_scope/g) || []).length, 1);
  assert.equal((migration.match(/create trigger ev_video_pipeline_checkpoints_validate_scope/g) || []).length, 1);
  assert.match(migration, /security definer\s+set search_path = ''/i);
  assert.match(migration, /source_asset\.sha256 is distinct from new\.input_sha256/i);
  assert.match(migration, /source_asset\.deleted_at is not null/i);
  assert.match(migration, /output_asset\.owner_id is distinct from new\.owner_id/i);
  assert.match(migration, /output_asset\.project_id is distinct from new\.project_id/i);
  assert.match(migration, /output_asset\.derivative_of is distinct from new\.input_asset_id/i);
  assert.match(migration, /output_asset\.sha256 is distinct from output_sha256/i);
  assert.match(migration, /revoke all on function executive_visuals\.validate_video_pipeline_checkpoint_scope\(\)[\s\S]*?from public, anon, authenticated, service_role/i);
});

test("atomic publication RPC is callable only by service_role", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /security definer\s+set search_path = ''/i);
  assert.match(sql, /revoke all on function executive_visuals\.finalize_asset_publication_v1[\s\S]*?from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function executive_visuals\.finalize_asset_publication_v1[\s\S]*?to service_role/i);
  assert.match(sql, /revoke all on function executive_visuals\.complete_asset_publication\(uuid,text,uuid\)[\s\S]*?from public, anon, authenticated, service_role/i);
});

const cleanupMigrationUrl = new URL("../../supabase/migrations/20261107020000_asset_publication_cleanup_claims.sql", import.meta.url);

test("durable cleanup claims serialize with publication and retain path tombstones", async () => {
  const sql = await readFile(cleanupMigrationUrl, "utf8");
  const claimStart = sql.indexOf("create or replace function executive_visuals.claim_asset_publication_cleanup_v1");
  const completeStart = sql.indexOf("create or replace function executive_visuals.complete_asset_publication_cleanup_v1");
  const finalizeStart = sql.lastIndexOf("create or replace function executive_visuals.finalize_asset_publication_v1");
  assert.ok(claimStart >= 0 && completeStart > claimStart && finalizeStart > completeStart);
  const reserveStart = sql.indexOf("create or replace function executive_visuals.reserve_asset_publication_v2");
  assert.ok(reserveStart >= 0 && reserveStart < claimStart);
  const reserveSql = sql.slice(reserveStart, claimStart);
  assert.match(sql, /add column if not exists job_id uuid/i);
  assert.match(reserveSql, /from executive_visuals\.jobs[\s\S]*?for update/i);
  assert.match(reserveSql, /job_row\.lease_token is distinct from p_lease_token/i);
  assert.match(reserveSql, /job_row\.lease_expires_at <= pg_catalog\.clock_timestamp\(\)/i);
  assert.match(reserveSql, /job_id, publication_key, payload_sha256/i);
  assert.match(reserveSql, /revoke all on function executive_visuals\.reserve_asset_publication\(uuid,uuid,text,text,uuid\)[\s\S]*?from public, anon, authenticated, service_role/i);
  const claimSql = sql.slice(claimStart, completeStart);
  assert.ok(claimSql.indexOf("from executive_visuals.jobs") < claimSql.indexOf("from executive_visuals.asset_publications"));
  assert.match(claimSql, /for update[\s\S]*?from executive_visuals\.asset_publications[\s\S]*?for update/i);
  assert.match(claimSql, /publication_row\.status not in \('reserved','published'\)/i);
  assert.match(claimSql, /publication_row\.updated_at > pg_catalog\.clock_timestamp\(\) - p_min_age/i);
  assert.match(claimSql, /from executive_visuals\.assets[\s\S]*?where a\.object_path = p_object_path/i);
  assert.match(claimSql, /on conflict \(object_path\) do update[\s\S]*?status = 'claimed'[\s\S]*?where executive_visuals\.asset_publication_cleanup_claims\.status = 'deleted'/i);
  const finalizer = sql.slice(finalizeStart);
  assert.match(finalizer, /from executive_visuals\.asset_publication_cleanup_claims[\s\S]*?cleanup_claim\.object_path = p_object_path/i);
  assert.match(finalizer, /publication_row\.job_id is distinct from p_job_id/i);
  assert.match(finalizer, /asset object path is fenced by a durable cleanup claim/i);
  assert.match(sql, /status = 'deleted'[\s\S]*?deleted_at = coalesce/i);
  assert.match(sql, /grant execute on function executive_visuals\.claim_asset_publication_cleanup_v1[\s\S]*?to service_role/i);
  assert.match(sql, /grant execute on function executive_visuals\.complete_asset_publication_cleanup_v1[\s\S]*?to service_role/i);
});
