import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/devstorage.read_write",
  "https://www.googleapis.com/auth/cloud-platform"
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const fail = (message, code) => Object.assign(new Error(message), { code });
const MIME_EXTENSIONS = new Map([
  ["image/jpeg","jpg"],["image/png","png"],["image/webp","webp"],["image/gif","gif"],
  ["video/mp4","mp4"],["video/webm","webm"],["video/quicktime","mov"],
  ["audio/mpeg","mp3"],["audio/wav","wav"],["audio/x-wav","wav"],["audio/mp4","m4a"],["audio/ogg","ogg"],
  ["application/pdf","pdf"],["text/plain","txt"],["text/vtt","vtt"],["application/json","json"]
]);

function safeBucket(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) &&
    !value.includes("..") && !value.includes(".-") && !value.includes("-.");
}
function safeToken(value) {
  return typeof value === "string" && value.length >= 20 && value.length <= 8192 && !/\s/.test(value);
}
function safeSessionUri(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "storage.googleapis.com" &&
      !url.username && !url.password && !url.hash && url.pathname.startsWith("/upload/storage/v1/");
  } catch { return false; }
}
function verifyMetadata(metadata, expected) {
  const custom = metadata?.metadata || {};
  return metadata?.bucket === expected.bucket &&
    metadata?.name === expected.objectName &&
    /^\d{1,30}$/.test(String(metadata?.generation || "")) &&
    /^\d{1,30}$/.test(String(metadata?.metageneration || "")) &&
    String(metadata?.size || "") === String(expected.sizeBytes) &&
    metadata?.contentType === expected.mediaType &&
    custom.executivevisualsassetid === expected.assetId &&
    custom.executivevisualsownerid === expected.ownerId &&
    (custom.executivevisualsprojectid || null) === expected.projectId &&
    custom.executivevisualssha256 === expected.sha256;
}

/**
 * Mirrors a previously authorized private asset into a dedicated allowlisted
 * GCS bucket using a create-only resumable upload. It verifies the completed
 * object's generation, metageneration, size, MIME type and custom ownership
 * metadata before recording it in the durable source registry.
 */
