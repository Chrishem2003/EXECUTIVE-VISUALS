import { randomUUID } from "node:crypto";

const DEFAULT_REMOTE_DAILY_LIMIT = 50;
const MAX_REMOTE_DAILY_LIMIT = 10000;

export function getRemoteUsagePolicy() {
  try { return { valid: true, limit: readLimit() }; }
  catch { return { valid: false, limit: null }; }
}

export function ensureRemoteUsageTable(db) {
  db.exec("CREATE TABLE IF NOT EXISTS remote_usage_reservations (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, project_id TEXT, job_id TEXT, provider TEXT NOT NULL, capability TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))); CREATE INDEX IF NOT EXISTS remote_usage_owner_created_idx ON remote_usage_reservations(owner_id, created_at DESC);");
}
function readLimit(raw = process.env.REMOTE_AI_DAILY_REQUEST_LIMIT) {
  if (raw === undefined || raw === "") return DEFAULT_REMOTE_DAILY_LIMIT;
  if (!/^[0-9]+$/.test(String(raw))) {
    throw Object.assign(new Error("REMOTE_AI_DAILY_REQUEST_LIMIT must be an integer from 0 to 10000."), {
      code: "REMOTE_USAGE_LIMIT_CONFIG_INVALID"
    });
  }
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_REMOTE_DAILY_LIMIT) {
    throw Object.assign(new Error("REMOTE_AI_DAILY_REQUEST_LIMIT must be an integer from 0 to 10000."), {
      code: "REMOTE_USAGE_LIMIT_CONFIG_INVALID"
    });
  }
  return limit;
}

/**
 * Reserve a rolling-24-hour remote request slot before contacting a remote
 * provider. A reservation remains counted if the provider later fails, which
 * is deliberately conservative and avoids retry storms bypassing the cap.
 * Local providers are not limited by this remote-only guardrail.
 */
export function reserveRemoteRequest(db, {
  ownerId, projectId = null, jobId = null, provider, capability,
  limit
}) {
  if (!provider?.remote) return { reserved: false, reason: "local_provider" };
  if (limit === undefined) limit = readLimit();
  if (!ownerId || !provider.provider || !capability) {
    throw Object.assign(new Error("Remote usage reservation requires owner, provider and capability."), {
      code: "REMOTE_USAGE_RESERVATION_INVALID"
    });
  }
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_REMOTE_DAILY_LIMIT) {
    throw Object.assign(new Error("Remote usage limit must be an integer from 0 to 10000."), {
      code: "REMOTE_USAGE_LIMIT_CONFIG_INVALID"
    });
  }
  ensureRemoteUsageTable(db);
  if (limit === 0) {
    throw Object.assign(new Error("Remote AI execution is disabled by the configured request limit."), {
      code: "REMOTE_USAGE_LIMIT_REACHED", limit, window: "rolling_24_hours"
    });
  }
  const id = randomUUID();
  const result = db.prepare(`
    INSERT INTO remote_usage_reservations(id,owner_id,project_id,job_id,provider,capability)
    SELECT ?,?,?,?,?,?
    WHERE (SELECT COUNT(*) FROM remote_usage_reservations
      WHERE owner_id=? AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')) < ?
  `).run(id, ownerId, projectId, jobId, String(provider.provider).slice(0, 80),
    String(capability).slice(0, 80), ownerId, limit);
  if (result.changes !== 1) {
    const used = db.prepare(`SELECT COUNT(*) AS count FROM remote_usage_reservations
      WHERE owner_id=? AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')`).get(ownerId).count;
    throw Object.assign(new Error("Remote AI request limit reached for this account. Try again after earlier reservations leave the rolling 24-hour window."), {
      code: "REMOTE_USAGE_LIMIT_REACHED", limit, used, window: "rolling_24_hours"
    });
  }
  return { reserved: true, reservationId: id, limit, window: "rolling_24_hours" };
}
