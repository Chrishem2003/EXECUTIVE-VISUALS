import { createHash } from "node:crypto";

const DRIVE_ORIGIN = "https://www.googleapis.com";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const MAX_BYTES = 250 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/quicktime", "video/x-matroska",
  "audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/ogg",
  "application/pdf", "text/plain", "text/vtt", "application/json"
]);
const fail = (message, code) => Object.assign(new Error(message), { code });

function validScope({ ownerId, projectId = null }) {
  if (typeof ownerId !== "string" || !UUID.test(ownerId) ||
      (projectId !== null && projectId !== undefined && projectId !== "" &&
       (typeof projectId !== "string" || !UUID.test(projectId)))) {
    throw fail("Google Drive operation requires a valid owner and optional project UUID.", "GOOGLE_DRIVE_SCOPE_INVALID");
  }
  return { ownerId, projectId: projectId || null };
}

function safeName(value) {
  const name = String(value || "drive-import").normalize("NFKC")
    .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
    .replace(/[^\p{L}\p{N}._() -]/gu, "_").trim().slice(0, 180);
  return name || "drive-import";
}

function validateDriveFile(file, maxBytes) {
  if (!file || typeof file !== "object" || Array.isArray(file) ||
      typeof file.id !== "string" || !FILE_ID.test(file.id) ||
      typeof file.name !== "string" || !file.name.trim() ||
      file.trashed === true || file.capabilities?.canDownload === false ||
      !MIME_TYPES.has(file.mimeType) ||
      !Number.isSafeInteger(Number(file.size)) || Number(file.size) < 1 ||
      Number(file.size) > maxBytes) {
    throw fail("Google Drive file is trashed, inaccessible, unsupported, or exceeds the private asset limit.",
      "GOOGLE_DRIVE_FILE_UNSUPPORTED");
  }
  return { id: file.id, name: safeName(file.name), mimeType: file.mimeType, size: Number(file.size) };
}

function safeUploadSession(value) {
  let url;
  try { url = new URL(value); } catch { throw fail("Google Drive returned an invalid resumable upload session.", "GOOGLE_DRIVE_UPLOAD_SESSION_INVALID"); }
  if (url.protocol !== "https:" ||
      !["www.googleapis.com", "upload.googleapis.com"].includes(url.hostname) ||
      url.username || url.password || url.hash || (url.port && url.port !== "443") ||
      url.pathname !== "/upload/drive/v3/files" ||
      !url.searchParams.has("upload_id")) {
    throw fail("Google Drive returned an upload session outside the approved API origin.", "GOOGLE_DRIVE_UPLOAD_SESSION_INVALID");
  }
  return url.toString();
}

/**
 * Private, per-user Google Drive bridge. OAuth tokens are obtained on demand
 * from the host's encrypted user-connection store and are never persisted here.
 * drive.file limits access to files the user explicitly selects or creates
 * with this application (for example through Google Picker).
 */
