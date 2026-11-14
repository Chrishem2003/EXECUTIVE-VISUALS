import { createCloudAssetService } from "./cloud-asset-service.mjs";
import { createCloudAssetAuthorizer } from "./cloud-asset-auth.mjs";
import { createCloudTimelineRepository } from "./cloud-timelines.mjs";
import { createCloudProjectRepository } from "./cloud-projects.mjs";

/**
 * Opt-in cloud timeline service. Asset lookup and authorization share the
 * exact same private asset boundary used by the media worker.
 */
export function createCloudTimelineService(options={}){
  const shared={url:options.url,serviceRoleKey:options.serviceRoleKey,fetchImpl:options.fetchImpl};
  const assets=options.assetService||createCloudAssetService({...shared,maxBytes:options.maxBytes,storageProvider:options.storageProvider,r2:options.r2});
  const authorize=options.authorize||createCloudAssetAuthorizer({...shared});
  const projects=createCloudProjectRepository({...shared,authorize,timeoutMs:options.timeoutMs??12000});
  const timelines=createCloudTimelineRepository({
    ...shared,
    authorize,
    getAsset:options.getAsset||assets.assets.get.bind(assets.assets),
    timeoutMs:options.timeoutMs??12000,
    maxDocumentBytes:options.maxDocumentBytes??5*1024*1024
  });
  return Object.freeze({assets:assets.assets,storage:assets.storage||null,timelines,projects});
}
