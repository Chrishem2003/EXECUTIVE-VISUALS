import { createHash } from "node:crypto";
import { verifyRenderManifest } from "./render-manifest.mjs";

const SHA256 = /^[a-f0-9]{64}$/i;
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const fail = message => { throw Object.assign(new Error(message), { code: "DELIVERY_MANIFEST_INVALID" }); };

function canonical(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || seen.has(value)) fail("Delivery evidence must be finite, acyclic JSON data.");
  seen.add(value);
  let result;
  if (Array.isArray(value)) result = "[" + value.map(item => canonical(item, seen)).join(",") + "]";
  else {
    if (!plain(value)) fail("Delivery evidence must contain plain JSON objects.");
    result = "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key], seen)).join(",") + "}";
  }
  seen.delete(value);
  return result;
}
const fingerprint = value => createHash("sha256").update(canonical(value)).digest("hex");

export function createDeliveryManifest({
  timelineId, timelineRevision, outputAsset, sha256, byteSize, mediaType,
  profileId = null, deliveryReport = null, renderManifest, createdAt = new Date().toISOString()
} = {}) {
  if (typeof timelineId !== "string" || !timelineId.trim() || timelineId.length > 256) fail("A valid timeline ID is required.");
  if (!Number.isSafeInteger(Number(timelineRevision)) || Number(timelineRevision) < 1) fail("A positive timeline revision is required.");
  if (typeof outputAsset !== "string" || !outputAsset.trim() || outputAsset.length > 256) fail("A published output asset ID is required.");
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) fail("A valid output SHA-256 checksum is required.");
  if (!Number.isSafeInteger(byteSize) || byteSize < 1) fail("A positive output byte size is required.");
  if (typeof mediaType !== "string" || !/^[\w.+-]+\/[\w.+-]+(?:;[\w=.+-]+)*$/.test(mediaType)) fail("A valid output media type is required.");
  if (profileId !== null && (typeof profileId !== "string" || !profileId.trim() || profileId.length > 128)) fail("The delivery profile ID is invalid.");
  if (deliveryReport !== null && !plain(deliveryReport)) fail("The delivery report must be a JSON object or null.");
  if (!renderManifest || !verifyRenderManifest(renderManifest)) fail("A verified render manifest is required.");
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) fail("A valid ISO timestamp is required.");

  const evidence = {
    schemaVersion: 1,
    timelineId: timelineId.trim(),
    timelineRevision: Number(timelineRevision),
    outputAsset,
    sha256: sha256.toLowerCase(),
    byteSize,
    mediaType,
    profileId,
    deliveryReport,
    renderManifest,
    createdAt
  };
  return Object.freeze({ ...evidence, fingerprint: fingerprint(evidence) });
}

export function verifyDeliveryManifest(manifest) {
  if (!plain(manifest) || manifest.schemaVersion !== 1 || typeof manifest.fingerprint !== "string" || !SHA256.test(manifest.fingerprint)) return false;
  const { fingerprint: supplied, ...evidence } = manifest;
  try { return fingerprint(evidence) === supplied; } catch { return false; }
}


export function createDeliveryPackage({
  jobId, projectId, timelineId, timelineRevision, master,
  deliveryReceipt, renderManifest, deliveryReport = null, qualityReport = null, reviewHistory = [],
  generatedAt = new Date().toISOString()
} = {}) {
  if (typeof jobId !== "string" || !jobId.trim() || jobId.length > 256) fail("A delivery job ID is required.");
  if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 256) fail("A project ID is required.");
  if (!verifyDeliveryManifest(deliveryReceipt)) fail("A verified delivery receipt is required.");
  if (deliveryReceipt.timelineId !== timelineId || deliveryReceipt.timelineRevision !== Number(timelineRevision)) fail("Delivery package timeline evidence does not match its receipt.");
  if (!plain(master) || master.assetId !== deliveryReceipt.outputAsset || master.sha256 !== deliveryReceipt.sha256 || master.byteSize !== deliveryReceipt.byteSize || master.mediaType !== deliveryReceipt.mediaType) fail("Delivery package master metadata does not match its receipt.");
  if (typeof master.filename !== "string" || !master.filename.trim() || master.filename.length > 256) fail("A valid master filename is required.");
  if (typeof master.downloadUrl !== "string") fail("A private master download URL is required.");
  let downloadUrl;
  try { downloadUrl = new URL(master.downloadUrl); if (downloadUrl.protocol !== "https:" || downloadUrl.username || downloadUrl.password || downloadUrl.hash) fail("The master download URL is unsafe."); }
  catch { fail("The master download URL is invalid."); }
  if (master.downloadUrlExpiresInSeconds !== 300) fail("The master download URL must have the five-minute expiry contract.");
  if (canonical(renderManifest) !== canonical(deliveryReceipt.renderManifest) || !verifyRenderManifest(renderManifest)) fail("The render manifest must be the verified manifest bound into the receipt.");
  if (canonical(deliveryReport) !== canonical(deliveryReceipt.deliveryReport)) fail("The delivery report must match the receipt.");
  if (!Array.isArray(reviewHistory) || reviewHistory.length > 1000 || reviewHistory.some(item => !plain(item) || item.fingerprint !== deliveryReceipt.fingerprint)) fail("Review history must contain only decisions for this delivery fingerprint.");
  if (qualityReport !== null && (!plain(qualityReport) || !["passed","review","needs-attention"].includes(qualityReport.status) || !plain(qualityReport.counts) || !Number.isSafeInteger(qualityReport.counts.errors) || qualityReport.counts.errors < 0 || !Number.isSafeInteger(qualityReport.counts.warnings) || qualityReport.counts.warnings < 0 || !Array.isArray(qualityReport.findings) || qualityReport.findings.length > 1000 || qualityReport.findings.some(item => !plain(item) || typeof item.code !== "string" || item.code.length > 100 || !["error","warning"].includes(item.severity) || typeof item.message !== "string" || item.message.length > 2000) || !Array.isArray(qualityReport.limitations) || qualityReport.limitations.length > 100 || qualityReport.limitations.some(item => typeof item !== "string" || item.length > 1000))) fail("The media quality report is invalid or exceeds package limits.");
  if (typeof generatedAt !== "string" || !Number.isFinite(Date.parse(generatedAt)) || new Date(generatedAt).toISOString() !== generatedAt) fail("A valid package timestamp is required.");
  const evidence = {
    schemaVersion: 1, packageType: "executive-visuals-delivery", generatedAt,
    jobId, projectId, timelineId, timelineRevision: Number(timelineRevision),
    master, deliveryReceipt, renderManifest, deliveryReport, qualityReport, reviewHistory
  };
  return Object.freeze({ ...evidence, packageFingerprint: fingerprint(evidence) });
}

export function verifyDeliveryPackage(value) {
  if (!plain(value) || value.schemaVersion !== 1 || value.packageType !== "executive-visuals-delivery" || typeof value.packageFingerprint !== "string" || !SHA256.test(value.packageFingerprint)) return false;
  const { packageFingerprint: supplied, ...evidence } = value;
  try {
    const recreated = createDeliveryPackage(evidence);
    return recreated.packageFingerprint === supplied;
  } catch { return false; }
}
