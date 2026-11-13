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
      file.trashed === true || file.capabilities?.canDownload !== true ||
      !MIME_TYPES.has(file.mimeType) ||
      !Number.isSafeInteger(Number(file.size)) || Number(file.size) < 1 ||
      Number(file.size) > maxBytes) {
    throw fail("Google Drive file is trashed, inaccessible, unsupported, or exceeds the private asset limit.",
      "GOOGLE_DRIVE_FILE_UNSUPPORTED");
  }
  return { id: file.id, name: safeName(file.name), mimeType: file.mimeType, size: Number(file.size) };
}

function validateDriveFolder(folder, expectedId) {
  if (!folder || typeof folder !== "object" || Array.isArray(folder) ||
      folder.id !== expectedId || folder.mimeType !== "application/vnd.google-apps.folder" ||
      folder.trashed === true || folder.capabilities?.canAddChildren !== true) {
    throw fail("Google Drive destination must be an accessible folder where this account can add files.",
      "GOOGLE_DRIVE_FOLDER_UNAVAILABLE");
  }
  return folder.id;
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
  timeoutMs = 30000,
  onCleanupError = () => {},
  attempts = null
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

  async function request(url, accessToken, { method = "GET", headers = {}, body, raw = false, readBytes = false, allowStatuses = [] } = {}) {
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
      if (!response.ok && !allowStatuses.includes(response.status)) {
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
      if (parentFolderId) {
        const folderUrl = DRIVE_ORIGIN + "/drive/v3/files/" + encodeURIComponent(parentFolderId) +
          "?supportsAllDrives=true&fields=id,mimeType,trashed,capabilities(canAddChildren)";
        validateDriveFolder(await request(folderUrl, accessToken), parentFolderId);
      }
      let loaded;
      try { loaded = await loadPrivateAsset({ ...scope, assetId }); }
      catch { throw fail("Private asset could not be authorized for Google Drive export.", "GOOGLE_DRIVE_ASSET_FORBIDDEN"); }
      try {
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
        const initUrl = DRIVE_ORIGIN + "/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size,md5Checksum,webViewLink,appProperties";
        const expectedMd5 = createHash("md5").update(bytes).digest("hex");
        let attemptRecord = null;
        let session = null;
        let leaseToken = null;
        const readExistingDriveFile = async driveFileId => {
          const url = DRIVE_ORIGIN + "/drive/v3/files/" + encodeURIComponent(driveFileId) +
            "?supportsAllDrives=true&fields=id,name,mimeType,size,md5Checksum,webViewLink,appProperties,trashed";
          const response = await request(url, accessToken, { raw: true, allowStatuses: [404] });
          if (response.status === 404) return null;
          let file;
          try { file = JSON.parse(await response.text()); }
          catch { throw fail("Google Drive returned invalid reconciliation metadata.", "GOOGLE_DRIVE_RESPONSE_INVALID"); }
          if (!file || file.id !== driveFileId || file.trashed === true ||
              file.appProperties?.source !== "executive-visuals" || file.appProperties?.assetId !== assetId ||
              file.mimeType !== asset.mediaType || Number(file.size) !== bytes.byteLength ||
              typeof file.md5Checksum !== "string" || file.md5Checksum.toLowerCase() !== expectedMd5) {
            throw fail("Existing Google Drive file does not match the private asset export attempt.",
              "GOOGLE_DRIVE_EXPORT_RECONCILIATION_CONFLICT");
          }
          return file;
        };
        const completedResult = async file => {
          if (attempts && attemptRecord?.state !== "COMPLETED") {
            await attempts.mark({ attemptKey: attemptRecord.attemptKey, ownerId: scope.ownerId,
              state: "COMPLETED", leaseToken, webViewLink: typeof file.webViewLink === "string" &&
                file.webViewLink.startsWith("https://drive.google.com/") ? file.webViewLink : null });
          }
          return Object.freeze({ id: file.id, name: safeName(file.name), mimeType: file.mimeType,
            size: bytes.byteLength, webViewLink: typeof file.webViewLink === "string" &&
              file.webViewLink.startsWith("https://drive.google.com/") ? file.webViewLink : null });
        };
        if (attempts) {
          if (typeof attempts.get !== "function" || typeof attempts.createOrGet !== "function" || typeof attempts.claim !== "function" ||
              typeof attempts.saveSession !== "function" || typeof attempts.mark !== "function") {
            throw new TypeError("Google Drive export attempt store is incomplete.");
          }
          const attemptKey = createHash("sha256").update(JSON.stringify({
            ownerId: scope.ownerId, projectId: scope.projectId, assetId, parentFolderId,
            sha256: asset.sha256, byteSize: bytes.byteLength, mimeType: asset.mediaType
          })).digest("hex");
          attemptRecord = await attempts.get(attemptKey, scope.ownerId);
          if (!attemptRecord) {
            const generated = await request(DRIVE_ORIGIN + "/drive/v3/files/generateIds?count=1&space=drive", accessToken);
            if (!Array.isArray(generated?.ids) || generated.ids.length !== 1 ||
                typeof generated.ids[0] !== "string" || !FILE_ID.test(generated.ids[0])) {
              throw fail("Google Drive did not return a valid pre-generated file ID.", "GOOGLE_DRIVE_GENERATED_ID_INVALID");
            }
            attemptRecord = await attempts.createOrGet({ attemptKey, ownerId: scope.ownerId,
              projectId: scope.projectId, assetId, parentFolderId, driveFileId: generated.ids[0],
              mimeType: asset.mediaType, byteSize: bytes.byteLength, sha256: asset.sha256 });
          }
          if (attemptRecord.ownerId !== scope.ownerId || attemptRecord.projectId !== scope.projectId ||
              attemptRecord.assetId !== assetId || attemptRecord.mimeType !== asset.mediaType ||
              attemptRecord.sha256 !== asset.sha256 || attemptRecord.byteSize !== bytes.byteLength ||
              attemptRecord.parentFolderId !== parentFolderId) {
            throw fail("Stored Drive export attempt does not match the authorized private asset.",
              "GOOGLE_DRIVE_EXPORT_IDEMPOTENCY_CONFLICT");
          }
          if (attemptRecord.state === "COMPLETED") {
            const existing = await readExistingDriveFile(attemptRecord.driveFileId);
            if (!existing) throw fail("Completed Drive export is missing from the provider; manual reconciliation is required.",
              "GOOGLE_DRIVE_EXPORT_RECONCILIATION_REQUIRED");
            return await completedResult(existing);
          }
          if (attemptRecord.state === "RECONCILIATION_REQUIRED") {
            if (typeof attempts.claimForReconciliation !== "function") {
              throw fail("Drive export store does not support safe reconciliation claims.",
                "GOOGLE_DRIVE_EXPORT_STORE_INCOMPLETE");
            }
            leaseToken = await attempts.claimForReconciliation({ attemptKey: attemptRecord.attemptKey, ownerId: scope.ownerId });
          } else {
            leaseToken = await attempts.claim({ attemptKey: attemptRecord.attemptKey, ownerId: scope.ownerId });
          }
          if (!leaseToken) throw fail("Another worker is already processing this Drive export attempt.",
            "GOOGLE_DRIVE_EXPORT_IN_PROGRESS");
          if (attemptRecord.state === "RECONCILIATION_REQUIRED") {
            let existing;
            try {
              existing = await readExistingDriveFile(attemptRecord.driveFileId);
            } catch (error) {
              try {
                await attempts.mark({ attemptKey: attemptRecord.attemptKey, ownerId: scope.ownerId,
                  state: "RECONCILIATION_REQUIRED", errorCode: error?.code || "GOOGLE_DRIVE_RECONCILIATION_FAILED",
                  leaseToken });
              } catch {}
              throw error;
            }
            if (existing) return await completedResult(existing);
            await attempts.mark({ attemptKey: attemptRecord.attemptKey, ownerId: scope.ownerId,
              state: "RECONCILIATION_REQUIRED", errorCode: "GOOGLE_DRIVE_RECONCILIATION_FILE_NOT_FOUND",
              leaseToken });
            throw fail("Google Drive export still requires manual reconciliation; no new upload was started.",
              "GOOGLE_DRIVE_EXPORT_RECONCILIATION_REQUIRED");
          }
          if (attemptRecord.state === "OUTCOME_UNKNOWN") {
            const existing = await readExistingDriveFile(attemptRecord.driveFileId);
            if (existing) return await completedResult(existing);
          }
          session = attemptRecord.sessionUri ? safeUploadSession(attemptRecord.sessionUri) : null;
          if (!session) {
            const existing = await readExistingDriveFile(attemptRecord.driveFileId);
            if (existing) return await completedResult(existing);
            metadata.id = attemptRecord.driveFileId;
          }
        }
        if (!session) {
          let init;
          try {
            init = await request(initUrl, accessToken, {
              method: "POST",
              headers: {
                "content-type": "application/json; charset=UTF-8",
                "x-upload-content-type": asset.mediaType,
                "x-upload-content-length": String(bytes.byteLength)
              },
              body: JSON.stringify(metadata), raw: true
            });
          } catch (error) {
            if (attempts && attemptRecord) {
              if (error?.status === 409) {
                const existing = await readExistingDriveFile(attemptRecord.driveFileId);
                if (existing) return await completedResult(existing);
                await attempts.mark({ attemptKey: attemptRecord.attemptKey, ownerId: scope.ownerId,
                  state: "RECONCILIATION_REQUIRED", errorCode: "GOOGLE_DRIVE_EXPORT_FILE_ID_CONFLICT", leaseToken });
                throw fail("Reserved Google Drive file ID conflicts with an existing provider resource; manual reconciliation is required.",
                  "GOOGLE_DRIVE_EXPORT_RECONCILIATION_REQUIRED");
              }
              const ambiguous = ["GOOGLE_DRIVE_TIMEOUT", "GOOGLE_DRIVE_REQUEST_FAILED", "GOOGLE_DRIVE_PROVIDER_ERROR"]
                .includes(error?.code) && (!error.status || error.status >= 500);
              await attempts.mark({ attemptKey: attemptRecord.attemptKey, ownerId: scope.ownerId,
                state: ambiguous ? "OUTCOME_UNKNOWN" : "FAILED",
                errorCode: error?.code || "GOOGLE_DRIVE_UPLOAD_INIT_FAILED", leaseToken });
            }
            throw error;
          }
          try {
            session = safeUploadSession(init.headers?.get?.("location"));
          } catch (error) {
            if (attempts && attemptRecord) await attempts.mark({ attemptKey: attemptRecord.attemptKey,
              ownerId: scope.ownerId, state: "FAILED", errorCode: error?.code || "GOOGLE_DRIVE_UPLOAD_SESSION_INVALID", leaseToken });
            throw error;
          }
          if (attempts) {
            try {
              attemptRecord = await attempts.saveSession({ attemptKey: attemptRecord.attemptKey,
                ownerId: scope.ownerId, sessionUri: session, leaseToken });
            } catch (error) {
              await attempts.mark({ attemptKey: attemptRecord.attemptKey, ownerId: scope.ownerId,
                state: "OUTCOME_UNKNOWN", errorCode: error?.code || "GOOGLE_DRIVE_SESSION_PERSIST_FAILED", leaseToken });
              throw error;
            }
          }
        }
        let uploadResponse;
        let offset = 0;
        let completed = false;
        try {
          for (let attempt = 0; attempt < 6 && !completed; attempt++) {
            try {
            uploadResponse = await request(session, accessToken, {
              method: "PUT",
              headers: {
                "content-type": asset.mediaType,
                "content-length": String(bytes.byteLength - offset),
                "content-range": `bytes ${offset}-${bytes.byteLength - 1}/${bytes.byteLength}`
              },
              body: bytes.subarray(offset),
              raw: true,
              allowStatuses: [308]
            });
          } catch (error) {
            if (error?.status === 404) {
              if (attempts) await attempts.mark({ attemptKey: attemptRecord.attemptKey, ownerId: scope.ownerId,
                state: "RECONCILIATION_REQUIRED", errorCode: "GOOGLE_DRIVE_UPLOAD_SESSION_EXPIRED", leaseToken });
              throw fail("Google Drive resumable session expired; reconcile the reserved file ID before restarting.",
                "GOOGLE_DRIVE_UPLOAD_SESSION_EXPIRED");
            }
            if (!["GOOGLE_DRIVE_TIMEOUT", "GOOGLE_DRIVE_REQUEST_FAILED", "GOOGLE_DRIVE_PROVIDER_ERROR"].includes(error?.code) ||
                (error.status && error.status < 500)) throw error;
            uploadResponse = await request(session, accessToken, {
              method: "PUT",
              headers: { "content-length": "0", "content-range": `bytes */${bytes.byteLength}` },
              raw: true,
              allowStatuses: [308, 404]
            });
          }
          if (uploadResponse.status === 404) {
            if (attempts) await attempts.mark({ attemptKey: attemptRecord.attemptKey, ownerId: scope.ownerId,
              state: "RECONCILIATION_REQUIRED", errorCode: "GOOGLE_DRIVE_UPLOAD_SESSION_EXPIRED", leaseToken });
            throw fail("Google Drive resumable session expired; reconcile the reserved file ID before restarting.",
              "GOOGLE_DRIVE_UPLOAD_SESSION_EXPIRED");
          }
          if (uploadResponse.status === 308) {
            const range = uploadResponse.headers?.get?.("range");
            if (range === null || range === undefined) offset = 0;
            else {
              const match = /^bytes=0-(\d+)$/.exec(range);
              if (!match) throw fail("Google Drive returned an invalid resumable upload range.", "GOOGLE_DRIVE_UPLOAD_RANGE_INVALID");
              offset = Number(match[1]) + 1;
              if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.byteLength) {
                throw fail("Google Drive returned an out-of-bounds resumable upload range.", "GOOGLE_DRIVE_UPLOAD_RANGE_INVALID");
              }
            }
            if (offset === bytes.byteLength) {
              throw fail("Google Drive reported all bytes received without confirming file creation.",
                "GOOGLE_DRIVE_UPLOAD_COMPLETION_UNCONFIRMED");
            }
            continue;
          }
          if (uploadResponse.status === 200 || uploadResponse.status === 201) completed = true;
          }
        } catch (error) {
          if (attempts && attemptRecord && error?.code !== "GOOGLE_DRIVE_UPLOAD_SESSION_EXPIRED") {
            try { await attempts.mark({ attemptKey: attemptRecord.attemptKey, ownerId: scope.ownerId,
              state: "OUTCOME_UNKNOWN", errorCode: error?.code || "GOOGLE_DRIVE_UPLOAD_OUTCOME_UNKNOWN", leaseToken }); } catch {}
          }
          throw error;
        }
        if (!completed || !uploadResponse) {
          if (attempts) await attempts.mark({ attemptKey: attemptRecord.attemptKey, ownerId: scope.ownerId,
            state: "OUTCOME_UNKNOWN", errorCode: "GOOGLE_DRIVE_UPLOAD_RECOVERY_EXHAUSTED", leaseToken });
          throw fail("Google Drive resumable upload did not complete within the bounded recovery attempts.",
            "GOOGLE_DRIVE_UPLOAD_RECOVERY_EXHAUSTED");
        }
        let uploaded;
        try {
          const raw = await uploadResponse.text();
          uploaded = raw ? JSON.parse(raw) : null;
          if (!uploaded || typeof uploaded.id !== "string" || !FILE_ID.test(uploaded.id) ||
              (attempts && (uploaded.id !== attemptRecord.driveFileId || uploaded.appProperties?.assetId !== assetId ||
                uploaded.appProperties?.source !== "executive-visuals")) ||
              uploaded.mimeType !== asset.mediaType || Number(uploaded.size) !== bytes.byteLength ||
              typeof uploaded.md5Checksum !== "string" || !/^[a-f0-9]{32}$/i.test(uploaded.md5Checksum) ||
              uploaded.md5Checksum.toLowerCase() !== expectedMd5) {
            throw fail("Google Drive upload completed without matching size, MIME type, and content checksum.",
              "GOOGLE_DRIVE_UPLOAD_RESPONSE_INVALID");
          }
        } catch (error) {
          // The provider may have committed the file even when its completion
          // payload is missing or untrustworthy. Preserve the reserved ID and
          // release the lease into reconciliation instead of inviting a blind retry.
          if (attempts && attemptRecord) {
            try {
              await attempts.mark({ attemptKey: attemptRecord.attemptKey, ownerId: scope.ownerId,
                state: "RECONCILIATION_REQUIRED", errorCode: error?.code || "GOOGLE_DRIVE_RESPONSE_INVALID", leaseToken });
            } catch {}
          }
          throw error?.code ? error : fail("Google Drive completed an upload but returned invalid file metadata.",
            "GOOGLE_DRIVE_RESPONSE_INVALID");
        }
        if (attempts) {
          await attempts.mark({ attemptKey: attemptRecord.attemptKey, ownerId: scope.ownerId, state: "COMPLETED", leaseToken,
            webViewLink: typeof uploaded.webViewLink === "string" &&
              uploaded.webViewLink.startsWith("https://drive.google.com/") ? uploaded.webViewLink : null });
        }
        return Object.freeze({
          id: uploaded.id, name: safeName(uploaded.name), mimeType: uploaded.mimeType,
          size: bytes.byteLength,
          webViewLink: typeof uploaded.webViewLink === "string" &&
            uploaded.webViewLink.startsWith("https://drive.google.com/") ? uploaded.webViewLink : null
        });
      } finally {
        if (typeof loaded?.cleanup === "function") {
          try { await loaded.cleanup(); }
          catch {
            try { onCleanupError({ code: "GOOGLE_DRIVE_TEMP_CLEANUP_FAILED" }); } catch {}
          }
        }
      }
    }
  });
}
