import { createCloudQueue } from "./cloud-queue.mjs";
import { createCloudVideoEnqueue } from "./cloud-video-enqueue.mjs";
import { createCloudVideoSubmissionLedger } from "./cloud-video-submissions.mjs";
import { createCloudStorage } from "./cloud-storage.mjs";
import { createCloudAssetAuthorizer } from "./cloud-asset-auth.mjs";
import { createCloudAssetRepository } from "./cloud-assets.mjs";
import { createCloudRunwayPrivateAssetResolver } from "./cloud-runway-asset-resolver.mjs";
import { createRunwayVideoAdapter } from "./runway-video-gateway.mjs";
import { createFfprobeVideoOutputValidator, createPrivateVideoOutputIngestor } from "./private-video-output-ingestion.mjs";
import { createCloudVideoCostEvidenceResolver } from "./cloud-video-cost-evidence.mjs";
import { createCloudVideoWorker } from "./cloud-video-worker.mjs";

/**
 * Composes the complete hosted Runway worker from server-only dependencies.
 * Construction performs no provider requests; remote execution occurs only
 * when the returned worker claims a job and the explicit Runway flags are on.
 */
export function createCloudVideoWorkerComposition({
  env = process.env,
  workerId,
  tempRoot,
  maxBytes = 250 * 1024 * 1024,
  fetchImpl = globalThis.fetch,
  outputHosts
} = {}) {
  const url = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new Error("Cloud video composition requires server-side Supabase credentials.");
  if (env.RUNWAY_VIDEO_ENABLED !== "true" || env.RUNWAY_VIDEO_ALLOW_REMOTE !== "true" || !env.RUNWAY_API_KEY) {
    throw new Error("Cloud video composition requires explicit Runway remote-execution opt-in and a server-side API key.");
  }
  if (typeof workerId !== "string" || !workerId.trim() || workerId.length > 128) {
    throw new Error("Cloud video composition requires a bounded worker ID.");
  }
  if (!Array.isArray(outputHosts) || outputHosts.length < 1 || outputHosts.length > 100 ||
      outputHosts.some(host => typeof host !== "string" || !/^[a-z0-9.-]{1,253}$/i.test(host) || host.startsWith(".") || host.endsWith("."))) {
    throw new Error("Cloud video composition requires an explicit exact-host output allowlist.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1024 * 1024 * 1024) {
    throw new Error("Cloud video composition media limit is invalid.");
  }
  if (typeof fetchImpl !== "function") throw new Error("Cloud video composition requires fetch.");

  const queue = createCloudQueue({ url, serviceRoleKey, fetchImpl });
  const enqueue = createCloudVideoEnqueue({ url, serviceRoleKey, fetchImpl });
  const ledger = createCloudVideoSubmissionLedger({ url, serviceRoleKey, fetchImpl });
  const storage = createCloudStorage({ url, serviceRoleKey, fetchImpl, maxBytes });
  const authorize = createCloudAssetAuthorizer({ url, serviceRoleKey, fetchImpl });
  const assets = createCloudAssetRepository({ url, serviceRoleKey, storage, authorize, fetchImpl });
  const resolveAssetUri = createCloudRunwayPrivateAssetResolver({
    assets, supabaseUrl: url, fetchImpl, runwayEnv: env, runwayFetchImpl: fetchImpl
  });
  const adapter = createRunwayVideoAdapter({ env, fetchImpl, resolveAssetUri });
  const validateMedia = createFfprobeVideoOutputValidator({ ffprobePath: env.FFPROBE_PATH || "ffprobe" });
  const privateOutputIngestor = createPrivateVideoOutputIngestor({
    assets, allowedHosts: outputHosts, validateMedia, tempRoot,
    maxBytesPerOutput: maxBytes, maxTotalBytes: maxBytes
  });
  const resolveActualCost = createCloudVideoCostEvidenceResolver({ url, serviceRoleKey, fetchImpl });

  return createCloudVideoWorker({
    workerId, queue, enqueue, ledger, adapter,
    ingestOutputs: args => privateOutputIngestor.ingest(args),
    resolveActualCost
  });
}
