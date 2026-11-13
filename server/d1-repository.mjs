import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const json = value => JSON.stringify(value);
const parse = value => value ? JSON.parse(value) : {};
const validUuid = (value, label) => {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(label + " must be a UUID.");
  return value;
};
const isoNow = () => new Date().toISOString();

function mapProject(row) {
  return {
    id: row.id, ownerId: row.owner_id, name: row.name,
    description: row.description, settings: parse(row.settings_json),
    revision: Number(row.revision), createdAt: row.created_at,
    updatedAt: row.updated_at, archivedAt: row.archived_at || null
  };
}
function mapAsset(row) {
  return {
    id: row.id, ownerId: row.owner_id, projectId: row.project_id || null,
    name: row.original_name, mediaType: row.media_type, size: Number(row.byte_size),
    sha256: row.sha256, storageProvider: row.storage_provider, storageKey: row.storage_key,
    derivativeOf: row.derivative_of || null, metadata: parse(row.metadata_json),
    provenance: row.provenance_json ? parse(row.provenance_json) : null,
    createdAt: row.created_at
  };
}

function mapJob(row) {
  return {
    id: row.id, ownerId: row.owner_id, projectId: row.project_id || null,
    jobType: row.job_type, status: row.status, progress: Number(row.progress),
    input: parse(row.input_json), output: row.output_json ? parse(row.output_json) : null,
    error: row.error_json ? parse(row.error_json) : null,
    idempotencyKey: row.idempotency_key || null, attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts), availableAt: row.available_at || null,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at || null
  };
}
function mapAuditEvent(row) {
  return {
    id: Number(row.id), ownerId: row.owner_id, projectId: row.project_id || null,
    eventType: row.event_type, subjectType: row.subject_type, subjectId: row.subject_id,
    details: parse(row.details_json), createdAt: row.created_at
  };
}

