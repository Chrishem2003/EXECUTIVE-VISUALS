import { createCloudAssetService } from "./cloud-asset-service.mjs";
import { createCloudMediaAssetIO } from "./cloud-media-io.mjs";
import { createGoogleGeminiGcsAssetResolver } from "./google-gemini-gcs-asset-resolver.mjs";
import { createGoogleGeminiGcsMirrorWriter } from "./google-gemini-gcs-mirror-writer.mjs";
import { createGoogleGeminiGcsSourceRepository } from "./google-gemini-gcs-source-repository.mjs";

function validAsset(asset, { assetId, ownerId, projectId }) {
  if (!asset || asset.id !== assetId || asset.ownerId !== ownerId ||
      (asset.projectId || null) !== projectId ||
      asset.storageBucket !== "executive-visuals-media" || asset.deletedAt) {
    const error = new Error("Private asset is outside the authorized owner/project scope.");
    error.code = "GEMINI_GCS_ASSET_SCOPE_INVALID";
    throw error;
  }
  return asset;
}

/**
 * Mirrors an existing private Supabase asset to an allowlisted GCS bucket.
 * The private asset remains canonical. Only after the GCS object is uploaded,
 * read back and verified is its source mapping committed to the service-only
 * GCS registry. Construction is side-effect free.
 */
export function createGoogleGeminiGcsMirrorService({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  env = process.env,
  fetchImpl = globalThis.fetch,
  getAccessToken,
  loadPrivateAsset,
  authorizePrivateAsset: authorizePrivateAssetOverride,
  sourceRepository,
  maxBytes = 250 * 1024 * 1024,
  timeoutMs = 120000,
  makeId
} = {}) {
  if (typeof fetchImpl !== "function" || typeof getAccessToken !== "function") {
    throw new TypeError("GCS mirror service requires fetch and a Google Cloud OAuth token provider.");
  }
  if (typeof loadPrivateAsset !== "undefined" && typeof loadPrivateAsset !== "function") {
    throw new TypeError("GCS mirror private asset loader must be a function.");
  }
  if (typeof authorizePrivateAssetOverride !== "undefined" && typeof authorizePrivateAssetOverride !== "function") {
    throw new TypeError("GCS mirror private asset authorizer must be a function.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024 * 1024) {
    throw new Error("GCS mirror service byte limit is invalid.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
    throw new Error("GCS mirror service timeout is invalid.");
  }

  let privateAssetLoader = loadPrivateAsset;
  let authorizePrivateAsset = authorizePrivateAssetOverride;
  if (!privateAssetLoader || !authorizePrivateAsset) {
    const cloudAssets = createCloudAssetService({
      url, serviceRoleKey, fetchImpl,
      storageTimeoutMs: Math.min(timeoutMs, 120000),
      metadataTimeoutMs: Math.min(timeoutMs, 30000),
      authorizationTimeoutMs: Math.min(timeoutMs, 8000),
      maxBytes: Math.min(maxBytes, 250 * 1024 * 1024)
    });
    if (!authorizePrivateAsset) {
      authorizePrivateAsset = async ({ assetId, ownerId, projectId = null }) => {
        const signed = await cloudAssets.assets.createSignedUrl({ ownerId, assetId, expiresIn: 60 });
        return validAsset(signed?.asset, { assetId, ownerId, projectId: projectId || null });
      };
    }
    if (!privateAssetLoader) {
      const mediaIO = createCloudMediaAssetIO({
        assets: cloudAssets.assets, fetchImpl,
        maxBytes: Math.min(maxBytes, 250 * 1024 * 1024), timeoutMs: Math.min(timeoutMs, 120000)
      });
      privateAssetLoader = async ({ assetId, ownerId, projectId = null }) => {
        const materialized = await mediaIO.materialize({ ownerId, assetId });
        try {
          const asset = validAsset(materialized.asset, { assetId, ownerId, projectId: projectId || null });
          if (materialized.size !== asset.size || materialized.sha256 !== asset.sha256) {
            throw new Error("Materialized private asset does not match its durable metadata.");
          }
          return {
            asset, path: materialized.path, size: materialized.size,
            sha256: materialized.sha256, cleanup: materialized.cleanup
          };
        } catch (error) {
          await materialized.cleanup();
          throw error;
        }
      };
    }
  }

  const sources = sourceRepository || createGoogleGeminiGcsSourceRepository({
    url, serviceRoleKey, fetchImpl, timeoutMs: Math.min(timeoutMs, 30000)
  });
  if (typeof sources.findActiveSource !== "function" ||
      typeof sources.recordVerifiedSource !== "function" ||
      typeof sources.revokeSource !== "function") {
    throw new TypeError("GCS mirror service requires the governed source repository.");
  }

  const resolver = createGoogleGeminiGcsAssetResolver({
    env, loadSource: scope => sources.findActiveSource(scope),
    getAccessToken, fetchImpl, maxBytes, timeoutMs: Math.min(timeoutMs, 120000)
  });
  const writer = createGoogleGeminiGcsMirrorWriter({
    env, fetchImpl, getAccessToken, sourceRepository: sources,
    maxBytes, timeoutMs, ...(typeof makeId === "function" ? { makeId } : {})
  });

  return Object.freeze({
    async mirrorAsset({ assetId, ownerId, projectId: assetProjectId = null } = {}) {
      if (typeof assetId !== "string" || typeof ownerId !== "string" ||
          (assetProjectId !== null && assetProjectId !== undefined && typeof assetProjectId !== "string")) {
        const error = new Error("GCS mirror asset scope is invalid.");
        error.code = "GEMINI_GCS_ASSET_SCOPE_INVALID";
        throw error;
      }
      const scope = { assetId, ownerId, projectId: assetProjectId || null };
      const existing = await sources.findActiveSource(scope);
      if (existing) {
        const verified = await resolver.resolvePrivateGcsAsset(scope);
        return Object.freeze({ source: existing, asset: verified.asset, gcsUri: verified.gcsUri, generation: verified.generation, reused: true });
      }

      const authorized = validAsset(await authorizePrivateAsset(scope), scope);
      const materialized = await privateAssetLoader(scope);
      if (!materialized || typeof materialized.cleanup !== "function") {
        throw new Error("Private asset loader must return a cleanup callback.");
      }
      let primaryError = null;
      try {
        const asset = validAsset(materialized.asset, scope);
        if (!materialized.path || !Number.isSafeInteger(materialized.size) ||
            materialized.size !== asset.size || materialized.sha256 !== asset.sha256 ||
            asset.mediaType !== authorized.mediaType || asset.sha256 !== authorized.sha256 ||
            asset.size !== authorized.size) {
          throw new Error("Private asset materialization does not match the authorized durable asset.");
        }
        const mirrored = await writer.mirrorAsset({
          assetId, ownerId, projectId: scope.projectId,
          mediaType: asset.mediaType, filePath: materialized.path,
          sizeBytes: materialized.size, sha256: materialized.sha256
        });
        const verified = await resolver.resolvePrivateGcsAsset(scope);
        return Object.freeze({
          source: mirrored.source, asset: verified.asset,
          gcsUri: verified.gcsUri, generation: verified.generation, reused: false
        });
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        try { await materialized.cleanup(); }
        catch {
          if (primaryError) primaryError.cleanupPending = true;
          else {
            const cleanupError = new Error("Temporary private asset cleanup failed after GCS mirroring.");
            cleanupError.code = "GEMINI_GCS_TEMP_CLEANUP_FAILED";
            throw cleanupError;
          }
        }
      }
    },
    revokeSource: args => sources.revokeSource(args)
  });
}
