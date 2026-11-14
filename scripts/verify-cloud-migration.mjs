import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const sql = await readFile(resolve(process.cwd(), "supabase/migrations/20261031210000_executive_visuals_core.sql"), "utf8");
const checkpointSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261102090000_video_pipeline_checkpoints.sql"), "utf8");
const publicationSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261106230000_asset_publication_ledger.sql"), "utf8");
const cleanupSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261106190000_asset_storage_cleanup_outbox.sql"), "utf8");
const timelineRevisionSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261120100000_timeline_revision_history.sql"), "utf8");
const publicationBootstrap = await readFile(resolve(process.cwd(), "scripts/asset-publication-postgres-bootstrap.sql"), "utf8");
const issues = [];
if (/\\bdrop\\s+database\\b/i.test(publicationBootstrap)) issues.push("Disposable database bootstrap must never drop an existing database.");
if (!publicationBootstrap.includes("SELECT 'CREATE DATABASE cloud_video_test'") || !publicationBootstrap.includes("FROM pg_database WHERE datname='cloud_video_test'") || !publicationBootstrap.includes("\\gexec")) {
  issues.push("Cloud video test database must be created conditionally without destructive reset.");
}
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
if (!timelineRevisionSql.includes("create table if not exists executive_visuals.timeline_revisions") || !timelineRevisionSql.includes("after insert or update of revision on executive_visuals.timelines")) issues.push("Immutable timeline revision snapshots are not captured.");
if (!timelineRevisionSql.includes("security definer") || !timelineRevisionSql.includes("create policy ev_timeline_revisions_read")) issues.push("Timeline revision snapshots require server-side capture and an authorized read policy.");
if (!timelineRevisionSql.includes("create trigger ev_timeline_revisions_immutable") || !timelineRevisionSql.includes("revoke all on table executive_visuals.timeline_revisions from public, anon, authenticated, service_role")) issues.push("Timeline revision snapshots must be immutable and not writable by API roles.");
if (!timelineRevisionSql.includes("from executive_visuals.timelines t") || !timelineRevisionSql.includes("t.project_id")) issues.push("Timeline revision reads must follow current timeline access after project moves.");
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
const checkpointFunctionSignature = "create or replace function executive_visuals.validate_video_pipeline_checkpoint_scope(";
const checkpointFunctionStart = checkpointSql.indexOf(checkpointFunctionSignature);
const checkpointFunctionCount = checkpointSql.split(checkpointFunctionSignature).length - 1;
const checkpointTriggerCount = checkpointSql.split("create trigger ev_video_pipeline_checkpoints_validate_scope").length - 1;
const dollarQuote = "$" + "$";
const checkpointBodyStart = checkpointSql.indexOf("as " + dollarQuote, checkpointFunctionStart);
const checkpointBodyEnd = checkpointSql.indexOf(dollarQuote + ";", checkpointBodyStart);
if (checkpointFunctionCount !== 1 || checkpointTriggerCount !== 1 || checkpointFunctionStart < 0 || checkpointBodyStart < 0 || checkpointBodyEnd < 0) {
  issues.push("Checkpoint migration must contain exactly one complete validation function and one trigger.");
} else {
  const body = checkpointSql.slice(checkpointBodyStart + 3 + dollarQuote.length, checkpointBodyEnd).trim();
  if (!body.startsWith("begin") || !body.endsWith("end;")) issues.push("Checkpoint validation function body is incomplete.");
  if (!body.includes("a.sha256 = lower(new.input_sha256)")) issues.push("Checkpoint source hash must match the persisted source asset.");
  if (!body.includes("output_asset.sha256 = lower(new.output_json ->> 'sha256')")) issues.push("Checkpoint output hash must match the persisted derivative asset.");
  if (!body.includes("!~*") || !body.includes("new.output_json ->> 'id'")) issues.push("Checkpoint output asset ID must be validated before casting.");
}
if ((checkpointSql.split(dollarQuote).length - 1) !== 2) issues.push("Checkpoint migration must use one balanced PL/pgSQL dollar-quoted function body.");
if (!checkpointSql.includes("octet_length(output_json::text) <= 32000")) issues.push("Cloud checkpoint output must be size-bounded.");
if (!checkpointSql.includes("output_asset.derivative_of = new.input_asset_id")) issues.push("Cloud checkpoint outputs must be verified as derivatives of their recorded inputs.");
if (!checkpointSql.includes("output_asset.owner_id = new.owner_id") || !checkpointSql.includes("output_asset.project_id = new.project_id")) issues.push("Cloud checkpoint output assets must match the checkpoint owner and project.");
if (!checkpointSql.includes("output_asset.sha256 = lower(new.output_json ->> 'sha256')")) issues.push("Cloud checkpoint output checksums must match persisted asset metadata.");
if (/\\b(drop\\s+table|truncate|delete\\s+from)\\b/i.test(checkpointSql)) issues.push("Checkpoint migration must not contain destructive DDL/DML.");

