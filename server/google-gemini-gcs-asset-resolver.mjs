const SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/devstorage.read_only",
  "https://www.googleapis.com/auth/cloud-platform"
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const fail = (message, code) => Object.assign(new Error(message), { code });

function safeBucket(value) {
  return typeof value === "string" &&
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) &&
    !value.includes("..") && !value.includes(".-") && !value.includes("-.");
}
function safeObjectName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    !value.startsWith("/") && !value.includes("\\") &&
    !/[\u0000-\u0020\u007f?#%]/.test(value) &&
    value.split("/").every(part => part && part !== "." && part !== "..");
}
function safeToken(value) {
  return typeof value === "string" && value.length >= 20 && value.length <= 8192 && !/\s/.test(value);
}

/**
 * Resolves a server-owned GCS mirror record to a verified gs:// URI.
 * The injected loadSource callback must query a service-only source registry
 * scoped by asset, owner and project. This module performs a metadata GET as
 * the caller identity, proving that identity can read the exact GCS object.
 * It never downloads media bytes or changes IAM policy.
 */
export function createGoogleGeminiGcsAssetResolver({
  env = process.env,
  loadSource,
  getAccessToken,
  fetchImpl = globalThis.fetch,
  maxBytes = 2 * 1024 * 1024 * 1024,
  timeoutMs = 15000
} = {}) {
  if (typeof loadSource !== "function" || typeof getAccessToken !== "function" ||
      typeof fetchImpl !== "function") {
    throw new TypeError("GCS asset resolver requires a trusted source loader, OAuth provider and fetch.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024 * 1024 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error("GCS asset resolver limits are invalid.");
  }
  const projectId = String(env.GOOGLE_CLOUD_PROJECT_ID || "").trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw fail("Configure a valid Google Cloud project ID.", "GEMINI_GCS_CONFIG_MISSING");
  }
  const allowedBuckets = new Set(String(env.GEMINI_GCS_ALLOWED_BUCKETS || "")
    .split(",").map(value => value.trim()).filter(Boolean));
  if (!allowedBuckets.size || [...allowedBuckets].some(value => !safeBucket(value))) {
    throw fail("Configure an explicit valid GCS bucket allowlist.", "GEMINI_GCS_BUCKET_ALLOWLIST_MISSING");
  }

  async function requestMetadata(url, accessToken) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: {
            authorization: "Bearer " + accessToken,
            "x-goog-user-project": projectId,
            accept: "application/json"
          },
          redirect: "error",
          signal: controller.signal
        });
      } catch (error) {
        throw fail(
          error?.name === "AbortError" ? "GCS object metadata lookup timed out." : "GCS object metadata lookup failed.",
          error?.name === "AbortError" ? "GEMINI_GCS_OBJECT_TIMEOUT" : "GEMINI_GCS_OBJECT_LOOKUP_FAILED"
        );
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > 256 * 1024) {
        throw fail("GCS object metadata response is too large.", "GEMINI_GCS_OBJECT_RESPONSE_INVALID");
      }
      let data = null;
      if (raw) {
        try { data = JSON.parse(raw); }
        catch { throw fail("GCS object metadata response is invalid.", "GEMINI_GCS_OBJECT_RESPONSE_INVALID"); }
      }
      if (!response.ok) {
        const code = response.status === 403 ? "GEMINI_GCS_CALLER_ACCESS_DENIED"
          : response.status === 404 ? "GEMINI_GCS_OBJECT_NOT_FOUND"
            : response.status === 429 ? "GEMINI_GCS_RATE_LIMITED" : "GEMINI_GCS_OBJECT_LOOKUP_FAILED";
        const error = fail("The configured GCS caller could not verify the private object (HTTP " + response.status + ").", code);
        error.status = response.status;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async resolvePrivateGcsAsset({ assetId, ownerId, projectId: assetProjectId = null } = {}) {
      if (typeof assetId !== "string" || !UUID.test(assetId) ||
          typeof ownerId !== "string" || !UUID.test(ownerId) ||
          (assetProjectId !== null && assetProjectId !== undefined && !UUID.test(assetProjectId))) {
        throw fail("Authenticated owner, project and asset identifiers are invalid.", "GEMINI_GCS_ASSET_SCOPE_INVALID");
      }
      const scopedProjectId = assetProjectId || null;
      let source;
      try {
        source = await loadSource({ assetId, ownerId, projectId: scopedProjectId });
      } catch {
        throw fail("No authorized GCS source is available for this private asset.", "GEMINI_GCS_SOURCE_NOT_FOUND");
      }
      if (!source || source.assetId !== assetId || source.ownerId !== ownerId ||
          (source.projectId || null) !== scopedProjectId || source.state !== "ACTIVE" ||
          !safeBucket(source.bucket) || !allowedBuckets.has(source.bucket) ||
          !safeObjectName(source.objectName) ||
          typeof source.generation !== "string" || !/^\d{1,30}$/.test(source.generation) ||
          typeof source.metageneration !== "string" || !/^\d{1,30}$/.test(source.metageneration) ||
          !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 1 || source.sizeBytes > maxBytes ||
          typeof source.mediaType !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(source.mediaType) ||
          typeof source.sha256 !== "string" || !SHA256.test(source.sha256)) {
        throw fail("GCS source registry metadata does not match the requested private asset.", "GEMINI_GCS_SOURCE_INVALID");
      }

      let accessToken;
      try {
        accessToken = await getAccessToken({ projectId, scopes: [...SCOPES] });
      } catch {
        throw fail("Google Cloud OAuth token acquisition failed.", "GEMINI_GCS_OAUTH_FAILED");
      }
      if (!safeToken(accessToken)) {
        throw fail("Google Cloud OAuth token provider returned an invalid token.", "GEMINI_GCS_OAUTH_FAILED");
      }

      const objectUrl = "https://storage.googleapis.com/storage/v1/b/" +
        encodeURIComponent(source.bucket) + "/o/" + encodeURIComponent(source.objectName) +
        "?fields=bucket,name,generation,metageneration,size,contentType,metadata";
      const metadata = await requestMetadata(objectUrl, accessToken);
      const custom = metadata?.metadata || {};
      if (metadata?.bucket !== source.bucket || metadata?.name !== source.objectName ||
          String(metadata?.generation || "") !== source.generation ||
          String(metadata?.metageneration || "") !== source.metageneration ||
          String(metadata?.size || "") !== String(source.sizeBytes) ||
          metadata?.contentType !== source.mediaType ||
          custom.executivevisualsassetid !== assetId ||
          custom.executivevisualsownerid !== ownerId ||
          (custom.executivevisualsprojectid || null) !== scopedProjectId ||
          custom.executivevisualssha256 !== source.sha256) {
        throw fail("GCS object generation, size, media type or ownership metadata does not match the private source registry.", "GEMINI_GCS_OBJECT_INTEGRITY_MISMATCH");
      }

      return Object.freeze({
        asset: Object.freeze({
          id: assetId,
          ownerId,
          projectId: scopedProjectId,
          mediaType: source.mediaType,
          sizeBytes: source.sizeBytes,
          sha256: source.sha256
        }),
        gcsUri: "gs://" + source.bucket + "/" + source.objectName,
        generation: source.generation
      });
    }
  });
}
