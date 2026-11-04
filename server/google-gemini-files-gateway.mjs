import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

const API_ORIGIN = "https://generativelanguage.googleapis.com";
const FILE_URI = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/([A-Za-z0-9_-]+)$/;
const FILE_NAME = /^files\/([A-Za-z0-9_-]+)$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const fail = (message, code) => Object.assign(new Error(message), { code });
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);

function safeMime(value) {
  const mime = String(value || "").toLowerCase().split(";")[0].trim();
  const allowed = new Set([
    "image/jpeg", "image/png", "image/webp", "image/gif",
    "video/mp4", "video/webm", "video/quicktime",
    "audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/ogg",
    "application/pdf", "text/plain", "text/vtt", "application/json"
  ]);
  if (!allowed.has(mime)) throw fail("This media type is not supported by the Google Files gateway.", "GEMINI_FILE_MIME_UNSUPPORTED");
  return mime;
}

function validateFileResource(file, expectedMime, expectedBytes) {
  if (!plain(file) || typeof file.name !== "string" || !FILE_NAME.test(file.name)) {
    throw fail("Google Files API returned an invalid file resource.", "GEMINI_FILE_RESPONSE_INVALID");
  }
  if (typeof file.uri !== "string" || !FILE_URI.test(file.uri)) {
    throw fail("Google Files API returned an unexpected file URI.", "GEMINI_FILE_RESPONSE_INVALID");
  }
  if (file.mimeType && file.mimeType !== expectedMime) {
    throw fail("Google Files API returned an unexpected MIME type.", "GEMINI_FILE_RESPONSE_INVALID");
  }
  if (file.sizeBytes !== undefined && Number(file.sizeBytes) !== expectedBytes) {
    throw fail("Google Files API returned an unexpected file size.", "GEMINI_FILE_RESPONSE_INVALID");
  }
  return Object.freeze({
    name: file.name,
    uri: file.uri,
    mimeType: expectedMime,
    sizeBytes: expectedBytes,
    state: String(file.state || "PROCESSING").toUpperCase()
  });
}

async function digestPrivateAsset({ bytes, path }) {
  const hash = createHash("sha256");
  if (bytes instanceof Uint8Array) {
    hash.update(bytes);
    return hash.digest("hex");
  }
  if (typeof path === "string" && path) {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  }
  throw fail("Private asset reader did not return bytes or a file path.", "GEMINI_FILE_ASSET_INVALID");
}

async function* chunksFromAsset(asset, chunkSize) {
  if (asset.bytes instanceof Uint8Array) {
    for (let offset = 0; offset < asset.bytes.byteLength; offset += chunkSize) {
      yield Buffer.from(asset.bytes.subarray(offset, Math.min(offset + chunkSize, asset.bytes.byteLength)));
    }
    return;
  }
  if (typeof asset.path === "string" && asset.path) {
    for await (const chunk of createReadStream(asset.path, { highWaterMark: chunkSize })) {
      yield Buffer.from(chunk);
    }
    return;
  }
  throw fail("Private asset reader must return verified bytes or a materialized file path.", "GEMINI_FILE_ASSET_INVALID");
}

/**
 * Server-only bridge from Executive Visuals private assets to Gemini Files API.
 * The private asset loader must authorize owner/project access before returning
 * bytes or a temporary file. Provider mappings are persisted by injected
 * callbacks; the Google URI is never accepted from a browser request.
 */
