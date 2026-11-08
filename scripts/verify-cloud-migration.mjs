import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const sql = await readFile(resolve(process.cwd(), "supabase/migrations/20261031210000_executive_visuals_core.sql"), "utf8");
const checkpointSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261102090000_video_pipeline_checkpoints.sql"), "utf8");
const publicationSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261106230000_asset_publication_ledger.sql"), "utf8");
const fencingSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261108000000_job_lease_fencing_tokens.sql"), "utf8");
const atomicPublicationSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261108010000_atomic_asset_publication_lease_fencing.sql"), "utf8");
const cleanupClaimsSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261108020000_asset_publication_cleanup_claims.sql"), "utf8");
const cleanupAttemptSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261108030000_storage_cleanup_attempt_paths.sql"), "utf8");
const cleanupSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261106190000_asset_storage_cleanup_outbox.sql"), "utf8");
const issues = [];
const tables = ["projects","project_members","project_workspace_documents","workflows","workflow_runs","workflow_node_runs","timelines","assets","jobs","job_events","consents","reviews","audit_events"];
for (const table of tables) {
  if (!sql.includes(`alter table executive_visuals.${table} enable row level security;`)) {
    issues.push(`RLS is not enabled for ${table}.`);
  }
}
for (const table of ["projects","workflows","timelines","assets","jobs","reviews","consents","job_events","audit_events"]) {
  if (!sql.includes(`create trigger ev_${table}_owner_immutable`)) {
    issues.push(`Owner immutability trigger is missing for ${table}.`);
  }
}
for (const policy of ["ev_projects_read","ev_members_read","ev_project_workspace_read","ev_project_workspace_insert","ev_project_workspace_update","ev_workflows_read","ev_workflow_runs_read","ev_workflow_node_runs_read","ev_timelines_read","ev_assets_read","ev_jobs_read","ev_job_events_read","ev_consents_read","ev_reviews_read","ev_audit_read"]) {
  if (!sql.includes(`create policy ${policy}`)) issues.push(`Read policy is missing: ${policy}.`);
}
if (!sql.includes("create trigger ev_workflow_runs_snapshot_immutable")) issues.push("Workflow run snapshots must be immutable.");
if (!sql.includes("create policy ev_workflow_runs_insert") || !sql.includes("status='awaiting_approval'") || !sql.includes("and job_id is null")) {
  issues.push("New workflow runs must be created in a gated, unsubmitted state.");
}
if (!sql.includes("revoke all on schema executive_visuals from public, anon;")) issues.push("Private schema must not be granted to anon or public.");
if (!sql.includes("grant usage on schema executive_visuals to authenticated, service_role;")) issues.push("Authenticated and server roles need schema usage.");
if (!sql.includes("grant all privileges on all tables in schema executive_visuals to service_role;")) issues.push("Trusted server role needs table privileges.");
if (!sql.includes("revoke update,delete on executive_visuals.jobs from authenticated;")) issues.push("Clients must not forge job state transitions.");
if (!sql.includes("revoke update,delete on executive_visuals.workflow_runs from authenticated;")) issues.push("Clients must not forge workflow run states.");
if (!sql.includes("revoke insert,update,delete on executive_visuals.workflow_node_runs from authenticated;")) issues.push("Per-node run history must be server-written.");
for (const table of ["job_events","audit_events"]) {
  if (!sql.includes(`revoke insert,update,delete on executive_visuals.${table} from authenticated;`)) {
    issues.push(`${table} must be server-written.`);
  }
}
if (!sql.includes("revoke update,delete on executive_visuals.jobs from authenticated;")) issues.push("Jobs must be server-transitioned.");
if (!sql.includes("revoke delete on executive_visuals.project_workspace_documents from authenticated;")) issues.push("Project workspace documents must not be client-deleted.");
if (!sql.includes("status in ('draft','awaiting_approval')")) issues.push("Client job creation must be limited to draft/approval states.");
if (!sql.includes("values ('executive-visuals-media','executive-visuals-media',false")) issues.push("Media storage bucket must be private.");
if (!sql.includes("on conflict (id) do update set") || !sql.includes("public=false") || !sql.includes("file_size_limit=excluded.file_size_limit") || !sql.includes("allowed_mime_types=excluded.allowed_mime_types")) issues.push("Existing media bucket configuration must be reconciled to the private, bounded policy.");
if (!sql.includes("create policy ev_storage_insert") || !sql.includes("create policy ev_storage_read")) issues.push("Private storage access policies are incomplete.");
if (!sql.includes("'text/vtt'")) issues.push("Private storage must allow generated WebVTT caption assets.");
if (!sql.includes("as $$") || !sql.includes("end;\n$$;") || /as \$(?!\$)\s*begin/.test(sql) || /\n\$(?!\$);/.test(sql)) {
  issues.push("PL/pgSQL trigger functions must use valid dollar quoting.");
}
if (/\b(drop\s+table|truncate|delete\s+from)\b/i.test(sql)) issues.push("Destructive DDL/DML is not allowed in the initial isolated migration.");
if (!sql.startsWith("-- Executive Visuals isolated data model.")) issues.push("Migration must identify its isolated deployment boundary.");