if (/\b(drop\s+table|truncate|delete\s+from)\b/i.test(publicationSql)) issues.push("Publication ledger migration must not contain destructive DDL/DML.");

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

const fencingSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261108000000_job_lease_fencing_tokens.sql"), "utf8");
const atomicPublicationSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261108010000_atomic_asset_publication_lease_fencing.sql"), "utf8");
const cleanupClaimsSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261108020000_asset_publication_cleanup_claims.sql"), "utf8");
const cleanupAttemptSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261108030000_storage_cleanup_attempt_paths.sql"), "utf8");
const cleanupAuditSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261114130000_publication_cleanup_audit_events.sql"), "utf8");
if (!fencingSql.includes("add column if not exists lease_token uuid") || !fencingSql.includes("create or replace function executive_visuals.claim_next_job_v2(") || !fencingSql.includes("create or replace function executive_visuals.finish_job_v2(")) {
  issues.push("Cloud jobs require per-attempt lease tokens and fenced claim/completion RPCs.");
}
if (!fencingSql.includes("revoke all on function executive_visuals.claim_next_job_v2") || !fencingSql.includes("to service_role")) {
  issues.push("Fenced worker RPCs must remain service-role-only.");
}
if (!atomicPublicationSql.includes("create or replace function executive_visuals.finalize_asset_publication_v1(") || !atomicPublicationSql.includes("set search_path = ''")) {
  issues.push("Atomic asset publication requires a pinned, server-only finalization RPC.");
}
if (!atomicPublicationSql.includes("from executive_visuals.jobs") || !atomicPublicationSql.includes("for update") || !atomicPublicationSql.includes("job_row.lease_token is distinct from p_lease_token") || !atomicPublicationSql.includes("job_row.lease_expires_at <= pg_catalog.clock_timestamp()")) {
  issues.push("Atomic asset publication must lock and validate the exact unexpired worker lease.");
}
if (!atomicPublicationSql.includes("from executive_visuals.asset_publications") || !atomicPublicationSql.includes("for update") || !atomicPublicationSql.includes("insert into executive_visuals.assets") || !atomicPublicationSql.includes("update executive_visuals.asset_publications")) {
  issues.push("Asset metadata and publication-ledger completion must share one transaction.");
}
if (!atomicPublicationSql.includes("revoke all on function executive_visuals.finalize_asset_publication_v1") || !atomicPublicationSql.includes("to service_role")) {
  issues.push("Atomic publication finalization must be callable only by service_role.");
}
if (!cleanupClaimsSql.includes("create or replace function executive_visuals.reserve_asset_publication_v2(") || !cleanupClaimsSql.includes("job_row.lease_token is distinct from p_lease_token")) {
  issues.push("Publication reservations must be bound to the exact current worker lease.");
}
if (!cleanupAttemptSql.includes("attempt-[0-9a-f]") || !cleanupAttemptSql.includes("ev_asset_storage_cleanup_object_path_check")) {
  issues.push("Storage cleanup must accept only immutable, owner-scoped publication attempt paths.");
}
if (/\\b(drop\\s+table|truncate|delete\\s+from)\\b/i.test(cleanupAuditSql)) issues.push("Publication cleanup audit migration must not contain destructive DDL/DML.");
if (!cleanupAuditSql.includes("create table if not exists executive_visuals.publication_cleanup_audit_events")) issues.push("Append-only publication cleanup audit ledger is missing.");
if (!cleanupAuditSql.includes("alter table executive_visuals.publication_cleanup_audit_events enable row level security;")) issues.push("Publication cleanup audit ledger must enable RLS.");
if (!cleanupAuditSql.includes("revoke all on executive_visuals.publication_cleanup_audit_events from public, anon, authenticated, service_role;") || !cleanupAuditSql.includes("grant select, insert on executive_visuals.publication_cleanup_audit_events to service_role;")) issues.push("Publication cleanup audit ledger must be private and service-role append/read only.");
if (!cleanupAuditSql.includes("before update or delete on executive_visuals.publication_cleanup_audit_events") || !cleanupAuditSql.includes("publication cleanup audit events are append-only")) issues.push("Publication cleanup audit ledger must reject mutation.");

if (issues.length) {
  console.error("Cloud migration guard failed:");
  for (const issue of issues) console.error("- " + issue);
  process.exitCode = 1;
} else {
  console.log(`Cloud migration guard passed: ${tables.length} RLS tables, immutable run snapshots, private storage, and server-only job/audit writes.`);
}
