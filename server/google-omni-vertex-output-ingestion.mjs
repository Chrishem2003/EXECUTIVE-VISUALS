import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GoogleAuth } from "google-auth-library";

const MODEL = "gemini-omni-1.2-flash";
const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const fail = (message, code) => Object.assign(new Error(message), { code });

function parseOutputUri(uri, bucket, prefix, context) {
  if (typeof uri !== "string" || uri.length > 2048 || !uri.startsWith("gs://" + bucket + "/")) {
    throw fail("Gemini Omni 1.2 output is not in the configured private GCS bucket.", "GOOGLE_VERTEX_OUTPUT_URI_INVALID");
  }
  const object = uri.slice(("gs://" + bucket + "/").length);
  const requiredPrefix = prefix + "/" + context.jobId + "/" + context.requestHash + "/";
  if (!object.startsWith(requiredPrefix) || object.length <= requiredPrefix.length ||
      object.includes("\\") || object.split("/").some(part => !part || part === "." || part === "..") ||
      /[?#\u0000-\u001f\u007f]/.test(object)) {
    throw fail("Gemini Omni 1.2 output URI escaped its authorized job output prefix.", "GOOGLE_VERTEX_OUTPUT_URI_INVALID");
  }
  return object;
}

/**
 * Downloads only the GCS output prefix allocated by the Vertex client and
 * publishes it through the existing lease-fenced private asset repository.
 * No provider/GCS URL is ever returned to the browser.
 */
export function createGoogleOmniVertexOutputIngestor({
  assets,
  interactions,
  outputBucket,
  outputPrefix = "executive-visuals/omni-12",
  authClient = null,
  fetchImpl = globalThis.fetch,
  tempRoot = tmpdir(),
  maxOutputBytes = 250 * 1024 * 1024,
  timeoutMs = 120000
} = {}) {
  if (!assets || typeof assets.createFromFileIdempotent !== "function") {
    throw new TypeError("Gemini Omni 1.2 output ingestion requires the private Cloud Asset repository.");
  }
  if (!interactions || typeof interactions.findInteraction !== "function") {
    throw new TypeError("Gemini Omni 1.2 output ingestion requires durable interaction ownership records.");
  }
  const bucket = String(outputBucket || "").trim();
  if (!BUCKET_RE.test(bucket) || bucket.includes("..")) throw new TypeError("Gemini Omni 1.2 requires a dedicated GCS output bucket.");
  const prefix = String(outputPrefix || "").replace(/^\/+|\/+$/g, "");
  if (!/^[a-zA-Z0-9/_-]{1,180}$/.test(prefix) || prefix.split("/").some(part => !part || part === "." || part === "..")) {
    throw new TypeError("Gemini Omni 1.2 GCS output prefix is invalid.");
  }
  if (typeof fetchImpl !== "function" || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 ||
      maxOutputBytes > 2 * 1024 * 1024 * 1024 || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
    throw new TypeError("Gemini Omni 1.2 output ingestion limits are invalid.");
  }
  const auth = authClient || new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/devstorage.read_only"] });
  let cachedClient = null;

  async function token() {
    if (!cachedClient) cachedClient = typeof auth.getClient === "function" ? await auth.getClient() : auth;
    if (typeof cachedClient.getAccessToken !== "function") throw fail("Google Cloud Storage OAuth is unavailable.", "GOOGLE_VERTEX_AUTH_UNAVAILABLE");
    const result = await cachedClient.getAccessToken();
    const value = typeof result === "string" ? result : result?.token;
    if (typeof value !== "string" || value.length < 20 || value.length > 8192 || /\s/.test(value)) {
      throw fail("Google Cloud Storage OAuth token is invalid.", "GOOGLE_VERTEX_AUTH_UNAVAILABLE");
    }
    return value;
  }

  async function download(object, filePath, { signal, assertLease } = {}) {
    if (typeof assertLease !== "function" || await assertLease() !== true) {
      throw fail("Gemini Omni 1.2 output download requires the current worker lease.", "CLOUD_WORKER_LEASE_LOST");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    let size = 0;
    const hash = createHash("sha256");
    try {
      const accessToken = await token();
      const url = "https://storage.googleapis.com/storage/v1/b/" + encodeURIComponent(bucket) +
        "/o/" + encodeURIComponent(object) + "?alt=media";
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { authorization: "Bearer " + accessToken, accept: "video/mp4" },
        signal: controller.signal,
        redirect: "error"
      });
      if (!response.ok) throw fail("Google Cloud Storage output download failed with HTTP " + response.status + ".", "GOOGLE_VERTEX_OUTPUT_DOWNLOAD_FAILED");
      const mimeType = String(response.headers?.get?.("content-type") || "").split(";")[0].trim().toLowerCase();
      const declaredSize = Number(response.headers?.get?.("content-length"));
      if (mimeType !== "video/mp4" || !Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > maxOutputBytes) {
        throw fail("Google Cloud Storage returned an unsupported or oversized video object.", "GOOGLE_VERTEX_OUTPUT_INVALID");
      }
      if (!response.body) throw fail("Google Cloud Storage returned an empty video body.", "GOOGLE_VERTEX_OUTPUT_INVALID");
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          if (size > maxOutputBytes) return callback(fail("Google Omni 1.2 output exceeded its byte limit.", "GOOGLE_VERTEX_OUTPUT_TOO_LARGE"));
          hash.update(chunk);
          callback(null, chunk);
        }
      });
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(filePath, { flags: "wx", mode: 0o600 }), { signal: controller.signal });
      if (size !== declaredSize || size < 1) throw fail("Google Cloud Storage output size did not match its response metadata.", "GOOGLE_VERTEX_OUTPUT_INVALID");
      if (await assertLease() !== true) throw fail("Worker lease was lost before private output publication.", "CLOUD_WORKER_LEASE_LOST");
      return Object.freeze({ sizeBytes: size, sha256: hash.digest("hex"), mimeType });
    } catch (error) {
      if (error?.name === "AbortError") throw fail("Google Omni 1.2 output download timed out.", "GOOGLE_VERTEX_OUTPUT_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async function ingestInteraction(interaction, context = {}) {
    const interactionId = String(interaction?.id || "");
    if (!/^v1_[A-Za-z0-9_-]{6,200}$/.test(interactionId) ||
        !UUID.test(String(context.ownerId || "")) || !UUID.test(String(context.jobId || "")) ||
        !HASH.test(String(context.requestHash || "")) || !UUID.test(String(context.workerId || "")) ||
        !UUID.test(String(context.leaseToken || "")) || typeof context.assertLease !== "function") {
      throw fail("Gemini Omni 1.2 output ingestion context is invalid.", "GOOGLE_VERTEX_OUTPUT_CONTEXT_INVALID");
    }
    const videoItems = (Array.isArray(interaction.steps) ? interaction.steps : [])
      .filter(step => step?.type === "model_output" && Array.isArray(step.content))
      .flatMap(step => step.content)
      .filter(item => item?.type === "video" && item.mime_type === "video/mp4" && typeof item.uri === "string");
    if (videoItems.length !== 1) throw fail("Gemini Omni 1.2 must return exactly one MP4 output.", "GOOGLE_VERTEX_OUTPUT_INVALID");
    const object = parseOutputUri(videoItems[0].uri, bucket, prefix, context);
    const record = await interactions.findInteraction({
      interactionId,
      ownerId: context.ownerId,
      projectId: context.projectId || null,
      jobId: context.jobId
    });
    if (!record || record.provider !== "google" || record.model !== MODEL ||
        record.interactionId !== interactionId || record.ownerId !== context.ownerId ||
        (record.projectId || null) !== (context.projectId || null) ||
        record.jobId !== context.jobId || record.requestHash !== context.requestHash ||
        record.state !== "succeeded" || record.outputUri !== videoItems[0].uri) {
      throw fail("Gemini Omni 1.2 output is not owned by this completed job.", "GOOGLE_VERTEX_OUTPUT_FORBIDDEN");
    }

    let directory;
    try {
      if (await context.assertLease() !== true) throw fail("Worker lease is no longer current.", "CLOUD_WORKER_LEASE_LOST");
      directory = await mkdtemp(join(tempRoot, "executive-visuals-omni-12-"));
      const filePath = join(directory, "gemini-omni-1-2-output.mp4");
      const downloaded = await download(object, filePath, { signal: context.signal, assertLease: context.assertLease });
      const asset = await assets.createFromFileIdempotent({
        ownerId: context.ownerId,
        projectId: context.projectId || null,
        originalName: "gemini-omni-1-2-" + interactionId + ".mp4",
        mediaType: downloaded.mimeType,
        filePath,
        publicationKey: "google:" + context.jobId + ":" + interactionId + ":output:0",
        metadata: {
          provider: "google",
          model: MODEL,
          providerTaskId: interactionId,
          outputIndex: 0,
          requestHash: context.requestHash,
          sourceUriScheme: "gs",
          sha256: downloaded.sha256,
          byteSize: downloaded.sizeBytes
        },
        assertLease: context.assertLease,
        signal: context.signal || null,
        leaseContext: { jobId: context.jobId, workerId: context.workerId, leaseToken: context.leaseToken }
      });
      return Object.freeze({
        assetId: asset.id,
        ownerId: context.ownerId,
        projectId: context.projectId || null,
        sizeBytes: downloaded.sizeBytes,
        sha256: downloaded.sha256,
        mediaType: downloaded.mimeType
      });
    } catch (error) {
      throw fail("Gemini Omni 1.2 output could not be committed to private storage.", error?.code || "GOOGLE_VERTEX_OUTPUT_INGEST_FAILED");
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  return Object.freeze({ ingestInteraction });
}