if (/\b(drop\s+table|truncate|delete\s+from)\b/i.test(checkpointSql)) issues.push("Checkpoint migration must not contain destructive DDL/DML.");
if (!checkpointSql.includes("unique(owner_id, project_id, pipeline_id, step_id)")) issues.push("Cloud pipeline steps must have immutable owner/project scoped uniqueness.");
if (!checkpointSql.includes("unique(owner_id, idempotency_key)")) issues.push("Cloud checkpoint idempotency keys must be unique per owner.");
if (!checkpointSql.includes("alter table executive_visuals.video_pipeline_checkpoints enable row level security;")) issues.push("Cloud pipeline checkpoints must enable RLS.");
if (!checkpointSql.includes("revoke all on executive_visuals.video_pipeline_checkpoints from public, anon, authenticated;")) issues.push("Cloud checkpoints must be unavailable to untrusted roles.");
if (!checkpointSql.includes("grant all privileges on executive_visuals.video_pipeline_checkpoints to service_role;")) issues.push("Trusted cloud worker role needs checkpoint access.");
if (!checkpointSql.includes("ev_video_pipeline_checkpoints_validate_scope")) issues.push("Cloud checkpoint writes must validate owner, project and source asset scope.");
if (!checkpointSql.includes("octet_length(output_json::text) <= 32000")) issues.push("Cloud checkpoint output must be size-bounded.");
if (!checkpointSql.includes("output_asset.derivative_of = new.input_asset_id")) issues.push("Cloud checkpoint outputs must be verified as derivatives of their recorded inputs.");
if (!checkpointSql.includes("output_asset.owner_id = new.owner_id") || !checkpointSql.includes("output_asset.project_id = new.project_id")) issues.push("Cloud checkpoint output assets must match the checkpoint owner and project.");
if (!checkpointSql.includes("output_asset.sha256 = lower(new.output_json ->> 'sha256')")) issues.push("Cloud checkpoint output checksums must match persisted asset metadata.");
if (/\\b(drop\\s+table|truncate|delete\\s+from)\\b/i.test(checkpointSql)) issues.push("Checkpoint migration must not contain destructive DDL/DML.");

if (/\b(drop\s+table|truncate|delete\s+from)\b/i.test(publicationSql)) issues.push("Publication ledger migration must not contain destructive DDL/DML.");

