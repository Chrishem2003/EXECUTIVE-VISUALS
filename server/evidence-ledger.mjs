import { randomUUID } from "node:crypto";
import { json, parseJson } from "./db.mjs";

const TARGET_TYPES = new Set(["project","scene","shot","timeline","asset"]);
const REVIEW_STATES = new Set(["needs_review","verified","rejected"]);
const clean = (value, max) => typeof value === "string" ? value.trim().replace(/\s+/g," ").slice(0,max) : "";

function atomic(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; }
  catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
}

function toRecord(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceAssetId: row.source_asset_id,
    sourceAssetName: row.source_asset_name,
    sourceMediaType: row.source_media_type,
    sourceSha256: row.source_sha256,
    target: { type: row.target_type, id: row.target_id },
    kind: row.evidence_kind,
    claim: row.claim,
    method: row.method,
    sourceRef: row.source_ref,
    observedAt: row.observed_at,
    note: row.note,
    status: row.status,
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at
  };
}

export function createEvidenceRecord(db, { id = randomUUID(), ownerId, projectId = null, sourceAsset, targetType, targetId, kind, claim, method = "", sourceRef = "", observedAt = null, note = "" }) {
  if (!ownerId || !sourceAsset?.id || !/^[a-f0-9]{64}$/i.test(String(sourceAsset.sha256 || ""))) throw new Error("EVIDENCE_SOURCE_ASSET_INVALID");
  if (projectId !== null && (typeof projectId !== "string" || !projectId.trim())) throw new Error("EVIDENCE_PROJECT_INVALID");
  if (!TARGET_TYPES.has(targetType) || typeof targetId !== "string" || !targetId.trim() || targetId.length > 160) throw new Error("EVIDENCE_TARGET_INVALID");
  const evidenceKind = clean(kind,64).toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(evidenceKind)) throw new Error("EVIDENCE_KIND_INVALID");
  const evidenceClaim = clean(claim,1200);
  if (evidenceClaim.length < 8) throw new Error("EVIDENCE_CLAIM_REQUIRED");
  const evidenceMethod = clean(method,120);
  const reference = clean(sourceRef,1000);
  const evidenceNote = clean(note,2000);
  let observed = null;
  if (observedAt !== null && observedAt !== "") {
    const parsed = Date.parse(observedAt);
    if (typeof observedAt !== "string" || !Number.isFinite(parsed)) throw new Error("EVIDENCE_OBSERVED_AT_INVALID");
    observed = new Date(parsed).toISOString();
  }
  const transaction = () => atomic(db, () => {
    db.prepare(`INSERT INTO evidence_records(id,owner_id,project_id,source_asset_id,source_sha256,target_type,target_id,evidence_kind,claim,method,source_ref,observed_at,note)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,ownerId,projectId,sourceAsset.id,String(sourceAsset.sha256).toLowerCase(),targetType,targetId.trim(),evidenceKind,evidenceClaim,evidenceMethod,reference,observed,evidenceNote);
    db.prepare("INSERT INTO evidence_record_events(evidence_id,actor_id,event_type,details_json) VALUES(?,?,?,?)").run(id,ownerId,"submitted",json({sourceSha256:String(sourceAsset.sha256).toLowerCase(),targetType,targetId:targetId.trim(),kind:evidenceKind}));
    return db.prepare(`SELECT e.*,a.original_name AS source_asset_name,a.media_type AS source_media_type
      FROM evidence_records e JOIN assets a ON a.id=e.source_asset_id WHERE e.id=?`).get(id);
  });
  return toRecord(transaction());
}

export function listEvidenceRecords(db, { sourceAssetId = null, projectId = null, targetType = null, targetId = null } = {}) {
  const clauses = [], values = [];
  if (sourceAssetId) { clauses.push("e.source_asset_id=?"); values.push(sourceAssetId); }
  if (projectId) { clauses.push("e.project_id=?"); values.push(projectId); }
  if (targetType) { clauses.push("e.target_type=?"); values.push(targetType); }
  if (targetId) { clauses.push("e.target_id=?"); values.push(targetId); }
  const where = clauses.length ? "WHERE "+clauses.join(" AND ") : "";
  const rows = db.prepare(`SELECT e.*,a.original_name AS source_asset_name,a.media_type AS source_media_type
    FROM evidence_records e JOIN assets a ON a.id=e.source_asset_id ${where} ORDER BY e.created_at DESC,e.id DESC LIMIT 500`).all(...values);
  return rows.map(toRecord);
}

export function reviewEvidenceRecord(db, { evidenceId, reviewerId, status, reviewNote = "" }) {
  if (!REVIEW_STATES.has(status)) throw new Error("EVIDENCE_REVIEW_STATE_INVALID");
  const existing=db.prepare("SELECT status FROM evidence_records WHERE id=?").get(evidenceId);
  if(existing&&["verified","rejected"].includes(existing.status))throw new Error("EVIDENCE_ALREADY_REVIEWED");
  const note = clean(reviewNote,2000);
  if(note.length<8)throw new Error("EVIDENCE_REVIEW_REASON_REQUIRED");
  const transaction = () => atomic(db, () => {
    const row = db.prepare("SELECT * FROM evidence_records WHERE id=?").get(evidenceId);
    if (!row) return null;
    if (row.status === "verified" || row.status === "rejected") throw new Error("EVIDENCE_ALREADY_REVIEWED");
    const reviewedAt = new Date().toISOString();
    const changed = db.prepare("UPDATE evidence_records SET status=?,review_note=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status IN ('submitted','needs_review')").run(status,note,reviewerId,reviewedAt,evidenceId);
    if (changed.changes !== 1) throw new Error("EVIDENCE_REVIEW_CONFLICT");
    db.prepare("INSERT INTO evidence_record_events(evidence_id,actor_id,event_type,details_json) VALUES(?,?,?,?)")
      .run(evidenceId,reviewerId,"reviewed",json({status,reviewNote:note}));
    return db.prepare(`SELECT e.*,a.original_name AS source_asset_name,a.media_type AS source_media_type
      FROM evidence_records e JOIN assets a ON a.id=e.source_asset_id WHERE e.id=?`).get(evidenceId);
  });
  const result = transaction();
  return result ? toRecord(result) : null;
}

export function listEvidenceEvents(db, evidenceId) {
  return db.prepare("SELECT id,actor_id AS actorId,event_type AS type,details_json AS detailsJson,created_at AS createdAt FROM evidence_record_events WHERE evidence_id=? ORDER BY id ASC").all(evidenceId)
    .map(row => ({ id: row.id, actorId: row.actorId, type: row.type, details: parseJson(row.detailsJson), createdAt: row.createdAt }));
}

export function evidencePersistenceReady({nodeEnv=process.env.NODE_ENV,persistence="unverified"}={}) {
  return nodeEnv!=="production"||persistence==="operator-confirmed-volume";
}
