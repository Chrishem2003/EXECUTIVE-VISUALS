import { createCloudAssetAuthorizer } from "./cloud-asset-auth.mjs";
import { createCloudAssetRepository } from "./cloud-assets.mjs";
import { createCloudStorage } from "./cloud-storage.mjs";
import { createCloudflareR2Storage } from "./cloudflare-r2-storage.mjs";

/**
 * Compose the production cloud asset boundary with the private storage and
 * role-aware authorization adapters. This factory never changes the local
 * asset API; callers must explicitly opt into the returned service.
 */
export function createCloudAssetService(options={}) {
 const shared={url:options.url,serviceRoleKey:options.serviceRoleKey,fetchImpl:options.fetchImpl};
 const storageProvider=String(options.storageProvider??process.env.CLOUD_MEDIA_STORAGE_PROVIDER??"supabase").trim().toLowerCase();
 let storage=options.storage||null;
 if(!storage&&storageProvider==="r2")storage=createCloudflareR2Storage({
  ...(options.r2||{}),fetchImpl:options.storageFetchImpl||options.fetchImpl||globalThis.fetch,
  timeoutMs:options.storageTimeoutMs??30000,maxBytes:options.maxBytes??250*1024*1024
 });
 else if(!storage&&storageProvider==="supabase")storage=createCloudStorage({
  ...shared,timeoutMs:options.storageTimeoutMs??30000,maxBytes:options.maxBytes??250*1024*1024
 });
 else if(!storage)throw new Error("CLOUD_MEDIA_STORAGE_PROVIDER must be supabase or r2.");
 const authorize=options.authorize||createCloudAssetAuthorizer({
  ...shared,
  timeoutMs:options.authorizationTimeoutMs??8000
 });
 const repository=createCloudAssetRepository({
  ...shared,
  storage,
  authorize,
  timeoutMs:options.metadataTimeoutMs??15000
 });
 return Object.freeze({assets:repository,storage});
}
