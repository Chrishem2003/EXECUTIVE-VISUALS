const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256=/^[a-f0-9]{64}$/i;
const ETAG=/^[A-Fa-f0-9-]{8,128}$/;

function validUuid(value,label){const text=String(value||"");if(!UUID.test(text))throw new TypeError("Multipart "+label+" must be a UUID.");return text;}
function validPath(value){
 if(typeof value!=="string"||value.length>1024||value.startsWith("/")||value.includes("\\")||value.split("/").length!==3)throw new TypeError("Multipart object path is invalid.");
 const parts=value.split("/");
 if(parts.some(part=>!part||part==="."||part===".."||!/^[A-Za-z0-9._-]{1,180}$/.test(part))||!UUID.test(parts[0])||!UUID.test(parts[1]))throw new TypeError("Multipart object path must use owner/project and asset UUID prefixes.");
 return value;
}
function normalizeSession(row){
 if(!row)return null;
 return {id:row.id,ownerId:row.owner_id,projectId:row.project_id||null,assetId:row.asset_id,idempotencyKey:row.idempotency_key,provider:row.storage_provider,bucket:row.storage_bucket,objectPath:row.object_path,uploadId:row.upload_id,originalName:row.original_name,mediaType:row.media_type,size:Number(row.byte_size),sha256:row.source_sha256,partSize:Number(row.part_size),partCount:Number(row.part_count),status:row.status,expiresAt:row.expires_at,createdAt:row.created_at,updatedAt:row.updated_at};
}

/**
 * Service-role-only durable ledger for B2 multipart uploads.
 * It stores opaque provider IDs and per-part receipts; callers must perform
 * project authorization before invoking this repository.
 */
