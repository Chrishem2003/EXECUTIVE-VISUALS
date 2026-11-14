const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEDIA_TYPES=new Set(["image/jpeg","image/png","image/webp","image/gif","video/mp4","video/webm","video/quicktime","audio/mpeg","audio/wav","audio/x-wav","audio/mp4","audio/ogg","application/pdf","text/plain","text/vtt","application/json"]);
const fail=(message,code,status)=>Object.assign(new Error(message),{code,status});

/**
 * Owner/editor-scoped facade for preparing an existing private asset for the
 * Gemini Files API. It never accepts bytes, URLs or caller-supplied owner IDs.
 */
export function createGoogleGeminiFilesUploadService({gateway,getProjectAccess,canWriteProject,audit}={}){
 if(!gateway||typeof gateway.resolveAsset!=="function")throw new TypeError("Gemini Files upload service requires the private asset gateway.");
 if(typeof getProjectAccess!=="function"||typeof canWriteProject!=="function"||typeof audit!=="function")throw new TypeError("Gemini Files upload service requires project authorization and audit callbacks.");
 return Object.freeze({
  async prepare({ownerId,projectId=null,assetId,mediaType}={}){
   if(typeof ownerId!=="string"||!UUID.test(ownerId)||typeof assetId!=="string"||!UUID.test(assetId)||
      (projectId!==null&&projectId!==undefined&&projectId!==""&&(typeof projectId!=="string"||!UUID.test(projectId)))||
      typeof mediaType!=="string"||!MEDIA_TYPES.has(mediaType.toLowerCase())){
    throw fail("Authenticated owner, private asset, optional project and supported media type are required.","GEMINI_FILE_REQUEST_INVALID",400);
   }
   const scopedProjectId=projectId||null;
   if(scopedProjectId){
    const access=getProjectAccess(ownerId,scopedProjectId);
    if(!access)throw fail("Project not found or not accessible.","PROJECT_NOT_FOUND",404);
    if(!canWriteProject(ownerId,scopedProjectId))throw fail("Owner or editor access is required to upload project media to Gemini.","EDITOR_REQUIRED",403);
   }
   const file=await gateway.resolveAsset({assetId,ownerId,projectId:scopedProjectId,mediaType:mediaType.toLowerCase()});
   if(!file||typeof file.expiresAt!=="string"||!Number.isFinite(Date.parse(file.expiresAt))||
      typeof file.mediaType!=="string"||file.mediaType!==mediaType.toLowerCase()){
    throw fail("Gemini Files gateway did not return a valid active file receipt.","GEMINI_FILE_RECEIPT_INVALID",502);
   }
   const subjectId=typeof file.providerFileName==="string"?file.providerFileName:"temporary-file";
   await audit(ownerId,"integration.google_gemini.file_prepared","provider_file",subjectId,{
    projectId:scopedProjectId,assetId,mediaType:file.mediaType,expiresAt:file.expiresAt
   },scopedProjectId);
   return Object.freeze({status:"active",assetId,mediaType:file.mediaType,expiresAt:file.expiresAt});
  }
 });
}
