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


function validateEditedStoryboard(content, expectedInputHash) {
  const text = (value, max) => typeof value === "string" && value.length <= max;
  const required = (value, max) => text(value, max) && value.trim().length > 0;
  const ratios = new Set(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]);
  if (!isObject(content) || content.schemaVersion !== 1 || content.source !== "model" ||
      typeof content.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(content.id) ||
      content.inputHash !== expectedInputHash || !required(content.model, 160) ||
      !Number.isFinite(Date.parse(content.generatedAt)) || !required(content.title, 160) ||
      !required(content.logline, 1000) || !Number.isInteger(content.targetDurationSeconds) ||
      content.targetDurationSeconds < 15 || content.targetDurationSeconds > 1800 ||
      !ratios.has(content.aspectRatio) || ![24,25,30,50,60].includes(content.frameRate) ||
      !Array.isArray(content.globalContinuityRules) || content.globalContinuityRules.length < 3 ||
      content.globalContinuityRules.length > 10 || content.globalContinuityRules.some(x => !required(x,400)) ||
      !Array.isArray(content.characterSuggestions) || content.characterSuggestions.length > 8 ||
      !Array.isArray(content.scenes) || content.scenes.length < 2 || content.scenes.length > 12) {
    throw Object.assign(new Error("Edited storyboard metadata or source lineage is invalid."), { code: "CREATIVE_ARTIFACT_REVISION_INVALID" });
  }
  const sceneIds = new Set(), shotIds = new Set();
  let totalSeconds = 0, totalShots = 0;
  for (let si=0; si<content.scenes.length; si++) {
    const scene=content.scenes[si];
    if (!isObject(scene) || typeof scene.id !== "string" || !scene.id || sceneIds.has(scene.id) ||
        shotIds.has(scene.id) || scene.number !== si+1 || !required(scene.title,160) ||
        !required(scene.slugline,160) || !required(scene.purpose,500) || !required(scene.storyBeat,160) ||
        !text(scene.location,160) || !text(scene.timeOfDay,80) ||
        !Array.isArray(scene.shots) || scene.shots.length < 1 || scene.shots.length > 8) {
      throw Object.assign(new Error("Edited storyboard contains an invalid or duplicate scene."), { code: "CREATIVE_ARTIFACT_REVISION_INVALID" });
    }
    sceneIds.add(scene.id);
    let sceneSeconds=0;
    for (let hi=0; hi<scene.shots.length; hi++) {
      const shot=scene.shots[hi];
      if (!isObject(shot) || typeof shot.id !== "string" || !shot.id || shotIds.has(shot.id) ||
          sceneIds.has(shot.id) || shot.number !== hi+1 || !Number.isInteger(shot.durationSeconds) ||
          shot.durationSeconds < 1 || shot.durationSeconds > 60) {
        throw Object.assign(new Error("Edited storyboard contains an invalid or duplicate shot."), { code: "CREATIVE_ARTIFACT_REVISION_INVALID" });
      }
      for (const [field,max] of Object.entries({shotType:100,framing:120,angle:120,movement:160,lens:100,action:600,dialogue:500,narration:500,visualPrompt:1600,motionPrompt:1000,negativePrompt:600,lighting:300,soundCue:300,continuityIn:300,continuityOut:300,proofReference:300,transitionOut:80})) {
        if (!text(shot[field],max)) throw Object.assign(new Error("Edited storyboard shot field "+field+" is invalid."), { code: "CREATIVE_ARTIFACT_REVISION_INVALID" });
      }
      if (!Array.isArray(shot.characterRefs) || shot.characterRefs.length > 12 ||
          shot.characterRefs.some(ref=>!isObject(ref)||!required(ref.name,120)||!text(ref.role,160)||
            (typeof ref.characterId!=="string"&&ref.characterId!==null)||!text(ref.action,300)||!text(ref.continuityNotes,300))) {
        throw Object.assign(new Error("Edited storyboard shot character references are invalid."), { code: "CREATIVE_ARTIFACT_REVISION_INVALID" });
      }
      shotIds.add(shot.id);totalShots++;sceneSeconds+=shot.durationSeconds;
    }
    if (Math.abs(sceneSeconds-Number(scene.durationSeconds))>1) throw Object.assign(new Error("Edited scene duration does not match its shots."), { code: "CREATIVE_ARTIFACT_REVISION_INVALID" });
    totalSeconds+=sceneSeconds;
  }
  if (totalShots>60 || Math.abs(totalSeconds-Number(content.durationSeconds))>1 ||
      Math.abs(totalSeconds-content.targetDurationSeconds)>Math.max(2,Math.round(content.targetDurationSeconds*0.05))) {
    throw Object.assign(new Error("Edited storyboard runtime or shot count is invalid."), { code: "CREATIVE_ARTIFACT_REVISION_INVALID" });
  }
}

export function appendCreativeProjectArtifactRevision(db, { projectId, artifactId, createdBy, content } = {}) {
  const parent=getCreativeProjectArtifact(db,{projectId,artifactId});
  if (!parent) throw Object.assign(new Error("Source creative artifact not found."), { code: "CREATIVE_ARTIFACT_NOT_FOUND" });
  if (parent.type!=="storyboard") throw Object.assign(new Error("Only storyboard artifacts support edited revisions through this endpoint."), { code: "CREATIVE_ARTIFACT_TYPE_INVALID" });
  if (typeof createdBy!=="string"||!createdBy) throw Object.assign(new Error("An authenticated editor is required."), { code: "CREATIVE_ARTIFACT_PROJECT_REQUIRED" });
  validateEditedStoryboard(content,parent.inputHash);
  return saveCreativeProjectArtifact(db,{
    projectId,createdBy,type:"storyboard",input:parent.input,content,inputHash:parent.inputHash,
    model:parent.model,usage:parent.usage
  });
}
