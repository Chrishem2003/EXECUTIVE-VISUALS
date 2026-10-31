import { createCloudAssetAuthorizer } from "./cloud-asset-auth.mjs";
import { createCloudAssetRepository } from "./cloud-assets.mjs";
import { createCloudStorage } from "./cloud-storage.mjs";

/**
 * Compose the production cloud asset boundary with the private storage and
 * role-aware authorization adapters. This factory never changes the local
 * asset API; callers must explicitly opt into the returned service.
 */
export function createCloudAssetService(options={}) {
 const shared={url:options.url,serviceRoleKey:options.serviceRoleKey,fetchImpl:options.fetchImpl};
 const storage=options.storage||createCloudStorage({
  ...shared,
  timeoutMs:options.storageTimeoutMs??30000,
  maxBytes:options.maxBytes??250*1024*1024
 });
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
