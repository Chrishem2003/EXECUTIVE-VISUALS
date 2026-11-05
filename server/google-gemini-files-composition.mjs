import { createCloudAssetService } from "./cloud-asset-service.mjs";
import { createCloudMediaAssetIO } from "./cloud-media-io.mjs";
import { createGoogleGeminiFilesGateway } from "./google-gemini-files-gateway.mjs";
import { createGoogleGeminiFilesRepository } from "./google-gemini-files-repository.mjs";

/**
 * Composes Gemini Files uploads with the existing private Cloud Asset Service.
 * Construction performs no network requests and does not enable generation.
 */
export function createGoogleGeminiFilesComposition({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  env = process.env,
  fetchImpl = globalThis.fetch,
  loadPrivateAsset,
  authorizePrivateAsset: authorizePrivateAssetOverride,
  repository,
  maxBytes = 250 * 1024 * 1024,
  timeoutMs = 30000,
  ...gatewayOptions
} = {}) {
  if (!url || !serviceRoleKey || typeof fetchImpl !== "function") {
    throw new Error("Google Gemini Files composition requires server-side Supabase credentials and fetch.");
  }
  if (typeof loadPrivateAsset !== "undefined" && typeof loadPrivateAsset !== "function") {
    throw new Error("Google Gemini Files private asset loader must be a function.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024 * 1024) {
    throw new Error("Google Gemini Files composition byte limit is invalid.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error("Google Gemini Files composition timeout is invalid.");
  }

  let privateAssetLoader = loadPrivateAsset;
  let authorizePrivateAsset = authorizePrivateAssetOverride;
  if (!privateAssetLoader) {
    const cloudAssets = createCloudAssetService({
      url, serviceRoleKey, fetchImpl,
      storageTimeoutMs: timeoutMs,
      metadataTimeoutMs: timeoutMs,
      authorizationTimeoutMs: Math.min(timeoutMs, 8000),
      maxBytes: Math.min(maxBytes, 250 * 1024 * 1024)
    });
    authorizePrivateAsset = async ({ assetId, ownerId, projectId = null }) => {
      const signed = await cloudAssets.assets.createSignedUrl({ ownerId, assetId, expiresIn: 60 });
      if (!signed?.asset || (signed.asset.projectId || null) !== (projectId || null) ||
          signed.asset.storageBucket !== "executive-visuals-media") {
        throw new Error("Private cloud asset authorization returned an invalid project scope.");
      }
      return signed.asset;
    };
    const mediaIO = createCloudMediaAssetIO({
      assets: cloudAssets.assets,
      fetchImpl,
      maxBytes: Math.min(maxBytes, 250 * 1024 * 1024),
      timeoutMs
    });
    privateAssetLoader = async ({ assetId, ownerId, projectId = null }) => {
      const materialized = await mediaIO.materialize({ ownerId, assetId });
      const asset = materialized.asset;
      if (!asset || asset.id !== assetId || (asset.projectId || null) !== (projectId || null) ||
          asset.storageBucket !== "executive-visuals-media") {
        await materialized.cleanup();
        throw new Error("Private cloud asset is outside the authorized owner/project scope.");
      }
      return {
        asset,
        path: materialized.path,
        size: materialized.size,
        sha256: materialized.sha256,
        cleanup: materialized.cleanup
      };
    };
  }

  const mappings = repository || createGoogleGeminiFilesRepository({
    url, serviceRoleKey, fetchImpl, timeoutMs: Math.min(timeoutMs, 30000)
  });
  if (typeof mappings.findProviderFile !== "function" ||
      typeof mappings.recordProviderFile !== "function" ||
      typeof mappings.deleteProviderFileRecord !== "function" ||
      typeof mappings.createUploadAttempt !== "function" ||
      typeof mappings.updateUploadAttempt !== "function") {
    throw new Error("Google Gemini Files composition requires the durable provider-file repository.");
  }

  return createGoogleGeminiFilesGateway({
    env, fetchImpl, loadPrivateAsset: privateAssetLoader, authorizePrivateAsset,
    findProviderFile: args => mappings.findProviderFile(args),
    recordProviderFile: record => mappings.recordProviderFile(record),
    deleteProviderFileRecord: args => mappings.deleteProviderFileRecord(args),
    createUploadAttempt: attempt => mappings.createUploadAttempt(attempt),
    updateUploadAttempt: update => mappings.updateUploadAttempt(update),
    maxBytes: Math.min(maxBytes, 2 * 1024 * 1024 * 1024),
    timeoutMs,
    ...gatewayOptions
  });
}
