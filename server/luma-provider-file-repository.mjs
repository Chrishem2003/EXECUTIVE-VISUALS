const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(message,code,status)=>Object.assign(new Error(message),{code,status});
const plain=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);

export function createLumaProviderFileRepository({
 url=process.env.SUPABASE_URL,
 serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,
 fetchImpl=globalThis.fetch,
 timeoutMs=15000
}={}) {
 if(!url||!serviceRoleKey||typeof fetchImpl!=="function")throw new TypeError("Luma provider-file repository requires server-side Supabase credentials and fetch.");
 if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000)throw new TypeError("Luma provider-file repository timeout is invalid.");
 let base;
 try{const parsed=new URL(url);if(parsed.protocol!=="https:"&&!["localhost","127.0.0.1","[::1]"].includes(parsed.hostname))throw new Error();if(parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error();base=parsed.origin;}
 catch{throw new TypeError("Luma provider-file repository URL must be safe absolute HTTPS.");}

 async function request(path,{method="GET",body=null,prefer=null,allowConflict=false}={}) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const headers={apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,accept:"application/json","accept-profile":"executive_visuals","content-profile":"executive_visuals"};
   if(body!==null)headers["content-type"]="application/json";
   if(prefer)headers.prefer=prefer;
   const response=await fetchImpl(base+"/rest/v1/"+path,{method,headers,...(body===null?{}:{body:JSON.stringify(body)}),signal:controller.signal});
   const raw=await response.text();let data=null;
   if(raw){try{data=JSON.parse(raw);}catch{if(response.ok)throw fail("Luma provider-file database returned invalid JSON.","LUMA_FILE_DATABASE_RESPONSE_INVALID",502);}}
   if(!response.ok){
    if(allowConflict&&response.status===409)return null;
    throw fail("Luma provider-file database request failed (HTTP "+response.status+").","LUMA_FILE_DATABASE_HTTP_"+response.status,response.status);
   }
   return data;
  }catch(error){if(error?.name==="AbortError")throw fail("Luma provider-file database request timed out.","LUMA_FILE_DATABASE_TIMEOUT",504);throw error;}
  finally{clearTimeout(timer);}
 }
 function validIdentity(value){
  if(!plain(value)||!UUID.test(value.assetId||"")||!UUID.test(value.ownerId||"")||
    (value.projectId!==null&&value.projectId!==undefined&&!UUID.test(value.projectId))||
    !["input","reference"].includes(value.purpose)||typeof value.mimeType!=="string"||
    !Number.isSafeInteger(value.byteSize)||value.byteSize<1||value.byteSize>250*1024*1024||
    typeof value.sha256!=="string"||!/^[a-f0-9]{64}$/i.test(value.sha256))throw fail("Luma provider-file identity is invalid.","LUMA_FILE_IDENTITY_INVALID",400);
  return value;
 }
 const attemptSelect="id,attempt_key,asset_id,owner_id,project_id,purpose,mime_type,byte_size,sha256,filename,state,provider_file_id,upload_expires_at,upload_completed_at,attempt_count,last_error_code,created_at,updated_at,reconciled_at";
 const fileSelect="id,provider,provider_file_id,asset_id,owner_id,project_id,purpose,mime_type,byte_size,sha256,state,provider_expires_at,failure_code,uploaded_at,ready_at,deleted_at,created_at,updated_at";

 async function getAttemptByKey(attemptKey){
  const rows=await request("luma_provider_file_upload_attempts?select="+attemptSelect+"&attempt_key=eq."+encodeURIComponent(attemptKey)+"&limit=1");
  return Array.isArray(rows)?rows[0]||null:null;
 }
 async function createAttempt(value){
  validIdentity(value);
  if(typeof value.attemptKey!=="string"||!/^[a-f0-9]{64}$/i.test(value.attemptKey)||typeof value.filename!=="string"||!value.filename.trim()||value.filename.length>255)throw fail("Luma upload attempt key or filename is invalid.","LUMA_FILE_ATTEMPT_INVALID",400);
  const body={attempt_key:value.attemptKey,asset_id:value.assetId,owner_id:value.ownerId,project_id:value.projectId||null,purpose:value.purpose,mime_type:value.mimeType,byte_size:value.byteSize,sha256:value.sha256,filename:value.filename,state:"PREPARED",attempt_count:1};
  const rows=await request("luma_provider_file_upload_attempts?select="+attemptSelect,{method:"POST",prefer:"return=representation",body,allowConflict:true});
  const row=Array.isArray(rows)?rows[0]||null:null;
  const existing=row||await getAttemptByKey(value.attemptKey);
  if(!existing||existing.asset_id!==value.assetId||existing.owner_id!==value.ownerId||(existing.project_id||null)!==(value.projectId||null)||existing.purpose!==value.purpose||existing.mime_type!==value.mimeType||Number(existing.byte_size)!==value.byteSize||existing.sha256!==value.sha256)throw fail("Existing Luma upload attempt does not match the requested asset identity.","LUMA_FILE_ATTEMPT_CONFLICT",409);
  return existing;
 }
 async function updateAttempt({id,fromStates,state,patch={}}={}){
  if(!UUID.test(id||"")||!Array.isArray(fromStates)||!fromStates.length||fromStates.some(x=>typeof x!=="string")||typeof state!=="string")throw fail("Luma upload attempt transition is invalid.","LUMA_FILE_ATTEMPT_TRANSITION_INVALID",400);
  const allowed=new Set(["provider_file_id","upload_expires_at","upload_completed_at","last_error_code","attempt_count","reconciled_at"]);
  for(const key of Object.keys(patch))if(!allowed.has(key))throw fail("Luma upload attempt patch contains a forbidden field.","LUMA_FILE_ATTEMPT_PATCH_INVALID",400);
  const rows=await request("luma_provider_file_upload_attempts?select="+attemptSelect+"&id=eq."+encodeURIComponent(id)+"&state=in.("+fromStates.map(encodeURIComponent).join(",")+")",{method:"PATCH",prefer:"return=representation",body:{...patch,state,updated_at:new Date().toISOString()}});
  if(Array.isArray(rows)&&rows[0])return rows[0];
  const current=await request("luma_provider_file_upload_attempts?select="+attemptSelect+"&id=eq."+encodeURIComponent(id)+"&limit=1");
  const row=Array.isArray(current)?current[0]:null;
  if(row&&row.state===state&&Object.entries(patch).every(([key,value])=>row[key]===value))return row;
  throw fail("Luma upload attempt changed concurrently; refusing to overwrite recovery state.","LUMA_FILE_ATTEMPT_CONFLICT",409);
 }
 async function getFileByAsset({assetId,ownerId,purpose="input"}={}){
  if(!UUID.test(assetId||"")||!UUID.test(ownerId||"")||!["input","reference"].includes(purpose))throw fail("Luma provider-file lookup scope is invalid.","LUMA_FILE_LOOKUP_INVALID",400);
  const rows=await request("luma_provider_files?select="+fileSelect+"&provider=eq.luma-ray32&asset_id=eq."+encodeURIComponent(assetId)+"&owner_id=eq."+encodeURIComponent(ownerId)+"&purpose=eq."+purpose+"&limit=1");
  return Array.isArray(rows)?rows[0]||null:null;
 }
 async function upsertFile(value){
  validIdentity(value);
  if(!UUID.test(value.providerFileId||"")||!["PENDING","READY","FAILED","DELETED","EXPIRED","QUARANTINED"].includes(value.state))throw fail("Luma provider-file record is invalid.","LUMA_FILE_RECORD_INVALID",400);
  const body={provider:"luma-ray32",provider_file_id:value.providerFileId,asset_id:value.assetId,owner_id:value.ownerId,project_id:value.projectId||null,purpose:value.purpose,mime_type:value.mimeType,byte_size:value.byteSize,sha256:value.sha256,state:value.state,provider_expires_at:value.providerExpiresAt||null,failure_code:value.failureCode||null,uploaded_at:value.uploadedAt||null,ready_at:value.readyAt||null,deleted_at:value.deletedAt||null,updated_at:new Date().toISOString()};
  const rows=await request("luma_provider_files?on_conflict=provider,asset_id,owner_id,purpose&select="+fileSelect,{method:"POST",prefer:"resolution=merge-duplicates,return=representation",body});
  const row=Array.isArray(rows)?rows[0]||null:null;
  if(!row||row.provider_file_id!==value.providerFileId||row.asset_id!==value.assetId||row.owner_id!==value.ownerId||(row.project_id||null)!==(value.projectId||null)||row.sha256!==value.sha256||row.purpose!==value.purpose)throw fail("Luma provider-file upsert returned a mismatched record.","LUMA_FILE_RECORD_MISMATCH",502);
  return row;
 }
 async function listRecoverable({limit=20}={}){
  limit=Math.max(1,Math.min(100,Number.isInteger(limit)?limit:20));
  const rows=await request("luma_provider_file_upload_attempts?select="+attemptSelect+"&state=in.(UPLOADING,OUTCOME_UNKNOWN,PROVIDER_CREATED)&order=updated_at.asc&limit="+limit);
  return Array.isArray(rows)?rows:[];
 }
 return Object.freeze({createAttempt,getAttemptByKey,updateAttempt,getFileByAsset,upsertFile,listRecoverable});
}
