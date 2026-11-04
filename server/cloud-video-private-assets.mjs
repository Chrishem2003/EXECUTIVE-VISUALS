import { readFile } from "node:fs/promises";

/**
 * Adapts the authenticated private cloud media repository to the Runway
 * first-frame resolver contract. Project-scoped assets may be owned by a
 * different collaborator, but must belong to the same authorized project.
 */
export function createCloudVideoPrivateAssetReader({ mediaIO, readFileImpl = readFile } = {}) {
  if (!mediaIO || typeof mediaIO.materialize !== "function") {
    throw new Error("Cloud video private asset reader requires cloud media IO.");
  }
  if (typeof readFileImpl !== "function") throw new Error("Cloud video private asset reader requires file reading.");

  return async function loadPrivateAsset({ assetId, ownerId, projectId = null } = {}) {
    const materialized = await mediaIO.materialize({ ownerId, assetId });
    if (!materialized || !materialized.asset || typeof materialized.path !== "string" ||
        typeof materialized.cleanup !== "function") {
      await materialized?.cleanup?.().catch?.(() => {});
      throw new Error("Cloud media IO returned invalid materialization metadata.");
    }
    try {
      const asset = materialized.asset;
      if (asset.id !== assetId || (asset.projectId || null) !== (projectId || null) ||
          asset.storageBucket !== "executive-visuals-media") return null;
      const bytes = await readFileImpl(materialized.path);
      if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) {
        throw new Error("Cloud media IO returned invalid private asset bytes.");
      }
      return {
        id: asset.id,
        ownerId: asset.ownerId,
        projectId: asset.projectId || null,
        isPrivate: true,
        filename: asset.name,
        contentType: asset.mediaType,
        bytes: Buffer.from(bytes)
      };
    } finally {
      await materialized.cleanup();
    }
  };
}