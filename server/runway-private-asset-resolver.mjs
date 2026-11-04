const API_BASE = "https://api.dev.runwayml.com/v1";
const API_VERSION = "2024-11-06";
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const IMAGE_TYPES = Object.freeze({
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"]
});
const fail = (message, code) => Object.assign(new Error(message), { code });

function safeRunwayUri(value) {
  return typeof value === "string" &&
    value.length >= 13 && value.length <= 5000 &&
    /^runway:\/\/[A-Za-z0-9._~:/-]+$/.test(value);
}

function validImageSignature(bytes, contentType) {
  if (contentType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/webp") return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return false;
}

function validateUploadResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.uploadUrl !== "string" || typeof value.runwayUri !== "string" ||
      !safeRunwayUri(value.runwayUri) ||
      !value.fields || typeof value.fields !== "object" || Array.isArray(value.fields)) {
    throw fail("Runway returned an invalid ephemeral-upload response.", "RUNWAY_ASSET_UPLOAD_RESPONSE_INVALID");
  }
  let url;
  try { url = new URL(value.uploadUrl); }
  catch { throw fail("Runway returned an invalid ephemeral upload URL.", "RUNWAY_ASSET_UPLOAD_RESPONSE_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw fail("Runway returned an unsafe ephemeral upload URL.", "RUNWAY_ASSET_UPLOAD_RESPONSE_INVALID");
  }
  const entries = Object.entries(value.fields);
  if (entries.length > 32 || entries.some(([key, item]) =>
    !/^[A-Za-z0-9_-]{1,100}$/.test(key) || typeof item !== "string" || item.length > 4000)) {
    throw fail("Runway returned invalid ephemeral upload fields.", "RUNWAY_ASSET_UPLOAD_RESPONSE_INVALID");
  }
  return { uploadUrl: url.href, runwayUri: value.runwayUri, fields: entries };
}

/**
 * Resolves an owner/project-scoped private image asset into a temporary
 * Runway upload URI. The caller must provide the application's private
 * asset reader; this module never reads arbitrary filesystem paths.
 *
 * Runway ephemeral URIs expire after 24 hours. This implementation uploads
 * on each preparation attempt rather than persisting temporary URLs.
 */
