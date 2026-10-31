import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const sql = await readFile(resolve(process.cwd(), "supabase/migrations/20261031210000_executive_visuals_core.sql"), "utf8");
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
if (!sql.includes("create policy ev_storage_insert") || !sql.includes("create policy ev_storage_read")) issues.push("Private storage access policies are incomplete.");
if (!sql.includes("as $$") || !sql.includes("end;\n$$;") || /as \$(?!\$)\s*begin/.test(sql) || /\n\$(?!\$);/.test(sql)) {
  issues.push("PL/pgSQL trigger functions must use valid dollar quoting.");
}
if (/\b(drop\s+table|truncate|delete\s+from)\b/i.test(sql)) issues.push("Destructive DDL/DML is not allowed in the initial isolated migration.");
if (!sql.startsWith("-- Executive Visuals isolated data model.")) issues.push("Migration must identify its isolated deployment boundary.");

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