if (/\b(drop\s+table|truncate|delete\s+from)\b/i.test(fencingSql)) issues.push("Lease fencing migration must not contain destructive DDL/DML.");
if (!fencingSql.includes("add column if not exists lease_token uuid")) issues.push("Jobs must store a per-attempt fencing token.");
if (!fencingSql.includes("ev_jobs_processing_requires_lease_token") || !fencingSql.includes("check (status <> 'processing' or lease_token is not null) not valid")) issues.push("New processing jobs must require a lease token while legacy active rows drain.");
if (!fencingSql.includes("lease_token=gen_random_uuid()")) issues.push("Every claim must generate a fresh database-side fencing token.");
if (!fencingSql.includes("lease_token=p_lease_token")) issues.push("Lease renewal and completion must match the current fencing token.");
if (!fencingSql.includes("lease_token=null")) issues.push("Recovery and completion must clear the prior fencing token.");
const fencedGrants = {
  claim_next_job_v2: "grant execute on function executive_visuals.claim_next_job_v2(text,integer,text[]) to service_role",
  renew_job_lease_v2: "grant execute on function executive_visuals.renew_job_lease_v2(uuid,text,uuid,integer) to service_role",
  finish_job_v2: "grant execute on function executive_visuals.finish_job_v2(uuid,text,uuid,text,jsonb,jsonb) to service_role",
  assert_job_lease_v2: "grant execute on function executive_visuals.assert_job_lease_v2(uuid,text,uuid) to service_role"
};
for (const [fn,grant] of Object.entries(fencedGrants)) {
  if (!fencingSql.includes("create or replace function executive_visuals."+fn+"(")) issues.push("Fenced queue RPC is missing: "+fn+".");
  if (!fencingSql.includes(grant)) issues.push("Fenced queue RPC permissions must be restricted to service_role: "+fn+".");
}
if (!fencingSql.includes("revoke all on function executive_visuals.claim_next_job(text,integer,text[]) from public,anon,authenticated,service_role;")
 || !fencingSql.includes("revoke all on function executive_visuals.renew_job_lease(uuid,text,integer) from public,anon,authenticated,service_role;")
 || !fencingSql.includes("revoke all on function executive_visuals.finish_job(uuid,text,text,jsonb,jsonb) from public,anon,authenticated,service_role;")) {
  issues.push("Legacy unfenced worker RPCs must be disabled after v2 migration.");
}
if (/\b(drop\s+table|truncate|delete\s+from)\b/i.test(atomicPublicationSql)) issues.push("Atomic publication migration must not contain destructive DDL/DML.");
if (!atomicPublicationSql.includes("create or replace function executive_visuals.finalize_asset_publication_v1(")
 || !atomicPublicationSql.includes("job_row.lease_token is distinct from p_lease_token")
 || !atomicPublicationSql.includes("for update")
 || !atomicPublicationSql.includes("insert into executive_visuals.assets")
 || !atomicPublicationSql.includes("set status = 'published'")) {
  issues.push("Asset metadata and publication ledger must finalize atomically under the active worker lease.");
}
if (!atomicPublicationSql.includes("create trigger ev_assets_validate_derivative_scope")
 || !atomicPublicationSql.includes("parent_asset.owner_id is distinct from new.owner_id")
 || !atomicPublicationSql.includes("parent_asset.project_id is distinct from new.project_id")) {
  issues.push("Asset derivatives must remain within the same owner and project scope.");
}
if (!atomicPublicationSql.includes("revoke all on function executive_visuals.complete_asset_publication(uuid,text,uuid) from public, anon, authenticated, service_role;")) {
  issues.push("Legacy unfenced asset publication completion must be disabled.");
}
if (/\b(drop\s+table|truncate|delete\s+from)\b/i.test(cleanupClaimsSql)) issues.push("Publication cleanup claim migration must not contain destructive DDL/DML.");
if (!cleanupClaimsSql.includes("create or replace function executive_visuals.reserve_asset_publication_v2(")
 || !cleanupClaimsSql.includes("job_row.lease_token is distinct from p_lease_token")
 || !cleanupClaimsSql.includes("publication_row.job_id is distinct from p_job_id")) {
  issues.push("Publication reservations must bind the immutable key and checksum to the current job lease.");
}
if (!cleanupClaimsSql.includes("create table if not exists executive_visuals.asset_publication_cleanup_claims")
 || !cleanupClaimsSql.includes("alter table executive_visuals.asset_publication_cleanup_claims enable row level security;")
 || !cleanupClaimsSql.includes("create or replace function executive_visuals.claim_asset_publication_cleanup_v1(")
 || !cleanupClaimsSql.includes("create or replace function executive_visuals.complete_asset_publication_cleanup_v1(")) {
  issues.push("Orphan publication cleanup must use durable, tokenized tombstone claims.");
}
if (!cleanupClaimsSql.includes("cleanup_claim.object_path = p_object_path")
 || !cleanupClaimsSql.includes("asset object path is fenced by a durable cleanup claim")) {
  issues.push("Publication finalization must reject object paths fenced for cleanup.");
}
if (!cleanupClaimsSql.includes("grant execute on function executive_visuals.reserve_asset_publication_v2(uuid,text,uuid,uuid,uuid,text,text,uuid) to service_role")
 || !cleanupClaimsSql.includes("grant execute on function executive_visuals.claim_asset_publication_cleanup_v1(uuid,uuid,uuid,text,text,interval) to service_role")
 || !cleanupClaimsSql.includes("grant execute on function executive_visuals.complete_asset_publication_cleanup_v1(uuid,uuid) to service_role")) {
  issues.push("Publication reservation and cleanup RPCs must be restricted to service_role.");
}if (/\b(drop\s+table|truncate|delete\s+from)\b/i.test(cleanupAttemptSql)) issues.push("Cleanup attempt-path migration must not contain destructive DDL/DML.");
if (!cleanupAttemptSql.includes("drop constraint if exists asset_storage_cleanup_object_path_check")
 || !cleanupAttemptSql.includes("attempt-[0-9a-f]{8}")) issues.push("Durable cleanup outbox must accept only exact original or immutable attempt object paths.");



