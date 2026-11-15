import { createHash } from "node:crypto";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPES=new Set(["image/jpeg","image/png","image/webp","image/gif","video/mp4","video/webm","video/quicktime"]);
const MAX_BYTES=250*1024*1024;
const fail=(message,code,status=400)=>Object.assign(new Error(message),{code,status});
const plain=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);

function safeFilename(value){
 const name=String(value||"source").normalize("NFKC").replace(/[\\/\u0000-\u001f\u007f]/g,"_").replace(/[^\p{L}\p{N}._() -]/gu,"_").trim().slice(0,180);
 return name||"source";
}
function attemptKey(identity){
 return createHash("sha256").update(JSON.stringify({
  provider:"luma-ray32",ownerId:identity.ownerId,projectId:identity.projectId||null,
  assetId:identity.assetId,purpose:identity.purpose,mimeType:identity.mimeType,
  byteSize:identity.byteSize,sha256:identity.sha256
 })).digest("hex");
}

export function createLumaProviderFileService({
 assets,adapter,repository,fetchImpl=globalThis.fetch,timeoutMs=30000,maxBytes=MAX_BYTES,now=()=>Date.now(),
 supabaseUrl=process.env.SUPABASE_URL,storageProvider=process.env.CLOUD_MEDIA_STORAGE_PROVIDER||"supabase",
 r2AccountId=process.env.R2_ACCOUNT_ID,r2Bucket=process.env.R2_BUCKET||"executive-visuals-media"
}={}){
 if(!assets||typeof assets.get!=="function"||typeof assets.createSignedUrl!=="function")throw new TypeError("Luma file service requires the authorized private asset repository.");
 for(const method of ["createFileUpload","uploadFileBytes","completeFileUpload","getFile","deleteFile"])if(typeof adapter?.[method]!=="function")throw new TypeError("Luma file service requires a complete Files API adapter.");
 for(const method of ["createAttempt","updateAttempt","getFileByAsset","upsertFile"])if(typeof repository?.[method]!=="function")throw new TypeError("Luma file service requires the durable provider-file repository.");
 if(typeof fetchImpl!=="function"||!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_BYTES||typeof now!=="function")throw new TypeError("Luma file service runtime configuration is invalid.");
 let expectedOrigin,expectedPathPrefix;
 try{
  if(String(storageProvider).toLowerCase()==="r2"){
   if(!/^[a-f0-9]{32}$/i.test(String(r2AccountId||""))||!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(String(r2Bucket)))throw new Error();
   expectedOrigin="https://"+r2AccountId+".r2.cloudflarestorage.com";expectedPathPrefix="/"+r2Bucket+"/";
  }else{
   const base=new URL(supabaseUrl);
   if(base.protocol!=="https:"&&!["localhost","127.0.0.1","[::1]"].includes(base.hostname))throw new Error();
   expectedOrigin=base.origin;expectedPathPrefix="/storage/v1/object/sign/";
  }
 }catch{throw new TypeError("Luma file service requires a safe private-storage origin.");}

 async function readPrivateAsset({ownerId,projectId,assetId}){
  if(!UUID.test(ownerId||"")||!UUID.test(assetId||"")||(projectId!==null&&projectId!==undefined&&!UUID.test(projectId)))throw fail("Authenticated owner, project and asset identifiers are required.","LUMA_FILE_SCOPE_INVALID",400);
  const asset=await assets.get({ownerId,assetId});
  if(!asset||asset.id!==assetId||(asset.projectId||null)!==(projectId||null)||(!projectId&&asset.ownerId!==ownerId))throw fail("Private asset is not available in the requested owner/project scope.","LUMA_FILE_ASSET_NOT_FOUND",404);
  if(!TYPES.has(asset.mediaType)||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>maxBytes||!/^[a-f0-9]{64}$/i.test(asset.sha256||""))throw fail("Private asset type, size or checksum is not supported by Luma Files API.","LUMA_FILE_ASSET_UNSUPPORTED",415);
  const signed=await assets.createSignedUrl({ownerId,assetId,expiresIn:300});
  if(!signed||signed.asset?.id!==assetId||signed.asset.ownerId!==asset.ownerId||(signed.asset.projectId||null)!==(asset.projectId||null)||typeof signed.url!=="string")throw fail("Private asset gateway did not return a matching owner/project-scoped signed download.","LUMA_FILE_SIGNED_URL_INVALID",502);
  let url;try{url=new URL(signed.url);}catch{throw fail("Private asset gateway returned an invalid signed URL.","LUMA_FILE_SIGNED_URL_INVALID",502);}
  if(url.origin!==expectedOrigin||!url.pathname.startsWith(expectedPathPrefix)||url.username||url.password||url.hash)throw fail("Private asset signed URL does not match the configured private-storage origin.","LUMA_FILE_SIGNED_URL_INVALID",502);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const response=await fetchImpl(url.toString(),{method:"GET",redirect:"error",signal:controller.signal});
   if(!response.ok)throw fail("Private asset download failed with HTTP "+response.status+".","LUMA_FILE_ASSET_DOWNLOAD_FAILED",response.status);
   const contentType=String(response.headers?.get?.("content-type")||"").split(";")[0].trim().toLowerCase();
   const declared=Number(response.headers?.get?.("content-length")||0);
   if(contentType!==asset.mediaType||declared>maxBytes||(declared>0&&declared!==asset.size))throw fail("Private asset response headers do not match stored metadata.","LUMA_FILE_ASSET_CHECKSUM_MISMATCH",409);
   const reader=response.body?.getReader?.();
   if(!reader)throw fail("Private asset response is not stream-readable.","LUMA_FILE_ASSET_DOWNLOAD_FAILED",502);
   const chunks=[];let total=0;
   try{
    while(true){
     const {done,value}=await reader.read();if(done)break;
     const chunk=Buffer.from(value);total+=chunk.length;
     if(total>Math.min(maxBytes,asset.size)){await reader.cancel().catch(()=>{});throw fail("Private asset exceeded its stored byte limit.","LUMA_FILE_ASSET_CHECKSUM_MISMATCH",409);}
     chunks.push(chunk);
    }
   }catch(error){if(error?.code==="LUMA_FILE_ASSET_CHECKSUM_MISMATCH")throw error;throw fail("Private asset download failed while streaming.","LUMA_FILE_ASSET_DOWNLOAD_FAILED",502);}
   finally{reader.releaseLock();}
   const bytes=Buffer.concat(chunks,total);
   if(bytes.byteLength!==asset.size||bytes.byteLength>maxBytes)throw fail("Private asset download size does not match stored metadata.","LUMA_FILE_ASSET_CHECKSUM_MISMATCH",409);
   const digest=createHash("sha256").update(bytes).digest("hex");
   if(digest!==asset.sha256)throw fail("Private asset checksum does not match stored metadata.","LUMA_FILE_ASSET_CHECKSUM_MISMATCH",409);
   return {asset,bytes};
  }catch(error){if(error?.name==="AbortError")throw fail("Private asset download timed out.","LUMA_FILE_ASSET_DOWNLOAD_TIMEOUT",504);throw error;}
  finally{clearTimeout(timer);}
 }

 async function persistReady(identity,file,attempt){
  const record=await repository.upsertFile({
   ...identity,providerFileId:file.fileId,state:"READY",providerExpiresAt:file.expiresAt||null,
   uploadedAt:new Date(now()).toISOString(),readyAt:new Date(now()).toISOString()
  });
  await repository.updateAttempt({id:attempt.id,fromStates:["PROVIDER_CREATED","COMPLETED"],state:"COMPLETED",patch:{provider_file_id:file.fileId,upload_completed_at:attempt.upload_completed_at||new Date(now()).toISOString(),last_error_code:null,reconciled_at:new Date(now()).toISOString()}});
  return Object.freeze({fileId:record.provider_file_id,state:"ready",assetId:identity.assetId,purpose:identity.purpose});
 }

 async function inspectProviderFile(identity,attempt){
  if(!attempt.provider_file_id)throw fail("Luma recovery record has no provider file ID.","LUMA_FILE_RECOVERY_QUARANTINED",409);
  const file=await adapter.getFile(attempt.provider_file_id);
  if(file.state==="ready")return persistReady(identity,{fileId:file.fileId,expiresAt:attempt.upload_expires_at},attempt);
  if(file.state==="failed"||file.state==="deleted"){
   await repository.updateAttempt({id:attempt.id,fromStates:["PROVIDER_CREATED"],state:"FAILED",patch:{last_error_code:"LUMA_FILE_"+file.state.toUpperCase(),reconciled_at:new Date(now()).toISOString()}});
   await repository.upsertFile({...identity,providerFileId:file.fileId,state:file.state.toUpperCase(),providerExpiresAt:null,failureCode:file.failureReason||"LUMA_FILE_"+file.state.toUpperCase()});
   throw fail("Luma rejected or deleted the uploaded source file.","LUMA_FILE_INGEST_FAILED",422);
  }
  throw Object.assign(fail("Luma is still ingesting the uploaded source file.","VIDEO_PROVIDER_POLL_DEFERRED",409),{retryable:true,retryAfterSeconds:10});
 }

 async function prepareAsset({ownerId,projectId=null,assetId,purpose="input"}={}){
  if(!["input","reference"].includes(purpose))throw fail("Luma file purpose must be input or reference.","LUMA_FILE_REQUEST_INVALID",400);
  const {asset,bytes}=await readPrivateAsset({ownerId,projectId,assetId});
  const identity={ownerId,projectId:projectId||null,assetId,mimeType:asset.mediaType,byteSize:asset.size,sha256:asset.sha256,purpose};
  const existing=await repository.getFileByAsset({assetId,ownerId,purpose});
  if(existing&&existing.state==="READY"&&existing.sha256===asset.sha256&&existing.byte_size===asset.size){
   const remote=await adapter.getFile(existing.provider_file_id);
   if(remote.state==="ready")return Object.freeze({fileId:existing.provider_file_id,state:"ready",assetId,purpose});
  }
  const key=attemptKey(identity);
  const attempt=await repository.createAttempt({...identity,attemptKey:key,filename:safeFilename(asset.name)});
  if(attempt.state==="COMPLETED"){
   const saved=await repository.getFileByAsset({assetId,ownerId,purpose});
   if(saved?.state==="READY"&&saved.sha256===asset.sha256){
    const remote=await adapter.getFile(saved.provider_file_id);
    if(remote.state==="ready")return Object.freeze({fileId:saved.provider_file_id,state:"ready",assetId,purpose});
    throw fail("The durable Luma provider-file mapping is no longer ready; refusing to reuse a stale file ID.","LUMA_FILE_MAPPING_STALE",409);
   }
   throw fail("Completed Luma upload attempt is missing its durable provider-file mapping.","LUMA_FILE_MAPPING_MISSING",409);
  }
  if(attempt.state==="PROVIDER_CREATED")return inspectProviderFile(identity,attempt);
  if(attempt.state==="UPLOADING"||attempt.state==="OUTCOME_UNKNOWN"){
   await repository.updateAttempt({id:attempt.id,fromStates:[attempt.state],state:"QUARANTINED",patch:{last_error_code:"LUMA_FILE_UPLOAD_OUTCOME_UNKNOWN",reconciled_at:new Date(now()).toISOString()}});
   throw fail("A previous Luma upload has an unknown outcome and was quarantined to prevent duplicate provider files.","LUMA_FILE_RECOVERY_QUARANTINED",409);
  }
  if(attempt.state==="QUARANTINED")throw fail("Luma upload attempt requires manual reconciliation; duplicate upload is blocked.","LUMA_FILE_RECOVERY_QUARANTINED",409);
  if(attempt.state==="FAILED")throw fail("Previous Luma upload attempt failed; create a new source asset version before retrying.","LUMA_FILE_PREVIOUS_ATTEMPT_FAILED",409);
  if(attempt.state!=="PREPARED")throw fail("Luma upload attempt is in an unsupported state.","LUMA_FILE_ATTEMPT_STATE_INVALID",409);
  await repository.updateAttempt({id:attempt.id,fromStates:["PREPARED"],state:"UPLOADING"});
  let receipt=null;
  try{
   receipt=await adapter.createFileUpload({mimeType:asset.mediaType,sizeBytes:bytes.byteLength,filename:safeFilename(asset.name),purpose,userId:ownerId});
   await repository.updateAttempt({id:attempt.id,fromStates:["UPLOADING"],state:"PROVIDER_CREATED",patch:{provider_file_id:receipt.fileId,upload_expires_at:receipt.upload.expiresAt}});
   await adapter.uploadFileBytes({upload:receipt.upload,bytes,mimeType:asset.mediaType});
   await adapter.completeFileUpload(receipt.fileId);
   const afterUpload=await repository.updateAttempt({id:attempt.id,fromStates:["PROVIDER_CREATED"],state:"PROVIDER_CREATED",patch:{upload_completed_at:new Date(now()).toISOString(),last_error_code:null}});
   return inspectProviderFile(identity,afterUpload);
  }catch(error){
   if(error?.code==="VIDEO_PROVIDER_POLL_DEFERRED")throw error;
   const fromStates=receipt?["UPLOADING","PROVIDER_CREATED"]:["UPLOADING"];
   const outcomeUnknown=error?.code==="LUMA_FILE_UPLOAD_OUTCOME_UNKNOWN"||
    (!receipt&&(error?.code==="LUMA_VIDEO_TIMEOUT"||error?.name==="TypeError"));
   const target=outcomeUnknown?"OUTCOME_UNKNOWN":"FAILED";
   try{await repository.updateAttempt({id:attempt.id,fromStates,state:target,patch:{last_error_code:String(error?.code||"LUMA_FILE_UPLOAD_FAILED").slice(0,120)}});}catch{}
   if(receipt&&target==="FAILED"){
    try{await adapter.deleteFile(receipt.fileId);}catch{}
   }
   throw error;
  }
 }

 async function resolveInput(input,context={}){
  if(!plain(input))throw fail("Luma generation input must be an object.","LUMA_FILE_INPUT_INVALID",400);
  const ownerId=context?.job?.owner_id,projectId=context?.job?.project_id||null;
  if(typeof ownerId!=="string"||!UUID.test(ownerId))throw fail("Luma source media requires an authenticated internal owner.","LUMA_FILE_SCOPE_INVALID",403);
  if(Array.isArray(input.referenceAssetIds)&&input.referenceAssetIds.length>0)throw fail("Ray 3.2 does not accept a generic referenceAssetIds list; use startFrameAssetId, endFrameAssetId or keyframeAssetIds.","LUMA_FILE_REFERENCE_MODE_UNSUPPORTED",400);
  const resolved={...input};
  if(input.sourceVideoAssetId){
   const file=await prepareAsset({ownerId,projectId,assetId:input.sourceVideoAssetId,purpose:"input"});
   resolved.sourceVideo={file_id:file.fileId};
  }else if(plain(input.sourceVideo)&&input.sourceVideo.assetId){
   const file=await prepareAsset({ownerId,projectId,assetId:input.sourceVideo.assetId,purpose:"input"});
   resolved.sourceVideo={file_id:file.fileId};
  }else if(plain(input.sourceVideo)&&input.sourceVideo.file_id){
   throw fail("Caller-supplied Luma file IDs are not accepted; use an owner-scoped private asset ID.","LUMA_FILE_UNSCOPED_REFERENCE",403);
  }else if(plain(input.source)&&input.source.file_id){
   throw fail("Caller-supplied Luma file IDs are not accepted; use an owner-scoped private asset ID.","LUMA_FILE_UNSCOPED_REFERENCE",403);
  }else if(plain(input.source)&&input.source.assetId){
   const file=await prepareAsset({ownerId,projectId,assetId:input.source.assetId,purpose:"input"});
   resolved.sourceVideo={file_id:file.fileId};
  }
  if(input.startFrameAssetId){
   const file=await prepareAsset({ownerId,projectId,assetId:input.startFrameAssetId,purpose:"reference"});
   resolved.startFrame={file_id:file.fileId};
  }
  if(input.endFrameAssetId){
   const file=await prepareAsset({ownerId,projectId,assetId:input.endFrameAssetId,purpose:"reference"});
   resolved.endFrame={file_id:file.fileId};
  }
  if(Array.isArray(input.keyframeAssetIds)){
   if(input.keyframeAssetIds.length<1||input.keyframeAssetIds.length>64)throw fail("Luma keyframe assets must contain 1 to 64 images.","LUMA_FILE_INPUT_INVALID",400);
   const files=await Promise.all(input.keyframeAssetIds.map(assetId=>prepareAsset({ownerId,projectId,assetId,purpose:"reference"})));
   resolved.keyframes=files.map(file=>({file_id:file.fileId}));
  }
  for(const field of ["startFrame","endFrame"]){
   if(plain(input[field])&&input[field].file_id)throw fail("Caller-supplied Luma file IDs are not accepted; use an owner-scoped private asset ID.","LUMA_FILE_UNSCOPED_REFERENCE",403);
  }
  if(Array.isArray(input.keyframes)&&input.keyframes.some(frame=>plain(frame)&&frame.file_id))throw fail("Caller-supplied Luma file IDs are not accepted; use owner-scoped private asset IDs.","LUMA_FILE_UNSCOPED_REFERENCE",403);
  return resolved;
 }

 async function deleteAsset({ownerId,assetId,purpose="input"}={}){
  const record=await repository.getFileByAsset({ownerId,assetId,purpose});
  if(!record)return {deleted:false,reason:"not_found"};
  if(record.state==="DELETED")return {deleted:true,fileId:record.provider_file_id};
  await adapter.deleteFile(record.provider_file_id);
  await repository.upsertFile({ownerId,projectId:record.project_id||null,assetId,mimeType:record.mime_type,byteSize:Number(record.byte_size),sha256:record.sha256,purpose,providerFileId:record.provider_file_id,state:"DELETED",deletedAt:new Date(now()).toISOString()});
  return {deleted:true,fileId:record.provider_file_id};
 }

 return Object.freeze({prepareAsset,resolveInput,deleteAsset});
}
