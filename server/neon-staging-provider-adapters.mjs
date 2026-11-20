import { createCloudAssetAuthorizer } from "./cloud-asset-auth.mjs";
import { createCloudAssetService } from "./cloud-asset-service.mjs";
import { createFfprobeVideoOutputValidator, createPrivateVideoOutputIngestor } from "./private-video-output-ingestion.mjs";
import { createFalVideoProviderAdapter } from "./fal-video-provider-registration.mjs";
import { createNeonObjectStorage } from "./neon-object-storage.mjs";

/**
 * Build the first production-shaped Neon staging provider registry.
 *
 * The FAL adapter is exact-model only and uses its task billing API for
 * settlement. Generated media is downloaded through the SSRF-hardened,
 * FFprobe-validated ingestion path and written to private Neon storage while
 * asset metadata and project authorization remain on the existing Supabase
 * boundary. Construction performs no provider or storage requests.
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
    throw new Error("Neon FAL execution requires explicit worker, gateway and remote-execution gates.");
  }
  if (String(env.CLOUD_MEDIA_STORAGE_PROVIDER || "").toLowerCase() !== "neon") {
    throw new Error("Neon staging provider adapters require CLOUD_MEDIA_STORAGE_PROVIDER=neon.");
  }
  if (!env.SUPABASE_URL || !(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Error("Neon staging media publication requires server-side Supabase asset metadata credentials.");
  }
  if (typeof fetchImpl !== "function") throw new Error("Neon staging provider adapters require fetch.");

  const serviceRoleKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  const neonStorage = storage || createNeonObjectStorage({
    endpoint: env.NEON_STORAGE_ENDPOINT,
    region: env.NEON_STORAGE_REGION,
    accessKeyId: env.NEON_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.NEON_STORAGE_SECRET_ACCESS_KEY,
    bucket: env.NEON_STORAGE_BUCKET || "executive-visuals-media",
    fetchImpl,
    timeoutMs,
    maxBytes: maxTotalBytes
  });
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
      bucket: env.NEON_STORAGE_BUCKET || "executive-visuals-media"
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
    allowedHosts: allowedOutputHosts,
    validateMedia,
    timeoutMs,
    maxBytesPerOutput,
    maxTotalBytes
  });
  const adapter = createFalVideoProviderAdapter({
    env, fetchImpl,
    ingestOutputs: args => outputIngestor.ingest(args)
  });

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
    adapters: Object.freeze([adapter]),
    storage: neonStorage,
    assets: privateAssets.assets,
    authorizeJob,
    readiness: Object.freeze({
      provider: "fal",
      model: adapter.model,
      storage: "neon-private",
      metadata: "supabase",
      billing: "fal-task-usage"
    })
  });
}
