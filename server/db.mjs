import { DatabaseSync } from "node:sqlite";
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
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      started_at TEXT,
      completed_at TEXT,
      UNIQUE(owner_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS jobs_owner_idx ON jobs(owner_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id),
      event_type TEXT NOT NULL,
      event_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events(job_id, id);
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
  `);
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
