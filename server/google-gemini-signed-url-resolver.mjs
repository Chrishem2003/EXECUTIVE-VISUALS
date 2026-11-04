import { createCloudAssetService } from "./cloud-asset-service.mjs";

const BUCKET = "executive-visuals-media";
const MAX_EXTERNAL_BYTES = 100 * 1024 * 1024;
const MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp",
  "video/mp4", "video/webm", "video/quicktime"
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message, code) => Object.assign(new Error(message), { code });

function safeOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("Google signed-URL resolver requires a valid Supabase URL."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) ||
      parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Google signed-URL resolver requires a safe HTTPS Supabase origin.");
  }
  return parsed.origin;
}

/**
 * Creates short-lived, owner/project-authorized Supabase Storage URLs for
 * Gemini Interactions. This path sends no media bytes through the app server.
 * Google fetches the private object during request processing; URLs are never
 * persisted in provider-file mappings or returned by client-facing APIs.
 */
export function createGoogleGeminiSignedUrlResolver({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
  assets,
  expiresIn = 600,
  maxBytes = MAX_EXTERNAL_BYTES,
  now = () => Date.now()
} = {}) {
  if (!url) throw new Error("Google signed-URL resolver requires the exact Supabase origin.");
  if (!assets && (!serviceRoleKey || typeof fetchImpl !== "function")) {
    throw new Error("Google signed-URL resolver requires the private Cloud Asset Service.");
  }
  if (!Number.isInteger(expiresIn) || expiresIn < 60 || expiresIn > 3600) {
    throw new Error("Google signed-URL expiry must be between 60 and 3600 seconds.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_EXTERNAL_BYTES) {
    throw new Error("Google external URL media limit cannot exceed 100 MB.");
  }
  const origin = safeOrigin(url);
  const cloudAssets = assets || createCloudAssetService({
    url, serviceRoleKey, fetchImpl,
    storageTimeoutMs: 15000,
    metadataTimeoutMs: 15000,
    authorizationTimeoutMs: 8000,
    maxBytes
  });

  return Object.freeze({
    async resolveAsset({ assetId, ownerId, projectId = null, mediaType } = {}) {
      if (typeof assetId !== "string" || !UUID.test(assetId) ||
          typeof ownerId !== "string" || !UUID.test(ownerId) ||
          (projectId !== null && projectId !== undefined && projectId !== "" &&
            (typeof projectId !== "string" || !UUID.test(projectId))) ||
          typeof mediaType !== "string" || !MIME_TYPES.has(mediaType)) {
        throw fail("Google signed-URL asset scope or MIME type is invalid.", "GEMINI_SIGNED_URL_ASSET_INVALID");
      }
      let signed;
      try {
        signed = await cloudAssets.assets.createSignedUrl({ ownerId, assetId, expiresIn });
      } catch {
        throw fail("Private asset could not be authorized for Google URL retrieval.", "GEMINI_SIGNED_URL_ASSET_FORBIDDEN");
      }
      const asset = signed?.asset;
      if (!asset || asset.id !== assetId ||
          (asset.projectId || null) !== (projectId || null) ||
          (!projectId && asset.ownerId !== ownerId) ||
          asset.storageBucket !== BUCKET || asset.mediaType !== mediaType ||
          !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > maxBytes ||
          typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(asset.sha256)) {
        throw fail("Private asset metadata does not match the requested owner, project, MIME type or URL size limit.",
          "GEMINI_SIGNED_URL_ASSET_INVALID");
      }
      let parsed;
      try { parsed = new URL(signed.url); } catch {
        throw fail("Private storage returned an invalid signed URL.", "GEMINI_SIGNED_URL_RESPONSE_INVALID");
      }
      const prefix = "/storage/v1/object/sign/" + BUCKET + "/";
      const keys = [...parsed.searchParams.keys()];
      if (parsed.origin !== origin || parsed.protocol !== "https:" ||
          parsed.username || parsed.password || parsed.hash ||
          !parsed.pathname.startsWith(prefix) || !parsed.searchParams.has("token") ||
          keys.some(key => key !== "token")) {
        throw fail("Private storage returned a signed URL outside the approved bucket and origin.",
          "GEMINI_SIGNED_URL_RESPONSE_INVALID");
      }
      const expiresAt = new Date(now() + expiresIn * 1000).toISOString();
      return Object.freeze({
        uri: parsed.toString(),
        mediaType,
        sizeBytes: asset.size,
        sha256: asset.sha256.toLowerCase(),
        expiresAt,
        sourceType: "signed_url"
      });
    }
  });
}
