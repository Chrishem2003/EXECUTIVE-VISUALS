const STAGE_STATUSES = new Set(["running", "succeeded", "failed", "skipped"]);
const SAFE_ATTRIBUTES = new Set(["attempt", "progress", "nodeKind", "errorCode", "retryable", "durationMs", "completedNodes", "totalNodes"]);

function cleanAttributes(value = {}) {
  const output = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return output;
  for (const [key, item] of Object.entries(value)) {
    if (!SAFE_ATTRIBUTES.has(key)) continue;
    if (typeof item === "string") output[key] = item.slice(0, 120);
    else if (typeof item === "number" && Number.isFinite(item)) output[key] = item;
    else if (typeof item === "boolean") output[key] = item;
  }
  return output;
}

export function recordJobStage(db, {
  jobId, ownerId, stageId, label, status, attributes = {}, timestamp = new Date().toISOString()
}) {
  const id = String(stageId || "").trim();
  const name = String(label || "").trim();
  if (!jobId || !ownerId || !id || id.length > 160 || !name || name.length > 160) {
    throw Object.assign(new Error("A job stage requires job, owner, stage ID and label."), { code: "INVALID_JOB_STAGE" });
  }
  if (!STAGE_STATUSES.has(status)) {
    throw Object.assign(new Error("Unsupported job stage status."), { code: "INVALID_JOB_STAGE_STATUS" });
  }
  const data = { stageId: id, label: name, status, ...cleanAttributes(attributes) };
  db.prepare("INSERT INTO job_events(job_id,owner_id,event_type,event_json,created_at) VALUES(?,?,?,?,?)")
    .run(jobId, ownerId, "job.stage." + status, JSON.stringify(data), timestamp);
  return data;
}

export function getJobStageTimeline(db, jobId, ownerId) {
  const rows = db.prepare(
    "SELECT id,event_type,event_json,created_at FROM job_events WHERE job_id=? AND owner_id=? AND event_type LIKE 'job.stage.%' ORDER BY id ASC"
  ).all(jobId, ownerId);
  const stages = new Map();
  for (const row of rows) {
    let data;
    try { data = JSON.parse(row.event_json || "{}"); } catch { continue; }
    const stageId = String(data.stageId || "");
    if (!stageId) continue;
    const existing = stages.get(stageId) || {
      id: stageId, label: String(data.label || stageId),
      status: "pending", startedAt: null, completedAt: null,
      durationMs: null, attributes: {}
    };
    if (row.event_type === "job.stage.running") {
      if (existing.status !== "running") existing.startedAt = row.created_at;
      existing.status = "running";
      existing.completedAt = null;
      existing.durationMs = null;
    } else if (row.event_type === "job.stage.succeeded" || row.event_type === "job.stage.failed" || row.event_type === "job.stage.skipped") {
      existing.status = data.status;
      existing.startedAt ||= row.created_at;
      existing.completedAt = row.created_at;
      if (existing.startedAt) {
        const duration = Date.parse(existing.completedAt) - Date.parse(existing.startedAt);
        existing.durationMs = Number.isFinite(duration) ? Math.max(0, duration) : null;
      }
    }
    existing.label = String(data.label || existing.label);
    existing.attributes = cleanAttributes(data);
    existing.lastEventId = row.id;
    stages.set(stageId, existing);
  }
  return [...stages.values()];
}
