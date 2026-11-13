import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function openDatabase(filename) {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT,
      password_salt TEXT,
      auth_source TEXT NOT NULL DEFAULT 'local',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      settings_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      archived_at TEXT
    );
    CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects(owner_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS project_workspace_documents (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      document_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('editor','reviewer','viewer')),
      invited_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY(project_id,member_id)
    );
    CREATE INDEX IF NOT EXISTS project_members_member_idx ON project_members(member_id,project_id);
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      project_id TEXT REFERENCES projects(id),
      original_name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
      sha256 TEXT NOT NULL,
      storage_path TEXT NOT NULL UNIQUE,
      derivative_of TEXT REFERENCES assets(id),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS assets_owner_idx ON assets(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS assets_project_idx ON assets(project_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      project_id TEXT REFERENCES projects(id),
      name TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      graph_json TEXT NOT NULL,
      graph_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(owner_id, project_id, name)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      project_id TEXT REFERENCES projects(id),
      job_type TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','reviewing','succeeded','partial','failed','cancelled','blocked','needs_input')),
      progress REAL NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 100),
      input_json TEXT NOT NULL,
      output_json TEXT,
      error_json TEXT,
      idempotency_key TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 2,
      available_at TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      lease_heartbeat_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      started_at TEXT,
      completed_at TEXT,
      UNIQUE(owner_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS jobs_owner_idx ON jobs(owner_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id),
      owner_id TEXT NOT NULL REFERENCES users(id),
      project_id TEXT REFERENCES projects(id),
      workflow_revision INTEGER NOT NULL,
      snapshot_hash TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','awaiting_approval','completed','partial','failed','blocked','cancelled')),
      job_id TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS workflow_runs_workflow_idx ON workflow_runs(workflow_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS workflow_runs_owner_idx ON workflow_runs(owner_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS workflow_node_runs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','blocked','awaiting_approval','skipped')),
      attempt INTEGER NOT NULL DEFAULT 0,
      input_json TEXT NOT NULL DEFAULT '{}',
      output_json TEXT,
      error_json TEXT,
      started_at TEXT,
      completed_at TEXT,
      UNIQUE(run_id,node_id)
    );
    CREATE INDEX IF NOT EXISTS workflow_node_runs_run_idx ON workflow_node_runs(run_id,node_id);
    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id),
      event_type TEXT NOT NULL,
      event_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events(job_id, id);
    CREATE TABLE IF NOT EXISTS video_generation_approvals (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      currency TEXT NOT NULL,
      quoted_amount_micros INTEGER NOT NULL CHECK(quoted_amount_micros >= 0),
      budget_ceiling_micros INTEGER NOT NULL CHECK(budget_ceiling_micros >= quoted_amount_micros),
      status TEXT NOT NULL CHECK(status IN ('approved_pending_submission','withdrawn','consumed')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(owner_id,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS video_generation_approvals_owner_idx ON video_generation_approvals(owner_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS video_generation_approvals_project_idx ON video_generation_approvals(project_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS model_usage_events (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      project_id TEXT REFERENCES projects(id),
      job_id TEXT,
      workflow_run_id TEXT,
      node_id TEXT,
      provider TEXT NOT NULL,
      capability TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      duration_ms INTEGER NOT NULL DEFAULT 0 CHECK(duration_ms >= 0),
      estimated_cost_micros INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS model_usage_owner_idx ON model_usage_events(owner_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS model_usage_project_idx ON model_usage_events(project_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS model_usage_job_idx ON model_usage_events(job_id);
    CREATE TABLE IF NOT EXISTS evidence_records (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      source_asset_id TEXT NOT NULL REFERENCES assets(id),
      source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
      target_type TEXT NOT NULL CHECK(target_type IN ('project','scene','shot','timeline','asset')),
      target_id TEXT NOT NULL,
      evidence_kind TEXT NOT NULL,
      claim TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT '',
      source_ref TEXT NOT NULL DEFAULT '',
      observed_at TEXT,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','needs_review','verified','rejected')),
      review_note TEXT NOT NULL DEFAULT '',
      reviewed_by TEXT REFERENCES users(id),
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK((status IN ('verified','rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL) OR status IN ('submitted','needs_review'))
    );
    CREATE INDEX IF NOT EXISTS evidence_records_project_idx ON evidence_records(project_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS evidence_records_asset_idx ON evidence_records(source_asset_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS evidence_records_target_idx ON evidence_records(target_type,target_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS evidence_record_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evidence_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL REFERENCES users(id),
      event_type TEXT NOT NULL CHECK(event_type IN ('submitted','reviewed')),
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS evidence_record_events_evidence_idx ON evidence_record_events(evidence_id,id);
    CREATE TABLE IF NOT EXISTS creative_graph_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id),
      revision INTEGER NOT NULL CHECK(revision > 0),
      graph_hash TEXT NOT NULL CHECK(length(graph_hash)=64),
      graph_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(project_id,revision)
    );
    CREATE INDEX IF NOT EXISTS creative_graph_snapshots_project_idx ON creative_graph_snapshots(project_id,revision DESC);
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id TEXT NOT NULL REFERENCES users(id),
      project_id TEXT,
      event_type TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS audit_owner_idx ON audit_events(owner_id, id DESC);
    CREATE TABLE IF NOT EXISTS timelines (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      project_id TEXT REFERENCES projects(id),
      name TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      timeline_json TEXT NOT NULL,
      otio_json TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      archived_at TEXT
    );
    CREATE INDEX IF NOT EXISTS timelines_owner_idx ON timelines(owner_id,updated_at DESC);
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      asset_id TEXT REFERENCES assets(id),
      reviewer_id TEXT REFERENCES users(id),
      version INTEGER NOT NULL DEFAULT 1,
      timecode_seconds REAL,
      decision TEXT NOT NULL DEFAULT 'comment' CHECK(decision IN ('comment','approve','request_changes')),
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','dismissed')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS reviews_project_created_idx ON reviews(project_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS consents (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      project_id TEXT REFERENCES projects(id),
      subject_label TEXT NOT NULL,
      consent_type TEXT NOT NULL,
      evidence_reference TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS video_pipeline_checkpoints (
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      pipeline_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('succeeded')),
      input_asset_id TEXT NOT NULL,
      input_sha256 TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      output_json TEXT NOT NULL,
      approval_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY(owner_id,pipeline_id,step_id)
    );
    CREATE INDEX IF NOT EXISTS video_pipeline_project_idx ON video_pipeline_checkpoints(owner_id,project_id,pipeline_id);
    CREATE TABLE IF NOT EXISTS transformation_plans(
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_asset_id TEXT NOT NULL REFERENCES assets(id), operation TEXT NOT NULL, prompt TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 1 AND 30),
      reference_asset_ids_json TEXT NOT NULL DEFAULT '[]', preservation_json TEXT NOT NULL DEFAULT '[]',
      rights_confirmed INTEGER NOT NULL CHECK(rights_confirmed IN (0,1)),
      subject_consent_confirmed INTEGER NOT NULL CHECK(subject_consent_confirmed IN (0,1)),
      status TEXT NOT NULL CHECK(status IN ('draft','approved','queued','running','succeeded','failed','cancelled')),
      idempotency_key TEXT NOT NULL, approval_id TEXT, estimated_cost_micros INTEGER, approved_budget_micros INTEGER,
      currency TEXT, adapter_id TEXT, capability TEXT, approved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(owner_id,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS transformation_plans_project_idx ON transformation_plans(project_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS control_remediation_actions (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      finding_id TEXT NOT NULL,
      control_id TEXT NOT NULL,
      title TEXT NOT NULL,
      severity TEXT NOT NULL,
      assigned_owner_id TEXT REFERENCES users(id),
      reviewer_id TEXT REFERENCES users(id),
      due_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('unassigned','open','in_progress','pending_review','verified','reopened')),
      action_plan TEXT NOT NULL DEFAULT '',
      verified_at TEXT,
      verified_by TEXT REFERENCES users(id),
      reopened_count INTEGER NOT NULL DEFAULT 0 CHECK(reopened_count >= 0),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(owner_id,project_id,finding_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS control_remediation_project_finding_unique ON control_remediation_actions(project_id,finding_id) WHERE project_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS control_remediation_personal_finding_unique ON control_remediation_actions(owner_id,finding_id) WHERE project_id IS NULL;
    CREATE INDEX IF NOT EXISTS control_remediation_owner_idx ON control_remediation_actions(owner_id,status,due_at);
    CREATE INDEX IF NOT EXISTS control_remediation_project_idx ON control_remediation_actions(project_id,status,due_at);
    CREATE TABLE IF NOT EXISTS control_remediation_evidence (
      id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL REFERENCES control_remediation_actions(id) ON DELETE CASCADE,
      submitted_by TEXT NOT NULL REFERENCES users(id),
      label TEXT NOT NULL,
      evidence_uri TEXT,
      sha256 TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('source','workpaper','approval','test','other')),
      captured_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS control_remediation_evidence_action_idx ON control_remediation_evidence(action_id,created_at);
    CREATE TABLE IF NOT EXISTS control_remediation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_id TEXT NOT NULL REFERENCES control_remediation_actions(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL REFERENCES users(id),
      event_type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      note TEXT NOT NULL DEFAULT '',
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS control_remediation_history_action_idx ON control_remediation_history(action_id,id);
  `);
  const jobColumns = new Set(db.prepare("PRAGMA table_info(jobs)").all().map(column => column.name));
  for (const [name, definition] of [
    ["available_at", "TEXT"],
    ["lease_owner", "TEXT"],
    ["lease_expires_at", "TEXT"],
    ["lease_heartbeat_at", "TEXT"]
  ]) {
    if (!jobColumns.has(name)) db.exec("ALTER TABLE jobs ADD COLUMN " + name + " " + definition);
  }
  db.exec("CREATE INDEX IF NOT EXISTS jobs_available_idx ON jobs(status, available_at, created_at)");
  return db;
}

export function json(value) { return JSON.stringify(value ?? {}); }
export function parseJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}
export function audit(db, ownerId, type, subjectType, subjectId, details = {}, projectId = null) {
  db.prepare("INSERT INTO audit_events(owner_id,project_id,event_type,subject_type,subject_id,details_json) VALUES(?,?,?,?,?,?)")
    .run(ownerId, projectId, type, subjectType, subjectId, json(details));
}
export function addJobEvent(db, jobId, ownerId, type, details = {}) {
  db.prepare("INSERT INTO job_events(job_id,owner_id,event_type,event_json) VALUES(?,?,?,?)")
    .run(jobId, ownerId, type, json(details));
}
export function recordModelUsage(db, {
  ownerId, projectId = null, jobId = null, workflowRunId = null, nodeId = null,
  provider, capability, model, usage = null, durationMs = 0
}) {
  if (!ownerId || !provider || !capability || !model) throw new Error("Model usage requires owner, provider, capability and model identifiers.");
  const integer = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.min(2147483647, Math.floor(Number(value))) : null;
  const promptTokens = integer(usage?.promptTokens ?? usage?.inputTokens);
  const completionTokens = integer(usage?.completionTokens ?? usage?.outputTokens);
  const totalTokens = integer(usage?.totalTokens) ?? (promptTokens !== null || completionTokens !== null ? (promptTokens || 0) + (completionTokens || 0) : null);
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO model_usage_events(id,owner_id,project_id,job_id,workflow_run_id,node_id,provider,capability,model,prompt_tokens,completion_tokens,total_tokens,duration_ms,estimated_cost_micros) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)")
    .run(id, ownerId, projectId, jobId, workflowRunId, nodeId, String(provider).slice(0,80), String(capability).slice(0,80), String(model).slice(0,160), promptTokens, completionTokens, totalTokens, integer(durationMs) ?? 0);
  return { id, promptTokens, completionTokens, totalTokens, estimatedCost: null };
}

export function getOwnedProject(db, ownerId, projectId) {
  return db.prepare("SELECT * FROM projects WHERE id=? AND owner_id=? AND archived_at IS NULL").get(projectId, ownerId);
}
export function getOwnedAsset(db, ownerId, assetId) {
  return db.prepare("SELECT * FROM assets WHERE id=? AND owner_id=? AND deleted_at IS NULL").get(assetId, ownerId);
}

export function getProjectAccess(db,userId,projectId){
  const project=db.prepare("SELECT * FROM projects WHERE id=? AND archived_at IS NULL").get(projectId);
  if(!project)return null;
  if(project.owner_id===userId)return {...project,access_role:"owner"};
  const membership=db.prepare("SELECT role FROM project_members WHERE project_id=? AND member_id=?").get(projectId,userId);
  return membership?{...project,access_role:membership.role}:null;
}
export function canWriteProject(db,userId,projectId){
  const access=getProjectAccess(db,userId,projectId);
  return !!access&&["owner","editor"].includes(access.access_role);
}
export function getAccessibleAsset(db,userId,assetId,write=false){
  const asset=db.prepare("SELECT * FROM assets WHERE id=? AND deleted_at IS NULL").get(assetId);
  if(!asset)return null;
  if(!asset.project_id)return asset.owner_id===userId?asset:null;
  const access=getProjectAccess(db,userId,asset.project_id);
  if(!access||write&&!["owner","editor"].includes(access.access_role))return null;
  return asset;
}
