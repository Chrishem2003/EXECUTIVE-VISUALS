import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl=new URL("../../supabase/migrations/20261117160000_b2_multipart_upload_sessions.sql",import.meta.url);
const storeUrl=new URL("../b2-multipart-upload-store.mjs",import.meta.url);
const cleanupMigrationUrl=new URL("../../supabase/migrations/20261117170000_b2_multipart_cleanup_claims.sql",import.meta.url);

test("B2 multipart session schema is service-role-only and owner scoped",async()=>{
 const sql=await readFile(migrationUrl,"utf8");
 assert.match(sql,/asset_multipart_upload_sessions/);
 assert.match(sql,/owner_id uuid not null references auth\.users\(id\) on delete cascade/);
 assert.match(sql,/unique\(owner_id,idempotency_key\)/);
 assert.match(sql,/storage_provider text not null check \(storage_provider = 'backblaze-b2'\)/);
 assert.match(sql,/storage_bucket text not null check \(storage_bucket = 'executive-visuals-media'\)/);
 assert.match(sql,/enable row level security/);
 assert.match(sql,/revoke all on executive_visuals\.asset_multipart_upload_sessions from public, anon, authenticated/);
 assert.match(sql,/grant select,insert,update,delete on executive_visuals\.asset_multipart_upload_sessions to service_role/);
 assert.match(sql,/asset_multipart_upload_parts/);
 assert.match(sql,/primary key\(session_id,part_number\)/);
 assert.match(sql,/sha256 text not null check \(sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/);
});

test("multipart ledger implementation never returns provider credentials or public signed URLs",async()=>{
 const source=await readFile(storeUrl,"utf8");
 assert.match(source,/accept-profile/);
 assert.match(source,/content-profile/);
 assert.match(source,/owner_id=eq\./);
 assert.match(source,/B2_MULTIPART_IDEMPOTENCY_CONFLICT/);
 assert.match(source,/B2_MULTIPART_PART_CONFLICT/);
 assert.doesNotMatch(source,/secretAccessKey|secret_access_key|createSignedUrl/);
});

test("expired multipart cleanup adds a leased claim state without changing completed-object semantics",async()=>{
 const sql=await readFile(cleanupMigrationUrl,"utf8");
 assert.match(sql,/add column if not exists cleanup_claimed_at timestamptz/);
 assert.match(sql,/cleanup_pending/);
 assert.match(sql,/status = 'cleanup_pending'/);
 assert.match(sql,/ev_multipart_sessions_cleanup_pending/);
});
