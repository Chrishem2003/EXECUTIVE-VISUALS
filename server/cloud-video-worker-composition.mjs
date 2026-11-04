import { createCloudQueue } from "./cloud-queue.mjs";
import { createCloudVideoEnqueue } from "./cloud-video-enqueue.mjs";
import { createCloudVideoSubmissionLedger } from "./cloud-video-submissions.mjs";
import { createCloudVideoWorker } from "./cloud-video-worker.mjs";
import { createRunwayVideoAdapter } from "./runway-video-gateway.mjs";
import { createRunwayPrivateAssetResolver } from "./runway-private-asset-resolver.mjs";

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
  if (typeof loadPrivateAsset !== "function") {
    throw new Error("Cloud video worker composition requires an owner/project-scoped private asset reader.");
  }
  if (typeof ingestOutputs !== "function") {
    throw new Error("Cloud video worker composition requires private output ingestion.");
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
  const resolveAssetUri = createRunwayPrivateAssetResolver({
    env, fetchImpl, loadPrivateAsset
  });
  const adapter = createRunwayVideoAdapter({ env, fetchImpl, resolveAssetUri });

  return createCloudVideoWorker({
    workerId, queue, enqueue, ledger, adapter, ingestOutputs, resolveActualCost,
    ...(sleep ? { sleep } : {}),
    maxPolls,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    deferSeconds
  });
}
