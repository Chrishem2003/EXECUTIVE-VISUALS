import { createRunwayPrivateAssetResolver } from "./runway-private-asset-resolver.mjs";

const MAX_BYTES = 200 * 1024 * 1024;
const fail = (message, code) => Object.assign(new Error(message), { code });

function safeOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Cloud Runway asset resolver requires a valid Supabase URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Cloud Runway asset resolver requires a clean HTTPS Supabase origin.");
  }
  return url.origin;
}

/**
 * Composes the existing private Cloud Asset Repository with the Runway
 * ephemeral uploader. Asset metadata authorization is performed by assets.get
 * and assets.createSignedUrl; the signed file is downloaded only server-side.
 */
export function createCloudRunwayPrivateAssetResolver({
  assets,
  supabaseUrl = process.env.SUPABASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
  maxBytes = MAX_BYTES,
  runwayEnv = process.env,
  runwayFetchImpl = fetchImpl
} = {}) {
  if (!assets || typeof assets.get !== "function" || typeof assets.createSignedUrl !== "function") {
    throw new Error("Cloud Runway asset resolver requires the authorized cloud asset repository.");
  }
  if (typeof fetchImpl !== "function") throw new Error("Cloud Runway asset resolver requires fetch.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error("Cloud asset download timeout is invalid.");
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 512 || maxBytes > MAX_BYTES) {
    throw new Error("Cloud asset download limit must be between 512 bytes and 200 MB.");
  }
  const origin = safeOrigin(supabaseUrl);

  const loadPrivateAsset = async ({ assetId, ownerId, projectId = null }) => {
    let asset;
    try { asset = await assets.get({ ownerId, assetId }); }
    catch { throw fail("Private cloud image asset was not found or is not authorized.", "RUNWAY_IMAGE_ASSET_SCOPE_INVALID"); }
    if (!asset || asset.id !== assetId || asset.ownerId !== ownerId ||
        (asset.projectId != null && asset.projectId !== projectId) ||
        asset.storageBucket !== "executive-visuals-media" ||
        !["image/png", "image/jpeg", "image/webp"].includes(asset.mediaType) ||
        !Number.isSafeInteger(asset.size) || asset.size < 512 || asset.size > maxBytes ||
        typeof asset.name !== "string") {
      throw fail("Cloud image asset metadata does not satisfy the owner/project and media constraints.", "RUNWAY_IMAGE_ASSET_SCOPE_INVALID");
    }

    let signed;
    try { signed = await assets.createSignedUrl({ ownerId, assetId, expiresIn: 300 }); }
    catch { throw fail("Cloud image asset could not be opened for private server-side reading.", "RUNWAY_IMAGE_ASSET_READ_FAILED"); }
    if (signed?.asset?.id !== assetId || signed.asset.ownerId !== ownerId ||
        (signed.asset.projectId != null && signed.asset.projectId !== projectId) ||
        typeof signed.url !== "string") {
      throw fail("Cloud signed asset receipt does not match the authorized asset.", "RUNWAY_IMAGE_ASSET_SCOPE_INVALID");
    }

    let url;
    try { url = new URL(signed.url); } catch { throw fail("Cloud storage returned an invalid signed asset URL.", "RUNWAY_IMAGE_ASSET_READ_FAILED"); }
    if (url.origin !== origin || url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw fail("Cloud storage returned a signed URL outside the configured Supabase origin.", "RUNWAY_IMAGE_ASSET_READ_FAILED");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(url.href, { method: "GET", signal: controller.signal, redirect: "error" });
      } catch (error) {
        throw fail(error?.name === "AbortError" ? "Private cloud image download timed out." : "Private cloud image download failed.",
          error?.name === "AbortError" ? "RUNWAY_IMAGE_ASSET_TIMEOUT" : "RUNWAY_IMAGE_ASSET_READ_FAILED");
      }
      if (!response.ok) throw fail("Private cloud image download was rejected (" + response.status + ").", "RUNWAY_IMAGE_ASSET_READ_FAILED");
      const contentType = String(response.headers?.get?.("content-type") || "").split(";")[0].trim().toLowerCase();
      if (contentType !== asset.mediaType) throw fail("Private cloud image media type does not match its asset record.", "RUNWAY_IMAGE_ASSET_TYPE_UNSUPPORTED");
      const declaredLength = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw fail("Private cloud image exceeds the Runway upload limit.", "RUNWAY_IMAGE_ASSET_SIZE_INVALID");
      }

      const chunks = [];
      let total = 0;
      if (!response.body || typeof response.body.getReader !== "function") {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.byteLength > maxBytes) throw fail("Private cloud image exceeds the Runway upload limit.", "RUNWAY_IMAGE_ASSET_SIZE_INVALID");
        chunks.push(bytes);
        total = bytes.byteLength;
      } else {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            total += chunk.byteLength;
            if (total > maxBytes) {
              await reader.cancel();
              throw fail("Private cloud image exceeds the Runway upload limit.", "RUNWAY_IMAGE_ASSET_SIZE_INVALID");
            }
            chunks.push(chunk);
          }
        } finally {
          reader.releaseLock?.();
        }
      }
      if (total !== asset.size) throw fail("Private cloud image size does not match its asset record.", "RUNWAY_IMAGE_ASSET_INVALID");
      return {
        id: asset.id,
        ownerId: asset.ownerId,
        projectId: asset.projectId || null,
        isPrivate: true,
        filename: asset.name,
        contentType: asset.mediaType,
        bytes: Buffer.concat(chunks, total)
      };
    } finally {
      clearTimeout(timer);
    }
  };

  return createRunwayPrivateAssetResolver({
    env: runwayEnv,
    fetchImpl: runwayFetchImpl,
    loadPrivateAsset
  });
}
