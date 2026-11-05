const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(message,code,status)=>Object.assign(new Error(message),{code,status});

/**
 * Authenticated owner/editor facade for mirroring an existing private asset.
 * The caller supplies no owner ID, bytes, bucket, object name or cloud URL.
 */
export function createGoogleGeminiGcsMirrorUploadService({
  mirrorService,getProjectAccess,canWriteProject,audit
}={}){
 if(!mirrorService||typeof mirrorService.mirrorAsset!=="function")
  throw new TypeError("GCS mirror upload service requires the server-side mirror service.");
 if(typeof getProjectAccess!=="function"||typeof canWriteProject!=="function"||typeof audit!=="function")
  throw new TypeError("GCS mirror upload service requires project authorization and audit callbacks.");
 return Object.freeze({
  async mirror({ownerId,projectId=null,assetId}={}){
   if(typeof ownerId!=="string"||!UUID.test(ownerId)||typeof assetId!=="string"||!UUID.test(assetId)||
      (projectId!==null&&projectId!==undefined&&projectId!==""&&(typeof projectId!=="string"||!UUID.test(projectId)))){
    throw fail("Authenticated owner, private asset and optional project are required.","GEMINI_GCS_MIRROR_REQUEST_INVALID",400);
   }
   const scopedProjectId=projectId||null;
   if(scopedProjectId){
    const access=getProjectAccess(ownerId,scopedProjectId);
    if(!access)throw fail("Project not found or not accessible.","PROJECT_NOT_FOUND",404);
    if(!canWriteProject(ownerId,scopedProjectId))throw fail("Owner or editor access is required to mirror project media.","EDITOR_REQUIRED",403);
   }
   const result=await mirrorService.mirrorAsset({assetId,ownerId,projectId:scopedProjectId});
   if(!result||typeof result.generation!=="string"||!result.generation)
    throw fail("GCS mirror service did not return a verified generation receipt.","GEMINI_GCS_MIRROR_RECEIPT_INVALID",502);
   await audit(ownerId,"integration.google_gcs.asset_mirrored","private_asset",assetId,{
    projectId:scopedProjectId,generation:result.generation,reused:Boolean(result.reused)
   },scopedProjectId);
   return Object.freeze({status:"mirrored",assetId,projectId:scopedProjectId,generation:result.generation,reused:Boolean(result.reused)});
  }
 });
}