export function createGoogleGeminiFilesGateway({
  env = process.env,
  fetchImpl = globalThis.fetch,
  loadPrivateAsset,
  authorizePrivateAsset,
  findProviderFile,
  recordProviderFile,
  deleteProviderFileRecord,
  timeoutMs = 30000,
  maxBytes = 250 * 1024 * 1024,
  chunkSize = 8 * 1024 * 1024,
  processingPollIntervalMs = 5000,
  maxProcessingPolls = 36,
  now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Google Files gateway requires fetch.");
  if (typeof loadPrivateAsset !== "function" || typeof recordProviderFile !== "function") {
    throw new TypeError("Google Files gateway requires private asset loading and durable provider-file persistence.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FILE_BYTES) throw new Error("Google Files maximum byte size is invalid.");
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 256 * 1024 || chunkSize > 32 * 1024 * 1024) throw new Error("Google Files chunk size is invalid.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("Google Files timeout is invalid.");
  if (!Number.isInteger(processingPollIntervalMs) || processingPollIntervalMs < 1000 || processingPollIntervalMs > 60000) throw new Error("Google Files polling interval is invalid.");
  if (!Number.isInteger(maxProcessingPolls) || maxProcessingPolls < 1 || maxProcessingPolls > 120) throw new Error("Google Files polling limit is invalid.");

  function apiKey() {
    const key = String(env.GEMINI_API_KEY || env.GOOGLE_GEMINI_API_KEY || "").trim();
    if (!key) throw fail("Configure a server-side Gemini API key before enabling Google file uploads.", "GEMINI_FILE_CONFIG_MISSING");
    return key;
  }

  async function request(url, { method = "GET", headers = {}, body, maxResponseBytes = 1024 * 1024 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          method, headers: { "x-goog-api-key": apiKey(), ...headers },
          ...(body === undefined ? {} : { body }),
          redirect: "error", signal: controller.signal
        });
      } catch (error) {
        throw fail(error?.name === "AbortError" ? "Google Files request timed out." : "Google Files request failed; upload state may require reconciliation.",
          error?.name === "AbortError" ? "GEMINI_FILE_TIMEOUT" : "GEMINI_FILE_UPLOAD_OUTCOME_UNKNOWN");
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw) > maxResponseBytes) throw fail("Google Files response exceeded its configured limit.", "GEMINI_FILE_RESPONSE_TOO_LARGE");
      let data = null;
      if (raw) {
        try { data = JSON.parse(raw); }
        catch { if (response.ok) throw fail("Google Files returned invalid JSON.", "GEMINI_FILE_RESPONSE_INVALID"); }
      }
      if (!response.ok) {
        const status = response.status;
        const code = status === 429 ? "GEMINI_FILE_RATE_LIMITED" : status >= 500 ? "GEMINI_FILE_PROVIDER_ERROR" : "GEMINI_FILE_REQUEST_REJECTED";
        throw fail("Google Files rejected the request (HTTP " + status + ").", code);
      }
      return { data, headers: response.headers };
    } finally {
      clearTimeout(timer);
    }
  }

  async function removeGoogleFile(name) {
    const match = FILE_NAME.exec(String(name || ""));
    if (!match) return false;
    await request(API_ORIGIN + "/v1beta/files/" + match[1], { method: "DELETE", maxResponseBytes: 64 * 1024 });
    return true;
  }

  async function getGoogleFile(name) {
    const match = FILE_NAME.exec(String(name || ""));
    if (!match) throw fail("Google file resource name is invalid.", "GEMINI_FILE_RESPONSE_INVALID");
    const result = await request(API_ORIGIN + "/v1beta/files/" + match[1]);
    return result.data?.file || result.data;
  }

  async function waitUntilActive(file, mimeType, sizeBytes) {
    let current = validateFileResource(file, mimeType, sizeBytes);
    for (let attempt = 0; current.state === "PROCESSING" && attempt < maxProcessingPolls; attempt++) {
      await sleep(processingPollIntervalMs);
      current = validateFileResource(await getGoogleFile(current.name), mimeType, sizeBytes);
    }
    if (current.state !== "ACTIVE") {
      if (current.state === "FAILED") throw fail("Google could not process the uploaded file.", "GEMINI_FILE_PROCESSING_FAILED");
      throw fail("Google file processing did not become ACTIVE before the polling limit.", "GEMINI_FILE_PROCESSING_TIMEOUT");
    }
    return current;
  }

  async function uploadBytes({ bytes, path, sizeBytes, mimeType, displayName }) {
    const start = await request(API_ORIGIN + "/upload/v1beta/files", {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(sizeBytes),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "content-type": "application/json"
      },
      body: JSON.stringify({ file: { display_name: displayName } })
    });
    const uploadUrl = start.headers?.get?.("x-goog-upload-url");
    let parsedUploadUrl;
    try {
      parsedUploadUrl = new URL(uploadUrl);
      if (parsedUploadUrl.origin !== API_ORIGIN || parsedUploadUrl.username || parsedUploadUrl.password || parsedUploadUrl.hash) throw new Error();
    } catch {
      throw fail("Google did not return a trusted resumable upload URL.", "GEMINI_FILE_UPLOAD_URL_INVALID");
    }

    let offset = 0;
    let finalResource = null;
    for await (const chunk of chunksFromAsset({ bytes, path }, chunkSize)) {
      const final = offset + chunk.byteLength === sizeBytes;
      const uploaded = await request(parsedUploadUrl.href, {
        method: "POST",
        headers: {
          "Content-Length": String(chunk.byteLength),
          "X-Goog-Upload-Offset": String(offset),
          "X-Goog-Upload-Command": final ? "upload, finalize" : "upload"
        },
        body: chunk
      });
      offset += chunk.byteLength;
      if (final) finalResource = uploaded.data?.file || uploaded.data;
    }
    if (offset !== sizeBytes || !finalResource) {
      throw fail("Google upload did not finalize at the expected byte offset.", "GEMINI_FILE_UPLOAD_INCOMPLETE");
    }
    try {
      return await waitUntilActive(finalResource, mimeType, sizeBytes);
    } catch (error) {
      try { await removeGoogleFile(finalResource.name); } catch {}
      throw error;
    }
  }

  return Object.freeze({
    async resolveAsset({ assetId, ownerId, projectId = null, mediaType } = {}) {
      if (typeof assetId !== "string" || !assetId || typeof ownerId !== "string" || !ownerId) {
        throw fail("Google Files upload requires an authenticated private asset and owner.", "GEMINI_FILE_ASSET_SCOPE_INVALID");
      }
      apiKey();
      const mimeType = safeMime(mediaType);
      let authorizedAsset = null;
      if (typeof authorizePrivateAsset === "function") {
        try { authorizedAsset = await authorizePrivateAsset({ assetId, ownerId, projectId, mediaType: mimeType }); }
        catch { throw fail("Private asset authorization failed before Google Files reuse or upload.", "GEMINI_FILE_ASSET_SCOPE_INVALID"); }
        const assetProjectId = authorizedAsset?.projectId || null;
        if (!plain(authorizedAsset) || authorizedAsset.id !== assetId ||
            assetProjectId !== (projectId || null) ||
            (assetProjectId ? false : authorizedAsset.ownerId !== ownerId) ||
            authorizedAsset.storageBucket !== "executive-visuals-media" ||
            authorizedAsset.mediaType !== mimeType ||
            !/^[a-f0-9]{64}$/i.test(String(authorizedAsset.sha256 || "")) ||
            !Number.isSafeInteger(Number(authorizedAsset.size)) || Number(authorizedAsset.size) < 1) {
          throw fail("Authorized asset metadata does not match the requested owner/project and media scope.", "GEMINI_FILE_ASSET_SCOPE_INVALID");
        }
      }
      if (typeof findProviderFile === "function" && authorizedAsset) {
        const existing = await findProviderFile({ provider: "google-gemini-files", assetId, ownerId, projectId, mimeType });
        if (plain(existing) && existing.state === "ACTIVE" && existing.expiresAt &&
            Date.parse(existing.expiresAt) > now() + 120000) {
          const match = FILE_URI.exec(String(existing.uri || ""));
          if (existing.ownerId === ownerId && (existing.projectId || null) === (projectId || null) &&
              existing.assetId === assetId && existing.mimeType === mimeType && match &&
              existing.sha256 === authorizedAsset.sha256 &&
              Number(existing.sizeBytes) === Number(authorizedAsset.size)) {
            return Object.freeze({ uri: existing.uri, mediaType: mimeType, providerFileName: existing.name, expiresAt: existing.expiresAt });
          }
        } else if (plain(existing) && existing.ownerId === ownerId &&
            (existing.projectId || null) === (projectId || null) && existing.assetId === assetId &&
            FILE_NAME.test(String(existing.name || ""))) {
          try { await removeGoogleFile(existing.name); } catch {}
          try { await deleteProviderFileRecord?.({ name: existing.name, recordId: existing.id }); } catch {}
        }
      }

      let loaded;
      try { loaded = await loadPrivateAsset({ assetId, ownerId, projectId }); }
      catch { throw fail("The private asset could not be loaded for Google upload.", "GEMINI_FILE_ASSET_UNAVAILABLE"); }
      if (!plain(loaded) || !plain(loaded.asset) || typeof loaded.cleanup !== "function") {
        try { await loaded?.cleanup?.(); } catch {}
        throw fail("Private asset reader returned invalid materialization metadata.", "GEMINI_FILE_ASSET_INVALID");
      }
      let googleFile = null;
      try {
        const asset = loaded.asset;
        const assetProjectId = asset.projectId || null;
        const authorizedScopeMatches = assetProjectId === (projectId || null) &&
          (assetProjectId ? true : asset.ownerId === ownerId);
        if (asset.id !== assetId || !authorizedScopeMatches ||
            asset.storageBucket !== "executive-visuals-media" || asset.mediaType !== mimeType ||
            (authorizedAsset && (asset.sha256 !== authorizedAsset.sha256 || Number(asset.size) !== Number(authorizedAsset.size)))) {
          throw fail("Private asset ownership, project, bucket or MIME type did not match.", "GEMINI_FILE_ASSET_SCOPE_INVALID");
        }
        const sizeBytes = Number(loaded.size ?? asset.size);
        if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > maxBytes) {
          throw fail("Private asset is empty or exceeds the configured Google upload limit.", "GEMINI_FILE_SIZE_INVALID");
        }
        if (loaded.path) {
          const fileStat = await stat(loaded.path);
          if (!fileStat.isFile() || fileStat.size !== sizeBytes) throw fail("Private asset file size changed during materialization.", "GEMINI_FILE_ASSET_INVALID");
        } else if (!(loaded.bytes instanceof Uint8Array) || loaded.bytes.byteLength !== sizeBytes) {
          throw fail("Private asset bytes do not match the recorded size.", "GEMINI_FILE_ASSET_INVALID");
        }
        const sha256 = String(loaded.sha256 || asset.sha256 || "");
        if (!/^[a-f0-9]{64}$/i.test(sha256) ||
            (loaded.sha256 && asset.sha256 && loaded.sha256 !== asset.sha256)) {
          throw fail("Private asset has no consistent verified SHA-256 receipt.", "GEMINI_FILE_ASSET_INVALID");
        }
        if (await digestPrivateAsset({ bytes: loaded.bytes, path: loaded.path }) !== sha256) {
          throw fail("Private asset SHA-256 verification failed before Google upload.", "GEMINI_FILE_ASSET_HASH_MISMATCH");
        }

        const displayName = "executive-visuals-" + randomUUID();
        googleFile = await uploadBytes({ bytes: loaded.bytes, path: loaded.path, sizeBytes, mimeType, displayName });
        const expiresAt = new Date(now() + 47 * 60 * 60 * 1000 + 50 * 60 * 1000).toISOString();
        const record = {
          provider: "google-gemini-files", assetId, ownerId, projectId: projectId || null,
          name: googleFile.name, uri: googleFile.uri, mimeType, sizeBytes, sha256,
          state: "ACTIVE", uploadedAt: new Date(now()).toISOString(), expiresAt
        };
        try {
          await recordProviderFile(record);
        } catch {
          try { await removeGoogleFile(googleFile.name); } catch {}
          googleFile = null;
          throw fail("Google upload succeeded but its private provider-file mapping could not be persisted.", "GEMINI_FILE_MAPPING_PERSIST_FAILED");
        }
        return Object.freeze({ uri: googleFile.uri, mediaType: mimeType, providerFileName: googleFile.name, expiresAt });
      } finally {
        await loaded.cleanup();
      }
    },
    async deleteProviderFile(name) {
      return removeGoogleFile(name);
    },
    async getProviderFile(name) {
      const file = await getGoogleFile(name);
      return Object.freeze({ name: file.name, uri: file.uri, mimeType: file.mimeType, state: file.state, sizeBytes: Number(file.sizeBytes) });
    },
    async forgetProviderFile({ name, recordId } = {}) {
      if (typeof deleteProviderFileRecord === "function") await deleteProviderFileRecord({ name, recordId });
    }
  });
}
