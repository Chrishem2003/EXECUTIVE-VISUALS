import { createHash } from "node:crypto";
import { normalizeGeminiOmniFlashInteractionResponse } from "./google-omni-flash-interaction.mjs";

const ORIGIN = "https://generativelanguage.googleapis.com";
const FILE_URI = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/([A-Za-z0-9_-]+)(?::download\?alt=media)?$/;
const fail = (message, code) => Object.assign(new Error(message), { code });

async function readSmallJson(response, maxBytes = 64 * 1024) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel?.(); } catch {}
    throw fail("Google Files metadata response exceeded its configured size limit.", "GEMINI_OMNI_FILE_METADATA_TOO_LARGE");
  }
  let raw;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch {}
          throw fail("Google Files metadata response exceeded its configured size limit.", "GEMINI_OMNI_FILE_METADATA_TOO_LARGE");
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    raw = Buffer.concat(chunks, total).toString("utf8");
  } else {
    raw = await response.text();
    if (Buffer.byteLength(raw) > maxBytes) {
      throw fail("Google Files metadata response exceeded its configured size limit.", "GEMINI_OMNI_FILE_METADATA_TOO_LARGE");
    }
  }
  try { return JSON.parse(raw); }
  catch { throw fail("Google Files returned invalid metadata JSON.", "GEMINI_OMNI_FILE_METADATA_INVALID"); }
}

