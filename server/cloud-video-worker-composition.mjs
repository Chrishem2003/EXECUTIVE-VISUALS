import { createCloudQueue } from "./cloud-queue.mjs";
import { createCloudVideoEnqueue } from "./cloud-video-enqueue.mjs";
import { createCloudVideoSubmissionLedger } from "./cloud-video-submissions.mjs";
import { createCloudVideoWorker } from "./cloud-video-worker.mjs";
import { createRunwayVideoAdapter } from "./runway-video-gateway.mjs";
import { createRunwayPrivateAssetResolver } from "./runway-private-asset-resolver.mjs";
import { createCloudAssetService } from "./cloud-asset-service.mjs";
import { createCloudMediaAssetIO } from "./cloud-media-io.mjs";
import { createFfprobeVideoOutputValidator, createPrivateVideoOutputIngestor } from "./private-video-output-ingestion.mjs";
import { createCloudVideoPrivateAssetReader } from "./cloud-video-private-assets.mjs";

/**
 * Composes the durable cloud video worker without performing network I/O.
 * Private storage reads, output ingestion and authoritative cost evidence are
 * application-owned dependencies and must be supplied explicitly.
 */
export function createCloudVideoWorkerComposition({
  workerId,
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  env = process.env,
  fetchImpl = globalThis.fetch,
  loadPrivateAsset,
  ingestOutputs,
  resolveActualCost,
  sleep,
  maxPolls = 120,
  pollIntervalMs,
  deferSeconds = 30,
  timeoutMs = 15000
} = {}) {
  if (env.CLOUD_VIDEO_WORKER_ENABLED !== "true") {
    throw new Error("Cloud video worker composition is disabled; explicit CLOUD_VIDEO_WORKER_ENABLED=true is required.");
  }
  if (typeof workerId !== "string" || !workerId.trim() || workerId.length > 128) {
    throw new Error("Cloud video worker composition requires a valid worker ID.");
  }
  if (!url || !serviceRoleKey || typeof fetchImpl !== "function") {
    throw new Error("Cloud video worker composition requires server-side Supabase credentials and fetch.");
  }
  if (typeof loadPrivateAsset !== "undefined" && typeof loadPrivateAsset !== "function") {
    throw new Error("Cloud video worker private asset reader must be a function when supplied.");
  }
  if (typeof ingestOutputs !== "undefined" && typeof ingestOutputs !== "function") {
    throw new Error("Cloud video worker output ingestor must be a function when supplied.");
  }
  if (typeof resolveActualCost !== "function") {
    throw new Error("Cloud video worker composition requires authoritative task-level cost evidence.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error("Cloud video worker composition timeout is invalid.");
  }

  const clientOptions = { url, serviceRoleKey, fetchImpl, timeoutMs };
  const queue = createCloudQueue(clientOptions);
  const enqueue = createCloudVideoEnqueue(clientOptions);
  const ledger = createCloudVideoSubmissionLedger(clientOptions);

  let privateAssets = null;
  let mediaIO = null;
  if (typeof loadPrivateAsset !== "function" || typeof ingestOutputs !== "function") {
    privateAssets = createCloudAssetService({
      ...clientOptions,
      storageTimeoutMs: timeoutMs,
      metadataTimeoutMs: timeoutMs,
      authorizationTimeoutMs: Math.min(timeoutMs, 8000),
      maxBytes: 250 * 1024 * 1024
    });
    mediaIO = createCloudMediaAssetIO({
      assets: privateAssets.assets, fetchImpl, maxBytes: 200 * 1024 * 1024,
      timeoutMs: Math.min(timeoutMs, 30000)
    });
  }

  const privateAssetReader = loadPrivateAsset || createCloudVideoPrivateAssetReader({ mediaIO });

  let outputIngestor = ingestOutputs;
  if (typeof outputIngestor !== "function") {
    const allowedHosts = String(env.RUNWAY_VIDEO_OUTPUT_HOSTS || "")
      .split(",").map(host => host.trim()).filter(Boolean);
    if (allowedHosts.length < 1 || allowedHosts.length > 100 ||
        allowedHosts.some(host => host.startsWith("*."))) {
      throw new Error("Cloud video output ingestion requires an explicit comma-separated RUNWAY_VIDEO_OUTPUT_HOSTS exact-host allowlist.");
    }
    const validateMedia = createFfprobeVideoOutputValidator({
      ffprobePath: env.FFPROBE_PATH || "ffprobe",
      timeoutMs: Math.min(timeoutMs, 15000)
    });
    const ingestor = createPrivateVideoOutputIngestor({
      assets: privateAssets.assets,
      allowedHosts,
      validateMedia,
      timeoutMs: Math.min(timeoutMs, 30000),
      maxBytesPerOutput: 250 * 1024 * 1024,
      maxTotalBytes: 500 * 1024 * 1024
    });
    outputIngestor = args => ingestor.ingest(args);
  }

  const resolveAssetUri = createRunwayPrivateAssetResolver({
    env, fetchImpl, loadPrivateAsset: privateAssetReader
  });
  const adapter = createRunwayVideoAdapter({ env, fetchImpl, resolveAssetUri });

  return createCloudVideoWorker({
    workerId, queue, enqueue, ledger, adapter, ingestOutputs: outputIngestor, resolveActualCost,
    ...(sleep ? { sleep } : {}),
    maxPolls,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    deferSeconds
  });
}
