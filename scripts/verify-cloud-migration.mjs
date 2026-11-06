import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const sql = await readFile(resolve(process.cwd(), "supabase/migrations/20261031210000_executive_visuals_core.sql"), "utf8");
const checkpointSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261102090000_video_pipeline_checkpoints.sql"), "utf8");
const reviewSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261106130000_frame_accurate_review_foundation.sql"), "utf8");
const reviewActorSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261106150000_review_api_actor.sql"), "utf8");
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

for (const column of ["timeline_id","timeline_revision","frame_number","duration_frames","annotation","visibility","updated_at","edited_at","request_id"]) {
  if (!reviewSql.includes("add column if not exists " + column)) issues.push("Review migration is missing the " + column + " field.");
}
for (const invariant of ["ev_reviews_frame_nonnegative","ev_reviews_duration_frames_valid","ev_reviews_visibility_valid","ev_reviews_annotation_object","ev_reviews_timeline_anchor_consistent"]) {
  if (!reviewSql.includes("constraint " + invariant)) issues.push("Review migration is missing constraint " + invariant + ".");
}
if (!reviewSql.includes("create table if not exists executive_visuals.review_events")) issues.push("Append-only review event table is missing.");
if (!reviewSql.includes("revoke all on executive_visuals.review_events from public,anon,authenticated;")) issues.push("Review events must not be client-writable.");
if (!reviewSql.includes("grant select on executive_visuals.review_events to authenticated;")) issues.push("Authenticated users need RLS-governed review event reads.");
if (!reviewSql.includes("create policy ev_review_events_read")) issues.push("Review event visibility policy is missing.");
if (!reviewSql.includes("reviews.visibility='project' or m.role in ('editor','reviewer')")) issues.push("Internal review comments must be hidden from viewer-only project members.");
if (!reviewSql.includes("create trigger ev_reviews_record_event")) issues.push("Review create/edit/resolve actions must produce durable event records.");
if (!reviewSql.includes("create trigger ev_reviews_touch_updated_at")) issues.push("Review edits must update durable timestamps.");
if (/\b(drop\s+table|truncate|delete\s+from)\b/i.test(reviewSql)) issues.push("Review migration must not contain destructive DDL/DML.");
if (!reviewSql.includes("language plpgsql") || !reviewSql.includes("as $") || !reviewSql.includes("end;\n$;")) issues.push("Review migration trigger functions must use valid PL/pgSQL dollar quoting.");
if (!reviewActorSql.includes("add column if not exists last_actor_id")) issues.push("Review API must persist the authenticated actor separately from the comment author.");
if (!reviewActorSql.includes("coalesce(new.last_actor_id,new.reviewer_id,new.owner_id)")) issues.push("Review audit events must record the actual acting user.");
if (!reviewActorSql.includes("on executive_visuals.reviews(reviewer_id,request_id)")) issues.push("Review idempotency keys must be scoped to the authenticated reviewer.");
if (!reviewActorSql.includes("revoke insert,update,delete on executive_visuals.reviews from authenticated;")) issues.push("Review writes must be restricted to the authenticated server API.");
if (!reviewActorSql.includes("revoke insert,update,delete on executive_visuals.review_events from authenticated;")) issues.push("Review event history must be server-written.");
if (!reviewActorSql.includes("as $") || !reviewActorSql.includes("end;\n$;")) issues.push("Review actor migration trigger must use valid PL/pgSQL dollar quoting.");




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
  console.log(`Cloud migration guard passed: ${tables.length} RLS tables, immutable run snapshots, private storage, and server-only job/audit writes.`);
}
