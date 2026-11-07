import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(message,code)=>Object.assign(new Error(message),{code});
const SESSION_PREFIX="gdrive-session:v1:";

export function createGoogleDriveExportAttemptStore({
  url=process.env.SUPABASE_URL,
  serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,
  encryptionKey=process.env.GOOGLE_DRIVE_EXPORT_SESSION_ENCRYPTION_KEY,
  fetchImpl=globalThis.fetch,
  timeoutMs=10000
}={}){
  let base;
  try{
    const parsed=new URL(String(url||""));
    const loopback=["localhost","127.0.0.1","[::1]"].includes(parsed.hostname);
    if((parsed.protocol!=="https:"&&!(loopback&&parsed.protocol==="http:"))||parsed.username||parsed.password||parsed.search||parsed.hash||parsed.pathname!=="/")throw new Error();
    base=parsed.origin;
  }catch{throw fail("Google Drive export store requires a safe Supabase URL.","GOOGLE_DRIVE_EXPORT_STORE_CONFIG_INVALID");}
  if(typeof serviceRoleKey!=="string"||serviceRoleKey.length<20||typeof encryptionKey!=="string"||encryptionKey.length<32||
    typeof fetchImpl!=="function"||!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>60000){
    throw fail("Google Drive export store configuration is invalid.","GOOGLE_DRIVE_EXPORT_STORE_CONFIG_INVALID");
  }
  const key=createHash("sha256").update(encryptionKey,"utf8").digest();
  function seal(uri){
    let parsed;
    try{parsed=new URL(uri);}catch{throw fail("Drive upload session URI is invalid.","GOOGLE_DRIVE_EXPORT_SESSION_INVALID");}
    if(parsed.protocol!=="https:"||!["www.googleapis.com","upload.googleapis.com"].includes(parsed.hostname)||
      parsed.pathname!=="/upload/drive/v3/files"||!parsed.searchParams.has("upload_id")||parsed.username||parsed.password||parsed.hash||(parsed.port&&parsed.port!=="443")){
      throw fail("Drive upload session URI is outside the approved Google API origin.","GOOGLE_DRIVE_EXPORT_SESSION_INVALID");
    }
    const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,iv);
    const ciphertext=Buffer.concat([cipher.update(parsed.toString(),"utf8"),cipher.final()]);
    return SESSION_PREFIX+[iv.toString("base64url"),cipher.getAuthTag().toString("base64url"),ciphertext.toString("base64url")].join(".");
  }
  function open(value){
    try{
      if(typeof value!=="string"||!value.startsWith(SESSION_PREFIX))throw new Error();
      const fields=value.slice(SESSION_PREFIX.length).split(".");
      if(fields.length!==3)throw new Error();
      const iv=Buffer.from(fields[0],"base64url"),tag=Buffer.from(fields[1],"base64url"),data=Buffer.from(fields[2],"base64url");
      if(iv.length!==12||tag.length!==16||data.length>8192)throw new Error();
      const decipher=createDecipheriv("aes-256-gcm",key,iv);decipher.setAuthTag(tag);
      const uri=Buffer.concat([decipher.update(data),decipher.final()]).toString("utf8");
      const parsed=new URL(uri);
      if(parsed.protocol!=="https:"||!["www.googleapis.com","upload.googleapis.com"].includes(parsed.hostname)||
        parsed.pathname!=="/upload/drive/v3/files"||!parsed.searchParams.has("upload_id")||(parsed.port&&parsed.port!=="443"))throw new Error();
      return uri;
    }catch{throw fail("Stored Drive upload session could not be safely decrypted.","GOOGLE_DRIVE_EXPORT_SESSION_STORE_INVALID");}
  }
  async function request(query,{method="GET",body,prefer}={}){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      let response;
      try{
        response=await fetchImpl(base+"/rest/v1/google_drive_export_attempts?"+query,{
          method,headers:{apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,
            "accept-profile":"executive_visuals","content-profile":"executive_visuals",accept:"application/json",
            ...(body===undefined?{}:{"content-type":"application/json"}),...(prefer?{prefer}:{})},
          ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal,redirect:"error"
        });
      }catch(error){throw fail(error?.name==="AbortError"?"Drive export store timed out.":"Drive export store is unavailable.",
        error?.name==="AbortError"?"GOOGLE_DRIVE_EXPORT_STORE_TIMEOUT":"GOOGLE_DRIVE_EXPORT_STORE_UNAVAILABLE");}
      const raw=await response.text();
      if(Buffer.byteLength(raw,"utf8")>256*1024)throw fail("Drive export store response is oversized.","GOOGLE_DRIVE_EXPORT_STORE_RESPONSE_INVALID");
      let rows=[];
      if(raw){try{rows=JSON.parse(raw);}catch{throw fail("Drive export store returned invalid JSON.","GOOGLE_DRIVE_EXPORT_STORE_RESPONSE_INVALID");}}
      if(!response.ok)throw fail("Drive export store rejected the operation (HTTP "+response.status+").","GOOGLE_DRIVE_EXPORT_STORE_FAILED");
      if(!Array.isArray(rows))throw fail("Drive export store returned an invalid row set.","GOOGLE_DRIVE_EXPORT_STORE_RESPONSE_INVALID");
      return rows;
    }finally{clearTimeout(timer);}
  }
  const owner=value=>{if(typeof value!=="string"||!UUID.test(value))throw fail("Drive export owner ID is invalid.","GOOGLE_DRIVE_EXPORT_SCOPE_INVALID");return value;};
  function map(row){
    if(!row||typeof row.attempt_key!=="string"||!/^[a-f0-9]{64}$/.test(row.attempt_key)||
      typeof row.owner_id!=="string"||!UUID.test(row.owner_id)||typeof row.asset_id!=="string"||!UUID.test(row.asset_id)||
      typeof row.drive_file_id!=="string"||!/^[-_A-Za-z0-9]{10,200}$/.test(row.drive_file_id)||
      (row.project_id!==null&&row.project_id!==undefined&&!UUID.test(row.project_id))||
      (row.parent_folder_id!==null&&row.parent_folder_id!==undefined&&!/^[-_A-Za-z0-9]{10,200}$/.test(row.parent_folder_id))||
      typeof row.mime_type!=="string"||!Number.isSafeInteger(Number(row.byte_size))||Number(row.byte_size)<1||
      typeof row.sha256!=="string"||!/^[a-f0-9]{64}$/.test(row.sha256)||
      (row.lease_token!==null&&row.lease_token!==undefined&&!UUID.test(row.lease_token))||
      (row.lease_expires_at!==null&&row.lease_expires_at!==undefined&&!Number.isFinite(Date.parse(row.lease_expires_at)))||
      ((row.lease_token===null||row.lease_token===undefined)!==(row.lease_expires_at===null||row.lease_expires_at===undefined))||
      !Number.isSafeInteger(Number(row.attempt_count))||Number(row.attempt_count)<1||
      (row.state==="COMPLETED"&&(row.lease_token||row.lease_expires_at||row.encrypted_session_uri))||
      !["PREPARED","UPLOADING","OUTCOME_UNKNOWN","COMPLETED","RECONCILIATION_REQUIRED","FAILED"].includes(row.state)){
      throw fail("Drive export attempt failed validation.","GOOGLE_DRIVE_EXPORT_STORE_RESPONSE_INVALID");
    }
    return Object.freeze({attemptKey:row.attempt_key,ownerId:row.owner_id,projectId:row.project_id||null,assetId:row.asset_id,
      parentFolderId:row.parent_folder_id||null,driveFileId:row.drive_file_id,mimeType:row.mime_type,byteSize:Number(row.byte_size),
      sha256:row.sha256,state:row.state,sessionUri:row.encrypted_session_uri?open(row.encrypted_session_uri):null,
      webViewLink:row.drive_web_view_link||null,leaseToken:row.lease_token||null,leaseExpiresAt:row.lease_expires_at||null,attemptCount:Number(row.attempt_count),updatedAt:row.updated_at});
  }
  async function get(attemptKey,ownerId){
    ownerId=owner(ownerId);
    if(typeof attemptKey!=="string"||!/^[a-f0-9]{64}$/.test(attemptKey))throw fail("Drive export attempt key is invalid.","GOOGLE_DRIVE_EXPORT_ATTEMPT_INVALID");
    const rows=await request("attempt_key=eq."+attemptKey+"&owner_id=eq."+encodeURIComponent(ownerId)+"&select=*&limit=1");
    return rows.length?map(rows[0]):null;
  }
  return Object.freeze({
    async get(attemptKey,ownerId){return get(attemptKey,ownerId);},
    async createOrGet(value){
      const ownerId=owner(value?.ownerId),projectId=value?.projectId||null;
      if((projectId!==null&&!UUID.test(projectId))||typeof value.attemptKey!=="string"||!/^[a-f0-9]{64}$/.test(value.attemptKey)||
        typeof value.assetId!=="string"||!UUID.test(value.assetId)||typeof value.driveFileId!=="string"||!/^[-_A-Za-z0-9]{10,200}$/.test(value.driveFileId)||
        typeof value.mimeType!=="string"||value.mimeType.length>128||!Number.isSafeInteger(value.byteSize)||value.byteSize<1||value.byteSize>262144000||
        typeof value.sha256!=="string"||!/^[a-f0-9]{64}$/.test(value.sha256)||(value.parentFolderId!==null&&value.parentFolderId!==undefined&&!/^[-_A-Za-z0-9]{10,200}$/.test(value.parentFolderId))){
        throw fail("Drive export attempt is incomplete or invalid.","GOOGLE_DRIVE_EXPORT_ATTEMPT_INVALID");
      }
      const rows=await request("on_conflict=attempt_key&select=*",{method:"POST",prefer:"resolution=ignore-duplicates,return=representation",
        body:{attempt_key:value.attemptKey,owner_id:ownerId,project_id:projectId,asset_id:value.assetId,parent_folder_id:value.parentFolderId||null,
          drive_file_id:value.driveFileId,mime_type:value.mimeType,byte_size:value.byteSize,sha256:value.sha256,state:"PREPARED"}});
      if(rows.length===1)return map(rows[0]);
      const existing=await get(value.attemptKey,ownerId);
      if(!existing)throw fail("Drive export attempt could not be created or recovered.","GOOGLE_DRIVE_EXPORT_STORE_FAILED");
      if(existing.assetId!==value.assetId||existing.projectId!==projectId||
        existing.mimeType!==value.mimeType||existing.sha256!==value.sha256||existing.byteSize!==value.byteSize||
        existing.parentFolderId!==(value.parentFolderId||null)){
        throw fail("Drive export idempotency key collides with a different asset scope.","GOOGLE_DRIVE_EXPORT_IDEMPOTENCY_CONFLICT");
      }
      return existing;
    },
    async claim({attemptKey,ownerId}){
      ownerId=owner(ownerId);
      if(typeof attemptKey!=="string"||!/^[a-f0-9]{64}$/.test(attemptKey))throw fail("Drive export attempt key is invalid.","GOOGLE_DRIVE_EXPORT_ATTEMPT_INVALID");
      const leaseToken=randomUUID(),now=new Date(),expiresAt=new Date(now.getTime()+60*60*1000);
      const rows=await request("attempt_key=eq."+attemptKey+"&owner_id=eq."+encodeURIComponent(ownerId)+
        "&or=(lease_expires_at.is.null,lease_expires_at.lt."+encodeURIComponent(now.toISOString())+")&state=in.(PREPARED,UPLOADING,OUTCOME_UNKNOWN)&select=*",{
        method:"PATCH",prefer:"return=representation",body:{lease_token:leaseToken,lease_expires_at:expiresAt.toISOString(),updated_at:now.toISOString()}});
      return rows.length===1?leaseToken:null;
    },
    async claimForReconciliation({attemptKey,ownerId}){
      ownerId=owner(ownerId);
      if(typeof attemptKey!=="string"||!/^[a-f0-9]{64}$/.test(attemptKey))throw fail("Drive export attempt key is invalid.","GOOGLE_DRIVE_EXPORT_ATTEMPT_INVALID");
      const leaseToken=randomUUID(),now=new Date(),expiresAt=new Date(now.getTime()+15*60*1000);
      const rows=await request("attempt_key=eq."+attemptKey+"&owner_id=eq."+encodeURIComponent(ownerId)+
        "&or=(lease_expires_at.is.null,lease_expires_at.lt."+encodeURIComponent(now.toISOString())+")&state=eq.RECONCILIATION_REQUIRED&select=*",{
        method:"PATCH",prefer:"return=representation",body:{lease_token:leaseToken,lease_expires_at:expiresAt.toISOString(),updated_at:now.toISOString()}});
      return rows.length===1?leaseToken:null;
    },
    async saveSession({attemptKey,ownerId,sessionUri,leaseToken}){
      ownerId=owner(ownerId);
      if(typeof attemptKey!=="string"||!/^[a-f0-9]{64}$/.test(attemptKey)||typeof leaseToken!=="string"||!UUID.test(leaseToken))
        throw fail("Drive export attempt lease is invalid.","GOOGLE_DRIVE_EXPORT_ATTEMPT_INVALID");
      const encrypted_session_uri=seal(sessionUri);
      const now=new Date().toISOString();
      const rows=await request("attempt_key=eq."+attemptKey+"&owner_id=eq."+encodeURIComponent(ownerId)+
        "&lease_token=eq."+leaseToken+"&lease_expires_at=gt."+encodeURIComponent(now)+"&select=*",{
        method:"PATCH",prefer:"return=representation",body:{encrypted_session_uri,state:"UPLOADING",updated_at:now}});
      if(rows.length!==1)throw fail("Drive upload session could not be persisted under the active lease.","GOOGLE_DRIVE_EXPORT_STORE_FAILED");
      return map(rows[0]);
    },
    async mark({attemptKey,ownerId,state,webViewLink=null,errorCode=null,leaseToken=null}){
      ownerId=owner(ownerId);
      if(typeof attemptKey!=="string"||!/^[a-f0-9]{64}$/.test(attemptKey)||
        typeof leaseToken!=="string"||!UUID.test(leaseToken))throw fail("Drive export attempt lease is invalid.","GOOGLE_DRIVE_EXPORT_ATTEMPT_INVALID");
      if(webViewLink!==null){let link;try{link=new URL(webViewLink);}catch{throw fail("Drive file link is invalid.","GOOGLE_DRIVE_EXPORT_LINK_INVALID");}
        if(link.protocol!=="https:"||link.origin!=="https://drive.google.com")throw fail("Drive file link is outside the approved origin.","GOOGLE_DRIVE_EXPORT_LINK_INVALID");}
      if(!["OUTCOME_UNKNOWN","COMPLETED","RECONCILIATION_REQUIRED","FAILED"].includes(state))throw fail("Drive export state transition is invalid.","GOOGLE_DRIVE_EXPORT_STATE_INVALID");
      const patch={state,last_error_code:errorCode,lease_token:null,lease_expires_at:null,updated_at:new Date().toISOString()};
      if(state==="COMPLETED"){patch.drive_web_view_link=webViewLink;patch.completed_at=new Date().toISOString();patch.encrypted_session_uri=null;}
      const now=new Date().toISOString();
      patch.updated_at=now;
      const rows=await request("attempt_key=eq."+attemptKey+"&owner_id=eq."+encodeURIComponent(ownerId)+
        "&lease_token=eq."+leaseToken+"&lease_expires_at=gt."+encodeURIComponent(now)+"&select=*",{
        method:"PATCH",prefer:"return=representation",body:patch});
      if(rows.length!==1)throw fail("Drive export state could not be persisted under the active lease.","GOOGLE_DRIVE_EXPORT_STORE_FAILED");
      return map(rows[0]);
    }
  });
}