export function createGoogleGeminiGcsMirrorWriter({
  env = process.env,
  fetchImpl = globalThis.fetch,
  getAccessToken,
  sourceRepository,
  attemptRepository = null,
  maxBytes = 250 * 1024 * 1024,
  timeoutMs = 120000,
  makeId = randomUUID
} = {}) {
  if (typeof fetchImpl !== "function" || typeof getAccessToken !== "function" ||
      !sourceRepository || typeof sourceRepository.recordVerifiedSource !== "function" ||
      (attemptRepository && (typeof attemptRepository.createAttempt !== "function" ||
        typeof attemptRepository.recordSession !== "function" || typeof attemptRepository.transition !== "function"))) {
    throw new TypeError("GCS mirror writer requires OAuth, fetch and the governed source repository.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024 * 1024 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000 ||
      typeof makeId !== "function") {
    throw new Error("GCS mirror writer limits are invalid.");
  }
  const projectId = String(env.GOOGLE_CLOUD_PROJECT_ID || "").trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw fail("Configure a valid Google Cloud project ID.", "GEMINI_GCS_CONFIG_MISSING");
  }
  const allowedBuckets = new Set(String(env.GEMINI_GCS_ALLOWED_BUCKETS || "")
    .split(",").map(value => value.trim()).filter(Boolean));
  if (!allowedBuckets.size || [...allowedBuckets].some(bucket => !safeBucket(bucket))) {
    throw fail("Configure an explicit valid GCS bucket allowlist.", "GEMINI_GCS_BUCKET_ALLOWLIST_MISSING");
  }
  const bucket = String(env.GEMINI_GCS_MIRROR_BUCKET || "").trim();
  if (!safeBucket(bucket) || !allowedBuckets.has(bucket)) {
    throw fail("The dedicated GCS mirror bucket must be in the server-side allowlist.", "GEMINI_GCS_MIRROR_BUCKET_FORBIDDEN");
  }

  async function token() {
    let value;
    try { value = await getAccessToken({ projectId, scopes: [...SCOPES] }); }
    catch { throw fail("Google Cloud OAuth token acquisition failed.", "GEMINI_GCS_OAUTH_FAILED"); }
    if (!safeToken(value)) throw fail("Google Cloud OAuth token provider returned an invalid token.", "GEMINI_GCS_OAUTH_FAILED");
    return value;
  }

  async function request(url, { method = "GET", accessToken, body, headers = {}, signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            ...(accessToken ? { authorization: "Bearer " + accessToken, "x-goog-user-project": projectId } : {}),
            ...headers
          },
          ...(body === undefined ? {} : { body }),
          ...(body && typeof body === "object" && typeof body.pipe === "function" ? { duplex: "half" } : {}),
          redirect: "error",
          signal: signal || controller.signal
        });
      } catch (error) {
        throw fail(error?.name === "AbortError" ? "GCS mirror request timed out." : "GCS mirror request failed.",
          error?.name === "AbortError" ? "GEMINI_GCS_MIRROR_TIMEOUT" : "GEMINI_GCS_MIRROR_REQUEST_FAILED");
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > 256 * 1024) throw fail("GCS mirror response is too large.", "GEMINI_GCS_MIRROR_RESPONSE_INVALID");
      let data = null;
      if (raw) {
        try { data = JSON.parse(raw); }
        catch { if (response.ok) throw fail("GCS mirror response is invalid.", "GEMINI_GCS_MIRROR_RESPONSE_INVALID"); }
      }
      if (!response.ok) {
        const error = fail("GCS mirror request was rejected (HTTP " + response.status + ").", "GEMINI_GCS_MIRROR_REQUEST_REJECTED");
        error.status = response.status;
        throw error;
      }
      return { response, data };
    } finally { clearTimeout(timer); }
  }

  async function readObjectMetadata(objectName, accessToken) {
    const url = "https://storage.googleapis.com/storage/v1/b/" + encodeURIComponent(bucket) +
      "/o/" + encodeURIComponent(objectName) +
      "?fields=bucket,name,generation,metageneration,size,contentType,metadata";
    return (await request(url, { accessToken })).data;
  }

  async function deleteExactObject(objectName, generation, accessToken) {
    if (!/^\d{1,30}$/.test(String(generation || ""))) return false;
    const url = "https://storage.googleapis.com/storage/v1/b/" + encodeURIComponent(bucket) +
      "/o/" + encodeURIComponent(objectName) + "?ifGenerationMatch=" + encodeURIComponent(generation);
    try {
      await request(url, { method: "DELETE", accessToken });
      return true;
    } catch (error) {
      if (error?.status === 404) return true;
      return false;
    }
  }

  return Object.freeze({
    async mirrorAsset({ assetId, ownerId, projectId: assetProjectId = null, mediaType, filePath, sizeBytes, sha256 } = {}) {
      if (!UUID.test(String(assetId || "")) || !UUID.test(String(ownerId || "")) ||
          (assetProjectId !== null && assetProjectId !== undefined && !UUID.test(String(assetProjectId)))) {
        throw fail("GCS mirror asset scope is invalid.", "GEMINI_GCS_ASSET_SCOPE_INVALID");
      }
      const scopedProjectId = assetProjectId || null;
      if (!MIME_EXTENSIONS.has(mediaType) || !Number.isSafeInteger(sizeBytes) ||
          sizeBytes < 1 || sizeBytes > maxBytes || typeof filePath !== "string" || !filePath ||
          typeof sha256 !== "string" || !SHA256.test(sha256)) {
        throw fail("GCS mirror file metadata is invalid.", "GEMINI_GCS_ASSET_INVALID");
      }
      let fileStat;
      try { fileStat = await stat(filePath); }
      catch { throw fail("Authorized private source file is unavailable.", "GEMINI_GCS_SOURCE_FILE_MISSING"); }
      if (!fileStat.isFile() || fileStat.size !== sizeBytes) {
        throw fail("Authorized private source file size changed before mirroring.", "GEMINI_GCS_SOURCE_FILE_MISMATCH");
      }

      const objectName = "mirrors/" + ownerId + "/" + (scopedProjectId || "personal") +
        "/" + assetId + "/" + makeId() + "." + MIME_EXTENSIONS.get(mediaType);
      if (objectName.length > 1024) throw fail("Generated GCS object name is invalid.", "GEMINI_GCS_OBJECT_NAME_INVALID");
      const expected = {
        assetId, ownerId, projectId: scopedProjectId, bucket, objectName,
        sizeBytes, mediaType, sha256
      };
      const accessToken = await token();
      const attempt = attemptRepository ? await attemptRepository.createAttempt({
        assetId, ownerId, projectId: scopedProjectId, bucket, objectName,
        mediaType, sizeBytes, sha256
      }) : null;
      const metadata = {
        name: objectName,
        contentType: mediaType,
        metadata: {
          executivevisualsassetid: assetId,
          executivevisualsownerid: ownerId,
          ...(scopedProjectId ? { executivevisualsprojectid: scopedProjectId } : {}),
          executivevisualssha256: sha256
        }
      };
      const initiateUrl = "https://storage.googleapis.com/upload/storage/v1/b/" +
        encodeURIComponent(bucket) + "/o?uploadType=resumable&ifGenerationMatch=0&name=" +
        encodeURIComponent(objectName);
      let initiated;
      try {
        initiated = await request(initiateUrl, {
          method: "POST", accessToken, body: JSON.stringify(metadata),
          headers: {
            "content-type": "application/json",
            "x-upload-content-type": mediaType,
            "x-upload-content-length": String(sizeBytes)
          }
        });
      } catch (error) {
        if (attempt) {
          try { await attemptRepository.transition({attemptId:attempt.id,expectedState:"PREPARED",state:"FAILED",errorCode:error.code || "GEMINI_GCS_SESSION_INIT_FAILED"}); } catch {}
        }
        throw error;
      }
      const sessionUri = initiated.response.headers.get("location");
      if (!safeSessionUri(sessionUri)) {
        if (attempt) {
          try { await attemptRepository.transition({attemptId:attempt.id,expectedState:"PREPARED",state:"FAILED",errorCode:"GEMINI_GCS_UPLOAD_SESSION_INVALID"}); } catch {}
        }
        throw fail("GCS did not return a valid resumable upload session.", "GEMINI_GCS_UPLOAD_SESSION_INVALID");
      }
      if (attempt) {
        try {
          await attemptRepository.recordSession({
            attemptId: attempt.id, sessionUri,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
          });
        } catch (error) {
          try { await attemptRepository.transition({attemptId:attempt.id,expectedState:"PREPARED",state:"FAILED",errorCode:"GEMINI_GCS_ATTEMPT_SESSION_PERSIST_FAILED"}); } catch {}
          throw error;
        }
      }

      let uploaded = false;
      let verifiedObject = false;
      let generation = null;
      try {
        const stream = createReadStream(filePath);
        let completed;
        try {
          completed = await request(sessionUri, {
            method: "PUT",
            body: stream,
            headers: { "content-type": mediaType, "content-length": String(sizeBytes) }
          });
        } catch (error) {
          error.outcomeUnknown = true;
          error.cleanupPending = true;
          if (attempt) {
            try { await attemptRepository.transition({attemptId:attempt.id,expectedState:"UPLOADING",state:"OUTCOME_UNKNOWN",errorCode:error.code || "GEMINI_GCS_UPLOAD_OUTCOME_UNKNOWN"}); } catch {}
          }
          throw error;
        }
        uploaded = completed.response.status === 200 || completed.response.status === 201;
        if (!uploaded) throw fail("GCS resumable upload did not complete.", "GEMINI_GCS_UPLOAD_INCOMPLETE");
        generation = String(completed.data?.generation || "");
        const verified = await readObjectMetadata(objectName, accessToken);
        generation = String(verified?.generation || generation);
        if (!verifyMetadata(verified, expected)) {
          throw fail("Uploaded GCS mirror failed exact object metadata verification.", "GEMINI_GCS_MIRROR_INTEGRITY_MISMATCH");
        }
        generation = String(verified.generation);
        verifiedObject = true;
        if (attempt) {
          await attemptRepository.transition({
            attemptId:attempt.id,expectedState:"UPLOADING",state:"OBJECT_VERIFIED",
            generation,metageneration:String(verified.metageneration)
          });
        }
        const source = await sourceRepository.recordVerifiedSource({
          assetId, ownerId, projectId: scopedProjectId, bucket, objectName,
          generation, metageneration: String(verified.metageneration),
          sizeBytes, mediaType, sha256
        });
        if (attempt) {
          await attemptRepository.transition({attemptId:attempt.id,expectedState:"OBJECT_VERIFIED",state:"REGISTERED",generation,metageneration:String(verified.metageneration)});
        }
        return Object.freeze({
          source,
          gcsUri: "gs://" + bucket + "/" + objectName,
          generation,
          reused: false
        });
      } catch (error) {
        if (uploaded && generation && !(attempt && verifiedObject)) {
          const removed = await deleteExactObject(objectName, generation, accessToken);
          if (!removed) error.cleanupPending = true;
        }
        if (attempt && !verifiedObject && !error.outcomeUnknown) {
          try {
            await attemptRepository.transition({
              attemptId:attempt.id,expectedState:"UPLOADING",state:"FAILED",
              errorCode:error.code || "GEMINI_GCS_MIRROR_FAILED"
            });
          } catch {}
        }
        throw error;
      }
    }
  });
}
