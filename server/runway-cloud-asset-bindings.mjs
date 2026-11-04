const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEDIA_PREFIX = Object.freeze({ image: "image/", video: "video/", audio: "audio/" });

/**
 * Binds Runway's reference-media resolver contract to Executive Visuals'
 * existing private cloud asset repository. The owner ID must come from the
 * authenticated request/session, never from user-supplied input.
 */
export function createRunwayCloudAssetBindings({
  assets,
  getAuthenticatedOwnerId,
  signedUrlExpiresIn = 600
} = {}) {
  if (!assets || typeof assets.list !== "function" ||
      typeof assets.get !== "function" || typeof assets.createSignedUrl !== "function") {
    throw new Error("Runway cloud asset bindings require the private cloud asset repository.");
  }
  if (typeof getAuthenticatedOwnerId !== "function") {
    throw new Error("Runway cloud asset bindings require an authenticated owner resolver.");
  }
  if (!Number.isInteger(signedUrlExpiresIn) || signedUrlExpiresIn < 30 || signedUrlExpiresIn > 3600) {
    throw new Error("Runway reference signed URL expiry must be between 30 and 3600 seconds.");
  }

  async function getAuthorizedAssetContext({ projectId } = {}) {
    if (typeof projectId !== "string" || !UUID.test(projectId)) {
      throw new Error("A valid project ID is required for Runway reference media.");
    }
    const ownerId = await getAuthenticatedOwnerId();
    if (typeof ownerId !== "string" || !UUID.test(ownerId)) {
      throw new Error("Authenticated owner identity is unavailable.");
    }
    // list() invokes the repository's project-role authorization boundary.
    await assets.list({ ownerId, projectId, limit: 1 });
    return Object.freeze({ ownerId, projectId });
  }

  async function resolvePrivateAsset({ assetId, ownerId, projectId, mediaType } = {}) {
    if (typeof assetId !== "string" || !UUID.test(assetId) ||
        typeof ownerId !== "string" || !UUID.test(ownerId) ||
        typeof projectId !== "string" || !UUID.test(projectId) ||
        !Object.hasOwn(MEDIA_PREFIX, mediaType)) {
      throw new Error("Runway private asset reference is invalid.");
    }
    const asset = await assets.get({ ownerId, assetId });
    if (!asset || asset.ownerId !== ownerId ||
        (asset.projectId !== null && asset.projectId !== projectId) ||
        typeof asset.mediaType !== "string" ||
        !asset.mediaType.startsWith(MEDIA_PREFIX[mediaType])) {
      throw new Error("Runway reference asset is outside the authorized project or media type.");
    }
    const signed = await assets.createSignedUrl({
      ownerId, assetId, expiresIn: signedUrlExpiresIn
    });
    if (signed?.asset?.id !== assetId || typeof signed.url !== "string" ||
        !/^https:\/\//i.test(signed.url)) {
      throw new Error("Cloud asset repository returned an invalid private media URL.");
    }
    return Object.freeze({ uri: signed.url, assetId, mediaType, expiresIn: signedUrlExpiresIn });
  }

  return Object.freeze({ getAuthorizedAssetContext, resolvePrivateAsset });
}
