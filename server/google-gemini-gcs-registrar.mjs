const ORIGIN = "https://generativelanguage.googleapis.com";
const FILE_URI = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[A-Za-z0-9_-]+$/;
const FILE_NAME = /^files\/[A-Za-z0-9_-]+$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/devstorage.read_only",
  "https://www.googleapis.com/auth/cloud-platform"
]);
const fail = (message, code) => Object.assign(new Error(message), { code });

function safeGcsUri(value, allowedBuckets) {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("gs://") ||
      value.includes("?") || value.includes("#") || value.includes("\\") ||
      /%2f|%5c|%2e/i.test(value)) {
    throw fail("Private GCS object URI is invalid.", "GEMINI_GCS_URI_INVALID");
  }
  const match = /^gs:\/\/([a-z0-9][a-z0-9.-]{1,220})\/(.+)$/.exec(value);
  if (!match || match[2].split("/").some(part => !part || part === "." || part === "..") ||
      /[\u0000-\u0020]/.test(match[2])) {
    throw fail("Private GCS object URI is malformed.", "GEMINI_GCS_URI_INVALID");
  }
  if (!allowedBuckets.has(match[1])) {
    throw fail("GCS bucket is not in the server-side Gemini registration allowlist.", "GEMINI_GCS_BUCKET_FORBIDDEN");
  }
  return value;
}

function validAsset(asset, { assetId, ownerId, projectId, mediaType, maxBytes }) {
  if (!asset || asset.id !== assetId || asset.ownerId !== ownerId ||
      (asset.projectId || null) !== (projectId || null) ||
      asset.mediaType !== mediaType ||
      !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 1 || asset.sizeBytes > maxBytes ||
      typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw fail("Authorized GCS asset metadata did not match the requested private asset scope.", "GEMINI_GCS_ASSET_SCOPE_INVALID");
  }
  return asset;
}

function parseFile(file, asset) {
  if (!file || typeof file !== "object" || Array.isArray(file) ||
      typeof file.name !== "string" || !FILE_NAME.test(file.name) ||
      typeof file.uri !== "string" || !FILE_URI.test(file.uri) ||
      (file.mimeType && file.mimeType !== asset.mediaType) ||
      (file.sizeBytes !== undefined && Number(file.sizeBytes) !== asset.sizeBytes) ||
      (file.state && String(file.state).toUpperCase() !== "ACTIVE")) {
    throw fail("Gemini GCS registration returned an invalid or inactive File resource.", "GEMINI_GCS_RESPONSE_INVALID");
  }
  return { name: file.name, uri: file.uri, mimeType: asset.mediaType, sizeBytes: asset.sizeBytes };
}

/**
 * Registers an already-authorized private GCS object with the Gemini Files API.
 * No media bytes are downloaded or copied. OAuth credentials are injected by
 * the host; this module never creates IAM grants or accepts caller-supplied
 * gs:// URIs.
 */
