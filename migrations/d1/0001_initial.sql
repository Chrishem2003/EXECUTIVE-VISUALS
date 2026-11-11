-- Executive Visuals isolated Cloudflare D1 metadata foundation.
-- This schema is deliberately separate from the existing Supabase/NEMA projects.
-- Apply first to the executive-visuals-staging D1 database only.
-- Authentication remains external: auth_subject is a verified provider subject,
-- never a password, access token, refresh token, or client-supplied identity.
CREATE TABLE IF NOT EXISTS ev_users (
  id TEXT PRIMARY KEY,
  auth_subject TEXT NOT NULL,
  auth_provider TEXT NOT NULL CHECK (length(auth_provider) BETWEEN 1 AND 40),
  email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (auth_provider, auth_subject)
);

CREATE TABLE IF NOT EXISTS ev_projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES ev_users(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json) AND json_type(settings_json) = 'object'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS ev_project_members (
  project_id TEXT NOT NULL REFERENCES ev_projects(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES ev_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('editor','reviewer','viewer')),
  invited_by TEXT NOT NULL REFERENCES ev_users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, member_id)
);

CREATE TABLE IF NOT EXISTS ev_project_workspace_documents (
  project_id TEXT PRIMARY KEY REFERENCES ev_projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  document_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(document_json) AND json_type(document_json) = 'object'),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ev_assets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES ev_users(id),
  project_id TEXT REFERENCES ev_projects(id),
  original_name TEXT NOT NULL CHECK (length(original_name) BETWEEN 1 AND 180),
  media_type TEXT NOT NULL CHECK (length(media_type) BETWEEN 1 AND 120),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  storage_provider TEXT NOT NULL CHECK (storage_provider IN ('r2','local-staging')),
  storage_key TEXT NOT NULL UNIQUE,
  derivative_of TEXT REFERENCES ev_assets(id),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  provenance_json TEXT CHECK (provenance_json IS NULL OR (json_valid(provenance_json) AND json_type(provenance_json) = 'object')),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS ev_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES ev_users(id),
  project_id TEXT REFERENCES ev_projects(id),
  job_type TEXT NOT NULL CHECK (length(job_type) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (status IN ('queued','running','reviewing','succeeded','partial','failed','cancelled','blocked','needs_input')),
  progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  input_json TEXT NOT NULL CHECK (json_valid(input_json) AND json_type(input_json) = 'object'),
  output_json TEXT CHECK (output_json IS NULL OR (json_valid(output_json) AND json_type(output_json) = 'object')),
  error_json TEXT CHECK (error_json IS NULL OR (json_valid(error_json) AND json_type(error_json) = 'object')),
  idempotency_key TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 10),
  available_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(owner_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS ev_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL REFERENCES ev_users(id),
  project_id TEXT REFERENCES ev_projects(id),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 120),
  subject_type TEXT NOT NULL CHECK (length(subject_type) BETWEEN 1 AND 80),
  subject_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json) AND json_type(details_json) = 'object'),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ev_projects_owner_updated ON ev_projects(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ev_members_member_project ON ev_project_members(member_id, project_id);
CREATE INDEX IF NOT EXISTS ev_assets_owner_created ON ev_assets(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ev_assets_project_created ON ev_assets(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ev_jobs_status_available ON ev_jobs(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS ev_jobs_owner_created ON ev_jobs(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ev_audit_owner_created ON ev_audit_events(owner_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS ev_project_owner_immutable
BEFORE UPDATE OF owner_id ON ev_projects
WHEN NEW.owner_id <> OLD.owner_id
BEGIN SELECT RAISE(ABORT, 'project owner is immutable'); END;

CREATE TRIGGER IF NOT EXISTS ev_asset_owner_immutable
BEFORE UPDATE OF owner_id ON ev_assets
WHEN NEW.owner_id <> OLD.owner_id
BEGIN SELECT RAISE(ABORT, 'asset owner is immutable'); END;

CREATE TRIGGER IF NOT EXISTS ev_job_owner_immutable
BEFORE UPDATE OF owner_id ON ev_jobs
WHEN NEW.owner_id <> OLD.owner_id
BEGIN SELECT RAISE(ABORT, 'job owner is immutable'); END;

CREATE TRIGGER IF NOT EXISTS ev_member_cannot_be_project_owner
BEFORE INSERT ON ev_project_members
WHEN NEW.member_id = (SELECT owner_id FROM ev_projects WHERE id = NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'project owner is implicit and must not be duplicated as a member'); END;
