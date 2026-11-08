import { createHash } from "node:crypto";
const SHA256 = /^[a-f0-9]{64}$/i;
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Provenance values must contain finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  throw new Error("Provenance values must be JSON-compatible.");
}
function digest(value) {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}
function validAsset(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A provenance asset descriptor is required.");
  if (typeof input.id !== "string" || !input.id.trim() || input.id.length > 128) throw new Error("Asset id is invalid.");
  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) throw new Error("Asset SHA-256 is invalid.");
  const mediaParts = typeof input.mediaType === "string" ? input.mediaType.toLowerCase().split("/") : [];
  if (mediaParts.length !== 2 || !mediaParts.every(part => /^[a-z0-9!#$&^_.+-]+$/i.test(part))) throw new Error("Asset media type is invalid.");
  if (!Number.isSafeInteger(input.size) || input.size < 1) throw new Error("Asset size must be a positive safe integer.");
}
function unsignedRecord({ asset, createdAt, source }) {
  validAsset(asset);
  const timestamp = createdAt || new Date().toISOString();
  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) throw new Error("Provenance timestamp must be a canonical UTC ISO timestamp.");
  const sourceKind = source?.kind || "user_upload";
  if (!["user_upload", "derived_asset", "imported_asset"].includes(sourceKind)) throw new Error("Unsupported provenance source kind.");
  const parentAssetId = source?.parentAssetId ?? null;
  if (parentAssetId !== null && (typeof parentAssetId !== "string" || !parentAssetId.trim() || parentAssetId.length > 128)) throw new Error("Parent asset id is invalid.");
  if (sourceKind === "derived_asset" && !parentAssetId) throw new Error("Derived assets require a parent asset id.");
  if (sourceKind !== "derived_asset" && parentAssetId) throw new Error("Only derived assets may declare a parent asset id.");
  return {
    schema: "executive-visuals.provenance.v1",
    recordType: "asset_ingest",
    asset: { id: asset.id, sha256: asset.sha256.toLowerCase(), mediaType: inputMediaType(asset.mediaType), size: asset.size },
    source: { kind: sourceKind, parentAssetId },
    actor: { type: "authenticated_user" },
    createdAt: timestamp
  };
}
function inputMediaType(value) {
  return value.toLowerCase();
}
/**
 * Creates a content-bound application provenance record.
 * This is an integrity record, not a C2PA manifest or a digital signature.
 */
export function createAssetProvenanceRecord(input) {
  const record = unsignedRecord(input);
  return Object.freeze({ ...record, recordHash: digest(record), hashAlgorithm: "sha256" });
}
/**
 * Verifies both the record hash and its binding to the current asset row.
 * A valid result proves internal record consistency only; it does not identify
 * a real-world author, establish rights, or validate a C2PA signature.
 */
export function verifyAssetProvenanceRecord(record, asset) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { status: "not_available", integrity: false, c2pa: "not_checked", findings: ["PROVENANCE_RECORD_MISSING"] };
  }
  const { recordHash, hashAlgorithm, ...unsigned } = record;
  const findings = [];
  if (record.schema !== "executive-visuals.provenance.v1" || record.recordType !== "asset_ingest" || hashAlgorithm !== "sha256" || typeof recordHash !== "string" || !SHA256.test(recordHash)) {
    findings.push("PROVENANCE_SCHEMA_INVALID");
  } else {
    try {
      if (digest(unsigned) !== recordHash.toLowerCase()) findings.push("PROVENANCE_HASH_MISMATCH");
    } catch {
      findings.push("PROVENANCE_RECORD_INVALID");
    }
  }
  if (!asset || typeof asset !== "object") {
    findings.push("ASSET_DESCRIPTOR_MISSING");
  } else {
    if (record.asset?.id !== asset.id) findings.push("PROVENANCE_ASSET_ID_MISMATCH");
    if (record.asset?.sha256 !== String(asset.sha256 || "").toLowerCase()) findings.push("PROVENANCE_CONTENT_HASH_MISMATCH");
    if (record.asset?.mediaType !== String(asset.mediaType || "").toLowerCase()) findings.push("PROVENANCE_MEDIA_TYPE_MISMATCH");
    if (record.asset?.size !== asset.size) findings.push("PROVENANCE_SIZE_MISMATCH");
  }
  return {
    status: findings.length ? "invalid" : "integrity_verified",
    integrity: findings.length === 0,
    c2pa: "not_checked",
    findings
  };
}