import { createCloudAssetAuthorizer } from "./cloud-asset-auth.mjs";
import { createCloudAssetRepository } from "./cloud-assets.mjs";
import { createCloudStorage } from "./cloud-storage.mjs";
import { createCloudflareR2Storage } from "./cloudflare-r2-storage.mjs";
import { createBackblazeB2Storage } from "./backblaze-b2-storage.mjs";

/**
 * Compose the production cloud asset boundary with the private storage and
 * role-aware authorization adapters. This factory never changes the local
 * asset API; callers must explicitly opt into the returned service.
 */
export function createCloudAssetService(options={}) {
 const shared={url:options.url,serviceRoleKey:options.serviceRoleKey,fetchImpl:options.fetchImpl};
 const storageProvider=String(options.storageProvider??process.env.CLOUD_MEDIA_STORAGE_PROVIDER??"supabase").trim().toLowerCase();
 let storage=options.storage||null;
 // The current asset metadata schema, publication RPCs and cleanup ledger intentionally
 // pin all objects to this bucket. Reject a custom R2 bucket before any upload can occur.
 if(!storage&&["r2","b2"].includes(storageProvider)&&String((storageProvider==="r2"?options.r2?.bucket??process.env.R2_BUCKET:options.b2?.bucket??process.env.B2_BUCKET)||"executive-visuals-media")!=="executive-visuals-media"){
  throw new Error("R2_BUCKET must be executive-visuals-media until the asset metadata and cleanup contracts support configurable buckets.");
 }
 if(!storage&&storageProvider==="b2")storage=createBackblazeB2Storage({
  ...(options.b2||{}),fetchImpl:options.storageFetchImpl||options.fetchImpl||globalThis.fetch,
  timeoutMs:options.storageTimeoutMs??30000,maxBytes:options.maxBytes??250*1024*1024
 });
 else if(!storage&&storageProvider==="r2")storage=createCloudflareR2Storage({
  ...(options.r2||{}),fetchImpl:options.storageFetchImpl||options.fetchImpl||globalThis.fetch,
  timeoutMs:options.storageTimeoutMs??30000,maxBytes:options.maxBytes??250*1024*1024
 });
 else if(!storage&&storageProvider==="supabase")storage=createCloudStorage({
  ...shared,timeoutMs:options.storageTimeoutMs??30000,maxBytes:options.maxBytes??250*1024*1024
 });
 else if(!storage)throw new Error("CLOUD_MEDIA_STORAGE_PROVIDER must be supabase, r2 or b2.");
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
