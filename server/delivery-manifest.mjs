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
