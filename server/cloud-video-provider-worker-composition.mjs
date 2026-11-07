import { createCloudQueue } from "./cloud-queue.mjs";
import { createCloudVideoEnqueue } from "./cloud-video-enqueue.mjs";
import { createCloudVideoSubmissionLedger } from "./cloud-video-submissions.mjs";
import { createCloudAssetService } from "./cloud-asset-service.mjs";
import {
  createFfprobeVideoOutputValidator,
  createPrivateVideoOutputIngestor
} from "./private-video-output-ingestion.mjs";
import { createProviderAwareCloudVideoWorker } from "./cloud-video-provider-worker.mjs";
import { createFalVideoProviderAdapter } from "./fal-video-provider-registration.mjs";\nimport { createRunwayCloudVideoAdapter } from "./runway-cloud-video-adapter.mjs";

/**
 * Build the provider-aware worker against the existing Supabase queue,
 * submission ledger and private asset repository. Provider construction is
 * injected so each provider can bind its own task-level billing resolver while
 * sharing the same hardened private-output ingestion boundary.
 *
 * This factory is opt-in and side-effect free: constructors do not contact
 * Supabase or a provider. Network activity begins only when runCycle runs.
 */
export function createProviderAwareCloudVideoWorkerComposition({
  workerId,
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  env = process.env,
  fetchImpl = globalThis.fetch,
  createAdapters,
  allowedOutputHosts = [],
  validateMedia,
  ffprobePath = process.env.FFPROBE_PATH || "ffprobe",
  timeoutMs = 15000,
  maxBytesPerOutput = 250 * 1024 * 1024,
  maxTotalBytes = 500 * 1024 * 1024,
  deferSeconds = 30
} = {}) {
  if (env.CLOUD_VIDEO_WORKER_ENABLED !== "true") {
    throw new Error("Provider-aware cloud video worker is disabled; explicit CLOUD_VIDEO_WORKER_ENABLED=true is required.");
  }
  if (env.VIDEO_GATEWAY_ENABLED !== "true" || env.VIDEO_GATEWAY_ALLOW_REMOTE !== "true") {
    throw new Error("Provider-aware remote execution requires VIDEO_GATEWAY_ENABLED=true and VIDEO_GATEWAY_ALLOW_REMOTE=true.");
  }
  if (typeof workerId !== "string" || !workerId.trim() || workerId.length > 128) {
    throw new Error("Provider-aware cloud video worker requires a valid worker ID.");
  }
  if (!url || !serviceRoleKey || typeof fetchImpl !== "function") {
    throw new Error("Provider-aware cloud video worker requires server-side Supabase credentials and fetch.");
  }
  if (!Array.isArray(allowedOutputHosts) || allowedOutputHosts.length < 1 || allowedOutputHosts.length > 100 ||
      allowedOutputHosts.some(host => typeof host !== "string" || !/^(?:\*\.)?[a-z0-9.-]{1,253}$/i.test(host))) {
    throw new Error("Provider-aware output ingestion requires an explicit bounded hostname allowlist.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error("Provider-aware cloud video worker timeout is invalid.");
  }
  if (!Array.isArray(runwayModels) || runwayModels.length > 10 ||
      runwayModels.some(model => typeof model !== "string" || !["gen4.5", "aleph2", "magnific_video_upscaler_creative"].includes(model)) ||
      new Set(runwayModels).size !== runwayModels.length) {
    throw new Error("Runway model registration must be a unique list of explicitly supported model profiles.");
  }

  const clientOptions = { url, serviceRoleKey, fetchImpl, timeoutMs };
  const queue = createCloudQueue(clientOptions);
  const enqueue = createCloudVideoEnqueue({ ...clientOptions, env, resolveRunwaySourceMetadata });
  const ledger = createCloudVideoSubmissionLedger(clientOptions);
  const privateAssets = createCloudAssetService({
    ...clientOptions,
    storageTimeoutMs: Math.min(timeoutMs, 30000),
    metadataTimeoutMs: timeoutMs,
    authorizationTimeoutMs: Math.min(timeoutMs, 8000),
    maxBytes: maxBytesPerOutput
  });
  const mediaValidator = validateMedia || createFfprobeVideoOutputValidator({
    ffprobePath,
    timeoutMs: Math.min(timeoutMs, 15000)
  });
  const outputIngestor = createPrivateVideoOutputIngestor({
    assets: privateAssets.assets,
    allowedHosts: allowedOutputHosts,
    validateMedia: mediaValidator,
    timeoutMs: Math.min(timeoutMs, 30000),
    maxBytesPerOutput,
    maxTotalBytes
  });
  const ingestOutputs = args => outputIngestor.ingest(args);
  const adapterFactory = createAdapters || (({ env: providerEnv, fetchImpl: providerFetch, ingestOutputs: ingest }) => {
    const adapters = [
      createFalVideoProviderAdapter({ env: providerEnv, fetchImpl: providerFetch, ingestOutputs: ingest })
    ];
    if (runwayModels.length) {
      if (typeof resolveRunwayActualCost !== "function") {
        throw new Error("Runway cloud registration requires an authoritative task-level billing resolver.");
      }
      if (runwayModels.some(model => ["aleph2", "magnific_video_upscaler_creative"].includes(model)) &&
          typeof prepareRunwayInput !== "function") {
        throw new Error("Runway source operations require an owner-scoped source-media resolver.");
      }
      if (runwayModels.some(model => ["aleph2", "magnific_video_upscaler_creative"].includes(model)) &&
          typeof resolveRunwaySourceMetadata !== "function") {
        throw new Error("Runway source operations require a server-side media metadata resolver for safe budget reservation.");
      }
      for (const model of runwayModels) {
        adapters.push(createRunwayCloudVideoAdapter({
          model,
          apiKey: providerEnv.RUNWAY_API_KEY || providerEnv.RUNWAYML_API_SECRET,
          enabled: providerEnv.VIDEO_GATEWAY_ENABLED === "true",
          allowRemote: providerEnv.RUNWAY_VIDEO_ALLOW_REMOTE === "true",
          fetchImpl: providerFetch,
          prepareInput: prepareRunwayInput,
          ingestOutputs: ingest,
          resolveActualCost: resolveRunwayActualCost,
          timeoutMs: Math.min(timeoutMs, 30000)
        }));
      }
    }
    return adapters;
  });
  const adapters = adapterFactory({
    env,
    fetchImpl,
    assets: privateAssets.assets,
    ingestOutputs
  });
  if (!Array.isArray(adapters) || adapters.length < 1 || adapters.length > 100) {
    throw new Error("Provider adapter factory must return between 1 and 100 adapters.");
  }

  return createProviderAwareCloudVideoWorker({
    workerId,
    queue,
    enqueue,
    ledger,
    adapters,
    deferSeconds
  });
}
