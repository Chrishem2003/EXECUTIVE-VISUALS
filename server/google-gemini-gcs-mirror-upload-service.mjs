const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEDIA_TYPES=new Set(["image/jpeg","image/png","image/webp","image/gif","video/mp4","video/webm","video/quicktime","audio/mpeg","audio/wav","audio/x-wav","audio/mp4","audio/ogg","application/pdf","text/plain","text/vtt","application/json"]);
const fail=(message,code,status)=>Object.assign(new Error(message),{code,status});

/**
 * Authenticated owner/editor facade for mirroring an existing private asset.
 * The caller supplies no owner ID, bytes, bucket, object name or cloud URL.
 */
export function createGoogleGeminiGcsMirrorUploadService({
  mirrorService,geminiFiles=null,getProjectAccess,canWriteProject,audit
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
  },
  async registerWithGemini({ownerId,projectId=null,assetId,mediaType}={}){
   if(!geminiFiles||typeof geminiFiles.registerAsset!=="function")
    throw fail("Gemini GCS registration is disabled by server policy.","GEMINI_GCS_REGISTRATION_DISABLED",503);
   if(typeof ownerId!=="string"||!UUID.test(ownerId)||typeof assetId!=="string"||!UUID.test(assetId)||
      (projectId!==null&&projectId!==undefined&&projectId!==""&&(typeof projectId!=="string"||!UUID.test(projectId)))||
      typeof mediaType!=="string"||!MEDIA_TYPES.has(mediaType.toLowerCase())){
    throw fail("Authenticated owner, private asset, optional project and supported media type are required.","GEMINI_GCS_MIRROR_REQUEST_INVALID",400);
   }
   const scopedProjectId=projectId||null;
   if(scopedProjectId){
    const access=getProjectAccess(ownerId,scopedProjectId);
    if(!access)throw fail("Project not found or not accessible.","PROJECT_NOT_FOUND",404);
    if(!canWriteProject(ownerId,scopedProjectId))throw fail("Owner or editor access is required to register project media with Gemini.","EDITOR_REQUIRED",403);
   }
   await mirrorService.mirrorAsset({assetId,ownerId,projectId:scopedProjectId});
   const file=await geminiFiles.registerAsset({assetId,ownerId,projectId:scopedProjectId,mediaType:mediaType.toLowerCase()});
   if(!file||typeof file.uri!=="string"||typeof file.providerFileName!=="string"||
      typeof file.expiresAt!=="string"||!Number.isFinite(Date.parse(file.expiresAt))){
    throw fail("Gemini GCS registration did not return a valid active provider-file receipt.","GEMINI_GCS_MIRROR_RECEIPT_INVALID",502);
   }
   await audit(ownerId,"integration.google_gcs.gemini_file_registered","provider_file",file.providerFileName,{
    projectId:scopedProjectId,assetId,mediaType:mediaType.toLowerCase(),expiresAt:file.expiresAt,reused:Boolean(file.reused)
   },scopedProjectId);
   return Object.freeze({status:"registered",assetId,projectId:scopedProjectId,providerFileName:file.providerFileName,uri:file.uri,mediaType:mediaType.toLowerCase(),expiresAt:file.expiresAt,reused:Boolean(file.reused)});
  }
 });
}
