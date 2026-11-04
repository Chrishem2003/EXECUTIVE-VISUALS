import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const sql = await readFile(resolve(process.cwd(), "supabase/migrations/20261031210000_executive_visuals_core.sql"), "utf8");
const checkpointSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261102090000_video_pipeline_checkpoints.sql"), "utf8");
const videoSubmissionSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261104120000_cloud_video_submission_ledger.sql"), "utf8");
const videoBudgetSql = await readFile(resolve(process.cwd(), "supabase/migrations/20261104143000_cloud_video_budget_enqueue.sql"), "utf8");
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
if (!sql.includes("job_type <> 'video.generate'")) {
  issues.push("Generic cloud lease recovery must leave video jobs to their state-aware recovery RPC.");
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
if (/\\b(drop\\s+table|truncate|delete\\s+from)\\b/i.test(videoSubmissionSql)) issues.push("Cloud video submission migration must not contain destructive DDL/DML.");
if (!videoSubmissionSql.includes("create table if not exists executive_visuals.video_generation_submissions")) issues.push("Cloud video submission ledger table is missing.");
if (!videoSubmissionSql.includes("alter table executive_visuals.video_generation_submissions enable row level security;")) issues.push("Cloud video submission ledger must enable RLS.");
if (!videoSubmissionSql.includes("revoke all on executive_visuals.video_generation_submissions from public, anon, authenticated;")) issues.push("Cloud video submission ledger must be unavailable to untrusted roles.");
if (!videoSubmissionSql.includes("grant all privileges on executive_visuals.video_generation_submissions to service_role;")) issues.push("Cloud worker role needs access to the video submission ledger.");
for (const rpc of ["prepare_video_generation_submission","begin_video_generation_submission","record_video_generation_submission","mark_video_generation_submission_unknown","get_video_generation_submission","reconcile_unknown_video_generation_submission","finish_video_generation_submission"]) {
  const count = (videoSubmissionSql.match(new RegExp(`create or replace function executive_visuals\\.${rpc}\\(`, "g")) || []).length;
  if (count !== 1) issues.push(`Cloud video ledger RPC must be defined exactly once: ${rpc}.`);
  if (!videoSubmissionSql.includes(`grant execute on function executive_visuals.${rpc}(`) || !videoSubmissionSql.includes(`to service_role;`)) issues.push(`Cloud video ledger RPC must be granted to service_role: ${rpc}.`);
  if (!videoSubmissionSql.includes(`revoke all on function executive_visuals.${rpc}(`)) issues.push(`Cloud video ledger RPC must be revoked from untrusted roles: ${rpc}.`);
}
if (!videoSubmissionSql.includes("j.status='processing' and j.lease_owner=p_worker_id and j.lease_expires_at > clock_timestamp()")) issues.push("Cloud submission transitions must be fenced to the active worker lease.");
if (!videoSubmissionSql.includes("s.state='prepared'")) issues.push("Cloud provider submission must start from prepared state only.");
if (!videoSubmissionSql.includes("s.state='submitting' and s.provider_task_id is null")) issues.push("Ambiguous cloud submissions must be quarantined without automatic resubmission.");
if (!videoSubmissionSql.includes("state='unknown' and provider_task_id is null")) issues.push("Explicit reconciliation must be required for ambiguous provider submissions.");
if (!videoSubmissionSql.includes("unique" ) || !videoSubmissionSql.includes("provider_task_id text unique")) issues.push("Provider task IDs must be globally unique in the ledger.");
if (!videoSubmissionSql.includes("queued.input ->> 'requestHash'")) issues.push("Cloud ledger preparation must verify the queued request hash.");
if ((videoSubmissionSql.match(/security invoker/gi) || []).length !== 7 || /security definer/i.test(videoSubmissionSql)) issues.push("Cloud video ledger RPCs must use invoker rights and avoid privileged definer execution.");


if (/\b(drop\s+table|truncate|delete\s+from)\b/i.test(videoBudgetSql)) issues.push("Cloud video budget migration must not contain destructive DDL/DML.");
for (const table of ["video_generation_budget_policies","video_generation_budget_approvals","video_generation_budget_reservations","video_generation_usage_reservations"]) {
  if (!videoBudgetSql.includes(`create table if not exists executive_visuals.${table}`)) issues.push(`Cloud video budget table is missing: ${table}.`);
  if (!videoBudgetSql.includes(`alter table executive_visuals.${table} enable row level security;`)) issues.push(`Cloud video budget RLS is missing: ${table}.`);
}
if (!videoBudgetSql.includes("revoke all on executive_visuals.video_generation_budget_policies from public, anon, authenticated;") ||
    !videoBudgetSql.includes("revoke all on executive_visuals.video_generation_budget_approvals from public, anon, authenticated;")) {
  issues.push("Budget policy and approval tables must revoke inherited table privileges before granting the minimum client operations.");
}
if (!videoBudgetSql.includes("grant insert (owner_id, project_id, provider, model, currency, spend_limit_amount, max_per_job_amount, rolling_24h_request_limit, enabled)")) {
  issues.push("Budget policy inserts must not allow clients to seed server-maintained counters.");
}
if (!videoBudgetSql.includes("grant update (provider, model, currency, spend_limit_amount, max_per_job_amount, rolling_24h_request_limit, enabled, updated_at)")) {
  issues.push("Budget policy updates must not allow clients to alter owner scope or accounting totals.");
}
if (!videoBudgetSql.includes("VIDEO_BUDGET_POLICY_SCOPE_LOCKED_AFTER_USE") ||
    !videoBudgetSql.includes("ev_video_budget_policy_scope_immutable")) {
  issues.push("Budget currency/provider/model scope must be immutable after reservations or spend exist.");
}

if (!videoBudgetSql.includes("new.consumed_at := null") || !videoBudgetSql.includes("interval '15 minutes'")) {
  issues.push("Explicit budget approvals must be fresh, short-lived and single-use.");
}
if (!videoBudgetSql.includes("VIDEO_BUDGET_LIMIT_BELOW_COMMITTED_SPEND") ||
    !videoBudgetSql.includes("before update of provider, model, currency, spend_limit_amount")) {
  issues.push("Budget policy updates must not lower the spend ceiling below existing reservations and spend.");
}
if (!videoBudgetSql.includes("pg_advisory_xact_lock") || !videoBudgetSql.includes("for update")) {
  issues.push("Cloud enqueue must serialize idempotency, usage and budget reservation decisions.");
}
if (!videoBudgetSql.includes("approval.consumed_at is not null") || !videoBudgetSql.includes("update executive_visuals.video_generation_budget_approvals")) {
  issues.push("Budget approvals must be consumed exactly once with enqueue.");
}
if (!videoBudgetSql.includes("policy.reserved_amount + policy.spent_amount + p_reserved_amount > policy.spend_limit_amount")) {
  issues.push("Cloud enqueue must enforce the approved cumulative spend ceiling.");
}
if (!videoBudgetSql.includes("VIDEO_ENQUEUE_PROVIDER_NOT_ENABLED") ||
    !videoBudgetSql.includes("VIDEO_PRICE_DURATION_INVALID") ||
    !videoBudgetSql.includes("VIDEO_PRICE_OUTPUT_FORMAT_UNSUPPORTED") ||
    !videoBudgetSql.includes("p_reserved_amount < ((p_input ->> 'durationSeconds')::numeric * 0.12)")) {
  issues.push("Postgres enqueue must fail closed on unpriced models and enforce the verified Gen-4.5 USD price floor.");
}

if (!videoBudgetSql.includes("create or replace function executive_visuals.enqueue_video_generation_job(") ||
    !videoBudgetSql.includes("grant execute on function executive_visuals.enqueue_video_generation_job(") ||
    !videoBudgetSql.includes("revoke all on function executive_visuals.enqueue_video_generation_job(")) {
  issues.push("Atomic cloud video enqueue must be service-role-only.");
}
if (!videoBudgetSql.includes("VIDEO_ENQUEUE_PROVIDER_NOT_ENABLED") ||
    !videoBudgetSql.includes("p_provider <> 'runway' or p_model <> 'gen4.5'")) {
  issues.push("Cloud video enqueue must reject provider/model combinations without a verified adapter and price contract.");
}
if (!videoBudgetSql.includes("create or replace function executive_visuals.finish_video_generation_job(") ||
    !videoBudgetSql.includes("lease_expires_at <= clock_timestamp()") ||
    !videoBudgetSql.includes("VIDEO_BUDGET_ACTUAL_EXCEEDS_RESERVATION") ||
    !videoBudgetSql.includes("set status = p_status") ||
    !videoBudgetSql.includes("update executive_visuals.video_generation_submissions")) {
  issues.push("Budget settlement, submission terminalization and job completion must be atomic and lease-fenced.");
}
if (!videoBudgetSql.includes("security invoker") || /security definer/i.test(videoBudgetSql)) {
  issues.push("Cloud video budget RPCs must use invoker rights and avoid privileged definer execution.");
}
if (!videoBudgetSql.includes("as $video_finish$") || !videoBudgetSql.includes("$video_finish$;")) {
  issues.push("Cloud video finalizer must use a complete, unambiguous SQL function delimiter.");
}
const approvalInsertPolicy = videoBudgetSql.split("create policy ev_video_budget_approval_owner_insert")[1]?.split(");")[0] || "";
if (!approvalInsertPolicy.includes("p.owner_id = (select auth.uid())") || approvalInsertPolicy.includes("project_members")) {
  issues.push("Per-request budget approvals for project generation must be restricted to the project owner.");
}
if (!videoBudgetSql.includes("as $$") ||
    !videoBudgetSql.includes("end;\n$$;") ||
    /as \$(?!\$)\s*begin/.test(videoBudgetSql) ||
    /\n\$(?!\$);/.test(videoBudgetSql)) {
  issues.push("Cloud video budget trigger functions must use valid, complete dollar quoting.");
}
for (const fn of ["defer_video_generation_job","quarantine_video_generation_job","resume_reconciled_video_generation_job"]) {
  if (!videoBudgetSql.includes(`create or replace function executive_visuals.${fn}(`) ||
      !videoBudgetSql.includes(`grant execute on function executive_visuals.${fn}(`) ||
      !videoBudgetSql.includes(`revoke all on function executive_visuals.${fn}(`)) {
    issues.push(`Cloud video recovery RPC is missing or not service-role-only: ${fn}.`);
  }
}
if (!videoBudgetSql.includes("VIDEO_SUBMISSION_RECONCILIATION_REQUIRED") ||
    !videoBudgetSql.includes("VIDEO_JOB_DEFER_REQUIRES_SUBMITTED_TASK") ||
    !videoBudgetSql.includes("VIDEO_JOB_QUARANTINE_REQUIRES_AMBIGUOUS_SUBMISSION") ||
    !videoBudgetSql.includes("VIDEO_JOB_RESUME_REQUIRES_RECONCILED_TASK")) {
  issues.push("Ambiguous submission quarantine, safe polling deferral and evidence-reconciled resume guards are required.");
}
if (!videoBudgetSql.includes("VIDEO_JOB_OUTPUT_ASSET_SCOPE_INVALID") ||
    !videoBudgetSql.includes("a.storage_bucket = 'executive-visuals-media'") ||
    !videoBudgetSql.includes("a.deleted_at is null")) {
  issues.push("Successful video finalization must verify registered private asset ownership.");
}
if (!videoBudgetSql.includes("VIDEO_JOB_RESUME_EVIDENCE_REQUIRED") ||
    !videoBudgetSql.includes("p_evidence_reference text")) {
  issues.push("Resuming a quarantined video job must require an evidence reference.");
}
if (!videoBudgetSql.includes("create or replace function executive_visuals.recover_expired_video_generation_jobs(") ||
    !videoBudgetSql.includes("submission.state <> 'prepared'") ||
    !videoBudgetSql.includes("VIDEO_WORKER_LEASE_EXPIRED_REVIEW")) {
  issues.push("Expired cloud video jobs must use state-aware recovery and quarantine post-submission states.");
}




if (issues.length) {
  console.error("Cloud migration guard failed:");
  for (const issue of issues) console.error("- " + issue);
  process.exitCode = 1;
} else {
  console.log(`Cloud migration guard passed: ${tables.length} RLS tables, immutable run snapshots, private storage, and server-only job/audit writes.`);
}
