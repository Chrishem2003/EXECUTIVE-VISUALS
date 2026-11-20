import { createCloudAssetAuthorizer } from "./cloud-asset-auth.mjs";
import { createCloudAssetService } from "./cloud-asset-service.mjs";
import { createFfprobeVideoOutputValidator, createPrivateVideoOutputIngestor } from "./private-video-output-ingestion.mjs";
import { createFalVideoProviderAdapter } from "./fal-video-provider-registration.mjs";
import { createRunwayModelRouterVideoAdapter } from "./runway-model-router-video-adapter.mjs";
import { createRunwaySourceAssetResolver } from "./runway-source-asset-resolver.mjs";
import { createNeonObjectStorage } from "./neon-object-storage.mjs";

/**
 * Build the production-shaped Neon staging provider registry.
 *
 * FAL uses its exact-model billing ledger. Runway Model Router uses the
 * completed task's realized cost.credits receipt and durably records the
 * selected model in submission metadata. Both share the same owner-scoped
 * private source resolver and hardened output ingestion. Construction performs
 * no provider or storage requests.
 */
export function createNeonStagingProviderAdapters({
  env = process.env,
  fetchImpl = globalThis.fetch,
  storage = null,
  ffprobePath = env.FFPROBE_PATH || "ffprobe",
  allowedOutputHosts = ["fal.media", "*.fal.media"],
  maxBytesPerOutput = 250 * 1024 * 1024,
  maxTotalBytes = 500 * 1024 * 1024,
  timeoutMs = 30000
} = {}) {
  if (env.NEON_STAGING_RUNTIME_ENABLED !== "true" ||
      env.NEON_STAGING_BRANCH_NAME !== "executive-visuals-staging") {
    throw new Error("Neon staging provider adapters require the explicitly enabled executive-visuals-staging runtime.");
  }
  if (env.CLOUD_VIDEO_WORKER_ENABLED !== "true" ||
      env.VIDEO_GATEWAY_ENABLED !== "true" ||
      env.VIDEO_GATEWAY_ALLOW_REMOTE !== "true") {
    throw new Error("Neon video execution requires explicit worker, gateway and remote-execution gates.");
  }
  if (String(env.CLOUD_MEDIA_STORAGE_PROVIDER || "").toLowerCase() !== "neon") {
    throw new Error("Neon staging provider adapters require CLOUD_MEDIA_STORAGE_PROVIDER=neon.");
  }
  if (!env.SUPABASE_URL || !(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Error("Neon staging media publication requires server-side Supabase asset metadata credentials.");
  }
  if (typeof fetchImpl !== "function") throw new Error("Neon staging provider adapters require fetch.");

  const serviceRoleKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = env.NEON_STORAGE_BUCKET || "executive-visuals-media";
  if (bucket !== "executive-visuals-media") {
    throw new Error("Neon staging assets must use the canonical executive-visuals-media bucket until metadata and cleanup contracts support configurable buckets.");
  }
  const falRequested = Boolean(String(env.FAL_VIDEO_MODEL || "").trim() || env.FAL_KEY || env.FAL_BILLING_KEY);
  const runwayRouterRequested = env.RUNWAY_MODEL_ROUTER_ENABLED === "true";
  let runwayOutputHosts = [];
  if (runwayRouterRequested) {
    if (env.RUNWAY_VIDEO_ALLOW_REMOTE !== "true" || !String(env.RUNWAY_VIDEO_ROUTER_CONFIG || "").trim() ||
        !String(env.RUNWAY_API_KEY || env.RUNWAYML_API_SECRET || "").trim()) {
      throw new Error("Runway Model Router requires its explicit remote gate, router configuration ID and server-side API key.");
    }
    runwayOutputHosts = String(env.RUNWAY_OUTPUT_HOSTS || "").split(",").map(value => value.trim()).filter(Boolean);
    if (runwayOutputHosts.length < 1 || runwayOutputHosts.length > 100 ||
        runwayOutputHosts.some(host => !/^(?:\\*\\.)?[a-z0-9.-]{1,253}$/i.test(host))) {
      throw new Error("Runway output ingestion requires an explicit bounded RUNWAY_OUTPUT_HOSTS allowlist.");
    }
  }
  const neonStorage = storage || createNeonObjectStorage({
    endpoint: env.NEON_STORAGE_ENDPOINT,
    region: env.NEON_STORAGE_REGION,
    accessKeyId: env.NEON_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.NEON_STORAGE_SECRET_ACCESS_KEY,
    bucket,
    fetchImpl,
    timeoutMs,
    maxBytes: maxTotalBytes
  });
  if (neonStorage.bucket && neonStorage.bucket !== bucket) {
    throw new Error("Injected Neon storage bucket does not match the canonical asset metadata bucket.");
  }
  const authorizeAsset = createCloudAssetAuthorizer({
    url: env.SUPABASE_URL, serviceRoleKey, fetchImpl,
    timeoutMs: Math.min(timeoutMs, 8000)
  });
  const privateAssets = createCloudAssetService({
    url: env.SUPABASE_URL, serviceRoleKey, fetchImpl,
    storageProvider: "neon", neon: {
      endpoint: env.NEON_STORAGE_ENDPOINT,
      region: env.NEON_STORAGE_REGION,
      accessKeyId: env.NEON_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.NEON_STORAGE_SECRET_ACCESS_KEY,
      bucket
    },
    storage: neonStorage, authorize: authorizeAsset,
    storageTimeoutMs: Math.min(timeoutMs, 30000),
    metadataTimeoutMs: timeoutMs,
    authorizationTimeoutMs: Math.min(timeoutMs, 8000),
    maxBytes: maxBytesPerOutput
  });
  const validateMedia = createFfprobeVideoOutputValidator({
    ffprobePath, timeoutMs: Math.min(timeoutMs, 15000)
  });
  const outputIngestor = createPrivateVideoOutputIngestor({
    assets: privateAssets.assets,
    allowedHosts: [...new Set([...allowedOutputHosts, ...runwayOutputHosts])],
    validateMedia,
    timeoutMs,
    maxBytesPerOutput,
    maxTotalBytes
  });
  const ingestOutputs = args => outputIngestor.ingest(args);
  const adapters = [];
  if (falRequested) {
    adapters.push(createFalVideoProviderAdapter({
      env, fetchImpl, ingestOutputs
    }));
  }
  if (runwayRouterRequested) {
    const sourceResolver = createRunwaySourceAssetResolver({
      assets: privateAssets.assets, fetchImpl, supabaseUrl: env.SUPABASE_URL,
      storageProvider: "neon", neonEndpoint: env.NEON_STORAGE_ENDPOINT,
      neonBucket: bucket, ffprobePath, maxBytes: maxBytesPerOutput, timeoutMs
    });
    adapters.push(createRunwayModelRouterVideoAdapter({
      configId: env.RUNWAY_VIDEO_ROUTER_CONFIG,
      apiKey: env.RUNWAY_API_KEY || env.RUNWAYML_API_SECRET,
      enabled: true, allowRemote: true, fetchImpl,
      prepareInput: sourceResolver.prepare,
      ingestOutputs, timeoutMs: Math.min(timeoutMs, 30000)
    }));
  }
  if (adapters.length < 1) {
    throw new Error("Neon staging requires at least one explicitly configured, billing-capable video provider adapter.");
  }

  const authorizeJob = async ({ ownerId, projectId } = {}) => {
    if (typeof ownerId !== "string" || typeof projectId !== "string" ||
        !projectId.trim()) return false;
    try {
      return await authorizeAsset({ ownerId, projectId, action: "write" }) === true;
    } catch {
      return false;
    }
  };

  return Object.freeze({
    adapters: Object.freeze(adapters),
    storage: neonStorage,
    assets: privateAssets.assets,
    authorizeJob,
    readiness: Object.freeze({
      provider: adapters.length === 1 ? adapters[0].provider : "multi-provider",
      model: adapters.length === 1 ? adapters[0].model : null,
      providers: Object.freeze(adapters.map(adapter => Object.freeze({
        provider: adapter.provider, model: adapter.model,
        billing: adapter.provider === "fal" ? "fal-task-usage" : "runway-model-router-task-cost"
      }))),
      storage: "neon-private",
      metadata: "supabase",
      billing: adapters.length === 1
        ? (adapters[0].provider === "fal" ? "fal-task-usage" : "runway-model-router-task-cost")
        : "provider-specific-task-cost"
    })
  });
}
