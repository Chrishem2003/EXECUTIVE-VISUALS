import { createHash, randomUUID } from "node:crypto";

const TYPES = new Set(["creative_direction", "storyboard"]);
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const stable = value => Array.isArray(value)
  ? "[" + value.map(stable).join(",") + "]"
  : isObject(value)
    ? "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}"
    : (JSON.stringify(value) ?? "null");
const digest = value => createHash("sha256").update(value, "utf8").digest("hex");
const parse = value => value ? JSON.parse(value) : {};

function mapArtifact(row) {
  return {
    id: row.id, projectId: row.project_id, createdBy: row.created_by,
    type: row.artifact_type, revision: Number(row.revision),
    inputHash: row.input_hash, contentHash: row.content_hash,
    input: parse(row.input_json), content: parse(row.content_json),
    model: row.model || null, usage: parse(row.usage_json),
    createdAt: row.created_at
  };
}

function encode(value, label) {
  if (!isObject(value)) throw Object.assign(new Error(label + " must be a JSON object."), { code: "CREATIVE_ARTIFACT_INVALID" });
  const serialized = stable(value);
  if (Buffer.byteLength(serialized, "utf8") > 512 * 1024) {
    throw Object.assign(new Error(label + " exceeds the 512 KiB artifact limit."), { code: "CREATIVE_ARTIFACT_TOO_LARGE" });
  }
  return serialized;
}

export function saveCreativeProjectArtifact(db, {
  projectId, createdBy, type, input, content, inputHash, model = null, usage = {}
} = {}) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") throw new TypeError("A SQLite-compatible database is required.");
  if (typeof projectId !== "string" || !projectId || typeof createdBy !== "string" || !createdBy) {
    throw Object.assign(new Error("A project and authenticated creator are required."), { code: "CREATIVE_ARTIFACT_PROJECT_REQUIRED" });
  }
  if (!TYPES.has(type)) throw Object.assign(new Error("Unsupported creative project artifact type."), { code: "CREATIVE_ARTIFACT_TYPE_INVALID" });
  if (typeof inputHash !== "string" || !/^[a-f0-9]{64}$/i.test(inputHash)) {
    throw Object.assign(new Error("A verified SHA-256 input hash is required."), { code: "CREATIVE_ARTIFACT_INPUT_HASH_INVALID" });
  }
  const project = db.prepare("SELECT id FROM projects WHERE id=?").get(projectId);
  if (!project) throw Object.assign(new Error("Project not found."), { code: "PROJECT_NOT_FOUND" });
  const inputJson = encode(input, "Creative artifact input");
  const contentJson = encode(content, "Creative artifact content");
  const usageJson = encode(isObject(usage) ? usage : {}, "Creative artifact usage");
  const modelName = typeof model === "string" ? model.trim().slice(0, 200) || null : null;
  const contentHash = digest(contentJson);
  db.exec("BEGIN IMMEDIATE");
  try {
    const revision = Number(db.prepare(
      "SELECT COALESCE(MAX(revision),0)+1 AS revision FROM creative_project_artifacts WHERE project_id=? AND artifact_type=?"
    ).get(projectId, type).revision);
    const id = randomUUID();
    const row = db.prepare(`
      INSERT INTO creative_project_artifacts(id,project_id,created_by,artifact_type,revision,input_hash,content_hash,input_json,content_json,model,usage_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      RETURNING *
    `).get(id, projectId, createdBy, type, revision, inputHash, contentHash, inputJson, contentJson, modelName, usageJson);
    db.exec("COMMIT");
    return mapArtifact(row);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function listCreativeProjectArtifacts(db, { projectId, type = null, limit = 20 } = {}) {
  if (!projectId) throw new TypeError("A project ID is required.");
  if (type !== null && !TYPES.has(type)) throw Object.assign(new Error("Unsupported creative project artifact type."), { code: "CREATIVE_ARTIFACT_TYPE_INVALID" });
  const boundedLimit = Number.isInteger(Number(limit)) ? Math.max(1, Math.min(100, Number(limit))) : 20;
  const rows = type
    ? db.prepare("SELECT * FROM creative_project_artifacts WHERE project_id=? AND artifact_type=? ORDER BY revision DESC LIMIT ?").all(projectId, type, boundedLimit)
    : db.prepare("SELECT * FROM creative_project_artifacts WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT ?").all(projectId, boundedLimit);
  return rows.map(mapArtifact);
}

export function getCreativeProjectArtifact(db, { projectId, artifactId } = {}) {
  if (!projectId || !artifactId) return null;
  const row = db.prepare("SELECT * FROM creative_project_artifacts WHERE project_id=? AND id=?").get(projectId, artifactId);
  return row ? mapArtifact(row) : null;
}