if (/\b(drop\s+table|truncate|delete\s+from)\b/i.test(cleanupSql)) issues.push("Storage cleanup outbox migration must not contain destructive DDL/DML.");
if (!cleanupSql.includes("create table if not exists executive_visuals.asset_storage_cleanup") || !cleanupSql.includes("alter table executive_visuals.asset_storage_cleanup enable row level security;")) issues.push("Storage cleanup outbox must exist and enable RLS.");
if (!cleanupSql.includes("revoke all on executive_visuals.asset_storage_cleanup from public, anon, authenticated;") || !cleanupSql.includes("grant select, insert, update on executive_visuals.asset_storage_cleanup to service_role;")) issues.push("Storage cleanup outbox must be service-role-only.");
if (!cleanupSql.includes("object_path text not null unique") || !cleanupSql.includes("object_path ~*")) issues.push("Storage cleanup outbox must enforce unique, owner-scoped original asset paths.");

if (!publicationSql.includes("unique(owner_id, publication_key)") || !publicationSql.includes("unique(asset_id)")) issues.push("Asset publication identity must be unique per owner and asset.");
if (!publicationSql.includes("payload_sha256") || !publicationSql.includes("status in ('reserved','published')")) issues.push("Asset publication ledger must bind a checksum to a recoverable state.");
if (!publicationSql.includes("alter table executive_visuals.asset_publications enable row level security;")) issues.push("Asset publication ledger must enable RLS.");
if (!publicationSql.includes("revoke all on executive_visuals.asset_publications from public, anon, authenticated;")) issues.push("Asset publication ledger must be unavailable to untrusted roles.");
if (!publicationSql.includes("grant select, insert, update on executive_visuals.asset_publications to service_role;")) issues.push("Asset publication ledger must be service-role-only.");
if (!publicationSql.includes("create or replace function executive_visuals.reserve_asset_publication(") || !publicationSql.includes("grant execute on function executive_visuals.reserve_asset_publication(uuid,uuid,text,text,uuid) to service_role")) issues.push("Asset publication reservation RPC must be restricted to service_role.");
if (!publicationSql.includes("create or replace function executive_visuals.complete_asset_publication(") || !publicationSql.includes("asset.sha256=publication.payload_sha256") || !publicationSql.includes("grant execute on function executive_visuals.complete_asset_publication(uuid,text,uuid) to service_role")) issues.push("Asset publication completion must verify the persisted asset checksum and be restricted to service_role.");