export function createB2MultipartUploadStore({url=process.env.SUPABASE_URL,serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl=globalThis.fetch,timeoutMs=12000,completionLeaseMs=5*60*1000,clock=()=>new Date()}={}){
 if(!url||!serviceRoleKey)throw new Error("B2 multipart ledger requires Supabase service credentials.");
 if(typeof fetchImpl!=="function")throw new Error("B2 multipart ledger requires fetch.");
 if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000)throw new Error("B2 multipart ledger timeout is invalid.");
 if(typeof clock!=="function")throw new Error("B2 multipart ledger clock must be a function.");
 if(!Number.isInteger(completionLeaseMs)||completionLeaseMs<30_000||completionLeaseMs>60*60*1000)throw new Error("B2 multipart completion lease must be between 30 seconds and one hour.");
 let base;try{const parsed=new URL(url);if(parsed.protocol!=="https:"&&!["localhost","127.0.0.1","[::1]"].includes(parsed.hostname))throw new Error();if(parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error();base=parsed.origin;}catch{throw new Error("B2 multipart ledger URL must be safe HTTPS.");}
 async function request(path,{method="GET",body=null,prefer=null}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const headers={apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,"accept-profile":"executive_visuals","content-profile":"executive_visuals"};
   if(body!==null)headers["content-type"]="application/json";if(prefer)headers.prefer=prefer;
   const response=await fetchImpl(base+"/rest/v1/"+path,{method,headers,...(body===null?{}:{body:JSON.stringify(body)}),signal:controller.signal});
   const raw=await response.text();let data=null;if(raw){try{data=JSON.parse(raw);}catch{if(response.ok)throw new Error("Multipart ledger returned invalid JSON.");}}
   if(!response.ok){const error=new Error("Multipart ledger request failed (HTTP "+response.status+").");error.code="B2_MULTIPART_LEDGER_HTTP_"+response.status;error.status=response.status;throw error;}
   return data;
  }catch(error){if(error?.name==="AbortError"){const timeout=new Error("Multipart ledger request timed out.");timeout.code="B2_MULTIPART_LEDGER_TIMEOUT";throw timeout;}throw error;}
  finally{clearTimeout(timer);}
 }
 async function getRaw(ownerId,sessionId){
  const rows=await request("asset_multipart_upload_sessions?select=*&owner_id=eq."+encodeURIComponent(ownerId)+"&id=eq."+encodeURIComponent(sessionId)+"&limit=1");
  return Array.isArray(rows)?rows[0]||null:null;
 }
 async function getParts(sessionId){
  const rows=await request("asset_multipart_upload_parts?select=part_number,etag,sha256,byte_size,recorded_at&session_id=eq."+encodeURIComponent(sessionId)+"&order=part_number.asc&limit=10000");
  return (Array.isArray(rows)?rows:[]).map(row=>({partNumber:Number(row.part_number),etag:row.etag,sha256:row.sha256,size:Number(row.byte_size),recordedAt:row.recorded_at}));
 }
 return Object.freeze({
  async create(input={}){
   const ownerId=validUuid(input.ownerId,"owner ID"),projectId=input.projectId?validUuid(input.projectId,"project ID"):null,assetId=validUuid(input.assetId,"asset ID");
   const objectPath=validPath(input.objectPath);
   const pathParts=objectPath.split("/");
   if(pathParts[0]!== (projectId||ownerId) || pathParts[1]!==assetId)throw new TypeError("Multipart object path must be bound to the verified owner/project and reserved asset ID.");
   if(!input.idempotencyKey||String(input.idempotencyKey).length>200)throw new TypeError("Multipart idempotency key is invalid.");
   if(!/^[\x21-\x7E]{8,512}$/.test(String(input.uploadId||"")))throw new TypeError("B2 multipart upload ID is invalid.");
   if(!SHA256.test(String(input.sha256||"")))throw new TypeError("Multipart source SHA-256 is invalid.");
   if(!Number.isSafeInteger(input.size)||input.size<1||!Number.isSafeInteger(input.partSize)||input.partSize<5000000||input.partSize>5368709120)throw new TypeError("Multipart source or part size is invalid.");
   const partCount=Math.ceil(input.size/input.partSize);if(partCount<1||partCount>10000)throw new TypeError("Multipart part count is invalid.");
   const expiresAt=new Date(input.expiresAt||clock().getTime()+24*60*60*1000);if(!Number.isFinite(expiresAt.getTime())||expiresAt<=clock())throw new TypeError("Multipart expiry must be in the future.");
   const row={owner_id:ownerId,project_id:projectId,asset_id:assetId,idempotency_key:String(input.idempotencyKey),storage_provider:"backblaze-b2",storage_bucket:"executive-visuals-media",object_path:objectPath,upload_id:String(input.uploadId),original_name:String(input.originalName||"upload").slice(0,180),media_type:String(input.mediaType||"application/octet-stream").slice(0,128),byte_size:input.size,source_sha256:String(input.sha256).toLowerCase(),part_size:input.partSize,part_count:partCount,status:"active",expires_at:expiresAt.toISOString()};
   const created=await request("asset_multipart_upload_sessions?on_conflict=owner_id,idempotency_key",{method:"POST",body:row,prefer:"resolution=ignore-duplicates,return=representation"});
   const saved=Array.isArray(created)?created[0]:null;
   const existing=saved||await (async()=>{const rows=await request("asset_multipart_upload_sessions?select=*&owner_id=eq."+encodeURIComponent(ownerId)+"&idempotency_key=eq."+encodeURIComponent(row.idempotency_key)+"&limit=1");return Array.isArray(rows)?rows[0]||null:null;})();
   if(!existing)throw new Error("Multipart session could not be persisted.");
   for(const key of ["asset_id","project_id","object_path","upload_id","original_name","media_type","source_sha256","byte_size","part_size","part_count","storage_bucket","storage_provider"])if((existing[key]??null)!==(row[key]??null))throw Object.assign(new Error("Multipart idempotency key is already bound to different upload data."),{code:"B2_MULTIPART_IDEMPOTENCY_CONFLICT"});
   return normalizeSession(existing);
  },
  async findByIdempotencyKey({ownerId,idempotencyKey}={}){
   ownerId=validUuid(ownerId,"owner ID");
   const key=String(idempotencyKey||"");
   if(!key||key.length>200)throw new TypeError("Multipart idempotency key is invalid.");
   const rows=await request("asset_multipart_upload_sessions?select=*&owner_id=eq."+encodeURIComponent(ownerId)+"&idempotency_key=eq."+encodeURIComponent(key)+"&limit=1");
   const row=Array.isArray(rows)?rows[0]||null:null;
   return row?{...normalizeSession(row),parts:await getParts(row.id)}:null;
  },
  async get({ownerId,sessionId}={}){
   ownerId=validUuid(ownerId,"owner ID");sessionId=validUuid(sessionId,"session ID");
   const row=await getRaw(ownerId,sessionId);return row?{...normalizeSession(row),parts:await getParts(sessionId)}:null;
  },
  async recordPart({ownerId,sessionId,partNumber,etag,sha256,size}={}){
   ownerId=validUuid(ownerId,"owner ID");sessionId=validUuid(sessionId,"session ID");
   if(!Number.isInteger(partNumber)||partNumber<1||partNumber>10000||!ETAG.test(String(etag||""))||!SHA256.test(String(sha256||""))||!Number.isSafeInteger(size)||size<1)throw new TypeError("Multipart part receipt is invalid.");
   const session=await getRaw(ownerId,sessionId);if(!session)throw Object.assign(new Error("Multipart upload session not found."),{code:"B2_MULTIPART_SESSION_NOT_FOUND"});
   if(session.status!=="active"||new Date(session.expires_at)<=clock())throw Object.assign(new Error("Multipart upload session is not active."),{code:"B2_MULTIPART_SESSION_NOT_ACTIVE"});
   if(partNumber>Number(session.part_count))throw new TypeError("Multipart part number exceeds the session part count.");
   const expectedSize=partNumber===Number(session.part_count)?Number(session.byte_size)-(partNumber-1)*Number(session.part_size):Number(session.part_size);
   if(size!==expectedSize)throw new TypeError("Multipart part byte size does not match the declared source layout.");
   const row={session_id:sessionId,part_number:partNumber,etag:String(etag),sha256:String(sha256).toLowerCase(),byte_size:size};
   const inserted=await request("asset_multipart_upload_parts?on_conflict=session_id,part_number",{method:"POST",body:row,prefer:"resolution=ignore-duplicates,return=representation"});
   const saved=Array.isArray(inserted)?inserted[0]:null;
   const existing=saved||await (async()=>{const rows=await request("asset_multipart_upload_parts?select=*&session_id=eq."+encodeURIComponent(sessionId)+"&part_number=eq."+partNumber+"&limit=1");return Array.isArray(rows)?rows[0]||null:null;})();
   if(!existing||existing.etag!==row.etag||existing.sha256!==row.sha256||Number(existing.byte_size)!==row.byte_size)throw Object.assign(new Error("Multipart part number is already recorded with different bytes."),{code:"B2_MULTIPART_PART_CONFLICT"});
   return {partNumber,etag:existing.etag,sha256:existing.sha256,size:Number(existing.byte_size)};
  },
  async listParts({ownerId,sessionId}={}){
   ownerId=validUuid(ownerId,"owner ID");sessionId=validUuid(sessionId,"session ID");
   const session=await getRaw(ownerId,sessionId);if(!session)return null;
   return {session:normalizeSession(session),parts:await getParts(sessionId)};
  },
  async claimCompletion({ownerId,sessionId}={}){
   ownerId=validUuid(ownerId,"owner ID");sessionId=validUuid(sessionId,"session ID");
   const session=await getRaw(ownerId,sessionId);if(!session)return {claimed:false,reason:"not_found"};
   const now=clock(),nowIso=now.toISOString();
   if(session.status==="completing"){
    const claimedAt=Date.parse(session.completion_claimed_at||"");
    if(!Number.isFinite(claimedAt)||now.getTime()-claimedAt<completionLeaseMs)return {claimed:false,reason:"already_completing"};
    const reclaimed=await request("asset_multipart_upload_sessions?id=eq."+encodeURIComponent(sessionId)+"&owner_id=eq."+encodeURIComponent(ownerId)+"&status=eq.completing&completion_claimed_at=eq."+encodeURIComponent(session.completion_claimed_at),{method:"PATCH",body:{completion_claimed_at:nowIso,updated_at:nowIso},prefer:"return=representation"});
    return {claimed:Array.isArray(reclaimed)&&reclaimed.length===1,reason:Array.isArray(reclaimed)&&reclaimed.length===1?"reclaimed_stale_completion":"claim_race"};
   }
   if(session.status!=="active"||new Date(session.expires_at)<=now)return {claimed:false,reason:"not_active"};
   const parts=await getParts(sessionId);
   if(parts.length!==Number(session.part_count)||parts.some((part,index)=>part.partNumber!==index+1))return {claimed:false,reason:"parts_incomplete",received:parts.length,expected:Number(session.part_count)};
   const changed=await request("asset_multipart_upload_sessions?id=eq."+encodeURIComponent(sessionId)+"&owner_id=eq."+encodeURIComponent(ownerId)+"&status=eq.active",{method:"PATCH",body:{status:"completing",completion_claimed_at:nowIso,updated_at:nowIso},prefer:"return=representation"});
   return {claimed:Array.isArray(changed)&&changed.length===1,reason:Array.isArray(changed)&&changed.length===1?"claimed":"claim_race"};
  },
  async markCompleted({ownerId,sessionId}={}){
   ownerId=validUuid(ownerId,"owner ID");sessionId=validUuid(sessionId,"session ID");
   const changed=await request("asset_multipart_upload_sessions?id=eq."+encodeURIComponent(sessionId)+"&owner_id=eq."+encodeURIComponent(ownerId)+"&status=eq.completing",{method:"PATCH",body:{status:"completed",completed_at:clock().toISOString(),updated_at:clock().toISOString()},prefer:"return=representation"});
   return Array.isArray(changed)&&changed.length===1;
  },
  async markAborted({ownerId,sessionId,expired=false}={}){
   ownerId=validUuid(ownerId,"owner ID");sessionId=validUuid(sessionId,"session ID");
   const status=expired?"expired":"aborted",now=clock().toISOString();
   const changed=await request("asset_multipart_upload_sessions?id=eq."+encodeURIComponent(sessionId)+"&owner_id=eq."+encodeURIComponent(ownerId)+"&status=in.(active,completing)",{method:"PATCH",body:{status,aborted_at:now,updated_at:now},prefer:"return=representation"});
   return Array.isArray(changed)&&changed.length===1;
  }
 });
}