export function createGoogleGeminiGcsFilesRegistrar({
  env = process.env,
  fetchImpl = globalThis.fetch,
  getAccessToken,
  resolvePrivateGcsAsset,
  authorizePrivateAsset,
  repository,
  maxBytes = 250 * 1024 * 1024,
  timeoutMs = 30000,
  registrationDays = 29,
  now = () => Date.now()
} = {}) {
  if (typeof fetchImpl !== "function" || typeof getAccessToken !== "function" ||
      typeof resolvePrivateGcsAsset !== "function" || typeof authorizePrivateAsset !== "function") {
    throw new TypeError("Google GCS registration requires OAuth, private asset resolution and authorization callbacks.");
  }
  if (!repository || typeof repository.findProviderFile !== "function" ||
      typeof repository.recordProviderFile !== "function" ||
      typeof repository.deleteProviderFileRecord !== "function") {
    throw new TypeError("Google GCS registration requires the durable provider-file repository.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FILE_BYTES ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000 ||
      !Number.isInteger(registrationDays) || registrationDays < 1 || registrationDays > 29) {
    throw new Error("Google GCS registration limits are invalid.");
  }
  const projectId = String(env.GOOGLE_CLOUD_PROJECT_ID || "").trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw fail("Configure a valid Google Cloud project ID for GCS registration.", "GEMINI_GCS_CONFIG_MISSING");
  }
  const allowedBuckets = new Set(String(env.GEMINI_GCS_ALLOWED_BUCKETS || "")
    .split(",").map(value => value.trim()).filter(Boolean));
  if (!allowedBuckets.size || [...allowedBuckets].some(bucket => !/^[a-z0-9][a-z0-9.-]{1,220}$/.test(bucket))) {
    throw fail("Configure an explicit GEMINI_GCS_ALLOWED_BUCKETS allowlist.", "GEMINI_GCS_BUCKET_ALLOWLIST_MISSING");
  }

  async function token() {
    let value;
    try { value = await getAccessToken({ scopes: [...SCOPES], projectId }); }
    catch { throw fail("Google Cloud OAuth token acquisition failed.", "GEMINI_GCS_OAUTH_FAILED"); }
    if (typeof value !== "string" || value.length < 20 || value.length > 8192 || /\s/.test(value)) {
      throw fail("Google Cloud OAuth token provider returned an invalid token.", "GEMINI_GCS_OAUTH_FAILED");
    }
    return value;
  }

  async function request(url, accessToken, { method = "GET", body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            authorization: "Bearer " + accessToken,
            "x-goog-user-project": projectId,
            ...(body === undefined ? {} : { "content-type": "application/json" })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: controller.signal
        });
      } catch (error) {
        throw fail(error?.name === "AbortError" ? "Google GCS registration timed out." : "Google GCS registration request failed.",
          error?.name === "AbortError" ? "GEMINI_GCS_TIMEOUT" : "GEMINI_GCS_REQUEST_FAILED");
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 1024 * 1024) throw fail("Google GCS registration response is too large.", "GEMINI_GCS_RESPONSE_TOO_LARGE");
      let data = null;
      if (raw) {
        try { data = JSON.parse(raw); }
        catch { if (response.ok) throw fail("Google GCS registration returned invalid JSON.", "GEMINI_GCS_RESPONSE_INVALID"); }
      }
      if (!response.ok) {
        const code = response.status === 403 ? "GEMINI_GCS_IAM_ACCESS_DENIED"
          : response.status === 429 ? "GEMINI_GCS_RATE_LIMITED"
            : response.status >= 500 ? "GEMINI_GCS_PROVIDER_ERROR" : "GEMINI_GCS_REQUEST_REJECTED";
        throw fail("Google GCS registration was rejected (HTTP " + response.status + ").", code);
      }
      return data;
    } finally { clearTimeout(timer); }
  }

  async function deleteProviderFile(name, accessToken) {
    const match = FILE_NAME.exec(String(name || ""));
    if (!match) return false;
    try {
      await request(ORIGIN + "/v1beta/" + name, accessToken, { method: "DELETE" });
    } catch (error) {
      if (error?.code !== "GEMINI_GCS_REQUEST_FAILED") throw error;
    }
    return true;
  }

  return Object.freeze({
    async registerAsset({ assetId, ownerId, projectId: assetProjectId = null, mediaType } = {}) {
      for (const [value, label] of [[assetId, "Asset ID"], [ownerId, "Owner ID"], [mediaType, "MIME type"]]) {
        if (typeof value !== "string" || !value.trim() || value.length > 256) throw new Error(label + " is required.");
      }
      let resolved;
      try { resolved = await resolvePrivateGcsAsset({ assetId, ownerId, projectId: assetProjectId }); }
      catch { throw fail("Private GCS asset resolution failed.", "GEMINI_GCS_ASSET_NOT_FOUND"); }
      const asset = validAsset(resolved?.asset, { assetId, ownerId, projectId: assetProjectId, mediaType, maxBytes });
      const uri = safeGcsUri(resolved.gcsUri, allowedBuckets);
      let authorized = false;
      try {
        const decision = await authorizePrivateAsset({ assetId, ownerId, projectId: assetProjectId, asset, gcsUri: uri });
        authorized = decision === true || (decision && decision.id === assetId &&
          decision.ownerId === ownerId && (decision.projectId || null) === (assetProjectId || null));
      } catch {}
      if (!authorized) throw fail("GCS object is not authorized for this owner and project.", "GEMINI_GCS_ASSET_FORBIDDEN");

      const cached = await repository.findProviderFile({ assetId, ownerId, projectId: assetProjectId, mimeType: mediaType });
      const currentTime = now();
      if (cached && cached.state === "ACTIVE" && cached.sha256 === asset.sha256 &&
          cached.sizeBytes === asset.sizeBytes && Date.parse(cached.expiresAt) > currentTime &&
          typeof cached.uri === "string" && FILE_URI.test(cached.uri) &&
          (cached.sourceType !== "gcs_registration" || cached.sourceUri === uri)) {
        return Object.freeze({
          uri: cached.uri, providerFileName: cached.name, mimeType: mediaType,
          expiresAt: cached.expiresAt, sourceType: cached.sourceType || "upload", reused: true
        });
      }

      const accessToken = await token();
      const response = await request(ORIGIN + "/v1beta/files:register", accessToken, {
        method: "POST", body: { uris: [uri] }
      });
      if (!Array.isArray(response?.files) || response.files.length !== 1) {
        throw fail("Google GCS registration did not return exactly one File resource.", "GEMINI_GCS_RESPONSE_INVALID");
      }
      const file = parseFile(response.files[0], asset);
      const expiresAtMs = currentTime + registrationDays * 24 * 60 * 60 * 1000;
      let expiresAt = new Date(expiresAtMs).toISOString();
      if (response.files[0].expirationTime !== undefined) {
        const providerExpiry = Date.parse(response.files[0].expirationTime);
        if (!Number.isFinite(providerExpiry) || providerExpiry <= currentTime) {
          throw fail("Google GCS registration returned an invalid expiration.", "GEMINI_GCS_RESPONSE_INVALID");
        }
        expiresAt = new Date(Math.min(expiresAtMs, providerExpiry)).toISOString();
      }
      try {
        await repository.recordProviderFile({
          provider: "google-gemini-files",
          assetId, ownerId, projectId: assetProjectId,
          name: file.name, uri: file.uri, mimeType: file.mimeType,
          sizeBytes: file.sizeBytes, sha256: asset.sha256, state: "ACTIVE",
          uploadedAt: new Date(currentTime).toISOString(), expiresAt,
          sourceType: "gcs_registration", sourceUri: uri
        });
      } catch {
        try { await deleteProviderFile(file.name, accessToken); } catch {}
        throw fail("GCS registration mapping could not be persisted; provider registration was compensated where possible.",
          "GEMINI_GCS_MAPPING_PERSIST_FAILED");
      }
      return Object.freeze({
        uri: file.uri, providerFileName: file.name, mimeType: file.mimeType,
        expiresAt, sourceType: "gcs_registration", reused: false
      });
    }
  });
}