export function createGoogleDrivePrivateFileBridge({
  getUserAccessToken,
  assets,
  loadPrivateAsset,
  fetchImpl = globalThis.fetch,
  maxBytes = MAX_BYTES,
  timeoutMs = 30000
} = {}) {
  if (typeof getUserAccessToken !== "function" || typeof fetchImpl !== "function") {
    throw new TypeError("Google Drive bridge requires a per-user OAuth token provider and fetch.");
  }
  if (!assets || typeof assets.create !== "function" ||
      typeof loadPrivateAsset !== "function") {
    throw new TypeError("Google Drive bridge requires the private Cloud Asset Service and asset loader.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error("Google Drive bridge limits are invalid.");
  }

  async function token(ownerId) {
    let value;
    try { value = await getUserAccessToken({ ownerId, scopes: [DRIVE_SCOPE] }); }
    catch { throw fail("Google Drive account is not connected or authorization has expired.", "GOOGLE_DRIVE_AUTH_REQUIRED"); }
    if (typeof value !== "string" || value.length < 20 || value.length > 8192 || /\s/.test(value)) {
      throw fail("Google Drive OAuth token provider returned an invalid token.", "GOOGLE_DRIVE_AUTH_REQUIRED");
    }
    return value;
  }

  async function request(url, accessToken, { method = "GET", headers = {}, body, raw = false, readBytes = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          method, headers: { authorization: "Bearer " + accessToken, ...headers },
          ...(body === undefined ? {} : { body }),
          redirect: "error", signal: controller.signal
        });
      } catch (error) {
        throw fail(error?.name === "AbortError" ? "Google Drive request timed out." : "Google Drive request failed.",
          error?.name === "AbortError" ? "GOOGLE_DRIVE_TIMEOUT" : "GOOGLE_DRIVE_REQUEST_FAILED");
      }
      if (!response.ok) {
        const status = response.status;
        const error = fail("Google Drive rejected the request (HTTP " + status + ").",
          status === 401 || status === 403 ? "GOOGLE_DRIVE_ACCESS_DENIED" :
          status === 429 ? "GOOGLE_DRIVE_RATE_LIMITED" : "GOOGLE_DRIVE_PROVIDER_ERROR");
        error.status = status;
        throw error;
      }
      if (readBytes) {
        const reader = response.body?.getReader?.();
        if (!reader) throw fail("Google Drive media response did not provide a readable stream.", "GOOGLE_DRIVE_RESPONSE_INVALID");
        const chunks = [];
        let total = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            total += part.value.byteLength;
            if (total > maxBytes) {
              await reader.cancel().catch(() => {});
              throw fail("Google Drive download exceeded the private asset size limit.", "GOOGLE_DRIVE_FILE_TOO_LARGE");
            }
            chunks.push(part.value);
          }
        } catch (error) {
          if (error?.code) throw error;
          throw fail("Google Drive media download was interrupted.", "GOOGLE_DRIVE_REQUEST_FAILED");
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return { headers: response.headers, bytes };
      }
      if (raw) return response;
      const text = await response.text();
      if (text.length > 1024 * 1024) throw fail("Google Drive response exceeded the metadata limit.", "GOOGLE_DRIVE_RESPONSE_TOO_LARGE");
      try { return text ? JSON.parse(text) : null; }
      catch { throw fail("Google Drive returned invalid JSON.", "GOOGLE_DRIVE_RESPONSE_INVALID"); }
    } finally { clearTimeout(timer); }
  }

  return Object.freeze({
    async importFile({ ownerId, projectId = null, fileId } = {}) {
      const scope = validScope({ ownerId, projectId });
      if (typeof fileId !== "string" || !FILE_ID.test(fileId)) {
        throw fail("Google Drive file ID is invalid.", "GOOGLE_DRIVE_FILE_ID_INVALID");
      }
      const accessToken = await token(scope.ownerId);
      const metadataUrl = DRIVE_ORIGIN + "/drive/v3/files/" + encodeURIComponent(fileId) +
        "?supportsAllDrives=true&fields=id,name,mimeType,size,trashed,capabilities(canDownload)";
      const metadata = validateDriveFile(await request(metadataUrl, accessToken), maxBytes);
      const response = await request(DRIVE_ORIGIN + "/drive/v3/files/" + encodeURIComponent(fileId) +
        "?alt=media&supportsAllDrives=true", accessToken, { readBytes: true });
      const declared = Number(response.headers?.get?.("content-length") || metadata.size);
      if (declared !== metadata.size || declared > maxBytes) {
        throw fail("Google Drive download size did not match authorized file metadata.", "GOOGLE_DRIVE_SIZE_MISMATCH");
      }
      const returnedType = response.headers?.get?.("content-type")?.split(";")[0]?.trim();
      if (returnedType && returnedType !== metadata.mimeType && returnedType !== "application/octet-stream") {
        throw fail("Google Drive download MIME type did not match authorized file metadata.", "GOOGLE_DRIVE_MIME_MISMATCH");
      }
      const bytes = response.bytes;
      if (bytes.byteLength !== metadata.size || bytes.byteLength > maxBytes) {
        throw fail("Google Drive returned a truncated or oversized file.", "GOOGLE_DRIVE_SIZE_MISMATCH");
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      const asset = await assets.create({
        ...scope, originalName: metadata.name, mediaType: metadata.mimeType, bytes,
        metadata: { source: "google-drive-import", provider: "google-drive", providerFileId: metadata.id, sha256: digest }
      });
      return Object.freeze({ asset, source: "google-drive", sourceFileId: metadata.id });
    },

    async uploadPrivateAsset({ ownerId, projectId = null, assetId, parentFolderId = null } = {}) {
      const scope = validScope({ ownerId, projectId });
      if (typeof assetId !== "string" || !UUID.test(assetId) ||
          (parentFolderId !== null && (typeof parentFolderId !== "string" || !FILE_ID.test(parentFolderId)))) {
        throw fail("Google Drive export asset or destination folder ID is invalid.", "GOOGLE_DRIVE_EXPORT_SCOPE_INVALID");
      }
      const accessToken = await token(scope.ownerId);
      let loaded;
      try { loaded = await loadPrivateAsset({ ...scope, assetId }); }
      catch { throw fail("Private asset could not be authorized for Google Drive export.", "GOOGLE_DRIVE_ASSET_FORBIDDEN"); }
      const asset = loaded?.asset;
      const bytes = loaded?.bytes;
      if (!asset || asset.id !== assetId || (asset.projectId || null) !== scope.projectId ||
          (!scope.projectId && asset.ownerId !== scope.ownerId) ||
          asset.storageBucket !== "executive-visuals-media" ||
          !MIME_TYPES.has(asset.mediaType) ||
          !(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maxBytes ||
          Number(asset.size) !== bytes.byteLength ||
          typeof asset.sha256 !== "string" ||
          createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
        throw fail("Private asset metadata, ownership, or content hash failed verification.", "GOOGLE_DRIVE_ASSET_INVALID");
      }
      const metadata = {
        name: safeName(asset.name),
        mimeType: asset.mediaType,
        ...(parentFolderId ? { parents: [parentFolderId] } : {}),
        appProperties: { source: "executive-visuals", assetId }
      };
      const initUrl = DRIVE_ORIGIN + "/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink";
      const init = await request(initUrl, accessToken, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "x-upload-content-type": asset.mediaType,
          "x-upload-content-length": String(bytes.byteLength)
        },
        body: JSON.stringify(metadata), raw: true
      });
      const session = safeUploadSession(init.headers?.get?.("location"));
      const uploaded = await request(session, accessToken, {
        method: "PUT",
        headers: { "content-type": asset.mediaType, "content-length": String(bytes.byteLength) },
        body: bytes
      });
      if (!uploaded || typeof uploaded.id !== "string" || !FILE_ID.test(uploaded.id) ||
          uploaded.mimeType !== asset.mediaType || Number(uploaded.size) !== bytes.byteLength) {
        throw fail("Google Drive upload completed without a matching file resource.", "GOOGLE_DRIVE_UPLOAD_RESPONSE_INVALID");
      }
      return Object.freeze({
        id: uploaded.id, name: safeName(uploaded.name), mimeType: uploaded.mimeType,
        size: bytes.byteLength,
        webViewLink: typeof uploaded.webViewLink === "string" &&
          uploaded.webViewLink.startsWith("https://drive.google.com/") ? uploaded.webViewLink : null
      });
    }
  });
}