if ((sql.match(/create or replace function executive_visuals\.(?:claim_next_job|renew_job_lease|recover_expired_jobs|finish_job)\(/g) || []).length !== 4) {
  issues.push("All four cloud queue RPC definitions must be present exactly once.");
}
if (/as \$(?:\r?\n)|\r?\n\$;/.test(sql)) issues.push("Cloud queue PL/pgSQL functions contain an invalid single-dollar delimiter.");
if (!sql.includes("limit 1\n    for update skip locked") || !sql.includes("limit p_limit\n    for update skip locked")) {
  issues.push("Cloud worker row locks must use valid PostgreSQL LIMIT/FOR UPDATE ordering.");
}
if (!sql.includes("revoke all on function executive_visuals.renew_job_lease(uuid, text, integer) from public, anon, authenticated;") || !sql.includes("revoke all on function executive_visuals.finish_job(uuid, text, text, jsonb, jsonb) from public, anon, authenticated;")) {
  issues.push("Lease renewal and job completion RPCs must be unavailable to untrusted roles.");
}
if (!sql.includes("create or replace function executive_visuals.claim_next_job(") || !sql.includes("for update skip locked") || !sql.includes("job_type = any(p_job_types)") || !sql.includes("grant execute on function executive_visuals.claim_next_job(text, integer, text[]) to service_role")) {
  issues.push("Cloud workers need an atomic SKIP LOCKED claim RPC restricted to service_role.");
}

if (!sql.includes("create or replace function executive_visuals.renew_job_lease(") || !sql.includes("lease_owner = p_worker_id") || !sql.includes("grant execute on function executive_visuals.renew_job_lease(uuid, text, integer) to service_role")) {
  issues.push("Cloud workers need owner-bound lease heartbeats restricted to service_role.");
}
if (!sql.includes("create or replace function executive_visuals.finish_job(") || !sql.includes("lease_expires_at > clock_timestamp()") || !sql.includes("grant execute on function executive_visuals.finish_job(uuid, text, text, jsonb, jsonb) to service_role")) {
  issues.push("Cloud job completion must be fenced to the current, unexpired worker lease.");
}
if (!sql.includes("create or replace function executive_visuals.recover_expired_jobs(") || !sql.includes("WORKER_LEASE_EXPIRED") || !sql.includes("grant execute on function executive_visuals.recover_expired_jobs(integer) to service_role")) {
  issues.push("Cloud workers need bounded expired-lease recovery restricted to service_role.");
}
if (!sql.includes("started_at timestamptz") || !sql.includes("set status = 'processing'") || !sql.includes("lease_expires_at = clock_timestamp() + make_interval")) {
  issues.push("Cloud job claim must persist its start time, processing state and lease expiry.");
}
if (!sql.includes("revoke all on function executive_visuals.claim_next_job(text, integer, text[]) from public, anon, authenticated;") || !sql.includes("revoke all on function executive_visuals.recover_expired_jobs(integer) from public, anon, authenticated;")) {
  issues.push("Cloud queue mutation functions must not be callable by untrusted roles.");
}
if (!sql.includes("lease_expires_at timestamptz") || !sql.includes("available_at timestamptz") || !sql.includes("lease_heartbeat_at timestamptz")) {
  issues.push("Durable worker lease and delayed retry fields are missing from the cloud job contract.");
}
if (issues.length) {
  console.error("Cloud migration guard failed:");
  for (const issue of issues) console.error("- " + issue);
  process.exitCode = 1;
} else {
  console.log(`Cloud migration guard passed: ${tables.length} RLS tables, immutable run snapshots, private storage, server-only job/audit writes, per-attempt lease fencing and atomic asset publication.`);
}