export function createD1Repository({ db, id = randomUUID, clock = isoNow, allowR2 = false } = {}) {
  if (!db || typeof db.prepare !== "function") throw new Error("D1 repository requires a Cloudflare D1 database binding.");
  if (typeof id !== "function" || typeof clock !== "function") throw new Error("D1 repository requires valid ID and clock functions.");

  async function projectAccess(actorId, projectId) {
    return db.prepare(`
      SELECT p.*, CASE WHEN p.owner_id = ? THEN 'owner' ELSE m.role END AS actor_role
      FROM ev_projects p
      LEFT JOIN ev_project_members m ON m.project_id = p.id AND m.member_id = ?
      WHERE p.id = ? AND p.archived_at IS NULL
        AND (p.owner_id = ? OR m.member_id = ?)
      LIMIT 1
    `).bind(actorId, actorId, projectId, actorId, actorId).first();
  }

  return Object.freeze({
    async resolvePrincipal({ subject, provider, email = null } = {}) {
      if (typeof subject !== "string" || !subject.trim() || subject.length > 255) throw new Error("Verified identity subject is required.");
      if (typeof provider !== "string" || !/^[a-z0-9._-]{1,40}$/i.test(provider)) throw new Error("Identity provider name is invalid.");
      if (email !== null && (typeof email !== "string" || email.length > 320)) throw new Error("Account email is invalid.");
      const timestamp = clock();
      const row = await db.prepare(`
        INSERT INTO ev_users (id, auth_subject, auth_provider, email, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(auth_provider, auth_subject) DO UPDATE SET
          email = excluded.email, auth_provider = excluded.auth_provider, updated_at = excluded.updated_at
        RETURNING id, auth_subject, auth_provider, email, created_at, updated_at
      `).bind(id(), subject.trim(), provider, email, timestamp, timestamp).first();
      if (!row || row.auth_subject !== subject.trim() || row.auth_provider !== provider) throw new Error("D1 principal resolution returned an invalid identity.");
      return { id: row.id, subject: row.auth_subject, provider: row.auth_provider, email: row.email, createdAt: row.created_at, updatedAt: row.updated_at };
    },

    async createProject({ ownerId, name, description = "", settings = {} } = {}) {
      validUuid(ownerId, "Owner ID");
      if (typeof name !== "string" || !name.trim() || name.trim().length > 160) throw new Error("Project name must contain 1–160 characters.");
      if (typeof description !== "string" || description.length > 4000) throw new Error("Project description is too long.");
      if (!object(settings)) throw new Error("Project settings must be an object.");
      const timestamp = clock(), projectId = id();
      const inserted = await db.batch([
        db.prepare(`
          INSERT INTO ev_projects (id, owner_id, name, description, settings_json, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        `).bind(projectId, ownerId, name.trim(), description, json(settings), timestamp, timestamp),
        db.prepare(`
          INSERT INTO ev_project_workspace_documents (project_id, revision, document_json, updated_at)
          VALUES (?, 1, '{}', ?)
        `).bind(projectId, timestamp)
      ]);
      if (!Array.isArray(inserted) || inserted.length !== 2 || inserted.some(result => result?.success === false)) {
        throw new Error("D1 project and workspace initialization did not complete atomically.");
      }
      const row = await db.prepare("SELECT * FROM ev_projects WHERE id = ? AND owner_id = ? LIMIT 1").bind(projectId, ownerId).first();
      if (!row) throw new Error("D1 project creation returned an invalid record.");
      return mapProject(row);
    },

    async listProjects({ actorId, limit = 50, offset = 0 } = {}) {
      validUuid(actorId, "Actor ID");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Project page size must be between 1 and 100.");
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new Error("Project offset is invalid.");
      const result = await db.prepare(`
        SELECT p.* FROM ev_projects p
        LEFT JOIN ev_project_members m ON m.project_id = p.id AND m.member_id = ?
        WHERE p.archived_at IS NULL AND (p.owner_id = ? OR m.member_id = ?)
        ORDER BY p.updated_at DESC, p.id ASC LIMIT ? OFFSET ?
      `).bind(actorId, actorId, actorId, limit, offset).all();
      return (result.results || []).map(mapProject);
    },

    async getProject({ actorId, projectId } = {}) {
      validUuid(actorId, "Actor ID"); validUuid(projectId, "Project ID");
      const row = await projectAccess(actorId, projectId);
      return row ? mapProject(row) : null;
    },

    async updateProject({ actorId, projectId, expectedRevision, name, description, settings } = {}) {
      validUuid(actorId, "Actor ID"); validUuid(projectId, "Project ID");
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("Expected project revision is invalid.");
      const current = await projectAccess(actorId, projectId);
      if (!current) { const error = new Error("Project not found."); error.code = "D1_PROJECT_NOT_FOUND"; throw error; }
      if (current.actor_role === "viewer" || current.actor_role === "reviewer") { const error = new Error("Project is read-only for this member."); error.code = "D1_PROJECT_ACCESS_DENIED"; throw error; }
      if (Number(current.revision) !== expectedRevision) { const error = new Error("Project revision changed."); error.code = "D1_PROJECT_REVISION_CONFLICT"; throw error; }
      const patch = { name: current.name, description: current.description, settings: parse(current.settings_json) };
      if (name !== undefined) { if (typeof name !== "string" || !name.trim() || name.trim().length > 160) throw new Error("Project name must contain 1–160 characters."); patch.name = name.trim(); }
      if (description !== undefined) { if (typeof description !== "string" || description.length > 4000) throw new Error("Project description is too long."); patch.description = description; }
      if (settings !== undefined) { if (!object(settings)) throw new Error("Project settings must be an object."); patch.settings = settings; }
      const row = await db.prepare(`
        UPDATE ev_projects SET name = ?, description = ?, settings_json = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND archived_at IS NULL
          AND (owner_id = ? OR EXISTS (
            SELECT 1 FROM ev_project_members m WHERE m.project_id = ev_projects.id
              AND m.member_id = ? AND m.role = 'editor'
          ))
        RETURNING *
      `).bind(patch.name, patch.description, json(patch.settings), clock(), projectId, expectedRevision, actorId, actorId).first();
      if (!row) { const error = new Error("Project revision changed or write access was revoked."); error.code = "D1_PROJECT_REVISION_CONFLICT"; throw error; }
      return mapProject(row);
    },

    async getWorkspaceDocument({ actorId, projectId } = {}) {
      validUuid(actorId, "Actor ID"); validUuid(projectId, "Project ID");
      const access = await projectAccess(actorId, projectId);
      if (!access) { const error = new Error("Project not found."); error.code = "D1_PROJECT_NOT_FOUND"; throw error; }
      const row = await db.prepare("SELECT revision, document_json, updated_at FROM ev_project_workspace_documents WHERE project_id = ? LIMIT 1").bind(projectId).first();
      if (!row) throw new Error("Project workspace document is missing.");
      return { document: parse(row.document_json), revision: Number(row.revision), updatedAt: row.updated_at };
    },

    async updateWorkspaceDocument({ actorId, projectId, expectedRevision, document } = {}) {
      validUuid(actorId, "Actor ID"); validUuid(projectId, "Project ID");
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("Expected workspace revision is invalid.");
      if (!object(document) || json(document).length > 256 * 1024) throw new Error("Workspace document must be an object no larger than 256 KB.");
      const access = await projectAccess(actorId, projectId);
      if (!access) { const error = new Error("Project not found."); error.code = "D1_PROJECT_NOT_FOUND"; throw error; }
      if (access.actor_role === "viewer" || access.actor_role === "reviewer") { const error = new Error("Project workspace is read-only for this member."); error.code = "D1_PROJECT_ACCESS_DENIED"; throw error; }
      const row = await db.prepare(`
        UPDATE ev_project_workspace_documents
        SET document_json = ?, revision = revision + 1, updated_at = ?
        WHERE project_id = ? AND revision = ?
        RETURNING revision, document_json, updated_at
      `).bind(json(document), clock(), projectId, expectedRevision).first();
      if (!row) { const error = new Error("Workspace revision changed."); error.code = "D1_PROJECT_REVISION_CONFLICT"; throw error; }
      return { document: parse(row.document_json), revision: Number(row.revision), updatedAt: row.updated_at };
    },

    async addMember({ actorId, projectId, memberId, role } = {}) {
      validUuid(actorId, "Actor ID"); validUuid(projectId, "Project ID"); validUuid(memberId, "Member ID");
      if (!["editor", "reviewer", "viewer"].includes(role)) throw new Error("Project member role is invalid.");
      const project = await projectAccess(actorId, projectId);
      if (!project || project.owner_id !== actorId) { const error = new Error("Only the project owner can manage members."); error.code = "D1_PROJECT_ACCESS_DENIED"; throw error; }
      if (memberId === actorId) throw new Error("Project owner is implicit and cannot be added as a member.");
      const member = await db.prepare("SELECT id FROM ev_users WHERE id = ? LIMIT 1").bind(memberId).first();
      if (!member) throw new Error("Project member must have a previously verified account.");
      await db.prepare(`
        INSERT INTO ev_project_members (project_id, member_id, role, invited_by, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id, member_id) DO UPDATE SET role = excluded.role
      `).bind(projectId, memberId, role, actorId, clock()).run();
      return { projectId, memberId, role };
    },

    async addMemberByEmail({ actorId, projectId, email, role } = {}) {
      validUuid(actorId, "Actor ID"); validUuid(projectId, "Project ID");
      if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new Error("A valid existing account email is required.");
      if (!["editor", "reviewer", "viewer"].includes(role)) throw new Error("Project member role is invalid.");
      const project = await projectAccess(actorId, projectId);
      if (!project || project.owner_id !== actorId) { const error = new Error("Only the project owner can manage members."); error.code = "D1_PROJECT_ACCESS_DENIED"; throw error; }
      const matches = await db.prepare("SELECT id FROM ev_users WHERE lower(email) = ? ORDER BY created_at ASC LIMIT 2").bind(email.trim().toLowerCase()).all();
      const rows = matches.results || [];
      if (!rows.length) { const error = new Error("The collaborator must sign in to the staging workspace before they can be added."); error.code = "D1_MEMBER_NOT_FOUND"; throw error; }
      if (rows.length > 1) { const error = new Error("More than one verified account uses this email; invite by account identity after resolving the duplicate."); error.code = "D1_MEMBER_AMBIGUOUS"; throw error; }
      const memberId = rows[0].id;
      if (memberId === actorId) throw new Error("Project owner is implicit and cannot be added as a member.");
      await db.prepare(`
        INSERT INTO ev_project_members (project_id, member_id, role, invited_by, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id, member_id) DO UPDATE SET role = excluded.role
      `).bind(projectId, memberId, role, actorId, clock()).run();
      return { projectId, memberId, email: email.trim().toLowerCase(), role };
    },

    async listMembers({ actorId, projectId } = {}) {
      validUuid(actorId, "Actor ID"); validUuid(projectId, "Project ID");
      const project = await projectAccess(actorId, projectId);
      if (!project) { const error = new Error("Project not found."); error.code = "D1_PROJECT_NOT_FOUND"; throw error; }
      const [owner, members] = await Promise.all([
        db.prepare("SELECT id, email FROM ev_users WHERE id = ? LIMIT 1").bind(project.owner_id).first(),
        db.prepare(`
          SELECT m.member_id, u.email, m.role, m.created_at, m.invited_by
          FROM ev_project_members m JOIN ev_users u ON u.id = m.member_id
          WHERE m.project_id = ? ORDER BY m.created_at ASC, m.member_id ASC
        `).bind(projectId).all()
      ]);
      return {
        canManageMembers: project.owner_id === actorId,
        members: [
          { memberId: project.owner_id, email: owner?.email || null, role: "owner", createdAt: project.created_at, invitedBy: null },
          ...(members.results || []).map(row => ({ memberId: row.member_id, email: row.email || null, role: row.role, createdAt: row.created_at, invitedBy: row.invited_by }))
        ]
      };
    },

    async removeMember({ actorId, projectId, memberId } = {}) {
      validUuid(actorId, "Actor ID"); validUuid(projectId, "Project ID"); validUuid(memberId, "Member ID");
      const project = await projectAccess(actorId, projectId);
      if (!project || project.owner_id !== actorId) { const error = new Error("Only the project owner can manage members."); error.code = "D1_PROJECT_ACCESS_DENIED"; throw error; }
      if (memberId === actorId) throw new Error("Project owner cannot be removed from their own project.");
      const row = await db.prepare("DELETE FROM ev_project_members WHERE project_id = ? AND member_id = ? RETURNING member_id").bind(projectId, memberId).first();
      if (!row) { const error = new Error("Project member not found."); error.code = "D1_MEMBER_NOT_FOUND"; throw error; }
      return { projectId, memberId: row.member_id, removed: true };
    },

    async createAsset({ actorId, ownerId = actorId, projectId = null, name, mediaType, size, sha256, storageProvider, storageKey, derivativeOf = null, metadata = {}, provenance = null } = {}) {
      validUuid(actorId, "Actor ID");
      if (ownerId !== actorId) throw new Error("Asset owner must be the authenticated actor.");
      if (projectId !== null) validUuid(projectId, "Project ID");
      if (derivativeOf !== null) validUuid(derivativeOf, "Derivative asset ID");
      if (typeof name !== "string" || !name.trim() || name.length > 180) throw new Error("Asset name is invalid.");
      if (typeof mediaType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(mediaType) || mediaType.length > 120) throw new Error("Asset media type is invalid.");
      if (!Number.isSafeInteger(size) || size < 1 || size > 1024 * 1024 * 1024) throw new Error("Asset size is outside the supported range.");
      if (typeof sha256 !== "string" || !SHA256.test(sha256)) throw new Error("Asset SHA-256 checksum is invalid.");
      if (!["r2", "local-staging"].includes(storageProvider) || storageProvider === "r2" && allowR2 !== true) throw new Error("Asset storage provider is not enabled.");
      if (typeof storageKey !== "string" || !/^[A-Za-z0-9/_ .-]{1,512}$/.test(storageKey) || storageKey.startsWith("/") || storageKey.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Asset storage key is invalid.");
      if (!object(metadata) || json(metadata).length > 16000) throw new Error("Asset metadata must be an object no larger than 16 KB.");
      if (provenance !== null && (!object(provenance) || json(provenance).length > 32000)) throw new Error("Asset provenance must be an object no larger than 32 KB.");
      if (projectId) {
        const project = await projectAccess(actorId, projectId);
        if (!project || !["owner", "editor"].includes(project.actor_role)) { const error = new Error("Project asset registration requires owner or editor access."); error.code = "D1_PROJECT_ACCESS_DENIED"; throw error; }
      }
      if (derivativeOf) {
        const source = await db.prepare("SELECT id, owner_id, project_id FROM ev_assets WHERE id = ? AND deleted_at IS NULL LIMIT 1").bind(derivativeOf).first();
        if (!source || source.owner_id !== ownerId || source.project_id !== projectId) throw new Error("Derivative source must belong to the same owner and project.");
      }
      const row = await db.prepare(`
        INSERT INTO ev_assets (id, owner_id, project_id, original_name, media_type, byte_size, sha256, storage_provider, storage_key, derivative_of, metadata_json, provenance_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
      `).bind(id(), ownerId, projectId, name.trim(), mediaType, size, sha256, storageProvider, storageKey, derivativeOf, json(metadata), provenance ? json(provenance) : null, clock()).first();
      if (!row || row.owner_id !== ownerId) throw new Error("D1 asset registration returned an invalid record.");
      return mapAsset(row);
    },


    async createJob({ actorId, projectId = null, jobType, input = {}, idempotencyKey = null, maxAttempts = 2, availableAt = null } = {}) {
      validUuid(actorId, "Actor ID");
      if (projectId !== null) validUuid(projectId, "Project ID");
      if (typeof jobType !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,119}$/i.test(jobType)) throw new Error("Job type must contain 1–120 safe characters.");
      if (!object(input) || json(input).length > 64 * 1024) throw new Error("Job input must be an object no larger than 64 KB.");
      if (idempotencyKey !== null && (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 128)) throw new Error("Idempotency key must contain 1–128 characters.");
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("Maximum attempts must be between 1 and 10.");
      if (availableAt !== null && (typeof availableAt !== "string" || !Number.isFinite(Date.parse(availableAt)))) throw new Error("Job availability time must be a valid ISO timestamp.");
      if (projectId) {
        const project = await projectAccess(actorId, projectId);
        if (!project) { const error = new Error("Project not found."); error.code = "D1_PROJECT_NOT_FOUND"; throw error; }
        if (!["owner", "editor"].includes(project.actor_role)) { const error = new Error("Only project owners and editors can enqueue jobs."); error.code = "D1_PROJECT_ACCESS_DENIED"; throw error; }
      }
      const timestamp = clock(), jobId = id();
      const inserted = await db.prepare(`
        INSERT INTO ev_jobs (id, owner_id, project_id, job_type, status, progress, input_json, idempotency_key, max_attempts, available_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, idempotency_key) DO NOTHING
      `).bind(jobId, actorId, projectId, jobType, json(input), idempotencyKey, maxAttempts, availableAt, timestamp, timestamp).run();
      if (inserted?.success === false) throw new Error("D1 job creation failed.");
      if (idempotencyKey !== null) {
        const existing = await db.prepare("SELECT * FROM ev_jobs WHERE owner_id = ? AND idempotency_key = ? LIMIT 1").bind(actorId, idempotencyKey).first();
        if (!existing) throw new Error("Idempotent D1 job creation returned no record.");
        if (existing.job_type !== jobType || existing.project_id !== projectId || existing.input_json !== json(input)) {
          const error = new Error("The idempotency key is already associated with a different job request.");
          error.code = "D1_IDEMPOTENCY_CONFLICT";
          throw error;
        }
        return { job: mapJob(existing), created: existing.id === jobId };
      }
      const row = await db.prepare("SELECT * FROM ev_jobs WHERE id = ? AND owner_id = ? LIMIT 1").bind(jobId, actorId).first();
      if (!row) throw new Error("D1 job creation returned no record.");
      return { job: mapJob(row), created: true };
    },

    async listJobs({ actorId, projectId = undefined, limit = 50, offset = 0 } = {}) {
      validUuid(actorId, "Actor ID");
      if (projectId !== undefined && projectId !== null) validUuid(projectId, "Project ID");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Job page size must be between 1 and 100.");
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new Error("Job offset is invalid.");
      const rows = await db.prepare(`
        SELECT j.* FROM ev_jobs j
        LEFT JOIN ev_project_members m ON m.project_id = j.project_id AND m.member_id = ?
        WHERE (j.owner_id = ? OR m.member_id = ?)
          AND (? IS NULL OR j.project_id = ?)
        ORDER BY j.created_at DESC, j.id ASC LIMIT ? OFFSET ?
      `).bind(actorId, actorId, actorId, projectId ?? null, projectId ?? null, limit, offset).all();
      return (rows.results || []).map(mapJob);
    },

    async getJob({ actorId, jobId } = {}) {
      validUuid(actorId, "Actor ID"); validUuid(jobId, "Job ID");
      const row = await db.prepare(`
        SELECT j.* FROM ev_jobs j
        LEFT JOIN ev_project_members m ON m.project_id = j.project_id AND m.member_id = ?
        WHERE j.id = ? AND (j.owner_id = ? OR m.member_id = ?) LIMIT 1
      `).bind(actorId, jobId, actorId, actorId).first();
      return row ? mapJob(row) : null;
    },

    async appendAuditEvent({ actorId, projectId = null, eventType, subjectType, subjectId, details = {} } = {}) {
      validUuid(actorId, "Actor ID");
      if (projectId !== null) validUuid(projectId, "Project ID");
      if (typeof eventType !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,119}$/i.test(eventType)) throw new Error("Audit event type must contain 1–120 safe characters.");
      if (typeof subjectType !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,79}$/i.test(subjectType)) throw new Error("Audit subject type must contain 1–80 safe characters.");
      if (typeof subjectId !== "string" || !subjectId.trim() || subjectId.length > 180) throw new Error("Audit subject ID must contain 1–180 characters.");
      if (!object(details) || json(details).length > 16 * 1024) throw new Error("Audit details must be an object no larger than 16 KB.");
      if (projectId) {
        const project = await projectAccess(actorId, projectId);
        if (!project) { const error = new Error("Project not found."); error.code = "D1_PROJECT_NOT_FOUND"; throw error; }
        if (!["owner", "editor"].includes(project.actor_role)) { const error = new Error("Only project owners and editors can append audit events."); error.code = "D1_PROJECT_ACCESS_DENIED"; throw error; }
      }
      const result = await db.prepare(`
        INSERT INTO ev_audit_events (owner_id, project_id, event_type, subject_type, subject_id, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *
      `).bind(actorId, projectId, eventType, subjectType, subjectId, json(details), clock()).first();
      if (!result || result.owner_id !== actorId) throw new Error("D1 audit event append returned an invalid record.");
      return mapAuditEvent(result);
    },

    async listAuditEvents({ actorId, projectId = undefined, limit = 50, offset = 0 } = {}) {
      validUuid(actorId, "Actor ID");
      if (projectId !== undefined && projectId !== null) validUuid(projectId, "Project ID");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Audit page size must be between 1 and 100.");
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new Error("Audit offset is invalid.");
      if (projectId) {
        const project = await projectAccess(actorId, projectId);
        if (!project) { const error = new Error("Project not found."); error.code = "D1_PROJECT_NOT_FOUND"; throw error; }
      }
      const rows = await db.prepare(`
        SELECT e.* FROM ev_audit_events e
        LEFT JOIN ev_project_members m ON m.project_id = e.project_id AND m.member_id = ?
        WHERE (e.owner_id = ? OR m.member_id = ?)
          AND (? IS NULL OR e.project_id = ?)
        ORDER BY e.id DESC LIMIT ? OFFSET ?
      `).bind(actorId, actorId, actorId, projectId ?? null, projectId ?? null, limit, offset).all();
      return (rows.results || []).map(mapAuditEvent);
    },

    async listAssets({ actorId, projectId, limit = 50, offset = 0 } = {}) {
      validUuid(actorId, "Actor ID");
      if (projectId !== undefined && projectId !== null) validUuid(projectId, "Project ID");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Asset page size must be between 1 and 100.");
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new Error("Asset offset is invalid.");
      const rows = await db.prepare(`
        SELECT a.* FROM ev_assets a
        LEFT JOIN ev_project_members m ON m.project_id = a.project_id AND m.member_id = ?
        WHERE a.deleted_at IS NULL AND (a.owner_id = ? OR m.member_id = ?)
          AND (? IS NULL OR a.project_id = ?)
        ORDER BY a.created_at DESC, a.id ASC LIMIT ? OFFSET ?
      `).bind(actorId, actorId, actorId, projectId ?? null, projectId ?? null, limit, offset).all();
      return (rows.results || []).map(mapAsset);
    }
  });
}
