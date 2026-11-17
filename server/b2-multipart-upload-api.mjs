import { randomUUID } from "node:crypto";
import { buildCloudAssetObjectPath } from "./cloud-storage.mjs";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256=/^[a-f0-9]{64}$/i;
const MEDIA=new Set(["image/jpeg","image/png","image/webp","image/gif","video/mp4","video/webm","video/quicktime","video/x-matroska","audio/mpeg","audio/wav","audio/x-wav","audio/mp4","audio/ogg","application/pdf","text/plain","text/vtt","application/json"]);
const MIN_PART=5_000_000;
const DEFAULT_PART=64*1024*1024;

function fail(status,code,message){return {status,body:{error:{code,message}}};}
function validUuid(value){return typeof value==="string"&&UUID.test(value);}
function safeName(value){return String(value||"upload").normalize("NFKC").replace(/[\\/\u0000-\u001f\u007f]/g,"_").replace(/[^\p{L}\p{N}._() -]/gu,"_").trim().slice(0,180)||"upload";}

export function createB2MultipartUploadApi({storage,store,assets,authorize,maxBytes=1024*1024*1024,partSize=DEFAULT_PART,clock=()=>new Date(),signedUrlTtlSeconds=300}={}){
 if(!storage||typeof storage.beginMultipartUpload!=="function"||typeof storage.remove!=="function"||typeof storage.createMultipartPartSignedUrl!=="function"||typeof storage.listMultipartParts!=="function"||typeof storage.completeMultipartUpload!=="function"||typeof storage.abortMultipartUpload!=="function"||typeof storage.verifyObject!=="function")throw new Error("B2 multipart API requires the complete private storage adapter.");
 if(!store||!["create","findByIdempotencyKey","get","recordPart","listParts","claimCompletion","markCompleted","markAborted"].every(k=>typeof store[k]==="function"))throw new Error("B2 multipart API requires the durable session ledger.");
 if(!assets||typeof assets.registerVerifiedObject!=="function"||typeof assets.getStorageUsage!=="function")throw new Error("B2 multipart API requires verified Asset Library registration and quota checks.");
 if(typeof authorize!=="function")throw new Error("B2 multipart API requires project authorization.");
 if(!Number.isSafeInteger(maxBytes)||maxBytes<MIN_PART||maxBytes>1024*1024*1024)throw new Error("B2 multipart maximum size is invalid.");
 if(!Number.isSafeInteger(partSize)||partSize<MIN_PART||partSize>5*1024*1024*1024)throw new Error("B2 multipart part size is invalid.");
 if(!Number.isInteger(signedUrlTtlSeconds)||signedUrlTtlSeconds<30||signedUrlTtlSeconds>900)throw new Error("B2 multipart signed URL lifetime is invalid.");

 async function permitted(ownerId,projectId,action){
  const result=await authorize({ownerId,projectId,action});
  if(result!==true)throw Object.assign(new Error("Project access denied."),{code:"CLOUD_ASSET_ACCESS_DENIED"});
 }
 async function ownedSession(ownerId,sessionId,action="write"){
  if(!validUuid(sessionId))return {error:fail(400,"B2_MULTIPART_SESSION_ID_INVALID","Upload session ID is invalid.")};
  try{
   const session=await store.get({ownerId,sessionId});
   if(!session)return {error:fail(404,"B2_MULTIPART_SESSION_NOT_FOUND","Upload session was not found.")};
   await permitted(ownerId,session.projectId,action);
   return {session};
  }catch(error){return {error:fail(statusFor(error),error.code||"B2_MULTIPART_SESSION_LOOKUP_FAILED","Upload session could not be accessed.")};}
 }
 function publicSession(session){
  if(!session)return null;
  return {
   id:session.id,assetId:session.assetId,projectId:session.projectId||null,
   originalName:session.originalName,mediaType:session.mediaType,size:session.size,
   sha256:session.sha256,partSize:session.partSize,partCount:session.partCount,
   status:session.status,expiresAt:session.expiresAt,createdAt:session.createdAt,updatedAt:session.updatedAt,
   parts:Array.isArray(session.parts)?session.parts.map(part=>({partNumber:part.partNumber,etag:part.etag,sha256:part.sha256,size:part.size,recordedAt:part.recordedAt})):undefined
  };
 }
 function statusFor(error){
  const code=error?.code||"B2_MULTIPART_UPLOAD_FAILED";
  if(code==="CLOUD_ASSET_ACCESS_DENIED")return 403;
  if(code==="B2_MULTIPART_SESSION_NOT_FOUND")return 404;
  if(code==="B2_MULTIPART_IDEMPOTENCY_CONFLICT"||code==="B2_MULTIPART_PART_CONFLICT")return 409;
  if(code==="B2_MULTIPART_SESSION_NOT_ACTIVE"||code==="CLOUD_ASSET_STORAGE_QUOTA_EXCEEDED")return 409;
  if(code==="B2_STORAGE_TIMEOUT"||code==="B2_MULTIPART_LEDGER_TIMEOUT")return 503;
  return 502;
 }
 async function start({ownerId,body={},idempotencyKey}){
  if(!validUuid(ownerId))return fail(401,"AUTH_REQUIRED","A verified user session is required.");
  const projectId=body.projectId?String(body.projectId):null;
  if(projectId&&!validUuid(projectId))return fail(400,"PROJECT_ID_INVALID","Project ID must be a UUID.");
  const size=Number(body.size),mediaType=String(body.mediaType||""),sha256=String(body.sha256||"").toLowerCase();
  if(!Number.isSafeInteger(size)||size<MIN_PART||size>maxBytes)return fail(400,"B2_MULTIPART_SIZE_INVALID","Multipart uploads must be at least 5 MB and within the configured upload limit.");
  if(!MEDIA.has(mediaType))return fail(415,"UNSUPPORTED_MEDIA_TYPE","This media type is not supported.");
  if(!SHA256.test(sha256))return fail(400,"B2_MULTIPART_SHA256_INVALID","A valid source SHA-256 checksum is required.");
  if(typeof idempotencyKey!=="string"||idempotencyKey.trim().length<8||idempotencyKey.length>200)return fail(400,"IDEMPOTENCY_KEY_REQUIRED","Provide an idempotency key between 8 and 200 characters.");
  const chosenPartSize=Math.max(MIN_PART,partSize,Math.ceil(size/10000));
  const partCount=Math.ceil(size/chosenPartSize);
  if(partCount>10000)return fail(400,"B2_MULTIPART_PART_COUNT_INVALID","Upload requires too many parts.");
  try{
   await permitted(ownerId,projectId,"write");
   const existing=await store.findByIdempotencyKey({ownerId,idempotencyKey});
   if(existing){
    const matches=existing.projectId===projectId&&existing.size===size&&existing.sha256===sha256&&existing.mediaType===mediaType&&existing.originalName===safeName(body.originalName)&&existing.partSize===chosenPartSize;
    if(!matches)return fail(409,"B2_MULTIPART_IDEMPOTENCY_CONFLICT","This idempotency key is already bound to different upload data.");
    return {status:200,body:{session:publicSession(existing),idempotentReplay:true}};
   }
   const usage=await assets.getStorageUsage({ownerId});
   if(!usage||!Number.isSafeInteger(usage.remainingOwnerBytes)||!Number.isSafeInteger(usage.remainingTotalBytes))throw Object.assign(new Error("Private asset storage quota could not be verified."),{code:"CLOUD_ASSET_STORAGE_QUOTA_UNAVAILABLE"});
   if(size>usage.remainingOwnerBytes||size>usage.remainingTotalBytes)return fail(409,"CLOUD_ASSET_STORAGE_QUOTA_EXCEEDED","This upload exceeds the remaining private storage quota.");
   const assetId=randomUUID(),objectPath=buildCloudAssetObjectPath({ownerId,projectId,assetId,filename:"original."+({"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif","video/mp4":"mp4","video/webm":"webm","video/quicktime":"mov","video/x-matroska":"mkv","audio/mpeg":"mp3","audio/wav":"wav","audio/x-wav":"wav","audio/mp4":"m4a","audio/ogg":"ogg","application/pdf":"pdf","text/plain":"txt","text/vtt":"vtt","application/json":"json"})[mediaType]});
   const begun=await storage.beginMultipartUpload(objectPath,mediaType);
   try{
    const session=await store.create({ownerId,projectId,assetId,objectPath,idempotencyKey,uploadId:begun.uploadId,originalName:safeName(body.originalName),mediaType,size,sha256,partSize:chosenPartSize,expiresAt:new Date(clock().getTime()+24*60*60*1000).toISOString()});
    return {status:201,body:{session:publicSession(session),idempotentReplay:false}};
   }catch(error){await storage.abortMultipartUpload(objectPath,begun.uploadId).catch(()=>{});throw error;}
  }catch(error){return fail(statusFor(error),error.code||"B2_MULTIPART_START_FAILED",error.message||"Multipart upload could not be started.");}
 }
 async function partUrl({ownerId,sessionId,partNumber}){
  const owned=await ownedSession(ownerId,sessionId);if(owned.error)return owned.error;
  const {session}=owned;
  if(session.status!=="active"||new Date(session.expiresAt)<=clock())return fail(409,"B2_MULTIPART_SESSION_NOT_ACTIVE","This upload session is no longer active.");
  if(!Number.isInteger(partNumber)||partNumber<1||partNumber>session.partCount)return fail(400,"B2_MULTIPART_PART_INVALID","Part number is outside this upload session.");
  try{
   const url=await storage.createMultipartPartSignedUrl(session.objectPath,session.uploadId,partNumber,signedUrlTtlSeconds);
   const start=(partNumber-1)*session.partSize,size=Math.min(session.partSize,session.size-start);
   return {status:200,body:{url,method:"PUT",partNumber,size,expiresInSeconds:signedUrlTtlSeconds,requiredHeaders:{},sessionId}};
  }catch(error){return fail(statusFor(error),error.code||"B2_MULTIPART_PART_URL_FAILED","A part upload URL could not be created.");}
 }
 async function recordPart({ownerId,sessionId,partNumber,body={}}){
  const owned=await ownedSession(ownerId,sessionId);if(owned.error)return owned.error;
  const {session}=owned;
  if(session.status!=="active"||new Date(session.expiresAt)<=clock())return fail(409,"B2_MULTIPART_SESSION_NOT_ACTIVE","This upload session is no longer active.");
  const expectedSize=Math.min(session.partSize,session.size-(partNumber-1)*session.partSize);
  const etag=String(body.etag||"").replace(/^"|"$/g,"");
  if(!Number.isInteger(partNumber)||partNumber<1||partNumber>session.partCount||!Number.isSafeInteger(body.size)||body.size!==expectedSize||!SHA256.test(String(body.sha256||""))||!/^[A-Fa-f0-9-]{8,128}$/.test(etag))return fail(400,"B2_MULTIPART_PART_RECEIPT_INVALID","Part number, size, checksum or ETag is invalid.");
  try{
   const receipt=await store.recordPart({ownerId,sessionId,partNumber,etag,sha256:String(body.sha256).toLowerCase(),size:body.size});
   return {status:200,body:{part:receipt}};
  }catch(error){return fail(statusFor(error),error.code||"B2_MULTIPART_PART_RECORD_FAILED","Part receipt could not be recorded.");}
 }
 async function getSession({ownerId,sessionId}){
  const owned=await ownedSession(ownerId,sessionId,"read");if(owned.error)return owned.error;
  return {status:200,body:{session:publicSession(owned.session)}};
 }
 async function complete({ownerId,sessionId}){
  const owned=await ownedSession(ownerId,sessionId);if(owned.error)return owned.error;
  const {session}=owned;
  if(session.status==="completed")return {status:200,body:{session:publicSession(session),assetId:session.assetId,idempotentReplay:true}};
  const claim=await store.claimCompletion({ownerId,sessionId});
  if(!claim.claimed)return fail(claim.reason==="parts_incomplete"?409:claim.reason==="not_found"?404:409,"B2_MULTIPART_COMPLETION_NOT_CLAIMED","Upload completion could not be claimed: "+claim.reason+".");
  try{
   let verified;
   try{verified=await storage.verifyObject(session.objectPath,{expectedSize:session.size,expectedSha256:session.sha256,contentType:session.mediaType});}
   catch{
    const provider=await storage.listMultipartParts(session.objectPath,session.uploadId);
    if(provider.truncated||provider.parts.length!==session.partCount)throw Object.assign(new Error("Provider parts do not match the upload reservation."),{code:"B2_MULTIPART_PROVIDER_PARTS_MISMATCH"});
    const recorded=await store.listParts({ownerId,sessionId});
    if(!recorded||recorded.parts.length!==session.partCount)throw Object.assign(new Error("Recorded part receipts are incomplete."),{code:"B2_MULTIPART_PARTS_INCOMPLETE"});
    const actual=[...provider.parts].sort((a,b)=>a.partNumber-b.partNumber);
    const expected=[...recorded.parts].sort((a,b)=>a.partNumber-b.partNumber);
    for(let i=0;i<expected.length;i++)if(actual[i].partNumber!==expected[i].partNumber||actual[i].etag!==expected[i].etag||actual[i].size!==expected[i].size)throw Object.assign(new Error("Provider part receipt differs from the recorded part."),{code:"B2_MULTIPART_PROVIDER_PARTS_MISMATCH"});
    await storage.completeMultipartUpload(session.objectPath,session.uploadId,expected.map(p=>({partNumber:p.partNumber,etag:p.etag})));
    verified=await storage.verifyObject(session.objectPath,{expectedSize:session.size,expectedSha256:session.sha256,contentType:session.mediaType});
   }
   let asset;
   try{
    asset=await assets.registerVerifiedObject({ownerId,projectId:session.projectId,assetId:session.assetId,originalName:session.originalName,mediaType:session.mediaType,size:session.size,sha256:session.sha256,metadata:{uploadProvider:"backblaze-b2",multipartSessionId:session.id},verifiedReceipt:verified});
   }catch(error){
    if(error?.code==="CLOUD_ASSET_STORAGE_QUOTA_EXCEEDED"){
     await storage.remove(session.objectPath);
     await store.markAborted({ownerId,sessionId});
    }
    throw error;
   }
   if(verified?.path!==session.objectPath||verified?.size!==session.size||verified?.sha256!==session.sha256)throw Object.assign(new Error("Verified object receipt does not match the upload session."),{code:"B2_MULTIPART_VERIFICATION_MISMATCH"});
   const marked=await store.markCompleted({ownerId,sessionId});
   if(!marked)throw Object.assign(new Error("Asset was published but the upload session completion state could not be committed."),{code:"B2_MULTIPART_FINALIZE_PENDING"});
   return {status:200,body:{session:publicSession({...session,status:"completed"}),asset,idempotentReplay:false}};
  }catch(error){return fail(statusFor(error),error.code||"B2_MULTIPART_COMPLETION_FAILED",error.message||"Multipart upload could not be completed.");}
 }
 async function abort({ownerId,sessionId}){
  const owned=await ownedSession(ownerId,sessionId);if(owned.error)return owned.error;
  const {session}=owned;
  if(["completed","aborted","expired"].includes(session.status))return {status:200,body:{session:publicSession(session),alreadyFinal:true}};
  try{
   await storage.abortMultipartUpload(session.objectPath,session.uploadId);
   const changed=await store.markAborted({ownerId,sessionId});
   if(!changed)return fail(409,"B2_MULTIPART_ABORT_STATE_CONFLICT","Provider upload was aborted but the session state changed concurrently.");
   return {status:200,body:{ok:true,status:"aborted"}};
  }catch(error){return fail(statusFor(error),error.code||"B2_MULTIPART_ABORT_FAILED","Multipart upload could not be aborted.");}
 }
 return Object.freeze({start,partUrl,recordPart,getSession,complete,abort});
}
