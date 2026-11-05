import { randomUUID } from "node:crypto";

const fail = (message, code = "RUNWAY_APPROVAL_INVALID") => Object.assign(new Error(message), { code });
const HEX_256 = /^[a-f0-9]{64}$/;
const STATES = new Set(["pending_approval", "approved", "consumed", "revoked", "expired"]);
const MAX_TTL_MS = 30 * 60 * 1000;

export function ensureRunwayRouterApprovalSchema(db) {
  if (!db || typeof db.exec !== "function") throw new Error("Runway approval ledger requires the application database.");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runway_router_approvals (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      config_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_hash TEXT NOT NULL CHECK(length(input_hash)=64),
      estimated_credits INTEGER NOT NULL CHECK(estimated_credits >= 0),
      max_estimated_credits INTEGER NOT NULL CHECK(max_estimated_credits >= 0),
      state TEXT NOT NULL CHECK(state IN ('pending_approval','approved','consumed','revoked','expired')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      approved_by TEXT REFERENCES users(id),
      approved_at TEXT,
      consumed_by TEXT REFERENCES users(id),
      consumed_at TEXT,
      revoked_by TEXT REFERENCES users(id),
      revoked_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS runway_router_approval_owner_idx
      ON runway_router_approvals(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS runway_router_approval_state_idx
      ON runway_router_approvals(state, expires_at);
    CREATE INDEX IF NOT EXISTS runway_router_approval_project_idx
      ON runway_router_approvals(project_id, created_at DESC);
  `);
}

function view(row) {
  if (!row) return null;
  let metadata = {};
  try { metadata = JSON.parse(row.metadata_json || "{}"); } catch {}
  return Object.freeze({
    id: row.id, ownerId: row.owner_id, projectId: row.project_id,
    configId: row.config_id, provider: row.provider, model: row.model,
    inputHash: row.input_hash, estimatedCredits: row.estimated_credits,
    maxEstimatedCredits: row.max_estimated_credits, state: row.state,
    createdAt: row.created_at, expiresAt: row.expires_at,
    approvedBy: row.approved_by, approvedAt: row.approved_at,
    consumedBy: row.consumed_by, consumedAt: row.consumed_at,
    revokedBy: row.revoked_by, revokedAt: row.revoked_at, metadata
  });
}

function required(value, name, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw fail(name + " is required and must be bounded.");
  }
  return value.trim();
}

/**
 * Durable approval boundary for a Runway Model Router dry-run decision.
 * This ledger does not submit provider tasks or reserve financial funds.
 */
export function createRunwayRouterApprovalLedger({
  db, authorizeProject = () => false, authorizeApproval = () => false,
  authorizeExecution = () => false, now = () => new Date()
} = {}) {
  ensureRunwayRouterApprovalSchema(db);
  for (const [name, fn] of Object.entries({ authorizeProject, authorizeApproval, authorizeExecution, now })) {
    if (typeof fn !== "function") throw new TypeError(name + " must be a function.");
  }

  const get = id => view(db.prepare("SELECT * FROM runway_router_approvals WHERE id=?").get(id));
  const transact = fn => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  };

  function assertScope(ownerId, projectId, actorId, authorizer, code) {
    if (!authorizer({ ownerId, projectId, actorId })) throw fail("The actor is not authorized for this project approval.", code);
  }

  return Object.freeze({
    recordPreflight({
      ownerId, projectId, actorId, decision, maxEstimatedCredits, ttlMs = 15 * 60 * 1000, metadata = {}
    } = {}) {
      required(ownerId, "ownerId"); required(projectId, "projectId"); required(actorId, "actorId");
      if (!decision || typeof decision !== "object" || Array.isArray(decision) ||
          decision.dryRun !== true || decision.taskCreated !== false || decision.billed !== false ||
          decision.budgetCheck !== "within_limit") {
        throw fail("Only a successful, non-billable dry-run decision within an explicit ceiling can be recorded.", "RUNWAY_APPROVAL_PREFLIGHT_REQUIRED");
      }
      const configId = required(decision.configId, "configId", 64);
      const provider = required(decision.provider, "provider", 80);
      const model = required(decision.model, "model", 120);
      const inputHash = required(decision.inputHash, "inputHash", 64);
      if (!HEX_256.test(inputHash)) throw fail("Preflight input fingerprint is invalid.", "RUNWAY_APPROVAL_HASH_INVALID");
      if (!Number.isSafeInteger(decision.estimatedCredits) || decision.estimatedCredits < 0 ||
          !Number.isSafeInteger(maxEstimatedCredits) || maxEstimatedCredits < 0 ||
          decision.estimatedCredits > maxEstimatedCredits) {
        throw fail("The router estimate must fit within a valid approved credit ceiling.", "RUNWAY_APPROVAL_BUDGET_INVALID");
      }
      if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_TTL_MS) {
        throw fail("Approval lifetime must be between one second and thirty minutes.", "RUNWAY_APPROVAL_TTL_INVALID");
      }
      assertScope(ownerId, projectId, actorId, authorizeProject, "RUNWAY_APPROVAL_PROJECT_FORBIDDEN");
      const created = now();
      if (!(created instanceof Date) || !Number.isFinite(created.getTime())) throw fail("Approval clock returned an invalid timestamp.");
      const createdAt = created.toISOString();
      const expiresAt = new Date(created.getTime() + ttlMs).toISOString();
      const id = randomUUID();
      const safeMetadata = metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? JSON.stringify(metadata) : "{}";
      db.prepare(`INSERT INTO runway_router_approvals
        (id,owner_id,project_id,config_id,provider,model,input_hash,estimated_credits,
         max_estimated_credits,state,created_at,expires_at,metadata_json)
        VALUES(?,?,?,?,?,?,?,?,?,'pending_approval',?,?,?)`)
        .run(id, ownerId, projectId, configId, provider, model, inputHash,
          decision.estimatedCredits, maxEstimatedCredits, createdAt, expiresAt, safeMetadata);
      return get(id);
    },

    approve({ approvalId, ownerId, projectId, actorId, inputHash } = {}) {
      required(approvalId, "approvalId"); required(ownerId, "ownerId");
      required(projectId, "projectId"); required(actorId, "actorId");
      if (typeof inputHash !== "string" || !HEX_256.test(inputHash)) throw fail("Approval must repeat the exact preflight input fingerprint.", "RUNWAY_APPROVAL_HASH_INVALID");
      const result = transact(() => {
        const row = db.prepare("SELECT * FROM runway_router_approvals WHERE id=?").get(approvalId);
        if (!row || row.owner_id !== ownerId || row.project_id !== projectId) throw fail("Approval record was not found in this project scope.", "RUNWAY_APPROVAL_NOT_FOUND");
        assertScope(ownerId, projectId, actorId, authorizeApproval, "RUNWAY_APPROVAL_ACTOR_FORBIDDEN");
        if (row.input_hash !== inputHash) throw fail("Approval fingerprint does not match the recorded preflight.", "RUNWAY_APPROVAL_HASH_MISMATCH");
        const current = now();
        if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw fail("Approval clock returned an invalid timestamp.");
        if (Date.parse(row.expires_at) <= current.getTime()) {
          db.prepare("UPDATE runway_router_approvals SET state='expired' WHERE id=? AND state='pending_approval'").run(approvalId);
          return { expired: true };
        }
        const changed = db.prepare(`UPDATE runway_router_approvals
          SET state='approved',approved_by=?,approved_at=?
          WHERE id=? AND state='pending_approval' AND input_hash=?`)
          .run(actorId, current.toISOString(), approvalId, inputHash);
        if (changed.changes !== 1) throw fail("Approval is no longer pending and cannot be replayed.", "RUNWAY_APPROVAL_STATE_INVALID");
        return { record: get(approvalId) };
      });
      if (result.expired) throw fail("The preflight approval window has expired; run a fresh preflight.", "RUNWAY_APPROVAL_EXPIRED");
      return result.record;
    },

    consume({ approvalId, ownerId, projectId, actorId, inputHash } = {}) {
      required(approvalId, "approvalId"); required(ownerId, "ownerId");
      required(projectId, "projectId"); required(actorId, "actorId");
      if (typeof inputHash !== "string" || !HEX_256.test(inputHash)) throw fail("Execution must provide the approved request fingerprint.", "RUNWAY_APPROVAL_HASH_INVALID");
      const result = transact(() => {
        const row = db.prepare("SELECT * FROM runway_router_approvals WHERE id=?").get(approvalId);
        if (!row || row.owner_id !== ownerId || row.project_id !== projectId) throw fail("Approval record was not found in this project scope.", "RUNWAY_APPROVAL_NOT_FOUND");
        assertScope(ownerId, projectId, actorId, authorizeExecution, "RUNWAY_APPROVAL_EXECUTOR_FORBIDDEN");
        if (row.input_hash !== inputHash) throw fail("Execution fingerprint differs from the approved preflight.", "RUNWAY_APPROVAL_HASH_MISMATCH");
        const current = now();
        if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw fail("Approval clock returned an invalid timestamp.");
        if (Date.parse(row.expires_at) <= current.getTime()) {
          db.prepare("UPDATE runway_router_approvals SET state='expired' WHERE id=? AND state='approved'").run(approvalId);
          return { expired: true };
        }
        const changed = db.prepare(`UPDATE runway_router_approvals
          SET state='consumed',consumed_by=?,consumed_at=?
          WHERE id=? AND state='approved' AND input_hash=?`)
          .run(actorId, current.toISOString(), approvalId, inputHash);
        if (changed.changes !== 1) throw fail("Approval has already been consumed or is not approved.", "RUNWAY_APPROVAL_STATE_INVALID");
        return { record: get(approvalId) };
      });
      if (result.expired) throw fail("The approved preflight has expired; approval cannot authorize execution.", "RUNWAY_APPROVAL_EXPIRED");
      return result.record;
    },

    revoke({ approvalId, ownerId, projectId, actorId } = {}) {
      required(approvalId, "approvalId"); required(ownerId, "ownerId");
      required(projectId, "projectId"); required(actorId, "actorId");
      return transact(() => {
        const row = db.prepare("SELECT * FROM runway_router_approvals WHERE id=?").get(approvalId);
        if (!row || row.owner_id !== ownerId || row.project_id !== projectId) throw fail("Approval record was not found in this project scope.", "RUNWAY_APPROVAL_NOT_FOUND");
        assertScope(ownerId, projectId, actorId, authorizeApproval, "RUNWAY_APPROVAL_ACTOR_FORBIDDEN");
        const current = now();
        const changed = db.prepare(`UPDATE runway_router_approvals
          SET state='revoked',revoked_by=?,revoked_at=?
          WHERE id=? AND state IN ('pending_approval','approved')`)
          .run(actorId, current.toISOString(), approvalId);
        if (changed.changes !== 1) throw fail("Only pending or approved records can be revoked.", "RUNWAY_APPROVAL_STATE_INVALID");
        return get(approvalId);
      });
    },

    get,
    listForProject({ ownerId, projectId, limit = 50 } = {}) {
      required(ownerId, "ownerId"); required(projectId, "projectId");
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw fail("Approval history limit is invalid.");
      return db.prepare(`SELECT * FROM runway_router_approvals
        WHERE owner_id=? AND project_id=? ORDER BY created_at DESC LIMIT ?`)
        .all(ownerId, projectId, limit).map(view);
    }
  });
}