async function readBounded(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== "function") {
    throw fail("Google video download did not provide a readable body.", "GEMINI_OMNI_OUTPUT_INVALID");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw fail("Google video output exceeded the private ingestion size limit.", "GEMINI_OMNI_OUTPUT_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  if (!total) throw fail("Google returned an empty video output.", "GEMINI_OMNI_OUTPUT_INVALID");
  return Buffer.concat(chunks, total);
}

/**
 * Converts a completed Gemini Omni REST interaction into a private Executive
 * Visuals asset. It never returns provider bytes or a provider URL to clients.
 * The injected authorizer must validate the durable job, owner, project and
 * interaction lineage; the ingestor must write to private storage and persist
 * media metadata using the application's existing asset service.
 */
export function createGoogleOmniPrivateOutputIngestor({
  env = process.env,
  fetchImpl = globalThis.fetch,
  authorizeOutputIngestion,
  findExistingOutput,
  ingestPrivateOutput,
  timeoutMs = 120000,
  fileReadyTimeoutMs = 120000,
  filePollIntervalMs = 5000,
  maxOutputBytes = 250 * 1024 * 1024,
  maxInlineVideoBytes = 32 * 1024 * 1024
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Gemini output ingestor requires fetch.");
  if (typeof authorizeOutputIngestion !== "function" ||
      typeof findExistingOutput !== "function" ||
      typeof ingestPrivateOutput !== "function") {
    throw new TypeError("Gemini output ingestor requires durable authorization, idempotency lookup and private asset ingestion.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000 ||
      !Number.isInteger(fileReadyTimeoutMs) || fileReadyTimeoutMs < 1000 || fileReadyTimeoutMs > 300000 ||
      !Number.isInteger(filePollIntervalMs) || filePollIntervalMs < 10 || filePollIntervalMs > 60000 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 * 1024 ||
      maxOutputBytes > 2 * 1024 * 1024 * 1024 ||
      !Number.isSafeInteger(maxInlineVideoBytes) || maxInlineVideoBytes < 1024 ||
      maxInlineVideoBytes > 64 * 1024 * 1024) {
    throw new Error("Gemini output ingestion limits are invalid.");
  }

  function apiKey() {
    const key = String(env.GEMINI_API_KEY || env.GOOGLE_GEMINI_API_KEY || "").trim();
    if (!key) throw fail("Configure a server-side Gemini API key before output ingestion.", "GEMINI_OMNI_CONFIG_MISSING");
    return key;
  }

  async function waitForFileReady(fileId) {
    const deadline = Date.now() + fileReadyTimeoutMs;
    while (Date.now() < deadline) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let metadata;
      try {
        const response = await fetchImpl(ORIGIN + "/v1beta/files/" + encodeURIComponent(fileId), {
          method: "GET",
          headers: { "x-goog-api-key": apiKey() },
          redirect: "error",
          signal: controller.signal
        });
        if (!response.ok) {
          throw fail("Google Files status lookup failed (HTTP " + response.status + ").",
            "GEMINI_OMNI_FILE_STATUS_FAILED");
        }
        metadata = await readSmallJson(response);
      } catch (error) {
        if (error?.code?.startsWith?.("GEMINI_OMNI_")) throw error;
        throw fail(error?.name === "AbortError" ? "Google Files status lookup timed out." : "Google Files status lookup failed.",
          error?.name === "AbortError" ? "GEMINI_OMNI_FILE_STATUS_TIMEOUT" : "GEMINI_OMNI_FILE_STATUS_FAILED");
      } finally {
        clearTimeout(timer);
      }
      if (metadata.state === "ACTIVE") return;
      if (metadata.state === "FAILED") {
        throw fail("Google Files processing failed; generated video is not downloadable.", "GEMINI_OMNI_FILE_PROCESSING_FAILED");
      }
      if (metadata.state !== "PROCESSING") {
        throw fail("Google Files returned an unsupported processing state.", "GEMINI_OMNI_FILE_STATE_INVALID");
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(filePollIntervalMs, Math.max(1, deadline - Date.now()))));
    }
    throw fail("Google Files did not become ACTIVE before the configured deadline.", "GEMINI_OMNI_FILE_READY_TIMEOUT");
  }

  async function download(uri) {
    const match = FILE_URI.exec(String(uri || ""));
    if (!match) throw fail("Gemini output URI is not a trusted Google Files resource.", "GEMINI_OMNI_OUTPUT_URI_INVALID");
    const url = new URL(uri);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash ||
        (url.search && url.search !== "?alt=media")) {
      throw fail("Gemini output URI contains unsupported URL components.", "GEMINI_OMNI_OUTPUT_URI_INVALID");
    }
    await waitForFileReady(match[1]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(uri, {
          method: "GET",
          headers: { "x-goog-api-key": apiKey() },
          redirect: "error",
          signal: controller.signal
        });
      } catch (error) {
        throw fail(error?.name === "AbortError" ? "Gemini output download timed out." : "Gemini output download failed.",
          error?.name === "AbortError" ? "GEMINI_OMNI_OUTPUT_TIMEOUT" : "GEMINI_OMNI_OUTPUT_DOWNLOAD_FAILED");
      }
      if (!response.ok) throw fail("Google output download failed (HTTP " + response.status + ").", "GEMINI_OMNI_OUTPUT_DOWNLOAD_FAILED");
      const mime = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (mime && mime !== "video/mp4" && mime !== "application/octet-stream") {
        throw fail("Google output download returned an unsupported MIME type.", "GEMINI_OMNI_OUTPUT_INVALID");
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxOutputBytes) {
        throw fail("Google video output exceeded the private ingestion size limit.", "GEMINI_OMNI_OUTPUT_TOO_LARGE");
      }
      return await readBounded(response, maxOutputBytes);
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async ingestInteraction(rawInteraction, context = {}) {
      const interaction = normalizeGeminiOmniFlashInteractionResponse(rawInteraction, {
        maxInlineVideoBytes
      });
      if (interaction.status !== "succeeded" || !interaction.video) {
        throw fail("Only a completed Gemini interaction with a video output can be ingested.", "GEMINI_OMNI_OUTPUT_NOT_READY");
      }
      let authorized = false;
      try { authorized = await authorizeOutputIngestion({ interactionId: interaction.interactionId, context }); }
      catch {}
      if (authorized !== true) {
        throw fail("Gemini output ingestion is not authorized for this job, owner and project.", "GEMINI_OMNI_OUTPUT_FORBIDDEN");
      }

      // Reconcile a prior successful private-asset commit before downloading or
      // uploading again. The repository lookup is owner/project/task scoped.
      let existing;
      try {
        existing = await findExistingOutput({
          ownerId: context.ownerId,
          projectId: context.projectId || null,
          providerTaskId: interaction.interactionId,
          outputIndex: 0
        });
      } catch {
        throw fail("Gemini output idempotency lookup failed; refusing duplicate ingestion.",
          "GEMINI_OMNI_OUTPUT_IDEMPOTENCY_LOOKUP_FAILED");
      }
      if (existing) {
        if (typeof existing.id !== "string" || !existing.id ||
            existing.ownerId !== context.ownerId ||
            (existing.projectId || null) !== (context.projectId || null) ||
            existing.mediaType !== "video/mp4" ||
            existing.storageBucket !== "executive-visuals-media" ||
            !Number.isSafeInteger(Number(existing.size)) || Number(existing.size) < 1 ||
            typeof existing.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(existing.sha256)) {
          throw fail("Existing Gemini output asset does not match the authorized private asset scope.",
            "GEMINI_OMNI_OUTPUT_ASSET_INVALID");
        }
        return Object.freeze({
          assetId: existing.id,
          ownerId: existing.ownerId,
          projectId: existing.projectId || null,
          mediaType: "video/mp4",
          sizeBytes: Number(existing.size),
          sha256: existing.sha256,
          provider: "google",
          model: interaction.model,
          interactionId: interaction.interactionId,
          reused: true
        });
      }

      const bytes = interaction.video.delivery === "inline"
        ? Buffer.from(interaction.video.base64, "base64")
        : await download(interaction.video.uri);
      if (!bytes.length || bytes.byteLength > maxOutputBytes) {
        throw fail("Gemini video output is empty or exceeds the configured private asset limit.", "GEMINI_OMNI_OUTPUT_TOO_LARGE");
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      let asset;
      try {
        asset = await ingestPrivateOutput({
          bytes,
          mimeType: "video/mp4",
          sizeBytes: bytes.byteLength,
          sha256,
          provider: "google",
          model: interaction.model,
          interactionId: interaction.interactionId,
          ownerId: context.ownerId,
          projectId: context.projectId,
          jobId: context.jobId,
          workerId: context.workerId,
          leaseToken: context.leaseToken,
          signal: context.signal,
          assertLease: context.assertLease,
          metadata: {
            source: "video-generation",
            providerTaskId: interaction.interactionId,
            outputIndex: 0
          }
        });
      } catch {
        throw fail("Gemini output could not be committed to private asset storage.", "GEMINI_OMNI_OUTPUT_INGEST_FAILED");
      }
      // cloud-assets returns a public metadata projection (not an isPrivate
      // boolean). Verify the private storage bucket and exact persisted bytes.
      if (!asset || typeof asset.id !== "string" || !asset.id ||
          asset.ownerId !== context.ownerId ||
          (asset.projectId || null) !== (context.projectId || null) ||
          asset.mediaType !== "video/mp4" ||
          asset.storageBucket !== "executive-visuals-media" ||
          Number(asset.size) !== bytes.byteLength ||
          asset.sha256 !== sha256) {
        throw fail("Private asset service returned an invalid or incorrectly scoped output record.", "GEMINI_OMNI_OUTPUT_ASSET_INVALID");
      }
      return Object.freeze({
        assetId: asset.id,
        ownerId: asset.ownerId,
        projectId: asset.projectId || null,
        mediaType: "video/mp4",
        sizeBytes: bytes.byteLength,
        sha256,
        provider: "google",
        model: interaction.model,
        interactionId: interaction.interactionId,
        reused: false
      });
    }
  });
}