export function createRunwayPrivateAssetResolver({
  env = process.env,
  fetchImpl = globalThis.fetch,
  loadPrivateAsset,
  timeoutMs = 120000
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Runway asset resolver requires fetch.");
  if (typeof loadPrivateAsset !== "function") throw new Error("Runway asset resolver requires a private asset reader.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
    throw new Error("Runway asset upload timeout must be between 1000 and 300000 milliseconds.");
  }

  async function request(url, options, message, code) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      try {
        const response = await fetchImpl(url, { ...options, signal: controller.signal, redirect: "error" });
        return response;
      } catch (error) {
        throw fail(error?.name === "AbortError" ? "Runway ephemeral upload timed out." : message,
          error?.name === "AbortError" ? "RUNWAY_ASSET_UPLOAD_TIMEOUT" : code);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return async function resolveAssetUri({ assetId, ownerId, projectId = null } = {}) {
    if (typeof assetId !== "string" || !assetId.trim() || assetId.length > 160 ||
        typeof ownerId !== "string" || !ownerId.trim() || ownerId.length > 160 ||
        (projectId !== null && (typeof projectId !== "string" || !projectId.trim() || projectId.length > 160))) {
      throw fail("Runway image asset scope is invalid.", "RUNWAY_IMAGE_ASSET_SCOPE_INVALID");
    }

    let asset;
    try { asset = await loadPrivateAsset({ assetId, ownerId, projectId }); }
    catch { throw fail("Private image asset could not be read.", "RUNWAY_IMAGE_ASSET_READ_FAILED"); }
    const assetProjectId=asset?.projectId??null;
    const requestedProjectId=projectId??null;
    const inAuthorizedProject=requestedProjectId!==null&&assetProjectId===requestedProjectId;
    const ownedPersonalAsset=requestedProjectId===null&&assetProjectId===null&&asset?.ownerId===ownerId;
    if (!asset || asset.id !== assetId || (!inAuthorizedProject&&!ownedPersonalAsset) || asset.isPrivate !== true) {
      throw fail("Image asset does not belong to the authorized owner/project or is not private.", "RUNWAY_IMAGE_ASSET_SCOPE_INVALID");
    }
    if (!Object.hasOwn(IMAGE_TYPES, asset.contentType)) {
      throw fail("Runway Gen-4.5 first-frame input must be PNG, JPEG or WebP.", "RUNWAY_IMAGE_ASSET_TYPE_UNSUPPORTED");
    }
    if (!(Buffer.isBuffer(asset.bytes) || asset.bytes instanceof Uint8Array)) {
      throw fail("Private image asset reader returned invalid file bytes.", "RUNWAY_IMAGE_ASSET_INVALID");
    }
    const bytes = Buffer.from(asset.bytes);
    if (bytes.byteLength < 512 || bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw fail("Private image asset must be between 512 bytes and 200 MB.", "RUNWAY_IMAGE_ASSET_SIZE_INVALID");
    }
    if (typeof asset.filename !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{1,250}$/.test(asset.filename) ||
        !IMAGE_TYPES[asset.contentType].some(extension => asset.filename.toLowerCase().endsWith(extension))) {
      throw fail("Private image asset filename does not match its media type.", "RUNWAY_IMAGE_ASSET_INVALID");
    }
    if (!validImageSignature(bytes, asset.contentType)) {
      throw fail("Private image asset bytes do not match their declared image format.", "RUNWAY_IMAGE_ASSET_INVALID");
    }

    const apiKey = String(env.RUNWAY_API_KEY || "").trim();
    if (!apiKey) throw fail("Runway API key is not configured on the server.", "RUNWAY_CONFIG_INVALID");

    const created = await request(API_BASE + "/uploads", {
      method: "POST",
      headers: {
        authorization: "Bearer " + apiKey,
        "X-Runway-Version": API_VERSION,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({ filename: asset.filename, type: "ephemeral" })
    }, "Runway could not create an ephemeral upload.", "RUNWAY_ASSET_UPLOAD_UNAVAILABLE");

    if (!created.ok) {
      throw fail("Runway rejected ephemeral upload creation (" + created.status + ").", "RUNWAY_ASSET_UPLOAD_REJECTED");
    }
    const raw = await created.text();
    if (Buffer.byteLength(raw, "utf8") > 64000) {
      throw fail("Runway ephemeral upload response exceeded its size limit.", "RUNWAY_ASSET_UPLOAD_RESPONSE_INVALID");
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw fail("Runway returned invalid ephemeral upload JSON.", "RUNWAY_ASSET_UPLOAD_RESPONSE_INVALID"); }
    const upload = validateUploadResponse(parsed);

    if (typeof FormData !== "function" || typeof Blob !== "function") {
      throw fail("This Node runtime does not support secure multipart upload.", "RUNWAY_ASSET_UPLOAD_RUNTIME_UNSUPPORTED");
    }
    const form = new FormData();
    for (const [key, value] of upload.fields) form.append(key, value);
    form.append("file", new Blob([bytes], { type: asset.contentType }), asset.filename);

    const uploaded = await request(upload.uploadUrl, {
      method: "POST",
      body: form
    }, "Runway ephemeral file upload failed.", "RUNWAY_ASSET_UPLOAD_FAILED");
    if (!uploaded.ok) {
      throw fail("Runway ephemeral file upload failed (" + uploaded.status + "). Start a new upload instead of retrying this URL.",
        "RUNWAY_ASSET_UPLOAD_FAILED");
    }
    return upload.runwayUri;
  };
}
